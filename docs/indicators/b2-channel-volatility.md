# B2 通道 / 波动批次口径（20 指标）

> 适用范围：`app/manifest/indicators.json` 中 T08–T16、T23、T24、V01–V10 共 20 条。
> 数值真源为 `indicator-core::indicators::b2`，参考实现为
> `indicator-golden/fixtures/gen_reference.py`；两者逐点对拍（黄金夹具 76 个 B2 case）。
> 容差口径与 B1 冻结规则一致：价格类 `relative:1e-6`，无量纲振荡 `absolute:1e-4`，
> T24 为原始窗口最值直取，使用 `absolute:1e-9`（等价容差 0）。

## 通用约定

- 输入统一为 `OhlcvView`（open/high/low/close/volume/amount 六个切片）。
- 缺失值一律 `NaN`，DTO 边界转 `null`；不下发 0 代替缺失。
- `warmup` 是「首个有效值下标（0 基）」，预热不足时整列 `NaN`。
- 周/月口径与图表周期一致：周线周期下所有输入已是「先复权后聚合」的周 K。

## 通道类

### T08 Envelopes

- 中轨 `SMA(close, N)`；上轨 `中轨×(1+pct/100)`；下轨 `中轨×(1-pct/100)`。
- 参数：`period` 默认 20；`pct` 默认 2.5（百分数）。
- 首个有效值 `N-1`。输出：upper / middle / lower。

### T09 Bollinger Bands

- 中轨 `SMA(close, N)`；`σ` 为样本标准差（ddof=1）；上/下轨 `中轨 ± kσ`。
- 参数：`period` 20、`mult` 2.0。首个有效值 `N-1`。

### T10 Keltner Channel

- 中轨 `EMA(close, N)`；`ATR(N)` 为 Wilder 平滑；上/下轨 `中轨 ± k×ATR`。
- 参数：`period` 20、`mult` 2.0。首个有效值 `N`（ATR 首值晚于 EMA）。
- 中轨在 ATR 未就绪时同样输出 `NaN`，保证三轨对齐。

### T11 Donchian Channel

- 上轨 = 近 `N` 根最高价；下轨 = 近 `N` 根最低价，无平滑。
- 参数：`period` 20。首个有效值 `N-1`。

### T12 ATR Bands

- 中轨 `SMA(close, N)`；上/下轨 `中轨 ± k×ATR(N)`。参数 `period` 20、`mult` 2.0。
- 首个有效值 `N`。

### T13 ATR Trailing Stop（beta）

- `ATR(period)`，`k = mult`；首个有效 ATR 处按 `close ≥ prev_close` 定初始方向。
- 多头：`long = max(prev_long, close - k×ATR)`；收盘跌破 `prev_long` 翻空，
  `short = close + k×ATR`。空头对称。
- 未激活一侧输出 `NaN`；翻向当根冻结旧止损值，避免线条跳变。
- **beta 原因**：翻多/翻空阈值（用前值还是当根候选值）规划未定义，本实现取「收盘穿越前值」。

### T14 Chandelier Exit

- 多头 `HHV(high, N) - k×ATR(N)`；空头 `LLV(low, N) + k×ATR(N)`。
- 参数：`period` 22、`mult` 3.0。首个有效值 `N`。

### T15 Ichimoku（beta）

- 转换线 `(HHV9+LLV9)/2`；基准线 `(HHV26+LLV26)/2`；
  先行带 A `=(转换线+基准线)/2`、B `=(HHV52+LLV52)/2`，均向未来位移 `displacement` 根；
  迟行线 `= close` 向后位移 `displacement` 根。
- 参数：`tenkan` 9、`kijun` 26、`senkou` 52、`displacement` 26。首个有效值 `senkou-1+displacement = 77`。
- 未来段（无对应 K 线）输出 `NaN`；不把未来值回填到当前。
- **beta 原因**：位移的尾部对齐口径（投影 vs 平移）尚未人工校对。

### T16 Parabolic SAR（beta）

- Wilder PSAR：`SAR = prev_SAR + AF×(EP-prev_SAR)`，按前两根极值夹逼；
  反转时 `SAR = EP`、`EP = 当根极值`、`AF` 重置为 `step`，否则 `AF = min(AF+increment, max)`。
- 参数：`step` 0.02、`increment` 0.02、`max` 0.2。首根有效值下标 1。
- **beta 原因**：初始方向（收盘比较）与首根 SAR（上一根反向极值）为自定口径。

### T23 Pivot Points（beta）

- `P=(H+L+C)/3`、`R1=2P-L`、`S1=2P-H`，取**上一根** H/L/C。
- 无参数；首根有效值下标 1。
- **beta 原因**：规划的「日/周两口径」由图表周期 D/W 决定，指标不再额外设 `basis` 参数；
  该映射需人工确认。

### T24 HHV / LLV（beta）

- `HHV = max(high[i-N+1..=i])`；`LLV = min(low[i-N+1..=i])`，原始值直取。
- 参数 `period` 20；首个有效值 `N-1`。夹具容差固定 `absolute:1e-9`（等价精确）。
- **beta 原因**：规划标「完整▲」，边界说明待补。

## 波动类

### V01 ATR

- `TR[0]=NaN`；`TR[i]=max(H-L, |H-PC|, |L-PC|)`。
- `ATR` 为 TR 的 Wilder 平滑，种子 = 前 `N` 个有效 TR 的算术均值。首个有效值 `N`。

### V02 ATRP

- `ATRP = ATR / close`，**无量纲比值**（不是百分数）。收盘为 0 时 `NaN`。
- 容差 `absolute:1e-4`。

### V03 Standard Deviation

- 样本标准差 `sqrt(Σ(C-C̄)²/(N-1))`，ddof=1。首个有效值 `N-1`。

### V04 Bollinger Band Width

- `带宽 = (上轨-下轨)/中轨 = 2kσ/SMA`，无量纲比值；中轨为 0 时 `NaN`。
- 参数：`period` 20、`mult` 2.0。

### V05 %B

- `%B = (C-下轨)/(上轨-下轨)`；零带宽（σ=0）输出 `NaN`。

### V07 Ulcer Index

- 窗口 `N` 内 `回撤 = (C-窗口峰值)/窗口峰值×100`；`UI = sqrt(mean(回撤²))`。
- 参数 `period` 14；峰值 ≤0 时 `NaN`。

### V08 GAPO（beta）

- `GAPO = (Open - 前收) / ATR(N) × 100`，ATR 周期默认 20。
- **beta 原因**：规划只写「跳空持续口径」；ATR 归一化与正负号方向为自定实现。

### V09 振幅

- `High - Low`（元），单根直接输出，首根即有效。

### V10 True Range

- `TR[0]=NaN`；其后 `max(H-L, |H-PC|, |L-PC|)`。

## 夹具与证据

| 项 | 位置 |
| --- | --- |
| Manifest | `app/manifest/indicators.json`（20 条，含 beta 标记与 notes） |
| 黄金夹具 | `base_b2_channel_seed42_520`（20 case）、`edge_b2_constant_ohlc`（20）、`edge_b2_first_bar`（20）、`edge_b2_insufficient`（16） |
| 夹具生成 | `cargo` 目录下 `python3 crates/indicator-golden/fixtures/gen_reference.py` |
| 性能记录 | `app/bench/baselines/macos-<arch>.json`（31 指标 × 520/2500） |
| golden-report | `app/bench/reports/golden-report.json`（130/130） |
| 单测 | `indicator-core::indicators::b2::tests` + `indicators::tests` 注册表/短序列 |
