import { useCallback, useEffect, useState } from "react";
import { AppShell } from "../../app/AppShell";
import { formatRowCount } from "../../features/workbench/datasetOverview";
import { formatDateTime } from "../../lib/datetime";
import { formatFixed } from "../../lib/format";
import { describeError, ipc, isTauriRuntime } from "../../lib/ipc";
import type { DatasourceCapabilityDto, DatasourceStatusDto } from "../../lib/types";
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
                title={version ? "复制完整 sha256" : "暂无数据版本"}
                onClick={() => void copySha()}
              >
                {shaCopied ? "已复制" : "复制"}
              </button>
            </div>
          </div>
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
          <p className="ds-op-note">离线 MVP 不联网；健康检查与启用交互在 S-07.01-02。</p>
        </section>

        <QualitySection />

        <BackfillSection />
      </main>
    </AppShell>
  );
}
