# 15 · 长任务拆解：四家 Agent 深度对比

> **核心洞察**：长任务拆解不是一个"用 TodoWrite 就能对付"的问题。它是**三层能力叠加**：
> 1. **Plan 层**：任务开始前的规划（Plan Mode）
> 2. **Progress 层**：任务执行中的进度追踪（TodoWrite）
> 3. **Delegate 层**：把子任务派给独立 agent 执行（Subagent / Task tool）
>
> 四家的差异，本质是**这三层的覆盖度 + 各层的工程深度**。dsh 是唯一三层都独立成包、且完全事件化的实现。
>
> 编写时间：2026-08-23。dsh 部分基于源码可验证；Codex / Claude Code 部分标 `[推测]` 并给出证据来源；tcum-ai 部分标 `[待补]`。

---

## 一、"长任务"的三个具体形态（先厘清问题）

面试官问"长任务怎么拆"，你要先反问：**哪种长任务？**

| 形态 | 典型例子 | 主要挑战 |
|---|---|---|
| **A. 深度型**（多步串行） | 修复一个跨 20 个文件的 bug、重构一个模块 | 上下文爆炸、模型健忘、KV cache 塌陷 |
| **B. 广度型**（多子任务并行） | 分析 100 个文件、给每个函数写文档 | 并行度控制、结果聚合、成本控制 |
| **C. 长时型**（长时间运行） | CI 里跑一晚上、周期性巡检 | 崩溃恢复、Resume、进度可观测 |

**关键**：不同形态需要不同的拆解策略：
- A 型主要靠 **Plan Mode + TodoWrite**（规划 + 进度）；
- B 型主要靠 **Subagent Fork**（并行分派）；
- C 型主要靠 **Event Sourcing + Checkpoint**（持久化 + 恢复）。

四家的策略覆盖度也不同——记住这个三分法，下面对比会清晰得多。

---

## 二、四家总体策略速览

| 家 | Plan 层 | Progress 层 | Delegate 层 | Persist 层 |
|---|---|---|---|---|
| **Codex** | ❌ 无 | ❌ 无（隐式） | ❌ 无 | ✅ Responses API `previous_response_id` |
| **Claude Code** | ✅ Plan Mode (`Shift+Tab`) | ✅ TodoWrite 工具 | ✅ Task 工具（sub-agent） | 部分 `.claude/projects/*/history.jsonl` |
| **dsh** | ✅ `plan-mode` 独立包 | ✅ `todo_write` + `todo/write` 事件 | ✅ **6 种 subagent provider** | ✅ **完全事件化 append-only** |
| **tcum-ai** | [待补] | [待补] | [待补] | [待补] |

**结论提前给你**：Codex 是"极简/黑盒"、Claude Code 是"齐全但内嵌"、dsh 是"完全解耦 + 三层都可插拔"。

---

## 三、逐家详细分析

### 1. Codex 的长任务拆解——"极简派"

#### 1.1 核心思路：**依赖服务端 + 依赖模型自身推理**

Codex 是 OpenAI 官方 CLI，走 Responses API：
```
POST /v1/responses
{
  "previous_response_id": "resp_xxx",  ← 服务端保存完整对话
  "input": [{ new user turn only }]
}
```

**长任务拆解的机制在服务端和模型里，不在客户端**。

#### 1.2 Codex 的三层情况

| 层 | Codex 情况 |
|---|---|
| Plan 层 | ❌ 无明确 Plan Mode。用户想让 agent 先规划，只能靠 prompt engineering |
| Progress 层 | ❌ 无 TodoWrite。模型自己在思维链里追踪，用户看不到 |
| Delegate 层 | ❌ 无 Task tool。所有工作都在单一 agent 里做 |
| Persist 层 | ✅ 但对用户透明——`previous_response_id` 由 SDK 内部管理 |

#### 1.3 Codex 的三层实际实现（推测 + 官方文档）

**Plan 层**：只有 `AGENTS.md` 作为静态指令。若用户希望规划，需在 `AGENTS.md` 里写`"Always plan before acting"`——纯 prompt 约束，无工程保障。

**Progress 层**：OpenAI 的 `o1`/`o3` 系列模型自带 reasoning tokens，reasoning 是长任务拆解的隐式载体——模型内部自己想清楚步骤。但**这些 reasoning tokens 用户看不到**（Responses API 只返回 encrypted reasoning summary）。

**Delegate 层**：完全没有。若要并行调用 20 个工具，Codex 依赖 OpenAI 的 parallel function calling（一次 response 里返回多个 tool_use），但**这不是拆解成子 agent，只是并行工具执行**。

**Persist 层**：`previous_response_id` 服务端接续。这是 Codex 唯一的长任务优势——**客户端崩了、重启后带 id 继续跑，服务端还有完整历史**。

#### 1.4 Codex 的优缺点

**优点**：
- **架构简单**：客户端几百行代码，重心全在服务端；
- **无客户端 context 管理**：不用 compact，OpenAI 服务端自己处理；
- **KV cache 命中率高**：服务端有完整 history，能做最优 prefix 匹配。

**缺点**：
- **无透明进度**：用户不知道模型内部规划了什么、执行到哪一步；
- **无子任务并行**：一个大任务只能串行做，慢；
- **无恢复选择性**：不能只回退某一步（要么全跟随 `previous_response_id`，要么完全新会话）；
- **依赖 OpenAI 服务端**：断网就没法工作，无 offline 能力；
- **调试困难**：黑盒，出问题只能看服务端日志（用户看不到）。

**总结一句话**：Codex 把长任务拆解**外包**给了模型和 OpenAI 服务端，客户端做尽可能少的事。

---

### 2. Claude Code 的长任务拆解——"齐全派"

#### 2.1 核心思路：**三层齐全，都做在客户端**

Claude Code 有明确的三层设计：**Plan Mode + TodoWrite + Task tool**。

#### 2.2 Plan 层：Plan Mode

**触发**：`Shift+Tab` 切换（推测——Anthropic 官方文档）。

**行为**：
- 进入 Plan Mode 后，Claude **只读不写**——所有会修改文件系统的工具（Write / Edit / Bash 里的写操作）都被 sandbox 禁用；
- Claude 只能用 Read、Grep、Glob 等只读工具**探索代码**；
- 探索完后**输出一个 Plan**——用户 review、批准；
- 批准后退出 Plan Mode，Claude 开始执行。

**核心价值**：**只读探索 + 显式批准**——避免"agent 想都没想就开始改代码"。

**局限**（推测）：
- 强制静态 Plan——如果执行中发现原 Plan 不对，需要重新进 Plan Mode；
- Plan 内容存在 message history 里，长任务 compact 时可能丢失；
- 无 Plan 的持久化——不能跨会话保留 Plan。

#### 2.3 Progress 层：TodoWrite 工具

**用法**（官方文档）：
```json
{
  "todos": [
    { "content": "读 config.ts", "status": "in_progress", "activeForm": "读取 config.ts" },
    { "content": "改 tool schema", "status": "pending", "activeForm": "修改 tool schema" },
    { "content": "跑测试", "status": "pending", "activeForm": "运行测试" }
  ]
}
```

**行为**：
- 模型主动调用 `TodoWrite` 更新任务清单；
- 用户看到 checklist UI；
- 每次工具调用时，模型**重新发整个 list**（不是 patch）；
- `activeForm` 是进行时的动词（"正在做 X"），用于 UI 展示。

**核心价值**：
- **显式进度追踪**——用户能实时看到 agent 做到哪；
- **反循环**——模型自己看自己的 todo，发现"我已经卡在这一步 5 轮了"能自动切换策略；
- **不影响推理**——todo 只是文本状态，模型可以随时看到但不强制。

**局限**：
- **无持久化**——TodoWrite 内容存 message history，session 结束就没了；
- **靠模型自觉**——模型可能忘了更新 todo（Claude Sonnet 4 之前经常出现）；
- **无 UI 编辑**——用户不能手动改 todo（除非重新提示模型）。

#### 2.4 Delegate 层：Task 工具

**用法**（官方文档）：
```
Use the Task tool to search all error handling patterns in packages/*/src
```

**行为**：
- 主 agent 调用 `Task` 工具，创建一个 **sub-agent**；
- Sub-agent **拿到独立 context**（不继承父 agent 的对话历史）；
- Sub-agent 执行自己的多轮循环（可以用 Read / Grep / 甚至嵌套 Task）；
- Sub-agent 完成后，只**返回 final result**给父 agent；
- 父 agent 拿到 result 后**只看得到结果，看不到 sub-agent 的过程**。

**核心价值**：
- **上下文隔离**——sub-agent 消耗自己的 token 预算，不污染父 agent 的 context；
- **并行分派**——多个 Task 可以并行跑（父 agent 一次 response 可以发多个 Task 调用）；
- **专项优化**——sub-agent 可以配置不同 model（比如便宜的 Haiku 做搜索，贵的 Opus 做 reasoning）。

**局限**：
- **不能通信**——sub-agent 跑起来后，父 agent 中途没法给它加信息；
- **不能续跑**——sub-agent 完成即销毁，不能"再问它一个问题"；
- **一次性**——所有 sub-agent 都是 fire-and-forget。
- **父 agent 看不见过程**——若 sub-agent 走错了，父 agent 只能从 final result 里推测。

#### 2.5 Persist 层：`.claude/projects/*/history.jsonl`

- 每个 session 一个 `history.jsonl`；
- `claude --resume` 从历史恢复；
- Compact 时会摘要（`/compact`），也可能自动触发。

**局限**：格式内部，未公开；跨版本兼容性未保证。

#### 2.6 Claude Code 三层协同的典型工作流

```
User: 帮我重构 packages/core/agent-loop，让它支持并行 tool calls
    │
    ▼
Claude: 进入 Plan Mode (Shift+Tab)
    ├─ Read agent-loop/src/index.ts
    ├─ Grep 所有调用者
    ├─ 输出 Plan：
    │   1. 修改 AgentLoop.step 支持 Promise.all
    │   2. 更新 tool 调度器
    │   3. 添加并行度上限配置
    │   4. 更新测试
    │
    ├─ 用户审批 ✅
    │
    ▼
Claude: 退出 Plan Mode，调用 TodoWrite:
    [1] pending: 改 step
    [2] pending: 改调度器
    [3] pending: 加配置
    [4] pending: 加测试
    │
    ├─ Task 并行分派：
    │   ├─ SubAgent A: 探索"现在的 step 具体怎么调 tool"
    │   └─ SubAgent B: 探索"现有的测试用什么 mock"
    │
    ├─ 拿到两个 SubAgent 结果 → 更新 TodoWrite [1] in_progress
    ├─ Edit files → TodoWrite [1] completed, [2] in_progress
    ...
```

#### 2.7 Claude Code 的优缺点

**优点**：
- **三层齐全**——业界最完整的 agent 长任务拆解产品；
- **UX 好**——用户能看到 plan、看到 todo checklist、看到 sub-agent 分派；
- **Sub-agent 隔离好**——独立 context 是防止 context 污染的最有效手段。

**缺点**：
- **内嵌硬编码**——三个能力都是内建的，第三方没法替换或扩展；
- **无跨 session 状态**——Plan、Todo 都会随 session 结束丢失；
- **Sub-agent 无通信/续跑**——一次性 fire-and-forget，不适合"长时间跑的子任务"；
- **可观测性弱**——sub-agent 内部执行父 agent 看不到，出问题难 debug。

**总结一句话**：Claude Code 是**当前用户体验最好**的方案，但是**闭源、无法扩展**。

---

### 3. dsh 的长任务拆解——"完全解耦派"

dsh 是这四家里**唯一**把 Plan / Progress / Delegate / Persist 四层**都拆成独立包**、**都事件化**、**都可插拔**的实现。

#### 3.1 Plan 层：`@deepseek-ai/dsh-plan-mode`（独立包）

源码：[`packages/plan/plan-mode/`](/Users/yaao/Documents/code/AI-agent/deepseek-harness/packages/plan/plan-mode)（README + 4 个测试文件，源代码 20KB）

**核心机制**（[`packages/plan/plan-mode/README.zh.md`](/Users/yaao/Documents/code/AI-agent/deepseek-harness/packages/plan/plan-mode/README.zh.md)）：

| 组件 | 作用 | 事件类型 |
|---|---|---|
| `plan/mode` 事件 | 持久化的 plan 状态，`{ active: boolean }`，log-only | `SessionEventMap` 成员 |
| `foldPlanMode(events)` 函数 | 从事件日志折叠出当前 plan 状态 | 纯函数投影 |
| `ctx.planMode.set(agent, active)` API | 服务方法切换 plan 状态 | 返回 `committed`/`queued`/`cancelled`/`noop` |
| `/plan [message]` 命令 | 用户手动进入 plan mode，可选带初始消息 | 触发 `command/run` 事件 |
| `/plan off` 命令 | 直接退出 plan mode | - |
| `exit_plan_mode` 工具 | 模型主动请求退出（走用户审批） | 走 `ctx.userQuestions` 审批 |
| `plan` sessionProjection unit | 折叠 command + plan/mode 事件产出 `{ active, pending }` | 可选注册 |

**dsh vs Claude Code Plan Mode 的关键差异**：

| 维度 | Claude Code | **dsh** |
|---|---|---|
| 状态载体 | Message history | **独立日志事件 `plan/mode`** |
| 恢复 | `--resume` 加载历史 | **`foldPlanMode()` 纯函数从日志恢复**，跨压缩保留 |
| Fork 继承 | 未知 | **Fork agent 继承 plan 状态，spawn agent 从未激活开始** |
| 切换机制 | Shift+Tab (键盘) | `/plan` 命令 + `ctx.planMode.set()` API + `exit_plan_mode` 工具三条路径 |
| 强制程度 | 依赖 sandbox 禁用工具 | **软引导** —— plan mode 本身只贡献 system prompt 段，强制约束由 sandbox-policy / permission-presets 独立插件负责 |
| UI 集成 | 内嵌 | 通过 `session/event` 广播，UI 自己 subscribe |

**"软引导 vs 硬强制"分离**是 dsh 的一大精妙设计——[`packages/plan/plan-mode/README.zh.md`](/Users/yaao/Documents/code/AI-agent/deepseek-harness/packages/plan/plan-mode/README.zh.md) 明说：
> Plan mode 只进行引导，而不强制执行；需要强制限制的部署必须分别配置沙箱与批准控制。

也就是说 dsh 里：
- `plan-mode` 包：告诉模型"你在规划状态"（软引导）；
- `sandbox-policy` 包：真正禁用写工具（硬强制）；
- `permission-presets` 包：审批策略（人机协作）；

三个包**正交独立**——你可以有 plan mode 但不禁写、或者禁写但不 plan mode，任意组合。Claude Code 是把这三件事**绑死**的。

#### 3.2 Progress 层：`@deepseek-ai/dsh-tool-todo`

源码：[`packages/tools/tool-todo`](/Users/yaao/Documents/code/AI-agent/deepseek-harness/packages/tools) + `docs/tool-catalog.md#L1686`

**核心机制**：

**TodoItem** 定义（[`docs/subsystems/session.md#L144`](/Users/yaao/Documents/code/AI-agent/deepseek-harness/docs/subsystems/session.md)）：
```ts
interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  // 没有 id、priority、activeForm —— 列表整体替换，无需稳定标识
}
```

**工具调用**（`todo_write`）：
- 输入是**完整 list**（不是 patch），整体替换旧值；
- 触发 `todo/write` 事件（log-only）；
- UI 渲染最新的 `todo/write` 事件为 checklist。

**dsh 相比 Claude Code TodoWrite 的关键差异**：

| 维度 | Claude Code | **dsh** |
|---|---|---|
| 数据结构 | 有 `activeForm` 进行时描述 | **精简**：只有 content + status 三态 |
| 持久化 | 存 message history | **一等公民事件 `todo/write`**，log-only 且跨压缩保留 |
| 恢复 | 靠 message 重放 | **`session.replay()` 自动重建**，任何时点可获取最新 todo |
| 并行 in_progress | 允许多个 | **`allowParallelInProgress` 显式配置**，无默认必填，`docs/tool-catalog.md#L1730` |
| 更新方式 | 全量替换 | 全量替换（避免 partial update 的复杂性） |

**`allowParallelInProgress` 的设计精妙**（[`docs/tool-catalog.md#L1730`](/Users/yaao/Documents/code/AI-agent/deepseek-harness/docs/tool-catalog.md)）：
> allowParallelInProgress is required with no default, so the catalog states its choice

作者被强制思考："你的场景允许多个任务同时 in_progress 吗？"——因为**并行执行 vs 串行执行**对模型行为有本质影响：
- `false`：模型被强制一个个做，进度线性清晰；
- `true`：允许多个并行，适合广度型任务，但模型可能忘记某个 in_progress 的任务。

dsh 不给默认值，强制作者选择。

**e2e 例子**：`examples/acp-agent/tests/snapshots/todo-write/session.jsonl` 完整演示一次 todo_write：
```json
{"type":"tool/call","name":"todo_write","arguments":{
  "todos": [
    { "content": "read the code", "status": "in_progress" },
    { "content": "watch the background", "status": "pending" },
    { "content": "reply DONE", "status": "pending" }
  ]
}}
```

`session.jsonl` 里能看到工具调用参数 + `todo/write` 事件写入 + UI 状态渲染的完整链条。

#### 3.3 Delegate 层：**6 种 subagent provider**（dsh 独有）

这是 dsh 最惊人的能力。源码：[`packages/subagent/`](/Users/yaao/Documents/code/AI-agent/deepseek-harness) 下 9 个包！

| 包 | 作用 |
|---|---|
| `dsh-subagent` | 核心 seam，`ctx.subagents` 服务 + 提供方注册表 |
| `dsh-subagent-fork-in-process` | **Fork 后端**：子 agent 继承父 agent 已完成 turn 的历史前缀 |
| `dsh-subagent-spawn-in-process` | **Spawn 后端**：子 agent 全新独立 context |
| `dsh-subagent-acp` | **ACP 协议后端**：把远程 agent 当作 subagent |
| `dsh-subagent-codex` | **把 Codex 当 subagent** —— 让 dsh 主 agent 调用 Codex 做子任务 |
| `dsh-subagent-claude-code` | **把 Claude Code 当 subagent** —— 让 dsh 主 agent 调用 Claude Code 做子任务 |
| `dsh-subagent-dsh-sdk` | 通过 SDK 调用另一个 dsh agent 做 subagent |
| `dsh-tool-subagent` | 面向模型的委派工具（按 provider） |
| `dsh-tool-subagent-control` | 面向模型的控制工具：`send_message` / `interrupt_agent` / `list_agents` |
| `dsh-tool-subagent-report` | 面向模型的返回通道工具：child 向 parent report |

**这意味着一个 dsh agent 可以在长任务中：**
- Fork 自己（继承历史）；
- Spawn 干净的子 agent（独立探索）；
- 调用 Codex 处理某个专项（比如 "Codex 你去看看这个 OpenAI 特化的场景"）；
- 调用 Claude Code 处理另一专项（"Claude Code 你去做代码 review"）；
- 通过 ACP 协议调用远程 agent。

**Claude Code / Codex 都没有对等能力**。

#### 3.4 Subagent 的两种模式

`docs/subsystems/subagent.zh.md` 明确划分：

| 模式 | 生命周期 | 与父 agent 关系 |
|---|---|---|
| **One-shot** | 一次性、fire-and-forget、只有 final result | 父 agent 直接消费 `SubagentRun.result` |
| **Continuable** | 持久化子 agent 会话，可多轮对话，可中断可恢复 | 父 agent 可 `followup` 追加消息，可 `interrupt` 中断，可 `reportFrom` 让子 agent 向父上报 |

Claude Code 的 Task 只有 one-shot；dsh 两者都有——**continuable 是 dsh 独有**。

**Continuable Subagent 的典型工作流**（[`docs/subsystems/subagent.zh.md`](/Users/yaao/Documents/code/AI-agent/deepseek-harness/docs/subsystems/subagent.zh.md)）：
```
Parent Agent:
  ├─ startContinuable(spec)  → 得到 { childId, messageId }
  │    ├─ 保留稳定 childId
  │    ├─ 快照 subagent/descriptor 事件（版本化）
  │    ├─ 创建 Activation（子 agent 驻留期）
  │    └─ 提交初始 prompt
  │
  ├─ ...父 agent 继续工作...
  │
  ├─ followup(parent, childId, content, options)
  │    ├─ 如果 childId 在线（running/waiting）：直接入队 inbox
  │    └─ 如果 childId 离线：cold resume 新 Activation
  │
  ├─ ...
  │
  ├─ 子 agent 主动调 reportFrom() → 通过 Agent.inject() 静默投递给 parent
  │
  ├─ interrupt(childId, authority)  → 中断子 agent 当前 turn（保留 inbox）
  │
  └─ 子 agent 完成 → SubagentRuntime 自动发 subagent-settled 通知给 parent
```

**关键设计细节**：

1. **委派深度限制**（`SessionHeader.delegationDepth` + `SubagentStartRequest.maxDepth`）
   - 每 fork 一层深度 +1；
   - 可配置绝对上限；
   - 冷恢复不能降低深度；
   - **防死递归**（不然 sub-agent 又 fork sub-agent 无限套娃）。

2. **Fork Seed 注入**（`CreateAgentOptions.seed`）
   - Fork 后端传父 agent 日志的**已完成轮次前缀**（从 seq 0 到最后一个 `turn/end`）；
   - 事件流从 0 连续，`invariants` 回放接受它；
   - **未完成的 turn 被排除**——避免子 agent 拿到父 agent 半成品状态。

3. **Interrupt 授权**（两种 authority）
   - `{ kind: 'user', parentSessionId }`：人类客户端提供的父 session 地址；
   - `{ kind: 'ancestor', agent: Agent }`：确切在线 ancestor Agent（记录的谱系必须包含调用方）；
   - **权限模型精细到 session lineage**，防止 sub-agent 越权中断兄弟 subagent。

4. **子 agent 上报 vs 系统通知**（两种 MessageSource）
   - `subagent-report`：子 agent **主动**选择上报的内容；
   - `subagent-settled`：管理器**自动**发的"子 agent 结束了"通知；
   - **transcript 里两种来源分开记录**——不会把管理器的账目伪装成 child 的话。这是防止 UI 误解的设计。

5. **持久化 catalog + `list_agents`**
   - `ctx.subagents.listChildren(parentSessionId)` 枚举直接子 agent；
   - `ctx.subagents.listDescendants(rootSessionId)` 枚举完整后代树；
   - **零 Agent 加载**——只读 session store，不 resume 任何 agent；
   - 可选模型工具 `list_agents` 暴露给模型自己看："我现在有哪些子 agent 在跑"。

#### 3.5 Persist 层：Event Sourcing + Semantic Checkpoint

dsh 有独立包 `@deepseek-ai/dsh-session-checkpoint-policy`（[`packages/session/session-checkpoint-policy`](/Users/yaao/Documents/code/AI-agent/deepseek-harness/packages/session/session-checkpoint-policy)）。

**Semantic checkpoints**（`python/sdk/README.md` 里明说）：
> ...preloaded DeepSeek adapter, JSONL session persistence with an **explicitly composed semantic checkpoint policy**, local bash...

**三个持久化 checkpoint**（`python/sdk-runtime/src/deepseek_harness_runtime/runtime/cordis.yml`）：
```
# the request, tool-dispatch, and completed-step durability checkpoints.
- id: session-checkpoints
  name: '@deepseek-ai/dsh-session-checkpoint-policy'
```

即在三个语义边界持久化：
1. **request** 边界（发出 LLM 请求前）；
2. **tool-dispatch** 边界（工具调度前）；
3. **completed-step** 边界（一个 step 完成后）。

**为什么是这三个点？**
- request 前 checkpoint：**如果 LLM 请求崩溃**，重启后 replay 到这里，state 完整；
- tool-dispatch 前：**如果工具执行崩溃**，能知道当时要调哪个工具；
- step 完成后：**建立稳定的 recovery 起点**，下次从这里恢复不必重放整个 turn。

**对比 Claude Code**：
- Claude Code 也做 append-only history 但没有明确的 semantic checkpoint 划分；
- Codex 靠服务端 `previous_response_id`，客户端不管；
- dsh 是**唯一显式建模**的。

#### 3.6 dsh 三层协同的典型工作流（真实源自 e2e 测试）

```
User: /plan 帮我重构 agent-loop 让它支持并行 tool calls
    │
    ▼
plan-mode 插件：
    ├─ 追加 plan/mode 事件 { active: true }
    ├─ /plan 后缀 "帮我重构..." 通过 agent.steer() 成为下一轮 user message
    │
    ▼
LLM (在 plan mode 的 system prompt 引导下):
    ├─ Read agent-loop/src/index.ts (Read tool)
    ├─ Grep 调用者 (Grep tool)
    ├─ 调用 todo_write:
    │   [{ content: "改 step", status: "pending" },
    │    { content: "改调度器", status: "pending" },
    │    { content: "加配置", status: "pending" },
    │    { content: "加测试", status: "pending" }]
    │  → 事件 todo/write 写入
    │
    ├─ Fork 子 agent A 并行探索 "现在 step 具体怎么调 tool"
    │  → subagent 事件: start (provider=fork, childId=xxx)
    │  → 父 agent 继续做别的事，Promise.all 等 A
    │
    ├─ Spawn 子 agent B（干净 context）分析"现有测试用什么 mock"
    │  → subagent 事件: start (provider=spawn)
    │  → 子 B 拿不到父的历史，独立探索
    │
    ├─ 拿到 A、B 的 result
    │  → subagent 事件: end (双方各一)
    │
    ├─ 更新 todo_write: [1] in_progress
    ├─ 调用 exit_plan_mode（要求批准）
    │  → ctx.userQuestions 弹 plan-review UI
    │
    ├─ 用户批准 ✅
    │  → plan/mode 事件 { active: false }
    │
    ├─ Edit files → todo_write [1] completed, [2] in_progress
    ├─ ...
    │
    └─ 全部完成 → todo_write 全 completed → turn/end
```

**注意**：所有绿色框都是**独立事件类型**写进 `session.jsonl`，UI 通过 `session/event` 订阅推送更新。任何时点崩溃，重启后 `session.replay()` 恢复到最近 checkpoint，然后继续。

#### 3.7 dsh 的优缺点

**优点**：
- **三层完全解耦**——Plan / Progress / Delegate 都是独立包，任意组合；
- **事件化持久化**——每个决策都是一个可回放事件，天然支持长时任务的 resume；
- **6 种 subagent provider**——可以调用外部 agent（Codex/Claude Code/ACP 远程）作为子任务执行器；
- **软引导 + 硬强制分离**——plan-mode 只贡献 prompt，sandbox 单独强制，正交组合；
- **委派深度限制**——防死递归；
- **Continuable subagent**——支持长时间跑的子任务，可多轮 followup 和 interrupt。

**缺点**：
- **架构复杂度高**——插件 + Cordis 依赖注入的学习曲线陡；
- **UX 不如 Claude Code**——需要客户端自己接 session event 做 UI；
- **模型需 fine-tune**——`allowParallelInProgress` 之类的选项对普通模型来说抽象度高，建议配合特定模型 prompt 调优；
- **e2e 复杂度**：一个"plan → fork → todo → exit_plan"的完整流程涉及至少 10+ 个事件类型，UI 得都 render 对。

**总结一句话**：dsh 是**工程深度最深、组合能力最强**的方案，但对使用者要求也最高。

---

### 4. tcum-ai 的长任务拆解——[待补]

按你项目实际情况填。以下是模板：

| 层 | tcum-ai 是否有？ | 如果有，怎么实现？ | 如果没有，落地建议 |
|---|---|---|---|
| Plan 层 | ? | ? | 借鉴 dsh `plan-mode`：独立 `plan/mode` 事件 + `/plan` 命令 + 软引导 |
| Progress 层 | ? | ? | 借鉴 dsh `todo_write`：全量替换 + 事件化 + `allowParallelInProgress` 显式配置 |
| Delegate 层 | ? | ? | 最小版：单一 `spawn` provider（干净 context 子 agent）；进阶版：加 `fork`（历史继承） |
| Persist 层 | ? | ? | 借鉴 dsh `session-checkpoint-policy`：三个 semantic checkpoint (request / tool-dispatch / completed-step) |

---

## 四、四家横向对比表（这一张是面试拿出来直接用的）

### 4.1 Plan 层对比

| 维度 | Codex | Claude Code | **dsh** | tcum-ai |
|---|---|---|---|---|
| 是否有专门 Plan Mode | ❌ | ✅ Shift+Tab | ✅ `/plan` + `exit_plan_mode` | ? |
| Plan 状态持久化 | 无 | Message history | **独立事件 `plan/mode`**，跨压缩保留 | ? |
| 强制 vs 引导 | N/A | 硬（sandbox 禁写工具） | **软引导 + sandbox 单独强制正交组合** | ? |
| 用户批准机制 | 无 | Shift+Tab 隐式 | **`exit_plan_mode` 走 `ctx.userQuestions` 审批** | ? |
| Fork agent 继承 plan | N/A | 未知 | **Fork 继承，Spawn 清零** | ? |

### 4.2 Progress 层对比

| 维度 | Codex | Claude Code | **dsh** | tcum-ai |
|---|---|---|---|---|
| Todo 工具 | ❌（内嵌 reasoning） | ✅ TodoWrite | ✅ todo_write | ? |
| 数据结构 | N/A | content + status + activeForm | **content + status（三态）** 极简 | ? |
| 持久化 | N/A | Message history | **一等事件 `todo/write`**，log-only | ? |
| 并行 in_progress | N/A | 默认允许 | **`allowParallelInProgress` 无默认强制作者选** | ? |
| 更新方式 | N/A | 全量替换 | **全量替换**（拒绝 partial update） | ? |
| 崩溃恢复 | N/A | 靠 message replay | **`session.replay()` 自动重建** | ? |

### 4.3 Delegate 层对比

| 维度 | Codex | Claude Code | **dsh** | tcum-ai |
|---|---|---|---|---|
| 子任务派发工具 | ❌ | ✅ Task | ✅ **6 种 provider** | ? |
| One-shot subagent | N/A | ✅ | ✅ | ? |
| Continuable subagent（多轮） | N/A | ❌ | ✅ **可 followup、interrupt、reportFrom** | ? |
| 独立 context | N/A | ✅ | ✅ Spawn 模式独立 | ? |
| 继承父历史 | N/A | ❌ | ✅ **Fork 模式继承已完成 turn 前缀** | ? |
| 委派深度限制 | N/A | 未知 | ✅ **`delegationDepth` + `maxDepth`** | ? |
| Tool 过滤（child 只能用部分工具） | N/A | 未知 | ✅ **`toolFilter` capability** | ? |
| Persona 定制（child 用不同人设） | N/A | 未知 | ✅ **`persona` capability，scoped 影子** | ? |
| Output Schema 强约束 | N/A | 未知 | ✅ **`outputSchema` 结构化返回** | ? |
| 调用外部 agent（Codex / Claude Code） | N/A | ❌ | ✅ **`subagent-codex` / `subagent-claude-code` provider** | ? |
| 中断子 agent | N/A | 未知 | ✅ **`interrupt(target, authority)` 双授权模式** | ? |
| 枚举后代 | N/A | 未知 | ✅ **`listChildren` + `listDescendants`** | ? |

### 4.4 Persist 层对比

| 维度 | Codex | Claude Code | **dsh** | tcum-ai |
|---|---|---|---|---|
| 客户端有 log | ❌（服务端保管） | ✅ `.claude/projects/*/history.jsonl` | ✅ `session.jsonl` | ? |
| Log 是纯函数？ | N/A | 部分 | ✅ **`deriveMessages()` bit 级一致** | ? |
| Semantic Checkpoint | N/A | 无（隐式） | ✅ **request / tool-dispatch / completed-step 三点** | ? |
| Compact 保留 checkpoint | N/A | `/compact` 打断 | ✅ **跨压缩保留** | ? |
| Resume 依赖 | 服务端 | 客户端 `--resume` | 客户端 `session.replay()` | ? |

---

## 五、深度追问（面试官视角，套娃 7 层）

**S1**（root）：你们 agent 怎么拆解长任务？

**S2**：你说 TodoWrite / plan mode——那 plan 内容用什么持久化？崩了怎么办？
- 强答：**独立事件类型 `plan/mode` + `todo/write`**，log-only 跨压缩保留（dsh 做法）；不是 message history（Claude Code 做法，会被 compact 摘掉）。

**S3**：三个 in_progress 任务并行跑，模型忘了更新其中一个的状态怎么办？
- 强答：三条防线：
  1. **配置 `allowParallelInProgress: false` 强制串行**（dsh 显式选项，无默认）；
  2. **`agent/pre-step` hook 检测**——如果同一 in_progress 任务超 N 步无进展就 prompt 提醒（dsh 有 `repeat-tool-reminder` 独立包）；
  3. **UI 显式提示**——todo list 展示"该 todo in_progress 已 30 min"，人工介入。

**S4**：子任务 fork 后，父 agent 想改主意让子 agent 换个方向怎么办？Claude Code 的 Task 好像不支持啊？
- 强答：**Claude Code 不支持**（Task 是 fire-and-forget）。**dsh 支持**：
  - `SubagentRuntime.followup(parent, childId, content, options)` 追加消息到子 agent 的 inbox；
  - 如果 childId 在线：直接入队；
  - 如果离线：cold resume 唤醒；
  - 授权：调用方必须是 durable direct parent。

**S5**：子 agent 又 fork 子 agent 无限套娃怎么办？
- 强答：**dsh 的深度限制**：
  - 持久化 `SessionHeader.delegationDepth`——每 fork 一层 +1；
  - `SubagentStartRequest.maxDepth` 单次调用可指定绝对上限；
  - 冷恢复不能降低深度（防绕过）；
  - 超限 fail loud，返回 `SubagentError('UNSUPPORTED_CAPABILITY')`。

**S6**：Fork 子 agent 时把父 agent 的历史"复制"给子 agent，是不是直接双份 KV cache？成本翻倍？
- 强答：**不翻倍**：
  - Fork seed 是**父 agent 已完成 turn 的 log 前缀**（`turn/end` 之前的完整部分）——通过 `CreateAgentOptions.seed` 传；
  - 子 agent 拿到 seed 后重建 messages 数组和父 agent **bit 级一致**（`deriveMessages` 是纯函数）；
  - **KV cache 是 provider 侧**——同一个 provider 看到相同前缀会命中缓存，**只 prefill 一次**；
  - 所以 fork 的 token 计费是 prompt cache read（0.1×–0.5×），不是完整 prompt cost。
  - 除非用两个不同 provider——那才双份。

**S7**：那 continuable subagent 一直挂着不释放，是不是会内存泄漏？
- 强答：**dsh 的三段所有权模型**：
  - `Activation` 概念：驻留 agent 的存续期；
  - 只有当子 agent **完全停稳 + 其所有子级都 dispose + best-effort 会话 flush 结算完毕**，才释放 `AgentHandle`；
  - 父 agent teardown 时会 `drainContinuableDescendants(parents)` **child-first 顺序**释放；
  - `interrupt(target, authority)` 只**触发 cancel signal**，不等待完全停稳返回（fire-and-return）；
  - 子 agent 观察 signal 停下后，再走正常 dispose 流程。
  这套设计**避免"父先死子还在跑"的孤儿子进程**。

---

## 六、按"长任务形态"再对号入座

回到最开始的三种形态：

### 形态 A（深度型：多步串行修 bug）

**最佳工具组合**：
- Codex：**依赖 reasoning tokens + AGENTS.md 引导**——弱；
- Claude Code：**Plan Mode 探索 + TodoWrite 追进度**——强；
- **dsh**：**plan-mode + todo_write + session-checkpoint-policy**——最强（可精确恢复到任一 completed step）。

### 形态 B（广度型：分析 100 个文件）

**最佳工具组合**：
- Codex：**依赖 OpenAI 的 parallel function calling**——单 agent 内并行 tool 调用，无子 agent 隔离，父 agent context 会被 100 个 tool_result 撑爆；
- Claude Code：**Task tool 并行 fire-and-forget**——每个 Task 独立 context，父 agent 只拿结果，是这种场景的标准解；
- **dsh**：**subagent-spawn + toolFilter 限制子 agent 只能用只读工具 + outputSchema 强约束返回结构**——最工程化。

### 形态 C（长时型：跑一晚上）

**最佳工具组合**：
- Codex：**依赖 Responses API `previous_response_id`**——服务端接续，客户端极简；但网络断了就废了；
- Claude Code：**`.claude/projects` + `--resume`**——可以恢复，但 Plan / Todo 状态可能因 compact 丢失；
- **dsh**：**Event Sourcing + Semantic Checkpoints + Continuable Subagent**——工业级；Todo / Plan 都是独立事件，`todo/write` 跨压缩保留，`plan/mode` 用 fold 函数从日志重建。**唯一能做到"跑一晚上、断电重启后 5 秒续跑"的**。

---

## 七、给 tcum-ai 的落地建议（按投入产出排序）

### Sprint 1：Progress 层 MVP（1 周）
- 加 `todo_write` 工具，事件类型 `todo/write`；
- 数据结构 `{ content, status: 'pending'|'in_progress'|'completed' }` 极简；
- 全量替换更新；
- UI 渲染最新 todo 事件；
- **明确决定 `allowParallelInProgress` 布尔值**，写进配置文档不给默认。

### Sprint 2：Persist 层（2 周）
- 参考 dsh `session-checkpoint-policy` 加三个 semantic checkpoint；
- session log 用 JSONL append-only；
- `deriveMessages()` 保持纯函数（禁 `Date.now()` / 随机 id）；
- Resume 从最近 checkpoint 恢复。

### Sprint 3：Plan 层（2 周）
- 新增事件类型 `plan/mode: { active: boolean }`；
- 提供 `/plan` 命令、`/plan off` 命令、`exit_plan_mode` 工具；
- 软引导：plan mode 只贡献一段 system prompt；
- 硬强制交给独立 sandbox policy（不要绑一起）。

### Sprint 4：Delegate 层 MVP（3-4 周）
- 先做 `spawn-in-process`：干净 context 的子 agent；
- 加 `delegationDepth` + `maxDepth`；
- 加 `outputSchema` 强返回结构；
- 事件 `subagent/start` + `subagent/end`。

### Sprint 5（可选，激进）：Continuable Subagent
- 只有 tcum-ai 走"平台化"路径时才做；
- 参考 dsh 6 provider 架构，从最简单的 `fork-in-process` 起步；
- 加 `followup` / `interrupt` / `reportFrom`；
- 加 Activation 所有权模型（child-first teardown）。

---

## 八、一句话金句（面试收尾用）

> "长任务拆解不是一个功能，是**三层能力叠加**——Plan（规划）、Progress（进度）、Delegate（分派）。Codex 依赖服务端和模型；Claude Code 三层齐全但内嵌；dsh 三层全部独立成包、完全事件化，是唯一能做到'跑一晚上、断电重启后 5 秒续跑'的架构。tcum-ai 的落地路径应该按 Progress → Persist → Plan → Delegate 逐步展开，前两层是基础设施，后两层是体验加成。"

---

## 附录 · 关键源码地址（面试引用用）

**dsh 侧**：
- Plan Mode：[`packages/plan/plan-mode/README.zh.md`](/Users/yaao/Documents/code/AI-agent/deepseek-harness/packages/plan/plan-mode/README.zh.md)
- TodoWrite：[`docs/subsystems/session.zh.md#L129`](/Users/yaao/Documents/code/AI-agent/deepseek-harness/docs/subsystems/session.zh.md)
- Subagent seam：[`docs/subsystems/subagent.zh.md`](/Users/yaao/Documents/code/AI-agent/deepseek-harness/docs/subsystems/subagent.zh.md)
- Subagent 6 providers：`packages/subagent/subagent-{fork,spawn,acp,codex,claude-code,dsh-sdk}-in-process/`
- Session Checkpoint Policy：[`packages/session/session-checkpoint-policy`](/Users/yaao/Documents/code/AI-agent/deepseek-harness/packages/session/session-checkpoint-policy)
- Semantic Checkpoints 说明：[`python/sdk-runtime/src/deepseek_harness_runtime/runtime/cordis.yml`](/Users/yaao/Documents/code/AI-agent/deepseek-harness/python/sdk-runtime/src/deepseek_harness_runtime/runtime/cordis.yml)
- E2e 例子（Todo）：`examples/acp-agent/tests/snapshots/todo-write/session.jsonl`
- E2e 例子（Subagent）：`examples/acp-agent/tests/snapshots/subagent-continuable/`

**Claude Code 侧**（推测/官方文档）：
- Plan Mode：Anthropic Claude Code docs
- TodoWrite：Anthropic Claude Code 内置工具
- Task tool：Anthropic Claude Code 内置工具

**Codex 侧**（推测/官方文档）：
- Responses API：OpenAI Platform docs `POST /v1/responses`
- AGENTS.md：Codex CLI 官方文档
