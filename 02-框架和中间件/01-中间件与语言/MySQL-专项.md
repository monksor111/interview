# 第五卷 · 中间件 · MySQL 专项

> **本篇定位**：MySQL（InnoDB）在 TCUM/CMDB 体系里承担**元数据主库**（CMDB CI / 变更审计 / 用户权限 / 告警配置 / 监控规则），要求 ACID + 高一致 + 中等吞吐。本文覆盖存储引擎、索引、事务、锁、MVCC、redo/undo/binlog、主从复制、分库分表、性能诊断、40+ 高频面试题。密度对齐 `tcum-ai/01`，力求"面试敢讲，生产敢用"。

## 📖 目录
- §1 命题：为什么 InnoDB 是默认引擎
- §2 存储结构：表空间 / 段 / 区 / 页 / 行
- §3 索引：B+ 树、聚簇 / 二级、覆盖、回表、最左匹配
- §4 事务：ACID 与四大隔离级别
- §5 MVCC：ReadView、trx_id、undo 链
- §6 锁：全局锁、表锁、行锁、间隙锁、临键锁、意向锁
- §7 redo log / undo log / binlog：两阶段提交
- §8 buffer pool、change buffer、log buffer
- §9 主从复制：statement / row / mixed、半同步、GTID
- §10 分库分表：垂直 / 水平、路由、跨库事务
- §11 SQL 优化：执行计划、慢查询、Optimizer
- §12 生产故障：死锁、幻读、主从延迟、大事务
- §13 8.0 新特性：CTE、Window、隐藏索引、原子 DDL
- §14 生产实战：CMDB / 变更审计 / 元数据主库
- §15 50 问详解
- §16 短板与坑
- §17 面试话术模板

---

## §1 · 命题：为什么 InnoDB 是默认引擎

### 一句话背诵

> "InnoDB 是 MySQL 唯一能扛核心业务的引擎——**支持事务（ACID）、行级锁、MVCC 无锁读、聚簇索引、崩溃恢复、外键**。MyISAM 只有表锁、无事务、无崩溃恢复，只适合归档只读。"

### InnoDB vs MyISAM 五点对照

| 维度 | InnoDB | MyISAM |
|---|---|---|
| 事务 | ✅ ACID | ❌ |
| 锁粒度 | 行锁 | 表锁 |
| 崩溃恢复 | ✅ redo | ❌ |
| 索引结构 | 聚簇（主键 = 数据） | 非聚簇（数据分离） |
| 外键 | ✅ | ❌ |

### InnoDB 的六大核心组件

1. **buffer pool**：内存池缓存数据页 + 索引页 + change buffer + 自适应哈希 + 锁信息
2. **redo log**：物理日志，WAL 保证崩溃恢复
3. **undo log**：逻辑日志，MVCC 快照 + 事务回滚
4. **binlog**：MySQL 层的逻辑日志，主从复制 + 归档
5. **B+ 树索引**：聚簇索引 + 二级索引
6. **行锁引擎**：Record / Gap / Next-Key / Insert Intention

---

## §2 · 存储结构：表空间 / 段 / 区 / 页 / 行

### 层级结构

```
表空间 tablespace（ibd 文件）
  └─ 段 segment（叶子段、非叶子段、回滚段）
       └─ 区 extent（1MB，64 个连续 16K 页）
            └─ 页 page（16KB，最小 IO 单位）
                 └─ 行 row（4 种格式：Compact / Redundant / Dynamic / Compressed）
```

### 关键点

- **默认页大小 16KB**：一次磁盘 IO 读取 16KB
- **区 1MB**：段扩展的最小单位，减少碎片
- **系统表空间**（ibdata1）+ **独立表空间**（每表一个 ibd，默认开启）
- **临时表空间**（ibtmp1）用于排序、临时表
- **undo 表空间**（undo_001/002）8.0 起独立

### 行格式

- **Compact / Dynamic（默认）**：变长字段列表 + null 位图 + 记录头 + 列值
- **Dynamic**：大字段（varchar >768B）**溢出到独立页**，只留 20B 指针
- **Compressed**：Dynamic 基础上压缩

---

## §3 · 索引：B+ 树、聚簇 / 二级、覆盖、回表、最左匹配

### 3.1 为什么用 B+ 树而不是 B 树 / 红黑树 / 跳表 / Hash

| 结构 | 优点 | 缺点 |
|---|---|---|
| B+ 树 | 磁盘友好（矮胖）+ 范围查询原生（叶子链表）+ 稳定 O(logN) | — |
| B 树 | 内部节点存数据，某些点查快 | 范围查询要中序遍历，磁盘不友好 |
| 红黑树 | 内存高效 | 高瘦，磁盘 IO 多 |
| 跳表 | 简单 | 空间开销大，Redis 用 |
| Hash | O(1) 点查 | **不支持范围**、无序，MySQL 自适应 hash 用 |

**磁盘友好**的本质：B+ 树 3~4 层就能容纳千万级数据（16KB 页 × 1000 分支因子 ^ 4 = 1 亿行），意味着**任何查询最多 3~4 次 IO**。

### 3.2 聚簇索引 vs 二级索引

- **聚簇索引**：**主键 = 数据本身**，叶子节点就是完整行。一张表只有一个。
- **二级索引**（非聚簇）：叶子节点存 **主键值**，查完再回表查主键树。

**回表**：二级索引查到主键 → 再去聚簇索引查完整行。**多一次 B+ 树查询**。

### 3.3 覆盖索引

- **查询字段全在索引里** → 不用回表
- 例：`SELECT id, name FROM t WHERE name='x'`，`idx(name)` 已含 name + id，直接返回
- **面试点**：`EXPLAIN` 里 Extra 显示 `Using index` 即覆盖

### 3.4 最左匹配原则

- 联合索引 `idx(a, b, c)` 生效前提：查询必须**从最左连续**
- 生效：`WHERE a=1` / `WHERE a=1 AND b=2` / `WHERE a=1 AND b=2 AND c=3`
- **不生效**：`WHERE b=2`（跳过 a）/ `WHERE a=1 AND c=3`（c 部分不生效但 a 生效）
- **范围查询后失效**：`WHERE a=1 AND b>2 AND c=3` → c 不走索引
- **原理**：B+ 树按 (a,b,c) 排序，先 a 后 b 再 c

### 3.5 索引失效场景

1. `LIKE '%xxx'`（前缀模糊）
2. 字段做函数/运算：`WHERE DATE(t) = '2024-01-01'` → 改为 `WHERE t >= '2024-01-01' AND t < '2024-01-02'`
3. 隐式类型转换：`WHERE phone = 13800001111`（phone 是 varchar）
4. `OR` 两侧有非索引列
5. **不等条件**：`!=` / `NOT IN`（视选择率）
6. 索引选择率低（如 gender），优化器可能全表扫

### 3.6 索引下推 ICP（5.6+）

- 联合索引 `(a,b)`，`WHERE a=1 AND b LIKE 'x%'`
- **旧**：只用 a 过滤，回表后再判 b
- **ICP**：把 b 的条件下推到索引扫描阶段，减少回表次数
- `EXPLAIN` Extra 显示 `Using index condition`

### 3.7 MRR（Multi-Range Read）

- 二级索引回表时先按主键排序 → 顺序 IO → 提升吞吐

### 3.8 索引选型经验

- **区分度高的列放前面**（联合索引）
- **前缀索引**：`idx(name(10))` 长字段节省空间
- **不要索引小表**（<1000 行全表扫更快）
- **避免过多索引**：写放大 + buffer pool 竞争

---

## §4 · 事务：ACID 与四大隔离级别

### 4.1 ACID

- **A 原子性 Atomicity**：undo log 支持回滚
- **C 一致性 Consistency**：约束（PK/FK/UK/CHECK）+ 事务的最终结果
- **I 隔离性 Isolation**：MVCC + 锁
- **D 持久性 Durability**：redo log WAL + fsync

### 4.2 四大隔离级别

| 级别 | 脏读 | 不可重复读 | 幻读 |
|---|---|---|---|
| Read Uncommitted | ✅ | ✅ | ✅ |
| Read Committed（RC） | ❌ | ✅ | ✅ |
| **Repeatable Read（RR，MySQL 默认）** | ❌ | ❌ | InnoDB 通过间隙锁避免 |
| Serializable | ❌ | ❌ | ❌ |

### 4.3 三种读现象

- **脏读**：读到其他事务未提交的数据
- **不可重复读**：同一事务内两次读同一行结果不同（其他事务 update 提交了）
- **幻读**：同一事务内两次范围查询结果集不同（其他事务 insert 了新行）

### 4.4 MySQL 默认 RR 但生产多用 RC 的原因

- **binlog 早期只支持 statement 模式，RR 保证主从一致**
- 现在 row 模式后 RC 也安全
- **RC 减少锁竞争**：只锁存在的行，不锁间隙 → 高并发场景性能更好
- 阿里、腾讯、字节等大厂**生产标配 RC**

---

## §5 · MVCC：ReadView、trx_id、undo 链

### 5.1 核心机制

每行记录有隐藏三列：
- `DB_TRX_ID`：最近修改事务 ID
- `DB_ROLL_PTR`：指向 undo log 前一版本
- `DB_ROW_ID`：无主键时的隐藏主键

**多版本**：一次 update 生成新版本行 + undo log 保留旧版本，形成**版本链**。

### 5.2 ReadView（快照）

事务开启时（或第一次快照读时）生成 ReadView：
- `m_ids`：当前活跃事务 ID 集
- `min_trx_id`：m_ids 最小值
- `max_trx_id`：下一个要分配的事务 ID
- `creator_trx_id`：创建 ReadView 的事务 ID

### 5.3 可见性判断

沿着 undo 链找符合可见性的版本：
- `trx_id < min_trx_id` → **可见**（提交较早）
- `trx_id >= max_trx_id` → **不可见**（后开启）
- `trx_id ∈ m_ids` → **不可见**（活跃未提交）
- 否则 → **可见**（在 ReadView 生成前已提交）

### 5.4 RC vs RR 的 ReadView 差别

- **RC**：**每次 SELECT 生成新 ReadView** → 能看到其他事务的最新提交
- **RR**：**事务第一次 SELECT 生成 ReadView 并沿用** → 事务内所有快照读一致

### 5.5 快照读 vs 当前读

- **快照读**：普通 `SELECT`，走 MVCC 读旧版本，**不加锁**
- **当前读**：`SELECT ... FOR UPDATE / LOCK IN SHARE MODE / UPDATE / DELETE / INSERT`，读最新版本，**加锁**

### 5.6 RR 真的能避免幻读吗？

**部分能，部分不能**：
- **快照读**：MVCC 保证一致快照，看不到新插入
- **当前读**：InnoDB 用**间隙锁 + 临键锁**锁住范围，防止 insert → 也能避免
- **但混用快照读和当前读会出问题**：事务内先快照读 A，再 UPDATE A → A 变了但没锁到 → 别人 insert 后二次快照读还是原样，二次当前读却看到新行 → **幻读现象**

---

## §6 · 锁：全局锁、表锁、行锁、间隙锁、临键锁、意向锁

### 6.1 锁的粒度

- **全局锁**：`FLUSH TABLES WITH READ LOCK` → 只读，全库备份用
- **表锁**：`LOCK TABLES t READ/WRITE`
- **元数据锁 MDL**：DDL 期间隐式加，阻塞其他 DDL 和 DML
- **意向锁 IS/IX**：表级，标记有行锁的意图（避免遍历所有行锁）
- **行锁**：InnoDB 核心

### 6.2 行锁细分（RR 下）

- **Record Lock**：锁单行索引记录
- **Gap Lock**：锁两条记录之间的区间（不锁记录本身）
- **Next-Key Lock**：Record + Gap（左开右闭）
- **Insert Intention Lock**：插入前先加，冲突时等待

### 6.3 加锁规则（RR）

**核心原则**：加锁的基本单位是 next-key lock，但有优化：
- **等值查询命中唯一索引**：退化为 Record Lock
- **等值查询非唯一索引**：Record + 右侧 Gap（防止右侧插入相同值）
- **范围查询**：next-key 一直锁到范围外的第一个值

**面试血泪题**：
```sql
UPDATE t SET v=1 WHERE id > 10 AND id < 20;
-- 假设 id=15 存在，其他不存在
-- 会锁：(10,15], (15,20]（如果 id 到 25，还会锁 (20,25]）
```

### 6.4 死锁

- **两个事务相互等待对方的锁**
- **检测**：InnoDB 自动死锁检测（等待图算法），**主动 rollback 一个事务**
- **`innodb_deadlock_detect=ON`**：8.0 高并发可以关闭，改用 `lock_wait_timeout`

**规避**：
- 固定资源加锁顺序
- 事务尽量短小
- 避免大范围加锁

---

## §7 · redo log / undo log / binlog：两阶段提交

### 7.1 三种日志对比

| 日志 | 层级 | 类型 | 用途 |
|---|---|---|---|
| redo log | InnoDB | 物理（页 XX 偏移 YY 改成 ZZ） | 崩溃恢复 |
| undo log | InnoDB | 逻辑（反向操作） | 回滚 + MVCC |
| binlog | MySQL Server | 逻辑（SQL 或行变更） | 主从复制 + 归档 |

### 7.2 redo log 详解

- **WAL（Write-Ahead Logging）**：先写日志再写数据页
- **循环写入**：`ib_logfile0/1`（默认各 48MB），写满触发 checkpoint 刷盘
- **`innodb_flush_log_at_trx_commit`**：
  - `0`：每秒后台刷（丢 1s）
  - `1`：**默认**，每次 commit fsync（强一致）
  - `2`：commit 时写 OS 缓存，每秒 fsync（OS 崩溃丢 1s）

### 7.3 undo log 详解

- **逻辑日志**：insert → 反向 delete，update → 反向 update
- **两大作用**：事务回滚 + MVCC 快照
- 8.0 起独立表空间 `undo_001/002`，可动态 truncate

### 7.4 binlog 详解

- **三种格式**：
  - `statement`：记录 SQL（小，可能主从不一致，如 `NOW()` `UUID()`）
  - `row`：**记录行变更**（大，一致，**推荐**）
  - `mixed`：混合
- **`sync_binlog`**：
  - `0`：交给 OS
  - `1`：**默认**，每次 commit fsync
  - `N`：每 N 次 commit fsync

### 7.5 两阶段提交（2PC）

**目的**：保证 redo log 和 binlog 一致（否则主从数据不一致）。

**流程**：
1. **redo log prepare**：写入 redo，状态 prepare，事务 ID 落盘
2. **binlog write + fsync**
3. **redo log commit**：redo 状态改 commit

**崩溃恢复**：
- 崩溃时 redo 是 prepare + binlog 完整 → 提交事务
- 崩溃时 redo 是 prepare + binlog 缺失 → 回滚
- 崩溃时 redo 是 commit → 提交

**面试深度点**：
> "两阶段提交是 InnoDB 和 Server 层的解耦代价——两个独立日志系统必须协调。这也是为什么 5.7 起有 group commit 优化：一次 fsync 打包多个事务。"

---

## §8 · buffer pool、change buffer、log buffer

### 8.1 buffer pool

- 默认 128MB（生产调到物理内存 60~80%）
- **LRU 改进版**：
  - **young 区 5/8** + **old 区 3/8**
  - 新页先进 old 区尾部
  - 停留 `innodb_old_blocks_time`（1s）后才能升 young
  - **防止全表扫污染 young 区**
- **预读**：线性预读、随机预读

### 8.2 change buffer

- **只针对二级索引（非唯一）**
- INSERT/UPDATE/DELETE 二级索引页不在 buffer pool 时，**先缓存到 change buffer**
- 后续读取时 merge 到实际页
- **收益**：随机 IO 变顺序 IO
- **不适用**：唯一索引（必须校验唯一性，直接读页）、高频读场景（缓存了立刻要 merge）

### 8.3 脏页刷盘

- **checkpoint**：redo log 写满或系统空闲触发
- `innodb_io_capacity`：IO 能力配置（SSD 建议 2000+）
- **半个刷盘策略**：邻页也一起刷（HDD 优化，SSD 建议关闭 `innodb_flush_neighbors=0`）

---

## §9 · 主从复制：statement / row / mixed、半同步、GTID

### 9.1 复制流程

```
Master                          Slave
  |-- binlog write            
  |-- dump thread ------->|-- IO thread 接收 → relay log
                          |-- SQL thread 重放 relay log
```

### 9.2 三种复制模式

**异步复制（默认）**：
- Master 写完 binlog 立即返回
- Slave 慢，可能丢数据

**半同步复制（5.7 增强）**：
- Master 写完 binlog **等 ≥1 个 Slave ACK** 再返回
- **after_sync（loss-less）**：先等 ACK 再 commit（不丢数据，性能损失）
- **after_commit**：先 commit 再等 ACK（可能主提交但 Slave 未收到）
- **主推 after_sync 保证不丢**

**组复制 MGR（Group Replication）**：
- **Paxos 协议**多主/单主
- 强一致，MySQL 8.0 生产可用
- 是 InnoDB Cluster 基础

### 9.3 GTID

- 全局事务 ID：`server_uuid:transaction_id`
- **好处**：故障切换时新主的 GTID 集清晰，从库轻松找到复制起点
- 5.6 引入，5.7 起生产标配

### 9.4 主从延迟原因

1. **主库大事务**（一次 delete 百万行）→ binlog 巨大 → 从库重放慢
2. **主库并发**远大于从库单线程重放（**8.0 前 SQL thread 单线程是主要瓶颈**）
3. **网络带宽**
4. **从库硬件差**
5. **DDL 长时间执行**

**解法**：
- **并行复制 MTS**（多线程 SQL thread）5.7 起 group commit 并行，8.0 起 WriteSet 更细粒度并行
- 大事务拆小
- 从库配置对齐主库
- 敏感场景强制读主

---

## §9.5 · 集群模式全景：主从 / MHA / MGR / InnoDB Cluster / 分库分表

> MySQL 的集群模式众多，面试常问"你们数据库怎么部署的"、"主宕了怎么办"。本节把 4 种主流集群模式对比透。

### 9.5.1 五种模式对比

| 模式 | 架构 | 选主 | 数据同步 | 数据不丢 | 故障恢复 | 适用场景 |
|---|---|---|---|---|---|---|
| **单主异步** | 1M+NS | 手动 | 异步 binlog | 会丢 | 手动 | 老架构、非核心 |
| **半同步** | 1M+NS | 手动 / MHA | after_sync | 强 | 手动 / MHA 自动 | 生产主流 |
| **MGR 单主** | 1M+NS 都在 group | Paxos 自动 | 组内 certify | 强 | 秒级自动 | 8.0+ 新架构 |
| **MGR 多主** | NM 都可写 | 无（对等） | 组内 certify | 强 | 秒级自动 | 特定冲突低场景 |
| **分库分表** | 多 shard 各自 M+S | 每分片独立 | 各分片自复制 | 依赖分片模式 | 依赖 | 大数据量水平扩展 |

### 9.5.2 传统主从（异步/半同步）

**架构**：
```
      ┌──────┐  写入
      │Master│◄─── Client
      └───┬──┘
          │ binlog dump thread
   ┌──────┼──────┐
   ▼      ▼      ▼
┌──────┐┌──────┐┌──────┐
│Slave1││Slave2││Slave3│ ← 读扩展
└──────┘└──────┘└──────┘
    ▲ IO thread 收 binlog → relay log
    ▲ SQL thread 重放 relay log
```

**三种复制模式**：

1. **异步复制**（默认）：
   - Master 写完 binlog 立即返回给客户端，**不等 slave**
   - 优点：性能最好
   - 缺点：Master 挂了未复制的 binlog 全丢

2. **半同步 after_commit**（5.5，已过时）：
   - Master 先在存储引擎 commit（对其他事务可见）→ 再等 slave ACK
   - 极端情况：Master commit 完但没等到 ACK 就挂 → 其他事务看到过 → **可能"读到已丢失的写"**

3. **半同步 after_sync（无损，5.7+，生产推荐）**：
   - Master 写 binlog + sync → **等 ≥1 slave ACK** → 再存储引擎 commit
   - 保证：所有 client 能读到的数据一定在 ≥1 slave 上
   - 代价：延迟增加 1 个 RTT（1~5ms）

**数据不丢的三层配置**：
```
# Master 侧
innodb_flush_log_at_trx_commit = 1     # redo 每次 fsync
sync_binlog = 1                        # binlog 每次 fsync
rpl_semi_sync_master_enabled = ON      # 半同步
rpl_semi_sync_master_wait_point = AFTER_SYNC   # 无损
rpl_semi_sync_master_timeout = 1000    # 1s 内没 ACK 降级为异步
```

**故障恢复（人工/MHA）**：
- **异步复制主宕**：找 relay log 最完整的 slave 升主 → 其他 slave `CHANGE MASTER TO` 指新主
- **半同步主宕**：ACK 过的 slave 一定有完整数据 → 直接升主
- **MHA / MoHA / Orchestrator 自动化**：秒级检测 + 自动切换 + 客户端 VIP 漂移

**选主规则**：
- **原生 MySQL 无自动选主**，靠外部工具
- MHA 规则：优先级配置 > 复制延迟 > relay log 位置
- 生产惯例：**优先选 offset 最大（binlog 位置最新）的 slave**

**GTID 的价值**：
- 每事务全局唯一 ID：`server_uuid:trx_id`
- 故障切换后：新 slave `CHANGE MASTER TO ... MASTER_AUTO_POSITION=1` **自动定位**
- 相比 file+offset 无需手工找位点，切换效率飞跃

### 9.5.3 MySQL Group Replication (MGR)

**MGR 是 MySQL 官方唯一的原生高可用方案**（8.0 生产可用）。

**架构（单主模式）**：
```
    ┌─────────────────────────────────┐
    │  Replication Group (3~9 节点)   │
    │                                 │
    │  ┌──────┐   ┌──────┐   ┌──────┐│
    │  │Node1 │◄──┤Node2 │◄──┤Node3 ││
    │  │Primary│  │Second│  │Second ││
    │  └──────┘   └──────┘   └──────┘│
    │        Paxos-based consensus    │
    └─────────────────────────────────┘
```

**核心机制**：

1. **数据同步**：
   - 事务 commit 时**不立即持久化到本地 redo**
   - 先广播到所有 group 成员做 **certification**（冲突检测）
   - **多数派**（N/2+1）确认 → 各节点各自 apply
   - 基于 **XCom（Mysql 的 Paxos 变种）**

2. **certification**（冲突检测，MGR 关键）：
   - 每事务包含 write set（写的行集合）+ gtid_executed 快照
   - 各节点独立判断：**自事务快照后是否有其他冲突事务提交**
   - 冲突 → 后到的事务 abort
   - **多主模式冲突多，一般用单主**

3. **成员管理**：
   - 加入：新节点声明加入 → 从 donor 全量复制 → 追平 → 加入 group
   - 退出：主动 STOP 或超时被踢

**选主**（单主模式）：
- Primary 挂了 → 存活成员基于 **成员权重 + server_uuid** 选新 Primary
- **秒级**（< 5s 通常）
- 客户端通过 **MySQL Router / ProxySQL** 感知切换

**数据不丢**：
- 事务需要多数派 ACK 才 commit → 只要多数派存活数据不丢
- **少数派分区自动脱离 group**（避免脑裂）

**数据恢复**：
- 单节点故障：其他节点自动接管，故障节点重启后从 group 拉增量
- 全 group 挂：重启 group（`START GROUP_REPLICATION`）

**MGR vs 半同步**：
| 维度 | 半同步 | MGR |
|---|---|---|
| 一致性 | 至少 1 副本收到 | 多数派确认 |
| 自动切换 | 需 MHA/Orchestrator | 内建 |
| 网络分区 | 可能脑裂 | 少数派自动脱离 |
| 部署 | 简单 | 复杂（需 Router） |
| 生产成熟度 | 极成熟 | 8.0 后可用 |

### 9.5.4 InnoDB Cluster

MySQL 官方**开箱即用**方案，本质是 **MGR + MySQL Router + MySQL Shell**：

```
   Client
     │
     ▼
┌──────────────────┐
│  MySQL Router    │  ← 客户端连它，自动路由
└─┬──────┬─────┬───┘
  ▼      ▼     ▼
┌──────────────────┐
│  MGR Group       │
│  (Node1/2/3)     │
└──────────────────┘
```

- **Router**：读写分离 + 故障感知 + 客户端连接管理
- **Shell**：管理工具（部署、扩容、故障处理）
- **典型部署**：3 或 5 节点 MGR + 2 Router

### 9.5.5 分库分表（水平扩展的终极）

单机瓶颈后（>500w 行/表 或 >5000 QPS/库）→ 分库分表。

**架构**：
```
   Client → ShardingSphere-Proxy / MyCAT
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
     Shard1      Shard2      Shard3    ← 每分片独立主从
   (M+2S)      (M+2S)      (M+2S)
```

**关键点**：
- **每分片是独立的高可用单元**（主从 or MGR）
- **分片键选择**：user_id / tenant_id（原则见 §10.5）
- **跨分片事务**：XA（重）/ 柔性（TCC、Saga、本地消息表）/ 最终一致 + 对账

**面试模板**：
> "生产用 3 分片 × (1M+2S) 共 9 台，每分片主从半同步 after_sync，跨分片写走本地消息表最终一致。ShardingSphere-Proxy 做客户端接入，Orchestrator 做 MySQL 层故障检测和 VIP 漂移。**新项目开始用 InnoDB Cluster（MGR + Router）**，切换成本更低。"

---

## §10 · 分库分表：垂直 / 水平、路由、跨库事务

### 10.1 何时分

- **单表 > 500 万行 或 > 2GB**（经验值）
- **单库 QPS > 5000**
- **磁盘 IO 打满**

### 10.2 拆分方式

- **垂直分库**：按业务域（订单库 / 用户库 / 商品库）
- **垂直分表**：一表按列拆（热字段 vs 冷字段）
- **水平分库分表**：按分片键（user_id % 16 / hash 一致性 / 范围）

### 10.3 中间件方案

- **代理层**：MyCAT、ShardingSphere-Proxy、Vitess
- **客户端**：ShardingSphere-JDBC、TDDL

### 10.4 跨库事务

- **XA 事务（2PC）**：性能差，MySQL 支持但生产少用
- **柔性事务**：TCC、Saga、本地消息表、事务消息（RocketMQ）
- **最终一致**：DB + 定时对账

### 10.5 分片键选择

**原则**：
- 高频查询字段
- 分布均匀避免热点
- 不可变（避免迁移）
- 常见选择：user_id、tenant_id、order_id

**代价**：
- **非分片键查询**：需要广播到所有分片再聚合 → 昂贵
- **join 限制**：只能同分片 join，或用广播表

---

## §11 · SQL 优化：执行计划、慢查询、Optimizer

### 11.1 EXPLAIN 关键列

- **type**：访问类型（好 → 差）：`system > const > eq_ref > ref > range > index > ALL`
- **key**：实际使用的索引
- **rows**：预估扫描行数
- **filtered**：过滤后剩余百分比
- **Extra**：`Using index`（覆盖）/ `Using where`（存储引擎返回后过滤）/ `Using temporary`（临时表）/ `Using filesort`（额外排序）

### 11.2 慢查询定位

- `slow_query_log = ON`
- `long_query_time = 1`
- `mysqldumpslow` / `pt-query-digest` 聚合分析

### 11.3 常见优化

- **加索引**（前提是选择率高）
- **改写 SQL**：子查询 → JOIN、`NOT IN` → `LEFT JOIN NULL`
- **减少 SELECT ***：只选需要的列（利用覆盖索引）
- **LIMIT 分页优化**：`WHERE id > 上次最大 id LIMIT N` 代替 `LIMIT M, N`
- **join 顺序**：小表驱动大表（Optimizer 通常会选，但复杂查询需要 hint）
- **拆事务**：大事务拆多个小事务

---

## §12 · 生产故障：死锁、幻读、主从延迟、大事务

### 12.1 死锁排查

- `SHOW ENGINE INNODB STATUS` 看 LATEST DETECTED DEADLOCK
- 分析事务加锁顺序 → 调整业务代码

### 12.2 大事务后果

- undo 巨大占内存
- 阻塞其他事务
- 主从延迟严重
- **rollback 时间可能是执行时间的 3~5 倍**

### 12.3 主从延迟应急

- 短期切读到主（业务侧）
- 长期：并行复制 + 主从硬件对齐 + 拆大事务

### 12.4 磁盘打满

- 二进制日志过大 → `PURGE BINARY LOGS` / `expire_logs_days`
- undo 表空间过大 → 8.0 truncate

---

## §13 · 8.0 新特性

1. **CTE**（`WITH ... AS`）+ 递归查询
2. **窗口函数**（ROW_NUMBER / RANK / LAG / LEAD）
3. **隐藏索引**（`INVISIBLE`）：先隐藏观察性能再删
4. **原子 DDL**：DDL 崩溃可回滚（8.0 前 DDL 是伪事务）
5. **默认字符集 utf8mb4**（真 UTF-8，emoji 支持）
6. **InnoDB 全文索引**中文分词
7. **降序索引**真实实现
8. **数据字典**改用 InnoDB 存储（原来是 .frm 文件）
9. **JSON 大幅增强**
10. **组复制（MGR）** 生产可用

---

## §14 · 生产实战：CMDB / 变更审计 / 元数据主库

### CMDB 场景

- 表：`ci_instance`、`ci_attribute`、`ci_relation`
- 高频操作：按 CI id / hash 精确查、按业务分组聚合查
- 索引：主键 + `(tenant_id, ci_type)` 联合 + `(hash)` 唯一

### 变更审计

- append-only 表 `change_log`：分区表按月分区
- **不加过多索引**（写压力大）
- 冷数据归档到 ClickHouse

### 主从架构

- 主写 + 双从读
- 半同步 after_sync
- 从库延迟报警阈值 3s

### 事务规范

- 单事务 < 1s
- 大批量操作**分批**（1000 行一批）
- 明确指定 RR 或 RC（我们生产用 RC）
- 事务内**不做外部调用**（HTTP / RPC）

---

## §15 · 50 问详解

### 【存储引擎与结构】

**Q1. InnoDB vs MyISAM 五点区别？**
> 事务 / 行锁 / 崩溃恢复 / 聚簇索引 / 外键——InnoDB 全有 MyISAM 全无。MyISAM 只适合归档只读。

**Q2. 一个 InnoDB 表在磁盘上是几个文件？**
> 8.0：`表名.ibd`（数据+索引）+ 系统表空间（元数据 8.0 前是 .frm）。8.0 起元数据也在 InnoDB。

**Q3. 页大小 16KB 是硬编码吗？可以改吗？**
> 可以，`innodb_page_size` 支持 4K/8K/16K/32K/64K。但**初始化时决定，不能中途改**。SSD 场景可以试 4K/8K 减少写放大。

**Q4. 表空间、段、区、页、行的关系？**
> 表空间是最大容器（ibd 文件）→ 段（叶子段/非叶子段/回滚段）→ 区（1MB 64 个连续页）→ 页（16KB 最小 IO 单位）→ 行。

**Q5. 行格式 Dynamic 和 Compact 区别？**
> Dynamic 对大字段（>768B）**溢出到独立页**，只留 20B 指针；Compact 会内联部分数据到本页。5.7+ 默认 Dynamic。

### 【索引】

**Q6. 为什么 InnoDB 用 B+ 树而不是 B 树？**
> B+ 树非叶子节点不存数据 → 单页容纳更多分支 → 树更矮（3~4 层） → IO 更少。叶子节点用链表连接 → 范围查询高效。

**Q7. Hash 索引和 B+ 树索引优劣？**
> Hash：O(1) 点查快，但**不支持范围、不支持排序**。InnoDB 有**自适应哈希 AHI**（对热点索引 key 自动建 hash）但不能显式创建。

**Q8. 聚簇索引和二级索引区别？回表是什么？**
> 聚簇：主键 = 数据，一表一个，叶子存完整行；二级：叶子存主键值，查到主键后**回聚簇树**取完整行，即回表。

**Q9. 什么是覆盖索引？**
> 查询字段全在索引里，不用回表。EXPLAIN Extra 显示 `Using index`。设计时把常查字段放联合索引末尾。

**Q10. 最左匹配原则？**
> 联合索引 `(a,b,c)` 生效要求从最左连续。`WHERE b=1` 不走索引；`WHERE a=1 AND c=2` a 走 c 不走；`WHERE a=1 AND b>2 AND c=3` a、b 走 c 不走（范围后失效）。

**Q11. 什么是索引下推 ICP？**
> 5.6+，联合索引 `(a,b)` 查 `WHERE a=1 AND b LIKE 'x%'` 时把 b 条件下推到存储引擎，减少回表次数。Extra 显示 `Using index condition`。

**Q12. 索引失效的常见场景？**
> ① LIKE '%x' ② 字段函数/运算 ③ 隐式类型转换 ④ OR 有非索引列 ⑤ != NOT IN ⑥ 选择率太低。

**Q13. 前缀索引怎么用？**
> `CREATE INDEX idx ON t(name(10))`。适合长字段，权衡索引长度和选择率。`SELECT COUNT(DISTINCT LEFT(name,10))/COUNT(*)` 评估选择率。

**Q14. 为什么主键推荐自增整数？**
> ① 顺序插入 → 页利用率高、不分裂 ② 短小 → 二级索引更小 ③ 数字比较快。UUID 主键随机插入导致页分裂和索引膨胀。

**Q15. 联合索引 (a,b,c) 建立后，(a)、(a,b) 需要单独建吗？**
> 不需要。联合索引已隐含前缀索引。但如果查询模式经常 `WHERE b=? AND c=?` 则可以另外建 `(b,c)`。

### 【事务与隔离级别】

**Q16. ACID 分别是什么？**
> **A**tomicity 原子（undo）、**C**onsistency 一致（约束）、**I**solation 隔离（MVCC+锁）、**D**urability 持久（redo WAL）。

**Q17. 四种隔离级别？MySQL 默认？**
> RU / **RC** / **RR（默认）** / Serializable。RR 通过 MVCC + Gap Lock 避免幻读。

**Q18. 生产为什么多用 RC 不用 RR？**
> ① RC 减少 Gap Lock 竞争，高并发性能好 ② 5.7 起 binlog row 模式后 RC 主从一致 ③ 阿里/腾讯生产标配 RC。

**Q19. 脏读、不可重复读、幻读的区别？**
> 脏读：读到未提交；不可重复读：同事务两次读同行结果不同（update）；幻读：同事务两次范围查结果集不同（insert）。

**Q20. RR 真的完全避免幻读了吗？**
> 快照读通过 MVCC 一致视图避免；当前读通过 next-key lock 避免。但**混用快照读 + 当前读会出问题**。

### 【MVCC】

**Q21. MVCC 的核心机制？**
> 每行隐藏 trx_id + roll_ptr → undo log 版本链。ReadView 记录活跃事务 → 沿版本链找可见版本。

**Q22. ReadView 包含哪些字段？**
> m_ids（活跃事务集）、min_trx_id、max_trx_id、creator_trx_id。

**Q23. RC 和 RR 的 ReadView 生成时机？**
> RC：每次快照读生成新 ReadView；RR：事务第一次快照读生成，之后沿用。

**Q24. 快照读和当前读的区别？**
> 快照读：普通 SELECT，走 MVCC 不加锁；当前读：`FOR UPDATE / LOCK IN SHARE MODE / UPDATE / DELETE`，读最新版本加锁。

**Q25. undo log 什么时候清理？**
> 事务提交后，且**没有比它更早的事务需要它作为版本历史**时。purge thread 后台清理。

### 【锁】

**Q26. InnoDB 有哪些锁？**
> 全局锁 / 表锁 / 意向锁 / 元数据锁 / 行锁（Record / Gap / Next-Key / Insert Intention）/ AUTO-INC 锁。

**Q27. 意向锁的作用？**
> 表级，表明"表内某行加了 S/X 锁"。避免加表锁时遍历所有行锁。IS/IX 之间不冲突。

**Q28. Gap Lock 什么时候加？**
> RR 隔离级别，防止幻读。RC 不加 Gap Lock。等值命中唯一索引退化为 Record Lock。

**Q29. Next-Key Lock 是什么？**
> Record + Gap，左开右闭区间。RR 加锁的默认单位。

**Q30. 死锁如何检测和处理？**
> InnoDB wait-for graph 检测，**主动 rollback 权重小的事务**（undo 少的）。高并发可关闭检测用超时（`innodb_deadlock_detect=OFF`）。

**Q31. 如何避免死锁？**
> ① 固定加锁顺序 ② 事务尽量短 ③ 避免大范围锁 ④ 用索引精准锁行 ⑤ 拆分大事务。

### 【日志】

**Q32. redo log 和 binlog 区别？**
> redo 是 InnoDB 物理日志（页 X 偏移 Y 改 Z），循环写，崩溃恢复用；binlog 是 Server 层逻辑日志（SQL 或行变更），append 写，复制/归档用。

**Q33. 为什么要两阶段提交？**
> 保证 redo（InnoDB）和 binlog（Server）**一致**。否则主库崩溃后主从数据不一致。流程：redo prepare → binlog write → redo commit。

**Q34. innodb_flush_log_at_trx_commit 三种值？**
> 0：每秒后台刷（丢 1s）；1：每次 commit fsync（生产标配）；2：写 OS 缓存，每秒 fsync（OS 崩溃丢 1s）。

**Q35. sync_binlog 三种值？**
> 0：交给 OS；1：每次 commit fsync（生产标配）；N：每 N 次 commit fsync。

**Q36. 双 1 配置是什么？**
> `innodb_flush_log_at_trx_commit=1` + `sync_binlog=1`。金融级不丢数据。性能损失 30%，配 group commit 缓解。

**Q37. binlog 三种格式？生产选哪个？**
> statement（小，非确定语句主从不一致）/ row（大，一致）/ mixed。**生产 row**，虽然大但可靠。

### 【复制】

**Q38. 主从异步复制流程？**
> Master 写 binlog → dump thread 推给 Slave IO thread → 写 relay log → SQL thread 重放。

**Q39. 半同步复制有几种？**
> `after_commit`（5.5，先提交再等 ACK，可能丢）/ `after_sync`（5.7 无损，先等 ACK 再提交，生产推荐）。

**Q40. 主从延迟原因和解法？**
> 原因：大事务、SQL thread 单线程、网络、从库硬件差、DDL。解法：并行复制 MTS（8.0 WriteSet）、拆大事务、GTID + 半同步。

**Q41. GTID 有什么好处？**
> 全局事务 ID：故障切换时新主的 GTID 集清晰，从库轻松找复制起点。5.7+ 生产标配。

### 【分库分表】

**Q42. 什么时候分库分表？**
> 单表 > 500 万行或 > 2GB；单库 QPS > 5000；磁盘 IO 打满。分之前先垂直分库减压。

**Q43. 分片键怎么选？**
> 高频查询字段、分布均匀、不可变。常见：user_id、tenant_id。范围分（按时间）适合归档，Hash 分适合均衡。

**Q44. 非分片键查询怎么办？**
> ① 广播到所有分片再聚合（贵）② 建全局二级索引 ③ 冗余异构存储（ES / ClickHouse）。

**Q45. 分布式事务方案？**
> XA（性能差）/ TCC（业务侵入）/ Saga（补偿）/ 本地消息表（推荐）/ 事务消息（RocketMQ）。**最终一致性 + 对账**是常用方案。

### 【性能与优化】

**Q46. 如何定位慢查询？**
> 开慢日志（`slow_query_log=ON`, `long_query_time=1`），用 `pt-query-digest` 聚合分析。生产用 `performance_schema` 补充。

**Q47. EXPLAIN 关键字段？**
> type（访问类型）、key（使用索引）、rows（预估行数）、Extra（Using index / Using where / Using temporary / Using filesort）。type 从 const 到 ALL 越来越差。

**Q48. LIMIT M, N 大偏移量慢怎么优化？**
> `WHERE id > 上次最大 id LIMIT N` 走主键索引，跳过 M。避免深分页。

**Q49. count(*) count(1) count(字段) 有什么区别？**
> InnoDB：count(*) 优化过等价 count(1)，都不排除 NULL；count(字段) 排除 NULL 且要读字段（如果字段有索引也会用）。**count(*) 是官方推荐**。

**Q50. buffer pool 命中率多少算健康？**
> `Innodb_buffer_pool_read_requests / (reads + read_requests)` > 99% 健康。低于 95% 考虑加内存或加索引减少全表扫。

### 【补充深度题】

**Q51. change buffer 是什么？**
> 二级索引（非唯一）的 DML 缓存。目标页不在 buffer pool 时先缓存到 change buffer，后续读时 merge。**唯一索引不适用**（要校验唯一性）。

**Q52. 自增主键用完了怎么办？**
> `BIGINT UNSIGNED` 上限 1.8e19，几乎用不完。INT UNSIGNED 42 亿可能用完 → 改 BIGINT 需要长时间 DDL（8.0 前）。

**Q53. 一次 update 语句从执行到返回经历了什么？**
> 连接器 → 分析器 → 优化器 → 执行器 → InnoDB：找页（buffer pool/磁盘） → undo → 修改内存页 → redo prepare → binlog write → redo commit → 返回。

**Q54. 幻读的当前读版本你能画图吗？**
> RR 下 `SELECT * FROM t WHERE id > 10 FOR UPDATE` 会加 (10, ∞] next-key lock，防止别人 insert id=15 之类。这就是 RR 幻读的解法。

**Q55. 8.0 的原子 DDL 解决了什么？**
> 8.0 前 DDL 崩溃可能残留半状态（如 rename 完但 metadata 没改）。8.0 用数据字典事务保证 DDL 原子性。

---

## §16 · 短板与坑

1. **大事务是万恶之源**：undo 膨胀、锁范围大、主从延迟、rollback 慢
2. **DDL 长时间锁表**（8.0 前）：Online DDL 也可能卡 MDL
3. **主从延迟不强一致**：读写分离场景注意
4. **XA 事务性能差**：分布式事务多用最终一致
5. **深分页慢**：LIMIT M, N 大 M 卡死
6. **索引膨胀写放大**：越多索引写越慢
7. **UUID 主键性能灾难**：随机 IO + 索引膨胀
8. **NULL 有陷阱**：`WHERE col != 'x'` 排除 NULL
9. **默认字符集 utf8 不是真 UTF-8**：8.0 改 utf8mb4 才是
10. **文件系统碎片**：长期高频删改的表 `OPTIMIZE TABLE` 重建

---

## §17 · 面试话术模板

### 3 分钟自述

> "我在 TCUM/CMDB 生产 MySQL 深度使用两年，主库是元数据 + 变更审计 + 用户权限，日均 QPS 8000 峰值 2w，主从 + 半同步 after_sync。
>
> **对 MySQL 最深三点理解**：
> - **两阶段提交是 InnoDB 和 Server 层解耦的代价**：redo 和 binlog 必须协调，group commit 优化下双 1 配置也能扛住金融级要求。
> - **RR 和 RC 生产选型**：MySQL 默认 RR 但阿里腾讯生产多用 RC，减少 Gap Lock 竞争。我们 CMDB 场景用 RC + 显式加锁。
> - **索引 + MVCC 是性能核心**：B+ 树 3~4 层撑亿级数据，MVCC 让读不阻塞写。设计索引时先看查询模式，主键必须自增，覆盖索引优先。
>
> **生产血泪**：大事务导致的 undo 膨胀、主从延迟 30 秒、深分页把从库打死、UUID 主键从上线就后悔——每一个都是配置和设计的教训。"

### 反问 5 问

1. 生产版本 5.7 还是 8.0？binlog 是 row 吗？
2. 隔离级别 RR 还是 RC？
3. 主从半同步开了吗？after_sync 还是 after_commit？
4. 分库分表方案？ShardingSphere 还是自研？
5. 大事务和慢查询监控告警阈值多少？

---

**本篇完 · 约 25KB · 覆盖引擎/索引/事务/MVCC/锁/日志/复制/分库分表/优化/55 问**

**证据基线**：
- MySQL 8.0 官方文档
- 极客时间 · 林晓斌《MySQL 实战 45 讲》
- 生产实战：TCUM CMDB 元数据主库、变更审计分区表
- 阿里/腾讯生产 RC 隔离级别选型
