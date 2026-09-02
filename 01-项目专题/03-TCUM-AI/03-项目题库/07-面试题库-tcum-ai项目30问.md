# tcum-ai 面试题库 · 30 问深度库（项目视角）

> **本卷定位**：围绕 tcum-ai 项目的 30 个高频面试题，按主题聚类，融合"通用 Agent 面试视角"（原 13）与"套娃追问链"（原 14）的相关追问，形成"项目回答 + 通用追问 + 深度探问"三层结构。
>
> **配套阅读**：
> - 通用视角（KV Cache 对照、自进化、跨家做法）见 [08-面试题库-通用Agent深度专题.md](./08-面试题库-通用Agent深度专题.md)
> - 反问弹药见 [09-反问清单-Agent岗深度反问50问.md](../04-面试表达/09-反问清单-Agent岗深度反问50问.md)
> - 机制底层原理详解请回溯 [01-机制篇-架构与上下文管理.md](../01-机制原理/01-机制篇-架构与上下文管理.md) 等机制篇章
>
> **合并说明**：本文件由 `07-30问-循环上下文与工具体系.md` + `08-30问-多Agent与知识记忆.md` + `09-30问-安全可观测与性能.md` 合并而成，编号 Q1~Q30 保留，主题聚类重排为 8 大主题。

---

## 📑 目录

> 本文共 **8 大主题、30 个高频问题（Q1~Q30）**，每题统一按「分析逻辑 → 四方做法 → 差异本质 → TCUM-AI 亮点与不足 → 解决思路」五段展开。

**一、循环调度与上下文管理（Q1~Q6）**
- Q1. Agent 推理循环如何驱动？最大轮次如何控制，耗尽后会发生什么？
- Q2. Token 预算如何计算和管控？
- Q3. 上下文超限如何处理？压缩算法是什么？
- Q4. 消息如何编排？多轮历史如何加载？
- Q5. System Prompt 如何管理？
- Q6. 循环中的流式处理如何做？工具能否边生成边执行？

**二、工具体系（Q7~Q12）**
- Q7. 工具如何定义、注册与发现？
- Q8. 工具 Schema 如何生成？
- Q9. 工具数量膨胀（128 个）怎么办？模型如何选对工具？
- Q10. 工具结果过大如何治理？
- Q11. 工具执行失败如何反馈给模型？超时、重试、并发如何控制？
- Q12. 如何保证模型输出的结构化可靠性？

**三、多 Agent 与协作（Q13~Q17）**
- Q13. 多 Agent 如何编排？
- Q14. 意图路由如何做？准确率如何保证？
- Q15. 子 Agent 上下文如何隔离？
- Q16. A2A 协议如何实现？稳定性如何？
- Q17. MCP 的 Client / Provider 双向能力实现如何？

**四、知识、记忆与幻觉（Q18~Q22）**
- Q18. RAG 检索质量如何保证？
- Q19. 知识如何切分、导入与更新？
- Q20. "三层记忆"具体是什么？如何召回与淘汰？
- Q21. 会话如何持久化与恢复？
- Q22. 如何控制幻觉？

**五、安全与权限（Q23~Q25）**
- Q23. 工具执行有权限控制吗？危险操作如何拦截？
- Q24. 有沙箱隔离吗？
- Q25. 用户身份如何透传？有审计吗？

**六、可观测性与评测（Q26~Q28）**
- Q26. Agent 的可观测性做到什么程度？
- Q27. 有评测体系吗？
- Q28. 如何防止能力回归？

**七、性能、容错与降级（Q29~Q30）**
- Q29. 延迟与成本如何优化？
- Q30. 容错与降级如何做？

**八、tcum-ai 亮点、短板与最高杠杆改动**
- 一、四家的定位差异（理解差异的前提）
- 二、TCUM-AI 的五个真亮点（可对外讲）
- 三、TCUM-AI 的十个真短板（按优先级）
- 四、五个"最高杠杆"的单点改动（面试问"你会先做什么"时的答案）
- 五、一段可以直接说的收尾

---

# 一、循环调度与上下文管理（Q1~Q6）

> **对照通用视角**（详见 [08-面试题库-通用Agent深度专题.md](./08-面试题库-通用Agent深度专题.md) 二部分 Q1~Q13）：本主题除了 tcum-ai 的实现细节，还应准备"Agent Loop 状态机 turn/step/tool_call 三层""停止条件 TurnEndReason""Cancel/Interrupt 优雅传播""Compaction checkpoint""长文件塞不进上下文的降级方案"等通用追问。

## Q1. Agent 推理循环如何驱动？最大轮次如何控制，而尽后会发生什么？

**为什么会有这个问题**：运维场景里一次跨产品根因定位经常 30+ 轮工具调用（告警⚠️→指标⚠️→实例⚠️→拓扑⚠️→变更⚠️…）。早期我们沜了 eino 默认 20 轮，线上频繁碰上 `ErrExceedMaxIterations`——**用户看到的不是"排查到一半的阶段性结论"，而是一个报错页**，一整轮几十次工具调用白费。于是需要回答三个问题：循环驱动机制（能不能支持断点）、轮次控制（成本上界，不同任务预算不同）、**耗尽后行为**（报错 vs 强制收敛）。第三点在教科书上很少被提，但恰恰是体感下限。

**回答思路**：Agent 的本质是"感知-推理-行动"的迭代。这个循环怎么实现（图/状态机/递归）决定了可扩展性；轮次上限怎么控制决定了成本上界；**耗尽后的行为决定了用户体验的下限**。第三点最常被忽略，但恰恰是最影响体感的。

| | 做法 |
|---|---|
| **TCUM-AI** | 循环在 eino ADK 内部：`newReact(ctx, *reactConfig)`（`react.go:340`）构建 `compose.Graph`，节点 `Init/ChatModel/ToolNode`，`toolCallCheck` 流式分支决定回环还是 END。轮次链路：eino 默认 20 → `AgentConfig.MaxStep` → 实例覆盖（`cloud_native_expert:30`/`prometheus_expert:25`/数字分身兜底 15）；Graph 层 `WithMaxRunSteps(math.MaxInt)`。耗尽在 `modelPreHandle` 抛 `ErrExceedMaxIterations` |
| **CC** | `QueryEngine.ts`驱动，**10 种 `Terminal.reason`**：`completed`/`aborted_streaming`/`aborted_tools`/`max_turns`/`blocking_limit`/`prompt_too_long`/`model_error`/`image_error`/`hook_stopped`/`stop_hook_prevented`。每种触发不同清理逻辑（`aborted_streaming` 必须为已发出未完成的 `tool_use` 补空 `tool_result`）；Effort 分级调节推理深度 |
| **Codex** | 基于 **Responses API** 的 agent loop：构建提示词 → token 化推理 → 工具请求（shell/文件系统）→ 结果回灌 → 重新组织提示词再推理，直到输出终止信息。`approval_policy` 会在循环中插入审批点（`on-request`/`on-failure`/`untrusted`/`never`），**审批点本身就是一种"受控暂停"而非终止** |
| **OpenClaw** | Gateway 单进程管理 sessions 与 routing，agent runtime 内置且可换provider；循环细节官方首页未展开（**未证实**）。但因其定位是"7×24 常驻助手 + cron/webhook 触发"，**其循环必须支持长期驻留与被动唤醒**，而非一次性会话 |

**差异本质**：
- CC 的 `Terminal.reason` 是**双向价值**设计：对内驱动清理逻辑、对外驱动重试决策。TCUM 只有"成功/一个错误"两态。
- Codex 的审批点提供了 CC/TCUM 都没有的第三种循环状态：**"暂停等人"**——这不是终止，是可恢复的中断。
- OpenClaw 的循环是**长生命周期**的（进程常驻 + 事件唤醒），而 CC/Codex/TCUM 都是"一次请求一个循环"。
- **dsh 参考**：类似 CC 的终止枚举，但做到**事件日志级别**——`TurnEndReasonMap` 6 种（completed/aborted/blocked/error/max-tokens/interrupted）完全结构化写入 `turn/end` 事件，且 map 可声明合并扩展（插件可自定义新结束原因）；一个 turn 不同 step 内 `StepEndReason` 只有 `completed/max-tokens` 两种，其他异常都浮到 turn 层——**这种"分层枚举"**比 CC 单层枚举更能本质地告诉上层"异常发生在哪个粒度"。参见 [08 Q2](./08-面试题库-通用Agent深度专题.md)。

**TCUM 亮点**：不自建循环、复用 eino ADK 是清醒的选型（核心竞争力在领域知识与工具生态）；`MaxStep` 三级配置（默认/配置/实例覆盖）粒度合适。

**TCUM 不足**：
1. **轮次耗尽是报错而非收尾**——运维场景最需要结论的复杂问题最容易撞上限，整轮工作白费；
2. **终止原因单一**——上层无法据此决定重试策略，前端无法差异化提示；
3. `math.MaxInt` 让 Graph 层失去第二道防线；
4. 单一全局轮次预算，不区分任务复杂度（简单问数和跨产品根因同用 20/30）。

**解决思路**：
- **O1.1** 定义 `TerminationReason` 枚举并在 `AgentEvent` / AG-UI 事件流透出；
- **O1.2（最高 ROI）** 轮次耗尽改**强制收敛**：`modelPreHandle` 检测剩余 ≤1 时注入 system 提示"请基于现有信息给出结论与不确定性说明，不要再调用工具"+ 临时置空 tool 列表（**复用现成的 `buildNoToolsRunFunc` 路径**）。成本极低，把"error"变成"带不确定性标注的阶段性结论"；
- **O1.3** 分级轮次预算（简单 8 / 单产品诊断 20 / 跨产品根因 40），由路由阶段的 `complexity` 标签驱动；
- **O1.4** Graph 层兜底改`MaxIterations*3+10`；
- **借鉴 Codex**：引入"审批暂停"作为第三种循环状态（技术底座 `CompositeInterrupt` 已有）。

---

## Q2. Token 预算如何计算和管控？

**为什么会有这个问题**：最早我们对 token 用量是"无感知"的——只能等模型回“上下文超限"才知道。后来上了本地估算（`chars/4`），但线上发现中文/JSON 严重低估：**我们估算“才 40k”，实际发出去已经 70k+，直接 400**；但如果正常请求也每次都包一次远程 tokenizer（真实精度），延迟又多了一次 HTTP。所以需要回答：什么时候需要“精”（超限重试时）、什么时候可以“粗”（日常请求）、精口子挂了怎么办（熔断降级）。**精度 vs 开销的权衡**是这题的本质。

**回答思路**：token 是Agent 的"内存"。算不准 → 要么浪费窗口要么撞上限。而**精确计数本身有成本**（远程tokenizer 一次 HTTP），所以这是一个"精度 vs 开销"的权衡题，答案取决于"在哪些路径上需要多准"。

| | 做法 |
|---|---|
| **TCUM-AI** | 三级 `TokenCounter`：`LocalTokenCounter`（`chars/4`）/ `LitellmTokenCounter`（POST litellm `/utils/token_counter`，真 `openai_tokenizer`，连续失败 3 次熔断 60s）/ `FallbackTokenCounter`（优先远端，失败降级，**成功时异步跑本地估算打偏差对比日志**）。**只在超限重试路径调远端**，800ms 超时。模型上限 `GetModelMaxTokens()` 单一全局值，默认 100000 |
| **CC** | **`tokenCountWithEstimation`**：从后向前扫 messages，找最近一条带 `usage` 的消息（并处理并行工具调用的分裂消息——同 `message.id` 需回溯到第一条），`return usage.tokens + roughEstimate(messages[i+1:])`。**零额外 API 调用、精度足够**。另有 `blocking_limit` 终止原因 + `claudeAiLimits.ts` 配额跟踪 |
| **Codex** | 依赖 Responses API 侧的 usage 与上下文管理；提供 `/compact` 手动压缩指令。**对用户暴露"上下文剩余"的可视化**，把预算管理部分交给人 |
| **OpenClaw** | 官方首页未展开 token 预算机制（**未证实**）。其"Models → 提供商/模型配置/failover/本地模型"章节说明是多provider 抽象层，token 语义随provider 变化 |

**差异本质**：**CC 的方案是"数学上的优雅"**——它意识到"最近一次响应的 `usage` 已经精确反映了当时整个上下文窗口的大小"，所以只需估算增量。TCUM 是"工程上的务实"——用真tokenizer 换精度，用熔断和路径限制控成本。**CC 的方案严格优于 TCUM**：零网络调用、精度足够、无熔断后退回不准估算的问题。

**TCUM 亮点**：
1. 三级降级 + 熔断的工程完备度高；
2. **成功时异步打偏差对比日志**——这是自带效果度量，很少有人这么做；
3. "只在超限重试路径调远端"体现了克制（正常请求零额外延迟）；
4. 代码注释**诚实记录**了 `chars/4` 对中文的低估问题（`chars/1.5~2`），并明确指出这是 `ContextWindowExceededError` 的根源。

**TCUM 不足**：
1. `chars/4` 对中文严重低估，熔断后退回这个不准的估算；
2. 精确计数是远程 HTTP，不能高频用；
3. `MODEL_MAX_TOKENS` 单一全局值——多模型混用时（32k/128k/200k 差异巨大）要么浪费要么撑爆；
4. **无 token/成本累计追踪**——无法回答"这次会话花了多少 token/多少钱"。

**解决思路**：
- **O2.1（P1，最高性价比借鉴点）** 落地 `HybridTokenCounter`：从 `schema.Message.ResponseMeta.Usage` 取最近 usage + 增量粗估，**替换当前"要么远程精确要么本地瞎猜"的二元选择**；
- **O2.2** 中文感知估算系数：ASCII `/4`、CJK `/1.6`、JSON 结构字符单独计权（低成本高收益）；
- **O2.3** `GetModelMaxTokens(modelName)` 按模型配置；
- **O2.4** 会话级 token/成本账本（对标 CC 的 `blocking_limit`），超阈值预警或降级。

---

## Q3. 上下文超限如何处理？压缩算法是什么？

**为什么会有这个问题**：早期告警诊断专家上线后出现过一个棘手现象：连续多轮正常，某一轮却因 `400 ContextWindowExceededError` 直接中断。复盘发现，eino 的 `ToolsNode` 对一轮多个 `tool_calls` 会并发执行并在 `wg.Wait()` 后一次性返回，因此 token 不是线性增长，而可能被一批大工具结果直接推过安全区；这批结果又都是模型尚未读过的新内容，周期性 summarization 没有旧内容可优先剔除。于是需要三层防御：入口治理、周期性压缩和撞墙后的自适应重试。具体 token 跳变量应以 trace 为证据，不把示例数值当成固定规律。

**回答思路**：这是长会话 Agent 的生死线。要回答三层：**入口治理**（工具结果别让它进来那么大）、**周期性压缩**（历史怎么瘦身）、**兜底**（真撞上限怎么办）。三层缺一层就会出现"某类场景必挂"。

| | 做法 |
|---|---|
| **TCUM-AI** | **七层压缩**（详见第一篇之一 §1.1）：**L0** 输出表示层，但它不是“任何数组自动压缩”——仅工具主动返回紧凑契约时发生；已确认 `ListCmdbServersCompact` 返回 `compact_table`（columns+rows，N 行只出现一次字段名），`QueryArchTopology`/`QueryImpactChain` 返回 v3 列存+元组压缩；普通 JSON 数组不触发 L0 → **L1** 工具结果结构化截断（64KB，可环境变量/per-tool 覆盖，metrics/table/compact_table/raw_grafana×2 形态/AnalyzedMetrics 五类对齐裁剪，保留条数用 `×(maxSize/totalSize)×0.8` 比例法）+ **COS 卸载**（2h 预签名 URL + WarnMsg 引导写脚本下载）→ **L2** Skill/说明书侧（手写精简版 SKILL.md 替换、skill 缓存距离淡出、mcporter 零 schema）→ **L3** summarization（阈值 `maxTokens/2`，`GenModelInput` 预算 0.9，未读保护 + 最近 2 条保护+ "已读最旧优先" 三级elide，`UserInstruction` 引导保留 COS_URL 清单）→ **L4** `AdaptiveContextRetry`（parse 400 拿真实 token → 打5 个标签/3 维排序 → **tool T1/T2/T3 + assistant T4 + 极限档**递进压缩，**round 递进解禁**（r1 护未读、r2 解禁未读+T3、r3 解禁 T4）→ **fail-fast 自查**（>target×1.05 且非末轮则不发请求）→ 原地重试，`0.85` 安全比例，16 个多供应商错误关键字）→ **L5** 跨轮：**摘要替代历史**（`SummaryMsgCount` 游标之前的消息永久不再进上下文，只以 `<conversation_summary>` 存在）+ Period 分层异步摘要（≥10 条触发，保留最近 6 条不摘要，Period>4 合并为1 粗+3 细，LLM 失败 fallback 为**直接拼接**）→ **L6** 场景化裁剪（报告只留 user+最终回答并剥离 reasoning/toolcalls；记忆 50→截 200B→LLM Top-10） |
| **CC** | **三级压缩**：**微压缩**（不丢信息的精准瘦身：去重、路径缩写、空白规范化）→ **会话记忆压缩** → **全量摘要**。`compact/` 目录专做此事。经验值：微压缩通常省 20~40%，**零 LLM 调用、零信息损失** |
| **Codex** | `/compact` 手动压缩 + 自动上下文管理；`AGENTS.md` 作为"稳定的项目上下文"，把可复用信息固化到文件而非会话历史里——**这是一种"用文件系统当外部记忆"的思路** |
| **OpenClaw** | 会话隔离维度丰富（per-agent / workspace / sender；DM 共享主会话、群聊各自独立会话）——**用"会话切分"而非"压缩"来控制上下文规模**。具体压缩策略未展开（**未证实**） |

**差异本质**：四家代表四种哲学：
- **TCUM = 纵深防御**（七层叠加，每层解决一类失效，且 L0~L2 是零LLM 成本层）；
- **CC = 分级成本**（先零成本无损，再花 LLM 钱）；
- **Codex = 外部化**（AGENTS.md 把稳定知识移出会话）；
- **OpenClaw = 分区**（用会话边界隔离，天然不让单会话变大）。

**这四种可以叠加**，不是互斥的。TCUM 的 L0~L2 其实已经带有CC "分级"的雏形，但缺的是**运行时的无损微压缩**（去重/清空已卸载 data/空白规范化）和 Codex 的"稳定上下文外部化"。

**dsh 参考**（参见 [08 Q7](./08-面试题库-通用Agent深度专题.md)）：**四件套**——`compaction`（`CompactionEngine` 抽象 + `compactCheckpointSource` 声明式边界）+ `compaction-basic`（挂 `agent/pre-step` + `agent/request-error`）+ `compaction-tool-result-pruner`（只剪尾部保护前缀 KV cache）+ `command-compact`（`/compact` 命令）。dsh 的**独门创新是 `compactCheckpointSource` 声明式边界**——压缩产生一个可从日志重建的 checkpoint 事件，下次重启可从此点重新积累 KV cache 池；**TCUM 的 L3/L5 则无此声明式边界**，压缩后无法从事件流重建断点位置、后续命中率无法监控。若未来 tcum-ai 要接 KV cache observability，可参考 `session-projection-cache` + `compactCheckpointSource` 两件套的创新。

**TCUM 亮点（这是全项目最强的一块）**：
1. **七层覆盖完整且分层清晰**：L0~L2 零 LLM 成本、L3/L5/L6 花 LLM 做语义压缩、L4 零 LLM 做应急压缩，每层有明确失效场景对应；
2. **L5 的"摘要替代历史"是长会话真正收敛的原因**：`GetRecentDialogHistory(dialogID, SummaryMsgCount)` 只加载游标之后的增量 → 50 轮会话发给模型的永远是"1 段分层摘要 + 最近十几条"，**上下文长度收敛而非线性增长**；
3. **COS_URL 穿透压缩**：tool 侧 T1/T2/T3 三档都强制保留（T1 保完整结构、T2 保 metadata、T3 靠`extractCOSURLHint` 单摘一条链接）——一个能穿透任意层压缩的"数据传送门"；
4. **压缩后 fail-fast 自查**：不达标就不发请求（>target×1.05 且非末轮），避免浪费一次必然失败的 400——很少有实现做这一步；
5. **协议安全**：只改 `Content` 不删消息，严格保 `tool_call_id ↔ tool` 对应；
5. **递归自保**：压缩模型自身也被 `adaptiveContextModel` 包一层，防"压缩请求自己超限"；
6. `UserInstruction` 引导摘要保留 COS_URL 清单——**压缩与数据卸载两个机制显式协同**。

**TCUM 不足**：
1. **L4 在流式主链路不生效（P0，最严重）**——`adaptiveContextModel.Stream` 直接透传（`adaptive_context_retry.go:272-276`），而 AG-UI 入口把 `EnableStreaming` 硬编码为 `true`（`adapter.go:79`）→ 生产上400 超限**不会**被接住。它目前只在 summarization 内部压缩模型、A2A 非流式、skill 子 Agent 三条 `Generate` 路径生效；
2. **报告总结路径零防护**——`SummaryDialogMessages` 超预算只warn 不裁剪，且用裸 `DefaultModel`（未过 `WrapModel`）；
3. **`skill`/`task` 结果跳过 L1**（`skipTruncateTools` 白名单）——失控子 Agent 报告可一次冲爆上下文；
4. **token 估算只算 `Content`**——不含 tools schema / `ToolCalls.Arguments` / `ReasoningContent`，低估是"chars/4 偏差"ד漏算字段"两因素叠加；
5. **缺运行时微压缩档位**——L0~L2 是静态/结构层，运行时仍是直接跳到 LLM 摘要；
6. **常规档不动 system/user**——Deep Agent 下 system 常是最大头，只有极限档才碰它，出现跳档；
7. **`toolBatchID` 是死字段**——算了但排序与极限档都没用，"按 tool_calls 批次整批处理"未落地（所以别说"五维打分"，准确是"5 个标签、3 维排序"）；
8. **摘要不可逆、无引用回溯**；
9. **触发阈值 `maxTokens/2` 过激进**——100k 上限下 50k 就触发，而L3 要一次 LLM 调用；
10. **阈值分散靠注释同步**（20 余个常量散在 6 个文件）；
11. **压缩质量无度量**（无压缩触发率/档位命中率/压缩后成功率任何指标）；
12. 阈值以字节而非 token 为单位。

**解决思路**：
- **O3.0（P0，ROI 最高）** 给 `adaptiveContextModel.Stream` 补"建流时同步400"这一类的压缩重试：复用现有 `isContextOverflowError` + `compressToTarget`，压缩后重新 `inner.Stream`；流中途报错的情况加"未产出任何 chunk 前才可重试"判定。约 30 行，直接把已有的 L4 从"实验室能力"变成"生产能力"；
- **O3.1（P0）** 补运行时微压缩：同工具重复结果去重（保留最新+差异摘要）、已 COS 卸载的 `data` 直接清空、长 JSON key 路径压缩、空白规范化、已完成无后续引用的中间步骤折叠；
- **O3.2** 摘要保留 `msg_id` + 提供 `recall_message(msg_id)` 工具让模型按需回看；
- **O3.3** 新建 `pkg/agent/context_budget.go` 统一 `ContextBudgetPolicy`，消除注释同步；把估算改成"包含 tools schema + arguments"；
- **O3.4** 20~30 组"长会话 + 期望结论"样本验证压缩前后结论一致性；配三个指标：各 tier 命中次数、L4 触发率/成功率、压缩前后 token 比；
- **借鉴 Codex**：引入 `AGENTS.md` 式的"稳定上下文文件"——把租户约定、指标命名规范、常用查询模板固化成文件，由 skill 机制按需加载，而不是每次靠会话历史传递。

---

## Q4. 消息如何编排？多轮历史如何加载？

**为什么会有这个问题**：一个长期不能归因的 case——同样的词句是一天好一天坏，同样一个告警今天能诊断明天就说"您提供的告警信息不足"。拉日志都正常，没报错，但模型就是行为不一致。后来削开一看：历史/记忆/skill/页面上下文 4 源拼装，**所有人都在改，但没人能回答"这次请求给模型看了什么"**。另一个隐藏险坑是：父 Agent 中途派生子 Agent 时，上一轮未完成的 `tool_use` 可能孤立在历史里，**传给 API 直接报 500**，而且报得不归因。所以需要回答：多源拼装能不能有一个单一入口（可审计），格式合法性能不能在发出前校验（防 500）。

**回答思路**：模型只能看到 messages 数组。**"这次请求到底给模型看了什么"如果说不清，一切效果问题都无法归因**。此外消息格式合法性（tool_use/tool_result 配对）是隐藏的线上 500 来源。

| | 做法 |
|---|---|
| **TCUM-AI** | 会话历史 `dialog_history_service.go` 落 DB；记忆由 `memory_context_service.go` 组装（**LLM rerank**，失败 `fallback to recent memories`）；skill 上下文由 `SkillCacheManager.BuildPrompt` 在 service 层拼成 `schema.UserMessage` 插入；页面上下文用独立 `context` role 隔离并在历史加载时过滤；`entity_tag_inject` 精确插入到"最后一条 system 之后" |
| **CC** | **`filterIncompleteToolCalls`**：明确移除无对应 `tool_result` 的孤立 `tool_use`（父 Agent 中途派生子 Agent、上轮被中断等场景），否则**传给 API 直接报错**。有明确的 context assembler概念 |
| **Codex** | `AGENTS.md`（项目级）+ 会话历史 + 工具结果；`AGENTS.md` 是**分层的**（全局 `~/.codex/AGENTS.md` + 项目根 + 子目录），按就近原则合并 |
| **OpenClaw** | 会话按agent/workspace/sender 隔离；"智能体 → 上下文、记忆"章节存在但首页未展开（**未证实**） |

**差异本质**：CC 关注**格式合法性**（防API 报错），Codex 关注**分层配置合并**（用文件层级表达上下文优先级），TCUM 关注**多源拼装**（历史+记忆+skill+页面上下文）。**TCUM 的多源拼装最复杂，但恰恰最缺"单一入口"和"格式校验"。**

**TCUM 亮点**：
1. **页面上下文独立 role 隔离 + 历史加载时过滤**——避免临时数据污染长期历史，是个精细的边界设计；
2. 记忆 rerank 有两处 fallback，降级意识好；
3. `entity_tag_inject` 的插入位置精确到"所有 system 之后的第一个位置"，且零实体时静默跳过不污染 prompt。

**TCUM 不足**：
1. **缺 `filterIncompleteToolCalls` 等价保护**（P0）——潜在线上 500 来源；
2. **历史加载策略不清晰**——未见明确滑窗条数/token 上限，依赖后续压缩兜底，等于把问题推给下游；
3. **消息拼装分散在多处**，没有单一 context assembler，难以审计"这次给模型看了什么"。

**解决思路**：
- **O4.1（P0）** 每次调模型前统一 `SanitizeMessages`：移除孤立 `tool_use`/`tool_result`、校验 role 交替合法性、空 content 补位；
- **O4.2** 抽 `ContextAssembler` 单一入口负责 `system + memory + skill + history + current`，并输出可落 trace 的"上下文清单"（各部分 token 占比）——直接解决"为什么模型没看到某信息"的排查；
- **O4.3** 配置化 `max_history_messages` / `max_history_tokens`，超限先微压缩再摘要。

---

## Q5. System Prompt 如何管理？

**为什么会有这个问题**：真实发生过的事件——某同学在 DB 里改了 supervisor 的 SystemPrompt，直接接入生产，后面发现路由错乱也**无法回滚**——因为 DB 不存历史版本。yaml 里那部分有 git 可回滚，但 15 个生产 Agent 的 prompt 大多在 DB。另一个 case 是字符串拼接 prompt 时，模板里某个变量名写错了中间多了个空格，启动时不报错、运行时静默产生残缺 prompt 地模型行为异常，追了半天才发现。所以需要回答：prompt 能不能当代码对待（版本/diff/review/回滚）、变量能不能启动期校验（防静默失效）。这是 **“prompt as code”** 的核心。

**回答思路**：Prompt 是 Agent 的"源代码"，但绝大多数团队用"改配置"的方式管它——**没有版本、没有灰度、没有回滚、没有测试**。对运维 Agent 而言，prompt 改坏的影响面直接是线上。

| | 做法 |
|---|---|
| **TCUM-AI** | `AgentConfig.SystemPrompt` 来源 **yaml + DB 两级合并**（文件优先）；`ExitTool.Prompt` 拼到尾部；`supervisor` 的 prompt **运行时动态拼装**（`<角色定义>` + `<子Agent列表>`）；数字分身拼 `<digital_twin><soul>`；工具描述中有大量硬编码长文本（如 `skill_exec.go:44-58` 近 20 行）。**多层次prompt 体系**：Agent 级 SystemPrompt / SKILL.md 级三类规则（铁律/流程/格式）/ 工作流级 PromptTemplate / 数字分身 XML 结构化注入 |
| **CC** | 内置 prompt + `CLAUDE.md` 项目记忆 + skills frontmatter；**三级配置合并（用户/项目/企业）** |
| **Codex** | **`AGENTS.md`** 是核心机制：分层（全局/项目/子目录）、纯文本可diff、可 git 管理、可review。**这是"prompt as code"的最佳实践**——prompt 进版本库、走 PR 流程 |
| **OpenClaw** | `~/.openclaw/openclaw.json` 配置 + agents 章节；插件/技能通过 ClawHub 分发并有 **trust 指南与策展（curation）**——**对第三方 prompt/插件有信任审核层** |

**差异本质**：**Codex 的 `AGENTS.md` 和 CC 的 `CLAUDE.md` 把 prompt 变成了"仓库里的文件"**，天然获得版本、diff、review、回滚。TCUM 把 prompt 放DB + yaml，**yaml 那部分有版本管理，DB 那部分没有**——而生产 Agent 的 prompt 大概率在 DB 里（15 个 Agent 都是 DB 记录）。

**TCUM 亮点**：
1. **prompt 分层体系清晰**（Agent 级 / Skill 级 / 工作流级 / 分身 XML 注入四层）；
2. **SKILL.md 的三类规则分类（铁律/流程约束/输出格式）是可复用的方法论**，且 SKILL.md 在 git 里有版本；
3. **XML 标签结构化注入**（`<soul>`/`<memories>`/`<preferences>`/`<子Agent列表>`/`<skill_context>`）避免 LLM 混淆不同来源信息——这是很实用的技巧。

**TCUM 不足**：
1. **无版本管理**——DB 里的 prompt 改动无法灰度/回滚/A-B；
2. **无模板引擎与变量校验**——字符串拼接，缺失变量不报错只静默产生残缺 prompt；
3. **散落三处**（yaml、DB、Go 硬编码），无单一事实来源；
4. **prompt 与 skill 内容、工具描述共同竞争上下文，但无人统计各自token 占比**。

**解决思路**：
- **O5.1** `prompt_id + version` 模型，DB 存全量版本，运行时按 Agent 配置引用具体版本，支持按流量比例灰度与一键回滚；
- **O5.2** `text/template` + **启动期变量完备性校验**，缺变量直接启动失败（与现有 `RegisterTools` panic的 fail-fast 风格一致）；
- **O5.3** trace 中记录 system/skill/tool-desc/history 各自 token 占比；
- **借鉴 Codex（强烈推荐）**：把 Agent 的 SystemPrompt **迁到 git 仓库的文件里**（如 `agents/{code}/PROMPT.md`），DB 只存文件版本引用。这样 prompt 改动天然走 PR + review + 可回滚，成本极低收益极大。

---

## Q6. 循环中的流式处理如何做？工具能否边生成边执行？

**为什么会有这个问题**：这里包含两类体验。第一是 **TTFT**（首 token 到达时间）：SSE 可以尽早返回可展示内容，避免用户长时间面对空白页面。第二是 **执行流式化**：当模型同时生成多个工具调用时，如果必须等所有 tool call 完整生成后才开始执行，就会浪费本可用于并行执行的时间。需要进一步回答：流式做到字符还是 tool call 粒度、工具执行能否与生成重叠，以及流式中断后如何恢复。具体秒数必须由 trace 证明，不应作为固定项目指标。

**回答思路**：流式有两个层次：**输出流式**（用户体验，降 TTFT）和**执行流式**（性能，把工具执行与模型生成重叠）。后者是纯工程优化，收益取决于"生成耗时 vs 工具耗时"的比例。

| | 做法 |
|---|---|
| **TCUM-AI** | **分支判定已是流式**（`compose.NewStreamGraphBranch`，扫 chunk 有 tool_calls 就走 ToolNode）；AG-UI 通过 SSE 推流（心跳 10s），事件体系完整（含 `REASONING_*` 推理透出、`STEP_*` 子 Agent 边界）；A2A子 Agent 流 `idleTimeout=60s`，server 心跳 15s。**但工具执行仍等完整 assistant message**（eino `ToolsNode` 行为）。同一轮内 N 个工具**并发**执行（`parallelRunToolCall`，N-1 个 goroutine + 当前协程 + `wg.Wait()`） |
| **CC** | **`StreamingToolExecutor`**：LLM 还在生成后续内容时，就对**已完整解析出的** tool_use block 立即启动执行——`addTool(block) → tracked → tryStartExecution(tracked)`，不等整条消息 |
| **Codex** | 流式输出到终端；工具（shell 命令）执行与审批交织。**审批点天然打断流式**，所以流式执行优化空间受限于审批策略 |
| **OpenClaw** | 面向 IM 渠道（WhatsApp/Slack/Telegram），**IM 的消息粒度天然不适合字符级流式**——它更可能是"分段发送"而非流式。移动节点提供 Canvas/相机/语音工作流（**流式细节未证实**） |

**差异本质**：**流式的价值取决于交付渠道**。CC/Codex 是终端/IDE，字符级流式价值高；TCUM 是 Web + SSE，流式价值高且做了完整事件体系；OpenClaw 是 IM，流式价值低（IM 不适合逐字更新）。**这解释了为什么 OpenClaw 不需要在这块投入。**

**TCUM 亮点**：
1. **AG-UI 事件体系是四家里对"多 Agent 可视化"最完整的**：`STEP_STARTED/FINISHED` 表达子 Agent 边界+ 前端栈式管理 + 三层级渲染规则（Level 0 完整/Level 1 折叠/Level 2+ 内联缩进）；
2. `REASONING_START/CHUNK/END` 把推理过程可视化；
3. `TEXT_MESSAGE_CHUNK` 便捷模式（客户端自动展开）+ `CompactEvents` 持久化合并——**既保流式体验又控存储开销**；
4. 工具并发实现质量高：单工具快路径不开 goroutine、N-1 个协程、零锁（只写自己那格）、每goroutine 独立 panic recover、结果按下标收敛保 OpenAI 协议顺序、流式路径用 `MergeStreamReaders` 保持顺序对齐。

**TCUM 不足**：
1. **无流式并行工具执行**——一次诊断常并行 5~8 个查询工具（每个 2~5s），串行等模型输出完再执行，浪费了模型生成后半段的时间；
2. `idleTimeout=60s` 对长任务偏短，且**硬编码不可配**；
3. 无 `StreamableTool` 使用——长耗时工具无进度回传。

**解决思路**：
- **O6.1** 流式并行工具执行需改 eino ADK 或自建循环，**建议先量化收益**：统计线上一次 assistant 消息平均生成耗时与工具平均耗时，若生成 > 2s 且平均并行工具数 > 3，改造价值明确；
- **O6.2** `idleTimeout` 配置化 + 子 Agent 周期性发 `progress` 事件当业务心跳，区分"真空闲"与"在忙但无输出"；
- **O6.3** 对巡检执行、大范围查询改造为 `StreamableTool`，配合 AG-UI 推进度。

---

# 二、工具体系（Q7~Q12）

> **对照通用视角**（详见 [08](./08-面试题库-通用Agent深度专题.md) 二部分 Q14~Q20）：Tool Schema 三种表达法（JSON Schema / TS type / function signature）、prefix-cache-friendly 的工具描述稳定化、MCP 动态注册 vs 编译期固定、结构化输出的三大技巧（tool use / JSON mode / grammar constrain）。

## Q7. 工具如何定义、注册与发现？

**为什么会有这个问题**：一个真事驱动的重拆——早期我们把 MCP 工具注册失败处理成“log+continue”（觉得服务能启动就行），后来发现一个严重 bug：**服务启动了但少一半工具，表现为"Agent 突然不会做某事"**——日志里就一行 warn、告警也不触发、排查了一天才定位。另一个 case 是工具重命名：把 `KillShell` 改成 `TaskStop` 后，**历史会话回放全断**，因为无别名机制。所以需要回答：失败策略能不能不静默降级（启动 fail-fast）、重命名能不能向后兼容（别名/废弃标记）。静默降级是最难排查的故障，这是本题的本质。

**回答思路**：工具是 Agent 的"手"。注册机制决定扩展成本；**失败策略决定故障可见性**（静默降级是最难排查的故障）；别名/废弃机制决定演进成本。

| | 做法 |
|---|---|
| **TCUM-AI** | **不自定义 Tool 接口**，直接用 eino 的 `tool.BaseTool`/`InvokableTool`。自有抽象仅两层薄封装：`ToolManager`（`map[string]tool.BaseTool` + RWMutex，重名返回 `already exists`）+ `pkg/mcp/tool.go` 的 `ToolHandlerFunc[TInput]`。**编译期静态注册 + 启动失败 panic**（obs_agent/ops_agent/agent_access 本地工具 panic；mcp_server 12 行 blank import 触发 `init()`，`log.FatalContextf`）。**例外：`agent_access` 的 MCP 工具注册失败只 log + continue** |
| **CC** | `tools.ts` 统一注册；**`findToolByName` 支持 `name or name in t.aliases`**解决工具重命名向后兼容（旧 `KillShell` → 新 `TaskStop`）；`isEnabled()` 动态检查 |
| **Codex** | 内置工具（shell/apply_patch 等）+ **MCP 扩展**；`rules` 机制（Beta）可精确控制"这一条命令永远允许/拒绝" |
| **OpenClaw** | "工具"是一级章节；能力体系为 **tools / skills / cron / webhooks / automations**；**ClawHub 插件市场**负责分发，有**策展（curation）与信任（trust）指南**——即插件生态有明确的审核层 |

**差异本质**：**OpenClaw 唯一有"工具市场 + 信任审核"的**，因为它面向个人自托管、需要第三方生态；TCUM 是企业内部平台，工具全内建/内部 MCP，所以不需要 trust 层但**需要更强的注册一致性**。

**TCUM 亮点**：
1. **启动期 fail-fast**（panic）把配置错误暴露在发布阶段而非运行时；
2. **`AdaptEinoTools` 任一失败整体报错**，拒绝半可用状态；
3. **`XxxInput` + `XxxCore` + `FormatXxxOutput` + `NewToolXxx`/`NewAgentToolXxx` 四件套范式**——schema 单一来源，一套核心逻辑同时对 eino 和 MCP 暴露，避免两套实现漂移；
4. 工具描述有**What/When/How 三要素规范**。

**TCUM 不足**：
1. **无别名机制**——重命名工具则历史会话回放与模型既有习惯全断；
2. **`agent_access` 的 MCP 注册失败 log+continue 与本地 panic 策略不一致** → **静默降级**：服务起来了但少一半工具，表现为"Agent 突然不会做某事"，极难排查；
3. **`StreamableTool` 完全未用**；
4. 无版本/废弃标记，无法优雅下线工具。

**解决思路**：
- **O7.1** `ToolInfo` 扩展 `Aliases []string` + `Deprecated bool` + `ReplacedBy string`；查找支持别名回退；废弃工具不进模型列表但仍可被调用（返回引导信息）；
- **O7.2** 统一注册失败策略：启动期 panic，运行期动态拉取失败才降级且**必须打指标 + 告警**；
- **O7.3** 长耗时工具改`StreamableTool`；
- **借鉴 Codex 的 `rules`**：给工具/命令级别的 allow/deny 精确规则（这也是 Q23 权限体系的一部分）。

---

## Q8. 工具 Schema 如何生成？

**为什么会有这个问题**：真实发生过的 bug——某个工具的 Go struct 改了字段名（业务重构时跟上游对齐），但手写的 `NewParamsOneOfByParams` 里面的 schema 字段名忘同步了，**编译通过、测试通过、上线后工具全部报“参数解析失败”**——因为手写 schema 与 struct 无编译期绑定。另一个现象是同一个业务列表（tenants）在库里有 9/15/30+ 三个版本快照，因为不同 Agent 的精确枚举需要人工同步。所以需要回答：多条 schema 生成路径能不能收敛到一致不回销（少写手写）、动态枚举能不能从 CMDB 运行时注入（免于快照不同步）。

**回答思路**：schema 质量直接决定模型调用准确率。多条生成路径并存 = 风格不统一 + 无法统一治理。

| | 做法 |
|---|---|
| **TCUM-AI** | **四条路径并存**：① 反射（eino `InferTool` 读 `jsonschema` tag）② 手写 JSONSchema（`schema.NewParamsOneOfByParams`）③ 反射（mcp-go 泛型 + `invopop/jsonschema`）④ eino→MCP 转换（`ToJSONSchema()`） |
| **CC** | TS 类型 + zod schema，单一路径 |
| **Codex** | 内置工具 schema 固定；MCP 工具由对端提供 |
| **OpenClaw** | 工具/插件由ClawHub 生态提供，schema 由插件自带（**细节未证实**） |

**差异本质**：TCUM 是唯一有"多路径"问题的，根源是**既要对 eino 暴露又要对 MCP 暴露，且历史上有手写遗留**。

**TCUM 亮点**：`AdaptEinoTools` 转换失败整体报错；四件套范式在采用时能保证 schema 单一来源。

**TCUM 不足**：
1. 四条路径风格不统一——手写路径易漏 `Required`、漏枚举约束，描述质量参差；
2. **手写 schema 与 Go struct 无编译期绑定**——改 struct 忘改 schema，编译通过但运行时解析失败；
3. **无 schema 质量检查**。

**解决思路**：
- **O8.1** 收敛为"反射优先"，只在动态枚举等场景允许手写并在 CR 标注原因；
- **O8.2** `make lint-tools`：检查每参数有非空 `Desc`、枚举声明 `Enum`、工具 `Desc` 长度合理、无重复名/别名冲突；
- **O8.3（TCUM 特有真需求）** **动态枚举注入**：`tenants`/地域/产品这类枚举运行时从 CMDB 注入 schema。**证据**：同一份业务空间列表在库里有 9 / 15 / 30+ 三个版本快照（告警专家/PromQL 专家/Grafana 专家），且三者`config_endpoint` 都指向同一端点——这是靠快照维护枚举的必然结果。

---

## Q9. 工具数量膨胀（128 个）怎么办？模型如何选对工具？

**为什么会有这个问题**：上线一年后工具从 30 个膨到 128 个，看到两个现象：**一是 `system prompt 里工具描述 15~25k token`**（128k 上限直接吃掉19%）；**二是模型开始选错工具**（查 Prometheus 时去调天巡接口，相似名字的工具互相干扰）。业界经验是 > 30 个工具选择准确率就会明显下滑，我们自己看模型处于“准确率拐点”之下。mcporter 路线就是为了这个痛点——把 MCP 工具变成沙箱 CLI，**零 tool-schema 占用，schema 只在 skill 被 Get 时才进正文**。所以需要回答：能背景降到什么粒度（预算的硬上限）、选择准确率能不能度量（不能度量就无法优化）、膨胀后能不能不撞尽头（按次加载）。

**回答思路**：这是 Agent 规模化的第一道墙。128 个工具全量描述约 15k~25k token（**吃掉 1/4 上下文**），且业界经验工具数 > 30 后选择准确率明显下滑。核心矛盾：**能力覆盖 vs 上下文成本 vs 选择准确率**。

| | 做法 |
|---|---|
| **TCUM-AI** | **静态按 Agent 划分**（每个 Agent 配不同工具子集）+ `allowedTools` 白名单 + **数字分身动态注入**（按 `SubAgentIDs`/`McpConfig`/`KbRefs` 现造）+ **mcporter 路线（零schema 占用）**。12 个子 MCP 分域（monitor 34/tianxun-access 22/grafana 19/tianxun 14/cmdb 11/zhiyan 9/barad 7/assess 5/cls 4/…） |
| **CC** | **三级动态过滤管线**：简单模式只给 3 个核心工具 → 全量池减特殊工具 → **deny 规则前置过滤** → REPL 模式隐藏被包装的原子工具 → `isEnabled()` 动态检查。另有**工具搜索 + 延迟加载** |
| **Codex** | 内置工具数量少（shell 为主，**一个 shell 顶一百个工具**）；MCP 按需配置。**"用一个通用 shell 替代大量专用工具"是一条完全不同的路线** |
| **OpenClaw** | 渠道插件与工具**按需安装**（官方插件不全打包）；多智能体路由把能力分散到不同 agent |

**差异本质**：四条不同路线，值得逐一评价：

| 路线 | 代表 | 优势 | 代价 |
|---|---|---|---|
| **静态分域 + 动态注入** | TCUM | 简单、可控 | 与当前意图无关，查 Prometheus 时22 个天巡工具是纯噪音 |
| **多级动态过滤 + 工具搜索** | CC | 精准、可扩展 | 实现复杂 |
| **通用 shell 替代专用工具** | Codex | schema 极小、无限扩展 | 安全风险高（必须配沙箱+审批）、可控性差 |
| **按需安装 + 多agent 分散** | OpenClaw | 用户自选、生态化 | 依赖用户配置能力 |

**TCUM 的mcporter 路线其实是第五条路**：把 MCP 工具变成沙箱 CLI 命令，**零 tool-schema 占用**，schema 只在对应 skill 被 `Get` 时追加到正文。**这条路线介于"专用工具"和"通用 shell"之间——保留了工具语义（有 schema 可查），但不占常驻上下文。这是 TCUM 最有原创性的一点。**

**TCUM 亮点**：
1. **mcporter 零schema 占用路线**（详见第一篇之二 §2.4）；
2. **skill 的两级渐进披露**（`List` 只给 frontmatter，`Get` 才拉全文）——同一模式在skill 层的应用；
3. 数字分身按权限动态注入，顺带起到了工具裁剪作用。

**TCUM 不足**：
1. **筛选与当前意图无关**——单个 Agent 工具列表仍可能数十个；
2. **无工具搜索/延迟加载**；
3. 命名空间化 `{Server}.{Tool}` 加长工具名，进一步耗 token；
4. **无工具选择准确率度量**。

**解决思路**：
- **O9.1（P0，收益最高）** 意图驱动动态裁剪：路由阶段判定意图域 → 只注入该域工具 + 通用工具（10~20 个）→ 提供 `search_tools(query)` 元工具让模型按需检索加载；
- **O9.2** 分层工具描述（渐进披露）：列表只给一句话简述，选定后 `describe_tool(name)`拉完整参数说明，**可省 60%+ 工具定义 token**。**这与现有 skill 两级披露、mcporter 是同一模式的第三次复用**；
- **O9.3** trace 记录"模型选的工具 → 是否报参数错 → 是否被重试"，产出每工具"误用率"排行，优先优化描述最差 Top10。

---

## Q10. 工具结果过大如何治理？

**为什么会有这个问题**：告警诊断专家最典型的碰墙——“查一下最近一天的告警”能回上千条告警、一次时序查询可能几 MB。早期直接丢给模型把上下文打爆；后来粗暴“前 N 条截断”，又引发新问题：聚类分析对采样极敏感，**只取前 N 条结论必然错**（异常集群往往不在头部）。而且直接截一段 JSON 会把结构截坏，模型直接解析得乱七八糟。所以需要回答：**怎么截（不破坏结构）、截掉的去哪（可找回吗）、模型知不知道被截了**。三个问题任何一个回答不好都会产生隐性 bug。

**回答思路**：工具结果是上下文膨胀的最大来源（一次时序查询可能几 MB）。治理要回答：**怎么截（不破坏结构）、截掉的去哪（可找回吗）、模型知不知道被截了**。

| | 做法 |
|---|---|
| **TCUM-AI** | **结构化截断 + COS 卸载**（详见 Q3）：64KB 默认 / 环境变量覆盖 / per-tool 倍数覆盖（`QueryArchTopology` 2 倍）/ 白名单跳过 / 业务错误跳过 / 按 metrics/table/frame/raw_grafana 四类对齐裁剪 / 完整数据传 COS（2h 预签名）/ `Metadata.COS_URL` + `⚠️ 数据已截断` WarnMsg 引导写脚本 |
| **CC** | 工具结果截断 + 微压缩去重；`filesystem` middleware 含 **`LargeToolResultOffloading`**（与 TCUM 自研截断功能重叠但更优雅） |
| **Codex** | 结果落文件系统，模型用 shell 工具（`grep`/`head`/`jq`）**自己按需读**——**这是最"unix 哲学"的方案：不预设怎么截，给模型工具让它自己挑** |
| **OpenClaw** | 未展开（**未证实**） |

**差异本质**：**Codex 的方案在思想上最彻底**——不做"截断策略"，而是把大结果放文件系统 + 给模型 shell 工具，让模型自己决定看哪一段。TCUM 的 COS + 沙箱方案**本质是同一思想的云端版**（数据放对象存储 + 沙箱 Python 自己分析），但多了一层"必须先卸载再引导"的间接。

**TCUM 亮点（这是本项目做得最好的部分之一）**：
1. **分类型结构化截断**（同一 keep 数对齐所有列）——作者理解"暴力截断 JSON 会破坏结构让模型无法解析"；
2. **per-tool 倍数阈值**（而非绝对值），保证调整默认值时相对比例稳定；
3. **业务错误跳过**，避免对错误响应上传 COS 污染 `COS_URL`；
4. **WarnMsg 是一段可执行的行动指令**（推断结构 → HTTP GET → 解析 → 统计 → skill_exec 执行），而不只是"数据被截断了"；
5. **与 summarization 显式协同**（`UserInstruction` 引导保留 COS_URL 清单）。

**TCUM 不足**：
1. **64KB 以字节为单位，与 token 不对齐**——64KB 中文 JSON 可能 30k+ token；
2. **COS 卸载依赖沙箱可用**，且**未见"模型是否真的用了 COS_URL"的度量**；
3. **只有 obs_agent 挂了这个中间件**——`ops_agent`/`agent_access` 是否受保护需确认；
4. **截断策略与工具语义解耦**——"查最近 1000 条日志"被截到前 N 条，但**对排障最有价值的往往是异常聚集段而非头部**。

**解决思路**：
- **O10.1** 阈值改 token 单位（结合 Q2 混合估算）；
- **O10.2（价值最高）** 语义感知采样截断：日志类"错误级别优先 + 时间分桶均匀采样 + 异常聚集段完整保留"；指标类"保留极值点与拐点、中段降采样"；
- **O10.3** 全服务统一挂载 + 埋"截断发生率"与"COS_URL 后续被访问率"，**若后者很低说明卸载机制形同虚设**；
- **借鉴 Codex**：给模型一组"数据探查工具"（`peek_cos(url, jq_expr)`），让它不必写完整脚本就能按需取片段。

---

## Q11. 工具执行失败如何反馈给模型？超时、重试、并发如何控制？

**为什么会有这个问题**：一条真实 trace——`zhiyan-monitor.alarm_tag_ana ERROR → ToolNode ERROR → ReAct ERROR`，就因为一个 MCP 工具报错，**整个会话直接 ERROR 终止**，用户换个句式重问都不行。后来发现更隐蔽的现象——“密集字错误”：模型报“参数错”→改参数重试→周而复始十几轮（因为错误信息就一句 `bad request`，模型不知道具体哪次了什么），最后 token 钱硬花完了结论还是错的。所以需要回答：错误信息能不能"结构化翻译”给模型（ModelHint）、重试能不能退避 + jitter（防惊群二次打爆下游）、并发能不能限量（一轮 8 个工具打同一后端 = 自伤）。

**回答思路**：工具失败是常态而非异常。**给模型的错误信息质量决定了它能否自我修复**；退避策略决定了会不会二次打爆下游。

| | 做法 |
|---|---|
| **TCUM-AI** | **`toolErrorHandlerMiddleware`**：错误转成`[TOOL_ERROR]` 正常文本 + **三条明确行动指引**（改参数重试 / 临时错误重试一次 / 连续失败 2 次改用其他工具），2000 字符截断；**两类透传不兜底**（`IsInterruptRerunError` 因 HITL 依赖、`ctx.Err()` 因请求已终止）；挂在 Handlers 链最外层故覆盖动态注入的 MCP 工具。`UnknownToolsHandler` 对幻觉工具返回文本而非 error。熔断三处（阈值均为 3）。**并发无上限**，同轮工具全并发 |
| **CC** | 完整**错误分类状态机**（连接错误精细分类、Axios 错误统一分类）；**`getRetryDelay`**：`BASE_DELAY_MS=500`，`min(500*2^(n-1), 32000)` + **0~25% 正向抖动**（装饰性抖动，确保实际延迟不低于基础值）；`MAX_529_RETRIES=3` 后触发模型回退，**529 计数器跨流式/非流式连续传递** |
| **Codex** | `approval_policy = on-failure` 是一个独特设计：**命令失败时才请求人工介入**——把"失败处理"变成"人机协作点"而非"自动重试" |
| **OpenClaw** | Models 章节有 **failover**（provider 级故障转移）；渠道级失败容错未展开（**未证实**） |

**差异本质**：TCUM 把错误"翻译给模型"让它自愈；CC 把错误"分类后由代码决策"；Codex 把错误"升级给人"。**三者不冲突，理想是分层：可自愈的给模型、可重试的给代码、需决策的给人。TCUM 只有第一层。**

**TCUM 亮点**：
1. **错误文本带三条行动指引**——这是 prompt 工程用于容错的好例子，且明确写了"同一工具连续失败超过 2 次请停止重试"防死循环；
2. **两类透传的区分很精准**——很多实现会把 interrupt 错误也吞掉，导致 HITL 机制失效；
3. **挂最外层保证覆盖动态注入工具**，且注释解释了 eino 底层合并机制；
4. 真实 trace 驱动的优化（`zhiyan-monitor.alarm_tag_ana ERROR → ToolNode ERROR → ReAct ERROR`）——**有故障复盘习惯**。

**TCUM 不足**：
1. **无统一错误分类** → `connection refused` 和 `参数校验失败` 得到相同处理，模型只能瞎猜；
2. **无指数退避 + 抖动**——**抖动是防惊群关键**（1000 个客户端同时 429 同时重试会二次打爆服务端）；
3. **工具并发无上限**——一轮并行 8 个工具打同一后端可能自伤；
4. 无"连续失败后从工具列表临时摘除 + 换路提示"。

**解决思路**：
- **O11.1（P0）** 定义 `ToolError{Class, Retryable, UserVisible, ModelHint}`，分类覆盖 参数非法/权限不足/目标不存在/下游超时/下游过载/内部错误；给模型的 `tool_result` 带明确 `ModelHint`（"参数 region 非法，合法值见 xxx"）而非原始堆栈；
- **O11.2** 落地 CC 式退避：`min(500ms*2^(n-1), 32s)` + `rand()*0.25*baseDelay`，**优先采用服务端 `Retry-After`**；
- **O11.3** `errgroup.SetLimit(N)` + 按下游服务维度令牌桶；
- **O11.4** 同一工具单会话连续失败 ≥3 次从本轮工具列表临时摘除 + 注入换路提示；
- **借鉴 Codex 的 `on-failure`**：对高风险工具，失败时不自动重试而是升级为人工确认。

---

## Q12. 如何保证模型输出的结构化可靠性？

**为什么会有这个问题**：最痛的 case 在 Grafana 看板——早期让模型直接生成完整看板 JSON，**平均成功率 60% 不到**：要么内层千字的 targets、labels、thresholds 嵌套错序，要么少个逗号，要么字段名写错然后前端渲染一片白。重试也没用，模型还是会犯相似错误。后来彻底重构：**不让模型生成结构，而是给它一套语义级组装工具**（`tool_build_metric_panel`/`tool_edit_variable`/`tool_edit_panel`），**模型只做“量名字→需要什么面板”的语义判断，结构正确性由代码保证**。成功率从 60% 提到 95%+。所以需要回答：能不能不让模型输出结构，能不能把结构与语义分层。

**回答思路**：Agent 大量依赖"模型输出被程序消费"（工具参数、JSON 结论、路由决策）。解析失败率直接等于功能失败率。

| | 做法 |
|---|---|
| **TCUM-AI** | 工具参数由 JSONSchema 约束、eino 侧解析；各处**各自 `json.Unmarshal` 后自己兜底**（如 `memory_context_service.go:132` LLM rerank 解析失败 → fallback to recent）；`AdaptEinoTools` 转换阶段失败即整体报错。**Grafana 看板场景采用了更强的方案：不让模型生成 JSON，而是给它语义级组装工具**（`tool_build_*`/`tool_edit_panel`/`tool_edit_variable`），**结构正确性由代码保证** |
| **CC** | zod schema 校验 + 修复重试 |
| **Codex** | `apply_patch` 用**专用diff 格式**而非自由 JSON——格式越受限越可靠；工具调用走 Responses API 的结构化 function calling |
| **OpenClaw** | 未展开（**未证实**） |

**差异本质**：**最可靠的结构化输出是"不让模型输出结构"**。Codex 的 `apply_patch` 专用格式、TCUM 的 Grafana 语义工具，都是这个思路——**把结构生成交给代码，模型只做语义决策**。

**TCUM 亮点（这是一个被低估的设计，值得重点讲）**：
**Grafana 看板的三层设计**是本项目结构化可靠性的最佳实践：

| 层 | 职责 | 为什么这么切 |
|---|---|---|
| `service/grafana_dashboard/core/` | 保证输出 JSON **结构永远合法** | 结构正确性由代码保证 |
| `datasource/` + `flavor/` | 适配 Prometheus/InfluxDB、TCUM/Barad/智研三套栈 | 同一"看板意图"渲染成不同栈实现 |
| `tools/dashboard/` 17 个工具 | 暴露语义级操作（`build`/`edit_panel`/`edit_row`/`edit_variable`/`flush`/`restore_version`） | 模型只表达"加一个 CPU 面板" |

而且 **`tool_restore_dashboard_version` 给了模型"撤销"能力**——当 Agent 会修改状态时必须给回滚工具，这一点常被忽略。

另一个亮点是 **PromQL/InfluxQL 专家的"生成 → 执行验证 → 读错误 → 修正"闭环**：不是"生成一段看起来对的表达式"，而是真的 `PrometheusQuery` 跑一遍。**凡是输出可被程序验证的场景（SQL/PromQL/配置/代码），都应该把验证工具给模型让它自己闭环——这是 Agent 优于纯 LLM 生成的根本所在。**

**TCUM 不足**：
1. **无统一 `StructuredOutput` 校验+修复层**，各处风格不一；
2. **未用模型侧强约束**（如 OpenAI `response_format: json_schema`），仍靠 prompt 说"请输出 JSON"；
3. **解析失败无可观测性**——无法回答"哪个 prompt 的 JSON 输出失败率最高"。

**解决思路**：
- **O12.1** `ParseStructured[T](ctx, model, prompt, schema)`：内置 JSONSchema 校验 → 失败把校验错误回灌模型重试（≤2 次）→ 仍失败降级；
- **O12.2** 对支持 `json_schema` 的模型走原生结构化输出；
- **O12.3** 埋点每个结构化调用点的一次成功率、重试率；
- **推广自有最佳实践**：把 Grafana 的"语义工具 + 代码保结构"模式复用到巡检项生成（当前是"生成配置直接落地"，应改为"语义工具组装 + dry-run 验证"）。

---

（续见 `08-30问-多Agent与知识记忆.md`、`09-30问-安全可观测与性能.md`）

---

# 三、多 Agent 与协作（Q13~Q17）

> **对照通用视角**（详见 [08](./08-面试题库-通用Agent深度专题.md) 二部分 Q24~Q28）：Orchestrator-Worker vs Peer-to-Peer 架构选择、Task 分解粒度、Agent 间信息共享策略（全量/摘要/结构化事件）、A2A 协议对齐性问题。**深度追问**：套娃链 C "一切皆插件"如何做到——见 [08](./08-面试题库-通用Agent深度专题.md) 三部分链 C。

## Q13. 多 Agent 如何编排？

**为什么会有这个问题**：把告警、指标、看板、CMDB、天巡和变更全部塞进一个大 Agent，会带来三个棘手问题：system prompt 和工具描述持续膨胀、相似工具互相干扰、不同任务的上下文相互污染。按领域拆分专家后，又会出现并发控制与上下文共享问题：两个子 Agent 不能同时修改同一资源，但子 Agent 也不能在完全缺少前因后果的情况下启动。因此要回答三个层次：为什么拆、按什么边界拆、读写任务如何控制并发。Agent 和工具的具体数量以运行配置快照为准。

**回答思路**：单 Agent 的天花板是"工具太多选不准+ 上下文太长记不住"。多 Agent 的编排模式决定三件事：**任务如何分解、并发如何控制、结果如何汇总**。其中并发控制在有写操作的场景是**安全问题**而非性能问题。

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

**为什么会有这个问题**：一个看似巧妙实则困扰的难题——**路由错了，表现是“Agent 答不对”**，但你无法区分到底是路由选错了专家（告警问题丢给了 PromQL 专家）还是专家自己能力不够（PromQL 专家自己写错了）。日志里也看不出——因为模型后面“头头是道”地把错误归结成了“信息不够”。而且早期直接把 15 个专家描述全部塞进 supervisor 的 prompt——**千 token 级别的常驻开销 + 选择无置信度**（模型不会告诉你它“不确定”选哪个，只会硬选）。所以需要回答：能不能度量路由准确率（否则无法优化）、能不能先规则硬匹再 LLM（降成本）、置信度低时能不能反问（不乱猜）。

**回答思路**：路由是多 Agent 的第一道关。路由错了后面全错，但**路由错误的表现是"Agent 答不对"，极难归因**。所以路由必须**可度量**，否则无法优化。

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
- **O14.2** 构建结构化路由集，不只标一个“正确域”，还要标 `acceptable_decisions`、必要/可选/禁止 Agent、缺失 slot、Handoff 必填字段和调用偏序；样本来自生产 Trace、Agent 能力边界组合、线上错误回流和对抗改写；
- **O14.3** 路由 Trace 记录 `decision/available_agents/selected_agents/arguments/profile_versions/是否被用户纠正`，第一步决策后立即评分；完整 ReAct 结束后再评轨迹与业务结果，避免子 Agent 错误污染 Supervisor 指标；
- **O14.4（新增，成本极低）** **Agent 配置 lint**：入库时校验 `profile` 非空、长度下限、必须包含"何时使用"描述。**在 LLM 驱动路由的架构下，`profile`/`use_cases` 的地位等同于函数的 doc comment——它不是文档，它是被执行的输入。**

**怎么衡量，不能只答 Accuracy**：

| 层次 | 指标 | 解决的问题 |
| --- | --- | --- |
| 决策 | Decision Accuracy、Macro-F1、混淆矩阵 | 该直答、澄清、拒绝还是委派 |
| 单 Agent 路由 | Top-1、Macro-F1、Top-K Recall | 是否选对专业 Agent |
| 多 Agent 路由 | Agent Precision/Recall/F1、Jaccard、Exact Set Match | 是否漏调或乱调 Agent |
| 澄清/拒识 | Clarification P/R、Out-of-Scope Recall、误接受率 | 不确定时是否乱猜，越权时是否拦截 |
| Handoff | Required Slot Recall、Slot Value Accuracy、约束保留率 | Agent 选对但任务参数是否传错/传漏 |
| 轨迹 | 必要/禁止调用、偏序满足、重复/循环率 | 拆分和调用顺序是否合理 |
| 结果 | Task Success、`P(Success | Route Correct)` | 区分 Supervisor 错误与子 Agent 错误 |

现有 `tool_sequence_match` 只是 candidate 与 baseline 工具名序列的 LCS，不能代表路由准确率：Baseline 也可能错，正确路径也可能不唯一，而且它不检查 `subagent_type`、Handoff 参数、澄清和最终状态。应新增确定性的 `supervisor_decision/supervisor_route/delegation_argument/trajectory_constraint/task_outcome` scorer；语义保真等无法规则化的部分再用经过人工校准的 custom scorer skill。完整 Case、评分时点、配置示例和线上看板见 [机制篇：Supervisor 的意图识别评测](../01-机制原理/05-机制篇-Agent评测与评测体系.md#56-多-agent-特有评测supervisor-的意图识别不能只看分类-accuracy)。

**90 秒面试回答**：

> Supervisor 不是一个普通单标签分类器，它要决定直答、澄清、拒绝还是委派，还可能拆成多个子任务。因此我不会只看总体 Accuracy，而会分层评估：决策层看 Macro-F1 和混淆矩阵；单路由看 Top-1，多路由看 Agent Precision/Recall/F1；Handoff 看租户、资源和时间范围等 slot 是否传全传对；轨迹看必要、可选、禁止 Agent 与偏序约束；最后看 Task Success 和路由正确条件下的成功率。第一步 Tool Call 出来就评 Supervisor 决策，完整 ReAct 结束后再评轨迹和业务结果。Case 主要从生产 Trace、能力边界、线上失败和对抗改写中来，人工确认 Gold；每个线上误路由都沉淀为回归样本。TCUM 当前只有工具序列 LCS，下一步应补结构化 route trace 和确定性 route scorer，把路由问题和子 Agent 能力问题真正拆开。

---

## Q15. 子 Agent 上下文如何隔离？

**为什么会有这个问题**：这里存在两难。完全隔离时，告警专家已经得到的告警时间和实例 ID 无法自动交给指标专家，后者必须重新查询；完全共享时，大量无关历史会干扰子 Agent，并显著增加 token 成本。另一个约束是 prompt cache 依赖稳定前缀，重新组织整段上下文可能失去缓存收益。因此上下文继承应分档：只传结构化任务包、传相关历史切片，或在确有必要时共享完整历史；每档都应记录 token、缓存命中和任务正确率。

**回答思路**：隔离带来干净和并行，但也带来信息丢失。**关键权衡：子 Agent 需要多少前因后果？** 而prompt cache 又给"共享前缀"带来了额外的成本动机。

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

**为什么会有这个问题**：tcum-ai 的多个 Agent 和服务可能跨进程部署，部分子 Agent 在长时间推理时不输出中间 chunk；如果 A2A 只用固定 idle timeout 判断存活，就可能把“仍在计算”误判为“已经卡死”。跨服务后，Langfuse trace 还可能被拆成多段。需要回答三个问题：如何用业务心跳区分忙与卡死、断线后如何保存中间状态、如何透传 `traceparent` 串起跨进程链路。具体 Agent 数量、机器地址和超时时间必须以配置或 trace 为准，不在面试稿中暴露内部地址。

**回答思路**：跨进程 Agent 通信的三个稳定性问题：**超时判定**（"在忙"和"卡死"怎么区分）、**断线恢复**（中间结果保不保）、**可观测性**（trace 能不能跨进程串起来）。

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

**为什么会有这个问题**：当工具分散在多个服务、又需要被不同团队复用时，每家维护一套 SDK 会造成重复实现和升级困难；以 MCP Provider 暴露统一协议可以降低耦合。同时，tcum-ai 还需要作为 Consumer 接入外部 MCP，因此连接管理、鉴权和契约兼容都变成双向问题。工具和服务数量应从当前配置生成清单，不把一次统计写成永久常量。

**回答思路**：MCP 是 2024 末以来的事实标准。作为 Consumer 关注**连接管理与鉴权**；作为 Provider 关注**契约稳定性**。双向都做的项目很少。

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

# 四、知识、记忆与幻觉（Q18~Q22）

> **对照通用视角**（详见 [08](./08-面试题库-通用Agent深度专题.md) 二部分 Q41~Q44）：Working memory vs Long-term memory 边界、RAG 作为工具 vs 作为上下文预注入的取舍、Memory 更新一致性（模型主动写 memory 的容错）、Skill/Plugin 注入时机（启动期 vs 运行时）。**自进化追问**：CLAUDE.md 自更新如何做——见 [08](./08-面试题库-通用Agent深度专题.md) 三部分。

## Q18. RAG 检索质量如何保证？

**为什么会有这个问题**：监控元数据检索里 BM25 与 kNN 分数直接相加，但两者量纲不同，BM25 可能淹没归一化后的向量分；`ScoreThreshold` 未配置时还会固定返回 TopK，把不相关候选一起放进 prompt。更隐蔽的问题是缺少周期回归集，检索退化往往只能靠用户反馈发现。因此评审 RAG 不能只看“用了混合检索”，而要分别验证召回、融合排序、阈值和索引一致性。

**回答思路**：RAG 的效果由四环决定：**召回（能不能找到）、排序（相关的在不在前面）、阈值（不相关的有没有被挡住）、一致性（索引与查询用同一个向量空间吗）**。任一环坏了整体失效，而且**大多是静默失效**。

| | 做法 |
|---|---|
| **TCUM-AI** | **两套完全独立的 RAG**：**体系 A（监控元数据）** `usercases/obs_agent/rag/`，自建 ES8（eino-ext es8 indexer/retriever），进程内自算 embedding（混元/Venus/OpenAI 三选一），索引 `metric_meta`/`barad_metric_meta`/`cls_topic_meta` 三个**同构**索引（只差索引名 + 过滤字段 + 数据源），`RetrieverConfig.TopK: 5` 但 `FindMetrics` 调用时按路传 **20**，`Hybrid: true`，**`RRF: false`**（注释：*RRF only available with specific licenses*），`ScoreThreshold` **未设置**，Indexer `BatchSize: 10`，灌库靠 `embedding_job` **每 5 分钟全量重建**；**检索层有双路 query + 位次融合**（见下方亮点 3）；**体系 B（通用知识库）** `pkg/rag/` + `usercases/kb_server/`，走 **trag 平台**（内部向量检索 PaaS，HTTP API），embedding 与切分都在 trag 侧 |
| **CC** | 主要靠文件系统检索（grep/glob）+ 语义搜索，**编码场景对向量 RAG 依赖低** |
| **Codex** | 同上——**代码检索用ripgrep 比向量检索更准**。`AGENTS.md` 承载"不可从代码推断的知识" |
| **OpenClaw** | 记忆/知识章节存在但首页未展开（**未证实**） |

**差异本质**：**这一问上TCUM 与另三家不可直接对比**——CC/Codex 是编码 Agent，语料是代码（结构化、可精确匹配），用 grep 优于向量；TCUM 面对的是"数千个监控指标的自然语言描述"，**必须靠语义检索**。所以 TCUM 在这块的技术债是**独有的、也是必须自己解决的**。

**TCUM 亮点**（完整链路详见 [`05-场景篇` §8](../02-场景案例/05-场景篇-总览与监控域.md)）：
1. **两套体系分工合理**：监控元数据是“一条指标元数据对应一个文档”的结构化检索（自建 ES8 可控），通用文档走 PaaS（不重复造轮子）；
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

**为什么会有这个问题**：产品告警流程变更后，如果知识库里的旧文档仍然有效，Agent 可能继续引导用户访问已下线的看板。切分过细还会破坏表格或字段上下文，切分过粗又会超出预算；如果 chunk 与源文件没有版本和删除关系，废弃内容只能人工清理。因此需要同时设计结构感知切分、来源版本、失效时间和删除传播。

**回答思路**：切分决定检索片段是否可用；**失效机制决定会不会"按已废弃的方案处理故障"**——后者在运维场景是真实风险。

| | 做法 |
|---|---|
| **TCUM-AI** | **体系 A 不存在切分**：`MetricMetaToDocument()`（`meta_service.go:321`）把**整条指标元数据 JSON 序列化后作为一个文档**，`doc.ID = "{stack}:{type}:info:{metric}"`。**这是合理的**——元数据检索天然是一条指标元数据对应一个文档，不是长文检索，没有 chunk size/overlap 概念。**体系 B** 走 trag：`CreateCollection`/`UpsertDocuments`/`DeleteDocuments`/`ImportFile`/`GetImportState`/`GetCollectionMeta`，**切分由 trag 侧负责（黑盒）**。Embedder 工厂：`cloud_hunyuan` / `venus_proxy_api`（`DefaultTimeoutSeconds=60`）/ `openai` |
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

**为什么会有这个问题**：早期直接对外宣传了“三层记忆体系”，但实际自己看代码发现一个尴尬事实：**记忆表 `Source`/`Confidence`/`HitCount`/`TTL` 六字段齐备，但写入回路全缺“——表结构全对、回路全无**。写一定靠人手动发布、自动识别“Agent 学到什么新东西”的机制不存在。而且实际代码里是会话历史/会话摘要/skill 缓存/记忆条目 **四个松散机制**，无统一记忆抽象。面试官一追问“写入能不能自动”就穿帮。所以需要回答：写什么（提取规则）、怎么写（自动 vs 手动）、召回成本、**冲突与过期怎么办**——项目重构后一条老记忆变成误导，谁负责让它失效。

**回答思路**：记忆要回答四问：**分几层（生命周期）、写什么（提取规则）、怎么召回（成本）、冲突怎么办**。绝大多数项目只做了"存对话历史"就号称有记忆系统。

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
0. **⚠️表结构全对，闭环全缺（最该主动说的一条）**：`Source` 恒为 `manual`（全仓无 `"auto"` 写入路径）、`HitCount`/`LastHitAt` 命中后**无任何 +1 逻辑**（只在 PO↔PB 转换里出现）、`Confidence` 创建时置 1.0 后**永不改变**、`TTL` **没有任何清理任务读它**。即"怎么用"这一环做得不错，但"谁来写"和"怎么退化"两环是空的。另外反馈数据（`Rating`/`Tags`/`Comment` → `LikeTopTags`/`DislikeTopTags`/环比）**唯一消费者是运营周报，不回流prompt/记忆/路由**——**把反馈做成了报表，没做成回路**。详见 [`10-对抗机制与自进化.md`](../05-演进与对比/10-对抗机制与自进化.md) §2.4/§2.5（含 CC `extractMemories` 分叉 Agent 自动提取、"可推导即不存"排除原则、新鲜度警告的完整抄法与三阶段落地）；
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

**为什么会有这个问题**：长任务遇到整体 deadline 或 SSE 断线后，仅仅把历史消息重新交给模型，并不能回答两个关键问题：已经执行的工具是否需要重跑、半途生成的结果如何从断点继续。多端同时向同一会话写入还可能造成消息交错。若日志只保存最终消息而没有完整事件流，事后也无法重放当时的决策。因此必须明确并发写入、断点恢复和事件审计三类语义；具体超时时间以部署配置为准。

**回答思路**：三个问题：**并发写会不会互相覆盖、断线能不能续、事后能不能重放当时的决策**。

| | 做法 |
|---|---|
| **TCUM-AI** | 会话与消息落 DB（`dialog_history_service.go`）；`agent_config_cache.go` 配置缓存 + 熔断（阈值 3）；AG-UI SSE 有心跳；`CompactEvents` 持久化时合并 chunk。**`CheckPointStore` 未配置**（`DefaultAgent.Resume` 已转发但无 store） |
| **CC** | `sessionStorage.ts` 存储策略 + **`conversationRecovery.ts` 断点续传** + **事件溯源**（可精确重放） |
| **Codex** | 会话可resume（`codex resume`）；`~/.codex/` 下存会话记录 |
| **OpenClaw** | **Gateway 是 sessions 的 single source of truth**，进程常驻天然持有会话状态；多客户端（CLI/Web/macOS/移动）接同一 Gateway，**会话状态天然一致** |

**TCUM-AI 的 Session 实现细节（源码核验）**：双表 + 渐进式 Period 摘要，是四家里唯一"服务端 DB + 时间衰减摘要"的路线。

1. **存储双表**：`dialog`（会话元数据：`user/agent/source/agent_config/digital_twin_id` + 四个压缩字段 `Summary / SummaryMsgCount / SummaryUpdatedAt / SkillCache`）+ `dialog_message`（消息流水：`role: user/assistant`，`content: user 是纯文本 / assistant 是 AGUI 事件 JSON 数组`，`status: running/completed/failed`）。
2. **多轮装配**（`agent_service.go: buildRequestParams`）：每次请求按序注入 ① `<conversation_summary>`（若 Summary 非空）→ ② `<skill_context>`（SkillCache 中 Distance ≤ MaxDistance 的结果，过期标"内容已过期"）→ ③ **只加载 `[SummaryMsgCount, ∞)` 的增量消息**（已摘要部分不重复加载）→ ④ 当次输入。
3. **渐进式摘要触发**（`dialog_history_service.go: MaybeSummarizeAndSave`）：消息追加后异步触发（goroutine + 60s timeout，不阻塞主链路）；未摘要数 ≥ `summarizeThreshold = 10` 才启动；永远保留最近 `reserveRecentCount = 6` 条原文。
4. **Period 分层摘要（独门）**：摘要非 flat string，而是追加 `<period from=".." to=".." msg_range="X-Y">…</period>` 段落，Period 超上限走 `mergePeriods` 合并压缩——形成"越老越粗、近期细节丰富"的时间衰减结构。
5. **恢复能力**：会话级可恢复（`dialog_id` 是入口，任意实例拉起继续聊）；AGUI 事件级持久化（前端刷新可重放完整工具调用轨迹）；但单 turn 崩溃不可续（`status: running` 消息残留）。

**四家 Session 管理深度对照**（OpenClaw 走"进程常驻内存态"、几乎不需要"恢复"，单独成行，不参与下面这条"持久化+恢复"维度线）：

| 维度 | TCUM-AI | CC | Codex | deepseek-harness（dsh） |
|---|---|---|---|---|
| 存储位置 | MySQL 双表 | 本地 JSONL | OpenAI 服务端 | append-only session log |
| 持久化粒度 | 消息（AGUI 事件级） | 一行一 message | response 链 | 事件（比消息更细） |
| 压缩机制 | 分 Period XML 追加式 | `/compact` 手动替换 | 服务端自管 | Compaction 三件套 + 逻辑跳过 |
| 压缩触发 | 未摘要≥10 自动异步 | 用户手动 | 服务端 | 显式 checkpoint |
| 多轮装配 | Summary+SkillCache+增量消息 | 本地全量重放 | `previous_response_id` 引用 | `deriveMessages()` 纯投影 |
| 崩溃恢复 | 会话级可恢复 | 进程崩溃可续 | 服务端保存 | 可恢复 + 可多分叉投影 |
| KV Cache 亲和 | 中（Summary 变化破前缀） | 中（compact 破前缀） | 极高（服务端做） | 极高（架构级保障） |
| 审计能力 | 消息可查 | JSONL 可看 | 差（不透明） | 极强（事件流全保留） |

> **一条面试主线**：Session 管理同时决定 **存储成本 / 多轮装配 / KV Cache 命中 / 崩溃恢复 / 并发隔离** 五件事。TCUM 的独门是"分 Period 时间衰减摘要"，代价是每次装配读 DB；若重做可向 dsh 靠——把 `dialog_message` 从"消息模型"改成"事件流模型"，让摘要与装配变纯函数投影，用副本表存投影结果消除读 DB 延迟。dsh 的 session 维度详见 [08](./08-面试题库-通用Agent深度专题.md) 第一部分（那里重点讲 KV Cache，这里补的是持久化/恢复维度）。

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

**为什么会有这个问题**：可以概括为“看似有据，实则仍可能编造”。当工具结果已经截断时，模型可能把局部样本外推成全量统计；`FindMetrics` 返回候选指标后，模型也可能使用一个不在候选列表中的常见指标名。`BuildTCUMDashboard.expr` 是自由文本，如果生成链路没有强制校验，调用过检索工具也不代表最终表达式受其约束。因此输入侧要标明截断和召回边界，输出侧要对指标白名单、PromQL parser 和工具证据做确定性校验。

**回答思路**：Agent 的幻觉比纯 LLM 更危险——因为它有工具，**看起来"有数据支撑"，实际可能是把不相关的检索结果编成了结论**。控制要从"输入侧（别喂噪音）"和"输出侧（强制溯源）"两头做。

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

---

# 五、安全与权限（Q23~Q25）

> **对照通用视角**（详见 [08](./08-面试题库-通用Agent深度专题.md) 二部分 Q45~Q47）：Prompt injection 防御的三层法（输入侧过滤 / 系统提示强化 / 输出侧校验）、敏感操作的 confirm 流程（HITL 断点）、Secrets 泄漏防御（.env 通配符过滤 + 白名单目录）。

## Q23. 工具执行有权限控制吗？危险操作如何拦截？

**为什么会有这个问题**：一个真实发生的事故（写到了优化编年史里）——Agent 回写大盘时 Name 为空，导致线上大盘名称丢失**并被移到根目录**，最后的解法是直接拒绝空 Name——**护栏是被事故逼出来的，不是设计出来的**。在企业内网 SaaS 场景里Agent 一旦能调修改类接口，“一个小 bug 可以变成 100 个客户的事故”。而当前权限依靠 IAM/CAM 在后台 API 层的鉴权，**tcum-ai 自己没有工具级白名单，没有危险操作弹框，没有 HITL 审批**。所以需要回答：鉴权边界在哪（Agent 能不能基于“模型当前想调”就直接调写接口）、**写操作能不能开“二次确认”**（人在回路上）、一旦确定需要确认能不能断点续跑（而不是当场就卡住）。

**回答思路**：这是 Agent 领域**唯一不能靠"以后补"的问题**。Agent 的自主性本质就是"把决策权交给一个不可完全预测的系统"，而权限体系是唯一的边界。判断一个 Agent 系统是否"生产就绪"，看这一条就够了。

**核心风险链**：Agent 有工具 → 工具能写 → 上下文可被外部内容污染（告警内容/CMDB 备注/日志/工单描述）→ **prompt注入直接转化为生产事故**。

| | 做法 |
|---|---|
| **TCUM-AI** | ⚠️ **全仓搜索 `readonly`/`writeOp`/`dangerous`/`approval`/`confirm`/`二次确认`，除白名单在MCP 过滤与截断中间件语境下的使用外，未发现任何权限决策或危险操作拦截实现**。仅有两处粗粒度控制：① `TwinSoulMiddleware` 按"是否 admin"过滤 5 个 `adminOnlyTools`（`ListMyDigitalTwins`/`GetDigitalTwinDetail`/`UpsertDigitalTwin`/`DeleteDigitalTwins`/**`ExecuteSQL`**）；② `DynamicTaskTool`/`filteredSkillBackend` 的 allowlist（**权限落在"工具存在与否"，未授权的从一开始就不在 map 里**——这个思路是对的）。`compose.ExtractInterruptInfo`/`CompositeInterrupt` 提供了 interrupt 的**技术能力**，但**业务侧未用它做审批**，且 `CheckPointStore` 未配置 |
| **CC** | **六种权限模式构成策略梯度**：`plan`（仅只读）/ `default`（逐条确认）/ `acceptEdits`（自动允许低风险）/ `auto`（分类器判定）/ `dontAsk`（询问转拒绝，适合无人值守）/ `bypass`（跳过多数检查）。**关键：`bypass-immune` 检查**——即使最宽松模式下三类不可绕过（工具级 deny 规则、用户显式配置的 ask 规则、敏感路径检查）。另有 `bashClassifier.ts` + `yoloClassifier.ts` 分类器、`dangerousPatterns.ts` 规则引擎、`PermissionRule.ts` 匹配算法、`pathValidation.ts` 路径验证、**`denialTracking.ts` 拒绝追踪与自适应**、`filterToolsByDenyRules` **前置过滤**、`autoModeCircuitBroken` 熔断式故障安全 |
| **Codex** | **两个正交维度的矩阵，是四家里最清晰的模型**：<br>**`sandbox_mode`**：`read-only` / `workspace-write` / `danger-full-access`（沙箱能力边界）<br>**`approval_policy`**：`untrusted`（跑任何东西前都问）/ `on-request` / `on-failure`（失败才问）/ `never`（人机协作策略）<br>推荐组合 `workspace-write` + `on-request`；另有 `rules`（精确控命令级allow/deny）与 **permission profiles（Beta）**、`--profile` 切换多套配置 |
| **OpenClaw** | 面向"消息入口"的权限：**`allowFrom` 发送者允许列表**、**`requireMention`（群聊需@ 才响应）**、`mentionPatterns`、**tokens**、渠道 **access groups**；网络侧**默认只绑 127.0.0.1**，远程需显式配SSH/Tailscale。ClawHub 插件有 **trust 指南与策展**。**整体是"最小暴露面 + 谁能跟它说话"的权限模型，而非"它能做什么"的工具级权限（未证实是否有工具级审批）** |

**差异本质（这是整份文档最重要的一张表）**：

| 维度 | TCUM-AI | CC | Codex | OpenClaw |
|---|---|---|---|---|
| **谁能用**（入口鉴权） | ⚠️ 服务身份，见 Q25 | 本地用户 | 本地用户 | ✅ allowFrom/access groups |
| **能力边界**（沙箱） | ⚠️ skill_exec 沙箱强度未确认 | ✅ sandbox/ | ✅ **seatbelt(macOS)/landlock+seccomp(Linux) 三档** | ✅ 默认本地绑定 |
| **单次操作审批**（HITL） | ❌ **完全没有** | ✅ 六模式 + bypass-immune | ✅ **四档 approval_policy** | 未证实 |
| **命令危险模式检测** | ❌ 自由 bash 无检测 | ✅ 三重（分类器+规则+AST） | ✅ rules（Beta） | 未证实 |
| **拒绝后自适应** | ❌ | ✅ denialTracking | ⚠️ | 未证实 |
| **故障安全熔断** | ❌ | ✅ autoModeCircuitBroken | ⚠️ | 未证实 |

**Codex 的"两维矩阵"最值得 TCUM 抄**，因为它把两件容易混淆的事分开了：
- **沙箱**回答"**技术上能做到什么**"（进程级强制，模型绕不过）；
- **审批** 回答"**流程上允许做什么**"（人在环）。

TCUM 现在两个维度**都缺**：沙箱强度未确认（技术边界不清），审批完全没有（流程边界不存在）。

**TCUM亮点（虽少但有）**：
1. **"权限落在工具存在与否"的思路是对的**——未授权子 Agent/skill 从一开始就不在 map 里，即使 prompt 注入让模型硬编名字也会被拒绝（`subagent type %q not found or not authorized`）。这比"先给工具再运行时判断"安全一个量级；
2. **`filteredSkillBackend` 的拒绝带审计日志**（agent/skill/user/session 全记）——是全项目唯一有权限审计的地方；
3. **`toolErrorHandlerMiddleware` 为interrupt 预留了透传**（`IsInterruptRerunError` 不兜底）——说明设计时**为 HITL 留了口子**。

**TCUM 不足（这是全文最严重的缺陷）**：

一个能调 128 个工具（含云 API）的运维 Agent，若工具集含任何写操作，意味着：
1. **模型可自主执行生产变更，无任何人工确认**；
2. **Prompt 注入可直接转化为生产事故**——攻击面极其实际：告警内容、CMDB 备注、日志内容、工单描述都会进上下文；
3. **无操作边界表达能力**——无法说"这个 Agent 只能读、那个可以改测试环境但不能改生产"；
4. **爆炸半径不可控**——一次循环最多 30 轮，理论上可执行 30 次写操作；
5. **`ExecuteSQL` 在工具集里**——虽在 `adminOnlyTools` 名单，但只靠"是否 admin"一个布尔量控制太粗。

**而且这个缺陷是"正在恶化"的**：从场景篇能看到能力演进曲线是 **只读分析（2025-12）→ 配置生成（2026-03Grafana/2026-05 巡检项）→ 无人值守自主执行（2026-06 数字分身）**，**风险等级持续上升，而权限体系停在原地**。

**解决思路（按落地顺序）**：

- **O23.1（P0）权限模式体系**：至少实现 `plan`（只读）/ `default`（逐条确认）/ `dontAsk`（无人值守场景，询问转拒绝）三档。**并明确 bypass-immune 项：生产环境写操作、删除类操作、跨租户操作，任何模式下都必须人工确认**；
- **O23.2（P0）工具风险分级**：`readonly`/`write_low`/`write_high`/`destructive` + `env: test|prod`。分级来源：
  - **云 API 可从action 名自动推断**（`Describe*`/`List*`/`Get*` → readonly；`Delete*`/`Terminate*`/`Destroy*` → destructive）——**这一条能覆盖 `pkg/capi` 批量转换的绝大部分工具，成本极低**；
  - MCP 工具注册时**强制声明**，未声明默认按 `write_high`（**fail-safe**）；
- **O23.3（P0）HITL 审批**：配`CheckPointStore` → 对 `write_high`/`destructive` 触发 `CompositeInterrupt` → 前端弹确认（展示"**将要执行什么、影响哪些资源、预期结果**"）→ 用户确认后 resume。**技术底座已有，是杠杆最大的单点改动**；
- **O23.4** 前置拒绝（对标 `filterToolsByDenyRules`）：把工具列表给模型**之前**剔除无条件禁止的工具——避免无意义调用，顺带省 token；
- **O23.5** 熔断式故障安全（对标 `autoModeCircuitBroken`）：检测到连续多次危险操作尝试或注入特征，**锁死在安全侧且不允许自动恢复**，需人工解除；
- **借鉴 Codex（强烈推荐）**：直接采用"**sandbox_mode × approval_policy**"两维模型，并做成 Agent 级配置 + 用户级 override。运维域的等价映射：
  - `sandbox_mode`: `readonly` / `test-env-write` / `prod-write`
  - `approval_policy`: `always` / `on-destructive` / `on-failure` / `never`

---

## Q24. 有沙箱隔离吗？

**为什么会有这个问题**：告警汇总和 SLO 分析可能需要用 pandas 做聚类或统计。直接让模型估算长数组不可靠，为每种需求都在 Provider 侧开发专用工具又缺少灵活性；给模型 Python 沙箱则会引入宿主机、文件、网络和子进程风险。在内网环境中，一个不受控 HTTP 请求还可能把沙箱变成访问内部系统的跳板。因此必须同时回答进程隔离、文件系统、网络出口和资源配额，不能只说“用了容器”。

**回答思路**：给模型一个 shell 是能力的巨大跃升，也是风险的巨大跃升。沙箱要回答四问：**进程隔离、文件系统边界、网络出口、资源配额**。**网络出口最容易被忽略，但在企业内网环境后果最严重**（内网跳板）。

| | 做法 |
|---|---|
| **TCUM-AI** | `pkg/agent/skill_exec.go` 提供 `skill_exec` 工具在**沙箱**中执行 skill 脚本。环境变量约定清晰：`$SKILL_DIR`（源码目录，cwd）/`$WORKSPACE_DIR`（可写）/`$SKILL_OUT_DIR`（产物）。**`stdin` 设计优秀**：大段内容经**文件系统预写入 + 管道注入**，**同时解决 shell 转义安全与消息体大小限制（`ARG_MAX`）两个问题**。⚠️ **但隔离强度、网络策略、只读挂载、资源 quota 均未在代码中明确确认**；`command` 是**自由 bash**，无命令分类、无危险模式检测、无路径校验 |
| **CC** | `sandbox/` 命令隔离 + **`bashClassifier.ts` 命令分类 + `dangerousPatterns.ts` 规则引擎 + AST 静态分析** 三重防护 + `pathValidation.ts`（符号链接解析、目录逃逸防御）+ 信任链（trust dialog → bypass permissions 层级）+ `policyLimits/` 企业级策略 + `secureStorage/` 凭证保护 |
| **Codex** | **OS 级强制沙箱，四家里最硬**：macOS 用 **Seatbelt**（`sandbox-exec`），Linux 用 **Landlock + seccomp**；`sandbox_mode` 三档；`[sandbox_workspace_write] network_access = true/false` **显式控制网络出口**；Windows 有专门的 sandbox setup。**"命令失败提示 retry without sandbox"这个报错本身就说明沙箱是默认强制的** |
| **OpenClaw** | 默认只绑 `127.0.0.1`（最小暴露面）；远程走 SSH/Tailscale 而非公网；插件有 trust 层。**但它本身运行在用户自己的机器上，隔离模型是"信任本机"** |

**差异本质**：**Codex 的方案在"技术强制"上最强**——OS 内核级隔离，模型和它生成的脚本**在技术上无法绕过**，而不是靠规则匹配。CC 是"规则 + 沙箱"双层。TCUM 是"沙箱（强度未明）+ 无规则"。

**特别值得注意的是 Codex 的 `network_access` 开关**——它把"是否允许出网"做成了一个显式配置项。这正是 TCUM 最该确认的一项：**若`skill_exec` 沙箱能自由出网，那么它就是一个内网跳板**（能访问元数据服务、能横向访问其他内部系统）。而TCUM 的场景里模型**确实需要出网**（下载 COS 数据），所以正确形态是**白名单出网**（只允许 COS 域名 + 必要的内部 API）。

**TCUM 亮点**：
1. **`stdin` 的文件系统预写入 + 管道注入**——一个设计同时解决转义安全与大小限制，是本项目公认的亮点；
2. 环境变量三分（源码只读区 / 可写工作区 / 产物输出区）**在语义上是对的**，说明设计时有隔离意识；
3. **沙箱是 COS 卸载机制的必要组件**——不是为了"给模型 shell 玩"，而是为了"把大数据的计算下沉到沙箱"，**用途明确、边界相对可控**（脚本主要做数据处理）。

**TCUM 不足**：
1. **隔离强度未确认**（P0 待核实）：容器 vs 同进程？网络受限吗？`$SKILL_DIR` 只读吗？CPU/内存/时长/磁盘 quota？
2. **`command` 是自由 bash 且无任何危险模式检测**——`rm -rf`、`curl | sh`、反弹shell、读凭证文件全无拦截；
3. **无路径校验**（符号链接、`../` 逃逸）；
4. **未确认是否注入云凭证**——若注入了长期 AK/SK，风险倍增。

**解决思路**：
- **O24.1（P0）** 明确并加固沙箱边界：**容器级隔离 + 默认拒绝出网（仅白名单域名：COS + 必要内部 API）+ `$SKILL_DIR` 只读挂载 + 资源 quota（CPU/内存/时长/磁盘）+ 无长期云凭证注入（如需用最小权限临时凭证）**；
- **O24.2** 命令分类器 + 危险模式规则引擎（对标 `bashClassifier.ts`/`dangerousPatterns.ts`）：正则/AST 拦截 `rm -rf /`、管道执行远程脚本、反弹 shell、凭证文件读取；或直接走**命令白名单模式**（只允许 `python3`/`jq`/`curl`（限白名单域）等）——**考虑到 TCUM 的沙箱用途是"数据处理"，白名单模式的可用性代价很小**；
- **O24.3** 路径校验（对标 `pathValidation.ts`）：解析符号链接、防目录逃逸；
- **借鉴 Codex**：把 `network_access` 做成**显式配置项**并默认 `false`，需要出网的 skill 显式声明所需域名。

---

## Q25. 用户身份如何透传？有审计吗？

**为什么会有这个问题**：一个真实侧背震惊的 case——数字分身场景，**分身代用户启动一个定时任务去搜云上 API，如果直接注入 admin token，Agent 能玩真的看到公司全部资源**——这不仅是技术问题而是合规红线。而且事后开安全扫描时发现**一个很隐蔽的 case**：分身 A 把一些数据写到了会话历史里，分身 B 后面接手同一个会话——分身 B 看到了 A 不该看到的东西（因为历史里存的是"会话级"而非"执行者级"）。所以需要回答：**操作以谁的身份执行**（数字分身场景难点：执行者是分身、授权者是管理员）、**跨服务传递能不能不丢 principal**（trpc 链路、A2A/AGUI 子 Agent）、**审计能不能反无可抵赖**（日后与当事人对峙的能力）。

**回答思路**：Agent 代替用户操作，那**操作以谁的身份执行**？直接决定两件事：**越权风险（AuthZ）**和**审计可追溯性**。在多租户企业平台上这是合规红线，不是"技术优化"。

| | 做法 |
|---|---|
| **TCUM-AI** | ⚠️ **在 `pkg/mcp` 中搜索 `staffName`/`operator`/`userID`，结果为空**。MCP 侧鉴权靠 `Authorization: Bearer ${TCUM_TOKEN}`（`dynamic_mcp_middleware.go` 的 header 占位符机制）；`pkg/mcp/aksk_resolver.go:263` 的 AK/SK 选择是**启发式**（最近创建 / 优先白名单 / Remark 匹配）。有身份基础设施但未贯穿：trpc filter `pkg/trpc/userregister/user_register.go:59` 用 TAI 解析用户身份；`user_inject` 中间件注入用户 ID 到 prompt；`ForwardedProps["userId"]` 用于 Langfuse trace |
| **CC** | 本地单用户模型（进程即用户身份）；`secureStorage/` 凭证保护；`policyLimits/`/`remoteManagedSettings/` 企业集中管控；`审计与可追溯：日志、归因与诊断追踪` |
| **Codex** | 本地单用户；ChatGPT 登录或 API Key；操作在本地文件系统，天然是本机用户身份 |
| **OpenClaw** | **`allowFrom` 发送者允许列表**是身份的核心（手机号/账号级）；渠道 **access groups**；tokens。**因为是自托管个人助手，"身份"就是"谁能给它发消息"**，不存在多租户 AuthZ 问题 |

**差异本质（一个必须讲清的关键点）**：

> **CC / Codex / OpenClaw 都是"单用户"系统——进程属于一个人，身份问题天然不存在。TCUM-AI 是"多租户企业平台"——同一个服务进程同时服务多个用户、多个业务方、多个租户。这意味着 Q25 是TCUM 独有的、且必须自己解决的问题，无法从这三家借鉴现成方案。**

这一点在面试里非常有价值：它说明**你理解"企业平台"与"个人工具"在安全模型上的本质差异**，而不是简单照搬 Claude Code 的做法。

**TCUM 亮点**：
1. **身份基础设施是有的**——trpc filter 已用 TAI 解析身份、`user_inject` 已注入用户 ID、`ForwardedProps["userId"]` 已传到 Langfuse。**缺的是"贯穿到工具执行层"这最后一段**；
2. **`${VAR}` 占位符机制（如 `Bearer ${TCUM_TOKEN}`）+ per-request JWT** 已经提供了"用户维度 token 透传到 MCP"的**技术形态**——改造成本比从零做低得多；
3. `pkg/rag/trag/client.go` 有 **token 脱敏**的先例，说明团队知道敏感信息处理的做法。

**TCUM 不足**：
1. **工具执行很可能使用"服务身份"而非用户身份**，后果：
   - **越权风险**：A 用户可通过 Agent 查到本无权限看的产品数据（**CMDB 资产专家是风险最高的场景**——`"查看我名下机器"`这类查询若用服务身份，要么查不对要么查太多）；
   - **审计断链**：云 API 侧日志记录的是服务账号，无法追溯真实发起人；
   - 多租户/多业务方共用的运维平台上这是**合规红线**；
2. **AK/SK 选择靠启发式**（"选最近创建的"）——存在**选错凭证操作错账号**的风险；
3. **无操作审计日志**——谁在什么时候通过 Agent 做了什么，未见完整记录；
4. **`auth_config` 里的 token 明文存DB**（生产数据导出 CSV 里可见 `{"token":"a4dd8fc0..."}`）——违反 "Secrets: env-only" 原则。

**解决思路**：
- **O25.1（P0，合规）端到端身份透传**：ctx 贯穿 `Identity{staffName, staffID, tenantID, sourceIP, sessionID}`，并：
  - MCP 调用通过标准 header 透传（如 `X-Tcum-Operator`）——**复用现有 `${VAR}` 占位符机制即可**；
  - 云 API 使用**用户维度临时凭证或 STS扮演**，而非固定服务 AK；
  - 工具执行前做 AuthZ：`can(identity, action, resource)`；
- **O25.2（P0）全链路审计日志**：每次工具调用落审计——`时间 / 身份 / 会话 / Agent / 工具 / 参数摘要 / 结果状态 / 影响资源 / 是否经审批`，写独立审计存储，保留期按合规要求；
- **O25.3** 凭证选择确定性化：废弃"选最近创建"启发式，改为显式配置绑定（`product + env → secretId`），**未配置则拒绝执行而非猜测**；
- **O25.4（低成本，立刻做）** `auth_config` 只存**凭证引用**（`secret_ref: "knot/tcum_ai_assistant"`），真实 token 放密钥管理系统/环境变量；数据导出与日志自动脱敏（**复用 trag client 已有的脱敏能力**）。

---

# 六、可观测性与评测（Q26~Q28）

> **对照通用视角**（详见 [08](./08-面试题库-通用Agent深度专题.md) 二部分 Q35~Q40）：Agent 应采的核心 metrics（turn 数 / 首 token 延迟 / 工具失败率 / cache 命中率 / 幻觉率）、成本核算三层拆解（模型侧 / 工具侧 / 缓存侧）、Regression test 的三层防护（回归题库 / A/B 灰度 / 线上采样打分）。

## Q26. Agent 的可观测性做到什么程度？

**为什么会有这个问题**：早期遇到一个反复归不了因的那类 bug——同样的告警啊，今天能诊断明天就羊了。走服务日志只能看到“模型返回了什么”，但**看不到当时拼的 messages 长什么样、路由到了哪个专家、RAG 召回了什么**。后来接了 Langfuse，但也只自动拿到了 LLM/工具 span——**业务语义那一层（路由、检索、记忆、压缩、权限）必须手工埋**，而这些恰恰是归因时最需要看到的。不埋就只能看到前后两个黑盒模型调用之间发生了什么。所以需要回答：**自动 span 到什么粒度（够不够回答归因问题）、手工 span 不埋会丢什么**。

**回答思路**：Agent 是"不确定性系统"，可观测性不是运维需求而是**开发需求**——没有 trace 就无法回答"为什么这次答错了"。关键是区分**框架自动 span**（LLM/工具调用，接一个 handler 就有）和**业务语义 span**（路由/检索/记忆/压缩/权限，必须手工埋）。

| | 做法 |
|---|---|
| **TCUM-AI** | **Langfuse 全链路**：实现 eino `callbacks.Handler` + 一行 `callbacks.AppendGlobalHandlers` 零侵入注入；`observationID` 经 ctx 传递自动挂父子树（**并发工具因 ctx 分叉自动产生 N 个平行 span**）；`filteredLangfuseHandler` 装饰器过滤 Embedding/Indexer/Retriever 噪音；请求级 `ContextEnricher` 注入 trace name/userId/sessionId/Agent 级 Tags；`FlushInterval=200ms`/`Threads=5`/优雅退出 flush。**AG-UI 事件体系**面向用户侧可视化（`STEP_*` 子 Agent 边界 + `REASONING_*` + 前端三层级渲染 + Agent 执行栈）。`pkg/telemetry` 统一 Log/Metric/Trace |
| **CC** | 诊断追踪 + `startupProfiler.ts`/`fpsTracker.ts`/事件循环阻塞检测 + **事件溯源**（可精确重放决策链）+ `agentColorManager.ts`（多 Agent 视觉区分） |
| **Codex** | 终端可见的推理与命令执行过程；会话记录落`~/.codex/`；**"可观测性"主要靠"人看着"** |
| **OpenClaw** | Gateway 有 **诊断（diagnostics）与运维（ops）** 章节；Web Control UI 提供集中视图；`openclaw dashboard` 命令 |

**差异本质**：**TCUM 是四家里唯一有"服务端集中式 trace 平台"的**（因为它是多用户服务，必须能事后排查别人的会话）。CC/Codex 是本地工具，用户当场就看到了过程，不需要集中 trace。**这是 TCUM 的结构性优势，但只用了一半。**

**TCUM 亮点**：
1. **零侵入接入**——一行 `AppendGlobalHandlers`，业务代码全程无感知；
2. **`filteredLangfuseHandler` 的 `Needed` 处理有深度**——注释解释了"`Needed` 在组件调用前被调用时 info 可能未携带完整信息，因此始终委托内层，实际过滤在 `On*` 完成"；
3. **AG-UI 的多 Agent 可视化是四家里最完整的**：`STEP_STARTED/FINISHED` + 双区域分离 + 三层级渲染规则 + 前端 `StepName` 路径编码执行栈。**"多 Agent 好做，让用户看懂很难"，这块投入是真实的产品差异化**；
4. `CompactEvents` 存储合并——兼顾流式体验与存储成本。

**TCUM 不足**：
1. **业务语义 span 全部缺失**（P0）——只有框架自动的 LLM/工具 span，排查"为什么答错"时看不到路由决策依据、RAG 命中什么、记忆召回什么、压缩为何触发、权限如何判定；
2. **无成本追踪**——有 token counter 但无 token→成本换算与 `会话/用户/Agent/场景` 四维聚合；
3. **无 Agent 黄金指标**——缺轮次分布、终止原因分布、工具误用率 Top10、RAG 空命中率、压缩触发率、P95 延迟；
4. **无轨迹回放**——存最终态消息而非事件流；
5. **跨进程/跨平台 trace 断链**（Q16.3）——到 `AGUIAgent.Run` 就断，外部平台内部完全黑盒；
6. 两条 Langfuse 注册路径不一致（`agent_access/main.go:361` 注册的是**未过滤**的 handler）。

**解决思路**：
- **O26.1（P0）补齐业务语义 Span**：`route`（input/domain/confidence/latency）、`rag.retrieve`（query/index/topK/hits[{id,score}]/是否命中阈值）、`memory.recall`（scope/候选数/是否走 LLM rerank）、`context.compact`（触发原因/before-after tokens/耗时/压缩档位 T1~T4 或极限档/是否 fail-fast 跳过请求）、`tool.call`（name/参数摘要/状态/重试次数/下游耗时）、`permission.check`（tool/risk_level/decision/是否人工审批）、`llm.call`（model/prompt_tokens/completion_tokens/cost）；
- **O26.2** 成本账本：token→成本换算表（按模型），按四维聚合出日报作为优化 ROI 依据；
- **O26.3（有说服力的 dogfooding）** **Agent 黄金指标看板**——**用自家监控平台监控自己的 Agent**：轮次分布、终止原因分布、工具误用率 Top10、RAG 空命中率、压缩触发率、COS_URL 使用率、P95 端到端延迟；
- **O26.4** 落"决策事件流"，管理端按 `session_id` 回放完整链路；
- **O26.5** 统一两条 Langfuse 注册路径；trace context 跨进程传播（W3C `traceparent`）。

---

## Q27. 有评测体系吗？

<a id="q27-eval-suite"></a>

**回答原则**：不能再回答“完全没有评测”，也不能回答“已经有成熟质量门禁”。准确定位是：**已落地一个以 Skill 为中心的离线 Eval Runner，完成了真实执行、Trace 留存、规则/custom 评分和异步聚合；但数据集治理、可复现环境、Artifact 真值、重复试验、Judge 校准和 CI 准入尚未补齐。**

### 30 秒回答

> *“有，但目前是可工作的离线评测雏形，还不是发布准入系统。我们把 Suite/Case 拆开，每个 Case 创建 Trial，经 scheduler 调外部 AG-UI 专用 Agent 真正运行被测 Skill，从 SSE 收集最终文本、工具序列、reasoning、耗时和原始事件。内置 5 个规则型 scorer，再允许 custom scorer skill 做领域语义评分，最后按非 NA 维度加权聚合。它解决了‘能跑、能留证据、能看维度分’；当前主要欠环境与版本快照、结构化 ToolCall/Artifact 判定、同 Case 多次试验、Judge 校准以及 PR 自动门禁。”*

### 2 分钟实现回答

```text
TriggerRun
  → 读取 Suite 与 Case
  → 每个 Case 创建 1 条 Trial + 一次性 SchedulerTask
  → EvalTrialExecutor 解析 Skill ID、模型和环境变量
  → POST skill_evaluation_agent
  → 消费 AG-UI SSE
  → TrialTrace{TaskResult, ActualTools, ReasoningText, DurationMs, DialogTrace}
  → 5 个内置 scorer + custom scorer agent
  → 非 NA 维度加权聚合
  → Trial 落库
  → 全部 Trial 终态后聚合 Run
```

这里有两个常被追问的边界：

- **执行轨迹来自 AG-UI SSE，不是从 Langfuse 查询回来。** Langfuse 在正常 Agent 链路中承担观测；当前 Eval Runner 直接消费 `TEXT_MESSAGE_CHUNK`、`TOOL_CALL_CHUNK`、`REASONING_MESSAGE_CHUNK`、`RUN_STARTED/RUN_FINISHED` 等事件构造 Trace。
- 当前真正实现的是 `skill_direct` 和 `baseline_skill_compare`；`model_eval`、`agent_eval` 只有枚举/占位，不能说成已支持。

### 当前代码事实卡

| 维度 | 当前实现 | 面试边界 |
| --- | --- | --- |
| 服务形态 | 独立 `cmd/server/eval_suite`、controller、`usercases/eval_suite` 业务域 | 外部 AG-UI endpoint 被硬编码；“专用 endpoint”不等于源码能证明物理集群隔离 |
| 数据模型 | Suite、Case、Run、Trial、SchedulerTask、TaskLock 6 类持久化实体 | 还没有 DatasetVersion、RunManifest、Artifact 一等实体 |
| 执行次数 | 1 Case = 1 Trial | 没有 `trial_count=N`、方差、置信区间或 pass@k |
| 执行场景 | `skill_direct`、`baseline_skill_compare` | baseline 对比不是通用 Agent A/B 实验 |
| Trace | 最终文本、工具名序列、reasoning、耗时、原始 AG-UI 事件 | 工具参数/结果没有形成稳定结构化契约 |
| 评分 | 5 个内置规则 scorer + custom scorer skill | custom Judge 尚未系统校准 |
| 聚合 | `Σ(score×weight)/Σweight`，NA 不进分母 | 单一平均分无法表达 blocker、安全失败和切片退化 |
| 调度 | `pkg/scheduler` + DB lock 异步执行 | 没有 PR/MR webhook 自动触发 |

### 五个内置 scorer 在证明什么

| Scorer | 真实算法 | 能证明 | 不能证明 |
| --- | --- | --- | --- |
| `tool_sequence_match` | 与 baseline 工具名序列做 LCS，相似度归一到 0～100 | 是否漏掉较多工具、顺序是否大幅漂移 | 参数正确、结果正确、另一条更优路径 |
| `keyword_match` | must 命中比例；forbidden 命中直接 0 | 文本包含必要标记、没有禁语 | 语义和数值正确 |
| `output_schema` | 最终文本解析 JSON，统计 required fields | 输出契约形状 | 字段值正确 |
| `duration` | 阈值内 100，超限后指数平滑衰减 | 明显时延退化 | 排队/下游瓶颈归因 |
| `token_cost` | reasoning + final text 的字符近似 Token；超限平滑衰减 | 明显冗长 | 精确账单、工具 Token、缓存收益 |

`custom` 不在本地 `scorer.Engine` 里完成：Engine 先放一个 NA 占位，Executor 再调用 `eval_scorer_agent` 加载指定 `scorer_skill`，解析 `{score, detail, evidence}` 后替换该维度。

### 为什么从“扣分制 + completeness Judge”改成量化 scorer

代码迁移痕迹表明，早期设计中的 `eval_suite_revisions`、`eval_scores`、`pass_rate`、`trial_count` 等结构被删除；当前实现改为 Suite 自身版本、Case 独立版本、量化维度和 NA 剔除。**删除和当前结构是代码事实；“为什么这样改”如果没有变更记录，只能作为工程推断表达。**

推荐面试话术：

> *“我从实现结果理解，这次演进是在可信度和覆盖面之间做取舍：JSON、关键词、时延和工具序列能用规则证明，就不让 LLM Judge 自由裁量；难以规则化的领域语义再下沉到 custom scorer。NA 让‘没有证据’不必被伪装成 0 分。不过这也牺牲了语义覆盖，所以 custom scorer 必须继续做证据契约和校准，不能只是把旧 Judge 换了个位置。”*

不要把“LLM Judge 跑三次分数不一样”“Revision 对当前规模过重”说成已查到的历史决策，除非能补充 PR、会议纪要或设计评审证据。

### custom scorer 与 Prometheus 大盘怎么答

简版回答：

> *“scorer skill 不是一句‘请给 0～100 分’的 Prompt，而是一份可执行判定 SOP。它先提取 Dashboard Artifact，再运行 Schema/布局校验、官方 PromQL parser 和可选的只读测试查询；LLM 只评需求覆盖与业务价值；最后由确定性脚本汇总并应用 hard cap。PromQL 要分语法、可执行性、指标类型语义和业务意图四层判断。”*

先补一句实现边界，避免把方案说成现状：

> *“但这套多脚本 scorer 目前是我建议的目标实现，不是仓库里已经落地的能力。当前 custom scorer 只把 `task_result`、工具名列表、原始 `dialog_trace` 和 config 发给 `eval_scorer_agent`；`tcum-ai-skills` 里还没有这个 scorer 包，也没有官方 PromQL parser 校验脚本。因此当前最多能利用被测 Skill 调 `PrometheusQuery` 的自检痕迹，不能保证评分器独立、逐条验证了所有表达式。”*

脚本路由不能继续交给 LLM 自由选择。生产版 `SKILL.md` 应只允许一次 `skill_exec`：`python3 scripts/score.py`，完整 Trial JSON 走 stdin；由 `score.py` 确定性调用提取、Dashboard 校验、每条 PromQL 的官方 parser、可选只读查询及最终算分。并用 `promql_extracted == promql_parsed + promql_skipped_with_reason` 做覆盖率断言，防止“有校验脚本但实际漏调”。

面试官追问“SKILL.md 怎么知道该调用哪个脚本”时，答案不是继续增加自然语言分支，而是：

1. `SKILL.md` 只定义触发条件、唯一入口 `score.py`、stdin/stdout 契约和禁止事项；
2. `score.py` 无条件提取证据，有 Dashboard 才做 Schema 校验，有非空 `expr` 就逐条强制 parse；
3. 只有 parse 通过且有指标元数据才做语义规则，只有显式开启并命中数据源白名单才真查 Prometheus；
4. 缺证据、权限错误和后端超时属于 `inconclusive/environment_error`，不能混成 Agent 的语法错误；
5. 最后检查“提取数 = 已解析数 + 有理由跳过数”，不相等说明 scorer 自己失效。

还要主动补一个 Grafana 特有细节：Panel 中的 PromQL 可能含 `$__rate_interval`、`$cluster`、`${namespace:regex}` 等模板变量，不能把原文直接送 parser 后就判错。`validate_promql.py` 应保留原式，按变量类型生成可审计的规范化表达式，再用与目标后端对齐版本的官方 parser 校验。无法解析的变量记为 `unresolved_template/inconclusive`，不能偷算为通过，也不能算作 Agent 语法错误。

当前输入边界也要主动说：custom scorer 只独立收到 `TaskResult`、工具名序列、原始 `DialogTrace` 和 config；Case、Reasoning、Duration、结构化 ToolCall 及 Dashboard Artifact 没有作为独立字段传入。`RunMetaSkill` 目前也只是将生成文本暂存在 `Skill.Desc`，不能据此宣称已经自动发布包含 `scripts/` 的完整 Skill 包。

脚本调用状态机、PromQL 四层校验、hard cap 和输出样例统一见[评测机制主文档的 scorer skill 设计](../01-机制原理/05-机制篇-Agent评测与评测体系.md#eval-custom-scorer)。

### 当前最关键的六个短板

1. **不可复现**：没有 RunManifest 固定 Skill hash、模型精确版本、prompt、工具 schema、数据快照和 scorer 版本。
2. **结果真值不足**：主要保存文本和工具名，缺少结构化参数、ToolResult、最终 Dashboard/告警/工单状态等 Artifact。
3. **数据集未治理**：Case 来源、风险切片、脱敏、owner、holdout 和覆盖率不完整。
4. **统计能力不足**：一个 Case 只跑一次，没有 candidate-baseline 配对分布、方差和显著性。
5. **Judge 未校准**：custom scorer 没有独立人工金标集、严重错误漏检率和版本回归。
6. **没有发布闭环**：没有 Skill/Prompt MR 自动触发核心集、每日全量和 blocker 门禁。

### 下一步的正确优先级

| 优先级 | 动作 | 原因 |
| --- | --- | --- |
| P0 | 增加 RunManifest、结构化 ToolCall/Artifact 和 scorer 版本 | 先让每个分数可解释、可重放 |
| P0 | 为 PromQL/Grafana/巡检配置做确定性执行验证 | 运维 Agent 中最接近编译/测试的低成本真值 |
| P0 | 建立线上失败、历史工单、事故复盘组成的版本化 Dataset | 避免只测开发者手写 happy path |
| P1 | baseline/candidate 配对重复执行，按风险切片报告 delta | 全局平均分会掩盖高风险退化 |
| P1 | custom Judge 人工校准与争议样本仲裁 | Judge 本身也是需要验收的组件 |
| P1 | PR 核心集、每日全量、线上 shadow 三层门禁 | 让评测真正进入交付流程 |

### 追问导航

- **问“源码完整链路”**：看[Agent 评测机制主文档](../01-机制原理/05-机制篇-Agent评测与评测体系.md)第 1、5 节。
- **问“为什么不能只看最终答案”**：看主文档第 0、2 节。
- **问“怎样做可信发布门禁”**：看主文档第 4～6 节。
- **问“scorer_skill 怎样调用脚本验证 PromQL”**：看主文档 `5.3.1～5.3.4`，重点是“单一 `score.py` 入口 + 程序内确定性路由”。
- **问“Langfuse 与执行 Trace 的关系”**：回答“Langfuse 负责观测，Eval 当前直接从 AG-UI SSE 构造 Trace”。

---

## Q28. 如何防止能力回归？

**为什么会有这个问题**：一个多次遇到的现象——上周优化了 SQL 生成专家，今天无关地改了 supervisor 的 SystemPrompt，**SQL 专家也自己变差了**，因为上下文拼装顺序变了、子 Agent 描述变了、一不小心 KV Cache 也断了。Agent 的“能力”不像代码那样完全隶属于单个模块，它分布在 prompt、工具 schema、skill、模型版本四处，**任一处变更都可能惄惄地破坏已有能力**。所以需要回答：契约能不能确定（工具名/参数 diff、子 Agent 描述 diff、prompt diff 在 CI 拒报告）、**黄金集能不能回放**（能力回归自动发现）。

**回答思路**：Agent 系统的"能力"分布在 prompt、工具 schema、skill、模型版本四处，**任一处变更都可能惄惄破坏已有能力**。**契约稳定性**是关键。

| | 做法 |
|---|---|
| **TCUM-AI** | 有单测；**`RegisterTools` 启动期 panic** 是良好的 fail-fast；`AdaptEinoTools` 任一失败整体报错避免半可用。**但：工具 schema 变更无兼容性检查、prompt 变更无回归（依赖 Q27）、MCP 契约无版本化** |
| **CC** | `findToolByName` 别名机制保证工具重命名向后兼容；`changeDetector.ts` 设置变更检测与热更新 |
| **Codex** | `AGENTS.md` 在 git 里 → prompt 变更天然可 diff、可 review、可回滚；模型版本明确（GPT-5.x-Codex） |
| **OpenClaw** | **发布与 CI** 章节 + ClawHub **策展/信任指南**——插件生态的质量门禁 |

**差异本质**：**Codex/CC 通过"prompt 即文件、进 git"获得了免费的回归防护**（diff + review + revert）。TCUM 的 prompt 在 DB 里，**改一次就永久覆盖，没有 diff、没有 review、没有回滚**。

**TCUM 亮点**：启动期 fail-fast（panic）+ `AdaptEinoTools` 拒绝半可用——**把配置错误暴露在发布阶段而非运行时**，这是正确的工程取向。

**TCUM 不足**：
1. **工具 schema 变更无兼容性检查**——改了参数名，老会话回放和模型习惯就断；
2. **prompt 变更无回归**（依赖 Q27 评测集）；
3. **MCP 契约无版本化**——对外暴露 128 工具，任一改名/改参数都可能打破外部消费方；
4. **Agent 配置（DB）无变更审计**——谁改了哪个 Agent 的 prompt/工具集，无记录。

**解决思路**：
- **O28.1** **工具 Schema 快照测试**：把所有 `ToolInfo` 序列化为 golden 文件纳入版本控制，变更时 diff 显式可见；破坏性变更必须走废弃流程（配合 O7.1 别名机制）；
- **O28.2** MCP 契约版本化：路径带版本（`/tcum-mcp/v1/monitor`），破坏性变更升版本并保留旧版一个周期；
- **O28.3** 发布前置检查清单：schema lint（O8.2）+ 评测核心集（Q27）+ 安全红队切片三项全绿才允许发布；
- **O28.4（借鉴 Codex，强烈推荐）** **把 Agent 的 SystemPrompt迁到 git 文件**（`agents/{code}/PROMPT.md`），DB 只存版本引用。**这一个动作同时解决：prompt 版本管理、变更 review、回滚、变更审计四个问题，成本极低。**

---

# 七、性能、容错与降级（Q29~Q30）

> **对照通用视角**（详见 [08](./08-面试题库-通用Agent深度专题.md) 二部分 Q29~Q34）：LLM API 429/5xx 三层重试策略、模型输出无效 JSON 的自愈方案、死循环检测（模型反复调同一个失败工具）、灾难场景（LLM 全站宕机）的降级路径设计。

## Q29. 延迟与成本如何优化？

**为什么会有这个问题**：一个具体的账——告警诊断一次平均 20 轮工具调用，每轮都把历史全量重发一遂（OpenAI 协议的 stateless 本质），**同样的 system prompt 重复上行 20 次**。如果模型支持 prompt cache，同一前缀能降 90% 成本 85% 延迟，**tcum-ai 目前没接**，直接钱花在了地上。另一个现象：告警列表查询这种“硬东西”完全可以不念 LLM，但默认全部交给默认模型，**简单问数也在烧 128k 上下文模型的钱**。所以需要回答：prompt cache 没接能不能接（ROI 最高）、任务分级能不能路由到不同模型（简单问数 → 小模型，深度分析 → 大模型）。

**回答思路**：Agent 的成本结构是"输入 token 为主"（system prompt + 工具定义 + 历史每轮全量重发）。优化优先级是：**prompt cache > 减少无效往返 > 分级模型 > 并行化**。

| | 做法 |
|---|---|
| **TCUM-AI** | `pkg/cache` 通用缓存；`agent_config_cache.go` 配置缓存 + 熔断；token counter 熔断降级；skill_cache 轮次淘汰；mcporter schema cache；`RuntimeModelSelector` 支持按前端选择换模型（**有换模型的技术能力，无自动分级逻辑**） |
| **CC** | **Prompt Cache 保护**（**设置路径要用内容哈希**，避免路径变化破坏前缀一致性）+ 子 Agent `fork_cached` 共享父前缀 + **并行预取模式（把延迟隐藏在用户思考时间中）** + 配置/模型能力/插件缓存 + 延迟加载 `feature()` 条件导入 + `apiPreconnect.ts` 连接池预热 + 135ms 冷启动优化 |
| **Codex** | Responses API 侧的缓存；`/compact` 控上下文规模；**`AGENTS.md` 是稳定前缀，天然利于 prompt cache** |
| **OpenClaw** | **Models → failover + 本地模型服务**——支持用本地模型跑低价值任务（**成本优化的另一条路：不是省token，是换更便宜的推理**） |

**差异本质**：四种成本优化思路：**CC = 缓存前缀**、**Codex = 稳定前缀 + 压缩**、**OpenClaw = 换便宜的模型/本地模型**、**TCUM = 目前主要靠减少数据量（截断/COS 卸载）**。

**TCUM 缺的正是最赚的那一条（prompt cache）**：运维 Agent 的 system prompt + 工具定义可能上万 token，**每轮全量重发**。而多轮排障会话 20~30 轮，命中 prompt cache 可省 50%+ 输入 token 成本。

**TCUM 亮点**：
1. **COS 卸载 + 沙箱聚合本身就是成本优化**——把"几 MB 数据进 token"变成"几 KB 结论进 token"，这个量级的节省超过任何缓存优化；
2. **mcporter 零schema 占用**——直接消除工具定义的常驻 token 成本；
3. skill 两级渐进披露、skill_cache 距离淘汰——都是在控上下文规模；
4. `RuntimeModelSelector` 已有换模型能力（缺的只是自动分级）。

**TCUM 不足**：
1. **无 Prompt Cache 利用（P0，成本收益最大）**；
2. **每轮重新拉 MCP 工具列表**（Q17.1）——纯延迟浪费；
3. **压缩本身要一次 LLM 调用，触发阈值又偏激进**（`maxTokens/2`）；
4. **LLM rerank 记忆每轮一次**（Q20.2）；
5. **无并行预取**——用户输入完成后才开始串行准备上下文（记忆召回、RAG、CMDB、工具列表）；
6. **无分级模型路由**——简单问数和跨产品根因用同一个大模型。

**解决思路**：
- **O29.1（P0，成本收益最大）Prompt Cache 优先**：
  - 保证请求前缀**字节级稳定**：system prompt、工具定义顺序固定，**动态内容（时间戳、会话 ID）一律后置**；
  - **注意 CC 的经验：设置路径要用内容哈希**，避免路径变化破坏前缀一致性；
  - 子 Agent 走 `fork_cached` 共享父前缀（O15.2）；
  - ⚠️ **这里有一个与现有实现的冲突需要注意**：`time_inject` 中间件把当前时间注入到消息里——如果注入位置在前缀，**每次请求前缀都不同，prompt cache 永远命中不了**。所以落地 prompt cache 的第一步是**审计所有动态注入的位置，全部后置**；
- **O29.2** MCP 工具列表缓存（同 O17.1）；
- **O29.3** 并行预取：用户消息到达后**并行**启动记忆召回、RAG 检索、CMDB 上下文拉取、工具列表准备——当前若串行，这块能省几百 ms 到数秒；
- **O29.4** 分级模型路由：简单问数用小模型，复杂根因用大模型，由 O14.1 的 `complexity` 标签驱动（**技术能力已有 `RuntimeModelSelector`，只需加分级逻辑**）；
- **O29.5** 压缩阈值从 `1/2` 提到 `0.7~0.75`，并先走微压缩（O3.1），减少 LLM 摘要调用频次；
- **借鉴 OpenClaw**：低价值任务（如摘要压缩、记忆 rerank、路由分类）用**本地/小模型**跑——这三个都是高频调用且不需要强推理。

---

## Q30. 容错与降级如何做？

**为什么会有这个问题**：一个真实的线上事件——公司内 LLM 网关持续抖22s抓约 5xx（只有一个 route），**所有告警/指标/变更专家陦2 小时内零可用**。回看发现 tcum-ai 对“模型服务本身挂了”基本零防护——无重试、无降级、无熝断、无多 route，而 ChatModelConfigList 能配多个模型但 `NewChatModel(ck)` 是确切匹配单个，没“A 挂了切 B”。味病相似的开发对 MCP：tianxun 远端拒连时，Agent 粒度上没有熝断，每一次尝试连接一下都阻塞了上游不少时间。所以需要回答：**分类**（可重试/不可重试/需降级）、**退避**（时间上错开避免惊群）、**降级**（模型/工具/子 Agent 多 route）、**清理**（孤儿会话/尸体子 Agent 不能一直堆在内存）。四件事 tcum-ai 基本只做了第四件的一部分。

**回答思路**：Agent 依赖链极长（模型 API → 工具 → MCP → 下游系统 → 沙箱），任一环故障都可能中断会话。容错要成体系：**分类 → 退避 → 降级 → 清理**。

| | 做法 |
|---|---|
| **TCUM-AI** | 熔断三处（token counter 阈值 3、`agent_config_cache` 阈值 3、MCP 单 server 失败跳过）；`AdaptiveContextRetry`（400 超限时渐进压缩重试，0.85 安全比例，**注意：仅 `Generate` 生效，流式主链路的 `Stream` 直接透传**）；记忆 rerank 失败 fallback to recent；摘要合并失败 fallback 为直接拼接；trag client 有重试与 token 脱敏；`toolErrorHandlerMiddleware` 工具错误转文本；工具 goroutine 独立 panic recover；`UnknownToolsHandler` 幻觉工具兜底；数字分身定时任务分布式锁 + 锁续约 |
| **CC** | **完整体系**：`errors.ts` 错误类型体系 + 连接错误精细分类 + Axios 错误统一分类；`getRetryDelay` 指数退避 + **0~25% 抖动**；**`MAX_529_RETRIES=3` → `FallbackTriggeredError` → 模型回退（Opus→Sonnet），且 529 计数器跨流式/非流式连续传递（`initialConsecutive529Errors`）**；`gracefulShutdown.ts` 清理注册表；`conversationRecovery.ts` 会话恢复；`rateLimitMessages.ts`；`claudeAiLimits.ts` 配额跟踪；**`backgroundHousekeeping.ts` 孤儿资源清理**；`TeleportOperationError` 远程操作恢复 |
| **Codex** | `approval_policy = on-failure` 把失败升级为人机协作点；命令失败提示（如 "retry without sandbox"）引导用户调整配置 |
| **OpenClaw** | **Models failover**（provider 级故障转移）+ 本地模型兜底；Gateway 诊断与运维章节 |

**差异本质**：**TCUM 有"降级意识"但无"降级体系"**——每处降级都是就地实现（rerank 失败退recent、摘要失败退截断、tokenizer 熔断退本地），没有统一的错误分类与决策矩阵。CC 是唯一做成体系的。

**而模型降级链是最明显的缺口**：CC 的 `MAX_529_RETRIES=3 → Opus→Sonnet 回退`，且**计数器跨流式/非流式连续传递**（这个细节说明他们真的踩过"流式和非流式各自计数导致总容忍度翻倍"的坑）。TCUM遇到大模型过载**只能失败**。

**TCUM 亮点（这块公平地说做得不错）**：
1. **多处降级都有 fallback，且注释写明动机**——rerank 两处 fallback、摘要合并失败 fallback 为直接拼接原 period"确保服务永不中断"、tokenizer 三级降级；
2. **`AdaptiveContextRetry` 是一个完整的"故障自愈"实现**——不只是重试，而是"分析错误 → 计算目标 → 分级压缩 → 自查 → 重试"；
3. **`AdaptEinoTools` 拒绝半可用状态**——宁可整体失败也不要"看起来能用但少一半工具"；
4. **数字分身定时任务的分布式锁 + 锁续约**——无人值守场景的正确做法；
5. **每goroutine 独立 panic recover**——单工具崩溃不炸整轮。

**TCUM 不足**：
1. **无统一错误分类状态机**（同 Q11.1）；
2. **无指数退避 + 抖动**（同 Q11.2）——**抖动缺失在大规模并发时会导致惊群**；
3. **无模型降级链**——大模型过载只能失败；
4. **无优雅关闭**——滚动发布时在途Agent 任务被硬中断；
5. **无孤儿资源清理**——中断的沙箱、僵死子 Agent、悬挂 SSE 连接、过期 skill 缓存的回收机制不明；
6. **`agent_access` 的 MCP 注册失败 log+continue** 是"错误的降级"——静默降级比失败更难排查。

**解决思路**：
- **O30.1（P0）** `pkg/agent/errors.go` 定义错误分类枚举与 `Retryable`/`FallbackModel`/`UserMessage` 决策矩阵；退避统一 `min(500ms*2^(n-1), 32s)` + `0~25%` 抖动，**优先服务端 `Retry-After`**；
- **O30.2** 模型降级链：配置 `model_chain: [primary, fallback1, fallback2]`，连续 3 次过载/超时自动降级并在 trace 标记降级事件；**计数器需跨流式/非流式连续**；
- **O30.3** 优雅关闭：停收新请求 → 等在途 Agent 任务（上限 30s）→ 落盘会话状态 → 关 SSE 与沙箱 → 退出；
- **O30.4** 后台清理（可复用现有 `pkg/jobscheduler`）：回收超时沙箱实例、僵死子 Agent、悬挂 SSE 连接、过期 skill 缓存；
- **O30.5** 统一"降级必须可见"原则：任何降级都要**打指标 + 告警**，禁止只记一行 log（针对 MCP 注册失败）；
- **借鉴 OpenClaw**：provider 级 failover + 本地模型兜底，作为模型降级链的最后一档。

---

# 八、tcum-ai 亮点、短板与最高杠杆改动

> **本章定位**：面试压轴问"这个项目最亮的地方 / 最大的短板 / 你会先改什么"时的标准答案。原文来自 `09-30问-安全可观测与性能.md` 尾部的"四家定位/亮点/短板/最高杠杆"分析。

## 一、四家的定位差异（理解差异的前提）

| | TCUM-AI | Claude Code | Codex | OpenClaw |
|---|---|---|---|---|
| **形态** | 服务端多租户平台 | 本地 CLI/IDE Agent | 本地 CLI + App | 自托管 Gateway |
| **用户模型** | **多用户多租户** | 单用户 | 单用户 | 单用户（自托管） |
| **域** | **多域（15 个垂直 Agent）** | 单域（编码） | 单域（编码） | 多渠道通用助手 |
| **输出可验证性** | ⚠️ 部分（PromQL/JSON 可验证，分析结论不可） | ✅ 高（编译/测试） | ✅ 高 | 低 |
| **核心风险** | **生产变更 + 越权 + 幻觉决策** | 本地文件损坏 | 本地文件损坏 | 个人数据/设备 |
| **核心挑战** | 多 Agent 编排 + 领域知识 + 权限合规 | 上下文 + 权限 + 性能 | 沙箱强制 + 审批 | 渠道接入 + 生态治理 |

**这张表解释了为什么不能照搬**：TCUM 面对的"多租户 AuthZ""多域路由""结论不可自动验证"三个问题，另三家**都不存在**。

## 二、TCUM-AI 的五个真亮点（可对外讲）

| # | 亮点 | 为什么算亮点 |
|---|---|---|
| 1 | **上下文压缩七层 + COS 卸载 + 沙箱回捞** | L0~L2 零 LLM 成本、L3/L5/L6 语义压缩、L4 应急压缩；但 L0 仅在工具主动返回 `compact_table`/v3 紧凑图时发生，不是数组自动压缩，L1 以最终结果 byte 长度为开关。把"数据大"与"上下文小"解耦：数据留对象存储、算力放沙箱、只有结论进 token；**在 COS 上传成功且后续压缩路径识别到 WarnMsg/Metadata 时**，COS_URL 会被刻意保留给后续回捞；上传失败时没有这个传送门。**L5 的 `SummaryMsgCount` 游标让长会话上下文收敛而非线性增长** |
| 2 | **AdaptiveContextRetry 的目标预算驱动递进压缩 + fail-fast** | 从 400 错误 parse 真实 token、按unread/density/size 排序、tool T1/T2/T3 + assistant T4 + 极限档递进、round 递进解禁、压缩后自查不达标就不发请求；**但要如实说明：目前仅 `Generate` 生效，流式主链路的 `Stream` 直接透传，补齐是 P0** |
| 3 | **mcporter 零 tool-schema 占用路线** | 业界通病是 MCP 工具schema 每轮全量发；这条路线把能力发现从 schema 层搬到正文按需注入层 |
| 4 | **数字分身运行时人格装配 + 权限落在"工具存在与否"** | 一个实例服务 N 个分身；未授权工具从一开始不在 map 里，prompt 注入也无法调用 |
| 5 | **跨协议/跨团队多 Agent 嵌套+ AG-UI 多 Agent 可视化** | tcum/knot/sre 三种协议、三层 Agent 嵌套（含外部团队的 MultiAgent 系统）；前端双区域 + 三层级渲染 + 执行栈 |

**另外两个"方法论级"亮点**：
- **Grafana 看板的"代码保结构、模型做语义"**——凡结构复杂但规则确定的输出，都该这么切；
- **PromQL/InfluxQL 的"生成 → 执行验证 → 修正"闭环**——凡输出可被程序验证的场景，都该把验证工具给模型。

## 三、TCUM-AI 的十个真短板（按优先级）

| 优先级 | 短板 | 对应问|
|---|---|---|
| 🔴 P0 | **无工具权限体系 + 无 HITL 审批**（且能力已从只读走到无人值守自主执行） | Q23 |
| 🔴 P0 | **身份未透传+ 无 AuthZ + 无审计 + token 明文入库** | Q25 |
| 🔴 P0 | **沙箱边界未确认 + 自由 bash 无危险模式检测** | Q24 |
| 🔴 P0 | **RAG 三连坑：ES 内部 BM25↔kNN 融合退化为分数相加（向量分被量纲淹没）/ 无 `ScoreThreshold` 永远返回满 TopK / embedding 一致性无守卫**；另加灌库任务每 5 分钟全量重建且所有节点都跑 | Q18 |
| 🟡 P1 | ~~无任何效果评测集~~ → **已落地 `eval_suite` 独立服务**（6 类持久化实体 + 5 个量化 scorer + AGUI 调专用评测 agent + custom scorer skill 执行链）。代码还提供 meta-skill 生成入口，但产物目前只暂存在 `Skill.Desc`，不能说成完整 Skill 包已自动发布。**仍存的短板**：不可复现 / 结构化 Artifact 不足 / Judge 未校准 / 单 Case 单次执行 / 无 CI 触发 | Q27 |
| 🔴 P0 | **上下文超限兜底未覆盖流式主链路**（`adaptiveContextModel.Stream` 直接透传，而 AG-UI 入口硬编码 `EnableStreaming: true`）+ 报告总结路径用裸模型且超预算只 warn 不裁剪 | Q3 |
| 🔴 P0 | **无引用溯源 + 无数值校验**（运维决策依赖数值） | Q22 |
| 🔴 P0 | **无独立审查 Agent + 无"完成定义"的可执行判定**（15 个 Agent 无一负责审查他人；`AfterModelRewriteState` 0 实现 = 无 CC Stop hook 等价物）；**记忆自进化"表结构全对、闭环全缺"**（`Source`/`Confidence`/`HitCount`/`TTL` 六字段齐备但无写入）；**反馈只进报表不回流** | 第四篇 |
| 🟡 P1 | **无 Prompt Cache 利用**（成本最大浪费） | Q29 |
| 🟡 P1 | **业务语义 span 全缺 + 无成本账本 + 无黄金指标** | Q26 |
| 🟡 P1 | **路由不可度量 + 配置质量无lint**（有Agent 的 profile 全空） | Q14 |
| 🟡 P1 | **无终止原因分类 + 轮次耗尽报错而非收敛** | Q1 |

## 四、五个"最高杠杆"的单点改动（面试问"你会先做什么"时的答案）

按"改动成本 / 收益"排序，这五个是我会最先做的：

| # | 改动 | 成本 | 一次解决 |
|---|---|---|---|
| 0 | **给 `adaptiveContextModel.Stream` 补超限压缩重试** | 极低（约 30 行，直接复用 `isContextOverflowError` + `compressToTarget` + 重新 `inner.Stream`） | 把已经写好的整套七层压缩兜底能力**从"仅非流式生效"变成"生产主链路生效"** —— 现有投入最大的一块能力目前在主链路上是空转的 |
| 1 | **配置 `CheckPointStore`** | 极低（一行配置 + 一个 store实现） | 同时解锁 **HITL 审批** + **并发工具批次部分完成续跑** + **子 Agent 断线续传** |
| 2 | **轮次耗尽改强制收敛** | 极低（复用现成 `buildNoToolsRunFunc`） | 把最坏情况从 "error" 变成"带不确定性标注的阶段性结论" |
| 3 | **自实现 RRF + 设 ScoreThreshold** | 低（纯排序融合，不需 license） | 修复**向量检索实质失效** + 砍掉幻觉最大来源 |
| 4 | **云 API 从 action 名自动推断风险等级** | 低（`Describe*/List*` → readonly；`Delete*/Terminate*` → destructive） | 覆盖 `pkg/capi` 批量转换的绝大部分工具，为权限体系提供**免费的分级数据** |
| 5 | **Prompt 迁到 git 文件（`agents/{code}/PROMPT.md`）** | 低 | 同时获得 **版本管理 + review + 回滚 + 变更审计** 四项能力 |
| 6 | **`AfterModelRewriteState` 输出守门人 + `TwinMemory` 三个 UPDATE** | 极低（一个中间件文件；三条UPDATE 语句） | 守门人：把"完成定义"从模型自觉变成平台强制（数值断言必须有工具证据 / 实体格式校验 / 关键字段完整性），**零 LLM 成本**；三个 UPDATE（命中回写 + TTL 清理 + 置信度衰减）：**让记忆自进化闭环开始产出数据**，是后续所有淘汰策略与评测集的种子。详见第四篇 |

## 五、一段可以直接说的收尾

> *我的判断是：TCUM-AI 在**上下文工程**和**多Agent 工程化**这两块的投入是扎实的，甚至有几处（COS 卸载 + 沙箱回捞、mcporter 零 schema、目标预算驱动的递进压缩 + fail-fast、摘要游标让长会话收敛）我认为超出了同类项目的平均水平；但在**安全权限**和**效果度量**这两块是明显欠债的，而且欠债在加剧——因为能力已经从『只读分析』走到了『配置生成』和『无人值守自主执行』，风险曲线上去了，权限体系没跟上。**另外我会主动说一个自己发现的问题：超限压缩重试只做了 `Generate`，而主链路是流式，等于最花心思的那层兜底在生产上基本没被触发过——这是我复盘时最有价值的一个发现，也是我会第一个补的。**
>
> *对照 Claude Code、Codex、OpenClaw，我最想抄的三样东西是：**Codex 的 `sandbox_mode × approval_policy` 两维权限矩阵**（把技术边界和流程边界分开）、**CC 的 `tokenCountWithEstimation`**（零 API 调用的精确 token 估算）、**Codex/CC 的 prompt 即文件进 git**（免费获得版本、review、回滚）。*
>
> *但我也清楚有三个问题是通用编码 Agent 不会替我们解决的：**多租户 AuthZ 与审计**、**多域意图路由的可度量性**、以及**结论不可自动验证时怎么评测**。第三点我们已经完成 0→1：`eval_suite` 能在真实 AG-UI 链路运行 Skill，保存 Trace，用 5 个规则 scorer 和 custom scorer 做 NA-aware 加权评分。迁移代码也能证明早期 Revision/扣分/pass-rate 结构被替换；至于替换原因，我会明确说是结合实现做出的工程解读，而不是冒充历史决策记录。当前最该补的不是再加一个聪明 Judge，而是 RunManifest、结构化 ToolCall/Artifact、版本化 Dataset、重复配对试验、Judge 校准和 CI 门禁。meta-skill 已打通“生成文本→UpsertSkill”的入口，但完整 `SKILL.md + scripts/` 文件包上传仍是 TODO。"*
