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
