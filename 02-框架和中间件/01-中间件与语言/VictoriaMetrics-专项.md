# VictoriaMetrics 专项：架构、可靠性与项目边界

> **结论先行**：VictoriaMetrics（VM）兼容 Prometheus remote-write 与查询生态，既有单机版，也有由 `vminsert / vmstorage / vmselect` 组成的 shared-nothing 集群版。它不是“自动强一致的 Prometheus 替代品”：官方文档明确说集群优先可用性，节点故障时可能返回 partial response；复制、持久队列、备份和查询保护需要分别配置。

## 1. 面试先说清四层边界

| 层 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| `vmagent` | 抓取/接收、relabel、remote-write、失败时磁盘排队 | 不是长期查询存储；磁盘达到上限会丢最老数据 |
| `vminsert` | 接收写入，按 series 的 metric name + labels 一致性散列到 storage | 不保存长期数据；节点列表变化不等于历史数据自动重平衡 |
| `vmstorage` | 保存原始数据和索引，按过滤条件返回时间范围数据 | 节点彼此不通信，也不自动复制对方已有数据 |
| `vmselect` | 向配置的 storage 取数、合并/去重并执行查询 | storage 缺失时历史数据可能不完整，必须识别 partial |

官方架构是 shared-nothing：`vmstorage` 之间互不感知、不共享数据，三种服务可分别扩容。这个设计减少协调依赖，但把拓扑、复制、容量与故障语义显式交给部署者。

## 2. 写入链路

```text
Prometheus remote_write / vmagent / SDK
  → vminsert
    → 对完整 series identity 做一致性散列
      → 选择 vmstorage（配置复制时选择 N 个）
        → storage 落盘
```

### 2.1 分片键为什么是完整 series identity

同一 metric name 加同一组 labels 构成同一时间序列。将其稳定路由到 storage，可以让时间范围写入和读取保持局部性。代价是：动态 label 会制造新 series；超级租户或异常 label 可能导致活跃 series、索引和查询集合急剧增长。

### 2.2 storage 不可用时发生什么

官方集群文档说明，`vminsert` 会把新写入重新路由到健康 storage；这提升可用性，但健康节点会承受额外 CPU、内存、磁盘 I/O、网络和活跃 series。节点恢复后，故障期间被重路由的数据不会凭空自动搬回原节点，因此扩缩容和故障恢复不能只看“Pod 已 Ready”。

### 2.3 replicationFactor 的真实含义

`-replicationFactor=N` 让 `vminsert` 把每个样本写到 N 个不同 storage，查询侧需要配置对应去重/复制语义。它不是免费的：官方文档指出 CPU、RAM、磁盘和网络开销最高可接近 N 倍。

复制解决部分节点故障，不代替备份；误删、逻辑错误、整个故障域损坏仍需要独立备份与恢复演练。

## 3. 查询链路与 partial response

```text
Grafana / Prometheus API client
  → vmselect
    → 向配置的 vmstorage 获取匹配数据
      → 合并、去重、执行 MetricsQL
        → 返回结果，必要时标记 isPartial
```

当部分 storage 不可用时，`vmselect` 可以继续服务，但结果可能缺少只存在于故障节点的历史数据。可靠的上层必须：

- 记录并暴露 partial，而不是把不完整结果当作正常 200；
- 对告警/结算等高风险查询选择 fail-closed 或降级策略；
- 监控 storage 可达性、partial 数、查询超时和返回 series/sample 数；
- 将“无数据”和“数据节点不可达”区分开。

## 4. `vmagent` 的磁盘持久队列

远端写不及时，`vmagent` 默认将 pending data 放入 `-remoteWrite.tmpDataPath`，直到发送成功或目录达到上限。每个 remote-write URL 有独立目录，可用 `-remoteWrite.maxDiskUsagePerURL` 限制。

重要边界：

1. 磁盘上限达到后会丢弃最老数据，因此“有磁盘队列”不等于永不丢。
2. 默认按 FIFO 先排空历史 backlog，新数据可见性可能在远端恢复后仍长期滞后。
3. K8s Operator 的默认临时路径可能随 Pod 重启丢失；要保留队列需使用 stateful mode/PVC 或等价持久卷配置。
4. 队列容量应按实际发送字节率 × 目标故障缓冲时长估算，并监控占用、丢弃和发送 lag。

## 5. MetricsQL 与 PromQL

官方将 MetricsQL 描述为向后兼容 PromQL 的查询语言，并明确列出有意的语义差异，例如 `rate/increase` 窗口、NaN、metric name 保留和隐式转换。因此正确说法是“兼容并扩展”，不是“99% 完全等价”或“零迁移成本”。迁移必须对黄金查询做双跑，尤其检查：

- `rate/increase` 边界与 lookbehind；
- subquery/step 和隐式转换；
- NaN 与空结果；
- metric name/label 保留；
- recording rule、告警阈值和 Grafana 面板结果。

## 6. 高基数与容量

容量不能用“单样本固定 0.4 字节”估算。至少需要实测：

```text
日样本数 = 活跃 series × 每 series 每秒样本数 × 86400
原始写入量 = 日样本数 × 实测平均编码后字节
总磁盘 = 原始写入量 × 保留天数 × 复制因子
         + 索引/合并/临时空间/安全水位
```

高基数治理优先级：

1. 在采集/relabel 入口删除无界 label；
2. 对租户、metric 和 label values 建 cardinality budget；
3. 用查询限制控制最大 series、样本、时间范围和并发；
4. 用 recording rules 预聚合稳定的高频查询，但接受额外写入和规则治理；
5. 请求 ID、用户 ID 等明细维度转到日志/Trace/列存，而不是硬塞进 metric labels。

## 7. 扩缩容与故障域

### 扩容

增加 storage 后，新数据会按新节点集合分布；已有历史数据不会自动变得均匀。查询仍要覆盖旧节点，容量收益会随新数据积累逐步体现。验收应观察每节点写入、磁盘、active series 和查询扇出，而不是只数实例。

### 缩容

直接移除 storage 会让只存在该节点的数据不可查询。应先明确复制/底层持久盘/迁移工具和数据保留策略，再做演练；“滚动下线一个 Pod”不是数据迁移方案。

### 多 AZ

复制副本是否跨 AZ 取决于实际拓扑与路由配置，不能由 `replicationFactor=2` 自动推出。更完整的设计会把采集、写入、storage 和查询故障域分别建模，并验证单 AZ 失效下的写入容量与查询完整性。

## 8. TCUM 项目中源码真正能证明什么

事实源：`/Users/yaao/Documents/code/tcum-yunshao-global`。

### 8.1 已实现的入口

- `VictoriaMetricsService` 用 Prometheus remote write client 构造写请求，protobuf + snappy 后发送；
- 同一服务创建 Prometheus v1 API client，可执行 range query，并配置写/查超时；
- `VictoriaMetricsProxyService.WriteTsData` 将内部 `TsData` 转成按 storage ID 分组的 `prompb.WriteRequest`；
- 只有全局 `VmProxyWrite` 开启，且目标 `StorageNode.PreComputeWrite=true` 时才代理写对应节点；
- 写入有次数、series 数、耗时和错误计数。

### 8.2 必须主动说明的边界

- Global 代码证明“存在配置门控的 VM 写路径”，不证明所有指标都写 VM；
- 项目主 PromQL proxy 当前按元数据在 XStor/ClickHouse 间选路，不能把 VM 说成该代理的唯一读主；
- XStor 与 VM 在后台存储任务中顺序调用，没有跨存储事务或可靠 outbox；
- 源码不包含 VM 集群部署拓扑，因此不能宣称固定的 vminsert/vmstorage/vmselect 数量、复制因子、日写样本、P99 或容量；
- 是否使用 vmagent、PVC persistent queue、备份和多 AZ，需要查部署配置，不能由客户端依赖推断。

### 8.3 30 秒项目回答

> “在 Global 里，VM 是配置门控的 remote-write 代理目标。数据先统一成内部时序结构，再按 storage ID 转为 Prometheus WriteRequest；只有全局开关和节点 PreComputeWrite 同时开启才写。代码里也保留了直接查询 Client，但主 PromQL proxy 的路由事实是 XStor/CK。当前 XStor 与 VM 在同一 worker 顺序写，任一侧失败没有持久补偿，所以我不会称它为强一致双写；优先改成每目标独立 durable queue、幂等重放和最终确认水位。”

## 9. 故障排查

### 写入延迟/错误

按顺序检查：入口速率和限流 → vmagent queue/磁盘/丢弃 → vminsert 请求错误与重路由 → 各 storage CPU/内存/磁盘/网络 → active series 是否突增。若只看 vminsert 200，会漏掉 backlog 和可见性延迟。

### 查询变慢

检查 query 时间范围、step、匹配 label、返回 series/sample 数、并发与 partial；再看 vmselect CPU/内存、各 storage 可达性与磁盘读取。先缩小时间窗和 label 集合验证基数，不要第一步就扩 vmselect。

### 数据空洞

区分采集缺失、remote-write backlog/丢弃、storage 故障、partial response、查询语义差异和路由查错存储。沿 tenant + metric + time range 记录每层最后成功水位。

## 10. 高频 20 问

### Q1. 单机版和集群版怎么选？

先用容量、可用性、独立扩缩容和运维成本决定。单机版部署简单；集群版可分别扩写入、存储、查询，但引入节点列表、partial、复制、重平衡和更多故障组合。不能把“数据多”当作唯一条件。

### Q2. 为什么 storage 节点不互相通信？

shared-nothing 减少一致性协调和集群控制面复杂度，使节点可独立扩展；代价是复制由写入端完成、查询由 select 聚合，历史再平衡也不是 storage 间自动完成。

### Q3. 一致性散列解决了什么？

让同一 series 稳定落到目标节点，并在节点集合变化时限制需要改变映射的 key 范围。它不自动迁移历史数据，也不消除热点和故障期间重路由负载。

### Q4. replicationFactor=2 是否能保证不丢？

不能无条件保证。它只说明写入端尝试存两份；还取决于健康节点数、确认语义、故障域、磁盘可靠性和备份。逻辑误删与整个故障域丢失仍需备份恢复。

### Q5. partial response 为什么危险？

HTTP 成功但数据不完整，可能把“部分节点不可达”误判为“指标下降/资源消失”。告警和报表必须识别 partial，并定义拒绝、降级或标注策略。

### Q6. vmagent 和 Prometheus remote_write 队列的核心价值？

将采集与远端短暂故障解耦，提供有界缓冲和重试。真正问题是队列容量、磁盘持久性、上限后的丢弃和恢复后 backlog 追赶，而不是“用了队列就不丢”。

### Q7. 为什么恢复后新数据仍可能很晚才可见？

默认 FIFO 会先发送历史 backlog。远端恢复只代表能接收，不代表积压已清零；需要用发送速率、积压字节和净排空速度估算恢复时间。

### Q8. MetricsQL 是否等同 PromQL？

向后兼容并有意扩展/改变部分语义。常规 dashboard 通常可迁移，但告警和边界函数必须双跑验证。

### Q9. vmselect 为什么容易 OOM？

大时间窗、宽 label matcher、高基数、过多并发和过大的返回集都会放大中间结果。应同时限制单查询成本和并发，并治理源头 cardinality。

### Q10. 为什么 recording rule 不是免费优化？

它用额外写入、存储、规则调度和新鲜度换查询成本；规则错误还会固化错误数据。只对稳定、高频、可验证的查询预计算。

### Q11. 新增 storage 后为什么磁盘不立刻均衡？

新的一致性散列只影响后续写入；旧数据仍在旧节点。查询要同时覆盖旧新节点，是否迁移历史取决于独立工具与运维方案。

### Q12. 怎样做容量压测？

用真实 label 分布和查询 mix；分别测 steady write、series churn、突发、节点故障重路由、长查询、恢复追赶和合并 I/O。平均 QPS 远远不够。

### Q13. 高基数一定该放 ClickHouse 吗？

要看查询语义。需要 PromQL rollup/告警的有限维度适合时序库；任意明细、多维 ad-hoc 和无界 ID 更适合列存/日志。通常是分层而非二选一。

### Q14. 查询所有 storage 是不是很浪费？

集群版由 vmselect 向配置的 storage 获取所需数据，因为历史分布在各节点。可以通过时间/label 过滤、缓存、预聚合、分组与查询限额降低成本，但不能漏查可能持有数据的节点。

### Q15. 如何验证复制真的跨故障域？

检查实际 Pod/节点/AZ 放置、storage 列表和写入配置，再做单节点/单 AZ 故障演练，观察 full/partial、写入重路由和数据恢复；仅看副本参数不够。

### Q16. 备份与复制有什么区别？

复制提高在线节点故障可用性，会同步逻辑错误；备份提供时间点恢复和灾难恢复。两者解决不同故障模型。

### Q17. TCUM 为什么不能说所有数据双写 VM？

源码有全局 `VmProxyWrite` 和节点 `PreComputeWrite` 双门控，转换路径也按 storage ID；这说明写入是选择性的迁移/预计算路径。

### Q18. TCUM 的 VM 写失败会怎样？

当前路径记录错误指标和日志，但没有在该调用点看到 durable retry/outbox；同时 XStor/VM 顺序写会相互影响。应以独立队列、重放和最终确认改造。

### Q19. 如何定义 VM 迁移成功？

不仅看写请求成功率，还要对比双写水位、样本/series 数、黄金 PromQL 结果、partial、P99 和成本；按指标/租户灰度，并保留快速读回退。

### Q20. 面试时哪些数字可以说？

只有能展示监控、容量报告、部署清单或压测报告的数字。厂商 benchmark 可作为参考条件，不得改写成自己的生产结果；本地源码也不能证明节点数、日写量或 P99。

## 11. 当前实现的改进优先级

| 优先级 | 改进 | 验收证据 |
| --- | --- | --- |
| P0 | XStor/VM 独立 durable queue 与 ACK/DLQ | 任一目标故障不阻塞另一目标；重启后可重放 |
| P0 | 端到端写入水位与差异校验 | 按 tenant/metric/time 对比最终样本与延迟 |
| P1 | VM 写入灰度与读回退显式化 | 每 storage/metric 开关、回退原因和回滚耗时 |
| P1 | cardinality 与查询预算 | 超预算可拒绝且有明确错误；无 OOM |
| P1 | partial response 门禁 | 告警/报表不会把 partial 当完整数据 |
| P2 | 部署、复制、备份证据归档 | 拓扑、参数、恢复演练和 RPO/RTO 可追溯 |

## 12. 权威来源

- [VictoriaMetrics 集群架构与可用性](https://docs.victoriametrics.com/victoriametrics/cluster-victoriametrics/)
- [vmagent 磁盘持久队列](https://docs.victoriametrics.com/victoriametrics/vmagent/)
- [MetricsQL 与 PromQL 差异](https://docs.victoriametrics.com/metricsql/)
- 项目实现：`tcum-yunshao-global/service/integration/victoria_metrics/`
- 项目总体读写边界：[监控数据面全链路](../../01-项目专题/02-监控可观测/01-机制原理/01-机制篇-数据面全链路.md)
