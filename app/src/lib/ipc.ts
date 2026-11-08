import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type {
  AppError,
  BarProvenanceDto,
  BarProvenanceRequest,
  BarsResponse,
  CalcRequest,
  CalcResponse,
  DatasetManifestDto,
  DatasourceStatusDto,
  DiagBuildInfo,
  DiagEnvDto,
  DiagFaultsDto,
  GetBarsRequest,
  ManifestResponse,
  MarketSnapshotDto,
  PositionDto,
  QualityReportDto,
  RegistryResponse,
  SecurityDto,
  TelemetrySummary,
  WatchToggleResult,
  WatchlistDto,
} from "./types";

export const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function describeError(error: unknown): AppError {
  if (error && typeof error === "object") {
    const candidate = error as Partial<AppError>;
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return {
        code: candidate.code,
        message: candidate.message,
        retryable: Boolean(candidate.retryable),
        details: candidate.details,
      };
    }
    if ("message" in error && typeof (error as Error).message === "string") {
      return {
        code: "E_INTERNAL",
        message: (error as Error).message,
        retryable: false,
      };
    }
  }
  return { code: "E_INTERNAL", message: String(error), retryable: false };
}

/** 取证专用旁路：只记录命令名，不改变 invoke 行为；业务代码不得使用（默认 null 即零开销）。 */
let invokeAudit: ((command: string) => void) | null = null;

/** 只读监听 invoke，用于「点击窗口内无新增 IPC」类断言；不得包装/改写 Tauri 注入对象。 */
export function setInvokeAudit(listener: ((command: string) => void) | null): void {
  invokeAudit = listener;
}

const invoke = <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
  invokeAudit?.(command);
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

  /** S-02.08-01：数据集 manifest；provider 不提供时返回 null。 */
  datasetManifest: (): Promise<DatasetManifestDto | null> =>
    invoke<DatasetManifestDto | null>("dataset_manifest"),

  /** S-07.01-01：P9 数据源状态；每次手动「重新检查」重新探测。 */
  datasourceStatus: (): Promise<DatasourceStatusDto> =>
    invoke<DatasourceStatusDto>("datasource_status"),

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

  /** S-02.02-02：前端写入运行日志（如 switch.period_ms），落 telemetry.jsonl */
  telemetryNote: (name: string, fields?: Record<string, unknown>): Promise<void> =>
    invoke<void>("telemetry_note", { name, fields: fields ?? {} }),

  marketSnapshot: (): Promise<MarketSnapshotDto> => invoke<MarketSnapshotDto>("market_snapshot"),

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
};
