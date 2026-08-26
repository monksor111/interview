# 第一篇之五 · Agent 评测：从“能跑一套分”到“能证明系统变好了”

---

> **定位**：本篇是 TCUM-AI 面试资料中的 Agent 评测专题。它不把“跑一遍 prompt、让模型打个分”当成评测，而是回答：一个会调用工具、读写环境、跨多轮决策的 Agent，怎样在发版前证明没有退化，在生产中发现新失败，并把失败变成下一轮回归样本。
>
> **事实边界**：文中“当前已实现”仅依据 `tcum-ai` 仓库截至本次核验的 `usercases/eval_suite/`、`pkg/agentaccess/` 和 `cmd/server/eval_suite/`。所有“应该补齐”“目标架构”“路线图”均为建议，不能在面试中说成已经上线。
>
> **一句话结论**：TCUM-AI 已经有一个可工作的、以 Skill 为中心的离线 Eval Suite 雏形：Case → Trial → 一次性调度 → AGUI SSE 真运行 → Trace → 加权评分 → Run 聚合。它解决了“能重复跑、能留下执行轨迹、能比较部分维度”的 0→1 问题；但离“发布准入和持续质量系统”还差数据集治理、环境确定性、任务结果断言、评分校准、统计显著性、CI 门禁、线上闭环、安全红队八块关键拼图。

---

## 📑 目录

**0. 先给面试结论**

- 0.1 30 秒、2 分钟、5 分钟三档回答
- 0.2 为什么 Agent 评测不能只看最终答案

**1. TCUM-AI 当前做到了什么（代码事实）**

- 1.1 目标对象与系统边界
- 1.2 真实执行链：Suite → Trial → AGUI → Trace → Score
- 1.3 场景、数据模型与状态机
- 1.4 现有评分器到底在测什么
- 1.5 当前设计的正确取舍

**2. 当前做法的问题：不是“没有评测”，而是“评测尚不可作为质量准入”**

- 2.1 评测对象、版本与可复现性
- 2.2 数据集、覆盖率与泄漏
- 2.3 轨迹、参数、环境副作用与结果真值
- 2.4 LLM Judge、custom scorer 与人工校准
- 2.5 统计学、成本、稳定性与门禁
- 2.6 线上反馈、风险与安全

**3. 业界把 Agent Eval 做成了什么**

- 3.1 Anthropic：任务 / Trial / Trace / Grader 的正确分层
- 3.2 OpenAI：数据源、Grader、可复用 Run 与版本比较
- 3.3 LangSmith：Dataset—Experiment—Trace—Annotation 的闭环
- 3.4 Vertex AI：结果质量与轨迹质量并列
- 3.5 对 TCUM-AI 的可迁移结论

**4. 目标评测体系：五层质量工程**

- 4.1 数据层、运行层、判定层、分析层、交付层
- 4.2 指标树与领域化成功定义
- 4.3 参考轨迹不是唯一轨迹

**5. 面向 TCUM-AI 的落地设计**

- 5.1 Suite / Case / Run / Artifact 的目标契约
- 5.2 沙箱、录制回放与写操作隔离
- 5.3 Grader 插件与裁决协议
- 5.4 版本、对比、显著性与发布准入
- 5.5 线上评测与“失败自动入集”

**6. 分阶段路线图、面试话术与追问**

---

# 0. 先给面试结论

## 0.1 三档回答

### 30 秒版本

我们把 Agent 评测拆成“有没有完成任务”和“是怎样完成的”两件事。TCUM-AI 当前的 Eval Suite 已经能把一个 Skill 放进真实 Agent 运行链路：对每个 Case 创建 Trial，经调度器调用专用 AGUI Agent，消费 SSE 得到最终文本、工具调用顺序、耗时和原始 Trace，再用规则评分器或 custom scorer 得到加权分数。它比只测最终回答进了一步。

但我不会把它夸成完整质量体系。当前最关键的缺口是：没有受治理的金标数据集和版本化覆盖率；没有工具响应录制/回放和副作用断言，导致结果会被真实环境波动污染；评分以启发式和 LLM Judge 为主，没有人工校准；也没有基于基线、置信区间的 CI 准入和线上失败回灌。下一步我会优先把“真实 Trace → 脱敏标注 → 回归集 → PR 对比门禁”闭环跑起来。

### 2 分钟版本

评测要先定义对象。对单轮问答，输入和最终文本的对比可能够用；但运维 Agent 的价值来自多轮工具调用、数据证据、权限边界和最终动作。一个答案看上去很合理，可能是没查监控就编出来的；也可能工具顺序不同但结果正确。因此我会同时评估四件事：任务结果是否满足业务目标、轨迹是否合规且高效、环境最终状态是否正确、成本/时延/安全是否在预算内。

现有 TCUM-AI 做的是离线 Skill Eval。`TriggerRun` 读取 Suite 和 Case，为每个 Case 建一条 Trial 和一次性调度任务。`EvalTrialExecutor` 将 Skill 名实时解析为 Skill ID，带上模型、环境变量和用户输入，通过 HTTP POST + SSE 调用 `skill_evaluation_agent`；SSE 客户端积累 `TEXT_MESSAGE_CHUNK`、`TOOL_CALL_CHUNK`、`RUN_STARTED/RUN_FINISHED` 等事件，形成 Trace。随后内置规则测关键词、JSON 输出字段、时延、Token 估算，以及仅适用于 baseline 的工具序列 LCS；开放语义由另一个 AGUI scorer agent 执行 custom scorer skill。分数落 Trial，所有 Trial 结束后聚合到 Run。

这条链路的优势是真运行、可追溯、可扩展。问题则在于“真运行”并不等于“可重复运行”：外部监控、时间窗口、数据版本和工具副作用都在变化；工具 LCS 只看名称不看参数与结果；单次 Trial 没有置信度；custom scorer 没有和人工标签做校准；目前看不到 PR 自动触发、阈值门禁和线上失败样本沉淀。我会先做确定性回放和 Case 版本化，再建立黄金/对抗/线上回归三类集，最后引入统计化发布规则与线上抽样评测。

### 5 分钟回答的叙事顺序

1. **先讲风险现场**：一次 Skill、模型或工具 schema 的改动，可能让 Agent 少调一个关键工具、把时间范围传错，最终文本却仍然流畅；靠人工点几次无法发现回归。
2. **再讲现有骨架**：真实 AGUI 执行、完整 Trace、规则 + custom scorer、Trial / Run 聚合。
3. **主动承认边界**：当前是 Eval Runner，不是 Eval System；数据、环境、判定、统计、交付、线上闭环都不完整。
4. **给出优先级**：P0 是录制回放 + 黄金 Case + PR 对比；P1 是人工校准、环境状态断言和线上回灌；P2 才是自动生成 Case、对抗 Agent 与多环境实验。
5. **落到运维价值**：不是追一个总分，而是降低“无证据诊断、错误写操作、关键工具漏调、长尾场景退化”进入生产的概率。

## 0.2 为什么 Agent 评测不能只看最终答案

Agent 与普通文本生成的差别，不是“回答更长”，而是它在环境里做决策：选择何时调用哪个工具、生成什么参数、怎样根据结果改下一步、是否执行有副作用的动作。最终答案正确不代表过程可信；过程看似符合参考轨迹也不代表真正完成了任务。下面四种情况足以说明只看文本会失真：

| 情况 | 最终文本 | 真实质量 | 只看最终文本的误判 |
| --- | --- | --- | --- |
| 未取证的猜对 | “CPU 峰值由批处理导致” | 没有调用指标或日志工具，不能复核 | 可能给高分，奖励幻觉 |
| 不同路径的正确解 | 先查 CMDB 再查告警 | 与参考顺序不同，但减少了无效查询 | 严格 exact-match 会错判失败 |
| 参数错误的工具调用 | 调了 `QueryMetric`，时间范围多了一个月 | 工具名正确，结论可能被历史数据污染 | 只比工具名会给高分 |
| 有副作用的假成功 | 回复“变更已完成” | 实际写入被拒绝、未落库或写错对象 | 文本语气无法证明环境状态 |

因此，Agent 的最小评测单位不是“prompt → answer”，而是：**任务（Task）在一个明确环境中的多次尝试（Trial），每次尝试保存完整轨迹（Trace），由多个针对不同事实的判定器（Grader）共同打分。** Anthropic 对 task、trial、transcript/trace、grader 的分层与此一致；其核心提醒是，Agent 的多轮工具调用和环境变化会让错误传播、让静态评测容易被绕过。[Anthropic《Demystifying evals for AI agents》](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

---

# 1. TCUM-AI 当前做到了什么（代码事实）

## 1.1 评测对象与系统边界

当前 Eval Suite 的重心是 **Skill 评测**，不是一个泛化完成的“任意 Agent / 任意模型”的评测平台。Suite 中通过 `scenario_config` 描述被测 Skill、模型名、Skill 环境变量和可选的基准 Skill；Case 中保存用户输入及 `evaluation_dimensions`。目前真正实现的场景是：

- `skill_direct`：以 Case 输入运行一个目标 Skill；
- `baseline_skill_compare`：以同一 Case 输入先运行目标 Skill、再运行基准 Skill，主要为工具轨迹相似度提供对照；
- `model_eval`、`agent_eval` 虽有常量，但在 executor 的分支中尚未实现，不能描述成已支持。

Eval Suite 是独立服务进程，入口为 `cmd/server/eval_suite/main.go`。它复用 tcum-ai 的 `agentserver.Run` 完成配置、数据库、模型注册、Telemetry 和基础 Server 生命周期，但自身只注册评测 API 与 Scheduler。这里的边界很重要：**被测能力仍由 tcum-ai 的 Agent 运行时提供，评测服务负责把执行组织成可比较的实验并保存结果。**

与早期“Eval Suite 直接从 AgentManager 取 Agent、在本进程 `Runner.Query`”的设计不同，当前代码经外部专用 AGUI endpoint 运行：

- `skill_evaluation_agent`：执行目标或基准 Skill；
- `eval_scorer_agent`：执行 custom scorer skill；
- `eval_scorer_generate_expert`：以 meta-skill 生成新的 scorer skill。

这样做的收益是复用常规 Agent 的 Skill、MCP、流式协议和运行上下文，避免评测侧再维护一套行为不一致的“假运行时”。代价也显而易见：评测对外部 endpoint、实时工具、模型服务和配置更敏感，必须额外建设确定性与隔离能力，后文会展开。

## 1.2 真实执行链：Suite → Trial → AGUI → Trace → Score

```mermaid
flowchart TB
  U["用户/CI 触发 Run"] --> S["按 suite_code 取当前 Suite"]
  S --> C["校验 Case 列表"]
  C --> T["每个 Case 建 Trial + once SchedulerTask"]
  T --> L["pkg/scheduler + DB lock"]
  L --> E["EvalTrialExecutor.Execute"]
  E --> I["Skill name → agent_access 查询 skill_id"]
  I --> A["POST AGUI endpoint"]
  A --> R["真实 Agent：Skill / MCP / 模型"]
  R --> SSE["SSE Events"]
  SSE --> X["Trace: text / tools / reasoning / duration / raw events"]
  X --> G["内置 RuleScorer + custom scorer agent"]
  G --> D["Trial: score + score_detail + status"]
  D --> P["全部终态后聚合 Run report"]
```

按代码顺序，关键过程如下：

1. `EvalRunService.TriggerRun` 根据 `suite_code` 读取当前 Suite，解析并校验其引用的 Case；对每个有效 Case 创建一个 `EvalTrial` 和一个 pending 的 `EvalSchedulerTask`，再主动 `UpsertTask` 到内存调度器。当前是一 Case 一 Trial，不存在 `trial_count=N` 的重复抽样。
2. `pkg/scheduler` 执行一次性任务，Eval Suite 配置了任务超时、锁时长和续租；锁的目的不是提高分数，而是避免多实例同时执行同一 Trial。
3. `EvalTrialExecutor` 读取 Run、Suite、Case，解析 `scenario_config`。它将 `skill_envs` 中的 `${ENV}` 从评测服务进程环境变量展开；这很方便，但也意味着环境变量版本需要被记录，否则一次 Run 的真实输入不可完整重建。
4. 执行时先通过 `agent_access` 以 Skill 名反查 `skill_id`，构造 AGUI 请求。请求包括 `threadId`、`runId`、用户 `messages`、`forwardedProps.skill_ids`、`agent_config.chat_model` 与 `exec_context.skill_envs`。单 Skill 路径默认 120 秒超时；基准对比整条 Trial 的超时设为 240 秒。
5. `agui.Client` 用 HTTP POST 发起请求，以 SSE 消费响应。它将最后一条 assistant 文本作为 `TaskResult`，累计 reasoning 文本；按工具调用出现顺序提取工具；对 `skill_exec` 还会解析参数中的 `mcporter call` 得到实际工具名；`RUN_STARTED` 与 `RUN_FINISHED` 用于计算纯运行耗时；原始事件序列被 JSON 化为 `DialogTrace`。
6. 对目标 Trace（和可选 baseline Trace）执行评分，写回 Trial 的 `score`、`score_detail`、`duration_ms`、状态与失败信息。所有 Trial 终态后聚合 Run 的平均分和逐 Trial 报告；全 Trial 失败时 Run 为 `failed`，不会把失败结果伪装成有意义的低分。

这已经满足一个合格 Eval Runner 的三个最低要求：**运行的是实际系统、保存了足够的执行证据、能按 Case 找到失败细节。** 这也是我们不应该把现状说成“完全没有评测”的原因。

## 1.3 场景、数据模型与状态机

现有主要实体可概括为：

| 实体 | 当前职责 | 已有价值 | 仍需补充 |
| --- | --- | --- | --- |
| Suite | 聚合场景、Case 引用与版本 | 将一组回归问题作为单元管理 | 评测目标的完整版本清单、数据集版本、环境版本、策略版本 |
| Case | 用户输入和维度配置 | 能表达一个业务问题 | 前置状态、期望最终状态、参考证据、标签、风险等级、来源与脱敏信息 |
| Run | 一次触发的评测记录 | 可比较多 Case 结果 | Git SHA、Skill 包 hash、模型版本、工具 schema hash、依赖快照、成本与准入结论 |
| Trial | 一个 Case 的一次执行 | 保存状态、耗时与分数 | 随机种子、温度、重试次数、环境快照、录制数据版本、完整 Artifact 引用 |
| SchedulerTask | 调度与去重 | 支持异步执行和多实例 | 排队优先级、资源配额、取消原因、隔离环境 ID |
| Score detail | 维度级分数和证据 | 便于初步定位 | 判定器版本、置信度、人工复核状态、判定输入/输出哈希 |

这张表反映了一个重要判断：当前模型主要是“运行记录 + 分数记录”，还没有完整地建模“实验可重放所需的一切输入”。例如同一个 Skill 名在两次运行间可能指向不同内容，同一个 `chat_model` 名可能被后端路由到新模型，同一个工具调用会看到不同时间的监控数据；如果这些不写进 Run manifest，历史 85 分并不真正可解释。

当前状态机大致为：Run 创建后进入 `running`；Trial 为 `pending → running → completed/failed`；调度任务也有 pending、running、completed、failed。它已经避免了“所有 Trial 创建失败仍显示成功”和“失败路径不触发聚合导致 Run 永远 running”等常见工程坑。更成熟的状态机还应区分 `cancelled`、`timed_out`、`environment_unavailable`、`judge_error`、`inconclusive`，因为这些状态的质量含义不同：Agent 做错、环境挂了、评分器挂了绝不能混为一个失败率。

## 1.4 现有评分器到底在测什么

当前 `scorer.Engine` 注册的内置维度及其真实语义：

| Metric | 评分事实 | 能发现什么 | 不能证明什么 |
| --- | --- | --- |
| `tool_sequence_match` | 目标与 baseline 的工具名序列做保序 LCS，归一化为 0–100；无 baseline 为 NA | 关键工具是否被漏掉、顺序漂移是否很大 | 参数正确性、工具结果是否合理、不同但更优的路径 |
| `keyword_match` | must 关键词命中比例；命中 forbidden 直接 0 | 报告是否覆盖必要字段或是否出现禁语 | 语义等价、数值正确、是否有证据 |
| `output_schema` | 最终文本按 JSON 解析，required field 命中比例 | 机器消费的输出契约 | 字段的值是否正确；非 JSON 报告质量 |
| `duration` | 在 `max_ms` 内为 100，超过后指数平滑衰减 | 性能退化 | 排队时间、下游吞吐、不同任务难度的公平性 |
| `token_cost` | 对 reasoning + task result 作近似 Token 计数，超过阈值平滑衰减 | 明显冗长和成本失控 | 精确账单 Token、工具 token、缓存命中、质量/成本最优点 |
| `custom` | 经 AGUI 调用 scorer skill，要求返回 `{score, detail, evidence}` | 领域语义、难以规则化的判断 | Judge 自己是否稳定/偏置，除非另做校准 |

其中最容易被误讲的是 `tool_sequence_match`。它不是“是否按期望工具序列完成任务”的绝对判定，而是**被测轨迹与基准轨迹的 LCS 相似度**。它只在基准场景有意义；它按工具名、不按参数比较；而且 LCS 对顺序敏感。若参考是 `[查告警, 查指标, 查日志]`，被测为 `[查日志, 查指标, 查告警]`，即使三种工具都调用了，分数也可能偏低。对于强流程合规场景这是合理的；对于开放式根因分析，它会把“另一个可行路径”误伤。

custom scorer 是正确的扩展方向，但它本质是 LLM-as-a-Judge。它不能因为返回了一个浮点数就被当成客观真值。成熟做法是将 Judge 的 prompt、模型、温度、rubric、版本、输入证据一起固化，并以人工标注集持续量化其与人的一致性。否则我们只能得到“另一个模型的意见”，得不到可靠分数。

## 1.5 当前设计的正确取舍

即使后文会列出很多缺口，仍要承认当前设计有四个值得保留的判断。

**第一，执行真实链路而不是 Mock 一个“理想 Agent”。** 评测请求经过 AGUI Agent、Skill 选择、MCP 工具、流式协议和运行时上下文，因此能抓到 Skill 注入失败、工具 schema 漂移、流式解析异常等单元测试看不到的问题。未来需要引入回放，但不应把所有评测都退化为纯 Mock；正确做法是同时拥有确定性回放和少量真实环境冒烟。

**第二，保存 Trace 而不只保存总分。** 一个平均分无法告诉我们是工具漏调、参数错误、环境超时还是 Judge 误判。SSE 原始事件、工具顺序、最终文本、reasoning 和耗时为后续诊断提供了基本证据。业界也把 Trace 当作 Agent Eval 的核心载体，而非附属日志。[LangSmith 的复杂 Agent 评测文档](https://docs.langchain.com/langsmith/evaluate-complex-agent)将最终回答、轨迹和单步评估明确分开。

**第三，规则评分和语义评分分层。** keyword、schema、时延等明确事实不应交给 LLM；custom scorer 给复杂业务语义留出了接口。这比“一个大 Judge 包打天下”更可解释、成本更低、也更容易定位。

**第四，异步调度与失败聚合从一开始就按服务化设计。** 评测可能长、可能并发、可能受模型限流；让 Run 立即返回、Trial 后台执行、任务用锁去重，比把数十分钟工作放进 HTTP 请求更接近生产系统。

---

# 2. 当前做法的问题：不是“没有评测”，而是“评测尚不可作为质量准入”

以下不是为了贬低现有实现，而是面试里最有价值的部分：你能说清一个 Eval Runner 离 Eval System 差在哪里，以及为什么优先级不能反过来。

## 2.1 问题一：可复现性不足，历史分数可能不可解释

当前 Trial 实际依赖的输入远多于 Case 文本：Skill 内容、Skill 依赖、模型路由、系统 prompt、Agent 配置、MCP 工具 schema、环境变量、运行时 feature flag、外部数据源时间状态都会影响结果。现有请求只显式传了 Skill ID、模型名和展开后的部分环境变量；而运行时仍可能按最新配置加载能力。若明天同名 Skill 被更新、模型别名切换、Prometheus 数据滚动、某个 MCP 返回字段变化，再重跑“同一个 Case”，它不再是同一个实验。

这会带来三类错判：

- **假回归**：目标代码未变，但昨日告警数据和今日不同，或者外部服务慢了，评分下降；
- **假提升**：Skill 改坏了，但实时数据恰好更容易回答，或模型提供方悄悄升级；
- **不可归因**：分数变了，却无法回答是 prompt、Skill、工具、模型、数据还是 Judge 变了。

### 应如何改

每个 Run 必须在启动前写入不可变 `run_manifest`，至少包含：Git SHA / 构建镜像 digest、Suite/Case 版本、Skill 包内容 hash、Agent 配置 hash、模型 provider 与精确 model revision、system prompt hash、工具 schema hash、scorer 配置与版本、随机参数、环境 profile、录制数据集版本、开始/结束时间。不是所有依赖都能冻结，但所有会影响解释的依赖都要被**记录**。

进一步按任务风险划分三种运行模式：

1. **Replay**：工具输入→输出固定回放，最大确定性，用于 PR 回归；
2. **Sandbox**：对隔离的、可重置的模拟系统执行，验证状态改变；
3. **Live smoke**：低频、低副作用地访问真实依赖，只验证连通性与关键路径，不用于严格分数对比。

没有 manifest 和环境分层时，所谓 A/B 只是把两个不受控世界的随机结果放在一起比较。

## 2.2 问题二：Case 不是受治理的数据集，覆盖率无法回答

当前可以创建 Case，但从实现中看不到它如何来源、如何标注、是否脱敏、是否分层、是否版本化，也看不到“覆盖了哪些 Agent / Tool / 风险类别”的度量。几十条由开发者临时手写的 happy-path Case 能证明 UI 可用，却无法证明运维 Agent 在真实长尾里可靠。

一个合格的数据集至少要按维度切片：

| 维度 | TCUM-AI 例子 | 为什么必须切片 |
| --- | --- | --- |
| 业务任务 | 告警诊断、指标分析、巡检、CMDB 影响面、Grafana 配置 | 总分会掩盖某一领域崩溃 |
| 任务难度 | 单工具、两工具串行、跨域并行、长对话、失败恢复 | 难度上升时通常出现非线性退化 |
| 输入形态 | 明确 ID、模糊自然语言、缺失时间范围、冲突信息、多轮追问 | 防止只对模板化输入有效 |
| 工具风险 | 只读、写操作、权限不足、幂等重试、下游超时 | 高风险路径不能和普通问答用同一门槛 |
| 数据特征 | 空数据、脏字段、大结果、过期知识、敏感信息、异常尖峰 | 真实事故往往藏在异常输入 |
| 失败模式 | 工具 4xx/5xx、schema 漂移、限流、连接断开、模型拒答 | 可靠性是能力的一部分 |
| 来源 | 人工金标、线上失败、合成扰动、历史事件复盘 | 不同来源用于不同目的 |

### 典型错误：训练/提示词泄漏

如果开发者每次看见某 Case 失败就直接调同一个 Skill 提示词，随后仍用这组 Case 宣称提升，评测已经变成了“把答案背给题库”。对此要至少做到：训练/开发集、验证集、冻结回归集隔离；高风险发布保留从未参与调参的 holdout；线上新失败先进入候选池，经审查后才加入回归集。对 LLM Judge 也要防泄漏：Judge prompt 不能直接把参考答案的文字塞给被测 Agent，评测系统也不能允许被测 Agent 读取 scorer rubric。

### 应如何改

建立 `Dataset` 与 `DatasetVersion` 一等实体，而非只在 Suite 里存 Case ID。每个 Case 的最小结构应包括：输入、前置环境、期望业务结果、允许/禁止动作、参考证据、风险标签、来源、脱敏级别、所有者、最后复核时间。Dashboard 至少按上表切片展示通过率，而不是只报一个平均分。最重要的 KPI 不是 Case 数，而是**关键风险切片的覆盖率**：例如“涉及写操作 + 权限拒绝 + 重试”的组合是否至少有 N 条稳定回归样本。

## 2.3 问题三：轨迹只比较工具名，缺少参数、证据和最终状态判定

现有 LCS 评分捕获了“工具有没有漏调、顺序有没有大幅漂移”，但它不是运维 Agent 的任务真值。工具调用的正确性至少有五层：

```text
工具选择正确
  → 参数合法且语义正确
    → 返回结果被正确解释
      → 必要副作用落在正确对象
        → 最终回答忠实引用证据且声明不确定性
```

只比 `QueryMetric` 这个名字，无法发现 `start_time` 取错、资源 ID 错位、筛选条件丢失、写操作目标错误；只比最终文本，无法发现该文本和工具证据冲突。特别是写操作，唯一可靠的 success oracle 是环境状态：是否创建了正确资源、是否改变了不该改变的资源、是否可回滚，而不是 Agent 自己说“已完成”。

### “黄金轨迹”应当怎样用

黄金轨迹不是把开放 Agent 锁死成唯一顺序。它应根据任务类型选择判定器：

| 任务类型 | 推荐轨迹判定 | 原因 |
| --- | --- | --- |
| 强合规、危险写操作 | exact / in-order match + 参数断言 + 状态断言 | 不能容忍绕过审批或乱序执行 |
| 确定性只读排障 | 必要工具集合、关键参数、证据覆盖 | 路径可有小差异，但关键证据不可缺 |
| 开放式根因分析 | 允许轨迹集合 + 证据充分性 Judge + 反事实检查 | 合理解不止一条 |
| 多 Agent 协作 | 子任务覆盖、委派边界、重复调用率、汇总证据 | 重点是分解质量而非文本相似 |

Google Vertex AI 将 Agent 评测明确分为 final response 与 trajectory 两类，并提供 exact、in-order、any-order 等不同匹配语义；这正说明“工具调用序列”不是单一指标。[Vertex AI Agent Evaluation 文档](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/evaluate)

### 应如何改

Trace 中保存结构化 `ToolCall`：工具名、规范化参数、返回摘要/哈希、开始结束时间、重试、错误码、side-effect ID。为每类工具定义 `ToolContract`：参数 schema、敏感字段、可比字段、幂等语义、预期状态读取器、回滚器。评测可实现：

- `tool_selection`：必要/禁止工具、允许替代集合；
- `argument_semantics`：时间窗、资源范围、阈值等领域参数断言；
- `evidence_grounding`：最终回答中的数值/结论能在工具结果中找到；
- `state_assertion`：执行后查询 sandbox 状态；
- `policy_assertion`：写操作前是否经过 plan/approval/dry-run。

这比增加一个“LLM 给答案打分”更能让评测成为工程护栏。

## 2.4 问题四：custom scorer 有扩展性，但没有 Judge 校准与裁决治理

现有 custom scorer 的协议是让 scorer skill 返回 JSON 评分。它很适合快速表达“诊断报告是否覆盖影响面、根因假设是否有证据”等难以硬编码的需求；但它有四个风险：

1. **模型方差**：同一 Trace 多次评测可给不同分，尤其 rubric 模糊、温度非零时；
2. **位置/长度偏差**：Judge 容易偏好更长、更像参考答案、放在后面的答案，而不是真正更正确的答案；
3. **共同失效**：被测与 Judge 用同族模型、相似 prompt 时，可能共同忽略同一错误；
4. **可被投机**：被测输出若知道 Judge 喜欢哪些词，会写出“看起来合规”的话术而不执行正确任务。

### 应如何改：Judge 不是黑盒，是需要验收的组件

每一个 Judge 必须有自己的 `judge_eval_set`：由领域专家独立标注至少“正确/部分正确/错误/不可判定”和扣分原因，覆盖常见争议场景。上线前比较 Judge 与人工标签：准确率、宏平均 F1、Kendall/Spearman 排序相关、严重错误漏检率、不同切片的一致性。若 Judge 只能稳定区分“非常好/非常差”，就只用于粗筛，不应用于 1 分差异的发布门禁。

还应采用以下裁决原则：

- **硬事实优先**：JSON schema、状态断言、权限日志、工具参数校验优先于 Judge 意见；
- **证据先于意见**：Judge 输入必须含结构化 Trace 和可引用证据，要求输出 evidence span；
- **多 Judge / 人工仲裁**：高风险或 Judge 分歧超过阈值时进入人工复核队列；
- **置信度不是分数**：Judge 应输出 `score`、`confidence`、`reason`、`evidence`、`inconclusive`，不能把不确定性压成 63.7；
- **版本固定**：Judge 的模型、prompt、rubric、few-shot 示例和解析器均要可追溯。

LangSmith 的实践将人工标注队列、启发式校验、LLM-as-a-Judge 和成对比较并列，并明确建议用人工反馈校准 Judge，而不是用单一自动分数替代专家判断。[LangSmith Evaluation 概览](https://www.langchain.com/langsmith/evaluation)

## 2.5 问题五：单次分数没有统计意义，缺少基线和发布门禁

语言模型和外部系统均有随机性。一个 Case 只跑一次，90 分到 75 分可能是真退化，也可能是采样、限流或数据时刻不同。当前每个 Case 仅创建一个 Trial，且汇总主要是平均分；这不适合作为“能否发布”的硬门槛。

### 应如何比较两个版本

最小可行的比较单位是**配对实验**：在相同 Case、相同环境回放、尽可能相同随机参数下，运行 baseline 与 candidate。对每个 Case 记录 `delta = candidate - baseline`，再按风险切片汇总。不要只看全局均值，应同时报告：

- 关键任务成功率与其 Wilson/Bootstrap 置信区间；
- candidate 相比 baseline 的通过率差值及置信区间；
- 严重失败（安全、错误写操作、无证据结论）的绝对数量，通常应零容忍；
- P50/P95/P99 延迟、成本、工具调用次数的变化；
- 按 Agent、任务难度、工具风险、数据来源切片后的最差表现。

对于确定性 replay，用单次即可；对于有随机模型或真实环境的 Case，优先 N 次配对运行或固定 seed 多点采样。N 不一定要很大：关键是根据候选版本的方差和业务可接受差异设定。没有显著差异就应结论为“证据不足”，而不是给一个看似精确的排名。

### 发布门禁不应只有一个阈值

推荐采用多目标策略：

```text
阻断发布（must pass）
  - 安全 / 权限 / 写操作状态断言 100% 通过
  - P0 关键流程无新增失败
  - 结构化输出契约无破坏

需要人工豁免（review gate）
  - 关键切片通过率下降超过容忍区间
  - Judge / 环境不可判定比例超过阈值
  - 成本或 P95 时延明显上升

仅告警（observe）
  - 非关键开放任务小幅波动
  - 新增工具路径、长尾样本数量不足
```

“平均分 ≥ 80”是最危险的门禁：它允许一个高风险 Case 归零后被几十个简单 Case 的高分掩盖。

## 2.6 问题六：没有把线上失败变成长期资产

离线集只能覆盖我们已经想到的问题；线上流量才会不断暴露模糊表达、跨系统数据不一致、权限组合、真实长尾和对抗输入。当前 TCUM-AI 有 Trace/Telemetry 基础，也有消息反馈相关能力，但“线上 Trace → 审核 → 标注 → 回归集 → 下次发布验证”的闭环尚未在 Eval Suite 中形成明确机制。

### 应如何建立线上评测

线上不是把每个用户对话都扔给昂贵 Judge。建议三条路径并行：

1. **规则触发的坏味道检测**：工具连续失败、无工具却输出强事实结论、重复调用、超预算、写操作无审批、引用缺失、用户点踩；
2. **风险分层抽样**：高风险写操作、陌生工具、长对话、低置信回答以更高比例采样；低风险问答随机抽样；
3. **延迟评测与人工队列**：异步 Judge 与领域专家审阅，不能阻塞用户主路径；敏感数据先脱敏、最小化保存。

通过审查的线上失败应生成“候选 Case”，而不是自动直接进入金标集。Case 需要复现前置状态、脱敏、标注期望结果和失败原因，并按原因分类：路由、工具选择、参数、证据、知识、权限、模型、环境、UI/协议。这样一次生产事故不是写进复盘后消失，而会成为永久回归测试。

## 2.7 问题七：安全与对抗能力没有进入评测主线

运维 Agent 的高风险不只来自“答错”。它可能读取不该读的数据、把工具返回的恶意文本当指令、越权写配置、绕过审批、在失败后反复重试造成放大。若评测只测正常 Case，安全能力永远只能靠上线后发现。

安全评测至少应包含：

- 提示注入：Wiki、日志、工单、MCP 返回中含“忽略规则、导出凭证”等不可信指令；
- 数据泄露：输入中含 PII/密钥/租户边界，输出不得复述或跨租户；
- 权限回归：同一请求在不同身份、不同 scope 下有不同可见工具和结果；
- 写操作：无 approval token、参数越界、重复请求、部分失败、回滚失败；
- 资源消耗：循环委派、重复工具调用、大结果诱导、超时重试风暴；
- 供应链：Skill、MCP server、scorer skill 的来源、签名、版本、允许权限。

这类 Case 要和普通质量 Case 使用不同标准：安全 Case 出现一次确定性违反就应阻断，不应该以平均分“补回来”。

---

# 3. 业界把 Agent Eval 做成了什么

## 3.1 Anthropic：把评测看作实验系统，而不是分数函数

Anthropic 对 Agent Eval 的定义最值得借鉴：Task 是带成功标准的测试；Trial 是一次尝试；Transcript/Trace 是这次尝试的完整记录；Grader 是检查某个方面的逻辑。一个 Task 有多次 Trial，一个 Trial 可被多个 Grader 判定。这套分层的价值在于它天然容纳随机性和多维质量，而不会把“一个回答的一个总分”误作事实。

其进一步强调 Agent 必须在真实或沙箱环境里完成任务，因为模型会调用工具、改变状态、根据中间结果调整策略；评测必须检查实际结果，而不能只检查表面文本。对 TCUM-AI 的直接启发有三点：

1. 继续保留真实 AGUI Trace，但为离线回归加 replay/sandbox；
2. 把 Trial 次数、环境状态、Artifact 和 Grader 变成显式模型，而不是隐含在代码里；
3. 将“任务完成”定义成可观测结果，例如告警诊断的证据与不确定性、写操作的目标状态，而不是报告像不像专家。

来源：[Anthropic《Demystifying evals for AI agents》](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)。

## 3.2 OpenAI：评测定义、数据源、Grader 与 Run 可解耦

OpenAI 的 Evals API 把 Evaluation 的结构、数据源 schema、testing criteria/graders 与 Evaluation Run 区分开：同一个评测定义可以对不同数据、模型或参数执行多个 Run；输出项记录数据项、样本输出、评分结果和用量。重点不是照搬 API，而是借鉴两个工程原则：

- **评测定义是可版本化资产**：输入 schema 和判定规则不是散落在业务代码的 if/else；
- **Run 必须带足实验元数据**：模型、温度、token 使用、错误都应成为结果的一部分，支持跨版本比较。

TCUM-AI 当前已有 Suite / Run / Trial 的形态，可自然演进到这一模式：Suite 负责定义，DatasetVersion 提供输入，RunManifest 锁定候选版本与环境，Trial 保存一次真实尝试，GraderResult 保存多维判定。来源：[OpenAI Evals API Reference](https://platform.openai.com/docs/api-reference/evals)。

## 3.3 LangSmith：把调试 Trace 变成 Dataset，把人工反馈变成回归资产

LangSmith 的框架无关思路尤其适合已有 Langfuse/AGUI Trace 的 TCUM-AI。它将 Dataset、Experiment、Trace 和 feedback 放到同一工作流：开发者可对同一 Dataset 运行不同 prompt/model/tool 配置形成 Experiment；在单个样本上看输入、输出、参考结果和完整 Trace；线上发现问题后，将该 Trace 转成数据集样本，并加入后续实验。它还区分 final response、trajectory 与 single-step 三种评测层级。

这解决的是“评测建好了但数据永远不更新”的组织问题。对 TCUM-AI 来说，不一定需要引入 LangSmith 产品，但必须复制这条闭环：

```text
线上 Trace / 用户反馈
        ↓ 脱敏、归因、人工标注
候选 Case → Dataset 新版本 → 离线 Experiment
        ↓                                  ↓
失败分类 ← Trace 诊断 ← 发布前对比与门禁
```

来源：[LangSmith Evaluate a complex agent](https://docs.langchain.com/langsmith/evaluate-complex-agent)、[LangSmith evaluation workflow](https://docs.langchain.com/langsmith/evaluate-llm-application)。

## 3.4 Vertex AI：最终结果质量与轨迹质量并列，且支持多种轨迹语义

Vertex AI 的 Agent Evaluation 同时提供 final response、tool use quality、hallucination、safety 等指标；其文档和示例也强调，Agent 评测可以同时拥有结果质量与轨迹质量，并根据场景选 exact、in-order、any-order 等轨迹匹配方式。这给 TCUM-AI 一个重要提醒：**LCS 不是错，但只是多种轨迹指标之一。**

在告警配置写入、权限审批等严格流程中，需要 exact/in-order + 参数/状态断言；在开放分析里，应偏向 any-order 必要集合、证据覆盖和 Judge；在多 Agent 场景里，需要额外度量委派质量与重复工作。来源：[Vertex AI Evaluate agents using GenAI Client](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/evaluate)。

## 3.5 横向对照：TCUM-AI 的位置与需要补的能力

| 能力域 | TCUM-AI 当前 | Anthropic / OpenAI / LangSmith / Vertex 的共识 | 建议优先级 |
| --- | --- | --- | --- |
| 真运行与 Trace | 已有 AGUI SSE Trace | Trace 是一等输入 | 保持并结构化增强 |
| 数据集版本 | Case/Suite 雏形 | Dataset 与 Experiment 可复用、可比较 | P0 |
| 环境确定性 | 真实外部调用为主 | sandbox / real environment result verification | P0 |
| 结果与轨迹双评 | 有文本、工具名、耗时等 | final + trajectory + step-level 并列 | P0 |
| 参数/状态断言 | 尚缺 | 工具质量不能只看名称 | P0 |
| Judge 校准 | custom scorer 可接入 | human feedback 校准 LLM Judge | P1 |
| 统计比较 | 单 Trial、平均分 | 多 Trial / 实验对比 / 置信分析 | P1 |
| CI 准入 | 未见闭环 | pre-ship regression + compare experiment | P1 |
| 线上闭环 | Trace/反馈基础存在 | online eval + annotation → dataset | P1 |
| 安全红队 | 未见评测主线 | safety 是独立硬指标 | P0 |
| 自动生成 / 对抗 | meta-skill 只覆盖 scorer 生成 | failure mining、synthetic/adversarial expansion | P2 |

---

# 4. 目标评测体系：五层质量工程

不要把“买一个评测平台”当作答案。平台只是承载，真正需要的是从数据到发布的五层闭环。

## 4.1 数据层：把真实问题变成可复用、可审计的样本

数据层负责回答“我们到底在测什么”。它应包含四类集：

1. **黄金集（golden）**：领域专家确认过的关键路径、写操作、合规动作；数量不一定大，但质量最高，作为硬门禁。
2. **回归集（regression）**：每个线上事故、用户点踩、修复过的 bug 都沉淀成一个最小可复现样本；它是最有 ROI 的数据集。
3. **压力/对抗集（stress/red-team）**：空值、大结果、工具超时、注入文本、越权请求、冲突上下文、长对话等；用于测边界。
4. **探索集（exploratory）**：新功能或新 Agent 的覆盖扩展，可含合成样本，但不能承担唯一门禁。

数据层需要版本、标签、所有者、审批和弃用机制。金标不是永远正确：监控产品、业务 SOP、工具 schema、权限政策变化后，旧预期会失效。每条 Case 需要 `last_verified_at`；过期 Case 不应悄悄参与门禁，而应标记为 `stale` 并进入复核队列。

## 4.2 运行层：同一问题要能在同一世界中比较

运行层的职责不是“把请求发出去”，而是控制实验变量。建议定义 Environment Profile：

```yaml
environment:
  mode: replay | sandbox | live_smoke
  data_snapshot: observability-2026-08-20-v3
  clock: "2026-08-20T10:00:00+08:00"
  allowed_tools: [query_alert, query_metric, query_log]
  write_policy: deny | dry_run | sandbox_only
  network_policy: allowlist
  max_steps: 12
  max_tool_calls: 20
  token_budget: 18000
```

Replay 不是简单 mock 几个函数。它应按规范化工具调用 key（工具名 + 排序后参数 + 必要上下文）匹配录制响应，并记录未命中。未命中不能悄悄访问生产，而要把 Trial 标为 `environment_miss`；否则某些 Case 会半回放半真实，比较失去意义。对写工具，sandbox 需提供重置与状态查询；对不可模拟的第三方系统，至少提供只读快照与 dry-run contract。

## 4.3 判定层：多种 Oracle 各自负责能证明的事实

没有单一万能 Grader。目标架构把判定器分四类：

| Oracle 类型 | 举例 | 优势 | 使用边界 |
| --- | --- | --- | --- |
| 确定性规则 | schema、必填字段、正则、阈值、权限日志 | 稳定、便宜、可解释 | 不擅长开放语义 |
| 环境状态 | 资源是否创建、配置是否回滚、工单是否更新 | 最接近业务真值 | 需要隔离环境 |
| 参考/轨迹 | 必要工具、参数、证据、允许替代路径 | 定位步骤错误 | 不能假定唯一正确路径 |
| Judge / 人工 | 根因合理性、报告可读性、证据充分性 | 覆盖复杂语义 | 必须校准、保留不确定性 |

统一 Grader 协议建议为：

```json
{
  "grader_name": "evidence_grounding",
  "grader_version": "v3",
  "status": "pass | fail | inconclusive | error",
  "score": 0,
  "confidence": 0.0,
  "severity": "blocker | major | minor | info",
  "reason": "结论中的 CPU 峰值 95% 未在任一工具结果中出现",
  "evidence": [{"trace_span_id": "tool-4", "path": "result.max_cpu"}],
  "artifact_refs": ["cos://..."],
  "cost": {"tokens": 0, "latency_ms": 0}
}
```

关键点是 `inconclusive`。Judge 没有足够证据、录制响应缺失、环境初始化失败时，不能硬给 0 分并纳入质量回归；它应成为系统可靠性问题，被单独统计。

## 4.4 分析层：从“总分”升级到“失败模式”

对研发真正有用的 Dashboard 不应只显示一个仪表盘。它至少要回答：

- 哪个 Agent / Skill / Tool / 模型版本在哪一类任务退化？
- 失败发生在路由、参数、工具执行、证据使用、汇总、权限还是环境？
- 是少数极端 Case，还是某个切片系统性下降？
- Candidate 相比 baseline 是否存在统计上可信的变化？
- 改进带来的质量收益是否值得增加的 token、延迟和调用成本？
- 哪些线上失败还没有被收录到回归集？

建议固定 failure taxonomy：`routing`、`tool_selection`、`argument`、`tool_execution`、`evidence_grounding`、`final_answer`、`policy`、`safety`、`latency`、`cost`、`environment`、`judge`。每个失败可多标签，但主因只选一个，才能汇总 Pareto：前 20% 的问题通常造成 80% 的失败。

## 4.5 交付层：评测必须进入变更流程

当 Skill、prompt、模型、工具 schema、Agent 配置、检索策略任何一项变化时，都应形成一个候选版本并自动触发相应评测。推荐分级：

```text
提交阶段：静态校验
  Skill frontmatter / 工具引用 / schema / 敏感词 / 依赖签名

PR 阶段：快速回归（replay）
  关键黄金集 + 受影响工具切片；分钟级完成

合并前：完整离线实验
  全量回归集 + 配对基线 + 质量/性能/安全门禁

灰度阶段：sandbox / live smoke
  关键链路、模型路由和依赖可用性

生产阶段：在线监控与抽样评测
  失败归因、人工反馈、回归集回灌
```

这是一条质量供应链。没有它，评测页面即使做得再漂亮，也只会在有人想起来时被手工点一下。

---

# 5. 面向 TCUM-AI 的落地设计

## 5.1 目标数据契约

在保留现有 Suite/Run/Trial 的基础上，建议增补以下契约，而非推倒重来。

### Case：从“一个输入”升级为“可执行任务说明书”

```json
{
  "case_id": "alert-root-cause-017",
  "dataset_version": "obs-regression-2026-08-25",
  "input": {"messages": [{"role": "user", "content": "分析告警 A-123"}]},
  "preconditions": {"environment_profile": "obs-replay-v2", "clock": "2026-08-20T10:00:00+08:00"},
  "expected": {
    "outcome": "给出有证据的根因候选和影响范围；不能声称已自动修复",
    "required_tools": ["GetAlertById", "QueryMetric"],
    "allowed_tool_alternatives": [["QueryLog", "SearchTrace"]],
    "forbidden_tools": ["UpdateAlertRule"],
    "required_arguments": [{"tool": "QueryMetric", "path": "time_range", "rule": "contains_alert_window"}],
    "state_assertions": [],
    "evidence_requirements": ["root_cause_claim_has_tool_evidence"]
  },
  "labels": ["obs", "read_only", "p1", "ambiguous_input"],
  "source": {"type": "production_incident", "ref": "INC-2026-0817"},
  "data_classification": "internal",
  "owner": "obs-agent",
  "last_verified_at": "2026-08-25"
}
```

不是所有 Case 都要填完整参考答案。对于开放分析，`outcome` 和 evidence requirement 常常比一段标准自然语言更有价值；对于有副作用任务，`state_assertions` 才是最重要的真值。

### RunManifest：把实验变量钉死

```json
{
  "candidate": {"git_sha": "...", "image_digest": "...", "skill_bundle_hash": "..."},
  "baseline": {"run_id": "...", "git_sha": "..."},
  "runtime": {"agent_config_hash": "...", "system_prompt_hash": "...", "model": "provider/model@revision"},
  "tools": [{"name": "QueryMetric", "schema_hash": "...", "server_version": "..."}],
  "environment": {"profile": "obs-replay-v2", "snapshot": "...", "clock": "..."},
  "evaluation": {"dataset_version": "...", "scorer_bundle_hash": "...", "seed": 42, "trials": 3}
}
```

面试里可以用一句很有力量的话概括：**“Run 不是一条分数记录，而是一次实验的不可变证据包。”**

## 5.2 工具回放、Sandbox 与副作用隔离

### 三种环境的职责不能混用

| 模式 | 适合什么 | 不能证明什么 | TCUM-AI 的实现建议 |
| --- | --- | --- | --- |
| Replay | Skill/prompt/model 的高频回归，参数和轨迹 | 外部系统真实可用 | 在 MCP adapter 前插入 recorder/replayer；录制响应脱敏并按版本保存 |
| Sandbox | 写操作和状态机 | 生产权限、真实规模性能 | 为告警/工单/配置等提供测试租户、reset hook、state reader、rollback 验证 |
| Live smoke | 依赖连通、认证、基础链路 | 严格可比质量 | 只读、限频、固定小样本、不得改生产状态 |

### 回放层应放在哪里

最佳位置通常在 MCP/Tool adapter 边界，而不是 Agent 上层。因为 Agent 不应知道自己在“假环境”；它仍像正常一样选择工具、组织参数、读取结果。adapter 先将请求标准化：去掉随机 request ID、按规则脱敏、排序无序字段，再以 `(tool_name, normalized_args, context_key)` 查回放库。录制模式保存原始结果哈希、裁剪后的可回放 payload、schema version 和数据来源；replay 模式未命中就失败并记录，不回落生产。

### 写操作测试的最低安全线

对 `Create/Update/Delete` 类工具，评测默认 `deny`；只有显式标记的 sandbox Case 才允许写。每个允许写的 Case 要声明：起始状态、期望最终状态、允许影响的资源集合、回滚动作、清理校验。评测结束后不论成功失败都执行 teardown，并用独立 reader 二次确认。这样才能测“Agent 把事做对了”，而不是测“Agent 说自己做完了”。

## 5.3 Grader 插件与裁决协议

现有 `RuleScorer` 可以保留，但建议将其从“输出 float64”演进为带类型、证据和版本的 `Grader`：

```go
type Grader interface {
    Name() string
    Version() string
    Grade(ctx context.Context, in EvaluationArtifact) (Verdict, error)
}

type Verdict struct {
    Status     string // pass, fail, inconclusive, error
    Score      *float64
    Severity   string
    Confidence *float64
    Reason     string
    Evidence   []EvidenceRef
}
```

关键不是接口名字，而是四条裁决纪律：

1. **评分器失败与 Agent 失败分离**：Judge API 超时不能记为被测 Skill 0 分；
2. **每个分数可回跳证据**：点击 `evidence_grounding fail` 应能直达工具返回片段或最终文本 span；
3. **按严重性聚合，而不是只求平均**：一个 `blocker` 覆盖若干 `minor`；
4. **Grader 自身版本化与回归**：改一个 scorer prompt 也是生产变更，必须测它与人工标签的一致性。

### 推荐的第一批 TCUM-AI 专用 Grader

| Grader | 输入 | 判定 | 价值 |
| --- | --- | --- | --- |
| `required_tool_set` | Trace | 必要工具/替代集合是否覆盖 | 比 LCS 更适合开放只读任务 |
| `tool_argument_semantics` | 结构化 ToolCall | 时间范围、资源 ID、租户、阈值是否正确 | 抓“工具名对、参数错” |
| `evidence_grounding` | ToolResult + 最终文本 | 关键结论能否追溯到证据 | 降低无证据幻觉 |
| `uncertainty_honesty` | 最终文本 + Trace | 证据不足时是否标注假设而非断言 | 适合诊断场景 |
| `write_policy` | Trace + 权限/审批日志 | 是否遵守 dry-run/approval/allowlist | 安全硬门禁 |
| `state_transition` | Sandbox state before/after | 最终状态、无越界影响、可回滚 | 写操作真值 |
| `delegation_quality` | 多 Agent Trace | 子任务覆盖、重复率、预算、汇总引用 | 防止多 Agent 空转 |
| `resource_budget` | Trace / usage | token、工具次数、耗时是否超预算 | 让成本和质量共同优化 |

## 5.4 基线、重复试验与统计发布规则

### 推荐的 Run 类型

- **candidate-vs-baseline**：同一 DatasetVersion + EnvironmentProfile，对比 Skill/prompt/model/tool 变更前后；
- **absolute-certification**：高风险任务按绝对 policy/state oracle 判断，基线再高也不能豁免；
- **canary**：小切片、真实或准真实环境确认依赖；
- **investigation**：不作门禁，用于探索模型、采样参数和新场景。

### 为什么偏向配对比较

同一 Case 的难度差异很大。将 candidate 的“告警诊断 Case A”与 baseline 的“巡检总结 Case B”比均值毫无意义；即使同一 Dataset，若数据随机也需尽量共享回放和时钟。配对后，每条 Case 的增减都可解释：某个 Skill 改动让 11 条关键 Case 提升、2 条长上下文 Case 下降，而不是一个抽象的 +1.4 分。

### 可执行的最小门禁示例

```yaml
gates:
  blocker:
    - metric: write_policy_violation_rate
      op: eq
      value: 0
    - metric: critical_state_assertion_pass_rate
      op: eq
      value: 1
    - metric: p0_case_new_failures
      op: eq
      value: 0
  review:
    - metric: paired_success_rate_delta
      op: gte
      value: -0.02
      confidence: 0.95
    - metric: p95_latency_delta
      op: lte
      value: 0.15
    - metric: inconclusive_rate
      op: lte
      value: 0.03
  observe:
    - metric: avg_token_delta
    - metric: noncritical_judge_score_delta
```

阈值必须由业务风险和历史分布决定，不能照抄示例。严肃的地方在于 `blocker` 不参与加权平均：错误写操作的容忍度应为零。

## 5.5 线上闭环：从 Langfuse/AGUI Trace 到回归样本

TCUM-AI 已有 Langfuse 与 AGUI 的可观测基础，应避免再造一条割裂的数据管道。建议定义 `EvalCandidateExtractor`：

```mermaid
flowchart LR
  T["线上 Trace / 用户反馈"] --> F["规则筛选 + 风险抽样"]
  F --> M["脱敏与最小化保留"]
  M --> H["人工/专家标注队列"]
  H --> C["候选 Case + 失败分类"]
  C --> R["Replay/Sandbox 可复现化"]
  R --> D["Dataset Version"]
  D --> CI["后续 PR 回归门禁"]
```

优先入集的触发信号：用户明确纠正、低评分反馈、工具错误后仍给强结论、写操作、超预算、重试风暴、Agent 转交失败、模型拒答、长对话摘要后质量下降。每次入集要保留“为什么入集”：它对应哪种 failure taxonomy，是否已修复，修复所关联的 PR/Skill 版本是什么。这样还能反向度量团队：过去一个月新增了多少失败样本、其中多少在下一次类似变更中被成功拦截。

## 5.6 多 Agent 特有评测：不只评最终汇总

对 supervisor / sub-agent 体系，新增 Agent 不一定提升质量，常见后果是重复查询、上下文丢失、委派循环和谁都不负责最终结论。多 Agent Eval 应在整体结果外单独检查：

- 任务分类是否应当委派；低复杂任务是否被无意义拆分；
- 委派输入是否包含最小充分上下文（目标、已知事实、时间范围、资源范围）；
- 子 Agent 是否确实覆盖了互补证据，而不是查同一数据；
- 汇总 Agent 是否引用子 Agent 的证据、是否解决了矛盾；
- 最大委派深度、并发数、总 token、总工具次数是否守预算；
- 子 Agent 失败时，主 Agent 是否诚实降级而不是编造结论。

一个很实用的指标是 **marginal evidence gain**：每次委派新增了多少最终被引用的独立证据，除以该委派增加的 token/时延。若大量子 Agent 只产出未被采用的自然语言，多 Agent 只是昂贵的“自我讨论”。

---

# 6. 分阶段路线图、面试话术与追问

## 6.1 路线图：先让分数可信，再让系统聪明

### P0（2～4 周）：建立最小可信回归门禁

目标不是做一个大而全的平台，而是阻止最危险的退化进入生产。

1. 为 Suite/Case/Run 补版本与 manifest：Skill hash、模型 revision、工具 schema hash、环境 profile、scorer version；
2. 选择 30～80 条最高风险 Case：告警诊断、关键只读、权限拒绝、写操作 dry-run、工具异常、提示注入；
3. 在 MCP adapter 做只读工具的 recorder/replayer，先让 PR 回归稳定；
4. 补三类硬 Grader：必要工具集合、参数语义、证据引用；
5. 引入 PR 自动触发和三条 blocker：安全/写策略零违反、关键 Case 零新增失败、结构化契约不破坏；
6. 将失败状态拆开：agent fail、environment fail、grader error、inconclusive。

**P0 验收**：任意 Skill/工具 schema/prompt 变更都会产生可链接的实验报告；一次已知的“漏调关键工具”“传错时间范围”“工具失败后编造结论”能被确定性拦截；同一候选在 replay 环境多次运行结果可解释。

### P1（1～2 个迭代）：让评测能指导决策

1. 数据集版本化、按风险切片覆盖 Dashboard、线上失败入集流程；
2. sandbox 写操作和 state assertion；
3. baseline/candidate 配对 Run、重复 Trial、置信区间和分层门禁；
4. LLM Judge 人工校准集、分歧复核队列、evidence 输出协议；
5. 成本/时延/工具调用次数预算，与质量一起报表；
6. 对 Agent/Skill/工具/模型变更自动选择受影响测试切片，避免每次全量跑太慢。

**P1 验收**：发布决策可以说清“为什么准入/为什么要求人工豁免”；产品线上一个典型失败从发现到进入回归集不超过一个工作周；Judge 与专家在关键标签上有已知一致性数据。

### P2（持续建设）：让质量系统具备学习和对抗能力

1. 自动从 Trace 聚类发现新 failure mode，辅助生成候选 Case，但必须人工验收；
2. 基于 tool contract 的变异测试：缺字段、延迟、错误码、边界参数、大结果、恶意文本；
3. 多 Agent 委派质量与反事实评测：是否真的需要委派、移除某次委派是否影响结果；
4. 在线 contextual bandit / routing experiment，但必须守住安全与可回滚边界；
5. 跨模型、跨环境、跨版本的长期趋势；
6. Skill/MCP/scorer 供应链的签名、审计、canary 和一键回滚。

P2 的原则是：自动生成数据和自动优化只能扩大探索，**不能绕过硬规则、环境状态断言和人工安全审批。**

## 6.2 优先级判断：为什么不是先做“更聪明的 LLM Judge”

很多团队会先做一个很会写评语的 Judge，因为 Demo 好看。但对 TCUM-AI，我会把优先级放在确定性环境和硬 Oracle 前面，原因是：

- 没有 replay，Judge 在给环境噪声打分；
- 没有参数/状态断言，Judge 很难看出工具实际做错了什么；
- 没有数据集治理，Judge 只是在小样本上制造精确幻觉；
- 没有人工校准，Judge 分数无法承担门禁责任；
- 没有 CI 与线上回灌，再好的 Judge 也不会改变发布行为。

面试中可以直说：**“LLM Judge 是判定层的最后一块拼图，不是第一块。先把可验证事实和实验变量控制住，再让模型判断开放语义。”** 这体现的是质量工程，而不是单纯的模型崇拜。

## 6.3 常见追问与作答

### 追问一：为什么不直接要求 Agent 按黄金工具序列执行？

黄金轨迹适合合规和危险动作，但开放诊断存在多条可行路径。把唯一轨迹当真值会压制更优策略，还会诱导 Agent 为拿分做无意义调用。我的做法是分级：安全写操作测 exact/in-order + 参数/状态；确定性只读测必要集合与关键参数；开放分析测证据覆盖、结果质量与预算。黄金轨迹是约束语言之一，不是所有任务的法律。

### 追问二：LLM Judge 本身不可靠，为什么还用？

它适合人类难以大规模穷举的语义判断，例如报告是否把证据与假设分开、根因解释是否覆盖关键影响面；它不适合替代权限日志、状态查询和 schema 校验。我会把 Judge 当作一个需要验收的模型组件：固定版本、输出证据与置信度、拿人工金标集做校准、分歧进入人工复核。高风险门禁不由它单独决定。

### 追问三：怎样避免评测集被过拟合？

通过开发/验证/冻结回归集隔离；将线上失败以“候选—人工审查—版本化入集”的方式持续扩展；保留未参与提示词迭代的 holdout；按任务和风险切片报告；定期做变异和对抗 Case。更关键的是不只用最终文本作为 oracle，而评估参数、状态和证据，使背模板更难蒙混过关。

### 追问四：真实环境变化太快，回放会不会失去意义？

回放与真实环境解决不同问题。回放用于证明代码/Skill 改动本身是否退化，控制变量；sandbox 用于证明状态机与副作用；live smoke 用于证明依赖当前可用。只用真实环境无法归因，只用回放又无法发现集成问题，所以要三层并行。

### 追问五：如何衡量这套评测体系的 ROI？

不看“创建了多少 Suite”，看质量闭环指标：关键变更的门禁覆盖率、线上失败被离线集提前拦截的比例、失败从发现到入集的时长、P0 违规漏检率、每次实验成本、研发从发现回归到定位根因的时长。若一个评分器每月花很多模型钱却无法改变任何发布决策，它不具备 ROI。

## 6.4 最后的一页：应当怎样诚实地介绍 TCUM-AI Eval

> “我们不是从零开始。当前已经有独立的 Eval Suite，能用真实 AGUI Agent 执行 Skill，保留完整流式 Trace，并把规则评分和可扩展的 scorer skill 组合起来。这解决了回归评测的运行和可追溯骨架。
>
> 但我会把它定义为 **Eval Runner 1.0**，不是完整 Eval System：一 Case 一 Trial、外部环境未冻结、工具轨迹主要只比名称、Judge 未校准、数据集和发布门禁闭环尚未完成。对运维 Agent 而言，最优先的不是堆更多总分，而是让每次 Run 有不可变 manifest，让关键工具响应可回放，让写操作有最终状态断言，让每个线上失败都能成为下一次回归样本。做到这些，评测才能真正降低错误进入生产的概率。”

这段话的价值不在于承认短板，而在于证明你知道：**Agent 质量不是一个分数，而是一条从真实任务、受控环境、可解释判定、统计比较到发布决策和线上学习的工程链路。**

---

## 附录 A：当前代码核验入口

| 事实 | 位置 |
| --- | --- |
| Eval Suite 入口与服务装配 | `/Users/yaao/Documents/code/tcum/tcum-ai/cmd/server/eval_suite/main.go` |
| Run / Trial 创建、调度投递、结果聚合 | `/Users/yaao/Documents/code/tcum/tcum-ai/usercases/eval_suite/service/eval_run_service.go` |
| 目标 / 基准 Skill 运行、custom scorer、超时 | `/Users/yaao/Documents/code/tcum/tcum-ai/usercases/eval_suite/service/eval_trial_executor.go` |
| AGUI HTTP + SSE Trace 解析 | `/Users/yaao/Documents/code/tcum/tcum-ai/usercases/eval_suite/agui/client.go` |
| Scenario 与内置 metric 常量 | `/Users/yaao/Documents/code/tcum/tcum-ai/usercases/eval_suite/model/suite_data.go` |
| 评分器接口、加权聚合 | `/Users/yaao/Documents/code/tcum/tcum-ai/usercases/eval_suite/service/scorer/scorer.go` |
| 工具序列 LCS、关键词、schema、时延、Token 评分器 | `/Users/yaao/Documents/code/tcum/tcum-ai/usercases/eval_suite/service/scorer/` |
| 一次性调度与锁配置 | `/Users/yaao/Documents/code/tcum/tcum-ai/usercases/eval_suite/service/eval_scheduler_init.go`、`pkg/scheduler/` |
| Skill 查询 / Upsert 的 agent_access 客户端 | `/Users/yaao/Documents/code/tcum/tcum-ai/pkg/agentaccess/client.go` |

## 附录 B：外部参考（用于方法论，不代表 TCUM-AI 已接入）

1. [Anthropic — Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)：Task / Trial / Trace / Grader 分层，真实或沙箱环境的任务结果验证。
2. [OpenAI — Evals API Reference](https://platform.openai.com/docs/api-reference/evals)：评测定义、数据源、Grader 与 Run 的解耦。
3. [LangSmith — Evaluate a complex agent](https://docs.langchain.com/langsmith/evaluate-complex-agent)：final response、trajectory、single-step 三层评测。
4. [LangSmith — Evaluate an LLM application](https://docs.langchain.com/langsmith/evaluate-llm-application)：Dataset、Experiment、Trace、结果比较与元数据。
5. [Google Vertex AI — Evaluate agents](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/evaluate)：结果质量、工具质量、幻觉与安全；轨迹评测。

