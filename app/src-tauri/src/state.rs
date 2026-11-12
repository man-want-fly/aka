use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use app_core::{AppCore, DatasetFault};

use crate::diagnostics::CommandLog;

/// QA 故障注入（仅 `AKA_DIAG=1` 时由启动参数打开）；正常启动全为 false。
// S-08.02-03：expect_code 为 String，DiagFaults 不再可 Copy，读取改走 clone()。
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagFaults {
    pub dataset_empty: bool,
    pub corrupt_db: bool,
    pub read_only_db: bool,
    /// S-07.01-02：模拟 manifest 不可读（健康检查①/② FAIL 链取证）。
    pub manifest_corrupt: bool,
    /// W-115：模拟数据集 manifest 整体缺失（数据目录「目录不存在」取证）。
    pub manifest_missing: bool,
    /// W-116：模拟 manifest 只缺 sha256（页脚「只缺一段、其余 6 段正常」取证）。
    pub manifest_sha256_missing: bool,
    /// S-08.02-02：下一次计算的故障注入；生效后自动回落 `None`。
    pub inject: InjectKind,
    /// S-08.02-03：数据集校验故障注入（QA 取证用）。
    pub dataset_fault: DatasetFault,
    /// S-08.02-03：脚本传入的期望错误码，与后端 DTO 独立，用于锚定分类是否真错。
    pub expect_code: String,
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
    /// S-08.02-03：用户选择「只读浏览」后置真；ST-DF-03-05 起持久化到 state.db，重启后保持。
    read_only: Mutex<bool>,
    /// ST-DF-03-01：安装/重建互斥；guard 离开作用域即释放，不产生第二个 staging。
    installing: Arc<AtomicBool>,
    /// AKA-33：退出收尾只执行一次；窗口关闭与应用退出可能各触发一次。
    shut_down: AtomicBool,
}

/// ST-DF-03-01：安装进行中凭证；Drop 时自动释放互斥，线程 panic 也不会卡死。
#[derive(Debug)]
pub struct InstallPermit {
    installing: Arc<AtomicBool>,
}

impl Drop for InstallPermit {
    fn drop(&mut self) {
        self.installing.store(false, Ordering::SeqCst);
    }
}

impl AppState {
    /// ST-DF-03-05：只读开关在 state.db settings 中的键（启动恢复与写入共用）。
    pub const READ_ONLY_KEY: &'static str = "dataset.readOnly";

    pub fn with_diag(core: AppCore, db_path: Option<PathBuf>, faults: DiagFaults) -> Self {
        Self {
            core: std::sync::Arc::new(core),
            db_path,
            commands: CommandLog::default(),
            faults: Mutex::new(faults),
            read_only: Mutex::new(false),
            installing: Arc::new(AtomicBool::new(false)),
            shut_down: AtomicBool::new(false),
        }
    }

    pub fn faults(&self) -> DiagFaults {
        self.faults
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
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

    /// 重建样本包后同时清掉三个故障位，保证校验能恢复到 ok。
    pub fn clear_dataset_faults(&self) {
        let mut faults = self.faults.lock().unwrap_or_else(|err| err.into_inner());
        faults.dataset_fault = DatasetFault::None;
        faults.manifest_corrupt = false;
        faults.dataset_empty = false;
    }

    /// S-08.02-03：只读浏览开关的内存态；持久化入口见 `persist_read_only`。
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

    /// 只读模式下拒绝写操作；安装/重建走 `begin_sim_install`，同样先过这里。
    pub fn ensure_writable(&self) -> Result<(), app_core::AppError> {
        if self.read_only() {
            Err(app_core::AppError::dataset_readonly())
        } else {
            Ok(())
        }
    }

    /// ST-DF-03-05：切换只读并持久化。
    /// 先落内存态再写库：即使 state.db 暂时写入失败，保护也必须立即生效；失败如实上报。
    pub fn persist_read_only(&self, read_only: bool) -> Result<(), app_core::AppError> {
        self.set_read_only(read_only);
        self.core.set_setting(
            Self::READ_ONLY_KEY,
            if read_only { "true" } else { "false" },
        )
    }

    /// ST-DF-03-05：启动时从 state.db 恢复只读开关；读不到按关闭处理。
    pub fn restore_read_only(&self) -> bool {
        let read_only = self.core.setting(Self::READ_ONLY_KEY).ok().flatten().as_deref()
            == Some("true");
        self.set_read_only(read_only);
        read_only
    }

    /// ST-DF-03-01：安装/重建入口互斥；只读优先拒绝，其次拒绝并发。
    pub fn begin_sim_install(&self) -> Result<InstallPermit, app_core::AppError> {
        self.ensure_writable()?;
        if self
            .installing
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(app_core::AppError::install_in_progress());
        }
        Ok(InstallPermit {
            installing: self.installing.clone(),
        })
    }

    pub fn sim_install_running(&self) -> bool {
        self.installing.load(Ordering::SeqCst)
    }

    /// AKA-33：退出前把可落盘状态刷到底 —— WAL 合并回 state.db、埋点 JSONL sync。
    /// 幂等：窗口关闭与应用退出会各触发一次，只真正执行一次。
    pub fn shutdown(&self) {
        if self.shut_down.swap(true, Ordering::SeqCst) {
            return;
        }
        let checkpointed = self
            .core
            .state_db()
            .map(|db| db.checkpoint().is_ok())
            .unwrap_or(false);
        self.core.telemetry().flush();
        crate::diagnostics::append_app_log(&format!(
            "[shutdown] state_db_checkpoint={checkpointed} telemetry_flushed=true"
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use app_core::{GetBarsRequest, HealthFaults, ListSecuritiesRequest};
    use data_store::state_db::StateDb;

    /// ST-DF-03-05：每个用例独立临时库，用于模拟「重启后仍读得到」。
    fn temp_state_db(tag: &str) -> (std::path::PathBuf, StateDb) {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "aka-readonly-{}-{stamp}-{tag}.db",
            std::process::id()
        ));
        let db = StateDb::open_with_fallback(&path);
        assert!(!db.degraded(), "临时库不应降级");
        (path, db)
    }

    /// 按启动顺序装配：state.db 打开 → AppState 创建 → 恢复只读开关。
    fn open_state(path: &std::path::Path) -> AppState {
        let core = tauri::async_runtime::block_on(AppCore::new_mock())
            .unwrap()
            .with_state_db(StateDb::open_with_fallback(path));
        AppState::with_diag(core, Some(path.to_path_buf()), DiagFaults::default())
    }

    fn cleanup_db(path: &std::path::Path) {
        let text = path.to_string_lossy().to_string();
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{text}{suffix}"));
        }
    }

    /// AC-DF-01-01-6 / AC-DF-01-04-5：只读开关只拦写操作，标的清单与数据源状态查询照常返回。
    #[test]
    fn readonly_mode_keeps_security_and_status_reads_available() {
        let core = tauri::async_runtime::block_on(AppCore::new_mock()).unwrap();
        let state = AppState::with_diag(core, None, DiagFaults::default());
        state.set_read_only(true);

        let securities = state
            .core
            .list_securities(&ListSecuritiesRequest { market: None, limit: None });
        assert_eq!(securities.len(), 120, "只读模式不得影响标的清单读取");

        let status = tauri::async_runtime::block_on(state.core.datasource_status());
        assert_eq!((status.required_ok, status.required_total), (4, 4));

        // 只读开关本身有效：写操作仍被拒绝。
        assert_eq!(
            state.ensure_writable().unwrap_err().code.as_str(),
            "E_DATASET_READONLY"
        );
    }

    /// AC-DF-03-01-4：安装进行中再次触发必须返回进行中错误，且不产生第二个构建。
    #[test]
    fn concurrent_sim_install_is_rejected_with_in_progress() {
        let core = tauri::async_runtime::block_on(AppCore::new_mock()).unwrap();
        let state = AppState::with_diag(core, None, DiagFaults::default());

        let permit = state.begin_sim_install().expect("first install");
        assert!(state.sim_install_running());
        assert_eq!(
            state.begin_sim_install().unwrap_err().code.as_str(),
            "E_INSTALL_IN_PROGRESS"
        );

        drop(permit);
        assert!(!state.sim_install_running());
        assert!(state.begin_sim_install().is_ok(), "释放后必须可再次安装");
    }

    /// AC-DF-03-01-5：只读开启时安装/重建在入口被拒绝，目录不会被创建或改动。
    #[test]
    fn readonly_blocks_sim_install_before_any_io() {
        let core = tauri::async_runtime::block_on(AppCore::new_mock()).unwrap();
        let state = AppState::with_diag(core, None, DiagFaults::default());
        state.set_read_only(true);

        assert_eq!(
            state.begin_sim_install().unwrap_err().code.as_str(),
            "E_DATASET_READONLY"
        );
        assert!(!state.sim_install_running());
    }

    /// AC-DF-03-05-3 / AC-DF-03-05-5：开关持久化；关闭只读后写入成功，重启后开关与写入都保持。
    #[test]
    fn readonly_switch_and_writes_survive_restart() {
        let (path, db) = temp_state_db("switch");
        let core = tauri::async_runtime::block_on(AppCore::new_mock())
            .unwrap()
            .with_state_db(db);
        let state = AppState::with_diag(core, Some(path.clone()), DiagFaults::default());

        // 开启只读：写入口拒绝，并写入 state.db。
        state.persist_read_only(true).unwrap();
        assert!(state.read_only());
        assert_eq!(
            state.ensure_writable().unwrap_err().code.as_str(),
            "E_DATASET_READONLY"
        );
        drop(state);

        // 模拟重启：新实例从同一 state.db 恢复，开关与关闭前一致。
        let state = open_state(&path);
        assert!(state.restore_read_only(), "重启后只读开关必须保持开启");
        assert!(state.ensure_writable().is_err());

        // 关闭只读后写入成功。
        state.persist_read_only(false).unwrap();
        assert!(state.ensure_writable().is_ok());
        state
            .core
            .set_view_state("workbench", &serde_json::json!({ "range": "1M" }))
            .unwrap();
        drop(state);

        // 再次重启：开关保持关闭，刚才的写入仍可读到。
        let state = open_state(&path);
        assert!(!state.restore_read_only(), "重启后只读开关必须保持关闭");
        assert_eq!(
            state.core.view_state("workbench").unwrap(),
            Some(serde_json::json!({ "range": "1M" }))
        );
        drop(state);
        cleanup_db(&path);
    }

    /// AC-DF-03-05-6：只读下健康检查与取数照常可用，且读路径不改写开关。
    #[test]
    fn readonly_health_check_and_bars_stay_available() {
        let core = tauri::async_runtime::block_on(AppCore::new_mock()).unwrap();
        let state = AppState::with_diag(core, None, DiagFaults::default());
        state.set_read_only(true);

        let health =
            tauri::async_runtime::block_on(state.core.data_health_check(HealthFaults::default()));
        assert_eq!(health.state, "ok", "只读下健康检查必须正常执行");

        let bars = tauri::async_runtime::block_on(state.core.get_bars(&GetBarsRequest {
            security: "600519.SH".to_string(),
            timeframe: "D".to_string(),
            adj: "qfq".to_string(),
            from: None,
            to: None,
        }))
        .unwrap();
        assert!(!bars.bars.is_empty(), "只读下取数必须正常");
        assert!(state.read_only(), "读接口不得改写只读开关");
    }

    /// AKA-33：关窗收尾幂等；WAL 被合并截断，重启后数据仍可读（不丢未落盘状态）。
    #[test]
    fn shutdown_is_idempotent_and_checkpoints_state_db() {
        let (path, db) = temp_state_db("shutdown");
        let core = tauri::async_runtime::block_on(AppCore::new_mock())
            .unwrap()
            .with_state_db(db);
        let state = AppState::with_diag(core, Some(path.clone()), DiagFaults::default());
        state
            .core
            .set_view_state("workbench", &serde_json::json!({ "range": "1M" }))
            .unwrap();

        state.shutdown();
        // 第二次（应用退出）不得重复写日志或报错。
        state.shutdown();

        let wal = std::path::PathBuf::from(format!("{}-wal", path.display()));
        let wal_len = std::fs::metadata(&wal).map(|meta| meta.len()).unwrap_or(0);
        assert_eq!(wal_len, 0, "退出后 WAL 必须已合并并截断");
        drop(state);

        // 模拟重启：数据仍在主库中，读取不依赖 WAL。
        let reopened = open_state(&path);
        assert_eq!(
            reopened.core.view_state("workbench").unwrap(),
            Some(serde_json::json!({ "range": "1M" }))
        );
        drop(reopened);
        cleanup_db(&path);
    }
}
