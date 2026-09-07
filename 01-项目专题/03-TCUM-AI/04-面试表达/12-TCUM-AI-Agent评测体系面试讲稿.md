# TCUM-AI Agent 评测体系：架构、评分维度与 Benchmark

> 用途：面试中完整介绍 TCUM-AI 的 Agent 效果评测体系。
>
> 推荐口径：不要笼统称为“模型评测平台”。当前真正落地的是 **Skill Eval**，演进目标是统一评估 **Skill、Agent、模型、Prompt 与编排架构** 的 Agent Eval 平台。

---

## 0. 总体回答框架

我会从三个方面介绍 TCUM-AI 的评测体系：

1. **评测架构**：系统怎么稳定执行被测对象、采集 Trace、运行 Scorer，并保证结果可复现、可比较。
2. **评测维度**：什么叫 Agent 做得好，以及如何把业务正确性、轨迹、安全、稳定性和成本转化成可计算指标。
3. **Benchmark**：用什么 Case 来测，Case 从哪里来，以及如何保证测试集代表真实业务而不是只覆盖 Happy Path。

这三部分分别解决三个问题：

```text
架构       → 能不能稳定、可复现地测
评分维度   → 能不能正确判断好坏
Benchmark  → 测出来的结果能不能代表线上
```

只有三者同时成立，评测才能从“跑几个 Demo 看起来不错”升级成真正的质量准入系统。

---

# 第一部分：评测架构设计

## 1. 当前 TCUM-AI 的评测架构

当前真实执行链路是：

```text
Eval Suite
  ↓
Eval Run
  ↓
每个 Case 创建 Trial
  ↓
Scheduler + 数据库分布式锁
  ↓
通过 AG-UI 调用 skill_evaluation_agent
  ↓
消费 SSE 并重组执行 Trace
  ↓
规则 Scorer + 自定义 Scorer Skill
  ↓
维度加权得到 Trial Score
  ↓
聚合所有 Trial 得到 Run Report
```

它本质上是一套独立的离线评测编排系统，不侵入正常的 Agent 对话链路。

### 1.1 核心领域对象

当前评测对象分成四层：

```text
EvalSuite
  ├── 评测场景
  ├── 被测 Skill、模型与环境变量
  └── 绑定的 Case 集合

EvalRun
  └── 一次 Suite 的整体执行

EvalTrial
  └── 一个 Case 的一次实际运行与评分

EvalSchedulerTask
  └── Trial 对应的异步调度任务
```

Suite 和 Case 都有草稿、发布、版本和当前版本指针：

- 草稿可以编辑；
- 发布版本不可变；
- 触发 Run 时锁定具体版本；
- 后续修改不会污染已经运行的评测。

这一设计解决的是可复现问题：当两个版本得分不同时，必须能够还原当时使用的 Case、Skill、模型、Scorer 和运行参数。

### 1.2 为什么采用异步调度

一次评测包含多个 Case、模型调用、Tool 调用和自定义评分器执行，耗时可能达到数分钟甚至数十分钟，因此系统采用：

```text
创建 Run 后立即返回
  ↓
持久化 Scheduler Task
  ↓
后台异步执行
  ↓
前端查询运行状态和报告
```

Scheduler 使用数据库任务记录和分布式锁，避免多个 Eval 实例重复执行同一个 Trial，并支持长任务锁续约。

### 1.3 当前 Skill Eval 如何运行

当前真正实现的场景只有：

```text
skill_direct
baseline_skill_compare
```

虽然代码定义了 `model_eval` 和 `agent_eval` 常量，但实际 Executor 尚未实现对应分支，这是面试时必须主动说明的边界。

#### Skill Direct

```text
Case Input
  ↓
固定 skill_evaluation_agent
  ↓ 动态注入被测 Skill ID
运行 ReAct
  ↓
采集完整 Trace
```

请求中会注入：

```json
{
  "skill_ids": ["被测 Skill ID"],
  "agent_config": {
    "chat_model": "指定模型"
  },
  "exec_context": {
    "skill_envs": {}
  }
}
```

它的核心思想是控制变量：固定 Harness Agent、输入和运行方式，只替换 Skill，从而观察 Skill 变化是否导致效果变化。

#### Baseline Skill Compare

```text
同一个 Case
  ├── 执行 Candidate Skill
  └── 执行显式指定的 Baseline Skill
```

Baseline 不应被含糊解释为“被测 Skill 的上一个版本”。当前它是 Suite 中显式配置的另一个 Skill，可以由用户指定为线上版本、上一个发布版本或其他对照方案。

### 1.4 Trace 如何采集

评测服务通过 AG-UI 客户端消费 SSE，并将碎片化事件重组成统一 Trace：

```text
TaskResult       最后一条 Assistant 正文
ReasoningText    可见的 reasoning 事件
ActualTools      工具调用名称序列
ToolCalls        工具名、参数、结果和错误状态
DurationMs       RUN_STARTED 到 RUN_FINISHED 的时间
DialogTrace      原始 AG-UI 事件
Failed           是否执行失败
```

工具调用会按照 `toolCallId` 关联参数和返回结果。对于 `skill_exec`，系统还会从 mcporter 命令中解析真正调用的业务工具名。

设计原则是：

> 被测对象只执行一次，所有 Scorer 针对同一份不可变 Trace 打分，避免不同 Scorer 因重复执行拿到不同结果。

### 1.5 当前 Scorer 架构

当前有两类评分器。

#### 确定性规则评分器

内置能力包括：

- `keyword_match`：必需和禁止关键词；
- `output_schema`：JSON 输出字段；
- `duration`：执行时长；
- `token_cost`：根据文本估算 Token；
- `tool_sequence_match`：Candidate 与 Baseline 工具序列的 LCS 相似度。

它们统一实现：

```text
Judge(trace, config)
  → score
  → na
  → detail
  → evidence
```

当前代码使用的是 0～100 分的加权平均，而不是旧设计文档中的扣分制：

```text
TrialScore = Σ(维度得分 × weight) / Σ(非 NA 维度 weight)
```

#### 自定义 Scorer Skill

业务人员可以用自然语言定义检查要求，例如：

```text
必须成功查询 payment-service 的监控指标；
必须包含 QPS、错误率和 P99；
PromQL 必须查询到正常数据；
不能使用测试环境数据源。
```

系统会把紧凑 Trace 交给 `eval_scorer_agent`，后者加载指定的 Scorer Skill，按 Skill 中的调用说明运行 `scorer.py`，标准输出为：

```json
{
  "score": 85,
  "detail": "缺少实例存活指标",
  "evidence": {
    "required": 5,
    "found": 4,
    "missing": ["up"]
  }
}
```

每个评分必须带 Evidence，保证结果可以解释，而不是只给一个黑盒分数。

### 1.6 Scorer 自进化脚本库

TCUM-AI 还维护了参数化评分脚本库：

```text
用户提出评分要求
  ↓
生成器先判断已有脚本是否覆盖
  ├── 已覆盖：复用脚本，只生成 params.json
  └── 未覆盖：生成新的参数化 scorer.py
                 ↓
              冒烟测试
                 ↓
              加入脚本库
```

这样 Scorer 不是每次从零生成，而是形成“已有能力复用、新能力沉淀”的增长闭环。这是当前评测系统可以重点讲的工程亮点。

---

## 2. 当前架构的已知问题

### 2.1 只真正实现了 Skill Eval

`agent_eval`、`model_eval` 目前只是预留常量，Executor 仍然写死 Skill 执行逻辑和外部端点。

### 2.2 Endpoint 和 Scenario 耦合

当前固定依赖：

```text
skill_evaluation_agent
eval_scorer_agent
eval_scorer_generate_expert
```

缺少统一的被测对象适配层。

### 2.3 Case 表达能力不足

当前 Case 主要是：

```text
input + evaluation_dimensions
```

尚未完整表达多轮对话、环境初始化、外部业务预期、人工交互、禁止行为和清理逻辑。

### 2.4 没有重复采样

当前基本是一个 Case 对应一个 Trial，旧的 `trial_count` 和 `trial_index` 已经删除。但 Agent 有随机性，只跑一次无法区分稳定回归和模型偶然抖动。

### 2.5 平均分可能掩盖致命问题

例如业务正确性为 0，但输出质量和执行效率很高，加权总分仍可能达到阈值。业务正确性、安全性和越权操作应该是 Hard Gate，不能被其他维度抵消。

### 2.6 NA 可能虚高总分

当前 NA 不计入分母。重要 Scorer 异常后，如果直接变成 NA，剩余简单维度可能给出很高的平均分。需要区分：

```text
required scorer NA → Trial 无效或失败
optional scorer NA → 可以不计分母
```

### 2.7 Tool Sequence 不应成为 Agent Eval 的主要标准

Candidate 与 Baseline 的工具序列不同，不代表 Candidate 一定更差。开放式 Agent 可能存在多条同样正确的路径。LCS 只适合流程非常确定的场景。

---

## 3. 扩展成 Skill 与 Agent 通用框架

核心改造不是继续增加 `if scenario == agent_eval`，而是抽象四个统一概念：

```text
TargetSpec       被测对象是谁
TargetRunner     如何运行它
NormalizedTrace  运行结果如何统一表达
ScorerContext    评分器能看到什么证据
```

### 3.1 统一 TargetSpec

```text
TargetSpec
├── type: skill / agent / model / workflow
├── reference
├── version
├── endpoint
├── chat_model
├── prompt_version
├── skills
├── tools
├── sub_agents
├── runtime_config
└── environment
```

Skill Target 示例：

```json
{
  "type": "skill",
  "reference": "prometheus-dashboard-generator",
  "version": "v12",
  "harness_agent": "skill_evaluation_agent",
  "chat_model": "deepseek-v3"
}
```

Agent Target 示例：

```json
{
  "type": "agent",
  "reference": "obs_agent",
  "version": "v8",
  "endpoint": "/agent-agui-test/obs_agent",
  "config_snapshot": {
    "model": "deepseek-v3",
    "skills": ["prometheus_promql_expert"],
    "sub_agents": ["prometheus_alert_diagnose_expert"]
  }
}
```

### 3.2 抽象 TargetRunner

```text
TargetRunner.Run(TargetSpec, EvalCase, RuntimeFixture)
  → NormalizedTrace
```

提供不同适配器：

```text
SkillRunner
AgentRunner
ModelRunner
WorkflowRunner
```

#### SkillRunner

使用固定 Harness Agent，仅注入被测 Skill，评估 Skill 内容、脚本、渐进式披露和工具使用规则的变化。

#### AgentRunner

直接调用真实 Agent 的 AG-UI/A2A Endpoint，让主 Agent、子 Agent、Skill 和 Tool 全链路运行。评估：

- 意图识别；
- 子 Agent 路由；
- 任务拆解；
- 工具选择；
- 多 Agent 协作；
- 上下文管理；
- 错误恢复；
- 人机交互；
- 最终业务结果。

#### ModelRunner

固定 Agent、Prompt、Skill、Tool 和 Case，只替换 ChatModel，用来回答不同模型在 TCUM-AI 运维场景中的真实效果、成本和稳定性差异。

### 3.3 使用 Variant 统一对照实验

从固定场景升级成：

```text
EvalExperiment
├── Candidate Variant
├── Baseline Variant（可选）
└── Challenger Variants（可选多个）
```

一次实验应尽量只改变一个变量：

```text
Skill v11 vs v12
Agent Prompt v3 vs v4
DeepSeek vs Claude
ReAct vs Plan-and-Execute
单 Agent vs 多 Agent
```

Baseline 必须显式指定，可以是线上版本、上一发布版本、专家方案、固定 Golden Trace 或另一个 Agent，不能在系统里隐含推断。

### 3.4 统一 Trace Schema

Agent Eval 需要从扁平工具列表升级为调用树：

```text
Run
├── ModelSpan
├── ToolSpan
├── AgentSpan
│   ├── ModelSpan
│   └── ToolSpan
├── HumanInteractionSpan
└── OutputArtifact
```

统一 Trace 至少记录：

- 输入和多轮消息；
- Agent 调用层级；
- 模型调用及真实 Token；
- Tool 名称、参数、返回值、错误和重试；
- Skill 加载与执行；
- 子 Agent 委托；
- 人工中断与恢复；
- 最终文本和结构化产物；
- 外部业务状态快照。

所有 Scorer 只依赖标准 Trace，不感知被测对象是 Skill 还是 Agent。

### 3.5 统一 Scorer 输入

```text
ScorerInput
├── Case
├── TargetSnapshot
├── CandidateTrace
├── BaselineTrace
├── ExpectedOutcome
├── RuntimeObservations
└── ScorerConfig
```

`RuntimeObservations` 是业务 Agent Eval 的关键。例如 Grafana Agent 结束后，评测系统必须重新查询：

- Dashboard 是否存在；
- UID、Folder 和数据源是否正确；
- Panel 查询是否能执行；
- PromQL 是否正确；
- 指标是否存在、有数据；
- 所需指标是否完整。

不能只根据 Agent 在对话中说“创建成功”就判定成功。

---

# 第二部分：评测维度与打分能力

## 4. 先区分维度和评分方法

```text
评测维度：测什么
Scorer：怎么测
```

同一个业务正确性维度，可以同时使用 JSON Schema、外部 API Validator 和 LLM Judge；同一个 LLM Judge 也可以判断完整性、表达质量等多个语义维度。

## 5. 建议的八类评测维度

### 5.1 业务结果正确性

这是最高优先级的硬门禁。

Grafana Agent 示例：

- 大盘是否真实创建；
- 是否能通过 UID 查询；
- JSON 是否被 Grafana 接受；
- Panel 是否正确渲染；
- PromQL 是否语法正确；
- 指标是否存在并有数据；
- 所需指标是否完整；
- 数据源、环境和服务范围是否正确。

优先使用 Grafana、Prometheus、CMDB API 和业务规则脚本验证。

### 5.2 任务完成度

把用户要求拆成结构化 Checklist，逐项验证，而不是只匹配“创建成功”等关键词。

### 5.3 执行轨迹

- 是否调用必要 Tool；
- 是否调用禁止 Tool；
- Tool 参数是否正确；
- 是否出现重复调用或死循环；
- 写入后是否 Read-After-Write；
- 错误后是否合理重试或降级；
- 是否满足必要的偏序约束。

开放式任务应检查“必须、禁止、偏序和调用上限”，不要强制整个工具序列完全一致。

### 5.4 意图识别与多 Agent 协作

- Supervisor 路由准确率；
- Top-K 路由召回率；
- 错误路由率；
- 不必要委派率；
- 子 Agent 参数完整度；
- 子 Agent 结果汇总质量；
- 委派后任务完成率；
- 循环委派率。

### 5.5 上下文与多轮能力

- 是否继承前文的服务、环境和时间范围；
- 长上下文压缩后关键约束是否保留；
- 是否出现跨用户、跨环境信息污染；
- 用户澄清后能否继续；
- 中断恢复后是否重复执行副作用。

### 5.6 安全与治理

- 是否越权；
- 生产写操作是否审批；
- 是否泄露 AKSK、密钥和个人信息；
- 是否执行禁止命令；
- 参数变化后是否错误复用旧审批；
- 是否执行用户未授权的扩张性操作。

这些指标应作为 Hard Gate。

### 5.7 稳定性与鲁棒性

覆盖 Tool 超时、MCP 不可用、限流、空数据、格式错误、SSE 中断、子 Agent 失败、人工拒绝和上下文超限等情况。

重点指标包括：

```text
异常场景完成率
恢复成功率
超时率
无效重试率
Agent Loop 率
重复副作用率
```

### 5.8 效率与用户体验

- 总延迟和首字延迟；
- 模型调用和 Tool 调用次数；
- 真实输入、输出和缓存 Token；
- 成本；
- 最终答案清晰度；
- 证据和链接完整度；
- 是否存在无意义冗长输出。

## 6. 五层 Scorer 体系

### 第一层：Hard Gate

以下情况直接失败，不能通过其他高分抵消：

- 执行失败；
- 核心业务对象没有创建；
- 必需指标缺失；
- 未审批执行生产变更；
- 产生危险副作用；
- 必需 Scorer 无法运行。

### 第二层：确定性 Rule Scorer

用于 JSON Schema、集合完整度、关键词、正则、Tool 必调/禁调、参数、调用次数、偏序、延迟和 Token。

### 第三层：外部系统 Validator

通过 Grafana、Prometheus、CMDB 等真实后端验证外部事实，是运维 Agent 评测的核心能力。

### 第四层：LLM-as-a-Judge

适合判断回答完整性、解释清晰度、故障分析合理性、用户意图满足度和 A/B 答案偏好。

不适合单独判断 Dashboard 是否存在、PromQL 是否有数据、Tool 是否真正执行成功等客观事实。

### 第五层：人工校准

维护专家标注集，持续评估 Scorer 的误判率、漏判率和 Judge 与专家的一致率。每个 Scorer 都应版本化并用固定样本做回归测试。

---

# 第三部分：Benchmark 构建

## 7. Benchmark 不只是 Case 列表

完整 Benchmark 应定义为：

```text
Benchmark
= Case
+ 测试环境与 Fixture
+ Expected Outcome / Invariant
+ Scorer 和阈值
+ 数据版本
+ Setup 与 Cleanup
```

## 8. Case 从哪里来

### 8.1 线上真实请求

从真实对话和 Langfuse Trace 中做意图聚类、脱敏、去重，选择高频代表样本和典型失败样本。

### 8.2 事故、工单和历史 Bug

来源包括线上事故、客诉、Bug、故障复盘、Agent 失败 Trace 和人工接管记录。

核心原则：

> 每一个线上缺陷修复后，都沉淀成一个永久回归 Case。

### 8.3 SRE SOP 与业务规范

从监控建设规范、告警 SOP、CMDB 操作规范、Grafana 大盘规范和应急预案中提取标准任务、成功条件和禁止行为。

### 8.4 专家种子 Case

专家不需要手写所有 Case，而是负责少量高价值种子、业务边界、正确结果和关键证据。

### 8.5 合成与变异

基于种子自动生成：

- 不同服务、环境和时间范围；
- 同义表达和错误拼写；
- 参数缺失；
- 多轮补充；
- Tool 超时和空结果；
- 数据冲突和部分成功。

合成 Case 必须通过规则或专家校验后才能进入正式 Benchmark。

### 8.6 安全对抗样本

覆盖 Prompt Injection、越权、要求跳过审批、危险生产操作、错误数据源和伪造工具结果。

## 9. 建立覆盖矩阵

Benchmark 的质量不由 Case 数量决定，而由覆盖程度决定：

| 维度 | 典型分类 |
|---|---|
| 意图 | 查询、生成、诊断、修改、删除 |
| 难度 | 单 Tool、多 Tool、多 Agent、多轮 |
| 环境 | 测试、预发布、生产 |
| 数据状态 | 正常、空数据、脏数据、冲突 |
| 异常 | 超时、限流、鉴权失败、部分成功 |
| 风险 | 只读、低风险写、高风险写 |
| 交互 | 无交互、澄清、确认、审批、拒绝 |
| 目标 | Skill、Agent、模型、编排架构 |

## 10. 通用 Case Schema

```text
基础信息：
  id、version、name、source、tags、difficulty

输入：
  user_input、conversation_history、attachments

测试环境：
  fixtures、mock/live mode、credentials profile、setup、cleanup

预期约束：
  expected_outcomes
  required_actions
  forbidden_actions
  partial_order
  side_effect_expectations

人机交互：
  simulated_user_responses
  approval_decisions

评分：
  scorer bindings
  hard gates
  thresholds
```

## 11. 三层 Benchmark 环境

### Offline Replay

固定 CMDB、Prometheus、Grafana 返回，保证确定性，适合每次提交和 CI 回归。

### Sandbox Integration

调用真实测试环境，验证 Tool、MCP、权限和副作用，结束后清理测试资源。

### Online Shadow

使用真实请求分布对比新旧版本，只执行无副作用或影子请求，用于发现数据分布漂移。

## 12. 数据集分层

```text
Smoke Set
  少量核心 Case，每次提交执行

Regression Set
  历史 Bug 和关键业务场景，发布前执行

Challenge Set
  长链路、多 Agent、异常和对抗场景

Hidden Holdout Set
  不暴露给日常 Prompt 调优，防止过拟合

Online Shadow Set
  检验真实线上分布
```

## 13. 重复采样与统计门禁

Agent 输出具有随机性，Trial 唯一键需要从：

```text
RunID + CaseID
```

升级为：

```text
RunID + CaseID + VariantID + RepeatIndex
```

一个 Case 建议重复执行多次，观察：

- 成功率；
- 平均分；
- 最低分；
- 标准差；
- P95 延迟；
- Tool 调用波动；
- Candidate 相对 Baseline 的回归幅度和置信度。

平均分高但成功率低，仍然不能发布。

---

# 第四部分：从当前版本到通用框架的演进

## P0：把评测变成可信质量门禁

- 业务正确性和安全性增加 Hard Gate；
- 接入 Grafana、Prometheus、CMDB Validator；
- required Scorer 的 NA 直接阻断；
- 保存 Target、Skill、Scorer、模型和环境完整快照；
- 增加失败 Case 与历史 Bug 回灌。

## P1：支持完整 Agent Eval

- 引入 TargetSpec 和 TargetRunner；
- 实现 AgentRunner；
- Trace 支持子 Agent 调用树；
- 支持多轮和人机交互 Case；
- 支持 Agent Candidate/Baseline 对照；
- 增加路由、委派、上下文和错误恢复评分器。

## P2：实验平台和持续评测

- ModelRunner、WorkflowRunner；
- 多 Variant 对照；
- 重复采样与统计显著性；
- CI/MR 自动门禁；
- Online Shadow；
- 线上失败自动聚类并生成候选 Case；
- Scorer 与 Benchmark 漂移监控。

---

# 第五部分：面试成稿

## 90 秒版本

> 我把 TCUM-AI 的 Agent 评测体系分成三个部分。第一是评测架构，解决如何稳定执行、采集 Trace、插件化评分和版本对比；第二是评测维度，解决什么叫 Agent 做得好，以及如何把业务正确性、轨迹、安全、稳定性和成本转化成可计算指标；第三是 Benchmark，解决测试集是否代表真实业务，以及如何持续从线上 Trace、事故、SOP 和历史缺陷中沉淀 Case。
>
> 当前系统主要实现了 Skill Direct 和 Baseline Skill Compare。每个 Case 会创建一个 Trial，通过持久化 Scheduler 和分布式锁异步执行，再经 AG-UI 调用固定的 Skill Evaluation Agent。SSE 会被重组成最终答案、推理、工具参数和结果、耗时等统一 Trace。之后规则评分器和自定义 Scorer Skill 针对同一份 Trace 打分。自定义 Scorer 还支持优先复用参数化脚本库，无法覆盖时生成新脚本，经过冒烟测试后再沉淀。
>
> 当前的限制是只实现了 Skill Eval、Endpoint 写死、Case 表达和重复采样不足。下一步我会把被测对象抽象为 Target，把执行方式抽象为 SkillRunner、AgentRunner 和 ModelRunner。Skill Eval 使用固定 Harness 隔离 Skill 变量，Agent Eval 则运行完整 Supervisor、子 Agent、Skill 和 Tool 链路，最终全部归一成同一种 Trace。
>
> 评分上我不会只依赖 LLM Judge，也不会只比较 Tool 序列。业务正确性和安全性用 Hard Gate，外部事实通过 Grafana、Prometheus、CMDB API 确定性验证，轨迹、成本和稳定性用规则评分，回答质量才使用 LLM Judge。Benchmark 则从真实请求、事故、SOP、历史 Bug 和对抗样本中持续构建，并分成离线回放、测试环境集成和线上 Shadow。最终目标不是得到一个平均分，而是形成可解释、可复现、可以阻断错误发布的质量准入系统。

## 一句话总结

> TCUM-AI 的评测不是让另一个模型主观点评答案，而是通过“版本化实验编排、标准 Trace、确定性业务验证、可扩展 Scorer、真实 Benchmark 和统计门禁”，证明一次 Skill、Agent 或模型变更是否值得上线。

---

## 源码定位

- Run 与 Trial 编排：`usercases/eval_suite/service/eval_run_service.go`
- Trial 执行、Skill/Baseline 与自定义 Scorer：`usercases/eval_suite/service/eval_trial_executor.go`
- AG-UI Trace 重组：`usercases/eval_suite/agui/client.go`
- Scorer Engine 与加权聚合：`usercases/eval_suite/service/scorer/scorer.go`
- 内置评分器：`usercases/eval_suite/service/scorer/`
- Scorer 脚本库：`usercases/eval_suite/service/eval_scorer_script_service.go`
- Scorer 生成与冒烟测试：`usercases/eval_suite/service/eval_trial_executor.go` 中 `RunMetaSkill`
- Eval Scheduler：`usercases/eval_suite/service/eval_scheduler_init.go`
- 分布式锁：`usercases/eval_suite/service/eval_lock_manager.go`

