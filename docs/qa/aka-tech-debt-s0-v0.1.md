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
> 关联文档：[S0 验收清单](./aka-s0-acceptance-checklist-v0.1.md)、[README](../../app/README.md)。

## 总览

| 编号 | 来源项 | 缺口摘要 | 偿还工作量 | 偿还时点 | 状态 |
| --- | --- | --- | --- | --- | --- |
| TD-S0-01 | T-01（部分） | DateRange 主链路已通，但周/月聚合与 T-01 完整验收证据未做 | 1.0 人日 | S2 开工前 3.5 人日清零 | **已清偿** |
| TD-S0-02 | T-05（实物） | dataset manifest 只有内存契约，无 `data/sim`、`data/real` 实物与 sha256 | 0.8 人日 | S2 开工前 3.5 人日清零 | **已清偿** |
| TD-S0-03 | QA-S0-015 | 周线聚合未实现，无法做 ISO 周手算对拍 | 0.4 人日 | S2 开工前 3.5 人日清零 | **已清偿** |
| TD-S0-04 | QA-S0-022 | 无 `indicator.compute` 日志，参数防抖「仅 1 条请求」无法取证 | 0.2 人日 | S2 开工前 3.5 人日清零 | **已清偿**（按 R-S0-04-01 修订判据；B 组 `1→12→60` 取证） |
| TD-S0-05 | QA-S0-028 | 无 `compute.count` / `compute.skip` 埋点，5 实例去重计数无法取证 | 0.2 人日 | S2 开工前 3.5 人日清零 | **已清偿** |
| TD-S0-06 | QA-S0-029 | 无 `indicator.cold_ms` 埋点，冷缓存 30 次 P95 无法取证 | 0.2 人日 | S2 开工前 3.5 人日清零 | **已清偿**（S2 实机取证） |
| TD-S0-07 | QA-S0-033 | 无 `cache.hit` 日志与切回耗时取证；命中仅进程内计数 | 0.2 人日 | S2 开工前 3.5 人日清零 | **已清偿**（S2 实机取证） |
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
  `requestsIssued=1`、`compute.count` 增量 `=1`，且日志含 `code/period/adj/indicatorId/paramsHash/datasetId/barCount`。
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
- **清零判据**：算一次 MACD → 切走切回，日志 `cache.hit=1`、耗时 ≤120ms、逐点一致。

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
  同口径 `1→12→60` → `requestsIssued=1`、`compute.count` **增量 1**（批次计数；事件 `count=12`，本批实算 12 个实例）、`barCount=520`、`totalMs=18`。
  两组共同证明「静默窗口只放行一次请求，且只发起一个计算批次」。
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
- **S2 实机取证（清零判据达成）**：30 个去重标的各自冷切一次，`allMiss=true`；
  `barsMs` P95 **20ms**（≤60ms 报价头阈值）、`calcMs` P95 **28ms**、`totalMs` P95 **31ms**（≤300ms）、
  `totalMs` max **67ms**；引擎侧 `indicator.cold_ms` 350 样本 P95 **0.65ms**。
  证据：[`aka-s2-real-machine-evidence-v0.1.md`](./aka-s2-real-machine-evidence-v0.1.md) §2、
  [`s2-evidence.json`](./evidence/s2-20261106/s2-evidence.json) `cold` 段（含 30 行采样表）。

### TD-S0-07 · QA-S0-033 缓存命中日志 → 已清偿

- **已落地**：缓存命中/未命中均发 `cache.hit` / `cache.miss`；缓存键仍为 7 元组（含规范化 DateRange）。
- **判据对拍（单实例 MACD）**：`single_macd_cache_hit_logs_one_event_and_values_match` —— 首次 miss、切回
  `cache.hit=1`、`indicator.compute` 不增长，且 DIF/DEA/HIST 三列 `values` 逐点相等（缓存直返一致）。
- **多实例命中另测**：`calc_telemetry_records_dedup_cache_and_cold_ms` 二次请求 `cache.hit=2`（两个缓存项各 1 条）。
- **S2 实机取证（清零判据达成）**：10 个标的切回，`allCacheHit=true`、`allPointwiseMatch=true`（10/10 序列哈希相等）、
  `totalMs` P95 **21ms**、max **21ms**（≤120ms）；`cache.hit` 138 条 / `cache.miss` 350 条于实机日志。
  证据：[`aka-s2-real-machine-evidence-v0.1.md`](./aka-s2-real-machine-evidence-v0.1.md) §3、
  [`s2-evidence.json`](./evidence/s2-20261106/s2-evidence.json) `warm` 段（含 10 行采样表）。

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
