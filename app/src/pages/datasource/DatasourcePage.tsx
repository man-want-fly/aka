import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "../../app/AppShell";
import { formatRowCount } from "../../features/workbench/datasetOverview";
import { runS070102Diagnostics } from "../../features/qa/batchDiag";
import { formatDateTime } from "../../lib/datetime";
import { formatFixed } from "../../lib/format";
import { describeError, ipc, isTauriRuntime } from "../../lib/ipc";
import type {
  DataHealthDto,
  DataHealthStatus,
  DatasourceCapabilityDto,
  DatasourceStatusDto,
} from "../../lib/types";
import { BackfillSection } from "./BackfillSection";
import { QualitySection } from "./QualitySection";

interface Props {
  onNavigate: (key: "workbench" | "market" | "catalog" | "settings" | "datasource") => void;
}

const STATE_TEXT: Record<DatasourceStatusDto["state"], string> = {
  ready: "可用",
  partial: "部分可用",
  unavailable: "不可用",
  missing: "未安装",
  probe_failed: "检查失败",
};

const STATE_TONE: Record<DatasourceStatusDto["state"], "ok" | "warn" | "bad"> = {
  ready: "ok",
  partial: "warn",
  unavailable: "bad",
  missing: "bad",
  probe_failed: "bad",
};

const MISSING = "—";

/** S-07.01-02：tushare 卡 4 项能力（口径固定 0/4，不随运行时变化）。 */
const TUSHARE_CAPS = [
  { key: "dailyBars", labelZh: "日线" },
  { key: "adjustFactors", labelZh: "复权" },
  { key: "securities", labelZh: "主数据" },
  { key: "tradingCalendar", labelZh: "交易日历" },
] as const;

/** S-07.01-02：4 个操作按钮保留但禁用（隐藏会让用户以为产品没有这个能力）。 */
const TUSHARE_ACTIONS = [
  { key: "connect", labelZh: "连接" },
  { key: "sync", labelZh: "同步" },
  { key: "verify", labelZh: "校验" },
  { key: "switch", labelZh: "切换" },
] as const;

const TUSHARE_DISABLED_REASON = "本期仅支持模拟数据（Mock）";

const HEALTH_TEXT: Record<DataHealthStatus, string> = {
  PASS: "通过",
  FAIL: "失败",
  SKIP: "跳过",
};

const HEALTH_TONE: Record<DataHealthStatus, "ok" | "warn" | "bad"> = {
  PASS: "ok",
  FAIL: "bad",
  SKIP: "warn",
};

/** epoch 毫秒 → 本地时区 `YYYY-MM-DD HH:mm:ss`。 */
function formatCheckTime(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return MISSING;
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function capTone(cap: DatasourceCapabilityDto): "ok" | "warn" | "bad" {
  if (cap.available) return "ok";
  return cap.required ? "bad" : "warn";
}

function copyText(text: string): Promise<boolean> {
  return (async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* wry 的 custom protocol 不一定是 secure context，走 textarea 兜底 */
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      document.body.removeChild(area);
    }
  })();
}

/** P9 数据源状态（S-07.01-01）：Mock 卡 + tushare 静态摘要。 */
export function DatasourcePage({ onNavigate }: Props) {
  const [status, setStatus] = useState<DatasourceStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [shaCopied, setShaCopied] = useState(false);
  const [health, setHealth] = useState<DataHealthDto | null>(null);
  const [checking, setChecking] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const checkingRef = useRef(false);

  const load = useCallback(async () => {
    if (!isTauriRuntime()) {
      setLoading(false);
      setError("当前不在桌面运行环境，无法探测数据源");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setStatus(await ipc.datasourceStatus());
    } catch (err) {
      // 探测自身失败：保留上次结果但不显示为绿色，给重试。
      setError(describeError(err).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // S-07.01-02 取证：AKA_DIAG_TARGET=s070102 时在 P9 自跑一次。
  useEffect(() => {
    if (!isTauriRuntime() || loading) return;
    if (sessionStorage.getItem("aka.s070102.diag.done") === "1") return;
    let alive = true;
    void (async () => {
      const target = await ipc.diagTarget().catch(() => "");
      if (target !== "s070102" || !alive) return;
      if (!(await ipc.diagEnabled().catch(() => false))) return;
      sessionStorage.setItem("aka.s070102.diag.done", "1");
      try {
        await runS070102Diagnostics();
      } catch (err) {
        console.error("[s070102.diag]", describeError(err).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [loading]);

  const state = status?.state ?? (error ? "probe_failed" : null);
  const version = status?.version ?? null;

  const locateIssue = () => {
    const target = status?.capabilities.find((cap) => !cap.available);
    if (!target) return;
    document
      .getElementById(`ds-cap-${target.key}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const copySha = async () => {
    if (!version?.sha256) return;
    if (await copyText(version.sha256)) {
      setShaCopied(true);
      window.setTimeout(() => setShaCopied(false), 1_500);
    }
  };

  /** S-07.01-02：手动触发、不轮询；ref 防重入保证连续点击只执行一次。 */
  const checkHealth = async () => {
    if (checkingRef.current) return;
    if (!isTauriRuntime()) {
      setHealthError("当前不在桌面运行环境，无法执行健康检查");
      return;
    }
    checkingRef.current = true;
    setChecking(true);
    setHealthError(null);
    try {
      setHealth(await ipc.dataHealthCheck());
    } catch (err) {
      const info = describeError(err);
      setHealthError(`${info.code} · ${info.message}`);
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  };

  /** AC-07.01-02（补3）：「重建样本包」→ 重新探测 + 重跑健康检查。 */
  const rebuildDataset = async () => {
    if (rebuilding || checkingRef.current) return;
    setRebuilding(true);
    setHealthError(null);
    try {
      await ipc.datasetRegenerate();
      await load();
      setHealth(await ipc.dataHealthCheck());
    } catch (err) {
      const info = describeError(err);
      setHealthError(`${info.code} · ${info.message}`);
    } finally {
      setRebuilding(false);
    }
  };

  const healthState = !health
    ? checking
      ? "检查中"
      : "尚未检查"
    : health.passed === health.total
      ? "正常"
      : health.items.some((item) => item.status === "SKIP")
        ? "前置失败"
        : "部分失败";
  const healthTone =
    healthState === "正常"
      ? "ok"
      : health && healthState !== "检查中"
        ? "bad"
        : "warn";
  const brokenPrefix = health?.items.some(
    (item) =>
      item.status === "FAIL" && (item.key === "dataset_present" || item.key === "manifest_parse"),
  );

  return (
    <AppShell active="datasource" onNavigate={onNavigate}>
      <main className="datasource" data-datasource-page="1">
        <header className="ds-head">
          <div>
            <h1>数据源状态</h1>
            <p className="ds-sub">
              首装后确认本地数据是否可用；数据版本只读，用于报障定位。
            </p>
          </div>
          <button
            type="button"
            className="ds-refresh"
            data-ds-refresh="1"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? "检查中…" : "重新检查"}
          </button>
        </header>

        {error && (
          <div className="ds-error" data-ds-error role="alert">
            <span>检查失败：{error}</span>
            <button type="button" onClick={() => void load()}>
              重试
            </button>
          </div>
        )}

        <section className="ds-card" data-datasource-card="mock">
          <header className="ds-card-head">
            <div className="ds-card-title">
              <h2>Mock 本地数据源</h2>
              {state && (
                <span
                  className={`ds-badge ds-badge--${STATE_TONE[state]}`}
                  data-ds-state={state}
                >
                  {STATE_TEXT[state]}
                </span>
              )}
            </div>
            {status && (
              <div className="ds-summary" data-ds-summary="1">
                <span>
                  {status.requiredOk}/{status.requiredTotal} 必需
                </span>
                <span className="ds-summary-sep">·</span>
                <span>
                  {status.optionalOk}/{status.optionalTotal} 可选
                </span>
                {state !== "ready" && (
                  <button type="button" className="ds-detail" data-ds-detail="1" onClick={locateIssue}>
                    查看详情
                  </button>
                )}
              </div>
            )}
          </header>

          {!version && state !== "probe_failed" && (
            <div className="ds-missing" data-ds-missing="1">
              <span>未安装样本包</span>
              <button type="button" onClick={() => onNavigate("settings")}>
                去环境页生成
              </button>
            </div>
          )}

          {status ? (
            <>
              <div className="ds-grid" data-ds-capabilities="1">
                {status.capabilities.map((cap) => (
                  <div
                    key={cap.key}
                    id={`ds-cap-${cap.key}`}
                    className="ds-cap"
                    data-capability-key={cap.key}
                    data-capability-required={cap.required ? "1" : "0"}
                    data-capability-available={cap.available ? "1" : "0"}
                  >
                    <span className={`ds-dot ds-dot--${capTone(cap)}`} aria-hidden="true" />
                    <div className="ds-cap-body">
                      <div className="ds-cap-line">
                        <b>{cap.labelZh}</b>
                        <span className={`ds-cap-state ds-cap-state--${capTone(cap)}`}>
                          {cap.available ? "可用" : "不可用"}
                        </span>
                        {!cap.required && <span className="ds-cap-tag">可选</span>}
                      </div>
                      {!cap.available && cap.note && (
                        <span className="ds-cap-note">{cap.note}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="ds-ops" data-ds-ops="1">
                <div className="ds-op">
                  <span>数据目录可读</span>
                  <b>{status.ops.dataDirReadable ? "可读" : "不可读"}</b>
                </div>
                <div className="ds-op">
                  <span>磁盘可用</span>
                  <b className="mono">
                    {status.ops.diskFreeGb === null
                      ? MISSING
                      : `${formatFixed(status.ops.diskFreeGb, 1)} GB`}
                  </b>
                </div>
                {status.ops.note && <span className="ds-op-note">{status.ops.note}</span>}
              </div>
            </>
          ) : (
            <p className="ds-loading">{loading ? "正在探测数据源…" : "尚无可展示的探测结果"}</p>
          )}

          <div className="ds-version" data-ds-version="1">
            <div className="ds-version-row" data-version-field="datasetId">
              <span>数据集 ID</span>
              <b className="mono" title={version?.datasetId ?? ""}>
                {version?.datasetIdShort ?? MISSING}
              </b>
            </div>
            <div className="ds-version-row" data-version-field="generatedAt">
              <span>生成时间</span>
              <b className="mono">{version ? formatDateTime(version.generatedAt) : MISSING}</b>
            </div>
            <div className="ds-version-row" data-version-field="rowCount">
              <span>数据行数</span>
              <b className="mono">{version ? formatRowCount(version.rowCount) : MISSING}</b>
            </div>
            <div className="ds-version-row" data-version-field="coverage">
              <span>数据区间</span>
              <b className="mono">
                {version ? `${version.coverageStart} ~ ${version.coverageEnd}` : MISSING}
              </b>
            </div>
            <div className="ds-version-row" data-version-field="sha256">
              <span>sha256</span>
              <b className="mono" data-sha-short="1">
                {version?.sha256Short ?? MISSING}
              </b>
              <button
                type="button"
                className="ds-copy"
                data-sha-copy="1"
                disabled={!version}
                title={version ? "复制完整 sha256" : "暂无版本"}
                onClick={() => void copySha()}
              >
                {shaCopied ? "已复制" : "复制"}
              </button>
            </div>
          </div>
        </section>

        {/* S-07.01-02：健康检查 6 项（只读、0 网络、仅手动触发） */}
        <section className="ds-card ds-health" data-health-section="1">
          <header className="ds-card-head">
            <div className="ds-card-title">
              <h2>健康检查</h2>
              <span
                className={`ds-badge ds-badge--${healthTone}`}
                data-health-state={healthState}
              >
                {healthState}
              </span>
            </div>
            <div className="ds-summary">
              {health ? (
                <span data-health-summary="1">
                  {health.passed}/{health.total} 通过
                  <span className="ds-summary-sep"> · </span>
                  总耗时 {formatFixed(health.durationMs, 0)} ms
                  <span className="ds-summary-sep"> · </span>
                  {formatCheckTime(health.checkedAt)}
                </span>
              ) : (
                <span>{checking ? "检查中…" : "尚未检查"}</span>
              )}
              <button
                type="button"
                className="ds-refresh"
                data-health-check="1"
                disabled={checking || rebuilding}
                onClick={() => void checkHealth()}
              >
                {checking ? "检查中…" : "健康检查"}
              </button>
            </div>
          </header>

          {healthError && (
            <div className="ds-error" data-health-error="1" role="alert">
              <span>健康检查失败：{healthError}</span>
              <button type="button" onClick={() => void checkHealth()}>
                重试
              </button>
            </div>
          )}

          {!health && !healthError && (
            <p className="ds-loading" data-health-empty="1">
              健康检查只读、不联网，仅在你点击时执行一次；不轮询、不上报。
            </p>
          )}

          {health && (
            <>
              <table className="qa-table" data-health-table="1">
                <thead>
                  <tr>
                    <th scope="col">检查项</th>
                    <th scope="col">结果</th>
                    <th scope="col">耗时</th>
                    <th scope="col">详情</th>
                  </tr>
                </thead>
                <tbody>
                  {health.items.map((item) => (
                    <tr
                      key={item.key}
                      data-health-row={item.key}
                      data-health-status={item.status}
                    >
                      <td>{item.labelZh}</td>
                      <td>
                        <span
                          className={`ds-dot ds-dot--${HEALTH_TONE[item.status]}`}
                          aria-hidden="true"
                        />
                        <span className={`qa-status qa-status--${HEALTH_TONE[item.status]}`}>
                          {HEALTH_TEXT[item.status]}
                        </span>
                        {item.errorCode && (
                          <code className="qa-code" data-health-code={item.key}>
                            {item.errorCode}
                          </code>
                        )}
                      </td>
                      <td className="mono">
                        {item.status === "SKIP" ? MISSING : `${item.durationMs} ms`}
                      </td>
                      <td className="qa-treatment">
                        {item.detail ?? MISSING}
                        {item.advice && (
                          <span className="ds-cap-note">建议：{item.advice}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {brokenPrefix && (
                <div className="ds-missing" data-health-rebuild-box="1">
                  <span>manifest 不可解析，样本包可能已损坏。</span>
                  <button
                    type="button"
                    data-health-rebuild="1"
                    disabled={rebuilding || checking}
                    onClick={() => void rebuildDataset()}
                  >
                    {rebuilding ? "重建中…" : "重建样本包"}
                  </button>
                </div>
              )}

              <p className="ds-op-note" data-health-note="1">
                行数抽检只覆盖最近 5 个交易日，不做全表扫描；单项超过 1.5s 标 FAIL 并附
                E_TIMEOUT。
              </p>
            </>
          )}
        </section>

        <section className="ds-card ds-card--tushare" data-datasource-card="tushare">
          <header className="ds-card-head">
            <div className="ds-card-title">
              <h2>tushare 数据源</h2>
              <span className="ds-badge ds-badge--bad" data-tushare-state="1">
                未启用
              </span>
            </div>
            <span className="ds-summary" data-tushare-summary="1">
              {status ? `${status.tushareEnabled}/${status.tushareTotal}` : "0/4"} 已启用
            </span>
          </header>
          <p className="ds-op-note" data-tushare-reason="1">
            接入需要 token、积分限流、字段映射差异，改造工作量约 8.5 人周；本期不联网。
          </p>
          <ul className="ds-tushare-caps" data-tushare-caps="1">
            {TUSHARE_CAPS.map((cap) => (
              <li key={cap.key} data-tushare-cap={cap.key} data-tushare-available="0">
                <span>{cap.labelZh}</span>
                <span className="ds-cap-tag">未启用</span>
              </li>
            ))}
          </ul>
          <div className="ds-tushare-actions" data-tushare-actions="1">
            {TUSHARE_ACTIONS.map((action) => (
              <button
                key={action.key}
                type="button"
                className="ds-tushare-button"
                data-tushare-action={action.key}
                disabled
                title={TUSHARE_DISABLED_REASON}
              >
                {action.labelZh}
              </button>
            ))}
          </div>
        </section>

        <QualitySection />

        <BackfillSection />
      </main>
    </AppShell>
  );
}
