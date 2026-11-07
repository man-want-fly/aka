mod commands;
mod state;

use tauri::Manager;

use app_core::{AppCore, Telemetry};
use data_store::state_db::StateDb;

use crate::state::{AppState, DiagFaults};

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

/// QA 注入只认 `AKA_DIAG=1`；正常启动即使带同名参数也全部忽略。
/// 发布构建（`cfg!(debug_assertions)=false`）里整段编译掉，release 二进制不含注入入口。
#[cfg(debug_assertions)]
fn diag_enabled() -> bool {
    std::env::var("AKA_DIAG").ok().as_deref() == Some("1")
}

#[cfg(debug_assertions)]
fn diag_flag(args: &[String], name: &str) -> bool {
    diag_enabled() && args.iter().any(|arg| arg == name)
}

/// 注入坏库：真实 state.db 先备份到临时目录，再在临时副本上写坏；
/// 产品库永远不被覆写，也不依赖脚本侧 `.backup` 兜底。
#[cfg(debug_assertions)]
fn corrupt_state_db(path: &std::path::Path) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("aka-diag-corrupt-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let temp = dir.join("state.db");
    if path.exists() {
        let _ = std::fs::copy(path, dir.join("state.db.orig"));
        let _ = std::fs::copy(path, &temp);
    }
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", temp.display()));
    }
    let _ = std::fs::write(&temp, b"AKA-DIAG-CORRUPT-STATE-DB");
    temp
}

pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    tauri::Builder::default()
        .setup(move |app| {
            let faults = {
                #[cfg(debug_assertions)]
                {
                    DiagFaults {
                        dataset_empty: diag_flag(&args, "--empty-dataset"),
                        corrupt_db: diag_flag(&args, "--corrupt-db"),
                        read_only_db: diag_flag(&args, "--readonly-db"),
                    }
                }
                #[cfg(not(debug_assertions))]
                {
                    let _ = &args;
                    DiagFaults::default()
                }
            };
            let db_path = state_db_path(app);
            // 单进程内完成装配：mock provider → app-core → state.db → 命令状态。
            let core = tauri::async_runtime::block_on(AppCore::new_mock())
                .map_err(|err| std::io::Error::other(err.message))?;
            let (core, db_path) = match db_path.clone() {
                Some(path) => {
                    // 坏库注入只作用于临时副本，真实 state.db 与其备份都不动。
                    #[cfg(debug_assertions)]
                    let path = if faults.corrupt_db {
                        corrupt_state_db(&path)
                    } else {
                        path
                    };
                    let db = StateDb::open_with_fallback(&path);
                    #[cfg(debug_assertions)]
                    if faults.read_only_db {
                        db.enable_query_only_for_diag()
                            .map_err(|err| std::io::Error::other(err.to_string()))?;
                    }
                    if db.degraded() {
                        eprintln!(
                            "[state.db] 已降级为内存库，原因：{}",
                            db.degraded_reason().unwrap_or("unknown")
                        );
                    }
                    (core.with_state_db(db), Some(path))
                }
                None => {
                    eprintln!("[state.db] 无法解析 home 目录，本次运行不持久化");
                    (core, None)
                }
            };
            let core = match telemetry_path(app) {
                Some(path) => core.with_telemetry(Telemetry::with_log_path(path)),
                None => core,
            };
            app.manage(AppState::with_diag(core, db_path, faults));
            // 取证运行：窗口被遮挡时 WKWebView 会节流/挂起定时器，诊断会卡在 await 上。
            // 只在 debug 构建且 AKA_DIAG=1 时把窗口钉到最前，正常启动与发布构建不受影响。
            #[cfg(debug_assertions)]
            if diag_enabled() {
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
            commands::dataset_regenerate,
            commands::storage_rebuild,
            commands::diag_faults,
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
