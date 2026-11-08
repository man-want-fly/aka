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
    /// W-115：模拟数据集 manifest 整体缺失（数据目录「目录不存在」取证）。
    pub manifest_missing: bool,
    /// S-08.02-02：下一次计算的故障注入；生效后自动回落 `None`。
    pub inject: InjectKind,
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
}
