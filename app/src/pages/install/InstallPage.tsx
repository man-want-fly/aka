import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell, type RouteKey } from "../../app/AppShell";
import { formatRowCount } from "../../features/workbench/datasetOverview";
import { formatDateTime } from "../../lib/datetime";
import { describeError, ipc, isTauriRuntime } from "../../lib/ipc";
import type { SimInstallReportDto, SimInstallStatusDto, SimStepStatus } from "../../lib/types";

interface Props {
  onNavigate: (key: RouteKey) => void;
}

const STATE_TEXT: Record<SimInstallStatusDto["state"], string> = {
  not_installed: "未安装",
  installing: "安装中",
  failed: "安装失败",
  installed: "已安装",
};

const STEP_TEXT: Record<SimStepStatus, string> = {
  pending: "待执行",
  running: "进行中",
  done: "已完成",
  failed: "失败",
};

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatCount(value: number): string {
  return formatRowCount(value) ?? "—";
}

function errorText(error: unknown): string {
  const info = describeError(error);
  return `${info.code}：${info.message}`;
}

export function InstallPage({ onNavigate }: Props) {
  const [status, setStatus] = useState<SimInstallStatusDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uiError, setUiError] = useState<string | null>(null);
  const [confirmRebuild, setConfirmRebuild] = useState(false);

  const load = useCallback(async () => {
    if (!isTauriRuntime()) {
      setLoading(false);
      return;
    }
    try {
      const next = await ipc.simInstallStatus();
      setStatus(next);
      setUiError(null);
    } catch (error) {
      setUiError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 安装中轮询真实进度；百分比只来自后端已落哨兵的 items/total。
  useEffect(() => {
    if (status?.state !== "installing" || !isTauriRuntime()) return;
    const timer = window.setInterval(() => {
      void ipc
        .simInstallStatus()
        .then((next) => {
          setStatus(next);
          if (next.state === "failed" && next.error) {
            setUiError(`${next.error.code}：${next.error.message}`);
          }
        })
        .catch((error) => setUiError(errorText(error)));
    }, 200);
    return () => window.clearInterval(timer);
  }, [status?.state]);

  const start = async () => {
    setBusy(true);
    setUiError(null);
    try {
      setStatus(await ipc.simInstallStart());
    } catch (error) {
      setUiError(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const rebuild = async () => {
    setConfirmRebuild(false);
    setBusy(true);
    setUiError(null);
    try {
      setStatus(await ipc.simInstallRebuild());
    } catch (error) {
      setUiError(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const progress = useMemo(() => {
    const steps = status?.steps ?? [];
    const total = steps.reduce((sum, step) => sum + (step.total || 0), 0);
    const done = steps.reduce((sum, step) => sum + (step.items || 0), 0);
    const elapsed = steps.reduce((sum, step) => sum + (step.durationMs || 0), 0);
    const percent = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0;
    const remainMs =
      status?.state === "installing" && done > 0 && total > done
        ? Math.round((elapsed / done) * (total - done))
        : null;
    return { total, done, percent, elapsed, remainMs };
  }, [status]);

  const state = status?.state ?? "not_installed";
  const report: SimInstallReportDto | null = status?.installed ?? null;
  const resumeFrom = status?.resumeFrom ?? null;

  return (
    <AppShell active="install" onNavigate={onNavigate}>
      <main className="install-page" data-install-page data-install-state={state}>
        <header className="install-head">
          <div>
            <h1>模拟数据环境</h1>
            <p>
              首装生成 120 只标的（112 股票 + 8 指数）× 520 个交易日，全程本地、0
              网络；中断后从 `.installing` 记录的步骤继续。
            </p>
          </div>
          <span className={`install-badge install-badge--${state}`} data-install-badge>
            {STATE_TEXT[state]}
          </span>
        </header>

        {!isTauriRuntime() ? (
          <section className="install-card" data-install-desktop-only>
            <h2>仅桌面端可用</h2>
            <p>安装器在 Rust 侧执行，浏览器预览无法生成数据集。</p>
          </section>
        ) : loading ? (
          <section className="install-card" data-install-loading>
            正在读取安装状态…
          </section>
        ) : (
          <>
            {uiError ? (
              <section className="install-alert install-alert--bad" data-install-error>
                <strong>安装未完成</strong>
                <span>{uiError}</span>
              </section>
            ) : null}

            {state === "failed" && status?.error ? (
              <section className="install-alert install-alert--bad" data-install-failed>
                <strong>{status.error.code}</strong>
                <span>{status.error.message}</span>
              </section>
            ) : null}

            {state === "installing" && resumeFrom ? (
              <section className="install-alert" data-install-resume-banner>
                上次安装未完成，将从第 {resumeFrom} 步继续；已完成的分片不会重复生成。
              </section>
            ) : null}

            {state === "not_installed" ? (
              <section className="install-card" data-install-preflight>
                <h2>安装前检查</h2>
                <ul className="install-checks">
                  <li>磁盘可用 ≥ 270 MB（预估占用 180 MB × 1.5）</li>
                  <li>数据目录可写：`~/Library/Application Support/aka/sim/seed-42`</li>
                  <li>全程 0 网络请求；不写 `sector_members`</li>
                  <li>断点可恢复：每步完成后更新 `.installing` 哨兵</li>
                </ul>
                <button
                  type="button"
                  className="install-action"
                  data-install-start
                  disabled={busy}
                  onClick={() => void start()}
                >
                  {busy ? "启动中…" : "开始安装"}
                </button>
              </section>
            ) : null}

            {state === "failed" ? (
              <button
                type="button"
                className="install-action"
                data-install-resume
                disabled={busy}
                onClick={() => void start()}
              >
                {busy ? "启动中…" : `从第 ${resumeFrom ?? 1} 步继续`}
              </button>
            ) : null}

            {state !== "installed" ? (
              <section className="install-card" data-install-steps>
                <div className="install-progress">
                  <div className="install-progress__meta">
                    <span>
                      总体进度 {progress.percent}%（{formatCount(progress.done)} /{" "}
                      {formatCount(progress.total)} 条）
                    </span>
                    <span>
                      已用 {formatDuration(progress.elapsed)}
                      {progress.remainMs !== null
                        ? ` · 预计剩余 ${formatDuration(progress.remainMs)}`
                        : ""}
                    </span>
                  </div>
                  <div className="install-progress__bar" aria-hidden="true">
                    <i style={{ width: `${progress.percent}%` }} />
                  </div>
                </div>
                <ol className="install-steps">
                  {(status?.steps ?? []).map((step) => (
                    <li
                      key={step.index}
                      className={`install-step install-step--${step.status}`}
                      data-install-step={step.index}
                      data-step-status={step.status}
                    >
                      <span className="install-step__index">{step.index}</span>
                      <div className="install-step__body">
                        <strong>{step.name}</strong>
                        <span className="install-step__detail">
                          {STEP_TEXT[step.status]}
                          {step.status !== "pending"
                            ? ` · ${formatCount(step.items)} / ${formatCount(step.total)} 条`
                            : ""}
                          {step.durationMs > 0 ? ` · ${formatDuration(step.durationMs)}` : ""}
                        </span>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}

            {state === "installed" && report ? (
              <section className="install-card" data-install-summary>
                <div className="install-summary__head">
                  <div>
                    <h2>已安装</h2>
                    <p>{report.datasetDir}</p>
                  </div>
                  <span className="install-summary__version" data-install-version>
                    {report.dataVersion}
                  </span>
                </div>
                <dl className="install-summary">
                  <div data-install-securities>
                    <dt>证券</dt>
                    <dd>{formatCount(report.securities)}</dd>
                  </div>
                  <div>
                    <dt>股票</dt>
                    <dd>{formatCount(report.stocks)}</dd>
                  </div>
                  <div>
                    <dt>指数</dt>
                    <dd>{formatCount(report.indices)}</dd>
                  </div>
                  <div data-install-index-members>
                    <dt>index_members</dt>
                    <dd>{formatCount(report.indexMembers)}</dd>
                  </div>
                  <div data-install-rows>
                    <dt>日线行数</dt>
                    <dd>{formatCount(report.rowCount)}</dd>
                  </div>
                  <div>
                    <dt>占用</dt>
                    <dd>{formatBytes(report.bytes)}</dd>
                  </div>
                  <div>
                    <dt>覆盖区间</dt>
                    <dd>
                      {report.coverageStart} ~ {report.coverageEnd}
                    </dd>
                  </div>
                  <div>
                    <dt>总耗时</dt>
                    <dd data-install-total-ms>
                      {formatDuration(report.totalMs)}
                      {report.slow ? "（超 60s）" : ""}
                    </dd>
                  </div>
                  <div>
                    <dt>生成时间</dt>
                    <dd>{formatDateTime(report.generatedAt)}</dd>
                  </div>
                  <div className="install-summary__sha">
                    <dt>sha256（{report.shaScope}）</dt>
                    <dd data-install-sha>{report.sha256}</dd>
                  </div>
                </dl>
                <div className="install-summary__actions">
                  <button
                    type="button"
                    className="install-action install-action--ghost"
                    data-install-rebuild
                    disabled={busy}
                    onClick={() => setConfirmRebuild(true)}
                  >
                    重建数据集
                  </button>
                </div>
              </section>
            ) : null}
          </>
        )}

        {confirmRebuild ? (
          <div className="install-modal" data-install-confirm>
            <div className="install-modal__body">
              <h2>重建数据集？</h2>
              <p>
                将删除当前 seed-42 数据集并重新执行 5 步，`data_version` 递增。重建期间页面不可用。
              </p>
              <div className="install-modal__actions">
                <button
                  type="button"
                  className="install-action install-action--ghost"
                  onClick={() => setConfirmRebuild(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="install-action"
                  data-install-confirm-ok
                  onClick={() => void rebuild()}
                >
                  确认重建
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </main>
    </AppShell>
  );
}
