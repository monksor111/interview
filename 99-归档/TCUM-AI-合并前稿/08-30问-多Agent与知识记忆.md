# 第三篇之二 · 30 问四方对比（C. 多 Agent 与协议 Q13–Q17 · D. 知识与记忆 Q18–Q22）

---

# C. 多 Agent与协议

## Q13. 多 Agent 如何编排？

**分析逻辑**：单 Agent 的天花板是"工具太多选不准+ 上下文太长记不住"。多 Agent 的编排模式决定三件事：**任务如何分解、并发如何控制、结果如何汇总**。其中并发控制在有写操作的场景是**安全问题**而非性能问题。

| | 做法 |
|---|---|
| **TCUM-AI** | 实际只有两种：**单 Agent**（`default_agent.go`）与**Deep**（`deep.New`，`agent_builder.go:265`）。子 Agent 通过 `adk.NewAgentTool` 包装成**一个统一的 `task` 工具**（参数 `subagent_type` + `description`），LLM 自主 function calling 委派。⚠️ 名为 `supervisor` 的 Agent **实为 `deep.New` 构建**（`agent_service.go:337`）——**非 vendor 代码里 `supervisor.New` 调用数为 0**。`transfer_to_agent`/`exit` 自动进 `ReturnDirectly` 表 |
| **CC** | **Swarm 架构**（`agentSwarmsEnabled.ts`）+ **Coordinator 模式**（`coordinatorMode.ts`，集中式调度，**明确四阶段：分解 → 分派 → 汇总 → 验证**）+ **Teammate 机制**（对等协作通信协议）+ `AgentTool` 递归调度 + `concurrentSessions.ts` 资源隔离 + `agentColorManager.ts`（UX 细节）。**并发分级规则**：只读任务自由并行；写任务同一组资源互斥；验证任务可与不同区域的写任务并行 |
| **Codex** | Codex App 支持**多智能体并行**，通过 **git worktree 隔离各agent 的修改**——**这是最干脆的隔离方案：物理隔离工作区，天然无写冲突**；另支持后台定时工作流 |
| **OpenClaw** | **多智能体路由（multi-agent routing）** 是一级能力：按 **agent / workspace / sender** 隔离会话。Gateway 是 sessions/routing 的 single source of truth。**子 Agent 委派机制在官方首页无提及，无法确认（未证实）** |

**差异本质**：四种隔离粒度：

| 隔离手段 | 代表 | 强度 | 适用 |
|---|---|---|---|
| 上下文隔离（Agent-as-Tool） | TCUM / CC AgentTool | 中 | 只读分析 |
| **资源级互斥锁** | CC 并发分级 | 强 | 有写操作 |
| **物理工作区隔离（worktree）** | Codex | 最强 | 代码修改 |
| 会话/工作区隔离 | OpenClaw | 中 | 多用户多场景 |

**Codex 的 worktree 方案对 TCUM 有直接启发**：运维场景的"worktree 等价物"是什么？答案是**资源维度的排他锁**——两个子 Agent 不能同时对 `instance:ins-xxx` 做变更。这正是 CC 并发分级规则要解决的问题。

**TCUM 亮点**：
1. **跨进程/跨协议/跨团队的子 Agent 接入**是四家里最强的：`tcum_agui`（自研 11 个）/ `knot_agui`（Knot 平台，带 token）/ `sre_agui`（外部 SRE 团队，且对端**自己还是一个 MultiAgent 系统**，形成三层嵌套）/ A2A。**这证明 A2A/AGUI 协议能让不同团队的 Agent 系统互相嵌套而不暴露内部结构**；
2. **零发版扩展**：新 Agent 入库一条记录（code+endpoint+profile+use_cases）即被 `supervisor` 自动感知；
3. **`use_cases`/`profile` 被拼进路由 prompt**——把"运营维护 Agent 描述"变成有技术含量的工作（描述即路由训练数据）；
4. `order` 字段做人工兜底路由（总入口和高频专家排前）。

**TCUM 不足**：
1. **对外口径与代码不符**（`supervisor.New` 调用数为 0）——技术评审会被直接击穿，必须更正为"Deep 模式 + 子 Agent 上下文隔离与并行"；
2. **无显式任务分解/汇总/验证阶段**——Deep 是"调子 Agent 工具"的隐式编排，没有 Plan 结构，无法可视化、无法重试单个 task；
3. **无分级并发控制（P0，安全相关）**——两个子 Agent 同时对同一实例变更是真实风险；
4. **子 Agent 无法复用/续命**（CC 有 `SendMessageTool` 向 running Worker 排队消息）；
5. 13~15 个 Agent 的注册配置分散（yaml + DB），无统一清单与依赖图。

**解决思路**：
- **O13.1** 引入轻量 Plan：`Task{id, goal, deps, readonly, resources}`，父 Agent 先出 plan，调度器按依赖拓扑执行；
- **O13.2（P0）** **资源级并发互斥**：每task 声明 `resources`（`instance:ins-xxx`、`product:cvm`）+ `readonly`，调度器对同 resource 的写 task 串行化。**这是防止"AI 并发变更打崩线上"的关键护栏**；
- **O13.3** 会话内 Agent 实例池，支持向 running 子 Agent 追加消息；
- **O13.4** 脚本自动生成 `docs/arch/agents.md`（每 Agent 的模型/工具集/max_step/prompt 版本/上下游关系）；
- **借鉴 Codex**：为"有写操作的运维任务"设计 worktree 等价物——例如变更操作先在"影子配置"上演算、确认后再落地。

---

## Q14. 意图路由如何做？准确率如何保证？

**分析逻辑**：路由是多 Agent 的第一道关。路由错了后面全错，但**路由错误的表现是"Agent 答不对"，极难归因**。所以路由必须**可度量**，否则无法优化。

| | 做法 |
|---|---|
| **TCUM-AI** | **Deep 模式下由主模型通过选择 `task` 工具的 `subagent_type` 隐式完成路由**，没有独立路由器组件，没有规则或小模型分类器。路由依据是 `<子Agent列表>` prompt 里的 `名称/描述/使用示例`（来自 DB 的 `code`/`profile`/`use_cases`） |
| **CC** | 简单模式/REPL 模式等**模式驱动**的工具与Agent 裁剪；Coordinator 显式分派 |
| **Codex** | 无"多域路由"概念——**Codex 只有一个域（编码）**，所以不需要路由。这本身是一个重要对比：**通用编码 Agent 不需要意图路由，垂直领域平台必须要** |
| **OpenClaw** | **多智能体路由**是一级能力，按 agent/workspace/sender 隔离。路由规则（是否规则驱动/是否 LLM 驱动）未展开（**未证实**）；但有 `requireMention` + `mentionPatterns` 机制——**在群聊里靠 @提及做显式路由**，这是"用交互设计规避路由不确定性"的思路 |

**差异本质**：**Codex 说明了一件重要的事——路由问题是"多域平台"独有的**。TCUM 有 15 个域各异的 Agent，路由是核心问题；CC/Codex 单域，只需工具裁剪；OpenClaw 用 @提及把路由决策**交还给用户**。

**OpenClaw 的 `requireMention` 值得学**：**当自动路由不可靠时，用交互设计让用户显式指定**。TCUM 其实已经部分这么做了——UI 上让用户从 15 个 Agent 里选，`supervisor` 只是"不想选时的兜底"。

**TCUM 亮点**：
1. **纯 LLM 路由的扩展性最好**——新增 Agent 零代码；
2. **`use_cases` 作为 few-shot 示例**是个巧妙设计（运营写示例问句= 维护路由样本）；
3. `order` + UI 显式选择 + `supervisor` 兜底三层结构，产品上是合理的。

**TCUM 不足**：
1. **路由准确率不可度量、不可归因**；
2. **路由成本高**——用主模型 + 全量子 Agent 描述做路由，token 与延迟双高；
3. **无置信度兜底**——分类不确定时应反问用户，当前只能硬选；
4. **配置质量直接决定路由质量但无校验**——`tcum_tcs_error_debug_expert` 的 `profile`/`use_cases` **全空**，supervisor 拿到的是"名称: xxx\n描述: \n使用示例: "，**这个 Agent 基本不会被选中**；`prometheus_promql_expert` 的 `desc` 是 `NULL`；`grafana_dashboard_expert` 的 `Tags` 是 `[{}]`。

**解决思路**：
- **O14.1** 三级路由：① 规则前置（含 `PromQL`/`rate(` → prometheus 域；含 `变更单` → change 域）零成本；② 小模型多标签分类输出 `domain + confidence + complexity`；③ `confidence < 阈值` 反问澄清；
- **O14.2** 积累 200+ 条"用户问题 → 正确域"标注样本纳入 CI，路由改动必跑回归；
- **O14.3** 路由 trace 记录 `input/domain/confidence/是否被用户纠正`，形成持续优化数据源；
- **O14.4（新增，成本极低）** **Agent 配置 lint**：入库时校验 `profile` 非空、长度下限、必须包含"何时使用"描述。**在 LLM 驱动路由的架构下，`profile`/`use_cases` 的地位等同于函数的 doc comment——它不是文档，它是被执行的输入。**

---

## Q15. 子 Agent 上下文如何隔离？

**分析逻辑**：隔离带来干净和并行，但也带来信息丢失。**关键权衡：子 Agent 需要多少前因后果？** 而prompt cache 又给"共享前缀"带来了额外的成本动机。

| | 做法 |
|---|---|
| **TCUM-AI** | Deep 模式的**近似 Clean Slate**：子 Agent 只收到 `task(description)` 一段文本，**看不到主会话历史**。远程子 Agent 更彻底（跨进程，物理隔离）。结果以工具返回值（一段文本）回到父 Agent |
| **CC** | **三种模式**：**Clean Slate**（空白开始，仅收任务 prompt，适合独立检索）/ **Context Forking**（继承完整父历史，适合需前因后果的跟进）/ **Fork 子 Agent**（继承全部上下文**并刻意保持 API 请求前缀字节一致以共享 prompt cache**）。另有 `filterIncompleteToolCalls` 保护——**父 Agent 中途派生子 Agent 时可能存在未完成的 tool_use，传给子 Agent 会导致 API 错误** |
| **Codex** | worktree 物理隔离（文件系统级），`AGENTS.md` 提供共享的静态上下文 |
| **OpenClaw** | 会话按 agent/workspace/sender 隔离；DM 共享主会话、群聊各自独立会话 |

**差异本质**：**CC 的第三种模式（Fork + 前缀字节一致）是四家里唯一把"上下文隔离"和"成本优化"统一考虑的**。这个洞察很深：共享上下文不仅是功能需求，还能命中供应商 prompt cache 省钱。

**TCUM 亮点**：
1. **跨进程隔离最彻底**——子 Agent 在独立进程/独立机器（甚至外部团队平台），故障域和资源都隔离；
2. 隔离带来的并发能力被实际用上了（一轮委派多个专家并行）。

**TCUM 不足**：
1. **只有一种隔离模式**——"用户前面说过我关注深圳区域"这类前因后果，**全靠 LLM 把它写进 `description`**，写漏就丢；
2. **未见 `filterIncompleteToolCalls` 等价保护**；
3. **子 Agent 结果是一段文本**——父 Agent 拿不到结构化中间证据（查了哪些指标、看了哪些实例），削弱最终结论的可追溯性；
4. **完全未利用 prompt cache**。

**解决思路**：
- **O15.1** Agent 配置增加 `context_mode: clean | fork | fork_cached`，按任务类型选择；
- **O15.2（成本，P1）** 对 `fork_cached` 保证子 Agent 请求**前缀字节完全一致**（system prompt + 工具定义 + 历史前缀），命中供应商 prompt cache。运维场景子 Agent 调用频繁，节省可观。**注意 CC 的相关经验：设置路径要用内容哈希，否则路径变化会破坏前缀一致性**；
- **O15.3** 子 Agent 返回 `{conclusion, evidence[], tools_used[], confidence}`，父 Agent 汇总时保留证据链——**这也是 Q22 引用溯源的前置条件**；
- **O15.4** 委派前由代码（而非 LLM）自动把"关键会话事实"（用户指定的租户/地域/时间范围）附加到 `description`，减少信息丢失。

---

## Q16. A2A 协议如何实现？稳定性如何？

**分析逻辑**：跨进程 Agent 通信的三个稳定性问题：**超时判定**（"在忙"和"卡死"怎么区分）、**断线恢复**（中间结果保不保）、**可观测性**（trace 能不能跨进程串起来）。

| | 做法 |
|---|---|
| **TCUM-AI** | `pkg/agent/a2a_agent.go`：子 Agent 流 `idleTimeout = 60s`（`:210`）；A2A server 心跳 15s（`manager.go:823`）；AG-UI SSE 有 `sseHeartbeatInterval`（10s）。双协议出口：8083(AGUI) / 8082(A2A)。**AgentCard 能力发现**：每Agent 通过 `GetA2AConfig` 暴露 Name/Description/Skills/Version。两种 A2A 工具模式：`ToolA2AQuery`（非流式）/ `ToolA2AStreamQuery`（流式） |
| **CC** | `swarm/reconnection.ts` 做**状态快照与重连** |
| **Codex** | 无跨进程 Agent 协议（worktree 内多 agent 在同机） |
| **OpenClaw** | Gateway 是唯一事实来源，客户端（CLI/Web UI/macOS/移动节点）通过**配对（pairing）**接入；有 RPC 参考文档。移动节点作为"感知/执行外设"而非独立运行时——**这是一种中心化拓扑，天然避免了分布式 Agent 的一致性问题** |

**差异本质**：**OpenClaw 的中心化 Gateway 是最省心的架构**（一个进程持有全部 session 状态，客户端只是终端）；TCUM 是分布式（多进程多机器多团队），能力上限高但一致性问题多。**这是"个人助手"与"企业平台"的架构必然差异。**

**TCUM 亮点**：
1. **AgentCard 能力发现**——支持 Agent 间动态能力发现与协商，是真正的协议化而非硬编码；
2. **双协议出口**（AGUI 面向前端富事件、A2A 面向 Agent 间调用）——同一实例两套协议，职责清晰；
3. 流式/非流式两种 A2A 工具模式，按任务耗时选择。

**TCUM 不足**：
1. **`idleTimeout=60s` 对长任务偏短**——跨产品根因定位的子 Agent 可能思考/查询超 60s 无输出被误判空闲中断；且**硬编码不可配**；
2. **无断线重连与状态快照**——子 Agent 流一断整个中间结果丢失；
3. **跨进程/跨平台 trace 断链**——Langfuse trace 到 `AGUIAgent.Run` 就断，对端（尤其 Knot / SRE 外部平台）内部的 LLM 调用与工具调用完全看不到。**这是所有跨平台 Agent 协作的通病**。

**解决思路**：
- **O16.1** `idleTimeout` 配置化 + 子 Agent 长任务周期性发 `progress` 事件充当业务心跳；
- **O16.2** 子 Agent 执行按步骤落快照（Redis），断线重连从最后一步继续；
- **O16.3（重要）** **trace context跨进程传播**：通过 W3C Trace Context（`traceparent` header）或 Langfuse 的 parent observation ID 透传，让子 Agent（含外部平台）的 span 挂到父 trace 上。**这是当前可观测性最大的黑洞**。

---

## Q17. MCP 的 Client / Provider 双向能力实现如何？

**分析逻辑**：MCP 是 2024 末以来的事实标准。作为 Consumer 关注**连接管理与鉴权**；作为 Provider 关注**契约稳定性**。双向都做的项目很少。

| | 做法 |
|---|---|
| **TCUM-AI** | **Provider**：12 个子 MCP Server 约 128 工具，路径 `/tcum-mcp/{name}`，转换链 `AdaptEinoTool → convertToolInfo → ToJSONSchema → mcpgo.NewToolWithRawSchema`；**云 API MCP 化**（`pkg/capi`：YunAPI → MCP 工具）；数字分身 MCP 对外暴露记忆/画像查询。**Consumer**：静态（配置 `mcp_servers` 启动期发现，`{Server}_{Tool}` 仅作为 ToolManager 注册键；源码没有同步改写 `ToolInfo.Name`，模型侧同名冲突仍是缺口）+ 动态（`DynamicMcpMiddleware` 每次 `BeforeAgent` 按 `TwinInfo.McpConfig` 现建 client，支持 `streamable-http`/`sse`、`${VAR}` 占位符、`allowedTools` 白名单、`{Server}.{Tool}` 命名空间、单 server 失败只warn） |
| **CC** | Consumer 侧完整：`mcp/client.ts` 连接管理、`mcp/config.ts` 多源配置合并、`InProcessTransport`/`SdkControlTransport` 传输抽象、**`MCPConnectionManager.tsx` 连接生命周期状态机**、`channelPermissions.ts` 通道权限、**`mcp/auth.ts` OAuth 认证流**、**`officialRegistry.ts` 服务发现**、企业 MCP 配置与策略过滤 |
| **Codex** | 支持 MCP 扩展工具（配置在 `config.toml`） |
| **OpenClaw** | 工具/技能/插件体系 + **ClawHub 插件市场（发布/策展/信任指南）**——**这是四家里唯一有"插件市场 + 信任审核"的**，本质上起到了 MCP registry 的作用 |

**差异本质**：
- **TCUM 是唯一的强 Provider**（128 工具 + 云 API 批量 MCP 化）——这是它作为"平台"而非"应用"的体现；
- **CC 是最完整的 Consumer**（OAuth、连接状态机、服务发现、企业策略）；
- **OpenClaw 有生态治理层**（市场 + trust）。

**TCUM 亮点**：
1. **云 API MCP 化（`pkg/capi`）是规模化的关键**——云 API 有上千个 action，手写工具不可能覆盖，批量转换才有规模效应；
2. **既是 Consumer 也是 Provider**，且Provider 侧有 `AdaptEinoTools` 整体失败策略（拒绝半可用）；
3. **`${VAR}` 占位符 + per-request JWT** 支持了"用户维度鉴权透传到 MCP"的技术形态（虽然 §Q25 显示实际未用于身份透传）；
4. `descAnnotatedTool` 工具级装饰器（动态改 Desc 追加可用 kb_code 列表）——绕过所有 hook，可复用于限流/缓存/权限。

**TCUM 不足**：
1. **每次运行前重新拉工具列表**——每轮对话 N 次 `list_tools` 往返，无缓存无 TTL；
2. **无 OAuth**——仅 header 塞 token，对接第三方 MCP 受限；
3. **无连接池与生命周期状态机**——每次新建 client，失败 log+continue；
4. **无服务发现/注册表**——MCP 列表靠人工配置；
5. 无通道权限；命名空间化加长工具名耗 token；
6. **无 MCP 契约版本化**——对外 128 工具，任一改名/改参数可能打破外部消费方。

**解决思路**：
- **O17.1（P0，延迟收益最直接）** 按 `serverURL + token 指纹` 缓存 tool list，TTL 5~10 分钟，支持 MCP `notifications/tools/list_changed` 主动失效——**可直接砍掉每轮的 list_tools 往返**；
- **O17.2** 连接池 + 健康检查 + 对连续失败 server 熔断（复用现有阈值 3 模式）并告警；
- **O17.3** 预留 OAuth 2.0 授权码流；
- **O17.4** 内部 MCP registry（可直接放 CMDB 自定义模型），支持按域检索，配合 Q9 动态工具裁剪；
- **O17.5** MCP 路径带版本（`/tcum-mcp/v1/monitor`），破坏性变更升版本并保留旧版一个周期；`ToolInfo` 序列化为 golden 文件做快照测试；
- **借鉴 OpenClaw**：若未来开放第三方接入 MCP，需要trust/策展层（谁能发布、谁审核、如何标记可信度）。

---

# D. 知识与记忆

## Q18. RAG 检索质量如何保证？

**分析逻辑**：RAG 的效果由四环决定：**召回（能不能找到）、排序（相关的在不在前面）、阈值（不相关的有没有被挡住）、一致性（索引与查询用同一个向量空间吗）**。任一环坏了整体失效，而且**大多是静默失效**。

| | 做法 |
|---|---|
| **TCUM-AI** | **两套完全独立的 RAG**：**体系 A（监控元数据）** `usercases/obs_agent/rag/`，自建 ES8（eino-ext es8 indexer/retriever），进程内自算 embedding（混元/Venus/OpenAI 三选一），索引 `metric_meta`/`barad_metric_meta`/`cls_topic_meta` 三个**同构**索引（只差索引名 + 过滤字段 + 数据源），`RetrieverConfig.TopK: 5` 但 `FindMetrics` 调用时按路传 **20**，`Hybrid: true`，**`RRF: false`**（注释：*RRF only available with specific licenses*），`ScoreThreshold` **未设置**，Indexer `BatchSize: 10`，灌库靠 `embedding_job` **每 5 分钟全量重建**；**检索层有双路 query + 位次融合**（见下方亮点 3）；**体系 B（通用知识库）** `pkg/rag/` + `usercases/kb_server/`，走 **trag 平台**（内部向量检索 PaaS，HTTP API），embedding 与切分都在 trag 侧 |
| **CC** | 主要靠文件系统检索（grep/glob）+ 语义搜索，**编码场景对向量 RAG 依赖低** |
| **Codex** | 同上——**代码检索用ripgrep 比向量检索更准**。`AGENTS.md` 承载"不可从代码推断的知识" |
| **OpenClaw** | 记忆/知识章节存在但首页未展开（**未证实**） |

**差异本质**：**这一问上TCUM 与另三家不可直接对比**——CC/Codex 是编码 Agent，语料是代码（结构化、可精确匹配），用 grep 优于向量；TCUM 面对的是"数千个监控指标的自然语言描述"，**必须靠语义检索**。所以 TCUM 在这块的技术债是**独有的、也是必须自己解决的**。

**TCUM 亮点**（完整链路详见正式版 [`05-场景篇` §8](../../01-项目专题/03-TCUM-AI/02-场景案例/05-场景篇-总览与监控域.md)）：
1. **两套体系分工合理**：监控元数据是"一条一档"的结构化检索（自建 ES8 可控），通用文档走 PaaS（不重复造轮子）；
2. **三个 embedding provider 可切换**，有工程灵活性；三个索引**同构复用**同一套 indexer/retriever/embedder，新增知识域成本 = 一个 `meta_service.go`；
3. ⭐**双路 query + 交替穿插的位次融合**（`tool_find_metrics.go:107-160`）：`FindMetrics` **强制要求两个 query 参数** —— `LLMRewrittenQuery`（模型提炼的指标描述）与 `Query`（用户原文全文，schema 里明确要求"全部传入"），各检索 20 条后**交替穿插按 `MetricFullName` 去重**。动机很扎实：只用改写会丢产品/地域线索，只用原文则噪音稀释向量；而两路分数**不可比**（不同 query 打出的分不在同一尺度），所以**按位次融合而不是按分数排序**——**这本质上是 RRF 的极简实现，在 ES商业版 RRF 不可用的约束下拿到了融合的主要收益**；
4. **语料质量做成业务可运营的资产**：灌库时每层描述按 **`ai_description > description > name`** 三级优先级取值，`AiDescription` 是后端专门为 AI 维护的字段——**让最懂指标的人去写"给 AI 看的描述"**，而不是让算法侧猜；
5. **RAG 返回的不只是"找到什么"，还有"怎么正确用"**：结果里带`PrometheusMetricType`（counter/gauge/histogram/summary），因为 counter 不套 `rate()` 会写出**能跑通但结果没意义**的 PromQL；
6. **过滤在ES 层做且两路都生效**：`tenant → QueryTenantConfig → MstackCodes`（支持 `"*"` 展开全量）→ `terms` 过滤，`knn.Filter` 与 `query.bool.filter` **都带上了**（`approximate.go:87`/`:123`），向量召回不会跨租户漏数据。

**TCUM 不足（这是全项目技术债最集中的一块）**：

1. **RRF 被关闭，ES 层的融合退化为"分数直接相加"**。BM25 无上界（受词频/IDF/文档长度影响，常见 5~30+），kNN 对 cosine 的打分归一化在 0~1，直接相加意味着**向量那一路的实际权重接近可忽略，ES 内部的混合检索退化为"BM25 为主 + 向量微调"**。⚠️ 准确表述是"**向量得分被量纲淹没**"而非"向量检索没执行"——它执行了，只是几乎不影响排序。**注意这条与亮点 3 不矛盾**：应用层的双路交替穿插补的是"两个 query 之间"的融合，**ES 内部"BM25 与 kNN 之间"的融合仍然是坏的**，两个层次的问题各自独立。
2. **没有相似度阈值**。`ScoreThreshold` 未设置 → `MinScore` 不下发（`vendor/.../es8/search_mode/approximate.go:142`）→ **永远返回满TopK，哪怕全都不相关**（`FindMetrics` 场景是两路各 20 条）。模型被强行喂入噪音，**这是幻觉的直接来源**。同一段配置里 `Similarity`（kNN 最小相似度）、`K`、`NumCandidates` 也全是 `nil`。
3. **embedding 一致性无守卫**。三个 provider 可切换，但**索引用混元建、检索用 Venus 查 → 向量空间不同 → 结果无意义且不报错**。（有个意外缓解：`embedding_job` 每 5 分钟全量重建，切换后约 5 分钟库内就统一了——但窗口期内是混杂状态。）
4. **embedding 维度与 analyzer 在代码中完全未声明**：仓库里只有 `indexer.Store`，**没有任何 mapping 定义**。维度依赖 ES 侧 mapping 的 `dims`；`content` 的中文分词器同样不可见——若是自动映射的 standard analyzer，中文会被**按字切分**（"内存利用率"→内/存/利/用/率），而 BM25 恰恰是当前的主导路，影响很大。
5. **embedding 语料含结构噪音**：`EmbedContent()` 就是 `json.Marshal(MetricDefine)`，所以 `"MetricStackCode"`/`"MetricTypeName"` 这些**英文字段名也进了向量文本与 BM25 语料**。
6. **灌库任务性价比很差**：`embedding_job` **每 5 分钟全量重建**（三层嵌套 CAPI 遍历 + 全量重新 embedding，`BatchSize=10`），且 `Condition()` 是 `AlwaysTrueCondition()` —— **多实例部署时每个节点都跑一遍**；无变更检测、无影子索引 + 别名切换，某次 CAPI 返回不完整就会把索引写成不完整状态且无回滚。

其他：`TopK` 固定不区分查询类型；**无 rerank**（有 query 改写但无结果精排）；体系 B 的切分策略完全黑盒。

**解决思路**（按 ROI 重排）：
- **O18.1（P0，最高ROI，改一行）** **设置 `ScoreThreshold`**（先采集线上分数分布取分位数），把"永远返回满 TopK"改成"不相关就返回空"。`FormatFindMetricsOutput` **已经有 `CodeNotFound` + `"no relevant metrics were found"` 的分支**，所以模型能明确知道"没找到"而不是拿到 20 条噪音——**这是降低幻觉最直接、成本最低的一手**；
- **O18.2（P0）** 修 **ES 内部**的 BM25↔kNN 融合（与已有的双路 query 融合是两个层次）。RRF 不可用时自己实现，纯排序融合不需要 license：
  ```
  分别取 BM25Top50 与 kNN Top50（两次请求或msearch）
  RRF(d) = Σ_i 1/(k + rank_i(d))，k 取 60
  按 RRF 融合后取 TopN
  ```
  或做分数归一化融合：`score = w_bm25*norm(bm25) + w_vec*norm(vec)`，在候选集内 min-max/z-score 归一化，初始权重 0.4:0.6 用评测集调优。**顺带把现有的"双路 query 交替穿插"也升级成统一的 RRF**，四路（2query × 2 检索方式）一起融合；
- **O18.3（P0，灌库侧）** `Interval` 从 5 分钟拉长到小时级 + `Condition` 改为单实例选主+ 按 `MetricFullName` 做**增量 upsert（内容 hash 比对）**；再进一步用**影子索引 + 别名切换**，避免不完整写入无法回滚；
- **O18.4（P1）** 索引 meta 记录 `embedding_provider + model + dim`，检索时校验不一致则**启动期失败**而非静默返回错误结果；同时把 mapping（`dims`、cosine/dot_product、中文 analyzer）**纳入代码或IaC**，而不是只存在于 ES 侧；
- **O18.5（P1）** 把 `EmbedContent` 从"整个结构体 JSON"改成**为检索优化的自然语言模板**（如 `"{栈描述} / {类型描述} / {指标名}：{指标描述}，单位 {unit}，类型 {promType}"`），去掉英文字段名噪音；
- **O18.6（P1）** 加 rerank 层（cross-encoder 或 LLM 对合并后的 Top20~40 精排取 Top5）—— **注意 query 改写这一环TCUM 已经有了**（双路 query），缺的是**结果精排**；
- **O18.7（P2）** 动态 TopK（按查询类型/首条分数与次条分数的落差决定取几条）。

---

## Q19. 知识如何切分、导入与更新？

**分析逻辑**：切分决定检索片段是否可用；**失效机制决定会不会"按已废弃的方案处理故障"**——后者在运维场景是真实风险。

| | 做法 |
|---|---|
| **TCUM-AI** | **体系 A 不存在切分**：`MetricMetaToDocument()`（`meta_service.go:321`）把**整条指标元数据 JSON 序列化后作为一个文档**，`doc.ID = "{stack}:{type}:info:{metric}"`。**这是合理的**——元数据检索天然"一条一档"，不是长文检索，没有 chunk size/overlap 概念。**体系 B** 走 trag：`CreateCollection`/`UpsertDocuments`/`DeleteDocuments`/`ImportFile`/`GetImportState`/`GetCollectionMeta`，**切分由 trag 侧负责（黑盒）**。Embedder 工厂：`cloud_hunyuan` / `venus_proxy_api`（`DefaultTimeoutSeconds=60`）/ `openai` |
| **CC / Codex** | 无独立知识库导入流程（代码即知识源，天然"实时"） |
| **OpenClaw** | ClawHub 插件/技能分发 + 策展；知识库导入未展开（**未证实**） |

**差异本质**：**CC/Codex 的知识源是"活的"（代码库），TCUM 的是"死的"（导入的快照）**。这带来一个 CC/Codex 完全没有的问题：**知识过期**。

**TCUM 亮点**：**体系 A 不切分是正确判断**——识别出"元数据检索 ≠ 长文检索"，避免了套用通用 chunk 策略。这个判断本身值得讲（很多团队会无脑上 chunk size=512/overlap=50）。

**TCUM 不足**：
1. **体系 B 切分完全不可控**——运维文档含表格、代码块、YAML，通用切分会切碎结构，检索出来的片段无法使用；
2. **无失效/过期机制（运维场景的真实风险）**——指标下线、文档废弃后旧向量仍被检索到，可能导致"**按已废弃的方案处理故障**"；
3. 增量更新粒度粗（`BatchSize: 10` 偏小，全量重建成本高）；
4. **无导入质量校验**——导入后不知道"这批文档是否可被正确检索"。

**解决思路**：
- **O19.1** 结构感知切分：若 trag 支持自定义切分则传入策略；否则**导入前预处理**——按 Markdown 标题层级切分，表格/代码块保持完整不切，每 chunk 补"文档标题 + 章节路径"作为上下文前缀；
- **O19.2** 文档/指标元数据加 `valid_until`/`deprecated`/`version`，检索时过滤失效内容；下线指标同步删向量；
- **O19.3（低成本高价值）** **导入后召回自检**：每批导入后抽样，用文档自身标题作为 query 检索，验证能否命中自己；命中率低于阈值则告警。

---

## Q20. "三层记忆"具体是什么？如何召回与淘汰？

**分析逻辑**：记忆要回答四问：**分几层（生命周期）、写什么（提取规则）、怎么召回（成本）、冲突怎么办**。绝大多数项目只做了"存对话历史"就号称有记忆系统。

| | 做法 |
|---|---|
| **TCUM-AI** | 对外称"三层记忆"，代码实际是**四个松散机制**：① 会话历史（`dialog_history_service.go`，Period 分层摘要）② 分身记忆（`TwinMemory` 表，含 `category`/`key`/`confidence`，**LLM Rerank 精选**：候选池 ≤50 → 每条截 200 字节 → Top-10 → 去重 → 注入 `<memories>`，失败 fallback to recent）③ **Skill 缓存**（`skill_cache.go`：`MaxDistanceThreshold=3`/`MaxCacheSize=10`/`MaxContentLength=20KB`/`ExpiredRetentionRounds=2`/`ExpiredHint="[Skill内容已过期，如需使用请重新加载]"`，距离优先 + LastAccessed tie-break 的近似 LRU）④ 分身画像（`Soul`/`Preferences` 注入 `<soul>`/`<preferences>`） |
| **CC** | `CLAUDE.md` 项目记忆 + 会话持久化 + `compact` 三级压缩；记忆是**显式文件**，用户可编辑 |
| **Codex** | **`AGENTS.md`** 分层（全局/项目/子目录）——**记忆即文件，可 git 管理、可 review、可 diff** |
| **OpenClaw** | "智能体 → 上下文、记忆"章节存在；会话按 agent/workspace/sender 隔离；定位是"**学习并与你共同成长**的个人助手"，**记忆是其核心卖点**，但实现细节未展开（**未证实**） |

**差异本质**：**CC/Codex 把记忆做成"用户可读可编辑的文件"，TCUM 做成"系统自动管理的数据库记录"**。前者透明可控但需用户维护，后者自动但**不可解释**（用户不知道 Agent"记住"了什么、为什么这次没用上）。

**这是一个值得讲的产品判断**：运维场景的数字分身，用户是运维专家，**他们可能更希望能"看见并修改"分身的记忆**——这更接近 `AGENTS.md` 模式。

**TCUM 亮点**：
1. **Skill 缓存的"距离衰减 + 过期提示语"建模很好**：过期不硬删，而是替换成 `[Skill内容已过期，如需使用请重新加载]`——**让模型知道"这里曾有内容，现在没了，需要就重新加载"，而不是凭空消失导致困惑**；
2. **LLM Rerank 有两处 fallback**（解析失败/调用失败都退到 recent memories）；
3. `TwinMemory` 的表结构**六个自进化字段一个不缺**（`Source`/`SourceDialogID`/`Confidence`/`HitCount`/`LastHitAt`/`TTL`）——设计时把闭环的位置留对了；
4. Period 分层摘要 + LLM 合并失败 fallback 为**直接拼接原细粒度 period**（宁可这次不压缩也不丢信息），**服务永不中断**。

**TCUM 不足**：
0. **⚠️表结构全对，闭环全缺（最该主动说的一条）**：`Source` 恒为 `manual`（全仓无 `"auto"` 写入路径）、`HitCount`/`LastHitAt` 命中后**无任何 +1 逻辑**（只在 PO↔PB 转换里出现）、`Confidence` 创建时置 1.0 后**永不改变**、`TTL` **没有任何清理任务读它**。即"怎么用"这一环做得不错，但"谁来写"和"怎么退化"两环是空的。另外反馈数据（`Rating`/`Tags`/`Comment` → `LikeTopTags`/`DislikeTopTags`/环比）**唯一消费者是运营周报，不回流prompt/记忆/路由**——**把反馈做成了报表，没做成回路**。详见正式版 [`10-对抗机制与自进化.md`](../../01-项目专题/03-TCUM-AI/05-演进与对比/10-对抗机制与自进化.md) §2.4/§2.5（含 CC `extractMemories` 分叉 Agent 自动提取、"可推导即不存"排除原则、新鲜度警告的完整抄法与三阶段落地）；
1. **"三层记忆"口径与代码不符**（实际四个松散机制，无统一抽象）——与 `supervisor` 同类问题，对外宣称需更正；
2. **LLM rerank 每轮一次，延迟与成本都不小**；
3. **记忆写入策略不明**——谁决定什么内容值得记？未见明确的"记忆提取"规则或模型；
4. **无记忆冲突消解**——同一事实的新旧记忆并存时如何取舍未定义；
5. `MaxContentLength=20KB` 截断后**模型不知道被截了什么**。

**解决思路**：
- **O20.1（P1）** 明确定义并实现三层，统一到 `pkg/memory` 提供 `Recall(ctx, scope, query)` / `Remember(ctx, scope, item)`：

| 层 | 存储 | 内容 | 淘汰 |
|---|---|---|---|
| 工作记忆 | 内存/请求内 | 当前轮上下文、skill 缓存 | 轮次距离（沿用 `MaxDistance=3`） |
| 会话记忆 | Redis + DB | 会话摘要、已确认结论、本会话实体 | 会话结束 / TTL |
| 长期记忆 | DB + 向量 | 用户偏好、常查对象、历史故障模式 | 置信度衰减 + LRU |

- **O20.2** 召回降级为"向量/BM25 粗排（零 LLM 成本）+仅候选 > N 时才小模型精排"；
- **O20.3** 显式记忆提取白名单（用户负责的产品、常用地域、偏好输出格式、已确认的环境事实），避免把整段对话当记忆；
- **O20.4** 记忆带时间戳与置信度，冲突时新覆盖旧并保留审计；
- **借鉴 Codex/CC（推荐）**：给数字分身提供一个**用户可见可编辑的"分身记忆卡"**（等价于 `AGENTS.md`），把系统自动提取的记忆展示出来允许人工修正。这既提升可解释性，也让专家经验的沉淀变成显式动作。

---

## Q21. 会话如何持久化与恢复？

**分析逻辑**：三个问题：**并发写会不会互相覆盖、断线能不能续、事后能不能重放当时的决策**。

| | 做法 |
|---|---|
| **TCUM-AI** | 会话与消息落 DB（`dialog_history_service.go`）；`agent_config_cache.go` 配置缓存 + 熔断（阈值 3）；AG-UI SSE 有心跳；`CompactEvents` 持久化时合并 chunk。**`CheckPointStore` 未配置**（`DefaultAgent.Resume` 已转发但无 store） |
| **CC** | `sessionStorage.ts` 存储策略 + **`conversationRecovery.ts` 断点续传** + **事件溯源**（可精确重放） |
| **Codex** | 会话可resume（`codex resume`）；`~/.codex/` 下存会话记录 |
| **OpenClaw** | **Gateway 是 sessions 的 single source of truth**，进程常驻天然持有会话状态；多客户端（CLI/Web/macOS/移动）接同一 Gateway，**会话状态天然一致** |

**差异本质**：**OpenClaw 的中心化常驻 Gateway 在这一问上是架构级优势**——不需要"恢复"，因为进程没停、状态一直在内存里。TCUM 是无状态服务 + DB，必须显式做恢复。

**TCUM 亮点**：`CompactEvents` 在持久化时合并碎片 chunk——兼顾流式体验与存储成本，这个取舍做得对。

**TCUM 不足**：
1. **未见断点续传**——流式响应中途断开（刷新/网络抖动），已生成部分与已执行工具结果是否可恢复不明确；
2. **同会话并发未处理**——用户快速连发两条消息 / 多端同时操作，可能消息交错、状态覆盖；
3. **无事件溯源**——存的是最终态消息，**无法回答"当时模型看到的上下文究竟是什么"**；
4. `CheckPointStore` 未配置，导致 eino 已有的 interrupt/resume 能力（含**并发工具批次里的"部分完成"可断点续跑**）完全闲置。

**解决思路**：
- **O21.1（P0，数据一致性）** 会话加 `version` 字段 CAS，或按 `dialog_id` 分布式锁串行化，拒绝并发请求并给明确提示；
- **O21.2** 流式输出按 chunk 落地（Redis + 序号），重连时按 `last_event_id` 续推（**SSE 原生支持 `Last-Event-ID`**）；
- **O21.3** 每次调模型前把"实际发送的 messages摘要 + token 分布"落 trace（存哈希 + 结构，不必存全文），便于事后归因；
- **O21.4** 配置 `CheckPointStore` —— **这一个动作同时解锁：HITL 审批（Q23）、并发工具部分完成续跑、子 Agent 断线续传**。是杠杆最大的单点改动。

---

## Q22. 如何控制幻觉？

**分析逻辑**：Agent 的幻觉比纯 LLM 更危险——因为它有工具，**看起来"有数据支撑"，实际可能是把不相关的检索结果编成了结论**。控制要从"输入侧（别喂噪音）"和"输出侧（强制溯源）"两头做。

| | 做法 |
|---|---|
| **TCUM-AI** | 主要靠**工具返回真实数据 + prompt 约束**：SKILL.md 明确铁律"所有工具返回结果是唯一数据来源，禁止编造不存在的指标/插件/数据"；`summarizeUserInstruction` 有行为约束（不要复制样例 JSON、要列 COS_URL 清单）；`entity_tag_inject` 让实体引用变成可验证的 `entity://` 链接 |
| **CC** | 工具结果为准+ 引用文件路径行号（**代码场景天然可验证**） |
| **Codex** | **执行验证**：改完代码跑测试/lint，**用程序判定对错**——这是最强的反幻觉机制 |
| **OpenClaw** | 未展开（**未证实**） |

**差异本质**：**Codex/CC 的反幻觉优势是"输出可被程序验证"**（代码能编译、测试能跑）。TCUM 的输出是"分析结论"，大部分不可自动验证——**除了 PromQL/InfluxQL/Grafana JSON 这三类**。

**这给了一个明确的方向**：TCUM 应该**尽可能把结论转成可验证形式**。例如"CPU 使用率 95%"这个结论，可以在后处理层用规则提取数值，与本轮 `tool_result` 做匹配校验——**这就把不可验证的自然语言结论部分变成了可验证的**。

**TCUM 亮点**：
1. **SKILL.md 的铁律层**——把"禁止编造"写成强约束句式，是低成本高收益的做法；
2. **PromQL/InfluxQL 专家的执行验证闭环**（生成 → 真跑 → 读错误 → 修正）——**这是 TCUM 少数达到 Codex 级反幻觉强度的地方**；
3. **Grafana 看板的"代码保结构"**——结构性幻觉被彻底消除；
4. `entity_tag_inject` 让实体引用可点击验证。

**TCUM 不足**：
1. **RAG 无相似度阈值是幻觉的最大来源**（Q18.2）——检索永远返回 5 条，模型被迫基于不相关内容作答；
2. **无引用溯源要求**——模型给结论时不强制标注"依据哪个工具的哪条数据"，用户无法验证。**运维场景一个编造的指标值可能直接导致错误的回滚决策**；
3. **无不确定性表达机制**——模型倾向给确定答案，但"我不确定，建议人工确认 X"往往才是正确输出；
4. **无事实校验层**——数值类结论未与工具原始返回做交叉校验。

**解决思路**：
- **O22.1（P0，信任基础）** **强制引用溯源**：要求结论中每个关键数值/事实标注来源 `[tool:tool_name, ts]`；后处理层校验"结论中的数字是否出现在工具返回中"，不匹配则标记告警。**对告警诊断、变更分析、SLO 分析三个 Agent 优先落地**——它们的结论直接影响回滚/扩容决策；
- **O22.2** 配合 Q18.2，检索无结果时明确告知模型"知识库无相关内容，请基于工具实测数据回答，或告知用户信息不足"；
- **O22.3** 结构化输出增加 `confidence`与 `caveats[]`，前端对低置信度结论显著标注；
- **O22.4** 响应返回前用规则提取结论中的数值，与本轮 `tool_result` 做匹配校验；
- **O22.5（战略性）** **扩大"可程序验证"的输出比例**：巡检项生成加 dry-run、Grafana 看板加"试导入 Grafana API 验证"、告警规则加"回放历史数据看是否会误报"。**把Codex 的"跑测试"思想迁移到运维域。**

---

（续见 `09-30问-安全可观测与性能.md`）
