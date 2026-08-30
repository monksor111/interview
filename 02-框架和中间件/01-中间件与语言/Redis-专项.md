# Redis 专项：从缓存原理到 TCUM 源码治理

> 目标：回答 Redis 原理题时能落到真实代码、故障边界和改造方案。
>
> 事实边界：TCUM 仓库能证明 Redis 被用于 CMDB 查询缓存、批量合并读取、通知配额计数、简单互斥锁和主节点选举；不能证明线上采用了 Sentinel、Cluster、固定分片数或特定持久化策略。

---

## 一、三分钟总览

Redis 的核心价值是：在内存中提供丰富的数据结构、原子命令、过期机制和低延迟访问。它适合缓存、计数、限流、短期协调与派生状态，但不能因为“命令原子”就把整个业务流程当成强一致系统。

面试回答应抓住五层：

1. 数据结构与复杂度：String、Hash、List、Set、Sorted Set、Stream 等解决不同访问模型。
2. 执行与延迟：命令主要串行执行，慢命令、大 key、fork、网络和过期/淘汰都会制造尾延迟。
3. 数据安全：RDB、AOF、复制分别解决不同问题，不能把副本等同于备份。
4. 高可用：复制是异步基础；Sentinel 解决非分片场景的监控与故障转移；Cluster 解决分片和分片内高可用。
5. 应用正确性：缓存一致性、锁 owner、TTL 原子性、幂等和降级策略必须由应用明确设计。

TCUM 源码中最有价值的案例不是“Redis 能扛多少 QPS”，而是：

- CMDB cache-aside 在回源成功但缓存写失败时仍返回错误，错误地把缓存变成强依赖；
- 合并 MGET 用 map 返回结果，外层再遍历 map 转为 slice，多 key 顺序不可靠；
- 通用锁没有唯一 owner，释放锁也没有 compare-and-delete；
- TCUM-AI 主节点选举使用 Lua 原子续租/抢占/释放，优于通用锁，但仍缺少 fencing token。

---

## 二、为什么 Redis 快，但不能只回答“单线程”

常见原因包括：

- 数据主要在内存；
- 基于事件循环与 IO 多路复用处理大量连接；
- 核心数据结构针对常用操作优化；
- 单条命令执行路径短，避免许多共享数据锁竞争；
- pipeline、批量命令和客户端连接复用减少往返。

“Redis 是单线程”是过度简化。不同版本会用后台线程处理持久化、惰性释放、网络 IO 等工作；核心命令执行模型也不能推导出固定 QPS。吞吐取决于命令复杂度、value 大小、pipeline、网络、CPU、持久化和副本数量。

### 2.1 尾延迟来自哪里

- `KEYS`、大范围集合运算等高复杂度命令；
- 大 key 的读写、序列化、复制和删除；
- RDB/AOF 重写时 fork 与 Copy-on-Write；
- 同时大量 key 过期；
- 内存到达上限后的淘汰；
- 连接池等待、网络抖动和客户端超时；
- 主从全量同步或故障切换。

诊断时看 `SLOWLOG`、`LATENCY DOCTOR`、command stats、事件循环延迟、网络、fork 时长、内存碎片和客户端连接，而不是仅看平均耗时。

---

## 三、数据结构与使用边界

| 结构 | 常见用途 | 主要风险 |
|---|---|---|
| String | 缓存、计数、token、bitmap | 大 value、无界增长 |
| Hash | 对象字段、小型映射 | 热 hash、整体 TTL 语义 |
| List | 简单队列、时间线 | 可靠消费能力弱于 Stream |
| Set | 去重、集合关系 | 大集合运算阻塞 |
| Sorted Set | 排行榜、延时任务、滑动窗口 | 热 key、成员规模与范围扫描 |
| Stream | 消费组、待确认消息 | pending 堆积、裁剪与重试治理 |

### 3.1 String

`SET key value NX EX seconds` 可以把“仅不存在时写入”和 TTL 合成一条原子命令。`INCR` 适合计数，但若首次计数后再单独 `EXPIRE`，两条命令之间存在故障窗口。

### 3.2 Hash

Hash 适合一个对象的多个字段，但 TTL 作用于整个 key，而不是单个 field。每次更新 field 都刷新整个 Hash TTL，可能让冷字段因热字段持续存活。

### 3.3 Sorted Set

用 score 表示时间可以做延时任务，但“取到期项 + 删除”必须原子化，并要处理消费者执行失败。Lua 能保证 Redis 内部状态转移原子，却不能把外部 RPC 一起纳入原子事务。

### 3.4 Stream

Stream 提供消费组和 pending 管理，比 Pub/Sub 更适合需要确认与重试的消息。但它仍需要设计：消息裁剪、pending 超时接管、幂等、毒消息和监控。

---

## 四、过期、淘汰与内存

### 4.1 过期不等于准点删除

Redis 通过访问时惰性删除与后台主动抽样结合清理过期键。所以 TTL 到点代表键在语义上失效，不保证内存立即释放。

大量 key 在同一秒过期可能造成集中清理和回源压力。缓存 TTL 应按业务新鲜度设定，并在允许范围内加入随机抖动。

### 4.2 淘汰策略

- `noeviction`：到达上限后，可能增内存的写命令失败；
- `allkeys-lru` / `allkeys-lfu`：从全部 key 近似淘汰；
- `volatile-*`：只从带 TTL 的 key 中淘汰；若没有可淘汰 TTL key，行为可能退化为拒写；
- `allkeys-random`：随机淘汰。

策略必须匹配数据语义。如果持久状态和可丢缓存混在同一实例，统一淘汰策略很难同时正确，优先拆实例或至少拆资源边界。

### 4.3 大 key 与热 key

大 key 没有统一字节阈值，要结合带宽、单次处理时间、复制、删除和迁移成本定义。治理方法：

- 采样扫描 key 大小和元素数；
- 拆分 value 或集合；
- 用 `UNLINK` 降低同步释放阻塞；
- 限制单次范围读取；
- 在写入入口做大小守卫。

热 key 的核心是单分片/单核负载集中。可按语义使用本地缓存、请求合并、只读副本、key 分片或异步聚合，但分片会增加聚合和一致性成本。

---

## 五、RDB、AOF 与复制

### 5.1 持久化

- RDB：周期性快照，文件紧凑、恢复快，但两次快照之间可能丢数据；生成快照需要 fork，并受 Copy-on-Write 影响。
- AOF：记录写命令，数据窗口取决于 fsync 策略；文件增长后需要重写。
- RDB + AOF：重启时通常用更完整的 AOF 恢复，但仍需验证真实配置、磁盘和恢复时间。
- 无持久化：可以用于纯缓存，但必须接受节点重启数据为空。

不能把 `everysec` 说成所有业务的“生产标配”，也不能承诺“最多只丢一秒”而忽略操作系统、磁盘、故障与复制切换模型。

### 5.2 复制

Redis 基础复制是异步的。副本断线重连时，会基于 replication ID 和 offset 尝试部分同步，条件不满足时执行全量同步。

`WAIT` 可以等待指定数量副本确认写入，但官方明确指出它不会把 Redis 变成强一致 CP 系统，故障切换时仍可能丢失已确认写。

### 5.3 副本不是备份

误删、错误写入和空主库重启都可能复制到副本。备份需要独立保留、隔离权限、定期校验并演练恢复。

---

## 六、Sentinel 与 Cluster

### 6.1 Sentinel

Sentinel 用于非 Cluster 部署，提供：

- 监控主从；
- 多 Sentinel 协作判断故障；
- 自动提升副本；
- 向客户端提供当前主节点地址；
- 通知。

它不改变复制的异步本质。客户端必须支持 Sentinel，并验证网络、NAT、DNS和认证配置。

### 6.2 Redis Cluster

Cluster 把 key 映射到 16384 个 hash slot，再把 slot 分配到主节点。客户端处理 `MOVED`/`ASK` 重定向；分片内通常仍依赖主从复制与选举。

多 key 命令、事务和 Lua 通常要求 key 位于同一 slot，可用 hash tag（如 `{tenant}:a`）把相关 key 定位到同一 slot，但这也可能制造热点。

### 6.3 选型

- 数据量和吞吐单实例可承载，只要自动故障转移：考虑 Sentinel 或托管主从服务；
- 需要水平拆分容量或写吞吐：考虑 Cluster/托管分片；
- 强一致协调：优先评估 etcd/ZooKeeper/数据库 fencing，而不是把 Redis 锁包装成共识系统。

仓库中的 `redis.Client` 单节点配置不能证明线上无高可用，因为地址可能指向代理；同样也不能证明使用了 Cluster。必须用部署配置和控制面证据判断。

---

## 七、缓存一致性

### 7.1 Cache-Aside

读流程：

1. 读缓存；
2. miss 后读权威数据源；
3. 写入带 TTL 的缓存；
4. 返回结果。

写流程通常是先提交数据库，再删除缓存。删除失败需要重试、消息/outbox 或基于 binlog 的失效机制。

“先更新数据库，再更新缓存”在并发下可能发生旧值覆盖新值；“先删缓存，再更新数据库”也可能被并发读回填旧值。没有万能两步顺序，必须明确允许的不一致窗口。

### 7.2 穿透、击穿、雪崩

- 穿透：请求不存在的 key。可用参数校验、短 TTL 空值、Bloom Filter；要考虑误判和数据新增。
- 击穿：热点 key 失效时大量并发回源。可用 singleflight、互斥回填、逻辑过期和 stale-while-revalidate。
- 雪崩：大量 key 同时失效或 Redis 故障。可用 TTL 抖动、多级缓存、限流、熔断和容量保护。

### 7.3 降级策略必须按数据类型选择

- 缓存读失败：可回源，但要限并发，避免击穿数据源；
- 缓存写失败：若数据源读取成功，通常不应让只读请求失败；
- 限额计数失败：fail-open 保可用，fail-closed 保配额，必须由业务决定并打指标；
- 锁服务失败：不能默认“放行”，否则互斥约束失效。

---

## 八、分布式锁的正确边界

### 8.1 单实例基本模型

抢锁：

```text
SET lock_key unique_owner NX PX lease_ms
```

释放必须原子比较 owner：

```lua
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
```

为什么不能直接 `DEL`：A 获得锁后停顿，租约过期；B 获得新锁；A 恢复后直接 DEL，会删掉 B 的锁。

### 8.2 租约、续期和 fencing

owner token 只防误删，不能阻止过期 owner 继续写外部系统。严格场景需要单调递增 fencing token，下游拒绝比已见 token 更旧的操作。

看门狗续期也不是万能的：进程长暂停、网络分区或 Redis 故障会让续期失败。任务必须能停止、幂等重试，或者由下游 fencing 保证安全。

### 8.3 Lua 的边界

Lua 能把 Redis 内部多个命令变为原子状态转换，但脚本执行期间会占用命令执行线程。脚本应短小、有界，并避免扫描大集合。Lua 无法把数据库/RPC 副作用一起原子化。

---

## 九、TCUM 源码案例一：Redis 客户端与缓存基础层

### 9.1 当前实现

源码：

- `tcum-yunshao-global/common/cache/redis.go`
- `tcum-yunshao-global/common/cache/redis_operator.go`
- `tcum-yunshao-global/common/cache/redis_batcher.go`

客户端使用 go-redis v8 的 `redis.Client`，初始化时设置固定连接池和超时，并 Ping 检查。配置可来自配置文件或中间件配置服务。

`MSetWithExpire` 使用 pipeline 对每个 key 执行 `SET value expiration`。pipeline 减少往返，但不是事务：网络/执行失败时，不能把整批视为全成或全败。

### 9.2 固定大连接池不是性能结论

源码设置 `PoolSize=2000`、`MinIdleConns=100`。这只是当前配置，不代表合理：

- 每实例连接数乘以副本数可能压垮 Redis；
- 大池无法修复慢命令；
- 应依据并发、命令耗时、pool wait、Redis `connected_clients` 和服务端 CPU 调整；
- 超时、重试与幂等也要一起评估。

### 9.3 MGET 合并器的真实问题

批处理器在时间窗口内收集请求，去重 key 后发一次 MGET，再按请求拆分结果。这是有效的请求合并思路，但实现存在以下风险。

#### 问题一：丢失调用方 context

提交请求和等待响应都没有监听 `ctx.Done()`；真正 MGET 使用 `context.Background()`。即使上游已超时，请求仍会等待并占用资源。

#### 问题二：map 转 slice 破坏顺序

批处理器返回 `map[string]interface{}`。外层 `MGet` 通过 range map 生成 slice：

```go
for _, v := range vmap {
    varray = append(varray, v)
}
```

Go map 遍历顺序不稳定。多 key 请求无法保证返回值与输入 keys 对齐。当前 CMDB 调用只传一个 key 时未暴露问题，但公共 API 的语义已经不安全。

#### 问题三：批次并发无显式上限

达到阈值或定时触发后通过 goroutine 执行批次。Redis 变慢时，批次可能并发堆积；请求通道和响应等待也缺少超时治理。

### 9.4 推荐 API

```go
func (rb *RedisBatcher) MGet(ctx context.Context, keys ...string) ([]any, error)
```

要求：

- 全链路传递 context；
- 结果按输入 key 顺序组装；
- 批次限制总 key 数和并发数；
- 上游取消后不再回写阻塞通道；
- 指标覆盖 queue depth、batch size、dedupe ratio、wait time、Redis latency 和 cancellation。

---

## 十、TCUM 源码案例二：CMDB Cache-Aside

源码：`service/integration/tcumcmdb/tcum_cmdb_service.go`。

当前流程：

1. 用请求 hash 查 Redis；
2. 命中则反序列化返回；
3. miss 后调用远端 CMDB；
4. 远端失败时把字符串 `tcumerror` 短期写入缓存；
5. 成功则缓存结果，TTL 在区间内随机；MQTT 实体使用更短 TTL。

### 10.1 做对了什么

- TTL 随机化降低同批 key 同时过期；
- 错误短缓存能暂时阻挡持续打向故障依赖的请求；
- 代码记录了命中、回源次数和耗时；
- 上层还使用共享请求合并，降低同 key 并发回源。

### 10.2 主要问题

#### 缓存写失败导致成功回源也失败

远端 CMDB 已成功返回数据后，若 Redis SET 失败，当前代码返回错误而不是源数据。这会把本应可降级的缓存升级为请求成功的强依赖。

更合理的策略：返回权威数据，异步或尽力写缓存，同时记录 `cache_write_error`。只有业务明确要求“结果必须进入缓存”时才失败。

#### magic string 污染数据协议

`"tcumerror"`、`"nil"` 等字符串与正常缓存值混用，存在碰撞和演进困难。应使用带类型的 envelope：

```json
{"status":"negative","reason":"upstream_error","data":null}
```

#### 故障缓存可能放大错误窗口

上游短暂恢复后，错误 sentinel 在 TTL 内仍让请求失败。应区分 not-found 与 dependency-error，后者可使用更短 TTL、退避或 stale data，而不是统一负缓存。

---

## 十一、TCUM 源码案例三：通知配额计数

源码：`service/bizservice/alertservice/notify_quota.go`。

当前设计：本地只缓存“已接近或达到上限”的计数，跨实例精确值用 Redis `INCR`；key 包含日期和接收人，TTL 为 48 小时；Redis 异常时选择放行。

### 11.1 关键竞态：INCR 与 EXPIRE 分离

```go
count, _ := client.Incr(ctx, key).Result()
if count == 1 {
    client.Expire(ctx, key, ttl)
}
```

如果进程在两条命令间失败，key 永不过期。应使用 Lua 原子完成首次递增与 TTL，或者脚本每次检查 TTL 并修复缺失 TTL。

### 11.2 本地清理时间并非可靠“当地零点”

`now.Truncate(24*time.Hour)` 按绝对时长截断，不等价于任意时区的当地零点。应显式构造下一天本地 `00:00:00`。

此外，运行时直接把 `sync.Map` 字段替换为新值，和并发读写之间需要额外同步；`sync.Map` 的方法安全不代表替换承载它的字段也自动安全。

### 11.3 fail-open 是业务决策

Redis 出错时放行能保证通知可达，但可能突破企微配额。需要指标、告警和降级上限。若配额涉及成本或合规，可能应使用本地保守限流或 fail-closed。

---

## 十二、TCUM 源码案例四：两种 Redis 锁

### 12.1 tcum-yunshao-global 通用锁

源码：`common/lock/lock.go`。

当前实现使用 `SETNX key "1" ttl` 抢锁，解锁直接 `DEL key`。

问题：

- 所有 owner 的 value 都是 `"1"`，无法识别持有者；
- 解锁没有 compare-and-delete，旧 owner 可删除新锁；
- `TryLock` 每秒 sleep，没有通过 select 响应 context 取消；
- 没有续租或 fencing；
- 失败模型没有区分“未获得锁”和“Redis 不可用后的业务策略”。

修复：唯一 owner token + Lua 比较删除；长任务增加受控续租；强正确性写入增加 fencing；等待用 ticker/select 响应取消并加入抖动。

### 12.2 tcum-ai 主节点选举

源码：`tcum-ai/pkg/masternode/redis_impl.go`。

它使用 Lua 原子执行：

- 当前 value 等于 nodeID：`PEXPIRE` 续租；
- 否则 `SET key nodeID NX EX ttl` 尝试成为 master；
- 释放时比较 nodeID 后再 DEL。

这比通用锁正确，因为 owner 校验与删除/续租是原子的。实现还在连续 Redis 错误后发出停止主节点事件，以减少错误引发的频繁切换。

但它仍是租约选主，不是共识：

- 没有 fencing token，过期旧 master 可能继续产生副作用；
- Redis 异步复制/切换可能丢锁状态；
- 业务执行器必须及时消费停止事件并可安全中断；
- interval 与 TTL 的比例需要覆盖调度抖动、GC pause 和网络尾延迟。

---

## 十三、安全与配置问题

仓库配置文件中存在明文 Redis 地址和密码。本文不复制具体凭据，但这属于需要立即治理的安全问题：

1. 轮换已经进入仓库历史的凭据；
2. 改用密钥管理或运行时注入；
3. 配置模板只保留变量名；
4. 对历史提交做秘密扫描和处置；
5. Redis 使用最小权限 ACL、TLS/受控网络和审计；
6. 日志不得打印 password 或完整连接串。

仅把文件加入 `.gitignore` 不能移除 Git 历史中的秘密，也不能替代凭据轮换。

---

## 十四、项目事实边界

| 命题 | 仓库证据 | 面试表达 |
|---|---:|---|
| CMDB 查询结果写 Redis，TTL 有随机抖动 | 有 | 可作为 cache-aside 案例 |
| 有跨请求 MGET 合并器 | 有 | 可讲收益和 context/顺序问题 |
| 企微通知用 Redis 计数 | 有 | 可讲 INCR+EXPIRE 原子性 |
| 通用锁用 SETNX + TTL | 有 | 必须同时讲 owner 缺陷 |
| TCUM-AI 用 Lua 做主节点租约 | 有 | 可讲原子续租及 fencing 边界 |
| 线上 Redis 为 6 分片 18 节点 | 无 | 不得写成事实 |
| 使用 Sentinel 或 Cluster | 无充分证据 | 只能讲选型 |
| 固定单实例 QPS、切换时长 | 无 | 不报数字 |
| AOF/RDB 生产配置 | 无 | 不声称生产标配 |

---

## 十五、面试高频 30 问

### Q1：Redis 为什么快？

内存访问、事件驱动、针对性数据结构和较短执行路径共同作用；吞吐还受命令复杂度、网络、value、持久化和复制影响。

### Q2：Redis 真的是单线程吗？

不能笼统说是。核心命令执行长期以串行为主，但后台任务、惰性释放、持久化和部分网络 IO 可使用其他线程或进程。

### Q3：pipeline 保证原子性吗？

不保证。它主要减少网络往返；原子状态转换使用单条命令、Lua，或在合适条件下使用事务。

### Q4：MULTI/EXEC 是否会自动回滚？

Redis 事务与关系数据库不同，不提供通用的执行期自动回滚语义。业务仍需设计错误处理和幂等。

### Q5：过期 key 会在 TTL 到点立即从内存删除吗？

不保证。语义上失效，物理清理由惰性删除和主动抽样完成。

### Q6：缓存淘汰与过期有什么区别？

过期由 key TTL 决定；淘汰是在内存超过限制时根据策略删除 key。

### Q7：RDB 和 AOF 怎么选？

根据 RPO、恢复时间、写放大、fork 风险和运维能力选择；不能脱离业务说某个模式永远最好。

### Q8：Redis 复制是强一致的吗？

不是，基础复制是异步的。`WAIT` 可降低风险但不把系统变为强一致 CP 系统。

### Q9：Sentinel 解决什么？

为非 Cluster 主从提供监控、通知、故障判断、自动切换和主地址发现。

### Q10：Cluster 为什么有 16384 slots？

key 先映射到 slot，slot 再分配给节点，使扩缩容迁移 slot 而非逐一重算所有 key 的节点映射。

### Q11：Cluster 多 key 操作为什么可能失败？

相关 key 不在同一 slot 时，单节点无法原子执行。hash tag 可共槽，但要防热点。

### Q12：缓存穿透怎么处理？

参数校验、短 TTL 负缓存、Bloom Filter；还需处理误判、数据新增和恶意请求。

### Q13：缓存击穿怎么处理？

singleflight、互斥回填、逻辑过期/stale-while-revalidate，并限制回源并发。

### Q14：缓存雪崩怎么处理？

TTL 抖动、多级缓存、高可用、熔断限流和数据源容量保护。

### Q15：为什么删除缓存通常在数据库提交后？

避免数据库回滚但缓存已删除造成无谓回源；不过删除失败仍需可靠重试或变更订阅。

### Q16：Redis 锁为什么需要唯一 value？

用于确认释放者仍是当前 owner，避免旧持有者删掉新持有者的锁。

### Q17：有 owner token 就绝对安全吗？

不是。过期 owner 仍可能写外部系统，严格场景需要 fencing token 和下游校验。

### Q18：Lua 有什么优点和风险？

可原子执行 Redis 内部状态转换；长脚本会阻塞其他命令，且不能覆盖外部副作用。

### Q19：大 key 有什么危害？

网络、序列化、主线程执行、复制、持久化、删除和 Cluster 迁移成本都会增大。

### Q20：热 key 怎么治理？

先测量，再根据读写语义采用本地缓存、合并请求、只读副本、拆 key 或异步聚合。

### Q21：TCUM CMDB 缓存做对了什么？

有随机 TTL、请求合并、错误短缓存和命中/回源指标。

### Q22：TCUM CMDB 缓存的主要可用性问题？

回源成功后缓存写失败仍返回错误，使缓存故障影响本可成功的主链路。

### Q23：TCUM MGET 合并器的顺序问题是什么？

结果先放入 map，外层遍历 map 形成 slice；多 key 时无法与输入 keys 按位置对应。

### Q24：批处理为什么必须传 context？

上游取消后应停止排队和等待，避免无效请求继续占用通道、goroutine 与 Redis 连接。

### Q25：INCR 后再 EXPIRE 有什么风险？

两条命令间失败会留下无 TTL key；用 Lua 或其他原子方案合并。

### Q26：限流依赖 Redis 失败时应放行还是拒绝？

取决于业务：通知可达性可能选择放行，成本/安全场景可能保守拒绝。必须可观测且有降级上限。

### Q27：TCUM 通用锁哪里不安全？

固定 value 且直接 DEL，没有 owner 比较，旧 owner 可能删除新锁。

### Q28：TCUM-AI 主节点 Lua 比通用锁好在哪里？

续租和释放都校验 nodeID，并通过 Lua 原子执行，避免检查与修改之间的竞态。

### Q29：TCUM-AI 主节点选举还缺什么？

缺 fencing token；租约过期后的旧 master 仍可能继续对外产生副作用。

### Q30：如何监控 Redis 应用层质量？

命中率只是起点，还要看回源率、pool wait、超时、重试、批量大小、热/大 key、内存、淘汰、复制延迟、锁续租失败和降级次数。

---

## 十六、项目表达模板

> TCUM 里 Redis 的真实用途包括 CMDB 查询缓存、通知配额和多节点协调。源码审查时我重点看的是正确性边界：CMDB 回源成功后不应因写缓存失败而让请求失败；MGET 合并结果必须保持 key 顺序并传播 context；配额的 INCR 与 TTL 应用 Lua 原子化；普通锁必须使用唯一 owner 和 compare-and-delete。TCUM-AI 的主节点选举已经用 Lua 把 owner 校验、续租和释放原子化，但租约只能证明“Redis 当前认可谁”，不能阻止过期节点继续写外部系统，因此强正确性任务还要加 fencing token、幂等和停止机制。高可用方面，我不会在没有部署证据时声称项目用了 Sentinel 或 Cluster，而会按容量、故障模型和一致性目标给出选型。

---

## 十七、源码与官方资料

### 项目源码

- `/Users/yaao/Documents/code/tcum-yunshao-global/common/cache/redis.go`
- `/Users/yaao/Documents/code/tcum-yunshao-global/common/cache/redis_operator.go`
- `/Users/yaao/Documents/code/tcum-yunshao-global/common/cache/redis_batcher.go`
- `/Users/yaao/Documents/code/tcum-yunshao-global/common/lock/lock.go`
- `/Users/yaao/Documents/code/tcum-yunshao-global/service/integration/tcumcmdb/tcum_cmdb_service.go`
- `/Users/yaao/Documents/code/tcum-yunshao-global/service/bizservice/alertservice/notify_quota.go`
- `/Users/yaao/Documents/code/tcum-ai/pkg/masternode/redis_impl.go`

### Redis 官方文档

- [Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- [Redis replication](https://redis.io/docs/latest/operate/oss_and_stack/management/replication/)
- [High availability with Sentinel](https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/)
- [Redis Cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
- [Key eviction](https://redis.io/docs/latest/develop/reference/eviction/)
- [Diagnosing latency issues](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/)
