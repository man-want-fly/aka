import { useEffect, useRef, useState } from "react";
import { AppShell } from "../../app/AppShell";
import { CandleChart } from "../../components/CandleChart";
import { ParamPanel } from "../../components/ParamPanel";
import { SimBadge } from "../../components/SimBadge";
import { Watchlist } from "../../components/Watchlist";
import { DEFAULT_PARAMS, buildInstances, localCheck, type WorkbenchParams } from "../../features/workbench/model";
import { describeError, ipc, isTauriRuntime } from "../../lib/ipc";
import type {
  AppError,
  BarsResponse,
  CalcResponse,
  RegistryResponse,
  SecurityDto,
} from "../../lib/types";
import {
  formatAmount,
  formatComputedMs,
  formatDate,
  formatPct,
  formatPrice,
  formatSigned,
  formatVolume,
} from "../../lib/format";
import type { ColorMode, ThemeMode } from "../../lib/theme";

interface Props {
  themeMode: ThemeMode;
  onThemeMode: (mode: ThemeMode) => void;
  colorMode: ColorMode;
  onColorMode: (mode: ColorMode) => void;
}

const RANGES = [
  { label: "60", value: 60 },
  { label: "120", value: 120 },
  { label: "250", value: 250 },
  { label: "全部", value: 9999 },
];

export function WorkbenchPage({
  themeMode,
  onThemeMode,
  colorMode,
  onColorMode,
}: Props) {
  const [securities, setSecurities] = useState<SecurityDto[]>([]);
  const [registry, setRegistry] = useState<RegistryResponse | null>(null);
  const [activeCode, setActiveCode] = useState("300750.SZ");
  const [adj, setAdj] = useState<"none" | "qfq" | "hfq">("qfq");
  const [range, setRange] = useState(120);
  const [params, setParams] = useState<WorkbenchParams>(DEFAULT_PARAMS);
  const [appliedParams, setAppliedParams] = useState<WorkbenchParams>(DEFAULT_PARAMS);
  const [bars, setBars] = useState<BarsResponse | null>(null);
  const [calc, setCalc] = useState<CalcResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (!isTauriRuntime()) {
      setError({
        code: "NO_RUNTIME",
        message:
          "当前不在 Tauri 容器内。请执行 npm run tauri dev（或构建后打开 AKA.app），浏览器预览无法访问 Rust 指标引擎。",
        retryable: false,
      });
      return;
    }
    let alive = true;
    Promise.all([ipc.listSecurities(120), ipc.indicatorRegistry()])
      .then(([items, meta]) => {
        if (!alive) return;
        setSecurities(items);
        setRegistry(meta);
      })
      .catch((err) => {
        if (!alive) return;
        setError(describeError(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const current = ++generation.current;
    setLoading(true);
    setError(null);

    const request = {
      security: activeCode,
      timeframe: "D" as const,
      adj,
      generation: current,
      instances: buildInstances(appliedParams),
    };

    Promise.all([ipc.getBars(request), ipc.calcIndicators(request)])
      .then(([nextBars, nextCalc]) => {
        if (current !== generation.current) return;
        setBars(nextBars);
        setCalc(nextCalc);
        setLoading(false);
      })
      .catch((err) => {
        if (current !== generation.current) return;
        setError(describeError(err));
        setLoading(false);
      });
  }, [activeCode, adj, appliedParams]);

  const security = securities.find((item) => item.code === activeCode);
  const lastIndex = bars && bars.bars.length > 0 ? bars.bars.length - 1 : -1;
  const lastBar = lastIndex >= 0 ? bars!.bars[lastIndex] : undefined;
  const prevBar = lastIndex > 0 ? bars!.bars[lastIndex - 1] : undefined;
  const changePct =
    lastBar && prevBar ? (lastBar.close / prevBar.close - 1) * 100 : Number.NaN;
  const changeAbs = lastBar && prevBar ? lastBar.close - prevBar.close : Number.NaN;

  const handleApply = () => {
    const issue = localCheck(params);
    if (issue) {
      setError({ code: "INVALID_ARGUMENT", message: issue, retryable: false });
      return;
    }
    setError(null);
    setAppliedParams({ ...params });
  };

  return (
    <AppShell>
      <div className="workbench">
        <header className="wb-header">
          <div className="sec-identity">
            <h1>{security?.name ?? "未选择标的"}</h1>
            <span className="sec-code">{activeCode}</span>
            <span className="pill">{security?.board ?? "—"}</span>
            <SimBadge />
          </div>

          <div className="quote">
            <span className="last mono">{lastBar ? formatPrice(lastBar.close) : "—"}</span>
            <span className={`chg mono ${changePct >= 0 ? "up" : "down"}`}>
              {formatSigned(changeAbs)}　{formatPct(changePct)}
            </span>
          </div>

          <div className="header-stats">
            <span>
              开<b>{lastBar ? formatPrice(lastBar.open) : "—"}</b>
            </span>
            <span>
              高<b>{lastBar ? formatPrice(lastBar.high) : "—"}</b>
            </span>
            <span>
              低<b>{lastBar ? formatPrice(lastBar.low) : "—"}</b>
            </span>
            <span>
              量<b>{lastBar ? formatVolume(lastBar.volume) : "—"}</b>
            </span>
            <span>
              额<b>{lastBar ? formatAmount(lastBar.amount) : "—"}</b>
            </span>
            <span>
              日期<b>{lastBar ? lastBar.date : "—"}</b>
            </span>
          </div>

          <div className="spacer" />

          <div className="theme-controls">
            <span className="theme-label">主题</span>
            <div className="seg">
              {(
                [
                  ["dark", "深色"],
                  ["light", "浅色"],
                  ["system", "跟随"],
                ] as Array<[ThemeMode, string]>
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={themeMode === mode}
                  onClick={() => onThemeMode(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="theme-label">涨跌色</span>
            <div className="seg">
              {(
                [
                  ["redUp", "红涨"],
                  ["greenUp", "绿涨"],
                ] as Array<[ColorMode, string]>
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={colorMode === mode}
                  onClick={() => onColorMode(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </header>

        <div className="wb-body">
          <Watchlist
            securities={securities}
            activeCode={activeCode}
            onSelect={setActiveCode}
          />

          <main className="main">
            <div className="toolbar">
              <span className="caption">周期</span>
              <div className="seg">
                <button type="button" aria-pressed>
                  D
                </button>
                <button type="button" disabled title="骨架期未实现">
                  W
                </button>
                <button type="button" disabled title="骨架期未实现">
                  M
                </button>
              </div>

              <span className="caption">复权</span>
              <div className="seg">
                {(
                  [
                    ["none", "不复权"],
                    ["qfq", "前复权"],
                    ["hfq", "后复权"],
                  ] as Array<["none" | "qfq" | "hfq", string]>
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={adj === mode}
                    onClick={() => setAdj(mode)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <span className="caption">显示</span>
              <div className="seg">
                {RANGES.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    aria-pressed={range === item.value}
                    onClick={() => setRange(item.value)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <div className="grow" />
              <span className="engine-note">
                按需计算 · {loading ? "更新中" : calc?.cacheHit ? "缓存命中" : "已计算"} ·{" "}
                <b>{calc ? formatComputedMs(calc.computedMs) : "—"} ms</b>
              </span>
            </div>

            {error && <div className="error-box">{error.message}</div>}

            <div className="chart-card">
              {bars ? (
                <CandleChart bars={bars.bars} series={calc?.series ?? []} windowSize={range} />
              ) : (
                <div className="empty">
                  {loading ? (
                    "正在读取 mock 行情…"
                  ) : error ? (
                    <>
                      无法加载行情
                      <br />
                      修复上方错误后重试
                    </>
                  ) : (
                    <>
                      暂无数据
                      <br />
                      请通过 <code>npm run tauri dev</code> 启动桌面骨架
                    </>
                  )}
                </div>
              )}
            </div>
          </main>

          <ParamPanel
            registry={registry}
            params={params}
            onChange={setParams}
            onApply={handleApply}
            busy={loading}
            error={error?.code === "PARAM_OUT_OF_RANGE" || error?.code === "INVALID_ARGUMENT" ? error.message : null}
            computedMs={calc?.computedMs ?? null}
            cacheHit={calc?.cacheHit ?? null}
          />
        </div>

        <footer className="status">
          <span>
            <i className="dot" />
            模拟数据 · 非真实行情
          </span>
          <span>
            provider <b>{bars?.provenance.provider ?? "mock"}</b>
          </span>
          <span>
            dataset <b>{bars?.provenance.datasetId ?? "sim-default"}</b>
          </span>
          <span>
            版本 <b>{bars?.provenance.dataVersion ?? "sim-v1.0"}</b>
          </span>
          <span>
            engine <b>{calc?.engineVersion ?? "aka-engine-0.1.0"}</b>
          </span>
          <span>
            区间 <b>{bars ? `${bars.bars[0]?.date ?? "—"} ~ ${lastBar?.date ?? "—"}` : "—"}</b>
          </span>
          <span>
            样本 <b>{bars?.totalBars ?? 0}</b>
          </span>
          <span>
            计算 <b>{calc ? formatComputedMs(calc.computedMs) : "—"} ms</b>
          </span>
          <span>
            缓存 <b>{calc ? (calc.cacheHit ? "命中" : "未命中") : "—"}</b>
          </span>
          <span>
            渲染 <b>{range === 9999 ? "全部" : `${range} 根`}</b>
          </span>
          <span className="mono">{bars ? formatDate(lastBar?.date ?? "") : ""}</span>
        </footer>
      </div>
    </AppShell>
  );
}
