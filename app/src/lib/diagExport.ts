/**
 * W-63：导出四支的分支注入开关。
 * 只用前端 dev-only 开关，不新增 Tauri 命令；`import.meta.env.DEV` 为 false 时整段被 Vite 摇掉，
 * release 前端产物里不出现键名（CI 有对应断言）。
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
