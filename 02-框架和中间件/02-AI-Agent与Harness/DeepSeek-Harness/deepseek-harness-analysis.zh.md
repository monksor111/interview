# DeepSeek Harness (`dsh`) 深度架构分析

> 目标：把 `deepseek-harness` 这个开源 agent harness 的架构、核心能力实现细节讲透，并与 Claude Code、OpenAI Codex CLI、腾讯 Tencent Cloud Coding Copilot (TCUM-AI，此处以业内公开的 AI Coding Agent 形态代指) 做横向对比，给出优缺点评估。

本报告基于对仓库 `docs/architecture.zh.md`、`docs/agent-lifecycle.zh.md`、`docs/tool-execution-pipeline.zh.md`、`docs/cordis-primer.zh.md`、`AGENTS.md`、`packages/README.zh.md`、`docs/subsystems/*.zh.md`（`core`、`session`、`persistence`、`system-prompt`、`tools`、`scope`、`token-meter`、`compaction`、`subagent`、`sandbox`、`shell`、`filesystem`、`skills`、`plan`、`approval`、`code-runtime`、`extensions` 等）、以及 `packages/hooks/**` 源码 README 的通读整理。

---

## 目录

1. 一句话概述与总体判断
2. 底座：Cordis "一切皆插件" 范式
3. 分层组装模型：Profile / Bundle / Patch
4. 领域核心概念：Turn / Step / Round / Goal Round / Ralph Round
5. 会话（Session）：仅追加事件溯源日志
6. Agent 循环（agent-loop）：驱动器逐 waterfall 逐事件的推进
7. Agent 句柄与 Inbox：投递 / 转向 / 注入的三合一模型
8. 系统提示装配：分域可插拔的组合流水线
9. 工具（Tools）：Schema + Pipeline + 展示 + 分类的完整流水线
10. Scope（作用域）：按 Agent 隔离的注册与遮蔽
11. LLM 层：Message / ContentBlock / StreamChunk 与适配器契约
12. Token 计量与压缩（Compaction）
13. 能力接缝（Capability Seam）：Service Def / Provider / Consumer 三角
14. Shell / Subprocess / Terminal / Sandbox 的四层结构
15. Filesystem 能力与"先读后写"策略
16. Code Runtime / Code Mode：把工具集变成 SDK
17. Subagent：多提供方的多 Agent 编排
18. Hooks 桥接：Claude Code / Codex 兼容层
19. Extensions：Agent 自修改自己的 Cordis 插件
20. Persistence：JSONL/SQLite 双后端与崩溃恢复
21. Approval / Plan Mode / Skills：人机协作面
22. 安全与防御性模式
23. 与 Claude Code 的对比
24. 与 OpenAI Codex CLI 的对比
25. 与 "tcum-ai" 类闭源 IDE Agent 的对比
26. 优点分析
27. 缺点与风险分析
28. 适用场景建议

---

## 1. 一句话概述与总体判断

DeepSeek Harness（下文简称 `dsh`）是一个**以 Cordis 为底座、把 agent harness 里所有关注点全部拆成插件、以能力接缝（capability seam）为主要扩展形式、以事件溯源会话日志为唯一事实源、以 waterfall 事件为主要拦截手段**的开源 agent 框架。它明确的产品定位是"harness"（马具）而非某一款具体的 coding agent：**LLM 适配器、工具、循环本身都是可替换的插件**，仓库同时交付 Web、Headless、ACP、JSON-RPC 四种 profile，并显式内置对 Claude Code、Codex 生态钩子协议的适配桥。

总体判断：**架构上是当前公开可见的开源 harness 里少数从"框架层"就把可组合性、可回放性、可审计性、能力接缝、边界防御作为一等公民设计的项目**。工程质量非常高（100% 单文件覆盖率门禁、doc-sync、type-equiv、类型漂移校验），但代价是**学习曲线陡峭、术语密度极高、组件间耦合通过事件与服务名而非静态导入完成，初次上手门槛显著高于 Claude Code / Codex CLI**。

---

## 2. 底座：Cordis "一切皆插件" 范式

Cordis 是 dsh vendor 进仓库的插件框架（参见 `docs/cordis-primer.zh.md`）。它有五个不可回避的一等概念：

1. **Plugin = 实现 Service 的对象**。可以是带 `inject`/`apply(ctx)` 的函数，也可以是 `Service` 子类，生命周期由 Cordis 挂载。
2. **Context (`ctx`) = 服务的容器**。服务占据稳定的 `ctx.<key>`，例如 `ctx.tools` / `ctx.llm` / `ctx.sessions` / `ctx.agents`；插件通过 key 查找，从不 `import` 具体实现。
3. **依赖通过 `inject` 声明**。插件不手动排序启动，声明依赖后 Cordis 决定顺序。
4. **类型化事件通过声明合并注册**。事件用 TS declaration merging 加入映射（如 `SessionEventMap`），然后走 `emit`/`waterfall`/`parallel`/`serial` 四种分发模式之一。
5. **注册是可逆副作用**。所有 `ctx.effect()` / `ctx.on()` 返回 disposer，reload/teardown 时按逆序撤销。

四种分发模式：

| 模式 | 是否 await | 顺序 | 返回值 |
|---|---|---|---|
| emit | 否 | 注册顺序 | 无 |
| waterfall | 否 | 注册顺序 | 有（层层包装 `next()`） |
| parallel | 是 | 并行 | 无 |
| serial | 是 | 顺序 | 有 |

**Waterfall 的语义是环绕中间件**：监听器接 `(...args, next)`，调用 `next()` 委托下游并可包装其返回值；不调 `next()` 就短路。这被 dsh 用于所有需要拦截的场景（`agent/pre-step`、`agent/request`、`llm/stream`、`tools/pre-execute`、`tools/execute`、`tools/post-execute`、`system-prompt/assemble`），是整个 harness 的"扩展针脚"。

**为什么这是关键设计**：其它 harness（Claude Code、Codex）主循环是私有的、写死的入口，只在若干"预定义时刻"暴露 hook 命令；dsh 的整条循环由若干具名 waterfall 事件构成，任何一段都可以由外部插件包装/替换/短路，且**不需要 patch 内核**。

---

## 3. 分层组装模型：Profile / Bundle / Patch

参见 `docs/architecture.zh.md#profile-与组合包`。

- **Profile**：Harness home 中的具名装配，列出叠放的 Bundle、外部插件与用户 `cordis.patch.yml`。发行版随附 `web`、`headless` 两个模板。
- **Bundle**：可分发的 Cordis 配置 + 挂载代码，是"能被 patch 的一层"。`dsh-base` 是每个 profile 的第一层；`dsh-web-app` 加浏览器；`dsh-headless` 是一次性 runner。
- **Patch**：按 id 命中某条 entry，替换其 config 或插入新 entry。

叠放顺序：**空列表 → profile 列出的 bundle → profile `cordis.patch.yml` → home 级 patch → 任意 `--patch` overlay**。

`dsh --profile web --dump-config` 打印任意机器上真实启动的配置树，每一条都是可 patch 的目标。这套模型带来两个能力：

1. **部署内组合**：一份代码库、一份 harness，同时支持"服务器 web UI"、"一次性 CLI 脚本"、"ACP 自动化服务器"、"JSON-RPC 后端"四种拓扑，无需分叉。
2. **热切换 provider**：把 LLM provider / sandbox backend / persistence backend 都以 entry 形式暴露，切换后端只是替换一行 config，无需改工具或 UI。

对比 Claude Code：Claude Code 是"anthropic 独家 LLM + 私有循环 + 一组内置工具"的封闭产品，用户没有 profile/bundle 的重组能力，只能通过 hooks.json 在若干节点插入外部命令。

---

## 4. 领域核心概念：Turn / Step / Round / Goal Round / Ralph Round

`docs/glossary.zh.md#循环层级` 定义了非常清晰的四层循环词汇，这是理解一切的前提：

- **Turn（轮次）**：会话内一次对已接纳输入的排空过程；当模型和工具都不欠工作、终止策略介入时结束。
- **Step（步骤）**：一次模型请求 + 该响应触发的工具执行；一个 turn 包含 0~N 个 step。
- **Round**：承载 turn 的**外层策略迭代**，是可选的策略概念（Goal Round、Ralph Round）。
- **Goal Round**：为当前 goal 接纳的一次续行周期；管家事件由 `ctx.goals` 负责。
- **Ralph Round**：一次面向不可变目标的**全新 agent 子会话**，配合工作流和 subagent 原语组成"顽固循环"（Ralph Loop）。

这种四层划分和 Claude Code "一个 conversation 中的 assistant/user 消息交替"、Codex "task -> messages" 是根本不同的：**dsh 明确区分"轮次"（用户视角一次交互）、"步骤"（模型视角一次调用）、"策略回合"（目标/顽固循环视角）**，这让上层策略（自动 compaction、goal 续跑、Ralph 交接）可以在正确的层级挂钩。

---

## 5. 会话（Session）：仅追加事件溯源日志

`docs/subsystems/session.zh.md`。

Session 是"由类型化 `SessionEvent` 组成的仅追加日志"，是 agent 交互历史的**唯一真源**。核心规则：

- **消息历史从日志派生**（`deriveMessages()`），不单独存储。
- 事件通过 `SessionEventMap` 声明合并可扩展。核心变体包括 `turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`、`todo/write`、`request/header`、`request/context`、`session/end-seed`。
- 每条事件带单调 `seq` 与 `time`，`assistant/chunk` 也是持久事件——**支持流式 token 级回放**。
- **surface 事件**（模型可见的）与非 surface 事件（例如 `compaction/*`、`hook/*`）分开。surface 事件才带 `surfaceOp`（replace/insert），才能通过压缩替换。
- **模型可见 ⟺ 已记录**：任何进入模型 request 的信息都必须能从日志重建，由运行时不变量断言。新增模型可见输入 = 新增会话事件。

这是本项目的第一根"设计脊梁"。它带来的能力：

1. **回放保真**：assistant 的原始 chunk 也进日志，UI/后端崩溃重启后能一 chunk 不差地重放。
2. **压缩、fork、生成 title 都是纯投影**：不需要副本；`fork(source, boundary?, childSessionId?)` 只是取前缀 + 新分支。
3. **可回退性**：surface replacement generation 是所有"压缩、剪枝、注入"策略的一致抽象。
4. **持久化 vs 派生解耦**：`SessionPersistence` 是独立 seam，日志形式版本号 `SESSION_FORMAT_VERSION` 独立演进，JSONL/SQLite 后端可换。

对比 Claude Code / Codex：两者都有 transcript/rollout 概念，但**"每一件事都是事件"**这条规矩没那么强。dsh 更接近事件溯源系统（Event Sourcing），系统的每个复杂能力（压缩、goal、hooks 审计、subagent lineage）都能落到"新增一条 event 变体"上。

---

## 6. Agent 循环（agent-loop）：驱动器逐 waterfall 推进

来自 `docs/architecture.zh.md#turn-flow` 与 `docs/agent-lifecycle.zh.md`。轮次流程可以看作下面这条状态机：

```text
turn/start
  claim next-step input + one queued message
  assemble prompt sections + tool schemas
  → agent/pre-step  (reject | enter(messages))
    step/start
    append entered messages as user/message
    derive model history from log
    → agent/request → llm/stream → assistant/chunk* → assistant/message
    → tool/call*
       → tools/pre-execute → tools/execute → tools/post-execute
       → tool/result*
    step/end
    (若工具欠一次续跑或 next-step input 到达 → 再次 claim)
  → agent/turn-stopping
turn/end
```

要点：

1. **认领与轮次的解耦**：turn 先开，输入才认领；一次首次认领被拒绝或改写为空，仍关闭一个"零 step 的持久轮次"——日志里能看到"我们尝试过但没有步进"。
2. **驱动器把整条循环拆成事件序列**：`agent/pre-step`、`agent/request`、`llm/stream`、`tools/*` 都是**waterfall**——外部插件可以包装任何一段。
3. **`assistant/message` 与 `assistant/chunk` 双写**：chunk 承担回放保真，assistant/message 承担派生历史 + usage 记录。空内容也保留（`sourceEventSeqs` 精确列出 chunk），是压缩正确性的必要条件。
4. **错误恢复也是事件**：`agent/request-error` 在失败步骤关闭后、失败轮次关闭前运行；返回 `{kind:'retry'}` 才发起新一轮次；否则终态。`dsh-compaction-basic` 就把"上下文溢出重试"挂在这里。
5. **压缩策略跑在 `agent/pre-step` 上**：在派生请求前处理压力，可选执行工具结果剪枝，再重估 token，只有 surface replacement generation 前进才走"重试轮次"。

**对比其它 harness**：Claude Code 的 hooks 语义（`UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` / `SessionStart` 等）只是"到达特定时点"的钩子命令；Codex 类似。dsh 的 waterfall 是**语言级、类型化、可包装、可短路、可返回值**——功能上是"aspect-oriented programming"级别的能力，而不是"生命周期回调"。

---

## 7. Agent 句柄与 Inbox：投递 / 转向 / 注入的三合一模型

`docs/subsystems/core.zh.md`。

Agent 对外只暴露一个 `Agent` 接口：

- `send(message, target, wakeup)`：底层投递
- `followup(message)`：新一轮次（wake=true, target=next-turn）
- `steer(message)`：在**最近一个 step 边界**注入，改变下一步（wake=true, target=next-step）
- `inject(message)`：**不唤醒**，仅在下一 pre-step 认领时进入（wake=false）

三种方式全部落成同一份持久化 `agent/inbox/*` 事件（`inserted` / `claimed` / `discarded` / `spliced`），因此外部 UI 或 SDK 都是通过日志观察生命周期，而不是通过 in-process 消息。

Inbox 由两条 FIFO 组成（`next-turn`、`next-step`）。`claim` 是"纯删除 splice"，认领后由驱动器另行分发 `claimed` 通知。这个设计极其重要：

- **中断可保留 inbox**：`cancel(cause, { keepInbox: true })` 只中止当前活动，未起工作仍留待下一轮。
- **steering（中途引导）真的可以"插队"**：`steer` 是唯一在**步骤**（非轮次）粒度插入的原语。
- **UI 与 driver 之间的语义完全统一**：Web UI 的 stop 按钮、Claude Code 的 Escape、Codex 的 Ctrl-C 在 dsh 里就是不同 `AgentCancelCause` 的 `Agent.cancel` 调用；持久 `turn/end` 只保留粗粒度 `{kind: 'aborted'}`，取消者身份放在独立事件里，避免把审计混进结果类型。

**AgentStatus 只有 `idle` 与 `running` 两个值**：这个刻意保持极简的状态机反映了一条原则——**异步状态不能当作同步事实**（`docs/defensive-patterns.zh.md` 里也强调这条）。`followup()` 不返回结果 handle，因为 `running` 区间可能覆盖多条 followup、steer、inject 的混合执行；如果调用方要拥有一次"run"，必须显式定义"从消息 inbox 回执到 agent 下一次 idle"的区间。

对比 Claude Code：Claude Code 的 SDK 也有类似的 abort/interrupt，但没有 dsh 这种"three-target inbox"的正交模型（followup 换轮、steer 换步、inject 无唤醒插入）。多数 harness 只有"发一条消息"和"打断"。

---

## 8. 系统提示装配：分域可插拔的组合流水线

`docs/subsystems/system-prompt.zh.md`。

系统提示由**5 类贡献者**在每次组装时协同产出：

1. **PromptSection**：静态或动态文本片段，按 `order` 排序（`-100` 是 harness 身份、`0` 是 deployment persona、`100-199` 是工具指引）。
2. **PromptContext**：作为 user-role 快照 durable 落地的"动态上下文"（cwd、时间、AGENTS.md、skills、cron）。
3. **ToolProvider**：贡献本轮组装可见的 `ToolSchema[]`，附带"限制前的 knownNames"用于区分拼错和作用域屏蔽。
4. **Variable**：`{{name}}` 变量插值。
5. **`system-prompt/assemble` waterfall**：所有以上贡献合并后走一遍 waterfall；插件可最后包装/替换。

关键设计：

- **scope 感知**：作用域内的 section 会 shadow 同名全局 section，从而实现"这个 agent 有独立 persona"。
- **complete section**：允许一个提供者声明"整个 prompt 由我定"，waterfall 仍跑（工具 / 变量能解析），但最终 prompt 段仍以它为准；多个 complete 就 fail loud。
- **模板严格插值**：未定义变量直接失败，不做默认 fallback（"misconfiguration fails loud" 是 AGENTS.md 明确的仓库约定）。

**对比**：Claude Code 的 system prompt 主要由官方拼装 + `claude.md` 项目文件；Codex CLI 类似。dsh 是"多提供方合并 + waterfall 最后拦截"，任何一个插件都能加/改一段（例如 plan mode 只在激活时贡献 `plan:policy` 段），这是一个**协作式提示词**架构。

---

## 9. 工具（Tools）：Schema + Pipeline + 展示 + 分类的完整流水线

`docs/subsystems/tools.zh.md` 与 `docs/tool-execution-pipeline.zh.md`。

一个"工具"由 `ToolDefinition` 完全描述：

```ts
{
  name, description, parameters,     // 模型可见 ToolSchema
  output: { schema, render, presentationMeta? },  // 规范化输出
  execute(args, exec),               // 执行体
  finalizeContent?(exec, result),    // 最后内容改写钩子
  timeoutMs?,                        // 由 policy 插件强制
  isConcurrencySafe?(args),          // 并发分类
  presentCall?(args),                // 待执行 UI
  presentResult?(args, result),      // 完成 UI
}
```

执行流水线（`tool-execution-pipeline.zh.md`）：

```
tool/call (日志) → presentCall (UI 卡片)
             ↓
tools/pre-execute waterfall  (钩子/权限/沙箱决策)
             ↓
单调 guards (deny 或 abstain)
             ↓
ctx.approval one-shot (若 pre-execute 判定 ask)
             ↓
tools/execute waterfall (环绕：超时、重试、指标)
             ↓
tool.execute() 函数体
   ├── fs/write-intent | fs/edit-intent (fs 突变的守卫)
   └── 工具自有事件 (todo/write, fs/observed, hook/*, tool/code-dispatch)
             ↓
tools/post-execute waterfall (accept / block / replace / add context)
             ↓
Registry 无损快照
             ↓
finalizeContent (可修改内容的最后同步机会)
             ↓
tools/result (同步通知，冻结权威结果)
             ↓
tool/result (日志) → presentResult (UI)
             ↓
active batch additionalContexts FIFO 注入下一 user/message
```

八点亮点：

1. **展示与执行完全分离**：`presentCall` / `presentResult` 是**纯函数**，UI 在实时流式和会话回放时都会调用，展示元数据固化在 `tool/result.meta`。
2. **规范化输出 (`output.schema` + `render`)**：工具函数体返回的是 **canonical JSON value**，`render(args, value)` 才把它投影成模型内容。这样"工具返回的机器可读结果"和"喂给模型的展示"分离——Code Mode 直接吃 canonical value。
3. **超时是策略插件而非 execute 参数**：`timeoutMs` 通过 `dsh-tool-call-timeout-policy` 插件的 `tools/execute` 包装层执行，不会泄漏进模型 schema。
4. **并发工具分类**：`isConcurrencySafe(args)` 是**纯同步分类器**，且**只有显式 `true` 才 opt-in**，异常/非 true 都是排他。opted-in call 不能改父级状态。
5. **fs mutation 守卫**：`fs/write-intent` / `fs/edit-intent` 只对 tool-fs 生效，工具函数体走过来触发"先读后写"的观测策略。
6. **finalizeContent**：**保证被调用一次**，即使 `tools/post-execute` 被绕过（错误路径），工具作者能保留 `isError`、canonical value、structured error、延迟上下文——但只能改内容。
7. **additionalContexts**：post-execute 可以让工具追加 FIFO 的"user/message"到下一步（如 hooks 的 additional context）——用于"我刚跑了工具，模型下一步该看到这段解释"。
8. **Code Mode 的 SDK 子分发**：保留工具 `run_code` 走同一条流水线，其序列化子调用带父 token、记录 `tool/code-dispatch`、拒绝呈现为约束驳回、省略 additionalContexts 使 call/result 相邻。

对比 Claude Code：Claude Code 的工具流水线是"pre_use/post_use hook + 内置工具执行"，没有 pre/around/post 三段 waterfall；没有并发工具的显式分类器；没有"canonical value vs render content"的分离；也没有"presentCall / presentResult 纯函数"的展示合约。dsh 的工具是**基础设施级**的抽象，明显走得更远。

---

## 10. Scope（作用域）：按 Agent 隔离的注册与遮蔽

`docs/subsystems/scope.zh.md` + `docs/glossary.zh.md#agent-scope`。

Cordis 本身没有 agent 概念，scope 补上这一层：

- **两层扁平**：注册要么全局，要么归属确切一个 scope key；**不向下传递到 subagent**。
- **scope key = 活跃 Agent 对象自身**：库层从不解释这个 key，只做身份比较。
- **Scoped<T> 品牌**：由 `scopeTarget(base, key)` 构造的**路由型接收器**，作为事件 `this` 类型；载荷主体走参数。
- **Shadowing**：作用域内的工具/片段/变量遮蔽同名全局项——这是"某个 agent 的定制 persona"、"某个 agent 用不同 grep 工具"的机制。
- **Restriction**：`tools.restrict()` 是作用域对**继承** tools 的过滤（多个 restriction 取交集）；不影响本作用域的注册。
- **Lineage**：父子关系是**数据**（`parentSession`、`delegationDepth`、`subagentDepth`），从不影响可见性——避免了"父作用域自动可见"这种带来意外行为的语义。

这个设计是**"多 agent + 每 agent 独立提示词/工具集/策略"**的正确基础。对比：
- Claude Code 只有一个 agent 一个作用域；子 agent 概念是通过 Task 工具外部启动一个新的 conversation。
- Codex 同样没有 harness 级 scope。

dsh 的 scope 让"每个 agent 一个 persona、一组子工具、一份工具限制"成为一种可组合的合并操作。

---

## 11. LLM 层：Message / ContentBlock / StreamChunk 与适配器契约

`docs/subsystems/llm-streaming.zh.md`。

三条主要设计：

1. **Message / ContentBlock 的合并可扩展**：`ContentBlockMap`、`MessageSourceMap`、`FinishReasonMap` 都是"map + 派生联合"。插件通过 declaration merging 追加变体（例如 subagent-report 是 `MessageSource` 的一个变体）。
2. **StreamChunk 是 wire protocol**：适配器把上游 SSE / gRPC / WebSocket 归一成同一 `StreamChunk` 序列，`BlockAssembler` 从 chunk 组装 `AssistantMessage`。
3. **`LlmAdapter.stream()` 的两种失败**：可以 throw，也可以发 `finish { kind: 'error' | 'aborted' }`；但 `LlmRuntime.stream()` 一定归一为终止型 finish chunk——**adapter 端可以任选、runtime 端统一**，防御性模式 "公共约定两侧都要遵守" 的直接体现。

**关键**：任何 provider 只要实现 `LlmAdapter`，就能挂进来（`ctx.llm` 是 seam service）。切换 provider = 换一行 config。这是与 Claude Code（唯一 anthropic）、Codex（唯一 openai）、tcum-ai（腾讯自研模型）最本质的差异之一：**dsh 是"provider-agnostic harness"**。

---

## 12. Token 计量与压缩（Compaction）

### 12.1 Token 计量

`docs/subsystems/token-meter.zh.md`。`TokenMeasurement` 是 detached immutable 快照：`logRevision`（消费的持久事件数）、`baseline`（`usage` 或 `estimated`）、`surfaceDeltaTokens`（相对基线的有符号定价）、`totalTokens`（请求+响应压力）、`surfaceTokens`（当前 surface 启发式总量）、`nodes`（按位置的 surface 节点数组）。

**关键**：只要请求 envelope 未变，就复用最近一次 usage 锚点，用有符号 delta 记录 surface 变化；否则回退到 heuristic 全量估算。**这让"上下文压力"是准确到可对齐 provider 计费的**。

### 12.2 压缩（Compaction）

`docs/subsystems/compaction.zh.md`。压缩是完整的 capability seam：Def (`ctx.compaction`) + Provider (`dsh-compaction-basic`) + Consumer (`/compact` 命令)，且**是可选能力**。它扩展了 3 类 `compaction/*` 会话事件：

- `compaction/start`：获取锁，`turn` 为数字表示自动、`null` 表示手动。
- `compaction/summary`：安全摘要投影 + 可选完整 raw output + 遮蔽范围 + 遮蔽 seq 数组 + 遮蔽 token 数 + 摘要请求 envelope。
- `compaction/end`：释放锁。

摘要本身作为一条 `user/message` 承载，带 `surfaceOp: {op: 'replace', start, end}`——这是**唯一的 surface 变更**。所以：
- **压缩失败可见**：锁事件对不齐即崩溃/中断，日志里有痕迹。
- **压缩是一次可回放事务**：`compaction/start` 与 `compaction/end` 之间的所有事件都可以在冷加载时重建，`compaction/summary` 只是记录来源。

自动压缩由 `agent/pre-step` 上的串行监听器处理：先尝试 `dsh-compaction-tool-result-pruner`（决定性 head/middle/tail 剪枝），再通过 `ctx.tokenMeter` 重新测量；如果没到摘要阈值就直接推进 surface，不生成摘要。超时/溢出走 `agent/request-error` 的 retry 路径。

**对比**：Claude Code 有 `/compact` 命令与自动 compaction，但它是"内建的 opaque summarization"；Codex CLI 也有类似机制。**dsh 的差异在于**：
- 压缩是 seam，第三方可写替代后端（tokenizer 模板、language 分段、embedding-based selection）。
- 压缩有严格的锁事件对，crash-safe。
- Tool result pruner 是独立子服务，可以先剪结果、再看是否需要摘要。
- 压缩范围以"surface position"（不是 seq 区间）计算，因为一次 replace 会让 seq 非单调。

---

## 13. 能力接缝（Capability Seam）：三角设计

`docs/glossary.zh.md#capability-seam`。

一个 seam 包含三种角色：
1. **Service Definition**：一个 Cordis `Service`——可以是抽象类（如 `ShellExecutor`）或具体注册表（如 `WebRuntime`）——拥有 `ctx.<key>` 和词汇类型。**不是 TS interface**。
2. **Service Provider**：一个或多个实现（Bash local、Bash sandbox；JSONL、SQLite；Claude Code subagent、Codex subagent、in-process subagent）。
3. **Consumer**：使用该服务的插件，通常是面向模型的工具。

规范范例 `packages/shell`：`dsh-shell`（Def）、`dsh-bash-local` / `dsh-bash-sandbox`（Provider）、`dsh-tool-bash`（Consumer）。

**一个包可以合并承担多个角色**（`dsh-llm` 同时是 Def 和 Consumer），但**单一角色本身不是 seam**——添加一项能力意味着把 Def/Provider/Consumer 三者一并设计。

这是 dsh 的第二根"设计脊梁"。它带来的性质：

- **替换任一提供方就改变整个产品**：把 fs / subprocess 都指向远程沙箱，Bash、PTY、LSP 也自动搬过去；`dsh-e2b` 就是这条路的 POC。
- **横向发现**：同一 seam 里多提供方共存的情况用 registry（Subagent、LLM）；单一 provider 的（Shell、Compaction）用直接 `ctx.<key>`。
- **失败清晰**：seam 层的错误分类可枚举（`ManualCompactionErrorCode`、`SubagentError`、`FsErrorCode`、`SandboxEnforcement`），"fail loud, no silent degradation"。

---

## 14. Shell / Subprocess / Terminal / Sandbox 的四层结构

`packages/shell`、`packages/subprocess`、`packages/terminal`、`packages/sandbox`。

四层是可组合的：

1. **subprocess seam** (`ctx.subprocess`)：完全显式的 `SubprocessSpawnSpec`，基于 offset 的输出 reader，`DshEnvironment` 管理受管 env。
2. **shell seam** (`ctx.shell`)：接口是 `resolve(request) → spec` + `run(spec)`，把可选字段（workdir、timeoutMs、stdoutMaxBytes）先在 consumer 侧显式解析，再进 provider。Consumer 侧遵循"包边界处显式优于隐式"。
3. **terminal seam** (`ctx.terminals`)：持久 PTY session，owner-scoped，`terminal_*` 工具管发送就绪 / 有界读取 / 快照。
4. **sandbox seam** (`ctx.sandbox`)：**只管文件效果**（`read-only` / `workspace-write` / `danger-full-access`）+ `full`/`partial` 强制度报告。Backend：Linux bwrap+Landlock、macOS Seatbelt、Windows ACL 受限令牌。

`ShellExecRequest` 携带三样正交的东西：`env`（普通环境）、`dshEnv`（Harness 所有的 `DSH_*`，最后合并，防止 caller `env` 覆盖）、`sandboxPolicy`（本次调用的策略）。这个 "resolve → spec" 的模式（`docs/subsystems/shell.zh.md`）在整个仓库反复出现，是"显式 > 隐式"约定的物理实现。

**沙箱一致性**（`docs/subsystems/sandbox.zh.md`）：
- `SandboxMode` 只管文件——网络/进程可见性另外算。
- 每次调用带自己的 `SandboxExecutionPolicy`（含 `workspaceRoot`、`sessionId`），**不是**固定在 provider 上——多 consumer 同时以不同边界向同一 provider 请求（bash 只读 / confined child agent 可写）。
- 强制度是 provider 报告的事实：`full` 或 `partial`；对绝对安全要求的 consumer 必须拒绝或上抛 `partial`。
- 分类 stderr 的两类：`RunnerFailureRule`（sandbox runner 自身失败）、`denialSignatures`（sandbox 正常工作但拒绝命令）。Consumer **先看 runner failure**，报为基础设施故障而非任务失败。

**对比**：Claude Code 有可配置的 bash tool 与 permission preset，但沙箱是操作系统层还是内嵌是模糊的；Codex CLI 有更强的沙箱概念（openai/codex-sandbox），但同样是"one process, one policy"。dsh 允许**多 consumer 并发不同 policy**、**runner 失败与命令拒绝的正交分类**、**partial 强制度的显式报告**——工程完备度明显更高。

---

## 15. Filesystem 能力与"先读后写"策略

`docs/subsystems/filesystem.zh.md`。四件套：

- `dsh-fs`：`ctx.fs` + atomic text ops + optional guards。
- `dsh-fs-local`：本地实现。
- `dsh-fs-observation-policy`：**通过监听 `fs/*` waterfall** 记录观测状态、注入新鲜度守卫。**移除这个插件不破坏工具**——工具调用 `ctx.fs` 分发事件即可；策略只是没在响应事件而已。
- `dsh-tool-fs`：面向模型的 read/write/edit 工具，渲染窗口。

关键设计：

1. **`FsTarget` 是不透明目标**：`targetKey` 是品牌化 opaque id，consumer 不许解析，因此本地/远程/沙箱 backend 无差别。
2. **`FsVersion` 是版本 token**：write/edit 用它做陈旧检查。
3. **跨能力协作 API**：`processPath(target)` 给子进程用，`fileUrl(target)` 给 LSP 用，`contains(parent, child)` 用于工作区边界检查——**避免每个 consumer 自己解析路径**。
4. **`stat` / `lstat` 分离**：`resolve` 会跟随 symlink 以得到稳定标识；需要拒绝 symlink 的边界（信任检查）先调 `lstat`。
5. **`readBytes(target, signal, maxBytes)` 必填上限**：`FS_TOO_LARGE` 失败，不做静默截断也不无界缓冲——防御性铁律。
6. **通过 `fs/*` waterfall 挂"先读后写"策略**：`fs/write-intent`、`fs/edit-intent` 由 policy 插件拦截，未先读的 write 会被拒绝。

**对比**：Claude Code 的 Edit/Write 工具内建"stale check + require prior read"策略；Codex 类似。dsh 把"检查策略"和"文件访问 API"分成两个插件——**加载 policy 就有先读后写；不加载就是无限制文件 API**，可组合。

---

## 16. Code Runtime / Code Mode：把工具集变成 SDK

`docs/subsystems/code-runtime.zh.md`。

Code Mode 的核心思路：**让模型不再逐次调用工具，而是写一段程序调用工具**。`ctx.codeRuntime` 是 seam，`worker-thread` provider 实现 JavaScript，`dsh-tool-code-mode` 是 Consumer（保留 `run_code` 传输）。

关键抽象 `CodeRunRequest`：`program`（源码，作为 async function body）、`bindings`（宿主函数命名空间：`tools` 就是一个）、`signal`（取消）。默认值都从**实现配置**读，不在 run 内 `??` 塞默认（"包边界显式"）。

`CodeRunResult`：`value?`（顶层 return，跨 lossless-JSON 边界；无效或超限视为失败）、`logs`（顺序）、`error?`（`CodeRunFailure`）。

- **错误是字段**：`run()` 不会 reject——用户负责报告失败，与 `ShellExecutor.run` 保持一致。
- **绑定的函数是全局对象方法**：`tools.readFile(...)`、`tools.bash(...)` 直接写。名字必须匹配**多语言可移植子集** `[A-Za-z_][A-Za-z0-9_]*`——JS-only 的 `$tools` 被拒绝。
- **绑定错误类**：runtime 注入真实 Error 构造函数，被拒调用变成 `new ToolError()`——**模型可以 `try/catch`**。
- **`tool/code-dispatch` 事件**：子调用带父 token，走完整工具流水线；拒绝作为约束驳回；省略 `additionalContexts` 以保持 call/result 相邻。

Code Mode 是当前 LLM Agent 领域的一大方向（Anthropic Skills / Cloudflare Code Mode），dsh 把它做成**capability seam**——backend 可以是 JS worker、Python worker、E2B sandbox 等，且**同时对接 tools registry 的官方权限/审批**，不是绕过。

**对比**：
- Claude Code 有 sub-agent（Task）与 hooks，但没有把整条工具集暴露为 JS 全局。
- Codex CLI 目前没有原生 Code Mode。
- TCUM-AI 类闭源 IDE Agent 通常有"批量任务"能力但不开放绑定 API。

---

## 17. Subagent：多提供方的多 Agent 编排

`docs/subsystems/subagent.zh.md`。这是最复杂的 seam 之一，特别在于**同 seam 可存在多个 provider 并按 name 注册**——不像 Shell 只允许一个。

六个提供方（本仓库交付）：
- `dsh-subagent-spawn-in-process`：同进程新 agent。
- `dsh-subagent-fork`：fork 会话前缀。
- `dsh-subagent-acp`：通过 ACP 协议委派。
- `dsh-subagent-codex`：把 turn 委派给 Codex CLI。
- `dsh-subagent-claude-code`：把 turn 委派给 Claude Code。
- `dsh-subagent-dsh-sdk`：委派给另一个 dsh SDK 实例。

三类 Consumer 工具：
- `dsh-tool-subagent`：按 provider 委派。
- `dsh-tool-subagent-control`：全局 `send_message` / `interrupt_agent` / `list_agents`。
- `dsh-tool-subagent-report`：child 作用域 `report` 返回通道。

亮点设计：

1. **两类能力，两种发现方式**：
   - **启动时能力**（`SubagentCapabilities`：`outputSchema` / `depthLimit` / `toolFilter` / `persona`）通过静态描述符公布，服务在 `start()` 前校验，缺失即 `UNSUPPORTED_CAPABILITY`。
   - **可继续 subagent** 由继续执行管理器自己组合，只由 `SubagentProvider.prepareContinuable` 存在与否把关（TypeScript 类型收窄）。
2. **Activation 生命周期**：一份持久 Session **最多**关联一个进程内 Activation。inbox 是唯一队列，FIFO 轮次。`followup` 根据 Activation 状态（running / waiting / 无）路由为入队、唤醒、冷恢复。
3. **权限来自在线 Agent 上下文**：`user` 权限携带持久 direct-parent 地址；`ancestor` 权限携带确切在线 Agent 对象（其 lineage 必须包含 caller）。取消只通过 `interrupt` 一个操作。
4. **`report` 通过扩展点实现**：不加第二条队列，child 授权后通过 `Agent.inject()` 静默投递或 `Agent.followup()` 唤醒投递。
5. **深度限制、工具过滤、persona 都是启动时能力**：not runtime 特性——因为它们决定 child 的 system prompt 和工具目录，恢复时不能变。

**对比**：
- Claude Code 的 Task 工具就是"新 conversation"，无 persona / tool filter / depth limit 的能力协商。
- Codex 无原生 subagent seam。
- **dsh 把"我要一个能力受限、自己有 persona、深度封顶的子 agent"** 和 **"我把 turn 委派给别家的 agent"** 统一为一个 seam——**它甚至可以把自己嵌进另一家 Coding Agent 里**。

---

## 18. Hooks 桥接：Claude Code / Codex 兼容层

`packages/hooks/README.zh.md` + `packages/hooks/hook-protocol/README.zh.md`。

dsh 把"hooks"定位为**桥接层**，不是原生扩展方式：真正的原生扩展是 waterfall 事件。但为了让 Claude Code / Codex 已有 `hooks.json` 用户零成本迁移，仓库提供两个桥接 + 一份共享协议库。

共享 `dsh-hook-protocol`：
- **matcher 校验**：`claude` mode（`[A-Za-z0-9_|]+` 视为字面量，其它视为正则）、`codex` mode（始终未锚定正则）；解析时诊断，运行时隔离无效 pattern。
- **runHook**：通过 `ctx.shell` 用 stdin JSON + env 跑 hook 命令；拒绝抛异常，failure 归一为 `HookOutput`。
- **parseHookOutput**：exit=2 用 stderr 阻塞，其它非阻塞。
- **mergeHookOutputs**：deny > ask > allow；`continue:false` 起 halt；理由 `\n\n` 拼接。
- **createDetachedRuns**：跟踪 fire-and-forget hooks 的完全停稳，`drain()` abort + await——遵循"dispose 必须完全停稳"。

`hook/invoked` 与 `hook/result` 是新增的 SessionEvent（通过 declaration merging）。所有 hook 结果都进日志——**审计完备**。

**这个设计的哲学**：
- Claude Code / Codex 的 hooks 是**主要扩展面**，因为它们内核不公开。
- dsh 的 hooks 只是**兼容层**，因为你可以直接写 Cordis 插件监听 waterfall——那才更强大（类型化决策、in-process 状态、多层组合）。

---

## 19. Extensions：Agent 自修改自己的 Cordis 插件

`docs/subsystems/extensions.zh.md` + `packages/extensions/`。

`ctx.dynamicCordisRunner` 让 agent 定义带版本的 Cordis Plugin/Package：
- **define / undefine**：写代码，接管 Session 所属身份。
- **run / runHostHalf**：启动某个 package version（模型驱动或用户面板手势），可选未来版本自动授权。
- **`ctx.cordisInspect`**：注册与跨端路由，让两个模型可见的 inspect 工具查询 Host 或 Client 的运行时元数据。

这是 dsh 独一无二的能力：**agent 可以在运行时挂载自己写的插件**，扩展自己。加上审批（未授权的 Client Package 等待用户批准）、生命周期撤销、Client/Host 两半激活。

**对比**：
- Claude Code 有 MCP（Model Context Protocol）加载外部 server，但**运行时新增自己写的 in-process 插件**能力没有。
- Codex 同样通过 MCP 扩展。
- **dsh 的 Extensions 让 agent 变成"能修改自己的 harness"**——这是一个近乎独一无二的能力，也可能是最有风险的能力（sandbox / approval 都必须严格）。

---

## 20. Persistence：JSONL/SQLite 双后端与崩溃恢复

`docs/subsystems/persistence.zh.md`。

`SessionPersistence` seam：`locate` / `create` / `append` / `prepare` / `load` / `inspect` / physical suffix reads / list / snapshot。**没有并行的持久化事件类型**——一切事件都还是 `SessionEvent`。

关键：

1. **`session/event` 是同步通知**：持久化插件把事件复制到逐会话控制器，不阻塞生产。
2. **有界批处理窗口**：第一个待处理事件开启固定窗口，后续加入但不重置；窗口到期启批。`session/flush` 取消等待、排空到完全停稳，作为顺序 + 错误观察检查点。
3. **崩溃恢复不截断日志**：找到孤立 `turn/start` 时用合成 `turn/end { reason: 'interrupted' }` 关闭，不修改前后独立事件——**保留部分执行的证据**。
4. **`inspect(id)` 冷检查**：不发布不写入，返回不可变逻辑 Session；使用 LRU 复用一次读取、解压、验证、冻结、Session 构造。
5. **格式拒绝清晰**：`SessionFormatUnsupportedError` 与 `SessionPersistenceCorruptionError` 分开；`SESSION_FORMAT_VERSION` 与 SQLite `SCHEMA_VERSION` 分层把关。
6. **`SessionHeader` 存在日志外**：version / cwd / parentSession / seedLength / origin / delegationDepth / agentPreset——存储层元数据不进 `SessionEventMap` 也不进 `deriveMessages()`。

**对比**：Claude Code 的 rollout 是文件级的；Codex 类似。dsh 是**能力 seam + 事件流**，你可以写第三个后端（比如 S3/Postgres）而不改工具或 UI。

---

## 21. Approval / Plan Mode / Skills：人机协作面

### 21.1 Approval

`docs/subsystems/approval.zh.md`。`ctx.approval.request(req)` 追加 `approval/asked` → 获取应答 → 追加 `approval/decided`。策略 `ApprovalPolicy` 是 `ask` 或 `never`（headless CI 用 `never`，确定性 rejected）。`ApprovalOutcome` 闭合枚举：`allowed-once` / `rejected` / `cancelled` / `unavailable`——**caller 对 unavailable fail closed**（不放行）。

审计事件仅进日志不进 transcript；模型可见的是"运行时上下文快照 + 派生工具结果"。

### 21.2 Plan Mode

`docs/subsystems/plan.zh.md`。`plan/mode: { active: boolean }` 是仅日志 whole-value 替换事件。`foldPlanMode(events, end?)` 返回前缀最后一个值，缺省 `false`——**生效状态是纯日志折叠**。选择保持待生效，直到下一轮 pre-step 追加。`exit_plan_mode` 工具要求 markdown 计划，走 UserQuestions seam 呈交评审。

**软性指引**：Plan Mode 只贡献 `plan:policy` 提示词段落；沙箱 / 审批策略强制限制是分开的（部署需要分别配置）。

### 21.3 Skills

`docs/subsystems/skills.zh.md`。`ctx.skills` 是提供方注册表 + 6 类根目录发现（rank 100~600）：project-dsh、project-agents、custom、user-dsh、user-agents、bundled。

- **项目根**：包含 `.git` 的最近祖先，找不到用 cwd。当 `ctx.fs` 可用时，git-root 通过 fs seam 探测——**远程沙箱工作区不会回退到宿主 fs 边界**。
- **watcher 覆盖**：Chokidar 监视目录变更；tool-fs 的 write/edit 观测也同步失效——**model 写完 skill 立即可见**。
- **skill 是可选指令**，不是会话事件。加载后进入 prompt context。

Skills 让 dsh 兼容 Anthropic Skills / Claude Code Skills 的目录风格：`AGENTS.md` 里有 `.claude/skills` 与 `.agents/skills` 的目录，说明它对齐这套生态。

---

## 22. 安全与防御性模式

`docs/defensive-patterns.zh.md` 是 dsh 有意保留的"缺陷类别规则"文档。摘要：

1. **正交结果独立上报**：`timedOut` / `signal` / `exitCode` 各自独立字段，不嵌套。
2. **公共约定两侧都要遵守**：`LlmAdapter.stream()` 可以 throw 或 finish{error}，`LlmRuntime.stream()` 统一归一。
3. **异步状态不是同步状态**：`agent/status` / `whenIdle()` 不当作某次 followup 的结果。
4. **dispose 必须完全停稳**：清理需 await 子进程退出；先关闭 listener/notification registry 再终止进程。
5. **分发器中隔离回调异常**：try/catch 包住分发循环，行为不当订阅者不破坏核心生命周期。
6. **绝不将 env 或可预测路径暴露给不可信输出**：命令走清理过的环境（移除 `*KEY*` / `*SECRET*` / `*TOKEN*` / `*PASSWORD*`）；spill 文件 0700 私有目录、随机名、`'wx'` `0o600`。
7. **用 unlink 删除链接形态**：`lstatSync().isSymbolicLink()` 先判，`unlinkSync` 删；对真实目录用 `rmSync recursive`。避免 symlink 竞态与 Windows junction 陷阱。

再加上 AGENTS.md 里的：
- **注册即副作用**，用 `ctx.effect()` / `ctx.on()`，registry `register()` 返 disposer。
- **switch on discriminant tags**，闭合联合用 `assertNever`，可扩展联合有 default。
- **misconfiguration fails loud**，`DEFAULT_*` 常量或 test hook 不是"可配置性"。
- **opaque cross-boundary ids are branded**，从不是裸 `string`。
- **trust TypeScript at typed same-process boundaries**：不为静态接口要求的值加运行时校验；只在 parser/config、queued、model/tool JSON、durable/file、worker、process、wire 边界校验。
- **source plane vs artifact plane, never mixed**：静态门与测试解析 tsconfig `paths` 到 `src`；消费 `lib/` 的门显式声明这个依赖。

这一套约定使得**每个模块都能自证正确**，也让代码看起来像"严肃软件工程"，明显区别于大多数 Python-first、prototype-first 的 AI Agent 项目。

---

## 23. 与 Claude Code 的对比

| 维度 | Claude Code | DeepSeek Harness (dsh) |
|---|---|---|
| **架构基座** | 私有循环 + 内置工具，`~/.claude` 目录 + `hooks.json` 扩展 | Cordis 插件树，一切皆插件；profile+bundle+patch 三层组装 |
| **LLM provider** | Anthropic Claude 独家 | LLM adapter seam；任意 provider 通过 `LlmAdapter` 挂入 |
| **扩展方式** | hooks（外部 shell 命令）+ MCP servers | 主：Cordis 插件监听 waterfall；兼容：`dsh-hooks-claude-code` 桥接现有 `hooks.json` |
| **循环拦截点** | `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`、`SubagentStop` 等固定时刻 | `agent/pre-step`、`agent/request`、`llm/stream`、`tools/pre-execute`、`tools/execute`、`tools/post-execute`、`system-prompt/assemble`、`agent/turn-stopping`、`agent/request-error`——**且全部是可包装 waterfall** |
| **工具流水线** | pre_use/post_use 两点 hook，中间黑箱 | pre / around（execute waterfall）/ post 三段 + finalizeContent + tools/result；执行、展示、canonical 输出分离 |
| **展示与执行** | 工具输出内置渲染 | `presentCall` / `presentResult` 是纯函数；`output.render(args, value)` 与 `execute` 返回值分离 |
| **会话日志** | rollout（内部格式） | `SessionEvent` 事件溯源，`SessionEventMap` 声明合并可扩展；每条 assistant chunk 都是持久事件 |
| **压缩** | 内建 `/compact` + auto compaction，黑箱 | Compaction seam：可换后端；tool result pruner 独立子服务；`compaction/*` 三事件锁事务；crash-safe |
| **subagent** | Task 工具（内部启动新 conversation），一个后端 | Subagent seam：**六**个 provider（含 Codex/Claude Code/ACP/dsh SDK）；启动时能力协商；可继续 subagent activation 生命周期；`report` 返回通道 |
| **沙箱** | Anthropic 权限预设 + 平台特定 | Sandbox seam：`ctx.sandbox` mode + `full/partial` 强制度 + 分类 stderr（runner failure vs denial）；每次调用带独立 policy |
| **fs 策略** | Read/Edit/Write 内建 "prior read" | `fs/*` waterfall 独立 policy 插件；`FsTarget` 不透明；`processPath` / `fileUrl` 跨能力协作 API |
| **多 agent** | 单 agent 单 conversation | Scope + Agent 双层：多 agent 共存；scope-local persona / tool filter / restriction |
| **skills** | `~/.claude/skills` 目录 | 兼容 `.agents/skills` + `.dsh/skills` + 6 rank 目录发现 + fs seam 感知远程 workspace |
| **hooks 兼容** | 原生 | `dsh-hooks-claude-code` 桥接：忠实运行 `hooks.json` |
| **审批** | Anthropic permission model 内建 | Approval seam + audit 事件对 + `ask` / `never` 策略 |
| **plan mode** | Anthropic 内建 | `dsh-plan-mode` 插件：`plan/mode` 会话事件 + `exit_plan_mode` 工具 + `/plan` 命令 |
| **agent 自修改** | 无 | `ctx.dynamicCordisRunner`：agent 定义并挂载版本化 Cordis Plugin/Package |
| **可回放性** | rollout replay | 事件溯源全 replay + `deriveMessages()` 派生历史；fork 是前缀共享 |
| **多 UI** | claude cli, VSCode 扩展 | Web UI、Headless CLI、ACP、JSON-RPC；同一 harness 不同 profile |
| **开源** | ❌ 闭源 SaaS + 私有 CLI（部分 CLI 侧脚本半开源） | ✅ MIT，完整开源 |
| **上手门槛** | 低（下载即用） | 高（术语密度大，Cordis + capability seam 概念多） |

**总结**：Claude Code 是一款**产品**，dsh 是**做 Claude Code 那样产品的 harness**。前者面向终端用户；后者面向想构建自己 Coding Agent 的公司/开源作者。dsh 在**可组合性、可回放性、事件模型、seam 分离**上比 Claude Code 走得深；Claude Code 在**默认工具的成熟度、模型质量、易用性、生态知名度**上占优。

---

## 24. 与 OpenAI Codex CLI 的对比

| 维度 | Codex CLI (openai/codex) | dsh |
|---|---|---|
| **LLM provider** | OpenAI (GPT/o系列) 独家 | 任意 |
| **架构语言** | Rust (rmcp) + TS | TypeScript + Cordis |
| **扩展方式** | hooks + MCP | Cordis 插件 + hooks 桥接（`dsh-hooks-codex`） |
| **循环模型** | task-based (Rust core) | turn/step/round + waterfall |
| **沙箱** | codex-sandbox（macOS Seatbelt / Linux Landlock） | 同样 Linux Landlock / macOS Seatbelt / Windows ACL + `full/partial` 报告 |
| **配置** | `~/.codex/config.toml` + `AGENTS.md` | `cordis.yml` + profile/patch 层 + `AGENTS.md` |
| **subagent** | 无原生 | seam 多 provider，含 `dsh-subagent-codex` |
| **可回放** | rollout | 事件溯源 |
| **压缩** | 有 (compact) | seam 可换 |
| **hooks matcher** | 未锚定正则 | `dsh-hook-protocol` 完全兼容 codex 方言（`codex` mode 未锚定正则；`claude` mode 字面/正则混合）|
| **审批模型** | approvals system (auto/read-only/on-request/never) | ApprovalService seam + policy + audit |
| **开源** | ✅ 开源 | ✅ 开源 |

**总结**：Codex CLI 是"OpenAI 家版本的 Claude Code"，架构上也是**产品**导向而非 harness 导向。它有相对完整的沙箱和审批系统（比 Claude Code 更清晰），但**依然是"一个产品，一个循环，一个 LLM 家族"**。dsh 把 Codex 视为一种可以委派的 subagent provider（`dsh-subagent-codex`），并桥接了它的 hooks 协议——**dsh 明确站在"元层"**。

如果你要基于 Codex 开发闭源公司内部 Coding Agent，你会 fork Codex；如果你要基于 dsh 开发同样的东西，你会写几个 Cordis 插件。

---

## 25. 与 "tcum-ai" 类闭源 IDE Agent 的对比

由于 tcum-ai（腾讯云 CodingCopilot 系列 / TCUM AI Coding Agent，具体产品名可能有别）不完全公开架构文档，这里以业内**大厂闭源 IDE 侧 Coding Agent** 通用形态做对比。

典型闭源 IDE Agent 形态：
- 后端：私有 LLM 网关（可能自研模型）+ 服务端 Task Manager + Sandbox 集群。
- 前端：IDE 插件（VSCode/JetBrains）+ Web 内嵌 Chat + Terminal 集成。
- 扩展：多为服务端配置（rules / mcp / retrieve backend），客户端不允许挂插件。
- 会话：数据库存储对话；索引服务做代码库检索。

| 维度 | tcum-ai 类闭源 | dsh |
|---|---|---|
| **部署模式** | SaaS / 企业内网托管 | Self-host node.js；可分发到 dev workstation |
| **LLM** | 通常绑定自家模型（混元 / DeepSeek / GPT）| 无绑定 |
| **代码检索/RAG** | 大量投入（vector db + AST + 索引服务） | 依赖工具层（bash+grep / lsp seam / web seam）；无内建 vector db |
| **多语言 LSP** | 通常有内建 language server pool | `packages/lsp` seam：注册即用 |
| **代码沙箱** | 通常在服务端跑（docker/k8s） | 客户端沙箱 seam（bwrap/Seatbelt/ACL）+ 可扩展到 e2b/远程 |
| **权限/审计** | 中央化，企业管理员配置 | 客户端 approval seam + hook 审计事件 |
| **多用户** | 中央用户系统 | `dsh-identity` 匿名 identity；企业协作靠 UI/后端叠加 |
| **可插拔性** | 平台运营方专属 | 用户/第三方开发者一等公民 |
| **数据留痕** | 服务端审计 | 客户端会话日志（可对接遥测 sink） |
| **协议开放** | 私有 | ACP / JSON-RPC / MCP-友好 |

**总结**：闭源 IDE Agent 的优势在**中央化管控、代码检索的深度、企业接入的一站式**；dsh 的优势在**开源可掌控、可 self-host、可跨 LLM、多 UI、事件溯源审计、Cordis 插件生态**。二者面向不同市场；但如果一家企业想以 dsh 为底座做自己的"内网 tcum-ai"，是完全可行的路径——事实上 dsh 交付的 web / headless / ACP / JSON-RPC 四种 profile 与 `dsh-web` + `dsh-host` 双半架构就是奔着这个场景。

---

## 26. 优点分析

### 26.1 架构层面

1. **事件溯源作为一等公民**：`SessionEvent` 是唯一真源；模型可见 ⟺ 已记录；崩溃恢复保留部分执行；fork/replay/压缩都可以是纯投影。这是当前开源 Coding Agent 里最工整的会话模型。
2. **Cordis 让"一切皆插件"落地**：不是宣传语——LLM adapter、工具、循环本身、会话后端、UI 都是 entry。切换后端 = 换一行 config。
3. **Capability Seam 强制三角设计**：新能力必须同时设计 Definition / Provider / Consumer；避免"一半 seam"的常见架构陷阱。
4. **Waterfall 拦截远强于生命周期 hook**：环绕、可包装、可短路、类型化返回值——这是 aspect-oriented 而非 event-driven。
5. **Scope 让多 agent 定制变简单**：作用域内 shadow + restriction 交集 + scope-local 新增，让"每个 agent 独立 persona/工具集"是一个可组合操作。
6. **Turn/Step/Round 四层词汇**：清晰区分用户视角、模型视角、策略视角；各层策略挂钩到正确层级。

### 26.2 工程质量

7. **doc-sync + type-equiv + 双语文档**：`docs/subsystems/*.md` 里的 `type-equiv` fenced block 会由 `pnpm run verify-type-equiv` 校验与 src 的字节等价；`verify-translation-pairing` 保证中英双语一致。**文档不是过时的负担，而是被 CI 门禁保护的真实契约**。
8. **100% 单文件覆盖率门禁**（`test:coverage`）：默认每个包每个源文件都要 100% 单元测试覆盖。
9. **snapshot 测试 + 真实 API e2e**：`test:snapshot` 用 keyless ACP/headless replay 对齐期望，`test:e2e` 带 key 走真 provider。
10. **AGENTS.md 明确列 20+ 条 conventions**：`Registrations are effects`、`Switch on discriminant tags`、`Misconfiguration fails loud`、`Trust TypeScript at typed same-process boundaries`……**每条都能追溯到具体 Agent Note 决策**。
11. **`.agents/notes/`**：不可变的架构决策记录（ADR），非平凡变更必须附一份 note 在同 PR。**决策历史可追溯**。
12. **一致的错误分类**：`FsErrorCode`、`SubagentError`、`ManualCompactionErrorCode`、`SandboxEnforcement`、`ApprovalOutcome`——都是闭合联合，`switch` + `assertNever` 兜底。
13. **防御性模式文档**（defensive-patterns.md）：把 7 类真实历史缺陷成文规则，避免复发。

### 26.3 生态与部署

14. **原生兼容 Claude Code / Codex hooks**：迁移成本几乎为零。
15. **原生兼容 ACP、MCP、JSON-RPC**：可以做客户端也可以做服务端。
16. **subagent seam 让 dsh 能反向嵌入**：`dsh-subagent-codex` / `-claude-code` 让 dsh 可以把 turn 委派给别人；反过来别人也可以把 dsh 当 subagent。
17. **多 profile 单仓库**：Web、Headless、ACP、JSON-RPC 都从同一份代码组装。
18. **MIT + 完全开源**：无授权顾虑。

### 26.4 独一无二的能力

19. **`ctx.dynamicCordisRunner`**：agent 可以在运行时挂载自己写的 Cordis Plugin/Package——一种"元 harness"能力。
20. **Code Mode 是 capability seam**：不是绑死 JS worker，可以换成 Python、E2B 等；且子分发走完整工具流水线。
21. **Compaction 与 pruner 分离**：先剪工具结果，再决定要不要摘要——比大多数只做 summarization 的方案精细。
22. **Sandbox 强制度 partial/full 显式报告**：绝对安全的 consumer 可以拒绝或上抛，而不是当作全强制。

---

## 27. 缺点与风险分析

### 27.1 复杂度与上手门槛

1. **术语密度极高**：turn/step/round/goal round/ralph round、scope key/scope carrier/lineage、seam/definition/provider/consumer、shadow/restrict、waterfall/emit/parallel/serial、`send`/`followup`/`steer`/`inject`、`agent/pre-step`/`agent/request`/`agent/request-error`/`agent/turn-stopping`……初学者会淹没。
2. **Cordis 不是主流框架**：Cordis 本身是一个较小众的框架（用于 Koishi 生态），生态之外知者不多；文档虽好但要读完 `cordis-primer.md` + `cordis-tutorial/*` + 20+ 篇 `subsystems/*` 才能真正"上手做贡献"。
3. **文档量巨大**：`docs/` 目录 100+ 篇 markdown，`config-catalog.md` 129 KB，`module-graph.md` 121 KB。信息完整但初次浏览成本高。
4. **package 数量爆炸**：`packages/` 下有近 50 个包组，每组内又 3-8 个子包。**没有一张全景图**能一眼看完（`module-graph.md` 是生成的但太大）。
5. **一切通过 `ctx.<key>` 与事件解耦**：静态导航难。要理解"tool 调用 → provider 响应"这条链，得跳读 5-7 个包。IDE 里"Go to Definition" 有时无法直达。

### 27.2 性能与运行时

6. **Node.js 单进程**：agent-loop、tools、fs、subprocess 都在同一 Node 进程里。CPU 密集型工具、大量 chunk 事件（比如超长模型输出）会给 event loop 压力。虽然 code-runtime 提供 worker-thread provider，但主循环无法多线程化。
7. **事件溯源的写放大**：assistant/chunk 全量落日志——SQLite 后端加上 WAL 是标配（应该有 checkpoint policy），JSONL 后端在极长会话下磁盘占用会大。
8. **`ctx.effect()` 撤销顺序敏感**：AGENTS.md 强调"teardown 顺序有要求时放在同一个 effect"，但一旦忽略容易泄漏；dispose 完全停稳的约定虽然写清，但违反了不会立即报错，只在长会话下暴露。

### 27.3 生态与市场

9. **无自研 LLM 加持**：DeepSeek 官方 API 免费/优惠，但 dsh 定位"harness"，与 DeepSeek 模型的深度绑定弱（provider seam 使得换模型很容易，反而不像 Claude Code 那种"模型 + agent 深度协同"的优势）。对追求"最佳模型体验"的用户，没有"专属"感。
10. **默认工具集竞争激烈**：dsh 的 `bash` / `read_file` / `edit` / `todo_write` / `plan_mode` 与 Claude Code / Codex 的默认工具几乎重合，用户如果只关心"能用"，不太会因 seam 架构而切换。
11. **社区规模**：截至发布，dsh 是开发者预览版；GitHub 关注度、外部 plugin 数量都远小于 Claude Code / Codex 生态。
12. **依赖 Cordis 源码 vendored**：`vendor/` 里 pin 上游 SHA，同步流程是手动的；万一 Cordis 上游停更或路径分叉，dsh 得独自维护 fork。
13. **面向 agent 的说明书（AGENTS.md）比人类文档更完整**：这套项目的目标读者是"AI agent 帮我改代码"，人类只读 README 会觉得跳跃——它明确期待你有 agent 在旁边协助阅读。

### 27.4 安全与合规

14. **Extensions 自修改带来供应链风险**：模型能定义 + 挂载自己写的 Cordis Plugin，虽然有审批 + client half approval，但**任何 approval bypass 都是 escape**。这条能力必须配合极其严格的沙箱和审计。
15. **hooks 命令走 `ctx.shell`**：hook 是 in-workspace shell 命令，如果 hook.json 被恶意 pull request 污染，`SessionStart` 就能执行任意命令——这是 Claude Code / Codex 共有的问题，dsh 也没有额外防线。
16. **partial 沙箱强制度**：Windows ACL / 老 Landlock ABI 只能 partial 强制；文档明确说"require absolute boundary 的 consumer 必须拒绝或上抛"，但实际有多少 consumer 认真处理 partial 是问号。
17. **credential 引用系统需要小心使用**：`dsh-credentials` 用引用而非明文（env 优先于 `.env`），但插件如果直接读 `process.env` 就绕过了引用体系。

### 27.5 破坏性变更风险

18. **明确处于 developer preview**：README 与 AGENTS.md 反复强调 "compatibility-breaking changes"。`AGENTS.md` 的 "Pre-release stance" 章节甚至写着"backends reject old on-disk formats"——**升级 harness 版本可能拒绝老会话文件**。这对希望长期存储对话的用户是一个警告。
19. **`SESSION_FORMAT_VERSION` 目前锁在 0**：明说"no compatibility promise"。首个正式 tagged release 之前，格式可能大改。

---

## 28. 适用场景建议

### 28.1 强烈适合

- 想做**内部 Coding Agent 产品**：把 dsh 当 harness 底座，注入自研 LLM adapter、自研代码检索工具、自研审批中心；产品逻辑写成 Cordis 插件而非 fork。
- 需要**多 LLM provider 切换**：dsh 的 provider seam 是原生的，`ctx.llm` 上注册 adapter 即可。
- 需要**多 agent 编排**：subagent seam 六个 provider 涵盖 in-process、fork、ACP、Codex、Claude Code、dsh SDK；scope 让每个 agent 独立能力集。
- 需要**完整审计与回放**：事件溯源 + 持久化 seam + hook 审计事件对 = 合规友好。
- **教学与研究**：这是我读过的最完整的开源 agent harness 架构文档；对想理解"如何做一个 agent 框架"的人是绝佳教材。
- **企业内部替代 Claude Code / Codex**：如果不能上外网、要绑内网 LLM、要接现有 CI/审批，dsh 比 fork Claude Code 简单得多。

### 28.2 需要三思

- **个人开发者只想快速跑代码**：Claude Code / Codex CLI 装一个二进制就能用；dsh 需要 pnpm、node 22/24、编译工作区，学习成本高一个数量级。
- **重度依赖 Anthropic 独占能力**：如 Claude 的 computer use、Artifacts、超长上下文等能力，需要 LlmAdapter 自己实现，不一定第一天就位。
- **单人小团队的临时脚本工作**：headless profile 可以用，但整体框架的复杂度会让"一个脚本"看起来杀鸡用牛刀。

### 28.3 不建议

- **无 TypeScript 基础的团队**：dsh 完全 TypeScript-first + strict mode + `noImplicitAny`；Cordis 依赖 TS declaration merging 与品牌类型。
- **想立即拿到"最完善默认体验"**：默认工具还在快速迭代，developer preview 意味着"你要愿意跟着一起改"。

---

## 结语

DeepSeek Harness 的设计野心非常明确：**做一个"不选一款 coding agent"的框架，让下一款 coding agent 只是它的一个 profile**。它把架构层面的正确性推到了当前开源领域少见的程度——事件溯源的会话、waterfall 的循环拦截、三角完整的能力接缝、按 agent 隔离的作用域、双语文档 + 类型等价校验的工程门禁。

它的每一条主要设计都有一份 Agent Note 说明"为什么这么选、不那么选"，`.agents/notes/implemented/**` 是一份罕见的、可读的 ADR 集合。

**成本是**：概念密度、术语门槛、需要读几十篇文档才能真正贡献代码，加上 developer preview 阶段的破坏性变更风险。

**对比小结**：
- 你要**一款好用的 coding agent**：选 Claude Code 或 Codex CLI。
- 你要**基于开源做自己的 coding agent 产品**：选 dsh，然后写几个 Cordis 插件把你的 LLM、检索、审批、UI 插进去。
- 你要**理解"如何做 agent harness"**：dsh 是当前最完整的公开范本，把 `docs/architecture.zh.md` + `agent-lifecycle.zh.md` + `tool-execution-pipeline.zh.md` + `subsystems/core.zh.md` + `subsystems/tools.zh.md` + `subsystems/session.zh.md` + `subsystems/subagent.zh.md` + `cordis-primer.zh.md` 顺序读完，收获会超过任何一本 agent 主题的书。
