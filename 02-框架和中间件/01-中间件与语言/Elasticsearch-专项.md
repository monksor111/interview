# 第五卷 · 中间件 · Elasticsearch 专项

> **本篇定位**：Elasticsearch 是 TCUM 体系里承担**日志全文检索 + Trace 检索 + 告警检索 + CMDB 全文搜索**的核心引擎。相对 CK 的结构化聚合、VM 的低基数时序，ES 的定位是**倒排索引 + 分布式检索 + 灵活聚合**。本文覆盖 Lucene 内核、倒排索引、分片副本、写入路径、查询路径、mapping、聚合、DSL、Refresh/Flush/Merge、生产实战、50+ 高频面试题。

## 📖 目录
- §1 命题：ES 为什么是分布式搜索之王
- §2 Lucene 内核与倒排索引
- §3 集群拓扑：master/data/coordinating/ingest
- §4 分片与副本
- §5 写入路径（Index → Refresh → Flush → Merge）
- §6 查询路径（Query then Fetch）
- §7 Mapping 与字段类型
- §8 Analyzer 分词器
- §9 DSL：query / filter / aggs
- §10 深度分页与 search_after / scroll / PIT
- §11 聚合内幕
- §12 段合并（Merge）机制
- §13 生产实战：日志 / Trace / CMDB 检索
- §14 版本演进：ES 6/7/8
- §15 50 问详解
- §16 短板与坑
- §17 面试话术模板

---

## §1 · 命题：ES 为什么是分布式搜索之王

### 一句话背诵

> "ES 是**分布式的 Lucene**——单机 Lucene 提供倒排索引和全文检索，ES 加上**分片副本 + 集群协调 + REST API + 聚合** 变成了工业级分布式搜索平台。它扛日志、Trace、检索、监控告警，是 ELK/EFK 栈的核心。"

### ES 五大能力

1. **全文检索**：倒排索引 O(1) 词项定位，TF-IDF/BM25 打分排序
2. **分布式**：Shard × Replica 水平扩展，单集群 PB 级
3. **准实时**：写入 1s 后可查（默认 refresh_interval=1s）
4. **灵活聚合**：Terms / Range / Histogram / Metric / Pipeline
5. **REST API + JSON DSL**：友好，与语言无关

### 边界代价（重要）

- **不擅长事务**：无 ACID，只有近实时一致
- **不擅长关系**：Nested / Parent-Child 慢，避免用
- **不擅长精确聚合大 cardinality**：cardinality 是估算（HLL）
- **深分页崩溃**：`from + size > 10000` 直接报错
- **写入放大**：每次 refresh 生成新 segment，段合并磁盘/CPU 消耗大
- **JVM 是瓶颈**：GC 抖动 = 请求延迟毛刺

---

## §2 · Lucene 内核与倒排索引

### 2.1 Lucene 是什么

- **Java 全文检索库**（Apache），Doug Cutting 1999 年开始
- ES / Solr / OpenSearch 都基于 Lucene
- **核心概念**：Segment（不可变的最小检索单元）

### 2.2 倒排索引

**正排索引**（关系数据库）：
```
doc1: [term_a, term_b, term_c]
doc2: [term_b, term_d]
```

**倒排索引**（Lucene）：
```
term_a → [doc1]
term_b → [doc1, doc2]
term_c → [doc1]
term_d → [doc2]
```

**结构细化**：
- **Term Dictionary**（词典）：所有 term 的有序集合，用 **FST（Finite State Transducer）** 存储 → 压缩率极高
- **Term Index**：Term Dictionary 的索引（内存）
- **Posting List**：每个 term 对应的 doc_id 列表，按 delta 编码 + 压缩
- **Positions / Offsets**：短语查询、高亮用
- **Norms**：文档长度归一化因子（BM25 打分用）
- **DocValues**：正排的列式存储（用于排序、聚合、脚本字段）

### 2.3 一次全文检索的流程

1. 查询词经 Analyzer 分词 → term 集合
2. Term Index 定位 Term Dictionary 中 term 位置
3. Term Dictionary 拿到 Posting List
4. **多个 term 的 Posting List 求交/并**（AND / OR）
5. **BM25 打分**（考虑 tf、idf、doc 长度）
6. Top-K 排序

### 2.4 段（Segment）不可变性

- **一个 Segment = 一个小型索引**（有独立的倒排、正排、norms 等文件）
- **不可变**：新写入生成新 Segment，删除只是标记 `_deleted`
- 段合并（Merge）时物理清除已删除文档

**为什么不可变**：
- 无并发写锁，读性能极佳
- 可以充分利用 OS page cache
- 支持增量索引（不需要重建全表）
- 代价：需要合并（Merge）回收空间

### 2.5 DocValues 与 FieldData

- **DocValues**：**列式正排**存储在磁盘（.dvd 文件），OS cache + mmap
- **FieldData**：老版本用堆内存反构建，OOM 元凶（**已弃用**）
- **text 字段默认无 DocValues**（无法排序/聚合），需要 `.keyword` 子字段

---

## §3 · 集群拓扑：master/data/coordinating/ingest

### 节点角色

| 角色 | 职责 |
|---|---|
| **master-eligible** | 集群元数据管理（cluster state、shard allocation） |
| **data** | 存数据 + 执行查询 |
| **coordinating** | 接收请求 + 路由 + 结果聚合（所有节点默认都是） |
| **ingest** | 前置管道处理（类似 Logstash） |
| **ml / transform** | 机器学习、数据变换（8.x） |

**生产架构**：
- 3 master 独立（不承担数据压力）
- N data 节点（按数据量扩展）
- 2~3 coordinating only 挡查询流量
- 大集群独立 ingest 节点

### 集群状态（Cluster State）

- **由 master 维护**，包含：index metadata、shard 分配、node 列表、mapping、settings
- 集群状态变更通过 **两阶段协议**：master 发提案 → majority 确认 → apply
- **8.x 起用 Raft-based 协议**（原来的 Zen Discovery 已被替换）

### 脑裂

- ES 6.x 及以前必须配置 `discovery.zen.minimum_master_nodes = (N/2)+1`
- **7.x 起自动管理**（bootstrap.initial_master_nodes 首启一次）

---

## §4 · 分片与副本

### 4.1 概念

- **索引（Index）**：逻辑表
- **分片（Shard）**：索引物理切分单位（一个 Lucene 索引）
- **主分片（Primary）**：负责写入
- **副本（Replica）**：主的完整备份，可读

**关系**：
```
Index: logs-2024-06
  Shard 0 [Primary on node1, Replica on node2]
  Shard 1 [Primary on node2, Replica on node3]
  Shard 2 [Primary on node3, Replica on node1]
```

### 4.2 分片路由

**写入**：`shard = hash(routing || _id) % primary_count`
- `_id` 默认作 routing
- 支持指定 routing → 相关文档同 shard（利于查询）

### 4.3 分片数如何选

**经验规则**：
- 单分片 **10~50GB** 最舒服
- 单节点分片数 **< 20 × 堆内存(GB)**（每 shard 有元数据开销）
- 主分片数 = 集群节点数 × 1.5 (可扩容余量)

**注意**：
- 主分片数 **创建后不可改**（改要 reindex 或 shrink/split API）
- 副本数可以动态改（`PUT /index/_settings { "number_of_replicas": 2 }`）

### 4.4 副本作用

- **高可用**：主挂了副本升主
- **读扩展**：查询会打到 P 或 R
- **代价**：写入成本翻倍（要复制到副本）

### 4.5 分片分配

- **shard allocation**：master 决定 shard 放哪个 node
- **allocation awareness**：机架/机房感知（不把 P/R 放同一机架）
- **shard rebalance**：节点增减时自动迁移

---

## §4.5 · 集群模式全景：Master 选举 / 分片副本同步 / 故障恢复

### 4.5.1 集群拓扑

**ES 集群模型只有一种：Master 中心化 + 数据分片副本**，但节点角色可以分离。

**典型生产架构**：
```
    ┌────────────────────────────────┐
    │  Master-eligible Nodes (3)     │  ← 只管元数据，不存业务数据
    │  master-1, master-2, master-3  │
    └──────────────┬─────────────────┘
                   │ 集群状态同步
        ┌──────────┼──────────┐
        ▼          ▼          ▼
    ┌──────┐  ┌──────┐  ┌──────┐
    │Data-1│  │Data-2│  │Data-3│  ← 存实际分片
    │P0 R1 │  │R0 P1 │  │R0 R1 │
    └──────┘  └──────┘  └──────┘
        ▲          ▲          ▲
        └──────────┼──────────┘
                   │
        ┌──────────┴──────────┐
        │  Coordinating Nodes │  ← 客户端接入
        └─────────────────────┘
```

**节点角色**：
- **master-eligible**：可选举成 master
- **master**：当选的 master，管理集群状态（选举出来的活跃 master）
- **data**：存数据 + 处理查询本地部分
- **coordinating**：接收请求 + 路由 + 结果聚合（所有节点默认都是）
- **ingest**：前置管道处理
- **ml / transform**：机器学习

**生产原则**：**Master、Data、Coordinating 分离**。大集群 Master 独占防止数据压力影响元数据管理。

### 4.5.2 Master 选举机制

**7.x 前（Zen Discovery）**：
- **需要手动配置** `discovery.zen.minimum_master_nodes = (N/2)+1` 防脑裂
- 配错 = 脑裂灾难

**7.x+（Cluster Coordination，基于 Raft 变种）**：
- **自动管理 quorum**，无需手动配置
- 首启时用 `cluster.initial_master_nodes` 指定初始 master-eligible 集合
- 后续自动追踪 **voting configuration**

**选举流程**：
1. **集群初始化 / master 挂了** → 每个 master-eligible 发起选举
2. 节点声明自己是候选人 → 拉票
3. 得票 ≥ **quorum**（voting nodes 的多数派）→ 成为 master
4. 新 master 广播 cluster state

**为什么至少 3 个 master-eligible**：
- 单个：单点故障
- 两个：脑裂时都拿不到多数 → 集群不可用
- 三个：允许 1 个故障（quorum=2）
- 五个：允许 2 个故障（quorum=3）

**voting-only 节点**（7.x+）：
- 参与投票但不能当 master
- 用于**扩大投票池但不增加 master 候选**（避免小配置机器成 master）

### 4.5.3 集群状态（Cluster State）同步

**Cluster State 是什么**：
- **由 master 独家维护**的全局元数据
- 内容：所有 index 的 mapping/setting、每个分片的位置和状态、节点列表、routing table
- **每次变更 = 新版本号**

**同步方式**：
1. Master 生成变更（比如创建 index / 分片迁移）
2. **两阶段协议 broadcast** 到所有 master-eligible 节点：
   - Phase 1：master 发提案 → 收 ACK
   - Phase 2：majority ACK 后 commit → 通知 apply
3. Data 节点通过订阅拿到 cluster state 更新

**性能陷阱**：
- **Cluster State 是全量下发**（7.x 前）
- 大集群 State 可能几十 MB → 每次变更同步开销大
- 7.x+ 部分优化为增量
- **建议**：单集群索引数 < 5w，分片数 < 10w

### 4.5.4 分片副本同步（写入路径的一致性）

**写入流程**（复习 + 深化）：
```
1. Client → Coordinating Node
2. Coordinating 根据 shard = hash(_id) % primary_count 找到目标主分片
3. 请求转发到 Primary 所在的 data node
4. Primary 写入 in-memory buffer + translog
5. Primary 【并行】转发到所有 in-sync replica
6. 等待 replica 完成（按 wait_for_active_shards 配置）
7. 都完成 → 返回 client
```

**wait_for_active_shards 参数**：
- `1`（默认）：只等 primary → 类似 Kafka acks=1
- `all` 或 `<N>`：等 N 个副本完成
- **注意**：ES **默认只等 primary**，副本写失败仍返回成功，靠后台补齐

**副本延迟处理**：
- **in-sync replica 列表**：类似 Kafka ISR
- 副本写失败 → 标记为 stale → master 决定是否升 primary
- **主分片挂了**：master 从 in-sync 中选新 primary，非 in-sync 的不会被选

**translog 保证不丢**：
- `translog.durability=request`（默认）：**每次请求 fsync**（安全但慢）
- `translog.durability=async` + `sync_interval=5s`：异步 fsync（丢 5s）
- 生产：搜索/存档场景 async，写入敏感场景 request

### 4.5.5 分片分配与再平衡

**allocation 决策**：
- Master 决定分片放哪个 node
- 考虑因素：磁盘剩余、节点负载、awareness 规则（rack/zone）、shard-per-node 上限

**allocation awareness**（重要）：
```yaml
# elasticsearch.yml
cluster.routing.allocation.awareness.attributes: zone
node.attr.zone: zone-a   # 每台机器配自己的 zone
```
效果：**同分片的 P 和 R 一定分到不同 zone** → 单 zone 挂了另 zone 还有副本。

**分片再平衡**：
- 节点上下线 → 触发 rebalance
- Master 计算最优分布 → 生成迁移计划
- 迁移是**分片级别的 recovery**（后面说）

**磁盘阈值**（生产常见坑）：
- `cluster.routing.allocation.disk.watermark.low=85%`：不再往此节点分新分片
- `.high=90%`：把分片迁走
- `.flood_stage=95%`：**所有索引变 read-only**（灾难，运维必须提前告警）

### 4.5.6 数据恢复：Shard Recovery

**触发场景**：
- 节点重启后加入集群
- 主分片挂了升副本
- 分片重新分配（rebalance）
- 快照恢复

**Recovery 流程**：
1. **对比源和目标的 segment 列表**
2. **相同 segment 跳过**（用 sync_id 快速验证）
3. **差异部分从源节点拷贝** segment 文件
4. **replay translog** 补最近的写入
5. **恢复完成后加入 in-sync 列表**

**性能限制**：
- `indices.recovery.max_bytes_per_sec=40mb`（默认）：限速避免打爆磁盘/网络
- 大集群 recovery 慢是常见问题，调大到 200mb+

**关键优化**：
- **sync_id**：索引不再写入时，`_flush/synced` 打标（**7.6 后已废弃**，改用 seq_no）
- 让 recovery **跳过全量对比**，直接秒级恢复

### 4.5.7 集群健康状态

**GREEN / YELLOW / RED**：
- **GREEN**：所有主副分片可用
- **YELLOW**：所有主分片可用，部分副本未分配（读写正常，但故障容忍度下降）
- **RED**：**有主分片不可用**（部分数据读写失败）

**RED 排查**：
```
GET /_cluster/allocation/explain
```
常见原因：
- 副本数配置 > 数据节点数（永远起不来）
- allocation awareness 冲突（唯一 zone 挂了）
- 磁盘满 flood_stage
- 副本迁移失败（网络问题）

### 4.5.8 生产集群设计

**规模建议**：
| 集群规模 | 建议 |
|---|---|
| 小（< 1TB） | 3 节点，all-in-one（master+data+coord） |
| 中（1~50TB） | 3 master + 3~10 data，coord 混部 |
| 大（> 50TB） | 3 master + 独立 data 节点（hot/warm/cold）+ 独立 coord |
| 超大 | 上述 + ML 节点 + 跨集群搜索 CCS |

**冷热架构**（生产标准）：
- **hot 节点**：SSD，接收新写入，短保留
- **warm 节点**：SATA，只读老数据
- **cold 节点**：更廉价，只查很少
- **frozen tier**（8.x）：搜索时才加载，基本零成本
- **ILM 自动迁移**：hot → warm → cold → delete

**面试模板**：
> "生产 ES 集群 3 独立 master + 12 data（分 hot/warm/cold 三层）+ 3 coordinating，写入按天 rollover 到 hot，ILM 自动迁移到 warm（7天）/ cold（30天）/ delete（180天）。分片配置：1 index = 6 primary × 1 replica，跨 3 AZ awareness 保证 zone 挂了业务不中断。master 用 quorum-3 保证脑裂免疫。"

---

## §5 · 写入路径

### 5.1 Index Buffer + Translog

1. Client 写入 → 路由到主 shard
2. **写入 in-memory buffer**（不可查）
3. **同时追加 translog**（磁盘，WAL）
4. **同步复制到副本**（wait for all/one/majority）
5. 返回客户端

### 5.2 Refresh（1 秒）

- 每 `refresh_interval=1s`（默认）：
  - buffer 里的文档 → 生成新 **Segment**（在 OS cache，不 fsync）
  - 新 Segment 打开可查 → **准实时（NRT）**
- **不 fsync**（fsync 太慢），但 translog 已经落盘保证不丢

### 5.3 Flush（30 分钟 或 translog 满 512MB）

- **fsync Segment 到磁盘**
- 清空 translog
- 生成 commit point（记录当前 segment 列表）

### 5.4 Merge

- **后台合并小段为大段**
- 物理清除 `_deleted` 文档
- 代价：磁盘 IO + CPU
- **`force_merge` 手动合并**（只对只读索引，冷数据）

### 5.5 写入优化关键点

- **增大 `refresh_interval`**（从 1s 到 30s）→ 减少 segment 数量 → 写吞吐提升 3x+
- **临时关闭副本**（`number_of_replicas=0`）导入历史数据
- **bulk API**：一次请求批量写（5~15MB / batch）
- **`translog.durability=async`**（每 5s fsync）性能好但可能丢 5s
- **调大 index buffer**（`indices.memory.index_buffer_size=30%`）

---

## §6 · 查询路径（Query then Fetch）

### 6.1 两阶段查询

**Phase 1: Query**
1. Client → Coordinating node
2. Coordinating 广播到所有相关 shard（每个 shard 只查 P 或 R）
3. 各 shard 本地查 → 返回 **from + size 个 doc_id + score**
4. Coordinating 全局排序 → 挑 top K

**Phase 2: Fetch**
5. Coordinating 向持有 top K doc 的 shard 请求文档
6. 返回给 Client

**深度分页的坑**：
- `from=10000 size=10`：每 shard 要返回 10010 个 doc_id → 内存爆炸
- ES 硬限制 `index.max_result_window=10000`
- 深分页用 `search_after` 或 `scroll` 或 PIT（7.10+）

### 6.2 Filter vs Query

- **Filter**：不打分，可缓存（bitset），快
- **Query**：算 BM25 打分，不缓存

**规则**：**不需要打分的条件放 filter**（`term / range / exists`）→ 5~10x 更快。

### 6.3 Query Context vs Filter Context

```json
{
  "query": {
    "bool": {
      "must": [ ...打分... ],
      "filter": [ ...不打分快缓存... ]
    }
  }
}
```

### 6.4 关联性打分（BM25）

**BM25 简式**：
```
score = idf(t) × (tf × (k1+1)) / (tf + k1 × (1 - b + b × |D|/avgdl))
```

- **idf**：`log((N - n_t + 0.5) / (n_t + 0.5))`——罕见词权重高
- **tf**：term 在文档中出现次数
- **b**：文档长度归一化系数（默认 0.75）
- **k1**：tf 饱和（默认 1.2）

---

## §7 · Mapping 与字段类型

### 7.1 字段类型

| 类型 | 用途 |
|---|---|
| `text` | 全文检索，分词，无 DocValues |
| `keyword` | 精确匹配，聚合，排序 |
| `long / integer / short / byte` | 整数 |
| `double / float / half_float / scaled_float` | 浮点 |
| `date` | 时间 |
| `boolean` | 布尔 |
| `binary` | 二进制（base64） |
| `object / nested` | 嵌套对象 |
| `geo_point / geo_shape` | 地理 |
| `ip` | IP 地址（优化） |
| `dense_vector` | 向量（8.x KNN 检索） |

### 7.2 multi-field 模式

```json
"name": {
  "type": "text",
  "fields": {
    "keyword": { "type": "keyword", "ignore_above": 256 }
  }
}
```

- `name` 做全文检索
- `name.keyword` 做精确匹配 / 聚合 / 排序
- **ES 动态映射默认就是这个模式**

### 7.3 动态映射（Dynamic Mapping）

- 首次写入某字段自动推断类型
- **常见坑**：先写 "123"（推断 text），再写数字变成 mapping conflict
- **生产建议**：**关闭动态映射**（`"dynamic": "strict"`），严格定义 mapping

### 7.4 index_options

- `docs`：只索引 doc_id（不能短语查）
- `freqs`：加 tf（用于打分）
- `positions`：**默认**，加位置（短语查）
- `offsets`：加偏移（高亮用）

**关闭不用的**：text 字段如果不做短语查 → `index_options: freqs` 节省 30% 空间。

### 7.5 doc_values

- `keyword / numeric / date` 默认开启
- **text 默认关闭**
- 关闭：`"doc_values": false` 节省磁盘，代价是不能排序/聚合

---

## §8 · Analyzer 分词器

### 8.1 组成

Analyzer = **char_filter → tokenizer → token_filter**

- **char_filter**：字符预处理（HTML 剥离、字符映射）
- **tokenizer**：切词（Standard / IK / whitespace / keyword）
- **token_filter**：token 后处理（lowercase / stop / synonym / stemmer）

### 8.2 常见 Analyzer

- **standard**（默认）：Unicode 分词 + 小写化，英文 OK 中文按字切
- **ik_smart**（中文常用）：粗粒度中文分词
- **ik_max_word**：细粒度分词，索引时用（写多，查全）
- **jieba**：另一款中文分词
- **pinyin**：拼音搜索

### 8.3 索引与查询分词器

- **索引时**：`analyzer: ik_max_word` 细粒度多写
- **查询时**：`search_analyzer: ik_smart` 粗粒度少查
- **通用**：**索引比查询细** → 提高召回

### 8.4 词典与热更新

- IK 支持远程词典（HTTP GET）
- 定时拉取更新，无需重启节点

---

## §9 · DSL：query / filter / aggs

### 9.1 全文查询

```json
{
  "query": {
    "match": {  "content": "程序员" }         // 分词后 OR
  }
}
```

- `match`：分词 OR（可配 `operator: and`）
- `match_phrase`：分词后必须相邻（顺序 + 位置）
- `multi_match`：多字段
- `query_string`：Lucene 语法（支持 AND/OR/NOT）
- `simple_query_string`：简化版

### 9.2 精确查询

- `term`：精确 term 匹配（不分词）
- `terms`：多个精确
- `range`：范围
- `exists`：字段存在
- `prefix`：前缀
- `wildcard`：通配（`*` 慢！）
- `regexp`：正则（更慢！）

### 9.3 组合查询 bool

```json
{
  "bool": {
    "must":     [...],   // AND，打分
    "should":   [...],   // OR，打分（`minimum_should_match`）
    "must_not": [...],   // NOT，不打分
    "filter":   [...]    // AND，不打分，可缓存
  }
}
```

### 9.4 聚合 aggs

**Bucket 聚合**（分桶）：
- `terms`：按字段值分组
- `date_histogram`：时间直方图
- `range`：数值区间
- `histogram`：数值直方图
- `filter / filters`：条件桶

**Metric 聚合**（统计）：
- `sum / avg / min / max / stats / extended_stats`
- `cardinality`：基数估算（HLL，误差 ~0.5%）
- `percentiles`：百分位（TDigest）
- `top_hits`：桶内文档

**Pipeline 聚合**（对其他聚合结果计算）：
- `derivative`：导数
- `moving_avg`：移动平均
- `bucket_selector`：桶过滤

### 9.5 聚合内幕

- **Terms 聚合本质**：DocValues 遍历 → 每个 shard 局部 top-N → 全局归并
- **注意**：Terms 高基数字段（trace_id）会 OOM，`size` 默认 10，`shard_size` 默认 `size*1.5+10`

---

## §10 · 深度分页

### 10.1 三种分页方式

| 方式 | 场景 | 局限 |
|---|---|---|
| `from + size` | 前几页 | `from+size ≤ 10000` |
| `scroll` | 深分页 / 大批量导出 | 消耗 scroll 上下文，不能实时 |
| `search_after` | 深分页 + 实时 | 需要唯一排序字段 |
| PIT（Point In Time，7.10+） | 深分页 + 版本一致 | 类似 scroll 但更轻 |

### 10.2 search_after 示例

```json
// 第一页
{
  "size": 10,
  "sort": [{"ts": "asc"}, {"_id": "asc"}]
}
// 返回最后一条 sort = [1720000000, "abc"]

// 下一页
{
  "size": 10,
  "sort": [{"ts": "asc"}, {"_id": "asc"}],
  "search_after": [1720000000, "abc"]
}
```

### 10.3 scroll 已不推荐

- 保留 scroll 上下文占内存
- 生产用 **PIT + search_after** 替代

---

## §11 · 聚合内幕（Terms Aggregation 深度）

### Terms 聚合的坑

1. **不准确性**：每 shard 只返 top `shard_size` → 归并可能漏
2. **size** 应保守，不宜太大（几千+ 慢）
3. **高基数字段慎用**（trace_id / user_id）
4. **execution_hint: map / global_ordinals**：低基数用 global_ordinals（默认，快），高基数用 map（省内存）

### precision_threshold（cardinality）

- HLL 内存 vs 精度权衡
- 默认 3000，误差 <1%
- 4w 时误差 <1%，40000 是极限

---

## §12 · 段合并（Merge）

### 12.1 段合并策略

- **TieredMergePolicy**（默认）：按大小分层，每层 10 个段合并
- 合并优先小段
- 合并期间 IO + CPU 高

### 12.2 force_merge

- **只对只读索引用**（冷数据）
- `_forcemerge?max_num_segments=1` 合并到 1 段 → 查询更快
- **热索引不要 force merge**（阻塞写入）

### 12.3 冷热架构

- **hot node**：SSD + 高配 CPU/内存，接收新写入
- **warm node**：SATA，只读老数据
- **cold node**：更便宜，只查询极少
- **frozen tier**：搜索时才加载（8.x），基本零成本

### 12.4 ILM（Index Lifecycle Management）

- 自动阶段迁移：hot → warm → cold → delete
- 常用 policy：`10GB` 或 `1 天` roll over → 30 天转 warm → 90 天转 cold → 180 天删除

---

## §13 · 生产实战：日志 / Trace / CMDB 检索

### 13.1 日志检索（ELK/EFK）

- Filebeat/Fluent Bit 采集 → Kafka → Logstash/Fluentd 处理 → ES
- **索引按天 rollover**：`logs-app-2024.06.01`
- **模板**：`_index_template` 统一 mapping / settings
- **ILM**：热 7 天 → 温 30 天 → 冷 90 天 → 删除

**注意**：
- 关闭 `_source` 无法用，一般保留
- 关闭 `_all`（6.x 已废）
- 大字段用 `keyword` + `ignore_above: 256` 避免超长值破坏索引
- **只对需要搜的字段建 text 索引**（其他改为 `index: false`）

### 13.2 Trace/APM 检索

- 每 span 一文档
- 查询模式：`GET by trace_id` + 时间范围
- **routing 用 trace_id**：同 trace 落同 shard → 查询快
- **保留短**（3~7 天），冷数据可归档 S3

### 13.3 CMDB 全文检索

- CI 名称、描述、tag 建 text（IK 分词）
- 精确匹配字段（CI 类型、tenant）用 keyword
- 少量写多量读 → 副本数 2~3

### 13.4 性能优化生产 checklist

1. **JVM 堆 ≤ 31GB**（超过失去指针压缩）
2. **JVM 堆 = 物理内存 50%**（其余给 OS cache）
3. **禁用 swap**：`swapoff -a` + `bootstrap.memory_lock: true`
4. **文件描述符**：`nofile 65536+`
5. **SSD** 优先
6. **合理分片数**（前文经验）
7. **refresh_interval 30s+**（日志场景）
8. **副本数** 0 导入 → 1+ 服务
9. **关闭动态映射**
10. **监控** shard 数、GC 时间、pending tasks、rejected

---

## §14 · 版本演进：ES 6/7/8

| 版本 | 关键变化 |
|---|---|
| 6.x | Rollup、SQL、跨集群搜索 |
| 7.x | 去 type（每个 index 一个 _doc）、集群协调协议改进、search_after 完善 |
| 7.10 | PIT（Point in Time） |
| 8.x | **默认 HTTPS + 用户名密码**、KNN 向量检索、更好的性能 |
| 8.5+ | ES|QL（新查询语言） |

**注意**：8.x 集群升级需重写客户端（Java REST Client → Java API Client）。

---

## §15 · 50 问详解

### 【架构与原理】

**Q1. ES 为什么快？**
> 倒排索引 O(1) 定位 term + 段不可变利用 OS cache + FST 压缩 term dictionary + BM25 快速打分 + 分布式并行。

**Q2. Lucene 和 ES 什么关系？**
> ES 是分布式的 Lucene 服务：Lucene 提供单机全文检索，ES 加上分片、副本、集群协调、REST API、聚合，变成工业级平台。

**Q3. 什么是倒排索引？**
> term → doc_id 列表的映射。相对正排 doc → terms，倒排让"查含某个词的所有文档"变成 O(1) 查找 + 列表求交/并。

**Q4. Segment 为什么不可变？**
> ① 无并发写锁，读性能极佳 ② 利用 OS page cache ③ 支持增量索引 ④ 简化实现。代价：需要 merge 回收删除空间。

**Q5. FST 是什么？**
> Finite State Transducer，term dictionary 的压缩存储结构。相邻 term 前缀共享，压缩率高，支持 O(m) 精确/前缀查询（m = term 长度）。

### 【集群与节点】

**Q6. ES 有哪些节点角色？**
> master-eligible（元数据）/ data（存数据）/ coordinating（路由聚合）/ ingest（前置处理）/ ml/transform（8.x）。生产建议专职 master 3 台。

**Q7. 什么是脑裂？如何避免？**
> 集群网络分区导致两组各自选出 master。ES 6.x 及以下配置 `discovery.zen.minimum_master_nodes = (N/2)+1`。7.x 起自动管理。

**Q8. Coordinating node 的作用？**
> 接收 client 请求，路由到 data node，聚合结果返回。所有节点默认都是 coordinating，但生产可以独立部署 coordinating only 节点分担查询流量。

**Q9. Cluster state 是什么？**
> Master 维护的集群元数据：index 元数据、shard 分配、node 列表、mapping、settings。变更通过两阶段协议同步。

**Q10. 集群健康 green/yellow/red 分别是什么？**
> green：所有主副本可用；yellow：所有主可用但有副本未分配；red：有主分片不可用。

### 【分片与副本】

**Q11. 分片数怎么选？**
> 单分片 10~50GB。经验：主分片数 ≈ 集群节点数 × 1.5。单节点分片数 < 20 × 堆内存(GB)。

**Q12. 主分片数创建后能改吗？**
> **不能直接改**。需要 reindex 到新索引，或用 shrink（缩小）/ split（切分）API（有限制）。所以创建前要规划好。

**Q13. 副本数能改吗？**
> **能**，动态修改 `number_of_replicas`。副本数越多读扩展越好，但写成本翻倍。

**Q14. 分片路由算法？**
> `shard = hash(routing || _id) % primary_count`。routing 默认 _id。指定 routing 可让相关文档同 shard 便于查询。

**Q15. 分片迁移会阻塞写入吗？**
> 不会。ES 边写边迁移。但迁移消耗网络/IO 会影响查询性能。生产在低峰迁移。

### 【写入路径】

**Q16. ES 写入流程？**
> Client → 主 shard → in-memory buffer + translog（磁盘 WAL） → 同步副本 → 返回。每 1s refresh 生成新 segment 可查。每 30 分钟 flush 落盘 segment 清空 translog。

**Q17. Refresh 和 Flush 区别？**
> Refresh：buffer 转 segment 到 OS cache（1s，NRT）；Flush：segment fsync 到磁盘 + 清空 translog（30 分钟或 translog 满）。

**Q18. Translog 的作用？**
> WAL 保证已写入 buffer 但未 flush 的数据崩溃可恢复。默认每次 index/update 请求都 fsync（`translog.durability=request`）。

**Q19. Bulk API 的最佳 batch size？**
> 5~15MB 一批。太小效率低，太大 GC 抖动。压测确定。

**Q20. 大批量写入怎么优化？**
> ① 副本数临时设 0 ② refresh_interval=-1（关闭 refresh）③ 大 bulk batch ④ 多线程 ⑤ 完成后恢复配置 + force merge。

### 【查询路径】

**Q21. Query then Fetch 两阶段是什么？**
> Phase1 Query：广播到所有 shard，各返回 top K doc_id + score；Phase2 Fetch：coordinating 全局 top K 后向持有节点取完整文档。

**Q22. 深分页为什么慢？**
> `from=10000 size=10` 要每 shard 返回 10010 个 doc_id，coordinating 内存爆炸。ES 硬限制 `max_result_window=10000`。

**Q23. search_after / scroll / PIT 区别？**
> scroll：保留快照上下文，占内存；search_after：基于上一页最后一条排序值，实时；PIT（7.10+）：类似 scroll 但更轻 + 支持一致性快照 + search_after 组合。**生产用 PIT + search_after**。

**Q24. Filter 和 Query context 区别？**
> Filter 不打分可缓存（bitset），5~10x 快；Query 算 BM25 打分不缓存。**不需要打分的条件放 filter**。

**Q25. term 和 match 区别？**
> term 精确匹配不分词；match 分词后 OR/AND。**text 字段查 term 通常查不到**（term 是分词后的，match 会走 analyzer）。keyword 用 term。

### 【Mapping 与分词】

**Q26. text 和 keyword 区别？**
> text 分词全文检索无 DocValues；keyword 不分词精确匹配可排序聚合。生产常用 multi-field：`name: text` + `name.keyword: keyword`。

**Q27. 动态映射的坑？**
> 首次写入自动推断类型 → 后续冲突。生产建议 `"dynamic": "strict"` 严格 mapping。

**Q28. mapping conflict 怎么处理？**
> 字段类型不能改。要么忽略字段（strict / index=false），要么 reindex 到新 mapping 的索引。

**Q29. IK 分词 ik_smart 和 ik_max_word 区别？**
> smart 粗粒度分词（少词），max_word 细粒度（多词）。**索引用 max_word 查询用 smart** 提高召回率。

**Q30. 中文数字混合场景怎么分词？**
> IK 支持自定义词典（本地 + 远程 HTTP），添加业务词汇。remote_ext_dict 支持热更新。

### 【聚合】

**Q31. Terms 聚合会漏数据吗？**
> 会。每 shard 只返回 top `shard_size` 个，归并可能漏低频。可以调大 shard_size 或用 `size: 0 + composite aggregation` 分页遍历。

**Q32. cardinality 聚合准确吗？**
> 不准确，用 HLL 估算，默认 precision_threshold=3000 误差 <1%。最大 40000。**要精确只能 terms + count**（贵）。

**Q33. date_histogram 是什么？**
> 按时间粒度分桶（minute / hour / day）。生产用 `fixed_interval` 代替 `interval`（后者已弃用）。

**Q34. 聚合会加载 fielddata 吗？**
> 5.x 后 keyword/numeric/date 默认 doc_values（磁盘 mmap）不占堆。**text 聚合需开启 fielddata 会占堆**，不推荐。

**Q35. Pipeline 聚合是什么？**
> 对其他聚合结果计算：`derivative`（导数）/ `moving_avg`（移动平均）/ `bucket_selector`（桶过滤）等。SQL 中的窗口函数。

### 【段与合并】

**Q36. Segment 越多查询越慢吗？**
> 是。每 shard 每次查询要遍历所有 segment。段合并减少段数。

**Q37. force_merge 什么时候用？**
> **只对只读索引**（冷数据）。合并到 1 段减少查询开销。**热索引绝对不要 force merge**（阻塞写）。

**Q38. TieredMergePolicy 怎么工作？**
> 按段大小分层，每层最多 10 个段，每层达到阈值触发合并到上层。合并优先小段。

**Q39. 段合并对写性能影响？**
> 大 merge 消耗 IO + CPU 可能影响写入吞吐。`indices.store.throttle.max_bytes_per_sec` 限速。

**Q40. 删除文档是什么行为？**
> 只标记 `_deleted`（不物理删），下次段合并时物理清除。所以磁盘不会立即回收。

### 【性能优化】

**Q41. JVM 堆为什么要 ≤31GB？**
> 超过 31GB 失去指针压缩（compressed oops），指针从 4 字节变 8 字节，内存效率降低。**堆 31GB + 物理内存 64GB+** 是黄金配置。

**Q42. mlockall 是什么？为什么要开？**
> 锁定 JVM 内存不被 swap。swap 会导致 GC 暂停几秒到几十秒。生产必须 `bootstrap.memory_lock: true` + OS `swappiness=0`。

**Q43. GC 时间怎么监控？**
> `_nodes/stats/jvm` 查 gc.collectors.young/old。young < 300ms、old < 1s 健康。频繁 old GC 是内存不足或 fielddata 过大。

**Q44. Circuit Breaker 是什么？**
> 熔断器保护 OOM：parent（总）、fielddata、request、in_flight_requests。触发时返回 `circuit_breaking_exception`。

**Q45. Rejected task 是什么？**
> 线程池队列满被拒绝。检查 `_cat/thread_pool` 的 write/search rejected。写入 rejected 说明写入太快，查询 rejected 说明查询太重或慢。

### 【故障与运维】

**Q46. Shard unassigned 怎么排查？**
> `GET _cluster/allocation/explain` 看原因。常见：磁盘满（85%/90%/95% 阈值）、节点掉线、副本分配冲突（同 P/R 不能同节点）。

**Q47. 集群一直 relocating 怎么办？**
> 等自然完成，或 `cluster.routing.allocation.enable` 暂停 rebalance。检查网络和磁盘 IO。

**Q48. 索引突然写不进去怎么办？**
> 检查：① 磁盘满 ② mapping conflict ③ circuit breaker 触发 ④ readonly（磁盘 95% 会自动只读）⑤ rejected（写线程池满）。

**Q49. 集群升级怎么做？**
> **滚动升级**：一个个节点重启（先关分片分配再升级再开）。跨大版本（6→8）不支持直接滚动升级，要 reindex。

**Q50. 备份怎么做？**
> Snapshot 到 S3/HDFS/NFS。`PUT _snapshot/repo` 注册仓库，`PUT _snapshot/repo/snap1` 创建。增量快照只备份新 segment。

### 【选型对比】

**Q51. ES vs ClickHouse 日志场景？**
> ES 全文检索灵活但存储成本高（压缩 3~5x），CK 列式压缩 10~30x 便宜。近年 CK 抢了 ES 大量日志市场。**ES 强在自由检索，CK 强在结构化聚合**。

**Q52. ES vs MySQL 全文检索？**
> MySQL 全文索引弱，只适合小规模。ES 分布式、灵活、生态好。业务表落 MySQL，检索建 ES 副本（Canal 同步）。

**Q53. ES vs Solr？**
> 都基于 Lucene。ES 分布式和 REST API 更现代，生态更丰富，云原生集成好。**新项目直接选 ES**。

**Q54. ES 8.x 的向量检索能做 RAG 吗？**
> 可以。`dense_vector` 字段 + `knn` 查询。相比专用向量库（Milvus/Weaviate）性能稍逊但复用 ELK 栈方便。**中小规模够用**。

### 【补充深度】

**Q55. Nested vs Flatten vs Parent-Child？**
> nested：内嵌对象保持独立性（`nested query`）；flatten：一个字段存 JSON 不分析；parent-child：跨文档关联，慢。**优先 flatten，其次 nested，尽量避免 parent-child**。

---

## §16 · 短板与坑

1. **JVM GC 抖动**：内存足 + 合理堆大小 + 关闭 swap
2. **写入放大**：段合并磁盘/CPU 消耗大
3. **深分页崩溃**：`from + size > 10000` 挂
4. **动态映射灾难**：类型冲突不可修复只能 reindex
5. **高基数 terms 聚合 OOM**
6. **cardinality 是估算**
7. **text 字段无法排序聚合**（要 multi-field keyword）
8. **主分片数不可改**
9. **主从异步（弱一致）**：写副本失败不影响主
10. **无事务无关联**：数据模型要"扁平化"设计

---

## §17 · 面试话术模板

### 3 分钟自述

> "我在 TCUM 里 ES 用于日志检索、Trace 检索、CMDB 全文搜索。集群规模日增 TB 级，索引按天 rollover，热温冷架构 + ILM 自动过期。
>
> **对 ES 最深三点理解**：
> - **Lucene 内核决定一切**：倒排索引 + 段不可变 + FST 压缩 term dictionary 是快的核心。段不可变让读性能极佳但需要 merge 回收删除空间。
> - **准实时的代价**：refresh 每秒生成新段虽然让写入 1s 后可查，但 segment 泛滥会拖慢查询。生产上日志场景我们把 refresh 拉到 30s，写吞吐提升 3x。
> - **JVM 是双刃剑**：堆 ≤31GB 才有指针压缩，mlockall 防 swap，物理内存 50% 给 OS cache。GC 抖动 = 请求毛刺。
>
> **生产血泪**：mapping conflict reindex 半天、深分页崩系统、cardinality 估算被追责、terms 聚合 OOM——每一个都是设计和使用的教训。"

### 反问 5 问

1. ES 版本？8.x 了吗？向量检索用了吗？
2. 集群规模、主分片数、副本数？
3. ILM 策略？冷热架构分几层？
4. 深分页方案用 scroll 还是 PIT+search_after？
5. 日志场景用 ES 还是切 ClickHouse 了？

---

**本篇完 · 约 27KB · 覆盖 Lucene/倒排索引/集群/分片/读写路径/mapping/聚合/优化/55 问**

**证据基线**：
- ES 官方文档：https://www.elastic.co/guide/
- Elastic 技术博客深度文章（Lucene internals）
- 生产实战：TCUM 日志 EFK、Trace 检索、CMDB 全文
- 阿里 / 字节生产 ES 集群规模：单集群百 TB 到 PB
