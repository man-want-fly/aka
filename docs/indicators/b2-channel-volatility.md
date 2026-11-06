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

### T13 ATR Trailing Stop

- `ATR(period)`，`k = mult`；首个有效 ATR 处按 `close ≥ prev_close` 定初始方向。
- 多头：`long = max(prev_long, close - k×ATR)`；收盘跌破 `prev_long` 翻空，
  `short = close + k×ATR`。空头对称。
- 未激活一侧输出 `NaN`；翻向当根冻结旧止损值，避免线条跳变。
- **口径裁定**：翻空用**收盘穿越**；翻空当根止损**重置**为 `C+k×ATR`。已裁定，见 `b2-beta-rulings.md` R-01。

### T14 Chandelier Exit

- 多头 `HHV(high, N) - k×ATR(N)`；空头 `LLV(low, N) + k×ATR(N)`。
- 参数：`period` 22、`mult` 3.0。首个有效值 `N`。

### T15 Ichimoku

- 转换线 `(HHV9+LLV9)/2`；基准线 `(HHV26+LLV26)/2`；
  先行带 A `=(转换线+基准线)/2`、B `=(HHV52+LLV52)/2`，均向未来位移 `displacement` 根；
  迟行线 `= close` 向后位移 `displacement` 根。
- 参数：`tenkan` 9、`kijun` 26、`senkou` 52、`displacement` 26。首个有效值 `senkou-1+displacement = 77`。
- 未来段（无对应 K 线）输出 `NaN`；不把未来值回填到当前。
- **口径裁定**：先行带与迟行线位移后**末尾 D 根留白（NaN）**，不回填未来值。已裁定，见 `b2-beta-rulings.md` R-02。

### T16 Parabolic SAR（beta）

- Wilder PSAR：`SAR = prev_SAR + AF×(EP-prev_SAR)`，按前两根极值夹逼；
  反转时 `SAR = EP`、`EP = 当根极值`、`AF` 重置为 `step`，否则 `AF = min(AF+increment, max)`。
- 参数：`step` 0.02、`increment` 0.02、`max` 0.2。首根有效值下标 1。
- **beta 原因（保留 beta）**：初始方向按首两根收盘决定、首根 SAR 取第 1 根反向极值、AF 0.02/0.02/0.2，已给出推荐值；但通达信/同花顺/TA-Lib 对初始方向与首根 SAR 的处理不一致且无公开公式可逐点核对，故**保留 beta**，见 `b2-beta-rulings.md` R-03。

### T23 Pivot Points

- `P=(H+L+C)/3`、`R1=2P-L`、`S1=2P-H`，取**上一根** H/L/C。
- 无参数；首根有效值下标 1。
- **口径裁定**：当日用**前一周期** H/L/C；周期随图表（D→上一日、W→上一周、M→上一月）；只输出 P/R1/S1，R2/R3/S2/S3 留 P1。已裁定，见 `b2-beta-rulings.md` R-04。

### T24 HHV / LLV

- `HHV = max(high[i-N+1..=i])`；`LLV = min(low[i-N+1..=i])`，原始值直取。
- 参数 `period` 20；首个有效值 `N-1`。夹具容差固定 `absolute:1e-9`（等价精确）。
- **口径裁定**：只输出 `HHV` / `LLV`，**不补中轨/带宽**；窗口 `i−N+1 … i` **含当前根**。已裁定，见 `b2-beta-rulings.md` R-05。

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

### V08 GAPO

- `GAPO = (Open - 前收) / ATR(N) × 100`，ATR 周期默认 14（裁定 R-06，按 Story 卡 AC-03.05-33/34）。
- **口径裁定**：分母用 `ATR(period)`（默认 14）；**保留正负号、不筛同向**。已裁定，见 `b2-beta-rulings.md` R-06。

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

## beta 裁定

6 条 beta 歧义的裁定值、可测断言与 manifest 处置见
[`b2-beta-rulings.md`](./b2-beta-rulings.md)（R-01 ~ R-06）：

- **转 normal**：T13（R-01）、T15（R-02）、T23（R-04）、T24（R-05）、V08（R-06）；
- **保留 beta**：T16（R-03）——初始方向与首根 SAR 各家不一致，待商业软件逐点对照。

裁定只冻结口径，不代表 B2 指标进入 UI，也不代表 Story 卡可结项。
