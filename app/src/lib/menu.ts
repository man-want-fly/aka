import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "./ipc";

/** 与 `src-tauri/src/menu.rs` 的 EVENT_MENU 同口径。 */
export const MENU_EVENT = "aka:menu";
/** 已在设置页时，菜单动作改走窗口事件，避免重新挂载丢页内状态。 */
export const MENU_ACTION_EVENT = "aka:menu-action";

/** AKA-33：原生菜单只转发这两个动作，其余项在菜单里置灰。 */
export type MenuAction = "about" | "export-diagnostics";

const isMenuAction = (value: unknown): value is MenuAction =>
  value === "about" || value === "export-diagnostics";

let pending: MenuAction | null = null;

/** 跨路由交接：菜单动作发生在页面挂载之前时，由目标页挂载后消费一次。 */
export function setPendingMenuAction(action: MenuAction): void {
  pending = action;
}

export function takePendingMenuAction(): MenuAction | null {
  const next = pending;
  pending = null;
  return next;
}

/** 订阅原生菜单动作；非 Tauri 环境返回空取消函数。 */
export function subscribeMenuAction(handler: (action: MenuAction) => void): () => void {
  if (!isTauriRuntime()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void listen<{ action?: unknown }>(MENU_EVENT, (event) => {
    const action = event.payload?.action;
    if (isMenuAction(action)) handler(action);
  })
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch(() => undefined);
  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}
