import { useEffect, useState } from "react";
import { AppShell } from "../../app/AppShell";
import { formatAmount, formatPct, formatPrice, formatVolume } from "../../lib/format";
import { describeError, ipc, isTauriRuntime } from "../../lib/ipc";
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
interface Props {
  onNavigate: (key: "workbench" | "market" | "catalog" | "settings") => void;
}

const DENSITY_OPTIONS: Array<{ key: Density; label: string }> = [
  { key: "compact", label: "紧凑" },
  { key: "comfy", label: "舒适" },
];

/** S-06.02-01：显示偏好只有密度一项；数字格式只读展示，MVP 不提供自定义小数位。 */
export function SettingsPage({ onNavigate }: Props) {
  const [settings, setSettings] = useState<DisplaySettings>({ density: "compact" });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

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
        if (!alive || target !== "s0602") return;
        if (sessionStorage.getItem("aka.s0602.diag.done")) return;
        sessionStorage.setItem("aka.s0602.diag.done", "1");
        void runSettingsDiagnostics();
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
      </main>
    </AppShell>
  );
}
