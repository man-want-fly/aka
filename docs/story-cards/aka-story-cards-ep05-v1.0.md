# AKA 重排 · EP-05 编排、缓存与 DTO · Story 卡 v1.0

| 项目 | 内容 |
|---|---|
| Epic | **EP-05 编排、缓存与 DTO**（按需批量计算、请求去重与取消、缓存键与世代丢弃、计算元信息、DTO 组装） |
| 不在本 Epic | 不做 IPC 命令注册与序列化边界（EP-06）、不做页面状态与渲染（EP-07）、不改指标公式（EP-03） |
| 卡数 / 点数 | **9 张，全部 P0；25 故事点** |
| 编写规则 | 《Story 卡编写规则》，逐条执行：标题动宾 / 产品三句话 / Given-When-Then / 优先级·故事点 / 依赖备注 / DoD |
| 卡面结构 | 规则六项必含字段在前；**技术决定（TL，开发期不再讨论）**、**可致红反例（QA）**、**Task 拆解（Dev）** 在后，是规则的「TL 补技术约束、Dev 拆 Task」两段落地 |
| 编号规则 | `S-EP{两位 Epic}-{两位序号}`。**不复用**旧 E-05（搜索）、E-06（设置与主题）、E-07（数据源与模拟环境）的号段，避免与 `aka-story-index-v0.1.csv` 撞号 |
| 落点基准 | `main@3192b76`，行号可直接跳转核对 |
| 代码状态 | 已实现 8 张 / 未实现 1 张（`S-EP05-05`） |
| blocked | 2 项（`B-05-01` 数据集重建后的缓存失效口径、`B-05-02` 质量标记字符串大小写），登记见 `aka-story-cards-blocked-v1.0.md`；两项均不阻塞本 Epic 开工 |

---

## 0. 口径锁定（本 Epic 内禁止再讨论的既有事实）

| 事实 | 现值 | 出处 |
|---|---|---|
| 编排入口 | `AppCore::calc_indicators(&CalcRequest) -> Result<CalcResponse, AppError>`，单请求内循环所有 `instances` | `app/crates/app-core/src/core.rs:1694` |
| 缓存键 | `calc_key()`：`v2\|ENGINE_VERSION\|dataset_id\|security\|timeframe\|adj\|indicator_id\|params_json\|from~to`，**7 维 + 日期区间** | `core.rs:2273-2292` |
| **不存在** `CalcCacheKey` 结构体 | 键是 `String`，值是 `Arc<Vec<Vec<f64>>>` | `core.rs:317`、`2273` |
| `SeriesKey` | **三字段** `security` / `timeframe` / `adj`，不含 `dataset_id` | `app/crates/data-store/src/lib.rs:66-71` |
| `QualityFlag` | **8 个变体**：`Simulated / LimitUp / LimitDown / SplitDay / Suspended / ExRights / ZeroVolume / PriceAnomaly` | `app/crates/data-provider/src/types.rs:127-160` |
| `BarFlag` | **全仓零定义**，不得在卡、代码、测试里引用该类型；K 线标记一律 `Vec<String>` | `rg "BarFlag" app/` → 0 |
| `indicator-core` 目录 | `src/` 下只有 `kernels.rs` + `indicators/`，**无 `kernels/` 子目录** | `app/crates/indicator-core/src/` |
| 落点复算 | 全量 154 条落点 / **66 条文件不存在**（旧卡口径 48/151 作废） | 本文件每张卡的落点均已在 worktree 内逐条 `test -f` 过 |

---

## S-EP05-01 · 一次请求批量计算多个指标实例

- 优先级：P0 ｜ 故事点：3 ｜ 依赖：无（本 Epic 首卡）；上游 `EP-03` 的 `lookup / merge_defaults / validate`
- 负责人：待 Sprint 规划指派 ｜ 备注：本卡只做「一次请求算 N 个实例并原样返回」，缓存与去重在下两张卡
- 模块编号：E-02 个股工作台 ｜ 原卡号：`S-02.06-01`（拆分）

**用户故事（产品）**
作为盯盘用户，我希望主图和副图上的所有指标在一次请求里一起算完，
以便切换标的时不会因为逐个请求而出现「主图先出、副图后到」的闪动。

**验收标准（BA）**
- 给定 指标实例 `[{a:T01 period=20}, {b:T01 period=20}, {c:T01 period=30}]` 与 `600519.SH / D / qfq`，当 调用 `calc_indicators`，则 `series.length = 3`，且 `series[0].instanceId="a"`、`series[1].instanceId="b"`、`series[2].instanceId="c"`（顺序 = 请求顺序，不按 id 排序）
- 给定 同一请求，当 返回成功，则 每个 `series[i].outputs[j].values.length` 严格等于响应 `barCount`，且 `barCount = range.returnedTo 与 returnedFrom 之间的实际根数`
- 给定 指标 id `"NOPE"`，当 调用，则 整请求返回 `E_UNKNOWN_INDICATOR`，`details.indicatorId="NOPE"`，**不得**返回「其余实例正常、缺一条」的部分结果
- 给定 `T01` 的 `period=0`，当 调用，则 返回 `E_PARAM_OUT_OF_RANGE`，`message` 含 `T01 参数不合法`
- 给定 请求 `generation=7`，当 成功返回，则 响应 `generation=7`（只回显，不做任何服务端判断）
- 给定 `timeframe="M"` 且该标的只有 24 根月线、实例为 `T02(12/26/9)`，当 调用，则 返回成功（HTTP-like 不报错）、`warmup=26`、该实例全部 `values` 为 `null`，不得因预热不足让整请求失败

**技术决定（TL · 开发期不再讨论）**
- 落点：`app/crates/app-core/src/core.rs:1694` `pub async fn calc_indicators(&self, req: &CalcRequest) -> Result<CalcResponse, AppError>`
- 主循环：`core.rs:1713-1844`；每实例依次 `lookup → meta → merge_defaults → validate → calc_key → 取缓存/计算 → 按 window 切片 → 组装 SeriesDto`
- 切片：`core.rs:1799-1835`，`values[window.start..window.end]`，`is_finite()` 为真取 `Some(v)`，否则 `None`
- 响应组装：`core.rs:1867-1877`
- 完整 DTO（`app/crates/app-core/src/dto.rs`）：

```rust
// dto.rs:377-394
pub struct CalcRequest {
    pub security: String,          // "600519.SH"
    pub timeframe: String,         // 默认 "D"，取值 D / W / M
    pub adj: String,               // 默认 "qfq"，取值 null(不复权) / qfq / hfq
    pub from: Option<String>,      // YYYY-MM-DD，含
    pub to: Option<String>,        // YYYY-MM-DD，含
    pub generation: u64,           // 前端自增序号，仅回显
    pub instances: Vec<InstanceRequest>,
}
// dto.rs:368-375
pub struct InstanceRequest { pub instance_id: String, pub indicator_id: String, pub params: BTreeMap<String, ParamValue> }
// dto.rs:417-430
pub struct CalcResponse {
    pub generation: u64, pub dataset_id: String, pub dataset_generation: u64,
    pub engine_version: &'static str, pub computed_ms: f64, pub cache_hit: bool,
    pub bar_count: usize, pub range: RangeDto, pub series: Vec<SeriesDto>,
}
// dto.rs:407-415
pub struct SeriesDto { pub instance_id: String, pub indicator_id: String, pub outputs: Vec<OutputSeriesDto>, pub warmup: usize, pub engine_version: u16 }
// dto.rs:396-405
pub struct OutputSeriesDto { pub key: &'static str, pub label_zh: &'static str, pub kind: OutputKind, pub color: &'static str, pub values: Vec<Option<f64>> }
```

- 命令入口（不在本卡改，签名冻结给 EP-06）：`app/src-tauri/src/commands.rs:231` `#[tauri::command] pub async fn calc_indicators(state: State<'_, AppState>, req: CalcRequest) -> Result<CalcResponse, AppError>`；超时 `CALC_TIMEOUT_MS = 8_000`（`commands.rs:218`）由命令层负责，本卡不重复实现
- 数据来源：`core.rs:1698` `series_for(security, timeframe, adj)`；`dataset_id` / `dataset_generation` 取自 `CandleSeries`（源头是 `BarBatch`）
- 不做：不做并行计算（每实例串行，44 实例实测 ≤ 300ms 基线）、不做取消（取消由前端 generation 比对丢弃，见 `S-EP05-03`）

**可致红反例（QA）**
1. 把 `core.rs:1806` 的 `&values[window.start..window.end]` 改成 `&values[..]` → AC2 红：`values.length != barCount`
2. 把 `core.rs:1714` 的 `lookup(...).ok_or_else(...)?` 改成 `if let Some` + 跳过该实例 → AC3 红：请求变成功且 `series.length = 0`
3. 把 `core.rs:1867` 的 `generation: req.generation` 改成 `generation: 0` → AC5 红
4. 把 `core.rs:1722` 的注释对应的「预热不足不失败」改成 `if window.end - window.start < warmup { return Err(...) }` → AC6 红（24 根月线时返回 `E_INSUFFICIENT_DATA`）

**Task 拆解（Dev）**
1. `core.rs` 新增测试 `calc_response_keeps_request_instance_order`：3 实例乱序 id（`c,a,b`），断言响应顺序 = 请求顺序
2. 新增测试 `calc_values_length_equals_bar_count`：同一响应内逐实例断言 `values.len() == bar_count`
3. 新增测试 `calc_unknown_indicator_fails_whole_request`：混入 `NOPE`，断言 `Err` 且 `details.indicatorId`
4. 新增测试 `calc_monthly_short_series_t02_all_null`：`M` + 24 根 + `T02`，断言 `warmup == 26` 且全 `None`
5. `app/scripts/` 无新增脚本；本卡不接 CI（仓库无 `npm test`，见阻塞清单 `B-05-03`）

**完成定义 DoD**
单测通过 · 联调通过 · 产品验收 · 文档更新

---

## S-EP05-02 · 同一请求内相同指标参数只算一次

- 优先级：P0 ｜ 故事点：2 ｜ 依赖：`S-EP05-01`（同一循环）、`S-EP05-04`（去重键即缓存键）
- 负责人：待 Sprint 规划指派 ｜ 备注：只做**请求内**去重，跨请求复用是 `S-EP05-03`，两者不得合并
- 模块编号：E-02 个股工作台 ｜ 原卡号：`S-02.06-02`（拆分）

**用户故事（产品）**
作为同时挂多个同参数均线的用户，我希望重复的指标只计算一次，
以便多挂几个副图不会拖慢整次刷新。

**验收标准（BA）**
- 给定 实例 `[a:T01/20, b:T01/20, c:T01/30]`，当 首次调用，则 埋点计数 `indicator.compute = 2`、`compute.skip = 1`，且 `compute.count` 事件字段 `{count:2, skip:1, instances:3}`
- 给定 上述请求，当 返回成功，则 `series[0].outputs[0].values` 与 `series[1].outputs[0].values` 逐元素相等（长度、值、`null` 位置全同）
- 给定 5 个键互不相同的实例（主图 2 叠加 + 副图 3，含同一指标不同参数），当 调用，则 `compute.skip = 0`、`compute.count = 5`
- 给定 双输出指标（`MACD` 的 `dif`/`dea`/`hist`），当 两个实例参数相同，则 命中去重的那个实例仍返回全部 3 条 `outputs`，不得只回填第一条
- 给定 去重命中，当 读埋点，则 `compute.skip` 事件 `reason = "duplicateKey"`、`cacheKey` 非空、`instanceId` 为被跳过实例的 id

**技术决定（TL · 开发期不再讨论）**
- 落点：`core.rs:1710` `let mut request_cache: HashMap<String, Arc<Vec<Vec<f64>>>> = HashMap::new();`（请求内，函数局部变量，随请求结束销毁）
- 命中分支：`core.rs:1735-1746`，`request_cache.get(&key)` → `skipped += 1` + `EVENT_COMPUTE_SKIP`（`telemetry.rs:26`）
- 回填：`core.rs:1797` `request_cache.insert(key, raw.clone())`，**在缓存读写之后**统一插入，保证「本请求算过的键」一定进表
- 去重键 = `calc_key(...)` 全串，**不**另设「指标 id + 参数」短键
- 埋点常量：`EVENT_COMPUTE_SKIP = "compute.skip"`、`EVENT_COMPUTE_COUNT = "compute.count"`（`app/crates/app-core/src/telemetry.rs:26-27`）
- 不做：不做跨请求去重（那是 `calc_cache`）、不做参数归一化（`merge_defaults` 已把缺省参数补齐，参数表是 `BTreeMap` 键序稳定）

**可致红反例（QA）**
1. 删掉 `core.rs:1735` 的 `if let Some(values) = request_cache.get(&key)` 分支 → AC1 红（`compute.count` 变 3、`skip` 变 0）
2. 把 `core.rs:1742` 的 `"duplicateKey"` 改成 `"cacheHit"` → AC5 红
3. 把 `core.rs:1797` 的 `insert` 移到 `core.rs:1735` 之前 → 首个实例也被判为重复，AC1 红（`count` 变 1、`skip` 变 2）
4. 把 `core.rs:1827` 的 `outputs` 由 `map` 改成 `take(1)` → AC4 红（`MACD` 只剩 1 条 output）

**Task 拆解（Dev）**
1. 复用既有 `calc_telemetry_records_dedup_cache_and_cold_ms`（`core.rs:3363`），补 `reason == "duplicateKey"` 断言
2. 补 `dedup_reuses_all_outputs_for_multi_output_indicator`：MACD 两实例同参，断言 `outputs.len() == 3` 且三列逐元素相等
3. 补 `five_distinct_instances_skip_zero`（已存在 `calc_telemetry_counts_five_instances_without_skips`，`core.rs:3430`）：仅补 `compute.count.instances == 5`

**完成定义 DoD**
单测通过 · 联调通过 · 产品验收 · 文档更新

---

## S-EP05-03 · 跨请求命中计算缓存并给出命中语义

- 优先级：P0 ｜ 故事点：3 ｜ 依赖：`S-EP05-04`（键）、`S-EP05-05`（容量）
- 负责人：待 Sprint 规划指派 ｜ 备注：`cacheHit` 是**全命中**语义，不是「任一命中」，前端与 QA 都按此判定
- 模块编号：E-02 个股工作台 ｜ 原卡号：`S-02.06-02`（拆分）

**用户故事（产品）**
作为反复调参的用户，我希望参数没变时不再重算，
以便拖动一次区间后图表能立刻回来。

**验收标准（BA）**
- 给定 同一 `CalcRequest`（同标的/周期/复权/区间/实例），当 连续调用两次，则 第一次 `cacheHit=false`、第二次 `cacheHit=true`
- 给定 上述两次调用，当 读埋点累计，则 `cache.miss = 2`、`cache.hit = 2`、`indicator.compute = 2`（第二次不再执行 `calc`）
- 给定 一次请求含 1 个已缓存键 + 1 个新键，当 返回，则 `cacheHit=false`（响应级只有布尔，不做部分命中标记），且 `CacheStats.hits` 与 `misses` 各 +1
- 给定 全部实例命中缓存，当 返回，则 `computedMs = 0.0`（仅统计真实执行耗时，命中不计入）
- 给定 请求区间从 `无` 改为 `from=2024-01-01`，当 返回，则 `cacheHit=false`（区间进键，见 `S-EP05-04`）

**技术决定（TL · 开发期不再讨论）**
- 落点：`core.rs:1748-1793` 缓存读/写；`core.rs:1706` `let mut cache_hit = true;`；任一 miss 时 `core.rs:1761` 置 `false`；`core.rs:1846-1855` 累计 `CacheStats`
- 存储：`calc_cache: Mutex<HashMap<String, Arc<Vec<Vec<f64>>>>>`（`core.rs:317`、初始化 `core.rs:391`）；`calc_stats: Mutex<CacheStats>`（`core.rs:318`）
- `CacheStats` 定义：`app/crates/data-store/src/lib.rs:103-106`（`hits: u64`、`misses: u64`）
- 统计口径：**按请求**累计，不是按实例 —— 一次请求只要有一个 miss 就 `misses += 1`
- 写入时机：计算完成、`Arc::new` 之后立即 `insert`（`core.rs:1787-1792`），先写缓存再切片，切片不改缓存
- 错误不写缓存：`indicator.calc` 返回 `Err` 时直接 `?` 上抛，缓存里不落半成品
- 不做：不做 TTL、不做按数据集主动清空（后者 blocked，见 `B-05-01`）

**可致红反例（QA）**
1. 把 `core.rs:1850` 的 `if cache_hit { stats.hits += 1 } else { stats.misses += 1 }` 改成两边都 `hits += 1` → AC1/AC2 红（第二次 `cacheHit` 恒 true 或统计错位）
2. 把 `core.rs:1772` 的 `computed_ms += elapsed_ms` 提到 `if let Some(cached)` 之前并对命中路径也计时 → AC4 红（`computedMs > 0.0`）
3. 删掉 `core.rs:1791` 的 `insert` → AC1 红（第二次仍 `cacheHit=false`）
4. 把 `core.rs:1706` 的初值改成 `false` → 全命中请求返回 `cacheHit=false`，AC1 红

**Task 拆解（Dev）**
1. 补 `cache_hit_is_all_or_nothing`：1 命中 + 1 新键，断言 `cacheHit=false`、`stats.hits=1`、`stats.misses=1`
2. 补 `fully_cached_request_reports_zero_computed_ms`：第二次调用断言 `computed_ms == 0.0`
3. 复用 `single_macd_cache_hit_logs_one_event_and_values_match`（`core.rs:3792`）作为 AC2 的现成证据，补 `cache.hit` 计数断言

**完成定义 DoD**
单测通过 · 联调通过 · 产品验收 · 文档更新

---

## S-EP05-04 · 缓存键锁定七维加日期区间

- 优先级：P0 ｜ 故事点：3 ｜ 依赖：`S-EP05-01`（请求字段）、`S-EP05-08`（区间归一化）
- 负责人：待 Sprint 规划指派 ｜ 备注：**没有** `CalcCacheKey` 结构体；键就是 `String`，任何「加个结构体更清晰」的提议本期不做
- 模块编号：E-02 个股工作台 ｜ 原卡号：`S-02.06-02`（拆分）

**用户故事（产品）**
作为改完区间又切回复权方式的用户，我希望拿到的永远是当前口径下的结果，
以便不会看到上一次改动的残留曲线。

**验收标准（BA）**
- 给定 同标的同周期同参数、`from=2024-01-01`，当 生成键，则 键形如 `v2|1|ds-...|600519.SH|D|qfq|T01|{"period":20}|2024-01-01~2024-12-31`，以 `v2|` 开头且含 `~` 区间段
- 给定 只改 `timeframe D→W`，当 生成键，则 键不同（`core.rs:3108` 已覆盖）
- 给定 只改 `adj qfq→hfq`，当 生成键，则 键不同
- 给定 只改 `from` 或 `to`，当 生成键，则 键不同（`core.rs:3093` 已覆盖）
- 给定 数据集重建（`dataset_id` 变化），当 生成键，则 键不同（`dataset_id` 在键内）
- 给定 参数表内容相同、插入顺序不同，当 生成键，则 键**相同**（`Params` 为 `BTreeMap`，序列化键序稳定）
- 给定 任意参数，当 计算 `params_hash`，则 输出固定 16 位小写十六进制（FNV-1a），仅用于埋点排查，不参与键

**技术决定（TL · 开发期不再讨论）**
- 落点：`core.rs:2273-2292` `fn calc_key(series: &CandleSeries, meta: &'static indicator_core::Meta, params: &Params, range: &RangeDto) -> String`
- 格式（写死，逐段不可增减）：

```text
v2|{ENGINE_VERSION}|{series.dataset_id}|{series.security}|{series.timeframe}|{series.adj}|{meta.id}|{serde_json::to_string(params)}|{range.returned_from.unwrap_or("*")}~{range.returned_to.unwrap_or("*")}
```

- 区间取 `range.returned_*`（吸附后的实际首末交易日），不取 `requested_*`；未指定时记 `*`
- `params_hash`：`core.rs:2240-2249`，FNV-1a 64 位，`format!("{hash:016x}")`；只进 `telemetry_context`（`core.rs:2250-2271`），**不进键**
- 不改：不新增结构体、不改成 `Hash`、不加 `security` 之外的行情维度（复权因子不进键，已由 `adj` 表达）
- 参数 JSON 由 `serde_json::to_string(&Params)` 产生，`Params = BTreeMap<String, ParamValue>`，故键序稳定；若未来改 `HashMap` 会破坏本 AC

**可致红反例（QA）**
1. 从格式串删掉 `|{}`（对应 `series.timeframe`）→ AC2 红（`cache_key_includes_timeframe`）
2. 把 `range.returned_from/returned_to` 换成常量 `*` → AC4 红（`cache_key_includes_date_range`）
3. 把 `params` 换成 `HashMap` 后序列化 → AC6 红（同参数两次生成键可能不同，测试用两个不同插入顺序的 `Params` 构造）
4. 把 `dataset_id` 段删掉 → AC5 红（数据集重建后仍命中旧结果）
5. 把 `params_hash` 改成 `format!("{hash:x}")` → AC7 红（长度不再固定 16 位）

**Task 拆解（Dev）**
1. 补 `cache_key_includes_adj`（现无）
2. 补 `cache_key_includes_dataset_id`
3. 补 `cache_key_stable_for_equal_params`（两个键序不同的 `Params`，断言 `calc_key` 相等）
4. 补 `params_hash_is_16_lower_hex`
5. 在卡面与代码注释同步「7 维 + 区间」表述，删除任何「六元组」旧说法

**完成定义 DoD**
单测通过 · 联调通过 · 产品验收 · 文档更新

---

## S-EP05-05 · 计算缓存设置容量上限并淘汰最早键

- 优先级：P0 ｜ 故事点：3 ｜ 依赖：`S-EP05-03`（写入路径）；**本卡是 EP-05 唯一未实现项**
- 负责人：待 Sprint 规划指派 ｜ 备注：现状 `calc_cache` 无上限、无淘汰、无清空（`core.rs:317`），长会话切标的会单调增长
- 模块编号：E-02 个股工作台 ｜ 原卡号：**新补**（无旧卡）

**用户故事（产品）**
作为一整天开着客户端切几十只股票的用户，我希望客户端内存不会越用越多，
以便下午不会因为缓存膨胀而卡顿。

**验收标准（BA）**
- 给定 连续请求 513 个互不相同的键（不同 `security`×`timeframe`×参数组合），当 全部完成，则 `calc_cache.len() == 512`
- 给定 上述 513 次请求，当 回看第 1 个键，则 它已被淘汰，再次请求该键触发 `cache.miss + 1`（不是 `cache.hit`）
- 给定 恰好 512 个不同键，当 逐个再请求一遍，则 全部 `cache.hit`（512 个键一个都不能被误淘汰）
- 给定 同一请求内 3 个实例同键，当 完成，则 只新增 1 个缓存键（去重不额外占容量）
- 给定 缓存已达 512，当 插入第 513 个，则 淘汰**最早插入**的键（FIFO），不是随机、不是按值大小

**技术决定（TL · 开发期不再讨论）**
- 常量：`core.rs` 顶部新增 `const CALC_CACHE_MAX: usize = 512;`（与 `MAX_RANGE_DAYS` 同区，`core.rs:2059` 附近）
- 结构：`calc_cache: Mutex<CalcCache>`，新增

```rust
// core.rs 内新增（不引第三方 crate，项目当前无 lru 依赖）
#[derive(Default)]
struct CalcCache { map: HashMap<String, Arc<Vec<Vec<f64>>>>, order: std::collections::VecDeque<String> }
impl CalcCache {
    fn get(&self, key: &str) -> Option<Arc<Vec<Vec<f64>>>> { self.map.get(key).cloned() }
    fn insert(&mut self, key: String, value: Arc<Vec<Vec<f64>>>) {
        if self.map.insert(key.clone(), value).is_none() { self.order.push_back(key); }
        while self.order.len() > CALC_CACHE_MAX {
            if let Some(oldest) = self.order.pop_front() { self.map.remove(&oldest); }
        }
    }
    fn len(&self) -> usize { self.map.len() }
}
```

- 改点：`core.rs:317` 字段类型；`core.rs:391` 初始化；`core.rs:1748-1753` 读（`get`）；`core.rs:1787-1792` 写（`insert`）；`core.rs:3634/3647/3657` 微基准里的 `calc_cache.lock().unwrap().get(...)` / `.keys()` 同步换成 `CalcCache` API（`keys()` → 提供 `fn keys(&self) -> Vec<String>` 或改用 `len()`）
- 淘汰顺序按「首次插入」计，重复 `insert` 同键不改变顺序（不做真 LRU；理由：命中路径持锁时间要短，真 LRU 需在 `get` 里改序，会把每次读变成写）
- 不做：不按字节预算淘汰（无 `size_of_val` 统计需求）、不做 TTL、不做数据集重建清空（blocked `B-05-01`）

**可致红反例（QA）**
1. 不实现淘汰（保留现状）→ AC1 红（`len == 513`）
2. 把 `while` 条件写成 `while self.order.len() >= CALC_CACHE_MAX` → AC3 红（512 键时最后插入的键把第 512 个挤掉，回读必然 miss）
3. 把 `pop_front` 换成 `pop_back`（LIFO）→ AC5 红（被淘汰的是刚插入的键，回读周期 2 反而命中）
4. 把去重分支也调 `insert` 到 `calc_cache` → AC4 红（同键被重复计入顺序表，513 次触发提前淘汰）

**Task 拆解（Dev）**
1. `core.rs` 新增 `CalcCache` 结构与 `CALC_CACHE_MAX`
2. 替换 `calc_cache` 字段类型与 3 处读写调用（含微基准里的 3 处）
3. 新增测试 `calc_cache_evicts_oldest_beyond_limit`：构造 513 个不同 `security` 的轻量请求（用 `CandleStore` 预置序列避免真实取数），断言 `len == 512` 且首键 miss
4. 新增测试 `calc_cache_keeps_exactly_512_hits`：512 个键全命中
5. QA 复核：确认 `order` 与 `map` 长度始终一致（`len()` 用 `map.len()`，淘汰用 `order` 长度驱动）

**完成定义 DoD**
单测通过 · 联调通过 · 产品验收 · 文档更新

---

## S-EP05-06 · 按标的周期复权缓存 K 线序列并共用日线批次

- 优先级：P0 ｜ 故事点：3 ｜ 依赖：`EP-04`（provider 返回 `BarBatch`）；本卡为 `S-EP05-01` 的取数前置
- 负责人：待 Sprint 规划指派 ｜ 备注：`SeriesKey` 只有三字段；周/月必须从日线批次派生，不允许直接向 provider 要周/月
- 模块编号：E-02 个股工作台 / E-01 行情与自选 ｜ 原卡号：`S-02.06-01`（拆分）

**用户故事（产品）**
作为在主图切周期的用户，我希望日线只取一次、周月线在本地聚合，
以便切到周线时不用重新等数据加载。

**验收标准（BA）**
- 给定 首次请求 `600519.SH / D / qfq`，当 完成，则 `provider.daily_bars` 被调用 1 次
- 给定 随后请求同一标的 `W / qfq`，当 完成，则 `provider.daily_bars` 累计仍为 1 次（共用 `daily_batches`），且返回周线根数 = 日线按自然周聚合后的周数
- 给定 第三次请求 `600519.SH / W / qfq`，当 完成，则 命中 `CandleStore`，`daily_bars` 不增加
- 给定 请求未知标的 `"999999.SH"`，当 调用，则 返回 `E_UNKNOWN_SECURITY`
- 给定 某标的整段停牌（聚合后 0 根），当 请求，则 返回 `E_DATASET_MISSING`，`details={security,timeframe}`
- 给定 任意合法请求，当 返回序列，则 `CandleSeries.dataset_id / dataset_generation / simulated / generated_at` 均来自 `BarBatch`，不得由 `AppCore` 自行编造

**技术决定（TL · 开发期不再讨论）**
- 落点：`core.rs:1880-1992` `async fn series_for(&self, security: &str, timeframe: Timeframe, adj: Adjust) -> Result<Arc<CandleSeries>, AppError>`
- 二级缓存：
  - `CandleStore`（`app/crates/data-store/src/lib.rs:74-95`），键 `SeriesKey{security,timeframe,adj}`（`lib.rs:66-71`），值 `Arc<CandleSeries>`
  - `daily_batches: Mutex<HashMap<String, Arc<BarBatch>>>`（`core.rs:314`），键 `format!("{}|{}", code, adj.as_str())`（`core.rs:1996`）
- 聚合：`core.rs:1902-1906`，`Timeframe::Week => aggregate_bars(&rows, AggregatePeriod::Week)`、`Month` 同理；日线直接 `batch.rows.clone()`
- 空序列：`core.rs:1962-1975` 返回 `DatasetMissing` + `details`
- 未知标的：`core.rs:1886-1888` 在 `self.securities` 里查，未命中即 `E_UNKNOWN_SECURITY`
- 锁：`store_lock()`（`core.rs:2026-2030`）统一取 `CandleStore`，锁中毒映射 `E_INTERNAL`
- 不改：不加 `dataset_id` 到 `SeriesKey`（会破坏 `CandleStore` 公开契约与现有测试构造），数据集重建后的陈旧序列问题记 blocked `B-05-01`

**可致红反例（QA）**
1. 把 `core.rs:1904` 改成 `Timeframe::Week => batch.rows.clone()`（不聚合）→ AC2 红（周线根数 = 日线根数）
2. 删掉 `daily_batch` 的缓存（`core.rs:1997-2005`）→ AC2 红（`daily_bars` 变 2 次）
3. 删掉 `core.rs:1896-1898` 的 `CandleStore` 命中分支 → AC3 红（`loaded_series() > 1` 或计数增加）
4. 把 `core.rs:1963` 的 `ErrorCode::DatasetMissing` 改成 `InsufficientData` → AC5 红（错误码断言）

**Task 拆解（Dev）**
1. 复用 `weekly_and_monthly_aggregate_from_daily_batch`（`core.rs:3137`）作为 AC2 证据，补 `daily_bars` 调用计数（`MockProvider` 加原子计数或读 `daily_batches.len()`）
2. 补 `series_store_hit_avoids_second_fetch`：两次同参请求后 `store.loaded_series() == 1`
3. 补 `unknown_security_maps_to_e_unknown_security`
4. 补 `empty_series_maps_to_e_dataset_missing`（用整段停牌样本）
5. 在 `daily_batch` 注释写明「周/月不得直连 provider」

**完成定义 DoD**
单测通过 · 联调通过 · 产品验收 · 文档更新

---

## S-EP05-07 · 逐根派生质量标记并冻结线上字符串

- 优先级：P0 ｜ 故事点：3 ｜ 依赖：`S-EP05-06`（序列装配点）；上游 `EP-04` 的 `QualityFlag`
- 负责人：待 Sprint 规划指派 ｜ 备注：只派生 3 类（`ZERO_VOLUME` / `EX_RIGHTS` / `PRICE_ANOMALY`），其余 5 类由 provider 透传
- 模块编号：E-02 个股工作台 / E-07 数据源健康 ｜ 原卡号：**新补**（无旧卡）

**用户故事（产品）**
作为看单根 K 线详情的用户，我希望异常那根有明确标记，
以便知道是停牌、除权还是数据有问题，而不是只看到价格跳了一下。

**验收标准（BA）**
- 给定 某行 `quality` 含 `Suspended` 且 `volume=0`，当 装配 K 线，则 `quality` 含 `"SUSPENDED"` 且**不含** `"ZERO_VOLUME"`
- 给定 非停牌行 `volume=0`，当 装配，则 `quality` 含 `"ZERO_VOLUME"`
- 给定 相邻两行 `adj_factor` 差 > `f64::EPSILON`，当 装配当日行，则 含 `"EX_RIGHTS"`；即使当日涨幅超过板块上限也不得再打 `"PRICE_ANOMALY"`
- 给定 主板标的、`adj_factor` 不变、当日涨幅 `+11.5%`（> 10% + 1% 容差），当 装配，则 含 `"PRICE_ANOMALY"`
- 给定 首根 `close ≤ 0`，当 装配，则 含 `"PRICE_ANOMALY"`
- 给定 任意行，当 读线上字符串，则 只可能出现这 8 个值之一：`simulated`、`limitUp`、`limitDown`、`splitDay`、`SUSPENDED`、`EX_RIGHTS`、`ZERO_VOLUME`、`PRICE_ANOMALY`（大小写敏感）

**技术决定（TL · 开发期不再讨论）**
- 落点：`core.rs:1913-1942`（在 `series_for` 的 `Candle` 构造闭包内）
- 透传：`row.quality.iter().map(|q| q.as_str().to_string())`（`core.rs:1913-1914`）
- 派生规则（写死）：
  - `ZERO_VOLUME`：`!suspended && row.volume == 0.0`
  - `EX_RIGHTS`：`index > 0 && (prev.adj_factor - row.adj_factor).abs() > f64::EPSILON`
  - `PRICE_ANOMALY`：`index == 0` 时 `close <= 0.0`；`index > 0` 时 `!suspended && !ex_rights && prev.close > 0.0 && (close <= 0.0 || |close/prev.close - 1|*100 > cap + 1.0)`
- 板块上限：`quality::board_limit_pct(board)`（`app/crates/app-core/src/quality.rs`），主板 10 / 创业板·科创板 20 / 北交所 30；容差 `PRICE_LIMIT_TOLERANCE_PCT = 1.0`（`quality.rs:11`）
- 去重：`push_flag`（`core.rs:136-140`）只在不存在时 push
- 字符串来源唯一：`QualityFlag::as_str()`（`app/crates/data-provider/src/types.rs:145-160`），代码里不得出现裸字面量
- 大小写分裂（`simulated/limitUp/limitDown/splitDay` vs `SUSPENDED/EX_RIGHTS/ZERO_VOLUME/PRICE_ANOMALY`）**冻结现值**，不统一；统一需契约 owner 裁定，记 blocked `B-05-02`

**可致红反例（QA）**
1. 删掉 `core.rs:1921` 的 `!suspended &&` → AC1 红（停牌行同时带 `ZERO_VOLUME`）
2. 把 `core.rs:1926` 的 `> f64::EPSILON` 改成 `!=`，喂入 `adj_factor` 差 `1e-16` 的样本 → AC3 红（误报 `EX_RIGHTS`）
3. 把 `quality::board_limit_pct(found.board)` 换成常量 `10.0`，喂创业板 `+11.5%` 样本 → AC4 反向红（本该 `PRICE_ANOMALY` 却没打；用创业板样本断言「含」才会红）
4. 把 `core.rs:1913` 的 `as_str()` 改成手写 `match` 并写成小写 `"suspended"` → AC6 红

**Task 拆解（Dev）**
1. 复用 `suspended_bars_are_not_flagged_as_zero_volume`（`core.rs:3332`）、`daily_bars_carry_provenance_and_derived_quality_flags`（`core.rs:3188`）
2. 补 `ex_rights_suppresses_price_anomaly`
3. 补 `chinet_board_11p5_pct_is_price_anomaly`（创业板 20% 上限边界）
4. 补 `first_bar_non_positive_close_is_price_anomaly`
5. 补 `quality_flag_wire_strings_are_exactly_eight`：遍历 `QualityFlag` 全集断言 8 个字符串逐字相等

**完成定义 DoD**
单测通过 · 联调通过 · 产品验收 · 文档更新

---

## S-EP05-08 · 日期区间解析、非交易日吸附与超限拦截

- 优先级：P0 ｜ 故事点：3 ｜ 依赖：`S-EP05-06`（拿到完整序列才谈区间）
- 负责人：待 Sprint 规划指派 ｜ 备注：区间是缓存键的第 8 维，本卡决定 `RangeDto` 的每一个字段
- 模块编号：E-02 个股工作台 / E-01 行情与自选 ｜ 原卡号：`S-02.06-01`（拆分）

**用户故事（产品）**
作为随手输入一段日期的用户，我希望输到周末或未来日期也能出图，
以便不用先去查哪天是交易日。

**验收标准（BA）**
- 给定 `from="2024-01-06"`（周六）、`to="2024-01-12"`，当 调用，则 `range.returnedFrom="2024-01-08"`、`range.clamped=true`、`barCount=5`
- 给定 `to` 晚于数据集最新交易日，当 调用，则 不报错，`returnedTo` = 最新交易日、`clamped=true`
- 给定 `from` 晚于最新交易日，当 调用，则 返回 `E_INSUFFICIENT_DATA`，`details` 含 `requestedFrom/requestedTo/availableFrom/availableTo/totalBars`
- 给定 `from > to`，当 调用，则 返回 `E_INVALID_ARGUMENT`，`details={from,to}`
- 给定 日历跨度 > 3 660 天，当 调用，则 返回 `E_INVALID_ARGUMENT`，`details.maxDays=3660`
- 给定 区间内根数 > 2 500，当 调用，则 返回 `E_INVALID_ARGUMENT`，`details={maxBars:2500,requestedBars}`
- 给定 `from="2024-13-01"`，当 调用，则 返回 `E_INVALID_ARGUMENT`（日期格式非法）
- 给定 `from`/`to` 都不传，当 调用，则 `range.requestedFrom=null`、`requestedTo=null`、`clamped=false`、`barCount` = 序列全部根数

**技术决定（TL · 开发期不再讨论）**
- 落点：`core.rs:2078-2178` `fn resolve_window(series, from, to) -> Result<ResolvedWindow, AppError>`；`core.rs:2179-2199` `fn parse_bound`；常量 `core.rs:2059-2060`
- 映射：日期闭区间 → 下标半开区间 `[start, end)`；`start = position(c.date >= from)`、`end = rposition(c.date <= to) + 1`；`start >= end` 即空区间报 `InsufficientData`
- `clamped` 判定：`requested_from != returned_from` 或 `requested_to != returned_to`
- `RangeDto` 字段（`dto.rs:139-152`）：`requestedFrom` / `requestedTo` / `returnedFrom` / `returnedTo` / `barCount` / `clamped`，六个字段全发，`Option` 为 `null` 不省略
- 错误细节统一带 `requestedFrom/requestedTo/availableFrom/availableTo/totalBars`
- 不做：不做分钟级区间、不做「区间内全是停牌日」的特殊码（统一 `InsufficientData`）

**可致红反例（QA）**
1. 把 `core.rs:2126` 的 `>=` 改成 `>` → AC1 红（`from` 恰为交易日时跳到下一根，`barCount` 少 1）
2. 把 `clamped` 恒置 `false` → AC1/AC2 红
3. 删掉 `core.rs:2153-2160` 的 `MAX_RANGE_BARS` 检查 → AC6 红（返回成功而不是 `E_INVALID_ARGUMENT`）
4. 把 `MAX_RANGE_DAYS` 改成 `30_000` → AC5 红（`details.maxDays` 断言 + 超长区间不再报错）
5. 把 `core.rs:2144` 的空区间分支（`if start >= end`）改成返回全序列 → AC3 红

**Task 拆解（Dev）**
1. 复用 `snaps_to_trading_day_and_clamps`（`core.rs:3021`）、`to_beyond_last_is_clamped_not_error`（`3032`）、`from_after_last_is_insufficient_data`（`3041`）、`inverted_and_too_long_are_invalid`（`3049`）、`bad_date_format_is_invalid`（`3060`）、`default_window_covers_all_bars`（`3068`）
2. 补 `range_wire_format_is_dates_not_indexes`（`3077`）的字段齐全断言：六键全在，`requestedFrom == null` 时键仍存在
3. 补 `max_bars_detail_fields`：断言 `maxBars=2500` 与 `requestedBars` 同发

**完成定义 DoD**
单测通过 · 联调通过 · 产品验收 · 文档更新

---

## S-EP05-09 · DTO 序列化形状冻结：camelCase、null 与 NaN

- 优先级：P0 ｜ 故事点：2 ｜ 依赖：`S-EP05-01`；被 `EP-06` 的 DTO 冻结清单引用
- 负责人：待 Sprint 规划指派 ｜ 备注：本卡只锁**形状**，不锁命令注册；命令面在 `EP-06`
- 模块编号：E-02 个股工作台（跨 E-01/E-07/E-08）｜ 原卡号：**新补**（无旧卡）

**用户故事（产品）**
作为前端开发者，我希望后端返回的字段名与空值方式始终一致，
以便不用为每个接口写一层防御性转换。

**验收标准（BA）**
- 给定 任意 `CalcResponse`，当 序列化，则 顶层键集合恰为 `generation`、`datasetId`、`datasetGeneration`、`engineVersion`、`computedMs`、`cacheHit`、`barCount`、`range`、`series`，**不含任何 snake_case 键**
- 给定 某个指标值不有限（NaN / ±Inf），当 序列化，则 对应位置为 `null`，且 `values.length` 仍等于 `barCount`
- 给定 `computedMs = 0.0`，当 序列化，则 输出 `0.0`（数字），不是 `null`、不是字符串
- 给定 请求未指定区间，当 序列化，则 `range.requestedFrom` 为 `null` 且**键存在**
- 给定 `BarDto.batchId` 缺失，当 序列化，则 `batchId: null` 键存在
- 给定 同一响应，当 对比 `engineVersion` 与 `series[0].engineVersion`，则 前者是字符串（如 `"1.0.0"`）、后者是数字（如 `1`）；前端不得混用，二者类型差异为已冻结事实

**技术决定（TL · 开发期不再讨论）**
- 落点：`app/crates/app-core/src/dto.rs` 全文；关键结构 `CalcResponse`（`dto.rs:417-430`）、`SeriesDto`（`407-415`）、`OutputSeriesDto`（`396-405`）、`RangeDto`（`139-152`）、`BarDto`（`54-73`）
- 规则一：所有 DTO 加 `#[serde(rename_all = "camelCase")]`，**无例外**；`Deserialize` 侧（`CalcRequest` / `InstanceRequest` / `GetBarsRequest`）同规则
- 规则二：`Option<T>` 不写 `skip_serializing_if`，缺省即 `null`
- 规则三：NaN → `null` 在编排层完成（`core.rs:1806-1814`），不依赖 serde；`OutputSeriesDto.values: Vec<Option<f64>>` 是唯一载体
- 规则四：`CalcResponse.engine_version: &'static str` 与 `SeriesDto.engine_version: u16` 类型不一致，**冻结不改**（改动会牵动前端 `types.ts:419/440` 两处类型与渲染）
- 规则五：不新增 `#[serde(flatten)]`、不新增 `Vec<f64>` 裸数组承载指标值
- 命令绑定（冻结给 EP-06）：`commands.rs:231` + `app/src/lib/ipc.ts:143-144` `calcIndicators: (req: CalcRequest) => invoke<CalcResponse>("calc_indicators", { req })`

**可致红反例（QA）**
1. 删掉 `dto.rs:418` 的 `#[serde(rename_all = "camelCase")]` → AC1 红（顶层出现 `dataset_id`）
2. 把 `core.rs:1808` 的 `Some(*value)` 改成 `Some(0.0)`（非有限也当 0）→ AC2 红（`null` 变 `0`）
3. 给 `RangeDto.requested_from` 加 `skip_serializing_if = "Option::is_none"` → AC4 红（键消失）
4. 把 `computed_ms` 改成 `Option<f64>` 并在 0 时置 `None` → AC3 红（输出 `null`）
5. 把 `CalcResponse.engine_version` 改成 `u16` → AC6 红（两处类型断言一致后失去「类型分裂」事实，前端 `types.ts:419` 的 `string` 断言失败）

**Task 拆解（Dev）**
1. 新增序列化快照测试 `calc_response_wire_shape`：`serde_json::to_value` 后断言顶层键集合（排序后逐个比对）
2. 新增 `nan_maps_to_null_keeps_length`
3. 新增 `range_option_keys_present_as_null`
4. 新增 `engine_version_type_is_str_outer_u16_inner`
5. 同步 `docs/reference` 里的 DTO 说明（若有），不改前端类型

**完成定义 DoD**
单测通过 · 联调通过 · 产品验收 · 文档更新

---

## 附：本 Epic 卡间依赖与建议开工顺序

```
S-EP05-01 批量计算（首卡，可独立开工）
   ├─ S-EP05-02 请求内去重
   ├─ S-EP05-03 跨请求缓存 ── S-EP05-05 容量上限（唯一未实现）
   ├─ S-EP05-04 缓存键 ────────┘
   ├─ S-EP05-06 序列与批次缓存 ── S-EP05-07 质量标记
   ├─ S-EP05-08 区间解析
   └─ S-EP05-09 DTO 形状（被 EP-06 引用，须在 EP-06 冻结前完成）
```

- 建议并行度：开发者 1 做 `01→02→03→05`（缓存主线），开发者 2 做 `06→07→08→09`（数据与形状主线）；两条线在 `04` 汇合
- 前置外部依赖：`EP-03`（指标注册表 `lookup / merge_defaults / validate`）、`EP-04`（`MockProvider::daily_bars` 返回的 `BarBatch` 含 `dataset_id / dataset_generation / rows[].quality`）
- 本 Epic 完成后解锁：`EP-06` 的 DTO 冻结清单（`S-IPC-02` 等价卡）可直接引用 `S-EP05-09` 的六条 AC
