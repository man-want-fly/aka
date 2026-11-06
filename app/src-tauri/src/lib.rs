mod commands;
mod state;

use tauri::Manager;

use app_core::AppCore;

use crate::state::AppState;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 单进程内完成装配：mock provider → app-core → 命令状态。
            let core = tauri::async_runtime::block_on(AppCore::new_mock())
                .map_err(|err| std::io::Error::other(err.message))?;
            app.manage(AppState::new(core));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_securities,
            commands::get_bars,
            commands::indicator_registry,
            commands::calc_indicators,
        ])
        .run(tauri::generate_context!())
        .expect("AKA 启动失败");
}
