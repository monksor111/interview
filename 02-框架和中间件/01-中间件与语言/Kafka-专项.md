# 第五卷 · 中间件 · Kafka 专项

> **本篇定位**：Kafka 是 TCUM 数据面的**核心消息总线** —— 承担监控/告警数据流（metric-filter → kafka → 存储链路）、CMDB 变更事件（增量同步）、审计流、异步解耦、削峰。本文覆盖架构、Producer/Consumer/Broker 内幕、日志存储、副本 ISR、Rebalance、幂等 + 事务、Kafka Streams、Connect、Zookeeper vs KRaft、生产实战、60+ 高频面试题。密度对齐 `tcum-ai/01`。

## 📖 目录
- §1 命题：Kafka 为什么是分布式消息总线王
- §2 架构：Broker / Topic / Partition / Replica / Producer / Consumer
- §3 日志存储：Segment / Index / 稀疏索引
- §4 副本机制：Leader / Follower / ISR / OSR / HW / LEO
- §5 Producer：分区器 / batch / acks / 幂等 / 事务
- §6 Consumer：Group / Offset / Rebalance / Sticky
- §7 消息可靠性：At Most Once / At Least Once / Exactly Once
- §8 顺序性保证
- §9 高性能秘密：零拷贝、顺序 IO、page cache、批量、压缩
- §10 Controller / Zookeeper / KRaft
- §11 Rebalance 详解与优化
- §12 Kafka Streams、Connect、KSQL 简介
- §13 生产实战：TCUM 中的 Kafka 使用
- §14 版本演进 + 新特性
- §15 60 问详解
- §16 短板与坑
- §17 面试话术

---

## §1 · 命题：Kafka 为什么是分布式消息总线王

### 一句话背诵

> "Kafka 用**分布式日志（distributed log）+ 顺序 IO + 零拷贝 + 分区并行 + 副本 ISR 强一致 + Consumer Group 消费模型**定义了流式消息中间件标准，成为大数据/云原生数据管道事实标准。它不是队列（不擅长任务派发），是**日志**（擅长广播 + 回溯 + 高吞吐）。"

### 六大能力

1. **超高吞吐**：单 Broker 百万条/秒（顺序写 + 批量 + 零拷贝）
2. **持久化 + 回溯**：默认保留 7 天，可 rewind 到任意 offset
3. **分区并行**：Topic 内多 Partition，Consumer Group 内成员并行消费
4. **副本高可用**：ISR 多副本，Leader 挂了从 ISR 选新 Leader
5. **强顺序性**：单 Partition 内消息严格有序
6. **生态丰富**：Streams / Connect / Schema Registry / Debezium / Flink 集成

### 边界代价（重要）

- **不擅长任务派发**（RocketMQ / RabbitMQ 更好）：无优先级、无延时、无回溯到特定消息
- **Consumer 分区数 = 并发上限**：分区多了 Rebalance 慢
- **无消息级重试**（要业务重试或死信）
- **不擅长小消息 + 高频**：批量 overhead
- **Rebalance 抖动**：Consumer 增减触发暂停消费

---

## §2 · 架构

### 概念对照

```
Cluster
├── Broker 1  ── Partition 0 Leader (Topic A)
│              ── Partition 1 Follower (Topic A)
├── Broker 2  ── Partition 0 Follower (Topic A)
│              ── Partition 1 Leader (Topic A)
└── Broker 3  ── ...

Producer → Topic A → 按 partitioner 路由到 Partition
Consumer Group G1 → 每 Partition 至多分给一个 member
```

### 概念

- **Broker**：单个 Kafka 进程 / 节点
- **Topic**：逻辑消息类别
- **Partition**：Topic 物理切分单位，一个 Partition = 一个日志文件
- **Replica**：Partition 的副本，一个 Leader + N 个 Follower
- **Offset**：Partition 内消息的序号
- **Consumer Group**：消费者组，Group 内成员分摊 Partition
- **Coordinator**：Group Coordinator 负责 Rebalance；Cluster Controller 负责元数据

---

## §3 · 日志存储

### 3.1 分层结构

```
topic-{n}/                          # 分区目录
├── 00000000000000000000.log       # Log Segment（消息数据）
├── 00000000000000000000.index     # 偏移量索引（稀疏）
├── 00000000000000000000.timeindex # 时间戳索引
├── 00000000000000001000.log       # 下一个 Segment（滚动）
├── 00000000000000001000.index
├── 00000000000000001000.timeindex
├── leader-epoch-checkpoint         # Leader 纪元
└── partition.metadata
```

### 3.2 Segment 滚动

- 触发条件：
  - 单 segment 大小 `log.segment.bytes=1GB`
  - 时间 `log.roll.hours=168`（7 天）
- 新 segment 命名：起始 offset 十进制补零 20 位

### 3.3 稀疏索引

- `.index` 每 4KB 消息一个索引项 → `(相对 offset, 物理位置)`
- 每 segment 索引 mmap 到内存
- **查找 offset X**：二分找 index → 定位到近似位置 → 顺序扫 .log 找精确 offset

**面试点**：为什么稀疏？密集索引会占大量内存；稀疏索引结合顺序扫（磁盘顺序 IO 极快）性价比最高。

### 3.4 时间索引

- `.timeindex` 按时间戳定位消息
- 用于按时间消费（`seek by timestamp`）

### 3.5 日志清理策略

**delete**（默认）：过期删除
- `log.retention.hours=168` 7 天
- `log.retention.bytes` 按大小

**compact**：日志压缩
- 相同 key 只保留最新
- 用于 KTable 场景（配置 / 用户状态）
- 保留最新一份，可无限时间

**delete + compact 混合**（KRaft 场景）

---

## §4 · 副本机制

### 4.1 术语

- **AR（Assigned Replicas）**：所有副本
- **ISR（In-Sync Replicas）**：与 Leader 同步的副本集
- **OSR（Out-of-Sync Replicas）**：落后 Leader 太多，被踢出 ISR
- **HW（High Watermark）**：**已被所有 ISR 复制的最高 offset** → Consumer 只能读到 HW 之前
- **LEO（Log End Offset）**：Leader 的下一条消息位置
- **Leader Epoch**：Leader 任期编号

### 4.2 ISR 动态维护（核心机制）

#### 4.2.1 ISR 是什么

**ISR（In-Sync Replicas）= 与 Leader 保持同步的副本集合**，是一个**动态集合**，不是固定不变的。Follower 跟得上就留在 ISR 里，跟不上就被踢出去（进 OSR），追上了再回来。

```
AR（Assigned Replicas）= 所有副本（创建时就定死的 N 个）
  ├── ISR（In-Sync）= 跟得上的副本（动态，可能 < N）
  │     └── 参与 acks=all 的确认、有资格被选为新 Leader
  └── OSR（Out-of-Sync）= 落后的副本（动态）
        └── 不参与确认、不能选为新 Leader（除非 unclean）
```

#### 4.2.2 为什么要有 ISR：同步 vs 异步的折中

Kafka 之前的分布式系统面临一个两难：

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **全同步复制** | 写等所有副本 ACK | 数据最安全 | 任一副本慢/挂 → 整个分区写不进去 |
| **纯异步复制** | 只写 Leader，不等副本 | 性能最好 | Leader 挂 → 未复制数据全丢 |
| **ISR（Kafka 方案）** | 写等「跟得上的副本」ACK | 兼顾性能与安全 | 需动态维护 ISR 集合 |

**核心思想**：不需要所有副本都同步，只需要「**足够新、足够快**」的副本。一个副本偶尔慢一点没关系，慢到「跟不上」就暂时踢出 ISR，等它追上再加回来。这样写延迟只受 ISR 内副本影响，而不是被最慢的副本拖死。

#### 4.2.3 怎么判断「跟得上」：两个维度

Kafka 用**时间维度**判断（条数维度已废弃）：

- **`replica.lag.time.max.ms`（默认 30s，现行标准）**
  - 判断的是「Follower 多久没完全跟上 Leader」
  - 超过这个时间还没把 Leader 的 LEO 追平 → 踢出 ISR

- **`replica.lag.max.messages`（0.9 之前，已废弃）**
  - 判断的是「Follower 落后多少条消息」
  - **废弃原因**：突发流量下，即使 Follower 健康，条数 lag 也会瞬间暴涨 → 误踢 → ISR 抖动。时间维度更稳定。

#### 4.2.4 踢出（Shrink）流程

```
Follower 每 fetch 请求都会带自己的 LEO
      │
      ▼
Leader 检查：follower.LEO 是否 >= leader.LEO（即是否完全跟上）？
      │
      ├─ 是 → 更新该 follower 的 lastCaughtUpTimeMs = now（刷新时间戳）
      │
      └─ 否 → 检查 lastCaughtUpTimeMs 距今是否 > replica.lag.time.max.ms（30s）？
                │
                ├─ 否 → 还在宽限期内，暂时保留在 ISR
                └─ 是 → 踢出 ISR，进入 OSR
                         │
                         ▼
                   Controller 感知 ISR 变化 → 更新元数据（ZK / KRaft）→ 通知所有 Broker
```

**关键点**：
- 判断是**时间维度**，不是「落后 N 条」——Follower 慢一点没关系，慢超过 30s 才踢
- ISR 收缩是**异步**的，由 Leader 在收到 fetch 时惰性判断（不是定时器轮询）

#### 4.2.5 加入（Expand）流程

```
Follower 继续 fetch，LEO 不断逼近 Leader
      │
      ▼
follower.LEO >= leader.LEO（完全追平）
      │
      ▼
Leader 把它重新拉回 ISR
      │
      ▼
Controller 感知 ISR 扩张 → 更新元数据 → 通知所有 Broker
```

**关键点**：
- 追上「**Leader 的 LEO**」才算完全同步，才会加回 ISR
- 如果只是追上 HW 但没追平 LEO，仍在 OSR（因为可能还有未提交数据没复制）

#### 4.2.6 ISR 变化为什么重要

ISR 集合的每一次收缩/扩张都直接影响三件事：

1. **写可用性**：`acks=all` 时，ISR 数量 < `min.insync.replicas` → 写入报错
2. **读可见性**：HW = min(所有 ISR 的 LEO)，ISR 变化会推动 HW 前进或停滞
3. **故障切换候选**：Leader 挂了只能从 ISR 里选新 Leader

所以 ISR 是 Kafka 一致性的**中枢**，理解 ISR 就理解了 Kafka 的可靠性模型。

---

### 4.3 HW 和 LEO

#### 4.3.1 两个 offset 的定义

- **LEO（Log End Offset）**：**每个副本自己**的下一条消息位置（该副本已写入的最后一条消息 + 1）
  - Leader 有 Leader 的 LEO，Follower 有 Follower 的 LEO，各算各的
- **HW（High Watermark，高水位）**：**已被所有 ISR 副本复制的最高 offset**
  - 由 Leader 计算并维护：`HW = min(所有 ISR 副本的 LEO)`
  - **Consumer 只能读到 HW 之前**（含 HW 位置之前的消息）

```
Leader Log:    [msg0][msg1][msg2][msg3][msg4]
                                  ↑     ↑
                                  HW    LEO
Follower1:     [msg0][msg1][msg2][msg3]     ← LEO = msg4 位置
Follower2:     [msg0][msg1][msg2]           ← LEO = msg3 位置（最慢的 ISR）
```

**HW = min(ISR 的 LEO) = min(msg4位置, msg3位置) = msg2 位置** → Consumer 只能读到 msg2（msg0~msg2）

#### 4.3.2 为什么 HW 取「ISR 的 min」而不是「所有副本的 min」

这是理解 ISR 价值的**关键**。对比一下：

| 取法 | 后果 |
|---|---|
| `min(所有副本 LEO)` | 最慢的 OSR 副本会**卡死 HW** → 消费者永远读不到新数据 → 不可接受 |
| `min(ISR 的 LEO)`（Kafka 实际） | 只看「跟得上的副本」，落后的 OSR 不影响 HW 前进 |

**本质**：HW 表示「**这条消息已经被足够多（ISR 内全部）副本持久化了**」。OSR 里的副本已经「跟不上」，Kafka 认为不需要等它——反正 Leader 挂了也不会选它当新 Leader。所以 HW 只跟 ISR 走。

#### 4.3.3 HW 存在的意义：防止读到「可能丢失」的数据

假设没有 HW，Consumer 直接读 Leader 的 LEO：

```
1. Producer 写 msg4 → Leader 写成功（LEO 推进到 msg5 位置）
2. Consumer 读到 msg4                       ← 读到了！
3. 此时 Leader 挂了，msg4 还没复制到任何 Follower
4. 新 Leader（Follower）没有 msg4
5. Consumer 读到的 msg4 永远消失了          ← 数据丢失！
```

有了 HW：
- msg4 写入后，要等 **ISR 内所有 Follower 都复制了 msg4**，HW 才会推进到 msg4
- Consumer 只能读到 HW 之前 → **保证读到的每一条消息都已经被 ISR 副本持久化** → Leader 挂了数据也不会丢

#### 4.3.4 HW 与 ISR 的联动（一张图看懂）

```
时刻 T0：ISR = {Leader, F1, F2}，三副本 LEO 都 = msg2
        Leader: [m0][m1][m2]  LEO=m3  HW=m3

时刻 T1：Producer 写 m3、m4 → Leader LEO 推进到 m5
        Leader: [m0][m1][m2][m3][m4]  LEO=m5  HW=m3（还停在 m3！）
        F1:     [m0][m1][m2]          LEO=m3
        F2:     [m0][m1][m2]          LEO=m3
        → Consumer 仍只能读到 m0~m2（m3/m4 还未复制，不可见）

时刻 T2：F1、F2 fetch 到 m3、m4
        F1:     [m0][m1][m2][m3][m4]  LEO=m5
        F2:     [m0][m1][m2][m3][m4]  LEO=m5
        → HW = min(m5, m5, m5) = m5 推进！
        → Consumer 现在能读到 m0~m4
```

**结论**：HW 的推进是「**复制完成**」的信号，不是「写入完成」的信号。这也是为什么 `acks=1` 时即使消息写进 Leader 了，只要还没被 ISR 复制，Consumer 就还读不到——**写入返回 ≠ 可被消费**。

---

### 4.4 Leader 选举

- **AR 中在 ISR 里的第一个副本**
- 若 ISR 空：`unclean.leader.election.enable=false`（默认）→ 分区不可用；`=true` → 从 OSR 选，**可能丢数据**

### 4.5 unclean 选举的取舍

- **false**（生产默认）：一致性优先，可用性牺牲
- **true**：可用性优先，可能丢数据

### 4.6 min.insync.replicas + acks=all（ISR 的强一致保底）

**这套组合是 Kafka 生产环境的「不丢数据」铁律**。它和 ISR 强绑定：

#### 4.6.1 三个参数怎么配合

```
acks = all                      ← Producer 侧：等「所有 ISR 副本」都确认才返回
min.insync.replicas = 2         ← Broker 侧：ISR 副本数的最低门槛
replication.factor = 3          ← 建 topic 时的总副本数
```

**写入时的判定流程**：

```
Producer 发消息
      │
      ▼
Leader 检查：当前 ISR 数量 >= min.insync.replicas 吗？
      │
      ├─ 是 → 写入，等 ISR 内所有副本 ACK → 返回成功
      │
      └─ 否 → 直接拒绝，Producer 抛 NotEnoughReplicasException
              （注意：不是写入失败，是根本没写进去）
```

#### 4.6.2 为什么需要 min.insync.replicas（光有 acks=all 不够）

关键洞察：**`acks=all` 的「所有」是「当前 ISR 里的所有」，不是「全部副本」**。

- 如果只有 `acks=all`，没有 `min.insync.replicas`：
  - ISR 收缩到只剩 Leader 1 个时，`acks=all` 变成「等 Leader 1 个 ACK」≈ `acks=1`
  - Leader 写完返回成功，紧接着 Leader 挂了 → **数据丢**（没有副本了）
- 加上 `min.insync.replicas=2`：
  - ISR 只剩 1 个时，**直接拒绝写入**
  - 从根源上避免「写进一个孤零零的 Leader 然后它挂了」的丢数据场景

#### 4.6.3 ISR 收缩如何触发拒写（完整时间线）

```
初始：3 副本，ISR = {Leader, F1, F2}，min.insync.replicas=2
  → acks=all 写入正常（等 Leader+F1+F2 都 ACK）

F2 宕机/网络隔离：
  → F2 超过 replica.lag.time.max.ms=30s 没跟上
  → 被踢出 ISR，ISR = {Leader, F1}
  → 还有 2 个 ISR >= min.insync.replicas=2
  → 写入仍正常（但此时只允许再挂 1 个）

F1 也宕机：
  → ISR = {Leader}，只有 1 个 < min.insync.replicas=2
  → 写入被拒绝，Producer 收到 NotEnoughReplicasException
  → 【关键时刻】：宁可不可写，也不写进孤 Leader 冒丢数据风险
```

**这就是 ISR + min.insync.replicas 的完整价值**：用「**拒绝写入**」来换取「**绝不丢已提交数据**」。

#### 4.6.4 副本数、min.insync、可容忍故障数对照表

| replication.factor | min.insync.replicas | 可容忍故障副本数 | 说明 |
|---|---|---|---|
| 1 | 1 | 0 | 无冗余，Leader 挂即丢 |
| 2 | 1 | 1 | 可挂 1 个，但挂后只剩 Leader 时仍在写（有丢风险） |
| 2 | 2 | 0 | 挂任 1 个就拒写（太保守） |
| 3 | 2 | **1** | ✅ **生产标配**：可挂 1 个，且永远至少 2 副本确认 |
| 5 | 3 | 2 | 可挂 2 个，适合更高可用要求 |

**经验公式**：`min.insync.replicas = (replication.factor / 2) + 1`（多数派），3 副本取 2 就是典型。

#### 4.6.5 一个常见误区

> ❌ 误区：「acks=all 就是写进所有 3 个副本」
> ✅ 真相：「acks=all 是写进**当前 ISR 里的所有副本**」。如果 ISR 已经收缩到 2 个，那就是写进 2 个；收缩到 1 个（且没配 min.insync），那就只写进 Leader 1 个。

**所以面试时说「acks=all 不丢数据」是错的**，准确说法是：

> 「`acks=all` + `min.insync.replicas=2` + `replication.factor=3` 这套组合才保证不丢——缺一不可。`acks=all` 决定『等几个副本』，`min.insync.replicas` 决定『副本不够时拒写』，两者配合才能在 ISR 收缩的极端情况下兜住一致性。」

---

## §5 · Producer

### 5.1 发送流程

1. Serializer 序列化 key/value
2. **Partitioner** 计算目标分区
3. **RecordAccumulator**：按分区聚合成 batch
4. **Sender 线程**：把满 batch 发送到 Broker
5. Broker 写入 log + 同步副本 + 返回 ACK

### 5.2 Partitioner

- **指定 key**：`hash(key) % partitions`
- **未指定 key**：
  - 老版：round-robin 轮询
  - 2.4+：**sticky partitioner**（同 batch 内消息集中一个分区 → batch 更大 → 性能好）
- **自定义**：实现 `Partitioner` 接口（如按业务 hash）

### 5.3 acks 三种

- **acks=0**：发就完事不等确认（**丢数据风险**，日志采集允许）
- **acks=1**：Leader 写完就返回（Leader 挂了 Follower 没跟上会丢）
- **acks=all**（等价 -1）：**所有 ISR** 确认（配 min.insync.replicas=2 强一致）

### 5.4 batch 参数

- `batch.size=16KB` 单分区单 batch 大小
- `linger.ms=0` 攒批等待时间（>0 增加 batch 减少请求数）
- **调优**：`batch.size=100KB` + `linger.ms=10~50ms` → 吞吐提升 5x+，延迟增加 10ms

### 5.5 幂等 Producer

- `enable.idempotence=true`
- Producer 分配 **PID + sequence number**
- Broker 按 (PID, partition, seq) 去重
- **单分区内幂等**：网络重试不产生重复

**注意**：跨分区 / 跨会话不幂等（幂等 PID 会重置）。

### 5.6 事务 Producer

- `transactional.id=xxx`
- **跨分区原子写**：多分区的消息要么都写要么都不写
- **典型场景**：Consume → Process → Produce 的 exactly-once

**事务提交 2PC**：
1. Producer 向 Transaction Coordinator 注册事务
2. 发消息到各分区（各分区数据标记事务 ID + 未提交）
3. Producer 发 COMMIT/ABORT
4. Coordinator 写事务 log + 通知各分区
5. Consumer 只读 `isolation.level=read_committed` 已提交的

### 5.7 压缩

- `compression.type=gzip/snappy/lz4/zstd`
- **推荐 lz4 或 zstd**（zstd 压缩率高 20%，CPU 开销可接受）
- Broker 端保持压缩（不解压再压）→ 从 Producer 到 Consumer 全程压缩省带宽

---

## §6 · Consumer

### 6.1 Consumer Group 模型

- Group 内成员分摊 Topic 的 Partition
- **一个 Partition 至多分给一个 member**
- **Group 内并发上限 = Partition 数**
- 不同 Group 独立消费（发布订阅）

### 6.2 Offset 管理

- **旧版**：offset 存 ZooKeeper（性能差）
- **新版（0.9+）**：offset 存内部 topic `__consumer_offsets`
- **自动提交** `enable.auto.commit=true`（默认 5s）：**可能重复消费**
- **手动提交**：`commitSync()` / `commitAsync()`

### 6.3 消费流程

```java
while (true) {
    ConsumerRecords<K,V> records = consumer.poll(Duration.ofSeconds(1));
    for (record : records) {
        process(record);
    }
    consumer.commitSync();  // 处理完再提交
}
```

**注意**：处理与提交的原子性影响 Exactly Once。

### 6.4 Rebalance

**触发条件**：
- Group 成员变化（加入/离开）
- 订阅的 Topic 分区数变化
- 心跳超时 `session.timeout.ms=45s`（3.0+）

**过程**：
1. Coordinator 收到成员变更
2. 停止所有 member 消费（**STW**）
3. 选 Group Leader（member）
4. Leader 分配分区
5. Coordinator 广播新分配
6. member 恢复消费

**Rebalance 是 Kafka 消费的最大痛点**：期间**所有 Consumer 停止消费**，可能几秒到几十秒。

### 6.5 分区分配策略

- **RangeAssignor**（默认）：按范围，不均匀
- **RoundRobinAssignor**：轮询，均匀
- **StickyAssignor**：粘性，Rebalance 时尽量保留原分配
- **CooperativeStickyAssignor**（2.4+）：**增量再平衡**，只调整变化的分区，其他继续消费

**生产推荐 CooperativeStickyAssignor**：消除 STW。

### 6.6 max.poll.interval.ms

- 默认 5 分钟
- **两次 poll() 间隔超过这个 → 认为 Consumer 挂了 → 触发 Rebalance**
- **业务处理慢 = Rebalance 频发**
- 解法：调大 `max.poll.interval.ms` 或减小 `max.poll.records`

---

## §7 · 消息可靠性

### 7.1 At Most Once（最多一次）

- Consumer poll 完立即提交 offset，再处理
- 处理失败消息丢

### 7.2 At Least Once（至少一次，默认）

- Consumer 处理完再提交
- 处理成功但提交前挂 → 重启后重复消费
- **要求业务幂等**

### 7.3 Exactly Once（精确一次）

**场景 1 · Producer → Broker**：
- `enable.idempotence=true` 单分区幂等
- `transactional.id` 跨分区事务

**场景 2 · Consume → Process → Produce**（流处理典型）：
- Consumer 处理 + 发送新消息 + 提交 offset **在一个事务里**
- `sendOffsetsToTransaction(offsets)` 把 offset 提交作为事务一部分
- **Kafka Streams / Flink Kafka connector** 默认这么做

**场景 3 · Consume → 写外部系统**：
- Kafka 事务无法覆盖外部系统
- 需要业务层 **幂等 key + 去重表** 或 **Two-Phase Commit + 外部 XA**

**面试深度**：
> "Kafka 的 Exactly Once 只在 Kafka 内闭环有效。写数据库 / Redis / HDFS 时都要业务侧幂等——**这是分布式系统的根本约束，不是 Kafka 的锅**。"

---

## §8 · 顺序性保证

### 单分区顺序

- **同分区内消息严格有序**（Producer 单线程 + Broker 顺序 append + Consumer 单线程消费）
- **Producer 需要 `max.in.flight.requests.per.connection=1`** 才能保证重试不乱序（幂等 Producer 无需）

### 跨分区无序

- 多分区并行，跨分区无序
- **同 key 同分区**（相同 hash）能保证同 key 有序 → 业务用 key 分组

### 消费端保序

- 单 Partition 单线程处理 → 顺序保证
- 多线程处理 → 需要业务侧再分片（同 key 到同线程）

---

## §9 · 高性能秘密

### 9.1 顺序 IO

- 消息追加写日志文件 → 磁盘顺序 IO
- 顺序 IO 是随机 IO 的 **100~1000 倍性能**（HDD 更明显，SSD 也有 3~5x）

### 9.2 零拷贝（sendfile）

- 传统流程：磁盘 → 内核 pagecache → 用户 buffer → socket buffer → 网卡
- 零拷贝：磁盘 → 内核 pagecache → 网卡（**跳过用户空间**）
- **减少 2 次数据拷贝 + 2 次上下文切换**
- Kafka 通过 `FileChannel.transferTo()` 实现

### 9.3 Page Cache

- Kafka 直接使用 OS page cache（不自己管理）
- 消费者读近期数据几乎是**内存访问速度**（不 disk seek）
- 生产者写入也进 page cache，OS 后台 flush

### 9.4 批量

- Producer batch 发送 → 减少 RTT
- Consumer fetch 批量 → 一次拉多条

### 9.5 压缩传输 + 存储

- Producer 压缩 → Broker 保持压缩 → Consumer 解压
- **端到端压缩省带宽和磁盘**

### 9.6 分区并行

- Topic 内多 Partition → 多机并行

---

## §10 · Controller / Zookeeper / KRaft

### 10.1 Controller 是什么

- 集群里一个特殊 Broker，负责：
  - 分区 Leader 选举
  - 分区副本分配
  - Topic 增删改
  - 集群元数据管理

### 10.2 ZK 时代（Kafka 2.8 及以前）

- Controller 通过 **ZK Watch** 感知 Broker 上下线
- **元数据存 ZK**：`/brokers/ids/*`、`/brokers/topics/*`、`/controller` 等
- **ZK 是外部依赖**：运维复杂 + 大集群 ZK 瓶颈

### 10.3 KRaft（Kafka Raft，2.8+，3.3 生产可用）

- **移除 ZK**：元数据存到 Kafka 内部特殊 topic `__cluster_metadata`
- **Controller 集群**（3~5 个）用 **Raft 协议**选举 + 复制元数据
- **优势**：
  - 无外部依赖，运维简化
  - 元数据更新更快（不受 ZK 单线程瓶颈）
  - 大集群支持百万分区（vs ZK 时代十万级）

### 10.4 迁移 ZK → KRaft

- 3.5+ 支持 ZK → KRaft 在线迁移
- **4.0 起完全弃用 ZK**

---

## §10.5 · 集群模式全景：Broker 集群 / 分区副本 / 跨机房 / MirrorMaker

### 10.5.1 集群拓扑

**Kafka 只有一种集群模式：Broker 集群 + 分区副本**（不像 Redis 有单机/主从/Cluster 多种），但可以有不同的部署形态。

**单机房架构**：
```
              ┌────────────────────┐
              │  Controller Broker │  ← ZK 时代由 ZK 选出；KRaft 时代由 controller 集群 Raft 选
              └────────┬───────────┘
                       │ 管理元数据
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   ┌──────┐      ┌──────┐      ┌──────┐
   │Broker1│      │Broker2│      │Broker3│
   │       │      │       │      │       │
   │P0-L  │      │P0-F  │      │P0-F  │  ← Topic partition-0
   │P1-F  │      │P1-L  │      │P1-F  │  ← Topic partition-1
   │P2-F  │      │P2-F  │      │P2-L  │  ← Topic partition-2
   └──────┘      └──────┘      └──────┘
   L=Leader  F=Follower
```

**关键概念对齐**：
- **Broker 集群**：多个 Broker 组成，通过 Controller 协调
- **分区副本**：Topic 的每个 Partition 有 N 个 replica，1 主 N-1 从
- **Leader 分区**：分散到不同 Broker（避免单 Broker 承载所有 leader）

### 10.5.2 Controller 选举

**ZK 时代**：
- 所有 Broker 启动时**争抢在 ZK 上创建 `/controller` 临时节点**
- 抢到者成为 Controller
- Controller 挂了 → 临时节点消失 → 其他 Broker 重新抢
- **Controller 负责**：Broker 上下线感知、分区 leader 选举、分区重分配、Topic 元数据变更

**KRaft 时代**：
- **专门的 Controller 集群**（3 或 5 节点）用 **Raft 协议**
- 元数据存储在特殊 topic `__cluster_metadata`（存在 Controller 节点）
- Leader Controller 处理集群元数据变更 → 通过 Raft 日志复制到 Follower Controller
- 数据 Broker（存业务 topic 的）通过 fetch 元数据 topic 感知集群状态
- **优势**：无外部依赖 + 支持百万分区 + 元数据更新快

### 10.5.3 分区 Leader 选举

**触发条件**：
- Broker 宕机 → 该 Broker 上的 leader 分区需要选新 leader
- Leader 手动迁移（负载均衡）
- Preferred leader election（把 leader 迁回"首选"的 Broker）

**选举规则**：
1. **Controller 是选举者**（不是分区内投票）
2. **从 ISR 中选**：AR（Assigned Replicas）中在 ISR 里的**第一个**副本
3. **ISR 空时**：看 `unclean.leader.election.enable`
   - `false`（默认，生产标配）：分区不可用等 ISR 恢复
   - `true`：从 OSR 选，**可能丢已 commit 但未同步的消息**

**面试深度**：
> "Kafka 的分区选举**不是分区内投票**（不像 MGR/Raft），是**由 Controller 集中决策**。这是因为 Kafka 追求高吞吐 + 简单，靠 ISR 机制事先保证候选者数据完整，选举只是快速决策不需要复杂共识。"

### 10.5.4 数据同步（副本复制）

**流程**：
```
Producer → Leader Broker (P0-L)
              │
              │ 写入 log segment (顺序 IO)
              ▼
         [P0-L log]
              ▲
              │ Follower fetch (拉模式)
              │
     ┌────────┴────────┐
     ▼                 ▼
[P0-F1 log]      [P0-F2 log]
```

**核心机制**：
1. **Producer 只写 Leader**（不同于 MySQL 主写从读，Kafka Follower 不对外服务读——2.4+ 有 fetch from follower 但仍是有限场景）
2. **Follower 主动 fetch**（拉模式，不是 Leader 推）
3. **Leader 维护 ISR 列表**：`replica.lag.time.max.ms=30s`（默认）内 fetch 到 LEO 的 follower 才算 in-sync
4. **HW (High Watermark)**：`min(所有 ISR 的 LEO)` → 消费者只能读到 HW 之前
5. **acks 决定 Producer 什么时候返回**：
   - `acks=0`：不等 → 丢
   - `acks=1`：Leader 写完 → Leader 挂 + follower 没跟上 → 丢
   - `acks=all`：所有 ISR ACK → 配合 `min.insync.replicas=2` **强一致**

**数据不丢的必配**：
```
# Broker 端
default.replication.factor=3            # 至少 3 副本
min.insync.replicas=2                   # ISR 至少 2 个
unclean.leader.election.enable=false    # 禁用不干净选举

# Producer 端
acks=all
retries=Integer.MAX_VALUE
enable.idempotence=true
max.in.flight.requests.per.connection=5
```

**含义**：3 副本允许 1 副本挂（还有 2 ISR），2 副本挂就拒绝写入（保数据一致）。**这是 Kafka 生产铁律**。

### 10.5.5 数据恢复流程

**Leader Broker 挂机**：

1. Controller 感知（ZK session 断 或 KRaft 心跳超时）
2. **从 ISR 中选新 Leader**（第一个存活的 ISR 副本）
3. 广播新 leader 元数据给所有 Broker + 客户端
4. 客户端收到 `NotLeaderForPartitionException` → 刷新元数据 → 连新 Leader
5. **原 Leader 恢复后**：作为 Follower 加入 → 从新 Leader fetch 追赶
6. **preferred leader election**（可配置定时）：把 leader 迁回原 Broker（负载均衡）

**恢复时间**：通常 < 30 秒（取决于 Controller 感知 + 客户端刷新元数据）。

**Follower Broker 挂**：
- Controller 感知 → 从 ISR 中踢出
- 恢复后重新 fetch 追赶 → 追上 LEO 后加入 ISR

**Broker 数据文件损坏**：
- 从 ISR 中其他副本 fetch 完整数据重建
- 前提：至少还有一个健康副本

**极端场景 · 所有 ISR 副本都挂**：
- `unclean.leader.election.enable=false`（默认）→ 分区不可用等待 ISR 恢复
- `=true` → OSR 中最后一个存活的升 Leader → **数据可能不完整**（不是最新的）

### 10.5.6 跨机房 / 多集群方案

**MirrorMaker 2（MM2）**：
```
Cluster A (主) ──MM2──→ Cluster B (灾备)
    │                       │
   Prod                    Reader (灾备读)
```

- **不是原生集群跨机房**，而是**两个独立集群 + 异步复制**
- MM2 消费 A 集群 → 生产到 B 集群
- 灾备场景：A 挂了切 B 读写（**offset 会不一致**）

**Confluent Multi-Region Cluster (MRC)**：
- 商业版能力：Observer 副本（跨机房的异步只读副本）
- 同 AZ 内 sync 副本 + 跨 AZ observer → 平衡性能和 RPO

**面试话术**：
> "Kafka 跨机房不像 MySQL 那样一套架构就能搞定。**同城多 AZ** 可以直接部署一个集群跨 AZ（依赖 ISR 内部同步），代价是写延迟增加。**跨城** 通常 MirrorMaker 2 做异步复制到备份集群，主集群不可用时切读到备集群，可以容忍一定数据丢失。"

### 10.5.7 集群运维实战

**常见问题与解法**：

| 问题 | 现象 | 解法 |
|---|---|---|
| ISR 频繁抖动 | ISR 缩容扩容日志刷屏 | 检查网络/GC/磁盘 IO，调大 `replica.lag.time.max.ms` |
| Under Replicated Partitions (URP) | ISR < replication factor | 单 Broker 慢/挂，扩容或替换 |
| Preferred replica 不均衡 | Leader 集中在少数 Broker | `kafka-preferred-replica-election.sh` |
| Broker 扩容 | 新 Broker 无分区 | `kafka-reassign-partitions.sh` 重分配 |
| Broker 缩容 | 停用节点 | 先 reassign 把分区迁走再停 |
| Controller 反复切换 | ZK session 频繁断 | 检查 ZK 集群健康 / GC 时间 |
| KRaft 元数据 lag | 数据 Broker 元数据落后 | 检查 controller 集群健康 |

**监控关键指标**：
- `kafka.server:type=ReplicaManager,name=UnderReplicatedPartitions` （URP，健康应 = 0）
- `kafka.controller:type=KafkaController,name=OfflinePartitionsCount`（离线分区数）
- `kafka.server:type=ReplicaManager,name=IsrShrinksPerSec / IsrExpandsPerSec`（ISR 抖动）
- `kafka.server:type=BrokerTopicMetrics,name=BytesInPerSec / BytesOutPerSec`（吞吐）
- `kafka.log:type=Log,name=LogEndOffset` - `LogStartOffset`（消息积压评估）

---

## §11 · Rebalance 详解与优化

### 11.1 Rebalance 的坏

- **全组 STW**：期间没消息被消费
- **Lag 突增**：可能几秒到几十秒
- **消费者故障恢复慢**

### 11.2 触发频率

- Consumer 加入/离开
- 心跳超时（`session.timeout.ms=45s`）
- `max.poll.interval.ms` 超时（默认 5min）

### 11.3 优化手段

1. **CooperativeStickyAssignor**：**增量 Rebalance**，只调整变化的分区
2. **`session.timeout.ms=45s`** + **`heartbeat.interval.ms=3s`**：合理心跳
3. **`max.poll.interval.ms=10min+`**：业务处理慢的情况避免误踢
4. **`max.poll.records=100`**：一次 poll 少点，避免处理超时
5. **消费者数量 ≤ 分区数**：多余的消费者只是备胎

### 11.4 静态成员（Kafka 2.3+）

- `group.instance.id=xxx`
- **Consumer 短暂离线不触发 Rebalance**（session.timeout 内回来仍能拿回原分区）
- **典型场景**：K8s 滚动重启不触发 Rebalance

---

## §12 · Kafka Streams、Connect、KSQL 简介

### 12.1 Kafka Streams

- 轻量级流处理库（Java）
- 输入 topic → 处理 → 输出 topic
- 内建 **KTable**（表）、**KStream**（流）
- 状态存储（RocksDB）+ Changelog Topic 保证故障恢复
- **相对 Flink**：轻量嵌入应用，无独立集群，能力较少

### 12.2 Kafka Connect

- 数据集成框架：Source（导入）+ Sink（导出）
- 常见 Connector：Debezium（CDC）、JDBC、HDFS、S3、Elasticsearch
- **TCUM 用 Debezium 从 MySQL CDC 到 Kafka**

### 12.3 KSQL / ksqlDB

- SQL 风格流处理
- 底层是 Kafka Streams
- **面试可选提**，生产多用 Flink SQL 代替

---

## §13 · 生产实战：TCUM 中的 Kafka 使用

### 13.1 监控数据管道

```
Prometheus/vmagent → remote_write → [Kafka Cluster] → [消费者：Filter/Router/存储]
                                                          ├── VM (metric)
                                                          ├── CK (明细)
                                                          └── Alertmanager (告警评估)
```

**关键决策**：
- **Topic 按数据类型分**：metric / trace / log / alert
- **分区数 = Broker × 10**（60 分区起步）
- **副本 3 + min.insync.replicas=2 + acks=all**：强一致
- **保留 7 天**：短期回溯

### 13.2 CMDB 变更事件流

- MySQL binlog → Debezium Connect → Kafka `cmdb-changes` topic
- Consumer：unified-gateway 消费 → 增量索引/推送
- **顺序性**：按 CI id 作 key → 同 CI 变更同分区有序
- **幂等**：Consumer 用 `(ci_id, version)` 去重表

### 13.3 告警通知削峰

- Alertmanager 产出告警 → Kafka `alerts-notify` topic
- 通知服务消费 → 发企业微信/邮件/电话
- **限流**：Kafka Consumer 消费速率控制 + 下游服务限流
- **重试**：失败消息发死信 topic

### 13.4 Client 选型

- **Java**：Confluent Kafka Java Client（官方）
- **Go**：
  - **confluent-kafka-go**（cgo，librdkafka 底层）：性能极好，事务/幂等完整
  - **segmentio/kafka-go**（纯 Go）：简单易用，性能次之
  - **Sarama**（老牌纯 Go）：Bug 相对多
- **TCUM 选择**：Java Client 用于稳定性，Go 场景用 confluent-kafka-go（代价是 cgo）

### 13.5 关键 producer 配置

```
acks=all
retries=Integer.MAX_VALUE
enable.idempotence=true
max.in.flight.requests.per.connection=5  # 幂等 producer 允许 ≤ 5 保序
compression.type=zstd
batch.size=100000
linger.ms=20
min.insync.replicas=2   # broker 端配置
```

### 13.6 关键 consumer 配置

```
enable.auto.commit=false
max.poll.records=100
max.poll.interval.ms=600000  # 10min
session.timeout.ms=45000
heartbeat.interval.ms=3000
partition.assignment.strategy=org.apache.kafka.clients.consumer.CooperativeStickyAssignor
```

---

## §14 · 版本演进 + 新特性

| 版本 | 关键特性 |
|---|---|
| 0.8 | 副本 + Kafka 化 |
| 0.9 | 新 Consumer + offset 存内部 topic + SASL |
| 0.10 | Streams + 时间戳 |
| 0.11 | **幂等 Producer + 事务** |
| 1.0 | 稳定化 |
| 2.0 | 增强 SASL、增量拉取 |
| 2.3 | 静态成员 |
| 2.4 | **CooperativeStickyAssignor** |
| 2.8 | **KRaft 早期版本**（不推荐生产） |
| 3.0 | KRaft 稳定 |
| 3.3+ | **KRaft 生产可用** |
| 3.5+ | ZK → KRaft 迁移工具 |
| 4.0 | **弃用 ZK** |

---

## §15 · 60 问详解

### 【架构与模型】

**Q1. Kafka 为什么这么快？**
> 顺序 IO + 零拷贝 sendfile + Page Cache + 批量 + 压缩 + 分区并行。核心是**顺序写日志**（100~1000x 快于随机 IO）。

**Q2. Topic / Partition / Replica / Broker 关系？**
> Broker 是节点；Topic 是逻辑分类；Partition 是 Topic 的物理切分；Replica 是 Partition 的副本。**Partition 是并行 + 副本 + 顺序性的基本单位**。

**Q3. 分区数怎么选？**
> ① 期望吞吐 / 单分区吞吐 ② Consumer 组并发上限（不能超分区数）③ 副本数 * 分区数 越多 Rebalance 越慢。经验：Broker × 5~10 起步，最大 10w 每集群。

**Q4. 分区数创建后能改吗？**
> **只能增加不能减少**。增加分区后**同 key 的分区路由可能变**（hash % N 变了），破坏顺序性。设计时留余量。

**Q5. Consumer 数量 vs 分区数？**
> Consumer <= 分区数才能全并发。多的 Consumer 是备胎。分区多可以让 Consumer 数灵活。

**Q6. Broker、Partition、Segment 什么关系？**
> Broker 磁盘上一堆分区目录，每分区一堆 Segment 文件（滚动）。查询消息 = 定位 Segment → 用 index 找位置 → 顺序读。

### 【日志存储】

**Q7. Segment 滚动条件？**
> `log.segment.bytes=1GB` 大小满 或 `log.roll.hours=168` 时间到（默认 7 天）。滚动新 segment 命名为起始 offset。

**Q8. Kafka 索引为什么稀疏？**
> 密集索引占内存大。稀疏索引每 4KB 消息一项 + 顺序扫（磁盘顺序 IO 极快）= 空间 + 时间平衡。

**Q9. 消息按 offset 查找流程？**
> ① 二分找 index → 找到近似位置 ② 顺序扫 .log 找精确 offset。O(logN) + 顺序 IO。

**Q10. 时间索引什么用？**
> `.timeindex` 存 (ts, offset)，支持 `seek by timestamp`。K8s 场景常用"从 5 分钟前开始消费"。

**Q11. 日志清理策略 delete vs compact？**
> delete：过期删除；compact：相同 key 保留最新（用于 KTable / 配置流）。可组合。

**Q12. Log Compaction 怎么保证性能？**
> 后台 compaction thread 单线程扫描 → 生成新 segment 覆盖旧 → 增量式，不阻塞读写。

### 【副本与一致性】

**Q13. ISR 是什么？**
> In-Sync Replicas：与 Leader 同步的副本集。落后超过 `replica.lag.time.max.ms=30s` 被踢 → OSR。

**Q14. HW 和 LEO 区别？**
> HW = min(ISR.LEO) 消费者可读上限；LEO = Leader 下一条位置。**HW 保证只读到已复制的数据**，防止读到未持久化的消息。

**Q15. Leader 选举怎么做的？**
> Controller 从 AR 里选**第一个在 ISR 里的副本**。ISR 空时看 `unclean.leader.election.enable`。

**Q16. Unclean 选举什么后果？**
> `=true` 从 OSR 选新 Leader，可能丢数据；`=false` 分区不可用直到 ISR 有副本。**生产默认 false**。

**Q17. min.insync.replicas 是什么？**
> Broker 端配置，配合 `acks=all` 使用：写入需要至少 N 个 ISR 副本 ACK。ISR 少于 N 时 Producer 报错 `NotEnoughReplicasException`。

**Q18. 3 副本 + min.insync.replicas=2 意味着什么？**
> 允许 1 副本挂（还有 2 ISR），2 副本挂就拒绝写入（保数据一致性）。**生产标配**。

**Q19. Leader Epoch 是什么？**
> Leader 任期编号，每次 Leader 变更 +1。用于故障恢复时正确截断日志（防止旧 Leader 的错误提交）。

**Q20. Kafka 有类似 Paxos/Raft 的选举吗？**
> 早期不是。副本机制类似 Primary-Backup。ZK 负责元数据 + Controller 选举（用 ZK 临时节点抢占）。**KRaft 后 Controller 集群用 Raft**。

### 【Producer】

**Q21. Producer 发送流程？**
> Serialize → Partitioner 分区 → RecordAccumulator 攒 batch → Sender 线程发 → Broker 响应 → 回调。

**Q22. Partitioner 怎么工作？**
> 有 key：`hash(key) % partitions`；无 key：sticky（2.4+）或轮询。自定义实现 Partitioner 接口。

**Q23. acks 三种含义？**
> 0：发就完事丢失风险高；1：Leader 写完就返回，Leader 挂了可能丢；all：所有 ISR ACK，最强一致。

**Q24. 幂等 Producer 怎么实现？**
> `enable.idempotence=true` → Producer 有 PID + 单分区 sequence number → Broker 按 (PID, partition, seq) 去重。**只保证单分区 + 单会话幂等**。

**Q25. 事务 Producer 怎么保证跨分区原子？**
> `transactional.id` + Transaction Coordinator。producer 发多分区消息标记事务未提交 → 提交时 coordinator 2PC 通知各分区 → Consumer read_committed 只读已提交。

**Q26. 顺序保证如何配？**
> `enable.idempotence=true`（同时保证幂等） 或 `max.in.flight.requests.per.connection=1`（保守但慢）。幂等 producer 允许 in-flight <=5 仍保序。

**Q27. Producer 重试为什么可能乱序？**
> 一个 batch 失败重试 + 后续 batch 成功 → 乱序。**幂等 Producer 内建重试保序**。

**Q28. 压缩什么时候做？**
> Producer 端 batch 压缩 → Broker 保持压缩存储 → Consumer 解压。端到端压缩省带宽和磁盘。

### 【Consumer】

**Q29. Consumer Group 模型？**
> Group 内成员分摊分区，一个分区最多给一个成员。不同 Group 独立消费同 Topic（发布订阅）。

**Q30. Offset 存哪？**
> 0.9+ 存内部 Topic `__consumer_offsets`（50 分区默认）。老版存 ZK 性能差。

**Q31. 自动提交 vs 手动提交？**
> 自动提交每 5s，容易重复消费；手动 commitSync（阻塞可靠）/ commitAsync（异步快）。生产用手动 + 处理完再提交。

**Q32. Rebalance 触发条件？**
> Group 成员变化 / 分区数变化 / 心跳超时 / max.poll.interval 超时。**Rebalance 期间全组停止消费**。

**Q33. 分区分配策略？**
> Range（默认，不均匀）/ RoundRobin（均匀）/ Sticky（尽量保留原分配）/ **CooperativeSticky（增量再平衡，2.4+，生产推荐）**。

**Q34. CooperativeSticky 好在哪？**
> 增量 rebalance：只调整变化的分区，其他 member 继续消费。**消除 STW**。

**Q35. session.timeout 和 max.poll.interval 区别？**
> session.timeout：心跳超时（后台线程发心跳）；max.poll.interval：两次 poll 间隔上限（业务处理慢受影响）。**处理慢调大 max.poll.interval**。

**Q36. 静态成员是什么？**
> `group.instance.id=xxx` → Consumer 短暂离线不触发 rebalance（session.timeout 内回来拿回原分区）。**K8s 滚动重启友好**。

**Q37. Consumer 消费顺序？**
> 单分区顺序消费。多分区并行无序。**同 key 同分区能保证同 key 有序**。

**Q38. Consumer poll 到底做什么？**
> 拉取消息、心跳、rebalance、offset 提交（自动模式）都在 poll 里做。**长时间不 poll → 心跳中断 → rebalance**。

### 【可靠性】

**Q39. Kafka 会丢消息吗？**
> 会：① acks=0/1 + Broker 挂 ② unclean leader election ③ Consumer 提交 offset 后处理失败 ④ Producer 发送前进程挂。**配置到位 + 幂等 producer + 手动 commit + 业务幂等 → 不丢**。

**Q40. Exactly Once 怎么做？**
> Kafka 内闭环（Consume → Process → Produce）：幂等 producer + 事务 + read_committed。**跨系统必须业务侧幂等**。

**Q41. 消息重复消费如何处理？**
> 业务侧幂等：唯一 key + 去重表 / Redis SETNX / 数据库唯一索引。**分布式系统的根本约束**。

**Q42. 消息丢失如何排查？**
> 三段查：Producer（acks、retries、error 日志）→ Broker（ISR 状态、min.insync 触发）→ Consumer（offset 提交时机、异常重试）。

### 【顺序性】

**Q43. Kafka 全局有序吗？**
> **单分区有序，跨分区无序**。要全局有序只能一个分区，代价是无并行。

**Q44. 保证同 key 有序怎么做？**
> Producer 用同 key（`hash(key) % partitions` 定位分区）→ 同 key 消息到同分区 → Consumer 单线程消费该分区 → 有序。

**Q45. Producer 重试会乱序吗？**
> 不用幂等 Producer 时会。用了幂等 Producer（seq number）broker 会拒绝乱序写入，保证顺序。

### 【性能与优化】

**Q46. 零拷贝是什么？**
> `FileChannel.transferTo()` 跳过用户空间：磁盘 → pagecache → 网卡。省 2 次拷贝 + 2 次上下文切换。

**Q47. Page Cache 用得爽在哪？**
> Kafka 直接依赖 OS pagecache，不自己管缓存。**读近期数据是内存速度**，写入进 pagecache OS 异步刷。

**Q48. Kafka 大批量写入调优？**
> `batch.size` 调大到 100KB+、`linger.ms=20~50ms`、`compression.type=lz4/zstd`、`buffer.memory` 调大、多 producer 并行。

**Q49. Consumer 消费慢怎么调优？**
> `fetch.min.bytes=1MB`、`fetch.max.wait.ms=500`、`max.poll.records` 视处理速度调、并行 Consumer 数 = 分区数、业务处理异步化。

**Q50. Broker 网络参数？**
> `num.network.threads=8`（网络 IO 线程）、`num.io.threads=16`（磁盘 IO 线程）、`socket.send.buffer.bytes=1MB`、`socket.receive.buffer.bytes=1MB`。

### 【运维】

**Q51. ZK 和 KRaft 区别？**
> ZK：外部依赖，元数据存 ZK；KRaft：内部 Controller 集群 Raft 协议，无外部依赖，大集群百万分区支持。**3.3+ KRaft 生产可用**。

**Q52. 集群扩容 Broker 怎么办？**
> 加 Broker → 用 `kafka-reassign-partitions.sh` 重平衡分区（迁数据）→ 完成后新 Broker 承接流量。**迁移期间网络 IO 高，低峰做**。

**Q53. Broker 挂了会怎样？**
> 挂节点上的 Leader 分区从 ISR 选新 Leader（几秒切换）；Follower 分区不影响 Leader；ISR 变化。**恢复后 Follower 从 Leader 拉数据追赶**。

**Q54. 分区不均匀怎么办？**
> `kafka-reassign-partitions.sh` 手动迁分区 或 用 Cruise Control 自动均衡（LinkedIn 出品）。

**Q55. Kafka Lag 怎么监控？**
> `kafka-consumer-groups.sh --describe` 看每分区 LAG（Log End Offset - Committed Offset）。Burrow / kafka-lag-exporter 集成 Prometheus。

**Q56. Kafka 磁盘满了会怎样？**
> Broker 停止接收写入。监控 `log.dirs` 磁盘使用率提前告警。清理老 log 或扩容。

### 【选型对比】

**Q57. Kafka vs RocketMQ？**
> Kafka：日志式高吞吐，广播/回溯强，生态丰富；RocketMQ：任务式，延时消息/事务消息/顺序消息更完善。**大数据管道 Kafka，业务消息 RocketMQ**。

**Q58. Kafka vs Pulsar？**
> Kafka：分区 = 存储单元，成熟稳定；Pulsar：Broker/Bookie 分离，云原生更友好，多租户强。**新场景可以看 Pulsar，成熟场景 Kafka 更稳**。

**Q59. Kafka vs RabbitMQ？**
> Kafka：分布式日志，扩展性强；RabbitMQ：AMQP 协议，路由灵活但吞吐低。**吞吐要求高选 Kafka，业务路由复杂选 RabbitMQ**。

**Q60. Kafka Streams vs Flink？**
> Streams：嵌入应用轻量，无独立集群，能力有限；Flink：独立集群，能力全面（CEP / 窗口 / 状态），大规模流处理王者。**TCUM 生产 Flink 为主**。

### 【补充深度】

**Q61. Kafka 消息大小限制？**
> `message.max.bytes=1MB`（Broker）、`max.request.size=1MB`（Producer）、`fetch.max.bytes=1MB`（Consumer）。生产可调大到 10MB，但**建议大消息用对象存储 + Kafka 传引用**。

**Q62. 事务的性能代价？**
> ~10~20% 吞吐损失（事务日志 + 2PC 开销）。仅在需要 EOS 的场景开启。

**Q63. Kafka 支持延时消息吗？**
> **原生不支持**。变通：多级 topic（delay-1min / delay-10min）+ Consumer 定时移动，或用 RocketMQ。

**Q64. 顺序性和吞吐量矛盾怎么权衡？**
> 全局有序 = 1 分区 = 无并行。业务上按 key 分组保证组内有序 + 组间并行。

**Q65. Kafka 高可用生产必配？**
> ① 3 副本 ② min.insync.replicas=2 ③ acks=all ④ unclean.leader.election=false ⑤ 幂等 producer ⑥ 手动 commit ⑦ CooperativeStickyAssignor ⑧ 静态成员 ⑨ 监控 Lag + ISR。

---

## §16 · 短板与坑

1. **Rebalance 是消费最大痛点**：Cooperative + 静态成员缓解
2. **分区数只能加不能减**
3. **Partition 数是 Consumer 并发上限**
4. **无延时消息**：需变通
5. **消息级 ACK 弱**：只有 offset 概念
6. **大消息不适合**：> 1MB 建议存对象存储
7. **精确一次限 Kafka 内**：跨系统需业务幂等
8. **ZK 时代运维复杂**：升级 KRaft
9. **Lag 告警配置需谨慎**：静态阈值 vs 突增检测
10. **Consumer 处理慢触发 Rebalance**：max.poll.interval / max.poll.records 调优

---

## §17 · 面试话术

### 3 分钟自述

> "我在 TCUM 用 Kafka 承担监控数据总线 + CMDB 变更事件流 + 告警通知削峰，日流量数百亿条，多 topic 分区数百，副本 3 min.insync.replicas=2 acks=all。
>
> **对 Kafka 最深三点理解**：
> - **它是分布式日志不是队列**：顺序 IO + 零拷贝 + Page Cache 让它成为高吞吐王者，广播 + 回溯 + 分区并行是它相对 RocketMQ / RabbitMQ 的差异化。任务派发场景 RocketMQ 更合适。
> - **可靠性是配置艺术**：acks=all + 3 副本 + min.insync.replicas=2 + 幂等 producer + 手动 commit + 业务幂等 = 端到端不丢。任何一个环节漏掉都会有坑。
> - **Rebalance 是最大运维痛点**：CooperativeStickyAssignor 增量再平衡 + 静态成员 group.instance.id 应对 K8s 滚动重启 + 合理 max.poll.interval——三招下去 Lag 突增基本消失。
>
> **生产血泪**：分区数拍脑袋定小了扩不动、Consumer 处理慢触发 Rebalance 雪崩、confluent-kafka-go cgo 编译坑、事务性能踩坑——每一个都是配置和使用姿势的教训。"

### 反问 5 问

1. Kafka 版本？KRaft 了吗？
2. 分区数、副本数、min.insync.replicas 配置？
3. Producer 幂等 + 事务开了吗？
4. Consumer Rebalance 用 CooperativeSticky 了吗？静态成员？
5. Lag 监控告警阈值？大 Lag 应急预案？

---

**本篇完 · 约 27KB · 覆盖架构/存储/副本/生产消费/EOS/顺序/性能/KRaft/生产/65 问**

**证据基线**：
- Kafka 官方文档：https://kafka.apache.org/documentation/
- Confluent 技术博客（KRaft / Cooperative Rebalance / Exactly Once）
- 生产实战：TCUM 监控数据总线、Debezium MySQL CDC、confluent-kafka-go Consumer
- 阿里/字节生产 Kafka 集群规模：单集群百 Broker / 10w+ 分区 / 万亿消息/日
