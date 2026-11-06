import manifestJson from "../../../manifest/indicators.json";
import type { InstanceRequest, ParamSpec } from "../../lib/types";

export interface WorkbenchParams {
  maPeriod: number;
  maType: "sma" | "ema" | "wma";
  fast: number;
  slow: number;
  signal: number;
}

const PARAMS_STORAGE_KEY = "aka.workbench.params.v1";

/** 默认参数只从 manifest 的 ParamSpec 读取，前端不再保存第二份数字。 */
export function defaultsFromIndicators(
  indicators: Array<{ id: string; params: ParamSpec[] }>,
): WorkbenchParams {
  const intDefault = (id: string, key: string) => {
    const param = indicators.find((item) => item.id === id)?.params.find((spec) => spec.key === key);
    if (!param || param.kind !== "int") {
      throw new Error(`manifest 缺少 ${id}.${key} 的整数默认值`);
    }
    return param.default;
  };
  return {
    maPeriod: intDefault("T01", "period"),
    maType: "sma",
    fast: intDefault("M06", "fast"),
    slow: intDefault("M06", "slow"),
    signal: intDefault("M06", "signal"),
  };
}

export const DEFAULT_PARAMS: WorkbenchParams = defaultsFromIndicators(
  manifestJson.indicators as Array<{ id: string; params: ParamSpec[] }>,
);

const isInt = (value: unknown): value is number => Number.isInteger(value);

/** 会话记忆：只存在于当前应用会话，重启回到 manifest 默认值。 */
export function readSessionParams(): WorkbenchParams | null {
  try {
    const raw = window.sessionStorage.getItem(PARAMS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WorkbenchParams>;
    if (
      !isInt(parsed.maPeriod) ||
      !isInt(parsed.fast) ||
      !isInt(parsed.slow) ||
      !isInt(parsed.signal) ||
      !["sma", "ema", "wma"].includes(parsed.maType ?? "")
    ) {
      return null;
    }
    return parsed as WorkbenchParams;
  } catch {
    return null;
  }
}

export function writeSessionParams(params: WorkbenchParams) {
  try {
    window.sessionStorage.setItem(PARAMS_STORAGE_KEY, JSON.stringify(params));
  } catch {
    // 存储不可用时退化为仅内存态，不影响参数应用
  }
}

export function sameParams(a: WorkbenchParams, b: WorkbenchParams) {
  return (
    a.maPeriod === b.maPeriod &&
    a.maType === b.maType &&
    a.fast === b.fast &&
    a.slow === b.slow &&
    a.signal === b.signal
  );
}

/** B2 主图叠加候选（11 个面板=主图的指标）。 */
export const B2_OVERLAY_CHOICES: Array<{ id: string; label: string }> = [
  { id: "T08", label: "T08 Envelopes" },
  { id: "T09", label: "T09 BOLL" },
  { id: "T10", label: "T10 Keltner" },
  { id: "T11", label: "T11 Donchian" },
  { id: "T12", label: "T12 ATR Bands" },
  { id: "T13", label: "T13 ATR Trail" },
  { id: "T14", label: "T14 Chandelier" },
  { id: "T15", label: "T15 Ichimoku" },
  { id: "T16", label: "T16 PSAR（beta）" },
  { id: "T23", label: "T23 Pivot" },
  { id: "T24", label: "T24 HHV/LLV" },
];

/** B2 副图候选（9 个波动指标）+ 既有 MACD。 */
export const B2_SUB_CHOICES: Array<{ id: string; label: string }> = [
  { id: "M06", label: "M06 MACD" },
  { id: "V01", label: "V01 ATR" },
  { id: "V02", label: "V02 ATRP" },
  { id: "V03", label: "V03 StdDev" },
  { id: "V04", label: "V04 BB Width" },
  { id: "V05", label: "V05 %B" },
  { id: "V07", label: "V07 Ulcer" },
  { id: "V08", label: "V08 GAPO" },
  { id: "V09", label: "V09 振幅" },
  { id: "V10", label: "V10 TR" },
];

/** B3 副图候选（13 个动量/摆动指标；M06 已在 B2 副图清单）。Q-01~Q-04 已裁定，均不再标 beta。 */
export const B3_SUB_CHOICES: Array<{ id: string; label: string }> = [
  { id: "M01", label: "M01 RSI" },
  { id: "M02", label: "M02 KDJ" },
  { id: "M04", label: "M04 %R" },
  { id: "M05", label: "M05 CCI" },
  { id: "M08", label: "M08 PPO" },
  { id: "M09", label: "M09 ROC" },
  { id: "M10", label: "M10 Momentum" },
  { id: "M19", label: "M19 Aroon" },
  { id: "M20", label: "M20 Vortex" },
  { id: "M21", label: "M21 CMO" },
  { id: "M24", label: "M24 Mass Index" },
  { id: "M25", label: "M25 Elder Impulse" },
  { id: "M26", label: "M26 NR7" },
];

export const SUB_CHOICES = [...B2_SUB_CHOICES, ...B3_SUB_CHOICES, { id: "E13", label: "E13 BIAS" }];

/** B1 回归族与 BIAS：AC-03.04-11 / -15 要求自 B2 起可上图（T19/T21 为 beta，带徽标、不进默认）。 */
export const B1_OVERLAY_CHOICES: Array<{ id: string; label: string }> = [
  { id: "T19", label: "T19 回归预测（beta）" },
  { id: "T20", label: "T20 回归截距" },
  { id: "T21", label: "T21 回归 R²（beta）" },
  { id: "T22", label: "T22 回归斜率" },
];

export const DEFAULT_B2_OVERLAYS = ["T09", "T24"];
export const DEFAULT_SUB_ID = "M06";
/** 主图叠加容量（S-02.04-02）：满 2 后需先移除才能加 */
export const MAX_MAIN_OVERLAYS = 2;
/** 副图容量（S-02.04-02）：满 3 后需先移除才能加 */
export const MAX_SUBPLOTS = 3;

const B2_IDS = [
  "T08", "T09", "T10", "T11", "T12", "T13", "T14", "T15", "T16", "T23", "T24",
  "V01", "V02", "V03", "V04", "V05", "V07", "V08", "V09", "V10",
] as const;

const B3_IDS = [
  "M01", "M02", "M04", "M05", "M08", "M09", "M10", "M19", "M20", "M21", "M24", "M25", "M26",
] as const;

/** B1 回归族 + BIAS，补齐 AC-03.04-11 / -15 的上图范围。 */
const B1_CHART_IDS = ["T19", "T20", "T21", "T22", "E13"] as const;

/** 前端只做「表单 → 实例」的装配；范围校验以后端 ParamSpec 为准。 */
export function buildInstances(params: WorkbenchParams): InstanceRequest[] {
  const maId = { sma: "T01", ema: "T02", wma: "T03" }[params.maType];
  return [
    {
      instanceId: "main-ma",
      indicatorId: maId,
      params: { period: params.maPeriod },
    },
    // B1 渲染层证据（TD-B1-02）：T01–T05 图线与 T19–T22 / E13 读数
    ...(["T01", "T02", "T03", "T04", "T05"] as const).map((indicatorId) => ({
      instanceId: `overlay-${indicatorId}`,
      indicatorId,
      params: { period: params.maPeriod },
    })),
    ...(["T19", "T20", "T21", "T22"] as const).map((indicatorId) => ({
      instanceId: `stat-${indicatorId}`,
      indicatorId,
      params: { period: 20 },
    })),
    {
      instanceId: "stat-E13",
      indicatorId: "E13",
      params: { period1: 6, period2: 12, period3: 24 },
    },
    {
      instanceId: "sub-macd",
      indicatorId: "M06",
      params: {
        fast: params.fast,
        slow: params.slow,
        signal: params.signal,
      },
    },
    // B2 全量 20 个：主图叠加与副图选择都在客户端切换，不额外触发 IPC。
    // 参数留空即用 manifest 默认值（与后端 fallback 同源）。
    ...B2_IDS.map((indicatorId) => ({
      instanceId: `b2-${indicatorId}`,
      indicatorId,
      params: {},
    })),
    // B3 全量 13 个：全部为副图候选，参数留空走 manifest 默认值。
    ...B3_IDS.map((indicatorId) => ({
      instanceId: `b3-${indicatorId}`,
      indicatorId,
      params: {},
    })),
    ...B1_CHART_IDS.map((indicatorId) => ({
      instanceId: `b1x-${indicatorId}`,
      indicatorId,
      params: {},
    })),
  ];
}

/** 仅拦截明显非法组合，避免一次无意义的 IPC；真正的边界由 Rust 返回。 */
export function localCheck(params: WorkbenchParams): string | null {
  const pairs: Array<[string, number, number, number]> = [
    ["MA 周期", params.maPeriod, 2, 200],
    ["MACD 快线", params.fast, 2, 200],
    ["MACD 慢线", params.slow, 2, 200],
    ["MACD 信号", params.signal, 2, 200],
  ];
  for (const [label, value, min, max] of pairs) {
    if (!Number.isInteger(value) || value < min || value > max) {
      return `${label}需为 ${min}~${max} 的整数`;
    }
  }
  if (params.fast >= params.slow) {
    return "MACD 快线必须小于慢线";
  }
  return null;
}
