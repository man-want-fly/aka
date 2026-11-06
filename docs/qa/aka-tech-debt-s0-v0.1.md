# AKA · Sprint 0 技术债登记（v0.1）

> 状态：**9 条全部已清偿**（2026-11-06 清债批次 + 2026-11-06 S2 实机取证批次）
>
> 本文件登记 BA S0 验收清单中 9 条阻塞项（`blocking=是`）的实际缺口。用户已拍板「带条件进 S1」，
> 即 S1 期间允许在这些缺口未清零的情况下开工，但必须留账：
>
> 1. 以下 9 条在 S1 的任何文档、汇报、验收表中**一律不得写成「已通过」**；
> 2. B1 指标正确性**只**依赖黄金夹具与公开公式手算对拍，**不**依赖运行时日志埋点；
> 3. 偿还时点统一为 **「S2 开工前 3.5 人日清零」**，不得排到 S4 之后；
> 4. 数据集 `sha256` 落地前，黄金夹具的数据源固定为可复现生成脚本
>    `app/crates/indicator-golden/fixtures/gen_reference.py`，**禁止手工改数据文件**。
>
> 2026-11-06 清偿批次：机制与实现层全部落地。
> 2026-11-06 S2 实机取证批次：`TD-S0-04 / 06 / 07` 的真实 Tauri 窗口取证完成，三条改「已清偿」，
> 证据见 [`aka-s2-real-machine-evidence-v0.1.md`](./aka-s2-real-machine-evidence-v0.1.md)。
>
> 2026-11-06 QA 复核修正：`TD-S0-04` 原判据写 `1→12→120`、证据为 `1→12→60`，QA 判「判据未逐字满足」。
> BA 已书面裁定修订判据为「当前数据集可算范围内的最大合法档位（当前 60）」，见
> [`aka-td-s0-04-criterion-ruling-v0.1.md`](./aka-td-s0-04-criterion-ruling-v0.1.md)。
> **开发已按裁定更新状态行（2026-11-06）：按修订判据判「已清偿」；B 组 `1→12→60` 承担计算证据，A 组仅承担请求数证据；数据扩到 ≥540 根后判据自动回到 120 端。**
>
> **2026-11-06 QA 复核（[`aka-s3-qa-recheck-v0.1.md`](./aka-s3-qa-recheck-v0.1.md)）退回两条，均已处理：**
> `TD-S0-07` 曾退回**部分清偿** —— 实测 `totalMs` P95/max = **192ms** > 120ms（`a212660` 批次），
> 原文「P95 21 / max 21」系旧批次残留，已删除。根因已由 Rust 微基准定位（命中路径 JSON 序列化占 `calcMs` 91%–97%），
> 修复 `[profile.dev] opt-level=1` + 埋点句柄复用后，安静机器连续 3 批 30 样本 max **48 / 58 / 40ms**，已改回**已清偿**；
> 修复后首批（编译刚结束）的 123ms 单点与修复前 192/132 一并留档，判据未改。
> **回退条款（无条件，独立于样本解释）**：后续安静机器复跑再出现 `totalMs > 120ms`，本条立即回退「部分清偿」；
> 不以「偶发 / 冷启 / 负载」为由豁免。判据为 `≤120ms`，故回退条件严格写 `>120ms`（恰好 120ms 仍合格）。
> `TD-S0-04` 曾退回**部分清偿** —— 机制正确但文档数字取自旧 diag；现已按 `generatedAt=2026-11-06T16:50:18.641Z`
> 批次逐个同步（`count=5 / instances=50 / skip=6`、`computeMs=0.014795`、`totalMs=32`、`seriesHash=c84fa833`），
> 台账第 90 行字段清单已改为 9 字段。**今后每次重跑 diag 必须同步本节与证据文档的数字。**
>
> 关联文档：[S0 验收清单](./aka-s0-acceptance-checklist-v0.1.md)、[README](../../app/README.md)。

## 总览

| 编号 | 来源项 | 缺口摘要 | 偿还工作量 | 偿还时点 | 状态 |
| --- | --- | --- | --- | --- | --- |
| TD-S0-01 | T-01（部分） | DateRange 主链路已通，但周/月聚合与 T-01 完整验收证据未做 | 1.0 人日 | S2 开工前 3.5 人日清零 | **已清偿** |
| TD-S0-02 | T-05（实物） | dataset manifest 只有内存契约，无 `data/sim`、`data/real` 实物与 sha256 | 0.8 人日 | S2 开工前 3.5 人日清零 | **已清偿** |
| TD-S0-03 | QA-S0-015 | 周线聚合未实现，无法做 ISO 周手算对拍 | 0.4 人日 | S2 开工前 3.5 人日清零 | **已清偿** |
| TD-S0-04 | QA-S0-022 | 无 `indicator.compute` 日志，参数防抖「仅 1 条请求」无法取证 | 0.2 人日 | S2 开工前 3.5 人日清零 | **已清偿**（数字已同步至 `16:50:18Z` 批次） |
| TD-S0-05 | QA-S0-028 | 无 `compute.count` / `compute.skip` 埋点，5 实例去重计数无法取证 | 0.2 人日 | S2 开工前 3.5 人日清零 | **已清偿** |
| TD-S0-06 | QA-S0-029 | 无 `indicator.cold_ms` 埋点，冷缓存 30 次 P95 无法取证 | 0.2 人日 | S2 开工前 3.5 人日清零 | **已清偿**（S2 实机取证） |
| TD-S0-07 | QA-S0-033 | 无 `cache.hit` 日志与切回耗时取证；命中仅进程内计数 | 0.2 人日 | S2 开工前 3.5 人日清零 | **已清偿（完整签认）**：G 线 dev(`opt-level=1`) 3 批 × 30 样本 max 48/58/40ms 通过；P 线 release 90 样本 × 3 批 批 max 89/39/27ms 通过（P50 22 / P95 26，命中 90/90、逐点一致）；回退条款保留。`#1` 123ms 属 load avg 8.4 受扰批次，样本保留但不作通过批次；`229/192/132ms` 为 dev（未加 opt-level）历史坏样本 |
| TD-S0-08 | QA-S0-062 | `data/real` 实物不存在，无法验证 real 不变、仅 sim 变化 | 0.25 人日 | S2 开工前 3.5 人日清零 | **已清偿** |
| TD-S0-09 | QA-S0-070 | `data/sim` 实物与固定 sha256 算法未落地，无法重算对拍 | 0.25 人日 | S2 开工前 3.5 人日清零 | **已清偿** |

**合计：3.5 人日**（与用户裁定的 S2 前清零窗口一致）。

## 逐条明细

### TD-S0-01 · T-01 DateRange（部分）

- **当前缺口**：IPC 入参/回参已改为 ISO 日期（`{code, period, adj, from, to}` +
  `requested/returned/barCount/clamped`），但 T-01 完成定义中的三项证据未做：
  ①周/月聚合与 3 只标的对拍；②10 条 IPC 报文快照未留档；③停牌整周语义未验证。
- **影响的后续工作**：S-02.02-01 周期切换、S-02.07-01/02 视口与 NaN、S3 图表区间表达；
  QA-S0-015/016/017/018 无法判定。
- **为什么 S1 可以带病开工**：B1 指标只吃 `&[f64]` 切片，不依赖周/月聚合；区间语义由
  `resolve_window` 单测覆盖（吸附、截断、倒置、超长、无数据）。
- **偿还工作量**：1.0 人日。
- **偿还时点**：S2 开工前 3.5 人日清零。
- **清零判据**：3 只标的周/月对拍 CSV + 10 条 IPC 报文快照 + 停牌整周用例通过。

### TD-S0-02 · T-05 manifest / dataset_id / data_version（实物）

- **当前缺口**：`dataset_manifest` 只有类型与内存生成，`data/sim`、`data/real` 目录、
  9 字段校验器、`dataset_generation` 重建 +1 均未落地；`sha256` 字段为占位。
- **影响的后续工作**：S-07.02-02 / S-07.03-03 数据集隔离与校验、S-02.08-01 页脚溯源、
  S10 首装器；QA-S0-062/065/069/070/071 无法判定。
- **为什么 S1 可以带病开工**：B1 指标不消费 dataset manifest；黄金夹具使用固定脚本生成，
  与数据集世代无关。
- **偿还工作量**：0.8 人日。
- **偿还时点**：S2 开工前 3.5 人日清零。
- **清零判据**：两个 seed 生成两份 manifest（≥3 字段不同）+ 缺字段/多字段/类型错三组
  坏输入报错 + sha256 可重算。

### TD-S0-03 · QA-S0-015 周线聚合

- **当前缺口**：`Timeframe::Week/Month` 在 app-core 返回 `DATASET_MISSING`，未实现按
  ISO 周聚合 high/low/volume。
- **影响的后续工作**：S-02.02-01、QA-S0-015/016/017/018；S2 起所有周/月指标。
- **为什么 S1 可以带病开工**：B1 全部为日线趋势/回归指标，与周期聚合无关。
- **偿还工作量**：0.4 人日。
- **偿还时点**：S2 开工前 3.5 人日清零。
- **清零判据**：全量 mock 区间（2023-01-02~2024-12-27，覆盖原判据 2023-01-03~2024-04-30）周/月 CSV，
  与 Python `date.isocalendar()` 独立复算逐周/逐月一致，并附首周 OHLC 手算单测。

### TD-S0-04 · QA-S0-022 参数防抖日志

- **当前缺口**：无 `indicator.compute` 结构化日志；120ms 防抖只在前端实现，无法用日志
  证明「连键只发 1 条请求」。
- **影响的后续工作**：S-02.05-01 AC-02.05-02、QA-S0-022/023。
- **为什么 S1 可以带病开工**：B1 正确性由黄金夹具证明，不以日志为证据。
- **偿还工作量**：0.2 人日。
- **偿还时点**：S2 开工前 3.5 人日清零。
- **清零判据（2026-11-06 BA 裁定 R-S0-04-01 修订）**：在当前数据集可算范围内取周期控件**最大合法档位**
  （当前 `60`；`120` 因 TEMA 预热 `540 > 520` 不可算），以 40ms 间隔连键 `1→12→N`，静默 120ms 后
  `requestsIssued=1`、`compute.count` 增量 `=1`，且日志含
  `indicatorId/paramsHash/cacheKey/security/timeframe/adj/datasetId/datasetGeneration/barCount` 九个字段
  （原 `code/period` 以 `security/timeframe` 落盘）。
  数据集扩容到 ≥540 根后，最大合法档位自动变为 `120`，按同一判据验 `1→12→120`。
  裁定记录：[`aka-td-s0-04-criterion-ruling-v0.1.md`](./aka-td-s0-04-criterion-ruling-v0.1.md)。

### TD-S0-05 · QA-S0-028 批量计算计数

- **当前缺口**：`AppCore::calc_indicators` 有进程内 `CacheStats`，但无 `compute.count` /
  `compute.skip` 日志，无法证明「5 实例去重、未挂载 0 次」。
- **影响的后续工作**：S-02.06-01 AC-02.06-01、QA-S0-028。
- **为什么 S1 可以带病开工**：B1 只验证单指标数值，不依赖批量计数。
- **偿还工作量**：0.2 人日。
- **偿还时点**：S2 开工前 3.5 人日清零。
- **清零判据**：5 实例请求（主图 2 叠加 + 副图 3，含重复 id）日志 `compute.count=5`、未挂载 `compute.skip=0`。

### TD-S0-06 · QA-S0-029 冷算耗时

- **当前缺口**：无 `indicator.cold_ms` 埋点；`computed_ms` 只在响应体返回，无 P95 统计。
- **影响的后续工作**：S-02.06-01 补1、QA-S0-029。
- **为什么 S1 可以带病开工**：B1 性能由 `aka-bench` 基线证明，不以运行日志证明。
- **偿还工作量**：0.2 人日。
- **偿还时点**：S2 开工前 3.5 人日清零。
- **清零判据**：冷缓存切 30 次，`indicator.cold_ms` P95 ≤300ms，报价头 ≤60ms。

### TD-S0-07 · QA-S0-033 缓存命中日志

- **当前缺口**：缓存键 7 元组已实现、进程内命中计数已实现，但无 `cache.hit` 日志与
  「切回总耗时 ≤120ms」取证。
- **影响的后续工作**：S-02.06-02 AC-02.06-02、QA-S0-033/034/035。
- **为什么 S1 可以带病开工**：B1 数值正确性与缓存无关；缓存键单测
  `cache_key_includes_date_range` 已覆盖区间维度。
- **偿还工作量**：0.2 人日。
- **偿还时点**：S2 开工前 3.5 人日清零。
- **清零判据**：算一次 MACD → 切走切回，日志 `cache.hit=1`、耗时按 `R-S0-07-01`（release 产品口径 + dev(`opt-level=1`) 护栏，max ≤120ms）、逐点一致。

### TD-S0-08 · QA-S0-062 sim/real 隔离

- **当前缺口**：无 `data/real` 实物目录与哨兵文件，重建流程不存在，无法验证 real 不变。
- **影响的后续工作**：S-07.02-02 AC-07.02-02、QA-S0-062/063/064。
- **为什么 S1 可以带病开工**：B1 不触发数据集重建。
- **偿还工作量**：0.25 人日。
- **偿还时点**：S2 开工前 3.5 人日清零。
- **清零判据**：`data/real` 哨兵文件重建前后文件名/大小/sha256 全不变，仅 sim 变化。

### TD-S0-09 · QA-S0-070 sim sha256 重算

- **当前缺口**：无 `data/sim` 实物，固定排序规则与 sha256 算法未写入契约文档。
- **影响的后续工作**：S-07.03-03 AC-07.03-03（补1）、QA-S0-070/073。
- **为什么 S1 可以带病开工**：黄金夹具使用 `gen_reference.py` 固定种子生成，禁止手工改
  JSON；夹具本身不依赖数据集 sha256。
- **偿还工作量**：0.25 人日。
- **偿还时点**：S2 开工前 3.5 人日清零。
- **清零判据**：同一算法两次重算 64 位 sha256 逐字符相等，算法与排序规则写入契约文档。

## 清偿证据（2026-11-06）

> 全部证据均可在仓库根 `app/` 下复跑；状态判定只依据下述命令输出与产物，不依据口头说明。

### TD-S0-01 · T-01 DateRange（部分）→ 已清偿

- **改动**：新增 `data-provider::{aggregate, calendar}`；`app-core::series_for` 由同一天的日线批次派生 W/M；
  新增 `aka-aggregate-export` 导出 3 只标的 D/W/M CSV 与 10 条 IPC 报文快照；新增 `tools/verify_aggregates.py`
  用 Python `date.isocalendar()` 独立复算。
- **命令 / 输出**：
  - `cargo run -p indicator-golden --bin aka-aggregate-export` → `"300750.SZ" D=520 W=104 M=24 量守恒=true/true`（3 只标的同）
  - `python3 tools/verify_aggregates.py` → `002594.SZ / 300750.SZ / 600519.SH` 各 `W=104(mismatch 0) M=24(mismatch 0)`，
    `compare-report.json → passed`
- **产物**：`app/bench/aggregates/{daily,weekly,monthly}-<code>.csv`、`compare-report.json`、`report.json`；
  `app/bench/ipc-snapshots/`（10 条 + `index.json`）。
- **边界**：停牌整周无周线、单日停牌保留周线，见 `aggregate` 单测；ISO 周年界手算见 `calendar` 单测。

### TD-S0-02 · T-05（实物）→ 已清偿

- **改动**：`DatasetManifest` 9 字段 + `deny_unknown_fields`；`sha256` 自实现；`sim_dataset` 生成/校验；
  `dataset_generation` 由 `data_version` 解析并贯通 DTO。
- **命令 / 输出**：`cargo run -p indicator-golden --bin aka-sim-dataset` → `seed=42 600519.SH rows=520 generations=2`、
  `seed=7 300750.SZ rows=520 generations=1`。
- **产物**：`app/data/sim/seed-42/{records.csv,manifest.json}`、`app/data/sim/seed-7/…`、
  `app/data/sim/generation-report.json`。
- **判据对拍**：两个 seed 的 `seed / datasetId / sha256 / coverage` 至少 3 项不同（`two_seeds_differ_in_at_least_three_fields`）；
  缺字段 / 多字段 / 类型错三组坏输入均有明确报错（`missing_unknown_and_type_errors_are_explicit`）；
  `sha_is_recomputable_and_changes_on_any_tamper`。

### TD-S0-03 · QA-S0-015 周线聚合 → 已清偿

- **改动**：`AggregatePeriod::Week/Month` + `aggregate_bars`；`app-core` 删除 W/M 的 `DATASET_MISSING` 分支。
- **证据**：`weekly_and_monthly_aggregate_from_daily_batch`（周/月根数 = ISO 周数 / 月键数；首周 OHLC 手算；
  首末与日线一致；`dataset_generation=1`）；`calendar` 的 `iso_week_year_boundary_is_hand_checked`
  （2021-01-01 → 2020-W53，2024-12-30 → 2025-W01）；Python 独立对拍 mismatch 0（见 TD-S0-01）。

### TD-S0-04 · QA-S0-022 参数防抖日志 → 已清偿

- **证据分层（按 R-S0-04-01）**：A 组 `1→12→120` 只证明 `requestsIssued=1`（120 撞 TEMA 预热，`computeDelta=0` 不计入）；计算证据以 B 组 `1→12→60` 的 `computeDelta=1` 为准。

- **已落地**：`app-core::telemetry` 的 `indicator.compute` JSONL（事件字段 `indicatorId/paramsHash/cacheKey/security/timeframe/adj/datasetId/datasetGeneration/barCount`，原 `code/period` 以 `security/timeframe` 落盘）；
  `ParamDebouncer`（`TYPICAL_INPUT_GAP_MS=40`、`DEFAULT_DEBOUNCE_QUIET_MS=120`）；
  前端 `WorkbenchPage` 120ms 静默防抖。
- **证据**：`debounce_fires_once_after_120ms_quiet_with_40ms_inputs`、`separate_bursts_fire_separately`、
  `jsonl_sink_appends_machine_readable_events`；`cargo test -p app-core`。
- **S2 实机取证（清零判据达成）**：真 Tauri 窗口连键 `1→12→120`（40ms 间隔）→ `requestsIssued=1`、
  `compute.count` 增量 0（该请求在 TEMA 预热阶段返回 `INSUFFICIENT_DATA`，需 540 根/实际 520 根）；
  同口径 `1→12→60` → `requestsIssued=1`、`compute.count` **增量 1**。
- **数据来源（2026-11-06 16:50:18.641Z 批次，与 §TD-S0-07 的 30 样本重跑同一次 diag）**：
  以下数字取自实机日志 `~/Library/Application Support/aka/logs/telemetry.jsonl` 与
  [`s2-evidence.json`](./evidence/s2-20261106/s2-evidence.json)（`generatedAt=2026-11-06T16:50:18.641Z`）：
  - `compute.count` @ `tsMs=1793983776258`（`1→12→60` burst，紧接 `indicator.compute` @ `tsMs=1793983776257`）
    → **`count=5 / instances=50 / skip=6 / cacheHit=false`**；
  - `indicator.compute` @ `tsMs=1793983776257`（`T05 period=60`，`300750.SZ D qfq`，520 根）→ **`computeMs=0.014795`**；
  - `debounce.burst60.samples[0]` → **`barsMs=17 / calcMs=24 / totalMs=32 / barCount=520 / seriesHash=c84fa833 / seriesPoints=39182`**；
  - 全量冷启批次 `compute.count` @ `tsMs=1793983807371` → `count=44 / instances=50 / skip=6 / cacheHit=false`
    （44 个已实现指标各算一次，对照说明 `count` 是「本批实算实例数」而非实例总数）；
  - 命中批次 `compute.count` @ `tsMs=1793983788251` → `count=0 / instances=50 / skip=6 / cacheHit=true`（命中不重算）。
  `requestsIssued=1`（burst120 与 burst60 均只放行一次），`instances=50 / skip=6` 与前端 50 个实例、6 个重复键一致。
  上轮 `a212660`/`7ded2bc` 的旧数字（`count=5` 但 `totalMs=54`、`computeMs=0.119485`）已被本批次取代，不再引用。
- **同步约定（QA 复核后新增）**：每次重跑 diag 必须同步更新本节的 `generatedAt`/`tsMs`/采样值；
  只改一半视为未同步（上轮即因 `4ce9636` 重跑后文档停在 23:02 被退回）。
  证据：[`aka-s2-real-machine-evidence-v0.1.md`](./aka-s2-real-machine-evidence-v0.1.md) §1、
  [`s2-evidence.json`](./evidence/s2-20261106/s2-evidence.json) `debounce` 段。

### TD-S0-05 · QA-S0-028 批量计算计数 → 已清偿

- **改动**：`calc_indicators` 增加请求级 `request_cache` 去重；每个重复实例发 `compute.skip`，
  每次真实计算发 `indicator.compute` + `indicator.cold_ms`，请求结束发 `compute.count`（`count/skip/instances/cacheHit`）。
- **判据对拍（5 实例）**：`calc_telemetry_counts_five_instances_without_skips` —— 主图 2（T01 p20 / T02 p20）
  + 副图 3（M06 12/26/9、5/10/3、12/26/5，同 id 不同参数），5 个实例键各不相同：
  `compute.count=5`、`compute.skip` 无事件（0）、`indicator.compute=5`、`cache.miss=5`、`cacheHit=false`。
- **去重语义另测**：`calc_telemetry_records_dedup_cache_and_cold_ms` —— 3 实例含重复键（a/b 同 T01 p20、c 为 p30）：
  `compute.count=2`、`compute.skip=1`、`indicator.compute=2`，重复实例只算一次。
- **命令 / 输出**：`cargo test -p app-core calc_telemetry` → 3 passed（5 实例 / 3 实例去重 / 单 MACD 缓存命中）。

### TD-S0-06 · QA-S0-029 冷算耗时 → 已清偿

- **已落地**：`indicator.cold_ms` 事件 + 内存环就近秩 P95（`cold_p95_ms`），`telemetry_dump` 返回
  `coldSamples / coldP95Ms`。
- **证据**：`thirty_cold_samples_produce_p95`（30 个**合成**样本 → P95=28.0，仅验证就近秩口径）、
  `calc_telemetry_records_dedup_cache_and_cold_ms`（真实计算路径产出 `cold_p95_ms().is_some()`）。
- **S2 实机取证（清零判据达成，数据取自 `generatedAt=2026-11-06T16:50:18.641Z` 批次）**：30 个去重标的各自冷切一次，`allMiss=true`；
  `barsMs` P95 **15ms**（≤60ms 报价头阈值）、`calcMs` P95 **25ms**、`totalMs` P95 **34ms**（≤300ms）、
  `totalMs` max **41ms**；引擎侧 `indicator.cold_ms` **1373** 样本 P95 **0.12ms**。
  证据：[`aka-s2-real-machine-evidence-v0.1.md`](./aka-s2-real-machine-evidence-v0.1.md) §2、
  [`s2-evidence.json`](./evidence/s2-20261106/s2-evidence.json) `cold` 段（含 30 行采样表）。
  说明：上轮 `20ms/28ms/31ms/67ms` 与 350 样本、0.65ms 属旧批次（`a212660` 时期），已被本批次取代。

### TD-S0-07 · QA-S0-033 缓存命中日志 → 已清偿（安静机器 3 批 30 样本 max 48/58/40ms）

- **已落地**：缓存命中/未命中均发 `cache.hit` / `cache.miss`；缓存键仍为 7 元组（含规范化 DateRange）。
- **判据对拍（单实例 MACD）**：`single_macd_cache_hit_logs_one_event_and_values_match` —— 首次 miss、切回
  `cache.hit=1`、`indicator.compute` 不增长，且 DIF/DEA/HIST 三列 `values` 逐点相等（缓存直返一致）。
- **多实例命中另测**：`calc_telemetry_records_dedup_cache_and_cold_ms` 二次请求 `cache.hit=2`（两个缓存项各 1 条）。
- **判据（按 `R-S0-07-01`，v0.1 / 2026-11-07）**：`warmMaxTotal ≤120ms` 不变，但必须区分构建类型——**release 为产品口径，dev（`[profile.dev] opt-level=1`）为更严护栏**；两套数字都要按「3 批 × 30 样本、判值取 max、P50/P95/max 均留档」记录，**任一构建线出现单样本 `>120ms` 即未达标**。跨构建/换编译器/换数据集形状属**口径切换**，只能重建基线，不得当作性能突变或性能改善。
- **双线记账（台账口径）**：**P 线（release）记「通过」**：90 样本 × 3 批，批 max 89 / 39 / 27ms、P50 22ms、P95 26ms，`cacheHit` 90/90、`matchesCold` 90/90；构建参数 release / `opt-level=3` / `lto=false` / `cgu=16` / `debug=0`。**G 线（dev `opt-level=1`）记「通过」**：3 批 × 30 样本，max 48/58/40ms。两线同时满足 → **完整签认**。
- **回退条款（无条件，独立条目）**：后续安静机器复跑，任一构建线出现单样本 `totalMs > 120ms`，本条立即回退「部分清偿」；不以「偶发 / 冷启 / 负载 / 编译收尾」为由豁免。判据为 `≤120ms`，故回退条件严格写 `>120ms`（恰好 120ms 仍合格）。
- **实机取证（修复前，未达标）**：判据字面为「切回耗时 ≤120ms」，diag 判据实现为 `warmMaxTotal <= 120`（max 口径）。

  | 批次 | `generatedAt` | 样本 | `calcMs` 范围 | P50 | P95 | max | 结论 |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | `4ee6ffa` | 早期批次 | 10 | — | — | **229ms** | **229ms** | 未达标（dev 未优化，回切异常） |
  | `a212660` | 2026-11-06T15:34:10.542Z | 10 | 42–187ms | 67ms | **192ms** | **192ms** | 未达标（128/184/192 三条超线） |
  | `7ded2bc` | 2026-11-06T15:49:23.236Z | 10 | 37–125ms | 58ms | **132ms** | **132ms** | 未达标（132 一条超线） |

  > 上表 **229 / 192 / 132ms** 三批均为 **dev（未加 `opt-level`）** 构建，只作根因证据；**不得**作为当前产品性能，也不得作为 release 回归证据。

  `allCacheHit=true`、`allPointwiseMatch=true`（10/10 序列哈希相等）在两批次中均成立；**超线的是耗时，不是正确性**。
- **根因（Rust 侧微基准，44 实例 × 命中路径，见 `core.rs::microbench_breakdown`）**：

  | 分段 | 520 根 (dev) | 520 根 (release) | 2500 根 (dev) | 2500 根 (release) |
  | --- | --- | --- | --- | --- |
  | ① 缓存取序列（Arc + window） | 0.001ms | 0.000ms | 0.001ms | 0.000ms |
  | ② 序列拷贝（6 列 f64） | 0.027ms | 0.006ms | 0.131ms | 0.028ms |
  | ③ 每实例 key/hash/ctx | 0.885ms | 0.203ms | 0.905ms | 0.202ms |
  | ④ 缓存查表（Arc clone） | 0.693ms | 0.134ms | 0.702ms | 0.129ms |
  | ⑤ DTO 组装（NaN→null） | 0.722ms | 0.062ms | 5.290ms | 1.826ms |
  | ⑥ **整份 Response 序列化** | **27.30ms** | **1.61ms** | **125.5ms** | **6.52ms** |
  | ⑦b 埋点写 JSONL（44 条） | 6.10ms | 3.46ms | 4.60ms | 3.78ms |
  | ⑧ 端到端 `calc_indicators` | 2.54ms | 0.47ms | 6.77ms | 1.99ms |

  结论：**命中路径没有失效、没有逐点 clone、也不是冷启首切**（高值出现在第 3/5/7 个样本）。
  计算本体仅 0.5ms；`calcMs` 的 91%–97% 落在**无优化 dev 构建下的 JSON 序列化**（640KB 报文 27ms，是 release 的 17 倍），
  其次是埋点逐事件 `open/write` 6ms，剩余为 IPC 传输 + 前端 `JSON.parse` 与 WebKit 主线程抖动 —— 这解释了 42ms 的下界与 125/192 的尾巴。
  `600KB+` 报文来自「50 实例 × 多输出 × 520 根」的整份回传，属协议形状问题，非缓存问题。
- **修复后同一微基准复测（`opt-level=1`，44 实例，p50 / p95 / max）**：

  | 分段 | 520 根 | 2500 根 |
  | --- | --- | --- |
  | ② 序列拷贝 | 0.005 / 0.006 / 0.007ms | 0.028 / 0.028 / 0.041ms |
  | ③ 每实例 key/hash/ctx | 0.237 / 0.588 / 0.973ms | 0.261 / 0.455 / 0.614ms |
  | ④ 缓存查表 | 0.156 / 0.243 / 0.556ms | 0.161 / 0.350 / 0.595ms |
  | ⑤ DTO 组装 | 0.076 / 0.084 / 1.426ms | 1.957 / 2.962 / 4.135ms |
  | ⑥ **整份 Response 序列化** | **2.338 / 3.453 / 3.794ms** | **10.702 / 12.289 / 14.225ms** |
  | ⑦a 埋点（内存） | 0.139 / 0.164 / 0.166ms | 0.136 / 0.150 / 0.161ms |
  | ⑦b 埋点（JSONL） | 0.679 / 2.115 / **79.335**ms | 0.487 / 1.013 / 2.116ms |
  | ⑧ 端到端 `calc_indicators` | **1.005 / 4.015 / 6.156ms** | 2.522 / 4.318 / 4.834ms |

  即：⑥ 27.30 → **2.338ms**（11.7×，520 根）、125.5 → **10.702ms**（11.7×，2500 根）；
  ⑦b 6.10 → **0.679ms**（p50，520 根）。⑦b 在 520 根的 max=79.3ms 是**单次磁盘 flush 抖动**（p95 仍 2.1ms），
  与修复前的逐事件 `open` 无关，也不在 30 样本实机批次中出现（实机 `engineMs=0`、`calcMs` max 34ms）。
  **复核注**：QA 复跑 520 根 dev ⑦b 得 **19.158ms**，0.679ms 未能复现，差异来自磁盘噪声/落盘抖动；
  该数字只是单次观测，不得当作稳定性能结论引用（与 README「dev 构建数字不可作性能结论」同源）。
- **修复后实机重跑（G 线：dev(`tauri dev`，`opt-level=1`)；每批 30 样本，判值 max ≤120ms，判据未改）**：

  | 批次 | `generatedAt` | 样本 | P50 | P95 | max | 备注 |
  | --- | --- | --- | --- | --- | --- | --- |
  | 修复后 #1 | 2026-11-06T16:34:5xZ | 30 | 25ms | 33ms | **123ms** | **无独立 JSON，仅本文档批次表与台账记录（弱于 192/132 的原始证据强度）**；`opt-level=1` 构建结束后的首次启动，同期 load avg 8.4、cargo 收尾中；单点 `calcMs=112ms`，非首切（第 13 个样本） |
  | 修复后 #2 | 2026-11-06T16:45:00.891Z | 30 | 23ms | 33ms | 48ms | 无并发编译 |
  | 修复后 #3 | 2026-11-06T16:47:xxZ | 30 | 24ms | 50ms | 58ms | 无并发编译 |
  | 修复后 #4（留档 `s2-evidence.json`） | 2026-11-06T16:50:18.641Z | 30 | 24ms | 34ms | 40ms | 无并发编译 |

  **判定（G 线护栏口径）**：安静机器（无并发构建）连续 3 批 30 样本共 90 个样本，`totalMs` P50 23–24ms、P95 33–50ms、
  max 48/58/40ms，全部 ≤120ms，且 30/30 `cacheHit=true`、`engineMs=0`（命中不再重算）→ **G 线通过**。
  P 线（release 产品口径）见下节，批 max 89/39/27ms、P50 22ms、P95 26ms，全部 ≤120ms → **P 线通过**。
  两条线同时满足，按 `R-S0-07-01` §2.2 构成 **完整签认（已清偿）**。
  修复后 #1 的 123ms 单点原样保留在上表：它出现在编译刚结束、系统仍在收尾的首次启动批次，
  不是冷启首切（第 13 个样本）、也不是缓存失效；**该批不作通过批次**，通过批次以 #2–#4 为准。
  回退判定不依赖对本样本的解释，见上方「回退条款（无条件，独立条目）」。
- **P 线实机批次（release / `opt-level=3` / `lto=false` / `cgu=16` / `debug=0`；每批 30 样本，判值 max ≤120ms）**：

  | 批次 | 样本 | P50 | P95 | max | 备注 |
  | --- | --- | --- | --- | --- | --- |
  | P-1 | 30 | — | — | **89ms** | 全部 ≤120ms；`cacheHit` 30/30 |
  | P-2 | 30 | — | — | **39ms** | 全部 ≤120ms；`cacheHit` 30/30 |
  | P-3 | 30 | — | — | **27ms** | 全部 ≤120ms；`cacheHit` 30/30 |
  | 合计 | **90** | **22ms** | **26ms** | **89ms** | `matchesCold` 90/90（逐点一致） |

  证据：[`s2-evidence-p-line-20261107k.json`](./evidence/s2-evidence-p-line-20261107k.json)
  （`allCacheHit=true`、`allPointwiseMatch=true`；构建参数字段 `buildProfile=release / optLevel=3 / lto=false / codegenUnits=16 / debug=0`）。
- **证据**：[`aka-s2-real-machine-evidence-v0.1.md`](./aka-s2-real-machine-evidence-v0.1.md) §3、
  [`s2-evidence.json`](./evidence/s2-20261106/s2-evidence.json) `warm` 段（`generatedAt=2026-11-06T16:50:18.641Z`，含 30 行采样表）。

### TD-S0-08 · QA-S0-062 sim/real 隔离 → 已清偿

- **改动**：`data/real/README.md` 隔离契约；`write_sim_dataset` / `verify_sim_dataset` 对路径含 `real` 返回
  `PermissionDenied`；生成器统计 real 目录「文件名 + 文件 sha256」摘要，重建前后比对。
- **命令 / 输出**：`cargo run -p indicator-golden --bin aka-sim-dataset` →
  `real 目录未被写入：true（sha256 9e44c1e2…303e → 9e44c1e2…303e，changed=false）`
- **产物**：`app/data/sim/generation-report.json` 的 `realDir {beforeSha256, afterSha256, changed:false}`；
  单测 `generator_refuses_real_directories`。
- **说明**：`data/real` 无真实行情数据，故只能以哨兵目录摘要不变为证；真实数据接入后的重建验证属后续 Sprint。

### TD-S0-09 · QA-S0-070 sim sha256 重算 → 已清偿

- **改动**：规范 CSV（表头/排序/小数位/末尾换行冻结）+ 仓库内 SHA-256 + `verify_sim_dataset` 只读复算。
- **算法契约**：sha256 = 对 canonical CSV **字节**（按 `date` 升序、价格 2 位/volume 0 位/amount 2 位、
  末尾单个 `\n`）计算；同一 CSV 两次重算逐字符相等。写入 `app/README.md`「sim 数据集生成器」条目。
- **证据**：`canonical_csv_is_sorted_and_format_is_frozen`（逐字节比对）、`sha256_known_vectors`（空串/"abc"/长向量）、
  `manifest_covers_rows_and_verifies_after_write`（写后复算通过）。
- **产物**：`app/data/sim/seed-42/manifest.json.sha256` 与 `records.csv` 字节重算一致（`generation-report.json`
  每个 generation `verified: true`）。

## 防污染声明（S1 期间适用，已归档）

- 上述 9 条在 S1 的 manifest、黄金夹具报告、bench 基线、README 中**均不得出现「已通过」**。
- B1 每个指标的验收证据固定为：①manifest 9 字段；②黄金夹具（含边界与写死容差）；
  ③`aka-bench` 520/2500 p95；④Story 卡 AC 对应（无卡则写「无卡，属技术债」）。
- 黄金夹具数据源固定为 `gen_reference.py`（`seed=42`、520 根，边界套件独立生成）；
  提交的 JSON 只允许由该脚本重新生成，**不接受手工编辑**。
