import type { AppError } from "../lib/types";

type StateTone = "empty" | "error" | "loading";

interface StateCardProps {
  tone: StateTone;
  title: string;
  description?: string;
  error?: AppError;
  actionLabel?: string;
  onAction?: () => void;
  /** 追踪锚点：`market-empty` / `watchlist-error` 等 */
  anchor?: string;
}

/**
 * 统一状态卡规范（S-08.02-04）：
 * 1. 标题说清「发生了什么」；2. 描述说清「为什么/影响范围」；3. 至少一个可执行动作；
 * 4. 错误态必须给出可直接复制的错误码，禁止只显示原始异常字符串。
 */
export function StateCard({
  tone,
  title,
  description,
  error,
  actionLabel,
  onAction,
  anchor,
}: StateCardProps) {
  const detail = description ?? error?.message;
  return (
    <div
      className={`state-card state-card--${tone}`}
      data-state-card={anchor ?? tone}
      role={tone === "error" ? "alert" : "status"}
    >
      <div className="state-card__icon" aria-hidden>
        {tone === "error" ? "!" : tone === "loading" ? "…" : "○"}
      </div>
      <div className="state-card__body">
        <div className="state-card__title">{title}</div>
        {detail && <p className="state-card__desc">{detail}</p>}
        {tone === "error" && error && (
          <button
            type="button"
            className="state-card__code mono"
            title="点击复制错误码"
            onClick={() => void navigator.clipboard?.writeText(`${error.code}: ${error.message}`)}
          >
            {error.code}
          </button>
        )}
        {actionLabel && onAction && (
          <button type="button" className="state-card__action" onClick={onAction}>
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}
