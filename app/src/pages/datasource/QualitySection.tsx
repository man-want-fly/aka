import { useCallback, useEffect, useState } from "react";
import { formatRowCount } from "../../features/workbench/datasetOverview";
import { formatDateTime } from "../../lib/datetime";
import { formatFixed } from "../../lib/format";
import { describeError, ipc, isTauriRuntime } from "../../lib/ipc";
import type { QualityCheckDto, QualityReportDto } from "../../lib/types";

const STATUS_TEXT: Record<QualityCheckDto["status"], string> = {
  pass: "通过",
  info: "信息",
  warning: "警告",
  failed: "失败",
};

const STATUS_TONE: Record<QualityCheckDto["status"], "ok" | "info" | "warn" | "bad"> = {
  pass: "ok",
  info: "info",
  warning: "warn",
  failed: "bad",
};

const DASH = "—";

function countText(value: number): string {
  return formatRowCount(value) ?? "0";
}

/** P9 数据质量区（S-07.05-01）：6 行报告 + 汇总条 + 过期/失败态。 */
export function QualitySection() {
  const [report, setReport] = useState<QualityReportDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isTauriRuntime()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setReport(await ipc.qualityReport());
    } catch {
      // 读缓存失败不阻塞页面，交给「重新检查」。
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const scan = async () => {
    if (!isTauriRuntime()) return;
    setScanning(true);
    setScanError(null);
    try {
      setReport(await ipc.qualityScan());
    } catch (err) {
      const error = describeError(err);
      setScanError(`${error.code} · ${error.message}`);
      // 后端失败不覆盖缓存；重读一次带出最新「过期」标记，保留上次结果。
      try {
        setReport(await ipc.qualityReport());
      } catch {
        /* 连缓存都读不到时保持现状 */
      }
    } finally {
      setScanning(false);
    }
  };

  const stateText = !report
    ? "尚未检查"
    : scanning
      ? "检查中"
      : scanError
        ? "失败保留"
        : report.stale
          ? "过期"
          : report.rows.some((row) => row.status === "failed")
            ? "失败保留"
            : report.passedCount === report.totalCount
              ? "正常"
              : "部分警告";

  return (
    <section className="ds-card ds-quality" data-quality-section="1">
      <header className="ds-card-head">
        <div className="ds-card-title">
          <h2>数据质量</h2>
          <span
            className={`ds-badge ds-badge--${
              stateText === "正常" ? "ok" : stateText === "部分警告" ? "warn" : "bad"
            }`}
            data-quality-state="1"
          >
            {stateText}
          </span>
        </div>
        <div className="ds-summary" data-quality-summary="1">
          {report ? (
            <>
              <span>
                {report.passedCount}/{report.totalCount} 通过
              </span>
              <span className="ds-summary-sep">·</span>
              <span>耗时 {formatFixed(report.durationMs, 0)} ms</span>
              <span className="ds-summary-sep">·</span>
              <span>{formatDateTime(report.scannedAt)}</span>
              <span className="ds-summary-sep">·</span>
              <span className="mono" data-quality-dataset={report.datasetId} title={report.datasetId}>
                {report.datasetId.slice(0, 24)}
              </span>
            </>
          ) : (
            <span>{loading ? "读取中…" : "尚未检查"}</span>
          )}
          <button
            type="button"
            className="ds-refresh"
            data-quality-scan="1"
            disabled={scanning || loading}
            onClick={() => void scan()}
          >
            {scanning ? "检查中…" : "重新检查"}
          </button>
        </div>
      </header>

      {scanError && (
        <div className="ds-error" data-quality-error="1" role="alert">
          <span>
            检查失败：{scanError}
            {report ? "；以下为上次结果 · 已过期" : ""}
          </span>
          <button type="button" onClick={() => void scan()}>
            重试
          </button>
        </div>
      )}

      {report?.stale && (
        <div className="ds-stale" data-quality-stale="1">
          结果基于旧数据集（{report.basedOnDatasetId}），当前为 {report.currentDatasetId}
          <button type="button" onClick={() => void scan()}>
            重新检查
          </button>
        </div>
      )}

      {!report && !scanError && (
        <p className="ds-loading" data-quality-empty="1">
          {loading ? "正在读取质量报告…" : "尚未检查：点击「重新检查」生成 6 项质量报告。"}
        </p>
      )}

      {report && (
        <table className="qa-table">
          <thead>
            <tr>
              <th scope="col">检查项</th>
              <th scope="col">命中数</th>
              <th scope="col">占比</th>
              <th scope="col">处理方式</th>
              <th scope="col">状态</th>
              <th scope="col" aria-label="示例" />
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => {
              const failed = row.status === "failed";
              const tone = STATUS_TONE[row.status];
              return (
                <tr key={row.key} data-quality-row={row.key} data-quality-status={row.status}>
                  <td>{row.labelZh}</td>
                  <td className="mono" data-quality-hits="1">
                    {failed ? DASH : countText(row.hits)}
                  </td>
                  <td className="mono" data-quality-ratio="1">
                    {failed ? DASH : `${formatFixed(row.ratioPct, 1)}%`}
                  </td>
                  <td className="qa-treatment">{row.treatment}</td>
                  <td>
                    <span className={`ds-dot ds-dot--${tone}`} aria-hidden="true" />
                    <span className={`qa-status qa-status--${tone}`}>
                      {STATUS_TEXT[row.status]}
                    </span>
                    {row.errorCode && (
                      <code className="qa-code" data-quality-error-code={row.key}>
                        {row.errorCode}
                      </code>
                    )}
                  </td>
                  <td className="qa-example-cell">
                    {row.examples.length > 0 ? (
                      <button
                        type="button"
                        className="ds-detail"
                        data-quality-examples={row.key}
                        aria-expanded={expanded === row.key}
                        onClick={() => setExpanded(expanded === row.key ? null : row.key)}
                      >
                        查看示例 {countText(row.examples.length)}
                      </button>
                    ) : (
                      <span className="qa-none">{DASH}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {report &&
        expanded &&
        (() => {
          const row = report.rows.find((item) => item.key === expanded);
          if (!row || row.examples.length === 0) return null;
          return (
            <ul className="qa-example-list" data-quality-example-list={row.key}>
              {row.examples.slice(0, 5).map((example) => (
                <li key={`${example.security}-${example.date}`}>
                  <span className="mono">{example.security}</span>
                  <span className="mono">{example.date}</span>
                </li>
              ))}
              {row.examples.length > 5 && (
                <li className="qa-none">另有 {countText(row.examples.length - 5)} 条</li>
              )}
            </ul>
          );
        })()}
    </section>
  );
}
