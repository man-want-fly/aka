/**
 * W-63：导出四支的分支注入开关。
 * 只用前端 dev-only 开关，不新增 Tauri 命令；`import.meta.env.DEV` 为 false 时整段被 Vite 摇掉，
 * release 前端产物里不出现键名（CI 有对应断言）。
 *
 * 口径（W-66 卡面锚点 `S-08.02-04·导出四态（渲染层）`）：
 * 四支只证「四种状态文案各自正确渲染」，不代表四条失败路径真实发生。
 * 注入点：`ok` / `no-download` 直接置 `copied=true`（短路剪贴板通道，不调用 clipboard），
 * `no-download` / `both-fail` 直接置 `downloaded=false`（短路下载通道，不调用 anchor.click）；
 * 只有下载在 `ok` / `no-copy` 两支是真实调用并真实落盘。
 */
export type DiagExportMode = "ok" | "no-copy" | "no-download" | "both-fail";

export const readDiagExportMode = (): DiagExportMode | null => {
  if (import.meta.env.DEV) {
    const value = window.localStorage.getItem("aka.diag.export");
    return value === "ok" || value === "no-copy" || value === "no-download" || value === "both-fail"
      ? value
      : null;
  }
  return null;
};

export const setDiagExportMode = (mode: DiagExportMode) => {
  if (import.meta.env.DEV) {
    window.localStorage.setItem("aka.diag.export", mode);
  }
};

export const clearDiagExportMode = () => {
  if (import.meta.env.DEV) {
    window.localStorage.removeItem("aka.diag.export");
  }
};

/**
 * 取证用文件名：dev 注入运行时把支名带进文件名，让文件断言能绑定到具体一支
 * （C1/C2 都真实下载，只按「最新文件」无法区分）。release / 正常运行时不带后缀。
 */
export const diagExportFileName = (traceId: string, mode: DiagExportMode | null): string =>
  mode ? `aka-diagnostics-${traceId}-${mode}.json` : `aka-diagnostics-${traceId}.json`;
