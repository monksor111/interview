# Agent 岗深度反问 50 问

> **本卷定位**：面试临近结束"你有什么问题问我们吗？"环节的**反问弹药库**——不是问"团队氛围怎么样"这种敷衍问题，而是用**深度技术反问**证明你做过功课、有独立判断，甚至反过来考察面试官的技术深度。
>
> **原始出处**：本文原为针对 MiniMaxCode 核心负责人的定向反问清单，但**同一套问题适用于所有做 Agent Team / Code Agent / Coding Copilot 的部门**（阿里通义、字节 Marscode、腾讯 CodeGeeX、快手 KwaiCoder、小红书 Agent 团队等）——只需要把具体项目名替换即可。
>
> **配套阅读**：
> - 项目具体答题看 [07-面试题库-tcum-ai项目30问.md](../03-项目题库/07-面试题库-tcum-ai项目30问.md)
> - 通用深度追问看 [08-面试题库-通用Agent深度专题.md](../03-项目题库/08-面试题库-通用Agent深度专题.md)
>
> **合并说明**：本文件由 `12-反问清单-MiniMaxCode核心负责人.md` 保留主体 + 从 `14-套娃追问与Agent自进化专题.md` 抽出"套娃追问链"作为附录合并而成。反问不出招时用主体，出招后被反问回来（面试官问"你觉得应该怎么做"）用附录中的套娃链应对。

---

## 📑 目录

> 面试尾声"你有什么想问我们的吗"环节的反问弹药。共 7 大主题 + 开场三问 + 5 条深挖链附录（4 条"被反问回来"应答链 + 1 条主动挑话题的 dsh 独家链）。

- 使用说明
- 开场三问（定调，证明做过功课）
- 一、Agent Team 架构与 Team Engine（4–13）
- 二、模型与 Harness 协同训练（14–20）
- 三、上下文工程与记忆（21–27）
- 四、代码理解与检索（28–32）
- 五、可靠性、验收与安全（33–39）
- 六、评测、工程化与组织（40–44）
- 七、宏观判断与未来（45–50）
- 必须准备的反问（他大概率会问回来）

**附录 · 被反问回来时的"套娃深挖弹药"**
- 链 A · KV Cache 的追问（8 层）
- 链 B · 上下文管理与 Compaction 的追问（7 层）
- 链 C · "一切皆插件" 的追问（8 层，dsh 核心）
- 链 D · 长程任务可靠性追问（7 层）
- 链 E · dsh 事件溯源 & 投影架构的独家追问（6 层，主动挑话题用）

---

## 使用说明

- **真实只问 8~12 题**，其余作为知识储备防反问接不住。
- 优先级建议：**4、15、19、24、32、37、46、50**。
- 每个技术问题都已埋好 tcum-ai 的经历钩子（标注 🔗），务必带自己的坑一起问——"我踩过同一个坑"的问法，信息交换效率比单纯提问高一个量级。
- **别问能搜到的**（M3 参数、Team 有几个角色），只问 **为什么这么设计 / 代价是什么 / 现在还没解决什么**。

---

## 开场三问（定调，证明做过功课）

**1.** 你们博客里那句"多 Agent 系统是 runtime，不是 prompt 编排"，我特别有共鸣——我做领域 Agent 最大的教训就是：**能力靠 prompt 加，但可靠性只能靠 runtime 加**。想请教的是，你们是在什么时刻/踩了什么坑之后，决定把重心从 prompt 转到控制面的？

> 🎯 一上来抛"共同伤疤"，比抛概念有效。

**2.** 你们提了判断多 Agent 产品的五个问题（为什么拆分/如何验收/何时停止/失败如何恢复/如何管理记忆）。如果只能选一个作为"最难、最能拉开差距"的，你选哪个？为什么？

> 🎯 逼他排优先级，能听到真实技术判断而非官方叙事。

**3.** 从 MiniMax Code 1.0 到 2.0，如果只保留一个架构决策、其余全部推翻重做，你会保留哪一个？

> 🎯 高职级最爱回答"取舍题"，信息量极大。

---

## 一、Agent Team 架构与 Team Engine（4–13）

**4.** Team Engine 的 `producing → verifying → done`，是**完全代码确定性驱动**，还是状态迁移里也留了 LLM 判断（比如"是否需要重跑"由模型决定）？确定性和灵活性的边界画在哪？

> 🔗 我做 Grafana 大盘 Agent 时，布局校验（`core.ValidateLayout`）只 warn 不阻断，就是因为不敢让代码硬判语义——取舍标准是"错了能不能事后修"。
> 🎯 这是整个架构的命门。

**5.** Leader 判断"这个任务值不值得开 Team"，是 prompt 里的启发式，还是有分类器/规则/历史数据打底？误判（该开没开、不该开却开了）的代价怎么衡量？

**6.** verifying 不通过就回退 producing，**重试上限**怎么定？会不会出现"改一点—被退回—再改一点"的死循环把 plan 跑爆？有没有"降级交付 + 标注不确定"的兜底路径？

> 🎯 他们博客自己承认了这个成本，问他现在解到什么程度。

**7.** Worker 和 Verifier 是对抗关系，那**Verifier 的评判标准从哪来**？是 Leader 下发的验收清单、Skill 里固化的规则，还是 Verifier 自己现场生成？如果自己生成，它凭什么比 Worker 更可信？

**8.** Tester 强调 tool-grounded（结论必须来自命令/测试/可执行检查）。在**没有测试、没有 CI 的老项目**上，Tester 的"外部证据"从哪来？会不会退化成"让模型自己写个测试再自己跑过"的自证循环？

> 🔗 企业内网项目大多没测试，我们做可观测域 Agent 也是这个困境：生成的 PromQL 语法对但可能查不出数据，`PrometheusQuery` 验证是**可选**的，模型可以跳过。

**9.** Reviewer 和 Tester 分开是很清晰的设计。Reviewer 的意见对 Worker 是**强制的还是建议性的**？如果 Worker 不服气（认为 Reviewer 理解错了业务语义），谁来仲裁？

**10.** 拆分粒度你们承认是长期难点。现在是靠模型自由裁量，还是有"最小可验收单元"这类硬约束？有没有考虑**从历史 session 里学拆分策略**？

**11.** Agent 之间"同权"（可互相 prompt/spawn/abort/kill）在工程上很漂亮，但也意味着**Agent 能杀 Agent**。这套权限模型怎么防止级联误伤或互相打断导致的活锁？

**12.** 你们和 Claude Code Teams 的对比里提到它"跨会话长期运行能力有限"。你们的**跨会话恢复**具体到什么粒度——恢复任务树+产物，还是能恢复某个 Agent 的中间推理状态？

**13.** Team 里的 Agent 是**同一模型不同 prompt**，还是不同规格模型混排（Leader 强模型、Worker 快模型）？混排怎么处理"弱模型 Worker 的产出强模型 Verifier 看不上"的错配？

---

## 二、模型与 Harness 协同训练（14–20）

**14.** "M3 与 MiniMax Code 协同训练"具体是哪种协同？是**把 harness 的工具协议/输出格式喂进 RL 环境**，还是更进一步——产品线上真实 session 直接进训练回路？

**15.** 协同训练最大的收益点，是"工具调用格式更稳"这种表层，还是**"知道什么时候该停下来"**这种行为层？你们提到单 Agent 有"上下文焦虑"、对停止条件判断模糊——训练上是怎么攻这个的？

> 🔗 我们在自研 Agent 上完全没法训模型，只能用 prompt 硬教（`[OPTIMIZE-V3]` 探针那一套），效果很脆、每次换模型都要重调。
> 🎯 最想听的一题。

**16.** 协同训练的**反向代价**是什么？会不会导致 M3 过拟合到自家 harness，别人接 M3 做 Agent 反而不如你们？开源 M3 的同时怎么保证第三方接入的公平体验？

**17.** 模型迭代和产品迭代的节奏怎么对齐？模型换代（M2.5→M3）时，harness 里那些为旧模型缺陷写的**补丁逻辑/兜底 prompt** 怎么清理？有没有"能力上移就删代码"的机制？

> 🔗 我们仓库里沉了 10 条 prompt/schema 补丁"化石"（把 skill_name 塞进 command、沙箱里到处 which/ls 探测、失败后反复换参重试……），没有任何机制判断它们还该不该留着。
> 🎯 好的 harness 会随模型变强而变薄，这题很能显示工程成熟度。

**18.** 从你们的经验看，Agent 能力提升里 **模型 vs harness 的贡献比**大概怎么分？未来两年这个比例会怎么变？

**19.** MSA + 1M 上下文，对 Agent 架构的实际影响有多大？既然上下文这么长，为什么还要做 Team 做 Context 隔离——**长上下文和多 Agent 拆分，是替代关系还是互补关系**？

> 🎯 把两条技术路线摆一起让他表态，极好的开放题。

**20.** 原生多模态 + 桌面操作在 coding 场景真正的杀手级用法是什么？是"看截图改 UI"，还是更本质的——**让 Agent 自己看浏览器验证效果，作为 Tester 的证据来源**？

---

## 三、上下文工程与记忆（21–27）

**21.** 交接/共享/聚合三类成本里，现在**哪个还没解决好**？聚合（把 10 份合成 1 份）听起来最难，现在是纯靠 Leader 的模型能力，还是有结构化的合并流程？

**22.** handoff 文件、共享白板、Agent 通讯 CLI 三种机制并存，**选择规则**是什么？会不会出现同一份信息在三个渠道里有三个版本，导致 Agent 间事实不一致？

**23.** 白板是"按需优雅获取"，那 Agent 怎么知道白板上有什么值得取？靠目录/索引还是每次 list 一遍？这个元信息本身的 token 成本怎么控？

**24.** 记忆机制里，**什么样的经验才值得被写成记忆**？判断权在 Agent 自己还是有独立的"记忆守门人"？你们说"写记忆不能靠 Agent 自觉，需要软硬门禁"——这个门禁具体长什么样？

> 🔗 我们的记忆表 `Source`/`Confidence`/`HitCount`/`TTL` 六字段全齐，但**写入闭环全缺**——表结构全对、回路没接上，最怕的就是沉淀一堆噪音。

**25.** 记忆的**冲突和过期**怎么处理？项目重构后一条老记忆变成误导，谁负责让它失效？有没有做过记忆的召回率/伤害率评估？

**26.** "执行中的 Agent 也会被立刻通知新记忆"——这个热更新会不会打乱它正在进行的推理链？怎么判断一条新记忆值不值得打断当前执行？

**27.** 你们引用 Anthropic 那句"session ≠ context window"。你们实现里，**session log 作为外部上下文对象**具体存什么、怎么按需回灌？压缩/摘要环节丢信息导致任务跑偏怎么处理？

> 🔗 我们做了七层上下文压缩（列式表示层 → 结构化截断+COS 卸载 → 说明书侧压缩 → summarization elide → 超限自适应重试 → 摘要替代历史 → 场景化裁剪），但"压缩后任务跑偏"这件事我们没有任何度量手段。

---

## 四、代码理解与检索（28–32）

**28.** MiniMax Code 做代码库理解，走的是**索引/embedding 路线，还是 Claude Code 那种纯 agentic search（grep/glob 现场找）**？为什么做这个选择？

> 🔗 我做可观测 Agent 时是自建 embedding（混元/Venus/OpenAI 三选一）+ ES8 混合检索（kNN + BM25），成本和维护负担都不低，很想对比判断依据。

**29.** 如果做了向量索引：**索引失效/漂移**怎么办（分支切换、大重构、单仓多语言）？有没有量化过"索引带来的收益 vs 现场搜索"的差距？

**30.** 如果没做索引、靠模型现场搜：**超大 monorepo**（几十万文件）怎么办？靠 Leader 先做一轮"仓库地图"预热吗？这个地图持久化还是每次重建？

**31.** 混合检索我们踩过一个坑：向量分和 BM25 分量纲不同（BM25 无上界、cosine 归一化 0~1），RRF 又要付费 License，最终排序质量不可控。你们在**多路召回的融合排序**上有什么更工程化的做法？

> 🔗 我们应用层的补救是"双路 query（原文 + LLM 改写）位次交替穿插"，本质是 RRF 的极简实现；ES 内部那层至今是技术债。

**32.** Agent 检索到的上下文，怎么区分"**真实读到的**"和"**模型脑补的**"？有没有做**溯源强制**——产出必须携带证据引用，否则 Verifier 直接打回？

> 🔗 我们的原则是"事实靠工具查、结构靠代码拼"，但代码层其实没有强制闸门：模型完全可以不调 `FindMetrics` 就凭记忆编一个不存在的指标名，`BuildTCUMDashboard` 的 `expr` 是自由文本、不校验。
> 🎯 承认自己系统的缺陷再问怎么解，最能展示深度。

---

## 五、可靠性、验收与安全（33–39）

**33.** "把停止条件绑定到确定性可观测的外部系统"是我看到最实用的一句。在**没有明确外部信号**的任务上（写文档、做技术方案、改配置），停止条件怎么定？

**34.** 两层门禁里 **test/lint/build 视为一等公民**，在用户项目千奇百怪、构建都跑不起来时怎么落地？你们会主动帮用户补 CI 吗？

**35.** 高风险动作（合并代码、覆盖线上数据）必须人类签字。这个"高风险"的**识别**是规则清单还是模型判断？漏判过什么印象深刻的 case？

> 🔗 我们出过一次：Agent 回写大盘时 Name 为空，导致线上大盘名称丢失并被移到根目录，最后的解法是**直接拒绝空 Name**——护栏是被事故逼出来的，不是设计出来的。

**36.** 沙箱和权限：Team 并发跑多个 Worker 改同一个仓库，**文件冲突/写竞争**怎么解？每个 Worker 一个 worktree/分支，还是共享工作区 + 锁？

**37.** 你们引用《Cost of Consensus》——多 Agent 可能烧 2–3 倍 token 而准确率不升。内部有没有一条**"Team 到底赢在哪"的量化证据**？哪类任务 Team 明确优于单 Agent，哪类明确劣于？

> 🎯 敢引负面论文的团队一定有内部数据，问出来价值极高。

**38.** 对抗式校验最怕"走过场的 Verifier"制造虚假安全感。怎么**监控 Verifier 本身的严格度**？有没有注入已知 bug 做"验尸检验"（类似变异测试）？

**39.** Agent 交付"可回放、可追责的轨迹"——出事复盘时真的够用吗？能定位到"哪一步的哪个决策导致最终错误"，还是只能看到一堆日志？

---

## 六、评测、工程化与组织（40–44）

**40.** SWE-Bench Pro 这类榜单和**真实用户满意度**的相关性，你们观察到有多强？内部真正用来做发布决策的是什么指标？

**41.** 多 Agent 系统的**回归测试**怎么做？行为不确定、成本又高，是固定 replay、影子流量，还是抽样人工评？一次架构改动的验证周期多长？

> 🔗 我们完全没有效果评测集，每次改 prompt 都是"线上看感觉"，这是我自评的 P0 短板之一。

**42.** 你们最有效的**线上问题发现渠道**是什么？"我的 Agent 怎么不回我了"这种反馈，从用户抱怨到定位根因，链路怎么打通？

**43.** 做这样一个 harness，团队怎么分工——**模型侧 / runtime 侧 / 产品侧**的边界怎么划？协同训练意味着模型团队和产品团队必须极紧耦合，组织上怎么保证？

> 🎯 高职级很愿意聊组织，而且这决定了你进来做什么。

**44.** Agent 产品迭代这么快，怎么决定**什么该做进 runtime、什么留给 Skill/配置让用户自己搞**？我的经验是很容易把一堆 hack 塞进主流程，最后动不了。

---

## 七、宏观判断与未来（45–50）

**45.** Coding Agent 的终局形态你怎么看——**IDE 内的协作者**、**CI 里的自动化工人**，还是**接管整个仓库的常驻 owner**？三条路你们押哪条？

**46.** 你们提到未来"管理面板本身也可以由一个 Agent 控制"，并说这需要更强的模型。那 **Team Engine 这层确定性代码，长期是会变厚还是变薄**？如果模型足够强，多 Agent 编排会不会整个消失、退回单 Agent 长程执行？

> 🎯 "自我否定式"问题，最容易问出真诚的战略判断。

**47.** 三年后，Agent 领域"现在很热但会被证明是弯路"的东西，你觉得是什么？（MCP？多 Agent 编排？RAG？记忆系统？）

**48.** 开源 M3 和 Agent 框架，商业上的逻辑是什么？开源之后**护城河**落在哪一层——模型、harness，还是积累的用户记忆与 Skill 资产？

**49.** 对做**垂直/企业内部领域 Agent** 的人（我做云平台可观测域），你的建议是什么？哪些该自己造、哪些该赌"通用 Agent 半年后就免费覆盖"？我的判断是**领域知识和数据接入自己造、编排和上下文管理别自己造**，你怎么看？

> 🎯 亮出自己的定位和判断，也最容易转成"你来我们这做什么"。

**50.** 如果我进来做这块，你希望我在**头 3 个月**证明什么？你现在最缺的是"能把系统做稳的人"还是"能把架构再往前推一步的人"？

> 🎯 收尾必问，把面试转成入职对话。

---

## 必须准备的反问（他大概率会问回来）

> **"你做的那套，如果重做会怎么改？"**

建议答案框架（正好接上 Agent Team 的思路，显示判断力同频）：

1. **数据正确性加硬闸门**：`expr` 里出现的指标名/label 必须在 `FindMetrics` / `ListMetricLabels` 的返回值白名单内，否则工具直接拒绝——把"事实靠工具查"从 prompt 约定升级为 runtime 强制。
2. **生成后自动跑一次验证**：`BuildTCUMDashboard` 内置调用 `PrometheusQuery` 抽样验证每个面板有数据，无数据的面板标红返回，而不是等用户肉眼发现空图。
3. **引入独立 Verifier 角色**：把现在"第二版修复 Skill 兜底"的隐式设计，显式化为对抗式校验节点，且校验标准来自可执行检查而非模型自述。
4. **优先级要反转**：现状是"布局做了软校验、数据层没闸门"，但布局错误肉眼可见可事后修，数据错误会误导运维判断——**优先级应该反过来**。

> 补充自曝三条（主动说比被问出来好）：无工具级权限与 HITL 审批 / 无效果评测集 / RAG 融合排序技术债。

---

# 附录 · 被反问回来时的"套娃深挖弹药"

> **场景**：你反问了一个技术问题（比如"你们的 KV Cache 前缀稳定性怎么保证的？"），面试官反过来问你"那你觉得应该怎么做？"——这时候本附录就是你的弹药库。
>
> 本附录内容与 [08-面试题库-通用Agent深度专题.md](../03-项目题库/08-面试题库-通用Agent深度专题.md) 第三部分完全一致，此处冗余保留是为了**反问场景下不用切文件即可查到**——面试节奏比查阅整齐更重要。

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
  - **禁止摘要摘要**：dsh 的 checkpoint 事件带 `originalRange: [seq_lo, seq_hi]`，二次压缩时**直接跳过已被压缩的区间**，只压缩新事件；
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
- 强答：**续跑**。dsh 用 **Event Sourcing** 模式：`session.jsonl` 是唯一真源，进程 = 事件日志的纯函数。重启时 `SessionPersistence` 从磁盘读回事件序列，作为 `SessionOptions.seed` 传给新 `Session` 构造器（`SessionOptions.seed: readonly SessionEvent[]`，`packages/core/session/src/types.ts:108`），`seedSource='persistence'` 标识；`request/header` 里的 `reason: 'resume'` 明确标记恢复边界。`[docs/subsystems/session.zh.md]`

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
  3. **副作用 rollback**——如果崩溃发生在 tool 执行中期且工具不幂等，应该**拒绝 resume**并让用户决策；`session-persistence` backend 在重启时对孤儿 turn 追认 `TurnEndReason.kind='interrupted'`（`packages/core/session/src/types.ts:170`："A persistence backend closed a crash-orphaned turn on reload. The loop never emits this marker"），agent-loop 本身从不 emit 它。
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
  - **对比**：Claude Code / Codex 没有对应的 API——Codex 虽然有基于 Responses API 的会话接续（`previous_response_id`），但那是"新 turn"而非"turn 中途插入"；想在 CC/Codex 里改方向只能 ESC 中断再重新输入，中断的成本是丢失当前 turn 的上下文推理。

---

### 链 E · dsh 事件溯源 & 投影架构的独家追问（6 层）

> **本链定位**：以上 A~D 是"被反问回来"时候准备的弹药；链 E 是**主动挑话题**用的——面试聊到"你怎么看 Agent 架构未来演进"时，用 dsh 独家的源码事实拉深对话，把交流从"我了解一些概念"上升到"我对比研究了标杆实现的具体机制"。每层配一条**候选人可以主动抛出的话术**。

**E0（root）**："我最近在读 deepseek-harness 的源码，觉得它做的最激进的抽象是把 Agent state 完全事件溯源化。你们在 tcum-ai 后续演进上，考虑往这个方向走吗？"

**E1**：什么叫"完全事件溯源化"，具体激进在哪？
- 候选人补的深度：dsh `packages/core/session/src/types.ts` 里 `SessionEventMap` 定义了 12+ 事件类型，包括 `turn/start` `turn/end` `step/start` `step/end` `user/message` `assistant/chunk` `assistant/message` `tool/call` `tool/result` `todo/write` `request/header` `request/context`——**agent 进程等于事件日志的纯函数**：`deriveMessages()` 是纯函数（同一份事件流 → bit 级一致的 messages 数组），进程崩了从事件流重放就能恢复。这比 CC 的 `history.jsonl`（jsonl 里存的是**消息**）激进——CC 存的是"派生结果"，dsh 存的是"发生的事实"。
- **引出对方深度**：问对方"你们 tcum-ai 现在 `dialog_message` 存的是消息模型还是事件模型？如果重做会怎么选？"——这问题往往能引出对方内部对 event sourcing 的看法。

**E2**：那读侧怎么办？事件流再纯，业务查询总得有"当前状态"？
- 候选人补的深度：dsh 有 `SessionProjectionRegistry`（`packages/session/session-projection`）——**读侧独立成"投影层"**，插件注册 `ProjectionDefinition` 定义"事件流→派生视图"的 fold 函数。已注册的：`tokenUsage`（token-meter）、`contextPressure`、`todos`（tool-todo）、`permissions`（permission-presets）、`sessionTitle` 多个变体。再加 `session-projection-cache` 做快照缓存。**这才是 event sourcing 落地的关键**：写侧只有 append，读侧不同消费者各自 fold。
- **引出对方深度**：如果对方项目里现在读写没分家（比如 tcum-ai 里 `SkillCache` 是直接写在 `dialog` 表字段里的），可以问"你们规模上来后有没有考虑过读写分家？dsh 的 projection registry 是个不错的参考"。

**E3**：事件流那么细粒度，磁盘不会爆吗？崩溃恢复不会慢吗？
- 候选人补的深度：dsh 有**双 backend seam**（`SessionPersistence` 接口）：默认 `session-persistence-jsonl`（append-only + Zstd 压缩）、可切 `session-persistence-sqlite`。加上 `session-checkpoint-policy` 定义**每次 request 的 durability checkpoint 时机**——不是每个事件都 fsync，是按 request 边界批量落盘。恢复时 `SessionOptions.seed` 传入事件序列构造新 Session，`seedSource='persistence'` 标识（`packages/core/session/src/types.ts:108`、`:134`）。加 `compactCheckpointSource` 声明式压缩边界后，就算长会话有百万事件、恢复也只需从最近 checkpoint 开始重放。
- **引出对方深度**：问"你们线上真出过 session 恢复失败或耗时暴涨的场景吗？"

**E4**：既然事件流全存，那插件生态怎么保证不互相踩？
- 候选人补的深度：dsh 用 **Cordis**（依赖注入 + 事件总线）做插件系统，服务图是 DAG（`docs/cordis-api/context.zh.md`），有 `dsh-dependency-check` gate 静态检测循环依赖。事件也支持 waterfall / parallel / serial 多种 dispatch mode。**踩过一次**：`postmortem-0002` 里一个配置里的 `!!js` 表达式解析错误导致 filesystem-tools 的 listener 短路了整个工具注册链——后来加了 `docs/defensive-patterns.zh.md` 规范 + CI lint 强制"每个 `ctx.on` 必须在同一 scope 内有对应 disposer"。
- **引出对方深度**：问"你们 tcum-ai 现在的 skill/tool 系统，第三方能加自己的钩子吗？还是全 in-tree？"

**E5**：那 dsh 值得抄的最独门一招是什么？
- 候选人补的深度（3 选 1，看对方兴趣）：
  1. **KV Cache 一等公民**：`token-meter` 把 `cacheReadTokens/cacheWriteTokens` 做成独立字段（对比 tcum 现在只看总 usage），且 `request/header` 只在 canonical 变化时 append（`if (!headerEquals(baseline, header))`）——**前缀字节序列 bit 级稳定是 KV cache 高命中的数学基础**。加上 CI 强制每个包 README 声明 `#### KV Cache effect`，压根不给作者破 cache 的机会。
  2. **hooks 跨生态桥接**：`packages/hooks/hooks-claude-code` + `hooks-codex` 让 dsh 直接吃 CC/Codex 用户已有的 hook 脚本——**这是"兼容旧生态又坚持自己安全模型"的典型工程**（`updatedInput` 只 log + warn 不 honor）。
  3. **subagent 抽象 + 7 种 backend**：同一个 `SubagentProvider` 接口下有 `fork-in-process` / `spawn-in-process` / `acp` / `claude-code` / `codex` / `dsh-sdk`——**"把外部 agent 当自己的 subagent 用"**是 dsh 独门。CC/Codex 的多 agent 都是自家里的。
- **引出对方深度**：可以让面试官选一个展开——他选哪个，往往映射他自己项目最痛的地方。

**E6**：对我加入的第一件事该做什么，你觉得启发是什么？
- 候选人自我锚定：从 E1~E5 里挑一个和面试官项目现状匹配的独家 dsh 做法，作为**第一个可落地的架构升级建议**——比如 "我看你们现在 session 存的是消息模型，第一件事我想做的是把它 refactor 成 event log + projection 分离，参考 dsh 的做法但适配你们业务，一个 sprint 能出 POC"。
- **战略价值**：把技术追问自然接回"我加入能创造什么价值"，收尾极干净。

---


