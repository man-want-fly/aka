import { useEffect, useRef, useState } from "react";

interface Plan {
  key: "A" | "B";
  range: string;
  calls: string;
  eta: string;
  adjust: string;
}

/** 卡面固定口径：两套方案参数不接受运行时输入，也不联网重算。 */
const PLANS: Plan[] = [
  {
    key: "A",
    range: "最近 60 个交易日",
    calls: "≈124 次",
    eta: "≈2.2 小时",
    adjust: "复权因子按日合并",
  },
  {
    key: "B",
    range: "最近 3 年",
    calls: "≈1452 次",
    eta: "≈26.2 小时",
    adjust: "复权因子按日合并",
  },
];

const TOAST_TEXT = "本期不提供历史回填，仅使用内置模拟数据";
const TOAST_MS = 2_000;

/**
 * P9 历史回填区（S-07.04-01）：纯静态展示成本，全部按钮禁用。
 * 不调用 IPC、不写库、不排队；断网时同样完整显示。
 */
export function BackfillSection() {
  const [toastVisible, setToastVisible] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const showToast = () => {
    // 2 秒内不叠加：已显示时直接忽略重复点击。
    if (timerRef.current !== null) return;
    setToastVisible(true);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setToastVisible(false);
    }, TOAST_MS);
  };

  return (
    <section className="ds-card ds-backfill" data-backfill-section="1">
      <header className="ds-card-head">
        <div className="ds-card-title">
          <h2>历史回填（本期不提供）</h2>
          <span className="ds-badge">仅说明</span>
        </div>
      </header>
      <p className="ds-sub ds-backfill-note">
        离线单机、无账户，回填需要外部数据源与 token。
      </p>

      <table className="bf-table">
        <thead>
          <tr>
            <th scope="col">方案</th>
            <th scope="col">区间</th>
            <th scope="col">调用次数</th>
            <th scope="col">预计耗时</th>
            <th scope="col">复权因子处理</th>
            <th scope="col" aria-label="操作" />
          </tr>
        </thead>
        <tbody>
          {PLANS.map((plan) => (
            <tr key={plan.key} data-backfill-plan={plan.key}>
              <td>{plan.key}</td>
              <td data-backfill-range="1">{plan.range}</td>
              <td data-backfill-calls="1">{plan.calls}</td>
              <td data-backfill-eta="1">{plan.eta}</td>
              <td data-backfill-adjust="1">{plan.adjust}</td>
              <td className="bf-action-cell">
                <span className="bf-action-wrap">
                  <button
                    type="button"
                    className="bf-button"
                    data-backfill-action={plan.key}
                    disabled
                    title={TOAST_TEXT}
                  >
                    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                      <path
                        d="M4.5 7V5.5a3.5 3.5 0 0 1 7 0V7M3.5 7h9v6.5h-9z"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.3"
                      />
                    </svg>
                    回填
                  </button>
                  {/* 禁用按钮不派发点击，用覆盖层承接点击只弹说明。 */}
                  <span
                    className="bf-click-catcher"
                    onClick={showToast}
                    aria-hidden="true"
                  />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="bf-footnotes" data-backfill-footnotes="1">
        <li>调用次数 = 标的数 × 交易日；按 3 秒/次限流估算耗时，额度按次消耗。</li>
        <li>前复权锚点 = 最新交易日；复权因子按日合并，不做插值。</li>
        <li>本期无后台任务：不排队、不预约、无进度与预计完成时间。</li>
      </ul>

      {toastVisible && (
        <div className="bf-toast" data-backfill-toast="1" role="status" aria-live="polite">
          {TOAST_TEXT}
        </div>
      )}
    </section>
  );
}
