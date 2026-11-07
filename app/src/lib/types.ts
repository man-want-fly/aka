// 与 Rust DTO 字段一一对应（camelCase）；改字段必须两边同时改。

export type Category =
  | "trend"
  | "momentum"
  | "volatility"
  | "volume"
  | "stat"
  | "breadth";

export type SpecStatus = "manualComplete" | "partial" | "productDefined";
export type OutputKind = "line" | "histogram" | "dot";

export type ParamSpec =
  | {
      kind: "int";
      key: string;
      label: string;
      min: number;
      max: number;
      default: number;
      step: number;
    }
  | {
      kind: "float";
      key: string;
      label: string;
      min: number;
      max: number;
      default: number;
      step: number;
      unit: string | null;
    }
  | {
      kind: "enum";
      key: string;
      label: string;
      variants: string[];
      default: string;
    }
  | { kind: "bool"; key: string; label: string; default: boolean };

export interface ParamValueMap {
  [key: string]: string | number | boolean;
}

export interface OutputSpecDto {
  key: string;
  labelZh: string;
  kind: OutputKind;
  color: string;
}

export interface InputsDto {
  open: boolean;
  high: boolean;
  low: boolean;
  close: boolean;
  volume: boolean;
  amount: boolean;
}

export interface IndicatorMetaDto {
  id: string;
  nameZh: string;
  nameEn: string;
  category: Category;
  params: ParamSpec[];
  outputs: OutputSpecDto[];
  inputs: InputsDto;
  specStatus: SpecStatus;
  engineVersion: number;
  unit: string;
  notes: string;
  warmup: number;
  implemented: boolean;
}

export interface RegistryResponse {
  /** 目录规划总量（含已实现），不是 status=planned 的条数 */
  catalogTotal: number;
  implementedCount: number;
  indicators: IndicatorMetaDto[];
}

/** manifest 参数：字段名是 `label`（与运行期 ParamSpec 的 label 一致） */
export type ManifestParam =
  | { kind: "int"; key: string; label: string; min: number; max: number; default: number; step: number }
  | {
      kind: "float";
      key: string;
      label: string;
      min: number;
      max: number;
      default: number;
      step: number;
      unit: string | null;
    }
  | { kind: "enum"; key: string; label: string; variants: string[]; default: string }
  | { kind: "bool"; key: string; label: string; default: boolean };

export interface ManifestIndicatorDto {
  id: string;
  prdId: string;
  aliases: string[];
  nameZh: string;
  nameEn: string;
  abbr: string;
  pinyinInitials: string;
  /** 中文名全拼，用于 `junxian` 这类整词拼音搜索 */
  pinyinFull: string;
  category: Category;
  inputs: InputsDto;
  params: ManifestParam[];
  outputs: OutputSpecDto[];
  formulaRef: string;
  version: number;
  specStatus: SpecStatus;
  status: "normal" | "beta" | "planned";
  unit: string;
  notes: string;
  /** 面板归属：主 / 副 */
  panel: string;
  formulaSummary: string;
  priority: "P0" | "P1";
  warmupBars: number;
  /** PRD 附录 A 完备度：完整 / 部分 / beta */
  completeness: "完整" | "部分" | "beta";
  /** 本产品补全口径（T03、M24、F04、F10、F12、F16） */
  isCompletion: boolean;
  /** PRD 附录 A 的默认参数展示文本（如 `12 / 26 / 9`） */
  defaultParamsText: string;
}

/** 指标目录的单一事实来源；前端指标列表一律由它生成。 */
export interface ManifestResponse {
  schemaVersion: number;
  /** 目录规划总量（含已实现）；status=planned 的条数需要按 indicators 自行统计 */
  catalogTotal: number;
  /** 缓存键维度（七元组：后三项固定为 indicatorId、params、dateRange） */
  cacheKey: string[];
  indicators: ManifestIndicatorDto[];
}

export interface SecurityDto {
  code: string;
  name: string;
  market: "SH" | "SZ";
  board: string;
  isIndex: boolean;
  basePrice: number;
}

export interface BarDto {
  ts: number;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
  /** 复权因子：1.0 = 不复权原始价（S-02.07-02 除权日 tooltip 口径用）；后端 serde camelCase */
  adjFactor: number;
  source: string;
  quality: string[];
}

export interface ProvenanceDto {
  provider: string;
  datasetId: string;
  dataVersion: string;
  /** 数据集代次：data_version v<N> → N，用于前端识别数据代次切换 */
  datasetGeneration: number;
  simulated: boolean;
  generatedAt: number;
}

export interface RangeDto {
  requestedFrom: string | null;
  requestedTo: string | null;
  /** 实际命中的第一根 K 线日期 */
  returnedFrom: string | null;
  /** 实际命中的最后一根 K 线日期 */
  returnedTo: string | null;
  barCount: number;
  /** 请求区间被数据集边界吸附/截断时为 true */
  clamped: boolean;
}

export interface BarsResponse {
  security: string;
  timeframe: string;
  adj: string;
  datasetId: string;
  totalBars: number;
  bars: BarDto[];
  range: RangeDto;
  provenance: ProvenanceDto;
}

/** 数据集 manifest（S-02.08-01 页脚 7 段的唯一来源） */
export interface DatasetManifestDto {
  datasetId: string;
  dataVersion: string;
  rowCount: number;
  coverageStart: string;
  coverageEnd: string;
  seed: number;
  sha256: string;
  provider: string;
  generatedAt: number;
}

export interface GetBarsRequest {
  security: string;
  timeframe: "D" | "W" | "M";
  adj: "none" | "qfq" | "hfq";
  /** 起始日期（含），YYYY-MM-DD；缺省 = 数据集起点 */
  from?: string;
  /** 结束日期（含），YYYY-MM-DD；缺省 = 数据集末尾 */
  to?: string;
}

export interface InstanceRequest {
  instanceId: string;
  indicatorId: string;
  params: ParamValueMap;
}

export interface CalcRequest {
  security: string;
  timeframe: "D" | "W" | "M";
  adj: "none" | "qfq" | "hfq";
  from?: string;
  to?: string;
  generation: number;
  instances: InstanceRequest[];
}

export interface OutputSeriesDto {
  key: string;
  labelZh: string;
  kind: OutputKind;
  color: string;
  values: (number | null)[];
}

export interface SeriesDto {
  instanceId: string;
  indicatorId: string;
  outputs: OutputSeriesDto[];
  warmup: number;
  engineVersion: number;
}

export interface CalcResponse {
  generation: number;
  datasetId: string;
  /** 数据集代次，与 provenance.datasetGeneration 同源 */
  datasetGeneration: number;
  engineVersion: string;
  computedMs: number;
  cacheHit: boolean;
  barCount: number;
  range: RangeDto;
  series: SeriesDto[];
}

export interface AppError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface TelemetryEventDto {
  tsMs: number;
  name: string;
  fields: Record<string, unknown>;
}

export interface TelemetrySummary {
  path: string | null;
  total: number;
  counts: Record<string, number>;
  coldSamples: number;
  coldP95Ms: number | null;
  recent: TelemetryEventDto[];
}

// ---------- E-01 行情 / 自选 / 持仓 ----------

/** 取证留档构建元数据（口径 R-S0-07-01） */
export interface DiagBuildInfo {
  buildProfile: "dev" | "release";
  optLevel: string;
  lto: string;
  codegenUnits: string;
  debug: string;
  targetTriple: string;
}

/** QA 故障注入开关（仅 `AKA_DIAG=1` 启动时可信） */
export interface DiagFaultsDto {
  datasetEmpty: boolean;
  corruptDb: boolean;
  readOnlyDb: boolean;
}

export interface MarketRowDto {
  security: string;
  code: string;
  name: string;
  market: string;
  board: string;
  isIndex: boolean;
  suspended: boolean;
  lastPrice: number | null;
  prevClose: number | null;
  changeAbs: number | null;
  changePct: number | null;
  volume: number | null;
  amount: number | null;
  turnoverPct: number | null;
  volumeRatio: number | null;
  amplitudePct: number | null;
  flags: string[];
  dataIssue: boolean;
}

export interface MarketSnapshotDto {
  sampleCount: number;
  dataDate: string;
  /** 数据集 manifest `coverage_start`（与 dataDate 独立来源） */
  coverageStart: string;
  /** 数据集 manifest `coverage_end`（数据集最后交易日） */
  coverageEnd: string;
  provider: string;
  datasetId: string;
  dataVersion: string;
  datasetGeneration: number;
  simulated: boolean;
  generatedAt: number;
  rows: MarketRowDto[];
}

export interface WatchGroupDto {
  name: string;
  count: number;
  sortOrder: number;
  isBuiltin: boolean;
}

export interface WatchItemDto {
  security: string;
  /** null = 未分组 */
  groupName: string | null;
  sortOrder: number;
}

export interface WatchlistDto {
  limit: number;
  total: number;
  groups: WatchGroupDto[];
  items: WatchItemDto[];
}

export interface WatchToggleResult {
  watched: boolean;
  total: number;
}

export interface PositionDto {
  security: string;
  costPrice: number;
  shares: number;
  updatedAt: number;
}
