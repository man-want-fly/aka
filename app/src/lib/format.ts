export function formatPrice(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

export function formatSigned(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

export function formatPct(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

/** 成交量：股 → 万/亿 */
export function formatVolume(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1e8) return `${(value / 1e8).toFixed(2)} 亿`;
  if (Math.abs(value) >= 1e4) return `${(value / 1e4).toFixed(1)} 万`;
  return value.toFixed(0);
}

/** 成交额：元 → 亿/万 */
export function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1e8) return `${(value / 1e8).toFixed(2)} 亿`;
  if (Math.abs(value) >= 1e4) return `${(value / 1e4).toFixed(1)} 万`;
  return value.toFixed(0);
}

export function formatDate(iso: string): string {
  return iso.length >= 10 ? iso.slice(5, 10) : iso;
}

export function formatComputedMs(value: number): string {
  if (value <= 0) return "<0.01";
  return value < 10 ? value.toFixed(2) : value.toFixed(1);
}
