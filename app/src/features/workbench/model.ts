import type { InstanceRequest } from "../../lib/types";

export interface WorkbenchParams {
  maPeriod: number;
  maType: "sma" | "ema" | "wma";
  fast: number;
  slow: number;
  signal: number;
}

export const DEFAULT_PARAMS: WorkbenchParams = {
  maPeriod: 20,
  maType: "sma",
  fast: 12,
  slow: 26,
  signal: 9,
};

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

export const DEFAULT_B2_OVERLAYS = ["T09", "T24"];
export const DEFAULT_SUB_ID = "M06";

const B2_IDS = [
  "T08", "T09", "T10", "T11", "T12", "T13", "T14", "T15", "T16", "T23", "T24",
  "V01", "V02", "V03", "V04", "V05", "V07", "V08", "V09", "V10",
] as const;

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
  ];
}

/** 仅拦截明显非法组合，避免一次无意义的 IPC；真正的边界由 Rust 返回。 */
export function localCheck(params: WorkbenchParams): string | null {
  const pairs: Array<[string, number, number, number]> = [
    ["MA 周期", params.maPeriod, 2, 200],
    ["MACD 快线", params.fast, 2, 100],
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
