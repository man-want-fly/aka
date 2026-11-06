# B3 动量 / 摆动批次口径（14 指标：13 新增 + M06 已在 B1）

> 适用范围：`app/manifest/indicators.json` 中 M01、M02、M04、M05、M06、M08、M09、M10、
> M19、M20、M21、M24、M25、M26 共 14 条。其中 **M06 MACD 已在 B1 实现**（`indicator-core` 根模块），
> 本批只补口径文档与夹具覆盖；其余 **13 条**在 `indicator-core::indicators::b3` 新增。
> 参考实现为 `indicator-golden/fixtures/gen_reference.py`，与 Rust 实现逐点对拍。
> 容差沿用 B1 冻结规则：价格类 `relative:1e-6`，无量纲振荡 `absolute:1e-4`，
> M26 布尔输出按计数严格相等。

## 通用约定

- `warmup` 为「首个有效值下标（0 基）」，即**全部输出列同时有效**的起点；预热不足整列 `NaN`。
- 多输出指标中较早可算的列（如 PPO 的 PPO 线早于信号线）按各自递推起点输出，但注册表
  `warmup` 取最后一列就绪的下标，避免 UI 在未就绪时读数。
- 除零/零区间一律输出 `NaN`，不用 0 代替；只有规则明确要求（RSI 的 0/100、KDJ 的 RSV=50）
 才给有限值，且逐条写明。
- 所有指标只读 `close` 或 `high/low/close`，不读成交量。

## 摆动类

### M01 RSI

- 涨幅 `gain[i]=max(C[i]-C[i-1], 0)`、跌幅 `loss[i]=max(C[i-1]-C[i], 0)`，均以 Wilder 平滑
  （种子 = 前 `N` 个有效差值的算术均值，之后 `avg = (avg×(N-1)+x)/N`）。
- `RSI = 100 - 100/(1 + avg_gain/avg_loss)`。
- 参数：`period` 默认 14。首个有效值 `N = 14`。
- 边界：`avg_loss == 0 → 100`；`avg_gain == 0 → 0`；两者均为 0（全程横盘）按前者取 100。

### M02 KDJ（beta）

- `RSV = (C - LLV(low,N)) / (HHV(high,N) - LLV(low,N)) × 100`。
- `K = ((k-1)×K[-1] + RSV)/k`，`D = ((d-1)×D[-1] + K)/d`，种子 `K[-1]=D[-1]=50`；
  `J = 3K - 2D`。
- 参数：`period` 9、`k` 3、`d` 3。首个有效值 `period-1 = 8`（0 基；CSV 写作 9 为 1 基根数）。
- **beta 原因（保留 beta）**：高低差为 0 时 RSV 取 50 是本产品约定；通达信（除零后沿用/取 0）、
  同花顺与 TA-Lib（Stoch 不输出 J、平滑用 SMA）均不一致，且 KDJ 的种子 50 与首次平滑是否
  需要额外预热没有统一公开公式可逐点核对，故**保留 beta**，待 BA 裁定（见
  `docs/qa/aka-b3-numeric-evidence-v0.1.md` §5 Q-01）。

### M04 Williams %R

- `%R = (HHV(high,N) - C) / (HHV(high,N) - LLV(low,N)) × -100`，值域 `[-100, 0]`。
- 参数：`period` 默认 14。首个有效值 `N-1 = 13`。
- 边界：高低差为 0 输出 `NaN`。

### M05 CCI

- `TP = (H+L+C)/3`；`SMA = SMA(TP,N)`；`平均绝对偏差 = mean(|TP[i-N+1..=i] - SMA|)`；
  `CCI = (TP - SMA) / (0.015 × 平均绝对偏差)`。
- 参数：`period` 默认 20。首个有效值 `N-1 = 19`。
- 边界：平均绝对偏差为 0（窗口内 TP 全等）输出 `NaN`。

## 动量类

### M06 MACD（B1 已实现，beta 沿用）

- `DIF = EMA(fast) - EMA(slow)`；`DEA = EMA(signal)(DIF)`；柱 `= 2×(DIF - DEA)`。
- 参数：12 / 26 / 9。首个有效值 `slow+signal-2 = 33`。
- **beta 原因**：柱的 2× 系数按 A 股惯例实现，但 TradingView/TA-Lib 为 1×；B1 起标 beta，
  本批不改状态，等待统一裁定。

### M08 PPO

- `PPO = (EMA(fast) - EMA(slow)) / EMA(slow) × 100`；`信号线 = EMA(signal)(PPO)`。
- 参数：`fast` 12、`slow` 26、`signal` 9；`fast < slow`，否则返回参数错误。
- 首个有效值 `slow+signal-2 = 33`；PPO 线本身自 `slow-1 = 25` 起有效。
- 边界：慢线为 0 输出 `NaN`；本口径**只出双线，不出柱**（CSV 要求「百分比双线」）。

### M09 ROC

- `ROC = (C - C[-N]) / C[-N] × 100`。
- 参数：`period` 默认 12。首个有效值 `N = 12`。
- 边界：前值为 0 输出 `NaN`。

### M10 Momentum

- `MOM = C - C[-N]`，单位为元。
- 参数：`period` 默认 10。首个有效值 `N = 10`。

### M19 Aroon

- `Aroon Up = 100 × (N - 距最高价根数) / N`；`Aroon Down` 同理取最低价。
- 窗口 `N` 根含当前根；默认 25，首个有效值 `N-1 = 24`。
- 边界：窗口内并列极值取**最近一次**（使 Up/Down 更贴近「刚发生的高/低点」）。

### M20 Vortex

- `VI+ = Σ|H[i] - L[i-1]| / ΣTR`；`VI- = Σ|L[i] - H[i-1]| / ΣTR`，窗口 `N`。
- `TR` 为真实波幅；默认 14，首个有效值 `N = 14`（需要前一根 L/H）。
- 边界：`ΣTR == 0` 输出 `NaN`。

### M21 CMO

- 逐根收盘差 `d[i]=C[i]-C[i-1]`；窗口 `N` 内
  `CMO = 100 × (Σ正差 - Σ负差绝对值) / (Σ正差 + Σ负差绝对值)`。
- 参数：`period` 默认 14。首个有效值 `N = 14`。
- 边界：分母为 0（窗口全程无涨跌）输出 `NaN`。

### M24 Mass Index（beta）

- `range = H - L`；`first = EMA9(range)`；`second = EMA9(first)`；
  `Mass = Σ(first/second, 25)`。
- 参数：`ema` 9、`sum` 25。首个有效值 `2×(9-1)+25-1 = 40`。
- **beta 原因（保留 beta）**：规划 CSV 的 warmup 写 30，与递推实算的首个有效值 40 不一致
  （EMA 两次各需 8 根、25 根求和再需 24 根）。本实现按公式实算 40，**不自行改口径**，
  待 BA 裁定是采用 CSV 的 30（需换 EMA 种子/窗口定义）还是修正 CSV（见
  `docs/qa/aka-b3-numeric-evidence-v0.1.md` §5 Q-02）。

### M25 Elder Impulse（beta）

- `hist = 2×(DIF - DEA)`（与 M06 同源）；`impulse = EMA13(hist)`；
  `state ∈ {-1,0,1}`：`hist>0 且 impulse 上行 → 1`、`hist<0 且 impulse 下行 → -1`、其余 `0`。
- 参数：12 / 26 / 9 / `ema` 13。首个有效值 `slow+signal+ema-2 = 46`
  （impulse 自 45 起，state 需前一根 impulse）。
- **beta 原因（保留 beta）**：Elder 原版对「脉冲」取 MACD 柱的 EMA13，但柱的系数（1×/2×）、
  三色边界（是否要求柱穿越零轴、是否用 EMA 斜率而非差分）在各平台不一致，故保留 beta，
  待 BA 裁定（见 `docs/qa/aka-b3-numeric-evidence-v0.1.md` §5 Q-03）。

### M26 NR7

- `range = H - L`；当根振幅为近 7 根最小 → `1`，否则 `0`。
- 参数：`period` 默认 7。首个有效值 `N-1 = 6`。
- 边界：并列最小按「是」处理（等值时输出 1）。

## 夹具与证据

| 项 | 位置 |
| --- | --- |
| Manifest | `app/manifest/indicators.json`（14 条 B3，含 3 条 beta） |
| 黄金夹具 | `base_b3_momentum_seed42_520`（14 case）、`edge_b3_constant_ohlc`（14）、`edge_b3_insufficient`（14）、`edge_b3_first_bar`（14） |
| 夹具生成 | `python3 crates/indicator-golden/fixtures/gen_reference.py` |
| 性能记录 | `app/bench/baselines/macos-<arch>.json`（44 指标 × 520/2500，共 88 case） |
| 单测 | `indicator-core::indicators::b3::tests`（预热/值域/0-1/常数/参数拒绝）+ 注册表 44 条 |
| 数值证据 | `docs/qa/aka-b3-numeric-evidence-v0.1.md` |

## beta 清单（不自行拍定）

| 指标 | 待裁定问题 | 当前实现 |
| --- | --- | --- |
| M02 KDJ | 零区间 RSV 取值、种子与额外预热 | RSV=50，种子 50/50，无额外预热 |
| M24 Mass Index | CSV warmup=30 与实算 40 冲突 | 按实算 40 |
| M25 Elder Impulse | 柱系数、三色边界、脉冲对象 | 2× 柱 + EMA13(柱) + 差分斜率 |
| M06 MACD | 柱 2× vs 1× | 2×（B1 起沿用） |
