# 第五卷 · 中间件 · ClickHouse 专项

> **本篇定位**：ClickHouse 是 TCUM 监控体系里承担**高基数 Trace/APM 明细存储 + SLO 分钟级预聚合 + 日志大宽表**的核心 OLAP 引擎。相对 VM 的时序场景（低基数 metric），CK 的场景是**"高基数、明细可下钻、SQL 灵活查询"**。本文覆盖 MergeTree 家族、列式存储、稀疏索引、分区、副本、分片、物化视图、投影、执行引擎、慢查询、生产实战、50+ 高频面试题。

## 📖 目录
- §1 命题：ClickHouse 为什么这么快
- §2 列式存储 vs 行式存储
- §3 MergeTree 家族与写入流程
- §4 主键与稀疏索引（primary.idx）
- §5 分区（PARTITION BY）
- §6 数据类型与压缩
- §7 副本 ReplicatedMergeTree + Zookeeper/Keeper
- §8 分片 Distributed 表
- §9 物化视图（Materialized View） 与 Projection
- §10 常用表引擎：Replacing / Summing / Aggregating / Collapsing
- §11 执行引擎与向量化
- §12 慢查询与优化
- §13 生产实战：SLO 预聚合 + Trace 明细 + 高基数时序
- §13.5 **完整例子：CVM CPU 使用率监控的端到端流程**（建表 → 写入 → MV → 查询）
- §14 版本演进与新特性
- §15 50 问详解
- §16 短板与坑
- §17 面试话术模板

---

## §1 · 命题：ClickHouse 为什么这么快

### 一句话背诵

> "ClickHouse 快的本质是**列式存储 + 向量化执行 + 稀疏主键索引 + LSM 风格 MergeTree**。列式让 SIMD 生效、只读需要的列；向量化把每次操作放大到 batch；稀疏索引让 PK 上的范围扫描不用查每行；MergeTree 保证写入吞吐几十万行/秒。"

### 五大加速来源

1. **列式存储**：每列独立文件，扫描一列不 IO 其他列；同列数据类型一致 → **压缩比 10~30x**（比行式高一个量级）
2. **向量化执行**：一次处理 8192 行（block）→ SIMD 指令并行 → CPU cache 友好
3. **稀疏主键索引**：不是每行一个索引项，而是每 `index_granularity=8192` 行一个 → **索引极小可放内存**
4. **MergeTree**：LSM 风格，写入只 append 生成新 part，后台异步合并 → 写吞吐几十万行/秒
5. **多核并行 + 分布式**：单查询自动并行到所有 CPU，Distributed 表跨机器并行

### 边界代价（重要）

- **不适合高频点更新/删除**：MergeTree 是 append-only，Update/Delete 是重写整个 part
- **不适合高并发点查**：设计给分析场景，单查询占大量 CPU/内存
- **弱事务**：只有 part 级别原子性，无 ACID
- **JOIN 弱**：hash join 内存放不下就 GG（8.0 起 grace hash 改善）
- **实时性有限**：物化视图是插入时触发（Push），不是查询时（Pull）

---

## §2 · 列式存储 vs 行式存储

### 行式（MySQL InnoDB）

```
[row1: id=1, name='a', age=20]
[row2: id=2, name='b', age=21]
```

**适合**：点查（`WHERE id=1` 一次 IO 拿到整行）、事务写。

### 列式（ClickHouse）

```
id 文件:   [1, 2, 3, ...]
name 文件: ['a','b','c',...]
age 文件:  [20, 21, 22,...]
```

**适合**：
- **聚合查询**：`SUM(amount) WHERE date > x` 只读 amount + date 两列，其他列不 IO
- **高压缩**：同列类型一致，相邻值相关（时间戳、枚举）压缩比极高
- **向量化**：连续内存 → SIMD 并行

**列式存储三大关键优化**：
- **相同类型连续存储** → 压缩率高（LZ4/ZSTD/Delta）
- **列独立 IO** → 只读需要的列
- **CPU cache friendly** → 一次加载 batch 到 L1/L2

### 面试深度点

> "行式和列式的选择本质是 **workload 决定存储布局**：OLTP 单行操作多用行式，OLAP 大范围聚合用列式。ClickHouse 甚至没有 primary key 唯一约束——它不关心 PK 唯一性，只关心 PK 用来排序和跳数。"

---

## §3 · MergeTree 家族与写入流程

### 3.1 MergeTree 是什么

- CK 最核心的**表引擎家族**，不是单独的写入组件；它决定数据如何存储、排序、索引、合并，以及如何处理更新/删除
- **MergeTree 本质上是面向 OLAP 的列式存储表引擎**：写入时将数据批次落盘为不可变的 part，后台异步合并 part，以兼顾高写入吞吐和查询性能
- 其写入模型类似 **LSM-Tree**，但不是传统 KV 存储中的完整 LSM 实现；MergeTree 还结合了分区、排序键、稀疏主键索引和列式压缩
- 单表可承载几亿到万亿行，集群规模可达 PB 级数据

### 3.2 建表基本语法

```sql
-- 例如 TCUM 的 Trace/APM 明细表：同一个服务会产生大量 span，查询通常是“按服务查一段时间内的请求”，偶尔再按 trace_id 下钻
CREATE TABLE tcum_spans (
    ts DateTime64(3),
    trace_id UUID,
    span_id UUID,
    service LowCardinality(String),
    pod LowCardinality(String),
    operation String,
    duration UInt32,
    status UInt8,
    tags Map(String, String)
) ENGINE = ReplicatedMergeTree(...)
PARTITION BY toYYYYMMDD(ts)       -- 按天分区，便于按日期裁剪和 DROP PARTITION 清理 30 天前数据
ORDER BY (service, ts, trace_id)   -- 常见查询先按服务、时间过滤；trace_id 仅作为同一服务时间范围内的辅助排序
TTL ts + INTERVAL 30 DAY DELETE
SETTINGS index_granularity = 8192;

-- 典型查询：
-- SELECT trace_id, span_id, duration
-- FROM tcum_spans
-- WHERE service = 'order-service'
--   AND ts >= '2024-06-01 10:00:00'
--   AND ts <  '2024-06-01 11:00:00';

-- 这个查询会先裁剪到 20240601 分区，再利用 (service, ts) 的排序和稀疏索引，
-- 尽量跳过其他服务及时间范围之外的 granule。

-- PARTITION BY 不一定是时间分区。分区键本质上是“物理数据管理和查询裁剪”的维度，
-- 可以按租户、业务类型或数据生命周期分区，例如：
-- PARTITION BY tenant_id
-- PARTITION BY (tenant_id, toYYYYMM(ts))
-- 但监控明细通常优先按天/月分区，因为数据天然按时间写入、查询和过期清理也主要按时间进行。
-- 不建议直接按 trace_id、metric 或 pod 分区，这些字段基数高，容易产生大量小分区和小 part。
-- 一般要求分区数量可控；高基数字段更适合放在 ORDER BY、分片键或跳数索引中，而不是 PARTITION BY。
```

### 3.3 写入流程

1. Client 将一批 rows 发送给 Server；Server 先把它们组织为内存中的 **Block**（列式数据块），做类型转换、默认值计算、约束/分区键/排序键计算与按分区拆分。
2. 对普通 `MergeTree` 同步 `INSERT`，**没有一个通用、可持久化的 memtable 阶段**：处理完成的 Block 会按 `PARTITION BY` 的值拆成若干组；每个命中的 partition 通常写出一个初始 part（复杂写入、Block 切分或分布式写入时也可能是多个）。随后每组数据按 `ORDER BY` 排序、压缩并写成新的临时 part，写完校验后原子 rename 成可见的 **part 目录**，例如 `data/db/table/202401_1_1_0/`。因此，一次 INSERT 若只命中一个 partition，最开始通常得到一个 part；若同时含 6 月 1 日和 6 月 2 日的数据，则会在两个 partition 各产生初始 part。它们从诞生时就是完整的列式 part，不必等后台 merge 后才“变完整”。
3. **part 内**每列一个文件：`.bin`（压缩列数据）+ `.mrk2`（marks，定位到数据块的偏移）+ `primary.idx`（主键稀疏索引）；同时还有 checksums、columns、partition/minmax 等元数据文件。
4. `INSERT` 返回成功通常表示 part 已落到本地磁盘；`ReplicatedMergeTree` 还会通过 ClickHouse Keeper 协调副本复制。它不等同于“后台 merge 已完成”，也不必然等同于所有副本都已经就绪，具体确认语义取决于副本/写入 quorum 配置。
5. 后台合并线程按策略合并小 part → 大 part；TTL、mutation 和部分 delete 操作也会在后续后台处理时重写或清理 part。

**`memtable` 是什么，为什么这里不能直接这么写？**

`memtable` 通常指 LSM-Tree 存储（如 RocksDB、LevelDB）中的**可变内存写缓冲区**：写请求先写 WAL 和 memtable，memtable 满了再 flush 成磁盘上的不可变 SSTable。它的核心作用是把随机小写转成顺序批量落盘。

MergeTree 也有“内存中先聚合一批数据、随后生成不可变磁盘文件”的相似外观，但常规同步 `INSERT` 的内存对象是一次请求处理过程中的 Block，不是独立、持续存在、等待阈值刷盘的 memtable。把两者混称会让人误以为 ClickHouse 的普通写入一定先落一层可恢复的内存表，这是不准确的。

以下场景才可能看到真正意义上的**内存缓冲 / 延迟落盘**，但它们不是普通 MergeTree `INSERT` 的默认路径：

- **async insert**：服务端按异步写入配置在内存中积攒小批请求，满足时间或大小条件后再组成 Block、写 part；若未开启 wait，客户端先拿到的是“已接收进队列”，而不是“part 已落盘”的确认。
- **`Buffer` 表引擎**：先写入内存 Buffer，再按阈值 flush 到目标 MergeTree 表；进程故障时，尚未 flush 的内存数据有丢失风险。
- **Kafka / 流式表引擎与 Materialized View**：消息先在消费/处理链路中暂存，最终仍由目标 MergeTree 表写 part；其可靠性还取决于 offset 提交与下游写入的协调。

**part 命名规则**：`{分区}_{最小块号}_{最大块号}_{level}`

**建议**：**batch 写入**（1000~10w 行一批），避免小 part 泛滥（会触发 `too many parts` 错误）。

### 3.3.1 `partition`、`part`、`granule` 的层级关系

这里的 `granul` 通常应写作 **granule（索引粒度）**。三者不是同一层概念，最容易混淆的是把 `PARTITION BY`、磁盘 part 和主键索引粒度都理解为“分块”。可以先记住：

```text
表（MergeTree）
└── partition：按 PARTITION BY 的值划出的逻辑/管理边界
    ├── part：一次或多次 INSERT 实际落下的不可变物理数据单元
    │   ├── granule 0：约 index_granularity 行，拥有一条 primary-key mark
    │   ├── granule 1：约 index_granularity 行，拥有一条 primary-key mark
    │   ├── ...
    │   └── granule N
    ├── part
    └── part
```

| 概念 | 由什么决定 | 它是什么 | 主要解决的问题 | 生命周期 / 操作 |
|---|---|---|---|---|
| **Partition（分区）** | `PARTITION BY` 表达式的结果，如 `toYYYYMMDD(ts)=20240601` | 数据管理的逻辑边界；一个分区下可以有很多 part | 按日期/租户做分区裁剪、TTL、`DROP PARTITION`、副本与合并隔离 | 通常按天或月长期存在；`DROP PARTITION` 可快速删除整个分区 |
| **Part（数据片段）** | 每批写入在每个分区产生一个或多个 part；后台 merge 继续合并 | 磁盘上的不可变物理文件集合 / 目录，含所有列文件、marks、主键索引、校验与元数据 | 高吞吐批量写、后台异步合并、并发读取与副本复制 | 新写入产生小 part；只在**同一 partition 内**合并成较大 part；mutation/TTL 可能重写 part |
| **Granule（索引粒度）** | `index_granularity`（默认通常为 8192 行）及 `index_granularity_bytes` | 一个 part 内的一段连续排序行；不是目录、不是独立文件 | 稀疏主键索引跳读的最小逻辑单位 | 随 part 写入或 merge 重建；查询命中后通常按 granule 读取 |

以本表为例：

```sql
PARTITION BY toYYYYMMDD(ts)
ORDER BY (service, ts, trace_id)
SETTINGS index_granularity = 8192
```

假设 2024-06-01 这一天写入了 1 亿行 Trace：

```text
partition = 20240601
├── part 20240601_1_1_0       ← 上午第一次批量写入
├── part 20240601_2_2_0       ← 上午第二次批量写入
├── ...                       ← 期间不断产生小 part
└── part 20240601_1_100_3     ← 后台 merge 后的大 part
    ├── 约 8,192 行 = granule 0
    ├── 约 8,192 行 = granule 1
    └── ...
```

这个例子中的 `20240601` 是 partition；`20240601_1_100_3` 是某个 part；该 part 内按 `(service, ts, trace_id)` 排序后的每约 8192 行，是一个 granule。一个很小的 part 也可能只有一个 granule；一个大 part 通常有大量 granules。

查询时三层各做一件不同的事：

```text
WHERE ts 在 2024-06-01
  → partition pruning：先只选中 20240601 分区
WHERE service='order-service' AND ts 在一小时内
  → primary-key sparse index：在每个候选 part 的 marks 中定位并跳过不可能命中的 granules
命中的 granules
  → 从列文件读取所需列，解压、过滤，返回实际匹配行
```

因此 `ORDER BY` 影响的是**同一个 part 内**相邻行如何排列，以及主键索引能否有效跳过 granules；`PARTITION BY` 影响的是更粗粒度的分区裁剪、合并边界和数据生命周期管理。不能用高基数 `trace_id` 做 partition 来追求点查：那会产生海量 partition/part；应让它作为排序键的后缀、跳数索引或其他查询优化的一部分。

还要注意“约 8192 行”不是绝对保证。启用 `index_granularity_bytes` 后，宽行可能在达到 8192 行前就切分；而列压缩块与 mark 的实际读取也可能让 ClickHouse 多读附近少量数据再过滤。因此 granule 是**跳读粒度**，不是“查询结果恰好只读取 8192 行”的硬边界。

`partition` 是**一张 MergeTree 表内部**按 `PARTITION BY` 表达式计算出来的逻辑数据集合，不是一张独立表，也不是一列一个 partition。更完整的层级可写成：

```text
数据库
└── 表（例如 cvm_metric_1m）
    └── partition（例如 20240601，由 PARTITION BY toYYYYMMDD(ts) 得到）
        └── part（一次 INSERT 或后台 merge 形成的物理文件集合）
            └── granule（part 内的稀疏索引 / 读取粒度）
```

例如：

```sql
CREATE TABLE cvm_metric_1m (...) ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (instance_id, metric, ts);
```

那么 `ts = '2024-06-01 10:01:00'` 的 CPU 样本属于**表 `cvm_metric_1m` 内**的 partition `20240601`。`cvm_metric_1m` 和 `cvm_metric_5m` 则是两张独立的表；它们各自再拥有自己的 partition。集群的 shard 也不是 partition：同一张逻辑表会分布在多个 shard 的 local 表上，而每个 local 表内部仍会按同一条 `PARTITION BY` 规则产生 partition。

这个层级也直接决定了迟到数据的写法：它不会原地修改旧 part 或旧 granule。MergeTree 的基本写入模型是**追加新 part，之后后台合并**。

假设今天收到一条迟到样本，业务时间为 `ts = '2024-06-01 10:01:00'`，而表按天分区：

1. ClickHouse 先计算分区键，得到目标 partition `20240601`。
2. 它在这个旧 partition 下为这次 INSERT 写出一个**新的 part**；该新 part 内的各列文件、marks 与 granule 都是新建的。
3. 原本已经存在的 part 不会被打开后“在中间插入一行”，其中的 granule 也不会被就地改写。
4. 后台 merge 在合适时机把新 part 与同一 partition 内的其他 part 读取、排序、重写为一个更大的新 part；合并成功后旧输入 part 被替换。

```text
partition = 20240601

原有状态：
  20240601_1_100_2       ← 旧 part，保持不变

迟到数据写入后：
  20240601_1_100_2       ← 旧 part，不原地修改
  20240601_101_101_0     ← 迟到数据新建的 part

后台 merge 完成后（示意）：
  20240601_1_101_3       ← 由两个输入 part 重写出的新 part
```

这就是历史回灌、补数或迟到数据常见的性能风险：如果每次只补几行且分散在许多旧日期，就会在许多历史 partition 中制造小 part，增加 merge、元数据和副本同步压力。通常应该按目标分区和时间窗口攒成批量再写；是否接受过期数据、是否转入冷存储或丢弃，则应由业务迟到窗口和数据正确性要求决定。

还要把“按分区管理行”和“列式存储”分开理解。partition 是对**行**按分区键分组；一行里的 `ts`、`instance_id`、`metric`、`value` 等所有列，作为同一行一起归入同一个 partition。列式存储发生在这个 partition 内的 **part** 层。

例如插入：

```text
(ts = 2024-06-01 10:01:00,
 instance_id = ins-1,
 metric = cpu_usage,
 value = 73.2)
```

如果 `PARTITION BY toYYYYMMDD(ts)`，这一整行属于 `20240601`。当这批数据形成 part `20240601_42_42_0` 后，part 内通常会为每个实际数据列分别保存压缩数据和 marks：

```text
partition 20240601
└── part 20240601_42_42_0
    ├── ts.bin / ts.mrk2
    ├── instance_id.bin / instance_id.mrk2
    ├── metric.bin / metric.mrk2
    ├── value.bin / value.mrk2
    ├── primary.idx
    └── columns.txt、checksums.txt、partition/minmax 等元数据
```

也就是说：**partition 按行管理，part 是一批行的物理容器，part 内按列保存数据文件。**虽然 `ts`、`value` 各有列文件，但它们的第 0 个、第 1 个 mark 对应的是同一批排序行的 granule 边界；不是 `ts` 列有自己的一套 partition、`value` 列又有另一套完全独立的行分组。

part 中除列数据外还带有索引和管理元数据。仍以 part 内的 `value` 列为例：

```text
value.bin
┌──────────────────────────────────────────────────────┐
│ 编码、压缩后的 value 列真实数据                         │
│ 压缩块 A：覆盖起始若干行                                │
│ 压缩块 B：覆盖后续若干行                                │
│ ...                                                     │
└──────────────────────────────────────────────────────┘

value.mrk2
┌──────────────────────────────────────────────────────┐
│ mark 0：granule 0 在 value.bin 中从哪里开始读取         │
│ mark 1：granule 1 在 value.bin 中从哪里开始读取         │
│ mark 2：granule 2 在 value.bin 中从哪里开始读取         │
│ ...                                                     │
└──────────────────────────────────────────────────────┘
```

- **`<column>.bin`**：该列实际的编码、压缩后的数据本体。没有 `.bin` 就读不到列值。它的压缩块边界不要求和 granule 一一对应，一个压缩块可能覆盖多个 granule。
- **`<column>.mrk2`**：该列的 marks，近似可理解为“按 granule 建的跳转目录”。每条 mark 记录相应 granule 的读取定位信息，包括压缩文件中的块偏移，以及在解压后块内的偏移。已经确定要读第 237 个 granule 时，ClickHouse 无须从 `.bin` 开头顺序解压，而是先查 `value.mrk2` 的第 237 条 mark，再跳到正确位置读取。
- **`primary.idx`**：不是数据文件的位置目录，而是**排序键的稀疏主键索引**。它按 granule 保存排序键值（或其对应 mark），用于先判断“这个 granule 有没有可能满足 `WHERE` 中与 `ORDER BY` 前缀匹配的条件”。

二者的职责应明确区分：

```text
primary.idx
  → 哪些 granule 可能命中 WHERE 条件？（筛选 / 跳过）

xxx.mrk2
  → 已决定读某个 granule 后，该列在 xxx.bin 的哪里？（定位）

xxx.bin
  → 跳过去之后，真正要解压和读取的列值是什么？（数据本体）
```

例如：

```sql
SELECT value
FROM cvm_metric_1m
WHERE instance_id = 'ins-abc'
  AND ts >= '2024-06-01 10:00:00'
  AND ts <  '2024-06-01 11:00:00';
```

在排序键能够帮助过滤的前提下，执行顺序近似为：先通过 partition pruning 选定 `20240601`；再借助 `primary.idx` 排除不可能包含目标实例/时间范围的 granule；对少数候选 granule，读取过滤列对应的 `.mrk2` 和 `.bin` 做精确判断；最后读取结果列 `value` 对应的 `.mrk2`、`.bin`。实际执行中 ClickHouse 可能因压缩块、PREWHERE、索引类型和读放大而额外读取附近少量数据，但不会因为只 SELECT 了 `value` 就顺序扫描所有列和所有 part。

#### 用 CVM CPU 监控的一条数据把三层落到实处

下面不是 TCUM 线上表的反向还原，而是一张典型的“CVM 每分钟 CPU 指标明细表”设计，用来说明三者在**存储时**分别是什么：

```sql
CREATE TABLE cvm_metric_1m (
    ts DateTime,
    tenant_id UInt64,
    region LowCardinality(String),
    instance_id String,
    metric LowCardinality(String),       -- 如 cpu_usage
    value Float64,
    labels Map(String, String)
) ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (tenant_id, region, instance_id, metric, ts)
SETTINGS index_granularity = 8192;
```

假设监控系统在 `2024-06-01 10:01:00` 收到一条样本：

```text
tenant_id  = 10001
region     = ap-guangzhou
instance_id= ins-abc123
metric     = cpu_usage
ts         = 2024-06-01 10:01:00
value      = 73.4
```

这条样本在三个层级上的归属是：

| 层级 | 对这条 `ins-abc123 / cpu_usage / 10:01` 样本而言是什么 | 它不是什么 |
|---|---|---|
| **Partition** | `toYYYYMMDD(ts) = 20240601`，即 `2024-06-01` 当天的分区。当天写入的所有租户、地域、CVM、CPU/内存/磁盘等指标都可能在这个分区中。 | 不是一台 CVM 的专属分区，也不是一个 metric 的专属文件。 |
| **Part** | 该样本所在的某个物理数据 part，例如写入器在 10:00~10:01 攒批后，为 `20240601` 产生的 `20240601_42_42_0`；该 part 可能同时包含数千或数百万条、来自许多 CVM 和多种指标的样本。后续它会与同一天其他 part merge。 | 不是“一条指标一个 part”，也不等于一个分区。part 名中的块号是内部写入块范围，不能拿它推断具体时间。 |
| **Granule** | 在该 part 内，按 `(tenant_id, region, instance_id, metric, ts)` 排完序后，该行落入的某段连续行，例如第 237 个 granule。该 granule 通常约 8192 行，常会覆盖 `ins-abc123/cpu_usage` 的一段时间，也可能在边界处包含相邻实例或相邻 metric 的行。 | 不是一个目录、不是单独一台机器、也不是严格的一条完整时间序列。 |

可以把真实落盘结果想成：

```text
cvm_metric_1m
└── partition 20240601                         ← 由 ts 决定
    ├── part 20240601_42_42_0                  ← 这一批 INSERT 在当天落下的物理片段
    │   ├── granule 0: 排序后的第 0 ~ 8191 行
    │   ├── ...
    │   └── granule 237: 其中包含 ins-abc123 的 cpu_usage@10:01 这一行
    ├── part 20240601_43_43_0
    └── 后台 merge 后的更大 part
```

当用户查询：

```sql
SELECT ts, value
FROM cvm_metric_1m
WHERE tenant_id = 10001
  AND region = 'ap-guangzhou'
  AND instance_id = 'ins-abc123'
  AND metric = 'cpu_usage'
  AND ts >= '2024-06-01 10:00:00'
  AND ts <  '2024-06-01 11:00:00';
```

ClickHouse 的工作顺序是：先由 `ts` 裁剪到 `20240601` 这个 partition；再在该分区各 part 的 `primary.idx` 中，根据排序键前缀 `(tenant_id, region, instance_id, metric, ts)` 跳过绝大多数不属于该实例/指标/时间范围的 granule；最后只读取命中 granule 内 `ts` 和 `value` 两列的相关数据块，再做精确过滤。

这也是为什么此例把 `tenant_id、region、instance_id、metric` 放在 `ts` 前面：目标查询是“**某台 CVM 的某个指标在一个时间范围内的曲线**”。如果主要查询改为“全租户某一指标在一段时间内的聚合”，排序键就应相应改为更匹配该访问模式的顺序，而不能机械照抄这一种写法。

### 3.4 后台合并

- **策略**：优先合并小的、时间相近的 part
- **限制**：单次 merge 不超过 `max_bytes_to_merge_at_max_space_in_pool`（150GB）
- **代价**：磁盘 IO + CPU 压缩解压
- **手动**：`OPTIMIZE TABLE t FINAL`（不建议生产用，代价大）

### 3.5 mutation（异步 update/delete）

```sql
ALTER TABLE t DELETE WHERE ts < '2024-01-01';  -- 后台异步
ALTER TABLE t UPDATE value = 0 WHERE metric = 'x';
```

- **不是原子操作**：只是标记，后台重写 part
- **代价高**：几分钟到几小时
- **生产建议**：**不要频繁 update/delete**；改用 ReplacingMergeTree 或 CollapsingMergeTree

**新语法**：CK 23.3+ 支持 lightweight delete（`DELETE FROM t WHERE ...`），标记删除位图，查询时过滤，比 mutation 快得多。

---

## §4 · 主键与稀疏索引

### 4.1 稀疏索引原理

**每 `index_granularity=8192` 行一个索引项** → 一张 10 亿行表只有约 12 万个索引项，索引远小于逐行索引，常可常驻内存。这里的“每 8192 行”指排序后同一个 part 内的一个 granule；并不表示磁盘变成了行式存储。

**结构**：
```
primary.idx:  [每个 granule 起点的主键元组]
{col}.mrk2:   [该列每个 granule 的读取位置]
{col}.bin:    [该列的压缩真实数据]
```

例如 `ORDER BY (tenant_id, instance_id, metric, ts)`，同一 part 会先根据这四列的字典序得到一套**全局行顺序**；然后该 part 的所有列都按这套同一行顺序分别写入自己的列文件：

```text
排序后逻辑行号：  0        1        2        3
tenant_id.bin: [10001,    10001,    10001,    10002]
instance_id:   [ins-a,    ins-a,    ins-b,    ins-a]
metric.bin:    [cpu,      cpu,      memory,   cpu]
ts.bin:        [10:00,    10:01,    10:00,    10:00]
value.bin:     [40,       50,       60,       80]
```

`value` 即使不在 `ORDER BY` 中，也绝不能按 value 自己的大小单独排序；否则列间的第 k 个值不再对应同一条记录，行就无法恢复。granule 正是所有列共享的逻辑行号范围：`ts.mrk2[237]`、`instance_id.mrk2[237]`、`value.mrk2[237]` 虽然指向不同文件、不同字节偏移，但都表示“排序后第 237 个 granule 的同一批行”。

**查询流程**：
1. 先由分区键裁剪 partition；
2. 对候选 part，用 `primary.idx` 判断哪些 granule **可能**命中主键条件；
3. 对命中的 granule，通过各列自己的 `.mrk2` 跳到各自 `.bin` 中对应位置；
4. 读取过滤列和结果列，在内存中按相同数组下标对齐并做精确过滤。

`primary.idx` 负责"要不要读这个 granule"，`.mrk2` 负责"决定读后去某列文件的哪里读"，`.bin` 才是数据本体。它们不是三种相互替代的索引。

**granule 不是偏移量，是"逻辑数据块"**

granule 是数据按 `index_granularity`（默认 8192 行）切出来的最小**行集合**，是"读数据的最小单位"，本身不是任何偏移量——查询时要么读整个 granule，要么跳过，不会只读半个。偏移量存在 `.mrk2` 里，与 granule 是两个层面的概念，别混为一谈。

**`.mrk2` 的内部结构（每个 granule 两个偏移量）**

`.mrk2` 文件存的是一串**等长记录**，**下标就是 granule 编号**：

```
MarkInCompressedFile = {
    offset_in_compressed_file    : UInt64,  // 该 granule 在压缩文件(.bin)中的字节偏移
    offset_in_decompressed_block : UInt64   // 解压后块内的字节偏移
}
```

- 每个偏移量 8 字节，**每个 granule 共 16 字节**；文件总大小 = `granule 数 × 16`
- 名字里的 **"2"** 就是指"两个偏移量"（旧版 `.mrk` 只有压缩偏移一个）

**为什么需要两个偏移量？** 因为 CK 的压缩单位不是 granule，而是**压缩块（compressed block）**——一个压缩块通常装多个 granule（`min_compress_block_size ≈ 64KB`）。所以只记"在 `.bin` 里的字节偏移"不够，还必须记"解压后这个 granule 在第几个块的第几字节"：前者定位到 `.bin` 里那个压缩块，后者在解压结果里切出这个 granule 的 8192 行。

**多列主键下 `.mrk2` 与主键列数无关**

- 主键 4 列，就有 4 个 `.mrk2`（每个主键列各一个），外加非主键列各自的 `.mrk2`
- 每个 `.mrk2` 结构**一模一样**，都是"granule 数 × 16 字节"，只是各自记录**自己那一列**在自己那个 `.bin` 里的偏移
- 多列主键只会让 `primary.idx` 的**元组变宽**（每个 granule 存该 granule 第一行的完整主键元组），**不影响 `.mrk2` 的结构**
- 同一个 granule 编号在所有列的 `.mrk2` 里指向**同一批 8192 行**，只是各自存自己列的偏移

> 小 part（默认 < `min_bytes_for_wide_part = 10MB`）走 compact 格式，所有列混在同一个 `data.bin`，偏移表合并成一个 `data.mrk3`（每个 granule 存所有列的偏移对）。这只是存储布局优化，不改变主键索引的工作方式。

### 4.2 主键 vs 排序键

```sql
ORDER BY (a, b, c) PRIMARY KEY (a)
```

- **默认 `PRIMARY KEY = ORDER BY` 全部**；若显式声明 `PRIMARY KEY`，它必须是 `ORDER BY` 的前缀。
- `ORDER BY` 是完整的**排序键**：决定 part 内所有行的共同排列顺序。
- `PRIMARY KEY` 是拿来生成 `primary.idx` 的排序键前缀：它只在每个 granule 的起点保存主键值，不保存所有行。
- CK 主键不保证唯一、不拒绝重复，也不是 MySQL 那种逐行 B+ 树。

复合键遵循最左前缀规律。对于 `ORDER BY (tenant_id, instance_id, metric, ts)`：

```sql
-- 能形成很小的连续主键范围，通常快
WHERE tenant_id = 10001
  AND instance_id = 'ins-abc'
  AND metric = 'cpu_usage'
  AND ts >= ... AND ts < ...

-- 只给第二列；同一个 instance_id 会散落在各 tenant_id 的范围中，主键跳过能力有限
WHERE instance_id = 'ins-abc'
  AND ts >= ... AND ts < ...
```

后一个查询不等于一定全表扫描：时间 partition 仍可裁剪，其他索引也可能帮助；但它不能像命中完整左前缀那样把目标定位为少数连续 granule。

**最左前缀：中间断列，后面全废**

对 `ORDER BY (tenant_id, instance_id, metric, ts)`，WHERE 能用到主键的多少列，取决于是否从最左边**连续**匹配：

| WHERE 条件 | 能用到的列 | 索引效果 |
|---|---|---|
| `tenant_id = 10001` | 第 1 列 | 定位该 tenant 连续段 |
| `tenant_id=10001 AND instance_id='ins-abc'` | 前 2 列 | 缩到该实例连续段 |
| `tenant_id=… AND instance_id=… AND metric='cpu_usage'` | 前 3 列 | 精准定位该指标段 |
| 上面 + `ts >= … AND ts < …` | 全部 4 列 | 最精准，ts 也参与定位起止 granule |
| `instance_id='ins-abc'`（跳 tenant_id） | **无** | 索引全废 → 全表扫 |
| `tenant_id=… AND metric='cpu_usage'`（跳 instance_id） | **仅第 1 列** | metric 失效 |
| `tenant_id=… AND ts >= …`（跳 instance_id、metric） | **仅第 1 列** | ts 失效 |

**为什么中间断列后面就全失效？** 因为数据先按 `tenant_id` 排，相同再按 `instance_id` 排，相同再按 `metric` 排。`instance_id` 的有序性只在"同一个 tenant_id 内部"成立——只给 `instance_id` 不给 `tenant_id` 时，它散落在所有 tenant 里，在整个 part 上不连续，二分没法定位连续区间。这跟 MySQL 复合索引 `(a,b,c)` 的 `WHERE b=1` 走不了索引一模一样。

**精确匹配 vs 范围**：主键列精确匹配（`=`）越多，锁定的连续段越窄；最后一列 `ts` 用范围条件时，只要前面所有列都精确匹配，`ts` 也能二分出起始/结束 granule 连续读取。若 `ts` 之前的某列是范围（如 `app_id IN (...)`），`ts` 就无法精准二分——因为同一前缀下多个值交错，ts 不再单调。

**面试点**：
> "CK 的主键**不唯一**，不像 MySQL。它只是排序 + 稀疏索引，用来跳过 granule。你可以有 100 万行 PK 相同——CK 不管。"

### 4.3 主键选择原则

1. **常用作 WHERE 条件**（否则索引失效）
2. **低基数在前**（枚举、tenant_id）→ 后面的列在同组内是排序的，压缩更好
3. **时间列常在后**（time-series 场景 tenant_id, metric, ts）
4. **不要太多列**（3~5 个）

排序键服务的是最常见、最重要的访问路径，不能试图用一套顺序同时最优覆盖互相冲突的查询。例如既要“按 tenant + 实例查曲线”，又要高频“跨 tenant 按实例查曲线”，通常保留主表的主路径，再为另一条高频路径建立 Projection 或一张不同 `ORDER BY` 的派生表；不要误以为加一个普通二级索引就等价于再拥有一套完整排序。

### 4.4 跳数索引（Skip Index，二级索引）

- **不是 B+ 树**，是**每 N 个 granule 一个统计信息**（bloom / min-max / set）；默认不会自动为所有列创建，只有显式 `INDEX` 声明的列或表达式才有。
- 类型：
  - `minmax`：min/max 值 → 范围过滤
  - `set(N)`：值集合 → 等值过滤
  - `bloom_filter`：布隆过滤 → 高基数等值
  - `ngrambf_v1 / tokenbf_v1`：文本子串 / token 匹配
- 只能**过滤 granule**，不精确到行

对上面只按第二列 `instance_id` 的查询，若它选择性高，可以补充：

```sql
INDEX idx_instance_id instance_id TYPE bloom_filter(0.01) GRANULARITY 4
```

`bloom_filter(0.01)` 的 `0.01` 是目标**假阳性率**：某索引块实际不含 `ins-abc` 时，理论上约 1% 概率仍会回答“可能存在”，于是 ClickHouse 多读数据再确认；它不会把实际存在的值判断为“不存在”，因此不会导致漏结果。参数越小，误判越少，但索引体积、写入和 merge 成本越高。

`GRANULARITY 4` 不是表的 `index_granularity=8192`。前者表示一条 Bloom Filter 覆盖连续 **4 个主键 granule**；若每个主键 granule 约 8192 行，则一条跳数索引覆盖约 32768 行：

```text
主键 granule 0 ~ 3   → Bloom Filter #0
主键 granule 4 ~ 7   → Bloom Filter #1
```

粒度设为 `1`，索引块最小、跳过最精细，但索引数量和成本最大；值越大，索引更省、过滤越粗。Bloom Filter 能补救“高基数字段不在排序键前缀”的等值/`IN` 查询，但不能把它变成主键连续范围查找：仍有假阳性，也可能因为目标值广泛分布而几乎不能跳过 granule。`instance_id` 这类高基数 ID 通常考虑 Bloom Filter；`set(N)` 更适合每个索引块内不同值很少的列；随机高基数值上的 `minmax` 通常效果有限。

---

## §5 · 分区（PARTITION BY）

### 5.1 分区的作用

- **物理隔离**：每分区独立目录
- **数据管理**：批量删除分区极快（`ALTER TABLE t DROP PARTITION '202401'`）
- **查询裁剪**：`WHERE ts BETWEEN ...` 只扫描相关分区
- **TTL**：按分区自动过期

### 5.2 分区粒度

- **按月**（`toYYYYMM`）：几十亿行/月的中等规模
- **按天**（`toYYYYMMDD`）：大规模需要精细管理
- **按小时**：**不推荐**，分区太多 → 元数据管理开销大

**经验**：单表分区数 < 1000，单分区数据量 100GB~1TB 最舒服。

### 5.3 分区裁剪

```sql
SELECT * FROM t WHERE ts > '2024-06-01'
-- 只扫描 202406+ 分区
```

- **必须 WHERE 有分区键**才能裁剪
- 分区键是**表达式**时（`toYYYYMM(ts)`），CK 会自动推导

---

## §6 · 数据类型与压缩

### 6.1 常用类型

| 类型 | 说明 |
|---|---|
| `UInt8/16/32/64` | 无符号整数 |
| `Int8/16/32/64/128/256` | 有符号（256 用于大数） |
| `Float32/64` | 浮点 |
| `Decimal(P, S)` | 定点小数 |
| `String` | 变长，无长度限制 |
| `FixedString(N)` | 定长 |
| `Date / DateTime / DateTime64(3)` | 日期时间 |
| `Array(T)` | 数组 |
| `Tuple(T1, T2)` | 元组 |
| `Map(K, V)` | 键值对（本质是 Array of Tuple） |
| `LowCardinality(T)` | **低基数字典编码**，字段值少时用 |
| `Nullable(T)` | 可空（有性能代价） |
| `UUID` | UUID |
| `IPv4 / IPv6` | 优化的 IP 类型 |

### 6.2 LowCardinality 是杀器

- 字段值 <1w 种（枚举、tag 值）时用 `LowCardinality(String)`
- **字典编码**：字段值编成 UInt8/16/32
- **压缩率提升 5~10x，查询提升 3x+**
- **典型场景**：service_name / region / status_code / metric_name

### 6.3 压缩

- **默认 LZ4**（快压缩解压）
- **`CODEC(ZSTD(1))`**：压缩率高 20%（生产热存推荐）
- **`CODEC(Delta, LZ4)`**：时间序列递增字段（timestamp）压缩率极高
- **`CODEC(DoubleDelta)`**：变化率低的时间戳
- **`CODEC(Gorilla)`**：Facebook 的浮点数编码（时序值）

**生产模板**：
```sql
ts DateTime64(3) CODEC(DoubleDelta, ZSTD(1)),
value Float64 CODEC(Gorilla, ZSTD(1)),
service LowCardinality(String) CODEC(ZSTD(1))
```

---

## §7 · 副本 ReplicatedMergeTree + Zookeeper/Keeper

### 7.1 副本原理

- **每个副本是完整数据**（不是分片）
- **Zookeeper/Keeper 元数据协调**：part 列表、leader 选举、副本状态
- **实际数据不走 ZK**：副本直接从 leader 拉取

### 7.2 建表

```sql
CREATE TABLE t (
    ...
) ENGINE = ReplicatedMergeTree(
    '/clickhouse/tables/{shard}/db/t',   -- ZK 路径
    '{replica}'                          -- 副本标识
)
ORDER BY ...
```

`{shard}` / `{replica}` 是宏（macros），每台机器配置不同。

### 7.3 写入流程

1. Client 写任意副本
2. 该副本落盘 part
3. **向 ZK 注册**：`/tables/.../parts/{part_name}`
4. 其他副本感知到新 part → 从写入副本拉取
5. **异步复制**（默认），可 `insert_quorum` 强一致

### 7.4 insert_quorum

- `insert_quorum=2` → 写入等 2 个副本 ACK 才返回
- **代价**：延迟增加，一个副本挂了写入 hang（配 `insert_quorum_timeout`）

### 7.5 ClickHouse Keeper

- CK 自研的 ZK 替代品，兼容 ZK 协议
- **优势**：C++ 实现（比 Java ZK 内存开销小 5x）、更好性能、更少 GC 抖动
- **生产建议**：新集群直接用 Keeper，老集群逐步替换

---

## §8 · 分片 Distributed 表

### 8.1 分片原理

- **一张 Distributed 表**是路由层，本身不存数据
- **多个本地表**是实际存储节点
- 客户端查 Distributed → 分发到各分片 → 各分片本地查 → 聚合返回

### 8.2 建表

```sql
-- 每个分片建本地表
CREATE TABLE t_local ON CLUSTER '{cluster}' (...)
ENGINE = ReplicatedMergeTree(...);

-- 分布式表
CREATE TABLE t_all ON CLUSTER '{cluster}' AS t_local
ENGINE = Distributed('{cluster}', 'db', 't_local', sipHash64(shard_key));
```

### 8.3 分片键（`sipHash64(...)`）

- 决定 insert 到哪个分片
- **不好选**：数据倾斜风险
- **建议**：高基数字段（user_id / trace_id）

### 8.4 查询流程

- **初始节点**收到查询 → 转发到所有分片（并行）→ 各分片本地执行 → 结果合并
- **聚合下推**：`SUM/COUNT/GROUP BY` 尽量在各分片本地完成，减少网络传输
- **JOIN 分布式坑**：默认 `distributed_product_mode='deny'`，跨分片 JOIN 需要显式改成 `local` 或 `global`

---

## §8.5 · 集群模式全景：分片 + 副本 + Keeper 三件套

### 8.5.1 CK 集群拓扑

**CK 的集群和 Kafka/ES 不同**：
- **没有中心 master**
- **无自动 rebalance**（分片间数据不自动迁移）
- **副本通过 Keeper/ZK 协调**（元数据），数据直连拉取

**典型生产架构**（4 分片 × 3 副本 = 12 节点）：
```
   ┌───────────────────────────┐
   │  ClickHouse Keeper (3~5)  │  ← 独立部署，元数据协调
   │  keeper-1, 2, 3           │
   └────────────┬──────────────┘
                │ 副本状态同步
    ┌───────────┴─────────────────┐
    ▼                             ▼
┌───────┐  ┌───────┐    ┌───────┐  ┌───────┐
│shard1 │  │shard2 │    │shard3 │  │shard4 │
│r1 r2 r3│ │r1 r2 r3│  │r1 r2 r3│ │r1 r2 r3│  ← 每分片 3 副本
└───────┘  └───────┘    └───────┘  └───────┘
   同一分片内三副本数据完全一致（异步复制）
   分片间数据完全不同（分片路由决定）

Client 通过 Distributed 表连任意节点 →
       该节点路由到目标分片副本 →
             聚合结果返回
```

**配置文件**（`config.xml` remote_servers）：
```xml
<remote_servers>
    <tcum_cluster>
        <shard>
            <internal_replication>true</internal_replication>
            <replica><host>ck-s1-r1</host><port>9000</port></replica>
            <replica><host>ck-s1-r2</host><port>9000</port></replica>
            <replica><host>ck-s1-r3</host><port>9000</port></replica>
        </shard>
        <shard>
            <internal_replication>true</internal_replication>
            <replica><host>ck-s2-r1</host><port>9000</port></replica>
            ...
        </shard>
    </tcum_cluster>
</remote_servers>

<macros>
    <shard>01</shard>       <!-- 该节点属于哪个 shard -->
    <replica>r1</replica>   <!-- 该节点的副本标识 -->
</macros>
```

**关键点 `internal_replication=true`**：
- Distributed 写入时**只写分片的一个副本**（由 ReplicatedMergeTree 自己同步到其他副本）
- 若 `false` → Distributed 写所有副本（**双写，容易不一致**，不推荐）
- **生产必配 true**

### 8.5.2 副本机制（ReplicatedMergeTree）

**副本对等，无主从概念**（每个副本都能写）：

**写入流程**（详细）：
1. Client 写入某副本 A（该副本先落盘生成 part）
2. **副本 A 向 Keeper 注册**新 part：`/clickhouse/tables/{shard}/table/parts/{part_name}`
3. Keeper 通知其他副本 B、C 有新 part
4. **副本 B、C 直接从 A HTTP 拉取 part 文件**（不走 Keeper）
5. B、C 落盘完成后自己也在 Keeper 上标记有该 part
6. **默认异步**：副本 A 落盘完成就返回客户端（不等 B、C）

**强一致选项 `insert_quorum`**：
```sql
SET insert_quorum = 2;                  -- 等至少 2 副本 ACK
SET insert_quorum_timeout = 60000;      -- 60s 超时
```
- 写入至少 2 副本才返回
- 副本不够 → hang 到超时或够
- 类似 Kafka `acks=all + min.insync.replicas=2`

**副本选主？**：
- **CK 副本对等，没有 leader/follower 概念**
- 唯一有"leader"的地方：**merge leader**（副本间只选一个执行合并，其他复制结果）
- Keeper 里通过临时节点 leader election 选出，挂了自动重选

**面试深度**：
> "CK 的副本模型是**多主异步复制**——不像 MySQL/Redis 一主多从、也不像 MGR 多数派共识。任何副本都能写，各副本通过 Keeper 元数据感知彼此的 part，直接 HTTP 拉数据。这是为高吞吐设计的选择：写入不需要主节点串行化。代价是**弱一致**——插入后立即从另一副本查可能查不到。"

### 8.5.3 分片机制（Distributed）

**分片路由**：
- 客户端 INSERT 到 Distributed 表
- Distributed 表按 sharding key 计算目标分片：`sipHash64(user_id)` / `cityHash64(instance_id)`
- **数据 append 到本地临时目录** → 后台异步转发到目标分片
- 目标分片再走 ReplicatedMergeTree 复制到副本

**同步 vs 异步转发**：
```
insert_distributed_sync = 0    -- 默认异步：client 秒返回，可能丢
insert_distributed_sync = 1    -- 同步：等所有分片 ACK，慢但可靠
```
生产建议：**Kafka Consumer 直接 INSERT INTO 本地表**（跳过 Distributed 写入），只用 Distributed 表做查询。

**分片键设计陷阱**：
| 陷阱 | 后果 |
|---|---|
| 分片键选枚举低基数（region） | 数据倾斜，几个分片全空/全满 |
| 分片键包含 NULL | 数据落 shard 0（可能倾斜） |
| 分片键选易变字段 | 无法预计算，性能差 |
| 需要 JOIN 的两表分片键不同 | 无法本地 join，只能 GLOBAL JOIN（贵） |

### 8.5.4 ClickHouse Keeper（重要）

**为什么替换 ZK**：
- ZK 是 Java 实现 → JVM GC 抖动 → 大集群下 session 频繁超时
- ZK 每节点内存开销大（几 GB）
- ZK 单线程写入，大量 part 元数据成为瓶颈

**Keeper 优势**：
- C++ 实现，无 GC 抖动
- 内存开销小 5x
- **协议完全兼容 ZK**（客户端无需改代码）
- **同一进程可以 embed** 到 ClickHouse Server 里（小集群省一层部署）

**Keeper 集群**：
- **通常 3 或 5 节点**（奇数，Raft 多数派）
- **不推荐 embed 到数据节点**（生产环境独立部署更稳）
- **Raft-based 一致性**：内部选 leader，数据强一致

**Keeper 挂了会怎样**：
- **写入**：任何依赖 Keeper 的操作（INSERT 到 Replicated 表、DDL）都会失败
- **查询**：只查数据的操作**不受影响**（数据不走 Keeper）
- **副本同步**：暂停（副本不知道哪些 part 是新的）
- 恢复：多数派恢复即可继续服务

### 8.5.5 数据不丢保证

**层次化保证**：

1. **单节点级**：
   - MergeTree 写入生成 part → fsync（默认）
   - `fsync_after_insert=1` 强制 fsync（默认 0，靠 OS）

2. **副本级**：
   - `insert_quorum=2` + 3 副本 → 允许 1 副本挂
   - `select_sequential_consistency=1` → 读时等副本追上（读老副本兜底）

3. **分片级**：
   - Distributed 表 `insert_distributed_sync=1` → 等所有分片确认
   - **推荐做法**：客户端直连本地表，靠外部消息队列（Kafka）重试保证不丢

4. **备份**：
   - `BACKUP TABLE ... TO Disk('backups', 'path')`
   - `clickhouse-backup` 工具增量备份到 S3

### 8.5.6 故障恢复流程

**单副本挂**：
- 其他副本继续服务读写
- 恢复后从 Keeper 拉当前 part 列表 → 从活的副本 HTTP 拉缺失 part → 追齐

**整个分片挂**（所有副本都挂）：
- Distributed 查询该分片会失败
- `distributed_replica_error_cap` + `distributed_replica_error_half_life` 配置错误熔断
- 恢复：至少一个副本重启即可，Keeper 元数据仍在

**Keeper 挂（少数派）**：
- Raft 保证多数派仍能服务
- 少数派恢复后自动追齐

**Keeper 全挂**：
- 灾难性事件
- 恢复：**必须从 Keeper 备份恢复**（`clickhouse-keeper-restore`）
- 或者：重建 Keeper 集群 + `SYSTEM RESTORE REPLICA`（副本重新注册到新 Keeper）

**part 数据损坏**：
- CK 启动时会自动检测损坏 part
- 从其他副本重新拉取
- 无副本时：**该 part 数据永久丢失**（DETACH 后手动处理）

### 8.5.7 集群扩容缩容

**扩分片**（水平扩容）：
1. 加新节点，配 `remote_servers` 加入 cluster
2. 建 local table + Distributed
3. **老数据不会自动迁移**（这是 CK 大坑）
4. 新数据按分片键分布 → 老分片 vs 新分片数据比例失衡
5. **解决**：`clickhouse-copier` 或 `INSERT INTO new SELECT FROM old WHERE ...` 手动迁移

**扩副本**（可靠性扩容）：
1. 加新节点，`macros` 里配置为已有 shard 的新 replica
2. `CREATE TABLE ... ENGINE = ReplicatedMergeTree` 建表
3. 新副本自动从 Keeper 感知历史 part → HTTP 拉取
4. 追齐后加入 ISR
5. **较简单，无需迁数据**

**缩容**：
- 副本：`DROP REPLICA` 从 Keeper 摘掉，然后关机
- 分片：**极难**，需要先把数据迁走再删

### 8.5.8 面试模板

> "CK 集群走**分片 + 副本**架构，我们生产 4 分片 × 3 副本 = 12 节点 + 3 独立 Keeper。副本对等（都能写）通过 Keeper 元数据协调 + HTTP 直连拉数据；分片间无中心通过 Distributed 表路由。
>
> **写入保证**：Kafka Consumer 直接 INSERT INTO 本地表跳过 Distributed 转发风险，`insert_quorum=2` 保证多数派副本落盘。写入失败 Kafka offset 不 commit 靠消费重试兜底。
>
> **不丢**：3 副本 + `insert_quorum` + Keeper Raft + 每天 clickhouse-backup 增量到 COS。
>
> **恢复**：单副本挂自动补齐；Keeper 少数派挂 Raft 兜住；Keeper 全挂靠 backup。**扩分片是最大痛点**——老数据不自动迁移，需要 clickhouse-copier 或 INSERT SELECT 手动迁。"

---

## §9 · 物化视图（Materialized View） 与 Projection

### 9.1 MV 原理

- **不是 MySQL 那种查询快照**，而是**触发器**
- 每次源表 insert 时，**同步计算 MV 的 SELECT 并写入 MV 目标表**
- 存量数据不自动 backfill（要 `INSERT INTO mv SELECT ... FROM t`）

**执行模型：同步落盘 part + 后台 merge（不是"内存常驻 + 定时 flush"）**

MV 触发**不是**"维护一份常驻内存的聚合状态、定时刷盘"，而是**每次 INSERT 独立地、同步地**完成：

1. 源表 INSERT 的这批行先进入内存 buffer（Block，约 8192 行）
2. 源表把这批数据落盘成一个 part（同步）
3. **同一时刻** MV 的 SELECT 对这批行执行 GROUP BY（聚合计算在内存完成）
4. 聚合结果（比如几百行）作为**一个新 part**，**立即**写进 MV 目标表（同步落盘）

三个关键纠正：

- **不是"insert 更新内存聚合值"**：每次 INSERT 都是独立、一次性把这批数据聚合成新 part 立刻落盘，CK 不维护流式常驻的聚合内存状态（这点和 Flink 的 State 完全不一样）
- **不是"定时任务落盘"**：落盘在 INSERT 那一瞬间就同步完成了
- **后台任务做的是"合并（merge）"不是"落盘"**：每次 INSERT 产生新 part，同一 key 的中间状态会散落在多个 part 里（如 `(service=A, minute=10:00, count=100)` 和 `(service=A, minute=10:00, count=200)` 各自在不同 part），后台 merge 任务异步把它们合并成更大的 part，合并时相同 ORDER BY 键的中间状态会继续聚合（100+200→300）

### 9.2 典型用法：分钟级预聚合

```sql
-- 源表：明细 Trace
CREATE TABLE spans (
    ts DateTime64(3),
    service LowCardinality(String),
    duration UInt32,
    status UInt8
) ENGINE = MergeTree() ORDER BY (service, ts);

-- 分钟聚合结果表
CREATE TABLE service_metrics_1m (
    ts DateTime,
    service LowCardinality(String),
    call_count AggregateFunction(count),
    p99 AggregateFunction(quantile(0.99), UInt32),
    error_count AggregateFunction(countIf, UInt8)
) ENGINE = AggregatingMergeTree() ORDER BY (service, ts);

-- MV：insert spans 时自动聚合到 service_metrics_1m
CREATE MATERIALIZED VIEW mv_service_metrics TO service_metrics_1m AS
SELECT
    toStartOfMinute(ts) AS ts,
    service,
    countState() AS call_count,
    quantileState(0.99)(duration) AS p99,
    countIfState(status >= 500) AS error_count
FROM spans
GROUP BY ts, service;

-- 查询时用 -Merge 合并中间状态
SELECT service, countMerge(call_count), quantileMerge(p99)
FROM service_metrics_1m
WHERE ts > now() - INTERVAL 1 HOUR
GROUP BY service;
```

**核心概念**：`AggregateFunction` + `-State` / `-Merge`
- `countState() / quantileState()` 生成**中间状态**（bitmap / t-digest / hll）
- `-Merge` 时合并中间状态得最终值
- 允许**跨行、跨时间粒度**再聚合

**`-Merge` 到底在干嘛？**

写入时 `countState()` 把 count 包装成"中间状态"存进 `AggregateFunction(count)` 列；查询时 `countMerge(call_count)` 把这个中间状态**解包合并**成可读的 UInt64 数字。`quantileMerge(p99)` 同理：`quantileState(0.99)` 存的是 t-digest sketch（近似分位数的数据结构），`quantileMerge` 解包 sketch 算出最终 P99。

**关键：这一列存的是"中间状态"不是"最终值"。** 直接 `SELECT call_count` 会得到二进制/乱码，必须用 `-Merge` 还原。之所以要绕这一圈，是为了支持**增量合并**——同一个 key 可能分多批 INSERT 进来（每次 INSERT 各自存一份 `countState`，散落在不同 part），查询时 `countMerge` 把多份状态合并成一个最终值；即使后台 merge 还没把 part 合并完，结果也依然正确。

**为什么 avg 不能直接存？** 平均值不能二次聚合（`avg(avg)` 是错的）。所以物化视图里**根本没有 avg 列**，只存 `countState()` 和 `sumState()` 两个中间状态，查询时用 `sumMerge(sum) / countMerge(count)` 现算 avg。

**分位数更甚**：两个 part 各自算出的 P99 不能简单平均成全局 P99，必须存 t-digest sketch 中间状态，查询时 `quantileMerge` 合并多个 sketch 再算精确分位数。这正是 State/Merge 机制存在的根本原因。

### 9.3 Projection（21.3+，投影）

- **表内的隐藏物化**：与主表同分区，自动选择
- **优势**：查询优化器自动决定用不用 projection（vs MV 需要手动查目标表）
- **代价**：写放大

```sql
ALTER TABLE t ADD PROJECTION p_hourly (
    SELECT toStartOfHour(ts), service, count(), avg(duration)
    GROUP BY toStartOfHour(ts), service
);
```

**面试点**：
> "MV 更灵活但需要显式查目标表；Projection 是引擎内建对查询透明，但只能同一张表。生产上 MV 更常用（跨表、复杂 pipeline），Projection 用在少量固定聚合模式。"

---

## §10 · 常用表引擎

### 10.1 ReplacingMergeTree

- 相同 ORDER BY 键的行**在 merge 时保留最新版本**（按 `ver` 列或插入顺序）
- **注意**：只在 merge 时去重，未 merge 前查询有重复 → 查询加 `FINAL` 强制去重（贵）
- **典型用法**：CDC 场景（binlog 同步）—— 覆盖旧版本

### 10.2 SummingMergeTree

- 相同 ORDER BY 键的行 **数值列自动 SUM**
- **典型用法**：按维度聚合的中间表

### 10.3 AggregatingMergeTree

- 存 AggregateFunction 类型的中间状态
- 结合 MV 使用，允许任意聚合函数（count/sum/uniq/quantile）
- **最强大的预聚合方案**

### 10.4 CollapsingMergeTree / VersionedCollapsingMergeTree

- 通过 `sign` 列（1/-1）表示插入/删除
- merge 时正负抵消
- **典型用法**：需要更新的场景（比 mutation 快得多）

### 10.5 引擎选型速查

| 场景 | 引擎 |
|---|---|
| 追加只写 | MergeTree |
| 需要副本 | ReplicatedMergeTree（生产必选） |
| CDC / 需要更新 | ReplacingMergeTree |
| 需要软删 | CollapsingMergeTree |
| 简单 SUM 聚合 | SummingMergeTree |
| 复杂聚合（quantile/uniq） | AggregatingMergeTree + MV |
| 一次性小表 | Memory / Log |

---

## §11 · 执行引擎与向量化

### 11.1 向量化本质

- 传统火山模型（Volcano）：**每行调用 next()** → 函数调用开销大
- 向量化：**每次 next() 返回一个 Block（8192 行）** → 减少函数调用 + SIMD 并行

### 11.2 一次查询的执行

1. SQL 解析 → AST
2. 分析 → 逻辑 plan
3. 优化 → 物理 plan（QueryPlan）
4. **QueryPlan → QueryPipeline**：物理算子组成 pipeline
5. 每个 processor（source/transform/sink）在独立线程执行
6. 通过 InputPort / OutputPort 连接，Block 流式传递

### 11.3 分布式查询

- 初始节点发起 → 远程节点执行 local 子计划 → 返回中间结果 → 初始节点合并

### 11.4 内存 & 并发限制

- `max_memory_usage`：单查询上限（默认 10GB）
- `max_threads`：单查询并发线程数（默认核数一半）
- `max_concurrent_queries`：全局并发上限（默认 100）
- **超限报错**：`Memory limit (for query) exceeded`

---

## §12 · 慢查询与优化

### 12.1 慢查询定位

```sql
SELECT query_id, query, memory_usage, read_rows, query_duration_ms
FROM system.query_log
WHERE type = 'QueryFinish' AND query_duration_ms > 5000
ORDER BY query_start_time DESC
LIMIT 20;
```

### 12.2 EXPLAIN

```sql
EXPLAIN PLAN header=1 SELECT ... 
EXPLAIN PIPELINE SELECT ...
EXPLAIN ESTIMATE SELECT ...       -- 估算读的行数
EXPLAIN SYNTAX SELECT ...         -- 重写后的 SQL
```

### 12.3 常见优化

1. **WHERE 用主键前缀**：确保命中稀疏索引
2. **加分区裁剪条件**
3. **只 SELECT 需要的列**：列式的核心优势
4. **LowCardinality**：低基数字段
5. **PREWHERE**：把选择性高的条件放 PREWHERE，先过滤再读其他列（自动优化，也可手动）
6. **禁用 SELECT ***
7. **避免大 JOIN**：优先用 dict / semi-join / IN 子查询
8. **物化视图预聚合**：高频聚合查询

### 12.4 JOIN 优化

- **默认 hash join**：右表放内存哈希 → 大表右会 OOM
- **grace hash join**（23.5+）：右表放不下就分批哈希
- **partial merge join**：预排序 join
- **建议**：小表放右边，或者用**字典（Dictionary）**代替维表 JOIN

---

## §13 · 生产实战：SLO 预聚合 + Trace 明细 + 高基数时序

### 13.1 SLO 分钟级预聚合

- **明细表**：原始请求，几十亿/天
- **1min MV**：AggregatingMergeTree 存中间状态（call_count / p99 / error_count）
- **5min / 1hour MV**：从 1min 表再聚合
- **查询**：不同粒度按查询范围选表（5min 表查 7 天，1hour 表查 30 天）

### 13.2 Trace / APM 明细

- 单条 span 存明细
- ORDER BY (service, ts) → 按服务和时间聚簇，压缩极高
- 按 trace_id 查找加 **bloom_filter 跳数索引**
- 冷数据 TTL 7~30 天到 S3 / HDFS

### 13.3 高基数时序（VM 存不下时）

- VM 的倒排索引在 label 组合 > 千万时爆炸
- **切 ClickHouse**：明细 + MV 预聚合 → 高基数 metric（如 pod-level 指标）
- **牺牲**：VM 的 PromQL 生态；**换来**：SQL 灵活 + 明细可下钻

**面试深度点**：
> "CK 不是 VM 的替代，是 VM 的补充。VM 的强项是低基数时序 + PromQL 生态 + 长期存储；CK 的强项是高基数明细 + SQL 灵活 + 预聚合物化视图。TCUM 里两者并存：核心指标用 VM，明细/高基数走 CK。"

### 13.4 CK 表结构模板（时序场景）

```sql
CREATE TABLE metrics (
    ts DateTime64(3) CODEC(DoubleDelta, ZSTD(1)),
    metric LowCardinality(String) CODEC(ZSTD(1)),
    service LowCardinality(String) CODEC(ZSTD(1)),
    pod LowCardinality(String) CODEC(ZSTD(1)),
    tags Map(LowCardinality(String), LowCardinality(String)),
    value Float64 CODEC(Gorilla, ZSTD(1))
) ENGINE = ReplicatedMergeTree(...)
PARTITION BY toYYYYMMDD(ts)
ORDER BY (service, metric, ts)
TTL toDate(ts) + INTERVAL 30 DAY DELETE,
    toDate(ts) + INTERVAL 7 DAY TO VOLUME 'cold'
SETTINGS index_granularity = 8192,
         storage_policy = 'hot_cold';
```

---

## §13.5 · 完整例子：CVM CPU 使用率监控的端到端流程

> 本节用**腾讯云 CVM 的 CPU 使用率**这个具体场景，把 CK 从建表 → 写入落盘 → 物化视图触发 → 查询执行的完整链路全走一遍。目标是让你**看完这一节就能自己动手上线一个监控指标 CK 表**。

> **先和 `tcum-yunshao-global` 当前代码对齐，避免把教学 DDL 当成项目事实：**本节后面的 `cvm_cpu_local`、`mv_cvm_cpu_1min_local` 等表名，是为了讲清楚 CK 设计而给出的**示例架构**；仓库中没有 `CREATE MATERIALIZED VIEW` 或 Kafka Engine 的 CK DDL。因此，不能根据该仓库断言线上已经为每一个指标建立了这些表和 MV。项目代码实际做到的是：把满足 `metricStoreConfig.ck=true` 的 `TsData` 发到 CK Kafka topic；每个指标配置还带有 `metricStoreConfig.ckTableName`。写出的 Kafka `Metric` 消息中，`measurement = ckTableName`（注释明确称为“表名”），`fields[0].name = MetricsName`（真正的指标名），标签带有 `physical_key`，供下游映射物理列。Kafka → CK 源表 → 物化视图 → 目标表究竟如何建、是否按 `measurement` 分流，属于下游 CK/流计算部署，**不在此仓库中**。

> **因此“一个 metric 一张表吗”的准确答案是：不是代码强制的。**表粒度由每个指标元数据中的 `ckTableName` 决定：多个指标可配置同一个 `ckTableName`，共同进入同一个 measurement/目标表；也可给某个指标单独配置一个表名。`MetricCkKafkaService` 不会把 `MetricsName` 拼成表名，也不会按 metric 自动创建表或自动创建一张 MV。下游若采用 CK 的 Kafka Engine + MV，常见做法是以 `measurement` 作为路由字段，写到对应表；但具体 MV 数量、目标表 DDL 和路由 SQL 必须以 CK 部署仓库或线上 `SHOW CREATE TABLE` 为准。

```text
指标元数据：{ ck: true, ckTableName: "cvm_device_60" }
          │
          ▼
一条 CPU 样本（MetricsName = "cpu_usage"）
          │
          ▼
Kafka Metric：measurement = "cvm_device_60"，fields[0].name = "cpu_usage"
          │
          ▼
下游 CK/流式部署按 measurement 决定进入哪张目标表（本仓库未包含该 DDL）
```

### 13.5.1 业务背景与数据规模

**业务描述**：
- 每台 CVM 每 10 秒采集一次 CPU 使用率（0.0 ~ 1.0 之间的 float）
- 标签维度：`region`（地域）、`zone`（可用区）、`instance_id`（实例 ID）、`app_id`（用户 UIN）、`instance_type`（机型如 S5.MEDIUM4）
- 规模：假设线上 500 万台 CVM，每 10 秒采集一次 → **每分钟 3000 万条样本，每天 432 亿条**
- 查询场景：
  - **Q1（诊断）**：查某台实例（`instance_id=ins-abc`）最近 1 小时的 CPU 曲线
  - **Q2（大盘）**：查某地域（`region=ap-guangzhou`）过去 24 小时的 CPU 平均值时序图
  - **Q3（下钻）**：查某用户（`app_id=100012345`）过去 7 天的 CPU 使用率 P95 / P99
  - **Q4（长周期）**：查某地域过去 30 天的 CPU 使用率月度趋势
  - **Q5（告警）**：找出过去 5 分钟 CPU > 90% 的 top 100 实例

**为什么这个例子典型**：
- **高基数**（500w instance_id）→ CK 强项
- **写多读少**（写 30w QPS，查询几百 QPS）→ MergeTree 适合
- **多个时间粒度诉求**（1h 秒级点查、24h 分钟聚合、7d 5 分钟聚合、30d 小时聚合）→ **典型的多层物化视图预聚合场景**

### 13.5.2 第一步：建明细表（原始数据落地）

先建一张 **local 表**（每个 shard 上的实际存储表）：

```sql
CREATE TABLE monitor.cvm_cpu_local ON CLUSTER '{cluster}'
(
    -- 时间戳，毫秒精度；DoubleDelta 对递增时间戳压缩极强，配合 ZSTD 二次压缩
    ts             DateTime64(3, 'Asia/Shanghai') CODEC(DoubleDelta, ZSTD(1)),

    -- 低基数枚举列：全球 30 个地域、5 种机型
    -- LowCardinality 内部字典化，1 字节 index 就够，压缩后基本不占空间
    region         LowCardinality(String)         CODEC(ZSTD(1)),
    zone           LowCardinality(String)         CODEC(ZSTD(1)),
    instance_type  LowCardinality(String)         CODEC(ZSTD(1)),

    -- 高基数列：500w 实例 id
    -- 不能用 LowCardinality（超过 1w 就没意义），直接 String + ZSTD
    instance_id    String                         CODEC(ZSTD(1)),

    -- 用户 UIN，几十万级别，仍算中等基数，用 String
    app_id         UInt64                         CODEC(ZSTD(1)),

    -- 值列：CPU 使用率 [0, 1]，Gorilla 编码专门为浮点时序设计（Facebook 论文）
    -- 相邻值变化小时压缩到几个 bit
    cpu_usage      Float32                        CODEC(Gorilla, ZSTD(1)),

    -- 为 instance_id 高基数点查加 bloom filter 二级索引
    -- 每 4 个 granule 一个 bloom，0.01 假阳率
    INDEX idx_instance instance_id TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = ReplicatedMergeTree(
    '/clickhouse/tables/{shard}/monitor/cvm_cpu_local',
    '{replica}'
)
PARTITION BY toYYYYMMDD(ts)          -- 按天分区：单天 432 亿行，约 400GB，合理
ORDER BY (region, app_id, instance_id, ts)   -- 排序键决定物理存储顺序 + 稀疏索引
TTL toDate(ts) + INTERVAL 7 DAY DELETE        -- 明细只留 7 天
SETTINGS
    index_granularity = 8192,        -- 稀疏索引粒度：每 8192 行一个索引项
    storage_policy = 'hot_cold';     -- 3 天热 SSD，超过转 SATA
```

**关键设计决策解读**：

**① 为什么 ORDER BY 是 `(region, app_id, instance_id, ts)` 这个顺序？**

排序键决定了三件事：**物理存储顺序**、**稀疏索引**、**压缩效果**。选择原则是"**基数从低到高**"：

| 位置 | 列 | 基数 | 作用 |
|---|---|---|---|
| 1 | `region` | 30 | 大盘查询按地域裁剪（Q2 命中） |
| 2 | `app_id` | 几十万 | 按用户下钻（Q3 命中） |
| 3 | `instance_id` | 500 万 | 精确定位实例（Q1 命中） |
| 4 | `ts` | 时间连续 | 时间范围过滤（所有查询都命中） |

**低基数在前的好处**：同一 region 的所有数据物理连续 → `region` 列压缩率极高（LowCardinality + 前后重复 → 几乎不占空间）；同 region 内同 app_id 的数据也连续，二级压缩效果好。

**反例**：如果 `ORDER BY (instance_id, ts, region)`——第一列基数 500w，region 就完全打散，压缩比雪崩。

**② 为什么用天分区而不是小时？**

- 单天数据量 400GB 左右，7 天 = 2.8TB，7 个分区管理简单
- 按小时分区 → 7×24=168 个分区，元数据管理开销大，merger 压力大
- **CK 官方经验**：**单表分区数 < 100**，单分区 100GB~1TB 最舒服

**③ 为什么加 bloom_filter 二级索引？**

- 主键 `(region, app_id, instance_id, ts)` 对**没有 region/app_id 只有 instance_id** 的查询无效（比如工单排查只知道 instance_id）
- bloom filter 索引让"只有 instance_id"的查询也能**跳过大部分 granule**
- **每 4 个 granule 一个 bloom**：粒度粗但内存占用少，适合大表

**④ 为什么 CPU 用 Float32 不用 Float64？**

- CPU 使用率精度到 0.001 就够，Float32 已经比 Float64 省一半空间
- Gorilla 编码后 Float32/Float64 差别更明显

**⑤ 分布式表在哪？**

上面建的是 **local 表**，还需要建一个 **Distributed 分布式表**做客户端入口：

```sql
CREATE TABLE monitor.cvm_cpu_all ON CLUSTER '{cluster}'
AS monitor.cvm_cpu_local
ENGINE = Distributed(
    '{cluster}',                      -- 集群名
    'monitor',                        -- 数据库
    'cvm_cpu_local',                  -- 本地表
    cityHash64(instance_id)           -- 分片键：按 instance_id hash 分片
);
```

**分片键选 `cityHash64(instance_id)` 的原因**：
- 500w instance_id 分布均匀，不会数据倾斜
- 同一实例的样本始终落同一 shard → 单机做完整时间序列查询，不用跨机聚合
- 反例：如果按 `cityHash64(region)`——只有 30 个 region，直接热点

### 13.5.3 第二步：写入路径（从 producer 到磁盘 part）

**客户端写入 SQL**：
```sql
INSERT INTO monitor.cvm_cpu_all VALUES
    ('2026-08-19 22:00:00.123', 'ap-guangzhou', 'ap-guangzhou-3', 'S5.MEDIUM4',
     'ins-abc123', 100012345, 0.75),
    ('2026-08-19 22:00:00.456', 'ap-shanghai',  'ap-shanghai-2',  'S5.LARGE8',
     'ins-def456', 100067890, 0.32),
    ...
```

**生产实际做法**：不会一条一条 INSERT（part 泛滥），而是 **kafka → 消费者 → 批量 INSERT**，一批 1w~10w 行。

**完整写入流程**（假设 10w 行一批）：

```
┌───────────────────┐
│  Kafka Consumer   │  从 metric kafka topic 拉一批 10w 行
│  (Go/Java 应用)   │
└─────────┬─────────┘
          │ INSERT INTO cvm_cpu_all
          ▼
┌───────────────────────────────┐
│ Distributed 表（任意 CK 节点）  │  ① 客户端连接到 Distributed 表所在节点
│                               │  ② 该节点按 cityHash64(instance_id) 分片
│                               │  ③ 把 10w 行拆分成 N 份，转发到目标 shard
└─────────┬─────────────────────┘
          │
          ├──→ shard 1 (10w × 1/N 行)
          ├──→ shard 2 (10w × 1/N 行)
          └──→ shard N (10w × 1/N 行)
                    │
                    ▼
    ┌───────────────────────────────────────┐
    │  目标 shard 上的 ReplicatedMergeTree    │
    │                                        │
    │  ① 数据在内存缓冲（Block，约 8192 行）  │
    │  ② 生成新 Part 目录：                  │
    │     /var/lib/clickhouse/data/monitor/  │
    │     cvm_cpu_local/                     │
    │     20260819_1234_1234_0/              │
    │                                        │
    │  ③ 每列一个 .bin 文件（列式存储）      │
    │  ④ 生成 .mrk2 marks 文件（索引→数据）   │
    │  ⑤ 生成 primary.idx（稀疏主键索引）    │
    │  ⑥ 生成 skp_idx_idx_instance.idx（bloom）│
    │  ⑦ 写入 ZK：/clickhouse/tables/.../parts/│
    │  ⑧ 副本从 ZK 感知，拉取 part          │
    └────────────────────────────────────────┘
```

**Part 目录内部结构**（真实磁盘布局）：

```
20260819_1234_1234_0/         # part 名字：分区_起始块号_结束块号_合并层级
├── ts.bin                    # ts 列的实际数据（Gorilla+ZSTD 压缩）
├── ts.mrk2                   # ts 列的 marks：每 granule 在 ts.bin 中的字节偏移
├── region.bin                # region 列数据
├── region.mrk2
├── region.dict.bin           # LowCardinality 字典
├── app_id.bin
├── app_id.mrk2
├── instance_id.bin
├── instance_id.mrk2
├── cpu_usage.bin             # 值列
├── cpu_usage.mrk2
├── primary.idx               # 稀疏主键索引（每 8192 行一项，全放内存）
├── skp_idx_idx_instance.idx  # bloom filter 二级索引
├── skp_idx_idx_instance.mrk2
├── columns.txt               # 列元数据
├── count.txt                 # 行数
├── checksums.txt             # 校验
└── minmax_ts.idx             # 分区键 minmax（用于分区裁剪）
```

**关键点**：
- **每列独立文件**是列式存储的物理体现，查询只读需要的列 → IO 极小
- **primary.idx 是稀疏的**：10w 行的 part 只有 `10w / 8192 ≈ 12` 个索引项，几百字节，全部放内存
- **.mrk2 marks 文件**：primary.idx 定位 granule 后，通过 .mrk2 找到 .bin 中的精确字节位置
- **写入完就是 immutable 的**：part 不可变，任何变更都是新 part

**写入完成后 part 的命名规则**：`分区ID_最小块号_最大块号_合并层级`
- 刚写入：`20260819_1234_1234_0`（level 0，未合并）
- 合并一次：`20260819_1234_2000_1`
- 再合并：`20260819_1234_5000_2`

**后台 Merge**：
- CK 后台线程定期挑小 part 合并成大 part
- 目的：减少 part 数量（查询要扫描每个 part），提高压缩率
- 触发条件：`parts_to_delay_insert=150`（part 数 >150 开始限速）、`parts_to_throw_insert=300`（>300 拒绝写入）

**写入放大问题**：
- 每次 INSERT 至少 1 个 part
- 10w 行/秒 + 1 秒一批 → 一天 8.6w 个 part
- 后台 merge 追不上 → **too many parts** 报错
- **解法**：加大 batch（1s → 10s）+ 加大 min_bytes_for_wide_part 让小 part 更快合并

### 13.5.4 第三步：物化视图（预聚合三层链路）

明细表存 7 天，但用户要查 30 天，直接扫明细不现实（30 天 = 30 × 432 亿 = 1.3 万亿行）。**建物化视图预聚合**：

**方案**：三层聚合链路
```
明细表（原始 10s 粒度，保留 7 天）
  └── MV1 分钟聚合表（保留 30 天）
        └── MV2 小时聚合表（保留 90 天）
              └── MV3 天聚合表（保留 1 年）
```

**MV1 - 分钟聚合表建表**：

```sql
-- 目标表：存放分钟粒度的聚合中间状态
CREATE TABLE monitor.cvm_cpu_1min_local ON CLUSTER '{cluster}'
(
    ts_min         DateTime         CODEC(DoubleDelta, ZSTD(1)),
    region         LowCardinality(String) CODEC(ZSTD(1)),
    app_id         UInt64            CODEC(ZSTD(1)),
    instance_id    String            CODEC(ZSTD(1)),

    -- 聚合中间状态列（关键！用 AggregateFunction 类型）
    cpu_count      AggregateFunction(count),                    -- 样本数
    cpu_sum        AggregateFunction(sum, Float32),             -- 总和
    cpu_min        AggregateFunction(min, Float32),             -- 最小
    cpu_max        AggregateFunction(max, Float32),             -- 最大
    cpu_quantile   AggregateFunction(quantile(0.95), Float32),  -- P95 分位 sketch
    cpu_quantile99 AggregateFunction(quantile(0.99), Float32)   -- P99 分位 sketch
)
ENGINE = ReplicatedAggregatingMergeTree(
    '/clickhouse/tables/{shard}/monitor/cvm_cpu_1min_local',
    '{replica}'
)
PARTITION BY toYYYYMM(ts_min)              -- 按月分区（数据量小很多）
ORDER BY (region, app_id, instance_id, ts_min)
TTL toDate(ts_min) + INTERVAL 30 DAY DELETE
SETTINGS index_granularity = 8192;

-- 物化视图：定义"每次明细表写入时如何计算"
CREATE MATERIALIZED VIEW monitor.mv_cvm_cpu_1min_local ON CLUSTER '{cluster}'
TO monitor.cvm_cpu_1min_local
AS SELECT
    toStartOfMinute(ts)             AS ts_min,        -- 时间归一到分钟
    region,
    app_id,
    instance_id,
    countState()                    AS cpu_count,     -- 生成聚合中间状态
    sumState(cpu_usage)             AS cpu_sum,
    minState(cpu_usage)             AS cpu_min,
    maxState(cpu_usage)             AS cpu_max,
    quantileState(0.95)(cpu_usage)  AS cpu_quantile,
    quantileState(0.99)(cpu_usage)  AS cpu_quantile99
FROM monitor.cvm_cpu_local          -- 源表：明细表
GROUP BY ts_min, region, app_id, instance_id;
```

**MV 触发机制**（这是核心难点）：

```
INSERT INTO cvm_cpu_local (10w 行)
       │
       ▼
明细表落盘生成 part 20260819_1234_1234_0
       │
       │  ★ CK 引擎发现明细表有 MV 挂着
       ▼
自动执行 MV 的 SELECT（仅对新写入的这 10w 行做 GROUP BY）
       │
       │  10w 行 → 假设有 500 个 (region, app_id, instance_id) 组合 → 500 行
       ▼
把这 500 行 AS 一个新 Block 写入 cvm_cpu_1min_local
       │
       ▼
cvm_cpu_1min_local 生成自己的 part
```

**关键理解**：
- **MV 不是"数据的第二份"**：MV 里的数据是明细表新写入数据的**增量聚合**
- **同分钟不同批次的问题**：22:00:00-22:00:59 期间来了 6 批数据（每 10s 一批） → MV 会产生 **6 个 part，每个 part 各有该分钟的部分聚合**
- **AggregateFunction + ReplicatedAggregatingMergeTree**：后台合并 part 时，相同 ORDER BY 键的行会**继续聚合**（不是简单拼接）
  - 例如两个 part 都有 `(22:00, ap-guangzhou, uid=1, ins-abc)`，各自 count=100 → merge 后 count=200
- 用户查询时用 `-Merge` 后缀合并所有 part 里的中间状态得到最终值

**为什么用 State/Merge 而不是直接算最终值？**

**错误做法**：
```sql
-- 直接算 avg
SELECT toStartOfMinute(ts), avg(cpu_usage) FROM cvm_cpu_local GROUP BY ...
```
问题：**avg 不能二次聚合**（多个 part 各算了 avg，合并时 avg(avg) 是错的），必须存 sum + count 分别累计。

**正确做法**：State 存 `(sum, count)` 中间状态 → Merge 时 `sum(sum_parts) / sum(count_parts)` 得正确 avg。

**分位数更甚**：quantile 完全不能二次聚合，必须存 **t-digest sketch** 中间状态，最终 Merge sketch 才能得精确 P95。

**MV2、MV3 类似**（从 1min 表聚合到 1hour 表）：

```sql
CREATE TABLE monitor.cvm_cpu_1hour_local ON CLUSTER '{cluster}' (
    ts_hour DateTime, region LowCardinality(String), app_id UInt64,
    instance_id String,
    cpu_count AggregateFunction(count),
    cpu_sum AggregateFunction(sum, Float32),
    cpu_min AggregateFunction(min, Float32),
    cpu_max AggregateFunction(max, Float32),
    cpu_quantile AggregateFunction(quantile(0.95), Float32),
    cpu_quantile99 AggregateFunction(quantile(0.99), Float32)
) ENGINE = ReplicatedAggregatingMergeTree(...)
PARTITION BY toYYYYMM(ts_hour)
ORDER BY (region, app_id, instance_id, ts_hour)
TTL toDate(ts_hour) + INTERVAL 90 DAY DELETE;

-- MV2：从 1min 表二次聚合到 1hour 表
CREATE MATERIALIZED VIEW monitor.mv_cvm_cpu_1hour_local ON CLUSTER '{cluster}'
TO monitor.cvm_cpu_1hour_local
AS SELECT
    toStartOfHour(ts_min) AS ts_hour, region, app_id, instance_id,
    countMergeState(cpu_count)               AS cpu_count,
    sumMergeState(cpu_sum)                   AS cpu_sum,
    minMergeState(cpu_min)                   AS cpu_min,
    maxMergeState(cpu_max)                   AS cpu_max,
    quantileMergeState(0.95)(cpu_quantile)   AS cpu_quantile,
    quantileMergeState(0.99)(cpu_quantile99) AS cpu_quantile99
FROM monitor.cvm_cpu_1min_local
GROUP BY ts_hour, region, app_id, instance_id;
```

**注意 `MergeState`**：把 1min 表的中间状态**合并后仍保持中间状态**（不 finalize），存到 1hour 表继续可以再聚合。这是链式 MV 的关键。

### 13.5.5 第四步：查询路径（读时逻辑）

回到最开始的 5 个查询场景，每个查最合适的表：

**Q1：查 `ins-abc` 最近 1 小时 CPU 曲线 → 查明细表**

```sql
SELECT ts, cpu_usage
FROM monitor.cvm_cpu_all         -- Distributed 表
WHERE instance_id = 'ins-abc'
  AND ts >= now() - INTERVAL 1 HOUR
ORDER BY ts;
```

**读时执行流程**：

```
① Client → 任意 CK 节点（作为 initiator）
② initiator 解析 SQL，识别是 Distributed 表
③ 由于 instance_id 已知，理论上可以通过 sharding key 定位单个 shard
   → 但客户端 SQL 未指定 shard → initiator 广播到所有 shard
④ 每个 shard 上执行 local 查询：
   
   ┌─────────────────────────────────────┐
   │ shard N 上的 cvm_cpu_local 查询流程   │
   │                                     │
   │ a) 分区裁剪：                        │
   │    WHERE ts >= now() - 1h           │
   │    → 只扫描 20260819 分区（1 个）    │
   │                                     │
   │ b) 主键索引失效？                    │
   │    ORDER BY (region, app_id, instance_id, ts)
   │    只知道 instance_id，前面两列不知  │
   │    → 主键索引不能直接用              │
   │                                     │
   │ c) bloom filter 二级索引生效！       │
   │    skp_idx_idx_instance 快速过滤     │
   │    不包含 'ins-abc' 的 granule      │
   │    → 从 5000 个 granule 缩到 20 个   │
   │                                     │
   │ d) 只读需要的列文件：                │
   │    ts.bin、cpu_usage.bin            │
   │    （其他列文件不 IO）               │
   │                                     │
   │ e) 向量化读取 20 个 granule × 8192 行│
   │    ≈ 16w 行进内存                   │
   │                                     │
   │ f) 精确过滤 instance_id = 'ins-abc' │
   │    → 假设匹配 360 行（1h × 6 次/min）│
   │                                     │
   │ g) 返回 360 行给 initiator          │
   └─────────────────────────────────────┘

⑤ initiator 合并各 shard 结果（因为分片键是 instance_id，
   其他 shard 都返回 0 行）
⑥ 全局 ORDER BY ts
⑦ 返回给 client
```

**性能**：单次查询几十 ms（bloom filter + 列式 + 向量化）。

**Q2：某地域过去 24 小时 CPU 平均值 → 查 1min 表**

```sql
SELECT
    toStartOfHour(ts_min)         AS hour,
    sumMerge(cpu_sum) / countMerge(cpu_count) AS avg_cpu   -- 手动 avg
FROM monitor.cvm_cpu_1min_all
WHERE region = 'ap-guangzhou'
  AND ts_min >= now() - INTERVAL 24 HOUR
GROUP BY hour
ORDER BY hour;
```

**读时执行流程**：

```
① Distributed 表广播到所有 shard
② 各 shard 上查 cvm_cpu_1min_local：
   
   a) 主键 ORDER BY (region, app_id, instance_id, ts_min)
      WHERE region = 'ap-guangzhou'
      → 主键索引第一列命中！稀疏索引精准定位
      → 只扫描 region='ap-guangzhou' 的 granule
   
   b) 分区裁剪：24 小时的数据在 202608 一个月分区
   
   c) 读取需要的列：ts_min、cpu_sum、cpu_count
      （聚合中间状态是 sketch，几十字节一行，很小）
   
   d) 每 shard 内部先做 partial GROUP BY hour
      → 减少传输量到 initiator
   
   e) 返回 24 行（每小时一行）到 initiator
   
③ initiator 合并所有 shard 的 partial 结果
④ 二次 sumMerge / countMerge 得到全局 avg
⑤ 返回 24 行给 client
```

**性能**：不用查原始 432 亿行，而是查预聚合的 `24h × 500w instance × 60min = 72 亿行` sketch → 秒级。

**Q3：某用户过去 7 天 CPU 使用率 P95/P99 → 查 1min 表**

```sql
SELECT
    toStartOfHour(ts_min) AS hour,
    quantileMerge(0.95)(cpu_quantile)   AS p95,
    quantileMerge(0.99)(cpu_quantile99) AS p99
FROM monitor.cvm_cpu_1min_all
WHERE app_id = 100012345
  AND ts_min >= now() - INTERVAL 7 DAY
GROUP BY hour;
```

**关键点**：`quantileMerge` 合并 t-digest sketch 得精确分位数。**这是普通 avg 类聚合做不到的**——分位数不能对分位数取平均。

**Q4：某地域过去 30 天月度趋势 → 查 1hour 表**

```sql
SELECT
    toStartOfDay(ts_hour) AS day,
    sumMerge(cpu_sum) / countMerge(cpu_count) AS avg_cpu
FROM monitor.cvm_cpu_1hour_all
WHERE region = 'ap-guangzhou'
  AND ts_hour >= now() - INTERVAL 30 DAY
GROUP BY day;
```

用 1hour 表：30 天 × 500w instance × 24h = 36 亿 sketch → 亚秒级。

**Q5：过去 5 分钟 CPU > 90% 的 top 100 实例 → 查明细表**

```sql
SELECT
    instance_id,
    region,
    max(cpu_usage) AS peak_cpu
FROM monitor.cvm_cpu_all
WHERE ts >= now() - INTERVAL 5 MINUTE
  AND cpu_usage > 0.9
GROUP BY instance_id, region
ORDER BY peak_cpu DESC
LIMIT 100;
```

**为什么查明细而不查 1min 表？** 5 分钟窗口 + max 需要秒级精度，1min 表已经把秒级点聚合掉了，找不出瞬时 spike。

**执行流程**：
- 分区裁剪到今天
- 5min × 500w instance × 6 次/min = 1.5 亿行 → 各 shard 分摊
- 过滤 `cpu_usage > 0.9` 通常大量筛掉（大部分实例不到 90%）
- 各 shard 内部先算 partial max + partial top100
- initiator 二次 max + 全局 top100 → 返回

### 13.5.6 完整链路总览

```
                    ┌─────────────────────────┐
                    │ CVM Agent (500w 台)      │
                    │ 每 10s 上报 CPU 使用率     │
                    └────────────┬────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │ Kafka (metric topic)     │
                    │ 30w msg/s               │
                    └────────────┬────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │ Consumer (Go)            │
                    │ 攒批 10w 行 / 5 秒        │
                    └────────────┬────────────┘
                                 │ INSERT INTO cvm_cpu_all
                                 ▼
        ┌────────────────────────────────────────────┐
        │  Distributed Table (cityHash64(instance_id))│
        └──────────┬──────────┬──────────┬───────────┘
                   │          │          │
                shard1     shard2     shardN
                   │          │          │
                   ▼          ▼          ▼
        ┌─────────────────────────────────────┐
        │ cvm_cpu_local (ReplicatedMergeTree) │  ← 明细，7 天
        │ ORDER BY (region, app_id, ins_id, ts)│
        │ bloom_filter on instance_id         │
        └──────────┬──────────────────────────┘
                   │ MV 触发
                   ▼
        ┌─────────────────────────────────────┐
        │ cvm_cpu_1min_local (Aggregating)     │  ← 分钟聚合，30 天
        │ ORDER BY (region, app_id, ins_id, ts_min)│
        │ 存 AggregateFunction sketch 状态     │
        └──────────┬──────────────────────────┘
                   │ MV2 触发
                   ▼
        ┌─────────────────────────────────────┐
        │ cvm_cpu_1hour_local (Aggregating)    │  ← 小时聚合，90 天
        └──────────┬──────────────────────────┘
                   │ MV3 触发（可选）
                   ▼
        ┌─────────────────────────────────────┐
        │ cvm_cpu_1day_local (Aggregating)     │  ← 天聚合，1 年
        └─────────────────────────────────────┘

                   ▲ 读时：
                   │
        ┌──────────┴──────────┐
        │                     │
    实时排障（1h）        大盘/长周期
    → 查明细表           → 查对应粒度聚合表
```

### 13.5.7 生产血泪教训汇总（这套架构里的坑）

1. **MV 是 push 不是 pull**：明细表回填历史数据不会自动填 MV，要手动 `INSERT INTO mv_target SELECT ... FROM 明细表`
2. **MV 抛错会让明细表也 fail**（除非 `EXCEPTION_ACTION` 显式设置）
3. **AggregateFunction 列不能直接 SELECT 查看**：`SELECT cpu_sum FROM cvm_cpu_1min_local` 返回二进制，必须 `sumMerge(cpu_sum)`
4. **副本延迟**：ReplicatedMergeTree 副本是异步复制，从副本读可能读到略旧数据（毫秒~秒级）
5. **too many parts 报警**：写入 batch 太小或分区过细都会引发，务必监控 `system.parts` 表
6. **分区键选错代价大**：改分区键 = 重建表 + 迁数据 = 停机风险
7. **bloom filter 加太多适得其反**：每次写入要更新 bloom，写放大
8. **ORDER BY 字段数不宜过多**：> 5 列稀疏索引膨胀，压缩效果变差
9. **物化视图链式依赖**：MV1 挂了 MV2 不会自动降级到明细回填，需要监控
10. **Distributed 表插入是"广播式"**：即使指定 sharding key，客户端也不能只发到目标 shard，initiator 会做拆分——**如果 initiator 挂了，重试可能重复**

### 13.5.8 面试话术：3 分钟讲清这套架构

> "以 CVM CPU 监控为例，我们的完整链路是：
>
> **写入侧**：500w CVM 每 10s 上报，通过 Kafka 攒批到 Consumer，每 5s 批量 INSERT 10w 行到 Distributed 表；Distributed 按 cityHash64(instance_id) 分片到 N 个 shard 上的 ReplicatedMergeTree local 表。每次 INSERT 落盘一个 immutable part，后台自动 merge。
>
> **存储侧**：ORDER BY (region, app_id, instance_id, ts) 按'基数从低到高'排；LowCardinality 优化 region/zone/instance_type；bloom filter 二级索引让'只知道 instance_id'的查询也能跳过大部分 granule；按天分区、7 天 TTL。
>
> **预聚合**：三层 MV 链——明细（10s，7天）→ 分钟（30天）→ 小时（90天）→ 天（1年）。用 AggregateFunction + State/Merge 存 t-digest sketch，让 P95/P99 可以跨粒度精确合并——这是普通 avg 做不到的。
>
> **查询侧**：诊断类查明细走 bloom filter；大盘类查分钟聚合走主键索引；长周期查小时/天表；实时告警要秒级精度只能扫明细。
>
> **踩过的坑**：MV push 语义导致历史回填要手动、AggregateFunction 列 SELECT 看不到值、分区键选错重建表——每个坑背后都是配置和使用姿势的教训。"

---

## §14 · 版本演进与新特性

| 版本 | 关键特性 |
|---|---|
| 19.x | Distributed / ReplicatedMergeTree 成熟 |
| 20.x | LowCardinality、Projection 雏形 |
| 21.x | Projection、Grace Hash Join 雏形、Keeper |
| 22.x | Async Insert、S3 后端、Parallel Insert Select |
| 23.x | Lightweight Delete、Analyzer、Grace Hash Join 生产可用 |
| 24.x | Vector Search 实验性、更多 SQL 兼容 |

---

## §15 · 50 问详解

### 【架构与原理】

**Q1. ClickHouse 为什么这么快？**
> 列式存储 + 向量化执行 + 稀疏索引 + LSM MergeTree + 多核并行 + 高压缩比。核心是**列式让 SIMD 生效 + 只读需要的列**。

**Q2. 列式和行式的本质区别？分别适合什么场景？**
> 行式（MySQL）：一行连续存，适合点查/事务；列式（CK）：每列独立文件，适合聚合分析，压缩比高 10x+。

**Q3. 向量化执行是什么？为什么快？**
> 每次操作处理一个 Block（8192 行）而非单行，减少函数调用，配合 SIMD 指令并行处理 → CPU cache 友好。相比火山模型快 10x+。

**Q4. MergeTree 是什么？**
> CK 核心引擎家族，LSM 变种。写入 append 生成 part，后台异步合并小 part 到大 part。写吞吐几十万行/秒。

**Q5. CK 的 primary key 和 MySQL 有什么不同？**
> ① 不唯一（可以有百万行相同 PK）② 用来排序 + 稀疏索引 ③ 每 8192 行一个索引项，索引极小放内存。

### 【索引与主键】

**Q6. 稀疏索引原理？**
> 每 `index_granularity=8192` 行一个索引项。查询时二分找 granule 范围，只读符合条件的 granule。10 亿行只有 12w 索引项可全放内存。

**Q7. 主键选择原则？**
> ① WHERE 常用列 ② 低基数在前（如 tenant_id）③ 时间列常在后 ④ 3~5 列足够。

**Q8. 什么是跳数索引？**
> 二级索引，每 N 个 granule 一个统计（bloom/minmax/set）。**只能过滤 granule，不精确到行**。用于加速非主键列的过滤。

**Q9. ORDER BY 和 PRIMARY KEY 什么关系？**
> ORDER BY 决定物理排序，PK 决定稀疏索引列。默认 PK = ORDER BY 全部。PK 可以是 ORDER BY 前缀（减少索引大小）。

**Q10. 主键为什么可以不唯一？**
> CK 不做唯一性校验（去重要用 ReplacingMergeTree）。PK 只是排序和跳数用的。这是 OLAP 场景下的性能选择。

### 【分区】

**Q11. 分区的作用？**
> ① 物理隔离 ② 快速 DROP PARTITION ③ 查询裁剪 ④ TTL 管理 ⑤ 副本粒度。

**Q12. 分区应该怎么选？**
> 按月最常见（`toYYYYMM(ts)`），按天用于大规模。**不要按小时**（分区数爆炸元数据慢）。经验：单表 <1000 个分区，单分区 100GB~1TB。

**Q13. 分区裁剪何时生效？**
> WHERE 有分区键（可推导）时。例如 `WHERE ts > '2024-06-01'` 会自动裁剪掉 202405 之前的分区。

### 【压缩与类型】

**Q14. CK 的默认压缩是什么？为什么快？**
> LZ4（快压缩解压）。同列类型一致 + 相邻值相关 → 压缩比 10~30x。生产热存推荐 ZSTD(1)。

**Q15. LowCardinality 是什么？**
> 字段值 <1w 种时用字典编码（值→小整数）。**压缩 5~10x，查询快 3x+**。典型：service_name / status_code / region。

**Q16. Delta / DoubleDelta / Gorilla 编码分别用于什么？**
> Delta：递增字段（seq_id）；DoubleDelta：时间戳（变化率低）；Gorilla：浮点时序值（Facebook 论文）。均需再套 LZ4/ZSTD。

**Q17. Nullable 有什么代价？**
> 额外的 null 位图文件，压缩率下降，查询慢。**尽量不用**，用哨兵值代替（0/-1/空字符串）。

### 【副本与分片】

**Q18. 副本和分片的区别？**
> 副本：同数据多机备份，读扩展 + 高可用；分片：数据切分到多机，写扩展 + 存储扩容。**生产同时用**：4 分片 × 2 副本 = 8 机。

**Q19. ReplicatedMergeTree 是怎么同步的？**
> ZooKeeper/Keeper 存元数据 → 写入副本注册新 part → 其他副本感知拉取。**实际数据不走 ZK**。

**Q20. insert_quorum 是什么？**
> 写入等 N 个副本 ACK 才返回。默认 0（异步）。生产可设 2 保证不丢，代价是延迟增加。

**Q21. Distributed 表工作原理？**
> 路由层，本身不存数据。查询转发到各分片本地表并行执行 → 结果合并。写入按 sharding key 路由到目标分片。

**Q22. ClickHouse Keeper 相比 ZooKeeper 优势？**
> C++ 实现内存开销小 5x、无 GC 抖动、协议兼容 ZK、专为 CK 优化。**新集群直接用 Keeper**。

### 【物化视图与 Projection】

**Q23. 物化视图 vs 普通视图？**
> 物化视图是**触发器**：insert 源表时自动计算并写目标表；普通视图是查询时展开 SQL（临时结果）。

**Q24. 物化视图的坑？**
> ① 存量数据不自动 backfill（要手动 INSERT INTO mv SELECT）② MV 内部错误可能导致源表写入失败（22.x 后可配置隔离）③ MV 是链式的，多层 MV 依赖复杂难维护。

**Q25. AggregatingMergeTree + MV 怎么用？**
> MV 里用 `-State` 后缀函数（`countState() / quantileState()`）生成中间状态，查询时用 `-Merge` 合并。允许跨行、跨粒度再聚合，是 CK 最强预聚合方案。

**Q26. Projection 和 MV 区别？**
> Projection 是表内隐藏物化，优化器自动选择；MV 是独立目标表，需要显式查。Projection 只能同表，MV 可以跨表 + 复杂 pipeline。

### 【常用引擎】

**Q27. ReplacingMergeTree 什么时候用？**
> CDC 同步（binlog）场景，相同 PK 的行 merge 时保留最新。**注意**：只在 merge 时去重，未 merge 时查询有重复 → 查询加 `FINAL` 或用 `argMax`。

**Q28. FINAL 关键字的代价？**
> 强制读取所有可能的重复行做归并 → **单表查询慢 5~10 倍**。生产避免用，改用 `argMax` 或维护结果表。

**Q29. SummingMergeTree 和 AggregatingMergeTree 区别？**
> Summing 只自动 SUM 数值列，简单；Aggregating 支持任意聚合函数（quantile/uniq/count）通过 State/Merge 中间状态。

**Q30. CollapsingMergeTree 怎么用？**
> `sign` 列标记 +1 插入 / -1 删除，merge 时正负抵消。**要求成对出现**，否则查询要 `GROUP BY ... HAVING sum(sign) > 0`。

### 【写入与更新】

**Q31. CK 为什么建议 batch 写入？**
> 每次写生成一个 part，小 part 泛滥会触发 `Too many parts` 错误（默认 100 个）。建议 1000~10w 行一批，10s 一次。

**Q32. 太多 part 报错怎么办？**
> ① 加大 batch size ② 减少 partition 粒度 ③ 提高 `parts_to_delay_insert / parts_to_throw_insert` ④ 手动 OPTIMIZE（不推荐）。

**Q33. Async Insert 是什么？**
> 22.x+，多客户端小 batch → CK 服务端缓冲合并成大 batch → 一次落盘。适合小写入密集场景。

**Q34. Update / Delete 怎么实现的？**
> 通过 mutation（异步重写整个 part）实现，代价高。23.3+ 支持 lightweight delete（位图标记），查询时过滤，快得多。

**Q35. CK 有事务吗？**
> 只有 part 级别原子性（单次 insert 生成一个 part 原子写入 or 失败）。**无 ACID 事务**。24.x 有实验性 MVCC 事务但生产别用。

### 【查询与优化】

**Q36. 慢查询怎么排查？**
> `system.query_log` 查历史，`EXPLAIN` / `EXPLAIN PIPELINE` 看执行计划。`SET send_logs_level = 'trace'` 打详细日志。

**Q37. 常见查询优化手段？**
> ① WHERE 命中主键 ② 分区裁剪 ③ 只 SELECT 需要列 ④ LowCardinality ⑤ PREWHERE ⑥ 物化视图预聚合 ⑦ 避免 SELECT *。

**Q38. PREWHERE 和 WHERE 区别？**
> PREWHERE 先过滤 → 再读取其他列（减少 IO）；WHERE 读全部列后过滤。CK 会自动优化，但复杂查询可以手动写 PREWHERE。

**Q39. JOIN 慢怎么办？**
> ① 小表放右（默认 hash join，右表进内存）② 用 Dictionary 代替维表 JOIN ③ 用 IN 子查询代替 JOIN ④ 开 grace hash join（23.x 生产可用）。

**Q40. Dictionary 是什么？**
> 内存中的键值映射，可以从 MySQL/CK/HTTP 等加载。**代替维表 JOIN**：`dictGet('dict_name', 'attr', key)` O(1) 查找。

### 【运维】

**Q41. Too many parts 怎么处理？**
> 加大 batch、减小分区粒度、允许更多 part（不推荐无限提高）、检查是否有 mutation 阻塞 merge。

**Q42. ZooKeeper session expired 怎么办？**
> 副本读写会 hang。检查 ZK 集群状态、网络、增加 `session_timeout`、迁移到 Keeper。

**Q43. 磁盘满了怎么办？**
> ① DROP PARTITION 老数据 ② TTL 自动过期 ③ 冷存策略（`TO VOLUME`）迁到便宜存储/S3 ④ 扩容。

**Q44. 单查询 OOM 怎么办？**
> 提高 `max_memory_usage` 或降低查询复杂度：分批 GROUP BY、聚合下推、用 MV 预聚合。

**Q45. CK 集群扩容怎么做？**
> ① 加新分片，改 cluster 配置 ② 重新分布数据（`clickhouse-copier` 或按分区 detach+attach）③ 应用侧改分片路由。**没有自动 rebalance**。

### 【场景选型】

**Q46. CK vs MySQL？**
> CK OLAP（分析聚合），MySQL OLTP（事务点查）。CK 无事务、无 UPDATE/DELETE 常用场景，MySQL 无 PB 级、无极致压缩。**互补而非替代**。

**Q47. CK vs Elasticsearch？**
> ES 全文检索 + 聚合，倒排索引 + 段合并；CK 结构化分析 + 列式压缩。**日志用 ES 检索灵活，CK 存储成本低查聚合快**。近两年 CK 抢了 ES 大量日志市场。

**Q48. CK vs VictoriaMetrics？**
> VM 低基数时序 + PromQL 生态；CK 高基数明细 + SQL 灵活。TCUM 生产两者并存：核心指标 VM，明细/高基数走 CK。

**Q49. CK vs Druid / Doris？**
> Druid 实时摄入 + 预聚合，但架构复杂（多角色）；Doris 兼容 MySQL 协议 + 更好的高并发点查；CK 单机极致性能 + 部署简单。**CK 分析场景王者**。

**Q50. CK 适合日志场景吗？**
> **非常适合**。列式压缩 10~30x（比 ES 便宜 5x），SQL 灵活，聚合快。**弱点**：全文检索不如 ES，tokenbf 跳数索引只能做粗过滤。

### 【补充深度题】

**Q51. index_granularity=8192 为什么是这个值？**
> 平衡索引大小和跳读粒度：太小索引占内存大，太大范围扫描浪费。8192 是 CK 团队经验值，适合大多数场景。可调但不建议。

**Q52. CK 的 MV 和 Kafka 是什么关系？**
> Kafka 引擎表 + MV 是经典组合：Kafka 表消费消息 → MV 触发 → 写入 MergeTree 存储。**流式入湖标配**。

**Q53. CK Trace 场景怎么设计表？**
> ORDER BY (service, ts)：按服务聚簇，同服务时间连续。加 `bloom_filter` 索引到 trace_id 支持 O(1) 找 trace。冷数据 TTL 7~30 天到 S3。

**Q54. 分片键选错了怎么补救？**
> 建新表新 sharding key → 用 clickhouse-copier 或 INSERT SELECT 迁移 → 切流量。**很痛，选错代价大**。

**Q55. CK 怎么实现高可用？**
> 每分片 2~3 副本 ReplicatedMergeTree + Keeper。客户端配置多个入口地址（LB 或应用侧路由）。单副本故障不影响服务。

---

## §16 · 短板与坑

1. **无 ACID / 无强事务**：并发写入依赖 part 级原子性
2. **UPDATE / DELETE 慢**：mutation 重写 part，避免频繁改
3. **JOIN 弱**：右表放不下内存直接 OOM（虽然 grace hash 改善）
4. **高并发点查差**：单查询占大量 CPU，不是设计给 QPS 1w+ 的
5. **写入 batch 要求**：小 batch 泛滥 too many parts
6. **物化视图学习曲线陡**：State/Merge 概念、链式 MV
7. **分片扩容不自动**：需手动迁数据
8. **元数据依赖 ZK/Keeper**：ZK 故障影响副本写入
9. **备份工具弱**：clickhouse-backup 第三方为主
10. **文档/生态不如 MySQL**：中文资料参差不齐

---

## §17 · 面试话术模板

### 3 分钟自述

> "我在 TCUM 监控体系里深度使用 ClickHouse：SLO 分钟级预聚合、Trace/APM 明细、高基数时序补充 VM 的短板，日写入几百亿行，单表几万亿。
>
> **对 CK 最深三点理解**：
> - **列式 + 向量化 + 稀疏索引是快的三驾马车**：列式让 SIMD 生效和高压缩，向量化每次处理 8192 行 batch，稀疏索引让主键上的范围扫描不用查每行。
> - **MergeTree + MV 是设计核心**：LSM 风格保证写吞吐几十万行/秒，MV 通过 AggregateFunction State/Merge 实现跨粒度预聚合。SLO 场景我们做了 1min/5min/1hour 三层 MV 链，查询自动选粒度。
> - **CK 和 VM 是互补不是替代**：VM 强在低基数时序 + PromQL 生态，CK 强在高基数明细 + SQL 灵活 + 长期归档。TCUM 里两者并存。
>
> **生产血泪**：分片键选错迁数据两周、mutation 卡住 merge、too many parts 全线报警、深 JOIN OOM——每一个都是设计和使用姿势的教训。"

### 反问 5 问

1. CK 版本？23.x 还是 24.x？MV 和 Projection 都用了吗？
2. 副本 + 分片架构？用 ZK 还是 Keeper？
3. 主要查询模式：点查还是聚合？高并发点查怎么应对？
4. 慢查询和 too many parts 监控？
5. 冷热存储策略？TTL 到 S3 / HDFS 吗？

---

**本篇完 · 约 27KB · 覆盖列式/向量化/MergeTree/索引/分区/副本/分片/MV/引擎/优化/55 问**

**证据基线**：
- ClickHouse 官方文档：https://clickhouse.com/docs
- Altinity Knowledge Base（生产实战最佳实践）
- 生产实战：TCUM SLO 三层 MV 链、Trace 明细存储、高基数时序补 VM
- 阿里/字节生产 CK 集群规模：单集群百 PB
