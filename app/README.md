# AKA · A 股桌面分析工作台（MVP 骨架）

macOS 单机、离线、免费、无账户的 A 股分析工作台骨架。技术栈：**Tauri 2 + React 18 + TypeScript + Vite**，指标引擎为 **Rust workspace**（无 Python sidecar、无本地 HTTP 端口）。

> 当前行情全部为 **mock 模拟数据**，界面已固定标注「模拟数据 · 非真实行情」。本仓库只搭骨架，不含投资建议，也未接入任何真实行情。

## 目录

```text
app/
├─ Cargo.toml                 # Rust workspace（6 个成员）
├─ package.json               # 前端脚本与依赖
├─ vite.config.ts  tsconfig.json  index.html
├─ manifest/indicators.json   # 指标 manifest（单一事实来源；S1 扩到 11 条 / S2 扩到 31 条）
├─ bench/baselines/           # 性能基线（macos-<arch>.json，S0 建立 / S2 扩到 31 指标 × 2 档）
├─ bench/reports/             # golden-report.json + golden-report.md（S0 债务清偿新增）
├─ bench/aggregates/          # 周/月聚合 CSV + Python 独立对拍报告（S0 债务清偿新增）
├─ bench/ipc-snapshots/       # 10 条 IPC 报文快照（S0 债务清偿新增）
├─ data/sim/                  # sim 数据集实物（seed-42 / seed-7 + generation-report.json）
├─ data/real/                 # 真实数据目录（当前仅隔离契约说明，无行情数据）
├─ tools/verify_aggregates.py # 聚合独立对拍脚本（S0 债务清偿新增）
├─ src/                       # 前端
│  ├─ main.tsx  App.tsx       # 入口 · 主题状态
│  ├─ app/AppShell.tsx        # 左侧 rail 与导航（hash 路由：#/workbench、#/catalog）
│  ├─ pages/workbench/        # 工作台页（D/W/M 周期、参数防抖、实机诊断入口）
│  ├─ pages/catalog/          # P4 指标口径页（B1 已实现 11 个）
│  ├─ features/workbench/     # 参数模型 / 实例组装 / 本地预校验 / diag.ts（S2 实机取证）
│  ├─ components/             # K 线图、自选列表、参数面板、模拟徽标
│  ├─ lib/                    # ipc.ts（唯一 invoke 出口）、types.ts、theme.ts、format.ts
│  └─ styles/                 # tokens.css（深/浅/红涨绿跌）、app.css
├─ src-tauri/                 # crate `aka-desktop`：Tauri 壳 + 命令层
│  ├─ tauri.conf.json  build.rs  capabilities/default.json
│  ├─ icons/                  # 构建必需（icon.png / icon.icns）
│  └─ src/main.rs  lib.rs  commands.rs  state.rs
└─ crates/
   ├─ app-core/               # 编排、缓存、DTO、错误映射
   ├─ indicator-core/         # 注册表 + ParamSpec + manifest 加载 + B1 数值内核（EMA/Wilder/滚动/OLS）
   ├─ data-provider/          # DataProvider trait + MockProvider + Tushare 骨架 + 数据集 manifest 契约
   ├─ data-store/             # Candle 模型 + 内存 CandleStore + state.db（SQLite）
   └─ indicator-golden/       # 黄金夹具 + 性能基线 bin（dev-only）

../.github/workflows/ci.yml   # macOS CI：cargo check / cargo test / tsc / vite build / golden
```

架构图（上一阶段产物）：

- [`../docs/architecture/aka-project-architecture.html`](../docs/architecture/aka-project-architecture.html)
- [`../docs/architecture/aka-module-architecture.html`](../docs/architecture/aka-module-architecture.html)

## 启动

```bash
cd app
npm install
npm run tauri dev        # 需要 Rust 工具链；会自动起 Vite(1420) 并编译 Tauri
```

只验证前端（不打开窗口）：

```bash
npm run build            # tsc --noEmit && vite build
```

Rust：

```bash
cargo check --workspace --all-targets
cargo test --workspace --exclude aka-desktop
cargo test -p indicator-golden -- --nocapture   # 黄金夹具，失败会报首个偏差下标
cargo run --release -p indicator-golden --bin aka-bench   # 性能基线
cargo run -p indicator-golden --bin aka-golden-report     # 机读 golden-report（bench/reports/）
cargo run -p indicator-golden --bin aka-sim-dataset       # sim 数据集 + manifest（data/sim/）
cargo run -p indicator-golden --bin aka-aggregate-export  # 周/月聚合 CSV + 10 条 IPC 快照
python3 tools/verify_aggregates.py                        # Python 独立复算周/月聚合并逐行对拍
AKA_DIAG=1 npm run tauri dev                              # S2 实机取证（落盘 diag/s2-evidence.json）
```

CI（`.github/workflows/ci.yml`，macOS runner）按顺序执行：`cargo check --workspace --all-targets` →
`cargo test --workspace --exclude aka-desktop` → `cargo test -p indicator-golden` →
`npm ci` → `npx tsc --noEmit` → `npm run build` → 校验 `dist/index.html`。任一步失败即为红灯。

打包（未签名，仅本地验证）：

```bash
npm run tauri build
```

## 已实现（骨架 + Sprint 0 地基）

- **一条完整链路**：`MockProvider → app-core → indicator-core → Tauri IPC → React 工作台`。
- **mock 数据源**：120 只标的（含 14 只知名标的与 3 个指数）× 520 根工作日日线，确定性随机（xorshift64*），部分标的含 2:1 拆分；支持 `none / qfq / hfq`，每根 K 线带 `source` 与 `quality` 标记。
- **DateRange（S0-1）**：IPC `get_bars` / `calc_indicators` 的 `from` / `to` 为 ISO 日期（`YYYY-MM-DD`），返回 `range: {requestedFrom, requestedTo, returnedFrom, returnedTo, barCount, clamped}`；不再接受序列下标。规则：`from` 吸附其后第一根、`to` 吸附其前最后一根；未来 `to` 截断并 `clamped=true`；`from > to` / 超 3660 天 / 超 2500 根 → `INVALID_ARGUMENT`；区间无数据或起点晚于最新 → `INSUFFICIENT_DATA`；非法日期 → `INVALID_ARGUMENT`（`details.field`）。
- **周/月聚合 + 交易日历（S0 债务清偿）**：`data-provider::{aggregate, calendar}` 提供 ISO-8601 周（周一为起点、周四定年份）与自然月分组；`app-core` 由**同一份缓存的日线批次**派生 W/M（open 首根、high 最大、low 最小、close 末根、volume/amount 求和、date 取区间末交易日、quality 并集），整周停牌不产生周线；`TradingCalendar` 提供 `contains / is_trading_day / between / first_on_or_after / last_on_or_before / natural_week_count`。独立对拍见 `bench/aggregates/compare-report.json`（3 只标的 × W/M，mismatch 0）。
- **指标引擎（S1 / B1 + S2 / B2）**：静态注册表 **31 个指标**（B1 11 + B2 20）+ `ParamSpec` 校验；id 统一为 PRD 编号
  **T01 SMA / T02 EMA / T03 WMA / T04 DEMA / T05 TEMA / T19 LinReg Forecast / T20 Intercept /
  T21 R² / T22 Slope / E13 BIAS(6/12/24)**，存量 **M06 MACD**；旧 `ma` → `T01`、`macd` → `M06`
  保留 alias 一版。数值内核在 `indicator-core::kernels`（SMA/滚动求和、EMA 以 SMA 为种子、
  Wilder RMA、WMA、中心化 OLS、BIAS），统一 `&[f64]` 输入、`NaN` 缺失、唯一入口
  `Indicator::calc(&OhlcvView, &Params, &mut [Vec<f64>])`；NaN 在 DTO 边界转 `null`。
- **B2 通道/波动 20 指标（S2）**：`T08 均线包络 / T09 布林带 / T10 肯特纳 / T11 唐奇安 / T12 ATR 通道 /
  T13 ATR 移动止损 / T14 吊灯止损 / T15 一目均衡 / T16 抛物线转向 / T23 轴心点 / T24 最高最低 /
  V01 真实波幅均值 / V02 归一化 ATR / V03 标准差 / V04 布林带宽 / V05 布林 %B / V07 溃疡指数 /
  V08 GAPO 跳空 / V09 振幅 / V10 真实波幅`。其中 **T13 / T15 / T16 / T23 / T24 / V08 为 beta**
  （口径自定或待人工校对，manifest `specStatus=partial`），口径见
  [`../docs/qa/aka-b2-ac-evidence-v0.1.md`](../docs/qa/aka-b2-ac-evidence-v0.1.md) §4。
  B2 只进引擎与黄金/性能，**未进工作台 UI**，且 **无 Story 卡**（AC 待 BA 分配）。
- **缓存键（S0 裁定）**：7 元组 `数据集版本 + 标的 + 周期 + 复权 + 指标 id + 参数 + DateRange`，DateRange 用规范化后的 `returnedFrom~returnedTo` 参与键；前缀 `v2|`，**不保留旧 6 元组键**。
- **6 类运行埋点（S0 债务清偿）**：`app-core::telemetry` 以 JSONL 落盘（`~/Library/Application Support/aka/logs/telemetry.jsonl`）+ 4096 条内存环；事件 `indicator.compute`（含 `code/period/adj/indicatorId/paramsHash/cacheKey/datasetId/barCount`）、`compute.count` / `compute.skip`（请求级去重，重复实例计 skip）、`cache.hit` / `cache.miss`、`indicator.cold_ms`（就近秩 P95，上限 5000ms）、`param.debounce`（`TYPICAL_INPUT_GAP_MS=40`、`DEFAULT_DEBOUNCE_QUIET_MS=120`）。前端工作台已按 120ms 静默防抖发请求；`telemetry_dump` 返回 `{path, total, counts, coldSamples, coldP95Ms, recent}`。
- **机读 golden-report（S0 债务清偿）**：`aka-golden-report` 输出 `bench/reports/golden-report.json`（`formatVersion/generatedAtUnix/total/passed/failed/result/indicators/suites/failures`）与同名 `.md`，失败时进程退出码 1，可直接进 CI。
- **sim 数据集生成器最小闭环（S0 债务清偿）**：`data-provider::sim_dataset` 固定规范 CSV（`date,open,high,low,close,volume,amount`，升序、2/0/2 位小数）→ `sha256`（仓库内自实现，已知向量测试）→ `manifest.json` 9 字段；`verify_sim_dataset` 只读复算行数与摘要，不改写；`data_version = v<N>` 经 `DatasetManifest::generation()` 解析为 `dataset_generation`，已贯通 `BarBatch → CandleSeries → ProvenanceDto / CalcResponse`（前端类型同步）；目录隔离：只写 `data/sim/seed-<n>/`，路径含 `real` 直接 `PermissionDenied`。实物见 `data/sim/` 与 `generation-report.json`（含 real 目录重建前后 sha256 比对）。**sha256 算法定义**：对 canonical CSV 的**字节**计算（按 `date` 升序；价格 2 位、volume 0 位、amount 2 位；末尾单个 `\n`），同一 CSV 两次重算逐字符相等，外部复算者可直接对 `records.csv` 取摘要。
- **IPC 8 条命令**：`list_securities`、`get_bars`、`indicator_registry`、`indicator_manifest`、`calc_indicators`、`telemetry_dump`、`diag_enabled`、`diag_write`（后两条仅 `AKA_DIAG=1` 时启用以落盘实机取证）；错误统一为 `{ code, message, retryable, details }`。
- **指标 manifest（S0-5 / S1 / S2）**：`app/manifest/indicators.json` 为目录唯一事实来源（id / 显示名 / 分类 / 参数 spec / 默认值与上下界 / 公式引用 / 版本 / normal|beta / 单位 / 口径说明），`include_str!` 编译期嵌入；**31 条**；注册表 `meta()` 由 manifest 派生，并有逐字段一致性测试（含 alias 冲突、单位与口径必填）；前端通过 `indicator_manifest` 生成指标目录。
- **state.db（S0-4）**：`~/Library/Application Support/aka/state.db`，rusqlite（bundled SQLite）；`PRAGMA user_version` + `schema_versions` 表版本化，前滚脚本 `migrations/001_init.sql` 与回滚脚本 `001_init_rollback.sql`；WAL；8 张业务表（`settings`、`view_state`、`watchlist_groups`、`watchlist_items`、`favorites`、`chart_layout`、`indicator_params`、`dataset_meta`）。打开时 `PRAGMA quick_check` 检坏库，坏库隔离为 `state.db.corrupt-<ts>` 并回退内存库（`degraded=true`，写失败 `retryable=true`）。
- **黄金夹具（S0-3 / S1 / S2）**：固定 JSON 基线（Python 公开公式独立手算，不回算 Rust 引擎），`seed=42 / 520 根`；B1 覆盖 T01–T05、T19–T22、E13、M06 共 11 指标，B2 追加 T08–T16、T23、T24、V01–V05、V07–V10 共 20 指标；合计 **12 套夹具、130 个 case**（B2 部分 76 个：`base_b2_channel_seed42_520` 20 / `edge_b2_constant_ohlc` 20 / `edge_b2_first_bar` 20 / `edge_b2_insufficient` 16）；缺基线时显式失败并提示生成命令；偏差报告含 case / output / bar index。数据源固定为 `fixtures/gen_reference.py`，禁止手工改 JSON。
- **容差口径（B 组修复后冻结）**：T21 `absolute:1e-6`；E13 / M06 与 B2 无量纲/比率类（V02 V04 V05 V07 V08）`absolute:1e-4`；T24 极值直取 `absolute:1e-9`；其余 `relative:1e-6`；仅手算类夹具（`edge_manual_nonlinear` / `edge_arithmetic_regression`）允许单 case 收紧到 `absolute:1e-9`，**不允许放宽**。`tolerance_rules_are_frozen` 锁定该映射，`tolerance_parsing_semantics` 锁定解析语义；文档同口径见 [`../docs/indicators/b1-trend-kernels.md`](../docs/indicators/b1-trend-kernels.md)。
- **性能基线（S0-6 / S1 / S2）**：`cargo run --release -p indicator-golden --bin aka-bench`，固定种子合成 520 / 2500 根，记录 p50 / p95 / max 与 peak RSS，输出 `app/bench/baselines/macos-<arch>.json`（含 CPU、rustc、profile、engineVersion 与阈值）。**31 指标 × 2 规模 = 62 项**（B2 占 40 项），全 pass；阈值沿用 S0：520 根 p95 ≤ 1.0ms，2500 根 p95 ≤ 8.0ms（B2 最大者为 T15 的 1.047ms）。
- **CI（S0-2）**：`.github/workflows/ci.yml`（macOS runner）串行跑 cargo check / cargo test / golden / `npm ci` / tsc / vite build，任一失败即红。
- **工作台（S2 扩）**：自选列表、**D / W / M 周期切换**（切换即换缓存键，W/M 走「先复权后聚合」）、K 线 + 8 条指标叠加（T01 T02 T03 T04 T05 T19 T20 T22）+ 成交量 + MACD（M06）副图、读数条（T21 R² / E13 三条 BIAS，带单位）、EMA/DEMA/TEMA 预热提示、参数修改（120ms 静默防抖）、日期区间选择、深/浅/跟随系统主题、红涨绿跌切换、模拟数据标识与状态栏。
- **P4 指标口径页（S2）**：路由 `#/catalog`，收录 B1 已实现的 11 个指标，每项四段（公式 / 参数 / 预热 / 边界）+ beta 徽标；页面为应用内真实 React 路由，不是 Markdown 文档。
- **S2 实机取证（S2）**：`AKA_DIAG=1` 启动后前端自跑诊断，经真实 IPC 采样并落盘 `~/Library/Application Support/aka/diag/s2-evidence.json`；覆盖防抖、冷切 30 次、切回缓存、W/M、渲染层 DOM、口径页 DOM。取证报告见 [`../docs/qa/aka-s2-real-machine-evidence-v0.1.md`](../docs/qa/aka-s2-real-machine-evidence-v0.1.md)。

## 未实现（后续 Sprint 边界）

- 分钟线与更细周期；停牌整周语义已在聚合层实现并有单测。M 周期下 24 根月线不足以满足多数指标预热（实机只取证到行情层聚合）。
- 其余 74 个规划指标（当前已实现 **31 / 105**）；B2 的 20 个指标**已进引擎但未进 UI**，且**无 Story 卡**；B2 口径页待 BA 排期。
- Story 卡缺口：B2 20 个指标未入库，AC 待 BA 分配；不得以 B1 的 `AC-03.04-xx` 或渲染层 AC 充当 B2 证据。
- 真实数据源：tushare 仅接口骨架（默认不可用）、baostock/akshare 仅有占位；无网络层。`data/real` 目录隔离契约与 sim sha256 复算已落地，但 real 侧仍无行情数据，无法验证真实数据的重建不变性。
- state.db 只接了打开/迁移/仓储与 `AppCore` 注入，尚未接任何 UI 持久化（主题、自选仍只在前端内存）。
- 数据集生成器只完成最小闭环（固定规范 CSV + manifest + sha256 + 目录隔离）；Parquet 分区、增量重建与 real 采集链路未做。
- 其余页面（行情列表、设置、诊断包导出等）、自选持久化、更新通道、代码签名与公证。
- 打包图标为脚本生成的占位图，发布前需替换为正式设计资产。

### 登记在案的未结项（不得写成已覆盖）

| 编号 | 未结项内容 | 归属 | 当前状态 |
| --- | --- | --- | --- |
| `TD-B1-02` | T04/T05、T19–T22、E13 未进入工作台，渲染层证据无法取证 | E-02 / S2 前端 | **已实现，待 BA 评估**（渲染层 DOM 断言已产出） |
| `TD-B1-03` | P4 指标口径页未实现，`S-03.03-01` 全部 AC 未结项 | E-03 / F-03.03 | **已实现，待 BA 评估**（`#/catalog` 已落地 11 项四段口径） |

> S2 已补齐上述两项的代码与实机取证；**是否结项由 BA/QA 判定，开发方不下结论**。
> 证据：[`../docs/qa/aka-s2-real-machine-evidence-v0.1.md`](../docs/qa/aka-s2-real-machine-evidence-v0.1.md) §5 / §6；
> 对账状态：[`../docs/qa/aka-b1-card-reconciliation-v0.1.md`](../docs/qa/aka-b1-card-reconciliation-v0.1.md) §8。

## 技术债（S0 9 条：**9 条已清偿**）

2026-11-06 清债批次按 [`../docs/qa/aka-tech-debt-s0-v0.1.md`](../docs/qa/aka-tech-debt-s0-v0.1.md)
逐条偿还；机制与实现层全部落地；`TD-S0-04 / 06 / 07` 的三条实机判据由 S2 真 Tauri 窗口取证补齐，
三条已改「已清偿」（证据见 [`../docs/qa/aka-s2-real-machine-evidence-v0.1.md`](../docs/qa/aka-s2-real-machine-evidence-v0.1.md)）。

| 编号 | 状态 | 证据（命令 / 产物） |
| --- | --- | --- |
| TD-S0-01 | 已清偿 | `aka-aggregate-export` → `bench/aggregates/*.csv` + `bench/ipc-snapshots/`（10 条）；`python3 tools/verify_aggregates.py` → `compare-report.json` passed（3 标的 W/M mismatch 0） |
| TD-S0-02 | 已清偿 | `data/sim/seed-42` 与 `seed-7` 两份 manifest；`dataset_manifest` 单测 `two_seeds_differ_in_at_least_three_fields`、`missing_unknown_and_type_errors_are_explicit`；`sim_dataset` 单测 `sha_is_recomputable_and_changes_on_any_tamper` |
| TD-S0-03 | 已清偿 | `calendar` / `aggregate` 单测（ISO 周年界、周一为起点、整周停牌无周线）；`weekly_and_monthly_aggregate_from_daily_batch` |
| TD-S0-04 | 已清偿 | 机制：`Telemetry` JSONL + `ParamDebouncer` + 前端 120ms 防抖；实机 `1→12→120` 只发 **1** 次请求、`1→12→60` 的 `compute.count` **+1** |
| TD-S0-05 | 已清偿 | `calc_telemetry_counts_five_instances_without_skips`：5 实例 → `compute.count=5 / skip=0 / cache.miss=5`；`calc_telemetry_records_dedup_cache_and_cold_ms` 另测重复键 → `count=2 / skip=1` |
| TD-S0-06 | 已清偿 | 实机 30 个去重标的冷切：`allMiss=true`、`barsMs` P95 **20ms**、`totalMs` P95 **31ms**、max **67ms**；引擎 `indicator.cold_ms` 350 样本 P95 **0.65ms** |
| TD-S0-07 | 已清偿 | 实机 10 个标的切回：`allCacheHit=true`、序列哈希 **10/10** 逐点一致、`totalMs` P95 **21ms**、max **21ms** |
| TD-S0-08 | 已清偿 | `data/sim/generation-report.json.realDir`：重建前后 sha256 `9e44c1e2…303e` 相同、`changed=false`；生成器写 real 目录被拒（`generator_refuses_real_directories`） |
| TD-S0-09 | 已清偿 | `data/sim/seed-42/records.csv` sha256 由 `verify_sim_dataset` 复算一致；`sha256_known_vectors` 已知向量；规范 CSV 格式单测；算法定义见上条「sim 数据集生成器」 |

> 说明：`data/real` 目前只有隔离说明文件、无真实行情数据，因此「real 数据重建不变」只能以哨兵目录
> sha256 不变为证；真实数据源接入与 real 侧重建验证仍属后续 Sprint（见「未实现」）。

## Sprint 0 变更记录（与 BA 卡片的已知差异）

本 Sprint 不改卡片正文，只按新口径实现代码与文档；下列差异由 BA 后续修订卡片时对齐。

| 卡号 | 原表述冲突点 | S0 实际口径 |
| --- | --- | --- |
| S-02.06-02 | 缓存键 6 元组，不含区间 | 改为 7 元组（含 `returnedFrom~returnedTo`），前缀 `v2|`，不保留旧键 |
| S-02.06-01 | 「可视区 200 根」用下标描述 | 可视区 = `[from,to]` 对应交易日根数，由服务端 `returnedFrom/returnedTo/barCount` 给出 |
| S-02.07-01 | 「可视 120 根」「三次放大保持 20 根」 | 交互断言保留，基准量改为「日期区间 ↔ 根数映射」 |
| S-02.07-02 | 「第 10~12 根索引为 NaN」 | 改为「某 3 个连续交易日为 NaN」，断线/空心点判据不变 |
| S-02.02-01 | 周/月聚合口径未冻结 | S0 期间 W/M 禁用；**2026-11-06 清债批次已落地** ISO 周/自然月聚合与交易日历；**S2 已打通前端 W/M 切换**（先复权后聚合，缓存键含周期） |
| S-04.01-02 | 视口以根数/下标表达 | 视口以日期区间表达，根数由 `barCount` 派生 |
| S-04.02-02 | 同上（缩放锚点用下标） | 缩放锚点改为日期，根数由区间映射 |
| S-07.03-02 | manifest 字段未冻结 | 指标 manifest 9 项字段已冻结在 `app/manifest/indicators.json`（含 `cacheKey` 说明） |
| S-02.08-01 | 参数变化后的缓存命中口径 | 参数 + DateRange 均参与键，切回原区间可命中，跨区间不复用 |

## Sprint 1（B1）变更记录

B1 底座批次已完成：10 个指标 + 存量 M06，共 11 条 manifest 记录。id 已统一为 PRD 编号，
旧 `ma` / `macd` 仅保留 alias 一版，前端与夹具全部切到新 id。

| 指标 | 数值层 | 渲染层 | 口径页 |
| --- | --- | --- | --- |
| T01 SMA | `S-03.04-01 / AC-03.04-01` | `AC-03.04-05`（已实现，待 BA 评估） | `S-03.03-01 / AC-03.03-01`（页面已落地，待 BA 评估） |
| T02 EMA | `S-03.04-01 / AC-03.04-02` | `AC-03.04-05`（同上） | 同上 |
| T03 WMA | `S-03.04-01 / AC-03.04-01` | `AC-03.04-05`（同上） | 同上 |
| T04 DEMA | `S-03.04-01 / AC-03.04-03` | `AC-03.04-05`（主图叠加，S2） | 同上 |
| T05 TEMA | `S-03.04-01 / AC-03.04-03` | `AC-03.04-05`（主图叠加，S2） | 同上 |
| T19 Forecast | `S-03.04-02 / AC-03.04-07`、`AC-03.04-08` | `AC-03.04-11`（3/4 满足，T21 独立读数，S2） | 同上 |
| T20 Intercept | `S-03.04-02 / AC-03.04-07` | `AC-03.04-11`（同上） | 同上 |
| T21 R² | `S-03.04-02 / AC-03.04-09` | `AC-03.04-11`（读数条 `T21-r2`，无量纲） | 同上 |
| T22 Slope | `S-03.04-02 / AC-03.04-07` | `AC-03.04-11`（元/根，S2） | 同上 |
| E13 BIAS | `S-03.04-03 / AC-03.04-12`、`AC-03.04-13`、`AC-03.04-14` | `AC-03.04-15`（读数条三线，副图折线未做，S2） | 同上 |
| M06 MACD | `S-03.04-01 / AC-03.04-06` | `S-02.03-01 / AC-02.03-03（补2）`（副图，S2） | 同上 |

> 证据文件：`bench/reports/golden-report.json`（**130/130 passed，12 套夹具**）、`crates/indicator-golden/fixtures/`。
> 渲染层与口径页已在 S2 落地并产出实机 DOM 断言，**是否结项由 BA/QA 判定**（见 `TD-B1-02 / 03`）。

**B1 口径裁定落地（BA §3 / §4）**：M06 `fast.max`、`signal.max` 已 100 → 200；`maType` **未新增**（卡已删除该描述）；
T02 `period.default` 保持 20（未按旧卡片改回 12）。`manifest/indicators.json` 为唯一事实来源，读取即验证 `R-01-A / R-02-A / R-03-A`。

**S1 自定口径（已写入 manifest `notes` 与[口径草稿](../docs/indicators/b1-trend-kernels.md)；页面未落地）**：

1. T02 / T04 的 `warmup` 取 B1 建议的 3N-1，T05 取 4.5N-1；数值首个有效值分别早于该门禁
   （EMA 为 N-1，DEMA 为 2N-2，TEMA 为 3N-3），应用层按建议观察期拦截。
2. T19 Forecast 取窗口内 `x=N-1`（当前根）的拟合值，**不取下一根**；因此标 `beta`。
3. T21 常数序列（`Syy=0`）定义 `R²=1.0`，避免 `0/0`；因此标 `beta`。
4. T03 虽公式完整，但 B1 标「完整▲」，边界说明未闭环，标 `beta`。
5. E13 的 `warmup=min(三个周期)-1`；`SMA=0` 时输出 `NaN`，不产生 `Infinity`。
6. EMA 默认周期 = 20（BA 裁定 R-01：PRD 附录 A 冻结 20，卡已从 12 改为 20；manifest 不改）。

**B1 结束冻结的内核 API**（后续批次不得破坏；新增只能追加）：

- `Indicator::calc(&self, &OhlcvView<'_>, &Params, &mut [Vec<f64>]) -> Result<(), CalcError>`；
- `OhlcvView`：`&[f64]` 六列 + 等长校验，长度唯一事实来源是 `view.len()`；
- `ParamSpec`（`Int` / `Enum`）、`Params`、`merge_defaults`、`validate` 的键与边界语义；
- 输出结构：`Vec<Vec<f64>>`，列顺序 = manifest `outputs` 顺序，缺失一律 `NaN`，
  `NaN → null` 只发生在 app-core DTO 边界；
- `Meta` 字段（含 `unit` / `notes` / `warmup`）与 `manifest::meta_for(id, warmup)`；
- `manifest` schemaVersion 1 + 9 字段（id / 显示名 / 分类 / ParamSpec / 公式引用 / 版本 / 状态 / 单位 / 口径）；
- `kernels`：`rolling_sum`、`sma`、`wma`、`ema`、`ema_of_valid`、`wilder`、`linreg`、`bias`
  与 `LinRegSeries`（slope / intercept / r2 / forecast）；
- 注册表：`all()`、`lookup()`（含 alias 一版）、`implemented_count()`、`PLANNED_INDICATOR_COUNT = 105`。

## Sprint 2（B2 + 前端 + 取证）变更记录

| 项 | 交付 | 证据 |
| --- | --- | --- |
| B2 20 指标 | manifest 31 条（+20），内核 `indicators/b2.rs`，黄金 76 case，bench 40 项 | [`../docs/qa/aka-b2-ac-evidence-v0.1.md`](../docs/qa/aka-b2-ac-evidence-v0.1.md) |
| W/M 切换 | 工具栏 `D / W / M`；缓存键含周期（实测 `\|D\|` 与 `\|W\|` 两条不同键） | 取证报告 §4 |
| 3 条旧债 | `TD-S0-04 / 06 / 07` 实机取证完成，改「已清偿」 | 取证报告 §1–3 |
| 渲染层 `TD-B1-02` | 主图 8 条叠加 + 2 条 MACD + 4 条读数（带单位） | 取证报告 §5 |
| 口径页 `TD-B1-03` | `#/catalog` 11 项 × 四段 | 取证报告 §6 |

**B2 未达成项（如实登记）**：B2 无 Story 卡、AC 待 BA 分配；20 个指标未进 UI；6 个 beta 口径（T13 T15 T16 T23 T24 V08）待裁定；B2 口径页未排期。

## 关键约定

- Rust 依赖方向固定：`aka-desktop → app-core → {indicator-core, data-provider, data-store}`；三个底层 crate 互不依赖（见模块架构图）。
- 参数范围与默认值只有一份事实来源：`app/manifest/indicators.json`；注册表 `Meta` 由它派生，前端 `indicator_manifest` 读取同一份数据。
- 前端只有 `src/lib/ipc.ts` 调用 `invoke`；组件不拼命令字符串。
- `from` / `to` 是 **ISO 日期区间**（含端点，按交易日吸附），不是序列下标；服务端回显实际命中区间。
- 本地状态库路径：`~/Library/Application Support/aka/state.db`；运行埋点：`~/Library/Application Support/aka/logs/telemetry.jsonl`；性能基线路径：`app/bench/baselines/macos-<arch>.json`；黄金夹具：`app/crates/indicator-golden/fixtures/`；sim 数据集：`app/data/sim/seed-<n>/`。
- 数据集目录隔离：sim 生成器只写 `data/sim/`，路径含 `real` 一律拒绝；real 目录只接受真实数据源。

## 工具链与环境说明

- 已验证环境：macOS 26.7.1、rustc/cargo 1.98.1、Node v22.21.1、Tauri 2。
- **本机注意**：`~/.local/bin/node` 是一个 Electron shim（`ELECTRON_RUN_AS_NODE=1`）。用它跑 Vite 会因 `@rollup/rollup-darwin-x64` 原生模块签名冲突报 `ERR_DLOPEN_FAILED`。验证时使用了官方 Node v22.21.1（解压到 `/tmp/aka-node`，通过 `PATH` 前置）。这只影响本机验证，不影响源码；正常机器安装官方 Node 20+ 即可。
- `src-tauri/icons/` 中的图标由本地脚本生成（深色圆角 + 4 根蜡烛），仅用于让 `generate_context!` 与打包通过。
