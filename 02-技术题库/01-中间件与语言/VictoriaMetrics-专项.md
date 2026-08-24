# 第五卷 · 中间件 · VictoriaMetrics 专项

> **本篇定位**：VictoriaMetrics（VM）是 TCUM 生产**核心时序库**，承担 Prometheus 远程写入 + 长期存储 + 高性能 PromQL 查询。相对 Prometheus 单机的存储与横向短板，VM 提供**vminsert/vmstorage/vmselect 三分离集群 + MergeTree 风格存储 + Gorilla 编码 + rerouter 弹性写入**。本文覆盖架构、数据模型、存储引擎、集群部署、写入路径、查询路径、MetricsQL、多租户、生产实战、50+ 高频面试题。

## 📖 目录
- §1 命题：为什么 VM 是 Prometheus 长期存储首选
- §2 架构：单机版 vs 集群版（vminsert/vmstorage/vmselect/vmagent/vmalert）
- §3 数据模型与 series 唯一性
- §4 存储引擎：mergeset + Part + inmemory buffer
- §5 写入路径与 rerouter
- §6 查询路径与并发
- §7 MetricsQL：相对 PromQL 的增强
- §8 多租户
- §9 长期存储与降采样（downsampling）
- §10 vmagent 与 vmalert
- §11 与 Prometheus 生态融合
- §12 生产实战：TCUM 中的 VM 集群
- §13 版本演进
- §14 50 问详解
- §15 短板与坑
- §16 面试话术

---

## §1 · 命题：为什么 VM 是 Prometheus 长期存储首选

### 一句话背诵

> "VM 的核心价值是**性能碾压 Prometheus 20x 写入 + 存储省 7x + PromQL 兼容**，同时把 Prometheus 单机架构拆成 vminsert/vmstorage/vmselect 三分离集群 → **水平扩展 + 无 GC 抖动（Go 精心优化） + 无外部依赖（不依赖 ZK/etcd）**。"

### 六大优势

1. **写入性能**：单核 100w+ 样本/秒（Prometheus 单核 5~10w）
2. **存储压缩**：Gorilla + ZSTD，样本平均 **0.4 字节**（Prometheus 1.2 字节）
3. **PromQL 兼容 + MetricsQL 增强**：几乎所有 PromQL 都能跑
4. **集群水平扩展**：多 vmstorage 分片，vminsert 一致性哈希路由
5. **无外部依赖**：不需要 ZK/etcd/Consul，简化运维
6. **多租户天然支持**：URL 前缀 `/insert/{accountID}/prometheus`

### 边界代价

- **告警集群化能力弱**：vmalert 相对 Prometheus alerting rule 生态兼容但功能略少
- **社区规模比 Prometheus 小**：Bug 修复速度虽好但插件生态没 Prometheus 广
- **vminsert 无状态但仍需要 LB**：写入侧 LB 配置需谨慎（rerouter 处理节点失败）
- **企业版收费**：downsampling、backup manager、graphite protocol 等在企业版

---

## §2 · 架构

### 2.1 单机版（vm-single）

```
[Prometheus/vmagent/远端 client] --remote_write--> [victoria-metrics binary]
                                                    ├── 内存 buffer
                                                    ├── mergeset 索引
                                                    └── data parts
```

**特点**：单个二进制，配置极简，10 亿 series 内够用。生产测试环境常用。

### 2.2 集群版

```
[Prometheus/vmagent] 
    │ remote_write
    ↓
[vminsert (N 无状态)] ─ 一致性哈希 → [vmstorage (M 有状态)]
                                          ↑ query
                                    [vmselect (K 无状态)]
                                          ↑
                                     [Grafana/客户端]
```

- **vminsert**（无状态）：接收写入，按 series hash 路由到 vmstorage
- **vmstorage**（有状态）：真正存储 + 处理查询本地部分
- **vmselect**（无状态）：接收查询，分发到所有 vmstorage 合并结果
- **vmagent**：可选边缘采集代理，代替 Prometheus 或 Push Gateway
- **vmalert**：告警规则评估器，对接 Alertmanager

### 2.3 三分离设计的价值

- **写读分离**：写量大扩 vminsert，读量大扩 vmselect
- **存储独立扩**：容量不够加 vmstorage
- **故障隔离**：vmselect 挂只影响查询不影响写入

### 2.4 一致性哈希

- vminsert 按 `hash(metric_labels)` 决定发到哪个 vmstorage
- **副本数默认 1**（可 `-replicationFactor=2` 增加）
- 节点增减触发数据重分布 → 短期查询可能不完整（`-search.maxWorkersPerQuery` 参数）

---

## §3 · 数据模型与 series 唯一性

### 3.1 series 定义

- 与 Prometheus 一致：`metric_name{k=v, k=v}` 是一条 series
- **series 唯一性由 label 组合决定**
- 单 label 的**排序**不影响 series 身份（`{a="1",b="2"}` == `{b="2",a="1"}`）

### 3.2 高基数（TCUM 生产血泪）

- **一样是高基数灾难的核心**：series 数 = metric × label 组合数
- VM 相对 Prometheus **抗高基数更强**：
  - 内存效率高 2~3x
  - 磁盘索引更紧凑（mergeset LSM 风格）
  - 但仍有上限 —— 超千万 active series 单机吃力
- **对策**：
  - 拒绝把 trace_id / user_id / path 作 label
  - 用 CK 存高基数明细（TCUM 生产实践）
  - VM 集群水平扩 vmstorage

### 3.3 VM vs ClickHouse：监控场景下的选型

#### 定位差异（一句话）

- **VM**：**专有时序数据库**，为「一条 series 随时间不断 append 样本」而设计
- **CK**：**通用列存 OLAP 数据库**，为「海量明细行的任意维度聚合分析」而设计

#### 核心差异表

| 维度 | VictoriaMetrics | ClickHouse |
|---|---|---|
| 定位 | 专有时序库 | 通用列存 OLAP |
| 数据模型 | metric + labels（时序） | 表 + 列（关系型） |
| 查询语言 | PromQL / MetricsQL | SQL |
| 写入路径 | 按 series hash 分片，顺序 append | 按 partition 批量 insert，MergeTree |
| 压缩 | Gorilla + ZSTD，样本 **0.4 字节** | 通用列压缩，看字段而定 |
| 索引 | label 倒排 + 稀疏时间索引 | 主键稀疏索引 + 跳数索引 |
| 点查/范围查 | **极快**（专为时序优化） | 快，但需预聚合 MV |
| 任意维度聚合 | 弱（只能按 label 维度） | **极强**（SQL 任意 group by / join） |
| 高基数 | 弱（series 爆炸） | **强**（列存天然抗高基数） |
| 明细数据 | 不适合（样本粒度，无明细列） | **天生适合**（明细行） |
| 运维 | 极简，无外部依赖 | 中等，需建表/MV/副本管理 |
| 生态 | Prometheus 生态 | 大数据 / SQL 生态 |

#### 监控场景下各自存什么 + 原因

**VM 适合存：低基数聚合时序（指标）**
- 典型：CPU / 内存 / 网络 / QPS / 延迟 P99 等**指标**数据
- 特征：series 数有限（几十万~几百万）、每 series 高频 append、查询是「某 series 在某时间范围的值/聚合」
- 原因：
  1. Gorilla 时序压缩对「ts 单调 + value 平滑变化」的指标数据压到 0.4 字节，存储省 7x
  2. 稀疏时间索引 + label 倒排，点查/范围查接近 O(log n)
  3. 原生 PromQL，与 Prometheus 生态无缝
  4. 写入吞吐高，扛得住秒级采集的海量指标

**CK 适合存：高基数明细 / 需任意维度分析的原始数据**
- 典型：
  1. **高基数明细**：trace_id、user_id、request_id、容器/pod 级原始样本
  2. **明细事件**：每次请求完整上下文（url、状态码、耗时、来源 IP、业务字段）
  3. **需复杂 SQL 关联分析**的原始数据
- 特征：基数极高（千万~亿级）、单条明细、查询是「任意字段过滤 + group by 聚合」
- 原因：
  1. 列存 + 稀疏索引天然抗高基数（不像 VM 一条 series 一个倒排项会爆炸）
  2. SQL 任意维度 group by / join / 窗口函数，分析灵活
  3. 明细数据保留完整字段，事后可按任意维度重算
  4. 物化视图 + AggregatingMergeTree 可预聚合，兼顾灵活与性能

#### 为什么「高基数」是分界线（核心原理）

这是最关键的一点，要能讲清底层原因：

- VM 的 series 是 `metric{labels}`，**每多一个 label 取值就多一条 series**，倒排索引 indexdb 里就多一个映射项，内存/磁盘都按 series 数膨胀。所以 `trace_id`、`user_id` 这种唯一值做 label，series 直接炸到千万级 → 内存 OOM + 查询变慢。
- CK 是列存，一行明细里的 `trace_id` 只是普通一列，**基数再高也只是列内数据变多，不改变索引结构**（稀疏索引按主键排序），所以千万级 trace_id 完全扛得住。

一句话：**VM 的「维度」是 label（代价高），CK 的「维度」是列（代价低）。所以高基数维度必须去 CK。**

#### 选型决策

```
监控数据来了，问自己三个问题：

1. 是不是「指标」（低基数 label + 时序 append）？
   ├─ 是 → VM（CPU/内存/QPS/延迟等常规监控指标）
   └─ 否 ↓

2. 是不是「高基数明细」（唯一 ID 做维度）？
   ├─ 是 → CK（trace/日志明细/用户级指标）
   └─ 否 ↓

3. 要不要「任意维度 SQL 聚合 / 关联分析」？
   ├─ 是 → CK（多维分析、漏斗、明细下钻）
   └─ 否 → 回到 VM
```

**典型分工（TCUM 实践）**：
- **VM**：存聚合指标（低基数）——服务 CPU、内存、请求 QPS、错误率、延迟 P99，供 Grafana 大盘 + 告警
- **CK**：存高基数明细（原始样本/事件）——带 trace_id/instance_id 的明细、容器/pod 级原始指标，供事后任意维度分析 + 下钻

#### 一句话背诵

> "VM 是专有时序库，为低基数聚合指标而生：Gorilla 压缩 0.4 字节 + PromQL 生态 + 极简运维，但 label 即维度、高基数会爆炸。CK 是通用列存 OLAP，为高基数明细而生：列存抗高基数 + SQL 任意维度分析 + MV 预聚合，但点查/范围查不如 VM 专精。**监控选型铁律：低基数时序指标 → VM，高基数明细/复杂多维分析 → CK**，生产常是 VM 管大盘告警、CK 管明细下钻的分工。"

---

## §4 · 存储引擎

### 4.1 layout

```
data/
├── data/
│   ├── small/          # 小 part（新写入）
│   │   └── {part_id}/
│   │       ├── metaindex.bin
│   │       ├── index.bin
│   │       ├── timestamps.bin
│   │       ├── values.bin
│   │       └── metadata.json
│   └── big/            # 大 part（merge 后）
├── indexdb/            # 倒排索引（label → series ID）
│   └── {part_id}/
└── tmp/
```

### 4.2 mergeset：VM 的核心数据结构

- **LSM Tree 风格**（类似 ClickHouse MergeTree）
- 写入先落 inmemory part → flush 成 file part → 后台 merge 成大 part
- 每 part 有独立的 index，查询时并行扫多个 part

**part 命名**：
- small：< 1MB 数据块，几秒 flush 一次
- big：merge 后大 part

### 4.3 索引结构与底层存储（核心）

VM 内部把每一条 series 映射成一个 **TSID（Time Series ID）**，然后围绕 TSID 建两套结构：一套是「倒排索引 indexdb」用来从 label 反查 TSID，一套是「数据存储 data」用来按 TSID 存样本。

#### 4.3.1 TSID：series 的唯一标识

- 每条 series（`metric{labels}`）被 hash 成一个 **TSID**（8 字节结构）
- TSID 拆成两部分：
  - **MetricGroupID**：metric name（`__name__`）的 hash，同一个 metric 名共享
  - **InstanceID**：该 series 的 label 集合的 hash，区分同 metric 下不同 label 组合
- 所以 `cpu_usage{region="gz",host="a"}` 和 `cpu_usage{region="sh",host="b"}` 共享 MetricGroupID，但 InstanceID 不同
- **内存里维护 `TSID ↔ 完整 label 字符串` 的双向映射**（可 mmap），避免重复存长字符串

#### 4.3.2 indexdb：倒排索引（label → TSID）

- indexdb 本身也是 mergeset 表，存的是**倒排关系**：
  - 正向：`metric name → MetricGroupID`
  - 倒排：`(MetricGroupID, labelName, labelValue) → InstanceID 集合`
- 即：想知道 `region=gz` 命中了哪些 series，就是查 `(metricGroupID, "region", "gz")` 对应的 InstanceID 列表
- **高基数陷阱就在这**：`labelValue` 每多一个取值，indexdb 就多一行倒排记录，series 数越多 indexdb 越大、查询时要合并的集合越大

#### 4.3.3 data：按 series 分 block 列存（回答「是不是按 series 存」）

**是，但更准确说：part 内按 TSID 排序，每个 series 的样本切成多个 block，block 内 timestamp / value 分开列存。**

- 一个 data part 内部，样本按 `TSID` 排序后分块（block）存储
- 每个 series 连续一段时间内的样本组成一个 **block**（默认约 8K 个点，或时间跨度到上限就切块）
- 一个 block 内部：
  - `timestamps` 数组：单独压缩（Delta of Delta）
  - `values` 数组：单独压缩（XOR）
- `index.bin` 记录每个 block 的定位信息：属于哪个 TSID、起止时间、样本数、压缩类型、在 timestamps.bin / values.bin 里的偏移
- **查找一条 series 的时间范围数据**：TSID → 定位到它的 block 列表 → 只解压命中的 block，不用扫全表

一句话：**VM 不是一张「每行一个样本」的大表，而是「每块一条 series 的连续样本」，列存 + 分块 + 压缩，这是它点查/范围查快、存储省的根因。**

### 4.4 压缩

- **timestamp**：Delta of Delta（Facebook Gorilla）+ ZSTD
- **value**：XOR / Gorilla + ZSTD
- **平均样本 0.4 字节**（Prometheus 1.2，InfluxDB 2+）

### 4.5 内存 vs 磁盘

- **inmemory part**：最近几秒写入，未 flush
- **file part**：flush 到磁盘的 part
- **mmap**：查询时 file part 通过 mmap 加载，利用 OS page cache
- **VM 内存主要用于**：inmemory part + 索引 hot 集 + query cache

---

## §5 · 写入路径与 rerouter

### 5.1 vminsert 写入流程

1. 接收 remote_write（Snappy Protobuf）
2. 解压 + 反序列化成样本列表
3. 每条样本按 label hash 决定目标 vmstorage
4. **批量转发**到目标 vmstorage（复用连接）
5. 目标 vmstorage 返回 ACK 后向客户端返回 200

### 5.2 vmstorage 落盘

1. 接收 vminsert 转发的样本 batch
2. 追加到 **inmemory part**（同时更新 index）
3. WAL 写入（可关闭）
4. inmemory part 满 → flush 成 file part
5. 后台 merger 合并 file part

### 5.3 rerouter：节点失败弹性

- **场景**：一个 vmstorage 挂了
- vminsert 检测到写入失败 → **rerouter** 把数据转发到其他健康 vmstorage
- 副本数 ≥ 2 时，故障节点数据在其他副本上仍可查询
- **代价**：临时数据倾斜（故障恢复后需要重平衡）

### 5.4 数据一致性

- **副本数 `-replicationFactor=N`**：每份数据存 N 个 vmstorage
- 写入等**大多数**（floor(N/2)+1）ACK 才返回
- 强一致，但比副本 1 慢

---

## §6 · 查询路径与并发

### 6.1 vmselect 查询流程

1. 接收 PromQL/MetricsQL 请求
2. 解析 → 生成执行计划
3. **广播到所有 vmstorage**（按分片查询）
4. 各 vmstorage 本地执行时序过滤 + 聚合
5. vmselect 合并结果（跨分片聚合）
6. 返回客户端

### 6.2 vmstorage 本地查询（倒排索引查询逻辑）

1. **解析 label matcher**：PromQL 里的 `{__name__="cpu_usage", region="gz"}` 拆成多个条件
2. **每个条件查倒排索引 indexdb**：
   - `__name__="cpu_usage"` → 查 metric name → MetricGroupID
   - `region="gz"` → 查 `(metricGroupID, "region", "gz")` → InstanceID 集合
3. **集合运算**：多个 matcher 之间是 **AND（交集）**；`=~` 正则可能命中多个值，先各自求集合再求并集
4. 交集结果 → **TSID 集合**（命中的 series 列表）
5. 用 TSID + 时间范围 → 定位 data part 里对应的 block（通过 index.bin 二分定位）
6. 只解压命中 block 的 timestamp / value → 返回样本
7. 本地可下推的聚合（sum/count/max/min）在解压后直接做，减少跨网络传输的数据量

> 关键点：查询开销集中在两处——① indexdb 求交集（label 高基数时集合巨大）② 解压命中的 block。这就是「label 高基数」会同时拖慢查询又吃内存的根因。

### 6.3 并发控制

- **`-search.maxConcurrentRequests`**：vmselect 最大并发查询
- **`-search.maxQueueDuration`**：查询排队上限
- **`-search.maxQueryDuration`**：单查询超时
- **`-search.maxSeries`**：单查询返回 series 上限（防止 OOM）

### 6.4 查询缓存

- vmselect 有 rollup result cache（时序聚合结果）
- 查询命中 cache 秒返
- **对 Grafana 高频刷新的 Dashboard 极友好**

---

## §7 · MetricsQL：相对 PromQL 的增强

### 7.1 兼容性

- **99% PromQL 兼容**：绝大多数查询无缝迁移
- 少量语义微差异（如 `last_over_time` 行为）

### 7.2 MetricsQL 独有能力

**常用增强**：

- **`WITH` 别名**：类似 SQL CTE
  ```
  WITH (
    total = sum(rate(http_requests_total[5m])),
    errors = sum(rate(http_requests_total{status=~"5.."}[5m]))
  )
  errors / total * 100
  ```

- **`keep_metric_names`**：算子后保留原 metric 名
- **`alias(expr, "name")`**：显式设置 metric 名
- **`rollup / rollup_rate / rollup_increase`**：滚窗聚合
- **`histogram_quantiles(...)`**：一次算多个分位数

### 7.3 更好的语义

- **`rate` 处理 counter reset**更宽容（不会有边缘负值）
- **`histogram_quantile`** 更精确的桶插值
- **`quantile_over_time`** 直接对样本算分位（比 Prometheus histogram_quantile 精确）

---

## §7.5 · 集群模式全景：三分离 + 一致性哈希 + rerouter

### 7.5.1 集群架构

**VM 相对 Prometheus 最大的差异：VM 天然是分布式**。

**完整拓扑**：
```
     [Prometheus / vmagent / OpenTelemetry]
              │ remote_write
              ▼
    ┌──────────────────────────────┐
    │  vminsert × N（无状态）       │  ← LB 前置，可水平扩
    │  一致性哈希路由到 vmstorage    │
    └────────────┬─────────────────┘
                 │
    ┌────────────┼─────────────┐
    ▼            ▼             ▼
┌──────┐    ┌──────┐      ┌──────┐
│ vms-1 │    │ vms-2 │      │ vms-N │  ← 有状态，数据分片
│ shard1│    │ shard2│      │ shardN│
└──┬───┘    └──┬───┘      └──┬───┘
   │ query      │             │
    └───────────┼─────────────┘
                ▲
    ┌────────────────────────────┐
    │  vmselect × K（无状态）     │  ← 查询广播到所有 vmstorage
    │  合并各分片结果             │
    └───────┬────────────────────┘
            ▲
      [Grafana / vmalert]
```

**三大组件对比**：
| 组件 | 状态 | 数量 | 扩容 |
|---|---|---|---|
| vminsert | 无状态 | N | 水平扩，加节点即可 |
| vmstorage | **有状态**（存数据） | M | 需数据迁移，扩容成本高 |
| vmselect | 无状态 | K | 水平扩，加节点即可 |

### 7.5.2 为什么无外部依赖（对比 Cortex / Thanos）

**关键差异**：
- **Cortex / Mimir**：依赖 Consul/etcd 做服务发现 + Ring；依赖 Cassandra/DynamoDB/BigTable 做元数据；依赖 S3 做存储
- **Thanos**：依赖 S3 存 Block，依赖 gossip 发现
- **VM**：**只依赖静态配置的 vmstorage 列表**（`-storageNode=vms-1:8400,vms-2:8400,...`）

**运维价值巨大**：
- 无 ZK / etcd / Consul 升级维护
- 无 S3 / Cassandra 组件依赖
- 一致性哈希在 vminsert 本地内存中计算

**代价**：
- **无自动服务发现**（新加节点要改所有 vminsert / vmselect 配置重启）
- **无自动 rebalance**（新 vmstorage 不承接老数据）

### 7.5.3 写入路径：一致性哈希 + rerouter

**分片算法**：
```go
shardIdx = jump_hash(labelsHash, len(storageNodes))
```

**特性**：
- **jump hash**（Google 论文）：无外部状态，本地计算
- 相同 series（同 label 组合）**始终落同一 vmstorage**
- 新增节点触发 K/N 的 series 迁移（重新哈希）

**写入流程**：
```
1. Prometheus remote_write → vminsert-1 (随机 LB)
2. vminsert-1 解 protobuf，得到 N 条样本
3. 每条样本按 jump_hash(labels) 分组
4. 分组后批量转发到目标 vmstorage
5. vmstorage 写入本地 mergeset
6. 所有分片 ACK → vminsert 返回 200
```

**rerouter 弹性**：
- 目标 vmstorage 挂了或超时（`insert_timeout=1m`）
- vminsert 检测到失败 → **rerouter 到其他健康 vmstorage**
- **代价**：数据 series 分布"临时紊乱"（本该到 vms-3 的数据临时写到 vms-4）
- 恢复：vms-3 起来后，新数据继续到 vms-3；老数据留在 vms-4 上（永远不迁）

**副本机制 `-replicationFactor=N`：写时冗余，而非主从**：

**核心结论：没有主从设计**。vmstorage 节点之间**完全对等**，没有 leader / follower，也没有谁向谁同步数据。副本的产生方式与 MySQL/Redis 主从复制、Kafka Leader/Follower 完全不同：

```
vminsert 收到一条样本
      │
      ▼
jump_hash(labels) 算出「主分片」
      │
      ▼
沿 hash 环取「连续 N 个」vmstorage（-replicationFactor=2 时取 2 个）
      │
      ▼
同一份数据同时写进 N 个 vmstorage（各存一份，互为副本）
```

- vminsert 每条样本**写到 N 个连续 vmstorage**（沿 jump hash 环取相邻 N-1 个）
- 生产标配 **N=2**：一份数据两个副本
- 单副本挂读写不中断
- **副本不是主从**：vmstorage 之间**不复制、不同步、互不感知**，副本完全靠 vminsert「写时一次性写 N 份」产生

**对比主从复制**：
| 特性 | 主从复制（MySQL/Redis） | VM 写时冗余 |
|---|---|---|
| 谁是数据源 | Leader 写，Follower 复制 | **vminsert 是唯一写入源** |
| 副本怎么产生 | 从 Leader 拉取/同步 | **写入时就写 N 份** |
| 副本间关系 | Leader/Follower 有主次 | **完全对等，互不感知** |
| 谁负责同步 | Leader 推 或 Follower 拉 | **没人同步**（写时直接落 N 份） |

### 7.5.4 vmstorage 挂机的处理

**单 vmstorage 挂**（有副本情况）：
- **写入**：vminsert rerouter 到其他节点，不中断
- **查询**：vmselect 广播到所有 vmstorage → 挂的那台没响应 → **`-search.skipSlowReplicas=true`** 允许跳过（默认 false 会报错）
- **副本读兜底**：`-replicationFactor=2` 时，挂的分片数据在另一副本上仍能读到
- **恢复**：vmstorage 重启后从本地磁盘加载 part，rerouter 期间的数据留在别的节点（不迁回）

**vmstorage 磁盘损坏**：
- 该节点数据永久丢
- **副本 = 2 时**：只丢一半冗余，业务无感
- **副本 = 1 时**：**数据永久丢失**
- 恢复：新盘 + 重启，节点里没老数据（副本从其他节点补齐？**不会**——VM 不自动重同步！）
- **想恢复数据**：只能从备份恢复或接受丢失

**面试深度**：
> "VM 的副本模型是**写时冗余**而非**主从同步**：vminsert 写 2 份到相邻 vmstorage 各存一份，副本之间**没有互相感知**——你挂了对方不会补你的数据。所以如果 replicationFactor=2 且一个副本磁盘挂了，读还是能读到（另一份还在），但**冗余度降到 1**，此时另一副本再挂就永久丢失。这是相对 Cassandra hinted handoff / anti-entropy 的简化。"

### 7.5.5 无选主？

**VM 集群完全没有选主概念**：
- vminsert 之间无协调（各自独立计算 hash）
- vmstorage 之间无协调（各存各的分片）
- vmselect 之间无协调（各自广播查询）
- **所有节点对等**

**为什么能不选主**：
- 分片策略是**静态确定的**（jump hash + storageNodes 配置）
- 副本策略是**写时决定的**（vminsert 写 N 份）
- 元数据没有全局一致性需求（每个 vmstorage 自管本地 series 索引）

**代价**：
- 配置变更（加/减节点）需要**滚动重启所有 vminsert / vmselect**
- 无法动态感知节点上下线（LB 层的健康检查兜底）

### 7.5.6 数据不丢的兜底：三层叠加

VM 保证 vmstorage 数据不丢，**不是靠主从**，而是靠三层叠加（每层防不同的故障场景）：

```
vmagent WAL        → 防「写入阶段集群不可用」
replicationFactor  → 防「单个 vmstorage 磁盘损坏」
vmbackup           → 防「集群级灾难 / 误删」
```

**第 1 层 · 写入侧缓冲（vmagent WAL）**：
- vmagent 本地磁盘 WAL 缓冲（`-remoteWrite.tmpDataPath`）
- 远端 VM 挂了 vmagent 缓存到磁盘（最多 N 小时可配）
- 恢复后自动补发
- **防的是**：写入瞬间 VM 集群整个不可用（vminsert 全挂 / 网络抖动）

**第 2 层 · 存储侧冗余（replicationFactor）**：
- `-replicationFactor=2`：每条样本写 2 份，落在 2 个不同 vmstorage
- **防的是**：单个 vmstorage 磁盘损坏，另一副本还在
- 这就是「写时冗余」而非主从，原理见 7.5.3

**第 3 层 · 备份（vmbackup）**：
- `vmbackup` 增量备份到 S3/COS
- 恢复用 `vmrestore`
- **防的是**：集群级灾难、误删、`replicationFactor=1` 时的数据丢失

**为什么 VM 选「写时冗余」而不是「主从」**：
- 主从复制（MySQL/Redis）：Leader 串行写，Follower 异步/半同步追。数据一致性强，但**写入有主节点瓶颈 + 同步有延迟**
- VM 写时冗余：vminsert 无状态可无限水平扩，写入时直接哈希落 N 份。**写入吞吐极高、无主节点瓶颈、无同步延迟**
- VM 是时序库，追求「极高写入吞吐」，所以牺牲「副本自动修复」换「写入无瓶颈」（代价见 7.5.4）

**vmagent 是数据不丢的关键**：
> "Prometheus remote_write 失败会缓冲一段但有上限。**vmagent 是新架构不丢的核心**——它本地磁盘 WAL 可以扛几小时的远端故障。生产建议 Prometheus 换成 vmagent 采集，就是为了这个。"

### 7.5.7 数据恢复

**vmstorage 磁盘挂**：
- 副本 ≥ 2 且另一副本健康 → 业务无感 → 换盘重启即可（**数据丢了但另一副本有**）
- 副本 = 1 → 数据丢，靠 vmbackup 恢复

**vminsert / vmselect 挂**：
- 无状态，重启即可，不涉及数据

**新加 vmstorage 节点**：
- 修改所有 vminsert / vmselect 的 `-storageNode` 参数
- 滚动重启 vminsert / vmselect
- **新数据按新哈希分布**，老数据留在原节点
- **无需数据迁移** = 快速扩容优势
- **代价**：数据分布不均，直到新老数据比例大致均衡（等 retention 到期）

**减 vmstorage 节点**：
- 需要先**手动迁数据**（`vmctl migrate` 从旧节点 → 新集群）
- 然后从配置摘除
- **风险高，生产极少缩容**

### 7.5.8 与竞品对比

| 维度 | VM 集群 | Thanos | Cortex/Mimir |
|---|---|---|---|
| 组件数 | 3（vmi/vms/vms） | 5+（sidecar/query/store/compact/rule） | 5+（distributor/ingester/querier/store/compactor） |
| 外部依赖 | 无 | S3 | Consul + Cassandra + S3 |
| 副本 | 写时冗余 | S3 天然多副本 | Ring 复制因子 |
| 扩容 | 加节点改配置重启 | 加 sidecar 上传 | 加 ingester 触发 rebalance |
| 长期存储 | vmstorage 本地/S3 | S3 强制 | 冷数据 S3 |
| 性能 | 写入 20x Prom | 依赖 S3 IO | 中等 |
| 运维复杂度 | **最低** | 中 | **最高** |

### 7.5.9 面试模板

> "生产 VM 集群 5 vminsert + 20 vmstorage（`replicationFactor=2`，跨 3 AZ）+ 5 vmselect + 3 独立 Keeper 补告警链路（vmalert）。日写 5000 亿 samples，查询 P99 <500ms。
>
> **集群哲学**：无选主、无外部依赖、静态一致性哈希，简单到令人发指。相对 Cortex Ring + Consul，VM 少了三个中间件依赖，运维成本降低一个数量级。
>
> **数据不丢**：vmagent WAL 缓冲远端故障 + replicationFactor=2 冗余 + vmbackup 备份到 COS。**核心弱点**：单副本挂盘且无副本时数据永久丢——所以 replicationFactor 生产**必须 ≥ 2**。
>
> **扩容优势**：新增 vmstorage 改配置重启即可，新数据自动分布，老数据留在原节点自然过期。**扩缩容都不需要停机**——但缩容需要手动 vmctl migrate 迁数据。"

---

## §8 · 多租户

### 8.1 URL 前缀路由

- 写入：`/insert/{accountID}/prometheus/api/v1/write`
- 查询：`/select/{accountID}/prometheus/api/v1/query`
- **accountID 数字或 `accountID:projectID`**

### 8.2 租户隔离

- 每租户独立 series 空间，无跨租户查询
- 存储层按租户分区，元数据独立
- 硬性隔离，无租户串扰

### 8.3 TCUM 生产多租户实践

- 按业务方划分 accountID（如：CVM=1, DB=2, LB=3）
- Prometheus/vmagent remote_write 时带上租户前缀
- Grafana 数据源按租户配置

---

## §9 · 长期存储与降采样

### 9.1 保留策略

- `-retentionPeriod=90d`（默认 1 个月）
- 支持年级别保留 `-retentionPeriod=2y`
- 老数据自动清理（超过 retention 的 part 被 merger 删除）

### 9.2 降采样（企业版）

- 老数据按更粗粒度聚合存储（5min / 1h / 1day）
- 长时间查询自动读粗粒度 → 节省 IO + 加速
- **开源版无原生降采样**，但可以用 vmalert Recording Rule 生成聚合 series 手动降采样

### 9.3 冷热存储

- 企业版支持 hot/cold tier
- 开源版可以拆多集群 + retention 不同（30d 热 + 1y 冷）

---

## §10 · vmagent 与 vmalert

### 10.1 vmagent

- **可代替 Prometheus 做采集**（更轻更快）
- **可代替 pushgateway**（接收 push 模式）
- **本地磁盘 WAL 缓冲**：远端 VM 挂时缓冲最多 N 小时
- **配置和 Prometheus scrape_configs 兼容**
- **常见部署**：DaemonSet 每节点一个 vmagent 采本地 pod，remote_write 到中心 VM

### 10.2 vmalert

- 评估 Prometheus alerting/recording rule
- 推 firing alerts 给 Alertmanager
- 存储 recording rule 结果到 VM
- **相对 Prometheus alerting**：无本地 TSDB，需要 VM 提供数据源

**典型部署**：多副本 vmalert + Alertmanager 集群 → 高可用告警链路。

---

## §11 · 与 Prometheus 生态融合

### 11.1 Prometheus → VM

- Prometheus `remote_write` 配置指向 vminsert
- VM 兼容 Prometheus TSDB block（`vmctl`：Prometheus data → VM 迁移）

### 11.2 Grafana 查 VM

- Prometheus 数据源类型，URL 指向 vmselect
- 几乎无缝

### 11.3 Alertmanager 集群

- vmalert → Alertmanager 集群
- **同 Prometheus 一样**：AM 靠指纹去重，多个 vmalert 副本发同 alert 会去重

---

## §12 · 生产实战：TCUM 中的 VM 集群

### 12.1 规模

- 单集群百 TB 级
- vmstorage 数十节点
- 写入 QPS 亿级 / 分钟
- 查询延迟 P99 < 500ms

### 12.2 部署模式

```
[Prometheus 边缘 * N]（K8s 边缘采集）
    │ remote_write
    ↓
[vminsert * 5 (LB)]
    │ 一致性哈希
    ↓
[vmstorage * 20]（-replicationFactor=2）
    ↑ query
[vmselect * 5 (LB)]
    ↑
[Grafana / vmalert]
```

### 12.3 关键配置

- `-replicationFactor=2`：数据两份，容忍单节点故障
- `-storageDataPath=/data`：SSD 数据盘
- `-retentionPeriod=30d`：热数据 30 天
- `-maxLabelsPerTimeseries=30`：单 series label 上限
- `-search.maxUniqueTimeseries=300000`：单查询 series 上限
- `-search.maxConcurrentRequests=64`：并发查询

### 12.4 监控 VM 自身

- vmstorage `vm_active_series` 单实例 series 数
- `vm_rows_inserted_total` 写入速率
- `vm_free_disk_space_bytes` 磁盘剩余
- `vm_slow_queries_total` 慢查询
- `vm_rerouted_rows_total` rerouter 触发（表明有节点异常）

### 12.5 迁移历史

- **早期**：Prometheus 单机 + Federation → 老数据丢
- **v1**：InfluxDB → GC 抖动，查询慢
- **v2**：Thanos → S3 迁移复杂 + Query 慢
- **v3（现在）**：VM 集群 → 20x 性能提升 + 简化架构

---

## §13 · 版本演进

- **1.50+**：稳定生产
- **1.70+**：MetricsQL WITH 表达式
- **1.80+**：vmagent WAL 缓冲增强
- **1.90+**：内存效率优化
- **v1.100+**：企业版 downsampling GA
- **v1.110+**（最新）：查询性能进一步优化

---

## §14 · 50 问详解

### 【架构与定位】

**Q1. VM 相比 Prometheus 有什么优势？**
> 写入 20x 快、存储省 7x、集群水平扩展、无外部依赖（不需要 ZK/etcd）、PromQL 兼容 + MetricsQL 增强。

**Q2. VM 单机版和集群版区别？**
> 单机：单二进制，10 亿 series 内够用；集群：vminsert/vmstorage/vmselect 三分离，水平扩展，生产标配。

**Q3. VM 三大组件各自作用？**
> vminsert（无状态写入路由）+ vmstorage（有状态存储）+ vmselect（无状态查询分发）。

**Q4. VM 为什么不用 ZK/etcd？**
> 一致性哈希在 vminsert 本地计算，无需外部协调。集群成员通过 `-storageNode` 参数配置，简化运维。

**Q5. vmagent 是什么？**
> 轻量采集代理，代替 Prometheus 做采集（更快更省）或代替 Pushgateway 接收 push。本地 WAL 缓冲远端故障。

**Q6. vmalert 是什么？**
> 告警规则评估器：查 VM 数据源 + 评估 alerting/recording rule + 推 firing 给 Alertmanager。

### 【存储与压缩】

**Q7. mergeset 是什么？**
> VM 核心数据结构，LSM Tree 风格：inmemory part → file part → merge 成大 part。类似 ClickHouse MergeTree。

**Q8. VM 每样本平均多少字节？**
> **约 0.4 字节**。timestamp Delta of Delta + value XOR/Gorilla + ZSTD。Prometheus 1.2，InfluxDB 2+。

**Q9. VM 索引结构？**
> indexdb 存 label→series_id 倒排；data 存 series_id → 时序值。查询先 indexdb 找 series，再 data 拿样本。

**Q10. VM 有 WAL 吗？**
> vmstorage 有可选 WAL（默认关闭）。可靠性靠副本（`-replicationFactor`）保证。开 WAL 影响性能。

**Q11. Gorilla 编码是什么？**
> Facebook 2015 论文：时序 timestamp 用 Delta of Delta，value 用 XOR 前导零编码。压缩率 10~15x。

### 【写入】

**Q12. vminsert 是无状态的吗？**
> 是。可以任意扩缩。用 LB / K8s Service 暴露。

**Q13. rerouter 是什么？**
> 一个 vmstorage 挂了，vminsert 检测到写失败会重路由到其他 vmstorage。保证写入不中断。

**Q14. 副本数怎么设？**
> `-replicationFactor=2` 数据两份，容忍单节点故障。生产标配 2，金融可 3。

**Q15. VM 写入 QPS 上限？**
> 单核 100w+ 样本/秒。vminsert 10 核 = 千万 QPS 数量级。vmstorage 磁盘 IO 是瓶颈。

**Q16. VM 兼容 remote_write 协议吗？**
> 完全兼容。Prometheus 直接 remote_write 到 vminsert。也支持 InfluxDB / Graphite / OpenTSDB / OpenTelemetry 等协议。

**Q17. VM 怎么处理 duplicate 样本？**
> 相同 series + 相同 ts 的重复样本自动去重（保留第一次）。可通过 `-dedup.minScrapeInterval` 配置。

### 【查询】

**Q18. vmselect 查询流程？**
> vmselect → 广播所有 vmstorage → 各 vmstorage 本地查 + 部分聚合 → vmselect 合并 → 返回。

**Q19. VM 有查询缓存吗？**
> 有 rollup result cache。相同查询秒返。Grafana Dashboard 高频刷新友好。

**Q20. VM 查询能下推什么？**
> sum/count/max/min/avg 等简单聚合在各 vmstorage 本地做，减少网络传输。复杂聚合（quantile / topk）需要 vmselect 全局做。

**Q21. VM 单查询能返多少 series？**
> `-search.maxUniqueTimeseries=300000` 默认。超过报错保护 OOM。

**Q22. VM 慢查询怎么排查？**
> `vm_slow_queries_total` 计数 + 慢查询日志（`-search.logSlowQueryDuration=5s`）。**类似 MySQL slow log**。

### 【MetricsQL】

**Q23. MetricsQL 和 PromQL 什么关系？**
> MetricsQL 超集，99% PromQL 兼容。少量语义微差异 + 独有增强（WITH / keep_metric_names / rollup）。

**Q24. MetricsQL 的 WITH 有什么用？**
> 类似 SQL CTE：复杂查询里定义中间变量，可读性 + 复用。

**Q25. `histogram_quantile` VM 版为什么更准？**
> VM 对稀疏 bucket 做更好的插值处理，减少估算误差。

**Q26. `quantile_over_time` 和 `histogram_quantile` 区别？**
> quantile_over_time 直接对样本算分位（精确但样本多才准）；histogram_quantile 用 bucket 插值估算（bucket 粗则误差大）。

### 【多租户】

**Q27. VM 多租户怎么实现？**
> URL 前缀 `/insert/{accountID}/...` 和 `/select/{accountID}/...`。硬隔离，无跨租户查询。

**Q28. 多租户的 series 是独立的吗？**
> 是。每租户独立 series 命名空间，metric_name 相同但 accountID 不同视为不同 series。

**Q29. TCUM 生产多租户怎么划分？**
> 按业务线（CVM / DB / LB / K8s / 中间件），每业务一 accountID。Grafana 数据源按租户配置。

### 【运维】

**Q30. vmstorage 挂了会怎样？**
> ① 该节点的数据无法读（除非有副本）② vminsert 通过 rerouter 转发新写入到其他节点 ③ 恢复后自动追赶数据。

**Q31. vmselect 挂了会怎样？**
> 只影响查询，写入继续。vmselect 无状态，restart 秒恢复。

**Q32. VM 扩容 vmstorage 怎么办？**
> 加新节点 → 更新 vminsert / vmselect 的 `-storageNode` 列表 → 新写入路由到新节点 → 老数据不自动 rebalance（查询仍能找到）。

**Q33. VM 数据备份怎么做？**
> `vmbackup` 工具，增量备份到 S3。恢复 `vmrestore`。企业版 backup manager 自动化。

**Q34. VM 冷热存储怎么做？**
> 企业版原生支持 hot/cold tier。开源版可以多集群拆分（30 天热 + 长期冷）+ 应用侧路由。

**Q35. VM 磁盘满了会怎样？**
> 停止接收新写入。监控 `vm_free_disk_space_bytes` 提前告警。清理旧数据或扩容。

### 【性能】

**Q36. VM 为什么写入快？**
> Go 精心优化（少 alloc + sync.Pool + unsafe.ToUnsafeString 零拷贝）、mergeset LSM 顺序 IO、Gorilla 压缩少落盘。

**Q37. VM 为什么查询快？**
> 索引紧凑 + 部分聚合下推 + rollup cache + Go 无 GC 抖动（相对 Java InfluxDB）。

**Q38. VM 内存管理关键点？**
> sync.Pool 复用 buffer、bytesutil.ToUnsafeString 零拷贝、预分配 slice、mmap 磁盘 part。

**Q39. VM 抗高基数比 Prometheus 强吗？**
> 强 2~3x。但仍有硬上限，超千万 active series 单机吃力。用 CK 存明细补充。

**Q40. VM 集群相比 Thanos / Cortex 优势？**
> ① 无外部依赖（Thanos 依赖 S3 + Bucket，Cortex 依赖 Cassandra/DynamoDB） ② 部署运维简单 ③ 写入性能好 5x+ ④ Go 无 GC 抖动。

### 【故障与调优】

**Q41. VM 出现慢查询怎么调优？**
> ① `-search.maxUniqueTimeseries` 保护 OOM ② 检查是否高基数 ③ 加 Recording Rule 预计算 ④ 拆细时间窗口 ⑤ 用 MetricsQL WITH 优化复杂查询。

**Q42. VM 内存持续增长怎么办？**
> 检查 `vm_active_series` 是否暴增（新 series 涌入）→ 定位是否高基数（label 值动态化）→ metric_relabel drop。

**Q43. vminsert 到 vmstorage 网络抖动会丢数据吗？**
> 不会。vminsert 有本地 buffer，重试失败节点数据 rerouter 到其他节点。副本 ≥ 2 保证不丢。

**Q44. VM 支持 histogram 吗？**
> 支持 Prometheus histogram_bucket。企业版原生支持 Native Histogram（Prometheus 2.40+ 新特性）。

**Q45. vmalert 和 Prometheus alerting rule 有什么区别？**
> 语法完全兼容。vmalert 无本地 TSDB 需要数据源（VM/其他 Prometheus）。多副本 vmalert + AM 集群等效 Prometheus HA。

### 【选型对比】

**Q46. VM vs InfluxDB？**
> VM：Go 无 GC 抖动，Prometheus 生态兼容，20x 写入快；InfluxDB：v2 商业能力多但 Flux 学习曲线陡。**云原生监控选 VM**。

**Q47. VM vs Thanos？**
> Thanos：Prometheus + S3 长期存储，查询 sidecar 汇聚，架构复杂；VM：独立时序库，简单快。**新场景选 VM**。

**Q48. VM vs Cortex/Mimir？**
> Cortex/Mimir：多租户强，云厂商托管方案；VM：轻量、快、部署简单。**中小规模 VM，多租户强需求 Mimir**。

**Q49. VM vs ClickHouse 存时序？**
> VM 专有时序库：Gorilla 压缩 0.4 字节 + 稀疏索引点查/范围查快，但 label 即维度、高基数会爆炸；CK 通用列存 OLAP：SQL 任意维度聚合灵活、列存抗高基数，但点查/范围查不如 VM 专精、需预聚合 MV。**选型铁律：低基数时序指标 → VM，高基数明细/复杂多维分析 → CK**（详见 §3.3）。

**Q50. VM 什么场景不合适？**
> ① 需要复杂 SQL 查询（用 CK）② 需要日志检索（用 ES/Loki）③ 单集群 series > 亿级极端场景（分集群或用云厂商托管）。

### 【补充深度】

**Q51. VM 支持 OpenTelemetry 吗？**
> 支持 OTLP HTTP 协议接收 metric。生态融合越来越好。

**Q52. VM 有没有 push 模式？**
> 支持。vmagent 可接收 push（InfluxDB line protocol / Graphite），vminsert 支持 remote_write（本质也是 push）。

**Q53. VM 的 dedup 是什么？**
> Prometheus HA 时两个 Prometheus 采相同 target 会发相同数据到 VM。VM `-dedup.minScrapeInterval=60s` 时间窗内 series 重复样本只保留最新。

**Q54. VM 生产要监控哪些关键指标？**
> vm_active_series（活跃 series）、vm_rows_inserted_total（写入速率）、vm_slow_queries_total（慢查询）、vm_rerouted_rows_total（rerouter 触发）、vm_free_disk_space_bytes（磁盘）、内存 RSS。

**Q55. VM 集群故障演练必测项？**
> ① 单 vmstorage 挂 → rerouter 生效？副本读能到？② 单 vminsert 挂 → LB 转发到其他？③ vmselect 挂 → 查询失败/切换？④ 磁盘满 → 告警响应？⑤ 慢查询限制 → 是否 OOM？

---

## §15 · 短板与坑

1. **企业版能力开源版缺失**：downsampling / backup manager / graphite protocol
2. **集群水平扩容不自动 rebalance**：新加 vmstorage 老数据不迁移
3. **副本 = 2 是标配**：副本 1 单点风险
4. **高基数虽比 Prometheus 强但仍是灾难**
5. **慢查询卡 vmselect**：单查询 series 上限保护但不阻止累积
6. **社区规模小于 Prometheus**：生态插件有限
7. **PromQL 语义有微差异**：极端场景需要注意
8. **Native Histogram 支持晚于 Prometheus**
9. **多集群拆分复杂**：企业规模需要考虑 vmauth 路由
10. **vmagent WAL 缓冲有上限**：远端长时间挂会丢数据

---

## §16 · 面试话术

### 3 分钟自述

> "我在 TCUM 生产用 VictoriaMetrics 集群承担时序主库，vminsert 5 + vmstorage 20（副本 2）+ vmselect 5，日写入亿级样本，查询 P99 <500ms。
>
> **对 VM 最深三点理解**：
> - **性能碾压 Prometheus 20x 的秘密**：Go 精心优化（sync.Pool + unsafe.ToUnsafeString 零拷贝 + 预分配）+ mergeset LSM 顺序 IO + Gorilla + ZSTD 压缩样本 0.4 字节。这是 InfluxDB Go 版本 GC 火焰图 35% 的教训之解。
> - **无外部依赖的架构简化运维**：不像 Cortex 依赖 Cassandra / Thanos 依赖 S3+Bucket，VM 一致性哈希在 vminsert 本地算，rerouter 应对节点失败。这是 5 人小组能维护百 TB 集群的关键。
> - **PromQL 兼容 + MetricsQL 增强**：99% PromQL 兼容零迁移成本，WITH 表达式和 keep_metric_names 让复杂查询可读得多。
>
> **生产血泪**：单 vmstorage 挂 rerouter 数据倾斜、高基数 label 涌入 series 千万级 vmselect OOM、多租户配置错误跨查失败——每一次都是模型和运维的教训。"

### 反问 5 问

1. VM 版本？集群规模？副本几份？
2. 有没有企业版？downsampling 用了吗？
3. 高基数 series 治理机制？动态 label 拒绝策略？
4. 慢查询监控和保护？maxUniqueTimeseries 多少？
5. 多集群拆分了吗？租户/业务隔离方案？

---

**本篇完 · 约 24KB · 覆盖架构/存储/写读路径/MetricsQL/多租户/生产/55 问**

**证据基线**：
- VictoriaMetrics 官方文档：https://docs.victoriametrics.com
- Facebook Gorilla 论文
- 生产实战：TCUM VM 集群百 TB 规模、pendingseries.go / bytesutil.ToUnsafeString 源码级
- Prometheus vs VM 官方 benchmark（20x 写入，7x 存储）
