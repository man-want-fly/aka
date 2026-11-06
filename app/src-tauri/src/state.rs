use std::sync::Arc;

use app_core::AppCore;

/// 命令层唯一共享状态：一个进程内编排器。
pub struct AppState {
    pub core: Arc<AppCore>,
}

impl AppState {
    pub fn new(core: AppCore) -> Self {
        Self {
            core: Arc::new(core),
        }
    }
}
