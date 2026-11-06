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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_securities,
            commands::get_bars,
            commands::indicator_registry,
            commands::indicator_manifest,
            commands::calc_indicators,
            commands::telemetry_dump,
        ])
        .run(tauri::generate_context!())
        .expect("AKA 启动失败");
}
