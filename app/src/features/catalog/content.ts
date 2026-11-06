/** P4 口径页内容：公式与关键口径描述；参数/预热/边界来自 registry 与 manifest。 */
export interface CatalogFormula {
  formula: string;
  tolerance: string;
}

export const B1_FORMULAS: Record<string, CatalogFormula> = {
  T01: {
    formula: "SMA(N) = (C₁ + C₂ + … + C_N) / N，滚动窗口均值。",
    tolerance: "价格口径 · relative 1e-6",
  },
  T02: {
    formula: "EMA(N)：α = 2/(N+1)，首值取前 N 根 SMA 为种子，其后 EMA = α·C + (1-α)·EMA₋₁。",
    tolerance: "价格口径 · relative 1e-6",
  },
  T03: {
    formula: "WMA(N) = Σ(Cᵢ·wᵢ)/Σwᵢ，权重 wᵢ = 1…N（最新一根权重最大）。",
    tolerance: "价格口径 · relative 1e-6",
  },
  T04: {
    formula: "DEMA(N) = 2·EMA(N) − EMA(EMA(N))。需要 3N−1 根有效收盘价才能输出首个值。",
    tolerance: "价格口径 · relative 1e-6",
  },
  T05: {
    formula: "TEMA(N) = 3·EMA − 3·EMA(EMA) + EMA(EMA(EMA))。需要约 4.5N 根预热。",
    tolerance: "价格口径 · relative 1e-6",
  },
  T19: {
    formula: "OLS 拟合 y = a + b·x（x=0…N−1），Forecast = a + b·(N−1)（当前根拟合值，不外推下一根）。",
    tolerance: "价格口径 · relative 1e-6",
  },
  T20: {
    formula: "同一 OLS 的截距 a，即窗口起点处的拟合值。",
    tolerance: "价格口径 · relative 1e-6",
  },
  T21: {
    formula: "R² = 1 − SS_res/SS_tot，衡量窗口内线性拟合优度，值域 [0, 1]。",
    tolerance: "无量纲 · absolute 1e-6",
  },
  T22: {
    formula: "同一 OLS 的斜率 b（元/根），表示窗口内每根 K 线的平均价格变化。",
    tolerance: "价格斜率 · relative 1e-6",
  },
  E13: {
    formula: "BIAS(N) = (C − MA(N)) / MA(N) × 100%，输出 6/12/24 三条带符号百分比。",
    tolerance: "百分比 · absolute 1e-4",
  },
  M06: {
    formula: "DIF = EMA(fast) − EMA(slow)；DEA = EMA(signal)(DIF)；柱 = 2×(DIF − DEA)。",
    tolerance: "副图 · absolute 1e-4",
  },
};

/** B3 动量/摆动 13 条新口径（M06 已计入 B1；正文与 docs/indicators/b3-momentum-oscillators.md 同源）。 */
export const B3_FORMULAS: Record<string, CatalogFormula> = {
  M01: {
    formula:
      "涨幅/跌幅取 Wilder 平滑（种子=前 N 个有效差值的算术均值）；RSI = 100 − 100/(1+RS)，RS = 平均涨幅/平均跌幅。N=14，首值下标 14；平均跌幅为 0 输出 100，平均涨幅为 0 输出 0。",
    tolerance: "百分比振荡 · absolute 1e-4",
  },
  M02: {
    formula:
      "RSV = (C − LLV(L,N))/(HHV(H,N) − LLV(L,N))×100；K = ((k−1)·K₋₁ + RSV)/k、D = ((d−1)·D₋₁ + K)/d，种子 K₀=D₀=50；J = 3K − 2D。N=9、k=d=3，首值下标 8。高低差为 0 时 RSV 取 50（beta 待裁定）。",
    tolerance: "百分比振荡 · absolute 1e-4（beta）",
  },
  M04: {
    formula:
      "%R = (HHV(H,N) − C)/(HHV(H,N) − LLV(L,N))×−100，值域 [−100, 0]。N=14，首值下标 13；高低差为 0 输出 NaN。",
    tolerance: "百分比振荡 · absolute 1e-4",
  },
  M05: {
    formula:
      "TP = (H+L+C)/3；CCI = (TP − SMA(TP,N))/(0.015×平均绝对偏差)，平均绝对偏差 = mean(|TPᵢ − SMA|)。N=20，首值下标 19；偏差为 0 输出 NaN。",
    tolerance: "无量纲振荡 · absolute 1e-4",
  },
  M08: {
    formula:
      "PPO = (EMA(fast) − EMA(slow))/EMA(slow)×100；信号线 = PPO 的 EMA(signal)。默认 12/26/9，首值下标 slow+signal−2=33；fast<slow，慢线为 0 时 NaN。本口径只出双线，不出柱。",
    tolerance: "百分比振荡 · absolute 1e-4",
  },
  M09: {
    formula: "ROC = (C − C₋N)/C₋N×100。N=12，首值下标 12；前值为 0 输出 NaN。",
    tolerance: "百分比振荡 · absolute 1e-4",
  },
  M10: {
    formula: "MOM = C − C₋N，差额单位元。N=10，首值下标 10。",
    tolerance: "价格口径 · relative 1e-6",
  },
  M19: {
    formula:
      "Aroon Up = 100×(N − 距最高价根数)/N；Aroon Down 同理取最低价。窗口 N 根含当前根，默认 25，首值下标 24；并列极值取窗口内最近一次。",
    tolerance: "百分比振荡 · absolute 1e-4",
  },
  M20: {
    formula:
      "VI+ = Σ|Hᵢ − Lᵢ₋₁|/ΣTR；VI− = Σ|Lᵢ − Hᵢ₋₁|/ΣTR，窗口 N，TR 为真实波幅。N=14，首值下标 14；ΣTR 为 0 输出 NaN。",
    tolerance: "无量纲振荡 · absolute 1e-4",
  },
  M21: {
    formula:
      "CMO = 100×(Σ涨幅 − Σ跌幅)/(Σ涨幅 + Σ跌幅)，窗口 N 内逐根收盘差。N=14，首值下标 14；分母为 0 输出 NaN。",
    tolerance: "百分比振荡 · absolute 1e-4",
  },
  M24: {
    formula:
      "Mass = Σ[EMA9(H−L)/EMA9(EMA9(H−L))]，求和 25 根。首值下标 40 = 2×(9−1)+25−1。CSV 声明 warmup=30 与递推实算不一致（beta 待裁定）。",
    tolerance: "无量纲比值 · relative 1e-6（beta）",
  },
  M25: {
    formula:
      "脉冲线 = EMA13(2×(DIF−DEA))；状态 state ∈ {−1,0,1}：柱>0 且脉冲上行 → 1，柱<0 且脉冲下行 → −1，其余 0。默认 12/26/9/13，首值下标 46（state 需前一根脉冲）。三色规则与 EMA 对象存在多种实现（beta 待裁定）。",
    tolerance: "副图 · absolute 1e-4（beta）",
  },
  M26: {
    formula: "range = H − L；当根振幅为近 7 根最小 → 1，否则 0。首值下标 6。",
    tolerance: "0/1 计数 · 严格相等",
  },
};

/** B2 通道/波动 20 条口径（正文与 docs/indicators/b2-channel-volatility.md 同源）。 */
export const B2_FORMULAS: Record<string, CatalogFormula> = {
  T08: {
    formula:
      "中轨 = SMA(C, N)；上轨 = 中轨×(1+pct/100)；下轨 = 中轨×(1−pct/100)。N=20、pct=2.5，首值下标 N−1。",
    tolerance: "价格口径 · relative 1e-6",
  },
  T09: {
    formula:
      "中轨 = SMA(C, N)；σ 为样本标准差（ddof=1）；上/下轨 = 中轨 ± kσ。N=20、k=2.0，首值下标 N−1。",
    tolerance: "价格口径 · relative 1e-6",
  },
  T10: {
    formula:
      "中轨 = EMA(C, N)；ATR(N) 为 Wilder 平滑；上/下轨 = 中轨 ± k×ATR。N=20、k=2.0，首值下标 N；ATR 未就绪时中轨同步 NaN。",
    tolerance: "价格口径 · relative 1e-6",
  },
  T11: {
    formula: "上轨 = 近 N 根最高价 HHV(high, N)；下轨 = 近 N 根最低价 LLV(low, N)，不做平滑。N=20，首值下标 N−1。",
    tolerance: "价格口径 · relative 1e-6",
  },
  T12: {
    formula:
      "中轨 = SMA(C, N)；上/下轨 = 中轨 ± k×ATR(N)（Wilder）。N=20、k=2.0，首值下标 N。",
    tolerance: "价格口径 · relative 1e-6",
  },
  T13: {
    formula:
      "ATR(14)、k=3.5。多头止损 = max(前值, C−k×ATR)，收盘跌破前值翻空；空头止损 = min(前值, C+k×ATR)，收盘升破翻多。翻向当根冻结旧止损值，未激活一侧 NaN。",
    tolerance: "价格口径 · relative 1e-6",
  },
  T14: {
    formula:
      "多头 = HHV(high, N) − k×ATR(N)；空头 = LLV(low, N) + k×ATR(N)。N=22、k=3.0，首值下标 N。",
    tolerance: "价格口径 · relative 1e-6",
  },
  T15: {
    formula:
      "转换线 = (HHV9+LLV9)/2；基准线 = (HHV26+LLV26)/2；先行带 A = (转换+基准)/2、B = (HHV52+LLV52)/2，向未来位移 26 根；迟行线 = C 向过去位移 26 根。首值下标 77，位移后末尾 26 根为 NaN（不回填未来值）。",
    tolerance: "价格口径 · relative 1e-6",
  },
  T16: {
    formula:
      "SAR = prev_SAR + AF×(EP−prev_SAR)，按前两根极值夹逼；反转时 SAR = EP、EP 取当根极值、AF 重置为 0.02，否则 AF = min(AF+0.02, 0.2)。首值下标 1。",
    tolerance: "价格口径 · relative 1e-6（beta，口径待三家对照）",
  },
  T23: {
    formula: "P = (H+L+C)/3；R1 = 2P−L；S1 = 2P−H，H/L/C 取上一根。无参数，首值下标 1；只输出 P/R1/S1。",
    tolerance: "价格口径 · relative 1e-6",
  },
  T24: {
    formula: "HHV = max(high[i−N+1 … i])；LLV = min(low[i−N+1 … i])，窗口含当前根，原始值直取。N=20，首值下标 N−1。",
    tolerance: "原始窗口最值 · absolute 1e-9",
  },
  V01: {
    formula:
      "TR[0]=NaN；TR[i]=max(H−L, |H−PC|, |L−PC|)；ATR 为 TR 的 Wilder 平滑，种子 = 前 N 个有效 TR 的算术均值。N=14，首值下标 N。",
    tolerance: "价格口径 · relative 1e-6",
  },
  V02: {
    formula: "ATRP = ATR(N)/C，无量纲比值（不是百分数）；C=0 时 NaN。N=14。",
    tolerance: "无量纲 · absolute 1e-4",
  },
  V03: {
    formula: "σ = sqrt(Σ(C−C̄)²/(N−1))，样本标准差 ddof=1。N=20，首值下标 N−1。",
    tolerance: "价格口径 · relative 1e-6",
  },
  V04: {
    formula: "带宽 = (上轨−下轨)/中轨 = 2kσ/SMA(C, N)，无量纲比值；中轨为 0 时 NaN。N=20、k=2.0。",
    tolerance: "无量纲 · absolute 1e-4",
  },
  V05: {
    formula: "%B = (C−下轨)/(上轨−下轨)；零带宽（σ=0）输出 NaN。N=20、k=2.0。",
    tolerance: "无量纲 · absolute 1e-4",
  },
  V07: {
    formula: "窗口 N 内 回撤 = (C−窗口峰值)/窗口峰值×100；UI = sqrt(mean(回撤²))。N=14，峰值 ≤0 时 NaN。",
    tolerance: "无量纲 · absolute 1e-4",
  },
  V08: {
    formula: "GAPO = (Open − 前收)/ATR(N)×100，ATR 周期 14；保留正负号、不按同向筛选。",
    tolerance: "百分比 · absolute 1e-4",
  },
  V09: {
    formula: "振幅 = High − Low（元），单根直接输出，首根即有效。",
    tolerance: "价格口径 · relative 1e-6",
  },
  V10: {
    formula: "TR[0]=NaN；TR[i]=max(H−L, |H−PC|, |L−PC|)，单根直接输出。",
    tolerance: "价格口径 · relative 1e-6",
  },
};
