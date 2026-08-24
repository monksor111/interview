# 第五卷 · 中间件 · Go 语言专项（重写增强版）

> **本篇定位**：Go 是 TCUM 全栈基础语言（metric-filter / alerts / cmdb-global / unified-gateway 全 Go 写）。相对上一版，本次**全面加深**：GMP 调度深入到源码级、GC 三色标记与写屏障详解、内存分配器 tcmalloc 变体、channel 底层数据结构、sync 原语实现、逃逸分析规则、context 生命周期、pprof/trace 实战、反射/unsafe 边界、云原生生产实践、60+ 高频面试题。密度对齐 `tcum-ai/01`。

## 📖 目录
- §1 命题：Go 为什么是云原生首选
- §2 协程原理：goroutine vs 线程（内核层深挖）
- §3 GMP 调度模型（源码级细节）
- §4 goroutine 栈管理与连续栈
- §5 channel 底层数据结构与操作
- §6 sync 原语深度：Mutex/RWMutex/WaitGroup/Once/Pool/Map
- §7 内存模型与 happens-before
- §8 内存分配器：mspan / mcache / mcentral / mheap
- §9 GC 三色标记 + 混合写屏障（源码级）
- §10 逃逸分析规则与工具
- §11 context：源码结构与生命周期
- §12 反射与 unsafe 边界
- §13 net/http & netpoll
- §14 泛型（1.18+）与实现原理
- §15 defer / panic / recover 深度
- §16 interface 内幕与陷阱
- §17 error wrapping + errors.Is/As
- §18 pprof / trace / race detector 实战
- §19 生产实战：TCUM 代码里的 Go 细节
- §20 60 问对比 Go vs Java/Rust
- §21 短板与坑
- §22 面试话术模板

---

## §1 · 命题：Go 为什么是云原生首选

### 一句话背诵

> "Go 是**云原生生态几乎全都用它写**（K8s / Docker / Prometheus / etcd / Istio / Terraform / TCUM 全栈）的原因是三点：**内建并发（goroutine + channel）+ 静态编译单二进制 + 学习曲线极平**。相比 Java 少了 JVM 复杂度，相比 Rust 少了 borrow checker 心智负担，相比 C 有 GC 和 goroutine——**云原生的中间地带 Go 拿满**。"

### 六大优势

1. **并发内置且轻量**：goroutine 2KB 起，单机百万级（Java Thread 1MB → 单机 5000，**500 倍差异**）
2. **静态编译单二进制**：`FROM scratch` 几十 MB（Java 需 JRE 几百 MB）
3. **学习曲线平缓**：语言规范 30 页，一周上手
4. **runtime 内建**：GC / netpoll / 调度器不需要额外框架
5. **接口隐式实现**：duck typing 让 API 演进宽容
6. **工具链完善**：`go fmt / go vet / go test / pprof / trace / race` 开箱即用

### 边界代价

1. **GC 是极致性能瓶颈**：XStor 火焰图 35% CPU GC（iwiki 4016226228）
2. **无泛型太久**（1.18 才有），生态大量代码 `interface{}` + 反射
3. **错误处理啰嗦**：`if err != nil` 泛滥
4. **无枚举 / 无 sum type**：只能 `const + iota` 模拟
5. **反射性能差**：热点路径避免
6. **defer 有开销**（1.14 前明显，后优化）

---

## §2 · 协程原理：goroutine vs 线程（内核层深挖）

### 2.1 三大差异表（面试可背）

| 维度 | OS 线程 | goroutine |
|---|---|---|
| 调度者 | 内核 | Go runtime（用户态） |
| 切换成本 | μs 级（syscall + TLB flush） | ns 级（几个寄存器） |
| 栈大小 | 固定 1MB / 8MB | **2KB 起步，动态到 1GB** |
| 创建成本 | 几十 μs + syscall | 几百 ns |
| 单机极限 | 几千 | **百万** |
| 通信方式 | 共享内存 + 锁 | channel（Don't communicate by sharing memory） |

### 2.2 内核线程切换为什么贵

**5 个阶段每个都消耗**：
1. **陷入内核态**（syscall）：几百 ns
2. **保存全部寄存器**到内核栈：全部通用寄存器 + 段寄存器 + FPU
3. **修改 MMU**：如果跨进程则 **TLB flush**（灾难）—— Meltdown 后 KPTI 让每次跨用户/内核切换也要 TLB flush
4. **加载新线程寄存器**
5. **返回用户态**

**总耗时**：1~5μs（进程切换）+ CPU cache miss 后续更贵。

### 2.3 goroutine 切换

1. 保存**当前 g 的 SP/PC/几个寄存器**到 g.sched
2. 修改 M 上的 curg 指针到新 g
3. 从新 g.sched 加载 SP/PC 恢复执行

**完全在用户态，无 syscall，几十~几百 ns**。

### 2.4 `go func()` 背后（源码级）

**编译器把 `go f()` 翻译成 `runtime.newproc(fn)`**：

```
runtime.newproc:
  1. 从 M 的本地 gfree 或全局 sched.gFree 取空闲 g
  2. 若无，从 sync.Pool 或全新 malloc 分配 g 结构体
  3. 初始化栈（2KB，_StackMin）
  4. 设置 g.sched.PC = fn, g.sched.SP = 栈顶
  5. runqput 放到当前 P 的本地 runq 末尾
  6. 如果有空闲 P + 无空闲 M：wakep（创建 M 绑定 P）
  7. 继续跑当前 goroutine（不立即切换）
```

**关键点**：`go f()` 不立即切换，只是入队。

### 2.5 goroutine 泄漏（最常见 bug）

```go
ch := make(chan int)
go func() { <-ch }()  // ch 无人发送，永久等待 → 泄漏
```

**排查**：
- `runtime.NumGoroutine()` 观察数量增长
- `pprof/goroutine?debug=2` 打全 stack trace 定位阻塞点
- `net/http/pprof` 生产暴露

**规则记住**："**goroutine 不会被 GC，只有 return / panic 才结束**"

### 2.6 goroutine 常见泄漏模式

1. **channel 阻塞**：无缓冲 + 无接收方
2. **for-select 无 default 死等**
3. **HTTP 请求没设 Timeout**：连接 hang 住 goroutine
4. **context 未 cancel**：defer cancel() 漏了
5. **锁未 unlock**：panic 内没 recover

---

## §3 · GMP 调度模型（源码级细节）

### 3.1 三个核心概念

- **G（Goroutine）**：用户态协程
  - 状态：`_Gidle / _Grunnable / _Grunning / _Gsyscall / _Gwaiting / _Gdead`
  - 结构：栈信息 + 调度信息 + 状态 + 上下文（context 值放这里）
- **M（Machine）**：OS 线程（pthread）
  - 上限默认 10000（`runtime.GOMAXPROCS` 不影响这个，看 debug.SetMaxThreads）
  - 每个 M 有独立的 g0（调度用的 goroutine，栈更大）
- **P（Processor）**：逻辑处理器
  - 数量 = **GOMAXPROCS**（默认 CPU 核数）
  - **每 P 有本地 runq（256 长度）**
  - 状态：`_Pidle / _Prunning / _Psyscall / _Pgcstop`

**核心约束**：G 必须绑定 P 才能被 M 执行 → **任意时刻最多 GOMAXPROCS 个 goroutine 真正并行**。

**三者的本质定位（这是理解"关系"的入口）**：

| 角色 | 本质 | 一句话 |
|---|---|---|
| **G**（Goroutine） | 用户态协程，**要执行的"任务"** | 一个函数调用的执行单元，有独立栈、状态、上下文 |
| **M**（Machine） | OS 线程（pthread），**真正干活的"工人"** | 只有 M 才真正占用 CPU、真正执行指令 |
| **P**（Processor） | 逻辑处理器，**"工作台/并行许可证"** | 一个抽象执行资源，管本地队列 + 运行状态 |

G 自己不能直接占 CPU，它必须先**挂到某个 P 上**，再由**绑定了这个 P 的 M** 来真正执行。

**三条硬约束绑定关系（关系的灵魂）**：

1. **一个 M 最多绑定一个 P**（M 必须有 P 才能跑 G，否则 M 空闲/休眠）
2. **一个 P 最多被一个 M 绑定**（P 被占了，别的 M 就不能再绑它）
3. **一个 P 的本地 runq 里可以排很多 G**，但**同一时刻只有 1 个 G 在这个 P 上被某个 M 真正运行**（那个 G 叫 `curg`）

一句话概括：**P 是「G 和 M 之间的中间层」——G 不直接认 M，G 认的是 P；M 也不直接认 G，M 要先「抢」到一个 P，再从 P 的队列里取 G 来跑。** 多出来的 P 这一层，正是 Go 调度器设计的精华。

**数量关系**：

| 角色 | 数量 | 上限 | 说明 |
|---|---|---|---|
| G | 用户随便建 | 只受内存限制 | 初始栈仅 2KB，极廉价 |
| M | 按需创建 | 默认 **10000**（`debug.SetMaxThreads`） | OS 线程，创建有成本（1MB 栈 + 内核态） |
| P | 固定 | **= `GOMAXPROCS`**（默认 CPU 核数） | 决定**最多多少个 goroutine 真正并行** |

P 的数量是**并行度的硬上限**：哪怕开 100 万个 G，只要 P 只有 8 个，任意时刻真正跑的 G 也只有 8 个。

### 3.2 结构关系图

```
[全局 sched]
    ├── sched.runq (全局 runq)
    ├── sched.gFree (空闲 g 列表)
    ├── sched.midle (空闲 M 列表)
    ├── sched.pidle (空闲 P 列表)
    └── sched.allp (所有 P)

P1 ── M1 ── curg → G1
   └── runq: [G2, G3, G4, ..., 256 个]
P2 ── M2 ── curg → G5
   └── runq: [G6, G7]
P3 (idle) ── nil M
```

**一个 G 的完整一生（把关系串起来）**：

```
① 创建：go func()
   G 被 new 出来，状态 = _Grunnable
   → 优先放入「当前 M 所绑 P 的本地 runq」（放不下才放全局 runq）

② M 取 G（调度循环，跑在 g0 上）：
   M 执行完上一个 G 后，执行 findRunnable() 找下一个 G：
     1) 先看自己绑的 P 的 runq（无锁，快）
     2) 再看全局 runq（加锁）
     3) 再看 netpoll 有没有就绪 fd
     4) 都没有 → work-stealing 偷别的 P
     5) 还找不到 → M 解绑 P，M 休眠

③ G 被选中：
   P.curg = G，G 状态 _Grunnable → _Grunning
   M 切换到 G 的栈上执行

④ 执行中遇到三种情况之一：
   a) 主动/被动让出（channel、mutex、Gosched）→ G 状态 _Gwaiting，放回队列，M 继续找下一个 G
   b) 发起 syscall → 见 3.5「syscall 解绑」
   c) 执行完 → G 状态 _Gdead，复用或回收，M 继续找下一个 G
```

**两个特殊角色（理解关系必备）**：

- **`g0`**：每个 M 都自带一个特殊的 g0，它不是用户 goroutine，而是**调度器本身**跑的时候用的。M 在「调度循环找下一个 G」时就是运行在 g0 上（g0 栈更大）。用户 G 的切换都是「先回到 g0，再切到下一个 G」。
- **`sysmon`**：一个**不绑定任何 P** 的特殊 M，负责后台监控（抢占、netpoll、GC、检测卡死的 syscall）。这就是为什么它能"游离"在 P 体系之外。

**一句话回答「GMP 是什么关系」**：

> G 是要跑的任务，M 是真正执行任务的 OS 线程，P 是连接两者的中间层和"并行许可证"。G 必须挂在 P 的队列上、由绑定了这个 P 的 M 来执行；一个 M 只能绑一个 P，一个 P 只能被一个 M 绑，但一个 P 的队列里可以排队多个 G。P 的数量（GOMAXPROCS）就是并行度上限。当 G 遇到 syscall 时，P 会从 M 上解绑、换一个 M 继续跑别的 G——这正是 Go 用「少量 P + 大量 M」优雅处理阻塞的关键。

### 3.3 调度触发时机

**协作式（cooperative）**：
- channel / mutex 阻塞 → `gopark`
- syscall 阻塞
- `time.Sleep()`
- 网络 IO（走 netpoll）
- **函数调用时的栈检查**：函数序言（prologue）会检查栈够不够，顺便检查 preempt flag
- `runtime.Gosched()` 主动让出

**抢占式（Go 1.14+）**：
- runtime 系统监控（sysmon）线程定期给 M 发 **`SIGURG` 信号**
- 信号处理器暂停当前 g，标记为可抢占
- **解决了 Go 1.13 之前"纯 CPU 循环（无函数调用）卡死 P"的问题**：
  ```go
  // Go 1.13 前：这段代码会独占 P，其他 g 饿死
  go func() { for {} }()
  ```

### 3.4 work-stealing 详解

**M 找 g 的顺序**（`runtime.findRunnable`）：
1. **本地 runq**（快路径，无锁）
2. **全局 runq**（加锁但少量）
3. **netpoll 检查就绪 fd**
4. **work-stealing**：随机选 3 次不同 P 偷它队列**后一半**（LIFO 减少缓存失效）
5. **park M**：找不到 g → M 睡眠等唤醒

**为什么偷后一半**：前一半缓存热度高被 owner 用着，后一半迁移代价低——**缓存亲和性优化**。

**偷 3 次的道理**：随机避免 hotspot，3 次覆盖率够高避免频繁抢锁。

### 3.5 P 与 M 解绑（syscall 场景）

**Go 1.14+ 处理**：
1. g 进入 `_Gsyscall`
2. **P 从当前 M 解绑**（`releasep`）—— 关键设计！
3. P 立即被空闲 M（handoffp）拿走继续跑其他 g
4. 原 M 继续跑当前 g 的 syscall（陷入内核态）
5. syscall 返回后 g 尝试拿回 P，拿不到就入全局队列，M 进入空闲池

**面试深度**：
> "Go 之所以能同时享受 M:N 性能和 syscall 兼容性，核心就是 P 中间层。这是相对 Java NIO / Rust async 的最大差异化——Go 的调度器对用户完全透明。"

### 3.6 netpoll：网络 IO 不阻塞 M

**`conn.Read()` 底层**：
1. **不直接 syscall**（不会阻塞 M）
2. 注册 fd 到 netpoll（epoll/kqueue），g 进入 `_Gwaiting`
3. netpoll 有独立后台 goroutine 定期 poll 就绪 fd
4. fd 就绪 → 唤醒对应 g → 放回 runq

**这就是为什么 Go 一个 goroutine per connection 能扛百万连接**——同样能力 Java 需要 Netty 事件驱动 + 线程池。

### 3.7 sysmon（系统监控线程）

- **独立 M，不绑 P**
- 每 10ms/20us 循环：
  - **抢占**：给长时间跑的 g 发 SIGURG
  - **netpoll**：定期检查就绪 fd
  - **GC**：触发定时 GC
  - **系统调用监控**：检测 syscall 超时的 P 解绑

### 3.8 GOMAXPROCS 与 K8s 陷阱

- **Go 1.22 前**：`runtime.NumCPU()` / `GOMAXPROCS` 默认 = 宿主机 CPU 核数
- **在 K8s pod 里陷阱**：pod limit 4 core 但看到宿主机 96 核 → 起 96 goroutine → **CPU throttle 严重延迟**
- **修法**（Go 1.22 前）：
  - 用 `automaxprocs`（uber）从 cgroup 读真实核数
  - VM 代码：`cgroup.AvailableCPUs()`（`pendingseries.go:220`）
- **Go 1.22+**：runtime 自动感知 cgroup

---

## §4 · goroutine 栈管理与连续栈

### 4.1 演进

- **Go 1.2 前**：分段栈（segmented stack）—— 栈满时分配新段 + 链表连接
  - 问题：**hot split**（函数在栈边界频繁调用触发 alloc/free 抖动）
- **Go 1.3+**：**连续栈**（contiguous stack）
  - 栈满时分配 2 倍新栈 + **复制内容** + **调整所有指针**（GC 精确类型信息支撑）
  - 起始 **2KB**（`_StackMin`），最大 **1GB**（`maxstacksize`）

### 4.2 栈增长流程

1. 函数序言检查 SP 是否越界（`morestack` 检查）
2. 越界 → 调用 `runtime.morestack`
3. 分配 2 倍新栈
4. **精确扫描栈上的所有指针**（Go 精确 GC 元数据支撑）
5. **复制旧栈内容到新栈 + 更新所有栈上指针**
6. 释放旧栈
7. 继续执行

### 4.3 栈收缩

- GC 期间扫描每个 goroutine 栈
- 使用 < 1/4 → 收缩到一半
- **减少内存占用，避免长期占大栈**

### 4.4 为什么只有 Go 能做连续栈

- **Go 精确 GC 知道每个栈位置的类型信息**（compile-time 生成 stack map），能识别指针
- C/C++ 做不到（编译器不生成栈位置类型元数据）
- Java JVM 用固定栈或 CompressedOops 不搞连续栈

---

## §5 · channel 底层数据结构与操作

### 5.1 hchan 结构

```go
type hchan struct {
    qcount   uint           // 当前元素数
    dataqsiz uint           // 环形队列大小（缓冲 channel）
    buf      unsafe.Pointer // 环形队列指针
    elemsize uint16
    closed   uint32
    elemtype *_type
    sendx    uint            // send 索引
    recvx    uint            // recv 索引
    recvq    waitq           // 等待接收的 goroutine 队列
    sendq    waitq           // 等待发送的 goroutine 队列
    lock     mutex           // 保护 hchan 所有字段
}
```

### 5.2 send 三种情况

**Case 1 · 有等待的 recv goroutine**：
- **直接 handoff**：数据直接给等待的 recv g（**跳过 buffer**）
- 唤醒 recv g

**Case 2 · buffer 未满**：
- 数据入 buffer
- sendx = (sendx+1) % dataqsiz

**Case 3 · buffer 已满 或 无缓冲无等待**：
- 当前 g 打包成 sudog 入 sendq
- gopark 阻塞
- 等 recv 唤醒

### 5.3 recv 对称三种情况

**Case 1 · sendq 非空 且 缓冲区满**：
- 从 buffer 取一个（保证 FIFO）
- 从 sendq 拿一个等待的 send g，把它的数据入 buffer
- 唤醒 send g

**Case 2 · buffer 非空**：
- 从 buffer 拿

**Case 3 · buffer 空 且 无 send 等待**：
- 阻塞入 recvq

### 5.4 close 处理

- 设置 closed=1
- **唤醒所有 sendq 中的 g，让它们 panic**（`send on closed channel`）
- **唤醒所有 recvq 中的 g，让它们收到零值 + ok=false**

### 5.5 select 随机性

- **多个 case 就绪 → `fastrand()` 随机选一个**
- 防止饥饿

**实现**：
1. 收集所有 case
2. 随机洗牌顺序
3. 按顺序尝试非阻塞操作
4. 都不行 → 每个 case 都注册到对应 channel 的等待队列
5. gopark
6. 任一 channel 唤醒时清理其他注册

### 5.6 channel 陷阱

**Q**：`close(ch); close(ch)` → **panic**
**Q**：`close(ch); ch <- 1` → **panic**
**Q**：`close(nil)` → **panic**
**Q**：`v, ok := <-closedCh` → **v=零值, ok=false**（不 panic）

**为什么不对称**：**producer 负责 close，consumer 感知**。这是 Go 的设计原则。

### 5.7 for-select-default 陷阱

```go
for {
    select {
    case <-ch:
        return
    default:
        // 空转 100% CPU！
    }
}
```

修法：加 `time.Sleep()` 或去掉 default。

---

## §6 · sync 原语深度

### 6.1 sync.Mutex 两个模式（Go 1.9+）

**Mutex 内部结构**：
```go
type Mutex struct {
    state int32   // [starving:1][waiter_count:30][woken:1][locked:1]
    sema  uint32  // 信号量
}
```

**正常模式**：CAS 抢锁（性能好但可能饥饿）
- 新 g Lock → 尝试 CAS locked bit
- 失败 → 短暂自旋（4 次）
- 仍失败 → 入队休眠

**饥饿模式**：等锁 > 1ms 触发 → 新来的 g **不能抢锁**直接入队，唤醒者优先获得锁 → 公平但慢 30%
- 队首等待时长 < 1ms 后切回正常模式

**面试深度**：
> "1.9 前 Mutex 完全 unfair，长期高并发场景队首饿死。1.9 引入 starving mode 折中：性能优先，饥饿兜底。"

### 6.2 sync.RWMutex

- 读多写少场景
- **写者 Lock() 时阻塞新读者**
- **短临界区（<100ns）RWMutex 比 Mutex 慢 2~3 倍**（内部有更多原子操作和读者计数）
- **写锁饥饿保护**：写者 pending 时不再接受新读者

### 6.3 sync.WaitGroup 三大坑

```go
type WaitGroup struct {
    noCopy noCopy
    state1 [3]uint32   // [counter:32][waiter:32][sema:32]
}
```

**坑 1**：Add 必须在 goroutine 外
```go
// 错：race 条件，Add 可能在 Wait 后执行
go func() { wg.Add(1); ...; wg.Done() }()
wg.Wait()

// 对
wg.Add(1)
go func() { defer wg.Done(); ... }()
wg.Wait()
```

**坑 2**：不能复用
- Wait() 返回后计数是 0，再 Add 可能和残留 waiter 冲突

**坑 3**：**必须传指针** `*sync.WaitGroup`
- 值传递会导致内部状态复制，counter 各自增

### 6.4 sync.Once 双检锁经典

```go
func (o *Once) Do(f func()) {
    if atomic.LoadUint32(&o.done) == 0 {  // 快路径：无锁读
        o.doSlow(f)
    }
}
func (o *Once) doSlow(f func()) {
    o.m.Lock()
    defer o.m.Unlock()
    if o.done == 0 {  // 二次检查
        defer atomic.StoreUint32(&o.done, 1)
        f()
    }
}
```

**注意**：`o.done = 1` 用 defer 保证 f panic 也标记完成（防止 f 再次调用重入）。

### 6.5 sync.Pool GC 特性

- **每 GC 周期开始时 Pool 被清空**（Go 1.13+ 有 victim cache 保留一轮）
- 每 P 有本地 pool（无锁快路径）
- Get 顺序：本地 pool → 本地 victim pool → 偷其他 P 的 pool → New

**关键理解**："**Pool 不是稳定缓存，是 GC 敏感的临时池**"

**用途**：临时 buffer 复用减少 alloc → GC 压力小
```go
var bufPool = sync.Pool{
    New: func() any { return new(bytes.Buffer) },
}
b := bufPool.Get().(*bytes.Buffer)
defer func() { b.Reset(); bufPool.Put(b) }()
```

**VM 库实战**（`pendingseries.go:220`）：
```go
var writeRequestBufPool bytesutil.ByteBufferPool  // 底层 sync.Pool
```

### 6.6 sync.Map vs map + Mutex

**Go 官方源码注释明示 sync.Map 只适合两个场景**：
- ① **一个 key 只写一次读多次**（如全局配置）
- ② **多 goroutine 读写不同的 key**（无写冲突）

**其他场景用普通 map + Mutex 更好**。误区："以为 sync.Map 是更好的并发 map"。

**内部实现**：read map（无锁）+ dirty map（有锁）+ 提升机制。

### 6.7 sync.Cond

- 条件变量：Wait / Signal / Broadcast
- **实际生产少用**（channel 覆盖大多数场景）
- 唯一用途：多 waiter 一起唤醒的**广播场景**

### 6.8 atomic 包

- CAS / Load / Store / Add
- **atomic.Value**：任意类型原子读写
- **atomic 比 Mutex 快 10x+**：但只能操作单一变量

---

## §7 · 内存模型与 happens-before

### 7.1 Go 内存模型（memory model）

- Go 1.19 更新过内存模型规范
- **只在有 happens-before 关系时保证可见性**
- 否则**编译器 + CPU 可能重排** → race condition

### 7.2 happens-before 建立方式

1. **同 goroutine 内代码顺序**（编译器允许在无副作用时重排）
2. **channel 发送 hb 对应接收**
3. **Mutex Unlock hb 下次 Lock**
4. **sync.Once 首次 Do hb 后续 Do**
5. **`go` 语句 hb 该 goroutine 内所有事件**（父 hb 子 start）
6. **goroutine 退出 hb 引发它退出的操作**（Wait 后）
7. **atomic 操作对应关系**

### 7.3 race detector

- **`go test -race` / `go run -race`**
- 每次内存访问附带 **vector clock**
- 检测无 hb 关系的并发访问
- 代价：内存 5~10 倍，CPU 2~20 倍
- **只用于测试和 canary**，生产不开

**金句**：race detector 只能发现**实际发生的**竞争，不能证明代码无竞争——覆盖率决定发现率。

### 7.4 闭包捕获循环变量陷阱（Go 1.22 前）

```go
// Go 1.21 及以前的坑
for i := 0; i < 10; i++ {
    go func() { fmt.Println(i) }()  // 可能全部打印 10
}

// 修法：显式传值
for i := 0; i < 10; i++ {
    go func(i int) { fmt.Println(i) }(i)
}
```

**Go 1.22+ 修正**：每次循环创建新 `i`——**最重要的语义变更之一**。

---

## §8 · 内存分配器：mspan / mcache / mcentral / mheap

### 8.1 tcmalloc 风格

Go 的分配器基于 Google tcmalloc（Thread-Caching Malloc）：
- **无锁快路径**（每 P 有本地 cache）
- **多级分配**：mcache → mcentral → mheap → OS

### 8.2 结构层次

```
[OS]
  ↑ mmap arena（64MB chunks）
[mheap]（全局，锁）
  ├── free lists (spanClasses × 2)
  └── large object direct
  ↑ 分配 mspan
[mcentral]（全局，每 sizeClass 一个，锁）
  ├── nonempty spans
  └── empty spans
  ↑ 分配 mspan 到 mcache
[mcache]（每 P 一个，**无锁**）
  └── alloc[sizeClasses] mspan array
  ↑ 分配对象
[goroutine]
```

### 8.3 sizeClasses（对象大小分类）

- 67 个 size class（Go 1.21）
- 例：8B / 16B / 32B / 48B / ... / 32KB
- **超过 32KB 走 large object 路径**（直接 mheap 分配）

### 8.4 分配流程

**小对象**（≤32KB）：
1. 找 sizeClass
2. mcache.alloc[class] 有空闲 slot → 直接返回（**无锁快路径**）
3. 没有 → mcentral 拿一个新 mspan
4. mcentral 没有 → mheap 分配
5. mheap 没有 → mmap 新 arena from OS

**大对象**（>32KB）：
- 直接 mheap 分配

**极小对象**（≤16B 且 无指针）：
- **tiny allocator**：多个小对象合并放同一 8B slot（提升密度）

### 8.5 mspan 结构

- 一片连续内存（几个 page × 8KB）
- 切成同 sizeClass 的多个 slot
- allocBits / gcmarkBits 位图记录分配 + GC 标记

### 8.6 内存对齐

- 结构体字段按类型对齐（int64 8 字节对齐）
- **字段重排能减少内存**：`struct{bool; int64; bool}` = 24B → `struct{int64; bool; bool}` = 16B
- 工具：`go vet -fieldalignment`

---

## §9 · GC 三色标记 + 混合写屏障（源码级）

### 9.1 版本演进

- Go 1.4：STW GC（几百 ms）
- Go 1.5：**并发三色标记 + 写屏障**（STW 10ms）
- Go 1.8：**混合写屏障**（STW 100μs）
- Go 1.14+：STW < 100μs

### 9.2 三色抽象

- **白**：待扫描，标记结束仍白 = **垃圾**
- **灰**：已扫描但引用未扫描（在扫描队列）
- **黑**：完全处理

### 9.3 GC 阶段

1. **STW1（sweep termination）**：< 100μs，暂停清扫上轮残留
2. **并发标记**：
   - Root 变灰（栈、全局变量）
   - 从灰对象出发扫描引用，引用变灰，自己变黑
   - **写屏障保护**并发正确性
3. **STW2（mark termination）**：< 100μs，标记结束
4. **并发清扫**：白对象释放

### 9.4 三色不变性

**违反不变性会漏标**：

**破坏场景**：黑对象指向白对象 + 唯一的灰对象引用被删除
```go
// 假设 A 是黑，B 是白，C 是灰（唯一引用 B）
A.ref = B    // 黑指白（违反强不变性）
C.ref = nil  // 删掉唯一灰引用
// 结果：B 被漏标，误回收 → 悬空指针
```

### 9.5 两种不变性

- **强三色不变性**：黑对象不能指向白对象（**插入屏障**保证）
- **弱三色不变性**：白对象只能被至少一个灰对象引用（**删除屏障**保证）

### 9.6 混合写屏障（Go 1.8+）

**Go 现在使用的写屏障**：

```
writeBarrier(slot *unsafe.Pointer, ptr unsafe.Pointer):
    shade(*slot)       // 删除屏障：slot 原对象变灰（保证被删除的引用被标记）
    shade(ptr)         // 插入屏障：新写入的 ptr 变灰
    *slot = ptr
```

**关键设计**：
- **栈上写不加屏障**（栈默认全黑，扫栈精确处理）
- 只对**堆上的指针写**加屏障
- **避免每次扫栈的 STW**（1.7 前每次 mark termination 要扫所有栈）

### 9.7 GC 触发时机

- **堆增长触发**：`GOGC=100`（默认）→ 堆到上次 live_heap × 2 时触发
- **定时触发**：sysmon 2 分钟没 GC 强制一次
- **手动 `runtime.GC()`**

### 9.8 GOMEMLIMIT（Go 1.19+）

- 软性上限
- 内存接近 limit 时 GC 更激进（不等 GOGC 倍数）
- **K8s pod 场景关键**：pod 内存 limit 4G，设 GOMEMLIMIT=3.5GiB 避免 OOM Killed

### 9.9 火焰图分析：XStor 的教训

**iwiki 4016226228 原文**：
> "XStor 火焰图 65% CPU 无法优化：35% GC + 30% cgo extern code"

**深度分析**：
- InfluxDB Go 代码大量 `[]byte→string→[]byte` 转换 → 频繁 alloc → GC 压力
- 高频路径 GC 占 35% CPU

**VM 的修法**：`bytesutil.ToUnsafeString` 零拷贝 + `sync.Pool` 复用 + 预分配 slice。**这就是 VM 相对 InfluxDB 性能好的核心原因**。

### 9.10 GC 面试模板："怎么排查 Go GC 问题"

1. `GODEBUG=gctrace=1` 观察 GC 耗时 + 堆大小
2. `pprof heap` 定位内存热点
3. `pprof allocs` 定位分配热点
4. `go tool trace` 看 GC pauses
5. 对症：sync.Pool / 减少逃逸 / GOGC 调整 / GOMEMLIMIT

---

## §10 · 逃逸分析规则与工具

### 10.1 逃逸场景（考试重点）

1. **返回局部变量指针**
   ```go
   func f() *int { x := 1; return &x }  // x 逃逸
   ```

2. **变量被闭包捕获**（跨越 goroutine 生命周期）

3. **interface 装箱**（值类型转 interface{}）
   ```go
   fmt.Println(n)  // n 逃逸（Println 参数是 ...interface{}）
   ```

4. **大对象**（编译器判断栈放不下）

5. **动态类型**（slice/map 长度不确定）

6. **channel 传送指针**：接收方生命周期不定

### 10.2 查看逃逸

```bash
go build -gcflags="-m -m"
```

输出示例：
```
main.go:5:6: x escapes to heap
main.go:10:15: []int{...} does not escape
```

### 10.3 逃逸避免技巧

**VM 零拷贝技法**（`pendingseries.go:196-215` copyTimeSeries）：
```go
buf = append(buf, srcLabel.Name...)
dstLabel.Name = bytesutil.ToUnsafeString(buf[len(buf)-len(srcLabel.Name):])
```
**没有新 string 逃逸，GC 压力最小** —— 教科书级例子。

**其他技巧**：
- 传值 struct 代替 `*struct`（小结构）
- 预分配 slice/map cap
- 避免 `fmt.Sprintf` 热点路径（用 strconv）
- 不必要不要用 `interface{}`

---

## §11 · context：源码结构与生命周期

### 11.1 四大能力

1. **取消传播**（WithCancel + Done channel）
2. **超时**（WithTimeout / WithDeadline）
3. **值传递**（WithValue）
4. **请求作用域**

### 11.2 内部结构

```go
type cancelCtx struct {
    Context             // 父 context
    mu       sync.Mutex
    done     chan struct{}  // Done() 返回，取消时 close
    children map[canceler]struct{}
    err      error
}
```

**关键**：Done() 返回的 channel 是**"只 close 不 send"** —— 取消时 close(done) 广播给所有 <-Done()。

### 11.3 取消传播

- 父 cancel → close(done)
- 遍历 children，对每个 child cancel
- **树状递归取消**

### 11.4 三大反模式

1. **忘记 defer cancel()** → 定时器泄漏
   ```go
   ctx, _ := context.WithTimeout(parent, 5*time.Second)  // 忘 cancel
   // 5 秒计时器 goroutine 泄漏到 GC 才回收
   ```

2. **context 传业务参数** → 类型不安全 + 隐式依赖
   ```go
   ctx = context.WithValue(ctx, "user_id", 123)  // 反模式
   ```

3. **context 存 struct 里** → 生命周期混乱

**官方明示**：context 应作为函数第一个参数，不能存 struct。

### 11.5 实战证据（tcum-cmdb-global）

```go
// unified_incr_sync_consumer.go
ctx := context.TODO()  // 初始化占位
for {
    select {
    case <-ctx.Done():
        return u.KafkaConsumerService.consumer.Close()
    default:
        msg, err := u.KafkaConsumerService.consumer.ReadMessage(time.Second)
        ...
    }
}
```

**context.TODO() vs Background()**：
- Background() = 明确的顶层 root
- TODO() = 占位符（不确定用哪个）
- 新代码用 Background()

---

## §12 · 反射与 unsafe 边界

### 12.1 反射性能

- 直接调用：1x
- interface 方法：2~3x
- `reflect.Value.Call`：50~100x
- `reflect.Value.Field(i).Set`：20~50x

**结论**：**不能用在热点路径**。

**典型场景**：JSON 反序列化、ORM、依赖注入（一次性开销可接受）。

### 12.2 反射三大定律

1. **interface → reflect.Value / reflect.Type**（TypeOf / ValueOf）
2. **reflect.Value → interface{}**（Interface()）
3. **修改 Value 必须 CanSet()**（原变量必须可寻址）

### 12.3 unsafe.Pointer 四大规则

1. **`*T1 → unsafe.Pointer → *T2`**（内存布局兼容前提）
2. **`unsafe.Pointer → uintptr`—— 不要长期持有 uintptr！**
   - GC 移动对象时 uintptr 不会跟着更新，失效
3. **同一表达式内的地址计算**
4. **`reflect.Value.UnsafePointer()`**

### 12.4 VM 库 unsafe 用法

**`bytesutil.ToUnsafeString`**：
```go
func ToUnsafeString(b []byte) string {
    return *(*string)(unsafe.Pointer(&b))
}
```

- **不拷贝底层内存**：把 []byte 头强转成 string 头
- **前提**：buf 生命周期 ≥ string 生命周期
- **安全性靠代码 review，不是编译器**

**金句**：
> "unsafe 是 Go 的性能出口，也是安全出口。VM 用它减少 GC 压力，代价是必须靠代码 review 保证生命周期。这是 Go 相对 Java 的性能杀器，也是相对 Rust 的安全债。"

### 12.5 Go 1.20 新增 unsafe.SliceData / StringData / Slice / String

- 官方支持的安全构造，替代旧 `*(*string)(unsafe.Pointer(&b))` 写法

---

## §13 · net/http & netpoll

### 13.1 net/http 一次请求流程

1. `http.ListenAndServe` 起 accept loop（单 goroutine）
2. 每个连接分配一个 goroutine 处理（**goroutine per connection**）
3. Handler 里同步 IO 但底层 netpoll 不阻塞 M
4. 处理完 close conn

### 13.2 net/http 常见坑

**Client 无 Timeout**：
```go
// 错：可能无限 hang
resp, err := http.Get("http://slow.com")

// 对
client := &http.Client{Timeout: 5 * time.Second}
resp, err := client.Get(...)
```

**Body 不 Close 泄漏 fd**：
```go
resp, err := client.Do(req)
if err != nil { return }
defer resp.Body.Close()  // 必须
```

**KeepAlive 连接池**：
- Transport 默认复用连接
- MaxIdleConnsPerHost=2 默认（生产要调大）

### 13.3 netpoll 实现

- Linux：epoll (edge-triggered)
- macOS：kqueue
- Windows：iocp
- runtime 底层直接调这些接口，不通过 libc

---

## §14 · 泛型（1.18+）与实现原理

### 14.1 语法

```go
func Map[T, U any](s []T, f func(T) U) []U {
    r := make([]U, len(s))
    for i, v := range s { r[i] = f(v) }
    return r
}
```

### 14.2 类型约束

```go
type Number interface {
    int | int64 | float32 | float64
}

func Sum[T Number](s []T) T { ... }
```

### 14.3 实现原理：**GC Shape Stenciling + 字典**

- **不是 C++ 模板全实例化**（避免代码膨胀）
- **不是 Java 类型擦除**（保留类型信息）
- **折中方案**：
  - 相同 GC shape（指针 vs 非指针 vs 大小类别）的类型**共用一份代码**
  - 通过**字典参数**在运行时传递类型元数据
  - 代码膨胀有限，性能损失小

### 14.4 泛型限制

- **无方法泛型**（类型参数只能在函数、类型上）
- 类型集合不能有方法（1.18 限制，1.21+ 部分放开）
- 类型推断有限（复杂场景要显式指定 T）

---

## §15 · defer / panic / recover 深度

### 15.1 defer 演进

- **Go 1.14 前**：堆分配 30~50ns
- **Go 1.14**：**栈分配** <10ns
- **Go 1.17+**：**开放编码**（open-coded），接近零

**开放编码原理**：编译器把 defer 内联到函数末尾，只用一个位图记录哪些 defer 需要执行。

### 15.2 defer 常见陷阱

**陷阱 1 · 循环里 defer**：
```go
for _, f := range files {
    fp, _ := os.Open(f)
    defer fp.Close()  // 延迟到函数返回，资源耗尽
}
```
修法：包一层函数。

**陷阱 2 · 参数立即求值**：
```go
i := 1
defer fmt.Println(i)  // 打印 1
i = 2
// 函数返回时打印的是 1（defer 时已确定参数）
```

**陷阱 3 · defer 与 return 顺序**：
```go
func f() (n int) {
    defer func() { n++ }()
    return 1  // 实际：先 n=1，然后 defer 执行 n++，最后 return n=2
}
```

### 15.3 panic / recover

- **panic 只能被同 goroutine 的 defer 中 recover 捕获**
- **子 goroutine panic 不能被父 recover**（是 Go 设计的坑）
- **recover 只有在 defer 里直接调用才生效**

**正确姿势**：
```go
go func() {
    defer func() {
        if r := recover(); r != nil {
            log.Errorf("panic: %v\n%s", r, debug.Stack())
        }
    }()
    // 业务代码
}()
```

### 15.4 什么时候不要 recover

- **不要在 main 里 recover 掩盖问题**（除非顶层框架）
- **越界、nil deref 这种编程错误 recover 后代码状态可能已损坏**——修 bug 而非 recover

---

## §16 · interface 内幕与陷阱

### 16.1 interface 双字结构

```go
type iface struct {
    tab  *itab           // 类型 + 方法表
    data unsafe.Pointer  // 数据指针
}
type eface struct {  // interface{}
    _type *_type
    data  unsafe.Pointer
}
```

- **两个字长**（16 字节 64 位平台）
- itab 缓存全局 map 避免重复计算

### 16.2 nil interface != nil pointer（**面试血案**）

```go
var p *MyError = nil
var err error = p
if err != nil {
    // 会进入！err.tab 非 nil
}
```

**原因**：interface (type, data) 双字，type 非 nil 则整体 != nil。

**修法**：
```go
if p == nil {
    return nil  // 显式返回 nil interface
}
return p
```

### 16.3 interface 装箱代价

- 值类型转 interface{} → 分配堆 + 拷贝
- **热点路径避免**
- **泛型（Go 1.18+）解决**：静态类型无装箱

### 16.4 interface 方法调用

- 通过 itab 找方法指针 → 间接调用
- 相比直接调用慢 2~3 倍（无内联）
- CPU 分支预测器可以缓解，但极致场景仍是瓶颈

---

## §17 · error wrapping + errors.Is/As

### 17.1 Go 1.13+ 错误链

```go
err := fmt.Errorf("open failed: %w", ioErr)  // 包装
```

- `%w` 建立包装链
- `errors.Unwrap(err)` 拿被包装的 err
- `errors.Is(err, io.EOF)` 沿链找是否有 io.EOF
- `errors.As(err, &target)` 沿链找特定类型

### 17.2 错误处理最佳实践

- **底层返回具体错误**（`io.EOF`, `os.PathError`）
- **中间层用 `%w` 包装添加上下文**
- **顶层用 `errors.Is/As` 判断**
- **不要 `err.Error() == "xxx"` 字符串比较**

### 17.3 Go 2 错误处理提案（未采纳）

- `check` / `handle` 提案讨论多年
- 社区反对**语法糖**破坏简洁性
- **短期内 `if err != nil` 就是 Go 特色**

---

## §18 · pprof / trace / race detector 实战

### 18.1 pprof

**开启**：
```go
import _ "net/http/pprof"
go http.ListenAndServe(":6060", nil)
```

**收集**：
```bash
go tool pprof http://localhost:6060/debug/pprof/heap
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30  # CPU
go tool pprof http://localhost:6060/debug/pprof/goroutine
```

**交互**：
- `top` 看最耗资源
- `list funcname` 看函数级
- `web` 生成 svg 火焰图

### 18.2 trace

```go
f, _ := os.Create("trace.out")
trace.Start(f)
defer trace.Stop()
// ... 业务代码
```

`go tool trace trace.out` 打开 web UI：
- goroutine 状态时间线
- GC pauses
- syscall / netpoll
- 阻塞分析

### 18.3 race detector

- `go test -race`
- `go run -race main.go`
- 生产不开（10x 性能损失）
- CI 全量跑，canary 灰度

---

## §19 · 生产实战：TCUM 代码里的 Go 细节

### 19.1 `cgroup.AvailableCPUs()` · 云原生感知

`pendingseries.go:220`：
```go
var marshalConcurrencyCh = make(chan struct{}, cgroup.AvailableCPUs())
```
- **不用 `runtime.NumCPU()`**—— K8s pod 里返回宿主机核数（可能 96）
- `cgroup.AvailableCPUs()` 从 `/sys/fs/cgroup/cpu/cpu.cfs_quota_us` 计算真实核数
- **Go 1.22+**：GOMAXPROCS 自动感知 cgroup

### 19.2 `fasttime` · 避免 syscall 开销

`pendingseries.go:86`：
```go
if fasttime.UnixTimestamp()-ps.wr.lastFlushTime.Load() < uint64(flushSeconds) {
    continue
}
```
- `time.Now()` 涉及 syscall（vDSO 优化后 ~10ns）
- fasttime：后台 goroutine 每秒更新全局原子变量，读取 ~1ns
- 代价：秒级精度

### 19.3 `google/wire` 依赖注入

`alerts/tasks/alert.go:12`：
```go
var TaskSet = wire.NewSet(NewTask)
```
- **编译期生成代码**（vs Spring 运行时反射）
- 无反射开销、可读、编译错误 vs 运行时错误

### 19.4 goroutine 池

`tcum-cmdb-global/common/gopool`：
- 每 goroutine 仍有 2KB 栈 + runtime 记账
- 百万级场景需池化换稳定性

### 19.5 confluent-kafka-go 的 cgo 特性

`unified_incr_sync_consumer.go:14`：
```go
"github.com/confluentinc/confluent-kafka-go/kafka"
```
- **底层 librdkafka（C 库），cgo 调用**
- vs sarama（纯 Go）
- **cgo 代价**：每次 ~100ns，不参与 goroutine 调度，编译需 gcc

**选 confluent-kafka-go 理由**：生产验证充分、支持事务/幂等、性能好。**代价**是 cgo 复杂度。

### 19.6 GOMEMLIMIT 生产实践

**K8s pod 内存 limit 4Gi，容器化 Go 服务标配**：
```bash
GOMEMLIMIT=3.5GiB
GOGC=100
```
- GOGC 触发常规 GC
- GOMEMLIMIT 快到时更激进 GC 避免 OOM

---

## §20 · 60 问对比

### 【基础与并发】

**Q1. 协程 vs 线程 vs 纤程 vs Actor？**
> 协程用户态调度、线程内核调度、纤程用户态但无标准库、Actor 消息驱动（Erlang/Akka）。goroutine 是最完善的协程实现。

**Q2. goroutine 栈起始多大？最大多少？**
> 2KB 起，1GB 最大。Go 1.3+ 连续栈（分配 2 倍新栈 + 复制内容 + 精确调整指针）。

**Q3. GMP 三个字母含义？**
> G goroutine、M machine（OS 线程）、P processor（逻辑处理器 = GOMAXPROCS）。G 必须绑 P 才能被 M 执行。

**Q4. GOMAXPROCS 默认多少？K8s 有什么陷阱？**
> 默认宿主机 CPU 核数。K8s 里 pod limit 4 core 但看到宿主机 96 → 起 96 goroutine → CPU throttle。Go 1.22+ 自动感知 cgroup，之前用 automaxprocs。

**Q5. work-stealing 是什么？为什么偷后一半？**
> M 找 g 顺序：本地 runq → 全局 → netpoll → 随机偷其他 P 的**后一半**。前一半缓存热度高，后一半迁移代价低。

**Q6. Go 1.14 之前长循环卡死怎么办？**
> `for {}` 无函数调用 → 无栈检查 → 无抢占点。1.14+ sysmon 发 SIGURG 信号强制抢占。

**Q7. `go f()` 会立即执行 f 吗？**
> **不会**。newproc 只是把 g 入队，继续跑当前 goroutine。调度器决定何时执行 f。

**Q8. goroutine 什么时候结束？**
> 只有 return 或 panic。不会被 GC。channel 阻塞 + 无发送 = 永久泄漏。

**Q9. goroutine 泄漏怎么排查？**
> `runtime.NumGoroutine()` 观察增长 + `/debug/pprof/goroutine?debug=2` 打全 stack trace 找阻塞点。

**Q10. syscall 时 P 会被占用吗？**
> Go 1.14+ P 从 M 解绑（handoffp），P 立即被其他空闲 M 拿去跑别的 g。这是 Go 相对 Java NIO / Rust async 最大差异化。

### 【channel】

**Q11. channel 有缓冲和无缓冲区别？**
> 无缓冲：send/recv 必须配对（handoff）；有缓冲：满/空时才阻塞。

**Q12. close 已 close 的 channel 会怎样？**
> panic。close nil 也 panic。close 后再 send 也 panic。**只有 recv closed 不 panic**（返回零值 + ok=false）。

**Q13. select 多个 case 就绪怎么选？**
> `fastrand()` 随机选一个。防止饥饿。

**Q14. for-select-default 陷阱？**
> 空转 100% CPU。修法：加 time.Sleep 或去掉 default。

**Q15. channel 用来做什么？**
> ① goroutine 通信 ② 同步（barrier）③ 广播（close 通知所有 recv）④ 信号量（缓冲大小限流）⑤ 超时（select time.After）。

### 【sync】

**Q16. Mutex 正常模式和饥饿模式？**
> 正常：CAS 抢锁性能好；饥饿（等锁 >1ms）：新来的直接入队，队首优先，公平但慢 30%。

**Q17. RWMutex 什么时候比 Mutex 慢？**
> 短临界区（<100ns）内部原子操作和读者计数开销大，慢 2~3 倍。**读多写少 + 临界区较长才划算**。

**Q18. WaitGroup 三大坑？**
> ① Add 必须在 goroutine 外 ② 不能复用 ③ 必须传指针（值传递内部状态副本）。

**Q19. sync.Once 是双检锁吗？**
> 是。快路径 atomic 无锁读 done；慢路径加锁二次检查。

**Q20. sync.Pool 什么时候不适合？**
> 需要稳定缓存的场景（Pool 每次 GC 清空）。**适合临时 buffer 复用减少 alloc**。

**Q21. sync.Map 什么时候比 map + Mutex 好？**
> 官方源码明示：① 一个 key 只写一次读多次 ② 多 goroutine 读写不同 key。**其他场景 map + Mutex 更好**。

**Q22. atomic 和 Mutex 什么区别？**
> atomic 无锁 CAS 快 10x+，但只能操作单一变量。Mutex 保护多个变量/复杂操作。

### 【内存与 GC】

**Q23. Go 的分配器基于什么？**
> tcmalloc（Thread-Caching Malloc）。mcache（每 P 无锁）→ mcentral（全局锁）→ mheap → OS mmap。

**Q24. sizeClasses 有多少？**
> 67 个（Go 1.21）。8B、16B、... 32KB。超过 32KB 走 large object 直接 mheap。

**Q25. 三色标记法？**
> 白（垃圾）/ 灰（已扫描但引用未扫描）/ 黑（完全处理）。root 变灰 → 出发扫引用变灰 → 自己变黑。

**Q26. 为什么需要写屏障？**
> 并发标记时，用户程序可能改指针。破坏三色不变性会漏标。写屏障保护每次指针写。

**Q27. 混合写屏障是什么？**
> Go 1.8+：删除屏障（slot 原对象变灰）+ 插入屏障（ptr 变灰）。栈默认黑不加屏障。

**Q28. GOGC 是什么？**
> 触发 GC 的堆倍数。默认 100（堆到上次 live × 2 触发 GC）。业务可调 50~200 平衡吞吐和 STW。

**Q29. GOMEMLIMIT 是什么？**
> Go 1.19+ 软内存上限。接近 limit 时更激进 GC。K8s pod 场景避免 OOM Killed 关键。

**Q30. GC STW 多长？**
> Go 1.14+ < 100μs。Go 1.5+ 三色标记让 STW 从 100ms 降到 10ms，混合写屏障（1.8）到 100μs。

**Q31. 排查 Go GC 问题？**
> ① GODEBUG=gctrace=1 看 GC 耗时和堆 ② pprof heap/allocs 定位热点 ③ trace 看 pauses ④ sync.Pool / 减少逃逸 / GOGC 调整 / GOMEMLIMIT。

### 【逃逸】

**Q32. 什么场景会逃逸？**
> ① 返回局部变量指针 ② 闭包捕获 ③ interface 装箱 ④ 大对象 ⑤ 动态类型 slice/map ⑥ channel 传送指针。

**Q33. 为什么 fmt.Println(n) 会让 n 逃逸？**
> Println 参数是 ...interface{}，n 装箱成 interface → 逃逸。

**Q34. 怎么查看逃逸？**
> `go build -gcflags="-m -m"`。

**Q35. VM 库怎么零拷贝减少逃逸？**
> `bytesutil.ToUnsafeString` 用 unsafe.Pointer 强转 []byte 头为 string 头，不拷贝底层内存。前提是 buf 生命周期足够。

### 【context】

**Q36. context 四大能力？**
> 取消、超时、值传递、请求作用域。

**Q37. context 传播是怎么实现的？**
> 树状：父 cancel → close(done) → 遍历 children 递归 cancel。Done() 返回的 channel 是"只 close 不 send"。

**Q38. context.TODO 和 Background 区别？**
> Background 是明确顶层 root；TODO 是不确定用哪个的占位。新代码用 Background。

**Q39. context 传业务参数是反模式？为什么？**
> 类型不安全（interface{} 转换）+ 隐式依赖（谁改了不清楚）+ 生命周期混乱。业务参数走显式参数。

**Q40. 忘记 defer cancel() 什么后果？**
> WithTimeout / WithDeadline 内部 goroutine 泄漏，直到超时才回收。生产建议每个 With* 后立即 defer cancel()。

### 【interface & 反射】

**Q41. interface 双字结构？**
> (type, data) 双字。type 非 nil 则整体 != nil。**nil interface != nil pointer** 是经典陷阱。

**Q42. interface{} 装箱代价？**
> 值类型转 interface{} → 堆分配 + 拷贝。热点路径避免。泛型（1.18+）解决。

**Q43. 反射性能多差？**
> reflect.Value.Call 50~100x，Field.Set 20~50x。**热点路径禁用**。

**Q44. 反射三大定律？**
> ① interface → Value/Type（ValueOf/TypeOf）② Value → interface{}（Interface()）③ 修改 Value 必须 CanSet（可寻址）。

**Q45. unsafe.Pointer 四大规则？**
> ① *T1 ↔ *T2 内存布局兼容 ② uintptr 不能长期持有（GC 移动失效）③ 同表达式内地址计算 ④ reflect.Value.UnsafePointer。

### 【泛型】

**Q46. Go 泛型实现方式？**
> GC Shape Stenciling + 字典。同 shape 共用代码，字典传运行时类型。折中 C++ 模板（代码膨胀）和 Java 类型擦除（性能损失）。

**Q47. 泛型限制？**
> ① 无方法泛型（类型参数只在函数、类型）② 类型集合不能有方法（1.18）③ 类型推断有限。

**Q48. 泛型 vs interface？**
> 泛型：编译期确定类型，无装箱，性能好；interface：动态类型，运行时开销。**热点路径优先泛型**。

### 【错误处理与 defer】

**Q49. defer 演进？**
> 1.14 前堆分配 30~50ns；1.14 栈分配 <10ns；1.17+ 开放编码接近零。

**Q50. defer 参数何时求值？**
> **defer 语句执行时立即求值**。`i:=1; defer f(i); i=2` → f 参数是 1 不是 2。闭包除外（引用捕获）。

**Q51. panic 能被子 goroutine 的 recover 捕获吗？**
> **不能**。panic 只能被同 goroutine 的 defer 中 recover。子 g panic 必须自己 recover 否则整个进程崩。

**Q52. errors.Is 和 errors.As 区别？**
> Is：沿包装链找等价 err（`errors.Is(err, io.EOF)`）；As：找特定类型（`var pe *os.PathError; errors.As(err, &pe)`）。

### 【网络与运行时】

**Q53. netpoll 是什么？**
> runtime 底层直接调 epoll/kqueue/iocp，goroutine per connection 编程模型 + 底层非阻塞 IO。

**Q54. net/http Client 常见坑？**
> ① 无 Timeout hang ② Body 不 Close 泄漏 fd ③ MaxIdleConnsPerHost 默认 2 生产要调大。

**Q55. sysmon 是什么？**
> 独立 M 不绑 P，10ms/20us 循环：抢占长跑 g、检查 netpoll 就绪、触发定时 GC、监控 syscall 超时。

### 【生产实战】

**Q56. TCUM 里 cgroup.AvailableCPUs 是干什么的？**
> K8s pod 内 runtime.NumCPU 返回宿主机核数是陷阱。cgroup.AvailableCPUs 读 /sys/fs/cgroup/cpu 算真实核数。Go 1.22+ 自动感知。

**Q57. fasttime 是什么？为什么用？**
> 后台 goroutine 每秒更新原子变量，读取 ~1ns（time.Now vDSO 优化后 ~10ns）。高频路径用 fasttime 省 syscall。

**Q58. sync.Pool 在 VM 里怎么用？**
> pendingseries.go 用 ByteBufferPool 复用 write buffer。每 GC 清空但 victim cache 保留一轮。减少大 buffer 频繁 alloc。

**Q59. wire 依赖注入 vs Spring？**
> wire：**编译期生成代码**，无反射，编译错误 vs 运行时错误。Spring：运行时反射，动态但慢。

**Q60. Go 生产必配 GOMEMLIMIT 吗？**
> K8s 容器化必配。pod limit 4Gi，设 GOMEMLIMIT=3.5GiB 避免 GC 不及时 OOM Killed。GOGC 常规触发 + GOMEMLIMIT 兜底。

---

## §21 · 短板与坑

1. **GC 不适合极致性能**：XStor 火焰图 35% CPU GC → 替代 Rust
2. **泛型不完善**：无方法泛型、类型集合无方法
3. **无枚举无 sum type**：只能 const + iota 模拟
4. **错误处理啰嗦**：`if err != nil` 泛滥
5. **module 早期坑多**：vendor / GOPATH / GOPROXY 历史包袱
6. **无面向对象继承**：只有组合（虽然是优点也是缺点）
7. **defer 在热点路径开销**：1.14+ 明显改善但仍有
8. **goroutine 泄漏排查难**：pprof/goroutine 需要主动开启
9. **channel 用不好比锁还坑**：close 后 send panic、双 close panic
10. **反射性能差**：热点路径禁用

---

## §22 · 面试话术模板

### 3 分钟自述

> "我在 TCUM 全栈用 Go 两年——metric-filter、alerts、cmdb-global（我主导）。这些都是高并发场景。
>
> **对 Go 最深五点理解**：
> - **GMP 调度是设计精华**：P 稀缺（GOMAXPROCS），G 廉价。work-stealing 负载均衡；syscall 时 P 从 M 解绑让其他 M 继续跑——这是相对 Java NIO / Rust async 最大的差异化。
> - **GC 演进极致但仍是瓶颈**：混合写屏障（1.8+）STW <100μs。但极致场景 GC 仍瓶颈——XStor 火焰图 35% CPU 是 GC。VM 用 unsafe.ToUnsafeString + sync.Pool 减压。
> - **云原生适配是运维核心**：K8s 里 NumCPU 返回宿主机核数是陷阱。Go 1.22 前用 cgroup.AvailableCPUs()；1.22 起 runtime 自感知。GOMEMLIMIT 是 K8s 容器化标配。
> - **channel 是杀器也是刺客**：goroutine 通信 + 同步 + 广播 + 信号量都能做，但 close 后 send panic、双 close panic、for-select-default 空转等陷阱一个都不能漏。
> - **接口双字模型**：nil interface != nil pointer 是经典血案。interface{} 装箱是性能刺客——泛型（1.18+）解决大部分场景。
>
> **短板坦白**：GC 不适合极致性能、无枚举、错误处理啰嗦——这些是 Go 相对 Rust/Java 的取舍代价。"

### 反问 5 问

1. 生产 Go 版本？1.22 升了吗？GOMEMLIMIT 用了吗？
2. GC 敏感场景怎么处理？sync.Pool？unsafe？切 Rust？
3. Kafka 客户端用 sarama 还是 confluent-kafka-go？cgo 开销怎么处理？
4. goroutine 池用什么库？
5. race detector 在 CI 覆盖程度？

---

**本篇完 · 约 32KB · 全面加深 · 覆盖调度/内存/GC/channel/sync/context/反射/网络/泛型/60 问**

**证据基线**：
- Go 官方文档：https://go.dev/doc/
- Go source code：runtime/proc.go / runtime/mgc.go / runtime/chan.go / sync/*
- pendingseries.go:220 cgroup.AvailableCPUs()
- pendingseries.go:86 fasttime
- pendingseries.go:220 ByteBufferPool
- pendingseries.go:196-215 ToUnsafeString 零拷贝
- unified_incr_sync_consumer.go confluent-kafka-go + context.TODO
- iwiki 4016226228 XStor GC 35% + cgo 30%
- alerts wire 依赖注入
