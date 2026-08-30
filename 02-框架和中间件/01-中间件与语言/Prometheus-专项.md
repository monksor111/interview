# Prometheus 专项：从 PromQL 到 TCUM 多存储查询与告警链路

> 目标：讲清 Prometheus 的数据模型、查询、规则与告警，同时能结合 TCUM 源码解释兼容 PromQL 的多存储执行层。
>
> 事实边界：仓库可以证明 TCUM 使用 Prometheus AST/PromQL 引擎、VictoriaMetrics 接口、ClickHouse/InfluxDB 查询代理和 Alertmanager webhook；不能据此推断完整部署拓扑、实例规模、长期存储副本数或性能倍数。

---

## 一、三分钟总览

Prometheus 不只是一个时序数据库，而是一套围绕多维指标的协议和运行模型：

1. 目标暴露指标，Prometheus 通常主动拉取；
2. metric name 与 labels 唯一确定一条时间序列；
3. 本地 TSDB 保存样本，PromQL 在时间和标签维度上计算；
4. recording rule 预计算高频表达式，alerting rule 生成告警状态；
5. Alertmanager 负责分组、路由、抑制、静默和通知；
6. remote write 把样本送到远端系统，但远端系统的查询与高可用模型各不相同。

TCUM 的特殊之处是把 PromQL 当作统一查询语言：服务先解析 AST、提取指标名，根据指标元数据选择 InfluxDB、ClickHouse 或默认存储的查询代理，再由嵌入式 PromQL 引擎执行。它降低了上层对存储的感知，但也带来跨存储表达式、标签语义对齐、下推能力和查询资源治理问题。

---

## 二、架构与 Pull 模型

```text
targets/exporters --scrape--> Prometheus --rules--> Alertmanager --> receivers
                              |
                              +-- remote write --> remote storage
```

### 2.1 Pull 的价值

- 采集端统一控制频率、超时和目标状态；
- 抓取失败自然形成 `up` 等健康信号；
- 业务只暴露 HTTP metrics endpoint，不必知道中心地址；
- 服务发现与 relabeling 在采集端集中治理。

Pull 不是绝对优于 Push。短生命周期批任务可能在下一次 scrape 前结束，Pushgateway 可作为中介，但官方只建议有限场景使用。它会丢失目标天然健康检查，并且已推送 series 需要显式删除。

### 2.2 组件边界

- Prometheus Server：scrape、本地 TSDB、PromQL、规则评估；
- Exporter/client library：暴露指标；
- Service Discovery：发现目标；
- Alertmanager：接收告警并管理通知；
- Remote storage：扩展保留、容量或多租户能力，具体语义由实现决定。

Prometheus 本地存储以单节点为边界。官方通过 remote storage 接口集成外部系统，而不是承诺内建分布式 TSDB。

---

## 三、数据模型与基数

### 3.1 Series 的身份

```text
http_requests_total{service="api", method="GET", status="200"}
```

metric name 与全部 labels 的组合确定 series。任一 label 值变化都会创建另一条 series。

指标名应表达单一数量和单位，例如：

- `http_requests_total`
- `http_request_duration_seconds`
- `process_resident_memory_bytes`

### 3.2 四类指标

| 类型 | 语义 | 常见查询 |
|---|---|---|
| Counter | 单调增加，进程重启可 reset | `rate`、`increase` |
| Gauge | 可增可减的瞬时值 | `avg_over_time`、直接聚合 |
| Classic Histogram | bucket/count/sum 多条 series | `histogram_quantile` |
| Summary | 客户端计算分位数与 count/sum | 本实例分位数展示 |

Histogram 分位数是按 bucket 估算的，精度依赖 bucket。Summary 的 quantile 通常不能跨实例正确聚合。选择前先确定是否需要跨实例聚合、可接受误差和观测区间。

### 3.3 高基数为什么危险

`user_id`、`trace_id`、原始 URL 等无界 label 会持续创建 series，放大：

- Head 内存与倒排索引；
- WAL、磁盘与 remote write 流量；
- 查询匹配和聚合成本；
- rule evaluation 与告警实例数。

没有通用“安全 series 数”。容量取决于采样间隔、活跃度、label 长度、查询和硬件。治理应设置 label allowlist、series budget、每 metric 基数告警，并在上线前基数压测。

---

## 四、PromQL 核心语义

### 4.1 四种值类型

- Instant vector：每条 series 在一个评估时刻的样本；
- Range vector：每条 series 在时间窗口内的样本序列；
- Scalar；
- String（很少作为最终结果）。

Range query 不是一种不同的 PromQL 语言，而是在多个等间隔时间点反复评估同一 instant expression。

### 4.2 Counter 先 rate，再聚合

```promql
sum by (service) (rate(http_requests_total[5m]))
```

先对每条原始 counter 做 `rate`，才能识别各自 reset；先 `sum` 再 `rate` 可能掩盖实例重启。

窗口要相对 scrape interval 足够长。过短窗口可能只有很少样本，结果抖动或为空。

### 4.3 向量匹配

```promql
errors_total / on(service, instance) requests_total
```

二元运算默认按完整 label set 匹配。`on(...)` 指定参与匹配的 labels，`ignoring(...)` 排除 labels；`group_left` / `group_right` 用于明确的一对多或多对一。

若两侧都可能多条匹配同一 key，会产生 many-to-many 错误。修复方式是先聚合到唯一键，而不是随意添加 group modifier。

### 4.4 缺失数据不等于零

- 空向量：没有匹配 series 或 lookback 内无有效样本；
- 数值 0：series 存在且值为零；
- stale：目标或 label set 消失后的陈旧标记语义。

`or vector(0)` 会丢失或改变 label 语义，不能机械使用。告警应区分“业务值为零”和“采集断了”。

### 4.5 Histogram 分位数

```promql
histogram_quantile(
  0.95,
  sum by (le, service) (rate(http_request_duration_seconds_bucket[5m]))
)
```

Classic histogram 聚合必须保留 `le`。bucket 设计应围绕 SLO 阈值，否则 P95 数字可能看似精确、实际误差很大。

### 4.6 `offset`、`@` 与 subquery

- `offset` 改变 selector 取数相对时间；
- `@` 固定 selector 的评估时间；
- subquery 对内部 instant expression 生成范围结果。

它们容易制造大扫描。Grafana 的 range、step、窗口和 series 数共同决定成本，不能只限制 PromQL 字符长度。

---

## 五、TSDB 与 Remote Write

### 5.1 本地 TSDB

核心结构：

- Head：最近活跃数据与索引；
- WAL：崩溃恢复；
- blocks：时间分块后的 chunks、index、meta 与 tombstones；
- compaction：合并 block，降低长期查询碎片。

不能用固定“每样本 1～2 字节”估算所有系统。label、index、WAL、Head、稀疏度和压缩效果都会改变容量。

### 5.2 Remote Write

Prometheus 将接收的样本写入远端 endpoint。要监控：

- queue backlog 与 shard；
- dropped/retried samples；
- endpoint latency/error；
- WAL 增长和磁盘余量；
- out-of-order、duplicate、label limit 错误。

Remote write 成功并不代表远端查询立即可见；分布式存储可能存在写入、索引与查询延迟。

### 5.3 Remote Read 的边界

官方文档指出，Prometheus remote read 通常从远端取原始 series，再在本地执行 PromQL。这会受传输数据量和本地查询资源限制，不能等同于分布式 PromQL 下推。

---

## 六、Recording Rule 与 Alerting Rule

### 6.1 Recording Rule

把高频或昂贵表达式周期性计算并保存为新 series：

```yaml
groups:
  - name: api-sli
    interval: 30s
    rules:
      - record: service:http_error_ratio:rate5m
        expr: |
          sum by (service) (rate(http_requests_total{status=~"5.."}[5m]))
          /
          sum by (service) (rate(http_requests_total[5m]))
```

收益是查询稳定和复用；代价是新增 series、评估资源以及数据新鲜度。规则必须用 `promtool check rules` 和单元测试验证。

### 6.2 Alerting Rule

```yaml
- alert: ApiHighErrorRatio
  expr: service:http_error_ratio:rate5m > 0.01
  for: 10m
  labels:
    severity: page
  annotations:
    summary: "{{ $labels.service }} error ratio is high"
```

- `for` 抑制短暂抖动；
- `keep_firing_for` 可在条件刚恢复时继续短暂 firing；
- labels 决定告警身份、路由和聚合；
- annotations 用于说明，不应放进身份 labels。

规则组串行评估；若一次评估超过 interval，后续周期可能被跳过。需监控 rule duration、failures、missed iterations 和 produced series。

---

## 七、Alertmanager

### 7.1 四个核心能力

- Grouping：把相关告警合为一条通知；
- Routing：按 label 路由到接收者；
- Inhibition：当根因告警存在时压制下游告警；
- Silence：在时间范围内按 matcher 静默。

`group_wait` 等待同组告警聚合；`group_interval` 控制同组新增告警通知；`repeat_interval` 控制仍 firing 的重复提醒。三者需结合故障响应目标设计。

### 7.2 HA 不是 exactly-once

Alertmanager 集群用 gossip 复制 silence 和 notification log。官方 HA 设计在分区时 fail-open：宁可重复通知，也尽量不漏关键告警。因此它追求至少一次，不承诺严格 exactly-once。

Prometheus 应把告警发送到所有 Alertmanager 实例，而不是只经一个负载均衡目标。具体实例数由故障域和运维能力决定，不存在所有项目固定三节点的结论。

### 7.3 告警质量

一个好告警需要：

- 对应用户/系统影响；
- 有明确 owner 与严重级别；
- 包含 dashboard/runbook 链接；
- 控制实例 label，避免告警风暴；
- 用依赖抑制和分组表达拓扑；
- 统计触发次数、确认/恢复时长和无行动告警比例。

---

## 八、TCUM 源码案例一：PromQL 作为多存储统一查询层

核心源码：

- `service/bizservice/pqlqueryservice/service.go`
- `service/bizservice/pqlqueryservice/proxy-manager/proxy_manager.go`
- `service/integration/promql-proxy/`

### 8.1 实际执行流程

`preparePromQLExecution` 大致执行：

1. 检测指标名正则等特殊形式并尝试转换；
2. 用 Prometheus `parser.ParseExpr` 解析 AST；
3. 失败时尝试自研 v2→v3 converter，再重新解析；
4. 从 AST 提取指标名；
5. 根据指标元数据选择对应 `PromqlProxy`；
6. proxy 作为数据查询层，交给 PromQL 引擎执行 instant/range query；
7. 把内部 `promql.Result` 转换为公共 model Vector/Matrix/Scalar。

这说明 TCUM 获取执行结果的主链路不是 Langfuse。Langfuse可记录 Agent trace；PromQL 结果来自 TCUM 查询服务和底层存储代理。

### 8.2 设计价值

- 上层统一使用 PromQL；
- 存储选择收口在指标元数据与 proxy manager；
- 复用官方 AST/engine，避免自写完整查询语言；
- 可在 proxy 中实现标签映射和有限下推。

### 8.3 明确边界：跨存储表达式

源码有 TODO：支持表达式中不同指标位于不同存储，例如 `a + b` 且 a、b 分别在 ClickHouse 和 InfluxDB。

当前逻辑主要提取一个指标名来选 proxy，因此不能把它描述成完整的联邦查询优化器。真正支持跨存储需要：

1. 遍历 AST 找出全部 vector selector；
2. 分别解析存储归属；
3. 按可下推子树拆分执行计划；
4. 统一 labels、时间戳、staleness 与 lookback；
5. 在协调层做向量匹配和聚合；
6. 设置跨源 fanout、样本数和超时预算。

### 8.4 Converter fallback 的风险

解析失败后自动改写查询有兼容价值，但必须保证语义等价。建议：

- 保存 original、converted 与 rewrite reason；
- 对 AST 做归一化差异测试；
- 无法证明等价时返回显式错误；
- 建立真实查询 corpus 回归；
- 不要“转换失败就静默执行原查询”。

---

## 九、TCUM 源码案例二：范围查询治理

`QueryRange` 对超过 24 小时的查询目前只打印日志，仍继续执行。环境配置中存在 lookback、timeout、max samples 等限制，但长 range 的成本还取决于 step 和 series 数。

应把查询预算建模为：

```text
estimated_points ≈ matched_series × (end-start)/step
```

完整治理包括：

- start/end/step 合法性；
- 最大时间范围与最大点数；
- 每租户并发、队列和成本预算；
- 查询超时向下游传播；
- recording rule/预计算引导；
- slow query 指纹、扫描 series/points 和被拒原因。

只记录“超过 24h”而不拒绝、降采样或改写，不能形成资源隔离。

---

## 十、TCUM 源码案例三：SLO PromQL 分片并行

源码：`service/bizservice/sloservicev2/slov2_promql_shard.go`。

实际策略：

- 把 module/probeProduct label 列表按固定大小拆片；
- 用正则构造每片 PromQL instant query；
- 信号量限制并发；
- 结果合并为 `label -> regions`；
- 全部分片失败才返回 error，部分失败返回成功片数据并记录错误。

### 10.1 价值

- 控制单条正则和底层 series 扫描范围；
- 并行降低端到端耗时；
- 有并发上限；
- 部分失败降级，不让单片拖垮整批。

### 10.2 风险

- 固定 shard size 是经验参数，不是成本模型；不同 label 的 series 基数可能差异巨大；
- 部分失败返回 nil error，调用者如果只看 error 会把不完整数据当完整；
- 信号量获取 `sem <- struct{}{}` 没有 select context，取消时等待中的 goroutine不能及时退出；
- 日志打印完整 PromQL，可能过长或暴露敏感标签；
- 返回 region 未排序，若下游依赖顺序会产生不稳定结果。

建议结果返回 `data + completeness + failed_shards`，把 partial 明确放进协议；按估算 series/历史耗时自适应拆片，并为等待信号量增加 context。

---

## 十一、TCUM 源码案例四：Alertmanager 后的自有告警处理

核心源码：

- `service/bizservice/alarmservice/alarm_rule_service.go`
- `service/bizservice/alertservice/alert_service.go`
- `service/cache/alarmcache/silence_runtime.go`
- `service/dao/t_mstack_alarm_history_dao.go`

仓库能证明：

- 规则配置会生成 Alertmanager route/receiver 相关参数；
- webhook 接收告警后执行 TCUM 自有静默匹配；
- active 与 silenced 告警都会写历史，静默告警不会从审计链路消失；
- 静默命中数按 tenant/silence 维度记录；
- 告警历史支持创建、更新、聚合、过期和增量同步。

因此 TCUM 并非完全依赖 Alertmanager 自带 silence，而是在通知入口后又有一层领域静默与历史治理。好处是租户/策略模型可控；代价是必须保证两层静默语义、matcher 兼容和配置传播一致。

更详细项目链路见：

- `01-项目专题/02-监控可观测/01-机制原理/04-机制篇-告警链路与SLO.md`
- `01-项目专题/02-监控可观测/03-项目题库/08-36问-一致性告警与运营.md`

---

## 十二、Dashboard Agent 的 PromQL 质量门禁

生成 Grafana 大盘的 Agent 不应只由 LLM judge 打分。合理顺序是：

1. 模板变量归一化，识别 `$__rate_interval`、`$cluster`、`${namespace:regex}`；
2. 使用锁定版本的官方 Prometheus parser 做语法验证；
3. 静态语义检查：metric/label 是否存在、counter 是否使用 rate、向量匹配是否合理；
4. 在安全只读环境执行 instant/range query；
5. 检查结果非空、series/points 上限、超时与错误；
6. 检查 dashboard JSON、panel 类型、单位、legend、变量引用；
7. LLM judge 只评估可读性、解释质量和业务覆盖。

无法解析的模板变量不能直接判 PromQL 错，应返回 `unresolved_template/inconclusive`。具体 scorer_skill 设计见：

- `01-项目专题/03-TCUM-AI/01-机制原理/05-机制篇-Agent评测与评测体系.md`

---

## 十三、项目事实边界

| 命题 | 仓库证据 | 面试表达 |
|---|---:|---|
| TCUM 使用 Prometheus AST 与 PromQL engine | 有 | 可讲真实执行链路 |
| 按指标元数据路由存储 proxy | 有 | 可讲统一查询抽象 |
| 支持 InfluxDB、ClickHouse、默认存储路径 | 有 | 具体能力以各 proxy 为准 |
| 跨存储表达式完整支持 | 无，且源码有 TODO | 明确说当前短板 |
| 长 range 超过 24h 会拒绝 | 无，只日志提醒 | 不声称有硬保护 |
| 使用 VictoriaMetrics 接口 | 有 | 不等于能证明全部部署拓扑 |
| 使用 Thanos/Cortex/Mimir | 无 | 只作为行业选项 |
| 固定三节点 Alertmanager | 无 | 不写成项目事实 |
| 固定性能倍数/series 上限 | 无 | 不报未经压测数字 |

---

## 十四、面试高频 30 问

### Q1：Prometheus 为什么通常用 Pull？

中心控制频率和超时、天然生成目标健康信号，并让目标只需暴露 endpoint。

### Q2：Pushgateway 适合什么？

有限的短生命周期批任务。它会成为集中点，失去 `up` 语义，旧 series 需要显式删除。

### Q3：什么定义一条 series？

metric name 与完整 label set。

### Q4：为什么不能把 trace_id 放 label？

值域近乎无界，会持续创建 series，放大内存、索引、存储、查询和 remote write。

### Q5：Counter 为什么用 rate？

Counter 表示累计值，rate 估计窗口内每秒变化并处理 reset。

### Q6：为什么先 rate 后 sum？

每条原始 series 的 reset 必须先被识别；先求和会掩盖单实例重启。

### Q7：Range query 是什么？

在 start 到 end 的多个 step 时间点重复评估 instant expression。

### Q8：PromQL 空结果等于 0 吗？

不等于。空结果可能是 matcher、时间、staleness 或采集问题；0 是存在样本的数值。

### Q9：many-to-many 怎么修？

先明确业务连接键并聚合到一侧唯一，再使用正确的 on/ignoring 与必要 group modifier。

### Q10：Histogram 与 Summary 怎么选？

需要跨实例聚合通常选 Histogram；Summary quantile 通常不能聚合，Histogram 精度依赖 bucket。

### Q11：Recording rule 的作用？

周期性预计算昂贵/高频表达式，换取查询稳定，但增加 series 和评估成本。

### Q12：`for` 解决什么？

条件持续一段时间才 firing，过滤短暂抖动；不等于替代合理窗口和 SLO 设计。

### Q13：Alertmanager 做什么？

分组、路由、抑制、静默、重试通知，不负责计算 PromQL 条件。

### Q14：Alertmanager HA 会严格只发一次吗？

不会。其分区策略 fail-open，宁可重复也尽量不漏，目标是至少一次。

### Q15：Remote Write 等于远端已可查询吗？

不等于。远端接收、持久化、索引与查询可能有延迟。

### Q16：副本 Prometheus 如何避免告警丢失？

多个实例独立评估并向全部 Alertmanager 实例发送；Alertmanager基于通知状态降重，但仍允许重复。

### Q17：如何估算 range query 成本？

核心是 matched series × 时间范围/step，再结合函数、subquery、聚合和存储扫描。

### Q18：查询超时为什么要向下游传播？

否则上游已取消，底层存储仍继续扫描，浪费资源并造成雪崩。

### Q19：TCUM PromQL 如何选存储？

解析 AST、提取指标名，再通过 proxy manager 按指标元数据选择查询代理。

### Q20：TCUM 的结果是 Langfuse 返回的吗？

不是。执行结果来自 PromQL 服务和存储 proxy；Langfuse如果接入，主要记录 Agent/LLM trace 与观测数据。

### Q21：为什么复用官方 parser？

保证语法语义与 Prometheus 版本对齐，避免用正则伪解析完整语言。

### Q22：converter fallback 有什么风险？

自动改写可能改变语义；必须记录改写、做 AST/corpus 回归，并在不确定时拒绝。

### Q23：TCUM 当前跨存储表达式的边界？

源码明确 TODO；当前以一个指标名选 proxy，不能称为完整跨源执行器。

### Q24：SLO 为什么拆 PromQL 分片？

缩小单条 regex 与底层扫描范围，再用有界并发降低总延迟。

### Q25：部分分片失败为什么危险？

返回 nil error 可能让调用方把残缺数据当完整。协议应显式携带 completeness 和失败分片。

### Q26：TCUM 长范围查询保护够吗？

目前超过 24h 主要是日志提醒；应增加点数估算、租户预算、降采样和拒绝策略。

### Q27：TCUM 为什么还做一层静默？

为了按租户和领域策略统一匹配、审计和历史留存；需要治理与 Alertmanager silence 的双层语义。

### Q28：如何验证 Agent 生成的 PromQL？

模板归一化、官方 parser、元数据语义检查、安全执行和资源预算；LLM judge 只做主观质量补充。

### Q29：如何发现告警规则慢？

监控评估时长、失败、missed iterations、输出 series/alerts 与数据可用延迟。

### Q30：如何降低告警噪声？

从影响出发设计规则，合理 for/window，聚合实例 labels，用 inhibition 表达依赖，并以响应行动数据持续复盘。

---

## 十五、项目表达模板

> TCUM 把 PromQL 作为多时序存储的统一查询语言。请求先用官方 parser 生成 AST，提取指标并通过元数据选择 InfluxDB、ClickHouse 或默认存储 proxy，再由 PromQL 引擎执行。这个抽象让上层不感知存储，但跨存储表达式目前仍是明确 TODO，不能夸大成完整联邦查询。性能上我们已有 SLO label 分片和并发上限，但我会进一步把部分失败显式化，并用 matched series × range/step 做查询预算。告警侧，Alertmanager负责分组路由，TCUM webhook 后还有租户级静默和历史留存，静默告警仍保留审计记录。对于 Agent 生成 PromQL，我会用官方 parser、元数据和安全执行做确定性门禁，Langfuse只负责 trace，不作为查询结果来源或语法裁判。

---

## 十六、源码与官方资料

### 项目源码

- `/Users/yaao/Documents/code/tcum-yunshao-global/service/bizservice/pqlqueryservice/service.go`
- `/Users/yaao/Documents/code/tcum-yunshao-global/service/bizservice/pqlqueryservice/proxy-manager/proxy_manager.go`
- `/Users/yaao/Documents/code/tcum-yunshao-global/service/integration/promql-proxy/`
- `/Users/yaao/Documents/code/tcum-yunshao-global/service/bizservice/sloservicev2/slov2_promql_shard.go`
- `/Users/yaao/Documents/code/tcum-yunshao-global/service/bizservice/alarmservice/alarm_rule_service.go`
- `/Users/yaao/Documents/code/tcum-yunshao-global/service/bizservice/alertservice/alert_service.go`
- `/Users/yaao/Documents/code/tcum-yunshao-global/service/cache/alarmcache/silence_runtime.go`

### Prometheus 官方文档

- [Querying basics](https://prometheus.io/docs/prometheus/latest/querying/basics/)
- [Storage](https://prometheus.io/docs/prometheus/latest/storage/)
- [Recording and alerting rules](https://prometheus.io/docs/prometheus/latest/configuration/recording_rules/)
- [Alerting overview](https://prometheus.io/docs/alerting/latest/overview/)
- [Alertmanager configuration](https://prometheus.io/docs/alerting/latest/configuration/)
- [Alertmanager high availability](https://prometheus.io/docs/alerting/latest/high_availability/)
- [Metric and label naming](https://prometheus.io/docs/practices/naming/)
- [When to use Pushgateway](https://prometheus.io/docs/practices/pushing/)
