# AI Agent 与 Harness 专题

> 本目录聚焦 AI Agent / Agent Harness 的**源码级架构分析**与**面试题库**，覆盖两条不同的技术路线：TypeScript 插件化事件溯源（DeepSeek Harness）与 Go 静态类型编排（Eino）。两者可互相印证——一个成熟的 Agent 框架，往往同时需要"编译期/类型级别的正确性保证"和"运行期/事件级别的可观测可恢复能力"，只是各家先做深了哪一半。

## 目录结构

| 子目录 | 定位 | 入口文件 |
|---|---|---|
| [`DeepSeek-Harness/`](./DeepSeek-Harness/) | 开源 Agent Harness，Cordis 插件化 + 事件溯源范式 | [`00-源码架构与50问.md`](./DeepSeek-Harness/00-源码架构与50问.md) |
| [`Eino/`](./Eino/) | Go Agent 运行时：Compose、ADK、多 Agent、ReAct、Skill、MCP 与 TCUM-AI 实践 | [`00-源码架构与74问.md`](./Eino/00-源码架构与74问.md) |

---

## DeepSeek-Harness（DSH）

**一句话定位**：基于 Cordis 的可组合 Agent harness——模型、工具、会话日志、主循环、持久化和 UI 都是插件；模型看到的上下文由仅追加的会话事件日志派生。强调"可替换能力接缝 + 可回放事实流"，而不是把功能固化进一个私有主循环。

| 文件 | 内容 |
|---|---|
| [`00-源码架构与50问.md`](./DeepSeek-Harness/00-源码架构与50问.md) | 架构全局图 + 50 问，覆盖 A~J 十大主题：架构可扩展性、运行循环与状态机、会话/记忆/恢复、上下文工程与压缩、工具/权限/执行环境、人机协作与计划、多 Agent 与长任务、LLM 可靠性与成本、可观测性与测试、面试式取舍题 |
| [`deepseek-harness-analysis.zh.md`](./DeepSeek-Harness/deepseek-harness-analysis.zh.md) | 更长篇的源码深度分析，逐子系统通读（Session、agent-loop、Scope、LLM 层、Compaction、Capability Seam、Shell/Sandbox、Subagent、Hooks、Extensions、Persistence 等 20+ 节） |
| [`长任务拆解-四家Agent对比.md`](./DeepSeek-Harness/长任务拆解-四家Agent对比.md) | Codex / Claude Code / dsh / tcum-ai 四家在长任务拆解上的 Plan / Progress / Delegate / Persist 四层能力对比 |

**核心关键词**：Cordis 插件、Capability Seam（Service Definition/Provider/Consumer 三角）、Turn/Step 分层、SessionEvent 仅追加日志、`deriveMessages()` 投影、Plan Mode 状态化、Subagent Continuation、Checkpoint Policy。

---

## Eino

**一句话定位**：字节跳动内部半年多迭代后开源的 Go 语言 LLM 应用开发框架。用**静态类型的组件抽象**统一 ChatModel / Tool / Retriever 等原子能力，用**图编排（Chain/Graph/Workflow）**在编译期做类型检查、运行期自动处理流式拼接/合并/复制、统一注入 Callback 切面；在此基础上用 **ADK** 把 Agent（含多智能体、Human-in-the-loop）也做成同一套可编排的组件。

| 文件 | 内容 |
|---|---|
| [`00-源码架构与74问.md`](./Eino/00-源码架构与74问.md) | 以 Eino v0.8.0 与 TCUM-AI 源码为基线：多 Agent 九类拓扑对比、ReAct 有环图、Middleware 顺序、TCUM-AI 扩展点、Skill 三层渐进披露、MCP Server/Client 三条链，以及状态、上下文、工具治理、评测、安全等生产 Agent 核心领域 |

**核心关键词**：Compile 期类型检查、Chain/Graph/Workflow 三种编排、四种流式范式（Invoke/Stream/Collect/Transform）、自动拼接/流化/合并/复制、Callback 五切点、CallOption 两级体系四级分发、Interrupt & CheckPoint、ADK（ChatModelAgent = ChatModel + Tools + ReAct Loop + Middleware）、AgentAsTool。

---

## 两条路线的对照速览

| 维度 | DeepSeek Harness | Eino |
|---|---|---|
| 语言/类型系统 | TypeScript，运行时为主 | Go，编译期静态类型检查 |
| 核心切入点 | 事件溯源（可审计/可回放） | 类型系统（接线正确性前移到 Compile） |
| 可扩展基座 | Cordis 插件 + 可逆 effect | 组件抽象 + Option 模式 |
| 编排/流程控制 | Waterfall 事件插点（`agent/pre-step` 等） | Graph/Chain/Workflow 编译产物 `Runnable[I,O]` |
| 流式处理 | 逐 chunk 持久化，UI 按事件回放 | 四种范式 + 自动拼接/装箱/合并/复制 |
| 中断恢复 | Session fork/resume + Checkpoint Policy 插件 | Interrupt & CheckPoint（静态/动态/外部触发） |
| 多 Agent | Subagent provider 可替换 + Continuation 桥接取消 | AgentAsTool（推荐）+ Workflow Agents（Sequential/Loop/Parallel） |
| 横切面 | 事件监听器 + Hooks 桥接 | Callback（5 切点/3 触发实体）+ CallOption（4 级分发） |
| 最大代价 | 学习曲线高：Cordis 生命周期/scope/事件模式 | 概念面宽：流式范式/Callback/CallOption/FieldMapping |

**面试迁移建议**：两家都验证了"不把功能固化进一个私有主循环"这一共识——用**显式挂载点 + 组合**取代"直接改核心循环"。差异在于先做深了哪一半：DSH 先做深"运行期可审计可恢复"，Eino 先做深"编译期类型正确性"。回答"如何设计一个 Agent 框架"类问题时，可以从这两条路线的取舍出发，讲清"为什么两者最终都会朝对方靠拢"（比如 Eino ADK 的 Middleware 与 DSH 的插件扩展点本质同构）。

## 延伸阅读

- 项目实践对照：[`01-项目专题/03-TCUM-AI/`](../../01-项目专题/03-TCUM-AI/00-索引与使用说明.md)（基于 Eino ADK 构建的生产级 Agent 平台，可与本目录的框架原理分析互相印证）
