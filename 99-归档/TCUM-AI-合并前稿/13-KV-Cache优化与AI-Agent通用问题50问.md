# 13 · KV Cache 优化 & AI Agent 通用问题 50 问

> 本文两部分：
> - **上半部分**：Prompt Caching / KV Cache 命中率——Codex、Claude Code、deepseek-harness (dsh) 三家的做法与 tcum-ai 可借鉴项（基于 dsh 源码可验证）。
> - **下半部分**：AI Agent 通用面试题 50 问（含大架构与关键实现细节），每题给出**四家横向对比**（Codex / Claude Code / dsh / tcum-ai）与优缺点视角。
>
> 编写时间：2026-08-22。dsh 部分来自源码可验证；Codex / Claude Code 部分明确标注"推测"来源（Anthropic cookbook、OpenAI 官方文档、社区抓包）。

---

## 第一部分 · KV Cache 命中率：三家做法对照

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

- `@deepseek-ai/dsh-compaction`：核心 API + checkpoint
- `@deepseek-ai/dsh-compaction-basic`：压力检测（挂 `agent/pre-step` + `agent/request-error`）
- `@deepseek-ai/dsh-compaction-tool-result-pruner`：工具结果剪枝

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

### 3. Codex（推测 + 部分公开）

OpenAI 家、走 Responses API / Chat Completions，**OpenAI cache 全自动**（≥1024 token / 5–10 min）。客户端能做的都是间接功夫。

#### 3.1 Responses API 的 `previous_response_id`

```
POST /v1/responses
{ "previous_response_id": "resp_xxx", "input": [{ new user turn only }] }
```

服务端接续上下文——**客户端不用重发历史**，前缀稳定问题搬到服务端。

#### 3.2 System prompt 稳定化

`AGENTS.md` + 内置指令 + 工具定义是磁盘固定文件；动态部分（CWD、shell、git branch）推测塞进 message 而非 system。

#### 3.3 Function calling 定义稳定

OpenAI SDK 的 functions 数组 JSON 序列化属性顺序稳定。

#### 3.4 局限

- 自动缓存仅 ≥ 1024 token 前缀生效；
- `cached_tokens` 有返回但 CLI 未透出；
- compaction 策略未知。

---

### 4. 四家对比汇总

| 维度 | Codex | Claude Code | **deepseek-harness** | tcum-ai (待补) |
|---|---|---|---|---|
| provider cache | OpenAI 自动 | Anthropic 手动 | 多 provider（DeepSeek 自动主打） | ? |
| 显式打断点 | 不需要 | 4 个 ephemeral | `cacheRetention` 由 adapter 决定 | ? |
| 前缀稳定保证 | 依赖 Responses API 服务端接续 | 工具集编译期固定 | **架构级**：epoch header + canonical + deepFreeze + 字典序 + 事件重放 | 缺失 |
| 命中率可观测 | 有 `cached_tokens` 但 CLI 不透出 | 有 usage 字段 | **一等公民**：`cacheReadTokens`/`cacheWriteTokens` 进投影 | 缺失 |
| Compaction | 未知 | `/compact` 手动 | 三件套（压力检测 + 剪枝 + checkpoint） | ? |
| 贡献者纪律 | N/A | N/A | **README 强制声明 `KV Cache effect`**，CI 校验 | N/A |
| 可扩展性 | 内置 | 内置 | 每层可替换插件 | ? |
| 公开可验证 | 无 | 部分 | 全部源码 | 内部 |

---

### 5. tcum-ai 落地建议（成本-收益排序）

1. **canonical request header + 仅变化时 append**——工作量小，避免语义等价但字节抖动；
2. **tool schema 字典序排序 / 显式 toolOrder**——一行 `sort`，可能把 tools 段命中率从 0 拉到 100%；
3. **usage 里加 `cacheReadTokens` 计量**——先能看到才能改；
4. **compaction checkpoint 机制**——比"简单滑窗"难得多，但对长会话是决定性的。参考 `packages/compaction/compaction-basic`。

---

## 第二部分 · AI Agent 通用面试 50 问

> 每题给出**四家对比 + 优缺点视角**（有些问题不适合的家会省略），标注 `[源码可验证]` 或 `[推测]`。tcum-ai 部分默认按目前你项目里已实现的机制填，若未实现则标 "缺失/待补"。

### 一、循环与调度（Q1–Q6）

**Q1. Agent Loop 的核心状态机是什么？turn / step / tool_call 三层如何区分？**
- dsh：`turn = 一次用户输入到 assistant 完成`，`step = 一次 LLM 调用 + 工具调用一轮`，多个 step 组成一个 turn，源码在 `packages/core/agent-loop/`。`[源码可验证]`
- Claude Code：类似三层，但内部无独立 turn/step 概念暴露；一个 message 内可嵌多个 tool_use block。`[推测]`
- Codex：Responses API 每个 response 一个 step，多个 response 一个 turn。`[推测]`
- tcum-ai：？

**Q2. 停止条件（TurnEndReason）怎么设计？**
- dsh：显式枚举 `TurnEndReason`（stop / max_steps / user_cancel / error / etc.），事件日志里明确记录。`[源码可验证]`
- 其他家一般用 `finish_reason` + 内部超限判断，缺乏统一枚举。

**Q3. 并发 tool call 怎么调度？串行 vs 并行？**
- Claude Code：允许一次 assistant message 返回多个 tool_use，客户端并行执行、并行 return（Anthropic 官方推荐）。
- Codex：Responses API 支持并行 function calls。
- dsh：`agent-loop` 内允许一步多 tool call 并行执行；对 stateful 工具（如文件写）通常放同一 step 顺序执行。`[源码可验证]`
- tcum-ai：？

**Q4. Cancel / Interrupt 怎么优雅传播？**
- dsh：`AbortSignal` 全链路穿透，request 冻结时含 signal；用户按 ESC 触发 turn 事件 `user_cancel`。
- Claude Code：ESC 中断，工具执行会打断但已发出的 LLM 请求需等 stream close。
- Codex：类似。
- 难点：中断后**部分执行完的工具结果如何持久化**——dsh 依然会 append `tool/result`，保证日志完整；有些实现会丢弃导致会话不可恢复。

**Q5. Retry / Backoff 策略：哪一层做？**
- dsh：`llm-retry` 独立包，policy 可注入，与 agent-loop 解耦。`[源码可验证]`
- Codex/Claude Code：内嵌 SDK。
- 优点对比：解耦利于按 provider 调 policy（DeepSeek 卡顿 vs OpenAI 429）。

**Q6. Max steps / Max tokens 触顶后如何处理？**
- dsh：`TurnEndReason=max_steps` 明确记录，让上层决定是否 escalate。
- Claude Code：`stop_reason=max_turns`。
- 关键设计：**触顶不等于失败**——要能续跑（resume），dsh 通过 `request/header reason:'resume'` 支持。

### 二、上下文管理 & Compaction（Q7–Q13）

**Q7. 上下文窗口打满前如何压缩？滑窗 vs 摘要 vs 剪枝？**
- Claude Code：`/compact` 手动 + auto-compact，让 LLM 生成摘要替换旧消息。**破坏 KV cache**。
- dsh：三件套（压力检测 + tool-result 剪枝 + checkpoint 摘要）。tool-result-pruner 只剪工具结果尾部，保护前缀 KV cache。`[源码可验证]`
- Codex：Responses API 服务端接续（`previous_response_id`），客户端 compaction 未知。
- tcum-ai：？

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
- dsh subagent-fork-in-process：可选继承部分 header（`subagent-fork-in-process/session.jsonl` 有例）；`[源码可验证]`
- Codex：Codex 内子 agent 不显式暴露。

### 三、工具体系（Q14–Q19）

**Q14. Tool schema 怎么定义？JSON Schema vs TypeScript type vs Function signature？**
- Claude Code / Codex：JSON Schema（OpenAI/Anthropic function calling）。
- dsh：**双模**——JSON Schema 或 Code Mode（TS/Python 类型定义嵌入 system prompt，模型直接输出 TS 代码）。`[源码可验证]`
- Code Mode 优点：token 更少、更符合模型 code 分布、语义更强；缺点：需要沙箱执行。

**Q15. 工具描述如何做到 prefix-cache-friendly？**
（见 Q11 + KV cache 部分）

**Q16. MCP 工具动态注册 vs 编译期固定？**
- Claude Code：内置固定 + MCP 动态。
- dsh：全插件化，MCP tools 走 `packages/core/tools` 注册接口。
- 权衡：动态灵活但字节稳定性差；dsh 通过字典序缓解。

**Q17. 工具执行的沙箱与权限模型？**
- Claude Code：默认 dangerously-skip-permissions 关闭，敏感操作弹权限。
- dsh：`packages/tools` 各工具自带权限声明；bubblewrap 沙箱脚本（`scripts/prepare-ci-bubblewrap.sh`）。`[源码可验证]`
- Codex：本地执行，权限模型依赖用户信任。

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
- Codex：主要单 agent + Responses API 状态服务器；
- dsh：`subagent-*` 支持 fork-in-process，属于 Orchestrator；
- 学术界：AutoGen 支持 Peer-to-Peer。
- 权衡：Orchestrator 好控好观测；Peer-to-Peer 灵活但难调试。

**Q25. 长程任务（跑几小时）如何保证不丢状态？**
- dsh：**Session 是 append-only event log**，进程崩重启后能 100% 重放。`[源码可验证]`
- Claude Code：`.claude/` 目录持久化，`--resume`；
- Codex：Responses API 服务端保存。
- 核心 pattern：**Event Sourcing**——所有状态是事件日志的纯函数。

**Q26. Checkpoint / Resume 怎么实现？**
- dsh：`request/header reason:'resume'` 事件重建，`session.replay()` 从任意点续跑。
- Claude Code：`--resume <session-id>` 从 `.claude/projects/*/history.jsonl`。
- Codex：`previous_response_id`。

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
- dsh：`token-meter` 独立包做 usage projection，`session.jsonl` 事件日志本身就是 trace；`[源码可验证]`
- Claude Code：`/status` 显示，无导出。
- **对 tcum-ai 建议**：直接把 session 事件日志接 OTel。

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
- dsh：`session.jsonl` per-session，跨 session 记忆走 `packages/settings/*` 或 project files。

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
- Codex：`--auto-edit` 开关；
- dsh：`packages/tools/*` 各工具声明 `requiresConfirmation`；
- 关键：**不要把 confirm 变成用户的按 Enter 操作**（confirmation fatigue）。

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
- dsh：新建 `packages/llm/llm-kimi`，实现 `Provider` 接口，registerAdapter，即完成。**不改任何其他 package**。
- Claude Code / Codex：需 fork 源码。

**Q50. Agent 框架的"可持久化"边界在哪？哪些是纯运行时状态？**
- dsh 明确分层：
  - **持久化**：`session.jsonl` 事件流（`request/header`、`tool/result`、`user/message` 等）；
  - **派生**：`deriveMessages()` 由事件重放得到，不入库；
  - **纯运行时**：Cordis Context 树、pending stream、AbortSignal——不入库；
- 好处：**恢复只需 replay 事件**；
- 陷阱：如果工具执行副作用没有事件化（比如某工具改了外部数据库但没写 `tool/result`），resume 会漏。

### 附加 · 深度追问（Q51–Q55）

**Q51. `request/header` 事件的 `reason: initial | resume | change | fallback` 各代表什么？**
- initial：首个 header（新 loop）；
- resume：从持久化 log 恢复；
- change：header 变了；
- fallback：旧版 v0 log 兼容（现已 reject）。
- 意义：**日志本身能重建整个请求**——`docs/subsystems/session.zh.md` 明确列。`[源码可验证]`

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
- 磁盘增长快（一个长 task 几十 MB）——需要 rotation；
- rewind 场景（用户点"回退到第 3 轮"）需要 fork 出新 log 而不是就地删；
- dsh：不允许就地修改事件，只能 append `steering/message` 类反悔事件。`[源码可验证]`

---

## 结语

上述 55 题按 dsh 源码优先展开，Codex / Claude Code 部分做了对齐。你在准备 tcum-ai 面试或架构评审时，可把"tcum-ai 目前的做法 / 缺失项"逐题填进去——尤其是 **KV Cache**、**Compaction**、**事件日志持久化**、**插件化架构** 这四大主题，是最容易出深度题的方向。

