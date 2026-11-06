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
  ];
}

/** 仅拦截明显非法组合，避免一次无意义的 IPC；真正的边界由 Rust 返回。 */
export function localCheck(params: WorkbenchParams): string | null {
  const pairs: Array<[string, number, number, number]> = [
    ["MA 周期", params.maPeriod, 2, 200],
    ["MACD 快线", params.fast, 2, 100],
    ["MACD 慢线", params.slow, 2, 200],
    ["MACD 信号", params.signal, 2, 100],
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
