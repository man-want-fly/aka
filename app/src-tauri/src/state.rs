use std::path::PathBuf;
use std::sync::Mutex;

use app_core::AppCore;

use crate::diagnostics::CommandLog;

/// QA 故障注入（仅 `AKA_DIAG=1` 时由启动参数打开）；正常启动全为 false。
#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagFaults {
    pub dataset_empty: bool,
    pub corrupt_db: bool,
    pub read_only_db: bool,
    /// S-07.01-02：模拟 manifest 不可读（健康检查①/② FAIL 链取证）。
    pub manifest_corrupt: bool,
}

/// 命令层唯一共享状态：一个进程内编排器。
pub struct AppState {
    pub core: std::sync::Arc<AppCore>,
    /// state.db 落盘路径；「重新生成数据」需要原地重建。
    pub db_path: Option<PathBuf>,
    /// S-06.03-02：最近 200 条 IPC 命令（只记名字/耗时/结果码，不记入参）。
    pub commands: CommandLog,
    faults: Mutex<DiagFaults>,
}

impl AppState {
    pub fn with_diag(core: AppCore, db_path: Option<PathBuf>, faults: DiagFaults) -> Self {
        Self {
            core: std::sync::Arc::new(core),
            db_path,
            commands: CommandLog::default(),
            faults: Mutex::new(faults),
        }
    }

    pub fn faults(&self) -> DiagFaults {
        *self.faults.lock().unwrap_or_else(|err| err.into_inner())
    }

    pub fn set_dataset_empty(&self, empty: bool) {
        self.faults
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .dataset_empty = empty;
    }

    /// 重建样本包后清除 manifest 损坏注入，否则健康检查无法恢复。
    pub fn set_manifest_corrupt(&self, corrupt: bool) {
        self.faults
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .manifest_corrupt = corrupt;
    }
}
