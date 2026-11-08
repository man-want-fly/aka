import type { ManifestIndicatorDto } from "../../lib/types";
import {
  MAX_MAIN_OVERLAYS,
  MAX_SUBPLOTS,
  SUB_HEIGHT_DEFAULT,
  readSubPlots,
  writeSubPlots,
} from "../workbench/model";

/** S-03.01-04：最近标的；工作台每次带着代码打开时写入。 */
export const LAST_CODE_KEY = "aka.last.code";
/** S-02.02-02：主图叠加指标持久化键，与 WorkbenchPage 同源。 */
export const OVERLAYS_KEY = "aka.chart.overlays";

export function readLastCode(): string | null {
  try {
    const raw = window.localStorage.getItem(LAST_CODE_KEY);
    const value = raw?.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

export function writeLastCode(code: string) {
  try {
    window.localStorage.setItem(LAST_CODE_KEY, code);
  } catch {
    // 存储不可用时只影响跨页记忆，不影响当前会话
  }
}

export function readOverlayIds(): string[] {
  try {
    const raw = window.localStorage.getItem(OVERLAYS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string").slice(0, MAX_MAIN_OVERLAYS);
  } catch {
    return [];
  }
}

export type ChartPanel = "main" | "sub";

/** manifest 的 panel 只有「主 / 副」两档；成交量归入副图常驻格。 */
export function panelOf(item: Pick<ManifestIndicatorDto, "panel">): ChartPanel {
  return item.panel === "主" ? "main" : "sub";
}

export type ChartAddStatus = "added" | "duplicate" | "full" | "planned";

export interface ChartAddResult {
  status: ChartAddStatus;
  count: number;
  capacity: number;
}

export function chartStateOf(item: ManifestIndicatorDto): {
  inChart: boolean;
  count: number;
  capacity: number;
  panel: ChartPanel;
} {
  const panel = panelOf(item);
  if (panel === "main") {
    const ids = readOverlayIds();
    return { inChart: ids.includes(item.id), count: ids.length, capacity: MAX_MAIN_OVERLAYS, panel };
  }
  const plots = readSubPlots();
  return {
    inChart: plots.some((plot) => plot.id === item.id),
    count: plots.length,
    capacity: MAX_SUBPLOTS,
    panel,
  };
}

/**
 * S-03.01-04：目录「加入图表」。
 * 与抽屉（S-02.04-02）同一套规则：主图容量 2、副图合计 3（含成交量常驻格），
 * 已在图表中不重复添加，规划项直接拒绝。
 */
export function addIndicatorToChart(item: ManifestIndicatorDto): ChartAddResult {
  const panel = panelOf(item);
  if (panel === "main") {
    const ids = readOverlayIds();
    if (ids.includes(item.id)) {
      return { status: "duplicate", count: ids.length, capacity: MAX_MAIN_OVERLAYS };
    }
    if (ids.length >= MAX_MAIN_OVERLAYS) {
      return { status: "full", count: ids.length, capacity: MAX_MAIN_OVERLAYS };
    }
    try {
      window.localStorage.setItem(OVERLAYS_KEY, JSON.stringify([...ids, item.id]));
    } catch {
      // 忽略存储异常；工作台下次读取时仍为空
    }
    return { status: "added", count: ids.length + 1, capacity: MAX_MAIN_OVERLAYS };
  }

  const plots = readSubPlots();
  if (plots.some((plot) => plot.id === item.id)) {
    return { status: "duplicate", count: plots.length, capacity: MAX_SUBPLOTS };
  }
  if (plots.length >= MAX_SUBPLOTS) {
    return { status: "full", count: plots.length, capacity: MAX_SUBPLOTS };
  }
  writeSubPlots([...plots, { id: item.id, height: SUB_HEIGHT_DEFAULT }]);
  return { status: "added", count: plots.length + 1, capacity: MAX_SUBPLOTS };
}
