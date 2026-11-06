import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "../../app/AppShell";
import { CandleChart } from "../../components/CandleChart";
import { IndicatorReadouts } from "../../components/IndicatorReadouts";
import { ParamPanel } from "../../components/ParamPanel";
import { SimBadge } from "../../components/SimBadge";
import { Watchlist } from "../../components/Watchlist";
import {
  B2_OVERLAY_CHOICES,
  SUB_CHOICES,
  DEFAULT_B2_OVERLAYS,
  DEFAULT_PARAMS,
  DEFAULT_SUB_ID,
  buildInstances,
  localCheck,
  type WorkbenchParams,
} from "../../features/workbench/model";
import {
  runS2Diagnostics,
  seriesSignature,
  type DiagPhase,
  type DiagSample,
  type TimeframeCode,
} from "../../features/workbench/diag";
import { describeError, ipc, isTauriRuntime } from "../../lib/ipc";
import type {
  AppError,
  BarsResponse,
  CalcResponse,
  ManifestResponse,
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
  onNavigate: (key: "workbench" | "catalog") => void;
}

const RANGES = [
  { label: "60", value: 60 },
  { label: "120", value: 120 },
  { label: "250", value: 250 },
  { label: "全部", value: 9999 },
];

/** 输入静默 120ms 后才发请求：连续输入（典型间隔 40ms）只保留最后一次，避免抖动请求 */
const REQUEST_DEBOUNCE_MS = 120;

export function WorkbenchPage({
  themeMode,
  onThemeMode,
  colorMode,
  onColorMode,
  onNavigate,
}: Props) {
  const [securities, setSecurities] = useState<SecurityDto[]>([]);
  const [registry, setRegistry] = useState<RegistryResponse | null>(null);
  const [manifest, setManifest] = useState<ManifestResponse | null>(null);
  const units = useMemo(
    () =>
      Object.fromEntries(
        (manifest?.indicators ?? []).map((item) => [item.id, item.unit]),
      ) as Record<string, string>,
    [manifest],
  );
  const [activeCode, setActiveCode] = useState("300750.SZ");
  const [adj, setAdj] = useState<"none" | "qfq" | "hfq">("qfq");
  const [timeframe, setTimeframe] = useState<TimeframeCode>("D");
  const [range, setRange] = useState(120);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [params, setParams] = useState<WorkbenchParams>(DEFAULT_PARAMS);
  const [appliedParams, setAppliedParams] = useState<WorkbenchParams>(DEFAULT_PARAMS);
  // B2 主图叠加与副图选择：纯客户端切换，指标实例已全量下发
  const [overlayIds, setOverlayIds] = useState<string[]>(DEFAULT_B2_OVERLAYS);
  const [subId, setSubId] = useState<string>(DEFAULT_SUB_ID);
  const [bars, setBars] = useState<BarsResponse | null>(null);
  const [calc, setCalc] = useState<CalcResponse | null>(null);
  // 供 diag 逐根比对读取「当前渲染帧」的引擎结果（effect 闭包不会随后续 render 更新）
  const calcRef = useRef<CalcResponse | null>(null);
  const barsRef = useRef<BarsResponse | null>(null);
  const rangeRef = useRef(120);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const generation = useRef(0);

  // S2 实机取证（TD-S0-04/06/07）：只在 AKA_DIAG=1 时激活，采样只来自真实 IPC 路径
  const diagPhase = useRef<DiagPhase>("off");
  const diagSamples = useRef<DiagSample[]>([]);
  const diagWaiters = useRef<Array<(sample: DiagSample) => void>>([]);
  const diagStarted = useRef(false);
  const activeCodeRef = useRef(activeCode);
  activeCodeRef.current = activeCode;
  const [diagStatus, setDiagStatus] = useState<string | null>(null);

  const drainSamples = useCallback(() => {
    const items = diagSamples.current;
    diagSamples.current = [];
    return items;
  }, []);

  const nextSample = useCallback((timeoutMs = 4_000) => {
    return new Promise<DiagSample | null>((resolve) => {
      let settled = false;
      let timer = 0;
      const wrapped = (sample: DiagSample) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(sample);
      };
      timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        const index = diagWaiters.current.indexOf(wrapped);
        if (index >= 0) diagWaiters.current.splice(index, 1);
        resolve(null);
      }, timeoutMs);
      diagWaiters.current.push(wrapped);
    });
  }, []);

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
    Promise.all([
      ipc.listSecurities(120),
      ipc.indicatorRegistry(),
      ipc.indicatorManifest(),
    ])
      .then(([items, meta, catalog]) => {
        if (!alive) return;
        setSecurities(items);
        setRegistry(meta);
        setManifest(catalog);
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
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      const current = ++generation.current;
      setLoading(true);
      setError(null);

      const request = {
        security: activeCode,
        timeframe,
        adj,
        from: dateFrom || undefined,
        to: dateTo || undefined,
        generation: current,
        instances: buildInstances(appliedParams),
      };

      const phaseAtIssue = diagPhase.current;
      const startedAt = performance.now();
      let barsMs = Number.NaN;
      let calcMs = Number.NaN;

      Promise.all([
        ipc.getBars(request).then((value) => {
          barsMs = performance.now() - startedAt;
          return value;
        }),
        ipc.calcIndicators(request).then((value) => {
          calcMs = performance.now() - startedAt;
          return value;
        }),
      ])
        .then(([nextBars, nextCalc]) => {
          if (current !== generation.current) return;
          setBars(nextBars);
          barsRef.current = nextBars;
          setCalc(nextCalc);
          calcRef.current = nextCalc;
          setLoading(false);

          if (phaseAtIssue !== "debounce" && phaseAtIssue !== "cold" && phaseAtIssue !== "warm") {
            return;
          }
          const signature = seriesSignature(nextCalc);
          const sample: DiagSample = {
            phase: phaseAtIssue,
            security: activeCode,
            timeframe,
            adj,
            barsMs,
            calcMs,
            totalMs: performance.now() - startedAt,
            cacheHit: nextCalc.cacheHit,
            computedMs: nextCalc.computedMs,
            barCount: nextCalc.barCount,
            seriesHash: signature.hash,
            seriesPoints: signature.points,
          };
          diagSamples.current.push(sample);
          const waiter = diagWaiters.current.shift();
          if (waiter) waiter(sample);
        })
        .catch((err) => {
          if (current !== generation.current) return;
          const failure = describeError(err);
          setError(failure);
          setLoading(false);
          if (phaseAtIssue !== "debounce" && phaseAtIssue !== "cold" && phaseAtIssue !== "warm") {
            return;
          }
          // 失败也算一次真实请求：既进样本池，也唤醒等待中的诊断步骤
          const sample: DiagSample = {
            phase: phaseAtIssue,
            security: activeCode,
            timeframe,
            adj,
            barsMs,
            calcMs,
            totalMs: performance.now() - startedAt,
            cacheHit: false,
            computedMs: Number.NaN,
            barCount: 0,
            seriesHash: "error",
            seriesPoints: 0,
            error: `${failure.code}: ${failure.message}`,
          };
          diagSamples.current.push(sample);
          const waiter = diagWaiters.current.shift();
          if (waiter) waiter(sample);
        });
    }, REQUEST_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeCode, adj, appliedParams, dateFrom, dateTo, timeframe]);

  // S2 实机取证：仅 AKA_DIAG=1 且已有标的列表时自跑一次
  useEffect(() => {
    if (!isTauriRuntime() || securities.length === 0 || diagStarted.current) return;
    if (window.sessionStorage.getItem("aka.s2.diag.once") === "1") return;
    diagStarted.current = true;
    let alive = true;
    (async () => {
      const enabled = await ipc.diagEnabled();
      if (!enabled || !alive) return;
      window.sessionStorage.setItem("aka.s2.diag.once", "1");
      setDiagStatus("S2 取证：运行中");
      try {
        const report = await runS2Diagnostics({
          codes: securities.map((item) => item.code),
          activeCode: activeCodeRef.current,
          baseParams: DEFAULT_PARAMS,
          setPhase: (phase) => {
            diagPhase.current = phase;
          },
          setCode: setActiveCode,
          setParams: setAppliedParams,
          setTimeframe,
          nextSample,
          drainSamples,
          telemetry: () => ipc.telemetryDump(200),
          probeBars: async (tf) => {
            const response = await ipc.getBars({
              security: activeCodeRef.current,
              timeframe: tf,
              adj,
              from: dateFrom || undefined,
              to: dateTo || undefined,
            });
            return {
              timeframe: response.timeframe,
              barCount: response.bars.length,
              datasetId: response.datasetId,
            };
          },
          write: (payload) => ipc.diagWrite(payload),
          snapshot: () => ({
            calc: calcRef.current,
            barsLength: barsRef.current?.bars.length ?? 0,
            windowSize: rangeRef.current,
          }),
        });
        if (!alive) return;
        const written = String(report.writtenTo ?? "");
        setDiagStatus(`S2 取证：完成 → ${written.split("/").slice(-2).join("/")}`);
        (window as unknown as Record<string, unknown>).__AKA_S2_EVIDENCE__ = report;
      } catch (err) {
        if (!alive) return;
        setDiagStatus(`S2 取证：失败 ${describeError(err).message}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [securities, nextSample, drainSamples]);

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
    <AppShell active="workbench" onNavigate={onNavigate}>
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
              <div className="seg" role="group" aria-label="周期切换">
                {(
                  [
                    ["D", "日"],
                    ["W", "周"],
                    ["M", "月"],
                  ] as Array<["D" | "W" | "M", string]>
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={timeframe === mode}
                    title={`${label}线`}
                    onClick={() => setTimeframe(mode)}
                  >
                    {mode}
                  </button>
                ))}
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
                    onClick={() => {
                      setRange(item.value);
                      rangeRef.current = item.value;
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <span className="caption">日期</span>
              <div className="date-range">
                <input
                  type="date"
                  aria-label="起始日期"
                  value={dateFrom}
                  onChange={(event) => setDateFrom(event.target.value)}
                />
                <span className="date-sep">~</span>
                <input
                  type="date"
                  aria-label="结束日期"
                  value={dateTo}
                  onChange={(event) => setDateTo(event.target.value)}
                />
                {(dateFrom || dateTo) && (
                  <button
                    type="button"
                    onClick={() => {
                      setDateFrom("");
                      setDateTo("");
                    }}
                  >
                    清除
                  </button>
                )}
              </div>

              <span className="caption">B2 叠加</span>
              <select
                className="b2-select"
                aria-label="B2 主图叠加"
                data-b2-overlay-select="1"
                multiple
                size={3}
                value={overlayIds}
                onChange={(event) =>
                  setOverlayIds(
                    Array.from(event.target.selectedOptions, (option) => option.value),
                  )
                }
              >
                {B2_OVERLAY_CHOICES.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>

              <span className="caption">副图</span>
              <select
                className="b2-select"
                aria-label="副图指标"
                data-b2-sub-select="1"
                value={subId}
                onChange={(event) => setSubId(event.target.value)}
              >
                {SUB_CHOICES.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>

              <div className="grow" />
              <span className="engine-note">
                按需计算 · {loading ? "更新中" : calc?.cacheHit ? "缓存命中" : "已计算"} ·{" "}
                <b>{calc ? formatComputedMs(calc.computedMs) : "—"} ms</b>
              </span>
            </div>

            {error && <div className="error-box">{error.message}</div>}

            <div className="chart-card">
              {bars ? (
                <>
                  <CandleChart
                    bars={bars.bars}
                    series={calc?.series ?? []}
                    windowSize={range}
                    overlayIds={overlayIds}
                    subId={subId}
                    units={units}
                  />
                  <IndicatorReadouts
                    series={calc?.series ?? []}
                    barCount={bars.bars.length}
                    overlayIds={overlayIds}
                    subId={subId}
                    units={units}
                  />
                </>
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
            引擎 <b>{calc?.engineVersion ?? "aka-engine-0.1.0"}</b>
          </span>
          <span>
            目录 <b>{manifest ? `${manifest.indicators.length} 条 / schema v${manifest.schemaVersion}` : "—"}</b>
          </span>
          <span>
            区间 <b>{bars ? `${bars.range.returnedFrom ?? "—"} ~ ${bars.range.returnedTo ?? "—"}` : "—"}</b>
            {bars?.range.clamped ? "（已吸附）" : ""}
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
          {diagStatus && <span className="diag-status">{diagStatus}</span>}
        </footer>
      </div>
    </AppShell>
  );
}
