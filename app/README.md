# AKA · A 股桌面分析工作台（MVP 骨架）

macOS 单机、离线、免费、无账户的 A 股分析工作台骨架。技术栈：**Tauri 2 + React 18 + TypeScript + Vite**，指标引擎为 **Rust workspace**（无 Python sidecar、无本地 HTTP 端口）。

> 当前行情全部为 **mock 模拟数据**，界面已固定标注「模拟数据 · 非真实行情」。本仓库只搭骨架，不含投资建议，也未接入任何真实行情。

## 目录

```text
app/
├─ Cargo.toml                 # Rust workspace（6 个成员）
├─ package.json               # 前端脚本与依赖
├─ vite.config.ts  tsconfig.json  index.html
├─ manifest/indicators.json   # 指标 manifest（单一事实来源，S0 建立 / S1 扩到 11 条）
├─ bench/baselines/           # 性能基线（macos-<arch>.json，S0 建立 / S1 扩到 11 指标）
├─ src/                       # 前端
│  ├─ main.tsx  App.tsx       # 入口 · 主题状态
│  ├─ app/AppShell.tsx        # 左侧 rail 与导航（仅工作台可用）
│  ├─ pages/workbench/        # 最小工作台页
│  ├─ features/workbench/     # 参数模型 / 实例组装 / 本地预校验
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
- **指标引擎（S1 / B1）**：静态注册表 11 个指标 + `ParamSpec` 校验；id 统一为 PRD 编号
  **T01 SMA / T02 EMA / T03 WMA / T04 DEMA / T05 TEMA / T19 LinReg Forecast / T20 Intercept /
  T21 R² / T22 Slope / E13 BIAS(6/12/24)**，存量 **M06 MACD**；旧 `ma` → `T01`、`macd` → `M06`
  保留 alias 一版。数值内核在 `indicator-core::kernels`（SMA/滚动求和、EMA 以 SMA 为种子、
  Wilder RMA、WMA、中心化 OLS、BIAS），统一 `&[f64]` 输入、`NaN` 缺失、唯一入口
  `Indicator::calc(&OhlcvView, &Params, &mut [Vec<f64>])`；NaN 在 DTO 边界转 `null`。
- **缓存键（S0 裁定）**：7 元组 `数据集版本 + 标的 + 周期 + 复权 + 指标 id + 参数 + DateRange`，DateRange 用规范化后的 `returnedFrom~returnedTo` 参与键；前缀 `v2|`，**不保留旧 6 元组键**。
- **IPC 5 条命令**：`list_securities`、`get_bars`、`indicator_registry`、`indicator_manifest`、`calc_indicators`；错误统一为 `{ code, message, retryable, details }`。
- **指标 manifest（S0-5 / S1）**：`app/manifest/indicators.json` 为目录唯一事实来源（id / 显示名 / 分类 / 参数 spec / 默认值与上下界 / 公式引用 / 版本 / normal|beta / 单位 / 口径说明），`include_str!` 编译期嵌入；注册表 `meta()` 由 manifest 派生，并有逐字段一致性测试（含 alias 冲突、单位与口径必填）；前端通过 `indicator_manifest` 生成指标目录。
- **state.db（S0-4）**：`~/Library/Application Support/aka/state.db`，rusqlite（bundled SQLite）；`PRAGMA user_version` + `schema_versions` 表版本化，前滚脚本 `migrations/001_init.sql` 与回滚脚本 `001_init_rollback.sql`；WAL；8 张业务表（`settings`、`view_state`、`watchlist_groups`、`watchlist_items`、`favorites`、`chart_layout`、`indicator_params`、`dataset_meta`）。打开时 `PRAGMA quick_check` 检坏库，坏库隔离为 `state.db.corrupt-<ts>` 并回退内存库（`degraded=true`，写失败 `retryable=true`）。
- **黄金夹具（S0-3 / S1）**：固定 JSON 基线（Python 公开公式独立手算，不回算 Rust 引擎），`seed=42 / 520 根`；容差 `relative 1e-6`（绝对值下限 1.0）、`absolute 1e-4`、计数严格；B1 覆盖 T01–T05、T19–T22、E13、M06 共 11 指标，以及数据不足 / 常数序列 / 全零均值 / 首根 K 线 4 类边界；缺基线时显式失败并提示生成命令；偏差报告含 case / output / bar index。数据源固定为 `fixtures/gen_reference.py`，禁止手工改 JSON。
- **性能基线（S0-6 / S1）**：`cargo run --release -p indicator-golden --bin aka-bench`，固定种子合成 520 / 2500 根，记录 p50 / p95 / max 与 peak RSS，输出 `app/bench/baselines/macos-<arch>.json`（含 CPU、rustc、profile、engineVersion 与阈值）。B1 覆盖 11 指标 × 2 规模；阈值沿用 S0：520 根 p95 ≤ 1.0ms，2500 根 p95 ≤ 8.0ms。
- **CI（S0-2）**：`.github/workflows/ci.yml`（macOS runner）串行跑 cargo check / cargo test / golden / `npm ci` / tsc / vite build，任一失败即红。
- **工作台**：自选列表、日线 K 线 + 均线叠加（SMA/EMA/WMA 分别请求 T01/T02/T03）+ 成交量 + MACD（M06）副图、参数修改、日期区间选择、深/浅/跟随系统主题、红涨绿跌切换、模拟数据标识与状态栏。

## 未实现（后续 Sprint 边界）

- 周/月周期与周月聚合（工具栏 W/M 已禁用）、分钟线、停牌整周语义。
- 其余 94 个规划指标（当前已实现 11 / 105）、完整指标口径页与完整黄金用例库（B1 之外的指标尚未建卡建夹具）。
- 真实数据源：tushare 仅接口骨架（默认不可用）、baostock/akshare 仅有占位；无网络层；`data/real` 隔离与 sha256 重算未落地（仅冻结 manifest 契约）。
- state.db 只接了打开/迁移/仓储与 `AppCore` 注入，尚未接任何 UI 持久化（主题、自选仍只在前端内存）。
- 数据集生成器（Parquet 分区、`dataset_generation` +1、sim/real 双目录隔离）。
- 多页面（行情/指标库/设置等）、自选持久化、诊断包导出、更新通道、代码签名与公证。
- 打包图标为脚本生成的占位图，发布前需替换为正式设计资产。

## 技术债（S0 未清偿，S1 带条件开工）

9 条阻塞项（T-01 部分、T-05 实物、QA-S0-015/022/028/029/033/062/070）**全部未清偿**，
要求在 **S2 开工前 3.5 人日清零**。S1 期间任何文档与验收不得写成「已通过」；B1 指标正确性
只依赖黄金夹具与公开公式手算对拍，不依赖运行时日志埋点。

- 登记与逐条明细：[`../docs/qa/aka-tech-debt-s0-v0.1.md`](../docs/qa/aka-tech-debt-s0-v0.1.md)
- 原始验收清单：[`../docs/qa/aka-s0-acceptance-checklist-v0.1.md`](../docs/qa/aka-s0-acceptance-checklist-v0.1.md)

## Sprint 0 变更记录（与 BA 卡片的已知差异）

本 Sprint 不改卡片正文，只按新口径实现代码与文档；下列差异由 BA 后续修订卡片时对齐。

| 卡号 | 原表述冲突点 | S0 实际口径 |
| --- | --- | --- |
| S-02.06-02 | 缓存键 6 元组，不含区间 | 改为 7 元组（含 `returnedFrom~returnedTo`），前缀 `v2|`，不保留旧键 |
| S-02.06-01 | 「可视区 200 根」用下标描述 | 可视区 = `[from,to]` 对应交易日根数，由服务端 `returnedFrom/returnedTo/barCount` 给出 |
| S-02.07-01 | 「可视 120 根」「三次放大保持 20 根」 | 交互断言保留，基准量改为「日期区间 ↔ 根数映射」 |
| S-02.07-02 | 「第 10~12 根索引为 NaN」 | 改为「某 3 个连续交易日为 NaN」，断线/空心点判据不变 |
| S-02.02-01 | 周/月聚合口径未冻结 | S0 仍未实现，W/M 禁用；交易日历吸附规则已在 DateRange 生效 |
| S-04.01-02 | 视口以根数/下标表达 | 视口以日期区间表达，根数由 `barCount` 派生 |
| S-04.02-02 | 同上（缩放锚点用下标） | 缩放锚点改为日期，根数由区间映射 |
| S-07.03-02 | manifest 字段未冻结 | 指标 manifest 9 项字段已冻结在 `app/manifest/indicators.json`（含 `cacheKey` 说明） |
| S-02.08-01 | 参数变化后的缓存命中口径 | 参数 + DateRange 均参与键，切回原区间可命中，跨区间不复用 |

## Sprint 1（B1）变更记录

B1 底座批次已完成：10 个指标 + 存量 M06，共 11 条 manifest 记录。id 已统一为 PRD 编号，
旧 `ma` / `macd` 仅保留 alias 一版，前端与夹具全部切到新 id。

| 指标 | 名称 | 状态 | Story 卡 / AC | 证据 |
| --- | --- | --- | --- | --- |
| T01 | SMA | normal | S-02.05-01 / AC-02.05-01 | `t01_sma_matches_manual_mean`、`base_trend_seed42_520` |
| T02 | EMA | normal | S-02.05-01 / AC-02.05-01 | `t02_ema_seed_is_sma`、`base_trend_seed42_520` |
| T03 | WMA | **beta** | S-02.05-01 / AC-02.05-01 | `t03_wma_matches_manual`、`base_trend_seed42_520` |
| T04 | DEMA | normal | **无卡，属技术债** | `t04_dema_matches_two_ema_formula`、`edge_*` |
| T05 | TEMA | normal | **无卡，属技术债** | `t05_tema_matches_three_ema_formula`、`edge_*` |
| T19 | LinReg Forecast | **beta** | **无卡，属技术债** | `t19_to_t22_regression_columns_share_window` |
| T20 | LinReg Intercept | normal | **无卡，属技术债** | `t19_to_t22_regression_columns_share_window` |
| T21 | LinReg R² | **beta** | **无卡，属技术债** | `t19_to_t22_regression_columns_share_window` |
| T22 | LinReg Slope | normal | **无卡，属技术债** | `t19_to_t22_regression_columns_share_window` |
| E13 | BIAS(6/12/24) | normal | **无卡，属技术债** | `e13_bias_has_three_periods`、`edge_bias_zero_mean` |
| M06 | MACD | **beta** | S-02.03-01 / AC-02.03-03(补2)、S-03.03-01 / AC-03.03-01 | `macd_outputs_are_finite_after_warmup`、`base_trend_seed42_520` |

**S1 自定口径（已写入 manifest `notes` 与口径页）**：

1. T02 / T04 的 `warmup` 取 B1 建议的 3N-1，T05 取 4.5N-1；数值首个有效值分别早于该门禁
   （EMA 为 N-1，DEMA 为 2N-2，TEMA 为 3N-3），应用层按建议观察期拦截。
2. T19 Forecast 取窗口内 `x=N-1`（当前根）的拟合值，**不取下一根**；因此标 `beta`。
3. T21 常数序列（`Syy=0`）定义 `R²=1.0`，避免 `0/0`；因此标 `beta`。
4. T03 虽公式完整，但 B1 标「完整▲」，边界说明未闭环，标 `beta`。
5. E13 的 `warmup=min(三个周期)-1`；`SMA=0` 时输出 `NaN`，不产生 `Infinity`。
6. EMA 默认周期按 B1 取 20（卡片其他段落出现过 12，以 manifest 为准）。

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

## 关键约定

- Rust 依赖方向固定：`aka-desktop → app-core → {indicator-core, data-provider, data-store}`；三个底层 crate 互不依赖（见模块架构图）。
- 参数范围与默认值只有一份事实来源：`app/manifest/indicators.json`；注册表 `Meta` 由它派生，前端 `indicator_manifest` 读取同一份数据。
- 前端只有 `src/lib/ipc.ts` 调用 `invoke`；组件不拼命令字符串。
- `from` / `to` 是 **ISO 日期区间**（含端点，按交易日吸附），不是序列下标；服务端回显实际命中区间。
- 本地状态库路径：`~/Library/Application Support/aka/state.db`；性能基线路径：`app/bench/baselines/macos-<arch>.json`；黄金夹具：`app/crates/indicator-golden/fixtures/`。

## 工具链与环境说明

- 已验证环境：macOS 26.7.1、rustc/cargo 1.98.1、Node v22.21.1、Tauri 2。
- **本机注意**：`~/.local/bin/node` 是一个 Electron shim（`ELECTRON_RUN_AS_NODE=1`）。用它跑 Vite 会因 `@rollup/rollup-darwin-x64` 原生模块签名冲突报 `ERR_DLOPEN_FAILED`。验证时使用了官方 Node v22.21.1（解压到 `/tmp/aka-node`，通过 `PATH` 前置）。这只影响本机验证，不影响源码；正常机器安装官方 Node 20+ 即可。
- `src-tauri/icons/` 中的图标由本地脚本生成（深色圆角 + 4 根蜡烛），仅用于让 `generate_context!` 与打包通过。
