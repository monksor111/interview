# 14 · 套娃式追问 & Agent 自进化专题

> 本文是 [13-KV-Cache优化与AI-Agent通用问题50问.md](./13-KV-Cache优化与AI-Agent通用问题50问.md) 的**深度姊妹篇**。
> - 上半部分：**套娃式追问**（4 条主链：KV Cache / 上下文管理 / 一切皆插件 / 长程可靠性），每条围绕一个 root question 展开 5–8 层深挖，每一层都能被下一层"锤爆"；
> - 下半部分：**Agent 自进化专题**——CLAUDE.md 自更新、Codex AGENTS.md、dsh 的动态 Cordis plugin（能让 agent 在运行时"写代码给自己装能力"）、self-correct 反馈闭环，附源码证据。
>
> 阅读方式：**面试官视角**——每层追问揭示上一层可能糊弄的漏洞。若答不出下一层，说明还没触到真实工程。

---

## 第一部分 · 四条套娃追问链

### 链 A · KV Cache 的追问（8 层）

**A0（root）**：你们 agent 怎么保证 KV cache 命中率？

**A1（追问）**："让 system prompt 稳定"——那你 system prompt 里塞不塞 CWD、git status、当前时间戳？如果塞了，每轮都变一遍，你怎么解释还能命中？
- 弱答：`用户不能感知`；
- 强答：**分离通道**——system prompt 只放 persona + 工具，动态信息走独立事件（dsh 的 `steering/message` / `agent.inject()`），拼装到 message 末尾而非 system 内。`[dsh 源码：docs/subsystems/session.zh.md#steering]`

**A2（追问）**：那 tools 数组呢？tool schema 里有 description，某个作者改了一个字的描述，全部 tools 的字节偏移变了，怎么办？
- 弱答：`tools 一般不变`；
- 强答：**Tools 只在 system 段末尾追加**（不插入中间），并且默认字典序排序 (`packages/core/tools/src/ts-types.ts`)。改一个 description 只影响从该 tool 起往后的字节，前面的仍命中。加新 tool 应放字典序对应位置，dsh 的 `<unlisted-tools>` rest 占位符强制作者显式定位新 tool。

**A3（追问）**：你说了默认字典序，但如果某天有人手贱在插件里给 tool 加了个前缀 `01_bash`，字典序变化，整个 system prompt 从这里全崩，怎么防？
- 弱答：`code review`；
- 强答：**CI 强制**——dsh `scripts/verify-package-readme-model-experience.ts` 要求每个包的 README 声明 `#### KV Cache effect`；违反直接失败。此外 `toolOrder` 显式配置钉死顺序，`TOOL_ORDER_REST` 占位符逼作者思考"新 tool 到底该放在哪儿"。`[源码可验证]`

**A4（追问）**：那 messages 段呢？工具结果每次都不一样，历史消息也在增长，前缀增量后为什么还能命中？
- 弱答：`OpenAI/DeepSeek 会自动前缀匹配`；
- 强答：**前缀增量命中的关键是"新增内容都在末尾"**——历史消息 append-only 不允许就地改。dsh 的 `deriveMessages()` 是**纯函数**，同一份 event log 输出 bit 级一致的 messages 数组；如果里面藏了 `Date.now()` 或随机 id，缓存立刻塌陷。`[docs/subsystems/session.zh.md#reconstructability]`

**A5（追问）**：那 compaction 呢？一压缩，前面所有历史都变了，前缀命中直接归零，你怎么办？
- 弱答：`忍受一次全量重跑`；
- 强答：**checkpoint 机制**——dsh 有 `@deepseek-ai/dsh-compaction` 显式 checkpoint 事件，压缩后从 checkpoint 开始积累新缓存池。此外 `compaction-tool-result-pruner` 只剪工具结果（尾部大块），不动 assistant 推理（前缀），这样即使 compact 也能保住大部分前缀命中率。

**A6（追问）**：Anthropic 是手动打 cache_control 断点的，你怎么知道断点该打在哪？打错一个位置就废了？
- 弱答：`按 Anthropic cookbook 抄`；
- 强答：**4 个断点位置的选择原则**（Anthropic API 最多 4 个 ephemeral）：
  1. `system prompt 末尾`——最稳定；
  2. `tools 数组末尾`——次稳定；
  3. `最近一次 tool_result 之前`——保护多轮工具往返；
  4. `user turn 开头`——滚动断点，让上一轮的 assistant + tool_result 也进 cache。
  4 个断点是**滑动的**——每完成一轮 turn，用最新的 turn 边界重新打断点，让 5 分钟 TTL 有机会保住。

**A7（追问）**：你说的 5 分钟 TTL，长任务 30 分钟不发请求怎么办？
- 弱答：`重跑`；
- 强答：**保活心跳 or 接受过期**——Anthropic 官方无保活 API，实用做法是**接受过期**但**减少首个请求代价**：把首次请求的 write 成本（1.25×）视为长任务的固定 overhead，后续 read（0.1×）省钱。Codex 走 Responses API 服务端保存 `previous_response_id`，没有 TTL 问题——**这是 OpenAI 相比 Anthropic 在长任务上的最大工程优势**。

**A8（追问）**：现在你在 tcum-ai 上要落地一套 KV cache 优化，第一版最小实现你要做哪 3 件事，性价比排序？
- 强答（tcum-ai 落地建议）：
  1. **canonical request header**（一天工作量）——把 system/tools 用规范化函数序列化，等价但字节不同的场景（空数组 vs 缺失字段）统一，避免"看起来一样但不命中"；
  2. **tool schema 字典序 + 显式 toolOrder**（半天工作量）——一行 sort，命中率可能从 0 拉到 80%+；
  3. **`cacheReadTokens` 计量**（一天工作量）——把 provider usage 里的 cached_tokens 抽出来做 metrics，能看到才能改。
  三件事一周内落地，剩下的 compaction checkpoint / cache_control 断点是 Sprint-2 的事。

---

### 链 B · 上下文管理与 Compaction 的追问（7 层）

**B0（root）**：Agent 上下文快满了怎么办？

**B1**：滑窗、摘要、剪枝，你选哪个？为什么？
- 弱答：`摘要`；
- 强答：**三选一是错的**——生产上必须组合：**摘要**处理旧的 assistant 推理（信息密度高）、**剪枝**处理旧的 tool_result（信息密度低但字节巨大）、**滑窗**永远不用（除非一次性 chatbot），因为滑窗直接丢失 tool call 链条会导致后续步骤崩溃。dsh 就是这么分工的：`compaction-basic` 做压力检测 + 摘要，`compaction-tool-result-pruner` 做工具结果剪枝。

**B2**：那你怎么决定"什么时候该压缩"？触发条件是什么？
- 弱答：`token 数到阈值`；
- 强答：**多信号**：
  1. **事前**：`token-meter` 在 `agent/pre-step` waterfall 里评估**下一次 request 会不会超**，超了就先压缩；
  2. **事后**：捕获 `agent/request-error` 里 provider 返回的 `context_length_exceeded`，反向触发压缩后重试；
  3. **主动**：用户 `/compact` 或 SDK 层调用。
  单看 token 数不够——不同 provider 的 token 计算不同（tiktoken vs deepseek tokenizer），事前估计不准，必须留 fallback。`[dsh: packages/compaction/compaction-basic]`

**B3**：压缩后模型可能忘掉重要细节（比如用户几百 turn 前说的偏好），怎么防？
- 弱答：`让模型自己摘要`；
- 强答：**分层记忆**：
  1. **短期**（本 turn 前 N 条）——不动；
  2. **中期**（可 compact）——LLM 摘要，但摘要 prompt 里明确要求保留"用户明确表达的约束 / 偏好 / 决策"；
  3. **长期**（跨 session）——写入 `CLAUDE.md` / `AGENTS.md` / dsh 的 `settings` 服务，永久保留。
  Claude Code 的 `/compact` 时会自动 propose 更新 `CLAUDE.md`，本质是把易失记忆迁移到持久化通道——**这就已经踩到 Agent 自进化的门槛了**（见下半部分）。

**B4**：那摘要本身能不能被摘要？递归 compact 会不会累积误差？
- 弱答：`不会`；
- 强答：**会**——这就是 LLM 的"电报游戏效应"。工程解法：
  - **保留 raw checkpoint**：摘要时**同时保留一份原始事件到本地**（不进上下文，进磁盘），需要时可加载子片段；
  - **禁止摘要摘要**：dsh 的 checkpoint 事件带 `originalRange: [seq_lo, seq_hi]`，二次压缩时**直接跳过已被压缩的区间**，只压缩新事件；
  - **摘要错误自愈**：模型下次读文件发现和摘要冲突时，会主动更正，dsh 的 `fs/observed` 事件就是这个机制。

**B5**：你说 tool_result 剪枝——一个文件读了两次结果不一样（比如中间被改过），你剪掉旧的会不会误导模型？
- 弱答：`保留最新的就行`；
- 强答：**去重要看语义**——文件读取用 `path + mtime` 做 key，重复读取只保留最新；grep 结果用 `query + files_scanned` 做 key；不能全按"同名工具就去重"。dsh 的 `compaction-tool-result-pruner` 里有分类去重策略。**并且剪掉后要在剪除处塞一个 marker**（如 `[3 previous reads of /src/foo.ts pruned]`），让模型知道"这里发生过读取"，避免它以为从来没读过。

**B6**：如果用户强制不 compact，任由上下文爆，最终会怎么样？
- 强答：**分层熔断**：
  1. 达到 provider hard limit（如 GPT-4o 128k）——直接 API 错误，agent-loop 拿到 `context_length_exceeded` 后 fallback 到强制 compact；
  2. 达到 provider soft limit（80%）——切换到更长上下文的 model route（如 Gemini 1M 或 GPT-4.1）；
  3. 用户禁用了 compact 又不给切模型——**turn-stopping**，返回明确错误 `TurnEndReason=context_exhausted`，让用户手动决定。**永远不要静默丢消息**。

**B7**：Codex 用 Responses API 服务端接续，是不是根本没有 compact 问题？
- 强答：**有，但被 OpenAI 藏起来了**。`previous_response_id` 只是客户端不用重发历史，服务端仍要把所有历史喂给模型，同样受 model 的 max context 限制。区别在于：
  - Codex 客户端：**看不见** context 用了多少（黑盒），无法主动 compact；
  - Claude Code / dsh 客户端：**看得见**（token-meter 一等公民指标），可主动优化。
  dsh 用户完全可以自己实现"Responses-API-like 服务端接续"——只需一个 stateless 代理保存日志——但**主动权在客户端**，这就是可观测性带来的架构选择自由。

---

### 链 C · "一切皆插件" 的追问（8 层，dsh 核心）

**C0（root）**：dsh 一切皆插件，具体怎么实现的？

**C1**：什么叫"一切"？举 3 个具体例子。
- 强答：
  1. **LLM adapter**：`llm-deepseek` / `llm-pi-ai` / `llm-anthropic` 都是插件，切 provider = 换插件；
  2. **工具**：每个工具（bash / read / grep / todo）都是独立 npm 包，MCP 工具是运行时注册的插件；
  3. **系统能力**：compaction、token 计量、subagent、skills，甚至 system prompt 组装本身都是插件。
  **反例**：Claude Code / Codex 的工具集和 LLM 绑死在核心里，加功能靠 fork。

**C2**：底层框架叫什么？和 DI 容器（Spring / NestJS）什么区别？
- 强答：**Cordis** ([docs/cordis-primer.zh.md](/Users/yaao/Documents/code/AI-agent/deepseek-harness/docs/cordis-primer.zh.md))——依赖注入 + 事件总线。区别：
  - **DI 容器**（Spring）：静态注册、启动期解析、运行时不可变；
  - **Cordis**：**运行时可挂卸**——`ctx.plugin(P)` 挂载，`fiber.dispose()` 卸载，全过程无重启；
  - **服务 vs 事件**：Cordis 服务是 API（`ctx.tools.register`），事件是 hook（`ctx.on('agent/pre-step')`）；服务用于直接能力调用，事件用于拦截和策略。

**C3**：`ctx.plugin(P)` 挂载时到底做了什么？有没有 lock？会不会有并发问题？
- 强答：Cordis 的 `Context` 是**fiber tree**——每个 plugin 挂在自己的 fiber 上，parent-child 关系构成 tree。挂载流程：
  1. 解析 `inject` 声明，等待依赖 fiber 就绪；
  2. 分配新 fiber，调用 `apply(ctx)` 或 Service 构造函数；
  3. 服务通过 `ctx.provide(name, impl)` 注册到 fiber-local store；
  4. 挂载完成，parent 的 `ctx.get(name)` 可见。
  并发：Cordis 的 fiber 是**协程语义**（非 OS 线程），每个 fiber 里操作序列化；跨 fiber 通过服务代理（`ctx.reflect`）访问，代理走全局 service store，不受 fiber 拓扑影响。**这在 postmortem 0001 里踩过大坑**：跨 fiber 传递的可追踪代理在 root fiber 上找不到 service——后来靠 `ctx.reflect.get(name, false)` 直接查全局 store 绕过。`[docs/postmortem/0001-acp-default-export-drops-inject.zh.md]`

**C4**：事件的 4 种分发模式（emit / waterfall / parallel / serial）怎么选？举例说明。
- 强答（[docs/cordis-primer.zh.md#dispatch-modes](/Users/yaao/Documents/code/AI-agent/deepseek-harness/docs/cordis-primer.zh.md)）：
  | 模式 | 是否 await | 顺序 | 有返回值 | 典型场景 |
  |---|---|---|---|---|
  | `emit` | 否 | 注册序 | 否 | `session/event` 单纯广播 |
  | `waterfall` | 否 | 注册序 | 是 | `agent/pre-step` 决策链，前一个可修改决策传给下一个 |
  | `parallel` | 是 | 并发 | 否 | `session/persist` 多 sink 并行落盘 |
  | `serial` | 是 | 注册序 | 是 | `tool/execute` 顺序拦截 + 决策 |
  **关键**：waterfall 是**环绕中间件**——listener 拿到 `(...args, next)`，调 `next()` 才走下游，短路直接 return 就否决全部下游。这是 Cordis 事件里最强大的一个。

**C5**：waterfall 的短路语义有什么坑？如果一个 listener 忘了调 `next()` 呢？
- 强答：**短路是 by design**——策略型 listener（如权限拒绝、缓存命中）应该短路。**观察型 listener 必须调 `next()` 委托**，否则会静默吞掉下游。dsh 的 [postmortem-0002](/Users/yaao/Documents/code/AI-agent/deepseek-harness/docs/postmortem/0002-js-expression-disabled-filesystem-tools.zh.md) 就是踩过一次：一个配置里的 `!!js` 表达式解析错误，导致 filesystem-tools 的 listener 短路了整个工具注册链。后来通过 loader-configuration 规范 + AGENTS.md 规则杜绝再次发生。

**C6**：`inject` 声明依赖，如果 A 依赖 B，B 依赖 A，怎么办？
- 强答：**Cordis 直接死锁**（fiber 永远等不到 ready）。解决：
  1. 用 lazy 服务代理——`ctx.reflect.get('B', false)` 不阻塞挂载，运行时再拿；
  2. 拆分成三个：A、B 都依赖 C，C 是共享抽象；
  3. 从设计上避免——dsh 里的服务图是 DAG（[docs/cordis-api/context.zh.md](/Users/yaao/Documents/code/AI-agent/deepseek-harness/docs/cordis-api/context.zh.md)），有 `dsh-dependency-check` gate 静态检测循环依赖。

**C7**：插件卸载（`fiber.dispose()`）时怎么保证资源清理干净？漏掉一个 timer 会怎样？
- 强答：**`ctx.effect()` 强制返回 disposer**——注册副作用时必须给回收函数（unregisterFn / clearTimeout / socket.close），Cordis 在 dispose 时逆序调用。漏掉：
  - 内存泄漏（listener 引用父 fiber 阻止 GC）；
  - "僵尸"响应（disposed plugin 的 hook 仍触发）；
  - dsh 通过 [`docs/defensive-patterns.zh.md`](/Users/yaao/Documents/code/AI-agent/deepseek-harness/docs/defensive-patterns.zh.md) 规范 + CI lint 检查每个 `ctx.on` 必须在同一 scope 内有对应 disposer。

**C8**：一切皆插件的**代价**是什么？为什么 Claude Code / Codex 不这么做？
- 强答：**代价三方面**：
  1. **启动开销**：每次挂载 fiber、resolve inject、type-check，冷启动比硬编码慢 5-10x；
  2. **类型系统复杂**：`ctx.tools` 类型要靠 TS 声明合并（declaration merging）动态扩展，出错难 debug；
  3. **调试链路长**：一个 tool 调用穿过 5 层 waterfall、3 个服务代理，栈追踪很深。
  Claude Code / Codex 选择硬编码是**产品定位**——它们是**面向终端用户的应用**，不追求二次开发。dsh 定位是**Agent 平台**，让第三方能实现自己的 tool 集/policy/observer，插件化必不可少。这不是技术优劣，是场景选择。

---

### 链 D · 长程任务可靠性追问（7 层）

**D0（root）**：agent 跑一个 3 小时的任务，中间进程崩了怎么办？

**D1**：怎么恢复？重跑还是续跑？
- 弱答：`重跑`；
- 强答：**续跑**。dsh 用 **Event Sourcing** 模式：`session.jsonl` 是唯一真源，进程 = 事件日志的纯函数。重启后 `session.replay(logPath)` 从任意点恢复。`request/header` 里的 `reason: 'resume'` 明确标记恢复边界。`[docs/subsystems/session.zh.md]`

**D2**：一个工具执行了一半（比如 bash 跑了 30 秒生成了半个文件）崩了，怎么恢复？
- 弱答：`重新执行`；
- 强答：**工具幂等性 + 显式 checkpoint**：
  - 工具本身应设计为幂等（如 file write 用原子 rename，git 用 commit hash 定位）；
  - dsh 在 tool 执行开始时 append `tool/call`，结束时 append `tool/result`——**如果只有 call 没有 result**，说明中断，恢复时读取工具对应的外部副作用状态（如文件已存在则跳过）；
  - 不幂等工具（如 `git push`、`API POST`）必须包裹在 confirm + idempotency-key 里，否则 resume 会重复执行造成灾难。

**D3**：模型在 turn 3 说"我要删除 100 个文件"，崩溃后 resume，你要不要重放这个删除？
- 强答：**分层判断**：
  1. **model output 恒常重放**——assistant 输出是纯文本，重放无副作用；
  2. **tool call 需 checkpoint**——检查是否已有对应 `tool/result` 事件，有则跳过工具执行；
  3. **副作用 rollback**——如果崩溃发生在 tool 执行中期，且工具不幂等，应该**拒绝 resume**并让用户决策（dsh 的 `TurnEndReason=partial_execution` 保留这个信号）。
  **实践建议**：所有对外副作用的工具都必须能被 event log 表达——如果一个工具改了 DB 但没写 `tool/result`，就是 bug。

**D4**：会话日志几十 MB 磁盘满怎么办？
- 强答：**日志 rotation + 冷热分离**：
  - 热：本 session 完整 log（用于 replay / debug）；
  - 冷：老 session gzip 归档；
  - **不做 append-only 就地删**——删除历史事件破坏 replay 保证，dsh 里明确禁止；
  - "撤销"场景（用户点回退到 turn 3）用 `steering/message` 事件表达反悔，不删旧事件。

**D5**：一个 turn 内多个 step 并发跑，其中一个失败了，其他要不要回滚？
- 强答：**agent 不做分布式事务**。每个 tool call 是独立事件，失败就 `tool/result.isError=true`，模型看到后自己决定下一步（重试 / 换路径 / 告诉用户）。**关键是错误信息足够详细**——dsh 的 `tool/result` 带 stderr + exit code + human-readable detail，让模型能 self-correct。`[docs/subsystems/code-runtime.zh.md#L154]`

**D6**：如果模型陷入死循环——反复调 `read_file` 同一个文件，token 烧穿怎么办？
- 强答：**多层熔断**：
  1. **max_steps**：agent-loop 硬限，触发 `TurnEndReason=max_steps` 强制停；
  2. **重复检测**：hook 在 `agent/pre-step` 挂 detector，同一 tool + 相同参数连续 N 次触发告警；
  3. **cost 预算**：`token-meter` 里的 usage projection 累加，超过每 turn 预算触发 escalate；
  4. **模型自省**：`todo_write` 让模型显式追踪进度，反复无进展时 prompt 里显式提示"你正在原地打转"（dsh 的 `agent/turn-stopping` hook 可实现）。

**D7**：3 小时任务跑到一半，用户改主意想让 agent 换个方向，不重启怎么办？
- 强答：**steering 机制**（dsh 独有）——[docs/subsystems/core.zh.md](/Users/yaao/Documents/code/AI-agent/deepseek-harness/docs/subsystems/core.zh.md)：
  - `Agent.steer(message)` 把用户的新指令插入下一个 step 的 message 队列；
  - 与 `Agent.followup()` 区别：followup 排队到 turn 之后；steer 是**turn 中途插入**；
  - 已发出的 LLM 请求不打断（等 stream 完），但下一个 step 的 request 会带上 steering message；
  - `TurnEndReason` 里有独立的 `steering_change` 值让上层能感知。
  Claude Code / Codex 没有等价机制——你要改方向只能 ESC 中断再重新输入，中断的成本是丢失当前 turn 的上下文推理。

---

## 第二部分 · Agent 自进化专题

> **这个话题目前业界只有 3 种典型形态**，从弱到强：
> 1. **Claude Code / Codex：静态记忆文件**（CLAUDE.md、AGENTS.md）——启动加载，运行时不变；
> 2. **dsh：动态注入 + 记忆更新**——`agent.inject()` 让运行时新信息进入下一次请求；
> 3. **dsh：动态 Cordis Plugin**（`cordis_define` / `cordis_run` / `cordis_inspect_self`）——**agent 在运行时"写代码给自己装能力"**，失败后自省诊断、修正、重试。这是目前最激进的自进化形态。
> 三种都写。

---

### 一、Claude Code 的 CLAUDE.md 自更新机制

#### 1.1 CLAUDE.md 是什么？

Claude Code 的**长期记忆文件**。启动时读入 system prompt，规则示例：
```md
# CLAUDE.md
## Project conventions
- 使用 pnpm 而非 npm
- 所有 log 走 packages/logger
- 提交前必须跑 pnpm test
## User preferences
- 不要主动加注释
- 用中文回复
```

优先级：`project/CLAUDE.md` > `user/~/.claude/CLAUDE.md` > 内置默认。

#### 1.2 自更新流程（推测 + 官方文档综合）

有 3 条更新路径：

**路径 A：`#` 快捷键（用户主动）**
- 用户敲 `#`，Claude Code 弹出一个 memory prompt；
- 用户输入内容如"记住我用 pnpm"；
- Claude 生成一个 file diff，写入 `CLAUDE.md`；
- 下次启动生效。

**路径 B：`/init` 命令**
- 命令让 Claude 扫描项目结构，**自动生成** `CLAUDE.md`（读 `package.json` / `Makefile` / `README` 归纳规约）；
- 用户 review 后 commit。

**路径 C：`/compact` 时的记忆迁移**
- `/compact` 摘要历史时，如果模型识别到"用户明确表达的偏好或约束"，会 propose 更新 `CLAUDE.md`；
- 用户 confirm 后写入；
- **这一步是真正的"自更新"**——不是用户显式写，而是模型从对话中提炼。

#### 1.3 CLAUDE.md 的缺陷（面试重点）

| 缺陷 | 具体表现 | 是否可修 |
|---|---|---|
| **静态注入** | 启动后不变，跑到一半发现规约不对没法立即更新 | 需重启 |
| **无版本追溯** | 谁改的、什么时候改的、为什么改，只能靠 git log | 依赖用户 |
| **可能过时** | pnpm 换成 bun 了，CLAUDE.md 还在说 pnpm，模型继续用错 | 无自动检测 |
| **优先级冲突** | project/CLAUDE.md vs user/CLAUDE.md 冲突时行为不明 | 文档模糊 |
| **无 KV cache 友好** | 更新一次全废，system prompt 缓存清零 | 结构性 |

---

### 二、Codex 的 AGENTS.md（对照）

#### 2.1 位置与加载

Codex 用 `AGENTS.md`（**注意 dsh 也用 `AGENTS.md`**——两家撞名了但语义不同）：
- Codex 从当前目录及上级目录递归查找；
- 同样启动时加载进 system prompt。

#### 2.2 差异

Codex 更"贴 git"：
- `AGENTS.md` 是团队共享文件（commit 到 repo）；
- Codex 不做"记忆迁移"（无 `/compact`-like 命令 propose 更新）；
- 用户手动维护为主。

**优点**：明确的团队约定；**缺点**：完全无自更新，最简版记忆。

---

### 三、dsh 的自进化：三层能力

dsh 的自进化远超前两家，分 3 个层次：

#### 3.1 **第一层：`agent.inject()` 动态上下文注入**

来源：`docs/architecture.zh.md#L124` / `docs/cookbook/adding-a-tool.zh.md#L49`

```ts
agent.inject({
  content,
  source: { kind: 'plugin', plugin: '<name>' }
})
```

作用：**下一次模型请求会看到追加的内容**，无需重启。用途：
- **文件变更通知**：watcher 检测到 `.env` 被改，`agent.inject("File .env changed, contents: ...")`；
- **子目录 AGENTS.md 触发式加载**：`docs/cookbook/extension-cookbook.zh.md#L113`——只有 agent 触碰某个子目录时才把该目录的 `AGENTS.md` inject 进上下文，避免污染；
- **skill 目录动态刷新**：`docs/subsystems/skills.zh.md#L233`——skill 定义变化时通过 `agent.inject()` 追加新 catalog 的完整替换。

**这是 dsh 版 CLAUDE.md 自更新**：不写文件、直接注入 context，天然支持运行时更新。

#### 3.2 **第二层：`todo/write` 显式记忆事件**

来源：`docs/persistence-catalog.md#L713`、`docs/tool-catalog.md#L39`

```ts
// LLM 通过 tool_use 调用 todo_write
{
  "todos": [
    { "id": "1", "content": "先读 config", "status": "completed" },
    { "id": "2", "content": "改 tool schema", "status": "in_progress" },
    { "id": "3", "content": "跑测试", "status": "pending" }
  ]
}
```

对应：**session 事件类型 `todo/write`**，作为一等公民持久化。UI 渲染为 checklist。

自进化价值：
- **模型显式追踪自己的进度**——不是隐藏在 context 里的推理，而是结构化 state；
- **崩溃恢复后能续跑**——`session.replay()` 恢复 todo 状态，模型继续从 in_progress 那步做起；
- **反循环**：模型看到自己已经在同一个 todo 卡了 5 轮，会自动切策略（dsh 的 `agent/pre-step` hook 可挂 detector）。

对比：Claude Code 的 `TodoWrite` 工具类似但不进持久化事件流，只是内存 state。

#### 3.3 **第三层（最激进）：动态 Cordis Plugin——agent 给自己写代码装能力**

来源：`docs/tool-catalog.zh.md#L23`、`packages/extensions/tool-cordis`、`examples/acp-agent/tests/snapshots/advanced-toolchain/`

这是 dsh 的**杀手锏**。工具族：

| 工具 | 作用 |
|---|---|
| `cordis_define` | 让 agent 定义一个新的 Cordis Plugin（写 TypeScript 源码） |
| `cordis_run` | 激活这个 Plugin（mode: run / update） |
| `cordis_stop` | 停止 |
| `cordis_undefine` | 卸载 |
| `cordis_inspect_self` | **agent 自省**——读取自己已装的 Plugins、源码、诊断信息 |
| `cordis_inspect_list` / `_query` | 探索可用 Provider / Service / Event / Slot / Theme |

**工作流**（源自 `system-prompt.expected.md#L69`）：

```
1. Call cordis_inspect_self(pluginId, packageId) to read the target source.
2. Call cordis_define(...) with corrected TypeScript to define a new immutable Package.
3. Call cordis_run(pluginId, packageId, 'update') to activate.
4. If technical failure: cordis_inspect_self reads diagnostics, correct the same Plugin, retry autonomously.
5. If user rejection: do NOT request approval again.
```

**关键设计**：
- **Package 是 immutable**——每次修改产生新 packageId，旧的保留（可回滚）；
- **currentPackageId 版本指针**——`cordis_run` 成功才更新，失败保留旧 current；
- **技术失败 vs 用户拒绝**：技术失败**自主重试**，用户拒绝**永不再问**（这条规则直接写在 system prompt 里，防止 agent 死缠烂打）；
- **审批双通道**：Client Package 需用户审批（浏览器弹窗），Host Package 直接运行——分级信任。

**实际用例**（`examples/acp-agent/tests/snapshots/advanced-toolchain/session.jsonl`）：

agent 一次会话中定义了一个动态 Plugin，运行、自省、修正——完整闭环在 session 事件流中可见。这个 e2e 测试就是**"agent 给自己长出一个新工具"** 的可复现证据。

**对比 Claude Code / Codex**：完全没有等价能力。它们的工具集编译期固定，MCP 也只能在启动前配置，不能运行时 agent 主动"我需要一个新工具，我自己写"。

---

### 四、self-correct 反馈闭环

来源：`docs/subsystems/code-runtime.zh.md#L154`

```ts
/** Human-readable detail, suitable for feeding back to a model to self-correct. */
```

dsh 的每个 tool 错误都强制带这个字段——**不是给用户看的 stack trace，是给模型看的自愈线索**。

设计原则：
1. **错误分类**：`user_error`（参数错） / `system_error`（内部错） / `sandbox_error`（权限拒） / `timeout`；
2. **可执行修复建议**：不只说"file not found"，还说"did you mean /src/foo.ts?"；
3. **序列化到事件**：`tool/result` 事件里带完整错误详情，模型下一步能看到；
4. **禁止无声失败**：所有失败必须 append `tool/result.isError=true`，绝不允许工具静默返回错误结果。

自愈流程：
```
step N:  tool_call → error → tool/result (with self-correct hint)
step N+1: model reads hint → decides new strategy → new tool_call
```

这就是**运行时自进化**——不改代码、不加插件，通过错误反馈让模型学会绕过。

---

### 五、四家自进化能力对比矩阵

| 能力 | Codex | Claude Code | **dsh** | tcum-ai |
|---|---|---|---|---|
| 静态记忆文件 | ✅ AGENTS.md | ✅ CLAUDE.md | ✅ AGENTS.md（不同语义） | ? |
| 运行时上下文注入 | ❌ | 部分（`/compact` propose） | ✅ `agent.inject()` | ? |
| 显式进度记忆事件 | ❌ | 部分（TodoWrite 内存） | ✅ `todo/write` 持久化事件 | ? |
| 记忆迁移（对话 → 文件） | ❌ | ✅ `/compact` propose 更新 | 通过 skill 系统 + settings 服务 | ? |
| Skill / Plugin 运行时热挂载 | ❌ | ❌（MCP 启动期） | ✅ Cordis 热插拔 | ? |
| **Agent 主动定义新工具** | ❌ | ❌ | ✅ **`cordis_define` + `cordis_run`** | ❌ |
| Agent 自省已装能力 | ❌ | 部分（`/status`） | ✅ `cordis_inspect_self` | ? |
| 失败诊断 → 自愈重试 | 隐式 | 隐式 | ✅ **显式约束在 system prompt + 事件里** | ? |
| 用户拒绝后停止申请 | ❌ | ❌ | ✅ 系统级规则 | ? |
| 事故复盘 → 防护固化 | 无公开 | 无公开 | ✅ `docs/postmortem/` + AGENTS.md 规则 | ? |

---

### 六、Agent 自进化的**深层追问**（5 层套娃）

**E1**：Claude Code 的 CLAUDE.md 自更新有什么坑？
- 强答：**污染 KV cache**（改完清零）、**版本冲突**（用户手动改 vs 模型 propose 改）、**过时不检测**（工具链换了 CLAUDE.md 不知道）、**优先级模糊**（project vs user 冲突时行为不定）。

**E2**：dsh 让 agent 自己定义 plugin，安全性怎么保证？会不会被 prompt injection 骗着装恶意插件？
- 强答：**四道防线**：
  1. **审批分级**：Client Package 强制用户审批（浏览器 UI 确认代码），Host Package 走 sandbox；
  2. **代码沙箱**：Package 跑在 landlock/bubblewrap 沙箱里（`scripts/prepare-ci-bubblewrap.sh`）；
  3. **immutable + 版本指针**：新 Package 不覆盖旧的，回滚可行；
  4. **系统 prompt 强约束**：`用户拒绝后不要再次申请审批`——直接钉在工具描述里，dsh 通过 CI 校验 tool-catalog 里这句话必须存在。

**E3**：动态 plugin 挂载会不会破坏 KV cache？每次 agent 加个工具 system prompt 就变？
- 强答：**会**——这就是 dsh 的架构 trade-off。缓解：
  - **increment 只加 append**：新 tool 按字典序插入末尾时，前面字节不变；插入中间则塌陷；
  - **checkpoint 隔离**：一次 Cordis plugin 更新对应一个新的 KV cache checkpoint，之后重新积累；
  - **观测**：`cacheReadTokens` 命中率断层能立刻发现是哪次 plugin 挂载导致，从而做取舍。

**E4**：agent 反复定义错误的 plugin，会不会陷入死循环？
- 强答：**多层熔断**：
  1. **`cordis_inspect_self` 强制自省**——system prompt 里明确要求失败后必须先自省再重试；
  2. **`max_steps` 硬限**——步数超上限强停；
  3. **cost 预算**——单 turn token 超预算 escalate；
  4. **用户拒绝一次不再问**——系统级规则，防止对同一失败反复申请审批。

**E5**：postmortem 事故复盘怎么反哺到 agent 行为里？
- 强答：dsh 有独立的 [`docs/postmortem/`](/Users/yaao/Documents/code/AI-agent/deepseek-harness/docs/postmortem/) 目录，每个事故：
  1. 记录**根因**（不是表象）；
  2. 建立**防护措施**（tests、AGENTS.md 规则、ADR）；
  3. AGENTS.md 更新后**所有 agent 下次启动自动读到**——这是团队级的自进化循环；
  4. 例如 [postmortem-0002](/Users/yaao/Documents/code/AI-agent/deepseek-harness/docs/postmortem/0002-js-expression-disabled-filesystem-tools.zh.md)：`!!js` 表达式踩坑 → AGENTS.md 加规则 → CI lint 强制 → 所有 agent 下次装 plugin 自动避开。
  这是**人 + agent 协作的自进化**，比纯 agent 自更新更可靠。

---

## 七、给 tcum-ai 的自进化落地路线图

按性价比排序（每步都是独立可交付）：

**Sprint 1（1-2 周）**：静态记忆文件
- 实现 `TCUM.md` / `AGENTS.md` 加载（对齐 Claude Code / Codex）；
- 优先级：project > user > default；
- KV cache 友好：放 system prompt 稳定段末尾。

**Sprint 2（2-3 周）**：`inject()` 动态上下文
- 在 session 事件流里加 `context/injected` 事件类型；
- 提供 `agent.inject({ content, source })` API；
- 用途：file watcher、子目录 memory 触发加载、skill 目录刷新。

**Sprint 3（3-4 周）**：`todo/write` 持久化进度记忆
- 加 `todo_write` 工具 + 事件类型；
- UI 渲染为 checklist；
- 崩溃恢复能续跑。

**Sprint 4（4-6 周）**：self-correct 反馈闭环
- 所有工具 `error` 结构标准化：`{ code, detail, hint }`；
- `hint` 字段强制存在，写成"给模型看的自愈线索"；
- CI 校验每个新工具的错误格式。

**Sprint 5（可选，激进）**：动态 plugin
- 只有 tcum-ai 走"平台化"路径时才做；
- 参考 dsh 的 `tool-cordis`，需先落地插件系统（Cordis 或自研）；
- 沙箱、审批、immutable 版本指针缺一不可。

---

## 结语

上述 4 条追问链共 30+ 层深挖，加上自进化专题的 3 层能力矩阵和 5 层追问，覆盖 AI Agent 面试可能遇到的所有硬核追问。**每一层都基于 dsh 源码可验证**，你答不出下一层没关系——记住"下一层锤爆上一层"的模式，面试时主动展开 2-3 层，会显得深度远超候选人平均水平。

**核心记忆点**（一句话记住）：
- KV Cache：**前缀字节稳定 = 架构级不变量**；
- 上下文管理：**摘要 + 剪枝 + 分层记忆，永不滑窗**；
- 一切皆插件：**Cordis fiber tree + 4 种事件分发 + inject 声明依赖**；
- 长程可靠性：**Event Sourcing，进程 = 事件日志的纯函数**；
- 自进化：**agent.inject → todo/write → cordis_define，从注入到进度到写代码**。
