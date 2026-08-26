const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, AlignmentType, LevelFormat,
  BorderStyle, TabStopType, HeadingLevel,
} = require("docx");

/* ============ 排版常量：字号/颜色/间距 三级层次 ============ */
const NAVY = "1F3864";       // 分区标题 / 定位标签
const GRAY = "666666";       // 次级信息（公司副标题、日期）
const GRAY2 = "595959";      // 联系信息
const BLACK = "000000";

const CN = "微软雅黑";
const EN = "Calibri";
const F = { ascii: EN, hAnsi: EN, eastAsia: CN, cs: EN };

const SZ = {
  name: 36,      // 18pt  一级：姓名
  tag: 21,       // 10.5pt 定位标签
  contact: 18,   // 9pt   联系信息
  section: 24,   // 12pt  二级：分区标题
  entry: 21,     // 10.5pt 三级：条目主标题（公司/项目名）
  role: 20,      // 10pt  条目右侧角色
  sub: 19,       // 9.5pt 四级：副标题/日期
  body: 19,      // 9.5pt 正文/要点
};

const CONTENT_W = 9906;      // A4 (11906) - 左右各 1000 DXA 页边距

/* ============ 基础构件 ============ */
const run = (text, o = {}) =>
  new TextRun({ text, font: F, size: o.size ?? SZ.body, bold: !!o.bold,
    italics: !!o.italics, color: o.color ?? BLACK });

// 分区标题：navy 加粗 + 整行下框线
const section = (text) =>
  new Paragraph({
    spacing: { before: 180, after: 70, line: 240 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: NAVY, space: 1 } },
    children: [run(text, { size: SZ.section, bold: true, color: NAVY })],
  });

// 条目第一行：左主标题（加粗）+ 右角色（加粗）
const entryHead = (left, right) =>
  new Paragraph({
    spacing: { before: 100, after: 0, line: 240 },
    tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W }],
    children: [
      run(left, { size: SZ.entry, bold: true }),
      run("\t" + right, { size: SZ.role, bold: true }),
    ],
  });

// 条目第二行：左副标题（灰）+ 右日期（灰斜体）
const entrySub = (left, right) =>
  new Paragraph({
    spacing: { before: 0, after: 30, line: 240 },
    tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W }],
    children: [
      run(left, { size: SZ.sub, color: GRAY }),
      run("\t" + right, { size: SZ.sub, color: GRAY, italics: true }),
    ],
  });

// 项目概述段（无符号、与要点左边界对齐）
const desc = (label, text) =>
  new Paragraph({
    spacing: { before: 0, after: 30, line: 250 },
    indent: { left: 170 },
    children: [
      ...(label ? [run(label, { bold: true })] : []),
      run(text),
    ],
  });

// 要点：粗体导语 + 正文（正文中可用 [[加粗]] 标记关键指标）
const bullet = (lead, text, level = 0) => {
  const parts = String(text).split(/\[\[(.+?)\]\]/g);
  const children = [];
  if (lead) children.push(run(lead + "：", { bold: true }));
  parts.forEach((p, i) => { if (p) children.push(run(p, { bold: i % 2 === 1 })); });
  return new Paragraph({
    numbering: { reference: "hollow", level },
    spacing: { before: 0, after: 20, line: 250 },
    children,
  });
};

// 业务收益行：挂在核心子工作下方，缩进一级、"收益"标签用深蓝加粗
const gain = (text) => {
  const parts = String(text).split(/\[\[(.+?)\]\]/g);
  const children = [run("收益：", { bold: true, color: NAVY })];
  parts.forEach((p, i) => { if (p) children.push(run(p, { bold: i % 2 === 1 })); });
  return new Paragraph({
    spacing: { before: 0, after: 40, line: 250 },
    indent: { left: 510 },
    children,
  });
};

// 技能行：粗体类目 + 内容，底部细线分隔
const skill = (label, text) =>
  new Paragraph({
    spacing: { before: 30, after: 30, line: 240 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: "D9D9D9", space: 2 } },
    tabStops: [{ type: TabStopType.LEFT, position: 1400 }],
    children: [run(label, { bold: true }), run("\t" + text)],
  });

/* ============ 文档 ============ */
const doc = new Document({
  styles: { default: { document: { run: { font: F, size: SZ.body }, paragraph: { spacing: { line: 240 } } } } },
  numbering: {
    config: [{
      reference: "hollow",
      levels: [
        { level: 0, format: LevelFormat.BULLET, text: "▪", alignment: AlignmentType.LEFT,
          style: { run: { font: { ascii: "Arial", hAnsi: "Arial" }, size: 16, color: NAVY },
                   paragraph: { indent: { left: 340, hanging: 170 } } } },
        { level: 1, format: LevelFormat.BULLET, text: "–", alignment: AlignmentType.LEFT,
          style: { run: { font: { ascii: "Arial", hAnsi: "Arial" }, size: SZ.body, color: GRAY },
                   paragraph: { indent: { left: 600, hanging: 170 } } } },
      ],
    }],
  },
  sections: [{
    properties: {
      page: { size: { width: 11906, height: 16838 },
              margin: { top: 900, right: 1000, bottom: 900, left: 1000 } },
    },
    children: [
      /* ---------- 抬头 ---------- */
      new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { after: 20, line: 240 },
        children: [run("乐宇辰", { size: SZ.name, bold: true })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { after: 20, line: 240 },
        children: [run("稳定性 / AI Agent 方向架构师　·　8 年工作经验", { size: SZ.tag, bold: true, color: NAVY })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { after: 0, line: 240 },
        children: [run("北京　|　18631732772　|　15580823476@163.com", { size: SZ.contact, color: GRAY2 })],
      }),

      /* ---------- 教育经历 ---------- */
      section("教育经历"),
      entryHead("北京理工大学", "硕士 · 计算机科学与技术"),
      entrySub("985 / 211 · 计算机学院", "2016.09 - 2018.07"),
      entryHead("中南大学", "本科 · 软件工程"),
      entrySub("985 / 211 · 软件学院", "2012.09 - 2016.07"),

      /* ---------- 工作经历 ---------- */
      section("工作经历"),

      entryHead("腾讯云 CSIG · 可观测平台组", "架构师 / 核心研发"),
      entrySub("统一运维平台（TCUM）· 可观测 / CMDB / AI 运维 / 运维底座 · Go", "2024.07 - 至今"),
      bullet("职责范围",
        "负责整个云运营端可观测、CMDB / 元数据、AI 运维、运维底座[[四个方向]]的架构设计与技术攻坚，虚线带领 [[10+ 人跨团队]]协作落地，具备公有云 / 专有云双栈架构经验。"),
      bullet("可观测与 SLO",
        "主导运营端统一监控与 SLO 体系从 0 到 1，把各云产品割裂自建的监控能力收敛为统一平台能力，完成核心 [[100+ 云产品]]接入，故障可观测率 [[55% → 85%]]。"),
      bullet("CMDB 元数据底座",
        "接手并重构腾讯云 CMDB，完成公私有云[[三套异构系统]]统一与模型驱动升级，使其从资源台账演进为支撑监控、变更与故障定位的核心元数据底座。"),
      bullet("AI 运维底座",
        "主导 AI 运维底座建设，以多 Agent + 开放协议构建可扩展架构，并基于该底座落地智能可观测、智能 CMDB，推动运维模式从人工驱动向 [[AI 辅助与主动运维]]演进。"),

      entryHead("蚂蚁集团（杭州）", "架构师 / 核心研发"),
      entrySub("业务稳定性平台 · 混合云基础平台 · Java", "2020.09 - 2024.07"),
      bullet("业务稳定性体系",
        "主导全站级稳定性中间件与平台建设，将业务故障发现与根因定位从依赖人工经验转为自动化，覆盖全站 [[3000+ Java 应用]]；获 BG 级技术创新奖（Westar + 蓝宝石），申请专利 2 篇。"),
      bullet("业务单元化架构",
        "主导蚂蚁业务单元化架构方案设计，并推动基金 / 保险等域完成改造，业务方[[年故障数下降 30%]]、机器资源节省 10%。"),
      bullet("公有云基础平台",
        "作为蚂蚁公有云基础平台[[一号位]]，从 0 到 1 完成云底座能力建设（账号权限 / 产品入驻 / 实例 / 交易 / 售卖策略），支撑 30+ 内部 SaaS 产品规模化上云与对客产品顺利公测，单产品上云周期[[从 3 个月缩短至 1 周]]。"),

      entryHead("百度在线网络技术（北京）", "后端研发工程师"),
      entrySub("DuerOS 垂类服务 · Java", "2018.07 - 2020.09"),
      bullet("", "负责 DuerOS 信息类 bot 后台研发，为 DuerOS 接入百度大搜索能力；独立完成 DuerOS-SDK 垂类开发与第三方技能接入。"),
      bullet("", "承担主干链路与旁路 API 的功能设计与开发，支撑小度系配套 APP / 官网业务。"),

      /* ---------- 项目经历 ---------- */
      section("项目经历"),

      entryHead("腾讯云 AI 运维底座（TCUM-AI）与多 Agent 能力体系", "架构师 / 核心研发　2025.06 - 至今"),
      desc("",
        "负责从 0 到 1 搭建腾讯云运维端 AI Agent 底座，基于 eino ADK 构建多 Agent 编排与上下文治理核心链路，并推动智能可观测、智能 CMDB 等运维场景的智能化落地。"),
      bullet("多 Agent 编排底座",
        "主导设计 5 种 Agent 执行形态与 3 种协作拓扑：总入口 Agent 在请求期查库动态装配子 Agent 清单，子 Agent 以 [[Agent-as-Tool]] 形式挂载实现上下文隔离与并行委派；跨进程 Agent 通过 [[A2A / AG-UI]] 远程壳以 HTTP + SSE 编排，实现 Agent 能力的配置化注入与跨服务复用。"),
      bullet("上下文工程与七层压缩",
        "针对长会话频发 [[ContextWindowExceeded]] 的问题，设计“源头减少—中间隔离—事后压缩”三段式防御：工具结果超 64KB 结构化截断并卸载至 [[COS]]（沙箱按需回捞）、Skill 说明书喂模型用精简版、[[RunLocalValue]] 哨兵保证一次性上下文只注入一次、周期性 summarization 与撞限后自适应压缩重试；配套 [[Token 三级计数降级与熔断]]，将单次工具注入从 MB 级压到 KB 级，支撑 20~30 轮跨产品根因分析稳定收敛。"),
      bullet("Skill 与 MCP 工具体系",
        "设计声明式 Skill 体系（4 种 Backend + 沙箱执行 + 轮次距离淡出缓存）实现能力零代码扩展；MCP 侧采用 [[mcporter 零 tool-schema]] 路线，远端工具不注册为 N 个 tool schema，改为加载 Skill 后以 tool result 按需呈现，从源头消除工具说明书的常驻 token 占用。"),
      bullet("SRE 数字分身",
        "设计运行时人格装配机制：同一 Agent 实例通过 [[BeforeAgent 中间件链]]在请求期注入人格、工具白名单与知识库，Tools 由空变非空触发 [[ReAct 图重编译]]，实现一个实例服务 N 个不同权限边界的分身，承接主动式巡检与告警值守。"),
      bullet("生产可靠性与效果度量",
        "落地工具异常兜底中间件避免单点报错终止全会话、沙箱数据面失效自愈、工具超时与并发控制；接入 [[Langfuse]] 四层零侵入 tracing，并自建 [[eval_suite]] 评测框架（case / skill 服务 + 多评分器），形成“上线—评测—回归”闭环。"),
      bullet("业务收益",
        "建成 [[13 个运维 Agent、11 个 MCP Server（约 128 个工具）、48 个声明式技能]]，覆盖告警诊断、指标问数、PromQL / InfluxQL 生成、巡检解读、变更观测与影响面分析；[[20+ 核心云产品]]接入 AI 可观测体系，[[30 个云产品]]低成本接入智能运维（月活 UV 100+），告警自动诊断覆盖率达 [[85%]]。"),

      entryHead("腾讯云运营端统一监控与云产品可用性（SLO）体系", "架构师 / 一号位　2025.08 - 至今"),
      desc("",
        "负责从 0 到 1 搭建腾讯云运营端统一可观测底座，解决各云产品自建监控、协议割裂、数据不通的问题，并将可用性能力对外沉淀为“云产品可用性（SLO）”数据产品。"),
      bullet("统一指标网关与写入面优化",
        "自研 remote-write 网关兼容 [[Prometheus / OpenTelemetry / Barad / ES]] 四类协议：Snappy + protobuf 解码复用[[对象池]]（5MB 解压缓冲、8000 series 预分配）降低 GC 压力；按 XStor 分库建独立内存队列做[[邻居隔离]]，后台 100 worker 批量出队并按库聚合为 Line Protocol 单请求写入，配合可配置 sleep 削峰，将接入延迟与存储延迟解耦，支撑[[数亿级时序数据]]写入。"),
      bullet("多存储路由与 PromQL 查询代理",
        "构建 [[XStor / VictoriaMetrics / ClickHouse]] 三存储架构：按指标元数据路由查询目标，对 sum/count/min/max 做[[存储端算子下推]]，CK 路径将数据扫描与元数据扫描并行并直接以 SQL GROUP BY 返回聚合结果；针对高基数查询打爆存储的风险，实现正则枚举改写、正则长度限制、1MB query 上限与最大样本数护栏，查询性能提升 [[50%]]。"),
      bullet("实时 SLI 计算与 SLO 指标体系",
        "在写入面旁路出实时 SLI 流（20000 容量 worker pool 做匹配、转换与 Kafka 输出），建成域名（内外网拨测）、服务（云 API）、实例三类客户可用性指标，输出全局 / 产品 / 客户[[三视角 SLO 视图]]，并配套白屏化插件式巡检与链路 Trace。"),
      bullet("告警治理与关联下钻",
        "统一告警网关侧做租户 / 地域归一化，将[[静默匹配前置]]到通知链路最前端（内存快照匹配、首条命中短路、命中仍留历史以保可审计），并用 [[errgroup]] 并行历史留存与通知分发降低尾延迟；复用 CMDB 关系拓扑为指标补齐资源与业务标签，实现区别于传统监控的[[指标关联下钻]]，支撑变更观测与故障影响面分析。"),
      bullet("业务收益",
        "完成核心 [[100+ 云产品]]监控告警接入（TCS 底座 / 计算 / 存储 / 网络 / 数据库 / 中间件 / 大数据），核心云产品覆盖率 81%；支撑 [[43 个地域、70+ TCS 集群]]稳定性运营，故障可观测率 [[55% → 85%]]、MTTD 保持分钟级、告警准确率提升至 70%，年度主动发现问题 25 个。"),

      entryHead("腾讯云统一 CMDB 架构重构与公私一体", "项目负责人　2024.09 - 至今"),
      desc("",
        "接手腾讯云 CMDB 后主导整体架构重构，将集团、星云、专有云三套模型与存储异构的系统统一为公私一体的 Global CMDB，并从计算资源查询平台升级为数据面 / 管控面的统一元数据出口。"),
      bullet("元模型（模型驱动）架构升级",
        "将原先写死的数据模型重构为“[[模型组—模型—字段—模型关系]]”四层元模型，配套白屏化自定义模型能力与 [[ModelRegistry 表驱动路由]]（50+ 云产品实体各一个 model service），使新增模型无需改动代码，用户接入新模型周期[[从周级缩短至小时级]]。"),
      bullet("统一增量同步体系（主导设计）",
        "定义 Protobuf [[SyncMessage]] 统一消息协议（trace_id / operation / model_type / event_time / payload oneof），以 event_time 毫秒时间戳作[[乐观锁版本号]]，通过 [[AOP 版本控制中间件三钩子]]（BeforeCreate / Update / Delete）非侵入拦截全部写入，一次开发全表生效；Kafka 消费者关闭自动提交（[[manual commit]]）配合乐观锁幂等，在不引入分布式锁的前提下解决“全量与增量并存覆盖、消息乱序、多源冲突”三类问题，等价 [[exactly-once]] 语义。"),
      bullet("多形态数据接入与平滑迁移",
        "沉淀 [[SPI 拉取 / 直连源库 / 多 Region 库 / Kafka 消息 / FlinkCDC 增量]]五种接入通路，以及白屏化通用数据同步与高吞吐全文检索能力；主导核心数据链路重构与灰度切换，完成 [[500+ 核心接口 0 故障迁移]]，最大查询 QPS 提升 100%。"),
      bullet("业务收益",
        "纳管 [[100+ 云产品、2000+ 拓扑级资源实例]]（IaaS / PaaS / SaaS 三层），单产品接入成本从 3~5 人月降至 [[5~10 人日]]，与集团 CMDB 数据一致性从小时 / 天级延迟收敛至[[分钟级最终一致]]；构建的关系拓扑与业务架构模型经 MCP 供 AI Agent 消费，支撑指标标签补全与影响面定位，[[CMDB 日活一年内提升 50%]]。"),

      entryHead("蚂蚁自动化业务故障发现与根因定位", "项目一号位　2020.09 - 2023.10"),
      desc("",
        "从 0 到 1 建立业务问题自动化处理方案，解决蚂蚁长期存在的业务监控缺失、业务流量识别难、根因不准确三大应急难题，覆盖支付 / 基金 / 中间件等全栈域。"),
      bullet("稳定性中间件与全站覆盖",
        "基于 [[JavaAgent + OpenTelemetry]] 研发业务无感知的埋点与流量识别中间件，支撑业务监控自动化布防、业务流量画像、耗时优化点识别与错误码体系建设，并主导技术能力在全站的推广接入，覆盖 [[3000+ 标准 Java 应用]]。"),
      bullet("自动化根因定位与租户级重保",
        "构建根因定位平台，将故障发现与定位从依赖人工经验转为自动化决策；面向 KA 商户建立[[租户维度 SLA 度量与重保机制]]，把稳定性能力从“应用视角”扩展到“客户视角”。"),
      bullet("业务收益",
        "支付域应急效率提升 50%、[[根因定位准确率 90%]]、监控布防覆盖率提升 40%；全年主动识别问题 132 个，[[挽回业务失败超 2700w 笔]]，识别并优化核心链路 80ms 耗时；重保 30+ 核心 KA 商户 SLA 达标。项目获蚂蚁 [[BG 级技术创新奖]]（Westar + 蓝宝石），申请专利 2 篇。"),

      entryHead("蚂蚁业务单元化隔离", "核心研发　2020.09 - 2022.12"),
      desc("",
        "面向微服务架构下业务流量混合导致的稳定性 / 效率 / 容量问题，设计业务弱感知的轻量级流量隔离方案，使细粒度业务流量运行在各自独立的 POD 组。"),
      bullet("单元化 SDK 与全链路流量隔离",
        "基于 JavaAgent 实现[[业务流量染色与引流]]，打通 RPC / HTTP / 消息三类通道的全链路隔离；负责业务单元 SDK 与用户平台研发，推动基金 / 保险等域完成单元化架构升级，并为双十一大促金融网络压测提供单元级隔离能力。"),
      bullet("业务收益",
        "[[0 故障]]完成基金全链路切流，隔离应用 30+、机器成本降低 10%、压测效率提升 30%；大促自主压测窗口减少 30%、并行数提升 60%；支付域 10+ 应用接入单应用隔离，[[0 故障支撑 3 年大促]]。"),

      /* ---------- 专业技能 ---------- */
      section("专业技能"),
      skill("编程语言", "Go（主力）、Java、Python"),
      skill("可观测与稳定性", "Prometheus、OpenTelemetry、VictoriaMetrics、SLO / 可用性体系、指标网关、流式计算、告警治理、自动化根因定位、JavaAgent"),
      skill("AI Agent 工程", "Eino ADK、多 Agent 编排、上下文工程、Skill / MCP / A2A / AG-UI 协议、RAG 检索、Langfuse 可观测"),
      skill("存储与中间件", "MySQL、Redis、Kafka、ClickHouse、XStor、Elasticsearch、FlinkCDC"),
      skill("云原生与架构", "Kubernetes、微服务治理、多租户权限、API 网关、多地域多集群、两地三中心容灾、模型驱动（元模型）建模"),
    ],
  }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(process.argv[2] || "resume.docx", buf);
  console.log("written:", process.argv[2]);
});
