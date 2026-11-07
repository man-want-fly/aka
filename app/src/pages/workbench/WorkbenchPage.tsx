import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "../../app/AppShell";
import { CandleChart } from "../../components/CandleChart";
import { IndicatorReadouts } from "../../components/IndicatorReadouts";
import { ParamPanel } from "../../components/ParamPanel";
import { SimBadge } from "../../components/SimBadge";
import { Watchlist } from "../../components/Watchlist";
import { IndicatorDrawer } from "../../features/workbench/IndicatorDrawer";
import { runDrawerDiagnostics } from "../../features/workbench/drawerDiag";
import {
  B2_OVERLAY_CHOICES,
  B1_OVERLAY_CHOICES,
  SUB_CHOICES,
  DEFAULT_B2_OVERLAYS,
  DEFAULT_PARAMS,
  DEFAULT_SUB_ID,
  MAX_MAIN_OVERLAYS,
  MAX_SUBPLOTS,
  buildInstances,
  defaultsFromIndicators,
  localCheck,
  readSessionParams,
  sameParams,
  writeSessionParams,
  type WorkbenchParams,
} from "../../features/workbench/model";
import {
  runS2Diagnostics,
  seriesSignature,
  type DiagPhase,
  type DiagSample,
  type TimeframeCode,
} from "../../features/workbench/diag";
import { runS205Diagnostics } from "../../features/workbench/s205Diag";
import { runCrossPageCountDiagnostics } from "../../features/catalog/crossPageDiag";
import { runRestartDiagnostics, restartDiagStage } from "../../features/workbench/restartDiag";
import { runWatchlistDiagnostics, watchlistDiagStage } from "../../features/watchlist/watchlistDiag";
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
  /** 从行情列表点行进入时携带的标的代码；S-01.01-03 返回态依赖它 */
  initialCode?: string | null;
  themeMode: ThemeMode;
  onThemeMode: (mode: ThemeMode) => void;
  colorMode: ColorMode;
  onColorMode: (mode: ColorMode) => void;
  onNavigate: (key: "workbench" | "market" | "catalog") => void;
}

const RANGES = [
  { label: "60", value: 60 },
  { label: "120", value: 120 },
  { label: "250", value: 250 },
  { label: "全部", value: 9999 },
];

/** 输入静默 120ms 后才发请求：连续输入（典型间隔 40ms）只保留最后一次，避免抖动请求 */
const REQUEST_DEBOUNCE_MS = 120;

/** AC-02.05-04 补3：把后端 INSUFFICIENT_DATA 的 details 转成副图内联文案 */
function noticesFrom(error: AppError, manifest: ManifestResponse | null) {
  const details = error.details as
    | { indicatorId?: string; required?: number; got?: number }
    | undefined;
  const id = details?.indicatorId;
  if (!id || !Number.isFinite(details?.required)) {
    return { M06: error.message };
  }
  const abbr = manifest?.indicators.find((item) => item.id === id)?.abbr ?? id;
  return { [id]: `${abbr} 需要 ${details?.required} 根，当前 ${details?.got} 根` };
}

/**
 * AC-02.05-04 补3：后端算指标时不会因预热不足报错（只输出 NaN），
 * 因此由前端按 manifest 的 warmupBars 判定「数据不足」，在副图内联提示且不阻塞主图。
 */
function noticesForBars(len: number, subIds: string[], manifest: ManifestResponse | null) {
  const notices: Record<string, string> = {};
  for (const id of subIds) {
    const item = manifest?.indicators.find((entry) => entry.id === id);
    if (!item || item.warmupBars <= 0) continue;
    if (len < item.warmupBars) {
      notices[id] = `${item.abbr} 需要 ${item.warmupBars} 根，当前 ${len} 根`;
    }
  }
  return Object.keys(notices).length > 0 ? notices : null;
}

export function WorkbenchPage({
  initialCode,
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
  const [activeCode, setActiveCode] = useState(initialCode ?? "300750.SZ");
  const [adj, setAdj] = useState<"none" | "qfq" | "hfq">("qfq");
  const [timeframe, setTimeframe] = useState<TimeframeCode>("D");
  const [range, setRange] = useState(120);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [params, setParams] = useState<WorkbenchParams>(DEFAULT_PARAMS);
  const [appliedParams, setAppliedParams] = useState<WorkbenchParams>(DEFAULT_PARAMS);
  const defaultParams = useMemo(
    () => (manifest ? defaultsFromIndicators(manifest.indicators) : DEFAULT_PARAMS),
    [manifest],
  );

  // S-02.05-02 会话记忆：同一会话内切页/切标的保留参数；重启回到 manifest 默认值
  useEffect(() => {
    const stored = readSessionParams();
    if (!stored) return;
    setParams(stored);
    setAppliedParams(stored);
  }, []);
  // B2 主图叠加与副图选择：纯客户端切换，指标实例已全量下发
  const [overlayIds, setOverlayIds] = useState<string[]>(DEFAULT_B2_OVERLAYS);
  const [subIds, setSubIds] = useState<string[]>([DEFAULT_SUB_ID]);
  // S-02.04-01 指标抽屉：Esc 先关抽屉，不能再触发行情返回
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerOpenRef = useRef(false);
  drawerOpenRef.current = drawerOpen;
  const drawerTriggerRef = useRef<HTMLButtonElement | null>(null);
  // S-02.04-01：关闭后焦点回到触发按钮，键盘用户不丢位置
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    window.requestAnimationFrame(() => drawerTriggerRef.current?.focus());
  }, []);
  const [bars, setBars] = useState<BarsResponse | null>(null);
  const [calc, setCalc] = useState<CalcResponse | null>(null);
  // 供 diag 逐根比对读取「当前渲染帧」的引擎结果（effect 闭包不会随后续 render 更新）
  const calcRef = useRef<CalcResponse | null>(null);
  const barsRef = useRef<BarsResponse | null>(null);
  const rangeRef = useRef(120);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  // 数据不足的内联提示按指标 id 归位，不上升为全局错误条
  const [calcNotices, setCalcNotices] = useState<Record<string, string> | null>(null);
  const restartStarted = useRef(false);
  const watchlistStarted = useRef(false);
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
      // 自选行要按「完整数据集」解析名称/板块/是否在数据集：不传 limit = provider 全量代码表
      ipc.listSecurities(),
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

  /** S-01.01-03：从行情点行进来时，代码以路由为准；Esc / 面包屑返回行情页。 */
  useEffect(() => {
    if (initialCode) setActiveCode(initialCode);
  }, [initialCode]);

  useEffect(() => {
    if (!initialCode) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName ?? "";
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (event.key !== "Escape") return;
      if (drawerOpenRef.current) return; // 先由抽屉自己关，Esc 不穿透到返回行情
      event.preventDefault();
      onNavigate("market");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [initialCode, onNavigate]);

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

      const barsPromise = ipc.getBars(request).then((value) => {
        barsMs = performance.now() - startedAt;
        return value;
      });
      // 指标重算失败不连坐行情：K 线照常渲染，数据不足在副图内联提示（AC-02.05-04 补3）
      const calcPromise = ipc
        .calcIndicators(request)
        .then((value) => {
          calcMs = performance.now() - startedAt;
          return { ok: true as const, value };
        })
        .catch((err) => {
          calcMs = performance.now() - startedAt;
          return { ok: false as const, failure: describeError(err) };
        });

      Promise.all([barsPromise, calcPromise])
        .then(([nextBars, calcResult]) => {
          if (current !== generation.current) return;
          setBars(nextBars);
          barsRef.current = nextBars;
          setLoading(false);

          if (calcResult.ok) {
            setCalc(calcResult.value);
            calcRef.current = calcResult.value;
            setCalcNotices(noticesForBars(nextBars.bars.length, subIds, manifest));
            setError(null);
          } else {
            setCalc(null);
            calcRef.current = null;
            const failure = calcResult.failure;
            if (failure.code === "INSUFFICIENT_DATA") {
              setCalcNotices(
                noticesForBars(nextBars.bars.length, subIds, manifest) ??
                  noticesFrom(failure, manifest),
              );
              setError(null);
            } else {
              setCalcNotices(null);
              setError(failure);
            }
          }

          if (phaseAtIssue !== "debounce" && phaseAtIssue !== "cold" && phaseAtIssue !== "warm") {
            return;
          }
          if (calcResult.ok) {
            const signature = seriesSignature(calcResult.value);
            const sample: DiagSample = {
              phase: phaseAtIssue,
              security: activeCode,
              timeframe,
              adj,
              barsMs,
              calcMs,
              totalMs: performance.now() - startedAt,
              cacheHit: calcResult.value.cacheHit,
              computedMs: calcResult.value.computedMs,
              barCount: calcResult.value.barCount,
              seriesHash: signature.hash,
              seriesPoints: signature.points,
            };
            diagSamples.current.push(sample);
            const waiter = diagWaiters.current.shift();
            if (waiter) waiter(sample);
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
            error: `${calcResult.failure.code}: ${calcResult.failure.message}`,
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
          getActiveCode: () => activeCodeRef.current,
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
          probePayload: () => {
            const calc = calcRef.current;
            if (!calc) return { datasetId: "", barCount: 0, instanceCount: 0, payloadBytes: 0 };
            return {
              datasetId: calc.datasetId,
              barCount: calc.barCount,
              instanceCount: calc.series.length,
              payloadBytes: JSON.stringify(calc).length,
            };
          },
          snapshot: () => ({
            calc: calcRef.current,
            barsLength: barsRef.current?.bars.length ?? 0,
            windowSize: rangeRef.current,
            barsClose: (barsRef.current?.bars ?? []).map((bar) => bar.close),
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

  // S-02.04-01 指标抽屉取证：AKA_DIAG_TARGET=drawer 时在 manifest 就绪后自跑一次
  useEffect(() => {
    if (!isTauriRuntime() || !manifest) return;
    if (window.sessionStorage.getItem("aka.drawer.diag.done") === "1") return;
    let alive = true;
    (async () => {
      const target = await ipc.diagTarget();
      const enabled = target === "drawer" ? await ipc.diagEnabled() : false;
      if (!enabled || !alive) return;
      window.sessionStorage.setItem("aka.drawer.diag.done", "1");
      setDiagStatus("S-02.04-01 取证：运行中");
      try {
        const report = await runDrawerDiagnostics(manifest);
        if (!alive) return;
        const passed = report.checks.filter((check) => check.passed).length;
        setDiagStatus(
          `S-02.04-01 取证：${report.ok ? "全绿" : "有红项"}（${passed}/${report.checks.length}）`,
        );
        (window as unknown as Record<string, unknown>).__AKA_DRAWER_EVIDENCE__ = report;
      } catch (err) {
        if (!alive) return;
        setDiagStatus(`S-02.04-01 取证失败：${describeError(err).message}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [manifest]);

  // S-02.05-02 恢复默认取证：AKA_DIAG_TARGET=s205 时在注册表/标的就绪后自跑一次
  useEffect(() => {
    if (!isTauriRuntime() || !manifest || !registry || securities.length === 0) return;
    if (window.sessionStorage.getItem("aka.s205.diag.done") === "1") return;
    let alive = true;
    (async () => {
      const target = await ipc.diagTarget();
      if (target !== "s205" || !alive) return;
      window.sessionStorage.setItem("aka.s205.diag.done", "1");
      setDiagStatus("S-02.05-02 取证：运行中");
      try {
        const report = await runS205Diagnostics({ registry, defaults: defaultParams });
        if (!alive) return;
        const passed = report.checks.filter((check) => check.passed).length;
        setDiagStatus(
          `S-02.05-02 取证：${report.ok ? "全绿" : "有红项"}（${passed}/${report.checks.length}）`,
        );
        (window as unknown as Record<string, unknown>).__AKA_S205_EVIDENCE__ = report;
      } catch (err) {
        setDiagStatus(`S-02.05-02 取证失败：${describeError(err).message}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [manifest, registry, securities, defaultParams]);

  // S-02.05-02 物理重启验证：AKA_DIAG_TARGET=restart 时按 localStorage 标记跑第一次或第二次启动
  useEffect(() => {
    if (!isTauriRuntime() || !manifest || !registry || securities.length === 0) return;
    if (restartStarted.current) return;
    if (window.sessionStorage.getItem("aka.restart.diag.done") === "1") return;
    restartStarted.current = true;
    let alive = true;
    (async () => {
      const target = await ipc.diagTarget();
      if (target !== "restart" || !alive) return;
      window.sessionStorage.setItem("aka.restart.diag.done", "1");
      try {
        const report = await runRestartDiagnostics(defaultParams);
        if (!alive) return;
        const passed = report.checks.filter((check) => check.passed).length;
        setDiagStatus(
          `重启验证（${report.phase}）：${report.ok ? "全绿" : "有红项"}（${passed}/${report.checks.length}）`,
        );
      } catch (err) {
        const message = describeError(err).message;
        const stage = restartDiagStage();
        setDiagStatus(`重启验证失败（${stage}）：${message}`);
        void ipc.diagWriteNamed(
          "s20502-restart-evidence.json",
          JSON.stringify({ ok: false, phase: "error", stage, error: message }, null, 2),
        );
      }
    })();
    return () => {
      alive = false;
    };
  }, [manifest, registry, securities, defaultParams]);

  // S-01.02-01/02/03 自选取证：AKA_DIAG_TARGET=watchlist@<token> 时在页面就绪后自跑一次
  useEffect(() => {
    if (!isTauriRuntime() || !manifest || !registry || securities.length === 0) return;
    if (watchlistStarted.current) return;
    watchlistStarted.current = true;
    // 不用 alive 门闩：StrictMode/HMR 重跑不应把已启动的取证静默掐断
    void (async () => {
      const target = await ipc.diagTarget();
      if (!target.startsWith("watchlist")) return;
      // sessionStorage 只在本进程内有效（实测：pkill 后新进程为空）；
      // token 用于同一进程内页面重挂载时区分取证批次，避免重挂载被旧标记静默挡住
      if (window.sessionStorage.getItem("aka.watchlist.diag.run") === target) return;
      window.sessionStorage.setItem("aka.watchlist.diag.run", target);
      try {
        const report = await runWatchlistDiagnostics();
        const passed = report.checks.filter((check) => check.passed).length;
        setDiagStatus(
          `自选取证：${report.ok ? "全绿" : "有红项"}（${passed}/${report.checks.length}）`,
        );
      } catch (err) {
        const message = describeError(err).message;
        const stage = watchlistDiagStage();
        setDiagStatus(`自选取证失败（${stage}）：${message}`);
        void ipc.diagWriteNamed(
          "s0102-watchlist-evidence.json",
          JSON.stringify({ ok: false, stage, error: message }, null, 2),
        );
      }
    })();
  }, [manifest, registry, securities, defaultParams]);

  // AC-02.04-01 跨页核对：抽屉分类计数 vs 指标目录分类计数（比较两页各自渲染结果）
  useEffect(() => {
    if (!isTauriRuntime() || !manifest) return;
    if (window.sessionStorage.getItem("aka.xpage.diag.done") === "1") return;
    (async () => {
      const target = await ipc.diagTarget();
      if (target !== "xpage") return;
      window.sessionStorage.setItem("aka.xpage.diag.done", "1");
      try {
        await runCrossPageCountDiagnostics();
      } catch (err) {
        console.error("[xpage.diag]", describeError(err).message);
      }
    })();
  }, [manifest]);

  // 副图面板标题按当前参数口径生成（AC-02.04-03：标题必须是 MACD(12,26,9) 这种形态）
  const subLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const item of manifest?.indicators ?? []) {
      labels[item.id] =
        item.id === "M06"
          ? `MACD(${appliedParams.fast},${appliedParams.slow},${appliedParams.signal})`
          : item.abbr;
    }
    return labels;
  }, [manifest, appliedParams.fast, appliedParams.slow, appliedParams.signal]);

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
    writeSessionParams(params);
  };

  const handleRestoreDefaults = () => {
    setError(null);
    setParams(defaultParams);
    setAppliedParams(defaultParams);
    writeSessionParams(defaultParams);
  };

  return (
    <AppShell active="workbench" onNavigate={onNavigate}>
      <div className="workbench">
        <header className="wb-header">
          <div className="sec-identity">
            {initialCode && (
              <button
                type="button"
                className="crumb"
                data-wb-back="1"
                title="返回行情（Esc）"
                onClick={() => onNavigate("market")}
              >
                行情 /
              </button>
            )}
            <h1 data-wb-name>{security?.name ?? "未选择标的"}</h1>
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
            onGoMarket={() => onNavigate("market")}
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

              <button
                type="button"
                className="btn"
                ref={drawerTriggerRef}
                data-drawer-trigger="1"
                aria-expanded={drawerOpen}
                onClick={() => (drawerOpen ? closeDrawer() : setDrawerOpen(true))}
              >
                指标
              </button>

              <span className="caption">主图叠加</span>
              <select
                className="b2-select"
                aria-label="主图叠加"
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
                {[...B2_OVERLAY_CHOICES, ...B1_OVERLAY_CHOICES].map((item) => (
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
                multiple
                size={3}
                value={subIds}
                onChange={(event) => {
                  const picked = Array.from(event.target.selectedOptions).map(
                    (option) => option.value,
                  );
                  setSubIds(picked.slice(0, MAX_SUBPLOTS));
                }}
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
                    subIds={subIds}
                    subNotices={calcNotices ?? undefined}
                    subLabels={subLabels}
                    units={units}
                  />
                  <IndicatorReadouts
                    series={calc?.series ?? []}
                    barCount={bars.bars.length}
                    overlayIds={overlayIds}
                    subIds={subIds}
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

            {drawerOpen && (
              <IndicatorDrawer
                manifest={manifest}
                loading={loading && !manifest}
                error={manifest ? null : error}
                onRetry={() => window.location.reload()}
                overlayIds={overlayIds}
                subIds={subIds}
                hasTarget={Boolean(security)}
                onAddMain={(id) =>
                  setOverlayIds((prev) =>
                    prev.includes(id) || prev.length >= MAX_MAIN_OVERLAYS
                      ? prev
                      : [...prev, id],
                  )
                }
                onAddSub={(id) =>
                  setSubIds((prev) =>
                    prev.includes(id) || prev.length >= MAX_SUBPLOTS ? prev : [...prev, id],
                  )
                }
                onClose={closeDrawer}
              />
            )}
          </main>

          <ParamPanel
            registry={registry}
            params={params}
            onChange={setParams}
            onApply={handleApply}
            onRestore={handleRestoreDefaults}
            isDefault={sameParams(params, defaultParams)}
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
          <span data-wb-returned={bars?.bars.length ?? 0}>
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
