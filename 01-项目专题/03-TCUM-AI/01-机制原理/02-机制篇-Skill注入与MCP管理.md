# 第一篇之二 · Skill 注入 + MCP 双向管理

---

# 2. Skill 注入（声明式能力扩展）

**为什么会有 Skill 这一层（真实痛点现场）**：同样一个告警 ID，不同 prompt 可能因为工具调用顺序不同而得到完全不同的诊断质量。大量细分场景都有各自的标准作业流程，但不能全部塞进 System Prompt，否则会导致 prompt 膨胀和场景干扰；也不能全部写死在代码里，否则每改一个流程都要发版。Skill 要解决的是：让流程知识脱离业务代码、避免全量注入，并能按意图只加载当前场景需要的操作说明。

## 2.1 为什么要有 Skill 这一层

工具（Tool）解决"能做什么"，但运维场景更大的成本在"**怎么做才对**"：告警分析要先查详情再查指标再判趋势，顺序错了结论就错。

- 把流程写进代码 → 每个场景都要发版；
- 把流程写进 System Prompt → prompt 无限膨胀且场景间互相干扰。

Skill 的定位：**用 Markdown 声明"某类任务的标准作业流程 + 铁律约束"，按需加载进上下文**。48 个 SKILL.md，分 `obs/monitor/`（13+）、`obs/inspection/`（6）、`obs/iwiki/`（1）、`ops/tcumtcs/`（1）等。

```markdown
---
name: alarm-id-analysis
description: 告警ID分析技能。当用户提供了具体的告警ID，需要分析该告警的详细信息和趋势时使用此Skill。
---
# 执行步骤
1. 调用 GetAlertById 获取告警详情
2. 调用 PrometheusQuery 查询相关指标数据
3. 分析趋势，输出诊断报告
```

SKILL.md 承载三类规则（prompt 工程的实际落点）：

| 规则类型 | 设计思路 | 示例 |
|---|---|---|
| **强约束（铁律）** | "必须/禁止"句式明确红线，防幻觉 | "任何工具调用失败必须立即停止，禁止推测继续" |
| **流程约束** | Step-by-Step 强制串行顺序 | "Step1 先调校验工具；Step2 再调分析工具" |
| **输出格式规范** | 固定格式确保 UI 渲染正确 | 输出告警 JSON 后必须附带"一键填充"按钮提示文案 |

**核心防幻觉设计**：明确规定"所有工具返回结果是唯一数据来源，禁止编造不存在的指标/插件/数据"，从提示词层面堵死LLM 自由发挥。

**"声明即执行"的交付链路**：编写 SKILL.md → CI/CD 验证 → 上传 COS → 服务轮询 30s 热更新 → 技能注册 → 用户触发 → MCP 工具调用链 → 聚合结果输出。**运维专家不写 Go 代码就能上线一个新能力**——这是这套设计最实际的组织价值。

## 2.2 注入机制：两个中间件 + 两个工具

Skill 不是静态工具，靠**两个 `BeforeAgent` 中间件**动态注入：

```go
// cmd/server/common/agentserver/agent_builder.go:215
skillMW, _ := skill.NewMiddleware(ctx, &skill.Config{Backend: skillBackend})
chatModelAgentMiddlewares = append(chatModelAgentMiddlewares, skillMW)

// 条件注入 skill_exec（agent_builder.go:222-234）
if len(agentCfg.Skills) > 0 && IsSkillExecEnabled() {
    execHandler, _ := BuildSkillExecMiddleware(ctx, skillBackend, GetGlobalSandboxExecutor(), agentCfg.SkillEnvs, agentCfg.Name)
    chatModelAgentMiddlewares = append(chatModelAgentMiddlewares, execHandler)
}
```

| 中间件 | 钩子 | 注入工具 | 作用 |
|---|---|---|---|
| `skillHandler`（eino 官方 `skill.New`） | `BeforeAgent` + **`WrapModel`** | `skill` | `List` 只给 frontmatter（name+description），模型判断需要时才 `Get(name)` 拉全文 |
| `skillExecHandler`（自研 `skill_exec.go:205`） | `BeforeAgent` | `skill_exec` | 在沙箱内执行 skill 目录下的脚本 |

`skillExecHandler.BeforeAgent` 的实现（典型的"中间件注入工具"模式）：

```go
func (h *skillExecHandler) BeforeAgent(ctx, runCtx) (...) {
    runCtx.Instruction += "\n" + h.instruction// 使用说明拼进 system prompt
    if h.mcporterInstruct != "" {
        runCtx.Instruction += "\n" + h.mcporterInstruct  // 条件追加 mcporter 调用约定
    }
    runCtx.Tools = append(runCtx.Tools, h.tool)        // 工具塞进本次运行的工具列表
    return ctx, runCtx, nil
}
```

**为什么用中间件而非静态注册工具**（三个理由，都是真实动机）：
1. **条件化按需开启**——只有配了 `skills` 且全局开关打开才注入，避免所有 Agent 平白多一个工具；
2. **携带上下文相关依赖**——`SkillExecTool` 需要 `dirResolver`（解析 skill 目录）、`executor`（沙箱）、`envs`（agent 级环境变量），这些在中间件构建时注入，跟静态工具池"一次构建全局共享"模式不同；
3. **工具与用法说明绑定注入**——保证模型不会"拿到工具却不知道怎么用"。

## 2.3 四种 Skill Backend + 渐进披露

项目把 eino 的 `einoskill.Backend`（`List`/`Get`）和自研 `SkillDirectoryResolver` 组合成统一接口：

```go
// cmd/server/common/agentserver/cos_skill_backend.go:96
type SkillBackend interface {
    einoskill.Backend            // eino 的：List/Get
    agent.SkillDirectoryResolver // 自研的：给 skill_exec 定位目录
}
```

| # | 实现 | 数据源 | 特性 |
|---|---|---|---|
| 1 | `LocalSkillBackend`（`local_skill_backend.go:37`） | 本地目录递归扫 `SKILL.md` | 惰性加载 + `fsnotify` 热更新（`StartWatcher:266`，500ms debounce） |
| 2 | `CosSkillBackend`（`cos_skill_backend.go:50`） | DB 元数据 + COS 下载 | 版本戳增量同步、本地缓存 `/tmp/skill_cache`、**模块/子 skill 两级渐进披露** |
| 3 | `SkillCOSLoader`（`skill_cos.go:52`） | COS + `md5.txt` | 启动全量拉取，外部 Job 检查 md5 触发热更新，COS 不可用时本地兜底 |
| 4 | `filteredSkillBackend`（`skill_manager.go:216`） | 包装 `SkillManager` | **allowlist 权限校验** + 持指针而非快照（热更新自动生效） |

**#4 是全项目 skill 层唯一的权限检查，且带审计日志**：

```go
func (b *filteredSkillBackend) Get(ctx context.Context, name string) (skill.Skill, error) {
    if !slices.Contains(b.allowNames, name) {
        log.WarnContextf(ctx, "skill invoke rejected by allowlist, agent: %s, skill: %s, user: %s, session: %s",
            b.agentName, name, utils.GetUserID(ctx), resolveSessionKey(ctx))
        return skill.Skill{}, fmt.Errorf("skill not allowed for this agent, skill: %s", name)
    }
    ...
}
```

三个 backend 共享两段后处理：`compactSkillContentForLLM(name, content)` 内容压缩，以及 mcporter schema 按需追加。

## 2.4 mcporter 路线：MCP 工具零“独立 tool-schema”占用（重点亮点）

**这是最值得吹的一条，因为它解决的是业界通病。**

常规 MCP 集成的问题：工具 schema **每轮全量发送**。128 个工具全放约需 15k~25k token，**光工具定义就吃掉 1/4 上下文**；且业界经验是工具数 > 30 后模型选择准确率明显下滑。

| |路线 A：常规 MCP 中间件 | **路线 B：mcporter** |
|---|---|---|
| 工具形态 | 注册成 eino `tool.BaseTool` | **沙箱 CLI 命令** |
| 初始正式 tools schema | 每个 MCP tool 都是一个独立 schema，通常每次模型调用都随 tools 参数发送 | 固定只有 `skill`（技能索引/加载器）和 `skill_exec`（通用执行器）；**远端 MCP tool 不逐个成为 `tool.BaseTool`** |
| MCP 工具说明何时进上下文 | 发现后作为独立 Function Calling schema 常驻本次 Run | **只在模型调用对应 `skill`、Backend 执行 `Get` 后，作为该次 `skill` 的 tool result 追加到 Skill.md 正文尾部** |
| 调用方式 | LLM function calling | LLM 写脚本调 `mcporter` CLI |

这里的“零 schema”一定要说准确：它是指**远端 MCP 的 N 个工具不会占据 N 个模型 Function Calling schema**，并不是说模型上下文里只剩一个工具。当前 Agent 仍有 `skill` 与 `skill_exec` 两个固定工具；模型通过前者按需获取说明，通过后者执行命令。远端工具的名字、描述、参数只作为后续消息中的文本出现，不是 Provider tools 数组里的独立函数。

实现：`mcporter_schema.go:50` 的 `fetchMcporterSchema(ctx, executor, sessionKey, skillName, skillDir, envs, cache)` 在沙箱里运行 `mcporter list` 获取工具说明，缓存后追加到 skill 正文。

### mcporter.json 不是脚本：两次“使用配置”的完整时序

`config/mcporter.json` 是开源 [mcporter](https://github.com/openclaw/mcporter) CLI 的 MCP Server 连接配置，不是 tcum-ai 自己实现的 MCP 协议，也不是一份会自动执行的脚本。它典型包含 `mcpServers`、Server URL、headers 以及 `${TCUM_TOKEN}`、业务 header、PAT 等占位符。tcum-ai 自己实现的是“发现这个文件、注入会话敏感变量、在沙箱调用 mcporter、把结果放回模型上下文”的集成层。

一次带 mcporter 配置的 Skill 在一轮 ReAct 中有两个不同的阶段，不能混为“调用 Skill 就已经调用了业务 MCP 工具”：

```text
第 1 次模型调用
  → 模型先看到 skill 的目录摘要，决定 skill({"skill":"operations-analysis"})
  → eino skillTool.InvokableRun 调 Backend.Get("operations-analysis")
  → filteredSkillBackend.Get 检测该 Skill 目录存在 config/mcporter.json
  → SandboxExecutor 将整个 Skill 目录同步到会话私有工作区
       （其中包括 SKILL.md / scripts / resources / config/mcporter.json）
  → 对 mcporter.json 做声明式占位符替换：
       ${TCUM_TOKEN}、ExecutionContext.McpHeaders、分身 EnvVars、agent SkillEnvs 等
  → 在沙箱执行“能力发现”，而非调用具体业务工具：
       mcporter --config config/mcporter.json list
       mcporter --config config/mcporter.json list <server> --all-parameters
  → 将发现到的工具名、描述、参数说明拼接到已加载 Skill.md，作为 skill tool result 返回

第 2 次模型调用
  → 模型阅读刚返回的 Skill.md 与 MCP 工具说明
  → 决定具体调用 skill_exec({skill_name, command:"mcporter call server.tool --args '{...}'"})
  → skill_exec 再次同步/刷新 mcporter.json（即使 Skill 文件未变，也刷新 JWT）
  → 沙箱中的 mcporter 读取该配置，作为 MCP Client 向远端执行 tools/call
  → stdout/stderr 作为 skill_exec tool result 回给模型
```

因此，**自动跑 `mcporter list`、解析 Server、追加 schema 是代码行为，不是 Prompt 约定**。模型只负责发起 `skill(name)`；`filteredSkillBackend.Get()` 发现 `mcporter.json` 后自动走该代码路径。提示词只负责指导模型在已经获得工具说明后，使用 `skill_exec` 执行 `mcporter call ...`。

上述“发现”结果以 `sessionKey:skillName` 缓存；同会话重复加载相同 Skill 不必重复 `list`。而执行阶段的 `mcporter.json` 会按会话目录隔离，并在后续执行时重新上传，以避免过期 JWT 或不同会话的 header 互相覆盖。

条件检测（`skill_exec.go:246-254`）：

```go
skillMgr, ok := dirResolver.(*SkillManager)
if ok && skillMgr != nil {
    agentSkillNames := skillMgr.GetAgentSkillNames(agentName)
    if skillMgr.HasAnyMcporterSkill(agentSkillNames) {
        mcporterInst = mcporterInstruction
    }
}
```

> ⚠️ **已知缺陷（诚实版）**：这里只对 `*SkillManager` 做类型断言，走 COS/Local backend 时断言失败，**mcporter 说明不会注入**。这是真实的实现瑕疵，面试主动讲出来反而加分。

**这条路线的思想可以拔高**：它本质是把"能力发现"从 **schema 层**（每轮成本）搬到 **正文按需注入层**（一次性成本），与 skill 的两级渐进披露、CC 的"工具搜索 + 延迟加载"是**同一个模式的不同实现**——**上下文中的每一个token 都应该是"当前这一步真正需要"的**。

## 2.5 `skill_exec` 沙箱执行：stdin 的巧思

`SkillExecTool`（`pkg/agent/skill_exec.go`）是真正的 `tool.InvokableTool`（`var _ tool.InvokableTool = (*SkillExecTool)(nil)` 编译期确认），参数 `skill_name` / `command` / `stdin`。环境变量约定：

- `$SKILL_DIR`：skill 源码目录（cwd）
- `$WORKSPACE_DIR`：可写工作目录
- `$SKILL_OUT_DIR`：产物输出目录

**最值得讲的是 `stdin` 设计**：大段内容（LLM 生成的整个 Python 脚本、或一大段 JSON）经**文件系统预写入 + 管道注入**，而非拼进 shell 命令行。一个设计同时解决两个问题：

1. **shell 转义安全**——避免引号/反引号/`$()` 被 shell 解释，天然消除一类命令注入；
2. **消息体大小限制**——命令行长度有 `ARG_MAX` 限制，走 stdin 没有此约束。

### `skill` 与 `skill_exec` 各自到底做什么

| 维度 | `skill` | `skill_exec` |
|---|---|---|
| 本质 | Skill 的索引与按需加载器 | 一个统一的、面向 Skill 目录的沙箱命令执行器 |
| 模型调用参数 | `{"skill":"<skill-name>"}` | `{"skill_name":"<skill-name>","command":"<shell command>","stdin":"<optional>"}` |
| 返回内容 | 完整/精简的 SKILL.md、BaseDirectory、可选 mcporter 工具说明；特殊 `fork` Skill 可运行子 Agent | 脚本、CLI 或 mcporter 的 stdout；失败时附 exit code 和最多 8KB stderr |
| 是否执行业务动作 | 默认不执行；主要是加载“怎么做”的说明 | 执行实际动作：Python/Node/sh 脚本、CLI、mcporter call 等 |
| 是否拥有远端 MCP 的独立 schema | 不拥有；只把 schema 以文本说明放入 tool result | 不拥有；只是执行 `mcporter call` 的统一入口 |
| 本次 Run 中的可见性 | 固定 schema 始终在；某个 Skill 正文仅在调用后进入消息历史 | 固定 schema 始终在；不会因 MCP 工具数量变多而增加 schema |

典型 ReAct 时序如下：

```text
模型第 1 轮：看到 skill 的名称/摘要和 skill_exec 的固定 schema
  → skill({"skill":"inspect-cvm"})
模型第 2 轮：读到 inspect-cvm 的 SKILL.md，知道该运行什么脚本或 mcporter 命令
  → skill_exec({"skill_name":"inspect-cvm", "command":"python3 scripts/inspect.py --instance-id ins-xxx"})
模型第 3 轮：读 stdout/stderr，决定继续调用、修正参数或生成最终答复
```

“先 `skill`、后 `skill_exec`”是正确的 Prompt 约定，因为模型需要先读手册再知道该执行什么；但当前服务端**没有维护“本 Run 内该 Skill 是否已经被加载”的强制状态机**。`SkillExecTool` 实际校验的是 `skill_name` 能否由 `SkillDirectoryResolver` 解析到已注册的目录。只要目录存在，模型理论上绕过前一步直接调用 `skill_exec` 也可能成功。因此若要把该流程升级为安全/审计边界，应额外记录并校验本 Run 的已加载 Skill 集合，不能只依赖工具描述。

`command` 是交给 CodeSandbox `Commands.Run` 的自由 shell 命令字符串，不是“只能调用预注册脚本”的 RPC。Skill.md 通过提示词约束模型优先执行预定义脚本，但当前代码没有针对命令做 allowlist、AST 分析或危险模式拦截；安全边界依赖沙箱以及其网络、文件系统、资源配额配置，不能把“有沙箱”表述成“命令天然安全”。

## 2.6 对话级 Skill 缓存：距离衰减近似 LRU

`pkg/agent/skill_cache.go`，运行在 **eino 之外的 service 层**（`agent_service.go:1215`拼历史消息时注入 `<skill_context>`，`buildSkillContextMessage` 最终 `return schema.UserMessage(skillPrompt)`）。

默认配置（`:110-116`）：

```go
MaxDistanceThreshold:   3      // 3 轮后内容标记过期
MaxCacheSize:           10     // 最多 10 个 skill
MaxContentLength:       20000  // 单条 20KB 截断
ExpiredRetentionRounds: 2      // 过期后再留 2 轮才彻底删
ExpiredHint: "[Skill内容已过期，如需使用请重新加载]"
```

四个核心方法：

| 方法 | 位置 | 作用 |
|---|---|---|
| `ExtractFromEvents(ctx, events, userQuery)` | `:144` | 从 AG-UI 事件流解析 skill 调用（`ToolCallStart` → Args 解析 skill 名 → Result），Distance=0 |
| `MergeCache(ctx, oldCache, newSkills)` | `:295` | 旧项 Distance+1 → 超阈值标记过期并替换为提示语 → 超保留期删除 → 新项去重合并 → 容量淘汰 |
| `BuildPrompt(cache)` | `:394` | 渲染 `<skill_context>` 块（按调用时间倒序，含"距离当前 N 轮对话"） |
| `UpdateUsageStats(cache)` | `:436` | UsageCount++ / LastAccessed |

容量淘汰是**距离优先 + LastAccessed tie-break** 的近似 LRU（`:356-368`）：

```go
sort.Slice(cache.Items, func(i, j int) bool {
    if cache.Items[i].Distance != cache.Items[j].Distance {
        return cache.Items[i].Distance < cache.Items[j].Distance    // 距离近的优先保留
    }
    return cache.Items[i].LastAccessed > cache.Items[j].LastAccessed
})
cache.Items = cache.Items[:m.config.MaxCacheSize]
```

**建模意义**：技能内容"随对话推进逐渐淡出"；且过期不是硬删，而是**替换成一句提示语**——让模型知道"这里曾有个技能内容，现在没了，需要就重新加载"，而不是凭空消失导致模型困惑。更新点 `updateSkillCache`（`:1045`）在事件流结束后**异步**执行（`:1610`）。

## 2.7 Skill 层短板

- `MaxContentLength = 20KB` 截断后**模型不知道被截了什么**，复杂 skill 可能不够；
- 只有 `filteredSkillBackend` 一条路径有 allowlist，其他 backend 路径的权限校验需确认；
- mcporter 说明的类型断言缺陷（§2.4）；
- 无 skill 效果度量——哪个 skill 加载后任务成功率高/低、哪个 skill 从未被加载过（死skill），都无数据。

---

# 3. MCP 管理（Consumer + Provider 双向）

**为什么会有这一层**：面临两个选择时的真实困境——**方案 A：内部已有 128 个工具散在 6 个服务进程**，不同项目组（具名平台/天巡/Grafana）都想接——如果每家自己写 SDK，**重复造轮、升级要推多方**；**方案 B：担任 MCP Provider**，统一协议、完全解耦，但内部工具发展很快，契约稳定性难保。又同时，自己也需要 Consumer 能力去拉外部 MCP（腾讯云公共 MCP、三方 SaaS）。直接后果就是——**tcum-ai 对内是 Provider、对外是 Consumer**，双向都得做。而且 128 个连接不能全卡在 stdout（会阻塞）、远端 MCP 鉴权方式各异（不能写死一套），非做封装不行。所以需要回答：**作为 Consumer**（连接管理、鉴权适配、失败降级）、**作为 Provider**（契约稳定性、开发成本内化）——双向都做的项目很少，tcum-ai 是不多的一个。

TCUM-AI 既是 MCP **Consumer** 也是 **Provider**，这一点对外讲很有说服力：**既接入外部工具生态，也把自身能力标准化输出**。

## 3.1 Provider 侧：12 个子 Server，~128 工具

路径 `/tcum-mcp/{name}`：

| 子 MCP | 工具数 | 子 MCP | 工具数 |
|---|---|---|---|
| monitor | 34 | zhiyan | 9 |
| tianxun-access | 22 | barad | 7 |
| grafana | 19 | assess | 5 |
| tianxun | 14 | cls | 4 |
| cmdb | 11 | common / wework-doc / … | 各 1 |

转换链：`AdaptEinoTool → convertToolInfo → ParamsOneOf.ToJSONSchema() → mcpgo.NewToolWithRawSchema`（`pkg/mcp/adapter.go:30,48,67`）。

注册方式是12 行 blank import 触发 `init()` 自注册（`usercases/mcp_server/mcp_register.go`），失败 `log.FatalContextf`。

**一个正确的设计决策**：`AdaptEinoTools`（`adapter.go:103`）**任一转换失败则整体返回 error**，拒绝半可用状态。

**一个明确的不一致**：`agent_access` 的 MCP 工具注册失败只 `log + continue`（`mcp_tools.go:32`），而本地工具是 panic（`usercases/agent_access/tool/register.go:13`）。后者会导致**静默降级**——服务起来了但少了一半工具，表现为"Agent 突然不会做某件事"，极难排查。**应统一为：启动期失败即 panic；运行期动态拉取失败才降级，且必须打指标 + 告警而非只记一行 log。**

**复用范式（值得讲的工程规范）**：`XxxInput` + `XxxCore` + `FormatXxxOutput` + `NewToolXxx`(MCP) / `NewAgentToolXxx`(eino)，**schema 由 `XxxInput` 唯一决定**，一套核心逻辑同时对 eino 和 MCP 暴露，避免两套实现漂移。

**系统自身也对外暴露数字分身 MCP**——把记忆查询、画像查询等能力标准化为 MCP 接口。

## 3.2 Consumer 侧：静态 + 动态两条路

### 先建立全景：配置、MCP 协议发现、Tool 注入、Tool Call 是四件不同的事

MCP 不是“一个 Agent 架构名词”，而是一套可传输的应用层协议。它规定 Client 与 Server 的 JSON-RPC 2.0 消息格式、连接生命周期、版本/能力协商，以及 tools/resources/prompts 等标准对象。以工具为例，正常协议顺序是：

```text
MCP Client                                  MCP Server
  → initialize（协议版本、Client capabilities）
  ← InitializeResult（协商版本、Server capabilities）
  → notifications/initialized
  → tools/list（按 cursor 可分页）
  ← tools[]：name / description / inputSchema / nextCursor
  → tools/call（name + arguments）
  ← content[] / structuredContent / isError
```

`tools/list` 的语义是“列出当前 MCP Client 身份可见的工具集合”；其标准分页参数是 `cursor`，**不是要查询的 tool name**。因此 MCP Server 可以依据 JWT、租户或权限只返回调用者可见的子集，但对于这个调用者，`tools/list` 返回的是该 Server 的可见工具列表（必要时多页）。指定具体工具发生在后续 `tools/call.params.name`，例如 `{"name":"SearchPage","arguments":{"keyword":"MCP"}}`。

这一点正好解释了“同一远端地址有 5 个 MCP 工具”的行为：如果它们属于同一个 server 配置，TCUM 对该 server 做一次初始化与 `tools/list`，会获得这 5 个工具（以及该身份还能见到的其他工具）；之后模型只从已注入的工具中挑一个发起 `tools/call`。`allowedTools` 并不是传给远端 `tools/list` 的按名称查询参数，而是 TCUM/eino-ext 在收到工具列表后做的本地白名单过滤。当前 `mcp-go Client.ListTools` 还会沿 `nextCursor` 自动取完所有页，再交给 `eino-ext mcpp.GetTools` 过滤和包装。

一条 MCP 配置本身**不携带工具描述和参数 schema**。它只是客户端的连接信息（server 别名、URL、transport、鉴权 header、可选白名单）。真正的工具元数据来自 MCP Server 对 `tools/list` 的协议响应；TCUM 再把响应转换为 eino 的 `tool.BaseTool`，最终才进入模型的 Function Calling tools 列表。不要把“配置了一个 MCP”误讲成“把一个 MCP 说明文字塞给模型”。

```text
配置层
  静态：appconfig.yaml 的 mcp_servers
  动态：DigitalTwin.McpConfig 的 mcpServers JSON

发现层（TCUM 是 MCP Client）
  创建 Streamable HTTP / SSE client
  → Start
  → initialize
  → tools/list
  → MCP Server 返回每个 tool 的 name / description / inputSchema

适配与装配层（TCUM 是 eino Agent 容器）
  eino-ext mcpp.GetTools 把远端 tool 转成 tool.BaseTool
  → 静态路径注册到全局 ToolManager，Agent 配置再选子集
  → 动态路径改名后追加到当次 runCtx.Tools

执行层（模型选中了某一个工具后）
  模型产生 tool call（工具名 + JSON 参数）
  → 该 BaseTool / renamedTool.InvokableRun
  → 其持有的 MCP client 发 tools/call 到原 Server
  → 结果成为 tool message，供下一轮 ReAct 推理
```

因此，假如 `McpConfig` 中只有 `iWiki` 的 URL 和 Authorization，TCUM 仍然能注入 `iWiki.SearchPage` 等工具：名字、描述、JSON Schema 都是 iWiki 在 `tools/list` 时返回的。`iWiki` 只是 TCUM 为该连接取的 namespace 名，不是一个统一给模型调用的总工具。

**静态**：配置文件 `mcp_servers` → 启动期 `registerMcpTools` → `StreamableHttpClient` → `InitializeRequest` 握手 → `GetTools` 发现 → 以 `{ServerName}_{ToolName}` 作为**全局 `ToolManager` 的注册键**。

关键设计：
- **注册键隔离，但模型侧仍有缺口**：`{ServerName}_{ToolName}` 能避免全局 `ToolManager` 的 map key 冲突；不过静态注册代码只是 `RegisterTool(key, t)`，没有像动态路径那样包装并改写 `t.Info().Name`。因此 Agent 用的是带下划线的注册键从 ToolManager 取对象，模型最终看到的却仍可能是远端返回的裸 Tool 名。两个静态 MCP server 暴露同名 tool 时，模型侧 schema 仍可能冲突——这不是完整的命名空间隔离，应复用动态路径的 `renamedTool` 修复；
- **容错**：单个 Server 连接失败只记日志跳过，不阻断其他工具注册；
- **Token 鉴权**：`Transport.WithHTTPHeaders` 传Bearer Token，适配企业内部鉴权。

这条静态路径说明：**并非只有数字分身能在普通 ReAct 中调用 MCP。**服务启动时，`registerMcpTools` 会对 `mcp_servers` 的每个启用 server 做 `Initialize + tools/list`，把远端的每个 tool 以 `{ServerName}_{ToolName}` 注册到进程级 `ToolManager`。但“已注册到全局池”不等于“每个普通 Agent 都会看见”：`NewDefaultAgent` / Deep Agent 构造时只从 `agentCfg.Tools` 取出这个**注册键**对应的对象放入自己的 ToolsNode。因此普通对话 ReAct 的 `agentCfg.Tools` 应配置如 `iWiki_SearchPage` 的注册键；模型实际发起的 Tool Call 名仍以该对象 `Info().Name`（通常是远端裸名 `SearchPage`）为准。没有列入 `agentCfg.Tools` 的 MCP tool 即使全局存在，也不会进入该 Agent 的模型上下文。

```text
普通 ReAct：启动期 mcp_servers → 全局 ToolManager → agentCfg.Tools 选子集 → 模型调用
数字分身：每次 Run 的 McpConfig → BeforeAgent 现连/现拉 → runCtx.Tools → 模型调用
Skill/mcporter：skill 按需加载 → 获取命令说明 → skill_exec 调 MCP CLI
```

**动态**（`pkg/agent/dynamic_mcp_middleware.go`，`BeforeAgent` 钩子，`:79`）：

1. 从 ctx 取 `TwinInfo.McpConfig`（标准 `mcpServers` JSON）；
2. 逐个 server **现场新建 MCP client**，支持 `streamable-http`（MCP 规范 2025-03-26+ 推荐）与 `sse`（兼容旧版）；
3. 支持 `${VAR}` 占位符解析（如 `Bearer ${TCUM_TOKEN}`），复用 per-request JWT 鉴权；
4. 先执行 `tools/list` 拉取当前身份可见的工具集合（支持分页）；再按 `allowedTools` 白名单**本地过滤**，命名空间化 `{ServerName}.{ToolName}` 后注入 `runCtx.Tools`；
5. **容错**：单 server 失败只 warn 跳过，不阻断整个 Run。

### 动态 MCP 到底何时加载、模型实际看见什么？

这点不能和 Skill 混为一谈。**动态 MCP 没有一个让模型先调用的统一 `mcp` 工具**；它在一次 Agent Run 的 `BeforeAgent` 阶段完成能力发现，然后把发现到的每一个远端工具作为独立的 `tool.BaseTool` 放入本次运行的 `runCtx.Tools`。

完整时序是：

```text
用户发起一次 Run
  → TwinSoulMiddleware 把当前数字分身的 TwinInfo 放入 ctx
  → DynamicMcpMiddleware.BeforeAgent 读取 TwinInfo.McpConfig
  → 对配置中的每个 MCP server：替换 header 变量、Start、Initialize、tools/list（必要时分页）
  → 在本地按 allowedTools 过滤，得到一个个远端 Tool
  → 将每个 Tool 改名为 serverName.toolName，追加进 runCtx.Tools
  → 第一次模型调用：模型直接收到这些独立 Tool 的 name / desc / input schema
  → 模型选择如 tianxun-access.ListProducts 的某一个 Tool Call
  → renamedTool 透传给该 MCP client，由 client 发起 tools/call
```

这里的“每次”是**每次 Agent Run**，例如用户新发一条消息或重新执行任务；不是每一个 ReAct 内部步骤都重新 `Initialize + tools/list`。同一个 Run 内，`BeforeAgent` 做一次注入，之后第 1、2、3 … 次模型推理都会复用该 Run 的工具集合。下一次 Run 又会重新建 client 并重新发现工具；代码明确不做 client 池缓存，以保证请求级 JWT/header 是新的，代价就是每次 Run 都多一次连接、初始化和工具发现的网络往返。

**不是所有 MCP、也不是全平台所有 MCP 工具都会进入每段上下文。**进入模型上下文的集合是：

```text
本 Agent 静态配置的本地/静态 MCP 工具
  + 当前数字分身 McpConfig 中列出的 server
  + 每个 server 经 allowedTools 过滤后的工具
  + 其他运行时中间件注入的 task / 知识库工具
```

`allowedTools` 是该 server 的 allowlist；配置了它时，TCUM 仍会先发现该 Client 可见的工具列表，但只把其中列出的名称包装并注入模型。未配置时，中间件把空列表原样交给 MCP 适配层，等价于把 server 返回的全部可见工具都转成 BaseTool。因此**一个 server 若工具很多、又没有设 allowlist，这些工具的名称、描述和参数 schema 都会成为本次 Run 内每次模型调用的固定上下文开销**；而设置 allowlist 能减少模型上下文，却不能减少当前实现中 `tools/list` 本身返回的数据量和发现网络往返。

“所有描述是否每轮都带上”也要分层回答：在该 Run 中，所有**已成功注入**的 MCP 工具各自的 `ToolInfo`（名字、描述、JSON Schema）会随模型工具定义提供给每次 ReAct 模型调用；但不会把所有 MCP 的工具执行结果重复塞入。执行结果只在对应 Tool Call 返回后，以 tool message 进入后续推理，并继续受 L0/L1/L3…上下文压缩规则约束。未配置、`allowedTools` 排除、连接/初始化/发现失败的工具则根本不会出现在模型可调用工具列表中。

**一个 MCP server 不等于一个 Tool。**一个 server 是远端能力提供者，可以暴露 N 个 MCP tool；`mcpp.GetTools` 返回 N 个工具对象，TCUM 为每个对象包一层 `renamedTool`。例如远端 `tianxun-access` 返回 `ListProducts`、`ListProductVersions`，模型看到的是两个独立函数：

```text
tianxun-access.ListProducts({ ... })
tianxun-access.ListProductVersions({ ... })
```

包装层只改对模型可见的名字以避免多 server 同名冲突，`InvokableRun` 不聚合、不转发到一个总分发函数，而是直接透传给各自远端 MCP Tool。换言之，TCUM 这里走的是“**多专用 Tool 常驻本次 Run 的 schema**”路线；它与 mcporter 的“**只常驻 `skill` + `skill_exec` 两个通用 schema，MCP 命令和参数说明按需写入已加载 Skill 的 tool result 正文**”是两种不同的上下文成本模型。

上句的执行细节也要分两种“tool call”：模型 Provider（如 OpenAI/Claude 兼容接口）先返回的是其自身 Function Calling 格式，例如工具名 `iWiki.SearchPage` 加参数 JSON；这还不是线上 MCP JSON-RPC。Eino 的 ReAct `ToolsNode` 用该名字定位 `runCtx.Tools` 里的 `renamedTool`，再转发给内部的 MCP `toolHelper.InvokableRun`。后者调用 `mcp-go Client.CallTool`，才构造并发出真正的 MCP JSON-RPC：`method="tools/call"`、`params.name="SearchPage"`、`params.arguments=<模型参数 JSON>`。`renamedTool` 只改变模型侧名字以避免同名冲突；远端仍收到原始 tool 名。这个适配层就是“模型 tool call 转为 MCP `tools/call`”的确切含义，不存在另一个独立的总分发工具。

> 面试时可用一句话概括：**普通动态 MCP 是先发现、后把每个远端能力平铺成独立 Function Calling schema；Skill/mcporter 是先给技能索引，模型按需加载技能文本，再经一个通用执行器调用命令。前者省接入代码，后者省常驻 schema。**

### MCP 的“渐进式加载”在本项目中实际指什么？

如果把“渐进式加载”严格定义为“先只给模型一个工具搜索入口，模型确认需要后才拉取某个 MCP 的某几个 Tool schema”，**TCUM 的普通 MCP client 当前没有实现这套机制**。`DynamicMcpMiddleware` 一旦决定为某个 server 注入，就会在 Run 开始前执行完整的 `tools/list`，并将该 server 经 `allowedTools` 过滤后的**全部**工具平铺给模型；它没有根据本轮用户意图再二次筛选，也没有 `search_tools` / `load_tool_schema` 这样的延迟发现工具。

项目中能称为“渐进”的其实有三种粒度，不能混说：

| 渐进粒度 | 实现 | 什么时候发生 | 模型一开始看到什么 | 没有看到什么 |
|---|---|---|---|---|
| **进程 / Agent 级裁剪** | 静态 `agentCfg.Tools`、启动期 `mcp_servers` 注册 | 服务启动或 Agent 构建 | 该 Agent 被配置的工具子集 | 不属于该 Agent 的全局工具 |
| **分身 / Run 级裁剪** | `DynamicMcpMiddleware` + `TwinInfo.McpConfig` + `allowedTools` | 每次 Run 的 `BeforeAgent` | 当前分身已授权 server 的全部白名单 Tool schema | 其他分身、未配置 server、白名单外工具 |
| **Skill / mcporter 的按需暴露** | `skill` → `Local/CosSkillBackend.Get` → `fetchMcporterSchema` → `skill_exec` | 模型先调用某个 skill 后 | 初始只见 `skill` 与 `skill_exec` 两个通用 schema；加载 skill 后才在该次 `skill` 的 tool result 中看到该 skill 关联 MCP 的命令说明和参数 | 未加载 skill 的 MCP 工具说明；也不会注册成一堆独立 Function Calling Tool |

第三种才是项目中真正解决“大量 MCP schema 常驻上下文”问题的路线。一个 skill 带有 `config/mcporter.json` 时，模型调用 `skill(name)`，backend 才在沙箱执行：

```text
mcporter --config config/mcporter.json list
mcporter --config config/mcporter.json list <server> --all-parameters
```

随后把得到的工具说明追加到**这一个已加载 Skill 的正文**，模型下一步再决定是否调用：

```text
skill_exec({
  skill_name: "...",
  command: "mcporter call <server>.<tool> --args '{...}'"
})
```

而不是把 `<server>.<tool>` 注册成模型的独立 Tool Call。该 schema 文本还按 `sessionKey:skillName` 缓存，避免同一会话重复加载同一个 skill 时重复执行 `mcporter list`。所以准确表述应是：**TCUM 对普通 MCP 做的是按 Agent/分身/Run 的集合裁剪；对采用 mcporter 的 MCP 做的是按 Skill 的正文和执行时机延迟暴露。它尚未做到按用户意图对普通 MCP 的单工具 schema 渐进加载。**

**云 API MCP 化**：`pkg/capi` 提供 YunAPI → MCP 工具的转换——这是"把存量云 API 资产批量 Agent 化"的路子，规模效应明显（云 API 有上千个 action，手写工具不可能覆盖）。

## 3.3 知识库工具的装饰器模式

`DynamicKbMiddleware`（`dynamic_kb_middleware.go:45`，启用条件 `bootstrap.GetRootCfg().KbMcp.Enable`）按 `TwinInfo.KbRefs` 分类：

- `Type == "internal"`：经 kb 子 MCP 拉 `SearchKnowledgeBase` 工具，并用 **`descAnnotatedTool` 装饰器**在工具 Desc 末尾**动态追加"可用 kb_code 列表"**；
- `Type == "external_mcp"`：解析 `ExternalMcpConfig`（mcpServers JSON）拉外部 MCP 工具并命名空间化。

**`descAnnotatedTool` 的通用价值**：包一层 `tool.BaseTool`，在 `Info()` 里动态改 Desc。它**绕过所有 hook**，可复用于工具级限流/缓存/权限——是一个比"往中间件里堆逻辑"更干净的扩展点。

## 3.4 MCP 层短板

| 短板 | 影响与改造方向 | 对标 |
|---|---|---|
| **每次运行前重新拉工具列表** | 每轮对话 N次 `list_tools` 往返，延迟叠加；未见缓存与 TTL。应按 `serverURL + token 指纹` 缓存，TTL 5~10min，配合 MCP 的 `notifications/tools/list_changed` 主动失效。**这是延迟收益最直接的一个改动** | CC `MCPConnectionManager` |
| **无 OAuth** | 仅支持 header 塞 token，对接第三方 MCP 受限 | CC `mcp/auth.ts` 完整 OAuth 2.0 授权码流 |
| **无连接池与生命周期状态机** | 每次新建 client，失败 log+continue；应复用 client + 健康检查 + 对连续失败 server 熔断（可复用现有 `circuitBreakerFailThreshold=3` 模式）并告警 | CC `MCPConnectionManager.tsx` |
| **无服务发现/注册表** | MCP 列表靠人工配置。可建内部 MCP registry（直接放 CMDB 自定义模型里），支持按域检索可用 MCP，配合动态工具裁剪 | CC `officialRegistry.ts` |
| **无通道权限** | 无 `channelPermissions` 等价物| CC `channelPermissions.ts` |
| **命名空间化加长工具名** | `{Server}.{Tool}` 进一步消耗 token | — |

## 3.5 工具体系的横向问题：Schema 四条路径并存

这是当前工具体系最大的一致性问题：

| # | 方式 | 关键调用 | 代表位置 |
|---|---|---|---|
| 1 | 反射（eino `InferTool` 读 `jsonschema` tag） | `toolutils.InferTool(name, desc, fn)` | `tool_prometheus_query_range.go:99` |
| 2 | 手写 JSONSchema | `schema.NewParamsOneOfByParams(params)` | `tool_query_sli_list.go:41`、`skill_exec.go:62` |
| 3 | 反射（mcp-go 泛型 + `invopop/jsonschema`） | `mcpgo.NewTool(..., mcpgo.WithInputSchema[TInput]())` | `pkg/mcp/tool.go:43-51` |
| 4 | eino → MCP 转换 | `AdaptEinoTool → convertToolInfo → ToJSONSchema()` | `pkg/mcp/adapter.go` |

后果：
1. 风格不统一——手写路径容易漏 `Required`、漏枚举约束，描述质量参差，**直接影响模型调用准确率**；
2. 手写 schema 与 Go struct **无编译期绑定**——改 struct 忘改 schema，编译通过但运行时参数解析失败；
3. **无 schema 质量检查**——没有 lint 检查"每个参数是否有 Desc""枚举值是否列出"。

**改造建议**：
- 收敛为"反射优先"单一路径，只在反射确实无法表达（如动态枚举）时才允许手写并在 CR 标注原因；
- 新增 `make lint-tools`：检查每参数有非空 `Desc`、枚举类参数声明 `Enum`、工具 `Desc` 长度在合理区间（过短模型选不对，过长挤占上下文）、无重复工具名/别名冲突；
- **动态枚举注入**：对"产品列表""地域列表"这类枚举，运行时从 CMDB 注入 schema，避免模型猜错参数值（这一点对 TCUM 特别有价值，见场景篇里 `tenants` 配置项从 9 个膨胀到 30+ 个的演化）。

**工具描述的信息密度工程**（团队已有的规范）：`Desc` 字段遵循三要素——**What**（做什么）+ **When**（何时用）+ **How**（参数约束）。这是降低工具误调用率最便宜的手段。

## 3.6缺失的工具治理能力

|缺失 | 后果 | 对标 |
|---|---|---|
| **无工具别名** | CC `findToolByName` 支持 `name or name in t.aliases`，用于工具重命名的向后兼容（旧 `KillShell` → 新 `TaskStop`）。我们一旦重命名，历史会话回放和模型既有习惯全断| CC |
| **无版本/废弃标记** | 无法优雅下线一个工具。应扩展 `ToolInfo` 加 `Aliases []string` + `Deprecated bool` + `ReplacedBy string`，废弃工具不进模型列表但仍可被调用（返回引导信息） | CC |
| **`StreamableTool` 完全未用** | 长耗时工具（大范围指标查询、巡检执行）无法流式回传进度，用户只能干等 | — |
| **无 MCP 契约版本化** | 对外暴露 128 个工具，任一改名/改参数都可能打破外部消费方。应路径带版本（`/tcum-mcp/v1/monitor`），破坏性变更升版本并保留旧版一个周期 | — |
| **无 schema 快照测试** | 应把所有 `ToolInfo` 序列化为 golden 文件纳入版本控制，变更时 diff 显式可见 | — |
