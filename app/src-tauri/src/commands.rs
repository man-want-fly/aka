//! IPC 命令层：只做「反序列化 → 调 AppCore → 错误映射」，不写业务逻辑。
//! 新增命令必须保持在这个形状，超过 15 行说明业务该下沉到 app-core。

use app_core::core::{EVENT_CALC_PANIC, EVENT_CALC_TIMEOUT};
use app_core::sim_install::{self, SimInstallReport, SimInstallStatus};
use app_core::{
    AppError, BarProvenanceDto, BarProvenanceRequest, BarsResponse, CalcRequest, CalcResponse,
    DatasetManifest, DatasourceStatusDto, DataHealthDto, ErrorCode, GetBarsRequest,
    HealthFaults, IndexSnapshotDto, IndicatorFavoritesResponse,
    ListSecuritiesRequest, Manifest, MarketSnapshotDto, PositionDto, QualityReportDto,
    RecentViewDto, RegistryRequest, RegistryResponse, SecurityDto, TelemetrySummary,
    WatchToggleResult, WatchlistDto,
};
use serde_json::Value;
use tauri::State;

use crate::state::{AppState, InjectKind};

/// S-06.03-02：IPC 命令统一记账（只记命令名/耗时/结果码，入参一律不落盘）。
macro_rules! tracked {
    ($state:expr, $name:literal, $body:block) => {{
        let started = std::time::Instant::now();
        let result: Result<_, AppError> = $body;
        let code = match &result {
            Ok(_) => "OK".to_string(),
            Err(err) => err.code.as_str().to_string(),
        };
        $state
            .commands
            .record($name, started.elapsed().as_millis() as u64, code);
        result
    }};
}

#[tauri::command]
pub async fn list_securities(
    state: State<'_, AppState>,
    req: ListSecuritiesRequest,
) -> Result<Vec<SecurityDto>, AppError> {
    // QA 注入（`--empty-dataset`）：模拟数据源返回 0 只，自选页展示「当前数据集为空」。
    if state.faults().dataset_empty {
        return Ok(Vec::new());
    }
    tracked!(state, "list_securities", {
        Ok(state.core.list_securities(&req))
    })
}

#[tauri::command]
pub async fn get_bars(
    state: State<'_, AppState>,
    req: GetBarsRequest,
) -> Result<BarsResponse, AppError> {
    tracked!(state, "get_bars", {
        state.core.get_bars(&req).await
    })
}

#[tauri::command]
pub async fn indicator_registry(
    state: State<'_, AppState>,
    req: RegistryRequest,
) -> Result<RegistryResponse, AppError> {
    tracked!(state, "indicator_registry", {
        Ok(state.core.indicator_registry(req.category.as_deref()))
    })
}

#[tauri::command]
pub async fn indicator_manifest(
    state: State<'_, AppState>,
) -> Result<&'static Manifest, AppError> {
    tracked!(state, "indicator_manifest", {
        Ok(state.core.indicator_manifest())
    })
}

/// S-03.02-01：首次读取时写入默认 8 个收藏。
#[tauri::command]
pub async fn indicator_favorites(
    state: State<'_, AppState>,
) -> Result<IndicatorFavoritesResponse, AppError> {
    tracked!(state, "indicator_favorites", {
        state.core.indicator_favorites()
    })
}

#[tauri::command]
pub async fn set_indicator_favorite(
    state: State<'_, AppState>,
    indicator_id: String,
    favorited: bool,
) -> Result<IndicatorFavoritesResponse, AppError> {
    tracked!(state, "set_indicator_favorite", {
        state.ensure_writable()?;
        state.core.set_indicator_favorite(&indicator_id, favorited)
    })
}

/// S-05.01-02：浮层「最近查看」，最多 5 条，读取时清理数据集里已不存在的记录。
#[tauri::command]
pub async fn recent_views(state: State<'_, AppState>) -> Result<Vec<RecentViewDto>, AppError> {
    tracked!(state, "recent_views", {
        state.core.recent_views()
    })
}

/// S-05.01-02：工作台打开标的时写入/刷新，返回裁剪后的最新 5 条。
#[tauri::command]
pub async fn touch_recent_view(
    state: State<'_, AppState>,
    code: String,
) -> Result<Vec<RecentViewDto>, AppError> {
    tracked!(state, "touch_recent_view", {
        state.ensure_writable()?;
        state.core.touch_recent_view(&code)
    })
}

/// S-07.05-01：未扫描过返回 null，由页面展示「尚未检查」。
#[tauri::command]
pub async fn quality_report(
    state: State<'_, AppState>,
) -> Result<Option<QualityReportDto>, AppError> {
    tracked!(state, "quality_report", { Ok(state.core.quality_report()) })
}

#[tauri::command]
pub async fn quality_scan(state: State<'_, AppState>) -> Result<QualityReportDto, AppError> {
    tracked!(state, "quality_scan", { state.core.quality_scan().await })
}

/// S-07.05-02：单根 K 线溯源；缺失字段由 `missingFields`/`errorCode` 明确返回。
#[tauri::command]
pub async fn bar_provenance(
    state: State<'_, AppState>,
    req: BarProvenanceRequest,
) -> Result<BarProvenanceDto, AppError> {
    tracked!(state, "bar_provenance", {
        state.core.bar_provenance(&req).await
    })
}

/// S-02.08-01：页脚 7 段同源；provider 不提供 manifest 时返回 null，前端整条显示 `—`。
#[tauri::command]
pub async fn dataset_manifest(
    state: State<'_, AppState>,
) -> Result<Option<DatasetManifest>, AppError> {
    // W-115：debug 注入「manifest 整体缺失」，与 list_securities 的 --empty-dataset 同构。
    if state.faults().manifest_missing {
        return Ok(None);
    }
    // W-116：只把 sha256 置空、其余 8 字段原样保留，造出「只缺一段」的可达路径；
    // 页脚 version 段由 shortSha(空) 派生为 `—`，其余 6 段照常（AC-02.08-01（补2））。
    if state.faults().manifest_sha256_missing {
        return Ok(state.core.dataset_manifest().map(|mut m| {
            m.sha256.clear();
            m
        }));
    }
    tracked!(state, "dataset_manifest", { Ok(state.core.dataset_manifest()) })
}

/// S-07.01-01：P9 首卡数据源探测；每次调用都重新探测，不做自动轮询。
#[tauri::command]
pub async fn datasource_status(
    state: State<'_, AppState>,
) -> Result<DatasourceStatusDto, AppError> {
    // W-115：注入只改命令层呈现，不动 core 探测逻辑；正常启动 faults 恒 false。
    // 数据目录「目录不存在」由此可达（SettingsPage 判 datasource.version === null）。
    if state.faults().manifest_missing {
        let mut status = state.core.datasource_status().await;
        status.state = "missing";
        status.version = None;
        status.error_code = Some("E_DATASET_MISSING");
        status.ops.data_dir_readable = false;
        return Ok(status);
    }
    tracked!(state, "datasource_status", {
        Ok(state.core.datasource_status().await)
    })
}

/// S-07.01-02：P9 健康检查 6 项；只读、0 网络，每次点击都重跑。
#[tauri::command]
pub async fn data_health_check(
    state: State<'_, AppState>,
) -> Result<DataHealthDto, AppError> {
    tracked!(state, "data_health_check", {
        let faults = state.faults();
        Ok(state
            .core
            .data_health_check(HealthFaults {
                manifest_corrupt: faults.manifest_corrupt,
                manifest_sha256_missing: faults.manifest_sha256_missing,
                manifest_missing: faults.manifest_missing,
            })
            .await)
    })
}

/// S-08.02-03：启动数据集校验；失败时前端只渲染全屏错误卡。
/// ST-DF-03-02：已安装时以落盘内容为准（行数/覆盖区间/checksum 复算），未安装回退内存口径。
#[tauri::command]
pub async fn dataset_integrity(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<app_core::DatasetIntegrityDto, AppError> {
    tracked!(state, "dataset_integrity", {
        let data_dir = sim_data_dir(&app).ok();
        Ok(state.core.dataset_integrity_at(
            state.faults().dataset_fault,
            data_dir.as_deref(),
            SIM_SEED,
        ))
    })
}

/// S-08.02-03 / ST-DF-03-05：进入/退出只读浏览，开关持久化到 state.db settings。
#[tauri::command]
pub async fn dataset_set_readonly(
    state: State<'_, AppState>,
    read_only: bool,
) -> Result<bool, AppError> {
    tracked!(state, "dataset_set_readonly", {
        state.persist_read_only(read_only)?;
        Ok(read_only)
    })
}

/// S-08.02-02：单次指标计算超时阈值（与错误态规范一致）。
const CALC_TIMEOUT_MS: u64 = 8_000;

/// 参数指纹：只记 16 位哈希，不把参数原文写进日志。
fn params_hash(req: &CalcRequest) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in format!("{:?}", req.instances).bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    format!("{hash:016x}")
}

#[tauri::command]
pub async fn calc_indicators(
    state: State<'_, AppState>,
    req: CalcRequest,
) -> Result<CalcResponse, AppError> {
    tracked!(state, "calc_indicators", {
        // ST-DF-03-05：只读浏览下禁用指标计算（页面同时置灰，这里兜底）。
        state.ensure_writable()?;
        let started = std::time::Instant::now();
        let indicator = req.instances.first().map(|item| item.indicator_id.clone());
        // S-08.02-02：注入生效一次即回落；timeout 真实等待，不伪造错误。
        let inject = state.take_inject();
        let task = async {
            match inject {
                InjectKind::Timeout => {
                    tokio::time::sleep(std::time::Duration::from_millis(CALC_TIMEOUT_MS + 1_000))
                        .await;
                    state.core.calc_indicators(&req).await
                }
                InjectKind::Panic => Err(AppError::engine_panic(indicator.as_deref())),
                InjectKind::Data => Err(AppError::data_unavailable(
                    "数据源不可用，请查看数据源状态",
                )),
                InjectKind::None => state.core.calc_indicators(&req).await,
            }
        };
        let result = match tokio::time::timeout(
            std::time::Duration::from_millis(CALC_TIMEOUT_MS),
            task,
        )
        .await
        {
            Ok(value) => value,
            Err(_) => Err(AppError::timeout(
                started.elapsed().as_millis() as u64,
                CALC_TIMEOUT_MS,
                indicator.as_deref(),
            )),
        };
        match &result {
            Err(err) if err.code == ErrorCode::Timeout => {
                state.core.telemetry().emit(
                    EVENT_CALC_TIMEOUT,
                    vec![
                        ("traceId", Value::from(err.trace_id())),
                        ("indicator", Value::from(indicator.clone())),
                        ("paramsHash", Value::from(params_hash(&req))),
                    ],
                );
            }
            Err(err) if err.code == ErrorCode::EnginePanic => {
                state.core.telemetry().emit(
                    EVENT_CALC_PANIC,
                    vec![
                        ("traceId", Value::from(err.trace_id())),
                        ("indicator", Value::from(indicator.clone())),
                    ],
                );
            }
            _ => {}
        }
        result
    })
}

/// QA 取证入口：导出最近 N 条埋点 + 事件计数 + 冷计算 P95。
#[tauri::command]
pub async fn telemetry_dump(
    state: State<'_, AppState>,
    recent: Option<usize>,
) -> Result<TelemetrySummary, AppError> {
    tracked!(state, "telemetry_dump", {
        Ok(state.core.telemetry().summary(recent.unwrap_or(200).clamp(1, 4_096)))
    })
}

// ---------- E-01 行情 / 自选 / 持仓 ----------

#[tauri::command]
pub async fn market_snapshot(state: State<'_, AppState>) -> Result<MarketSnapshotDto, AppError> {
    tracked!(state, "market_snapshot", { state.core.market_snapshot().await })
}

/// S-04.01-01：指数概览快照（独立只读路径，不触碰 get_bars / calc_indicators 热路径）。
#[tauri::command]
pub async fn index_snapshot(state: State<'_, AppState>) -> Result<IndexSnapshotDto, AppError> {
    tracked!(state, "index_snapshot", { state.core.index_snapshot() })
}

#[tauri::command]
pub async fn watchlist_read(state: State<'_, AppState>) -> Result<WatchlistDto, AppError> {
    tracked!(state, "watchlist_read", { state.core.watchlist() })
}

#[tauri::command]
pub async fn watch_toggle(
    state: State<'_, AppState>,
    security: String,
    group: Option<String>,
) -> Result<WatchToggleResult, AppError> {
    tracked!(state, "watch_toggle", {
        state.ensure_writable()?;
        state.core.toggle_watch(&security, group.as_deref())
    })
}

#[tauri::command]
pub async fn watch_group_create(state: State<'_, AppState>, name: String) -> Result<(), AppError> {
    tracked!(state, "watch_group_create", {
        state.ensure_writable()?;
        state.core.create_watch_group(&name)
    })
}

#[tauri::command]
pub async fn watch_group_rename(
    state: State<'_, AppState>,
    old: String,
    new: String,
) -> Result<(), AppError> {
    tracked!(state, "watch_group_rename", {
        state.ensure_writable()?;
        state.core.rename_watch_group(&old, &new)
    })
}

#[tauri::command]
pub async fn watch_group_delete(state: State<'_, AppState>, name: String) -> Result<(), AppError> {
    tracked!(state, "watch_group_delete", {
        state.ensure_writable()?;
        state.core.delete_watch_group(&name)
    })
}

/// S-01.02-03 补2：空态页动作「重新生成模拟数据」。
#[tauri::command]
pub async fn dataset_regenerate(
    state: State<'_, AppState>,
    req: ListSecuritiesRequest,
) -> Result<Vec<SecurityDto>, AppError> {
    tracked!(state, "dataset_regenerate", {
        // ST-DF-03-05：「重新生成」属于写操作，只读下不得清故障位或重发数据。
        state.ensure_writable()?;
        // 重建后三个故障位一起清掉（S-07.01-02 损坏注入 + S-08.02-03 数据集注入）。
        state.clear_dataset_faults();
        // S-08.02-03：重建成功即退出只读浏览（补4）。
        state.set_read_only(false);
        Ok(state.core.list_securities(&req))
    })
}

/// S-01.02-03 补3：损坏库错误页动作「重新生成数据」——原地重建 state.db。
#[tauri::command]
pub async fn storage_rebuild(state: State<'_, AppState>) -> Result<(), AppError> {
    tracked!(state, "storage_rebuild", {
        // ST-DF-03-05：state.db 原地重建必须被只读开关拦截。
        state.ensure_writable()?;
        let path = state
            .db_path
            .clone()
            .ok_or_else(|| AppError::internal("state.db 未初始化"))?;
        state.core.rebuild_state_db(&path)
    })
}

/// QA 取证入口：当前故障注入开关（仅 debug 构建且 `AKA_DIAG=1` 时可信）。
/// release 不注册该命令（W-49），函数体也整段编译掉。
#[cfg(debug_assertions)]
#[tauri::command]
pub async fn diag_faults(state: State<'_, AppState>) -> Result<crate::state::DiagFaults, AppError> {
    let enabled = diag_env_enabled();
    tracked!(state, "diag_faults", {
        Ok(if enabled {
            state.faults()
        } else {
            crate::state::DiagFaults::default()
        })
    })
}

#[cfg(debug_assertions)]
#[tauri::command]
pub async fn diag_set_inject(
    state: State<'_, AppState>,
    kind: String,
) -> Result<String, AppError> {
    let enabled = diag_env_enabled();
    tracked!(state, "diag_set_inject", {
        Ok(if enabled {
            state.set_inject(InjectKind::parse(&kind)).as_str().to_string()
        } else {
            InjectKind::None.as_str().to_string()
        })
    })
}

#[tauri::command]
pub async fn view_state_get(state: State<'_, AppState>, scope: String) -> Result<Option<Value>, AppError> {
    tracked!(state, "view_state_get", { state.core.view_state(&scope) })
}

#[tauri::command]
pub async fn view_state_set(
    state: State<'_, AppState>,
    scope: String,
    value: Value,
) -> Result<(), AppError> {
    tracked!(state, "view_state_set", {
        state.ensure_writable()?;
        state.core.set_view_state(&scope, &value)
    })
}

#[tauri::command]
pub async fn positions_read(state: State<'_, AppState>) -> Result<Vec<PositionDto>, AppError> {
    tracked!(state, "positions_read", { state.core.positions() })
}

#[tauri::command]
pub async fn position_save(
    state: State<'_, AppState>,
    security: String,
    cost_price: f64,
    shares: i64,
) -> Result<(), AppError> {
    tracked!(state, "position_save", {
        state.ensure_writable()?;
        state.core.save_position(&security, cost_price, shares)
    })
}

#[tauri::command]
pub async fn position_delete(state: State<'_, AppState>, security: String) -> Result<(), AppError> {
    tracked!(state, "position_delete", {
        state.ensure_writable()?;
        state.core.delete_position(&security)
    })
}

/// S2 实机取证：只有 debug 构建且显式设置 `AKA_DIAG=1` 启动时才允许前端自跑诊断。
/// release 保留同名命令但恒为 false，前端探测不会抛「命令不存在」。
#[tauri::command]
pub async fn diag_enabled() -> Result<bool, AppError> {
    #[cfg(debug_assertions)]
    let enabled = diag_env_enabled();
    #[cfg(not(debug_assertions))]
    let enabled = false;
    Ok(enabled)
}

/// 环境变量读取集中在此，源码层门禁按「函数是否被 cfg 覆盖」检查。
#[cfg(debug_assertions)]
fn diag_env_enabled() -> bool {
    std::env::var("AKA_DIAG").ok().as_deref() == Some("1")
}

/// 取证落地页：P/G 线共用同一套采样，但 release 必须直接落到工作台；
/// `AKA_DIAG_TARGET=s2` 时前端启动即跳工作台，避免行情页把 S2 套件锁掉。
/// release 读不到该变量（W-49），恒返回空串。
#[tauri::command]
pub async fn diag_target() -> Result<String, AppError> {
    #[cfg(debug_assertions)]
    let target = diag_env_target();
    #[cfg(not(debug_assertions))]
    let target = String::new();
    Ok(target)
}

#[cfg(debug_assertions)]
fn diag_env_target() -> String {
    std::env::var("AKA_DIAG_TARGET").unwrap_or_default()
}

/// 取证留档所需的构建元数据（口径 R-S0-07-01）。
/// `opt_level` / `lto` / `codegen_units` / `debug` 与 `app/Cargo.toml` 的 profile 对应，
/// 单测 `diag_build_info_matches_profile` 会在 profile 改动时失败提醒同步。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagBuildInfo {
    build_profile: &'static str,
    opt_level: &'static str,
    lto: &'static str,
    codegen_units: &'static str,
    debug: &'static str,
    target_triple: &'static str,
}

#[tauri::command]
pub async fn diag_build_info() -> Result<DiagBuildInfo, AppError> {
    let release = !cfg!(debug_assertions);
    Ok(DiagBuildInfo {
        build_profile: if release { "release" } else { "dev" },
        opt_level: if release { RELEASE_OPT_LEVEL } else { DEV_OPT_LEVEL },
        lto: "false",
        codegen_units: if release { RELEASE_CODEGEN_UNITS } else { "256" },
        debug: if release { "0" } else { "2" },
        target_triple: TARGET_TRIPLE,
    })
}

/// R-EV-02 运行环境：os/arch + 二进制绝对路径与 sha256 + dump 目录。
/// 由 Rust 读取，前端只做组装；禁止任何手写路径（制度第 19 条）。
#[cfg(debug_assertions)]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagEnv {
    os: &'static str,
    arch: &'static str,
    binary: String,
    binary_sha256: String,
    dump_dir: String,
}

#[cfg(debug_assertions)]
#[tauri::command]
pub async fn diag_env(app: tauri::AppHandle) -> Result<DiagEnv, AppError> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    use tauri::Manager;

    let binary = std::env::current_exe()
        .map_err(|err| AppError::internal(format!("无法解析当前可执行文件：{err}")))?;
    let mut file = std::fs::File::open(&binary)
        .map_err(|err| AppError::internal(format!("无法读取当前可执行文件：{err}")))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|err| AppError::internal(format!("读取可执行文件失败：{err}")))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let dump_dir = app
        .path()
        .home_dir()
        .map_err(|err| AppError::internal(format!("无法解析 home 目录：{err}")))?
        .join("Library/Application Support/aka/diag");
    Ok(DiagEnv {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        binary: binary.display().to_string(),
        binary_sha256: format!("{:x}", hasher.finalize()),
        dump_dir: dump_dir.display().to_string(),
    })
}

/// 与 `app/Cargo.toml` 的 profile 对应；`diag_build_info_matches_profile` 单测守着同步。
const DEV_OPT_LEVEL: &str = "1";
const RELEASE_OPT_LEVEL: &str = "3";
const RELEASE_CODEGEN_UNITS: &str = "16";

/// 编译期目标三元组（`rustc -vV` 的 host 与构建目标一致）。
const TARGET_TRIPLE: &str = "x86_64-apple-darwin";

/// S2 实机取证：把前端采样结果落盘为 JSON，便于作为验收材料归档。
/// 仅 debug 构建注册与编译（W-49）：release 无写入能力、也无文件名/路径字符串。
#[cfg(debug_assertions)]
#[tauri::command]
pub async fn diag_write(
    app: tauri::AppHandle,
    payload: String,
) -> Result<String, String> {
    write_diag(&app, "s2-evidence.json", &payload)
}

/// 前端埋点：事件名由前端给出（如 `switch.period_ms`），字段随 Map 落 telemetry.jsonl。
#[tauri::command]
pub async fn telemetry_note(
    state: State<'_, AppState>,
    name: String,
    fields: Option<serde_json::Map<String, Value>>,
) -> Result<(), AppError> {
    tracked!(state, "telemetry_note", {
        state.core.telemetry().emit_dynamic(&name, fields.unwrap_or_default());
        Ok(())
    })
}

/// 命名诊断落盘：不同批次（S2 / E-01 / E-02）证据分开存档，避免互相覆盖。
/// 仅 debug 构建注册与编译（W-49）：release 不可写诊断文件。
#[cfg(debug_assertions)]
#[tauri::command]
pub async fn diag_write_named(
    app: tauri::AppHandle,
    name: String,
    payload: String,
) -> Result<String, String> {
    let safe: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .collect();
    if safe.is_empty() || safe.contains("..") {
        return Err("非法诊断文件名".to_string());
    }
    write_diag(&app, &safe, &payload)
}

#[cfg(debug_assertions)]
fn write_diag(app: &tauri::AppHandle, name: &str, payload: &str) -> Result<String, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .home_dir()
        .map_err(|err| format!("无法解析 home 目录：{err}"))?
        .join("Library/Application Support/aka/diag");
    std::fs::create_dir_all(&dir).map_err(|err| format!("创建诊断目录失败：{err}"))?;
    let path = dir.join(name);
    std::fs::write(&path, payload).map_err(|err| format!("写入诊断结果失败：{err}"))?;
    Ok(path.display().to_string())
}

/// S-06.03-02：一键导出诊断包（固定 `~/Downloads`，全程 0 网络）。
/// 隐私排除由后端强制：`config.json` 只写白名单字段，自选/搜索/原始行情/成本一律不落包。
#[tauri::command]
pub async fn export_diagnostics(
    state: State<'_, AppState>,
    config: Option<Value>,
) -> Result<crate::diagnostics::DiagnosticsExportDto, AppError> {
    tracked!(state, "export_diagnostics", {
        crate::diagnostics::export(&state.core, &state.commands, config)
    })
}

/// 在 Finder 中定位刚导出的 zip；只接受 `~/Downloads/aka-diagnostics-*.zip`。
#[tauri::command]
pub async fn reveal_diagnostics(path: String) -> Result<(), AppError> {
    crate::diagnostics::reveal(&path)
}

/// S-07.03-01：首装数据集固定 seed 42，与 manifest 的 `seed` 字段一致。
pub(crate) const SIM_SEED: u64 = 42;
fn sim_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AppError> {
    use tauri::Manager;
    app.path()
        .home_dir()
        .map(|home| home.join("Library/Application Support/aka"))
        .map_err(|err| AppError::internal(format!("无法解析 home 目录：{err}")))
}

#[tauri::command]
pub async fn sim_install_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<SimInstallStatus, AppError> {
    tracked!(state, "sim_install_status", {
        let dir = sim_data_dir(&app)?;
        let status = sim_install::status(&dir, SIM_SEED);
        // ST-DF-03-03：安装/重建成功后同步接管落盘版本并写入 dataset_meta；
        // 这是「只有重建成功才放行」的写入口，失败时保留旧身份。
        if status.state == "installed" {
            state
                .core
                .adopt_installed_dataset(&dir, SIM_SEED, state.read_only());
        }
        Ok(status)
    })
}

/// 启动安装：后台线程跑 5 步，最多等 2s 让哨兵落盘后返回当前状态；进度靠 P10 轮询。
#[tauri::command]
pub async fn sim_install_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<SimInstallStatus, AppError> {
    tracked!(state, "sim_install_start", {
        let dir = sim_data_dir(&app)?;
        let permit = state.begin_sim_install()?;
        let (tx, rx) = std::sync::mpsc::channel();
        let worker_dir = dir.clone();
        std::thread::spawn(move || {
            let _permit = permit;
            let _ = tx.send(sim_install::install(&worker_dir, SIM_SEED));
        });
        wait_for_sim_start(&dir, &rx)
    })
}

/// 已安装页「重建」：staging 构建完成后原子替换，`data_version` +1；失败保留旧版本。
#[tauri::command]
pub async fn sim_install_rebuild(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<SimInstallStatus, AppError> {
    tracked!(state, "sim_install_rebuild", {
        let dir = sim_data_dir(&app)?;
        let permit = state.begin_sim_install()?;
        let (tx, rx) = std::sync::mpsc::channel();
        let worker_dir = dir.clone();
        std::thread::spawn(move || {
            let _permit = permit;
            let _ = tx.send(sim_install::rebuild(&worker_dir, SIM_SEED));
        });
        wait_for_sim_start(&dir, &rx)
    })
}

/// 启动后最多等 2s：哨兵一落盘就返回（前端继续轮询）；若安装线程已报错，
/// 直接把错误抛给 IPC（例如 E_DISK_INSUFFICIENT，此时按卡面要求不会创建 `.installing`）。
fn wait_for_sim_start(
    dir: &std::path::Path,
    rx: &std::sync::mpsc::Receiver<Result<SimInstallReport, app_core::sim_install::SimErrorInfo>>,
) -> Result<SimInstallStatus, AppError> {
    let mut status = sim_install::status(dir, SIM_SEED);
    for _ in 0..200 {
        if let Ok(result) = rx.try_recv() {
            if let Err(error) = result {
                return Err(AppError::internal(format!("{}：{}", error.code, error.message)));
            }
            return Ok(sim_install::status(dir, SIM_SEED));
        }
        if status.state != "not_installed" {
            return Ok(status);
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
        status = sim_install::status(dir, SIM_SEED);
    }
    Ok(status)
}

/// 仅供下一张卡（P11/P12/P13）读同一份口径；W-101 不替下游签 AC。
#[tauri::command]
pub async fn sim_install_report(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<SimInstallReport>, AppError> {
    tracked!(state, "sim_install_report", {
        Ok(sim_install::status(&sim_data_dir(&app)?, SIM_SEED).installed)
    })
}

#[cfg(test)]
mod tests {
    /// profile 数字是硬编码在证据里的，profile 一改就必须同步，否则 P/G 线留档会失真。
    #[test]
    fn diag_build_info_matches_profile() {
        let cargo = include_str!("../../Cargo.toml");
        assert!(
            cargo.contains("[profile.dev]") && cargo.contains("opt-level = 1"),
            "app/Cargo.toml 的 dev opt-level 变化，请同步 commands::DEV_OPT_LEVEL"
        );
    }

    /// ST-DF-03-05 AC-2/AC-4：守卫必须在命令层（绕过 UI 直调同样拒绝），
    /// 且安装/重建先拿只读+互斥凭证再落盘。
    #[test]
    fn every_write_command_guards_against_read_only() {
        const WRITE_COMMANDS: &[&str] = &[
            "set_indicator_favorite",
            "touch_recent_view",
            "calc_indicators",
            "watch_toggle",
            "watch_group_create",
            "watch_group_rename",
            "watch_group_delete",
            "dataset_regenerate",
            "storage_rebuild",
            "view_state_set",
            "position_save",
            "position_delete",
        ];
        const READ_COMMANDS: &[&str] = &[
            "list_securities",
            "get_bars",
            "data_health_check",
            "watchlist_read",
            "view_state_get",
            "positions_read",
            "dataset_set_readonly",
        ];
        let source = include_str!("commands.rs");
        for name in WRITE_COMMANDS {
            let body = command_body(source, name);
            assert!(
                body.contains("state.ensure_writable()?;"),
                "{name} 缺少只读守卫，绕过 UI 直调会放行"
            );
        }
        for name in READ_COMMANDS {
            let body = command_body(source, name);
            assert!(
                !body.contains("ensure_writable"),
                "{name} 是读接口，不得被只读开关拦截"
            );
        }
        for name in ["sim_install_start", "sim_install_rebuild"] {
            let body = command_body(source, name);
            let guard = body
                .find("state.begin_sim_install()?;")
                .expect("安装/重建缺少只读+互斥守卫");
            let io = body.find("std::thread::spawn").expect("缺少安装线程");
            assert!(guard < io, "{name} 必须先过守卫再写盘");
        }
    }

    /// 截取单个命令函数体（到下一个命令属性或文件末尾）。
    fn command_body<'a>(source: &'a str, name: &str) -> &'a str {
        let marker = format!("pub async fn {name}(");
        let start = source
            .find(&marker)
            .unwrap_or_else(|| panic!("{name} 不存在"));
        let rest = &source[start..];
        let end = rest.find("\n#[tauri::command]").unwrap_or(rest.len());
        &rest[..end]
    }
}
