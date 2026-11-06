//! IPC 命令层：只做「反序列化 → 调 AppCore → 错误映射」，不写业务逻辑。
//! 新增命令必须保持在这个形状，超过 15 行说明业务该下沉到 app-core。

use app_core::{
    AppError, BarsResponse, CalcRequest, CalcResponse, GetBarsRequest, ListSecuritiesRequest,
    Manifest, RegistryRequest, RegistryResponse, SecurityDto, TelemetrySummary,
};
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
