# 第一篇之三 · 多 Agent 管理 + 长程任务可靠性

---

# 4. 多 Agent 管理

**为什么要拆多 Agent（真实碰墙现场）**：早期曾尝试把告警、指标、看板、CMDB、天巡和变更全部放进一个大 Agent，结果遇到三个棘手问题：

1. **system prompt 体积过大**：工具描述、Skill 注入和专家描述叠加后会降低 KV Cache 收益并增加调用成本；具体线上命中率和成本倍数需要以运行指标为准；
2. **选错工具频发**——128 个工具名字相似的互相干扰（`FindMetrics` vs `FindDimensions`），**业界经验工具 > 30 后选择准确率明显下滑**；
3. **上下文互相污染**——同时处理告警和变更时，“刚才告警看到的变更信息”会被带到下一个完全无关的问题。

于是拆到 15 个专家 Agent，**每个只处自己领域的 10-20 个工具 + 自己的 SystemPrompt**，直接解决 1/2 两个问题，上下文也物理隔离。但新问题又来了：子 Agent 需要多少前因后果（完全隔离 vs 完全共享）、并发两个子 Agent 写同一实例怎么办（安全风险）、新专家上线要不要发版（拓展成本）。本节四个子节就回答这四个矛盾：**子 Agent 来源 & 统一接口 → Agent-as-Tool 分发 → 数字分身运行时人格装配 → 并发完整机制**。

## 4.1 三种子 Agent 来源，一个统一接口

无论哪种来源，最终都收敛为实现 `adk.Agent`（`Name`/`Description`/`Run`）的对象。

### 来源一：静态配置（同服务内层级）

```yaml
agents:
  - name: cloud_native_expert
    sub_agents: [prometheus_expert]   # 写名字
```

构建期 `InitAgentManager`（`agent_builder.go:64`）：

```go
for _, item := range agentCfgs {
    ag, _ := agent.NewDefaultAgent(ctx, item, cm)   // 先把所有 Agent 都造出来
    agentMap[item.Name] = ag
}
adkAgentMap := ...   // 汇总成 name -> adk.Agent 全局表
for agName, ag := range agentMap {
    finalAg, _ := buildAgentWithSubAgents(ctx, agCfg, cm, ag, adkAgentMap)  // 按名字查出子 Agent 实例
    am.RegisterAgent(ctx, finalAg)
}
```

配置来源是 **DB + yaml 两级合并**（`GetAgentConfigs`）：DB 里有的先取，文件里同名的**覆盖** DB，文件独有的追加。

### 来源二：动态跨服务（supervisor）

```go
_, agents, _ := s.agentOperator.ListAgents(ctx, po.AgentFilter{Enabled: []int64{1}})
for _, item := range agents {
    if item.Endpoint == "" { continue }
    subAgent, _ := NewSubAgent(ctx, item)// 按 ProtocolType 造 A2AAgent / AGUIAgent
    ags = append(ags, subAgent)
    subAgentDescs = append(subAgentDescs,
        fmt.Sprintf("名称: %s\n描述: %s\n使用示例: %s", item.Code, item.Profile, item.UseCases))
}
sa.SystemPrompt = fmt.Sprintf("<角色定义>%s</角色定义><子Agent列表>%s</子Agent列表>",
    sa.SystemPrompt, strings.Join(subAgentDescs, "\n\n"))
mainAgent, _ := s.getDeepAgent(ctx, accessAG, *sa, ags)
```

**注意 `use_cases` 也被拼进了 prompt**——这是 `agent` 表里那些 `query_examples` 的真实用途：**给总入口 Agent 做few-shot 路由依据**，不只是前端"猜你想问"的展示数据。这是一个很实用的设计：**运营同学维护示例问句，等于在维护路由训练数据**。

`NewSubAgent`（`sub_agent_factory.go:33`）按协议造远程壳：

```go
switch protocolType {
case client.ProtocolTypeA2A:
    return agent.NewA2AAgent(ctx, &agent.A2AAgentConfig{
        AgentURL: ag.Endpoint, Name: ag.Code, Description: ag.Profile, Streaming: true}, nil, nil)
default: // tcum_agui / sre_agui / knot_agui
    agentConfig := parseAgentConfigItems(ag.ConfigItems)
    knotToken := cfg.knotToken
    if knotToken == "" { knotToken = parseKnotToken(ag.AuthConfig) }
    return agent.NewAGUIAgent(ctx, &agent.AGUIAgentConfig{
        Endpoint: ag.Endpoint, Name: ag.Code, Description: extractAgentDescZh(ag.Profile),
        ProtocolType: protocolType, KnotToken: knotToken, AgentConfig: agentConfig,
    })
}
```

**这里能看出平台的异构接入能力**（生产数据印证）：

| `protocol_type` | 含义 | 生产实例 |
|---|---|---|
| `tcum_agui` | 自有 AGUI 协议| 11 个自研 Agent |
| `knot_agui` | 公司 Knot 平台，需 `auth_config.token` | `tcum_ai_assistant`（`knot.woa.com/apigw/api/v1/agents/agui/…`） |
| `sre_agui` | 外部 SRE 团队的 SSE 端点 | `sre_expert`（`https://sreagent.woa.com/api/sse/stream/from_tcumai`） |

**同一个 `task` 工具背后可以是自研 Agent、公司内其他团队的 Agent、甚至第三方平台的 Agent**——这是平台化的关键，也是"多 Agent 协作"能真正跨组织落地的前提。

### 来源三：数字分身按权限过滤（见 §4.3）

## 4.2 分发机制：Agent-as-Tool，LLM 自主 Function Calling

**关键认知：子 Agent 不是挂在 Agent 树上被直接调用，而是被包装成主 Agent 手里的一个"工具"。**

构建期（`vendor/.../deep/task_tool.go:61` `newTaskTool`）：

```go
t := &taskTool{subAgents: map[string]tool.InvokableTool{}, subAgentSlice: subAgents, descGen: defaultTaskToolDescription}

// 内置"通用兜底"子 Agent（除非WithoutGeneralSubAgent）
if !withoutGeneralSubAgent {
    generalAgent, _ := adk.NewChatModelAgent(ctx, &adk.ChatModelAgentConfig{
        Name: generalAgentName, Description: agentDesc, Instruction: Instruction,
        Model: Model, ToolsConfig: ToolsConfig, MaxIterations: MaxIteration, ...})
    it, _ := assertAgentTool(adk.NewAgentTool(ctx, generalAgent))
    t.subAgents[generalAgent.Name(ctx)] = it
}

for _, a := range subAgents {
    it, _ := assertAgentTool(adk.NewAgentTool(ctx, a))  // Agent → Tool 适配器
    t.subAgents[a.Name(ctx)] = it                        // key = agent 名字
}
```

LLM 看到的只是**一个**叫 `task` 的工具，`Info()` 的 Desc 里列出所有候选（`-名字: 描述`），参数只有两个：

```go
ParamsOneOf: schema.NewParamsOneOfByParams(map[string]*schema.ParameterInfo{
    "subagent_type": {Type: schema.String},
    "description":   {Type: schema.String},
})
```

运行期分发（`task_tool.go:155`）：

```go
a, ok := t.subAgents[input.SubagentType]
if !ok { return "", fmt.Errorf("subagent type %s not found", input.SubagentType) }
params, _ := sonic.MarshalString(map[string]string{"request": input.Description})
return a.InvokableRun(ctx, params, opts...)
```

再往下 `agentTool.InvokableRun`（`adk/agent_tool.go:122`）构造 `Runner` → `subAgent.Run(ctx, [UserMessage(description)])`：

- **本地子 Agent** → 走它**自己独立的一份 ReAct 图实例**（独立迭代计数、独立 State）；
- **远程子 Agent** → `A2AAgent.Run` 内部 `go func(){}` 起协程 → `client.StreamMessage` 真实跨服务 HTTP/SSE，事件流累积成字符串回传。

**所以"路由"这一步没有任何代码规则**——没有关键词匹配、没有 if/else、没有独立分类器，就是标准 LLM tool calling；代码只做"名字 → map 查表 → 调 Run"。

**这既是亮点也是短板（辩证讲）**：

| | 说明 |
|---|---|
| ✅ 亮点 | 新增 Agent 只需入库一条记录（code + endpoint + profile + use_cases），**零代码、零发版**即可被总入口感知和调度；跨团队、跨协议都能接 |
| ❌ 短板 | **路由准确率不可度量、不可归因**——路由错了表现为"Agent 答不对"，无法定位是路由环节还是执行环节；用大模型 + 全量子 Agent 描述做路由，token 与延迟成本都高；置信度低时无法反问澄清，只能硬选一个；新增域时模型不知道该域存在（除非改 prompt / 补 use_cases） |

**改造方向（三级路由）**：
1. **规则前置**：关键词/正则命中直接定域（含 `PromQL`、`rate(` → prometheus 域；含 `变更单` → change 域），零成本零延迟；
2. **小模型分类**：未命中则小模型多标签分类，输出 `domain + confidence + complexity`；
3. **置信度兜底**：`confidence < 阈值`时反问用户澄清而非乱猜。

`complexity` 还能顺带驱动分级轮次预算（简单问数 8 轮、单产品诊断 20 轮、跨产品根因 40 轮）与分级模型路由。

## 4.3 数字分身：一个实例服务 N 个人格

全项目最有设计感的一块。问题：`digital_twin_agent` 是**一个共享 Agent 实例**，要同时服务成百上千个数字分身，而**每个分身被授权的子 Agent / MCP / 知识库都不同**。

如果子 Agent 列表在构建期焊死，就只能所有分身共享同一份能力全集，做不到细粒度授权。解法：把"决定能力集合"这一步从**构建期**下沉到**每次请求的 `BeforeAgent`**。

**构建期是空壳**，逐层验证：

```go
// ① buildAgentWithSubAgents 优先用自定义 Provider
subProvider := agent.GetAgentManager().GetSubAgentsProvider(cfg.Name)
if subProvider != nil { subs, _, _ := subProvider.GetSubAgents(ctx); subAgents = subs }

// ② DigitalTwinAgentSubAgentsProvider.GetSubAgents 明确返回 nil
func (p *DigitalTwinAgentSubAgentsProvider) GetSubAgents(ctx) ([]adk.Agent, []agent.SubAgentInfo, error) {
    p.refreshCache(ctx)     // 只借这个时机刷新全量业务 Agent 缓存
    return nil, nil, nil    // ← 不向deep 提供任何子 Agent
}

// ③ deep.New 因此根本不构建 task 工具
if !cfg.WithoutGeneralSubAgent || len(cfg.SubAgents) > 0 { ... }  // false || false = false
```

**运行期四个中间件链式装配**（顺序敏感，`digital_twin_agent_provider.go:161` `GetExtraHandlers`）：

| 顺序 | 中间件 | 做什么 |
|---|---|---|
| 1 | `TwinSoulMiddleware`（`twin_soul_middleware.go:91`） | ① `resolver` 实时查 DB 拿 `*TwinInfo`（ID/Code/Name/Soul/SubAgentIDs/SkillIDs/McpConfig/EnvVars/KbRefs）；② **`ctx = WithTwinInfo(ctx, twin)`**（后三个全靠它，**所以它必须第一个注册**）；③ `<digital_twin id code name><soul>…</soul></digital_twin>` **前置**到 Instruction；④ **AuthZ**：非 admin 分身过滤 `adminOnlyTools`（`ListMyDigitalTwins`/`GetDigitalTwinDetail`/`UpsertDigitalTwin`/`DeleteDigitalTwins`/`ExecuteSQL`），并按 `SubAgentIDs` 过滤 `<sub_agents>` prompt 段 |
| 2 | `DynamicTaskToolMiddleware`（`dynamic_task_tool_middleware.go:41`） | 从 ctx 取 `TwinInfo.SubAgentIDs`（为空则**不注入**直接 return）→ `m.fetcher(ids)` 从缓存拿授权子集 → `newDynamicTaskTool(agents)` 现造 `task` 工具 + `buildDynamicTaskPrompt` 说明 |
| 3 | `DynamicMcpMiddleware` | 按 `TwinInfo.McpConfig` 现拉 MCP 工具 |
| 4 | `DynamicKbMiddleware` | 按 `TwinInfo.KbRefs` 现拉知识库检索工具 |

**依赖注入解耦**：`DynamicTaskToolMiddleware` 只依赖一个函数 `AgentsFetcher func(ids []int64) []adk.Agent`，实际注入的是 `p.subAgentsProvider.GetCachedA2AAgentsByIDs(ids)`。它完全不知道 Agent 怎么创建、怎么缓存——**关注点分离**：谁负责"造子 Agent 实例并缓存"是 `DigitalTwinAgentSubAgentsProvider`（构建/热更新时 `refreshCache` 全量拉 DB），中间件只负责"运行时按 ID 查缓存 + 组装工具"。

**权限落在"工具存在与否"而不是"运行时判断"**——这是安全设计的关键区别：

```go
a, ok := t.subAgents[input.SubagentType]
if !ok {
    return "", fmt.Errorf("subagent type %q not found or not authorized for current digital twin", input.SubagentType)
}
```

未授权的子 Agent **从一开始就不在 map 里**，即使 prompt 注入让模型硬编一个名字也会被拒绝。这比"先把工具都给模型，再在执行时判断权限"安全一个量级。

**具体例子**（面试举例用）：

| 分身 | `sub_agents` | 效果 |
|---|---|---|
| 分身A "运维值班助手"（twin_id=101） | `[3, 7]` | `task` 工具里只有 `prometheus_alert_diagnose_expert` + `tcum_cmdb_expert` |
| 分身 B "巡检小助手"（twin_id=102） | `[5]` | 只有 `tianxun_inspect_summary_analysis_expert`；**即使用户问告警问题，模型也调不到告警诊断专家**（工具里根本没这个选项） |

**并发安全的关键**：`ChatModelAgentContext` 是每次 `Run()` 新建的临时值，所有中间件都做**值拷贝**（`nRunCtx := *runCtx`），不污染共享 Agent 实例：

```go
// vendor/.../adk/chatmodel.go:600 applyBeforeAgent
runCtx := &ChatModelAgentContext{
    Instruction: ec.instruction, Tools: cloneSlice(ec.unwrappedTools), ReturnDirectly: copyMap(ec.returnDirectly),
}
for i, handler := range a.handlers { ctx, runCtx, err = handler.BeforeAgent(ctx, runCtx) }
runtimeEC := &execContext{
    instruction: runCtx.Instruction,
    toolsNodeConf: compose.ToolsNodeConfig{Tools: runCtx.Tools, ...},
    rebuildGraph: (原来没工具但现在有了) || (原来没returnDirectly 但现在有了),
}
```

`rebuildGraph` 这个开关正是 `digital_twin_agent`"构建期零工具、运行期长出工具"能成立的原因——工具从 0 变非 0 时会重新 `newReact` 建一张新图。

**`TwinSoulMiddleware` 的容错**：resolver 报错只 warn 不阻断（`skip twin enhancement`）——分身信息查不到时降级为"普通 Agent"而非直接失败。

## 4.4 一次工具并发的完整机制（高频追问）

"上一轮返回多个工具时怎么并发"——答案在 `compose/tool_node.go`，**并发不在图层做，在 `ToolsNode` 这一个节点内部做**。

第一步 `genToolCallTasks`（`:556`）把 N 个ToolCall 展开成 N 个独立 task（`toolCallTask` 自带输入 + 输出槽位：`endpoint/name/arg/callID` + `output/sOutput/err/executed`）：

```go
n := len(input.ToolCalls)
toolCallTasks := make([]toolCallTask, n)
for i := 0; i < n; i++ {
    toolCall := input.ToolCalls[i]
    if result, executed := executedTools[toolCall.ID]; executed { ...; continue }  // 断点续跑
    index, ok := tuple.indexes[toolCall.Function.Name]
    if !ok {
        if tn.unknownToolHandler == nil { return nil, fmt.Errorf("tool %s not found ...") }
        toolCallTasks[i] = newUnknownToolTask(...)  // 幻觉工具兜底
    } else {
        toolCallTasks[i].endpoint = tuple.endpoints[index]  // 已包好中间件的 endpoint
        toolCallTasks[i].callID = toolCall.ID               // callID 绑死在 task 上
        ...
    }
}
```

第二步 `parallelRunToolCall`（`:751`）：

```go
func parallelRunToolCall(ctx, run, tasks, opts...) {
    if len(tasks) == 1 { run(ctx, &tasks[0], opts...); return }  // ① 单工具快路径：不开goroutine

    var wg sync.WaitGroup
    for i := 1; i < len(tasks); i++ {                            // ② 注意从 1 开始
        if tasks[i].executed { continue }
        wg.Add(1)
        go func(ctx_ context.Context, t *toolCallTask, opts ...tool.Option) {
            defer wg.Done()
            defer func() {                                        // ③ 每goroutine 独立 panic 兜底
                if panicErr := recover(); panicErr != nil {
                    t.err = safe.NewPanicErr(panicErr, debug.Stack())
                }
            }()
            run(ctx_, t, opts...)                                 // ④ 只写自己那一格 → 零锁
        }(ctx, &tasks[i], opts...)
    }
    if !tasks[0].executed { run(ctx, &tasks[0], opts...) }        // ⑤ 第 0 个复用当前协程
    wg.Wait()                // ⑥ fan-in 屏障
}
```

四个工程细节：
1. **单工具快路径**不开 goroutine，省调度与 GC 开销；
2. **N 个任务只开 N-1 个 goroutine**（第 0 个用当前协程），主协程不空等；
3. **零锁**：每个 goroutine 只写 `&tasks[i]`（切片元素地址稳定），无共享写；
4. **panic 隔离**：单工具 panic 转成 `t.err`，走普通错误路径，不炸整个 ToolNode。

**ctx 分叉保证 trace 正确**（`runToolCallTaskByInvoke:658`）：

```go
ctx = callbacks.ReuseHandlers(ctx, &callbacks.RunInfo{Name: task.name, Type: ..., Component: ...})
ctx = setToolCallInfo(ctx, &toolCallInfo{toolCallID: task.callID})
ctx = appendToolAddressSegment(ctx, task.name, task.callID)
```

ctx 是值语义，每个 goroutine 派生自己的链（自己的 callID、RunInfo、address segment），所以 Langfuse 能在每个工具协程里各自 `CreateSpan`，自动挂成 **N 个平行 span**；`GetToolCallID(ctx)` 在任意工具内部都拿到"自己的"callID 不会串。

**结果收敛按下标而非完成时间**（`:839-879`）：

```go
output[i] = schema.ToolMessage(tasks[i].output, tasks[i].callID, schema.WithToolName(tasks[i].name))
```

保证返回顺序严格等于 `input.ToolCalls` 顺序——这对 OpenAI 协议至关重要（`assistant.tool_calls[i]` 必须能和 `tool` 消息一一对应）。

流式路径把 N 个流合并（`:985-1011`）：每个工具的 chunk 转成"长度 n 的数组，只有自己下标有值"，再 `schema.MergeStreamReaders(sOutput)`——**同样保证顺序对齐，但能边跑边流式吐出**。

**并发+ 中断的组合处理**（很少有人注意的细节）：若并发的 N 个工具里有几个抛 `InterruptRerunError`，**已跑完的结果会被存进 `ExecutedTools[callID]`** 再合成 `CompositeInterrupt` 抛出；下次 resume 时 `genToolCallTasks` 开头就检查 `executedTools[toolCall.ID]` 直接复用、`executed=true` 跳过重跑——**并发批次里的"部分完成"是可断点续跑的**。

> ⚠️但 TCUM-AI **未配置 `CheckPointStore`**，这套断点续跑的技术底座虽存在、业务上并未启用（`DefaultAgent.Resume` 已转发但没有 store）。**这也正是 HITL 审批能快速落地的技术基础。**

**开关**：`ToolsNodeConfig.ExecuteSequentially`（`:171-174`）一路透传自 `adk/chatmodel.go:643`，TCUM-AI **从未设置** → 全部 Agent 走并发路径。

## 4.5 AgentManager：注册、路由与热更新

`pkg/agent/manager.go` 用 `gorilla/mux` 为每个 Agent 注册路径（`/{agent_code}`），并组装 AG-UI Server：

```go
aguiServer, err := einoagui.New(agent,
    einoagui.WithPath(agent.GetAGUIConfig(ctx).Path),
    einoagui.WithCallbacks(callbacks),                 // 事件翻译回调（当前空）
    einoagui.WithUserIDResolver(userIDResolver),       // ForwardedProps["userId"] → 否则 anonymous_user
    einoagui.WithContextEnricher(contextEnricher),     // 注入 Langfuse trace 配置
    einoagui.WithRunAgentInputHook(runAgentInputHook), // 输入预处理（当前空壳）
)
```

三个 Agent 初始化路径彼此独立：
- 业务专家 → `InitAgentManager` 批量构建（服务启动时）；
- `digital_twin_agent` → `AgentService.InitDigitalTwinAgent` → `RebuildAgent`，AGUI 路径固定 `/digital_twin_agent`；
- `supervisor` → 请求时 `NewSupervisorAgent` 动态生成，构建后注册进 `AgentManager`（**同名已存在则热更新**），下次同进程请求可复用。

`AgentManager.ListAgents() map[string]*AgentInstance`（`:381`）返回运行时实际生效的完整清单——**比配置文件更准**（反映热更新后状态），但目前**未暴露成 HTTP 接口**，这是一个低成本的可观测性改进点。

## 4.6 多 Agent 层短板

| 短板 | 说明 | 对标 |
|---|---|---|
| **无显式任务分解/汇总/验证阶段** | Deep 模式是"调用子 Agent 工具"隐式编排，没有 Plan 结构。应引入 `Task{id, goal, deps, readonly, resources}`，父 Agent 先出plan，调度器按依赖拓扑执行——好处是可视化、可重试单个 task、可做并发控制 | CC Coordinator 四阶段模型 |
| **无分级并发控制（安全相关，P0）** | CC 规则很实用：**只读任务自由并行；写任务同一组资源互斥；验证任务可与不同区域的写任务并行**。运维场景两个子 Agent 同时对同一实例变更是真实风险。应为每个 task 声明 `resources`（`instance:ins-xxx`、`product:cvm`）+ `readonly`，调度器对同 resource 的写 task 串行化 | CC |
| **子 Agent 无法复用/续命** | 每次都新建；CC 通过 `SendMessageTool` 向仍在 running 的 Worker 排队消息 | CC Teammate 机制 |
| **上下文隔离模式单一** | 只有近似 Clean Slate；CC 有三种：**Clean Slate**（空白开始，适合独立检索）/ **Context Forking**（继承完整父历史，适合需前因后果的跟进）/ **Fork（继承全部上下文并刻意保持 API 请求前缀字节一致以共享 prompt cache）**。第三种是成本优化关键技巧 | CC |
| **子 Agent 结果是一段文本** | 父 Agent 拿不到结构化中间证据（查了哪些指标、看了哪些实例），削弱结论可追溯性。应返回 `{conclusion, evidence[], tools_used[], confidence}` | — |
| **A2A `idleTimeout = 60s` 偏短** | 跨产品根因定位的子 Agent 可能思考/查询 >60s 无输出被误判空闲中断（`a2a_agent.go:210`；server 心跳 `manager.go:823` 15s）。应配置化 + 子 Agent 周期性发 `progress` 事件当业务心跳，区分"真空闲"与"在忙但无输出" | — |
| **无断线重连与状态快照** | 子 Agent 流断开则中间结果全丢。应按步骤落快照（Redis），重连后从最后一步继续 | CC `swarm/reconnection.ts` |
| **无 `filterIncompleteToolCalls`** | 父 Agent 中途派生子 Agent 时可能存在未完成的 `tool_use`，传给子 Agent 会 API 报错 | CC |

---

# 5. 长程任务可靠性

**为什么要专门拿出来讲**：一条真实 trace 已能说明问题：`zhiyan-monitor.alarm_tag_ana ERROR → ToolNode ERROR → ReAct ERROR`，即一个 MCP 工具错误可以沿调用链放大并导致整轮失败。跨产品根因定位涉及多轮工具调用、并发执行和跨服务调用，任何一环缺少隔离都会放大失败。长任务的失败代价也明显高于短问答，因此可靠性必须分层设计，且每层都不能静默降级。本节先拆解已有七层机制，说明当前保护边界；再列十个关键缺口，最后给出高 ROI 的改造顺序。

运维排障天然是长程任务：一次跨产品根因定位可能 30+ 轮、并发几十次工具调用、跨 3~4 个服务进程。可靠性是这类场景的生命线。

## 5.1 已有的七层可靠性机制

| 层 | 机制 | 位置 | 效果 |
|---|---|---|---|
| **迭代上限** | eino 默认 20；`MaxStep` 可配（`cloud_native_expert:30`、`prometheus_expert:25`、`ops_expert:30`、DB 默认 20、数字分身兜底 15） | `react.go:331` + `modelPreHandle` | 防死循环 |
| **上下文超限自愈** | 七层压缩（第一篇之一 §1.1）；⚠️ 其中 L4 应急压缩仅 `Generate` 生效，流式主链路未覆盖 | — | 会话不因超限中断（流式场景尚有缺口） |
| **工具错误不中断会话** | `toolErrorHandlerMiddleware` | `tool_error_handler_middleware.go:41` | 见下 |
| **幻觉工具兜底** | `UnknownToolsHandler` 返回 `"unknown tool: %s"` 而非 error | `default_agent.go:174`、`agent_builder.go:269` | 模型可自纠 |
| **工具并发 + panic 隔离** | `parallelRunToolCall` 每goroutine 独立 recover | `compose/tool_node.go:766` | 单工具崩溃不炸整轮 |
| **熔断降级三处** | token counter（阈值 3）、`agent_config_cache`（阈值 3）、MCP 单 server 失败跳过 | — | 依赖故障不扩散 |
| **主动式长程任务** | 数字分身 cron/once 定时任务 + **分布式锁防多实例重复执行 + 锁续约** | `pkg/jobscheduler` | 无人值守可靠执行 |

### `toolErrorHandlerMiddleware` 值得单独讲

**背景是真实 trace 驱动的优化**：MCP 工具失败时错误沿 `ToolNode → ReAct` 直接抛出，整个会话 ERROR 终止（trace 实例：`zhiyan-monitor.alarm_tag_ana ERROR → ToolNode ERROR → ReAct ERROR`）。

```go
func (m *toolErrorHandlerMiddleware) WrapInvokableToolCall(ctx, endpoint, tCtx) (adk.InvokableToolCallEndpoint, error) {
    return func(ctx context.Context, argumentsInJSON string, opts ...tool.Option) (string, error) {
        result, err := endpoint(ctx, argumentsInJSON, opts...)
        if err == nil { return result, nil }
        if shouldPassThroughToolError(ctx, err) { return result, err }
        return buildToolErrorResult(tCtx.Name, err), nil   // ← 错误变成正常结果
    }, nil
}
```

给模型的错误文本**带行动指引**（提示词工程的好例子，`buildToolErrorResult:91`）：

```
[TOOL_ERROR] 工具 %q 本次调用失败。
错误信息: %s
该错误已被系统捕获, 会话不会中断。请分析错误原因并采取以下行动之一:
1. 若为参数问题(缺失必填字段/格式非法/取值超范围), 修正参数后重新调用该工具
2. 若为临时性错误(超时/网络抖动/限流), 可原样重试一次
3. 若同一工具连续失败超过 2 次, 请停止重试, 改用其他可用工具或基于已获得的信息继续完成任务
```

`toolErrorMsgMaxLen = 2000` 截断，防超长错误（如整段 HTML）撑爆上下文。

**两类必须透传不兜底的错误**（这个区分很关键，`shouldPassThroughToolError:78`）：
1. `compose.IsInterruptRerunError(err)` —— human-in-the-loop 中断机制依赖，必须原样抛；
2. `ctx.Err() != nil` / `Canceled` / `DeadlineExceeded` —— 请求已终止，兜底无意义。

**挂载位置在 Handlers 链最前（最外层）**（`agent_builder.go:202`），因此连`BeforeAgent` 动态注入的 MCP 工具也一起被兜住——eino 底层把 `WrapInvokableToolCall` 转成 `compose.ToolMiddleware` 合并进同一份 `ToolCallMiddlewares`，每次迭代都以同一配置构建 ToolsNode，覆盖是完整的。

## 5.2 长程可靠性的十个关键缺口（必须诚实讲）

| # | 缺口 | 后果 | 对标机制 |
|---|---|---|---|
| 1 | **轮次耗尽是"报错终止"而非"优雅收尾"** | `ErrExceedMaxIterations` 直接抛给用户——运维场景**最需要结论的复杂问题恰恰最容易撞上限**，整轮工作白费 | CC 10 种 `Terminal.reason` |
| 2 | **终止原因只有一种** | 无法区分「正常完成/轮次耗尽/上下文超限/用户中断/模型报错」，上层无法决定重试策略，前端无法差异化提示 | 同上 |
| 3 | **无模型降级链** | CC：`MAX_529_RETRIES = 3`，连续 3 次 529(Overloaded) 抛 `FallbackTriggeredError` 触发 Opus→Sonnet 回退，且 **529 计数器在流式与非流式请求间连续传递**（`initialConsecutive529Errors`）保证总容忍度不变。我们大模型过载只能失败 | CC §13 |
| 4 | **无指数退避 + 抖动** | CC `getRetryDelay`：`BASE_DELAY_MS=500`，`min(500*2^(n-1), 32000)` + `0~25%` 正向抖动。**抖动是防惊群关键**——1000 个客户端同时 429 同时重试会二次打爆服务端。应优先采用服务端 `Retry-After` | CC |
| 5 | **无统一错误分类状态机** | 大部分错误原样丢给模型，但 `connection refused` 和 `参数校验失败` 需要完全不同应对。应定义 `ToolError{Class, Retryable, UserVisible, ModelHint}`，覆盖 参数非法/权限不足/目标不存在/下游超时/下游过载/内部错误 | CC `errors.ts` |
| 6 | **工具并发无上限** | 一轮并行 8 个工具打同一后端，可能自己把下游打挂。应 `errgroup.SetLimit(N)` + 按下游维度令牌桶 | — |
| 7 | **`math.MaxInt` 让 Graph 层失去兜底** | `compose.WithMaxRunSteps(math.MaxInt)`（`chatmodel.go:801,808`）；若 `MaxIterations` 传入负数或极大值没有第二道防线。应改为 `MaxIterations*3+10` | — |
| 8 | **无优雅关闭** | 滚动发布时在途 Agent 任务被硬中断。应：停收新请求 → 等在途任务（上限 30s）→ 落盘会话状态 → 关 SSE 与沙箱 → 退出 | CC `gracefulShutdown.ts` |
| 9 | **无孤儿资源清理** | 中断的沙箱、僵死子 Agent、悬挂 SSE 连接、过期 skill 缓存的回收机制不明。可复用现有 `pkg/jobscheduler` | CC `backgroundHousekeeping.ts` |
| 10 | **会话并发 + 无断点续传** | 用户快速连发两条消息 / 多端同时操作同一会话 → 消息交错、状态覆盖（应会话级 `version` CAS 或按 `dialog_id` 分布式锁串行化）；流式响应中途断开则已生成部分与已执行工具结果不可恢复（SSE 原生支持 `Last-Event-ID`，可按 chunk 落 Redis + 序号续推） | CC `conversationRecovery.ts` |

## 5.3 最值得讲的一个改造建议

**把"轮次耗尽报错"改为"强制收敛"**：在 `modelPreHandle` 检测到剩余轮次 ≤ 1 时，不直接报错，而是：

1. 向消息尾部注入一条system 提示：「你已接近步数上限，请基于现有信息直接给出结论与不确定性说明，不要再调用工具」；
2. 同时把 tool 列表临时置空（**复用现成的 `buildNoToolsRunFunc` 路径**），强制模型出文字结论。

这样最坏情况下用户拿到的是"**带不确定性标注的阶段性结论**"，而不是一个 error。

**为什么这个改造值得单独讲**：它体现了一个 Agent 设计的核心判断——**长程任务的失败不应该是"全无"，而应该是"部分有"**。运维场景里"我排查到这一步，发现 A 和 B 正常、C 有异常但未确认根因，建议人工从 C 继续"这样的输出，价值远大于一个 `exceeds max iterations`。而且这个改造成本极低（复用现有代码路径），是典型的高ROI 项。

## 5.4 会话稳定性全景：前端↔Agent↔LLM 三层 + 断线恢复

> 这是把"会话怎么不断、断了怎么恢复"这条线完整串起来的独立小节。工具兜底见 §5.1，模型降级/指数退避见 §5.2 缺口 3/4，这里不重复。

### 5.4.1 一句话架构：无状态 + DB 重放，而非长连接保持

tcum-ai 的"会话不断"**不是靠长连接保持或断点续跑**，而是靠「**无状态 + DB 持久化 + 每次请求重放历史**」。真正的稳定性保障是四件事：**消息全量落库、SSE 心跳防假死、分层超时熔断、超限自适应重试**；最大的缺口是 **`CheckPointStore` 未配置 → 没有真正的断点续跑**——会话断了只能"重放历史 + 用户重新问"，无法从上次中断处自动继续。

### 5.4.2 会话标识：ThreadID 稳定绑定，RunID 每次新生成

`agent_service.go:buildRequestParams`：

```go
ThreadID: fmt.Sprintf("thread_%d", req.DialogId),  // thread 与 dialogId 稳定绑定
RunID:    runId,                                     // 每次请求新生成
```

**ThreadID 跟 dialogId 强绑定**，所以同一个会话无论发多少次消息、断多少次线，thread 都不变；RunID 每次新生成。这是"无状态重放"的锚点。

### 5.4.3 历史重放（会话恢复的本质）

每次前端发消息，后端**从 DB 重新拼装历史**，不依赖内存状态（`buildRequestParams`）：

1. `dialog.Summary` 非空 → 注入 `<conversation_summary>` 前缀消息
2. `buildSkillContextMessage` → 注入 Skill 缓存上下文
3. `GetRecentDialogHistory(ctx, dialogId, dialog.SummaryMsgCount)` → 只加载「总结之后」的增量消息
4. `ConvertDialogMessagesToSchemaMessages` → 转 schema.Message

所以服务重启、前端断线后重进会话，**都不丢上下文**——状态全在 `dialog` / `dialog_message` 两张表，每次现算。

### 5.4.4 三层超时体系（关键纠正：不是 5min，是 10min）

| 层级 | 值 | 位置 | 作用 |
|---|---|---|---|
| LLM 单次 `Generate` | `timeout_seconds: 600` | appconfig.yaml:31 | 单次模型请求 10min |
| `AgentAccessAPI` 服务整体 | `timeout: 600000` | trpc_go.yaml:28 | `SendAIWorkbenchDialogMessage` 整个 HTTP 请求 deadline |
| A2A 子 Agent | 连接 10s / 空闲 60s / TCP keepalive 15s | a2a_agent.go | 跨服务调用分层超时 |

**关键结论**：LLM 的 600s 是**单次请求**，agent loop 每轮 tool call 都是独立短请求，多轮不累加——这不是瓶颈；**真正的瓶颈是服务层 `timeout: 600000`（10min）整体 deadline**——一个 turn 跑超 10 分钟会被 trpc 强杀、SSE 断掉。**且没有续期逻辑**（无心跳续期、无延长 deadline），长任务跑不完就是跑不完，标 `canceled`，下次重放重来。这是 tcum-ai 的一个真实硬伤。

### 5.4.5 SSE 心跳：后端发前端（10s 一次）

```go
sseHeartbeatInterval = 10 * time.Second
// sendSSEHeartbeat: 每 10s 写 ": heartbeat\n\n"（SSE 注释行，客户端忽略）
```

- **方向：后端 → 前端单向**（SSE 协议约束，只能服务端推、客户端不能推）；
- **目的**：保活，防中间层 LB/Nginx 因空闲超时把长连接掐掉；
- **写失败间接探测客户端已断**（这是后端感知断线的方式，不是显式心跳探测）；
- 注意区分：A2A 子 agent 之间用的是 **TCP keep-alive**（`KeepAlive: 15s`，传输层双向探测），跟 SSE 应用层心跳是两码事。

### 5.4.6 断线也落库：独立 ctx + 三态标记

`saveAssistantMessageAndPostProcess` 最关键的一点：

- 用 `context.WithTimeout(context.Background(), 5*time.Second)` **独立 ctx，刻意不继承请求 ctx**——客户端断开导致原 ctx 取消，已收集的事件照样落库；
- 三态判定：`completed`（无错且最后 `RUN_FINISHED`）/ `failed`（有错）/ `canceled`（客户端断开）；
- `SendAIWorkbenchDialogMessage` 整体 `defer recover()` 兜 panic。

所以前端断线，上次跑到一半的 assistant 内容已落库（status=canceled），下次重进能看见"上次聊到哪了"——但**不会自动续跑**，需用户重发。

### 5.4.7 SSE 断了客户端怎么恢复（业界做法，前端消费端不在本仓库）

分两层断线：**连接层断**（网络抖动/代理超时，后端还在跑）vs **生成层断**（LLM 超时/后端被杀，生成中止）。tcum-ai 无 `Resume(runID)` 端点，两层恢复方式都是同一个——**重新发消息、DB 重放重新生成**。

**① 消费方式**：生产 AI 对话基本不用浏览器原生 `EventSource`（只支持 GET、不能带 body / 自定义 header），用 **`fetch` + `ReadableStream`** 手动控制（支持 POST + 认证 + AbortController 主动取消）。tcum 后端走 POST + SSE，前端应用这种方式。

**② 断线检测**：监听心跳注释行 + 超时判定——**3 个心跳周期（30s）没收到任何数据判定连接已死**，比等 `reader.read()` 抛错快（TCP 半开连接可能长时间不报错）。

**③ 重连策略**：指数退避 + jitter（`1s→2s→4s…` 封顶 30s，`jitter = delay * (0.5 + rand*0.5)`，最多 5~8 次）。jitter 防惊群（大量客户端同一时刻同时重连会二次打爆后端）。

**④ 恢复内容（两个必须做对的点）**：

1. **整条替换而非续接**——重连后后端推的是「从 user 消息开始重新生成的完整回答」，前端要**替换掉上次那半条气泡**，不能直接 append（否则重复）；
2. **幂等去重**——客户端每次发送生成 `client_msg_id`，重连带同一个 id，避免「第一次其实已成功落库、但客户端没收到最后几个事件就断了 → 重连又发一次 → 历史出现两条重复消息」。**tcum 当前 `SendAIWorkbenchDialogMessageRequest` 没有 `client_msg_id` 字段，可补**。

**升级到「断点续跑」需后端补三件套**（也是 5.4.4/5.4.9 的结论串联）：`CheckPointStore` + `Resume(runID)` 端点 + `client_msg_id` 幂等键，能一次性解决「10min 超时跑不完长任务」和「断线不能续跑」两个硬伤。

### 5.4.8 SkillCache：不是分布式缓存，是 DB 表 JSON 字段

- **存储位置**：`dialog` 表的 `SkillCache` 字段（`UpdateDialogSkillCache` 写库），**按 dialog 维度，无 Redis、无进程缓存**；
- **KV 设计**：key = `dialog_id`（隐含在 dialog 表行里），value = 整个 JSON 字符串；
- **结构**（`skill_cache.go`）：

```go
type SkillCache struct {
    Items     []SkillCacheItem `json:"items"`       // 按调用时间排序，新的在后
    UpdatedAt int64            `json:"updated_at"`
    Version   int              `json:"version"`     // 并发控制（乐观锁思想）
}
type SkillCacheItem struct {
    SkillName string `json:"skill_name"`    // 从 ToolCallArgs 解析
    MessageID string `json:"message_id"`    // ToolCallID
    Content   string `json:"content"`        // 工具结果，可能截断
    ContentExpired bool `json:"content_expired"`
    Distance  int    `json:"distance"`       // 距当前消息间隔（0=刚调用）
    UsageCount   int `json:"usage_count"`    // 被引用次数
    LastAccessed int64 `json:"last_accessed"`
}
```

- **淘汰策略**（距离衰减 + 数量上限）：`MaxDistanceThreshold: 3`（3 轮后过期）、`MaxCacheSize: 10`、`MaxContentLength: 20000`（20KB 截断）、`ExpiredRetentionRounds: 2`（过期后再保留 2 轮才删）；
- **作用**：下次请求 `buildSkillContextMessage` 把缓存注入 context，让模型「记住上次调过哪些 skill、结果是什么」，避免重复调用。

一句话：它是**会话级持久化的技能调用结果备忘，不是分布式 KV，不跨会话共享**。

### 5.4.9 CheckPointStore 详解（未接，但技术底座在）

**作用**：把 agent 执行到一半的 state（已执行工具结果 `ExecutedTools[callID]`、中间变量、`CompositeInterrupt`）持久化到外部存储（Redis/DB），支持中断后**从断点续跑，不用重跑前面步骤**。场景：HITL 中断（人审批）、进程崩溃、SSE 断线。

**tcum 现状**：
- ✅ `InterruptRerunError` 能被识别并透传（HITL 信号有了，`tool_error_handler_middleware.go:80` 的 `compose.IsInterruptRerunError`）；
- ❌ 断点状态**没有 store 落盘**，中断后无法真正续跑。

**怎么用**：构建 react 时配 `WithCheckPointStore(redisStore)` 存中间状态，再提供 `Resume(runID)` 入口——用户断线重连带上次 `RunID` 从断点续跑。这正好与 §4.4 末尾"⚠️ 未配置 CheckPointStore"、§5.2 缺口 10 呼应，补上后能把「10min 超时跑不完」「SSE 断了重发」两个硬伤一起解决。

### 5.4.10 LLM 服务故障防护：当前最大空白

tcum-ai 只对「上下文超限」一种错误做了原地重试（`adaptive_context_retry.go`），对**模型服务挂掉/降级**这四件事一个都没做：❌ 无通用重试、❌ 无健康检查/熔断/限流、❌ 无多 provider 降级（`ChatModelConfigList` 能配多个模型但 `NewChatModel(ck)` 按 key 精确匹配单个，没有「A 挂了切 B」）、❌ 无退避策略。

借三家改进：

| 借鉴 | 来源 | 建议 |
|---|---|---|
| 指数退避 + jitter 重试 | dsh `llm-retry`（`localDelay = min(initialDelayMs*2^exp, maxDelayMs)` + jitter） | 5xx/429/超时按 provider 差异化重试 |
| 多路由降级 + 备份 route | dsh `config.routes` 多 adapter 并存 | `ChatModelConfigList` 加主备关系，主熔断自动切备 |
| 熔断器 | Codex/CC 内嵌 SDK retry | 连续 N 次失败 → 冷却期 → 半开探测 |
| provider 健康探测 | 通用 | 定时 ping `base_url`，不健康的从 `ListAvailable` 摘掉，避免前端选到挂掉的模型 |

一句话：**tcum-ai 的 LLM 稳定性现在只有「上下文超限自适应重试」一根支柱，模型服务故障的检查/熔断/降级/重试四件事全没做**，这是最值得补的空白。
