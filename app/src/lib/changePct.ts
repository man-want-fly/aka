/**
 * W-74：涨跌幅三态判据（卡面 AC-01.01-01（补1））。
 * 数据层 change_pct 决定唯一合法文本，渲染层必须逐行一致：
 * - null（缺前收/停牌）→ `—`
 * - 0（平盘）→ `0.00%`，无 `+`/`−`，也不得 `—`
 * - ≠ 0 → `+`/`−`（U+2212）+ 2 位小数 + `%`
 */
const DASH = "—";
const MINUS = "\u2212";

export function expectedChangePctText(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  if (value === 0) return (0).toFixed(2) + "%";
  return `${value > 0 ? "+" : MINUS}${Math.abs(value).toFixed(2)}%`;
}

/** 返回 null 表示一致；否则给出可直接落证据的差异描述。 */
export function changePctMismatch(
  value: number | null | undefined,
  domText: string,
): string | null {
  const expected = expectedChangePctText(value);
  if (domText === expected) return null;
  return `数据=${value ?? "null"} 期望="${expected}" DOM="${domText}"`;
}
