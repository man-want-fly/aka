import manifestJson from "../../../manifest/indicators.json";
import type { InstanceRequest, ParamSpec, ParamValueMap } from "../../lib/types";

export interface WorkbenchParams {
  maPeriod: number;
  maType: "sma" | "ema" | "wma";
  fast: number;
  slow: number;
  signal: number;
  bollPeriod: number;
  bollMult: number;
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
  const floatDefault = (id: string, key: string) => {
    const param = indicators.find((item) => item.id === id)?.params.find((spec) => spec.key === key);
    if (!param || param.kind !== "float") {
      throw new Error(`manifest 缺少 ${id}.${key} 的小数默认值`);
    }
    return param.default;
  };
  return {
    maPeriod: intDefault("T01", "period"),
    maType: "sma",
    fast: intDefault("M06", "fast"),
    slow: intDefault("M06", "slow"),
    signal: intDefault("M06", "signal"),
    bollPeriod: intDefault("T09", "period"),
    bollMult: floatDefault("T09", "mult"),
  };
}

export const DEFAULT_PARAMS: WorkbenchParams = defaultsFromIndicators(
  manifestJson.indicators as Array<{ id: string; params: ParamSpec[] }>,
);

const isInt = (value: unknown): value is number => Number.isInteger(value);
const isNum = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

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
      !isInt(parsed.bollPeriod) ||
      !isNum(parsed.bollMult) ||
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

/**
 * 启动即清空参数记忆，让「重启回默认」由本函数保证。
 * 不依赖 WKWebView 的 sessionStorage 进程存活语义：wry 升级、换 ephemeral data store
 * 或有人打开状态恢复时，sessionStorage 可能被带过来，AC 会静默失效。不要当冗余删掉。
 */
export function clearSessionParams() {
  try {
    window.sessionStorage.removeItem(PARAMS_STORAGE_KEY);
  } catch {
    // 存储不可用时参数本就是内存态，无需清理
  }
}

export function sameParams(a: WorkbenchParams, b: WorkbenchParams) {
  return (
    a.maPeriod === b.maPeriod &&
    a.maType === b.maType &&
    a.fast === b.fast &&
    a.slow === b.slow &&
    a.signal === b.signal &&
    a.bollPeriod === b.bollPeriod &&
    a.bollMult === b.bollMult
  );
}

/** 选项文案只从 manifest 的 abbr 来，id 只作引擎键；beta 由 manifest status 派生。 */
type Choice = { id: string; label: string };

const MANIFEST_INDEX = new Map(
  (manifestJson.indicators as Array<{ id: string; abbr: string; status: string }>).map((item) => [
    item.id,
    item,
  ]),
);

function choices(ids: readonly string[]): Choice[] {
  return ids.map((id) => {
    const item = MANIFEST_INDEX.get(id);
    if (!item) throw new Error(`manifest 缺少 ${id}`);
    return { id, label: `${id} ${item.abbr}${item.status === "beta" ? "（beta）" : ""}` };
  });
}

/** B2 主图叠加候选（11 个面板=主图的指标）。 */
export const B2_OVERLAY_CHOICES: Choice[] = choices([
  "T08", "T09", "T10", "T11", "T12", "T13", "T14", "T15", "T16", "T23", "T24",
]);

/** B2 副图候选（9 个波动指标）+ 既有 MACD。 */
export const B2_SUB_CHOICES: Choice[] = choices([
  "M06", "V01", "V02", "V03", "V04", "V05", "V07", "V08", "V09", "V10",
]);

/** B3 副图候选（13 个动量/摆动指标；M06 已在 B2 副图清单）。Q-01~Q-04 已裁定，均不再标 beta。 */
export const B3_SUB_CHOICES: Choice[] = choices([
  "M01", "M02", "M04", "M05", "M08", "M09", "M10", "M19", "M20", "M21", "M24", "M25", "M26",
]);

export const SUB_CHOICES: Choice[] = [...B2_SUB_CHOICES, ...B3_SUB_CHOICES, ...choices(["E13"])];

/** B1 回归族与 BIAS：AC-03.04-11 / -15 要求自 B2 起可上图（T19/T21 为 beta，带徽标、不进默认）。 */
export const B1_OVERLAY_CHOICES: Choice[] = choices(["T01", "T19", "T20", "T21", "T22"]);

/** 默认主图叠加 = SMA(20) + BOLL(20,2)：与 AC-02.02-04 的给定初始态一致 */
export const DEFAULT_B2_OVERLAYS = ["T01", "T09"];
export const DEFAULT_SUB_ID = "M06";
/** 主图叠加容量（S-02.04-02）：满 2 后需先移除才能加 */
export const MAX_MAIN_OVERLAYS = 2;
/** 副图容量（S-02.04-02 / S-02.03-01）：成交量 + 指标副图合计 3 格 */
export const MAX_SUBPLOTS = 3;

/** S-02.03-01：副图格（含成交量）的顺序与高度，全局持久化，非按标的 */
export const VOLUME_PANEL_ID = "VOL";
export const SUB_HEIGHT_MIN = 96;
export const SUB_HEIGHT_MAX = 220;
export const SUB_HEIGHT_DEFAULT = 140;
const SUBPLOTS_STORAGE_KEY = "aka.workbench.subplots.v1";

export interface SubPlotSetting {
  id: string;
  height: number;
}

/** 默认组合 D-08：成交量 + MACD + RSI（RSI=M01） */
export const DEFAULT_SUB_PLOTS: SubPlotSetting[] = [
  { id: VOLUME_PANEL_ID, height: SUB_HEIGHT_DEFAULT },
  { id: "M06", height: SUB_HEIGHT_DEFAULT },
  { id: "M01", height: SUB_HEIGHT_DEFAULT },
];

export function clampSubHeight(height: unknown): number {
  const value = typeof height === "number" && Number.isFinite(height) ? height : SUB_HEIGHT_DEFAULT;
  return Math.round(Math.max(SUB_HEIGHT_MIN, Math.min(SUB_HEIGHT_MAX, value)));
}

/** 读取本地设置；非法 id / 超容量 / 损坏数据一律回退默认组合，不静默半残 */
export function readSubPlots(): SubPlotSetting[] {
  try {
    const raw = window.localStorage.getItem(SUBPLOTS_STORAGE_KEY);
    if (!raw) return DEFAULT_SUB_PLOTS;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_SUBPLOTS) {
      return DEFAULT_SUB_PLOTS;
    }
    const seen = new Set<string>();
    const list: SubPlotSetting[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") return DEFAULT_SUB_PLOTS;
      const id = (entry as { id?: unknown }).id;
      if (typeof id !== "string") return DEFAULT_SUB_PLOTS;
      if (id !== VOLUME_PANEL_ID && !MANIFEST_INDEX.has(id)) return DEFAULT_SUB_PLOTS;
      if (seen.has(id)) return DEFAULT_SUB_PLOTS;
      seen.add(id);
      list.push({ id, height: clampSubHeight((entry as { height?: unknown }).height) });
    }
    // 成交量格是常驻格：旧数据里缺它时补到首位，保证「成交量 + 指标」合计 3 格
    if (!list.some((item) => item.id === VOLUME_PANEL_ID)) {
      list.unshift({ id: VOLUME_PANEL_ID, height: SUB_HEIGHT_DEFAULT });
    }
    return list.slice(0, MAX_SUBPLOTS);
  } catch {
    return DEFAULT_SUB_PLOTS;
  }
}

export function writeSubPlots(plots: SubPlotSetting[]) {
  try {
    window.localStorage.setItem(
      SUBPLOTS_STORAGE_KEY,
      JSON.stringify(plots.map((item) => ({ id: item.id, height: clampSubHeight(item.height) }))),
    );
  } catch {
    // 存储不可用时退化为仅内存态，不影响本会话布局
  }
}

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
      params: (indicatorId === "T09"
        ? { period: params.bollPeriod, mult: params.bollMult }
        : {}) as ParamValueMap,
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
    ["MA 周期", params.maPeriod, 2, 500],
    ["MACD 快线", params.fast, 2, 200],
    ["MACD 慢线", params.slow, 2, 200],
    ["MACD 信号", params.signal, 2, 200],
    ["BOLL 周期", params.bollPeriod, 2, 200],
  ];
  for (const [label, value, min, max] of pairs) {
    if (!Number.isInteger(value) || value < min || value > max) {
      return `${label}需为 ${min}–${max} 的整数`;
    }
  }
  if (!isNum(params.bollMult) || params.bollMult < 0.5 || params.bollMult > 5.0) {
    return "BOLL 标准差倍数需在 0.5–5.0 之间";
  }
  if (params.fast >= params.slow) {
    return "MACD 快线必须小于慢线";
  }
  return null;
}
