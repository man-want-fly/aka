import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppShell, type RouteKey } from "../../app/AppShell";
import { CandleChart, type ChartViewport } from "../../components/CandleChart";
import { IndicatorReadouts } from "../../components/IndicatorReadouts";
import { ParamPanel } from "../../components/ParamPanel";
import { SimBadge } from "../../components/SimBadge";
import { Watchlist } from "../../components/Watchlist";
import { StarButton } from "../../components/StarButton";
import { IndicatorDrawer } from "../../features/workbench/IndicatorDrawer";
import { runDrawerDiagnostics } from "../../features/workbench/drawerDiag";
import { writeLastCode } from "../../features/catalog/chartLink";
import {
  B2_OVERLAY_CHOICES,
  B1_OVERLAY_CHOICES,
  SUB_CHOICES,
  DEFAULT_B2_OVERLAYS,
  DEFAULT_PARAMS,
  MAX_MAIN_OVERLAYS,
  MAX_SUBPLOTS,
  SUB_HEIGHT_DEFAULT,
  VOLUME_PANEL_ID,
  clampSubHeight,
  readSubPlots,
  writeSubPlots,
  type SubPlotSetting,
  buildInstances,
  defaultsFromIndicators,
  localCheck,
  readSessionParams,
  sameParams,
  writeSessionParams,
  type WorkbenchParams,
} from "../../features/workbench/model";
import {
  LIMIT_APPROX_TITLE,
  deriveLimitPrices,
  showLimitApprox,
} from "../../features/workbench/quote";
import {
  runS2Diagnostics,
  runS20602Diagnostics,
  seriesSignature,
  type DiagPhase,
  type DiagSample,
  type TimeframeCode,
} from "../../features/workbench/diag";
import { runS205Diagnostics } from "../../features/workbench/s205Diag";
import { runS20501Diagnostics } from "../../features/workbench/s20501Diag";
import { runS20801Diagnostics } from "../../features/workbench/s20801Diag";
import { datasetSegments as buildDatasetSegments } from "../../features/workbench/datasetOverview";
import { runS203Diagnostics } from "../../features/workbench/s203Diag";
import { runS20202Diagnostics } from "../../features/workbench/s20202Diag";
import { runS20101Diagnostics } from "../../features/workbench/s20101Diag";
import { runS207Diagnostics } from "../../features/workbench/s207Diag";
import { runS070503Diagnostics } from "../../features/workbench/s070503Diag";
import { runS080202Diagnostics } from "../../features/workbench/s080202Diag";
import { runCrossPageCountDiagnostics } from "../../features/catalog/crossPageDiag";
import { runRestartDiagnostics, restartDiagStage } from "../../features/workbench/restartDiag";
import { runWatchlistDiagnostics, watchlistDiagStage } from "../../features/watchlist/watchlistDiag";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { describeError, ipc, isTauriRuntime } from "../../lib/ipc";
import {
  runS020801Diagnostics,
  runS030302WorkbenchDiagnostics,
  writeDiagnosticFailure,
} from "../../features/qa/batchDiag";
import type {
  AppError,
  BarProvenanceDto,
  BarsResponse,
  CalcResponse,
  ManifestResponse,
  RegistryResponse,
  SecurityDto,
  DatasetManifestDto,
} from "../../lib/types";
import {
  formatAmount,
  formatComputedMs,
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
  onNavigate: (key: RouteKey) => void;
}

/**
 * 图表子树兜底：渲染期抛错会把整棵图表卸载，光看空白无法定位。
 * 捕获时落盘 s207-crash.json（含 componentStack），并把错误显示在图表位。
 */
class ChartCrashBoundary extends Component<{ children: ReactNode }, { message: string }> {
  state = { message: "" };

  componentDidCatch(error: Error, info: ErrorInfo) {
    void ipc
      .diagWriteNamed(
        "s207-crash.json",
        JSON.stringify(
          {
            at: new Date().toISOString(),
            message: error.message,
            stack: error.stack ?? "",
            componentStack: info.componentStack ?? "",
          },
          null,
          2,
        ),
      )
      // release 不注册诊断写命令（W-49），这里失败是预期，不能变成未捕获拒绝。
      .catch(() => undefined);
    this.setState({ message: error.message });
  }

  render() {
    if (this.state.message) return <div className="error-box">图表渲染失败：{this.state.message}</div>;
    return this.props.children;
  }
}

const RANGES = [
  { label: "60", value: 60 },
  { label: "120", value: 120 },
  { label: "250", value: 250 },
  { label: "全部", value: 9999 },
];

/** 输入静默 120ms 后才发请求：连续输入（典型间隔 40ms）只保留最后一次，避免抖动请求 */
const REQUEST_DEBOUNCE_MS = 120;

/** W-119：页脚取证前等待「页脚已就绪」的上限；超时也照常跑一次 runner，产出可判红的 dump */
const FOOTER_READY_TIMEOUT_MS = 20_000;

/** S-08.02-02：错误标题只认三类，其余归「计算失败」。 */
const CALC_ERROR_TITLES: Record<string, string> = {
  E_TIMEOUT: "计算超时",
  E_ENGINE_PANIC: "引擎异常",
  E_DATA_UNAVAILABLE: "数据不可用",
};

function calcErrorMeta(failure: AppError): { traceId: string | null; elapsedMs: number | null } {
  const details = (failure.details ?? {}) as Record<string, unknown>;
  return {
    traceId: typeof details.traceId === "string" ? details.traceId : null,
    elapsedMs: typeof details.elapsedMs === "number" ? details.elapsedMs : null,
  };
}

/** AC-02.05-04 补3：把后端 E_INSUFFICIENT_DATA 的 details 转成副图内联文案 */
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

/**
 * S-07.05-03：六字段溯源展示口径。
 * 缺失（后端 missingFields 命中或值为空）一律显示「缺失」；
 * quality_flags 只认四个枚举，其余不展示，空集显示「无」。
 */
const PROVENANCE_FLAGS = ["EX_RIGHTS", "SUSPENDED", "ZERO_VOLUME", "PRICE_ANOMALY"];
const PROVENANCE_MISSING = "缺失";

function provText(value: string | null, missing: Set<string>, field: string): string {
  if (!value || missing.has(field)) return PROVENANCE_MISSING;
  return value;
}

function provTime(value: number | null, missing: Set<string>): string {
  if (value === null || !Number.isFinite(value) || missing.has("ingestedAt")) {
    return PROVENANCE_MISSING;
  }
  const date = new Date(value * 1000);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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
  /** 区分「代码表加载中」与真实的 0 只数据集 */
  const [datasetReady, setDatasetReady] = useState(false);
  const [registry, setRegistry] = useState<RegistryResponse | null>(null);
  const [manifest, setManifest] = useState<ManifestResponse | null>(null);
  // S-02.08-01：页脚 7 段唯一来源；不提供 manifest 时整段显示 —
  const [datasetManifest, setDatasetManifest] = useState<DatasetManifestDto | null>(null);
  // W-119：manifest 读取是否仍在途中。途中不是「manifest 字段缺失」，页脚各段显示「加载中」。
  const [datasetManifestPending, setDatasetManifestPending] = useState(true);
  const [shaCopied, setShaCopied] = useState(false);
  const units = useMemo(
    () =>
      Object.fromEntries(
        (manifest?.indicators ?? []).map((item) => [item.id, item.unit]),
      ) as Record<string, string>,
    [manifest],
  );
  const [activeCode, setActiveCode] = useState(initialCode ?? "300750.SZ");

  // S-03.01-04：工作台每次带到某只标的，都刷新目录页可用的最近标的。
  useEffect(() => {
    writeLastCode(activeCode);
    // S-05.01-02：工作台打开标的即写最近查看；浏览器预览不写。
    if (isTauriRuntime()) {
      void ipc.touchRecentView(activeCode).catch(() => {
        /* 最近查看失败不影响主流程 */
      });
    }
  }, [activeCode]);
  // S-02.02-02：复权口径本地持久化（chart.adj），默认前复权
  const [adj, setAdj] = useState<"none" | "qfq" | "hfq">(() => {
    try {
      const stored = window.localStorage.getItem("aka.chart.adj");
      if (stored === "none" || stored === "qfq" || stored === "hfq") return stored;
    } catch {
      /* 存储不可用时用默认值 */
    }
    return "qfq";
  });
  const [timeframe, setTimeframe] = useState<TimeframeCode>("D");
  // S-02.07-01 视口：按 (code, period) 记忆，默认 120 根；切标的/周期各用各的
  const [viewport, setViewportState] = useState<ChartViewport | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [params, setParams] = useState<WorkbenchParams>(DEFAULT_PARAMS);
  const [appliedParams, setAppliedParams] = useState<WorkbenchParams>(DEFAULT_PARAMS);
  // S-02.05-01：越界不计算；上一份有效参数用于超时（>300ms）回退
  const [paramTimeout, setParamTimeout] = useState(false);
  const lastGoodParamsRef = useRef<WorkbenchParams>(DEFAULT_PARAMS);
  const defaultParams = useMemo(
    () => (manifest ? defaultsFromIndicators(manifest.indicators) : DEFAULT_PARAMS),
    [manifest],
  );

  // S-02.07-01 视口记忆：按 (code, period) 存；sessionStorage 只为同进程内刷新页面保留
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem("aka.chart.viewport");
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, ChartViewport>;
      Object.entries(parsed).forEach(([key, value]) => {
        if (value && Number.isFinite(value.start) && Number.isFinite(value.end)) {
          viewportMemory.current.set(key, value);
        }
      });
    } catch {
      /* 记忆损坏时按空表处理，不影响主流程 */
    }
  }, []);

  const viewportKey = `${activeCode}|${timeframe}`;
  const setViewport = useCallback((next: ChartViewport) => {
    viewportRef.current = next;
    setViewportState(next);
    viewportMemory.current.set(viewportKey, next);
    try {
      window.sessionStorage.setItem(
        "aka.chart.viewport",
        JSON.stringify(Object.fromEntries(viewportMemory.current)),
      );
    } catch {
      /* 存储不可用时只保留内存记忆 */
    }
  }, [viewportKey]);

  // S-02.05-02 会话记忆：同一会话内切页/切标的保留参数；重启回到 manifest 默认值
  useEffect(() => {
    const stored = readSessionParams();
    if (!stored) return;
    setParams(stored);
    setAppliedParams(stored);
    lastGoodParamsRef.current = stored;
  }, []);
  // S-02.05-01：合法参数 120ms 防抖后即时生效；越界值不入计算，图上保留上一份有效结果
  const paramsIssue = localCheck(params);
  useEffect(() => {
    if (paramsIssue) return;
    if (sameParams(params, appliedParams)) return;
    const timer = window.setTimeout(() => {
      setAppliedParams({ ...params });
      writeSessionParams(params);
      setError(null);
    }, REQUEST_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [params, appliedParams, paramsIssue]);

  // B2 主图叠加与副图选择：纯客户端切换，指标实例已全量下发
  // S-02.02-02：chart.overlays[] 本地持久化，容量 2，K 线本身不计入
  const [overlayIds, setOverlayIds] = useState<string[]>(() => {
    try {
      const raw = window.localStorage.getItem("aka.chart.overlays");
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      if (Array.isArray(parsed)) {
        const ids = parsed.filter((item): item is string => typeof item === "string");
        return ids.slice(0, MAX_MAIN_OVERLAYS);
      }
    } catch {
      /* 存储损坏时回默认 */
    }
    return DEFAULT_B2_OVERLAYS;
  });
  // S-02.02-02：复权/叠加选择落本地，重启恢复
  useEffect(() => {
    try {
      window.localStorage.setItem("aka.chart.adj", adj);
    } catch {
      /* 存储不可用不阻塞主流程 */
    }
  }, [adj]);
  useEffect(() => {
    try {
      window.localStorage.setItem("aka.chart.overlays", JSON.stringify(overlayIds));
    } catch {
      /* 存储不可用不阻塞主流程 */
    }
  }, [overlayIds]);
  /** 切换计时起点：复权/周期按钮点击时写入，数据落图后打 switch.*_ms */
  const switchStartRef = useRef<{ at: number; kind: "period" | "adj" } | null>(null);
  const pendingSwitchRef = useRef<{
    at: number;
    kind: "period" | "adj";
    security: string;
    timeframe: TimeframeCode;
    adj: "none" | "qfq" | "hfq";
    barsMs: number;
    calcMs: number;
  } | null>(null);
  const lastSwitchKeyRef = useRef(`${adj}|${timeframe}`);
  /** 首次切换立即发请求；请求在途时的后续连点仍走 100ms 防抖，只保留最后一次 */
  const inFlightRef = useRef(false);
  // S-02.03-01：副图格（含成交量）的顺序与高度，全局持久化
  const [subPlots, setSubPlots] = useState<SubPlotSetting[]>(readSubPlots);
  const subIds = useMemo(
    () => subPlots.filter((item) => item.id !== VOLUME_PANEL_ID).map((item) => item.id),
    [subPlots],
  );
  const commitSubPlots = useCallback((next: SubPlotSetting[]) => {
    const clamped = next
      .slice(0, MAX_SUBPLOTS)
      .map((item) => ({ id: item.id, height: clampSubHeight(item.height) }));
    setSubPlots(clamped);
    writeSubPlots(clamped);
  }, []);
  /** 取证读取当前副图配置（effect 闭包不随 state 更新） */
  const subPlotsRef = useRef(subPlots);
  subPlotsRef.current = subPlots;
  // 兼容既有入口（工具栏多选 / 取证脚本）：只改副图指标，保留成交量格
  const updateSubIds = useCallback((ids: string[]) => {
    setSubPlots((prev) => {
      const vol = prev.find((item) => item.id === VOLUME_PANEL_ID);
      const next: SubPlotSetting[] = vol ? [{ ...vol }] : [];
      for (const id of ids) {
        if (next.length >= MAX_SUBPLOTS) break;
        if (next.some((item) => item.id === id)) continue;
        const old = prev.find((item) => item.id === id);
        next.push({ id, height: old?.height ?? SUB_HEIGHT_DEFAULT });
      }
      writeSubPlots(next);
      return next;
    });
  }, []);
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
  // S-03.03-02：从抽屉深链返回时恢复抽屉，视口/副图由各自持久化恢复
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem("aka.workbench.drawer.return") === "1") {
        window.sessionStorage.removeItem("aka.workbench.drawer.return");
        setDrawerOpen(true);
      }
    } catch {
      // 返回态只影响体验，存储不可用时不阻断工作台
    }
  }, []);
  // S-03.03-02：图例「?」/ 抽屉来源取证
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let alive = true;
    (async () => {
      const target = await ipc.diagTarget();
      if (target !== "s030302" || !(await ipc.diagEnabled()) || !alive) return;
      if (window.sessionStorage.getItem("aka.batch.s030302.done") === "1") return;
      window.sessionStorage.setItem("aka.batch.s030302.done", "1");
      try {
        await runS030302WorkbenchDiagnostics();
      } catch (err) {
        console.error("[s030302.diag]", describeError(err).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  const [bars, setBars] = useState<BarsResponse | null>(null);
  const [calc, setCalc] = useState<CalcResponse | null>(null);
  // W-119：本次计算是否已出结果（成功或失败）。未出结果时页脚计算段显示「计算中」（卡面口径）。
  const [calcSettled, setCalcSettled] = useState(false);
  // S-07.05-03：主图 K 线点击 → 六字段溯源浮层（复用 S-07.05-02 的 bar_provenance，不新增 IPC）
  const [provSel, setProvSel] = useState<{ index: number; date: string } | null>(null);
  const [provData, setProvData] = useState<BarProvenanceDto | null>(null);
  const [provLoading, setProvLoading] = useState(false);
  const [provError, setProvError] = useState<string | null>(null);
  const provToken = useRef(0);
  // 供 diag 逐根比对读取「当前渲染帧」的引擎结果（effect 闭包不会随后续 render 更新）
  const calcRef = useRef<CalcResponse | null>(null);
  const barsRef = useRef<BarsResponse | null>(null);
  const viewportRef = useRef<ChartViewport | null>(null);
  const viewportMemory = useRef<Map<string, ChartViewport>>(new Map());

  // bars 到位/切标的后落视口：同一 (code, period) 有记忆就恢复，否则默认 120 根
  useEffect(() => {
    if (!bars || bars.bars.length === 0) {
      viewportRef.current = null;
      setViewportState(null);
      return;
    }
    // 切标的瞬间 bars 仍是上一批，等请求参数与当前 code/timeframe 对齐后再落
    if (bars.security !== activeCode || bars.timeframe !== timeframe) return;
    const total = bars.bars.length;
    const remembered = viewportMemory.current.get(viewportKey);
    if (remembered) {
      const count = Math.min(remembered.end - remembered.start + 1, total);
      const start = Math.max(0, Math.min(remembered.start, total - count));
      const next = { start, end: start + count - 1 };
      viewportRef.current = next;
      setViewportState(next);
      return;
    }
    const count = Math.min(120, total);
    const next = { start: total - count, end: total - 1 };
    viewportRef.current = next;
    setViewportState(next);
  }, [bars, activeCode, timeframe, viewportKey]);
  const [loading, setLoading] = useState(false);
  /** 切换超过 120ms 才换骨架；120ms 内保留旧图 + 半透明遮罩 */
  const [slowLoading, setSlowLoading] = useState(false);
  useEffect(() => {
    if (!loading) {
      setSlowLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setSlowLoading(true), 120);
    return () => window.clearTimeout(timer);
  }, [loading]);

  // S-02.02-02：切换耗时在状态提交后打点——click → 新数据上图（DOM 提交）的耗时，
  // 不含 rAF 排队那一帧，避免 AC-02.02-02 的 150ms 被浏览器调度噪声吃掉。
  useLayoutEffect(() => {
    const pending = pendingSwitchRef.current;
    if (loading || !pending) return;
    pendingSwitchRef.current = null;
    const totalMs = performance.now() - pending.at;
    void ipc
      .telemetryNote(pending.kind === "adj" ? "switch.adj_ms" : "switch.period_ms", {
        total_ms: Math.round(totalMs * 10) / 10,
        security: pending.security,
        timeframe: pending.timeframe,
        adj: pending.adj,
        bars_ms: Math.round(pending.barsMs * 10) / 10,
        calc_ms: Math.round(pending.calcMs * 10) / 10,
      })
      .catch(() => undefined);
  }, [loading]);
  const [error, setError] = useState<AppError | null>(null);
  // S-08.02-02：错误态独立于数据不足内联提示；连续失败 3 次才出「导出诊断包」。
  const [retryNonce, setRetryNonce] = useState(0);
  const [failureStreak, setFailureStreak] = useState(0);
  const failureStreakRef = useRef(0);
  const [exportHint, setExportHint] = useState<string | null>(null);
  // S-01.02-01：报价头星标与自选同源；写库失败必须回滚并给出错误条。
  const [watched, setWatched] = useState(false);
  const [watchBusy, setWatchBusy] = useState(false);
  const [watchError, setWatchError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauriRuntime()) {
      setWatched(false);
      return;
    }
    let alive = true;
    ipc
      .watchlist()
      .then((data) => {
        if (alive) setWatched(data.items.some((item) => item.security === activeCode));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [activeCode]);

  const toggleWatch = () => {
    if (watchBusy) return;
    const next = !watched;
    setWatched(next);
    setWatchBusy(true);
    setWatchError(null);
    void ipc
      .toggleWatch(activeCode)
      .then((result) => {
        setWatched(result.watched);
        window.dispatchEvent(new Event("aka:watchlist-refresh"));
      })
      .catch((err) => {
        setWatched(!next);
        const message = describeError(err).message;
        setWatchError(message.startsWith("自选上限") ? message : `自选未保存：${message}`);
      })
      .finally(() => window.setTimeout(() => setWatchBusy(false), 200));
  };

  // 数据不足的内联提示按指标 id 归位，不上升为全局错误条
  const [calcNotices, setCalcNotices] = useState<Record<string, string> | null>(null);
  // S-02.08-01：7 段全部派生自 manifest + 当前口径；顺序由 DATASET_SEGMENTS 固定
  const datasetFooter = buildDatasetSegments({
    manifest: datasetManifest,
    adj,
    timeframe,
    computedMs: calc?.computedMs ?? null,
    cacheHit: calc?.cacheHit ?? null,
    loading,
    manifestPending: datasetManifestPending,
    calcPending: !calcSettled,
  });
  // W-119：页脚 7 段的读点。manifest 派生的 4 段要等 dataset_manifest 回来，
  // 计算段要等首次计算出结果；否则读到的只是「未就绪」的半成品。
  const footerReady = !datasetManifestPending && calcSettled;
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
  const timeframeRef = useRef(timeframe);
  timeframeRef.current = timeframe;
  const [diagStatus, setDiagStatus] = useState<string | null>(null);
  /** S-07.01-01（补1）：必需能力缺口文案；非空时工作台入口出现「查看数据源状态」。 */
  const [datasourceIssue, setDatasourceIssue] = useState<string | null>(null);

  // S-07.05-03：浮层关闭（ESC / 点外 / 切标的 / 切周期 / 切复权均清空，不保留上一条）
  const closeProvenance = useCallback(() => {
    provToken.current += 1;
    setProvSel(null);
    setProvData(null);
    setProvError(null);
    setProvLoading(false);
  }, []);

  const openProvenance = useCallback(
    (index: number) => {
      const bar = barsRef.current?.bars[index];
      if (!bar) return;
      const token = provToken.current + 1;
      provToken.current = token;
      setProvSel({ index, date: bar.date });
      setProvData(null);
      setProvError(null);
      setProvLoading(true);
      ipc
        .barProvenance({
          security: activeCodeRef.current,
          date: bar.date,
          timeframe,
          adj,
        })
        .then((data) => {
          if (provToken.current !== token) return;
          setProvData(data);
          setProvLoading(false);
        })
        .catch((err) => {
          if (provToken.current !== token) return;
          setProvError(describeError(err).message);
          setProvLoading(false);
        });
    },
    [adj, timeframe],
  );

  useEffect(() => {
    closeProvenance();
  }, [activeCode, timeframe, adj, closeProvenance]);

  useEffect(() => {
    if (!provSel) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeProvenance();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest("[data-provenance='1']")) return;
      closeProvenance();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [provSel, closeProvenance]);

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

  // S-02.08-01：页脚只消费 manifest 下发的字段；取不到就整段显示 —，不在前端补默认数字
  useEffect(() => {
    if (!isTauriRuntime()) {
      // 非 Tauri 运行没有 manifest 来源，直接落到「未就绪结束」态，不让页脚一直显示「加载中」
      setDatasetManifestPending(false);
      return;
    }
    let alive = true;
    ipc
      .datasetManifest()
      .then((meta) => {
        if (alive) setDatasetManifest(meta);
      })
      .catch(() => {
        /* manifest 取不到不阻塞行情主流程，页脚降级为 — */
      })
      .finally(() => {
        if (alive) setDatasetManifestPending(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const copyDatasetSha = useCallback(async () => {
    const sha = datasetManifest?.sha256;
    if (!sha) return;
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(sha);
        copied = true;
      }
    } catch {
      /* 走 textarea 兜底 */
    }
    if (!copied) {
      // wry 的 custom protocol 不一定是 secure context，剪贴板 API 可能不可用
      const area = document.createElement("textarea");
      area.value = sha;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      }
      area.remove();
    }
    if (!copied) return;
    setShaCopied(true);
    window.setTimeout(() => setShaCopied(false), 1_500);
  }, [datasetManifest]);

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
        setDatasetReady(true);
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

  // S-08.02-02 补2：切标的后旧错误立即消失，不等下一次请求回来。
  useEffect(() => {
    setError(null);
    setExportHint(null);
    failureStreakRef.current = 0;
    setFailureStreak(0);
  }, [activeCode]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    // 复权/周期切换：首次点击立即取数（AC-02.02-02 总耗时 ≤150ms）；在途连点按 100ms 防抖只留最后一次
    const switchKey = `${adj}|${timeframe}`;
    const isSwitch = lastSwitchKeyRef.current !== switchKey;
    lastSwitchKeyRef.current = switchKey;
    const debounceMs =
      isSwitch && switchStartRef.current
        ? inFlightRef.current
          ? 100
          : 0
        : REQUEST_DEBOUNCE_MS;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      const current = ++generation.current;
      inFlightRef.current = true;
      setLoading(true);
      setError(null);
      // W-119：本轮计算重新开始，计算段回到「计算中」，页脚未就绪
      setCalcSettled(false);

      const requestParams = appliedParams;
      const request = {
        security: activeCode,
        timeframe,
        adj,
        from: dateFrom || undefined,
        to: dateTo || undefined,
        generation: current,
        instances: buildInstances(requestParams),
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
          // W-114：计时终点＝两份响应都到手那一刻，不含其后的状态提交与取证哈希
          const totalMs = performance.now() - startedAt;
          inFlightRef.current = false;
          setBars(nextBars);
          barsRef.current = nextBars;
          setLoading(false);
          // W-119：本轮计算已出结果（成功或失败），页脚计算段不再是「计算中」
          setCalcSettled(true);

          if (calcResult.ok) {
            // AC-02.05-01 补4：服务端耗时 >300ms 提示超时并回退上一组有效参数
            const forcedTimeout =
              (window as unknown as Record<string, unknown>).__AKA_FORCE_PARAM_TIMEOUT__ === true;
            if (calcResult.value.computedMs > 300 || forcedTimeout) {
              setParamTimeout(true);
              setParams(lastGoodParamsRef.current);
              setAppliedParams(lastGoodParamsRef.current);
              writeSessionParams(lastGoodParamsRef.current);
            } else {
              setParamTimeout(false);
              lastGoodParamsRef.current = requestParams;
            }
            setCalc(calcResult.value);
            calcRef.current = calcResult.value;
            setCalcNotices(noticesForBars(nextBars.bars.length, subIds, manifest));
            setError(null);
            failureStreakRef.current = 0;
            setFailureStreak(0);
          } else {
            setCalc(null);
            calcRef.current = null;
            const failure = calcResult.failure;
            if (failure.code === "E_INSUFFICIENT_DATA") {
              setCalcNotices(
                noticesForBars(nextBars.bars.length, subIds, manifest) ??
                  noticesFrom(failure, manifest),
              );
              setError(null);
            } else {
              setCalcNotices(null);
              setError(failure);
              failureStreakRef.current += 1;
              setFailureStreak(failureStreakRef.current);
            }
          }

          // S-02.02-02：复权/周期切换总耗时写入 telemetry（AC-02.02-02 的 switch.period_ms 取证）。
          // 打点推迟到本批状态提交之后（useLayoutEffect），避免把 rAF 排队的一帧算进切换耗时。
          if (isSwitch && switchStartRef.current) {
            pendingSwitchRef.current = {
              ...switchStartRef.current,
              security: activeCode,
              timeframe,
              adj,
              barsMs,
              calcMs,
            };
            switchStartRef.current = null;
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
              totalMs,
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
            totalMs,
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
    }, debounceMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeCode, adj, appliedParams, dateFrom, dateTo, retryNonce, timeframe]);

  /** S-08.02-02：重试 / 降低参数 / 导出诊断包（连续失败 3 次后可见）。 */
  const retryCalc = useCallback(() => {
    setExportHint(null);
    setRetryNonce((value) => value + 1);
  }, []);

  const reduceCalcParams = useCallback(() => {
    setParams(DEFAULT_PARAMS);
    setAppliedParams(DEFAULT_PARAMS);
    writeSessionParams(DEFAULT_PARAMS);
    setParamTimeout(false);
    setRetryNonce((value) => value + 1);
  }, []);

  const exportCalcDiagnostics = useCallback(async () => {
    try {
      const result = await ipc.exportDiagnostics({});
      setExportHint(`诊断包已导出：${result.path}`);
    } catch (err) {
      const info = describeError(err);
      setExportHint(`导出失败：${info.code} · ${info.message}`);
    }
  }, []);

  // S-08.02-02 取证：AKA_DIAG_TARGET=s080202 时在真实工作台跑错误态。
  useEffect(() => {
    if (!isTauriRuntime() || securities.length < 2 || !activeCode) return;
    if (window.sessionStorage.getItem("aka.s080202.diag.done") === "1") return;
    let alive = true;
    (async () => {
      const enabled = await ipc.diagEnabled();
      const target = await ipc.diagTarget();
      if (!enabled || !alive || target !== "s080202") return;
      window.sessionStorage.setItem("aka.s080202.diag.done", "1");
      try {
        await runS080202Diagnostics({
          codes: securities.map((item) => item.code),
          setInject: async (kind) => {
            await ipc.diagSetInject(kind);
          },
          trigger: () => setRetryNonce((value) => value + 1),
          setCode: setActiveCode,
        });
      } catch (err) {
        console.error("[s080202.diag]", describeError(err).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [activeCode, securities]);

  // S2 实机取证：仅 AKA_DIAG=1 且已有标的列表时自跑一次
  useEffect(() => {
    if (!isTauriRuntime() || securities.length === 0 || diagStarted.current) return;
    if (window.sessionStorage.getItem("aka.s2.diag.once") === "1") return;
    diagStarted.current = true;
    let alive = true;
    (async () => {
      const enabled = await ipc.diagEnabled();
      const target = await ipc.diagTarget();
      // 指定了其它取证目标时让路，避免两套套件同时切标的/周期
      if (!enabled || !alive || (target !== "" && target !== "s2")) return;
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
          // 走真实用户输入路径：params → 120ms 防抖 → appliedParams（S-02.05-01）。
          // 直接写 appliedParams 会与 params 防抖互相触发，连键会被测成 2 个批次。
          setParams,
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
            windowSize: viewportRef.current
              ? viewportRef.current.end - viewportRef.current.start + 1
              : 0,
            viewStart: viewportRef.current?.start ?? 0,
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

  // W-111 / S-02.06-02 缓存回切取证：独立套件，AKA_DIAG_TARGET=s20602 时自跑一次。
  useEffect(() => {
    if (!isTauriRuntime() || securities.length === 0) return;
    if (window.sessionStorage.getItem("aka.s20602.diag.once") === "1") return;
    let alive = true;
    (async () => {
      const enabled = await ipc.diagEnabled();
      const target = await ipc.diagTarget();
      if (!enabled || !alive || target !== "s20602") return;
      window.sessionStorage.setItem("aka.s20602.diag.once", "1");
      setDiagStatus("S-02.06-02 取证：运行中");
      try {
        const report = await runS20602Diagnostics({
          codes: securities.map((item) => item.code),
          getActiveCode: () => activeCodeRef.current,
          baseParams: DEFAULT_PARAMS,
          setPhase: (phase) => {
            diagPhase.current = phase;
          },
          setCode: setActiveCode,
          setParams,
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
          // 本套件落盘走 ipc.diagWriteNamed("s20602-evidence.json")，不碰 s2 dump
          write: (payload) => ipc.diagWriteNamed("s20602-evidence.json", payload),
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
            windowSize: viewportRef.current
              ? viewportRef.current.end - viewportRef.current.start + 1
              : 0,
            viewStart: viewportRef.current?.start ?? 0,
            barsClose: (barsRef.current?.bars ?? []).map((bar) => bar.close),
          }),
        });
        if (!alive) return;
        const written = String(report.writtenTo ?? "");
        setDiagStatus(`S-02.06-02 取证：完成 → ${written.split("/").slice(-2).join("/")}`);
        (window as unknown as Record<string, unknown>).__AKA_S20602_EVIDENCE__ = report;
      } catch (err) {
        if (!alive) return;
        setDiagStatus(`S-02.06-02 取证：失败 ${describeError(err).message}`);
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
        const message = describeError(err).message;
        setDiagStatus(`S-02.04-01 取证失败：${message}`);
        void ipc.diagWriteNamed(
          "s20401-error.json",
          JSON.stringify(
            {
              error: message,
              stack: err instanceof Error ? err.stack : String(err),
              failedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
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

  // S-02.05-01 参数设置面板取证：AKA_DIAG_TARGET=s20501 时在注册表/标的就绪后自跑一次
  useEffect(() => {
    if (!isTauriRuntime() || !manifest || !registry || securities.length === 0) return;
    if (window.sessionStorage.getItem("aka.s20501.diag.done") === "1") return;
    let alive = true;
    (async () => {
      const target = await ipc.diagTarget();
      if (target !== "s20501" || !alive) return;
      window.sessionStorage.setItem("aka.s20501.diag.done", "1");
      setDiagStatus("S-02.05-01 取证：运行中");
      try {
        await new Promise((resolve) => window.setTimeout(resolve, 800));
        const report = await runS20501Diagnostics({ registry, defaults: defaultParams });
        if (!alive) return;
        const passed = report.checks.filter((check) => check.passed).length;
        setDiagStatus(
          `S-02.05-01 取证：${report.ok ? "全绿" : "有红项"}（${passed}/${report.checks.length}）`,
        );
        (window as unknown as Record<string, unknown>).__AKA_S20501_EVIDENCE__ = report;
      } catch (err) {
        setDiagStatus(`S-02.05-01 取证失败：${describeError(err).message}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [manifest, registry, securities, defaultParams]);

  // S-02.08-01 数据集概览取证：等 manifest 到位后再跑，避免把 null 当缺字段
  useEffect(() => {
    if (!isTauriRuntime() || !manifest || !datasetManifest) return;
    if (window.sessionStorage.getItem("aka.s20801.diag.done") === "1") return;
    let alive = true;
    (async () => {
      const target = await ipc.diagTarget();
      if (target !== "s20801" || !alive) return;
      window.sessionStorage.setItem("aka.s20801.diag.done", "1");
      setDiagStatus("S-02.08-01 取证：运行中");
      try {
        await new Promise((resolve) => window.setTimeout(resolve, 600));
        const report = await runS20801Diagnostics({ manifest: datasetManifest });
        if (!alive) return;
        const passed = report.checks.filter((check) => check.passed).length;
        setDiagStatus(
          `S-02.08-01 取证：${report.ok ? "全绿" : "有红项"}（${passed}/${report.checks.length}）`,
        );
        (window as unknown as Record<string, unknown>).__AKA_S20801_EVIDENCE__ = report;
      } catch (err) {
        setDiagStatus(`S-02.08-01 取证失败：${describeError(err).message}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [manifest, datasetManifest]);

  // W-118：S-02.08-01（补2）页脚取证接线。runner 只读 [data-dataset-overview]/
  // [data-dataset-seg]，宿主是本页；此前无任何组件调用（死代码）→ 零 dump、240s 超时。
  // 异常也落失败 dump，避免零产物空等（对齐 s070503 的 blockedDump 口径）。
  // W-119：读点必须是「页脚已就绪」。runner 的 waitFor 只等 [data-dataset-overview] 出现，
  // 而该节点从首帧就在，manifest 派生段要等 dataset_manifest 回来、计算段要等首次计算出结果；
  // 过早读会拿到「未就绪」半成品（实测缺 provider/version/range/rows/calc 共 5 段）。
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let alive = true;
    let timer = 0;
    const start = () => {
      if (!alive) return;
      if (window.sessionStorage.getItem("aka.batch.s020801.done") === "1") return;
      window.sessionStorage.setItem("aka.batch.s020801.done", "1");
      void runS020801Diagnostics().catch((err: unknown) => {
        void writeDiagnosticFailure("s020801-evidence.json", "s020801", err);
      });
    };
    void ipc
      .diagTarget()
      .then((target) => {
        if (!alive || target !== "s020801") return;
        if (footerReady) {
          start();
          return;
        }
        // 页脚始终未就绪：最多再等 FOOTER_READY_TIMEOUT_MS，仍未就绪也跑一次 runner，
        // 产出可判红、可定位的 dump，而不是零产物空等。
        timer = window.setTimeout(start, FOOTER_READY_TIMEOUT_MS);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [footerReady]);

  // S-07.05-03 溯源浮层取证：AKA_DIAG_TARGET=s070503 时自跑一次
  useEffect(() => {
    if (!isTauriRuntime() || !manifest || securities.length === 0) return;
    if (window.sessionStorage.getItem("aka.s070503.diag.done") === "1") return;
    let alive = true;
    (async () => {
      const target = await ipc.diagTarget();
      if (target !== "s070503" || !alive) return;
      window.sessionStorage.setItem("aka.s070503.diag.done", "1");
      setDiagStatus("S-07.05-03 取证：运行中");
      try {
        await new Promise((resolve) => window.setTimeout(resolve, 600));
        const report = await runS070503Diagnostics({
          getBars: () => barsRef.current,
          getActiveCode: () => activeCodeRef.current,
          getTimeframe: () => timeframeRef.current,
          setCode: setActiveCode,
          setTimeframe,
        });
        if (!alive) return;
        const passed = report.checks.filter((check) => check.passed).length;
        setDiagStatus(
          `S-07.05-03 取证：${report.ok ? "全绿" : "有红项"}（${passed}/${report.checks.length}）`,
        );
        (window as unknown as Record<string, unknown>).__AKA_S070503_EVIDENCE__ = report;
      } catch (err) {
        const message = describeError(err).message;
        setDiagStatus(`S-07.05-03 取证失败：${message}`);
        // W-89：套件异常也必须落 dump，否则 240s 只能看到「一个文件都没有」，
        // 无法区分「没跑完」和「等待路径错」；blocked 原因由 dump 明确写出。
        const blockedDump = {
          suite: "s070503",
          card: "S-07.05-03",
          ok: false,
          error: message,
          windowFocused: document.hasFocus(),
          appActive: document.visibilityState === "visible" && !document.hidden,
          finishedAt: new Date().toISOString(),
          checks: [
            {
              id: "OV-00",
              card: "S-07.05-03",
              ac: "AC-07.05-04",
              layer: "runtime" as const,
              passed: false,
              detail: `套件异常中断：${message}`,
            },
          ],
          blocked: [
            {
              ac: "AC-07.05-04",
              blocker: "run-s070503",
              reason: `套件异常中断：${message}`,
              skipped: false,
            },
          ],
        };
        await ipc
          .diagWriteNamed("s070503-evidence.json", JSON.stringify(blockedDump, null, 2))
          .catch(() => undefined);
      }
    })();
    return () => {
      alive = false;
    };
  }, [manifest, securities]);

  // S-02.03-01 副图取证：AKA_DIAG_TARGET=s203 时自跑；两轮验证「布局/拖拽」与「重启恢复」
  useEffect(() => {
    if (!isTauriRuntime() || !manifest || !registry || securities.length === 0) return;
    const restartPhase = window.localStorage.getItem("aka.s203.diag.phase") === "restart";
    if (!restartPhase && window.sessionStorage.getItem("aka.s203.diag.done") === "1") return;
    let alive = true;
    let minWait = 0;
    const waitReady = async (label: string, timeoutMs = 4000) => {
      if (minWait > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, minWait));
        minWait = 0;
      }
      let previous = "";
      let stable = 0;
      let lastNode = false;
      const startedAt = performance.now();
      while (performance.now() - startedAt < timeoutMs) {
        await new Promise((resolve) => window.setTimeout(resolve, 120));
        const frame = barsRef.current;
        const result = calcRef.current;
        const node = document.querySelector('[data-chart="candle"]');
        lastNode = node !== null;
        const signature = [
          frame?.security,
          frame?.timeframe,
          frame?.adj,
          frame?.bars.length,
          result?.generation,
          result?.barCount,
          node?.getAttribute("data-bar-count"),
          node?.getAttribute("data-view-start"),
          node?.getAttribute("data-view-end"),
        ].join("|");
        if (frame && result && node && result.barCount === frame.bars.length && signature === previous) {
          stable += 1;
          if (stable >= 2) return;
        } else {
          stable = 0;
          previous = signature;
        }
      }
      throw new Error(
        `等待就绪超时：${label}（node=${lastNode ? "有" : "无"} 末次签名=${previous} error=${
          document.querySelector(".error-box")?.textContent?.slice(0, 120) ?? "无"
        }）`,
      );
    };
    (async () => {
      const target = await ipc.diagTarget();
      if (target !== "s203" || !alive) return;
      window.sessionStorage.setItem("aka.s203.diag.done", "1");
      setDiagStatus("S-02.03-01 取证：运行中");
      try {
        const report = await runS203Diagnostics({
          getSubPlots: () => subPlotsRef.current,
          setSubPlots: commitSubPlots,
          setDateRange: (from, to) => {
            minWait = 700;
            setDateFrom(from);
            setDateTo(to);
          },
          clearDateRange: () => {
            minWait = 700;
            setDateFrom("");
            setDateTo("");
          },
          bars: () => barsRef.current,
          calc: () => calcRef.current,
          waitReady,
        });
        if (!alive) return;
        const passed = report.checks.filter((check) => check.passed).length;
        setDiagStatus(
          `S-02.03-01 取证：${report.ok ? "全绿" : "有红项"}（${passed}/${report.checks.length}）`,
        );
        (window as unknown as Record<string, unknown>).__AKA_S203_EVIDENCE__ = report;
      } catch (err) {
        if (!alive) return;
        setDiagStatus(`S-02.03-01 取证失败：${describeError(err).message}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [manifest, registry, securities, commitSubPlots]);

  // S-02.07-01/02 缩放·十字光标·数据不足取证：AKA_DIAG_TARGET=s207 时自跑一次
  useEffect(() => {
    if (!isTauriRuntime() || !manifest || !registry || securities.length === 0) return;
    if (window.sessionStorage.getItem("aka.s207.diag.done") === "1") return;
    let alive = true;
    let minWait = 0;
    // 等待「切标的/周期/参数」后的真实渲染帧：至少等 minWait，再要求两次相同的稳定签名
    const waitReady = async (label: string, timeoutMs = 4000) => {
      if (minWait > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, minWait));
        minWait = 0;
      }
      let previous = "";
      let stable = 0;
      let lastNode = false;
      const startedAt = performance.now();
      while (performance.now() - startedAt < timeoutMs) {
        await new Promise((resolve) => window.setTimeout(resolve, 120));
        const frame = barsRef.current;
        const result = calcRef.current;
        const node = document.querySelector('[data-chart="candle"]');
        lastNode = node !== null;
        const signature = [
          frame?.security,
          frame?.timeframe,
          frame?.adj,
          frame?.bars.length,
          result?.generation,
          result?.barCount,
          node?.getAttribute("data-bar-count"),
          node?.getAttribute("data-view-start"),
          node?.getAttribute("data-view-end"),
        ].join("|");
        if (frame && result && node && result.barCount === frame.bars.length && signature === previous) {
          stable += 1;
          if (stable >= 2) return;
        } else {
          stable = 0;
          previous = signature;
        }
      }
      throw new Error(
        `等待就绪超时：${label}（node=${lastNode ? "有" : "无"} 末次签名=${previous} error=${
          document.querySelector(".error-box")?.textContent?.slice(0, 120) ?? "无"
        }）`,
      );
    };
    (async () => {
      const target = await ipc.diagTarget();
      if (target !== "s207" || !alive) return;
      window.sessionStorage.setItem("aka.s207.diag.done", "1");
      // 取证期间把渲染异常落盘：CandleChart 抛错会让图表整棵子树卸载，只留 UI 状态无法定位
      const onCrash = (event: ErrorEvent) => {
        void ipc.diagWriteNamed(
          "s207-crash.json",
          JSON.stringify(
            {
              at: new Date().toISOString(),
              message: event.message,
              stack: event.error instanceof Error ? (event.error.stack ?? "") : "",
            },
            null,
            2,
          ),
        );
      };
      window.addEventListener("error", onCrash);
      setDiagStatus("S-02.07-01/02 取证：运行中");
      try {
        const report = await runS207Diagnostics({
          getActiveCode: () => activeCodeRef.current,
          setCode: (code) => {
            minWait = 600;
            setActiveCode(code);
          },
          setTimeframe: (tf) => {
            minWait = 600;
            setTimeframe(tf);
          },
          setAdj: (next) => {
            minWait = 600;
            setAdj(next);
          },
          setParams: (next) => {
            minWait = 700;
            setParams(next);
            setAppliedParams(next);
          },
          setDateRange: (from, to) => {
            minWait = 700;
            setDateFrom(from);
            setDateTo(to);
          },
          clearDateRange: () => {
            minWait = 700;
            setDateFrom("");
            setDateTo("");
          },
          setSubIds: (ids) => {
            minWait = 200;
            updateSubIds(ids);
          },
          bars: () => barsRef.current,
          calc: () => calcRef.current,
          viewport: () => viewportRef.current,
          waitReady,
        });
        if (!alive) return;
        const passed = report.checks.filter((check) => check.passed).length;
        setDiagStatus(
          `S-02.07-01/02 取证：${report.ok ? "全绿" : "有红项"}（${passed}/${report.checks.length}）`,
        );
        (window as unknown as Record<string, unknown>).__AKA_S207_EVIDENCE__ = report;
      } catch (err) {
        const message = describeError(err).message;
        setDiagStatus(`S-02.07-01/02 取证失败：${message}`);
        try {
          await ipc.diagWriteNamed(
            "s207-error.json",
            JSON.stringify(
              {
                at: new Date().toISOString(),
                message,
                stack: err instanceof Error ? (err.stack ?? "") : String(err),
              },
              null,
              2,
            ),
          );
        } catch {
          // 取证失败时不再因写盘错误覆盖原始异常
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [manifest, registry, securities]);

  // S-02.02-02 复权切换取证：AKA_DIAG_TARGET=s20202 时自跑一次
  const s20202Started = useRef(false);
  useEffect(() => {
    if (!isTauriRuntime() || !manifest || !registry || securities.length === 0) return;
    if (s20202Started.current) return;
    let alive = true;
    let minWait = 0;
    const waitReady = async (label: string, timeoutMs = 8000) => {
      if (minWait > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, minWait));
        minWait = 0;
      }
      let previous = "";
      let stable = 0;
      let lastNode = false;
      const startedAt = performance.now();
      while (performance.now() - startedAt < timeoutMs) {
        await new Promise((resolve) => window.setTimeout(resolve, 120));
        const frame = barsRef.current;
        const result = calcRef.current;
        const node = document.querySelector('[data-chart="candle"]');
        lastNode = node !== null;
        const signature = [
          frame?.security,
          frame?.timeframe,
          frame?.adj,
          frame?.bars.length,
          result?.generation,
          result?.barCount,
          node?.getAttribute("data-bar-count"),
          node?.getAttribute("data-view-start"),
          node?.getAttribute("data-view-end"),
        ].join("|");
        if (frame && result && node && result.barCount === frame.bars.length && signature === previous) {
          stable += 1;
          if (stable >= 2) return;
        } else {
          stable = 0;
          previous = signature;
        }
      }
      throw new Error(
        `等待就绪超时：${label}（node=${lastNode ? "有" : "无"} 末次签名=${previous} error=${
          document.querySelector(".error-box")?.textContent?.slice(0, 120) ?? "无"
        }）`,
      );
    };
    (async () => {
      const target = await ipc.diagTarget();
      if (target !== "s20202" || !alive) return;
      s20202Started.current = true;
      setDiagStatus("S-02.02-02 取证：运行中");
      const onCrash = (event: ErrorEvent) => {
        void ipc.diagWriteNamed(
          "s20202-crash.json",
          JSON.stringify(
            {
              at: new Date().toISOString(),
              message: event.message,
              stack: event.error instanceof Error ? (event.error.stack ?? "") : "",
            },
            null,
            2,
          ),
        );
      };
      window.addEventListener("error", onCrash);
      try {
        const report = await runS20202Diagnostics({
          getActiveCode: () => activeCodeRef.current,
          setCode: (code) => {
            minWait = 600;
            setActiveCode(code);
          },
          setDateRange: (from, to) => {
            minWait = 700;
            setDateFrom(from);
            setDateTo(to);
          },
          clearDateRange: () => {
            minWait = 700;
            setDateFrom("");
            setDateTo("");
          },
          bars: () => barsRef.current,
          calc: () => calcRef.current,
          waitReady,
          telemetry: () => ipc.telemetryDump(600),
        });
        if (!alive) return;
        const passed = report.checks.filter((check) => check.passed).length;
        setDiagStatus(
          `S-02.02-02 取证：${report.ok ? "全绿" : "有红项"}（${passed}/${report.checks.length}）`,
        );
        (window as unknown as Record<string, unknown>).__AKA_S20202_EVIDENCE__ = report;
      } catch (err) {
        if (!alive) return;
        setDiagStatus(`S-02.02-02 取证失败：${describeError(err).message}`);
      } finally {
        window.removeEventListener("error", onCrash);
      }
    })();
    return () => {
      alive = false;
    };
  }, [manifest, registry, securities]);

  // S-02.01-01 报价头取证：AKA_DIAG_TARGET=s20101 时自跑一次
  const s20101Started = useRef(false);
  useEffect(() => {
    if (!isTauriRuntime() || !manifest || !registry || securities.length === 0) return;
    if (s20101Started.current) return;
    let alive = true;
    const waitRendered = async (code: string, timeoutMs = 6000) => {
      const startedAt = performance.now();
      while (performance.now() - startedAt < timeoutMs) {
        await new Promise((resolve) => window.setTimeout(resolve, 120));
        const head = document.querySelector('[data-quote-head="1"]');
        if (
          head &&
          head.getAttribute("data-quote-code") === code &&
          barsRef.current?.security === code &&
          !inFlightRef.current
        ) {
          await new Promise((resolve) => window.setTimeout(resolve, 60));
          return;
        }
      }
      throw new Error(`报价头未切到 ${code}`);
    };
    (async () => {
      const target = await ipc.diagTarget();
      if (target !== "s20101" || !alive) return;
      s20101Started.current = true;
      setDiagStatus("S-02.01-01 取证：运行中");
      try {
        const report = await runS20101Diagnostics({
          setCode: (code) => setActiveCode(code),
          waitRendered,
        });
        if (!alive) return;
        const passed = report.checks.filter((check) => check.passed).length;
        setDiagStatus(
          `S-02.01-01 取证：${report.ok ? "全绿" : "有红项"}（${passed}/${report.checks.length}）`,
        );
        (window as unknown as Record<string, unknown>).__AKA_S20101_EVIDENCE__ = report;
      } catch (err) {
        if (!alive) return;
        setDiagStatus(`S-02.01-01 取证失败：${describeError(err).message}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [manifest, registry, securities]);

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
  // 不按 securities.length 早退：`--empty-dataset` 时数据集本就是 0 只，套件要覆盖该空态。
  useEffect(() => {
    if (!isTauriRuntime() || !manifest || !registry) return;
    if (securities.length === 0 && !datasetReady) return;
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
      if (item.id === "M06") {
        labels[item.id] = `MACD(${appliedParams.fast},${appliedParams.slow},${appliedParams.signal})`;
        continue;
      }
      if (item.id === "M01") {
        const period = item.params.find((param) => param.key === "period")?.default;
        labels[item.id] = period !== undefined ? `RSI(${period})` : item.abbr;
        continue;
      }
      labels[item.id] = item.abbr;
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
  // AC-02.01-01：停牌由合成行判定（量/额为 0），涨跌停价按板块规则推导
  const suspended = lastBar ? !(lastBar.volume > 0) : false;
  const limitPrices = deriveLimitPrices(prevBar?.close, security?.board ?? "");
  const limitApprox = showLimitApprox({
    board: security?.board ?? "",
    isIndex: Boolean(security?.isIndex),
    suspended,
    prices: limitPrices,
  });

  const handleApply = () => {
    const issue = localCheck(params);
    if (issue) {
      // 越界值不夹取、不重算：字段自身标红，图上显示「参数无效」角标
      return;
    }
    setError(null);
    lastGoodParamsRef.current = { ...params };
    setParamTimeout(false);
    setAppliedParams({ ...params });
    writeSessionParams(params);
  };

  const handleRestoreDefaults = () => {
    setError(null);
    setParamTimeout(false);
    lastGoodParamsRef.current = defaultParams;
    setParams(defaultParams);
    setAppliedParams(defaultParams);
    writeSessionParams(defaultParams);
  };

  // S-07.01-01（补1）：必需能力有缺口时，工作台入口出现「查看数据源状态」。
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let alive = true;
    void ipc
      .datasourceStatus()
      .then((status) => {
        if (!alive) return;
        setDatasourceIssue(
          status.requiredOk < status.requiredTotal
            ? `${status.requiredOk}/${status.requiredTotal} 必需能力可用`
            : null,
        );
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // S-07.05-03：浮层字段派生（缺失集合 / 允许的质量标记）
  const missingFields = new Set(provData?.missingFields ?? []);
  const flagsText = (provData?.qualityFlags ?? [])
    .filter((flag) => PROVENANCE_FLAGS.includes(flag))
    .join("、");

  return (
    <AppShell active="workbench" onNavigate={onNavigate}>
      <div className="workbench" data-workbench-root="1">
        {datasourceIssue && (
          <div className="watch-error-bar" data-wb-datasource-entry="1" role="alert">
            <span>数据源必需能力不可用（{datasourceIssue}）</span>
            <button type="button" onClick={() => onNavigate("datasource")}>
              查看数据源状态
            </button>
          </div>
        )}
        {watchError && (
          <div className="watch-error-bar" data-wb-watch-error role="alert">
            <span>{watchError}</span>
            <button type="button" onClick={toggleWatch}>
              重试
            </button>
          </div>
        )}
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
            {suspended && (
              <span className="tag tag--warn" data-quote-suspended="1">
                停牌
              </span>
            )}
            <SimBadge />
            <StarButton
              code={activeCode}
              name={security?.name ?? ""}
              watched={watched}
              busy={watchBusy}
              onToggle={toggleWatch}
            />
          </div>

          <div className="quote">
            <span className="last mono">{lastBar ? formatPrice(lastBar.close) : "—"}</span>
            <span className={`chg mono ${changePct >= 0 ? "up" : "down"}`} data-quote-change="1">
              {suspended ? "—" : `${formatSigned(changeAbs)}　${formatPct(changePct)}`}
            </span>
          </div>

          <div className="header-stats" data-quote-head="1" data-quote-code={activeCode}>
            <span>
              开<b>{lastBar ? formatPrice(lastBar.open) : "—"}</b>
            </span>
            <span>
              高<b>{lastBar ? formatPrice(lastBar.high) : "—"}</b>
            </span>
            <span>
              低<b>{lastBar ? formatPrice(lastBar.low) : "—"}</b>
            </span>
            <span data-quote-prev-close="1">
              昨收<b>{prevBar ? formatPrice(prevBar.close) : "—"}</b>
            </span>
            <span data-limit-row="1" data-limit-approx={limitApprox ? "1" : "0"}>
              涨停
              <b
                data-limit-price="up"
                title={limitApprox ? LIMIT_APPROX_TITLE : undefined}
              >
                {limitApprox && limitPrices ? `≈${formatPrice(limitPrices.up)}` : "—"}
              </b>
              跌停
              <b
                data-limit-price="down"
                title={limitApprox ? LIMIT_APPROX_TITLE : undefined}
              >
                {limitApprox && limitPrices ? `≈${formatPrice(limitPrices.down)}` : "—"}
              </b>
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
            datasetReady={datasetReady}
            onRegenerate={async () => {
              try {
                const items = await ipc.datasetRegenerate();
                setSecurities(items);
                setDatasetReady(true);
                window.dispatchEvent(new Event("aka:watchlist-refresh"));
              } catch (err) {
                setError(describeError(err));
              }
            }}
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
                    data-timeframe={mode}
                    title={`${label}线`}
                    onClick={() => {
                      switchStartRef.current = { at: performance.now(), kind: "period" };
                      setTimeframe(mode);
                    }}
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
                    data-adj-mode={mode}
                    onClick={() => {
                      switchStartRef.current = { at: performance.now(), kind: "adj" };
                      setAdj(mode);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <span className="caption">显示</span>
              <div className="seg">
                {RANGES.map((item) => {
                  const total = bars?.bars.length ?? 0;
                  const count = viewport ? viewport.end - viewport.start + 1 : 0;
                  const pressed =
                    total > 0 && (item.value === 9999 ? count >= total : count === item.value);
                  return (
                    <button
                      key={item.value}
                      type="button"
                      aria-pressed={pressed}
                      onClick={() => {
                        if (!bars || bars.bars.length === 0) return;
                        const shown =
                          item.value === 9999
                            ? bars.bars.length
                            : Math.min(item.value, bars.bars.length);
                        setViewport({ start: bars.bars.length - shown, end: bars.bars.length - 1 });
                      }}
                    >
                      {item.label}
                    </button>
                  );
                })}
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
                data-overlay-count={overlayIds.length}
                multiple
                size={3}
                value={overlayIds}
                title={
                  overlayIds.length >= MAX_MAIN_OVERLAYS
                    ? `主图最多 ${MAX_MAIN_OVERLAYS} 个叠加，请先移除一个`
                    : undefined
                }
                onChange={(event) =>
                  setOverlayIds(
                    Array.from(event.target.selectedOptions, (option) => option.value).slice(
                      0,
                      MAX_MAIN_OVERLAYS,
                    ),
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
                  updateSubIds(picked.slice(0, MAX_SUBPLOTS - 1));
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

            {error && (
              <div className="calc-error" data-calc-error={error.code} role="alert">
                <div className="calc-error-head">
                  <strong data-calc-error-title>
                    {CALC_ERROR_TITLES[error.code] ?? "计算失败"}
                  </strong>
                  <code className="qa-code" data-calc-error-code>
                    {error.code}
                  </code>
                  {calcErrorMeta(error).traceId && (
                    <span className="calc-error-trace" data-calc-error-trace>
                      trace {calcErrorMeta(error).traceId}
                    </span>
                  )}
                  {calcErrorMeta(error).elapsedMs !== null && (
                    <span className="calc-error-elapsed" data-calc-error-elapsed>
                      耗时 {calcErrorMeta(error).elapsedMs} ms
                    </span>
                  )}
                </div>
                <p className="calc-error-message">{error.message}</p>
                <div className="calc-error-actions">
                  <button type="button" data-calc-retry onClick={retryCalc}>
                    重试
                  </button>
                  <button type="button" data-calc-reduce onClick={reduceCalcParams}>
                    降低参数
                  </button>
                  {error.code === "E_DATA_UNAVAILABLE" && (
                    <button type="button" data-calc-goto-ds onClick={() => onNavigate("datasource")}>
                      查看数据源状态
                    </button>
                  )}
                  {failureStreak >= 3 && (
                    <button type="button" data-calc-export onClick={() => void exportCalcDiagnostics()}>
                      导出诊断包
                    </button>
                  )}
                </div>
                {exportHint && (
                  <p className="calc-error-hint" data-calc-export-hint>
                    {exportHint}
                  </p>
                )}
              </div>
            )}

            <div className="chart-card">
              {paramsIssue && (
                <span
                  className="adj-badge param-badge"
                  data-param-invalid-badge="1"
                  title={paramsIssue}
                >
                  参数无效
                </span>
              )}
              {paramTimeout && (
                <div className="param-timeout" data-param-timeout="1" role="status">
                  计算超时，参数可能过大，已恢复上一组有效参数
                </div>
              )}
              {adj === "none" && (
                <span className="adj-badge" data-adj-badge="none">
                  不复权
                </span>
              )}
              {loading && bars && (
                <div
                  className="chart-mask"
                  data-chart-mask="1"
                  aria-hidden="true"
                />
              )}
              {loading && bars && slowLoading && (
                <div className="chart-skeleton" data-chart-skeleton="1">
                  重算中…
                </div>
              )}
              {bars ? (
                <>
                  <ChartCrashBoundary>
                  <CandleChart
                    bars={bars.bars}
                    series={calc?.series ?? []}
                    viewport={
                      viewport ?? { start: Math.max(0, bars.bars.length - 120), end: bars.bars.length - 1 }
                    }
                    onViewportChange={setViewport}
                    overlayIds={overlayIds}
                    subPlots={subPlots}
                    onSubPlotsChange={commitSubPlots}
                    subNotices={calcNotices ?? undefined}
                    subLabels={subLabels}
                    units={units}
                    adjMode={adj}
                    onOpenIndicatorDetail={(indicatorId) => {
                      // S-03.03-02：图例「?」进入 P4，返回仍回工作台并保留副图/缩放
                      window.location.hash = `#/catalog/${encodeURIComponent(indicatorId)}?from=chart&code=${encodeURIComponent(activeCode)}`;
                    }}
                    onCandleClick={openProvenance}
                  />
                  <IndicatorReadouts
                    series={calc?.series ?? []}
                    barCount={bars.bars.length}
                    overlayIds={overlayIds}
                    subIds={subIds}
                    subCount={subPlots.length}
                    units={units}
                  />
                  {provSel && (
                    <div
                      className="prov-overlay"
                      data-provenance="1"
                      data-provenance-date={provSel.date}
                      role="dialog"
                      aria-label="K 线溯源"
                    >
                      <div className="prov-overlay__head">
                        <span>K 线溯源 · {provSel.date}</span>
                        <button
                          type="button"
                          className="prov-overlay__close"
                          data-provenance-close="1"
                          aria-label="关闭溯源浮层"
                          onClick={closeProvenance}
                        >
                          ×
                        </button>
                      </div>
                      {provLoading && <div className="prov-overlay__hint">读取中…</div>}
                      {provError && (
                        <div className="prov-overlay__hint" data-provenance-error="1">
                          读取失败：{provError}
                        </div>
                      )}
                      {provData && (
                        <dl className="prov-overlay__list">
                          <div>
                            <dt>provider</dt>
                            <dd data-prov-field="provider">
                              {provText(provData.provider, missingFields, "provider")}
                            </dd>
                          </div>
                          <div>
                            <dt>batch_id</dt>
                            <dd data-prov-field="batchId">
                              {provText(provData.batchId, missingFields, "batchId")}
                            </dd>
                          </div>
                          <div>
                            <dt>ingested_at</dt>
                            <dd data-prov-field="ingestedAt">
                              {provTime(provData.ingestedAt, missingFields)}
                            </dd>
                          </div>
                          <div>
                            <dt>dataset_id</dt>
                            <dd data-prov-field="datasetId">
                              {provText(provData.datasetId, missingFields, "datasetId")}
                            </dd>
                          </div>
                          <div>
                            <dt>adj_mode</dt>
                            <dd data-prov-field="adjMode">
                              {provText(provData.adjMode, missingFields, "adjMode")}
                            </dd>
                          </div>
                          <div>
                            <dt>quality_flags</dt>
                            <dd data-prov-field="qualityFlags">
                              {flagsText || "无"}
                            </dd>
                          </div>
                        </dl>
                      )}
                      {provData && provData.errorCode && (
                        <div className="prov-overlay__hint" data-provenance-missing="1">
                          {provData.errorCode}
                        </div>
                      )}
                    </div>
                  )}
                  </ChartCrashBoundary>
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
                      行情未加载
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
                subCount={subPlots.length}
                hasTarget={Boolean(security)}
                activeCode={activeCode}
                onAddMain={(id) =>
                  setOverlayIds((prev) =>
                    prev.includes(id) || prev.length >= MAX_MAIN_OVERLAYS
                      ? prev
                      : [...prev, id],
                  )
                }
                onAddSub={(id) => {
                  if (subPlots.some((item) => item.id === id) || subPlots.length >= MAX_SUBPLOTS) {
                    return;
                  }
                  commitSubPlots([...subPlots, { id, height: SUB_HEIGHT_DEFAULT }]);
                }}
                onClose={closeDrawer}
              />
            )}
          </main>

          {/* E_PARAM_ORDER 不能被吞：错误码必须传下去，由 ParamPanel 落到快线/慢线红框 + 顺序提示 */}
          <ParamPanel
            registry={registry}
            params={params}
            onChange={setParams}
            onApply={handleApply}
            onRestore={handleRestoreDefaults}
            isDefault={sameParams(params, defaultParams)}
            busy={loading}
            error={
              error?.code === "E_PARAM_OUT_OF_RANGE" ||
              error?.code === "E_INVALID_ARGUMENT" ||
              error?.code === "E_PARAM_ORDER"
                ? error.message
                : null
            }
            errorCode={error?.code ?? null}
            computedMs={calc?.computedMs ?? null}
            cacheHit={calc?.cacheHit ?? null}
          />
        </div>

        <footer className="status dataset-status" data-dataset-overview="1">
          {datasetFooter.map((segment) =>
            segment.key === "version" ? (
              <button
                key={segment.key}
                type="button"
                className="dataset-seg dataset-seg--sha mono"
                data-dataset-seg={segment.key}
                data-dataset-missing={segment.missing ? "1" : "0"}
                title={
                  segment.missing
                    ? "manifest 字段缺失"
                    : segment.pending
                      ? "正在读取数据集清单"
                      : `数据集 ${datasetManifest?.datasetId ?? ""} · 点击复制完整 sha256`
                }
                disabled={segment.missing || segment.pending}
                onClick={copyDatasetSha}
              >
                {segment.text}
              </button>
            ) : (
              <span
                key={segment.key}
                className={segment.key === "calc" ? "dataset-seg mono" : "dataset-seg"}
                data-dataset-seg={segment.key}
                data-dataset-missing={segment.missing ? "1" : "0"}
                title={
                  segment.missing
                    ? segment.key === "calc"
                      ? "计算未产出结果"
                      : "manifest 字段缺失"
                    : segment.pending
                      ? "正在读取数据集清单"
                      : segment.label
                }
              >
                {segment.text}
              </span>
            ),
          )}
          {shaCopied && (
            <span className="dataset-copied" data-sha-copied="1" role="status">
              已复制
            </span>
          )}
          {diagStatus && <span className="diag-status">{diagStatus}</span>}
        </footer>
      </div>
    </AppShell>
  );
}
