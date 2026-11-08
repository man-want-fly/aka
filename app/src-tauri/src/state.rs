use std::path::PathBuf;
use std::sync::Mutex;

use app_core::{AppCore, DatasetFault};

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
    /// S-08.02-02：下一次计算的故障注入；生效后自动回落 `None`。
    pub inject: InjectKind,
    /// S-08.02-03：数据集校验故障注入（QA 取证用）。
    pub dataset_fault: DatasetFault,
}

/// S-08.02-02：`inject_error` 口径（none / timeout / panic / data）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InjectKind {
    #[default]
    None,
    Timeout,
    Panic,
    Data,
}

impl InjectKind {
    /// 只认卡片口径；非法值按 `none` 处理，避免误触。
    pub fn parse(raw: &str) -> Self {
        match raw {
            "timeout" => Self::Timeout,
            "panic" => Self::Panic,
            "data" => Self::Data,
            _ => Self::None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Timeout => "timeout",
            Self::Panic => "panic",
            Self::Data => "data",
        }
    }
}

/// 命令层唯一共享状态：一个进程内编排器。
pub struct AppState {
    pub core: std::sync::Arc<AppCore>,
    /// state.db 落盘路径；「重新生成数据」需要原地重建。
    pub db_path: Option<PathBuf>,
    /// S-06.03-02：最近 200 条 IPC 命令（只记名字/耗时/结果码，不记入参）。
    pub commands: CommandLog,
    faults: Mutex<DiagFaults>,
    /// S-08.02-03：用户选择「只读浏览」后置真；重建成功或重启后归零（不跨启动记忆）。
    read_only: Mutex<bool>,
}

impl AppState {
    pub fn with_diag(core: AppCore, db_path: Option<PathBuf>, faults: DiagFaults) -> Self {
        Self {
            core: std::sync::Arc::new(core),
            db_path,
            commands: CommandLog::default(),
            faults: Mutex::new(faults),
            read_only: Mutex::new(false),
        }
    }

    pub fn faults(&self) -> DiagFaults {
        *self.faults.lock().unwrap_or_else(|err| err.into_inner())
    }

    /// S-08.02-02：设置注入类型，返回旧值。
    pub fn set_inject(&self, kind: InjectKind) -> InjectKind {
        let mut faults = self.faults.lock().unwrap_or_else(|err| err.into_inner());
        let previous = faults.inject;
        faults.inject = kind;
        previous
    }

    /// S-08.02-02：取走注入并立即回落 `none`（避免忘记关闭）。
    pub fn take_inject(&self) -> InjectKind {
        self.set_inject(InjectKind::None)
    }

    /// 重建样本包后同时清掉三个故障位，保证校验能恢复到 ok。
    pub fn clear_dataset_faults(&self) {
        let mut faults = self.faults.lock().unwrap_or_else(|err| err.into_inner());
        faults.dataset_fault = DatasetFault::None;
        faults.manifest_corrupt = false;
        faults.dataset_empty = false;
    }

    /// S-08.02-03：只读浏览开关（不写 state.db，重启即失效）。
    pub fn set_read_only(&self, read_only: bool) {
        *self
            .read_only
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = read_only;
    }

    pub fn read_only(&self) -> bool {
        *self
            .read_only
            .lock()
            .unwrap_or_else(|err| err.into_inner())
    }

    /// 只读模式下拒绝写操作；重建类命令不经过这里。
    pub fn ensure_writable(&self) -> Result<(), app_core::AppError> {
        if self.read_only() {
            Err(app_core::AppError::dataset_readonly())
        } else {
            Ok(())
        }
    }
}
