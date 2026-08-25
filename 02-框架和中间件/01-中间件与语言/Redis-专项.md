# 第五卷 · 中间件 · Redis 专项

> **本篇定位**：Redis 是 TCUM 场景下的**核心缓存 / 计数器 / 分布式锁 / 幂等键 / Session 存储**。在监控告警链路里，Redis 承担告警去重、告警状态机、限流令牌桶、Kafka 消费位点缓存、CMDB 热数据缓存等职责。本文覆盖数据结构、持久化、复制、Sentinel、Cluster、缓存三大问题、分布式锁、脚本原子性、内存管理、生产运维实战、以及 50+ 高频面试题。密度对齐 `tcum-ai/01`，力求"面试敢讲，生产敢用"。

## 📖 目录
- §1 命题：Redis 为什么这么快 & 为什么能扛核心链路
- §2 单线程 + 多路复用：epoll 与事件循环
- §3 九大数据结构与底层编码
- §4 持久化：RDB / AOF / 混合持久化
- §5 复制：主从同步与 psync2
- §6 Sentinel 高可用哨兵
- §7 Cluster 分片：16384 槽位与 gossip
- §8 内存管理：过期与淘汰策略
- §9 缓存三大问题：穿透 / 击穿 / 雪崩
- §10 分布式锁：SETNX / Redlock / lease
- §11 Lua 脚本与原子性
- §12 事务：MULTI/EXEC/WATCH 与其局限
- §13 pipeline / mget / cluster pipeline
- §14 大 key / 热 key / 慢查询
- §15 生产实战：TCUM/告警 场景下的用法
- §16 版本演进（3.x → 7.x）与新特性
- §17 50 问详解（架构、性能、一致性、运维、故障）
- §18 短板与坑
- §19 面试话术模板

---

## §1 · 命题：Redis 为什么这么快 & 为什么能扛核心链路

### 一句话背诵

> "Redis 快的本质是三点：**内存操作 + 单线程 IO 事件循环（无锁）+ IO 多路复用**；扛核心的本质是**丰富的数据结构（把复杂业务下沉到 O(1)/O(logN) 内核算子）+ 持久化兜底 + 主从/Sentinel/Cluster 三级可用性**。"

### 六大速度来源

1. **纯内存**：无磁盘 IO，L1/L2/L3 缓存友好，几十 ns 级别的访问延迟。
2. **单线程处理命令**：无锁、无上下文切换、无 CAS 争用（**注意**：单线程仅指命令处理，网络 IO 在 6.0+ 已多线程化）。
3. **IO 多路复用（epoll / kqueue）**：单线程处理数万连接，事件驱动，就绪即处理。
4. **高效数据结构**：ziplist / listpack / SDS / skiplist / quicklist / hashtable 均针对 CPU 缓存和空间做深度优化。
5. **紧凑的协议 RESP**：文本协议但解析快，一次 write 打包多个 reply。
6. **零 GC 语言（C）**：无 STW，内存布局可控（相对 Java Redis-clone/Aerospike 的优势）。

### 为什么单线程还能这么高 QPS？

- **CPU 不是瓶颈**：Redis 大多数命令是 O(1)/O(logN)，CPU 忙不起来。
- **瓶颈在网络和内存带宽**：网络 IO 上限（万兆网卡 ~1.2GB/s）远小于内存带宽（几十 GB/s）。
- **单线程避免锁**：避免了 Memcached 早期多线程锁的复杂度和上下文切换。
- **6.0+ IO 多线程**：`io-threads`，把 read/write 系统调用交给多线程做，命令执行仍单线程 → **协议解析 + write 是 CPU 密集，命令执行是快操作**。

### 边界代价（不背要吃亏）

- **单命令阻塞整个实例**：`KEYS *` / 大 hash 的 `HGETALL` / 大 zset 的 `ZRANGE 0 -1` → 慢查询把所有连接卡死。
- **持久化对延迟敏感**：fork 触发 COW，大内存实例 fork 需要几十 ms 甚至几百 ms。
- **主从复制不是强一致**：`min-replicas-to-write` 也只是异步语义的兜底。
- **Cluster 不支持跨槽事务/多 key 命令**：`MGET k1 k2` 若不同槽会报错，必须走 hashtag。

---

## §2 · 单线程 + 多路复用：epoll 与事件循环

### 事件循环（ae 模块）

Redis 主循环是一个基于 Reactor 模式的事件循环，核心文件 `src/ae.c`。伪代码：

```c
while (!server.shutdown) {
    // 1) 处理时间事件（cron，1ms 精度）
    processTimeEvents();
    // 2) IO 多路复用（epoll_wait），带超时
    events = aeApiPoll(eventLoop, tvp);
    // 3) 遍历就绪的文件事件
    for (e in events) {
        if (readable) e.rfileProc(e.fd);   // 读命令
        if (writable) e.wfileProc(e.fd);   // 发响应
    }
    // 4) beforeSleep / afterSleep hook（AOF flush、cluster cron 等）
}
```

- **aeApiPoll** 是抽象层：Linux 上就是 `epoll_wait`，macOS 上是 `kqueue`，Solaris 上是 evport。
- **时间事件**（`serverCron`）：默认 10Hz，负责过期扫描、内存驱逐、集群心跳、AOF/RDB 触发、连接超时清理。
- **文件事件**：一个连接对应一个 fd，读事件调 `readQueryFromClient`，写事件调 `sendReplyToClient`。

### 单条命令的完整流程

1. TCP 数据到达网卡 → epoll 就绪 → `readQueryFromClient`
2. RESP 协议解析 → 拆成 `argc / argv`
3. `processCommand`：**权限校验（ACL） → 事务/脚本上下文 → 慢查询记录 → 命令函数**
4. 命令函数执行（例如 `getCommand`）→ 写回复到 client 的 buf
5. 后续 write 事件将 buf flush 到 socket

### 6.0 IO 多线程详解

**动机**：Redis 单实例 QPS 顶格约 10w，瓶颈在 read/write 系统调用（尤其是 pipeline 场景 write 大量数据）。

**方案**（`io-threads-do-reads yes`）：
1. 主线程收到就绪事件后，把客户端**分给 IO 线程池**做协议解析和 read。
2. **命令执行仍在主线程**（避免锁）。
3. write 阶段同样多线程分发。

**性能收益**：4 IO 线程 QPS 提升 2x，8 线程 3x（但边际递减）。**默认关闭**，官方建议 CPU 核数 ≥ 4 时开启。

**面试深度点**：
> "Redis 6 的多线程只解决 IO 瓶颈，不解决 CPU 计算瓶颈。所以 Lua 脚本、大 key、O(N) 命令依然是老毛病——本质是单线程命令模型没变。"

---

## §3 · 九大数据结构与底层编码

Redis 对外 5 大类型（string/list/hash/set/zset），加上 stream/hyperloglog/bitmap/geo 一共 9 大类型。**底层编码是重点**。

### 3.1 String（SDS）

- 底层：**SDS（Simple Dynamic String）**
- 结构：`{ len, alloc, flags, buf[] }`——**O(1) 求长度**，二进制安全，预分配减少 realloc。
- 三种编码：`int`（可用 long 表示）、`embstr`（≤44 字节，一次 malloc 分配 sds + robj）、`raw`（>44 字节，两次 malloc）
- **面试点**：为什么 embstr 边界是 44？→ jemalloc 分配 64 字节 chunk，robj 头 16B + sds 头 3B + '\0' 1B = 20B，剩 44。

**典型用法**：计数器（`INCR`）、缓存对象（JSON 序列化）、分布式锁 key、bloom filter 位图基础。

### 3.2 List

- 编码演进：
  - Redis 3.2 前：**ziplist**（小） / **linkedlist**（大）
  - Redis 3.2+：**quicklist**（ziplist 组成的双向链表，兼顾空间和随机访问）
  - Redis 7.0+：**quicklist + listpack**（listpack 替换 ziplist，避免连锁更新）
- **面试点 · ziplist 连锁更新**：某个节点前置长度字段从 1B 变 5B → 下一个节点也要扩容 → 雪崩式内存拷贝。listpack 用**每个 entry 自记录长度**规避了这个问题。

**典型用法**：消息队列（`LPUSH/BRPOP`，5.0 后被 Stream 取代）、时间线（微博 timeline）、最近 N 条记录（LTRIM）。

### 3.3 Hash

- 编码：`listpack`（小对象）/ `hashtable`（大对象）
- 阈值：`hash-max-listpack-entries 128`，`hash-max-listpack-value 64`（7.x）
- **rehash 渐进式**：`ht[0] / ht[1]` 双表 + `rehashidx`，每次命令搬 1 个 bucket，避免长时间阻塞。

**典型用法**：对象聚合存储（比 100 个 string key 省内存 5-10 倍）、字段级别原子操作（`HINCRBY`）。

### 3.4 Set

- 编码：`intset`（全整数且 ≤ 512 个）/ `hashtable`
- 7.2 起新增 `listpack` 编码
- **典型用法**：标签、共同好友（`SINTER`）、抽奖（`SPOP`/`SRANDMEMBER`）

### 3.5 ZSet（有序集合）

- 编码：`listpack`（小）/ **`skiplist + hashtable`**（大）
- **跳表 vs 红黑树**：
  - 实现更简单（作者 antirez 原话："I don't have to worry about balancing"）
  - 范围查询更友好（O(logN) 定位起点 + 线性扫描）
  - 无锁并发扩展性更好（Redis 单线程用不上但设计前瞻）
- **hashtable 的作用**：`ZSCORE` O(1)，避免遍历跳表

**典型用法**：排行榜（`ZREVRANGE`）、延时队列（score = 到期时间戳，`ZRANGEBYSCORE`）、限流（滑动窗口）。

### 3.6 Stream（5.0 新增）

- **Redis 版 Kafka**：消息 ID 单调递增（`ms-seq`），消费组、pending list、确认机制、DLQ。
- 底层：**radix tree + listpack**
- 关键命令：`XADD / XREAD / XREADGROUP / XACK / XPENDING / XCLAIM`
- **面试点**：Stream vs List 消息队列：List 无消费组，无消费确认；Stream 支持消费组、消息回溯、pending 追踪。

### 3.7 HyperLogLog

- 基数估计算法（14 位 bucket × 6 位 rank，约 12KB 空间估计 2^64 基数）
- 误差 **0.81%**
- `PFADD / PFCOUNT / PFMERGE`
- **典型用法**：UV 统计、去重计数

### 3.8 Bitmap

- 底层就是 String，按 bit 操作
- `SETBIT / GETBIT / BITCOUNT / BITOP / BITPOS`
- **典型用法**：日活签到（1 bit/user/day）、布隆过滤器基础、用户在线状态

### 3.9 Geo

- 底层是 zset，score 是 **GeoHash 52 位整数**
- `GEOADD / GEORADIUS / GEOSEARCH`
- **典型用法**：附近的人、门店查询

### 数据结构选型速查表

| 场景 | 推荐 | 拒绝 |
|---|---|---|
| 计数 | String INCR | Hash HINCRBY（除非要聚合） |
| 对象缓存 | Hash（少字段）/ String JSON（多字段） | — |
| 排行榜 | ZSet | Sorted List |
| 消息队列 | Stream | List（5.0 后不推荐） |
| 去重 | Set | List LREM |
| 大规模去重（可容忍误差） | HyperLogLog | Set |
| 签到 | Bitmap | Hash |
| 分布式锁 | String SETNX + Lua | 手写 GETSET |

---

## §4 · 持久化：RDB / AOF / 混合持久化

### 4.1 RDB（快照）

- **触发**：手动 `SAVE`（阻塞）/ `BGSAVE`（fork 子进程）；自动 `save 3600 1` 等策略。
- **过程**：
  1. `BGSAVE` 调用 `fork()`，子进程共享父进程内存（Copy-On-Write）
  2. 子进程序列化数据到临时 RDB 文件
  3. 完成后原子 rename 覆盖旧 RDB
- **优点**：紧凑二进制，恢复快，适合灾备迁移
- **缺点**：**丢数据**（两次快照间的数据全丢）

### 4.2 AOF（追加日志）

- **原理**：每条写命令追加到 AOF 文件（RESP 协议）
- **fsync 三种策略**：
  - `always`：每次写都 fsync（安全但慢，损失 50% QPS）
  - `everysec`：**默认**，后台线程每秒 fsync（**最多丢 1 秒**）
  - `no`：交给 OS，最多丢 30 秒
- **AOF 重写**（`BGREWRITEAOF`）：
  - fork 子进程根据当前内存**重新生成最小化 AOF**
  - 父进程新命令写入 **AOF buffer + AOF rewrite buffer**
  - 子进程完成后，父进程把 rewrite buffer 追加到新 AOF，rename 覆盖

### 4.3 混合持久化（4.0+，`aof-use-rdb-preamble yes`）

- **AOF 重写时**：前半部分是 RDB 二进制快照，后半部分是增量 RESP 命令
- **优点**：恢复速度接近 RDB，最多丢 1s（AOF everysec 保底）
- **默认开启**（5.0+），**这是当前生产标配**

### 4.4 fork 的坑（生产血案）

- 大内存实例（>10G）fork 需要几百 ms，客户端命令全部卡住
- COW 触发时如果写多，父进程内存翻倍
- 磁盘写满 → AOF fsync 卡住 → 主线程阻塞
- **建议**：`vm.overcommit_memory=1`（允许过量分配，否则 fork 失败）

### 4.5 面试模板："RDB 和 AOF 怎么选"

> "生产标配开混合持久化 + AOF everysec + 每天凌晨 BGSAVE。故障恢复速度 ≥ RDB，数据丢失窗口 ≤ 1 秒。极端场景（金融、支付）用 AOF always + 主从半同步（不能真正等）。缓存场景可以只 RDB 甚至关闭持久化。"

---

## §5 · 复制：主从同步与 psync2

### 5.1 全量复制 vs 增量复制

- **全量**（首次或断线过久）：主执行 `BGSAVE` 生成 RDB → 传给从 → 从加载 RDB → 主把 buffer 中新命令追加过去
- **增量**（断线时长 < 缓冲区容量）：从上次的 `offset` 开始把 replication backlog 里的命令重放

### 5.2 psync2（4.0+）

**关键改进**：
- **replid + offset** 取代旧的 `runid`
- 主故障切换后从升主，保留旧 replid → 兄弟从库仍可增量同步
- 从库重启后可能仍能增量（如果 backlog 够）

### 5.3 数据流

```
Master                     Replica
  |--- ping ------->|
  |<-- pong --------|
  |<-- REPLCONF ---|
  |<-- PSYNC repl_id offset ---|
  |--- +FULLRESYNC 或 +CONTINUE ->|
  |--- RDB 文件 ------------->| (全量)
  |--- 命令流 -------------->| (backlog 或实时)
```

### 5.4 从节点只读 & 半同步

- **默认从节点只读**（`replica-read-only yes`）
- Redis 无真正的半同步，`WAIT numreplicas timeout` 只是等待写命令被 N 个从确认，**不是强一致**

### 5.5 复制风险

- **主从数据不一致**：主写完立即读从，可能读到旧值（毫秒级延迟）
- **复制风暴**：多个从同时全量复制，主 IO 打爆
- **backlog 溢出**：`repl-backlog-size` 默认 1MB，网络抖动久了就全量复制

---

## §6 · Sentinel 高可用哨兵

### 6.1 职责

- **监控**：ping 主从、感知宕机
- **通知**：pub/sub 通知客户端
- **自动故障转移**：主宕 → 选新主 → 让其他从复制新主 → 更新配置

### 6.2 选主规则（优先级 desc）

1. **优先级** `replica-priority`（默认 100，0 表示永不当选）
2. **复制偏移量** offset 最大（数据最全）
3. **runid** 字典序小

### 6.3 客观下线判定（quorum）

- 单个 Sentinel 认为主挂了 = **主观下线（SDOWN）**
- 超过 `quorum` 个 Sentinel 同意 = **客观下线（ODOWN）**
- 触发选举 leader Sentinel（Raft-like），由 leader 执行故障转移

### 6.4 脑裂问题

- **网络分区** → 客户端可能继续写老主 → 分区恢复后老主降从，数据丢失
- **缓解**：`min-replicas-to-write 1` + `min-replicas-max-lag 10`——主如果发现从太少或延迟太大，**拒绝写入**

### 6.5 Sentinel vs Cluster

| 维度 | Sentinel | Cluster |
|---|---|---|
| 分片 | ❌ | ✅ 16384 槽 |
| 高可用 | ✅ | ✅（每分片主从） |
| 部署复杂度 | 低 | 高 |
| 适用场景 | 数据量 <100GB | 大数据量/高并发 |

---

## §7 · Cluster 分片：16384 槽位与 gossip

### 7.1 为什么是 16384 而不是 65536

- 心跳包携带槽位 bitmap，16384 bit = 2KB，65536 bit = 8KB
- 集群规模上限 1000 节点，16384 已足够
- 作者 antirez 原话：**"a good compromise"**

### 7.2 槽位分配

- `CRC16(key) % 16384` → 槽号 → 节点
- **hashtag**：`{user1}:profile` 和 `{user1}:orders` 只对 `{user1}` 做 hash，保证同槽
- **面试点**：为什么需要 hashtag？→ 让相关 key 落同槽以支持 `MGET / MULTI` 和 Lua 多 key 操作

### 7.3 客户端重定向

- **MOVED**：目标槽已迁到别的节点（永久）→ 客户端更新本地槽路由
- **ASK**：槽正在迁移，本次去别的节点（临时）→ 不更新路由

### 7.4 gossip 协议

- 每秒随机选几个节点发 PING/PONG，同步节点状态
- 传播故障感知（PFAIL → FAIL）
- **收敛慢**：大集群故障感知可能需要几秒

### 7.5 故障转移

- 主宕 → 从发起选举 → 其他主投票 → 得票 >= N/2+1 从升主
- **不需要 Sentinel**，集群内自治

### 7.6 集群限制

- **不支持多 db**（只有 db 0）
- **多 key 命令**必须同槽（hashtag）
- **事务/Lua** 必须同槽
- **pub/sub** 全集群广播（有 shard pubsub 后改善）

---

## §7.5 · 集群模式全景对比与运维实战

> Redis 有 **单机 / 主从 / Sentinel / Cluster** 4 种部署形态。面试常被问"你们生产是什么模式？怎么选？为什么？"——这一节把每种模式的**架构、选主、同步、不丢、恢复**5 个维度一次讲透。

### 7.5.1 四种模式对比总表

| 维度 | 单机 | 主从 | Sentinel | Cluster |
|---|---|---|---|---|
| **架构** | 单点 | 1 主 N 从 | 1 主 N 从 + M Sentinel | N 分片 × (1 主 + M 从) |
| **拓扑** | 无 | 单主链式/星形 | 单主 + 独立哨兵集群 | 多主，每主自带从 |
| **选主** | 无 | 手动切换 | 哨兵 Raft 选举 | 集群内主间投票 |
| **数据同步** | 无 | 主从异步复制 | 主从异步复制 | 分片内主从异步复制 |
| **写入扩展** | 单机上限 | 单机上限（只读扩） | 单机上限（只读扩） | 水平扩展 |
| **数据不丢保证** | RDB/AOF | + min-replicas 兜底 | + 自动切换 | + 自动切换 |
| **故障自动恢复** | ❌ | ❌ | ✅ | ✅ |
| **适用规模** | 玩具 | <10GB 只读扩 | <100GB 高可用 | >100GB 大数据 |
| **客户端复杂度** | 简单 | 简单 | 中（发现主） | 高（槽路由） |

### 7.5.2 主从复制（Replication）架构

**架构图**：
```
        ┌──────────┐
        │  Master  │ ← 唯一写入点
        └────┬─────┘
             │ 异步复制
    ┌────────┼────────┐
    ▼        ▼        ▼
┌──────┐ ┌──────┐ ┌──────┐
│Slave1│ │Slave2│ │Slave3│ ← 只读
└──────┘ └──────┘ └──────┘
```

**同步机制**（psync2 协议）：

1. **首次全量同步**：
   - Slave 发 `PSYNC ? -1`
   - Master 执行 `BGSAVE` fork 子进程生成 RDB 文件
   - **同时**：主进程把新来的写命令缓存到 **replication buffer**（每个 slave 一个）+ **replication backlog**（环形缓冲，全局共享，默认 1MB）
   - RDB 传给 slave → slave 清空自己数据加载 RDB
   - Master 再把 replication buffer 里的命令发给 slave
   - 之后进入增量复制阶段

2. **稳态增量复制**：
   - Master 每执行一条写命令，通过 **command propagation** 发给所有 slave
   - 用 **replid + offset** 追踪进度

3. **断线重连增量复制**（psync2 核心改进）：
   - Slave 断线时记住 (replid, offset)
   - 重连时发 `PSYNC {replid} {offset}`
   - 如果 offset 还在 backlog 范围内 → **增量补发**（跳过全量）
   - 超出 backlog → 触发**全量复制**

**数据不丢兜底**：
```
min-replicas-to-write 1     # 至少 1 个副本连着才允许写
min-replicas-max-lag 10     # 副本延迟 > 10s 视为断开
```
效果：**主发现从活着的副本不够 → 拒绝写入**，避免"主继续写但没副本 → 主挂了数据全丢"。

**数据恢复流程**（主挂了）：
- **主从模式无自动切换** → 需要人工介入
- 步骤：① 选一个数据最全的 slave → `SLAVEOF NO ONE` 升主 → ② 其他 slave `SLAVEOF new_master` → ③ 客户端切流
- 这个痛点催生了 Sentinel

### 7.5.3 Sentinel 高可用哨兵

**架构图**：
```
       ┌───────────────────────────┐
       │  Sentinel Cluster (3+)   │
       │  Sentinel1 Sentinel2 Sen3 │
       └────┬──────┬──────┬────────┘
        gossip     │  监控 ping
            ▼      ▼      ▼
        ┌──────┐  ┌──────┐  ┌──────┐
        │Master│─→│Slave1│  │Slave2│
        └──────┘  └──────┘  └──────┘
                异步复制
```

**部署要点**：
- **Sentinel 集群独立部署**，通常 3 或 5 个（奇数，避免脑裂）
- Sentinel 之间靠 **Redis pub/sub 频道 `__sentinel__:hello`** 互相发现
- **Sentinel 本身不存业务数据**，只负责监控 + 协调

**故障检测两阶段**：

1. **主观下线 SDOWN**：
   - 单个 Sentinel `ping` master 超时（`down-after-milliseconds`，默认 30s）
   - 只是"我觉得挂了"

2. **客观下线 ODOWN**：
   - Sentinel 向其他 Sentinel 发 `SENTINEL is-master-down-by-addr`
   - 收到超过 `quorum`（配置，通常 N/2+1）确认 → **客观下线**
   - 触发故障转移

**选主流程**（Raft-like）：

1. **选 leader Sentinel**：任一 Sentinel 发现 ODOWN 后 → 发起 `SENTINEL is-master-down-by-addr` 拿票 → 得票超半数成为 **leader Sentinel**（**是 Sentinel 之间的 leader，不是 Redis 主从**）
2. **由 leader Sentinel 选新 Redis master**（在存活的 slave 中）：
   - 优先级 `replica-priority` 高（默认 100，0 = 永不当选）
   - **复制偏移量 offset 最大**（数据最全）
   - **runid 字典序小**（tiebreaker）
3. **执行故障转移**：
   - 对选中 slave 执行 `SLAVEOF NO ONE`
   - 更新配置纪元（`config-epoch`）
   - 通知其他 slave `SLAVEOF new_master`
   - 通过 pub/sub 通知客户端

**脑裂问题**（生产必坑）：
- 网络分区 → 老 master 和一批 client 在小区
- Sentinel 在大区选出新 master
- **老 master 上的写入分区恢复后被覆盖 → 数据丢失**
- **兜底**：`min-replicas-to-write 1 + min-replicas-max-lag 10`——老 master 发现从少了自动拒写

**客户端如何发现新主**：
- 支持 Sentinel 的客户端（Jedis/Redisson/go-redis）：连 Sentinel 地址列表 → 查询当前 master → 订阅 Sentinel pub/sub 感知切换
- **不能直接连 master 地址**（切换后就失效）

### 7.5.4 Cluster 分片模式

**架构图**：
```
       客户端（cluster-aware）
             │
    ┌────────┼────────┐
    │        │        │
    ▼        ▼        ▼
┌──────┐  ┌──────┐  ┌──────┐
│Shard1│  │Shard2│  │Shard3│
│M + 2S│  │M + 2S│  │M + 2S│  各分片一主两从
└──────┘  └──────┘  └──────┘
   ▲◄────Gossip 协议──────▶
   
   16384 槽位分布：
     Shard1: 0-5461
     Shard2: 5462-10922
     Shard3: 10923-16383
```

**核心机制**：

1. **数据分片**：`CRC16(key) % 16384` → 槽号 → 节点
2. **无中心节点**：所有节点通过 **Gossip 协议**互相同步集群状态
3. **每个分片内部**：仍然是主从复制（同 §7.5.2）
4. **分片间**：主节点相互监控 + 投票选主

**故障检测（Gossip）**：
- 每个节点每秒随机 ping 几个其他节点（PING/PONG 携带槽位分配和集群纪元）
- 收到 PING 后回 PONG，附带自己感知的集群拓扑
- **PFAIL**（主观下线）：某节点 ping 超时 → 标记为可能故障
- **FAIL**（客观下线）：多数主节点确认 PFAIL → 广播 FAIL 消息

**选主流程**（集群内自治）：

**不需要 Sentinel！** Cluster 主宕后：
1. 该分片的 slave 检测到 master FAIL
2. slave 等待一个随机延迟（**offset 大的等得短**，让数据最全的先发起）
3. slave 增加 `currentEpoch` 向所有 master 广播 `FAILOVER_AUTH_REQUEST`
4. 每个 master 一个 epoch 内只投一票给第一个请求者
5. slave 得票 ≥ (N/2)+1 → 升为新主 → 广播 `PONG` 通知所有节点
6. 客户端收到 `MOVED` 重定向自动切换

**为什么是 16384（2^14）槽？**
- 心跳包用 bitmap 表示节点持有的槽，16384/8 = 2048 字节 → 心跳负担轻
- 65536 槽的心跳会到 8KB，太重
- 1000 节点集群 16384 槽仍能均匀分布

**槽迁移（在线扩缩容）**：
```
CLUSTER SETSLOT 100 MIGRATING <target-node-id>    -- 源节点标记
CLUSTER SETSLOT 100 IMPORTING <source-node-id>    -- 目标节点标记
CLUSTER GETKEYSINSLOT 100 <count>                 -- 拿 key
MIGRATE <target> <key> 0 <timeout>                -- 逐 key 迁移
CLUSTER SETSLOT 100 NODE <target-node-id>         -- 完成
```
迁移期间该槽 key：
- 在源节点 → 返回 **ASK 重定向**（一次性，不更新客户端路由表）
- 在目标节点 → 直接执行

**数据不丢兜底**：
- 每分片配置 **至少 1 主 2 从** → 单机房单机故障可容忍
- `cluster-require-full-coverage yes`（默认）→ 任何槽无主 → 整个集群不可写
- `cluster-require-full-coverage no` → 部分槽故障其他槽仍可用
- **金融场景**：跨机房部署 3 副本（同 AZ 1 从 + 跨 AZ 1 从）

**数据恢复**：
- 单机故障 → 分片内 slave 自动升主（30 秒内）
- 整机房故障 → 跨 AZ 从升主 + 手动 rebalance 槽
- **无法恢复的分片**（3 副本全挂）→ 该槽 key 永久丢失

### 7.5.5 集群模式选型决策树

```
数据量 > 100GB 或 QPS > 10w?
    ├─ 是 → Cluster
    └─ 否 → 是否需要自动故障切换?
              ├─ 是 → Sentinel（生产强推）
              └─ 否 → 是否需要读扩展?
                        ├─ 是 → 主从
                        └─ 否 → 单机（仅测试）
```

### 7.5.6 生产运维实战

**监控关键指标**：
- `master_link_status:up`（从看主的链路状态）
- `master_last_io_seconds_ago`（复制延迟）
- `master_repl_offset - slave_repl_offset`（复制字节滞后）
- `connected_slaves`
- Cluster：`cluster_state:ok`、`cluster_slots_ok`、`cluster_known_nodes`

**常见故障与恢复**：

| 故障 | 现象 | 恢复 |
|---|---|---|
| 主从复制断开 | slave `master_link_status:down` | 检查网络/密码/`repl-backlog-size` 增大避免全量 |
| 全量复制风暴 | 多 slave 同时全量拉主 | 错峰重启 slave / `repl-diskless-sync yes` 无盘复制 |
| Sentinel 选不出新主 | ODOWN 后卡住 | 检查 quorum 配置 / Sentinel 存活数 / 网络分区 |
| Cluster 槽异常 | `cluster_state:fail` | `CLUSTER FIX` / `redis-cli --cluster fix` 修复 |
| 迁移中断槽卡在 MIGRATING | 客户端反复 ASK | 手动 `CLUSTER SETSLOT` 恢复 |
| 主从数据不一致 | slave 数据莫名少 | 检查主是否 `min-replicas` 触发拒写 / AOF 是否损坏 |

**面试模板："你们 Redis 集群怎么部署的？"**：
> "生产用 Redis Cluster 6 分片 × (1 主 + 2 从) 共 18 节点，跨 3 AZ 部署（每 AZ 一份副本）。写入侧 `min-replicas-to-write 1` + `min-replicas-max-lag 10` 兜底不丢；集群内主故障 30s 内 slave 自动升主；跨 AZ 网络分区通过 `cluster-require-full-coverage no` 保证部分可用。数据量瓶颈时通过 `CLUSTER RESHARD` 在线扩容——迁移期间 ASK 重定向对客户端透明。"

---

## §8 · 内存管理：过期与淘汰策略

### 8.1 过期删除

- **惰性删除**：访问 key 时检查是否过期
- **定期删除**：`serverCron` 每 100ms 抽样一批 key，过期率 > 25% 继续下一轮，最多 25ms 或全清完
- **缺陷**：如果冷 key 过期后没人访问，会一直占内存 → 靠淘汰策略兜底

### 8.2 8 种淘汰策略（`maxmemory-policy`）

**内存达到 `maxmemory` 时触发**：

| 策略 | 淘汰范围 | 算法 |
|---|---|---|
| noeviction | 不淘汰 | 写失败 |
| allkeys-lru | 全部 key | LRU |
| allkeys-lfu | 全部 key | LFU（4.0+） |
| allkeys-random | 全部 key | 随机 |
| volatile-lru | 有过期时间的 key | LRU |
| volatile-lfu | 有过期时间的 key | LFU |
| volatile-random | 有过期时间的 key | 随机 |
| volatile-ttl | 有过期时间的 key | 优先淘汰 ttl 小的 |

### 8.3 近似 LRU / LFU

- **不是全局 LRU**（那需要维护双向链表，代价大）
- **采样 LRU**：`maxmemory-samples 5`——随机采 5 个 key 淘汰最老的
- LFU 用**对数计数器 + 衰减**近似频率

### 8.4 内存分配器：jemalloc

- **默认 jemalloc**（相比 glibc malloc 减少内存碎片 20%+）
- `INFO memory` 里 `mem_fragmentation_ratio` > 1.5 说明碎片严重
- **4.0+ `activedefrag yes`**：在线内存碎片整理

---

## §9 · 缓存三大问题：穿透 / 击穿 / 雪崩

### 9.1 缓存穿透

- **场景**：查询根本不存在的 key（黑客攻击刷不存在的用户 ID）
- **表现**：缓存无 → 每次都打 DB → DB 崩溃
- **解法**：
  1. **布隆过滤器**：先查 BloomFilter，肯定不存在直接返回
  2. **缓存空值**：`SET key null EX 60` 短过期
  3. **参数校验/风控**：拦截明显非法的请求

### 9.2 缓存击穿

- **场景**：热点 key 突然过期（比如秒杀商品）
- **表现**：过期瞬间大量请求全打到 DB
- **解法**：
  1. **互斥锁**：`SETNX + Lua` 只让一个线程回源
  2. **逻辑过期**：value 里带过期时间，业务层判断是否过期，过期时异步刷新
  3. **热点 key 永不过期**（写场景注意主动更新）

### 9.3 缓存雪崩

- **场景**：大量 key 同时过期，或 Redis 集群整体宕机
- **表现**：DB 瞬时被打爆
- **解法**：
  1. **过期时间加随机**：`EX (3600 + rand(600))`
  2. **多级缓存**：本地 Caffeine + Redis + DB
  3. **熔断降级**：Redis 宕机时返回默认值 / 降级页
  4. **高可用架构**：Sentinel / Cluster

### 9.4 缓存一致性（经典命题）

**三大方案对比**：

| 方案 | 优点 | 缺点 |
|---|---|---|
| Cache Aside（旁路缓存） | 简单直接 | 有短暂不一致窗口 |
| Read/Write Through | 强一致 | 需要中间层 |
| Write Behind | 高吞吐 | 数据丢失风险 |

**Cache Aside 双写不一致的经典分析**：
- 更新时是**先删缓存还是先更 DB**？
- 面试标准答案：**先更新 DB 再删缓存**（`Cache Aside`）
- 极端场景：读线程读缓存 miss → 读 DB 旧值 → 写线程更新 DB → 写线程删缓存 → 读线程写回旧值到缓存 → 不一致
- 解法：**延时双删**（更新 DB 后先删缓存，休眠 500ms 再删一次）+ 订阅 binlog 补偿

**监听 binlog 方案**（推荐生产）：Canal / Debezium 订阅 MySQL binlog → 精确删除对应缓存

---

## §10 · 分布式锁：SETNX / Redlock / lease

### 10.1 基础版

```
SET lock_key uuid NX EX 30  -- 原子 setnx + expire
业务操作...
if GET(lock_key) == uuid: DEL(lock_key)  -- 保证只删自己的锁
```

**关键点**：
- **必须原子**：不能先 SETNX 再 EXPIRE（宕机会漏 expire → 永久锁）
- **必须带 uuid**：避免误删别人的锁
- **释放锁必须用 Lua**（`GET + DEL` 在 Lua 里原子）

### 10.2 Redlock（多实例）

**动机**：单节点 Redis 主从异步复制，主宕从升主时锁可能丢失。

**过程**：
1. 客户端向 **N 个独立 Master** 依次申请锁
2. 超过 **N/2+1** 个成功 + **总耗时 < 锁 ttl** → 获取成功
3. 失败则依次释放已获取的锁

**争议**：
- **Martin Kleppmann 批评**：进程 GC 长暂停会导致锁失效但客户端不知道 → **fencing token** 解决
- **antirez 回击**：Redlock 是为无高精度时钟的分布式场景做的合理折中
- **生产建议**：如果强一致要求高，**用 ZK / etcd** 而不是 Redlock

### 10.3 lease + 续期（Redisson 方案）

- 锁 ttl 30s，客户端启动**看门狗**每 10s 续期一次
- 客户端崩溃 → 无人续期 → 30s 后自动释放
- **优点**：业务不需要预估执行时长

---

## §11 · Lua 脚本与原子性

### 11.1 为什么用 Lua

- Redis 保证 **Lua 脚本执行期间原子性**（单线程模型天然保证）
- 减少网络往返（多命令一次发送）
- 复杂逻辑下沉到 Redis 侧

### 11.2 EVAL 与 EVALSHA

```
EVAL "return redis.call('SET', KEYS[1], ARGV[1])" 1 mykey myvalue
```

- 生产用 `SCRIPT LOAD` + `EVALSHA` 缓存 SHA1
- **陷阱**：脚本迁移到新节点时 SHA 缓存丢失 → 需要重试 `NOSCRIPT` 错误

### 11.3 限流：滑动窗口 Lua

```lua
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count < limit then
    redis.call('ZADD', key, now, now)
    redis.call('EXPIRE', key, window / 1000)
    return 1
else
    return 0
end
```

### 11.4 脚本注意事项

- **不能有慢命令**（`KEYS *` / 大 range）→ 阻塞主线程
- **不能有随机性**（`RANDOMKEY` 会破坏主从一致）—— 4.0 起用 `redis.replicate_commands()` 或 Function（7.0+）
- **必须声明所有 KEYS**（Cluster 需要）

---

## §12 · 事务：MULTI/EXEC/WATCH 与其局限

- **不是关系数据库事务**：无回滚，中间命令报错其他命令仍执行
- **WATCH 实现乐观锁**：CAS，被 watch 的 key 被改则 EXEC 返回 nil
- **无隔离级别**：Redis 单线程本来就没有并发问题
- **推荐用 Lua 代替**：Lua 原子性更强，性能更好

---

## §13 · pipeline / mget / cluster pipeline

- **pipeline**：一次发送 N 条命令，一次收 N 个响应 —— 减少 **N 次 RTT**
- **网络吞吐提升 10~50x**（跨机房场景尤其）
- **注意**：pipeline **不是事务**，中间命令不隔离
- **Cluster pipeline** 需要按槽拆分（Jedis JedisCluster、Lettuce 支持）

---

## §14 · 大 key / 热 key / 慢查询

### 14.1 大 key

- **定义**：value > 10KB（string）或元素 > 1w（list/hash/set/zset）
- **危害**：网络传输阻塞、迁移时集群卡顿、删除时阻塞（`DEL` 是 O(N)）
- **发现**：
  - `redis-cli --bigkeys` 采样
  - `MEMORY USAGE key`
  - `SCAN + TYPE + STRLEN/LLEN/HLEN`
- **删除**：`UNLINK`（4.0+）异步删除，不阻塞

### 14.2 热 key

- **定义**：单 key QPS 数万以上
- **危害**：单机 CPU 打满，其他 key 受影响
- **发现**：`redis-cli --hotkeys`（需要 `maxmemory-policy` 是 LFU）
- **解法**：
  - **多副本**：`hotkey:{0..9}` 打散到 10 个 key（写广播、读随机）
  - **本地缓存**：应用层 Caffeine 挡一层
  - **读写分离**：读从库

### 14.3 慢查询

- `SLOWLOG GET 10` 查看慢日志
- `slowlog-log-slower-than 10000`（10ms）
- **常见慢命令**：`KEYS *` / `HGETALL 大 hash` / `SMEMBERS 大 set` / `ZRANGE 0 -1`
- **代替**：`SCAN` / `HSCAN` / `SSCAN` 增量遍历

---

## §15 · 生产实战：TCUM / 告警场景下的用法

### 15.1 告警去重（幂等）

```
SET alarm:hash:<md5(alertname+labels)> 1 NX EX 300
```
- **NX** 保证原子
- **300s** 过期防止 key 无限增长
- 告警去重时间窗内相同告警不重复发送

### 15.2 告警状态机

- Hash：`alarm:state:<id>`
- 字段：`status=pending/firing/resolved`、`fire_at`、`last_notified_at`
- **典型操作**：`HSET` 状态、`HINCRBY` 计数、`EXPIRE` 兜底

### 15.3 限流（Prometheus 告警通道限流）

- 滑动窗口 zset + Lua（§11.3）
- 保护下游通知网关（企业微信 / 邮件 / 电话）

### 15.4 CMDB 元数据热缓存

- Hash 存储对象元数据（CI 属性）
- Pipeline 批量 HGET 减少 RTT
- **TTL 5 分钟** + **binlog 订阅精确失效**（Canal）

### 15.5 Kafka 消费位点辅助缓存

- 消费者本地做 checkpoint 快照到 Redis
- 崩溃恢复时优先读 Redis（比 __consumer_offsets 快）

### 15.6 SLO 计数

- `INCRBY error_5xx 1` + `INCRBY total 1`
- 每分钟 dump 到 ClickHouse 做长期存储

---

## §16 · 版本演进（3.x → 7.x）与新特性

| 版本 | 关键特性 |
|---|---|
| 3.0 | Cluster |
| 3.2 | quicklist、GEO |
| 4.0 | 混合持久化、LFU、UNLINK、模块 |
| 5.0 | **Stream**、ZPOPMIN/MAX |
| 6.0 | **IO 多线程**、ACL、RESP3、cluster proxy 建议 |
| 6.2 | Cluster shard pubsub、副本迁移 |
| 7.0 | **Function**（替代 Lua）、Sharded Pubsub、listpack 全面取代 ziplist、client-eviction |
| 7.2 | 更好的 memory reporting、Set listpack 编码 |
| 7.4+ | Streams 优化 |

---

## §17 · 50 问详解

### 【架构与原理】

**Q1. Redis 为什么快？三个核心原因？**
> ① 纯内存操作（无磁盘 IO） ② 单线程避免锁和上下文切换 ③ IO 多路复用（epoll）支持海量连接。补充：紧凑的 RESP 协议 + 高效数据结构 + C 语言零 GC。

**Q2. 单线程为什么能扛 10w QPS？**
> Redis 命令绝大多数是 O(1)/O(logN)，CPU 不是瓶颈。瓶颈在网络 IO 和内存带宽。单线程避免了锁竞争和上下文切换开销。6.0 引入 IO 多线程进一步提升到 20w+。

**Q3. Redis 单线程模型下，多个客户端命令是并行的还是串行的？**
> 命令处理是**串行**的（单线程），但网络 IO 在 6.0+ 是**并行**的（多个 IO 线程）。任意时刻只有一条命令在执行。

**Q4. Redis 6.0 的多线程做了什么？**
> 只把**协议解析**和 **socket read/write** 交给 IO 线程池。命令执行仍在主线程串行。默认关闭，通过 `io-threads 4` 开启。不解决 Lua/大 key 慢的问题。

**Q5. 事件循环 ae 是怎么工作的？**
> Reactor 模式：epoll_wait 阻塞等 IO 事件 → 遍历就绪 fd 调用读/写回调 → 执行时间事件（cron）→ beforeSleep hook（AOF flush 等）→ 循环。

### 【数据结构】

**Q6. String 底层 SDS 有什么优势？**
> ① O(1) 求长度（Java String 也是）② 二进制安全（不像 C 字符串以 \0 结尾）③ 预分配减少 realloc ④ 惰性释放 ⑤ 三种编码 int/embstr/raw 节省空间。

**Q7. 为什么 embstr 边界是 44 字节？**
> jemalloc 64B chunk - robj 头 16B - sds 头 3B - \0 1B = 44B。刚好一次 malloc 分配。

**Q8. List 从 linkedlist 到 quicklist 再到 listpack quicklist，为什么？**
> linkedlist 每节点 malloc + 前后指针内存开销大；ziplist 内存紧凑但**连锁更新**（某节点扩容触发级联）；quicklist 是分段 ziplist 双向链表兼顾空间和随机访问；7.0 listpack 每 entry 自记录长度**根除连锁更新**。

**Q9. Hash 为什么用渐进式 rehash？**
> 一次性 rehash 大 hash 会阻塞主线程几秒。渐进式：`ht[0]/ht[1]` 双表，每次命令搬 1 个 bucket，读写双查，避免长阻塞。

**Q10. ZSet 为什么用跳表不用红黑树/B+树？**
> ① 实现简单（作者原话）② 范围查询原生支持（红黑树需要中序遍历难）③ 无锁并发扩展性好（虽然 Redis 单线程用不上，但设计前瞻）④ 内存开销和红黑树相近。

**Q11. 跳表的时间复杂度和空间复杂度？**
> 时间 O(logN) 平均，空间 O(N)（每个节点期望 2 层指针）。

**Q12. Stream vs List 消息队列？**
> Stream：消费组、消息确认（XACK）、pending 追踪（XPENDING）、消息回溯（XREAD ID）。List：只支持简单入出，无消费组、无确认、消息一旦 POP 就丢失。5.0 后 List 不推荐用作可靠队列。

**Q13. HyperLogLog 的误差是多少？内存占用？**
> 误差 0.81%，内存 12KB 估计 2^64 基数。原理是 14 位 bucket × 6 位 rank，用调和平均 + LogLog 修正。

**Q14. Bitmap 能存多大？**
> 单 key 上限 512MB（string 上限）→ 40 亿个 bit。适合日活签到（每个用户 1 bit / 天 → 1000w 用户 30 天 = 3.5MB）。

### 【持久化】

**Q15. RDB 和 AOF 的区别？**
> RDB 是二进制快照，紧凑恢复快，会丢数据；AOF 是命令日志，最多丢 1s（everysec），恢复慢。混合持久化（4.0+）= RDB + 增量 AOF，兼顾两者。

**Q16. BGSAVE 的原理？为什么用 fork？**
> fork 子进程共享父进程内存（COW），子进程遍历内存序列化到磁盘，不阻塞主线程。COW 只有写时才复制页，通常父进程写不多所以内存开销小。

**Q17. fork 的代价？**
> 大内存实例 fork 需要几十甚至几百 ms（页表复制）。这段时间父进程完全阻塞。解法：控制单实例内存 <10GB，`vm.overcommit_memory=1`。

**Q18. AOF fsync 三种策略如何选？**
> `always` 强一致但性能腰斩；`everysec` **生产标配**，最多丢 1s；`no` 交给 OS 最多丢 30s。金融场景用 always，一般业务 everysec。

**Q19. AOF 重写是什么？**
> AOF 越写越大，重写会 fork 子进程根据**当前内存**重新生成最小化 AOF。父进程期间用双 buffer（AOF buffer + AOF rewrite buffer）保证不丢命令。

**Q20. 混合持久化如何工作？**
> AOF 重写时前半是 RDB 二进制、后半是增量 RESP 命令。恢复时先加载 RDB 快照再重放增量。恢复速度 ≈ RDB，丢失 ≤ 1s。

### 【复制与集群】

**Q21. 主从全量复制流程？**
> 从连主 → 发 PSYNC ? -1 → 主 BGSAVE 生成 RDB → 传给从 → 从加载 → 主追加期间的写命令。

**Q22. psync2 相比 psync1 改进了什么？**
> ① replid + offset 取代 runid ② 从升主后保留旧 replid → 兄弟从可增量 ③ 从重启后可能仍能增量（backlog 够）。**避免不必要的全量复制**。

**Q23. 主从数据一致吗？**
> **异步复制不强一致**。`WAIT N T` 等待 N 个副本确认但不保证。生产建议 `min-replicas-to-write 1` + `min-replicas-max-lag 10` 兜底。

**Q24. Sentinel 的三大职责？**
> 监控（ping）、通知（pub/sub）、故障转移（选新主、切换客户端）。

**Q25. Sentinel 选主规则？**
> ① priority 高 ② offset 大（数据最全）③ runid 字典序小。priority=0 永不当选。

**Q26. Cluster 为什么是 16384 槽？**
> 心跳携带槽 bitmap，16384 bit = 2KB 心跳开销可接受。65536 会到 8KB。1000 节点上限 16384 足够。

**Q27. Cluster 客户端如何路由？**
> 客户端本地维护槽→节点映射。首次或路由错时收到 MOVED/ASK 更新映射。Cluster-aware 客户端如 Lettuce / JedisCluster 自动处理。

**Q28. MOVED 和 ASK 区别？**
> MOVED：槽已永久迁移 → 客户端更新本地映射。ASK：槽正在迁移中，本次去新节点但**不更新映射**（因为迁移还没完成）。

**Q29. Cluster 支持多 key 命令吗？**
> 只有**同槽**才支持。用 hashtag `{user1}` 强制同槽。跨槽的 MGET/MULTI/Lua 会报错 CROSSSLOT。

**Q30. Cluster 集群里主宕机怎么办？**
> 从节点检测到主宕（gossip） → 发起选举 → 其他主投票 → 得票 >= N/2+1 从升主 → 广播新配置。**不需要 Sentinel**，集群内自治。

### 【内存与淘汰】

**Q31. Redis 内存达到 maxmemory 会怎样？**
> 触发淘汰策略（默认 noeviction 直接写失败）。生产建议 allkeys-lru 或 allkeys-lfu。

**Q32. LRU 和 LFU 什么区别？**
> LRU 淘汰**最久未访问**的；LFU 淘汰**访问频率最低**的（带时间衰减）。突发访问的冷 key 在 LRU 下会污染缓存，LFU 更抗污染。**热点场景推 LFU**。

**Q33. Redis 的 LRU 是精确的吗？**
> 不是。全局 LRU 需要双向链表代价大。Redis 用**采样近似**：随机 5 个 key 淘汰最老的（`maxmemory-samples`）。

**Q34. 过期 key 是怎么删除的？**
> ① 惰性删除：访问时检查 ② 定期删除：cron 每 100ms 抽样一批。冷 key 靠淘汰策略兜底。

**Q35. 内存碎片怎么处理？**
> `INFO memory` 看 `mem_fragmentation_ratio`，> 1.5 严重。4.0+ 开 `activedefrag yes` 在线整理。极端情况重启。

### 【缓存问题】

**Q36. 缓存穿透如何解决？**
> ① 布隆过滤器拦截 ② 缓存空值短过期 ③ 参数校验/风控。

**Q37. 缓存击穿如何解决？**
> ① 互斥锁（SETNX + Lua）只让一个线程回源 ② 逻辑过期异步刷新 ③ 热点 key 永不过期。

**Q38. 缓存雪崩如何解决？**
> ① 过期时间加随机抖动 ② 多级缓存（本地 + Redis + DB）③ 熔断降级 ④ 高可用架构。

**Q39. 数据库和缓存双写一致性如何保证？**
> **Cache Aside**：先更新 DB 再删除缓存。极端不一致场景用**延时双删** + **订阅 binlog 补偿**（Canal/Debezium）。

**Q40. 为什么是"删除缓存"不是"更新缓存"？**
> ① 删除是懒计算（下次读时才回源计算），减少无效更新 ② 并发写场景更新顺序难保证 ③ 大对象更新代价高。

### 【分布式锁】

**Q41. Redis 分布式锁怎么实现？**
> `SET key uuid NX EX 30` + Lua 释放。**必须原子 setnx+expire**，**必须带 uuid 防误删**，**释放必须 Lua**。

**Q42. Redlock 是什么？为什么有争议？**
> 向 N 个独立主节点申请锁，超过 N/2+1 且总耗时 < ttl 视为成功。**争议**：GC 长暂停会导致锁失效但客户端不知道 → 需要 fencing token（单调递增）解决。强一致场景不建议用 Redis，用 ZK/etcd。

**Q43. Redisson 的看门狗是什么？**
> 客户端启动定时任务每 ttl/3 续期一次。业务卡住时锁不会过期，客户端崩溃则 30s 后自动释放。相比手写更健壮。

**Q44. 主从异步复制会导致锁失效吗？**
> 会。主写入锁后未复制到从 → 主宕 → 从升主 → 锁"消失" → 别人可以再获取。这就是 Redlock 想解决的问题。

### 【运维与故障】

**Q45. 大 key 如何发现和处理？**
> 发现：`redis-cli --bigkeys` / `MEMORY USAGE`。删除：**UNLINK**（异步）代替 DEL。改造：拆成多个小 key 或换存储。

**Q46. 热 key 如何发现和处理？**
> 发现：`redis-cli --hotkeys`（LFU 策略下）或代理层统计。处理：多副本 hotkey:0..9 打散、本地缓存、读从库。

**Q47. Redis 慢查询怎么排查？**
> `SLOWLOG GET 10` 查看，`slowlog-log-slower-than 10000` 阈值。常见慢命令：`KEYS *` / 大 range / 大 hash `HGETALL`。用 SCAN 系列替代。

**Q48. Redis 主从延迟大怎么办？**
> ① 检查网络带宽 ② 主实例是否有大 key/大 value ③ 从节点是否 IO 满 ④ `repl-backlog-size` 调大避免全量 ⑤ 磁盘持久化压力（AOF fsync）。

**Q49. Redis 内存突增怎么排查？**
> ① `INFO memory` 看 used_memory / used_memory_rss ② `MEMORY STATS` 看 dataset.bytes ③ 大 key 扫描 ④ 检查是否有慢查询（Lua 脚本占用）⑤ 客户端 output buffer 是否堆积（pub/sub 慢消费者）。

**Q50. Redis Cluster 扩容缩容流程？**
> 扩容：加新节点 → `cluster add-node` → `reshard` 迁移槽（`MIGRATE` 命令逐 key 迁）→ 完成后新节点开始接收流量。缩容：`reshard` 把槽迁走 → `del-node`。**在线迁移不中断服务**，客户端通过 ASK/MOVED 感知。

### 【补充深度题】

**Q51. Redis 的 pub/sub 有什么缺陷？**
> ① 消息不持久化，订阅者掉线丢消息 ② 无消费组 ③ 慢消费者会撑爆 output buffer。生产用 **Stream** 或 Kafka 替代。

**Q52. Redis 事务和 MySQL 事务的本质区别？**
> Redis 事务：**无回滚**（中间命令报错其他仍执行）、无隔离级别（单线程）、WATCH 是乐观锁 CAS。适合原子批处理不适合强事务场景。

**Q53. Lua 脚本能保证原子性但为什么不能替代事务？**
> 能。Lua 执行期间**独占**主线程，任何其他命令都在等待。生产**优先用 Lua**，MULTI/EXEC 已成历史。

**Q54. Redis 的 GEO 底层原理？**
> 用 zset 存储，score = 52 位 GeoHash 整数。`GEORADIUS` 通过范围查询 + 精确距离过滤。

**Q55. Redis 如何做延时队列？**
> ZSet + score=到期时间戳。生产者 `ZADD queue <ts> <task>`。消费者循环 `ZRANGEBYSCORE queue 0 now LIMIT 0 100` + `ZREM`（用 Lua 原子）。比 List 灵活。

**Q56. Redis 网络协议 RESP 是文本还是二进制？**
> RESP 2 主要是**文本行**（`\r\n` 分隔），但支持**二进制安全**（bulk string 带长度）。RESP 3（6.0+）支持更多类型（map/set/verbatim）。

**Q57. Redis 客户端连接数上限？**
> `maxclients 10000`（默认）。受限于文件描述符 `ulimit -n`。生产上单实例 5000~2w 连接常见，太多导致 accept 慢。

**Q58. Redis 为什么建议单实例内存 < 10GB？**
> ① fork 代价大 ② 主从全量复制传输慢 ③ 恢复时间长（AOF 重放 / RDB 加载）④ 淘汰扫描慢。大规模用 Cluster 分片。

**Q59. Redis 客户端超时怎么设？**
> connect 500ms，read 1s，业务侧再包一层熔断（Sentinel/Hystrix）。大 key 场景 read 可以放大到 3s 但要监控。

**Q60. Redis 生产必须开哪些关键配置？**
> ① `maxmemory` + `maxmemory-policy allkeys-lru` ② `appendonly yes` + `everysec` ③ `save 3600 1 300 100 60 10000` ④ `min-replicas-to-write 1` ⑤ `min-replicas-max-lag 10` ⑥ `slowlog-log-slower-than 10000` ⑦ `tcp-keepalive 60` ⑧ 关闭危险命令 `rename-command KEYS ""`。

---

## §18 · 短板与坑

1. **大 key 是万恶之源**：网络、复制、迁移、删除全遭殃。
2. **fork 是延迟毒药**：内存越大越明显。
3. **单命令阻塞整个实例**：Lua 脚本、`KEYS *`、大 range 是刺客。
4. **主从异步复制不强一致**：分布式锁、幂等场景注意。
5. **Cluster 多 key 限制**：hashtag 必须提前设计。
6. **pub/sub 不可靠**：不要拿它做消息队列。
7. **Redis 事务弱**：没回滚，Lua 更好。
8. **过期删除不精确**：占内存直到被访问或触发淘汰。
9. **客户端连接管理坑多**：连接泄漏、pipeline 顺序错乱。
10. **热 key 单点瓶颈**：单机 CPU 上限约 10w QPS。

---

## §19 · 面试话术模板

### 3 分钟自述

> "我在 TCUM 全链路里深度使用 Redis：告警去重、状态机、限流、CMDB 热缓存、Kafka 消费位点辅助。
>
> **对 Redis 最深三点理解**：
> - **单线程 + IO 多路复用**是快的本质，但 6.0 引入 IO 多线程解决了 read/write 系统调用瓶颈，命令执行仍串行以保持无锁模型。
> - **数据结构决定生产用法**：Stream 取代 List 做可靠队列，ZSet 做延时任务和排行榜，HyperLogLog 做 UV，Bitmap 做签到——每种结构都有场景绑定。
> - **持久化和高可用是三层防线**：混合持久化保证秒级 RPO，主从异步复制保证读扩展，Sentinel/Cluster 保证故障自动切换。**但异步复制天然不强一致**，分布式锁场景要么用 Redlock（有争议），要么切 ZK/etcd。
>
> **生产血泪**：大 key 引发的雪崩、fork 引发的延迟毛刺、缓存击穿引发的 DB 打爆——每一次都是配置和数据结构选型的教训。"

### 反问 5 问

1. Redis 版本？6.0+ IO 多线程开了吗？
2. 单实例内存多大？fork 延迟监控在多少？
3. Cluster 还是 Sentinel？迁移过槽吗？
4. 缓存一致性怎么保证的？Cache Aside 还是 binlog 订阅？
5. 分布式锁场景强一致要求高不高？Redlock 还是 ZK/etcd？

---

**本篇完 · 约 26KB · 覆盖机制/结构/持久化/复制/集群/缓存/锁/运维/60 问**

**证据基线**：
- antirez 关于 16384 槽位的原文说明
- Redis 6.0 IO 多线程 release notes
- Martin Kleppmann 关于 Redlock 的批评（"How to do distributed locking"）
- antirez 关于 Redlock 的回击
- Redis 官方 docs：https://redis.io/docs/
- 生产实战：TCUM 告警去重、CMDB 热缓存、限流令牌桶
