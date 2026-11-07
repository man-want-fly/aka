const DASH = "—";

/** epoch 秒 → 本地时区 `YYYY-MM-DD HH:mm`；非法值返回 `—`。 */
export function formatDateTime(epoch: number): string {
  if (!Number.isFinite(epoch) || epoch <= 0) return DASH;
  const date = new Date(epoch * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}
