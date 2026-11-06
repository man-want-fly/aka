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
  return [
    {
      instanceId: "main-ma",
      indicatorId: "ma",
      params: { period: params.maPeriod, maType: params.maType },
    },
    {
      instanceId: "sub-macd",
      indicatorId: "macd",
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
