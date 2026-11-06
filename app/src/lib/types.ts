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
  warmup: number;
  implemented: boolean;
}

export interface RegistryResponse {
  plannedCount: number;
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
  category: Category;
  inputs: InputsDto;
  params: ManifestParam[];
  outputs: OutputSpecDto[];
  formulaRef: string;
  version: number;
  specStatus: SpecStatus;
  status: "normal" | "beta";
}

/** 指标目录的单一事实来源；前端指标列表一律由它生成。 */
export interface ManifestResponse {
  schemaVersion: number;
  plannedCount: number;
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
  source: string;
  quality: string[];
}

export interface ProvenanceDto {
  provider: string;
  datasetId: string;
  dataVersion: string;
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
