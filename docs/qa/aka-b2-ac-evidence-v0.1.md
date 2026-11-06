# AKA · B2 通道/波动批次 20 指标 AC 证据 v0.1

| 项 | 内容 |
|---|---|
| 文档编号 | AKA-QA-B2-EVIDENCE-0.1 |
| 版本 / 日期 | v0.1 / 2026-11-06 |
| 批次范围 | 严格按 `docs/planning/aka-indicator-batches-and-sprints-v0.1.md` §B2：**20 个 id**，未增删、未提前做 B3 |
| 指标清单 | T08 T09 T10 T11 T12 T13 T14 T15 T16 T23 T24 / V01 V02 V03 V04 V05 V07 V08 V09 V10 |
| 四件套 | ①manifest 条目；②黄金夹具；③性能记录；④Story 卡 AC 证据 |
| 结论 | 20/20 的 ①②③ 齐备；④Story 卡已由 BA 补齐（`S-03.05-01 ~ 08`），AC 逐条挂接；渲染层证据随 B2 接入 UI 单独取证 |
| beta | 原 6 个已裁定：**5 个转 normal**（T13 T15 T23 T24 V08），**T16 保留 beta**（见 §4） |

---

## 1. 四件套矩阵

> 证据层级只标 `[数据层]`；B2 尚未进入工作台 UI，**不存在渲染层证据**，故不挂任何 `[渲染层]` AC。

| id | 名称 | manifest | 黄金夹具（case 数） | bench 520 p95 / 2500 p95（ms） | AC 证据 | 状态 |
|---|---|---|---|---|---|---|
| T08 | 均线包络 | `manualComplete` / 2 参数 | 4 | 0.004 / 0.033 | 数值层已具备；无卡 | beta 否 |
| T09 | 布林带 | `manualComplete` / 2 参数 | 4 | 0.058 / 0.204 | 数值层已具备；无卡 | beta 否 |
| T10 | 肯特纳通道 | `manualComplete` / 2 参数 | 4 | 0.029 / 0.138 | 数值层已具备；无卡 | beta 否 |
| T11 | 唐奇安通道 | `manualComplete` / 1 参数 | 4 | 0.060 / 0.206 | 数值层已具备；无卡 | beta 否 |
| T12 | ATR 通道 | `manualComplete` / 2 参数 | 4 | 0.032 / 0.040 | 数值层已具备；无卡 | beta 否 |
| T13 | ATR 移动止损 | `manualComplete` / 2 参数 | 4 | 0.024 / 0.074 | 数值层已具备；卡 AC-03.05-13 | normal（R-01） |
| T14 | 吊灯止损 | `manualComplete` / 2 参数 | 4 | 0.078 / 0.315 | 数值层已具备；无卡 | beta 否 |
| T15 | 一目均衡表 | `manualComplete` / 4 参数 | 4 | 0.221 / 1.047 | 数值层已具备；卡 AC-03.05-17~19 | normal（R-02） |
| T16 | 抛物线转向 | `partial` / 3 参数 | 3 | 0.005 / 0.043 | 数值层已具备；卡 AC-03.05-21~23 | **beta（R-03 保留）** |
| T23 | 轴心点 | `manualComplete` / 0 参数 | 3 | 0.002 / 0.014 | 数值层已具备；卡 AC-03.05-25~27 | normal（R-04） |
| T24 | 最高最低 | `manualComplete` / 1 参数 | 3 | 0.043 / 0.193 | 数值层已具备；卡 AC-03.05-03~04 | normal（R-05） |
| V01 | 真实波幅均值 | `manualComplete` / 1 参数 | 4 | 0.027 / 0.055 | 数值层已具备；无卡 | beta 否 |
| V02 | 归一化 ATR | `manualComplete` / 1 参数 | 4 | 0.024 / 0.084 | 数值层已具备；无卡 | beta 否 |
| V03 | 标准差 | `manualComplete` / 1 参数 | 4 | 0.061 / 0.193 | 数值层已具备；无卡 | beta 否 |
| V04 | 布林带宽 | `manualComplete` / 2 参数 | 4 | 0.060 / 0.285 | 数值层已具备；无卡 | beta 否 |
| V05 | 布林 %B | `manualComplete` / 2 参数 | 4 | 0.058 / 0.305 | 数值层已具备；无卡 | beta 否 |
| V07 | 溃疡指数 | `manualComplete` / 1 参数 | 4 | 0.058 / 0.179 | 数值层已具备；无卡 | beta 否 |
| V08 | GAPO 跳空 | `manualComplete` / 1 参数 | 4 | 0.019 / 0.074 | 数值层已具备；卡 AC-03.05-33~34 | normal（R-06） |
| V09 | 振幅 | `manualComplete` / 0 参数 | 3 | 0.002 / 0.006 | 数值层已具备；无卡 | beta 否 |
| V10 | 真实波幅 | `manualComplete` / 0 参数 | 3 | 0.003 / 0.043 | 数值层已具备；无卡 | beta 否 |

- 性能阈值：520 根 ≤1.0ms、2500 根 ≤8.0ms（`bench/baselines/macos-x86_64.json` `thresholds`）；20 个指标 × 2 档 = **40 项全部 `pass`**，最大者为 T15 的 1.047ms（2500 根，阈值 8.0ms）。
- 黄金夹具合计 **76 个 case**（B2 部分），全过：`bench/reports/golden-report.json` 中 `base_b2_channel_seed42_520` 20、`edge_b2_constant_ohlc` 20、`edge_b2_first_bar` 20、`edge_b2_insufficient` 16。

## 2. 黄金夹具细目（独立参考实现）

生成器 `crates/indicator-golden/fixtures/gen_reference.py`（Python，固定种子 42，禁止手工改 JSON）。

| 套件 | 根数 | case | 覆盖 |
|---|---|---|---|
| `base_b2_channel_seed42_520` | 520 | 20 | 每指标 1 条基线，逐点对拍 |
| `edge_b2_constant_ohlc` | 40 | 20 | 常数 OHLC 退化（带宽 0、GAPO 0、止损不翻转等） |
| `edge_b2_first_bar` | 1 | 20 | 首根 NaN / 首根即有效（V09） |
| `edge_b2_insufficient` | 20 | 16 | 预热不足：T08–T15、T24、V01–V05、V07、V08（无预热要求的 T16/T23/V09/V10 不入本套件） |

容差冻结（`indicator-golden/src/lib.rs`）：价格类 `relative:1e-6`；无量纲/比率类（V02 V04 V05 V07 V08）`absolute:1e-4`；T24 原始极值直取 `absolute:1e-9`（只允许手算夹具或 T24 收紧到 1e-9，禁止放宽）。

单测（`indicator-core/src/indicators/b2.rs`）：`v10_first_bar_is_nan_and_later_finite`、`v01_atr_is_wilder_mean_of_true_range`、`t24_is_exact_window_extreme`、`v03_sample_stddev_excludes_denominator_n`、`v02_atrp_is_atr_over_close`、`every_b2_indicator_has_nan_prefix_and_no_panic_on_short_series`。

## 3. Story 卡与 AC 挂接

| 项 | 现状 |
|---|---|
| B2 是否有卡 | **有**。BA 已补 8 张卡：`S-03.05-01` T24、`-02` T23、`-03` T13、`-04` T15、`-05` T16、`-06` T14、`-07` T10/T12、`-08` T08/T09/T11；加 `V01-V10` 汇总卡，覆盖 B2 全部 20 个指标 |
| AC 挂接 | 按卡内 `AC-03.05-xx` 逐条挂接；数据层 AC 由黄金夹具 + 单测证明，渲染层 AC 随 UI 接入单独取证，不以「数值层已具备」冒充 |
| 未覆盖项 | V01–V05、V07、V09、V10 的独立 AC 仍在 `S-03.05-08` 汇总卡内，未拆细；如需单指标 AC，待 BA 再拆 |
| 可否结项 | **不可**。开发方不对 B2 下任何结项结论 |

## 4. beta 口径裁定（5 转 normal，1 保留）

裁定结果集中记录在 [`docs/indicators/b2-beta-rulings.md`](../../docs/indicators/b2-beta-rulings.md)（R-01 ~ R-06），与 `b2-channel-volatility.md` 各条「口径裁定」段一致。

| id | 原争议 | 裁定结论 | 处置 |
|---|---|---|---|
| T13 | 翻转阈值、翻空后止损 | 收盘价跌破前一根多头止损即翻空；翻空当根冻结旧值，空头止损重置为 `C+k·ATR` | R-01 → normal |
| T15 | 位移后尾部取舍 | 先行带右移 D 根、末尾 D 根留白；迟行线 `close[i−D]`、前 D 根留白 | R-02 → normal |
| T16 | 初始方向、首根 SAR、AF | 采用 Wilder 推荐值，但各家商业软件无公开公式可逐点核对 | R-03 → **保留 beta** |
| T23 | 周期归属、是否补 R2/R3 | 只用上一根 H/L/C，周期随图表（日/周/月），只输出 P/R1/S1 | R-04 → normal |
| T24 | 是否加中轨/带宽 | 原始值直取，无中轨/带宽，窗口含当前根 | R-05 → normal |
| V08 | 分母、正负号、同向筛选 | `(Open−前收)/ATR(20)×100`，保留正负号，不筛同向 | R-06 → normal |

- manifest 处置：上述 5 条已改为 `specStatus=manualComplete` / `status=normal`；T16 维持 `partial` / `beta`，UI 带 beta 徽标，不进默认组合。
- T16 解除条件：取得至少一家商业软件（通达信/同花顺/TA-Lib）的逐点对照样本后重新裁定。
- 裁定只冻结口径，不代表 B2 可结项；渲染层与结项结论仍待 BA。

## 5. 证据文件与复跑

| 产物 | 路径 |
|---|---|
| 黄金夹具（4 套） | `app/crates/indicator-golden/fixtures/base_b2_channel_seed42_520.json`、`edge_b2_constant_ohlc.json`、`edge_b2_first_bar.json`、`edge_b2_insufficient.json` |
| 生成器 | `app/crates/indicator-golden/fixtures/gen_reference.py` |
| 黄金报告 | `app/bench/reports/golden-report.json`（`passed=130 / failed=0`） |
| 性能记录 | `app/bench/baselines/macos-x86_64.json`（release，200 iterations，62 项全 pass） |
| 口径草稿 | `docs/indicators/b2-channel-volatility.md`（公式与边界；**不作为 AC 证据**，页面未落地） |

```bash
cd app
cargo test -p indicator-core
cargo run -p indicator-golden --bin aka-golden      # 130 case
cargo run -p indicator-golden --bin aka-bench --release
```

## 6. 本批未达成项

1. **B2 渲染层证据**：本轮负责接入工作台后再取证；截至本文档更新时尚未取证，故所有渲染层 AC 仍为「未取证」。
2. **V01–V05/V07/V09/V10 独立 AC 未拆细**：目前只挂在 `S-03.05-08` 汇总卡。
3. **T16 仍为 beta**：见 §4，未取得商业软件逐点对照。
4. **结项结论**：开发方不下结论，待 BA 评估。
