//! IPC 命令层：只做「反序列化 → 调 AppCore → 错误映射」，不写业务逻辑。
//! 新增命令必须保持在这个形状，超过 15 行说明业务该下沉到 app-core。

use app_core::{
    AppError, BarsResponse, CalcRequest, CalcResponse, GetBarsRequest, ListSecuritiesRequest,
    Manifest, MarketSnapshotDto, PositionDto, RegistryRequest, RegistryResponse, SecurityDto,
    TelemetrySummary, WatchToggleResult, WatchlistDto,
};
use serde_json::Value;
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn list_securities(
    state: State<'_, AppState>,
    req: ListSecuritiesRequest,
) -> Result<Vec<SecurityDto>, AppError> {
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

/// S2 实机取证：只有显式设置 `AKA_DIAG=1` 启动时才允许前端自跑诊断。
#[tauri::command]
pub async fn diag_enabled() -> Result<bool, AppError> {
    Ok(std::env::var("AKA_DIAG").ok().as_deref() == Some("1"))
}

/// S2 实机取证：把前端采样结果落盘为 JSON，便于作为验收材料归档。
#[tauri::command]
pub async fn diag_write(
    app: tauri::AppHandle,
    payload: String,
) -> Result<String, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .home_dir()
        .map_err(|err| format!("无法解析 home 目录：{err}"))?
        .join("Library/Application Support/aka/diag");
    std::fs::create_dir_all(&dir).map_err(|err| format!("创建诊断目录失败：{err}"))?;
    let path = dir.join("s2-evidence.json");
    std::fs::write(&path, payload).map_err(|err| format!("写入诊断结果失败：{err}"))?;
    Ok(path.display().to_string())
}
