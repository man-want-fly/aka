import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type {
  AppError,
  BarProvenanceDto,
  BarProvenanceRequest,
  BarsResponse,
  CalcRequest,
  CalcResponse,
  DatasetIntegrityDto,
  DatasetManifestDto,
  DataHealthDto,
  DatasourceStatusDto,
  DiagnosticsConfigSnapshot,
  DiagnosticsExportDto,
  DiagBuildInfo,
  DiagEnvDto,
  DiagFaultsDto,
  GetBarsRequest,
  IndexSnapshotDto,
  IndicatorFavoritesResponse,
  ManifestResponse,
  MarketSnapshotDto,
  PositionDto,
  QualityReportDto,
  RecentViewDto,
  RegistryResponse,
  SecurityDto,
  SimInstallReportDto,
  SimInstallStatusDto,
  TelemetrySummary,
  WatchToggleResult,
  WatchlistDto,
} from "./types";

export const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** AC-DF-05-02-3：未归类 panic 归一为 internal，且不得把堆栈路径/回溯标记抛到 UI。 */
const STACK_MARKERS = ["panicked at", "stack backtrace", ".rs:", "RUST_BACKTRACE"];

function uiSafeMessage(raw: string): string {
  return STACK_MARKERS.some((marker) => raw.includes(marker)) ? "内部错误，请稍后重试" : raw;
}

export function describeError(error: unknown): AppError {
  if (error && typeof error === "object") {
    const candidate = error as Partial<AppError>;
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return {
        code: candidate.code,
        message: uiSafeMessage(candidate.message),
        retryable: Boolean(candidate.retryable),
        // AC-DF-05-02-1/6：四字段齐全，details 无内容统一为 null。
        details: candidate.details ?? null,
      };
    }
    if ("message" in error && typeof (error as Error).message === "string") {
      return {
        code: "E_INTERNAL",
        message: uiSafeMessage((error as Error).message),
        retryable: false,
        details: null,
      };
    }
  }
  return {
    code: "E_INTERNAL",
    message: uiSafeMessage(String(error)),
    retryable: false,
    details: null,
  };
}

/** 取证专用旁路：只记录命令名，不改变 invoke 行为；业务代码不得使用（默认 null 即零开销）。 */
let invokeAudit: ((command: string) => void) | null = null;

/** 只读监听 invoke，用于「点击窗口内无新增 IPC」类断言；不得包装/改写 Tauri 注入对象。 */
export function setInvokeAudit(listener: ((command: string) => void) | null): void {
  invokeAudit = listener;
}

export interface InvokeDelayConfig {
  command: string;
  ms: number;
  /** 只延迟 req.code 匹配的命令（用于「旧响应晚到」取证） */
  code?: string;
  /** 一次性：命中后立即失效 */
  once?: boolean;
}

/**
 * 取证专用旁路：给指定命令注入一次性延迟，用于复现「旧响应晚到/加载中」。
 * 只延迟、不改写返回值；业务代码不设置时为零开销。
 * persist=true 写入 sessionStorage，跨页面刷新仍生效（刷新类取证用）。
 */
const DELAY_KEY = "aka.diag.invokeDelay";
let invokeDelay: InvokeDelayConfig | null = null;

export function setInvokeDelay(config: InvokeDelayConfig | null, persist = false): void {
  invokeDelay = config;
  try {
    if (persist) {
      if (config) window.sessionStorage.setItem(DELAY_KEY, JSON.stringify(config));
      else window.sessionStorage.removeItem(DELAY_KEY);
    }
  } catch {
    /* 存储不可用时只影响跨刷新生效 */
  }
}

function pendingDelay(command: string, args?: Record<string, unknown>): number {
  let config = invokeDelay;
  if (!config) {
    try {
      const raw = window.sessionStorage.getItem(DELAY_KEY);
      if (raw) config = JSON.parse(raw) as InvokeDelayConfig;
    } catch {
      config = null;
    }
  }
  if (!config || config.command !== command) return 0;
  if (config.code) {
    // 取数/计算请求的标的字段是 req.security；部分命令（如 diag）用 code
    const req = (args as { req?: { code?: unknown; security?: unknown } } | undefined)?.req;
    const target = req?.code ?? req?.security;
    if (!req || target !== config.code) return 0;
  }
  if (config.once) {
    invokeDelay = null;
    try {
      window.sessionStorage.removeItem(DELAY_KEY);
    } catch {
      /* 同上 */
    }
  }
  return Math.max(0, config.ms);
}

const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
  invokeAudit?.(command);
  const delayMs = pendingDelay(command, args);
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  return tauriInvoke<T>(command, args);
};

/** 前端唯一允许调用 Tauri 命令的出口。页面与组件禁止直接 import invoke。 */
export const ipc = {
  // 不传 limit = 取 provider 全量代码表（后端按 securities.len() 截断，等价于不截断）
  listSecurities: (limit?: number): Promise<SecurityDto[]> =>
    invoke<SecurityDto[]>("list_securities", {
      req: limit === undefined ? { market: "ALL" } : { market: "ALL", limit },
    }),

  getBars: (req: GetBarsRequest): Promise<BarsResponse> =>
    invoke<BarsResponse>("get_bars", { req }),

  indicatorRegistry: (category?: string): Promise<RegistryResponse> =>
    invoke<RegistryResponse>("indicator_registry", {
      req: { category: category ?? null },
    }),

  /** 指标目录唯一事实来源；生成指标列表/参数面板应优先用它。 */
  indicatorManifest: (): Promise<ManifestResponse> =>
    invoke<ManifestResponse>("indicator_manifest"),

  /** S-03.02-01：首装首次读取写入默认 8 个收藏，后续读取幂等。 */
  indicatorFavorites: (): Promise<IndicatorFavoritesResponse> =>
    invoke<IndicatorFavoritesResponse>("indicator_favorites"),

  /** S-03.02-01：收藏/取消收藏，返回最新完整列表。 */
  setIndicatorFavorite: (
    indicatorId: string,
    favorited: boolean,
  ): Promise<IndicatorFavoritesResponse> =>
    invoke<IndicatorFavoritesResponse>("set_indicator_favorite", {
      indicatorId,
      favorited,
    }),

  /** S-05.01-02：最近查看（最多 5 条）；读取时清理数据集里已不存在的记录。 */
  recentViews: (): Promise<RecentViewDto[]> => invoke<RecentViewDto[]>("recent_views"),

  /** S-05.01-02：工作台打开标的时写入/刷新，返回裁剪后的最新 5 条。 */
  touchRecentView: (code: string): Promise<RecentViewDto[]> =>
    invoke<RecentViewDto[]>("touch_recent_view", { code }),

  /** S-02.08-01：数据集 manifest；provider 不提供时返回 null。 */
  datasetManifest: (): Promise<DatasetManifestDto | null> =>
    invoke<DatasetManifestDto | null>("dataset_manifest"),

  /** S-07.01-01：P9 数据源状态；每次手动「重新检查」重新探测。 */
  datasourceStatus: (): Promise<DatasourceStatusDto> =>
    invoke<DatasourceStatusDto>("datasource_status"),

  /** S-07.01-02：P9 健康检查 6 项；每次点击都重跑，无轮询。 */
  dataHealthCheck: (): Promise<DataHealthDto> =>
    invoke<DataHealthDto>("data_health_check"),

  /** S-08.02-03：启动数据集校验；blocked 时前端只渲染全屏错误卡。 */
  datasetIntegrity: (): Promise<DatasetIntegrityDto> =>
    invoke<DatasetIntegrityDto>("dataset_integrity"),

  /** S-08.02-03：进入/退出只读浏览（后端内存态，不写 state.db）。 */
  datasetSetReadonly: (readOnly: boolean): Promise<boolean> =>
    invoke<boolean>("dataset_set_readonly", { readOnly }),

  /** S-07.05-01：最近一次质量报告；从未扫描过返回 null。 */
  qualityReport: (): Promise<QualityReportDto | null> =>
    invoke<QualityReportDto | null>("quality_report"),

  qualityScan: (): Promise<QualityReportDto> => invoke<QualityReportDto>("quality_scan"),

  /** S-07.05-02：单根 K 线溯源（S-07.05-03 浮层复用此 IPC，不新增命令） */
  barProvenance: (req: BarProvenanceRequest): Promise<BarProvenanceDto> =>
    invoke<BarProvenanceDto>("bar_provenance", { req }),

  calcIndicators: (req: CalcRequest): Promise<CalcResponse> =>
    invoke<CalcResponse>("calc_indicators", { req }),

  telemetryDump: (recent = 200): Promise<TelemetrySummary> =>
    invoke<TelemetrySummary>("telemetry_dump", { recent }),

  diagEnabled: (): Promise<boolean> => invoke<boolean>("diag_enabled"),

  /** 取证落地页：`s2` = 启动直接进工作台，跑 release 性能线。 */
  diagTarget: (): Promise<string> => invoke<string>("diag_target"),

  /** QA 故障注入开关：`--empty-dataset` / `--corrupt-db` / `--readonly-db` */
  diagFaults: (): Promise<DiagFaultsDto> => invoke<DiagFaultsDto>("diag_faults"),

  diagBuildInfo: (): Promise<DiagBuildInfo> => invoke<DiagBuildInfo>("diag_build_info"),

  /** R-EV-02：运行环境（os/arch/二进制路径与 sha256/dump 目录），仅 debug 构建注册。 */
  diagEnv: (): Promise<DiagEnvDto> => invoke<DiagEnvDto>("diag_env"),

  diagWrite: (payload: string): Promise<string> =>
    invoke<string>("diag_write", { payload }),

  diagWriteNamed: (name: string, payload: string): Promise<string> =>
    invoke<string>("diag_write_named", { name, payload }),

  /** S-06.03-02：一键导出诊断包（后端强制白名单与隐私排除，0 网络）。 */
  exportDiagnostics: (config: DiagnosticsConfigSnapshot): Promise<DiagnosticsExportDto> =>
    invoke<DiagnosticsExportDto>("export_diagnostics", { config }),

  /** S-08.02-02：设置下一次计算的故障注入（仅 debug + AKA_DIAG=1）。 */
  diagSetInject: (kind: string): Promise<string> =>
    invoke<string>("diag_set_inject", { kind }),

  revealDiagnostics: (path: string): Promise<void> =>
    invoke<void>("reveal_diagnostics", { path }),

  /** S-02.02-02：前端写入运行日志（如 switch.period_ms），落 telemetry.jsonl */
  telemetryNote: (name: string, fields?: Record<string, unknown>): Promise<void> =>
    invoke<void>("telemetry_note", { name, fields: fields ?? {} }),

  marketSnapshot: (): Promise<MarketSnapshotDto> => invoke<MarketSnapshotDto>("market_snapshot"),

  /** S-04.01-01：指数概览快照（独立只读命令） */
  indexSnapshot: (): Promise<IndexSnapshotDto> => invoke<IndexSnapshotDto>("index_snapshot"),

  watchlist: (): Promise<WatchlistDto> => invoke<WatchlistDto>("watchlist_read"),

  toggleWatch: (security: string, group?: string): Promise<WatchToggleResult> =>
    invoke<WatchToggleResult>("watch_toggle", { security, group: group ?? null }),

  createWatchGroup: (name: string): Promise<void> =>
    invoke<void>("watch_group_create", { name }),

  renameWatchGroup: (oldName: string, newName: string): Promise<void> =>
    invoke<void>("watch_group_rename", { old: oldName, new: newName }),

  deleteWatchGroup: (name: string): Promise<void> =>
    invoke<void>("watch_group_delete", { name }),

  /** S-01.02-03 补2：空态页动作「重新生成模拟数据」 */
  datasetRegenerate: (): Promise<SecurityDto[]> =>
    invoke<SecurityDto[]>("dataset_regenerate", { req: {} }),

  /** S-01.02-03 补3：损坏库错误页动作「重新生成数据」 */
  storageRebuild: (): Promise<void> => invoke<void>("storage_rebuild"),

  viewStateGet: (scope: string): Promise<unknown | null> =>
    invoke<unknown | null>("view_state_get", { scope }),

  viewStateSet: (scope: string, value: unknown): Promise<void> =>
    invoke<void>("view_state_set", { scope, value }),

  positions: (): Promise<PositionDto[]> => invoke<PositionDto[]>("positions_read"),

  savePosition: (security: string, costPrice: number, shares: number): Promise<void> =>
    invoke<void>("position_save", { security, costPrice, shares }),

  deletePosition: (security: string): Promise<void> =>
    invoke<void>("position_delete", { security }),

  /** S-07.03-01：P10 首装状态（读取 `.installing` / install-report，不做重活）。 */
  simInstallStatus: (): Promise<SimInstallStatusDto> =>
    invoke<SimInstallStatusDto>("sim_install_status"),

  /** S-07.03-01：启动/续装，返回已落哨兵的当前状态；进度由 P10 轮询。 */
  simInstallStart: (): Promise<SimInstallStatusDto> =>
    invoke<SimInstallStatusDto>("sim_install_start"),

  /** S-07.03-01：删除旧 seed 目录后重建，data_version +1。 */
  simInstallRebuild: (): Promise<SimInstallStatusDto> =>
    invoke<SimInstallStatusDto>("sim_install_rebuild"),

  simInstallReport: (): Promise<SimInstallReportDto | null> =>
    invoke<SimInstallReportDto | null>("sim_install_report"),
};
