# 通用 Agent 面试深度专题

> **本卷定位**：跨家（Claude Code / dsh / Codex / tcum-ai）对照的通用 Agent 面试题库，聚焦"深度追问"和"跨项目对照"两个维度，作为项目题库（[07-面试题库-tcum-ai项目30问.md](./07-面试题库-tcum-ai项目30问.md)）的**通用视角补充**。
>
> **和 [07](./07-面试题库-tcum-ai项目30问.md) 的关系**：
> - **07 · 项目视角** = 用 tcum-ai 的代码事实回答 30 个具体问题
> - **08 · 通用视角**（本卷）= 跨家对照 + 套娃追问 + 自进化专题，回答"通用 Agent 该怎么做"
> - 面试时先用 07 立项目锚点，再用 08 展现"我知道行业其他人怎么做，也知道我们的取舍"
>
> **合并说明**：本文件由 `13-KV-Cache优化与AI-Agent通用问题50问.md` + `14-套娃追问与Agent自进化专题.md` 合并而成。
>
> **章节结构**：
> 1. **KV Cache 命中率**：四家做法对照 + tcum-ai 落地建议（原 13 第一部分）
> 2. **通用 Agent 50 问**：十大主题（原 13 第二部分）
> 3. **四条套娃追问链**：A/B/C/D 四条深挖链（原 14 第一部分）
> 4. **Agent 自进化专题**：CLAUDE.md / AGENTS.md / Cordis Plugin 三家对照（原 14 第二部分）
> 5. **Harness 设计哲学**：模型进步会吃掉什么，运行时应保留什么
> 6. **tcum-ai 自进化落地路线图**（合并 13/14 尾部收敛）

---

## 📑 目录

> 本卷是通用视角的深度专题：跨家（Claude Code / dsh / Codex / tcum-ai）对照，分三大部分 + 附加深度追问。

**第一部分 · KV Cache 命中率：四家做法对照**
- 0. 概念先厘清
- 1. deepseek-harness：把"前缀稳定"上升为架构级不变量
- 2. Claude Code（推测，Anthropic 未开源核心）
- 3. Codex（推测 + 部分公开）
- 4. 四家对比汇总
- 5. tcum-ai 落地建议（成本-收益排序）

**第二部分 · 通用 Agent 面试 50 问（十大主题）**
- 一、循环与调度（Q1–Q6）
- 二、上下文管理 & Compaction（Q7–Q13）
- 三、工具体系（Q14–Q19）
- 四、Prompt 工程与前缀稳定（Q20–Q23）
- 五、多 Agent 与长程任务（Q24–Q28）
- 六、可靠性与失败处理（Q29–Q34）
- 七、可观测性与评测（Q35–Q40）
- 八、知识与记忆（Q41–Q44）
- 九、安全与权限（Q45–Q47）
- 十、扩展性与架构（Q48–Q50+）
- 附加 · 深度追问（Q51–Q55）
- 附加 · dsh 源码核验后新增（Q56–Q60）

**第三部分 · 四条套娃追问链 & Agent 自进化专题**
- 第一部分 · 四条套娃追问链
  - 链 A · KV Cache 的追问（8 层）
  - 链 B · 上下文管理与 Compaction 的追问（7 层）
  - 链 C · "一切皆插件" 的追问（8 层，dsh 核心）
  - 链 D · 长程任务可靠性追问（7 层）
- 第二部分 · Agent 自进化专题
  - 一、Claude Code 的 CLAUDE.md 自更新机制
  - 二、Codex 的 AGENTS.md（对照）
  - 三、dsh 的自进化：三层能力
  - 四、self-correct 反馈闭环
  - 五、四家自进化能力对比矩阵
  - 六、Agent 自进化的深层追问（5 层套娃）
- 七、设计理念：模型进步会吃掉什么，Harness 应保留什么
- 八、给 tcum-ai 的自进化落地路线图
- 结语

---

# 第一部分 · KV Cache 命中率：四家做法对照


### 0. 概念先厘清

**KV Cache（Prompt Cache / Prefix Cache）是 provider 侧能力**：模型服务器把已处理 token 前缀的 attention KV 缓存下来，下次请求前缀字节完全相同则直接复用，只对增量做 prefill。

| Provider | 触发方式 | 计量字段 | 计费 |
|---|---|---|---|
| OpenAI (gpt-4o / o1 / o3) | 全自动，前缀 ≥ 1024 token，5–10 min TTL | `usage.prompt_tokens_details.cached_tokens` | 命中 0.5× |
| Anthropic (Claude) | **手动** `cache_control: { type: 'ephemeral' }`，5 min TTL | `cache_creation_input_tokens` / `cache_read_input_tokens` | write 1.25×，read 0.1× |
| DeepSeek | 全自动，硬盘 KV cache | `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` | 命中 0.1× |
| Google Gemini | 显式 `cachedContents` API | 独立 API | 独立 |

**客户端能做的努力，本质三件事**：
1. 让请求前缀**字节稳定**（不能每次抖几个 token）；
2. 让能变化的东西**尽可能靠后**；
3. 对 Anthropic 类手动型 provider，正确打断点。

---

### 1. deepseek-harness：把"前缀稳定"上升为架构级不变量

dsh 没有一个叫 "prompt cache" 的插件——**整个架构围绕 prefix-cache-friendly 设计**。至少 10 层机制：

#### 1.1 `request/header` epoch 事件（源码可验证）

`packages/core/agent-loop/src/agent.ts` `buildRequest()`：

```ts
const header = canonicalHeader({ config, ...system ? { system } : {}, ...tools.length > 0 ? { tools } : {} })
const baseline = this.session.requestHeader()
if (!this.requestHeaderLogged) {
  this.session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'resume' })
} else if (baseline === undefined || !headerEquals(baseline, header)) {
  this.session.append('request/header', { header, reason: 'change' })   // 只有变化才写
}
```

意义：一个 turn 内多个 step，只要 header 不变，前缀字节序列完全一致——**这是最直接的 KV cache 保障**。

#### 1.2 `canonicalHeader()` 规范化

`docs/subsystems/session.zh.md`：
> 系统提示词和工具列表都表示为**字段缺失**（不是空串、不是空数组），与请求构建方式一致

杜绝"语义等价但字节不同"（空数组 vs 缺失字段序列化结果不同 → 前缀命中断裂）。

#### 1.3 `deepFreeze` + `markAgentLoopRequest`

请求发出前 `deepFreeze` 冻住整个对象——中间件、拦截器、adapter **任何位置都不能就地改字段**。想改必须走新 waterfall 产生新 header 事件。

#### 1.4 工具顺序稳定化：`toolOrder` + 默认字典序

`packages/core/tools/src/ts-types.ts`：
```
* Deterministic — tools are emitted in lexicographic name order
```

`packages/core/tools/README.md`：
> Deterministic — lexicographic tool order, byte-identical text for an **unchanged tool set (prefix-cache-friendly)**

- 插件注册顺序**不影响**最终 prompt/tool-spec 顺序；
- 默认 `name` 字典序；
- 用户可用 `systemPrompt.toolOrder` 显式钉死（必须含 `<unlisted-tools>` rest 占位符）。

**重要性**：工具描述在 system prompt 里常常几千 token，顺序抖动 → 从抖动位置起前缀全部命中失败。

#### 1.5 Code Mode：把工具描述从 system prompt 摘出来

`packages/core/tools/tests/code-mode.spec.ts`：工具编译成 TS/Python 类型定义放进 system prompt——**system prompt 是最容易命中缓存的一段**。

#### 1.6 `deriveMessages()` 纯投影

`session.zh.md`：
> 每个会话请求都是日志的**纯函数**

同一份 append-only 事件日志永远产出同一份消息数组——不因时间戳、重连、临时状态抖动。

#### 1.7 Compaction 三件套

- `packages/compaction/compaction` (npm: `@deepseek-ai/dsh-compaction`)：核心 API + `CompactionEngine` 抽象；`CompactionTrigger = 'pressure' | 'context-overflow'`（两种触发）；导出 `compactCheckpointSource` 显式声明压缩边界；
- `packages/compaction/compaction-basic` (`@deepseek-ai/dsh-compaction-basic`)：`BasicCompactionEngine` 实现——挂 `agent/pre-step`（压力检测）+ `agent/request-error`（overflow 恢复）；
- `packages/compaction/compaction-tool-result-pruner`：工具结果剪枝；
- `packages/compaction/command-compact`：`/compact` 用户命令入口（`ManualCompactionError.code = 'busy'|'cancelled'|...`）。

关键点：**checkpoint** 概念——只在必要时 compact，一 compact 就产生新 checkpoint，后续从新点重新积累缓存。`tool-result-pruner` 只剪工具结果（尾部），不动 assistant 推理文本（前缀）。

#### 1.8 Provider 计量层观测

`packages/llm/token-meter/src/usage-projection.ts` 把 `cacheReadTokens` / `cacheWriteTokens` 作为**一等字段**存进 usage 投影。
`packages/llm/llm-deepseek`：`cacheReadTokens` ← `prompt_cache_hit_tokens`。

**没有观测的策略是盲的**。

#### 1.9 `cacheRetention` 配置

`packages/llm/llm-pi-ai/src/config.ts:129`：
```ts
/** Prompt-cache retention preference. */
cacheRetention?: CacheRetention
```

暴露给上层的 provider-neutral 配置口子，用于控制对 Anthropic 类 provider 打显式 breakpoint。

#### 1.10 CI 强制：每个 package 的 README 必须声明 `#### KV Cache effect`

`scripts/verify-package-readme-model-experience.ts` line 17-18 强制校验。

**这是把 KV cache 提升到贡献者纪律层面**：不能偷偷加"每轮把当前时间戳塞进 system prompt"的插件。

---

### 2. Claude Code（推测，Anthropic 未开源核心）

依据：Anthropic 公开 API 文档、SDK 行为、AWS Bedrock 参考、社区抓包分析。

#### 2.1 显式 `cache_control` 断点

Anthropic 允许最多 4 个 breakpoint，Claude Code 大概率打在：
1. system prompt 末尾；
2. tools 数组末尾；
3. 最近一次 tool_result 之前；
4. user turn 开头（滚动断点）。

#### 2.2 5 分钟 TTL

Anthropic ephemeral cache TTL=5min。长时间不操作后首个请求明显更慢——推测无心跳保活，接受过期。

#### 2.3 工具集编译期固定

内置工具集 Read/Write/Edit/Bash/Grep 等运行时不动态增删——天然字节稳定。MCP 工具则依赖用户端实现。

#### 2.4 `/compact` 手动压缩

明确告知用户会"损失 KV cache 命中"，让用户权衡。

#### 2.5 局限

`<system-reminder>` 塞 CWD/git status/已改文件——若在 breakpoint 前会破坏缓存。Anthropic 官方推荐放 message 内层且在 breakpoint 后。

---

### 3. Codex（2026-08-26 本地官方开源 Harness 已可验证；云端策略仍有边界）

OpenAI 家、可使用 Responses API / Chat Completions；云端 prompt-cache 的具体命中/TTL 不应由本地仓库反推。当前 `openai/codex` 开源 runtime 已能直接验证其客户端侧的上下文状态、compact、AGENTS.md、Skill/MCP/Hook 与事件历史机制。

#### 3.1 Responses API 的 `previous_response_id`

```
POST /v1/responses
{ "previous_response_id": "resp_xxx", "input": [{ new user turn only }] }
```

服务端接续上下文可以避免客户端重发完整历史，但并不消除模型窗口与前缀稳定问题；Codex 还维护本地 Thread/Turn/Item history，不能只用这个 API 描述整个运行时。

#### 3.2 System prompt 稳定化

`AGENTS.md` 按根目录到当前目录分层发现并装配；同时 runtime 使用带 kind/marker 的 contextual fragments。动态信息究竟在不同产品表面/模型请求中的精确摆放需以抓包或协议实现为准，不再写“推测塞进 message”。

#### 3.3 Function calling 定义稳定

内置工具、MCP、Skill、Hook、Plugin 分层管理；稳定 schema 仍是 cache-friendly 原则，但不能把 JSON 序列化顺序当成 Codex 的完整工具稳定性策略。

#### 3.4 局限

- 云端缓存阈值、TTL 和具体命中率属于服务端行为，应从官方 API 文档/实际 usage 核验；
- 客户端并非没有预算能力：`context_window.rs` 跟踪 active context、auto-compact scope、hard cap、剩余预算与 fallback buffer；
- 可公开验证的是本地 compact / token-budget 控制；云端最终摘要策略仍未知。

---

### 4. 四家对比汇总

| 维度 | Codex | Claude Code | **deepseek-harness** | tcum-ai (待补) |
|---|---|---|---|---|
| provider cache | OpenAI 自动 | Anthropic 手动 | 多 provider（DeepSeek 自动主打） | ? |
| 显式打断点 | 不需要 | 4 个 ephemeral | `cacheRetention` 由 adapter 决定 | ? |
| 前缀稳定保证 | `AGENTS.md` 分层 + typed context；是否命中云端缓存须实际核验 | 工具集编译期固定 | **架构级**：epoch header + canonical + deepFreeze + 字典序 + 事件重放 | 缺失 |
| 命中率可观测 | 有 usage/Thread 事件；云端 cache 指标暴露依产品/API 而定 | 有 usage 字段 | **一等公民**：`cacheReadTokens`/`cacheWriteTokens` 进投影 | 缺失 |
| Compaction | 本地有 token budget 与 compact 控制；云端摘要细节未知 | `/compact` 手动 | 三件套（压力检测 + 剪枝 + checkpoint） | ? |
| 贡献者纪律 | N/A | N/A | **README 强制声明 `KV Cache effect`**，CI 校验 | N/A |
| 可扩展性 | Skill / MCP / Hook / Plugin / App Server；内核更受控 | 内置 | 每层可替换插件 | ? |
| 公开可验证 | 本地 Harness 源码可验证，模型/云端策略不可见 | 部分 | 全部源码 | 内部 |

---

### 5. tcum-ai 落地建议（成本-收益排序）

1. **canonical request header + 仅变化时 append**——工作量小，避免语义等价但字节抖动；
2. **tool schema 字典序排序 / 显式 toolOrder**——一行 `sort`，可能把 tools 段命中率从 0 拉到 100%；
3. **usage 里加 `cacheReadTokens` 计量**——先能看到才能改；
4. **compaction checkpoint 机制**——比"简单滑窗"难得多，但对长会话是决定性的。参考 `packages/compaction/compaction`（核心）+ `packages/compaction/compaction-basic`（默认实现）+ `packages/compaction/command-compact`（用户命令）。

---


---

# 第二部分 · 通用 Agent 面试 50 问（十大主题）

> **答题原则**：每题先给通用解法（跨家共识），再补tcum-ai 变体（我们怎么做的，看 [07](./07-面试题库-tcum-ai项目30问.md) 具体 Q）。**面试时优先讲通用解法立框架，再切项目细节立可信度**。


> 每题给出**四家对比 + 优缺点视角**（有些问题不适合的家会省略），标注 `[源码可验证]` 或 `[推测]`。tcum-ai 部分默认按目前你项目里已实现的机制填，若未实现则标 "缺失/待补"。

### 一、循环与调度（Q1–Q6）

**Q1. Agent Loop 的核心状态机是什么？turn / step / tool_call 三层如何区分？**
- dsh：**三层事件型状态机**（`packages/core/agent-loop/src/agent.ts` 的 `ReactLoopAgent`）：
  - **turn**：一次用户输入到 assistant 完成，开头 `turn/start`、结尾 `turn/end{reason}`；
  - **step**：一次 LLM 调用 + 它请求的工具执行一轮，开头 `step/start`、结尾 `step/end`；`StepEndReason` 只有 `'completed' | 'max-tokens'` 两种（其他异常都浮到 turn 层）；
  - **tool_call**：`tool/call` + `tool/result` 成对事件，同一 `callId` 配对；
  - 一个 turn 包含 N 个 step，一个 step 包含 M 个 tool_call。内部 `Phase` 状态机五种：`idle / stepping / maintenance / aborting / disposed`。`[源码可验证]`
- Claude Code：类似三层，但内部无独立 turn/step 概念暴露；一个 message 内可嵌多个 tool_use block。`[推测]`
- Codex：Responses API 每个 response 一个 step，多个 response 一个 turn。`[推测]`
- tcum-ai：靠 eino ADK 的 ReAct 内部循环（`MaxIteration` 控制上限），**无显式 turn/step 事件类型**，只有消息流水——这是可观测性的主要短板（想知道"这个循环现在到第几轮"只能数 assistant 消息）。

**Q2. 停止条件（TurnEndReason）怎么设计？**
- dsh：显式枚举 `TurnEndReasonMap`（`packages/core/session/src/types.ts:155`）：**`completed / aborted / blocked / error / max-tokens / interrupted`** 6 种（`aborted` 携带 `TurnEndCancelCause`；`error` 携带结构化 `LlmFailure`；`interrupted` 仅在持久化 backend 从 crash 恢复时由后端追认）。事件日志里明确记录，且 map 是**声明合并可扩展**的——插件可注入新的结束原因。`[源码可验证]`
- 其他家一般用 `finish_reason` + 内部超限判断，缺乏统一枚举。

**Q3. 并发 tool call 怎么调度？串行 vs 并行？**
- Claude Code：允许一次 assistant message 返回多个 tool_use，客户端并行执行、并行 return（Anthropic 官方推荐）。
- Codex：Responses API 支持并行 function calls。
- dsh：**分类并发 + 有界内存池**（`packages/core/agent-loop/src/tool-calls.ts` 的 `executeToolCalls`）：每个工具声明 `executionMode` 为 `parallel | exclusive`；默认并发上限 `DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10`（`constants.ts`）；遇到 exclusive 工具（如文件写）**自动切回串行**（"exclusive barrier"），上一波并发完后才启动 exclusive。`Promise.allSettled` 确保任一失败不影响同批其他工具。`[源码可验证]`
- tcum-ai：eino ADK 双路径（并发 vs `ExecuteSequentially`），实际全部 Agent 走并发路径（`ExecuteSequentially` 从未设置）；并发时若部分工具抛 `InterruptRerunError`，**已跑完的结果存入 `ExecutedTools[callID]`** 再合成 `CompositeInterrupt` 抛出，下次 resume 可复用。但 `CheckPointStore` 未配置，断点续跑能力未启用。

**Q4. Cancel / Interrupt 怎么优雅传播？**
- dsh：`AbortSignal` 全链路穿透，`Agent.cancel(cause, options)`（`packages/core/agent-loop/src/agent.ts:134`）触发；用户 ESC 走这条路径，`turn/end` 事件 `reason.kind='aborted'` 携带 `TurnEndCancelCause`（不是 `user_cancel`）。`options.keepInbox` 可控制是否保留排队消息。
- Claude Code：ESC 中断，工具执行会打断但已发出的 LLM 请求需等 stream close。
- Codex：类似。
- 难点：中断后**部分执行完的工具结果如何持久化**——dsh 依然会 append `tool/result`，保证日志完整；有些实现会丢弃导致会话不可恢复。

**Q5. Retry / Backoff 策略：哪一层做？**
- dsh：`packages/llm/llm-retry` 独立包，挂在 `agent/request-error` 扩展点，与 agent-loop 解耦。策略：**指数退避 + jitter**（`localDelay = min(initialDelayMs * 2^exponent, maxDelayMs)`，`jitter = 1 - jitterRatio + 2*jitterRatio*random()`）；policy 写在**每个 provider 配置**里（`retryPolicy` 属于 provider、不属于 retry 包），方便按 provider 差异化调优。每次 retry 在 cancellable wait 前先 append `llm-retry/started` 事件（durable，崩溃后能看到）。`[源码可验证：packages/llm/llm-retry/src/index.ts]`
- Codex/Claude Code：内嵌 SDK，不能单独换 policy。
- 优点对比：解耦利于按 provider 调 policy（DeepSeek 卡顿 vs OpenAI 429）；durable 预申告能避免崩溃重启后"告诉模型重试了"的信息丢失。

**Q6. Max steps / Max tokens 触顶后如何处理？**
- dsh：`TurnEndReason` 有 `max-tokens`（output-token 触顶）+ `aborted`（cancel）+ `error` 三条通往"未完成"的路径；`step` 数量的硬上限由 agent-loop 内 `constants.ts` 控制、超限则触发 `aborted` 而非专门的 reason。让上层决定是否 escalate。
- Claude Code：`stop_reason=max_turns`。
- 关键设计：**触顶不等于失败**——要能续跑（resume），dsh 通过 `request/header reason:'resume'` 支持。

### 二、上下文管理 & Compaction（Q7–Q13）

**Q7. 上下文窗口打满前如何压缩？滑窗 vs 摘要 vs 剪枝？**
- Claude Code：`/compact` 手动 + auto-compact，让 LLM 生成摘要替换旧消息。**破坏 KV cache**。
- dsh：**四件套**（`packages/compaction/*`）：
  1. `compaction`——导出 `CompactionEngine` 抽象 + `compactCheckpointSource` 声明式边界；`CompactionTrigger = 'pressure' | 'context-overflow'` 两种触发；
  2. `compaction-basic`（`BasicCompactionEngine`）——挂 `agent/pre-step`（压力检测）+ `agent/request-error`（overflow 恢复）；
  3. `compaction-tool-result-pruner`——只剪工具结果尾部（保护前缀 KV cache）；
  4. `command-compact`——`/compact` 用户命令入口。`[源码可验证]`
- Codex：Responses API 服务端接续（`previous_response_id`），客户端 compaction 未知。
- tcum-ai：七层压缩（L0-L6），L3 Summarization + L4 `AdaptiveContextRetry`——参见 [07 Q3](./07-面试题库-tcum-ai项目30问.md)。相对 dsh 缺的是 **checkpoint 术语**（压缩后无声明式边界，KV cache 断点无法从日志重建）。

**Q8. Compaction checkpoint 机制？**
- dsh：checkpoint 是一个 marker 事件，压缩后从这里重新积累前缀缓存。上层监控命中率断层。`[源码可验证]`
- 其他家未见等价概念公开。

**Q9. 长文件 / 大工具输出（比如 grep 10k 行）怎么塞进上下文？**
- Claude Code：`Read` 工具有 offset+limit，默认 2000 行；`Grep` 限制 count 默认 100。
- dsh：`token-meter` 事前评估，超阈值触发 pruner。
- Codex：类似 read limit。
- 底层共识：**永远不让单个工具结果吃掉大半窗口**。

**Q10. 历史消息去重？重复读同一个文件怎么处理？**
- dsh：tool-result-pruner 有去重策略（旧的 file read 可被后来的替代）。`[源码可验证]`
- Claude Code：默认全保留，靠 `/compact` 处理。
- Codex：未知。

**Q11. System prompt 里塞不塞动态信息（CWD / git status / 已改文件）？**
- Claude Code：塞 `<system-reminder>` 但在 message 层（推测在 cache breakpoint 后）。
- Codex：推测同上。
- dsh：`request/header` 里的 system 保持稳定，动态信息走 `steering/message` 事件而非 system。**这是最 KV-cache-friendly 的做法**。`[源码可验证]`
- 权衡：塞 system 简单粗暴但破坏缓存；单独通道复杂但缓存友好。

**Q12. Persona / 系统人设与工具指令的编排顺序？**
- 通行做法：`[persona] → [tools] → [runtime instructions]` 从最稳定到最易变；
- dsh：`system-prompt` 包按此分层，`toolOrder` 显式钉死顺序。

**Q13. Sub-agent 的上下文继承 vs 隔离？**
- Claude Code Task：**新起独立 context**，只回传 final result。优点隔离清晰，缺点父 agent 看不见细节。
- dsh：**同一套 subagent 抽象，多种 backend**（`packages/subagent/*`）：`subagent-fork-in-process`（继承父会话）/`subagent-spawn-in-process`（干净起）/`subagent-acp`（跨进程 ACP 协议）/`subagent-claude-code`/`subagent-codex`/`subagent-dsh-sdk`——**同一个 `SubagentProvider` 接口**，容器化调度。fork 版继承有个精细边界：**seed 到最后一个 `turn/end`**（"the current tool-call turn is unbalanced and cannot be replayed as a valid child session"），避免用 in-flight turn 污染子会话。`[源码可验证：packages/subagent/subagent-fork-in-process/src/index.ts]`
- Codex：**旧口径已过时**。本地官方 `openai/codex` 源码（2026-08-26）已有 Multi-Agent V2：区分 root/subagent role instruction、并发槽位、父子消息与任务回传；full-history fork 继承模型/推理配置也有显式边界。默认仍是 `explicit request only`，仅特定高 reasoning 配置允许 proactive 多 Agent，因此不能表述为“默认到处自动拆 agent”。详见 [Codex 源码对读](../05-演进与对比/12-Codex开源Agent源码解构与TCUM-AI对照.md#6-多-agentcodex-已经显式具备协作运行时但不等于所有任务都该拆)。

### 三、工具体系（Q14–Q19）

**Q14. Tool schema 怎么定义？JSON Schema vs TypeScript type vs Function signature？**
- Claude Code / Codex：JSON Schema（OpenAI/Anthropic function calling）。
- dsh：**双模**——JSON Schema 或 Code Mode。Code Mode 是**独立工具 `run_code`**（`packages/core/tools/src/code-mode.ts` 的 `RUN_CODE_NAME='run_code'`），支持 **TypeScript 和 Python 两种语言**（`SDK_RENDERERS` 按 `CodeRuntime.language` 分派，emit 与 SDK 指令语义一致的 flavor）；模型输出一段 TS/Python 代码，`code-runtime` 沙箱执行，`code_dispatch/*` 事件记录每次子工具调用轨迹，只有外层 curated 结果进入模型历史。`[源码可验证]`
- Code Mode 优点：token 更少、更符合模型 code 分布、语义更强（循环/条件/变量复用一次生成执行多个 tool call）；缺点：需要沙箱执行。

**Q15. 工具描述如何做到 prefix-cache-friendly？**
（见 Q11 + KV cache 部分）

**Q16. MCP 工具动态注册 vs 编译期固定？**
- Claude Code：内置固定 + MCP 动态。
- Codex：内置工具之外同时有本地 Skill、Plugin 和 MCP；App Server 对 Skill 根目录、文件变更失效、MCP server 启动状态与扩展 profile 都有运行时协议。工具能力并非只能“改核心再 fork”，但高风险动作仍受权限/审批边界约束。
- dsh：全插件化，MCP tools 走 `packages/core/tools` 注册接口。
- 权衡：动态灵活但字节稳定性差；dsh 通过字典序缓解。

**Q17. 工具执行的沙箱与权限模型？**
- Claude Code：默认 dangerously-skip-permissions 关闭，敏感操作弹权限。
- dsh：**跨平台四包**（`packages/sandbox/*`）：`sandbox`（核心抽象）/`sandbox-local`（Linux/macOS，bubblewrap 底层）/`sandbox-windows-acl`（Windows ACL）/`sandbox-policy`（策略层）。工具在 `packages/tools/*` 各自声明能力，`ToolExecutionMode`（`packages/core/tools/src/index.ts:344`）区分 parallel / exclusive。`[源码可验证]`
- Codex：本地执行，权限模型依赖用户信任 + `approval_policy` 四档。

**Q18. 工具失败的错误传给模型 vs 直接抛给用户？**
- 通行做法：结构化错误传回模型（让它自愈），仅致命错误抛用户；
- dsh：`tool/result` 事件带 `error` 字段，模型能看到 stderr。`[源码可验证]`

**Q19. Streaming tool output 支持吗？**
- Claude Code：不支持（tool_use 是一整块 return）；
- dsh：`assistant/chunk` 支持流式；tool 结果本身还是一次性 return，但工具**内部**可以流式打印到 UI；
- Codex：类似。

### 四、Prompt 工程与前缀稳定（Q20–Q23）

**Q20. 让 LLM 输出结构化数据（工具参数）的技巧？**
- Anthropic：tool_use block（JSON schema 校验）；
- OpenAI：function calling / structured output；
- dsh：双模——Code Mode 直接让模型输出 TS 代码由解释器执行，避免 JSON escape 问题。

**Q21. Prompt 里的 few-shot examples 放哪层？**
- 稳定 examples → system prompt 内；
- 会变的 examples → user 或 message 层。
- 目的：保护 system 段 KV cache。

**Q22. Temperature / top_p 对 agent 场景的选择？**
- 工具调用一般 T=0；
- 创造性写作 T 高；
- dsh：`config` 里逐 provider 配置，defaults 由 adapter 提供。

**Q23. 如何 A/B 两个 system prompt 而不污染 KV cache？**
- 分流量到不同 route，每个 route 独立缓存池；
- dsh：`request/header` 里的 config 变化会触发 `reason:'change'`，日志能明确回溯是哪次 A/B 影响了指标。

### 五、多 Agent 与长程任务（Q24–Q28）

**Q24. Orchestrator-Worker vs Peer-to-Peer 多 agent 架构？**
- Claude Code Task：Orchestrator 模式（主 agent 派单 sub agent）；
- Codex：单 Agent 仍是常态，但当前开源 runtime 已有 Multi-Agent V2；其 Thread/Turn/Item 也可由本地 thread store 持久化、resume/fork/replay，不能再简化成“只有 Responses API 状态服务器”。
- dsh：**统一 subagent 抽象 + 7 种 backend**（`packages/subagent/*`）：`subagent` 定义 `SubagentProvider` 接口；backend 有 `subagent-fork-in-process`（fork 父会话）/`subagent-spawn-in-process`（干净起）/`subagent-acp`（跨进程 ACP 协议）/`subagent-claude-code`（把 CC 当 subagent）/`subagent-codex`（把 Codex 当 subagent）/`subagent-dsh-sdk`；工具侧有 `tool-subagent` + `tool-subagent-control` + `tool-subagent-report`。**能把外部 agent 当 subagent 用**是 dsh 独门。属于 Orchestrator 但插件可换 backend。`[源码可验证]`
- 学术界：AutoGen 支持 Peer-to-Peer。
- 权衡：Orchestrator 好控好观测；Peer-to-Peer 灵活但难调试。

**Q25. 长程任务（跑几小时）如何保证不丢状态？**
- dsh：**Session 是 append-only event log**，进程崩重启后能 100% 重放；另外有 **Goal 域**（`packages/goal/*` 四个包：`goal` 事件溯源 + CAS 变更、`goal-round-driver` 分轮调度、`tool-goal`、`command-goal`）专门追踪长程任务的分解与阻塞——**这才是 dsh 真正的长程任务原语**，不是单纯靠 session 恢复。`[源码可验证]`
- Claude Code：`.claude/` 目录持久化，`--resume`；
- Codex：既可与上游 Responses API 交互，也有本地 Thread/Turn/Item、rollout 与 thread-store；App Server 提供 `thread/resume`/`thread/fork`，持久化边界由客户端/运行环境配置决定。
- 核心 pattern：**Event Sourcing**——所有状态是事件日志的纯函数。

**Q26. Checkpoint / Resume 怎么实现？**
- dsh：**双层持久化**——`packages/core/session` 定义事件模型；`packages/session/session-persistence` 是可替换 seam，默认 backend `session-persistence-jsonl`（append-only + Zstd 压缩），可切 `session-persistence-sqlite`；`session-checkpoint-policy` 定义每次 request 的 durability checkpoint 时机；重启后按 `request/header reason:'resume'` 事件明确标记恢复边界，任意点续跑。`[源码可验证]`
- Claude Code：`--resume <session-id>` 从 `.claude/projects/*/history.jsonl`。
- Codex：可通过服务端 response 接续，也有本地 `thread/resume`、`thread/fork` 和事件历史；实际选择应按产品表面和存储策略区分，不能把两种机制混成一个 `previous_response_id`。

**Q27. Task 分解粒度：一个 Task 应该多大？**
- Claude Code Task 官方建议：一个 Task 只做一件相对独立的探索（例如"找出所有 error handling 位置"）；
- 实践经验：一个 Task 消耗 20K–100K token，超过就该再分。

**Q28. 多 agent 间信息共享：全量 vs 摘要 vs 结构化事件？**
- Claude Code Task：只回传 final result（摘要）；
- dsh：`session.jsonl` 里 subagent 有独立子事件流，父 agent 通过 `tool/result` 拿到摘要；
- 权衡：摘要省 token 但丢细节，结构化事件适合调试。

### 六、可靠性与失败处理（Q29–Q34）

**Q29. LLM 幻觉调用不存在的工具怎么处理？**
- 通行做法：返回 `unknown tool` 错误让模型自愈；
- dsh：`toolOrder` 里 unknown tool 直接 reject prompt assembly（fail-loud）；`[源码可验证]`
- 权衡：fail-loud 早发现 bug，fail-soft 用户体验好。

**Q30. 工具超时怎么办？**
- dsh：`streamIdleTimeoutMs` / `timeoutMs` 分层（`packages/llm/llm-pi-ai/src/config.ts`）；`[源码可验证]`
- Claude Code：Bash 工具有 timeout 参数（默认 2min，最长 10min）。

**Q31. LLM 429 / 5xx 如何处理？**
- dsh：`llm-retry` 独立 policy，指数退避 + jitter；
- Claude Code / Codex：内嵌 SDK 处理。

**Q32. 模型输出无效 JSON / 参数缺字段怎么办？**
- 通行：schema validate 失败后把错误消息塞回给模型让它重试；
- dsh：`tool/call` 事件带 validation error，模型下一步能看到。

**Q33. 死循环检测：模型反复调同一个失败工具？**
- Claude Code：有反复调用检测（推测），达到阈值提示用户；
- dsh：`agent/pre-step` hook 可挂 detector，`compaction-basic` 就是一个 hook。

**Q34. 灾难场景：LLM API 全站宕机？**
- 通行降级：切换 provider（多路由）；
- dsh：`packages/llm/*` 多 adapter 并存，`config.routes` 可配置备份 route；`[源码可验证]`
- Claude Code / Codex：单一 provider，无备份。

### 七、可观测性与评测（Q35–Q40）

**Q35. Agent 的 metrics 应该采什么？**
- 核心 4 类：token 用量、tool 成功率、turn 时长、error rate；
- dsh：**投影系统**（`SessionProjectionRegistry`，`packages/session/session-projection`）是核心——事件流→派生视图；`token-meter` 注册 `tokenUsageProjection` + `contextPressureProjection` 两个投影；另有 `session-stats` / `session-telemetry` / `session-telemetry-otel`（OTel 直接对接）三个开箱即用 telemetry 包；`session-projection-cache` 做投影快照缓存。`[源码可验证]`
- Claude Code：`/status` 显示，无导出。
- **对 tcum-ai 建议**：直接引 `session-telemetry-otel` 的思路，把 assistant/tool 消息事件做投影后接 OTel。

**Q36. 如何评测 agent 能力？SWE-Bench / TAU-Bench / 自建集？**
- 公开榜：SWE-Bench Verified、TAU-Bench、AgentBench、HumanEval-Agent；
- 自建集要点：**任务可自动判定通过**（不是主观打分）、**沙箱隔离**、**多次运行取 pass@k**；
- 陷阱：Claude Code / Codex 都在 SWE-Bench 上刷分，但真实 workspace 表现差异更大——建议加"多轮追问"、"跨文件 refactor"等真实场景。

**Q37. 单个 turn 的成本怎么算？**
- 公式：`Σ (uncached_input × rate) + (cached × discount) + (output × rate)`；
- dsh：`token-meter` 已把四项 usage 分开投影；
- 落地：结合 provider 定价表出**每 turn 成本**、**每 task 成本**指标。

**Q38. Prompt cache 命中率如何监控？**
- 指标：`cache_read_tokens / (cache_read + uncached_input)`；
- dsh：token-meter 已投影；
- 建议：按 route / model / turn-position 分桶看，找到命中率断层的 root cause。

**Q39. Regression test：改了 system prompt 怎么保证不退化？**
- 通行：录制回放（golden test）；
- dsh：`examples/acp-agent/tests/snapshots/` 里全是 session.jsonl expected 快照，改 prompt 会 diff 出来；`[源码可验证]`
- Claude Code / Codex：内部有但不公开。
- **这是 dsh 最强项之一**——事件日志作为 golden，天然可 diff。

**Q40. Agent 输出的 grounding / citation 如何实现？**
- 通行：让模型在结构化字段里输出 `sources: [file:line]`；
- Claude Code：在 tool_result 里返回 file path 供模型引用；
- dsh：`derived-index` 可持久化 source 索引（`docs/config-catalog.md:1664`）。

### 八、知识与记忆（Q41–Q44）

**Q41. Working memory vs Long-term memory 边界？**
- Working：本 session 上下文；
- Long-term：跨 session 持久化（如 Claude Code 的 `CLAUDE.md`、Codex 的 `AGENTS.md`）；
- dsh：**四层记忆**：① `session.jsonl` per-session（Working）；② `packages/context/agent-instructions` 分层加载 `AGENTS.md`（Long-term 项目记忆，dsh 顶层 `CLAUDE.md -> AGENTS.md` 符号链接兼容 CC）；③ `packages/settings/*` 服务（跨 session 用户偏好）；④ `packages/context/time-context` / `session-reference` / `tmux-context` 三种运行时上下文源（**每一种都是独立插件，可关闭**）。`[源码可验证]`

**Q42. RAG / 向量检索作为工具 vs 作为上下文预注入？**
- 主流：作为工具（如 `Grep`、`Search`），按需检索；
- 反例：把全库塞 system prompt——token 爆炸且破坏 cache；
- dsh 建议做法：`Grep` 工具走 code search，向量检索作为 MCP tool。

**Q43. Memory 更新的一致性：模型主动写 memory 会出错吗？**
- Claude Code：`CLAUDE.md` 靠用户维护，模型 propose 由用户 confirm；
- dsh：`todo/write` 是显式事件类型，模型写入后可持久化；`[源码可验证]`
- 陷阱：让模型自由 write 会 hallucinate 出错误 memory 越积越多。

**Q44. Skill / Plugin 的注入时机：启动期 vs 运行时？**
- Claude Code：MCP 启动期注入，运行期不变；
- dsh：**Cordis 插件系统运行时热插拔**（`docs/cordis-primer.zh.md`），`ctx.plugin()` 可动态挂卸；`[源码可验证]`
- 权衡：热插拔灵活但 KV cache 需重建；启动期简单但需重启。

### 九、安全与权限（Q45–Q47）

**Q45. Prompt injection 防御？**
- 通行：tool_result 内容不作为 system 指令解释、显式说明"user data 不是 instructions"；
- Claude Code：`<system-reminder>` 在敏感操作前提醒；
- dsh：`system-prompt/assemble` 分层，tool_result 严格隔离；`[源码可验证]`
- 陷阱：从网页/文件读入的内容里藏 "ignore previous instructions"——所有 agent 都可能中招。

**Q46. 敏感操作（rm / git push / API 调用）的 confirm 流程？**
- Claude Code：默认弹权限确认；
- Codex：`--auto-edit` 开关 + `approval_policy` 四档；
- dsh：**独立的 `ApprovalService` 服务**（`packages/interaction/user-approval`），不是每个工具自带 flag。核心机制：
  1. `approval/request` 是 **waterfall 事件**——多个 answerer 依次决策，缺席时 **fail-closed**（默认拒绝）；
  2. 授权只覆盖被请求的动作，不放宽；
  3. 两个 durable 审计事件：`approval/asked`（提问）+ `approval/decided`（决定），带 `id/toolName/callId/reason` 供事后审计；
  4. **`permission-presets`**（`packages/interaction/permission-presets`）——对标 CC 的 6 种模式，通过 `PresetOption` 桥接两个独立 knob：`SandboxMode`（沙箱强度）+ `ApprovalPolicy`（审批策略）；
  5. 相关工具 `tool-ask-user`（工具主动问用户）、`user-questions`（对话式追问）。`[源码可验证]`
- 关键：**不要把 confirm 变成用户的按 Enter 操作**（confirmation fatigue）；dsh 的 preset 就是给"两个正交 knob"打成一个用户友好挡位。

**Q47. Secrets 泄漏防御：模型看到 env / .env 怎么办？**
- 通行：工具层 mask（Read `.env` 时替换值为 `***`）；
- Claude Code / dsh：都有 mask 逻辑；
- 陷阱：模型可能通过 `cat` / `echo $VAR` 绕过——沙箱 env 白名单是最终解。

### 十、扩展性与架构（Q48–Q50+）

**Q48. dsh 的"一切皆插件"是怎么实现的？**
- 底层：**Cordis 依赖注入 + 事件总线**（`docs/cordis-primer.zh.md`）；
- 三大要素：
  1. `Context` 树——`ctx.plugin(Plugin, config)` 挂载，`ctx.scope.dispose()` 卸载；
  2. **服务注入**——`ctx.session`、`ctx.tools` 等按名字挂 context 上，插件间通过 context 拿依赖；
  3. **事件 waterfall**——`ctx.bail()`/`ctx.parallel()`/`ctx.serial()` 三种触发模式，插件监听事件动态改行为。
- **这决定了 dsh 每层都能被替换**：换 LLM adapter、换 compaction 策略、换 tool set，都是加/减插件。`[源码可验证]`
- 对比 Claude Code / Codex：内嵌硬编码，加功能靠 fork。

**Q49. 增加一个新 provider（比如 Kimi）需要改哪些地方？**
- dsh：新建 `packages/llm/llm-kimi`，实现 `Provider` 接口（`packages/llm/llm` 定义），自己声明 `retryPolicy`、`cacheRetention`、token 映射（把 Kimi 的 `prompt_cache_hit_tokens` 映射到 `cacheReadTokens`，对标 `llm-deepseek` 里的实现），就完了。**不改任何其他 package**——agent-loop、compaction、llm-retry、token-meter 全部不感知。`[源码可验证：就看 llm-deepseek/llm-pi-ai 的实现模板]`
- Claude Code / Codex：需 fork 源码。

**Q50. Agent 框架的"可持久化"边界在哪？哪些是纯运行时状态？**
- dsh 明确分层（`docs/subsystems/session.zh.md` + `docs/subsystems/persistence.zh.md`）：
  - **持久化**：`session.jsonl` 事件流（`request/header`、`tool/result`、`user/message`、`todo/write`、`approval/asked`、`approval/decided` 等 12+ 事件）；
  - **投影层**（可选持久化）：`SessionProjectionRegistry` 管理的派生视图（tokenUsage / contextPressure / permissions / todos 等），可上 `session-projection-cache` 快照；
  - **派生**：`deriveMessages()` 由事件重放得到，不入库；
  - **纯运行时**：Cordis Context 树、pending stream、AbortSignal、inbox 队列——不入库；
- 好处：**恢复只需 replay 事件**；
- 陷阱：如果工具执行副作用没有事件化（比如某工具改了外部数据库但没写 `tool/result`），resume 会漏。

### 附加 · 深度追问（Q51–Q55）

**Q51. `request/header` 事件的 `reason` 有哪些？各代表什么？**
- 源码定义（`packages/core/session/src/types.ts:228`）：`RequestHeaderReason = 'initial' | 'resume' | 'change'` **只有 3 种**（早期文档流传的 `'fallback'` 是错误的、当前仓库不存在）。
- **initial**：首个 header（新 turn 首次记录）；
- **resume**：从持久化 log 恢复、跨 turn 重启（如崩溃恢复）；
- **change**：header 内容变了（system prompt / tools / config 任一发生 canonical 差异）。
- 意义：**同 turn 内多 step 只要 header 未变就不 append**（`if (baseline === undefined || !headerEquals(baseline, header))`），前缀字节序列稳定 → KV cache 命中最大化。**日志本身能重建整个请求**。`[源码可验证：packages/core/agent-loop/src/agent.ts buildRequest()]`

**Q52. `deriveMessages()` 是纯函数意味着什么？**
- 同一份事件日志 → 同一份 messages 数组，**bit 级一致**；
- 这是 KV cache 稳定性的数学基础；
- 反例：如果 derive 里有 `Date.now()`，缓存立刻塌陷。

**Q53. `TOOL_ORDER_REST` (`<unlisted-tools>`) 为什么必须显式存在？**
- 强制用户思考"新加的 tool 到底在哪里"；
- 避免"某天加了新 tool 突然改变工具顺序"破坏 cache；
- dsh 在 `packages/core/system-prompt/tests/tool-order.spec.ts` 明确 reject 没有 rest entry 的配置。`[源码可验证]`

**Q54. Code Mode vs Function Calling 深度对比？**
- token 消耗：Code Mode 少 20-40%（TS 类型比 JSON Schema 紧凑）；
- 表达力：Code Mode 支持循环、条件、变量复用（一次生成执行多个 tool call）；
- 安全性：Code Mode 需要 TS 解释器沙箱（dsh 用 `run_code` tool）；
- KV 友好度：Code Mode 的 system prompt 更稳定（无 JSON escape 差异）；
- 现状：Claude Code / Codex 还是 function calling 为主，dsh 双模并存。

**Q55. Session log 的 append-only 有哪些坑？**
- 磁盘增长快（一个长 task 几十 MB）——需要 rotation；默认 `session-persistence-jsonl` 用 Zstd 压缩缓解；
- rewind 场景（用户点"回退到第 3 轮"）需要 fork 出新 log 而不是就地删（`packages/subagent/subagent-fork-in-process` 就是这个能力的应用面）；
- dsh 不允许就地修改事件，只能 append 新事件表达"反悔"——**注意架构演进**：早期存在过独立的 `steering/message` 事件类型（`packages/session/session-persistence/src/coordinator.ts` 里以 `legacySteeringType` 命名并仅用于旧 log 兼容读取，写入时会 reject 恶意构造），**当前 steering 直接用 `user/message` 事件 + inbox 队列的 `next-step` 分区实现**（`packages/core/agent-loop/src/agent.ts:126`）。这也是与旧文档的一个显著差异。`[源码可验证]`

---

### 附加 · dsh 源码核验后新增（Q56–Q60）

> 以下 5 个问题是 2026-08 深度核验 dsh 源码后新增的高价值追问，每题都在 dsh 里找到了 tcum-ai 没有做但值得借鉴的**新颖机制**。

**Q56. dsh 怎么兼容 Claude Code / Codex 的 hook？直接接过来能跑吗？** ⭐️ 新增

- **能跑，一行不改**——dsh 有两个专门的桥接包：
  - `packages/hooks/hooks-claude-code`：把 CC 的 `SessionStart` / `PreToolUse` / `PostToolUse` / `Stop` / `SubagentStart` / `SubagentStop` hook 命令直接接到 dsh 的等价扩展点（`agent/pre-step` / tool `pre` / `post` 等）；
  - `packages/hooks/hooks-codex`：同类桥接给 Codex hook。
  - 通用协议在 `packages/hooks/hook-protocol`——**执行、参数替换、决策映射**都统一实现，桥接包只关心 payload 格式差异。
- **一个精细边界**：CC 的 `updatedInput`（允许 hook 改写工具入参）dsh **只 log + warn，不 honor**——想真改 input 必须写 native plugin。这是"兼容旧生态但坚持自己安全模型"的典型 dsh 设计。
- **对 tcum-ai 的意义**：dsh 桥接了 CC 生态就等于 tcum-ai 未来若切 dsh 底座，能直接复用 CC 用户已有的 hook 脚本，迁移成本大幅降低。`[源码可验证：packages/hooks/hooks-claude-code/src/index.ts]`

**Q57. 一个 turn 内多个 step 之间的 KV Cache 怎么保住？** ⭐️ 新增

- 核心是 **`request/header` 只在变化时 append**（`buildRequest()` 里 `if (baseline === undefined || !headerEquals(baseline, header))`）——同一 turn 内多 step，只要 system prompt + tools + config 都不变，就不会追加新 `request/header`，前缀字节序列完全一致，KV cache 100% 命中。
- 触发 `reason:'change'` 的情况：workflow 中动态挂载新工具、A/B 切 config、compaction 完成后。**这些都会导致本 step 的前缀失效**，所以 dsh 通过 CI 强制每个包声明 `#### KV Cache effect`（`scripts/verify-package-readme-model-experience.ts`）逼作者思考"我这个改动会不会破 cache"。`[源码可验证]`

**Q58. `SessionProjectionRegistry` 是什么？为什么要独立成一个服务？** ⭐️ 新增

- 定义：`packages/session/session-projection` 提供 `ProjectionDefinition` + `SessionProjectionRegistry` 服务，让插件**注册"事件流→派生视图"的投影函数**。
- 现有的投影：`tokenUsage`（token-meter 注册）、`contextPressure`（token-meter）、`todos`（tool-todo）、`permissions`（permission-presets）、多 session-title 变体等。
- 为什么要独立：**Event Sourcing 的"读侧"必须与"写侧"解耦**——`session.jsonl` 是唯一真源，但 UI 展示 / metrics 上报 / 决策查询 都需要不同的"当前状态视图"。投影层让每个消费者定义自己的 fold 函数，共享同一份事件流，还能上 `session-projection-cache` 快照加速。
- **对 tcum-ai 借鉴**：现在的 `SkillCache`/`Summary` 都是"手写投影"混在 `dialog` 表字段里，将来重构可参考——把投影从表字段抽出来做成独立 `ProjectionRegistry` 层，读侧代码就不用改到表结构。`[源码可验证：packages/session/session-projection/src/index.ts]`

**Q59. `packages/goal` 的 goal 域和 `packages/todo` 的 todo 有什么区别？为什么两套？** ⭐️ 新增

- **`todo/write`**：轻量级——模型自主写整块 todo list snapshot 到 session，last-write-wins；纯给模型和 UI 看的"任务追踪笔记"；`tool-todo` 提供工具入口。
- **`goal` 域**：重量级——**事件溯源 + CAS 变更 + 分轮驱动**（`goal` 事件溯源、`goal-round-driver` 每一轮显式激活/阻塞、`GoalActivation` 状态机、`GoalBlockReason` 显式记录卡壳原因、`GoalError` 处理并发冲突）；给**长程任务**用的正式生命周期管理。
- **判断标准**：一次 turn 内的任务分解 → todo；跨天跨会话的长任务追踪 → goal。dsh 两套都提供是因为**滥用 todo 做长期规划模型经常忘、滥用 goal 做短期就重**。`[源码可验证：packages/goal/goal/src/index.ts]`

**Q60. `packages/workflow` 家族在跑什么？和 subagent 什么关系？** ⭐️ 新增

- 4 个包：`workflow`（核心 DAG 定义）、`workflow-worker-thread`（**在 Node worker thread 里跑 workflow，隔离主线程**）、`tool-workflow`（工具入口）、`tool-ralph`（Ralph——具体 workflow 之一，是 dsh 内的一种自主编排能力）。
- **和 subagent 的区别**：
  - subagent 是"再起一个完整 agent 跑一段对话"，粒度粗、模型主导；
  - workflow 是"跑一段声明式 DAG"，粒度细、代码主导；
  - workflow 里的每个节点可以是"调 subagent"、也可以是"调工具"、也可以是"if/else 分支"。
- **典型场景**：需要严格顺序保证的多步操作（比如 "先 lint → 再 test → 通过后才 push"）用 workflow；需要模型自主决定下一步的探索性任务用 subagent。`[源码可验证：packages/workflow/*]`

---


---

# 第三部分 · 四条套娃追问链 & Agent 自进化专题

> **本部分定位**：面试深度追问弹药库，也是 A～D 四条追问链的唯一现行正文。内容已按当前 deepseek-harness 源码修正，不追求保留旧稿中未经验证的数字和机制猜测。**建议先掌握第一/二部分的通用回答，再用本部分应对“你说的 A 是怎么做的？B 是怎么做的？”式套娃追问。**

## 第一部分 · 四条套娃追问链

<a id="deep-dive-a"></a>

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
- 强答：**checkpoint 机制**——dsh 的 `packages/compaction/compaction` 导出 `compactCheckpointSource` / `isCompactCheckpointSource`（`src/checkpoint.ts`），压缩产生声明式边界，下次重启能从 checkpoint 开始重新积累新缓存池。此外 `compaction-tool-result-pruner` 只剪工具结果（尾部大块），不动 assistant 推理（前缀），这样即使 compact 也能保住大部分前缀命中率。

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

<a id="deep-dive-b"></a>

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
  单看 token 数不够——不同 provider 的 token 计算不同（tiktoken vs deepseek tokenizer），事前估计不准，必须留 fallback。`[dsh: packages/compaction/compaction-basic src/index.ts]`

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
  - **不要虚构 `originalRange`**：当前 dsh compaction 会追加带 `surfaceOp: { op: 'replace', start, end }` 的摘要节点，旧事件仍保留在 raw log，但从当前 model-visible surface 中被遮蔽；后续压缩基于当前 surface 重新选择安全区间，因此通常操作的是“摘要节点 + 后续消息”，并不等于系统禁止再次压缩旧摘要。递归摘要失真仍需要质量评测和按需回看 raw log；
  - **摘要错误自愈**：模型下次读文件发现和摘要冲突时，会主动更正；dsh 的 `fs/observed` 事件（`packages/skill/skill-filesystem/src/index.ts:139` 里 `ctx.on('fs/observed', ...)`）就是这个机制——**注意它不是通用事件**，而是 `skill-filesystem` 包自己声明合并的事件类型、仅当你装了这个 skill 时存在。

**B5**：你说 tool_result 剪枝——一个文件读了两次结果不一样（比如中间被改过），你剪掉旧的会不会误导模型？
- 弱答：`保留最新的就行`；
- 强答：**去重要看语义**——文件读取用 `path + mtime` 做 key，重复读取只保留最新；grep 结果用 `query + files_scanned` 做 key；不能全按"同名工具就去重"。dsh 的 `compaction-tool-result-pruner` 里有分类去重策略。**并且剪掉后要在剪除处塞一个 marker**（如 `[3 previous reads of /src/foo.ts pruned]`），让模型知道"这里发生过读取"，避免它以为从来没读过。

**B6**：如果用户强制不 compact，任由上下文爆，最终会怎么样？
- 强答：**分层熔断**：
  1. 达到 provider hard limit（如 GPT-4o 128k）——直接 API 错误，agent-loop 拿到 `context_length_exceeded` 后 fallback 到强制 compact；
  2. 达到 provider soft limit（80%）——切换到更长上下文的 model route（如 Gemini 1M 或 GPT-4.1）；
  3. 用户禁用了 compact 又不给切模型——**turn-stopping**，返回明确错误 `TurnEndReason=context_exhausted`，让用户手动决定。**永远不要静默丢消息**。

**B7**：Codex 用 Responses API 服务端接续，是不是根本没有 compact 问题？
- 强答：**有，但不能再把 Codex 当作纯黑盒**。服务端接续不会消灭模型上下文上限；当前开源 runtime 的 `context_window.rs` 会维护 active context、auto-compact 范围、full window hard cap、剩余预算和 fallback buffer，并有 compact/token-budget 事件。因此正确的比较是：
  - Codex：拥有 runtime 级预算与压缩机制，具体产品界面暴露程度、云端策略和模型端自动压缩细节不应从客户端源码反推；
  - Claude Code / dsh 客户端：**看得见**（token-meter 一等公民指标），可主动优化。
  dsh 用户完全可以自己实现"Responses-API-like 服务端接续"——只需一个 stateless 代理保存日志——但**主动权在客户端**，这就是可观测性带来的架构选择自由。

---

<a id="deep-dive-c"></a>

### 链 C · "一切皆插件" 的追问（8 层，dsh 核心）

**C0（root）**：dsh 一切皆插件，具体怎么实现的？

**C1**：什么叫"一切"？举 3 个具体例子。
- 强答：
  1. **LLM adapter**：`llm-deepseek` / `llm-pi-ai` / `llm-anthropic` 都是插件，切 provider = 换插件；
  2. **工具**：每个工具（bash / read / grep / todo）都是独立 npm 包，MCP 工具是运行时注册的插件；
  3. **系统能力**：compaction、token 计量、subagent、skills，甚至 system prompt 组装本身都是插件。
  **反例（需修正）**：Claude Code 与 Codex 的内置核心工具更产品化，但 Codex 已有 Skill、MCP、Hook、Plugin 和 App Server 扩展面；它不是 dsh 那种“所有内部子系统均可热挂卸”的全插件架构，却也不是“加能力只能 fork”。

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
  并发边界要说准确：fiber 是**插件生命周期和依赖作用域**，不是替你串行化所有异步任务的协程调度器；共享状态仍需由具体 Service 自己保证一致性。服务属性代理默认沿当前 fiber/祖先解析，**会受拓扑和 shadow 影响**。`postmortem-0001` 的真实修复是：声明依赖的服务继续用属性访问；机会性读取、未在 `inject` 中声明的兄弟服务改用拓扑无关且保留活性检查的 `ctx.get(name)`，不是笼统地说所有代理都走全局 store。

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
- 强答：这类循环依赖会让相关 entry 无法进入 active，而不是可以正常工作的依赖图。解决：
  1. 首选依赖倒置：拆分成三个，A、B 都依赖 C，C 是共享契约或能力 seam；
  2. 如果 B 真的是可选能力而非 A 的启动前提，A 不声明强依赖，只在实际调用点用 `ctx.get('B')` 查询并处理不存在；不能在 `apply` 阶段假装 B 已就绪；
  3. 启动时 fail loud——`app-boot` 的 `assertEntriesLoaded/assertEntriesActivated` 会报告没有 fiber、加载失败和 pending entry 的 unresolved services，避免应用带着未激活插件继续运行。当前仓库没有名为 `dsh-dependency-check` 的静态循环依赖 gate，不能在面试中这样宣称。

**C7**：插件卸载（`fiber.dispose()`）时怎么保证资源清理干净？漏掉一个 timer 会怎样？
- 强答：**`ctx.effect()` 强制返回 disposer**——注册副作用时必须给回收函数（unregisterFn / clearTimeout / socket.close），Cordis 在 dispose 时逆序调用。漏掉：
  - 内存泄漏（listener 引用父 fiber 阻止 GC）；
  - "僵尸"响应（disposed plugin 的 hook 仍触发）；
  - 当前仓库主要靠 Cordis 生命周期 API、包级测试和 review 约束清理；没有发现“每个 `ctx.on` 必须在同一 scope 配 disposer”的专门 CI lint。准确说法是：优先使用 `ctx.effect()`、`ctx.on()` 或返回 disposer 的官方注册 API，把资源所有权绑定到 fiber；关键后台任务再补 teardown 测试。

**C8**：一切皆插件的**代价**是什么？为什么 Claude Code / Codex 不这么做？
- 强答：**代价三方面**：
  1. **启动和治理开销**：每次挂载都要解析依赖、建立 fiber、等待激活并审计 pending/failed entry；源码能证明路径更长，但当前材料没有可支持“冷启动慢 5～10 倍”的 benchmark，不能给这个数字；
  2. **类型系统复杂**：`ctx.tools` 类型要靠 TS 声明合并（declaration merging）动态扩展，出错难 debug；
  3. **调试链路长**：一个 tool 调用穿过 5 层 waterfall、3 个服务代理，栈追踪很深。
  Claude Code / Codex 的内核更强调稳定产品体验和受控扩展：Codex 将 Skill、MCP、Hook、Plugin、App Server 协议作为扩展面，而不是把每个核心子系统都暴露为可热挂卸插件。dsh 定位更接近可重组的 Agent 平台，二者是**扩展边界选择**而非技术优劣；不要再说 Codex“不追求二次开发”。

#### 补充：从 HTTP 请求到 Session 落盘的一条完整链路

这组问题适合在面试官继续追问“插件很多，核心到底怎样跑起来”时展开。先给结论：**`AgentLoop` 是一个普通 Cordis 插件，但它注册了唯一的 `AgentFactory`；每次会话创建出的运行对象是 `ReactLoopAgent`，而不是一个新的 Cordis 插件。**

```text
HTTP / SDK 请求
  → ctx.agents.create(...)
  → 唯一 AgentFactory（默认由 AgentLoop 插件注册）
  → 创建一个 ReactLoopAgent + 一个 Session
  → ReactLoopAgent 的 turn/step 循环
  → waterfall('agent/pre-step') → LLM → tool → 下一 step
  → session.append(...)
  → 内存事件日志 + session/event 通知
  → 持久化插件批量落盘
```

**C9**：为什么核心流程会调用 `AgentLoop`，而不是任意一个 LLM 插件？
- 强答：Cordis 不会按插件名“挑一个执行”。`dsh-agent` 提供 `ctx.agents.create()` 这个入口；`AgentLoop` 在加载时调用 `ctx.agents.setFactory(this)`，以 `AgentFactory` 的业务角色注册自己。`AgentRegistry` 同一时刻只允许一个 factory，第二个会直接报错。
- 因此，`AgentLoop` 在 Cordis 看来是普通插件；在 **Agent API 的业务协议**里，它恰好是“创建 Agent 的唯一工厂”。LLM 插件只提供 `ctx.llm.stream()` 能力，不能替代工厂和调度器。

**C10**：一个 turn、一个 Agent、一个 Session 是什么关系？
- 强答：通常 **一个 Agent 对应一个 Session，并可处理多个 turn**；一个 turn 里又可有多个 ReAct step（模型调用 → 工具调用 → 再次模型调用）。新用户消息通过 `agent.followup()` 放进该 Agent 的 inbox，唤醒同一个驱动循环，不会为每轮对话重新创建 `ReactLoopAgent`。
- `ReactLoopAgent` 是运行期对象，保存 inbox、取消信号、当前 phase 等短期状态；Session 是可恢复的历史账本。进程重启后不会反序列化旧的 JS Agent 对象，而是加载 Session 日志，再创建新的 Agent 继续跑。

**C11**：Session 到底存什么，模型上下文又从哪里来？
- 强答：Session 是 append-only 的 `SessionEvent[]`，每条事件有 `seq`、`time`、`type`、`data`，例如 `user/message`、`assistant/message`、`tool/result`、`turn/start`。热路径先在 `ctx.sessions` 的内存 `Map<SessionId, Session>` 中追加；追加成功后发出 `session/event`，不会在每个事件上同步等待磁盘 I/O。
- `session.deriveMessages()` 不是读取一份可变的“messages 数组”，而是从事件日志中带有 `surfaceOp` 的消息事件推导出当前请求历史。因此“模型可见的信息必须能由日志重建”是关键约束；chunk、turn 边界等非消息事件不会直接进入模型上下文。

**C12**：Session 用什么持久化介质？是否写数据库？
- 强答：**当前默认落在本机磁盘文件，不是数据库。**仓库默认加载 `@deepseek-ai/dsh-session-persistence-jsonl`；每个 Session 一个 append-only 的 JSONL 日志，默认使用 Zstd 压缩。以 headless 示例为例，配置 `root: './.sessions'`，所以实际文件类似：`./.sessions/--项目路径--/<session-id>/session.jsonl.zstd`。基础 bundle 也是同一个 JSONL provider，只是 root 配成 dsh 数据目录下的 `sessions/`。
- `ctx.sessionPersistence` 是可替换的持久化接口，不是 `Session` 类写死的实现。因此部署方**可以**改装 `@deepseek-ai/dsh-session-persistence-sqlite`，那时才会写入一个 SQLite 数据库文件；但这不是当前默认路径，更不是 JSONL 与 SQLite 同时双写。
- JSONL provider 为每个 live Session 维护独立有界写队列，默认最多合并约 200ms 的事件后追加；`session/flush`、Session 销毁和 provider 卸载会强制 drain。这样模型主循环不被 fsync 卡住，同时在明确检查点获得持久化保证。
- SQLite 后端中，`sessions` 表存 header 元数据，`events` 表按 `(session_id, seq)` 一条事件一行，默认使用 WAL。选 JSONL 还是 SQLite 是 `cordis.yml` 的组装选择：前者便于单会话迁移和审计，后者便于按 seq 查询、索引和集中管理。

**C13**：Event 是插件级、进程级还是 Agent 级？怎样指定 scope？
- 强答：必须拆成四件事：

  | 维度 | 含义 |
  |---|---|
  | 事件名字/类型 | 应用级公共协议，例如 `agent/pre-step` 由 `dsh-agent` 用 TypeScript declaration merging 声明 |
  | emit 者 | 具体插件或运行对象，例如 `ReactLoopAgent` 在每个 step 前触发 `agent/pre-step` |
  | 监听器所有者 | 某个插件 fiber；插件卸载时，`ctx.on()` 注册的监听器随 effect 自动注销 |
  | 本次分发范围 | 由 dispatch carrier 中的 scope 决定，可以是未绑定的全局范围，也可以是某个 Agent / Session |

- Agent 创建时会执行 `createScope(loopCtx, agent)`，拿到 `agent.ctx`；这个 Context 带有 Agent 身份标签。派发 Agent 事件时框架创建 `scopeTarget(agent, agent)`，将它作为事件的 receiver。这个 receiver 的过滤规则是：未带 scope 的全局监听器总能接收；带当前 Agent scope 的监听器可以接收；父 Agent scope 也能接收子 Agent 的事件；兄弟 Agent 和子 Agent 不能反向接收父级事件。
- 所以监听代码的注册位置，就是最常用的 scope 指定方式：

```ts
// 根 ctx：观察所有可见 Agent 的 pre-step
ctx.on('agent/pre-step', listener)

// agent.ctx：只观察这个 Agent 及它创建的子 Agent
agent.ctx.on('agent/pre-step', listener)
```

- 注意区分两类“事件”：`assistant/message`、`tool/result` 是 **持久化 SessionEvent**，会写日志；`agent/pre-step`、`agent/status`、`session/event` 是 **进程内 Cordis 事件**。后者默认不落盘，其中 `session/event` 只是“一个持久化日志事件刚刚追加”的实时通知。

**C14**：Harness 的上下文管理是否只有“摘要压缩”？
- 强答：**不是。摘要压缩只是“历史过长后怎样缩短”的一种手段。**完整问题要分为四层：

  | 层次 | Harness 已有做法 | 解决的问题 |
  |---|---|---|
  | 1. 选择模型本轮能看见什么 | `Session.deriveMessages()` 将 append-only 事件日志投影为 message surface；`surfaceOp: append/replace` 决定一条事件是否仍可见 | 日志可以完整保存，模型不必看到全部日志 |
  | 2. 控制新上下文如何进入 | `agent-instructions` 读取 `AGENTS.md` 链并按 `maxBytes` 限制、去重、按目录优先级取舍；`time-context`、`tmux-context` 只在需要时注入；`session-reference` 以显式引用读其他 Session 的有界快照 | 避免把所有环境信息、所有其他会话无差别塞进 prompt |
  | 3. 降低已有上下文成本 | `compaction-tool-result-pruner` 先截断超大工具输出；`compaction-basic` 再把较旧消息总结成 checkpoint，并保留最近原文 | 工具输出或对话历史太长时释放 token 预算 |
  | 4. 长期保存与恢复 | JSONL/SQLite 保存完整 SessionEvent；恢复时重新建立 surface，projection cache 用于快速得到标题、统计等派生状态 | 进程重启后能续跑，但不等于自动把全部历史重新塞给模型 |

- 所以一个更准确的请求链是：先由 Session surface 选择历史，再叠加按预算和触发条件注入的 workspace/time/tmux/跨会话上下文；若 token-meter 判断仍有压力，先 prune 大工具结果，再用 summary checkpoint 替换较旧的一段。最终才形成 `ctx.llm.stream()` 的 messages。
- 这与业界常见方案对应：滑动窗口只保留最近 N token；摘要压缩用摘要替代旧历史；RAG/检索按需取回外部记忆；结构化状态把任务进度、槽位、事实放到 JSON/数据库；工具输出裁剪降低高噪声内容；分层记忆把短期原文、摘要和长期档案分开。Harness 已实现 summary、工具输出裁剪、显式跨 Session 有界引用、结构化事件日志和按需环境注入；它不是“把向量库召回自动混入每一轮 prompt”的通用 RAG 框架。

**源码锚点（可用于面试时自证）**：
- `packages/core/agent/src/index.ts`：`AgentRegistry` 与唯一 `AgentFactory`；
- `packages/core/agent-loop/src/index.ts`：`AgentLoop` 注册 factory 并创建 `ReactLoopAgent`；
- `packages/core/agent-loop/src/agent.ts`：`createScope(loopCtx, this)` 与 ReAct step 循环；
- `packages/core/session/src/index.ts`：append-only 内存日志、`deriveMessages()`、`session/event`；
- `packages/session/session-persistence-jsonl/`、`session-persistence-sqlite/`：两种持久化 provider；
- `packages/core/scope/src/index.ts`：`createScope`、`scopeTarget` 的路由规则。

---

<a id="deep-dive-d"></a>

### 链 D · 长程任务可靠性追问（7 层）

**D0（root）**：agent 跑一个 3 小时的任务，中间进程崩了怎么办？

**D1**：怎么恢复？重跑还是续跑？
- 弱答：`重跑`；
- 强答：**会话状态续跑，外部副作用重新取证**。dsh 用 Event Sourcing 保存 append-only Session log；重启时 `SessionPersistence` 读回事件序列作为 seed，新生命周期用 `session/end-seed` 标出 seed/live 边界，后续模型请求用 `request/header reason:'resume'` 记录恢复。它能确定性重建消息表层、turn/step/tool 边界和日志投影，但整个 Agent 进程不是纯函数：LLM 输出、工具副作用和外部服务状态仍需幂等键、状态检查或人工确认。

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
  3. **副作用 rollback**——如果崩溃发生在 tool 执行中期且工具不幂等，应该**拒绝 resume**并让用户决策；`session-persistence` backend 在重启时对孤儿 turn 追认 `TurnEndReason.kind='interrupted'`（`packages/core/session/src/types.ts:170` 有个专门的此 kind："A persistence backend closed a crash-orphaned turn on reload. The loop never emits this marker"），agent-loop 本身从不 emit 它。
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
  1. **step 硬上限**：agent-loop 硬限（`packages/core/agent-loop/src/constants.ts`），超限直接触发 `Agent.cancel()` 路径，turn 结束时 `TurnEndReason.kind='aborted'`；
  2. **重复检测**：hook 在 `agent/pre-step` 挂 detector，同一 tool + 相同参数连续 N 次触发告警；
  3. **cost 预算**：`token-meter` 里的 usage projection 累加，超过每 turn 预算触发 escalate；
  4. **模型自省**：`todo_write` 让模型显式追踪进度，反复无进展时 prompt 里显式提示"你正在原地打转"（dsh 的 `agent/turn-stopping` hook 可实现）。

**D7**：3 小时任务跑到一半，用户改主意想让 agent 换个方向，不重启怎么办？
- 强答：**steering 机制**（dsh 对 turn-中途插入的一等公民支持）——[docs/subsystems/core.zh.md](/Users/yaao/Documents/code/AI-agent/deepseek-harness/docs/subsystems/core.zh.md)：
  - `Agent.steer(message)` 把用户的新指令插入下一个 step 的 message 队列（`packages/core/agent-loop/src/agent.ts:126`：`this.send(input, 'next-step', true)`）；
  - **三个 Inbox 接口**区分插入时机：`followup()` → `next-turn`（组成下一个新 turn）｜`steer()` → `next-step` + 唤醒（当前 turn 中途插入）｜`inject()` → `next-step` + 不唤醒（高阶推理用：下次自然推理时带上）；
  - 已发出的 LLM 请求不打断（等 stream 完），但下一个 step 的 request 会带上 steering message；
  - `wakeDriver()` 在下一个推理边界处重新读 inbox：发现 fresh steering 就多跑一个 step；没有就 close turn。**没有专门的 `TurnEndReason=steering_change`**（早期文档推测错误），而是通过 inbox 拆分到 `next-turn` / `next-step` 两个队列自然区分。
  - **对比（需限定版本）**：当前 Codex App Server 已公开 `turn/steer`，可以把新输入送入指定 thread 的运行时；其精确插入时机与 dsh inbox 不同，不能据此断言“只能 ESC 中断”。比较时应问：新指令是取消当前请求、下一个 step 生效，还是能安全改变正在执行的有副作用工具；后两者都必须配合状态机和幂等语义。

---

## 第二部分 · Agent 自进化专题

> **这个话题目前业界只有 3 种典型形态**，从弱到强：
> 1. **Claude Code：以静态 `CLAUDE.md` 为主；Codex：`AGENTS.md` 是稳定项目指令，同时当前开源 runtime 已有从 rollout 异步抽取、再由隔离 consolidation Agent 串行聚合的 memory pipeline**。两者都不能简单概括为“只支持启动时静态文件”。
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

**对比 Claude Code / Codex**：当前公开 Codex 有 Skill/MCP/Hook/Plugin 的加载与变更发现能力，但没有看到 dsh 这种“主 Agent 在一轮里自主生成、安装、激活任意新 runtime Plugin”的等价闭环。差别应表述为**自我扩展的授权与动态性更弱/更受控**，而不是“工具集编译期固定”。

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

## 七、设计理念：模型进步会吃掉什么，Harness 应保留什么

> **面试结论**：模型升级通常吃掉的是 Harness 中“替模型思考”的认知层编排，而不是 Harness 本身。Harness 的重心会从 prompt chain、手写路由和格式修复，迁移到权限、执行、状态、审计和评测这些确定性运行时能力。

### 1. 先区分两类能力

| 层次 | 解决的问题 | 模型进步后的趋势 | 应放在哪里 |
|---|---|---|---|
| **认知策略层** | 怎么拆任务、选什么工具、何时反思、怎样组织回答 | 模型逐渐能在一次或少量调用中完成，固定流程的收益下降 | System prompt、skill、tool description；可配置、可替换、用 eval 验证 |
| **确定性运行时层** | 能不能执行、是否有权限、状态是否可恢复、失败能否安全重试 | 不会被模型能力替代，模型越强、外部副作用越大，反而越重要 | Harness / runtime 的代码与持久化协议 |

换句话说：不要把“模型这周还不够会做”永久固化成一个复杂框架能力；但也不能把“必须可靠地做到”交给模型临场发挥。

### 2. 哪些曾经很重要的能力，正在被模型能力吃掉？

| 早期 Agent 常见组件 | 当时为什么需要 | 今天为什么收益下降 | 仍然保留的合理场景 |
|---|---|---|---|
| Prompt chain / 固定 Planner → Executor → Writer | 单次模型调用难以维持目标与步骤 | 强模型已能在一个 agent loop 内自行拆解、调用工具、收敛答案 | 有明确审批关卡、流程合规或可验证的工作流 |
| 手写工具路由器 | 模型不可靠地选择 API | 原生 tool calling、清晰描述和更多上下文显著提升选工具能力 | 工具涉及权限、成本、地域或硬性策略时做**策略拦截**，不是猜模型想法 |
| JSON 提取、正则修复、重试 prompt | 自由文本难以被程序消费 | Function calling / Structured Outputs 将“格式正确”变为接口能力 | 不可信外部输入的校验；业务语义校验仍必须在服务端做 |
| AutoGPT 式任务队列 | 模型难以长期记住多步计划 | 模型能自己做局部规划；机械地维护 todo 常造成额外回合与陈旧计划 | 向用户展示进度、断点恢复、审计长期任务 |
| 默认的 critic / reflection 循环 | 早期模型需要反复自我纠错 | 无目标验证的“再想一次”常只增加 token 与循环风险 | 有测试、编译、约束检查等外部信号时，将它做成“失败后修复” |
| 默认 manager-worker 多 Agent | 用多个弱模型拼推理 | 强模型的单 Agent 能覆盖大量普通任务；多 Agent 带来上下文复制和协调成本 | 真并行、上下文隔离、不同权限域、不同专业工具或独立复核 |
| 粗粒度 RAG | 上下文短、模型知识旧 | 长上下文与检索能力降低“先切块再拼 prompt”的必要性 | 权威私有知识、时效信息、引用溯源；重点变成召回质量与权限过滤 |

这里的“吃掉”不是说这些模式消失，而是说它们不应再作为默认的、不可替换的主流程。比如 ReAct 的“调用工具—观察结果—继续决策”循环仍然是 Agent runtime 的骨架；弱化的是把每一步思考写成固定外部链路的必要性。

### 3. 这对 dsh / tcum-ai 的直接含义

- **TodoWrite**：不是为了让模型“获得任务拆解能力”。模型通常已经能拆；todo 的产品价值是把计划显式化、向用户展示进度，并把长期任务的进展写入可恢复的事件流。
- **Plan Mode**：更像人机协作的审批状态，而不是替模型规划。它让模型先调研、输出方案、等待用户确认后退出规划状态；是否会规划仍主要来自模型和 prompt。它本身不是禁止写操作的硬权限层，真正的副作用控制仍由审批与 sandbox 负责。
- **多 Agent**：只有在并行速度、上下文隔离、权限隔离、专用工具或独立验证上有明确收益时才创建子 agent。仅仅因为任务“看起来复杂”而分叉，常常更慢、更贵、更难收敛。
- **验证优先于反思**：编译、测试、schema 校验、接口返回、权限检查是可观测的外部事实；让模型根据这些事实修复，通常比没有证据的 critic loop 更可靠。

### 4. Harness 真正应长期拥有的能力

这些能力的失败后果不能仅靠“下一轮让模型再试一次”解决，因此必须留在运行时：

- 工具权限、用户审批、sandbox、网络与文件系统隔离；
- 外部副作用的幂等、超时、重试、取消和并发控制；
- Session / 事件日志、断点恢复、租户隔离和审计；
- token、成本、步数和时间预算，以及熔断；
- 模型请求、工具调用、结果与错误的观测；
- 离线 eval、回放和回归测试，用来判断某条 prompt 或编排是否真的提升成功率。

一个实用判断题是：**“这件事失败后，我们能否接受让模型在下一轮自己修好吗？”**

- 能接受：优先放在 prompt、skill、工具描述或可替换策略里；用评测证明价值，价值不足就删除。
- 不能接受：放进 Harness 的确定性代码。例如越权调用、重复扣费、会话丢失、跨租户泄漏、不可审计的写操作。

### 5. 面试时可以这样收束

“我不会把 Harness 当作替模型思考的脚手架。模型越强，固定 planner、路由器、JSON 修复和无证据反思的边际价值越低；这些能力应该保持轻量、可配置、可通过 eval 淘汰。Harness 要把最硬的部分做好：权限和副作用控制、持久化状态、可恢复执行、观测与评测。这样模型升级时我们替换的是策略，不是推翻运行时。”

可追溯的行业节点：[ReAct](https://arxiv.org/abs/2210.03629) 提出了 reasoning 与 acting 交错的 agent 模式；[Toolformer](https://arxiv.org/abs/2302.04761) 展示了模型学习何时调用工具；[Structured Outputs](https://openai.com/index/introducing-structured-outputs-in-the-api/) 说明输出格式可由接口层约束；[Anthropic 对 agent 的实践建议](https://www.anthropic.com/engineering/building-effective-agents) 也强调先从简单、可组合的模式开始，再按实际收益增加复杂性。

---

## 八、给 tcum-ai 的自进化落地路线图

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
- 长程可靠性：**Event Sourcing 重建会话状态，副作用靠幂等与外部取证恢复**；
- 自进化：**agent.inject → todo/write → cordis_define，从注入到进度到写代码**。
