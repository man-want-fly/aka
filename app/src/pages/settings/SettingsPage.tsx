import { useEffect, useRef, useState } from "react";
import { AppShell, type RouteKey } from "../../app/AppShell";
import { formatAmount, formatPct, formatPrice, formatVolume } from "../../lib/format";
import { describeError, ipc, isTauriRuntime } from "../../lib/ipc";
import {
  MENU_ACTION_EVENT,
  takePendingMenuAction,
  type MenuAction,
} from "../../lib/menu";
import { runSettingsDiagnostics } from "../../features/settings/diag";
import {
  DISPLAY_SCOPE,
  ROW_HEIGHT,
  loadDisplaySettings,
  saveDisplaySettings,
  sanitizeDisplay,
  type Density,
  type DisplaySettings,
} from "../../lib/settings";
import type { DatasourceStatusDto, DiagnosticsExportDto, ManifestResponse } from "../../lib/types";
import { runS060301Diagnostics, runS060302Diagnostics } from "../../features/qa/batchDiag";
import { loadColorMode, loadThemeMode } from "../../lib/theme";

const DATA_DIR = "~/Library/Application Support/AKA/data/sim";
interface Props {
  onNavigate: (key: RouteKey) => void;
}

const DENSITY_OPTIONS: Array<{ key: Density; label: string }> = [
  { key: "compact", label: "紧凑" },
  { key: "comfy", label: "舒适" },
];

/** S-06.03-02：诊断包体积展示。 */
const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(0, Math.round(bytes / 1024))} KB`;

/** S-06.02-01：显示偏好只有密度一项；数字格式只读展示，MVP 不提供自定义小数位。 */
export function SettingsPage({ onNavigate }: Props) {
  const [settings, setSettings] = useState<DisplaySettings>({ density: "compact" });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [manifest, setManifest] = useState<ManifestResponse | null>(null);
  const [datasource, setDatasource] = useState<DatasourceStatusDto | null>(null);
  // S-06.03-02：诊断包导出四态（导出中 / 成功 / 磁盘不足 / 无日志），失败不留半截文件。
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<DiagnosticsExportDto | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.all([ipc.indicatorManifest(), ipc.datasourceStatus()])
      .then(([nextManifest, nextStatus]) => {
        if (!alive) return;
        setManifest(nextManifest);
        setDatasource(nextStatus);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const implemented = manifest
    ? manifest.indicators.filter((item) => item.status !== "planned").length
    : null;
  const catalogTotal = manifest?.indicators.length ?? null;
  const dataDirMissing = datasource !== null && datasource.version === null;

  useEffect(() => {
    let alive = true;
    void loadDisplaySettings()
      .then((next) => {
        if (!alive) return;
        setSettings(next);
      })
      .catch((err) => {
        if (alive) setError(`设置读取失败：${describeError(err).message}`);
      })
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onDensity = (event: Event) => {
      const detail = (event as CustomEvent<Density>).detail;
      setSettings(sanitizeDisplay({ density: detail }));
    };
    window.addEventListener("aka:density", onDensity);
    return () => window.removeEventListener("aka:density", onDensity);
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let alive = true;
    void ipc
      .diagTarget()
      .then((target) => {
        if (!alive) return;
        if (target === "s0602") {
          if (sessionStorage.getItem("aka.s0602.diag.done")) return;
          sessionStorage.setItem("aka.s0602.diag.done", "1");
          void runSettingsDiagnostics();
          return;
        }
        if (target === "s060301") {
          if (sessionStorage.getItem("aka.batch.s060301.done")) return;
          sessionStorage.setItem("aka.batch.s060301.done", "1");
          void runS060301Diagnostics();
          return;
        }
        if (target === "s060302") {
          if (sessionStorage.getItem("aka.batch.s060302.done")) return;
          sessionStorage.setItem("aka.batch.s060302.done", "1");
          void runS060302Diagnostics();
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const changeDensity = (density: Density) => {
    if (!loaded || settings.density === density) return;
    setSettings({ density });
    setStatus("已保存");
    void saveDisplaySettings({ density }).catch((err) => {
      setStatus(null);
      setError(`设置未保存：${describeError(err).message}`);
    });
  };

  /** S-06.03-02：一键导出；配置快照只传白名单字段，后端还会再裁一次。 */
  const exportDiagnostics = () => {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    setExportResult(null);
    void ipc
      .exportDiagnostics({
        theme_mode: loadThemeMode(),
        color_direction: loadColorMode() === "greenUp" ? "green_up" : "red_up",
        density: settings.density,
        crosshair: null,
        candle_hollow: null,
        subchart_height: null,
        insufficient_hint: null,
        dataset_id: datasource?.version?.datasetId ?? null,
      })
      .then((result) => setExportResult(result))
      .catch((err) => {
        const info = describeError(err);
        const details = info.details as
          | { requiredBytes?: number; availableBytes?: number }
          | undefined;
        if (details && typeof details.availableBytes === "number") {
          setExportError(
            `磁盘空间不足：需要约 ${formatBytes(details.requiredBytes ?? 0)}，可用 ${formatBytes(
              details.availableBytes,
            )}；未生成任何文件。`,
          );
          return;
        }
        setExportError(`导出失败：${info.message}`);
      })
      .finally(() => setExporting(false));
  };

  const exportState = exporting
    ? "exporting"
    : exportError
      ? "error"
      : exportResult
        ? exportResult.noLog
          ? "no-log"
          : "success"
        : "idle";

  // AKA-33：菜单「关于 / 导出诊断包」落到本页既有实现，不再另写一份。
  // 跨路由时由 App 存 pending，挂载后消费一次；已在本页时走窗口事件。
  const exportRef = useRef(exportDiagnostics);
  exportRef.current = exportDiagnostics;
  useEffect(() => {
    const run = (action: MenuAction) => {
      if (action === "about") {
        document
          .querySelector("[data-about-page]")
          ?.scrollIntoView({ block: "start", behavior: "smooth" });
        return;
      }
      exportRef.current();
    };
    const pending = takePendingMenuAction();
    if (pending) run(pending);
    const onAction = (event: Event) => run((event as CustomEvent<MenuAction>).detail);
    window.addEventListener(MENU_ACTION_EVENT, onAction);
    return () => window.removeEventListener(MENU_ACTION_EVENT, onAction);
  }, []);

  const retry = () => {
    setError(null);
    void ipc
      .viewStateGet(DISPLAY_SCOPE)
      .then((value) => {
        const next = sanitizeDisplay(value);
        setSettings(next);
        void saveDisplaySettings(next);
        setStatus("已保存");
      })
      .catch((err) => setError(`设置未保存：${describeError(err).message}`));
  };

  return (
    <AppShell active="settings" onNavigate={onNavigate}>
      <main className="settings" data-settings-root="1">
        <header className="settings-head">
          <h1>设置</h1>
          <p className="settings-sub">显示偏好保存在本地 state.db，重启后保持。</p>
        </header>

        {error && (
          <div className="settings-error" data-settings-error>
            <span>{error}</span>
            <button type="button" onClick={retry}>
              重试
            </button>
          </div>
        )}

        <section className="settings-section" data-settings-section="display">
          <h2>显示</h2>
          <div className="settings-row">
            <div>
              <b>列表密度</b>
              <span className="settings-hint">
                行情、自选、指数与板块表统一行高；默认紧凑。
              </span>
            </div>
            <div className="seg" role="group" aria-label="列表密度">
              {DENSITY_OPTIONS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  className={settings.density === option.key ? "selected" : ""}
                  data-density-option={option.key}
                  aria-pressed={settings.density === option.key}
                  onClick={() => changeDensity(option.key)}
                >
                  {option.label}（{ROW_HEIGHT[option.key]}px）
                </button>
              ))}
            </div>
          </div>
          {status && (
            <span className="settings-hint" data-settings-status>
              {status}
            </span>
          )}
        </section>

        <section className="settings-section" data-settings-section="format">
          <h2>数字格式</h2>
          <p className="settings-hint">格式由全局统一，本期不提供自定义小数位。</p>
          <ul className="settings-formats">
            <li>
              <span>价格</span>
              <b className="mono" data-format-sample="price">
                {formatPrice(1684.2)}
              </b>
              <span className="settings-hint">2 位小数、千分位</span>
            </li>
            <li>
              <span>百分比</span>
              <b className="mono" data-format-sample="percent">
                {formatPct(1.24)} / {formatPct(-0.86)}
              </b>
              <span className="settings-hint">2 位 + %，正负号</span>
            </li>
            <li>
              <span>成交量</span>
              <b className="mono" data-format-sample="volume">
                {formatVolume(123_400)}
              </b>
              <span className="settings-hint">内部股 → 界面手，1 位小数</span>
            </li>
            <li>
              <span>成交额</span>
              <b className="mono" data-format-sample="amount">
                {formatAmount(124_000_000)} / {formatAmount(35_000_000)}
              </b>
              <span className="settings-hint">元 → 万/亿，2 位小数</span>
            </li>
          </ul>
        </section>
        <section className="settings-section" data-settings-section="about" data-about-page="1">
          <h2>关于</h2>
          <div className="settings-row">
            <div>
              <b>应用版本</b>
              <span className="settings-hint">当前安装的桌面端版本。</span>
            </div>
            <span className="mono" data-about-version={__APP_VERSION__}>
              {__APP_VERSION__}
            </span>
          </div>
          <div className="settings-row">
            <div>
              <b>构建号</b>
              <span className="settings-hint">开发构建显示 dev。</span>
            </div>
            <span className="mono" data-about-build={__BUILD_NO__}>
              {__BUILD_NO__}
            </span>
          </div>
          <div className="settings-row">
            <div>
              <b>数据引擎</b>
              <span className="settings-hint">指标计算引擎版本。</span>
            </div>
            <span className="mono" data-about-engine="aka-engine-0.1.0">
              aka-engine-0.1.0
            </span>
          </div>
          <div className="settings-row">
            <div>
              <b>指标实现进度</b>
              <span className="settings-hint">已实现 / 目录总量，与指标目录同一来源。</span>
            </div>
            <span
              className="mono"
              data-about-indicators={implemented === null || catalogTotal === null ? "" : `${implemented}/${catalogTotal}`}
            >
              {implemented === null || catalogTotal === null ? "—" : `${implemented} / ${catalogTotal}`}
            </span>
          </div>
          <div className="settings-row">
            <div>
              <b>数据目录</b>
              <span className="settings-hint">样本行情目录；可复制到 Finder 打开。</span>
            </div>
            <span className="mono" data-about-datadir={DATA_DIR}>
              <code>{DATA_DIR}</code>
              {dataDirMissing ? (
                <em data-about-datadir-state="missing" style={{ marginLeft: 8 }}>
                  目录不存在
                </em>
              ) : (
                <em data-about-datadir-state="present" style={{ marginLeft: 8 }}>
                  可读
                </em>
              )}
            </span>
          </div>
          {dataDirMissing && (
            <div className="settings-row" data-about-datadir-rebuild="1">
              <div>
                <b>数据目录不可用</b>
                <span className="settings-hint">可到数据源页重建样本包后重试。</span>
              </div>
              <button type="button" className="btn" onClick={() => onNavigate("datasource")}>
                重建样本包
              </button>
            </div>
          )}
          <div className="settings-row">
            <div>
              <b>更新通道</b>
              <span className="settings-hint">本期不提供切换，仅展示当前通道。</span>
            </div>
            <span className="mono" data-about-channel="stable" data-about-channel-buttons="0">
              stable
            </span>
          </div>
          <div className="settings-row">
            <div>
              <b>许可协议</b>
              <span className="settings-hint">内部构建，仅供评估。</span>
            </div>
            <span className="mono" data-about-license="internal-evaluation">
              内部评估许可
            </span>
          </div>
          <div className="settings-row" data-about-diagnostics="1">
            <div>
              <b>导出诊断包</b>
              <span className="settings-hint" data-about-diagnostics-hint="1">
                含版本、日志、最近 200 条命令与配置快照；不含自选、搜索历史与行情原始数据，全程不上传。
              </span>
              {exportResult && (
                <span className="settings-hint" data-about-diagnostics-path={exportResult.path}>
                  已保存到 <code>{exportResult.path}</code>（{formatBytes(exportResult.bytes)}）
                  {exportResult.noLog ? " · 本次无日志，已附 README 说明" : ""}
                  {exportResult.logTruncated ? " · 日志已截断为最近 7 天" : ""}
                </span>
              )}
              {exportError && (
                <span className="settings-hint" role="alert" data-about-diagnostics-error={exportError}>
                  {exportError}
                </span>
              )}
            </div>
            <div className="settings-actions">
              <button
                type="button"
                className="btn"
                onClick={exportDiagnostics}
                disabled={exporting || !isTauriRuntime()}
                data-about-export="1"
                data-about-export-state={exportState}
              >
                {exporting ? "正在打包…" : "导出诊断包"}
              </button>
              {exportResult && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void ipc.revealDiagnostics(exportResult.path).catch((err) => {
                      setExportError(`无法在 Finder 中显示：${describeError(err).message}`);
                    });
                  }}
                  data-about-reveal="1"
                >
                  在 Finder 中显示
                </button>
              )}
            </div>
          </div>
          <span className="settings-hint" data-about-network="0">
            关于页仅读取本地数据，不发起外部网络请求。
          </span>
        </section>
      </main>
    </AppShell>
  );
}
