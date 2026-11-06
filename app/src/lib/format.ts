/**
 * 全局格式与密度（S-06.02-01）：所有金额/量/涨跌文本只从这里出，页面不得各写一套。
 * 口径：价格与涨跌 2 位小数；成交量股→手；大数按 亿/万 2 位小数；涨跌带正负号。
 */

const DASH = "—";

export function formatPrice(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return DASH;
  return value.toFixed(digits);
}

export function formatSigned(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return DASH;
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

export function formatPct(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return DASH;
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

/** 大数统一口径：≥1 亿→亿，≥1 万→万，其余保留 2 位小数；单位由调用方拼。 */
export function formatCompact(value: number, unit = ""): string {
  if (!Number.isFinite(value)) return DASH;
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${(value / 1e8).toFixed(2)} 亿${unit}`;
  if (abs >= 1e4) return `${(value / 1e4).toFixed(2)} 万${unit}`;
  return `${value.toFixed(2)}${unit}`;
}

/** 成交量：数据层为「股」，界面统一以「手」呈现（1 手 = 100 股）。 */
export function formatVolume(shares: number): string {
  if (!Number.isFinite(shares)) return DASH;
  return formatCompact(shares / 100, "手");
}

/** 成交额：数据层为「元」，界面按 亿/万元 呈现。 */
export function formatAmount(yuan: number): string {
  if (!Number.isFinite(yuan)) return DASH;
  return formatCompact(yuan, "元");
}

/** 涨跌语义色：只用于 DOM class，颜色仍来自 --pos/--neg。 */
export function signClass(value: number | null | undefined): "pos" | "neg" | "flat" {
  if (value == null || !Number.isFinite(value) || value === 0) return "flat";
  return value > 0 ? "pos" : "neg";
}

export function formatDate(iso: string): string {
  return iso.length >= 10 ? iso.slice(5, 10) : iso;
}

export function formatComputedMs(value: number): string {
  if (value <= 0) return "<0.01";
  return value < 10 ? value.toFixed(2) : value.toFixed(1);
}
