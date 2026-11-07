//! IPC 命令层：只做「反序列化 → 调 AppCore → 错误映射」，不写业务逻辑。
//! 新增命令必须保持在这个形状，超过 15 行说明业务该下沉到 app-core。

use app_core::{
    AppError, BarsResponse, CalcRequest, CalcResponse, DatasetManifest, GetBarsRequest,
    ListSecuritiesRequest, Manifest, MarketSnapshotDto, PositionDto, RegistryRequest,
    RegistryResponse, SecurityDto, TelemetrySummary, WatchToggleResult, WatchlistDto,
};
use serde_json::Value;
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn list_securities(
    state: State<'_, AppState>,
    req: ListSecuritiesRequest,
) -> Result<Vec<SecurityDto>, AppError> {
    // QA 注入（`--empty-dataset`）：模拟数据源返回 0 只，自选页展示「当前数据集为空」。
    if state.faults().dataset_empty {
        return Ok(Vec::new());
    }
    Ok(state.core.list_securities(&req))
}

#[tauri::command]
pub async fn get_bars(
    state: State<'_, AppState>,
    req: GetBarsRequest,
) -> Result<BarsResponse, AppError> {
    state.core.get_bars(&req).await
}

#[tauri::command]
pub async fn indicator_registry(
    state: State<'_, AppState>,
    req: RegistryRequest,
) -> Result<RegistryResponse, AppError> {
    Ok(state.core.indicator_registry(req.category.as_deref()))
}

#[tauri::command]
pub async fn indicator_manifest(
    state: State<'_, AppState>,
) -> Result<&'static Manifest, AppError> {
    Ok(state.core.indicator_manifest())
}

/// S-02.08-01：页脚 7 段同源；provider 不提供 manifest 时返回 null，前端整条显示 `—`。
#[tauri::command]
pub async fn dataset_manifest(
    state: State<'_, AppState>,
) -> Result<Option<DatasetManifest>, AppError> {
    Ok(state.core.dataset_manifest())
}

#[tauri::command]
pub async fn calc_indicators(
    state: State<'_, AppState>,
    req: CalcRequest,
) -> Result<CalcResponse, AppError> {
    state.core.calc_indicators(&req).await
}

/// QA 取证入口：导出最近 N 条埋点 + 事件计数 + 冷计算 P95。
#[tauri::command]
pub async fn telemetry_dump(
    state: State<'_, AppState>,
    recent: Option<usize>,
) -> Result<TelemetrySummary, AppError> {
    Ok(state.core.telemetry().summary(recent.unwrap_or(200).clamp(1, 4_096)))
}

// ---------- E-01 行情 / 自选 / 持仓 ----------

#[tauri::command]
pub async fn market_snapshot(state: State<'_, AppState>) -> Result<MarketSnapshotDto, AppError> {
    state.core.market_snapshot().await
}

#[tauri::command]
pub async fn watchlist_read(state: State<'_, AppState>) -> Result<WatchlistDto, AppError> {
    state.core.watchlist()
}

#[tauri::command]
pub async fn watch_toggle(
    state: State<'_, AppState>,
    security: String,
    group: Option<String>,
) -> Result<WatchToggleResult, AppError> {
    state.core.toggle_watch(&security, group.as_deref())
}

#[tauri::command]
pub async fn watch_group_create(state: State<'_, AppState>, name: String) -> Result<(), AppError> {
    state.core.create_watch_group(&name)
}

#[tauri::command]
pub async fn watch_group_rename(
    state: State<'_, AppState>,
    old: String,
    new: String,
) -> Result<(), AppError> {
    state.core.rename_watch_group(&old, &new)
}

#[tauri::command]
pub async fn watch_group_delete(state: State<'_, AppState>, name: String) -> Result<(), AppError> {
    state.core.delete_watch_group(&name)
}

/// S-01.02-03 补2：空态页动作「重新生成模拟数据」。
#[tauri::command]
pub async fn dataset_regenerate(
    state: State<'_, AppState>,
    req: ListSecuritiesRequest,
) -> Result<Vec<SecurityDto>, AppError> {
    state.set_dataset_empty(false);
    Ok(state.core.list_securities(&req))
}

/// S-01.02-03 补3：损坏库错误页动作「重新生成数据」——原地重建 state.db。
#[tauri::command]
pub async fn storage_rebuild(state: State<'_, AppState>) -> Result<(), AppError> {
    let path = state
        .db_path
        .clone()
        .ok_or_else(|| AppError::internal("state.db 未初始化"))?;
    state.core.rebuild_state_db(&path)
}

/// QA 取证入口：当前故障注入开关（仅 debug 构建且 `AKA_DIAG=1` 时可信）。
/// release 不注册该命令（W-49），函数体也整段编译掉。
#[cfg(debug_assertions)]
#[tauri::command]
pub async fn diag_faults(state: State<'_, AppState>) -> Result<crate::state::DiagFaults, AppError> {
    if std::env::var("AKA_DIAG").ok().as_deref() != Some("1") {
        return Ok(crate::state::DiagFaults::default());
    }
    Ok(state.faults())
}

#[tauri::command]
pub async fn view_state_get(state: State<'_, AppState>, scope: String) -> Result<Option<Value>, AppError> {
    state.core.view_state(&scope)
}

#[tauri::command]
pub async fn view_state_set(
    state: State<'_, AppState>,
    scope: String,
    value: Value,
) -> Result<(), AppError> {
    state.core.set_view_state(&scope, &value)
}

#[tauri::command]
pub async fn positions_read(state: State<'_, AppState>) -> Result<Vec<PositionDto>, AppError> {
    state.core.positions()
}

#[tauri::command]
pub async fn position_save(
    state: State<'_, AppState>,
    security: String,
    cost_price: f64,
    shares: i64,
) -> Result<(), AppError> {
    state.core.save_position(&security, cost_price, shares)
}

#[tauri::command]
pub async fn position_delete(state: State<'_, AppState>, security: String) -> Result<(), AppError> {
    state.core.delete_position(&security)
}

/// S2 实机取证：只有 debug 构建且显式设置 `AKA_DIAG=1` 启动时才允许前端自跑诊断。
/// release 保留同名命令但恒为 false，前端探测不会抛「命令不存在」。
#[tauri::command]
pub async fn diag_enabled() -> Result<bool, AppError> {
    #[cfg(debug_assertions)]
    let enabled = std::env::var("AKA_DIAG").ok().as_deref() == Some("1");
    #[cfg(not(debug_assertions))]
    let enabled = false;
    Ok(enabled)
}

/// 取证落地页：P/G 线共用同一套采样，但 release 必须直接落到工作台；
/// `AKA_DIAG_TARGET=s2` 时前端启动即跳工作台，避免行情页把 S2 套件锁掉。
/// release 读不到该变量（W-49），恒返回空串。
#[tauri::command]
pub async fn diag_target() -> Result<String, AppError> {
    #[cfg(debug_assertions)]
    let target = std::env::var("AKA_DIAG_TARGET").unwrap_or_default();
    #[cfg(not(debug_assertions))]
    let target = String::new();
    Ok(target)
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
    state.core.telemetry().emit_dynamic(&name, fields.unwrap_or_default());
    Ok(())
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
}
