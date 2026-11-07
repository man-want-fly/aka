import { ipc } from "./ipc";

/** S-06.02-01：列表密度只有两档，默认紧凑；数字格式随版本固定，不暴露控件。 */
export type Density = "compact" | "comfy";

export interface DisplaySettings {
  density: Density;
}

export const DISPLAY_SCOPE = "settings.display";

/** 行高口径：紧凑 28px / 舒适 34px（CSS 与 diag 共用同一组常量）。 */
export const ROW_HEIGHT: Record<Density, number> = { compact: 28, comfy: 34 };

export const DEFAULT_DISPLAY: DisplaySettings = { density: "compact" };

export function sanitizeDisplay(value: unknown): DisplaySettings {
  if (!value || typeof value !== "object") return DEFAULT_DISPLAY;
  const raw = value as Partial<DisplaySettings>;
  return { density: raw.density === "comfy" ? "comfy" : "compact" };
}

export function currentDensity(): Density {
  if (typeof document === "undefined") return DEFAULT_DISPLAY.density;
  return document.documentElement.dataset.density === "comfy" ? "comfy" : "compact";
}

/** 所有页面共享的密度切换事件；写入根节点 attribute，由 CSS 统一改行高。 */
export function applyDensity(density: Density): void {
  document.documentElement.dataset.density = density;
  window.dispatchEvent(new CustomEvent<Density>("aka:density", { detail: density }));
}

export async function loadDisplaySettings(): Promise<DisplaySettings> {
  const settings = sanitizeDisplay(await ipc.viewStateGet(DISPLAY_SCOPE));
  applyDensity(settings.density);
  return settings;
}

/** 写库失败不回落内存态：当前会话即时生效，由调用方给出错误条。 */
export async function saveDisplaySettings(settings: DisplaySettings): Promise<void> {
  applyDensity(settings.density);
  await ipc.viewStateSet(DISPLAY_SCOPE, settings);
}
