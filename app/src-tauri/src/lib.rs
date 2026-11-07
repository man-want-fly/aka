mod commands;
mod state;

use tauri::Manager;

use app_core::{AppCore, Telemetry};
use data_store::state_db::StateDb;

use crate::state::AppState;

/// 与架构图一致：`~/Library/Application Support/aka/state.db`。
fn state_db_path(app: &tauri::App) -> Option<std::path::PathBuf> {
    app.path()
        .home_dir()
        .ok()
        .map(|home| home.join("Library/Application Support/aka/state.db"))
}

/// 埋点日志：`~/Library/Application Support/aka/logs/telemetry.jsonl`（JSONL，可机读）。
fn telemetry_path(app: &tauri::App) -> Option<std::path::PathBuf> {
    app.path()
        .home_dir()
        .ok()
        .map(|home| home.join("Library/Application Support/aka/logs/telemetry.jsonl"))
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 单进程内完成装配：mock provider → app-core → state.db → 命令状态。
            let core = tauri::async_runtime::block_on(AppCore::new_mock())
                .map_err(|err| std::io::Error::other(err.message))?;
            let core = match state_db_path(app) {
                Some(path) => {
                    let db = StateDb::open_with_fallback(&path);
                    if db.degraded() {
                        eprintln!(
                            "[state.db] 已降级为内存库，原因：{}",
                            db.degraded_reason().unwrap_or("unknown")
                        );
                    }
                    core.with_state_db(db)
                }
                None => {
                    eprintln!("[state.db] 无法解析 home 目录，本次运行不持久化");
                    core
                }
            };
            let core = match telemetry_path(app) {
                Some(path) => core.with_telemetry(Telemetry::with_log_path(path)),
                None => core,
            };
            app.manage(AppState::new(core));
            // 取证运行：窗口被遮挡时 WKWebView 会节流/挂起定时器，诊断会卡在 await 上。
            // 只在 AKA_DIAG=1 时把窗口钉到最前，正常启动行为不受影响。
            if std::env::var("AKA_DIAG").ok().as_deref() == Some("1") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_always_on_top(true);
                    let _ = window.set_focus();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_securities,
            commands::get_bars,
            commands::indicator_registry,
            commands::indicator_manifest,
            commands::dataset_manifest,
            commands::calc_indicators,
            commands::telemetry_dump,
            commands::market_snapshot,
            commands::watchlist_read,
            commands::watch_toggle,
            commands::watch_group_create,
            commands::watch_group_rename,
            commands::watch_group_delete,
            commands::view_state_get,
            commands::view_state_set,
            commands::positions_read,
            commands::position_save,
            commands::position_delete,
            commands::diag_enabled,
            commands::diag_target,
            commands::diag_build_info,
            commands::diag_write,
            commands::diag_write_named,
            commands::telemetry_note,
        ])
        .run(tauri::generate_context!())
        .expect("AKA 启动失败");
}
