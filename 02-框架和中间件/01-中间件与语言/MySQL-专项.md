# MySQL 专项：从 InnoDB 原理到 TCUM 事务与租约锁

> 目标：既能回答 MySQL 原理题，也能结合 TCUM 源码讲清楚事务、锁、幂等和高可用边界。
>
> 事实边界：本文只把仓库中能定位到的实现称为“项目现状”。隔离级别、主从拓扑、QPS、数据规模等若无配置或监控证据，不冒充线上事实。

---

## 一、三分钟总览

MySQL 在业务系统里的核心价值，不只是“存数据”，而是通过以下机制共同提供正确性与可运维性：

1. InnoDB 用聚簇索引组织行数据，二级索引保存主键，因此主键设计会影响所有二级索引。
2. MVCC 让普通查询在 RC、RR 下通常使用一致性快照，而 `FOR UPDATE` 属于锁定读。
3. redo log 服务于崩溃恢复，undo log 服务于回滚和历史版本，binlog 服务于复制、审计式恢复等服务端能力。
4. 事务正确性不只取决于数据库，还取决于应用是否把所有 SQL 放进同一个事务、是否处理 Begin/Commit 错误、是否设计唯一约束与重试。
5. 主从复制、高可用和分库分表属于部署方案，不能仅凭应用用了 MySQL 就推断线上采用了哪一种拓扑。

在 TCUM 源码中，最值得展开的两个案例是：

- `tcum-yunshao-global` 用 `context.Context` 传递 `*gorm.DB`，支持嵌套方法复用事务，但部分调用点忽略 Begin 错误，Commit 错误也只记录日志。
- `tcum-ai` 的评测任务锁使用“唯一索引 + 过期时间 + owner 条件续租”，能解决抢锁竞争，但没有 fencing token，旧 owner 超时后仍可能继续产生副作用。

---

## 二、InnoDB 数据与索引

### 2.1 聚簇索引和二级索引

InnoDB 每张表都有聚簇索引，叶子节点存完整行：

- 有主键：主键作为聚簇索引。
- 无主键：选择第一个所有列均非空的唯一索引。
- 两者都没有：InnoDB 生成隐藏行 ID。

二级索引叶子节点保存“索引列 + 主键”。查询需要二级索引未覆盖的列时，再用主键访问聚簇索引，这通常称为回表。

因此主键应兼顾：

- 稳定、非空、唯一；
- 尽量短，避免放大所有二级索引；
- 高频插入场景下尽量避免完全随机且宽的键造成页分裂和缓存局部性下降。

不能说“任何查询只需 3～4 次 IO”。树高、缓存命中、范围宽度、回表次数和存储介质都会改变真实代价。

### 2.2 联合索引

对索引 `(a, b, c)`，能否高效使用取决于谓词和排序，而不是背诵一句“最左前缀”：

```sql
-- 通常可形成连续索引范围
WHERE a = ? AND b = ?

-- a 等值后对 b 做范围，c 往往不能继续缩小扫描范围
WHERE a = ? AND b > ? AND c = ?

-- 缺少前导列，一般不能直接按该联合索引定位
WHERE b = ?
```

设计顺序时应同时考虑：等值过滤、范围条件、排序/分组、选择性以及是否能覆盖查询。高选择性列并不永远必须排第一。

### 2.3 覆盖索引、ICP 与回表

- 覆盖索引：返回列都能从索引记录取得，减少回表。
- ICP：存储引擎在索引层先判断可下推条件，减少回表，但不等于扫描范围一定缩小。
- `Using filesort`：表示没有直接利用索引顺序完成排序，不等于一定落磁盘。
- `Using temporary`：提示中间结果风险，但仍需结合行数、内存和执行时长判断。

索引不是越多越好。每个索引都增加写放大、空间占用、统计信息与优化器选择复杂度。

### 2.4 索引常见失效或收益下降

- 对索引列做无法改写的函数计算；
- 隐式类型转换；
- 前导模糊匹配，如 `LIKE '%abc'`；
- 联合索引缺少前导列；
- 低选择性条件返回大部分表；
- OR 两侧缺少合适索引；
- 统计信息过旧导致代价估算失真。

判断依据应是 `EXPLAIN ANALYZE`、扫描行数、回表量和真实耗时，而不是只看 `type` 字段。

---

## 三、事务、MVCC 与锁

### 3.1 ACID 如何落到实现

- 原子性：失败时借助 undo 回滚事务修改。
- 一致性：数据库约束与应用事务共同维护业务不变量。
- 隔离性：MVCC、锁和隔离级别控制并发可见性。
- 持久性：redo、刷盘策略和存储可靠性共同决定提交后的恢复能力。

“开启事务”不等于自动获得业务一致性。若漏掉一条 SQL、没有唯一约束、提交错误被吞掉，事务外观仍可能掩盖错误。

### 3.2 RC 与 RR

InnoDB 默认隔离级别是 REPEATABLE READ，但不能据此声称某个项目线上一定使用 RR；连接或服务端配置都可能覆盖它。

| 维度 | READ COMMITTED | REPEATABLE READ |
|---|---|---|
| 普通一致性读 | 每次读取创建新快照 | 同一事务通常复用第一次一致性读建立的快照 |
| 读到已提交新值 | 后续查询可以 | 普通一致性读通常不可以 |
| 锁范围 | 通常更少使用 gap lock | 锁定读/写入常涉及 next-key lock |
| 适合关注 | 最新已提交数据、降低锁冲突 | 同事务快照稳定、范围并发控制 |

隔离级别必须结合业务不变量选择。账户扣减、库存更新等场景通常还需要条件更新、锁定读或乐观版本，而不是只调整隔离级别。

### 3.3 快照读与锁定读

普通 `SELECT` 在 RC/RR 下通常是一致性非锁定读；以下属于锁定读：

```sql
SELECT * FROM task WHERE id = ? FOR UPDATE;
SELECT * FROM task WHERE id = ? FOR SHARE;
```

`FOR UPDATE` 要生效，必须满足两个条件：

1. 查询运行在一个尚未结束的事务中；
2. 后续写操作使用同一事务/连接。

若开启事务前缓存了一个原始 DB handle，之后仍用它执行锁定读，代码看起来有锁，实际锁的生命周期却不受目标事务控制。

### 3.4 Record、Gap 与 Next-Key Lock

- Record lock：锁索引记录。
- Gap lock：锁索引记录之间的间隙，主要阻止插入。
- Next-key lock：记录锁与前间隙锁的组合。

InnoDB 锁的是扫描到的索引范围，而不是抽象的 `WHERE` 语义。缺少合适索引时，锁定读/更新可能扫描并锁住远超预期的范围。

使用唯一索引精确定位唯一记录时，通常只需要记录锁；范围查询、非唯一索引和隔离级别会改变锁范围。面试时不要把“`FOR UPDATE` 一定锁一行”当成结论。

### 3.5 死锁不是异常现象

死锁是并发控制的正常结果。数据库会选择一个事务回滚，应用必须能够重试。

治理顺序：

1. 从死锁日志还原锁等待环；
2. 让多个事务按相同顺序访问资源；
3. 缩短事务，避免事务内远程调用；
4. 补充合适索引，缩小扫描与锁范围；
5. 对可重试错误做有上限、带抖动的重试；
6. 依赖唯一约束和幂等，保证重试安全。

---

## 四、redo、undo、binlog 与复制

### 4.1 三类日志不要混淆

| 日志 | 所属层次 | 主要用途 |
|---|---|---|
| redo log | InnoDB | 崩溃恢复与持久性 |
| undo log | InnoDB | 回滚；为一致性读提供旧版本 |
| binary log | MySQL Server | 复制、增量恢复、变更订阅 |

把它们说成“一个用于写、一个用于读”是不准确的。它们解决的问题、记录形式和生命周期不同。

### 4.2 为什么要协调 redo 与 binlog

一次提交同时涉及 InnoDB 状态和 server 层 binlog。如果一个成功、另一个失败，恢复后的数据库状态与复制日志可能不一致。MySQL 使用内部提交协调机制维护二者一致性。

面试中讲清目标即可，不要把某个版本的内部刷盘顺序背成永恒不变的协议。精确实现应以目标版本官方文档和源码为准。

### 4.3 复制与高可用

常见方案包括：

- 异步复制：吞吐和延迟较好，但源故障时可能丢失尚未传到副本的事务。
- 半同步复制：源提交返回前等待至少一个副本确认已接收并记录事务事件；它不等同于所有副本已应用。
- GTID：用全局事务标识跟踪事务，简化故障切换和复制定位。
- Group Replication / InnoDB Cluster：提供成员管理、冲突检测和自动选主等能力；客户端流量仍需 Router、中间件或负载均衡转移。

当前仓库不足以证明 TCUM 使用了哪种主从拓扑、半同步模式或分片中间件。这些只能作为候选设计，不能写成项目事实。

---

## 五、SQL 性能诊断方法

### 5.1 先定位，再优化

推荐顺序：

1. 从慢日志、APM 或数据库指标定位高总耗时 SQL；
2. 记录调用量、P50/P95/P99、扫描行数、返回行数和锁等待；
3. 用 `EXPLAIN ANALYZE` 对比估算与实际；
4. 判断问题在访问路径、回表、排序、临时表、锁还是连接池；
5. 做最小改动并回放验证；
6. 观察写放大、缓存、复制延迟等副作用。

### 5.2 EXPLAIN 关注点

- 实际与估算行数是否严重偏离；
- 使用了哪个索引，为什么没有选预期索引；
- 循环次数与每层耗时；
- 是否大量回表；
- 排序、临时表和物化成本；
- 谓词过滤发生在哪一层。

单看 `rows=10` 或 `type=ref` 不足以得出“SQL 很快”的结论。

### 5.3 深分页

```sql
SELECT * FROM event ORDER BY id LIMIT 1000000, 20;
```

数据库仍需跳过大量记录。优先使用游标/Seek 分页：

```sql
SELECT id, created_at, payload
FROM event
WHERE id > ?
ORDER BY id
LIMIT 20;
```

如果排序键不唯一，应使用稳定复合游标，例如 `(created_at, id)`，否则并发写入时可能重复或漏项。

### 5.4 不要先拍脑袋分库分表

先确认瓶颈是容量、单机写入、热点、连接数还是低效 SQL。分片会引入：

- 跨分片查询与聚合；
- 全局唯一 ID；
- 分布式事务；
- 扩容迁移和数据校验；
- 路由键不可变约束。

“500 万行就分表”或“5000 QPS 就分库”都不是通用标准。

---

## 六、TCUM 源码案例一：Context 事务封装

### 6.1 当前实现

源码：

- `tcum-yunshao-global/common/transaction/transaction.go`
- `tcum-yunshao-global/service/modelservice/t_folder_service.go`

`Begin(ctx)` 的行为：

1. 若 context 已有事务，直接复用，返回 `owned=false`；
2. 否则通过 GORM Begin 创建事务；
3. 把 `*gorm.DB` 放进 context，返回 `owned=true`。

DAO 通过 `GetTx(ctx)` 获取事务；若不存在则退化为原始 DB。外层方法只有在 `owned=true` 时负责提交或回滚。这使 service 嵌套调用时可以共享同一事务。

### 6.2 设计优点

- 避免每层函数显式传递 `*gorm.DB`；
- 支持外层事务覆盖多层 service/DAO；
- owner 标识避免内层误提交外层事务；
- DAO 在非事务场景仍可复用。

### 6.3 已确认的问题

#### 问题一：部分调用点忽略 Begin 错误

源码中既有正确处理 `beginErr` 的方法，也有：

```go
ctx, newt, _ := transaction.Begin(ctx)
```

若 Begin 失败，后续代码可能使用空 context，或 `GetTx` 回退到非事务 DB，造成“以为在事务里，实际没有”的风险。

#### 问题二：Commit 错误只记录日志

`Check` / `CheckTcumError` 调用 `commitTx`，但不返回 commit 错误。调用方常在 defer 中执行它，因此业务函数可能已经准备返回成功，最终提交失败却只留下日志。

#### 问题三：缺少统一 panic 回滚

封装没有集中处理 panic。若调用栈没有其他恢复逻辑，异常路径不一定按预期主动回滚。

#### 问题四：GetTx 静默回退

事务型用例如果漏传新 context，`GetTx` 会返回原始 DB 而不是失败。这增强了通用性，却削弱了事务必需场景的 fail-fast 能力。

### 6.4 源码级严重案例：锁和写入使用了旧 DB handle

文件：`service/dao/mstack_entity_dao.go` 的 `SaveOrUpdate`。

当前顺序是：

```go
tx := transaction.GetTx(ctx) // 先取旧 handle
ctx, newt, _ := transaction.Begin(ctx)

result := tx.Clauses(clause.Locking{Strength: "UPDATE"})...
err := tx.Save(&existing).Error
```

如果调用前没有外层事务：

1. `tx` 是原始 DB；
2. 随后才新建事务并放进新 context；
3. `FOR UPDATE`、`Save/Create` 仍使用旧 `tx`；
4. defer 提交的是 context 中的新事务。

结果是锁定读和写入没有进入刚开启的事务，提交动作提交的反而是一个没有承载这些 SQL 的事务。修复原则是先 Begin，再从新 context 取 tx，或者完全禁止 DAO 自己控制事务。

### 6.5 更合理的事务 API

推荐收口成唯一入口：

```go
func WithinTx(ctx context.Context, fn func(context.Context) error) (err error) {
    if HasTx(ctx) {
        return fn(ctx)
    }

    tx := datasource.GetDS().Begin()
    if tx.Error != nil {
        return tx.Error
    }
    txCtx := WithTx(ctx, tx)

    defer func() {
        if p := recover(); p != nil {
            _ = tx.Rollback().Error
            panic(p)
        }
        if err != nil {
            _ = tx.Rollback().Error
            return
        }
        err = tx.Commit().Error
    }()

    err = fn(txCtx)
    return err
}
```

还应配套：

- 事务必需 DAO 使用 `RequireTx(ctx)`，缺失时立即报错；
- 禁止 Begin 前缓存 DB handle；
- lint/代码扫描禁止忽略 Begin 错误；
- 对死锁、锁等待超时只在幂等边界内重试；
- 测试注入 commit failure，验证 API 不会返回假成功。

---

## 七、TCUM 源码案例二：评测任务数据库租约锁

### 7.1 当前流程

源码：

- `tcum-ai/usercases/eval_suite/service/eval_lock_manager.go`
- `tcum-ai/usercases/eval_suite/po/eval_task_lock.go`

锁表对 `task_id` 建唯一索引。抢锁大致流程：

1. 删除该任务已经过期的锁；
2. 查询是否仍有有效锁；
3. 插入 `(task_id, lock_by, expire_at)`；
4. 并发插入冲突时，由唯一约束决定只有一个 owner 成功。

续租通过 `task_id + lock_by + expire_at > now` 条件更新，并检查 `RowsAffected`；释放锁按 `task_id + lock_by` 删除。

进程内 mutex 只能串行化当前实例内的抢锁。真正跨实例裁决的是数据库唯一约束，而不是这个 mutex。

### 7.2 做对了什么

- 把唯一性作为数据库不变量，而不是依赖“先查后写”；
- owner 条件避免其他实例误续租、误解锁；
- 续租检查有效期和影响行数，具备 CAS 思路；
- 租约会过期，持锁进程崩溃后不需要永久人工解锁。

### 7.3 仍然存在的边界

#### Check-then-insert 不是原子的

多个实例可能同时观察到“没有有效锁”，随后同时插入。唯一索引能保证最终只有一个成功，所以正确性仍可维持，但多了失败分支和额外往返。

#### 依赖应用时钟

若不同节点时间漂移，可能提前删除、延迟续租或错误判断过期。应尽量使用数据库时间，或确保严格时钟同步并监控漂移。

#### 没有 fencing token

最关键的问题是：owner A 停顿超过租期；owner B 获得锁；A 恢复后仍继续写外部系统。即使 A 已无法续租，它已经发出的副作用也不会自动撤销。

解决方案是在每次获得锁时生成单调递增的 epoch/token，并要求下游只接受比已见 token 更新的写入。没有下游校验的 token 只是装饰。

### 7.4 改进设计

推荐：

1. 使用数据库时间判断 expiry；
2. 通过单条条件 upsert 完成“无锁或已过期则获取”；
3. 每次成功获取递增 `fencing_token`；
4. 心跳续租必须校验 owner、token 与未过期；
5. 任务每个阶段写入前检查 token；
6. 任务结果表使用 `(run_id, case_id)` 等唯一约束保证幂等；
7. 对抢锁失败、续租失败、过期接管和旧 owner 拒绝分别打指标。

示意表：

```sql
CREATE TABLE eval_task_lock (
  task_id        VARCHAR(128) PRIMARY KEY,
  lock_by        VARCHAR(128) NOT NULL,
  fencing_token  BIGINT NOT NULL,
  expire_at      DATETIME(6) NOT NULL,
  updated_at     DATETIME(6) NOT NULL
);
```

---

## 八、项目事实边界

| 命题 | 当前仓库是否能证明 | 面试表达 |
|---|---:|---|
| 使用 GORM 访问 MySQL 风格关系库 | 能 | 可作为项目实现讲 |
| context 传递和复用事务 | 能 | 可说明 owner 语义与风险 |
| 多处使用 `FOR UPDATE` | 能 | 可结合具体 DAO 讲锁范围 |
| 评测锁表有 `task_id` 唯一索引 | 能 | 可说明唯一约束裁决竞争 |
| 评测 trial 有 `(run_id, case_id)` 唯一约束 | 能 | 可说明幂等不变量 |
| 线上使用 RC 或 RR | 不能 | 只能讲选择方法 |
| 一主两从、半同步、Orchestrator | 不能 | 不写成项目现状 |
| 使用 ShardingSphere 分片 | 不能 | 只能作为候选架构 |
| 固定 QPS、数据量、故障时长 | 不能 | 没监控/复盘证据不报数字 |

---

## 九、常见问题与解决方案

### 9.1 “先查再插”并发重复

错误做法：只在应用层查不存在再插入。

正确边界：数据库唯一约束 + 捕获冲突 + 幂等返回。唯一约束是最终裁决者。

### 9.2 事务里调用 RPC

风险：远程超时会拉长持锁时间、扩大连接占用和死锁概率。

方案：事务内只保存本地状态和 outbox；提交后异步发送消息；消费端以 inbox/唯一键幂等。

### 9.3 读写分离后立刻读不到

原因：复制存在应用延迟。

方案根据一致性要求选择：写后读主库、携带 GTID/位点等待副本追平、短期会话粘滞，或接受最终一致性并在 UI 明示。

### 9.4 热点行更新

方案不只是“加锁”：

- 条件原子更新；
- 乐观版本号；
- 按业务维度拆热点；
- 合并写或异步串行化；
- 将严格不变量留在数据库，将可聚合状态异步化。

### 9.5 大事务

风险包括 undo 膨胀、purge 受阻、锁持有时间增加、复制延迟和恢复时间增长。应分批处理、设置断点和幂等键，并监控 history list、事务时长与副本延迟。

---

## 十、面试高频 25 问

### Q1：为什么 InnoDB 主键不宜过长？

二级索引记录包含主键。主键越长，所有二级索引越大，缓存效率和写放大越差。

### Q2：二级索引查询一定回表吗？

不一定。返回列被二级索引和其中包含的主键覆盖时，可以直接返回。

### Q3：联合索引最左前缀的本质是什么？

B+Tree 按联合键字典序排序。缺少前导维度时，目标值分散，无法形成连续可定位范围。

### Q4：索引越多越好吗？

不是。索引加速部分读取，却增加写入维护、磁盘、缓存和优化器成本。

### Q5：RC 和 RR 的核心差异？

在一致性读上，RC 每次语句读取新快照，RR 通常复用事务第一次一致性读的快照；锁行为也会受隔离级别影响。

### Q6：普通 SELECT 会加行锁吗？

RC/RR 下普通一致性读通常不加行锁；`FOR UPDATE`、`FOR SHARE`、写语句等会加锁。

### Q7：`FOR UPDATE` 为什么可能锁很多行？

锁基于实际扫描的索引记录和范围。缺少合适索引时可能扫描并锁定大量记录。

### Q8：MVCC 依靠什么？

事务可见性信息、Read View 与 undo 历史版本共同支持一致性读取。

### Q9：redo 与 undo 的区别？

redo 用于重做已持久化日志对应的页修改以实现崩溃恢复；undo 用于回滚并提供历史版本。

### Q10：binlog 与 redo 的区别？

binlog 属于 server 层，服务复制和增量恢复；redo 属于 InnoDB，服务崩溃恢复。

### Q11：死锁如何处理？

先还原等待环，再统一访问顺序、缩短事务、补索引；应用对可重试错误做有界重试并保证幂等。

### Q12：唯一索引能替代分布式锁吗？

可用于“一次创建”等唯一性裁决，但无法自动保护长任务的持续所有权；租约任务还需 owner、续租，强正确性场景需 fencing token。

### Q13：为什么 commit 也会失败？

连接故障、存储或刷盘错误、数据库状态变化等都可能让 Commit 失败，所以不能提前向调用者返回成功。

### Q14：事务为什么不应包含 RPC？

RPC 延迟不可控，会延长持锁和连接占用，并放大死锁与雪崩风险。

### Q15：如何实现数据库与 Kafka 最终一致？

同一数据库事务写业务数据和 outbox；后台投递；消费者用唯一键/inbox 幂等。不要依赖“提交后立刻发消息”没有故障窗口。

### Q16：TCUM 事务封装的优点是什么？

context 让多层 service/DAO 复用事务，owner 标识避免内层提交外层事务。

### Q17：TCUM 事务封装最需要修什么？

统一处理 Begin 错误、传播 Commit 错误、panic 回滚，并避免 `GetTx` 在事务必需场景静默回退。

### Q18：`SaveOrUpdate` 的源码问题是什么？

它在 Begin 前取得 DB handle，之后锁定读和写仍用旧 handle，导致这些 SQL 没进入新事务。

### Q19：TCUM-AI 锁为何能避免两个实例同时插入？

`task_id` 唯一索引是最终裁决者。先查后插仍有竞态，但其中一个插入会因唯一冲突失败。

### Q20：为什么租约锁需要 fencing token？

旧 owner 可能在租约过期后恢复并继续写。单调 token 让下游拒绝旧 owner 的过期操作。

### Q21：深分页怎么优化？

用稳定排序键做 Seek 分页；复合排序要把唯一键纳入游标。

### Q22：如何判断是否该分库分表？

以容量、吞吐、热点和可用性瓶颈为依据，并先排除 SQL、索引和模型问题；没有统一行数/QPS 阈值。

### Q23：异步复制会带来什么业务问题？

副本读取旧数据，源故障时可能损失尚未复制的事务。需要按场景设计读路由与故障恢复目标。

### Q24：半同步是否等于零丢失？

不等于。它通常确认至少一个副本已接收并记录事务事件，不代表所有副本已应用，也仍需完整故障模型。

### Q25：慢 SQL 优化最容易犯什么错？

只看 EXPLAIN 的单个字段或直接加索引。应从工作负载和总耗时出发，用实际执行数据验证并观察写入副作用。

---

## 十一、项目表达模板

> 我们在 Go 服务里使用 GORM，并通过 context 传递事务，使多层 service 和 DAO 可以复用同一个事务。这个设计的关键不是 Begin 本身，而是事务所有权、错误传播和所有 SQL 是否使用同一个 tx。源码审查中我发现一个 `SaveOrUpdate` 在 Begin 前就缓存 DB handle，导致后续 `FOR UPDATE` 和写入没有进入新事务；同时部分调用点忽略 Begin 错误，Commit 失败也只打日志。我的改造方案是收口为 `WithinTx` 高阶函数，统一处理嵌套事务、panic、rollback 和 commit error，并为事务必需 DAO 增加 `RequireTx`。TCUM-AI 的评测调度还使用了数据库租约锁，唯一索引可以裁决并发抢锁，但要防止过期 owner 继续写，需要数据库时间、心跳、幂等约束和 fencing token。这个案例说明数据库正确性必须同时看存储机制、约束和应用事务边界。

---

## 十二、资料与源码定位

### 项目源码

- `/Users/yaao/Documents/code/tcum-yunshao-global/common/transaction/transaction.go`
- `/Users/yaao/Documents/code/tcum-yunshao-global/service/dao/mstack_entity_dao.go`
- `/Users/yaao/Documents/code/tcum-yunshao-global/service/modelservice/t_folder_service.go`
- `/Users/yaao/Documents/code/tcum-ai/usercases/eval_suite/service/eval_lock_manager.go`
- `/Users/yaao/Documents/code/tcum-ai/usercases/eval_suite/po/eval_task_lock.go`

### MySQL 官方文档

- [Clustered and Secondary Indexes](https://dev.mysql.com/doc/refman/8.4/en/innodb-index-types.html)
- [Consistent Nonlocking Reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-consistent-read.html)
- [Locks Set by Different SQL Statements](https://dev.mysql.com/doc/refman/8.4/en/innodb-locks-set.html)
- [Undo Logs](https://dev.mysql.com/doc/refman/8.4/en/innodb-undo-logs.html)
- [Replication](https://dev.mysql.com/doc/refman/8.4/en/replication.html)
- [Group Replication](https://dev.mysql.com/doc/refman/8.4/en/group-replication.html)
- [InnoDB Cluster](https://dev.mysql.com/doc/refman/8.4/en/mysql-innodb-cluster-introduction.html)
