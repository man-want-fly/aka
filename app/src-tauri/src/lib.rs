mod commands;
mod diagnostics;
mod state;

use tauri::Manager;

use app_core::{AppCore, Telemetry};
use data_store::state_db::StateDb;

use crate::state::{AppState, DiagFaults, InjectKind};

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

/// 四个 QA 启动参数集中在此处，源码层门禁可按「函数是否被 cfg 覆盖」逐条检查。
#[cfg(debug_assertions)]
fn faults_from_args(args: &[String]) -> DiagFaults {
    DiagFaults {
        dataset_empty: diag_flag(args, "--empty-dataset"),
        corrupt_db: diag_flag(args, "--corrupt-db"),
        read_only_db: diag_flag(args, "--readonly-db"),
        manifest_corrupt: diag_flag(args, "--corrupt-manifest"),
        // S-08.02-02：`--inject=timeout|panic|data`；生效一次后自动回落 none。
        inject: if diag_enabled() {
            args.iter()
                .find_map(|arg| arg.strip_prefix("--inject="))
                .map(InjectKind::parse)
                .unwrap_or_default()
        } else {
            InjectKind::None
        },
    }
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

/// 崩溃或 SIGTERM 退出可能留下上次的临时库目录，启动时先扫掉，避免逐次累积。
#[cfg(debug_assertions)]
fn cleanup_stale_diag_temp() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with("aka-diag-corrupt-")
        {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let builder = tauri::Builder::default()
        .setup(move |app| {
            #[cfg(debug_assertions)]
            cleanup_stale_diag_temp();
            // S-06.03-02：上次导出中途崩溃留下的临时目录，启动时清掉。
            diagnostics::cleanup_stale_temp();
            let faults = {
                #[cfg(debug_assertions)]
                {
                    faults_from_args(&args)
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
                    let real_path = path.clone();
                    // 坏库注入只作用于临时副本，真实 state.db 与其备份都不动。
                    #[cfg(debug_assertions)]
                    let path = if faults.corrupt_db {
                        corrupt_state_db(&path)
                    } else {
                        path
                    };
                    let db = StateDb::open_with_fallback(&path);
                    // 坏库副本已降级为内存库，临时目录即刻清掉；不依赖退出钩子。
                    #[cfg(debug_assertions)]
                    if faults.corrupt_db {
                        if let Some(dir) = path.parent() {
                            let _ = std::fs::remove_dir_all(dir);
                        }
                    }
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
                    // 状态里保留真实路径：「重新生成数据」重建的是产品库，不是临时副本。
                    (core.with_state_db(db), Some(real_path))
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
            // S-06.03-02：真实启动日志（诊断包 `app.log` 的来源），不伪造、不上传。
            diagnostics::append_app_log(&format!(
                "[startup] version={} build={}",
                env!("CARGO_PKG_VERSION"),
                std::env::var("AKA_BUILD_NO").unwrap_or_else(|_| "dev".to_string())
            ));
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
        });
    // W-49：诊断写入口只在 debug 构建注册；release 的 handler 里不出现 diag_write/diag_faults，
    // 命令名与实现都不进产物（读侧 diag_enabled/diag_target 保留为恒 false/空串的桩，供前端探测）。
    #[cfg(debug_assertions)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::list_securities,
        commands::get_bars,
        commands::indicator_registry,
        commands::indicator_manifest,
        commands::indicator_favorites,
        commands::set_indicator_favorite,
        commands::recent_views,
        commands::touch_recent_view,
        commands::quality_report,
        commands::quality_scan,
        commands::bar_provenance,
        commands::dataset_manifest,
        commands::datasource_status,
        commands::data_health_check,
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
        commands::diag_set_inject,
        commands::view_state_get,
        commands::view_state_set,
        commands::positions_read,
        commands::position_save,
        commands::position_delete,
        commands::diag_enabled,
        commands::diag_target,
        commands::diag_build_info,
        commands::diag_env,
        commands::diag_write,
        commands::diag_write_named,
        commands::telemetry_note,
        commands::export_diagnostics,
        commands::reveal_diagnostics,
    ]);
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::list_securities,
        commands::get_bars,
        commands::indicator_registry,
        commands::indicator_manifest,
        commands::indicator_favorites,
        commands::set_indicator_favorite,
        commands::recent_views,
        commands::touch_recent_view,
        commands::quality_report,
        commands::quality_scan,
        commands::bar_provenance,
        commands::dataset_manifest,
        commands::datasource_status,
        commands::data_health_check,
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
        commands::view_state_get,
        commands::view_state_set,
        commands::positions_read,
        commands::position_save,
        commands::position_delete,
        commands::diag_enabled,
        commands::diag_target,
        commands::diag_build_info,
        commands::telemetry_note,
        commands::export_diagnostics,
        commands::reveal_diagnostics,
    ]);
    builder
        .run(tauri::generate_context!())
        .expect("AKA 启动失败");
}
