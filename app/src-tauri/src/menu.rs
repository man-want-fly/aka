//! AKA-33：原生菜单。
//!
//! 菜单只做两件事：把四项能力摆出来（关于 / 导出诊断包 / 切换数据源 / 退出），
//! 以及把动作转成前端事件。真正的导航与导出一律复用前端既有实现，避免同一能力
//! 出现两个入口（AC-33-4）。

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

/// 前端 `src/lib/menu.ts` 监听同一事件名。
pub const EVENT_MENU: &str = "aka:menu";

pub const ID_ABOUT: &str = "menu.about";
pub const ID_EXPORT_DIAGNOSTICS: &str = "menu.export-diagnostics";
pub const ID_SWITCH_DATASOURCE: &str = "menu.switch-datasource";

/// 菜单项 id → 前端动作；未列出的 id（如系统退出）不由菜单转发。
pub fn action_for(id: &str) -> Option<&'static str> {
    match id {
        ID_ABOUT => Some("about"),
        ID_EXPORT_DIAGNOSTICS => Some("export-diagnostics"),
        _ => None,
    }
}

/// AC-33-1：关于 / 导出诊断包 / 切换数据源 / 退出 四项齐备。
/// AC-33-3：目前只有 sim 一个数据源，切换没有落地实现，置灰而不是给假入口。
/// AC-33-4：快捷键只用 ⌘⇧E(导出)；⌘K 归搜索浮层，退出走系统 ⌘Q，互不冲突。
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let about = MenuItemBuilder::with_id(ID_ABOUT, "关于 AKA").build(app)?;
    let export = MenuItemBuilder::with_id(ID_EXPORT_DIAGNOSTICS, "导出诊断包…")
        .accelerator("CmdOrCtrl+Shift+E")
        .build(app)?;
    let switch = MenuItemBuilder::with_id(ID_SWITCH_DATASOURCE, "切换数据源…")
        .enabled(false)
        .build(app)?;
    let quit = PredefinedMenuItem::quit(app, Some("退出 AKA"))?;
    let app_menu = SubmenuBuilder::new(app, "AKA")
        .item(&about)
        .separator()
        .item(&export)
        .separator()
        .item(&switch)
        .separator()
        .item(&quit)
        .build()?;
    MenuBuilder::new(app).item(&app_menu).build()
}

/// 只发动作、不做业务：前端收到事件后复用既有路由与命令。
pub fn emit<R: Runtime>(app: &AppHandle<R>, action: &str) {
    let _ = app.emit(EVENT_MENU, serde_json::json!({ "action": action }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_implemented_actions_are_forwarded() {
        assert_eq!(action_for(ID_ABOUT), Some("about"));
        assert_eq!(action_for(ID_EXPORT_DIAGNOSTICS), Some("export-diagnostics"));
        // 置灰项即便被误触也不转发，避免出现第二入口。
        assert_eq!(action_for(ID_SWITCH_DATASOURCE), None);
        assert_eq!(action_for("menu.unknown"), None);
    }
}
