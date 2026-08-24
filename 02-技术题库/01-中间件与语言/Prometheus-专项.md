# 第五卷 · 中间件 · Prometheus 与 Alertmanager 专项

> **本篇定位**：Prometheus 是 TCUM/云原生监控事实标准 —— **拉模式采集 + 时序数据库 + PromQL + Alertmanager 告警链路** 一体。TCUM 生产上 Prometheus 承担采集协议标准 + 单集群/小规模场景本地存储；大规模场景 VictoriaMetrics 或 Thanos 兼容 Prometheus 协议做长期/横向扩展。本文覆盖架构、TSDB、Pull vs Push、Service Discovery、Federation、Remote Write、Recording Rule、Alerting Rule、Alertmanager 路由/分组/抑制/静默、生产实战、50+ 高频面试题。

## 📖 目录
- §1 命题：为什么 Prometheus 是云原生监控事实标准
- §2 架构：Prometheus Server / Exporter / Pushgateway / Alertmanager
- §3 拉模式 vs 推模式
- §4 数据模型：metric / labels / sample / series
- §5 TSDB 存储：Block / Chunk / WAL / Head
- §6 Service Discovery
- §7 PromQL 深度
- §8 Recording Rule
- §9 Alerting Rule
- §10 Alertmanager：路由 / 分组 / 抑制 / 静默 / 集群
- §11 Remote Write / Remote Read
- §12 Federation
- §13 高可用与长期存储
- §14 生产实战：TCUM 中的 Prometheus / VM 融合
- §15 版本演进
- §16 50 问详解
- §17 短板与坑
- §18 面试话术

---

## §1 · 命题：为什么 Prometheus 是云原生监控事实标准

### 一句话背诵

> "Prometheus 用**多维度 label 数据模型 + Pull 采集 + PromQL 查询 + 单机 TSDB + 独立 Alertmanager** 定义了云原生监控标准。它不是最强的时序库（写入 VM 快 20x），但是**协议 + 生态标准**——K8s、几乎所有云原生组件都提供 `/metrics` 端点。"

### 六大设计原则

1. **Pull 模式**：Server 主动去 target 拉指标（相对 Push）
2. **多维度 label 模型**：`metric{k=v,k=v}` 而非扁平命名（相对 Graphite）
3. **本地时序存储**：单机 TSDB，无外部依赖（相对 InfluxDB 早期）
4. **PromQL**：函数式查询语言
5. **单机架构简单**：单二进制，无 master/worker
6. **告警独立**：Alertmanager 单独部署处理告警路由

### 边界代价（重要）

- **单机存储上限**：TB 级，横向不能扩（需要 VM / Thanos / Cortex）
- **不适合日志/事件**：只存数值时序
- **数据可靠性弱**：本地磁盘挂 = 数据丢
- **无鉴权**：靠反向代理 + 网络隔离
- **Push 场景弱**：Pushgateway 是补丁不是主体
- **长期存储弱**：默认 15 天，需要 remote_write 到 VM/Thanos

---

## §2 · 架构

### 组件

```
[Targets: node_exporter/blackbox_exporter/自定义 exporter]
         ↑ pull /metrics
[Prometheus Server]  ─── remote_write ──→ [VictoriaMetrics/Thanos]
   │            │
   │            └── evaluate rules → firing alerts
   ↓                                         │
[Local TSDB (blocks + WAL)]                  ↓
                                    [Alertmanager]
                                        │
                                        └→ [Notification: 微信 / 邮件 / 电话]
```

### 组件职责

- **Prometheus Server**：抓取指标 + TSDB 存储 + 执行 PromQL + 评估 Recording/Alerting Rule
- **Exporter**：暴露 `/metrics`（node_exporter 采主机，blackbox 采探活，业务自埋点用 client_library）
- **Pushgateway**：短生命作业（批处理）推指标临时存放，Prometheus 拉走
- **Alertmanager**：接收 alerts → 分组 / 抑制 / 静默 / 路由 → 通知
- **Service Discovery**：K8s / Consul / EC2 / File 等自动发现 target

---

## §3 · 拉模式 vs 推模式

### Pull 优势

1. **Server 主动控制频率**：避免 target push 打爆 Server
2. **健康检测天然**：pull 失败即知 target down（可作探活指标）
3. **配置集中**：Prometheus 配置管理所有 target
4. **对开发友好**：只需暴露 HTTP 端点，无需 Server 地址

### Push 优势（Pushgateway 场景）

- **短生命作业**：批处理任务，Prometheus 还没来拉就结束
- **网络受限**：target 在防火墙后，Server 拉不到

### Push 的坑

- Pushgateway 不能持久化 —— 重启数据丢
- 已推入的指标除非手动删除，永久保留（陷阱：作业名换了导致旧数据一直在）
- **官方建议只用于短生命作业**，不要拿它当 Prometheus 用

---

## §4 · 数据模型

### 4.1 基本概念

- **metric name**：`http_requests_total`
- **labels**：`{method="GET", handler="/api", status="200"}`
- **timestamp**：ms 精度
- **value**：float64
- **series（时间序列）**：`metric{labels}` 唯一标识，一条 series 是一堆 (ts, value)

### 4.2 四种指标类型

- **Counter**（计数器）：只增（reset 到 0 表示重启）—— `http_requests_total`
- **Gauge**（仪表盘）：可增可减 —— `memory_usage_bytes`
- **Histogram**（直方图）：预定义 bucket 区间计数 + sum + count —— `http_request_duration_seconds_bucket`
- **Summary**（摘要）：客户端计算的分位数 —— `latency_summary`

### 4.3 Histogram vs Summary

| 维度 | Histogram | Summary |
|---|---|---|
| 分位数计算 | 服务端 `histogram_quantile()` 估算 | 客户端预计算 |
| 精度 | 依赖 bucket 划分 | 精确 |
| 聚合 | ✅ 可跨实例聚合 | ❌ 无法聚合分位数 |
| 客户端开销 | 低 | 高（stream 分位数算法） |

**规则**：**做分位数选 Histogram**（因为要跨实例聚合），除非本地报告用 Summary。

### 4.4 series 基数（Cardinality）

- **series 数 = metric × label 值组合数**
- **高基数是灾难**：`user_id` / `trace_id` 作 label → 千万级 series → 内存爆炸
- **经验**：单实例 series < 500 万，label 组合 < 100

### 4.5 命名规范

- metric_name 用 snake_case：`http_requests_total`
- 单位后缀：`_total`（Counter）、`_seconds`、`_bytes`
- 前缀区分子系统：`process_` / `go_` / `http_`

---

## §5 · TSDB 存储

### 5.1 存储层次

```
data/
├── wal/                      # Write-Ahead Log（防崩溃丢失）
│   └── 000000
├── chunks_head/              # 内存 Head Block 落盘的 mmap 块
├── 01H..../                  # Block（2 小时一个块）
│   ├── chunks/               # 时间序列数据
│   ├── index                 # 倒排索引（label → series ID）
│   ├── meta.json             # 元数据
│   └── tombstones            # 删除标记
└── 01H..../                  # 更多 Block
```

### 5.2 Head Block（活跃块）

- 最近 2~3 小时数据**内存中**
- WAL 记录所有写入，崩溃恢复用
- **Head Compaction**：满 2h 转成磁盘 Block

### 5.3 Chunk 压缩

- **XOR 编码（Facebook Gorilla 论文）**：浮点数用异或增量存储，压缩率 12x+
- 一个 chunk 120 sample（默认），压缩后几十字节
- 单点数据平均**几个字节**，非常紧凑

### 5.4 索引（每个 Block 独立）

- **倒排索引**：label 键值 → series ID 列表
- **series 信息**：series ID → (labels + chunk 位置)

**查询流程**：
1. PromQL 解析 → label matchers
2. Block 倒排索引找 matchers 命中的 series 集合
3. 按时间范围读对应 chunk
4. 解压 XOR → 返回样本

### 5.5 Compaction（压实）

- 相邻 Block 合并成大 Block（2h → 6h → 24h → 更长）
- 减少 Block 数量提升查询效率
- 老 Block 保留时间由 `--storage.tsdb.retention.time` 决定（默认 15 天）

### 5.6 磁盘占用估算

- 一个样本约 1~2 字节（压缩后）
- 10w series × 每 15s 一样本 × 天 = 10w × 5760 × 2 ≈ **1GB/天**

---

## §6 · Service Discovery

### 6.1 常用 SD

- **static_config**：手动列表
- **file_sd**：文件（外部工具生成）
- **kubernetes_sd**：K8s API 发现 pod / service / endpoint / node / ingress
- **consul_sd** / **etcd_sd** / **eureka_sd**
- **ec2_sd** / **gce_sd** / **azure_sd**
- **dns_sd**：DNS SRV

### 6.2 K8s SD 典型配置

```yaml
- job_name: 'kubernetes-pods'
  kubernetes_sd_configs:
    - role: pod
  relabel_configs:
    - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
      action: keep
      regex: true
    - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_port]
      action: replace
      target_label: __address__
```

**relabel_configs 是灵魂**：过滤、改标签、构造抓取地址。

### 6.3 relabel 五大 action

- **keep**：保留匹配的
- **drop**：丢弃匹配的
- **replace**：字段替换
- **labelmap**：批量映射
- **hashmod**：按 hash 分片（负载均衡多个 Prometheus）

---

## §7 · PromQL 深度

### 7.1 四种类型

- **Instant Vector**：某时刻多个 series 的一组瞬时值（默认查询）
- **Range Vector**：一段时间内多个 series 的样本集合（`[5m]`）
- **Scalar**：标量
- **String**：字符串（少用）

### 7.2 基础语法

```promql
# 瞬时值
node_cpu_seconds_total

# 过滤
node_cpu_seconds_total{mode="idle", instance="host1"}

# 范围
node_cpu_seconds_total[5m]

# 时间偏移
node_cpu_seconds_total offset 1h

# 时间戳
node_cpu_seconds_total @ 1720000000
```

### 7.3 常用函数

- **rate(v[t])**：范围向量 counter 的**每秒平均增长率**
- **irate(v[t])**：**瞬时变化率**（取最后两个点）
- **increase(v[t])**：范围内增量
- **delta / idelta**：Gauge 的差值
- **histogram_quantile(0.99, sum(rate(...bucket[5m])) by (le))**：分位数估算
- **avg_over_time / max_over_time**：范围聚合
- **predict_linear(v[t], s)**：线性外推

### 7.4 聚合运算符

- `sum / avg / min / max / count / stddev`
- `by (label1, label2)`：按 label 分组
- `without (label1)`：排除 label 分组
- `topk / bottomk / quantile`

### 7.5 向量匹配

- **1 vs 1（默认）**：labels 完全一致才匹配
- **on(...) / ignoring(...)**：指定 join 的 label
- **group_left / group_right**：一对多 join

**经典陷阱**：
```promql
# 两 metric labels 不完全一致，直接除会为空
memory_used_bytes / memory_total_bytes

# 正确：on 或 ignoring
memory_used_bytes / on(instance) memory_total_bytes
```

### 7.6 rate 陷阱

- **rate 只能用于 Counter**，不能对 Gauge 用（结果没意义）
- **rate([5m])** 的时间窗必须 ≥ 3~4 倍 scrape_interval，太短易受抖动影响
- **rate 之前不能 sum**：`rate(sum(...))` 错误 —— sum 后重启信息丢失，rate 会得到负值。**必须 sum(rate(...))**
- **Counter reset 检测**：rate 自动处理 counter 归零

### 7.7 histogram_quantile 陷阱

```promql
histogram_quantile(0.99, sum(rate(http_duration_bucket[5m])) by (le))
```
- **必须 rate 后 sum 前保留 `le` label**
- 桶划分不精细则误差大：99 分位数在 [1s, 5s] 桶内会**线性插值**（可能实际是 5s 但报 3s）

---

## §8 · Recording Rule

### 目的

- **预计算高频复杂查询** → 减少查询时的 CPU
- Grafana Dashboard 上高频用的 PromQL 提取

### 语法

```yaml
groups:
  - name: cpu.rules
    interval: 30s
    rules:
      - record: job:node_cpu:usage_rate5m
        expr: |
          1 - avg by(job, instance)(rate(node_cpu_seconds_total{mode="idle"}[5m]))
```

**规则**：命名遵循 `level:metric:operation` 惯例。

**注意**：Recording Rule 也占存储（生成新 series），别 record 太多。

---

## §9 · Alerting Rule

### 语法

```yaml
groups:
  - name: cpu.alerts
    interval: 30s
    rules:
      - alert: HighCPU
        expr: job:node_cpu:usage_rate5m > 0.8
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Instance {{$labels.instance}} CPU high"
          description: "CPU is {{ humanizePercentage $value }}"
```

### 关键字段

- **expr**：PromQL 结果非空即触发
- **for**：持续时间（避免瞬时抖动）
- **labels**：标签，Alertmanager 路由用
- **annotations**：文本模板（渲染到通知）

### 告警状态机

- **inactive**：expr 未匹配
- **pending**：匹配但 `for` 未到
- **firing**：`for` 到了，推给 Alertmanager

**Prometheus 每次 evaluation 都会推所有 firing alerts** 给 Alertmanager，AM 靠**指纹去重**。

---

## §10 · Alertmanager

### 10.1 核心能力

- **分组（Grouping）**：相同类的告警合并成一封
- **抑制（Inhibition）**：一个大告警发生时，抑制关联小告警
- **静默（Silence）**：临时屏蔽（维护窗口）
- **路由（Routing）**：按 label 分发到不同接收人
- **通知集成**：邮件 / 微信 / 电话 / Slack / PagerDuty / webhook

### 10.2 路由树

```yaml
route:
  receiver: 'default'
  group_by: ['alertname', 'cluster']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    - match:
        severity: critical
      receiver: 'phone'
    - match_re:
        service: '^(db|cache)$'
      receiver: 'infra-team'
```

**核心字段**：
- **group_by**：按哪些 label 分组
- **group_wait**：**首批告警等多久收集同组的其他告警**（一起发）
- **group_interval**：分组后续告警的最小间隔
- **repeat_interval**：**同一分组重发间隔**（防止告警轰炸）

### 10.3 分组示例

- **group_by: [alertname, cluster]** → 100 台机同时 HighCPU 只发一封（合并所有 instance）
- 关键设计：避免告警海啸

### 10.4 抑制规则

```yaml
inhibit_rules:
  - source_matchers:
      - severity="critical"
      - alertname="NodeDown"
    target_matchers:
      - severity="warning"
    equal: ['instance']
```

**含义**：节点 down 时，同 instance 的 warning 告警被抑制（避免噪声）。

### 10.5 静默

- Web UI 或 API 创建
- 按 label matcher 匹配
- 常用于**发布/维护窗口**

### 10.6 Alertmanager 集群

- **多副本 + gossip 协议**
- **不需要外部协调**（无 ZK/etcd 依赖）
- **去重**：告警指纹 + gossip 同步"已发送"状态
- **静默**同步到所有节点
- 生产建议 **3 节点集群**避免单点

### 10.7 消息去重

- Prometheus 高可用部署时**多个 Prometheus 实例都发相同告警**给 AM 集群
- **AM 靠告警指纹（labels hash）去重** → 客户端只收一份

---

## §11 · Remote Write / Remote Read

### Remote Write

- Prometheus 把每次采集的样本**实时写到远程存储**（VM / Thanos / M3 / Cortex）
- **本地存储仍有**（可保留短期）
- 协议：**Snappy 压缩的 Protobuf**（HTTP POST）
- 生产标配：Prometheus 采集 + remote_write to VM + VM 做长期查询

### Remote Read

- PromQL 查询时从远程读数据
- **少用**（性能差、协议兼容问题）
- 推荐**直接查远程存储**（VM 的 vmselect）

---

## §12 · Federation

### 概念

- 一个 Prometheus 从另一个 Prometheus 拉聚合后的指标
- **只拉聚合指标，不拉明细**
- 用于**跨集群/跨机房数据汇聚**

### 局限

- 不适合大规模（还是拉，会有 30s scrape 延迟）
- **推荐用 remote_write 到中央 VM/Thanos** 代替 Federation

---

## §13 · 高可用与长期存储（集群模式全景）

### 13.1 Prometheus 本质上是单机

**关键认知**：**Prometheus 本身是单机时序库，不是分布式系统**。这是它设计哲学的选择——简单可靠优于分布式复杂度。

**没有的**：
- 没有原生集群模式
- 没有内建选主
- 没有内建数据分片
- 没有内建自动故障切换

**有的**：
- HA 部署（双跑）
- Remote Write 到分布式存储（VM/Thanos/Mimir）
- Alertmanager 自己有集群

### 13.2 HA 部署（双跑模式）

**架构**：
```
        ┌─────────────────┐
        │  Target Pods    │
        │ (K8s / VM / 主机)│
        └────────┬────────┘
                 │
       同时被两个 Prom 拉取
                 │
        ┌────────┴────────┐
        ▼                 ▼
   ┌─────────┐       ┌─────────┐
   │ Prom-A  │       │ Prom-B  │  ← 相同配置，独立运行
   │ 本地TSDB │       │ 本地TSDB │  ← 数据独立各自完整
   └────┬────┘       └────┬────┘
        │                 │
        └────────┬────────┘
                 │
         ┌───────▼────────┐
         │  Alertmanager  │  ← 集群化，通过指纹去重两 Prom 的告警
         │   Cluster      │
         └────────────────┘
```

**核心机制**：
- **不是主从，是双活**：两个 Prom 都在采集、都在存储、都在评估规则
- **没有数据同步**：各自独立，彼此不感知
- **数据一致性靠幂等采集**：同 target 同时间点采集结果一致（假设 target 状态没变）
- **告警去重靠 Alertmanager**：AM 对 label 指纹去重，同告警只发一次

**HA 部署的取舍**：
- 优点：极简，无外部依赖，任一 Prom 挂了另一个继续工作
- 缺点：
  - 双倍存储成本
  - 查询时**数据可能有毛刺不一致**（各自采样时间不完全同步，rate 计算可能微差）
  - 需要客户端选一个 Prom 查（LB 无法完美合并两 Prom 数据）

### 13.3 Alertmanager 集群

**AM 是 Prometheus 生态里唯一有集群的组件**。

**架构**：
```
   ┌─────────┐     ┌─────────┐     ┌─────────┐
   │  AM-1   │◄───►│  AM-2   │◄───►│  AM-3   │
   └─────────┘gossip └───────┘ gossip └───────┘
       ▲            ▲              ▲
       │            │              │
       └────每 Prom 都发给所有 AM──────┘
       
       ↓ 去重后
   通知：企业微信 / 邮件 / 电话
```

**核心机制**：
1. **每个 Prom 把 firing alert 发给所有 AM**（多路径避免丢）
2. **AM 之间用 gossip 协议同步**已发送状态和 silence
3. **去重**：AM 收到相同指纹（labels hash）的 alert 视为同一个
4. **通知分片**：一个 AM 负责一个 alert group 的通知发送，其他 AM 只做备份

**为什么 AM 不用 Raft？**：
- 告警场景对**可用性 > 强一致**
- 网络分区时希望**每个分区都能发通知**（宁可重复也不能漏）
- gossip 最终一致就够了

**部署建议**：3~5 节点集群，跨 AZ 部署。

### 13.4 长期存储方案对比

| 方案 | 架构 | 集群模型 | 特点 |
|---|---|---|---|
| **Thanos** | Prom sidecar 上传 Block 到 S3；Query 统一入口 | Query 无状态可扩，Store Gateway 无状态，S3 提供持久化 | 依赖 S3；查询慢 |
| **Cortex / Mimir** | 中心化架构，多租户 | Ingester + Distributor + Querier + Store + Compactor 分离；分布式一致性哈希 | 组件多运维复杂；多租户强 |
| **VictoriaMetrics** | vminsert + vmstorage + vmselect | vminsert/select 无状态，vmstorage 一致性哈希分片 + 副本 | 无外部依赖；性能好；生产推荐 |
| **M3DB** | Uber 出品 | 类似 Cassandra 一致性哈希 + 多副本 | 重量级，中小规模用不上 |

**TCUM 生产**：VictoriaMetrics 作为长期存储主力（详见 [VictoriaMetrics-专项.md](./VictoriaMetrics-专项.md)）。

### 13.5 完整生产架构（HA + 长期存储 + AM 集群）

```
        [K8s Pods / Targets]
                 │
        ┌────────┼────────┐
        ▼                 ▼
   ┌─────────┐       ┌─────────┐
   │ Prom-A  │       │ Prom-B  │
   │(边缘采集)│       │(边缘采集)│
   └────┬────┘       └────┬────┘
        │                 │
        └───remote_write──┤
                          ▼
             ┌────────────────────┐
             │  VictoriaMetrics   │
             │   Cluster          │
             │  (vmi + vms + vmq) │
             └──────────┬─────────┘
                        │
                        ▼
                   [Grafana / vmalert]
        
        Prom-A/B 都推 firing alerts →
        ┌────────────────────────────┐
        │  Alertmanager Cluster (3)  │
        │  gossip 去重                 │
        └───────────┬────────────────┘
                    │
                    ▼
             [微信/邮件/电话]
```

### 13.6 数据不丢 & 恢复

**Prometheus 本地数据**：
- WAL 保证已写入 buffer 但未 flush 的数据崩溃可恢复
- **本地磁盘挂 = 该 Prom 数据丢**（另一 Prom 有）
- **HA 双跑是唯一手段**（无副本机制）

**Remote Write 兜底**：
- Prom 本地是短期存储（几天）
- 长期数据在 VM/Thanos，那边有自己的副本机制
- Prom 磁盘挂了不影响长期数据

**恢复流程**：
- 单 Prom 挂：另一 Prom 继续工作 → 修复重启 → **不需要数据恢复**（历史已在 VM）
- 全部 Prom 挂：告警链路中断，采集断，靠 VM 里的历史 backfill 查看趋势
- Alertmanager 集群挂多数派：通知能力降级但不完全丢失

### 13.7 vmagent + Prometheus 演进

**新架构趋势（推荐）**：用 **vmagent** 代替 Prometheus 做采集。

**vmagent 优势**：
- 更轻（几十 MB 内存 vs Prom 几 GB）
- 无本地 TSDB（不需要磁盘）
- 内建 remote_write 缓冲（磁盘 WAL 防丢）
- 支持 Prom scrape_configs 配置

**演进路径**：
```
第一代：Prom 采 + 本地存 + Grafana 查 Prom
     ↓
第二代：Prom HA + AM 集群 + Prom 远程写 VM/Thanos
     ↓
第三代：vmagent 采（无本地存）+ VM 集群 + vmalert 告警评估 + AM 集群
```

**面试模板**：
> "生产走第三代架构：vmagent 每 K8s 节点部署为 DaemonSet 做本地采集，remote_write 到中心 VM 集群（vminsert + vmstorage 3 副本 + vmselect）；vmalert 从 VM 查数据评估告警规则推给 Alertmanager 3 节点 gossip 集群。Prom 本身在这个架构里已经被 vmagent 取代——历史包袱迁移中的场景仍保留 Prom HA 双跑。"

---

## §14 · 生产实战：TCUM 中的 Prometheus / VM 融合

### 14.1 采集架构

```
K8s Pods (Exporter/自埋点)
  │
  ├── kube-state-metrics
  ├── node_exporter (DaemonSet)
  └── 业务 /metrics
    │
    ↓ Pull (Prometheus 边缘)
[Prometheus] ─── remote_write ──→ [VictoriaMetrics 中心]
    │                                    ↑
    │                                    │
    └── evaluate rules → firing ───→ [Alertmanager 集群]
                                          │
                                          ↓
                              [Notification: 微信/邮件/电话/Webhook]
```

### 14.2 边缘 Prometheus vs 中心 VM

- **边缘 Prometheus** 短保留（1~7 天）+ 本地评估 recording/alerting rule
- **中心 VM** 长期存储（30~365 天）+ 全局查询 + Grafana 后端

### 14.3 分层告警设计

- **L1 基础设施**：CPU/内存/磁盘/网络（node_exporter）
- **L2 平台/中间件**：Redis/MySQL/Kafka/ES 各自 exporter
- **L3 业务/SLO**：错误率 / 延迟 / 饱和度（RED/USE 方法）
- **L4 端到端拨测**（blackbox_exporter）

### 14.4 告警治理

- **for 至少 2min**（避免抖动）
- **合理分组** by (service, alertname) 避免海啸
- **severity 分级** critical / warning / info，不同通道
- **runbook 链接**：annotations 里带 wiki 链接指导 on-call
- **抑制规则**：NodeDown 抑制该节点其他告警

### 14.5 高基数控制

- 禁止把 `user_id` / `trace_id` / `path` 作为 label
- 定期审查 `count({__name__=~".+"})` 各 metric series 数
- 单 metric series > 1w 报警

---

## §15 · 版本演进

| 版本 | 关键 |
|---|---|
| 1.x | 早期，被 2.x 全面替代 |
| 2.0 | 全新 TSDB，性能提升 |
| 2.5+ | Recording rule 优化 |
| 2.20+ | remote_write metadata support |
| 2.30+ | agent mode（无本地存储） |
| 2.40+ | Native Histogram（新式直方图，8~10x 更省） |
| 2.45+ | LTS 版本 |
| 2.50+ | 更多 PromQL 优化 |

---

## §16 · 50 问详解

### 【架构与模型】

**Q1. 为什么 Prometheus 是云原生监控事实标准？**
> 多维 label 数据模型 + Pull 采集 + PromQL + 单机 TSDB + 独立 Alertmanager。K8s 及几乎所有 CNCF 组件都提供 /metrics，生态标准化。

**Q2. Pull 和 Push 的优劣？**
> Pull 优势：Server 控制频率、天然探活、配置集中；Push 优势：短生命作业、防火墙场景。Prometheus 用 Pull，短生命用 Pushgateway 补充。

**Q3. Pushgateway 什么时候用？什么时候不用？**
> 用：短生命 cron job；不用：长服务（Prometheus 直接拉）、大流量（PG 变瓶颈）、需要历史（PG 不持久）。

**Q4. 四种 metric 类型？**
> Counter（只增）/ Gauge（可增减）/ Histogram（服务端算分位）/ Summary（客户端算分位）。**分位数选 Histogram**（可聚合）。

**Q5. Histogram 和 Summary 怎么选？**
> Histogram：服务端 `histogram_quantile` 估算，可跨实例聚合，bucket 精度影响准确度；Summary：客户端算，精确但不可聚合。**云原生场景推 Histogram**。

**Q6. 什么是高基数？为什么危险？**
> series 数 = metric × label 组合。把 user_id / trace_id 当 label → 千万 series → 内存爆炸、查询慢、TSDB 索引膨胀。经验：单实例 <500w series。

### 【TSDB 存储】

**Q7. Prometheus 存储结构？**
> WAL + Head（内存 2~3h）→ 满 2h 转 Block（磁盘） → Compaction 合并大 Block。默认保留 15 天。

**Q8. 一个 Block 里有什么？**
> chunks（时序数据，XOR 压缩）+ index（label 倒排索引）+ meta.json + tombstones（删除标记）。

**Q9. XOR 压缩是什么？**
> Gorilla 论文的浮点数增量存储：相邻 value XOR 后前导零编码。压缩率 12x+，一个样本平均几字节。

**Q10. WAL 的作用？**
> Head Block 内存写入前先追加 WAL，崩溃恢复时重放。默认每 10s fsync。

**Q11. TSDB 的查询流程？**
> PromQL → label matchers → Block index 倒排找 series → 时间范围过滤 → chunk 解压 XOR → 返回样本。

**Q12. 数据保留时间怎么控制？**
> `--storage.tsdb.retention.time=30d`（时间）或 `retention.size=100GB`（磁盘上限）。长期靠 remote_write。

### 【Service Discovery】

**Q13. 常用 SD 有哪些？**
> static / file / kubernetes / consul / dns / EC2/GCE 等。**K8s 环境用 kubernetes_sd 是必须**。

**Q14. Relabel 五大 action？**
> keep（保留匹配）/ drop（丢弃）/ replace（替换字段）/ labelmap（批量映射）/ hashmod（分片）。

**Q15. relabel_configs 和 metric_relabel_configs 区别？**
> relabel：抓取前对 target 元 label 处理；metric_relabel：抓取后对 metric label 处理。抓取过滤优先前者省网络。

### 【PromQL】

**Q16. Instant Vector 和 Range Vector 区别？**
> Instant：某时刻多 series 的一组瞬时值；Range：一段时间的样本集合（`[5m]`）。rate/increase 等函数要 Range。

**Q17. rate 和 irate 区别？**
> rate：范围内**平均**每秒增长；irate：取最后两个点的**瞬时**变化。图表用 rate 平滑，告警可用 irate 敏感。

**Q18. rate 陷阱？**
> ① 只能用 Counter ② `sum(rate(...))` 而不是 `rate(sum(...))`（sum 后 counter 重置信息丢失得负值）③ 窗口 ≥ 3~4 倍 scrape_interval。

**Q19. histogram_quantile 陷阱？**
> ① rate 之后要保留 le label（`sum by (le)(...)`）② bucket 划分不细误差大 ③ P99 落在 [1s,5s] 桶会**线性插值**估 3s，实际可能是 5s。

**Q20. increase 和 rate 什么关系？**
> `increase(v[5m]) = rate(v[5m]) * 300`。都可以，`rate` 更常用（结果是 per-second）。

**Q21. 向量匹配为什么会没结果？**
> 两 metric labels 不完全一致，1-to-1 匹配失败。用 `on(...)` / `ignoring(...)` 指定 join label，或 `group_left/right`。

**Q22. PromQL 支持子查询吗？**
> 支持（2.7+）：`max_over_time(rate(http[5m])[30m:1m])` = 过去 30 分钟每分钟计算一次 5 分钟 rate，取最大。**子查询贵，慎用**。

**Q23. topk 和 sort 区别？**
> topk 返回前 K 个 series；sort 返回全部但排序。**告警场景常用 topk 减少数据量**。

### 【Recording Rule / Alerting Rule】

**Q24. Recording Rule 有什么用？**
> 预计算高频复杂 PromQL，Grafana 查预计算结果快得多。命名遵循 `level:metric:operation`。**代价**：生成新 series 占空间。

**Q25. Alerting Rule 的 for 是什么？**
> 匹配持续时间。for=5m 表示条件持续 5min 才 firing。防止瞬时抖动误报。

**Q26. pending 和 firing 区别？**
> pending：条件匹配但 for 未到；firing：for 到了推给 AM。

**Q27. Rule 评估失败会怎样？**
> 单个 rule 失败不影响其他，Prometheus `prometheus_rule_evaluation_failures_total` 指标暴露。生产要监控这个。

### 【Alertmanager】

**Q28. AM 三大核心能力？**
> 分组（合并同类）、抑制（大告警屏蔽小）、静默（临时屏蔽）+ 路由分发。

**Q29. group_wait / group_interval / repeat_interval 分别是什么？**
> group_wait：**首批**告警到达后等多久收集同组的其他告警一起发（30s 常用）；group_interval：**同组新增**告警发送间隔；repeat_interval：同分组**重复通知**间隔（4h 常用防轰炸）。

**Q30. 抑制规则怎么写？**
> source_matchers 匹配大告警 + target_matchers 匹配要抑制的 + equal 指定共同 label。例：NodeDown 抑制同 instance 其他 warning。

**Q31. 静默和抑制区别？**
> 静默：**手动**创建时间窗口内屏蔽（维护）；抑制：**规则驱动**告警之间的相关屏蔽。

**Q32. AM 集群怎么工作？**
> 多副本 gossip 协议同步状态（已发送、静默列表）。无外部协调依赖。Prometheus 高可用发相同告警，AM 通过指纹去重。

**Q33. AM 集群脑裂了会怎样？**
> 两组各自发送→重复告警。降低 gossip 超时可缓解，但根本靠网络稳定。

**Q34. 告警去重是怎么做的？**
> 告警指纹 = labels 的 hash。相同指纹 AM 只发一次。多个 Prometheus 发相同告警到 AM 集群，AM 去重。

**Q35. 告警通知模板怎么写？**
> `annotations.summary` / `description` 用 Go template，`{{ $labels.xxx }}` 引用 label，`{{ $value }}` 当前值。支持函数 `humanizeDuration` 等。

### 【Remote / Federation】

**Q36. Remote Write 是什么？**
> Prometheus 采集的每样本实时推到远程存储（VM / Thanos）。协议：Snappy Protobuf HTTP POST。**生产标配**。

**Q37. Remote Read 用吗？**
> 少用，性能差。推荐直接查远程（如查 vmselect 而不是通过 Prometheus）。

**Q38. Federation 和 Remote Write 区别？**
> Federation：Prometheus 拉另一 Prometheus 的聚合指标（还是 Pull）；Remote Write：实时推样本到远程。**推荐 Remote Write**。

**Q39. Agent Mode 是什么？**
> 2.30+ 无本地存储，只做采集 + remote_write。适合超大规模边缘采集，只把数据发中心。

### 【生产实践】

**Q40. Prometheus 单机能扛多少 series？**
> 官方经验 100~500 万 series 舒服，1000 万勉强。**超过靠 VM / Thanos / Cortex**。

**Q41. Prometheus 高可用怎么做？**
> 两个相同配置的 Prometheus 各自采集，remote_write 到中心 VM，AM 集群去重。

**Q42. 磁盘满了会怎样？**
> 停止写入 series（读还行）。监控 `prometheus_tsdb_lowest_timestamp` 和 disk usage 告警。

**Q43. WAL Corruption 怎么处理？**
> 启动时报错。删除 wal 目录（丢失最近样本）或 downgrade 版本。生产 remote_write 后 WAL 丢失影响小。

**Q44. 采集间隔 scrape_interval 怎么设？**
> 通用 15~30s。业务敏感 5~10s。**注意 rate 窗口要 ≥ 3~4 倍 scrape_interval**。

**Q45. 抓取超时 scrape_timeout 怎么设？**
> < scrape_interval。默认 10s。target 慢的话 exporter 优化或调长（但抓取过慢挤压 CPU）。

### 【场景与选型】

**Q46. Prometheus vs Zabbix？**
> Zabbix：Push 为主，传统监控，agent 复杂，UI 强；Prometheus：Pull + 云原生 + PromQL + K8s 无缝。**云原生首选 Prometheus**。

**Q47. Prometheus vs InfluxDB？**
> Prometheus：拉模式 + PromQL + 云原生生态；InfluxDB：推模式 + Flux/InfluxQL + 商业版能力多。**监控场景选 Prometheus，通用时序选 InfluxDB**。

**Q48. Prometheus vs VictoriaMetrics？**
> VM 是 Prometheus 的**长期存储 + 高性能替代**。协议兼容 Prometheus，写入 20x 快，压缩省 7x。**TCUM 生产：Prometheus 采集 + VM 存储**。

**Q49. 为什么 K8s 组件都提供 /metrics？**
> Prometheus 生态标准。kube-apiserver / kubelet / etcd / kube-state-metrics 都原生支持。集成成本零。

**Q50. 告警最佳实践 5 点？**
> ① for 至少 2min 避抖动 ② group_by 合并同类 ③ severity 分级不同通道 ④ runbook 链接指导 on-call ⑤ 定期演练 + 告警治理（无效告警下线）。

### 【补充深度】

**Q51. Native Histogram 是什么？**
> 2.40+ 新型直方图，bucket 自动指数划分。相比经典 Histogram 存储省 8~10x，精度更高。**未来趋势，但生态兼容还在推进**。

**Q52. Prometheus 有鉴权吗？**
> 内建有 basic auth / TLS。多租户/复杂 ACL 用**反向代理**（nginx / OpenResty / Gateway）或 Cortex/Mimir 多租户。

**Q53. Grafana 里 Prometheus 慢查询怎么优化？**
> ① Recording Rule 预计算 ② 减小时间范围 ③ 用 label 精确过滤 ④ 避免 `.*` 正则 ⑤ 避免 `count(...)` 大范围。

**Q54. PromQL 里 sum(rate(x[5m])) by (job) 慢怎么办？**
> Recording Rule 预计算 → 查询变简单 `job:x:rate5m{job="..."}`。

**Q55. Prometheus 采集敏感数据 label 怎么脱敏？**
> metric_relabel_configs 里 `action: labeldrop` 或 `regex` 匹配删除。或 target 侧脱敏。

---

## §17 · 短板与坑

1. **单机存储上限**：靠 VM/Thanos 补
2. **高基数灾难**：把动态值当 label 秒挂
3. **rate/sum 顺序**：sum(rate(...)) 而非反过来
4. **深查询卡死**：Grafana 查 30 天 * 1w series → OOM
5. **PG 陷阱**：不持久 + 历史残留
6. **无原生鉴权**：靠反代
7. **Federation 不适合大规模**：用 Remote Write
8. **AM 分组配置陷阱**：group_wait / repeat_interval 不合理导致告警海啸或告警不到
9. **规则文件 reload 失败静默**：监控 `prometheus_rule_evaluation_failures_total`
10. **本地 SSD 坏 = 数据丢**：remote_write 保底

---

## §18 · 面试话术模板

### 3 分钟自述

> "我在 TCUM 全链路里 Prometheus 承担采集协议标准 + 边缘评估，Alertmanager 承担告警路由 + 分组 + 抑制，VictoriaMetrics 承担长期存储。
>
> **对 Prometheus 最深三点理解**：
> - **多维 label + Pull + PromQL 是生态标准**：K8s/CNCF 全适配。VM/Thanos/Cortex 都兼容 Prometheus 协议就是明证。
> - **TSDB 内核精妙但单机上限硬**：WAL + Head + Block + XOR 压缩样本几字节；但 series 超 500w 就吃力，横向不能扩，长期必须 remote_write 到 VM。
> - **告警的三层设计**：Prometheus 生成 firing → Alertmanager 分组抑制静默路由 → 通知集成。**Alertmanager 集群 gossip 去重是天才设计**：Prometheus HA 发相同告警 AM 自动收敛。
>
> **生产血泪**：把 user_id 打进 label 秒挂内存、sum(rate) 写反得负值、group_wait 太短告警海啸、深查询 Grafana 卡死——每一次都是模型和 PromQL 理解的教训。"

### 反问 5 问

1. Prometheus 版本？开 Native Histogram 了吗？
2. 长期存储用 VM / Thanos / Mimir？
3. AM 集群规模？分组策略？
4. 高基数控制机制？series 上限告警吗？
5. 告警响应流程和 runbook 建设？

---

**本篇完 · 约 26KB · 覆盖架构/TSDB/PromQL/Rule/AM/生产实战/55 问**

**证据基线**：
- Prometheus 官方文档：https://prometheus.io/docs/
- Facebook Gorilla 论文（XOR 编码）
- 生产实战：TCUM Prometheus + VM + AM 集群 + 分级告警
- 阿里/字节 K8s 集群规模：单集群万 pod，Prometheus + VM 承载
