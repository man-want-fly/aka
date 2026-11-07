import { useEffect, useMemo, useRef } from "react";
import { ipc } from "../lib/ipc";
import type { AppError } from "../lib/types";

type StateTone = "empty" | "error" | "loading";

interface StateCardProps {
  tone: StateTone;
  title: string;
  description?: string;
  error?: AppError;
  actionLabel?: string;
  onAction?: () => void;
  /** 该动作是否为「重试」；重试只对可重试错误展示（AC-08.02-05） */
  retryAction?: boolean;
  /** 次要动作，例如损坏数据的「导出诊断」 */
  secondaryLabel?: string;
  onSecondary?: () => void;
  /** 追踪锚点：`market-empty` / `watchlist-error` 等 */
  anchor?: string;
}

let traceSeq = 0;
const generatedTraceIds = new WeakMap<AppError, string>();

function generatedTraceId(error: AppError): string {
  const cached = generatedTraceIds.get(error);
  if (cached) return cached;
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  traceSeq = (traceSeq + 1) % 10_000;
  const id = `TR-${date}-${time}-${String(traceSeq).padStart(4, "0")}`;
  generatedTraceIds.set(error, id);
  return id;
}

function traceIdOf(error: AppError): string {
  const fromBackend = error.details?.traceId;
  return typeof fromBackend === "string" && fromBackend.length > 0
    ? fromBackend
    : generatedTraceId(error);
}

/**
 * 统一状态卡规范（S-08.02-04）：
 * 1. 标题说清「发生了什么」；2. 描述说清「为什么/影响范围」；3. 错误码可直接复制；
 * 4. 追踪号可复制且与 `error.card` 埋点同值；5. 动作组（主/次），重试仅限可重试错误。
 */
export function StateCard({
  tone,
  title,
  description,
  error,
  actionLabel,
  onAction,
  retryAction = false,
  secondaryLabel,
  onSecondary,
  anchor,
}: StateCardProps) {
  const detail = description ?? error?.message;
  const traceId = useMemo(() => (error ? traceIdOf(error) : null), [error]);
  const loggedTrace = useRef<string | null>(null);

  useEffect(() => {
    if (tone !== "error" || !error || !traceId) return;
    if (loggedTrace.current === traceId) return;
    loggedTrace.current = traceId;
    void ipc.telemetryNote("error.card", {
      code: error.code,
      level: "error",
      traceId,
      anchor: anchor ?? tone,
    });
  }, [tone, error, traceId, anchor]);

  const showPrimary = Boolean(actionLabel && onAction) && (!retryAction || Boolean(error?.retryable));

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
        {tone === "error" && error && traceId && (
          <div className="state-card__meta">
            <button
              type="button"
              className="state-card__code mono"
              title="点击复制错误码"
              onClick={() =>
                void navigator.clipboard?.writeText(`${error.code}: ${error.message} (${traceId})`)
              }
            >
              {error.code}
            </button>
            <button
              type="button"
              className="state-card__trace mono"
              data-state-trace={traceId}
              title="点击复制追踪号"
              onClick={() => void navigator.clipboard?.writeText(traceId)}
            >
              {traceId}
            </button>
          </div>
        )}
        {(showPrimary || (secondaryLabel && onSecondary)) && (
          <div className="state-card__actions">
            {showPrimary && (
              <button type="button" className="state-card__action" onClick={onAction}>
                {actionLabel}
              </button>
            )}
            {secondaryLabel && onSecondary && (
              <button
                type="button"
                className="state-card__action state-card__action--secondary"
                onClick={onSecondary}
              >
                {secondaryLabel}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
