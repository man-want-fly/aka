/**
 * 全局格式与密度（S-06.02-01）：所有金额/量/涨跌文本只从这里出，页面不得各写一套。
 * 口径（AC-06.02-02）：
 * - 价格/涨跌额 2 位小数 + 千分位；正数 `+`、负数 `−`（U+2212）
 * - 百分比 2 位 + `%`，正负号同上
 * - 成交量：内部股 → 界面手（÷100），1 位小数 + 万/亿
 * - 成交额：元 → 2 位小数 + 万/亿
 */

const DASH = "—";
const MINUS = "\u2212";

function groupInt(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 绝对值定小数 + 千分位；符号由调用方决定。 */
function fixedAbs(value: number, digits: number): string {
  const [intPart, frac] = Math.abs(value).toFixed(digits).split(".");
  return frac === undefined ? groupInt(intPart) : `${groupInt(intPart)}.${frac}`;
}

export function formatPrice(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return DASH;
  return `${value < 0 ? MINUS : ""}${fixedAbs(value, digits)}`;
}

/** 定点显示（无千分位）：指标参数等非行情四类数值。 */
export function formatFixed(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return DASH;
  return `${value < 0 ? MINUS : ""}${Math.abs(value).toFixed(digits)}`;
}

/** 带符号差值（涨跌额等）：正数 `+`、负数 `−`。 */
export function formatSigned(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return DASH;
  return `${value >= 0 ? "+" : MINUS}${fixedAbs(value, digits)}`;
}

export function formatPct(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return DASH;
  return `${value >= 0 ? "+" : MINUS}${Math.abs(value).toFixed(digits)}%`;
}

/** 万/亿归一：≥1 亿 → 亿，≥1 万 → 万，其余原值；均带千分位。 */
function scaled(value: number, digits: number, unit: string): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? MINUS : "";
  if (abs >= 1e8) return `${sign}${fixedAbs(abs / 1e8, digits)}亿${unit}`;
  if (abs >= 1e4) return `${sign}${fixedAbs(abs / 1e4, digits)}万${unit}`;
  return `${sign}${fixedAbs(abs, digits)}${unit}`;
}

/** 兼容旧调用：大数统一按 万/亿 归一，2 位小数。 */
export function formatCompact(value: number, unit = ""): string {
  if (!Number.isFinite(value)) return DASH;
  return scaled(value, 2, unit);
}

/** 成交量：数据层为「股」，界面统一以「手」呈现（1 手 = 100 股），1 位小数。 */
export function formatVolume(shares: number): string {
  if (!Number.isFinite(shares)) return DASH;
  return scaled(shares / 100, 1, "手");
}

/** 成交额：数据层为「元」，界面按 亿/万 呈现，2 位小数。 */
export function formatAmount(yuan: number): string {
  if (!Number.isFinite(yuan)) return DASH;
  return scaled(yuan, 2, "");
}

/** 指标值：按输出类型复用价格 / 百分比 / 量 的口径。 */
export function formatIndicator(value: number, kind: "price" | "percent" | "volume"): string {
  if (kind === "percent") return formatPct(value);
  if (kind === "volume") return formatVolume(value);
  return formatPrice(value);
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
