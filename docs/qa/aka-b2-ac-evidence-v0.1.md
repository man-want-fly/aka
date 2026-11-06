# AKA · B2 通道/波动批次 20 指标 AC 证据 v0.1

| 项 | 内容 |
|---|---|
| 文档编号 | AKA-QA-B2-EVIDENCE-0.1 |
| 版本 / 日期 | v0.1 / 2026-11-06 |
| 批次范围 | 严格按 `docs/planning/aka-indicator-batches-and-sprints-v0.1.md` §B2：**20 个 id**，未增删、未提前做 B3 |
| 指标清单 | T08 T09 T10 T11 T12 T13 T14 T15 T16 T23 T24 / V01 V02 V03 V04 V05 V07 V08 V09 V10 |
| 四件套 | ①manifest 条目；②黄金夹具；③性能记录；④Story 卡 AC 证据 |
| 结论 | 20/20 的 ①②③ 齐备；④**B2 无卡入库**，如实登记为「卡未入库 / AC 待 BA 分配」，不以 B1 卡或渲染层 AC 充数 |
| beta | 6 个：T13 T15 T16 T23 T24 V08（口径自定或待人工校对，见 §4） |

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
| T13 | ATR 移动止损 | `partial` / 2 参数 | 4 | 0.024 / 0.074 | 数值层已具备；无卡 | **beta** |
| T14 | 吊灯止损 | `manualComplete` / 2 参数 | 4 | 0.078 / 0.315 | 数值层已具备；无卡 | beta 否 |
| T15 | 一目均衡表 | `partial` / 4 参数 | 4 | 0.221 / 1.047 | 数值层已具备；无卡 | **beta** |
| T16 | 抛物线转向 | `partial` / 3 参数 | 3 | 0.005 / 0.043 | 数值层已具备；无卡 | **beta** |
| T23 | 轴心点 | `partial` / 0 参数 | 3 | 0.002 / 0.014 | 数值层已具备；无卡 | **beta** |
| T24 | 最高最低 | `partial` / 1 参数 | 3 | 0.043 / 0.193 | 数值层已具备；无卡 | **beta** |
| V01 | 真实波幅均值 | `manualComplete` / 1 参数 | 4 | 0.027 / 0.055 | 数值层已具备；无卡 | beta 否 |
| V02 | 归一化 ATR | `manualComplete` / 1 参数 | 4 | 0.024 / 0.084 | 数值层已具备；无卡 | beta 否 |
| V03 | 标准差 | `manualComplete` / 1 参数 | 4 | 0.061 / 0.193 | 数值层已具备；无卡 | beta 否 |
| V04 | 布林带宽 | `manualComplete` / 2 参数 | 4 | 0.060 / 0.285 | 数值层已具备；无卡 | beta 否 |
| V05 | 布林 %B | `manualComplete` / 2 参数 | 4 | 0.058 / 0.305 | 数值层已具备；无卡 | beta 否 |
| V07 | 溃疡指数 | `manualComplete` / 1 参数 | 4 | 0.058 / 0.179 | 数值层已具备；无卡 | beta 否 |
| V08 | GAPO 跳空 | `partial` / 1 参数 | 4 | 0.019 / 0.074 | 数值层已具备；无卡 | **beta** |
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

## 3. Story 卡与 AC 挂接（如实登记）

| 项 | 现状 |
|---|---|
| B2 是否有卡 | **无**。`docs/story-cards/aka-story-cards-v0.1.md` 现有 60 张中，V01–V10 / T08–T24 均无对应 Story 卡 |
| 因此的 AC 证据 | **无法挂接**。不把 B1 的 `AC-03.04-xx` 借给 B2，也不把任何 `[渲染层]` AC 当作 B2 证据 |
| 登记方式 | 本批按「卡未入库 / AC 待 BA 分配」登记；待 BA 补卡后再按 §1 逐行挂 `[数据层]` AC |
| 可否结项 | **不可**。开发方不对 B2 下任何结项结论 |

> 说明：`S-03.04-01/02/03` 是 B1 底座卡，**不覆盖** B2 的 20 个指标；它们只承接 T01–T05、T19–T22、E13、M06。

## 4. beta 清单与口径歧义（6 条）

| id | 标 beta 的原因 | 自定部分 | 待 BA 裁定 |
|---|---|---|---|
| T13 | ATR 移动止损的多空翻转阈值属自定口径 | 多头止损 `max(前值, C−k×ATR)`；`C` 跌破前值翻空；翻空阈值未在规划中给出；未激活一侧输出 NaN | 翻空是否用「收盘价穿越」还是「最低价触及」；翻空后止损是否重置为 `C+k×ATR` |
| T15 | 一目均衡表位移口径待人工校对 | 先行带 A/B 向未来位移 D 根、迟行线向后位移 D 根、未来段输出 NaN；尾部对齐方式自定 | 位移后序列尾部取舍：末 D 根先行带是否留白；迟行线是否以「当前根 = 前 D 根收盘」呈现 |
| T16 | 抛物线转向的初始方向与首根 SAR 取值属自定 | 首根有效值为第 2 根；初始方向取首根涨跌；extremum 初值自定 | 初始方向是否固定为多头；加速因子起点与上限口径 |
| T23 | 轴心点映射待人工校对 | `P=(H+L+C)/3`、`R1=2P−L`、`S1=2P−H`，取**上一根**日/周值；不设参数 | 是否按「当日枢轴用前一日」映射；W 周期是否用上一周；是否补 R2/R3/S2/S3 |
| T24 | 规划标「完整▲」，边界说明缺失 | 原始值直取 `HHV/LLV`，无平滑 | 是否需要中轨/带宽输出；极值窗口是否含当前根（现实现含） |
| V08 | 规划仅写「跳空持续口径」，未给归一化方式 | `GAPO=(Open−前收)/ATR×100`，带正负号 | 分母是否用 ATR 还是前收；是否只保留同向跳空（持续口径） |

以上 6 条在 manifest 中均为 `specStatus=partial` → `status=beta`，UI 未暴露；口径页（P4）B2 段尚未排期。

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

1. **B2 Story 卡缺失**：20 个指标无卡，AC 未分配，四件套的 ④ 处于「待 BA」。
2. **UI 未暴露**：B2 未进入工作台（主图叠加与副图仍为 B1 11 个），无渲染层证据；`TD-B1-02` 的渲染层取证只覆盖 B1。
3. **6 条 beta 口径待裁定**：见 §4，裁定前不进默认组合。
4. **T15 尾部对齐**为全批最慢项（2500 根 1.047ms，仍在阈值内），但需在补卡时确认位移口径后再定型。
