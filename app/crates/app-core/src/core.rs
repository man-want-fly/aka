use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use data_provider::mock::MockProvider;
use data_provider::{
    aggregate_bars, Adjust, AggregatePeriod, BarBatch, BarRequest, DataProvider, Date,
    QualityFlag, Security, Timeframe,
};
use data_store::state_db::{AddWatchOutcome, StateDb};
use data_store::{CacheStats, Candle, CandleSeries, CandleStore, SeriesKey};
use indicator_core::manifest as registry;
use indicator_core::{
    all, implemented_count, lookup, merge_defaults, validate, CalcError, Category, Indicator,
    ManifestParam, OhlcvView, ParamError, Params, ENGINE_VERSION, PLANNED_INDICATOR_COUNT,
};

use crate::dto::{
    BarDto, BarProvenanceDto, BarProvenanceRequest, BarsResponse, CalcRequest, CalcResponse,
    DatasetFault, DatasetIntegrityDto, DatasetVersionDto, DataHealthDto, DataHealthItemDto,
    DatasourceCapabilityDto, DatasourceOpsDto, DatasourceStatusDto,
    GetBarsRequest, IndicatorFavoriteDto, IndicatorFavoritesResponse, IndicatorMetaDto, InputsDto,
    ListSecuritiesRequest, MarketRowDto,
    MarketSnapshotDto, OutputSeriesDto, OutputSpecDto, PositionDto, ProvenanceDto,
    QualityCheckDto, QualityExampleDto, QualityReportDto, RangeDto, RecentViewDto, RegistryResponse,
    SecurityDto,
    SeriesDto, WatchGroupDto, WatchItemDto, WatchToggleResult, WatchlistDto,
};
use serde_json::Value;

use crate::error::{trace_id, AppError, ErrorCode};
use crate::quality::{self, SecurityQualityInput};
use crate::telemetry::{
    Telemetry, EVENT_CACHE_HIT, EVENT_CACHE_MISS, EVENT_COMPUTE_COUNT, EVENT_COMPUTE_SKIP,
    EVENT_INDEFINITE, EVENT_INDICATOR_COMPUTE,
};

/// 质量扫描完成事件（JSONL 与内存环形队列同源）。
pub const EVENT_QUALITY_SCAN: &str = "quality.scan";
/// S-07.01-01：数据源探测事件（各能力状态）。
pub const EVENT_DATASOURCE_PROBE: &str = "datasource.probe";
/// S-07.01-02：健康检查事件（通过数 / 总耗时）。
pub const EVENT_HEALTH_CHECK: &str = "health.check";
/// S-08.02-02：计算超时（trace id / 指标 / 参数哈希）。
pub const EVENT_CALC_TIMEOUT: &str = "calc.timeout";
/// S-08.02-02：引擎异常（trace id / 指标）。
pub const EVENT_CALC_PANIC: &str = "calc.panic";
/// S-08.02-03：启动校验失败（错误分类 / trace id / 数据集路径）。
pub const EVENT_DATASET_ERROR: &str = "dataset.error";

/// 数据集目录（页面展示与重建提示共用）。
pub const DATASET_PATH: &str = "~/Library/Application Support/aka/data/sim";

/// 自选上限（跨分组按标的去重计数）
pub const WATCHLIST_LIMIT: i64 = 500;
/// 最近查看保留条数（S-05.01-02）
pub const RECENT_VIEW_LIMIT: usize = 5;
/// 自定义分组上限
pub const MAX_CUSTOM_GROUPS: usize = 20;
/// 内置分组名（只读派生，不承载 items）
pub const DEFAULT_WATCH_GROUP: &str = "全部";
/// 未分组视图名（只读派生，group_name = NULL 的标的）
pub const UNGROUPED_GROUP: &str = "未分组";

fn validate_group_name(name: &str) -> Result<&str, AppError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::invalid_argument("分组名不能为空"));
    }
    if trimmed.chars().count() > 20 {
        return Err(AppError::invalid_argument("分组名最长 20 个字符"));
    }
    if trimmed == DEFAULT_WATCH_GROUP || trimmed == UNGROUPED_GROUP {
        return Err(AppError::invalid_argument(format!(
            "「{trimmed}」为只读视图名，不可作为自定义分组名"
        )));
    }
    Ok(trimmed)
}

fn group_duplicate(name: &str) -> AppError {
    AppError::invalid_argument(format!("分组已存在：{name}"))
        .with_details(serde_json::json!({ "reason": "GROUP_DUPLICATE", "name": name }))
}

/// S-07.05-02：单根溯源字段缺失时的错误码；前端据此显示「缺失」而不是空白/null。
pub const E_PROVENANCE_MISSING: &str = "E_PROVENANCE_MISSING";

/// 由一根 K 线组装溯源 DTO；缺失判定在核内完成，渲染层只负责展示。
fn build_bar_provenance(
    security: &str,
    candle: &Candle,
    dataset_id: &str,
    adj_mode: &str,
    raw_close: f64,
) -> BarProvenanceDto {
    let mut missing_fields = Vec::new();
    if candle.source.trim().is_empty() {
        missing_fields.push("provider".to_string());
    }
    match candle.batch_id.as_deref() {
        Some(batch) if !batch.trim().is_empty() => {}
        _ => missing_fields.push("batchId".to_string()),
    }
    if candle.ingested_at.is_none() {
        missing_fields.push("ingestedAt".to_string());
    }
    if dataset_id.trim().is_empty() {
        missing_fields.push("datasetId".to_string());
    }
    if adj_mode.trim().is_empty() {
        missing_fields.push("adjMode".to_string());
    }

    BarProvenanceDto {
        security: security.to_string(),
        date: candle.date.clone(),
        provider: candle.source.clone(),
        batch_id: candle.batch_id.clone(),
        ingested_at: candle.ingested_at,
        dataset_id: dataset_id.to_string(),
        adj_mode: adj_mode.to_string(),
        quality_flags: candle.quality.clone(),
        raw_close,
        close: candle.close,
        adj_factor: candle.adj_factor,
        error_code: if missing_fields.is_empty() {
            None
        } else {
            Some(E_PROVENANCE_MISSING)
        },
        missing_fields,
    }
}

fn push_flag(flags: &mut Vec<String>, flag: &str) {
    if !flags.iter().any(|current| current == flag) {
        flags.push(flag.to_string());
    }
}

fn yes_no(flag: bool) -> &'static str {
    if flag {
        "✓"
    } else {
        "—"
    }
}

/// 首装默认收藏：SMA / EMA / BOLL / MACD / RSI / KDJ / ATR / OBV。
/// W-51：默认 8 项必须全部 `status=normal`；D01（OBV）已实现且为 normal。
pub const DEFAULT_INDICATOR_FAVORITES: [&str; 8] =
    ["T01", "T02", "T09", "M06", "M01", "M02", "V01", "D01"];

fn favorite_status(status: &str) -> &'static str {
    match status {
        "planned" => "planned",
        "beta" => "beta",
        "normal" => "normal",
        _ => "beta",
    }
}

fn format_param_number(value: f64) -> String {
    let mut text = format!("{value:.4}");
    while text.contains('.') && text.ends_with('0') {
        text.pop();
    }
    if text.ends_with('.') {
        text.pop();
    }
    text
}

fn param_summary(params: &[ManifestParam]) -> String {
    params
        .iter()
        .map(|param| match param {
            ManifestParam::Int { default, .. } => default.to_string(),
            ManifestParam::Float { default, .. } => format_param_number(*default),
            ManifestParam::Enum { default, .. } => default.clone(),
            ManifestParam::Bool { default, .. } => {
                if *default {
                    "ON".to_string()
                } else {
                    "OFF".to_string()
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" / ")
}

fn board_label(sec: &Security) -> &'static str {
    match sec.board {
        data_provider::Board::ShMain | data_provider::Board::SzMain => "主板",
        data_provider::Board::ChiNext => "创业板",
        data_provider::Board::Star => "科创板",
        data_provider::Board::Index => "指数",
    }
}

/// 行情列表行：缺字段给 `None`（前端显示 —），绝不把缺失当 0。
fn summary_row(sec: &Security, rows: &[data_provider::BarRow]) -> MarketRowDto {
    let last = rows.last();
    let prev = if rows.len() >= 2 { Some(&rows[rows.len() - 2]) } else { None };

    let suspended = last.map(|row| row.volume <= 0.0).unwrap_or(true);
    let last_price = last.map(|row| row.close).filter(|p| p.is_finite() && *p > 0.0);
    let prev_close = prev.map(|row| row.close).filter(|p| p.is_finite() && *p > 0.0);

    // 停牌日无成交：涨跌额/涨跌幅无定义，显示 —；振幅按 0.00% 展示。
    let change_abs = if suspended {
        None
    } else {
        match (last_price, prev_close) {
            (Some(last), Some(prev)) => Some(last - prev),
            _ => None,
        }
    };
    let change_pct = if suspended {
        None
    } else {
        match (last_price, prev_close) {
            (Some(last), Some(prev)) => Some((last - prev) / prev * 100.0),
            _ => None,
        }
    };

    // 模拟域的流通股本口径：与 mock 成交量同量级派生（指数不适用）。
    let float_shares = if sec.is_index {
        0.0
    } else {
        (sec.base_price * 120_000.0).clamp(4_000_000.0, 80_000_000.0) * 10.0
    };
    let turnover_pct = match (last.map(|row| row.volume), float_shares > 0.0) {
        (Some(volume), true) if volume.is_finite() => Some(volume / float_shares * 100.0),
        _ => None,
    };

    // 卡口径「指数与停牌的量类指标显示 —」：量比不拿指数成交量硬算。
    let volume_ratio = if sec.is_index || suspended {
        None
    } else {
        (rows.len() >= 6)
            .then(|| {
                let start = rows.len() - 6;
                let prior = &rows[start..rows.len() - 1];
                let avg = prior.iter().map(|row| row.volume).sum::<f64>() / prior.len() as f64;
                if avg > 0.0 {
                    Some(last.map(|row| row.volume).unwrap_or(0.0) / avg)
                } else {
                    None
                }
            })
            .flatten()
    };

    let amplitude_pct = if suspended && last.is_some() {
        Some(0.0)
    } else {
        match (last, prev_close) {
            (Some(row), Some(prev)) if row.high.is_finite() && row.low.is_finite() => {
                Some((row.high - row.low) / prev * 100.0)
            }
            _ => None,
        }
    };

    let mut flags: Vec<String> = last
        .map(|row| {
            row.quality
                .iter()
                .filter(|q| !matches!(q, data_provider::QualityFlag::Simulated))
                .map(|q| q.as_str().to_ascii_uppercase())
                .collect()
        })
        .unwrap_or_default();
    flags.sort();
    flags.dedup();

    let amount = last.map(|row| row.amount).filter(|a| a.is_finite());
    let data_issue = last_price.is_none() || prev_close.is_none() || amount.is_none();

    MarketRowDto {
        security: sec.code.clone(),
        code: sec.code.split('.').next().unwrap_or(&sec.code).to_string(),
        name: sec.name.clone(),
        market: sec.market.as_str().to_string(),
        board: board_label(sec).to_string(),
        is_index: sec.is_index,
        suspended,
        last_price,
        prev_close,
        change_abs,
        change_pct,
        volume: last.map(|row| row.volume).filter(|v| v.is_finite()),
        amount,
        turnover_pct,
        volume_ratio,
        amplitude_pct,
        flags,
        data_issue,
    }
}

/// 编排层：唯一知道「provider + store + 指标 + 缓存」如何协作的地方。
/// 命令层不得绕过它直接访问任一子系统。
pub struct AppCore {
    provider: Box<dyn DataProvider>,
    securities: Vec<Security>,
    store: Mutex<CandleStore>,
    /// 日线原始批次（按「标的|复权」缓存）：日/周/月都从同一份日线派生，避免重复取数。
    daily_batches: Mutex<HashMap<String, Arc<BarBatch>>>,
    /// 数据集 manifest 覆盖区间（provider 自报，独立于行内最新交易日）
    dataset_coverage: Option<(String, String)>,
    /// S-EP05-05：指标计算结果缓存，容量上限 512，按首次插入顺序 FIFO 淘汰。
    calc_cache: Mutex<CalcCache>,
    calc_stats: Mutex<CacheStats>,
    /// S-07.05-01：按 dataset_id 缓存的最近一次质量报告（跨命令复用）。
    quality_report: Mutex<Option<QualityReportDto>>,
    telemetry: Telemetry,
    /// rusqlite `Connection` 是 `Send` 但不是 `Sync`，因此包一层 Mutex 才能随 `AppCore`
    /// 被 Tauri 的 `State` 共享。
    state: Option<Mutex<StateDb>>,
}

/// 取证运行注入短序列 / 停牌 / 报价样本；正常启动不注入，产品行为不变。
/// release 整段编译掉，`AKA_DIAG` 环境变量字符串不进产物（W-49）。
#[cfg(debug_assertions)]
fn with_diag_samples(provider: MockProvider) -> MockProvider {
    if std::env::var("AKA_DIAG").ok().as_deref() != Some("1") {
        return provider;
    }
    // E-01 行情列表自证要求原始 120 只样本；关闭注入可避免 S-02.07 / S-02.01
    // 的专用样本把行数抬到 128。仅 debug+AKA_DIAG 的组合可用，正常启动不受影响。
    if std::env::var("AKA_DIAG_NO_SAMPLES").ok().as_deref() == Some("1") {
        return provider;
    }
    provider
        .with_diag_short_series(20)
        .with_diag_tiny_series(12)
        // S-02.07-02 取证样本：120 根中第 80~99 根为停牌合成行（量/额为 0）
        .with_diag_suspended_series(120, 80, 20)
        // S-07.05-03 取证样本：40 根中最后一根清空 batch_id/ingested_at（缺失字段浮层）
        .with_diag_missing_provenance(40, 39)
        // S-02.01-01 取证样本：前收 10.00 / 10.03、末日停牌、上市首日、指数 000300.SH
        .with_diag_quote_samples()
}

#[cfg(not(debug_assertions))]
fn with_diag_samples(provider: MockProvider) -> MockProvider {
    provider
}

/// S-08.02-04 取证注入：仅 debug 构建且 `AKA_DIAG=1` + `AKA_DIAG_INF=1` 时，
/// 把首个实例首个输出的末值改成 +∞，走真实的「Infinity → None + E_INDEFINITE」路径。
/// 集中在此便于源码层门禁按「函数是否被 cfg 覆盖」检查两个环境变量字面量。
#[cfg(debug_assertions)]
fn diag_inject_indefinite(index: usize, end: usize, values: &mut [Vec<f64>]) {
    if std::env::var("AKA_DIAG").ok().as_deref() != Some("1")
        || std::env::var("AKA_DIAG_INF").ok().as_deref() != Some("1")
    {
        return;
    }
    if index != 0 {
        return;
    }
    if let Some(first) = values.first_mut() {
        let last = end - 1;
        if last < first.len() {
            first[last] = f64::INFINITY;
        }
    }
}

impl AppCore {
    pub async fn new(provider: Box<dyn DataProvider>) -> Result<Self, AppError> {
        let dataset_coverage = provider
            .dataset_coverage()
            .map(|(start, end)| (start.iso(), end.iso()));
        let master = provider
            .securities(data_provider::Date::new(2026, 1, 1))
            .await
            .map_err(AppError::from)?;
        Ok(Self {
            provider,
            securities: master.securities,
            store: Mutex::new(CandleStore::new()),
            daily_batches: Mutex::new(HashMap::new()),
            dataset_coverage,
            calc_cache: Mutex::new(CalcCache::default()),
            calc_stats: Mutex::new(CacheStats::default()),
            telemetry: Telemetry::in_memory(),
            quality_report: Mutex::new(None),
            state: None,
        })
    }

    /// 注入埋点 sink（路径由 aka-desktop 决定）；不注入时只保留内存环形队列。
    pub fn with_telemetry(mut self, telemetry: Telemetry) -> Self {
        self.telemetry = telemetry;
        self
    }

    pub fn telemetry(&self) -> &Telemetry {
        &self.telemetry
    }

    /// 注入 `state.db`（路径由 aka-desktop 决定）；不注入时应用照常可跑。
    pub fn with_state_db(mut self, db: StateDb) -> Self {
        self.state = Some(Mutex::new(db));
        self
    }

    pub fn state_db(&self) -> Option<MutexGuard<'_, StateDb>> {
        self.state
            .as_ref()
            .map(|db| db.lock().unwrap_or_else(|err| err.into_inner()))
    }

    /// 重新生成数据：把降级后的内存库换成一份全新可写的 state.db。
    pub fn replace_state_db(&self, db: StateDb) {
        if let Some(slot) = self.state.as_ref() {
            let mut guard = slot.lock().unwrap_or_else(|err| err.into_inner());
            *guard = db;
        }
    }

    /// 删除损坏的 state.db（含 WAL 旁文件）并重建，成功后替换内存句柄。
    pub fn rebuild_state_db(&self, path: &std::path::Path) -> Result<(), AppError> {
        for suffix in ["", "-wal", "-shm"] {
            let file = format!("{}{suffix}", path.display());
            let _ = std::fs::remove_file(file);
        }
        let db = StateDb::open_with_fallback(path);
        if db.degraded() {
            return Err(AppError::internal("重新生成数据失败：state.db 仍无法写入"));
        }
        self.replace_state_db(db);
        Ok(())
    }

    pub fn setting(&self, key: &str) -> Result<Option<String>, AppError> {
        self.state_db()
            .ok_or_else(|| AppError::internal("state.db 未初始化"))?
            .setting(key)
            .map_err(AppError::from)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), AppError> {
        self.state_db()
            .ok_or_else(|| AppError::internal("state.db 未初始化"))?
            .set_setting(key, value)
            .map_err(AppError::from)
    }

    /// MVP 装配：mock 是唯一启用的数据源。
    pub async fn new_mock() -> Result<Self, AppError> {
        let provider = with_diag_samples(MockProvider::new());
        Self::new(Box::new(provider)).await
    }

    pub fn provider_id(&self) -> &'static str {
        self.provider.id().as_str()
    }

    pub fn security_count(&self) -> usize {
        self.securities.len()
    }

    pub fn list_securities(&self, req: &ListSecuritiesRequest) -> Vec<SecurityDto> {
        let filter = req
            .market
            .as_deref()
            .map(|m| m.to_ascii_uppercase())
            .unwrap_or_else(|| "ALL".to_string());
        let limit = req.limit.unwrap_or(self.securities.len());

        self.securities
            .iter()
            .filter(|sec| match filter.as_str() {
                "SH" => matches!(sec.market, data_provider::Market::Sh) && !sec.is_index,
                "SZ" => matches!(sec.market, data_provider::Market::Sz) && !sec.is_index,
                "INDEX" => sec.is_index,
                _ => true,
            })
            .take(limit)
            .map(|sec| SecurityDto {
                code: sec.code.clone(),
                name: sec.name.clone(),
                market: sec.market.as_str(),
                board: sec.board.label_zh(),
                is_index: sec.is_index,
                base_price: sec.base_price,
            })
            .collect()
    }

    /// E-01 行情列表：以最新两根日线生成全市场快照（模拟数据域内全样本）。
    pub async fn market_snapshot(&self) -> Result<MarketSnapshotDto, AppError> {
        let mut rows = Vec::with_capacity(self.securities.len());
        let mut data_date = String::new();
        let mut provenance: Option<(String, String, String, u64, bool, i64)> = None;

        for sec in &self.securities {
            let batch = self.daily_batch(&sec.code, Adjust::Qfq).await?;
            if provenance.is_none() {
                provenance = Some((
                    batch.provider.as_str().to_string(),
                    batch.dataset_id.clone(),
                    batch.data_version.clone(),
                    batch.dataset_generation,
                    batch.simulated,
                    batch.generated_at,
                ));
            }
            if let Some(last) = batch.rows.last() {
                data_date = last.date.iso();
            }
            rows.push(summary_row(sec, &batch.rows));
        }

        let (provider, dataset_id, data_version, dataset_generation, simulated, generated_at) =
            provenance.unwrap_or_else(|| {
                (
                    self.provider.id().as_str().to_string(),
                    String::new(),
                    String::new(),
                    0,
                    true,
                    0,
                )
            });

        Ok(MarketSnapshotDto {
            sample_count: self.securities.len(),
            data_date,
            coverage_start: self
                .dataset_coverage
                .as_ref()
                .map(|(start, _)| start.clone())
                .unwrap_or_default(),
            coverage_end: self
                .dataset_coverage
                .as_ref()
                .map(|(_, end)| end.clone())
                .unwrap_or_default(),
            provider,
            dataset_id,
            data_version,
            dataset_generation,
            simulated,
            generated_at,
            rows,
        })
    }

    // ---------- 指标收藏（S-03.02-01） ----------

    /// 读取收藏；首次调用时按「无初始化标记且表为空」写入默认 8 个。
    pub fn indicator_favorites(&self) -> Result<IndicatorFavoritesResponse, AppError> {
        let rows = {
            let db = self
                .state_db()
                .ok_or_else(|| AppError::internal("state.db 未初始化"))?;
            db.ensure_default_indicator_favorites(&DEFAULT_INDICATOR_FAVORITES)
                .map_err(AppError::from)?;
            db.indicator_favorites().map_err(AppError::from)?
        };

        let favorites = rows
            .into_iter()
            .map(|row| {
                let meta = registry::entry(&row.indicator_id);
                let (abbr, name_zh, status, panel, summary) = match meta {
                    Some(meta) => (
                        meta.abbr.clone(),
                        meta.name_zh.clone(),
                        favorite_status(&meta.status),
                        meta.panel.as_str(),
                        param_summary(&meta.params),
                    ),
                    // 注册表已移除：保留行、显示已下线，不静默删收藏。
                    None => (
                        row.indicator_id.clone(),
                        row.indicator_id.clone(),
                        "offline",
                        "",
                        String::new(),
                    ),
                };
                IndicatorFavoriteDto {
                    indicator_id: row.indicator_id,
                    abbr,
                    name_zh,
                    status,
                    panel,
                    param_summary: summary,
                    is_default: row.is_default,
                    added_at: row.added_at,
                    sort_order: row.sort_order,
                }
            })
            .collect();
        Ok(IndicatorFavoritesResponse { favorites })
    }

    /// 收藏/取消收藏均可重复调用：重复收藏不新增行，重复取消不报错。
    pub fn set_indicator_favorite(
        &self,
        indicator_id: &str,
        favorited: bool,
    ) -> Result<IndicatorFavoritesResponse, AppError> {
        let id = indicator_id.trim();
        if id.is_empty() {
            return Err(AppError::invalid_argument("indicatorId 不能为空"));
        }
        {
            let db = self
                .state_db()
                .ok_or_else(|| AppError::internal("state.db 未初始化"))?;
            if favorited {
                db.add_indicator_favorite(id).map_err(AppError::from)?;
            } else {
                db.remove_indicator_favorite(id).map_err(AppError::from)?;
            }
        }
        self.indicator_favorites()
    }

    // ---------- 最近查看 ----------

    /// 浮层「最近查看」：最多 5 条，名称/板块由数据集补齐；
    /// 数据集里已不存在的记录顺手清理，避免显示幽灵标的。
    pub fn recent_views(&self) -> Result<Vec<RecentViewDto>, AppError> {
        let db = self
            .state_db()
            .ok_or_else(|| AppError::internal("state.db 未初始化"))?;
        let rows = db.recent_views(RECENT_VIEW_LIMIT).map_err(AppError::from)?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            match self.securities.iter().find(|sec| sec.code == row.code) {
                Some(sec) => out.push(RecentViewDto {
                    code: sec.code.clone(),
                    name: sec.name.clone(),
                    board: sec.board.label_zh(),
                    is_index: sec.is_index,
                    viewed_at: row.viewed_at,
                }),
                None => {
                    db.remove_recent_view(&row.code).map_err(AppError::from)?;
                }
            }
        }
        Ok(out)
    }

    /// 工作台打开标的时调用：同一标的只刷新时间，随后裁剪到 5 条。
    pub fn touch_recent_view(&self, code: &str) -> Result<Vec<RecentViewDto>, AppError> {
        let target = code.trim();
        if target.is_empty() {
            return Err(AppError::invalid_argument("code 不能为空"));
        }
        if !self.securities.iter().any(|sec| sec.code == target) {
            return Err(AppError::invalid_argument(format!("未知标的：{target}")));
        }
        {
            let db = self
                .state_db()
                .ok_or_else(|| AppError::internal("state.db 未初始化"))?;
            db.touch_recent_view(target).map_err(AppError::from)?;
            db.prune_recent_views(RECENT_VIEW_LIMIT).map_err(AppError::from)?;
        }
        self.recent_views()
    }

    // ---------- 自选 ----------

    pub fn watch_limit(&self) -> i64 {
        WATCHLIST_LIMIT
    }

    pub fn watchlist(&self) -> Result<WatchlistDto, AppError> {
        let db = self
            .state_db()
            .ok_or_else(|| AppError::internal("state.db 未初始化"))?;
        // 坏库已无法修复：让页面拿到 trace id 并展示「重新生成数据」，不要静默当成空自选。
        if let Some(reason) = db.degraded_reason() {
            if reason.starts_with("state.db 已损坏") {
                let err = AppError::storage_corrupt(reason.to_string());
                // 页面 id 必须能查：生成即写 telemetry，用户报号可按 id grep 到同一条。
                if let Some(id) = err.trace_id() {
                    self.telemetry.emit(
                        "storage.corrupt",
                        vec![
                            ("traceId", serde_json::Value::from(id)),
                            ("code", serde_json::to_value(err.code).unwrap_or_default()),
                            ("message", serde_json::Value::from(err.message.clone())),
                        ],
                    );
                }
                return Err(err);
            }
        }
        let items = db.watchlist().map_err(AppError::from)?;
        let groups = db.watch_groups().map_err(AppError::from)?;
        let mut counts: HashMap<String, i64> = HashMap::new();
        let mut ungrouped = 0_i64;
        for item in &items {
            match &item.group_name {
                Some(name) => *counts.entry(name.clone()).or_insert(0) += 1,
                None => ungrouped += 1,
            }
        }
        let total = items.len() as i64;

        // 「全部」「未分组」都是只读派生，不落库、不承载 items
        let mut dto_groups = vec![WatchGroupDto {
            name: DEFAULT_WATCH_GROUP.to_string(),
            count: total,
            sort_order: 0,
            is_builtin: true,
        }];
        dto_groups.extend(groups.into_iter().map(|g| WatchGroupDto {
            count: counts.get(&g.name).copied().unwrap_or(0),
            name: g.name,
            sort_order: g.sort_order,
            is_builtin: g.is_builtin,
        }));
        if ungrouped > 0 {
            dto_groups.push(WatchGroupDto {
                name: UNGROUPED_GROUP.to_string(),
                count: ungrouped,
                sort_order: i64::MAX - 1,
                is_builtin: true,
            });
        }

        Ok(WatchlistDto {
            limit: WATCHLIST_LIMIT,
            total,
            groups: dto_groups,
            items: items
                .into_iter()
                .map(|i| WatchItemDto {
                    security: i.security,
                    group_name: i.group_name,
                    sort_order: i.sort_order,
                })
                .collect(),
        })
    }

    /// 星标切换：未收藏 → 加入指定分组（缺省为未分组）；已收藏 → 从自选移除。
    pub fn toggle_watch(&self, security: &str, group: Option<&str>) -> Result<WatchToggleResult, AppError> {
        let db = self
            .state_db()
            .ok_or_else(|| AppError::internal("state.db 未初始化"))?;
        // 已收藏 → 先移除：标的可能已不在数据集（退市/更名），移出不能被数据集校验拦住
        if db
            .watchlist()
            .map_err(AppError::from)?
            .iter()
            .any(|i| i.security == security)
        {
            db.remove_watch(security).map_err(AppError::from)?;
            return Ok(WatchToggleResult {
                watched: false,
                total: db.watch_distinct_count().map_err(AppError::from)?,
            });
        }
        // 新增才要求标的在数据集内
        if !self.securities.iter().any(|s| s.code == security) {
            return Err(AppError::unknown_security(security));
        }

        let target = group.filter(|name| *name != DEFAULT_WATCH_GROUP && *name != UNGROUPED_GROUP);
        if let Some(name) = target {
            if !db.watch_group_exists(name).map_err(AppError::from)? {
                return Err(AppError::invalid_argument(format!("自选分组不存在：{name}")));
            }
        }
        let distinct = db.watch_distinct_count().map_err(AppError::from)?;
        // 判定与写入同一事务：499 放行、落库 500，count >= 500 时拒第 501 只
        match db
            .add_watch_with_limit(security, target, distinct + 1, WATCHLIST_LIMIT)
            .map_err(AppError::from)?
        {
            AddWatchOutcome::Added => {}
            AddWatchOutcome::LimitReached => {
                return Err(AppError::new(
                    ErrorCode::InvalidArgument,
                    format!("自选上限 {WATCHLIST_LIMIT} 只，请先移出后再添加"),
                )
                .with_details(serde_json::json!({
                    "reason": "WATCHLIST_LIMIT",
                    "limit": WATCHLIST_LIMIT,
                    "security": security,
                })))
            }
        }
        Ok(WatchToggleResult {
            watched: true,
            total: db.watch_distinct_count().map_err(AppError::from)?,
        })
    }

    pub fn create_watch_group(&self, name: &str) -> Result<(), AppError> {
        let name = validate_group_name(name)?;
        let db = self
            .state_db()
            .ok_or_else(|| AppError::internal("state.db 未初始化"))?;
        if db.watch_group_exists(name).map_err(AppError::from)? {
            return Err(group_duplicate(name));
        }
        let custom = db
            .watch_groups()
            .map_err(AppError::from)?
            .into_iter()
            .filter(|g| !g.is_builtin)
            .count();
        if custom >= MAX_CUSTOM_GROUPS {
            return Err(AppError::invalid_argument(format!(
                "分组上限 {MAX_CUSTOM_GROUPS} 个，请先删除不用的分组"
            ))
            .with_details(serde_json::json!({
                "reason": "GROUP_LIMIT",
                "limit": MAX_CUSTOM_GROUPS,
            })));
        }
        db.create_watch_group(name).map_err(AppError::from)
    }

    pub fn rename_watch_group(&self, old: &str, new: &str) -> Result<(), AppError> {
        let db = self
            .state_db()
            .ok_or_else(|| AppError::internal("state.db 未初始化"))?;
        let groups = db.watch_groups().map_err(AppError::from)?;
        if old == DEFAULT_WATCH_GROUP || groups.iter().any(|g| g.name == old && g.is_builtin) {
            return Err(AppError::invalid_argument("内置分组「全部」不可重命名"));
        }
        if !groups.iter().any(|g| g.name == old) {
            return Err(AppError::invalid_argument(format!("自选分组不存在：{old}")));
        }
        let name = validate_group_name(new)?;
        if db.watch_group_exists(name).map_err(AppError::from)? {
            return Err(group_duplicate(name));
        }
        db.rename_watch_group(old, name).map_err(AppError::from)
    }

    pub fn delete_watch_group(&self, name: &str) -> Result<(), AppError> {
        let db = self
            .state_db()
            .ok_or_else(|| AppError::internal("state.db 未初始化"))?;
        // 内置名优先拒绝：即使测试库尚未落行，也不能把「全部/未分组」当成可删。
        if name == DEFAULT_WATCH_GROUP || name == UNGROUPED_GROUP {
            return Err(AppError::invalid_argument("内置分组「全部」不可删除"));
        }
        let groups = db.watch_groups().map_err(AppError::from)?;
        // 重复删除（双击确认）幂等成功：组已不存在即视为完成，不报错。
        let Some(group) = groups.iter().find(|g| g.name == name) else {
            return Ok(());
        };
        if group.is_builtin {
            return Err(AppError::invalid_argument("内置分组「全部」不可删除"));
        }
        db.delete_watch_group(name).map_err(AppError::from)
    }

    // ---------- 视图状态（沿用 state.db，不新起存储） ----------

    pub fn view_state(&self, scope: &str) -> Result<Option<serde_json::Value>, AppError> {
        self.state_db()
            .ok_or_else(|| AppError::internal("state.db 未初始化"))?
            .view_state(scope)
            .map_err(AppError::from)
    }

    pub fn set_view_state(&self, scope: &str, value: &serde_json::Value) -> Result<(), AppError> {
        self.state_db()
            .ok_or_else(|| AppError::internal("state.db 未初始化"))?
            .set_view_state(scope, value)
            .map_err(AppError::from)
    }

    // ---------- 持仓 ----------

    pub fn positions(&self) -> Result<Vec<PositionDto>, AppError> {
        let db = self
            .state_db()
            .ok_or_else(|| AppError::internal("state.db 未初始化"))?;
        Ok(db
            .positions()
            .map_err(AppError::from)?
            .into_iter()
            .map(|p| PositionDto {
                security: p.security,
                cost_price: p.cost_price,
                shares: p.shares,
                updated_at: p.updated_at,
            })
            .collect())
    }

    pub fn save_position(&self, security: &str, cost_price: f64, shares: i64) -> Result<(), AppError> {
        if !self.securities.iter().any(|s| s.code == security) {
            return Err(AppError::unknown_security(security));
        }
        if !cost_price.is_finite() || cost_price <= 0.0 {
            return Err(AppError::invalid_argument("成本价必须大于 0"));
        }
        if shares < 0 || shares > 10_000_000_000 {
            return Err(AppError::invalid_argument("持仓数量超出范围"));
        }
        self.state_db()
            .ok_or_else(|| AppError::internal("state.db 未初始化"))?
            .save_position(security, cost_price, shares)
            .map_err(AppError::from)
    }

    pub fn delete_position(&self, security: &str) -> Result<(), AppError> {
        self.state_db()
            .ok_or_else(|| AppError::internal("state.db 未初始化"))?
            .delete_position(security)
            .map_err(AppError::from)
    }

    /// 指标 manifest：目录的唯一事实来源，前端据此生成指标目录（含未实现项）。
    pub fn indicator_manifest(&self) -> &'static indicator_core::Manifest {
        indicator_core::manifest()
    }

    /// S-02.08-01：页脚 7 段全部从这份 manifest 派生，页面不另写数字。
    /// provider 侧按需计算并缓存（mock 为 OnceLock），不在启动路径上付全量摘要成本。
    pub fn dataset_manifest(&self) -> Option<data_provider::DatasetManifest> {
        self.provider.dataset_manifest()
    }

    fn current_dataset_id(&self) -> String {
        self.dataset_manifest()
            .map(|manifest| manifest.dataset_id)
            .unwrap_or_else(|| "unknown".to_string())
    }

    /// S-07.01-01：P9 首卡探测。状态只由「实际探测结果 + manifest」决定，
    /// 不信任 `capabilities()` 自报——必需能力必须真的调用一次成功才算可用。
    pub async fn datasource_status(&self) -> DatasourceStatusDto {
        let caps = self.provider.capabilities();
        let mut errors = 0usize;
        let first = self.securities.first().map(|sec| sec.code.clone());

        let securities_ok = caps.securities && !self.securities.is_empty();

        let daily_ok = match first.as_deref() {
            Some(code) if caps.daily_bars => {
                match self.daily_batch(code, Adjust::None).await {
                    Ok(batch) => !batch.rows.is_empty(),
                    Err(_) => {
                        errors += 1;
                        false
                    }
                }
            }
            _ => false,
        };

        let adjust_ok = match first.as_deref() {
            Some(code) if caps.adjust_factors => {
                match self.provider.adjust_factors(code).await {
                    Ok(batch) => !batch.factors.is_empty(),
                    Err(_) => {
                        errors += 1;
                        false
                    }
                }
            }
            _ => false,
        };

        let calendar_ok = match self.dataset_coverage.as_ref() {
            Some((start, end)) if caps.trading_calendar => {
                match (
                    data_provider::Date::parse(start),
                    data_provider::Date::parse(end),
                ) {
                    (Some(from), Some(to)) => {
                        match self.provider.trading_calendar(from, to).await {
                            Ok(days) => !days.is_empty(),
                            Err(_) => {
                                errors += 1;
                                false
                            }
                        }
                    }
                    _ => false,
                }
            }
            _ => false,
        };

        let capabilities = vec![
            DatasourceCapabilityDto {
                key: "daily_bars",
                label_zh: "日线行情",
                required: true,
                available: daily_ok,
                note: None,
            },
            DatasourceCapabilityDto {
                key: "adjust_factors",
                label_zh: "复权因子",
                required: true,
                available: adjust_ok,
                note: None,
            },
            DatasourceCapabilityDto {
                key: "securities",
                label_zh: "证券主数据",
                required: true,
                available: securities_ok,
                note: None,
            },
            DatasourceCapabilityDto {
                key: "trading_calendar",
                label_zh: "交易日历",
                required: true,
                available: calendar_ok,
                note: None,
            },
            DatasourceCapabilityDto {
                key: "industry",
                label_zh: "行业映射",
                required: false,
                available: caps.industry,
                note: Some("无行业映射：板块区按内置样本分组"),
            },
            DatasourceCapabilityDto {
                key: "index_members",
                label_zh: "指数成分",
                required: false,
                available: caps.index_members,
                note: Some("无指数成分：指数页仅展示内置样本"),
            },
            DatasourceCapabilityDto {
                key: "limit_flags",
                label_zh: "ST 标记",
                required: false,
                available: caps.limit_flags,
                note: Some("无 ST 标记：涨跌停按普通规则推导"),
            },
            DatasourceCapabilityDto {
                key: "suspended_flags",
                label_zh: "停牌标记",
                required: false,
                // 数据契约里没有停牌标记字段，如实标不可用，不按零成交量猜测。
                available: false,
                note: Some("无停牌标记：零成交量不区分停牌"),
            },
        ];
        let required_ok = capabilities
            .iter()
            .filter(|cap| cap.required && cap.available)
            .count();
        let required_total = capabilities.iter().filter(|cap| cap.required).count();
        let optional_ok = capabilities
            .iter()
            .filter(|cap| !cap.required && cap.available)
            .count();
        let optional_total = capabilities.iter().filter(|cap| !cap.required).count();

        let manifest = self.dataset_manifest();
        let version = manifest.as_ref().map(|manifest| DatasetVersionDto {
            dataset_id: manifest.dataset_id.clone(),
            dataset_id_short: manifest.dataset_id.chars().take(24).collect(),
            generated_at: manifest.generated_at,
            row_count: manifest.row_count,
            coverage_start: manifest.coverage_start.clone(),
            coverage_end: manifest.coverage_end.clone(),
            sha256: manifest.sha256.clone(),
            sha256_short: manifest.sha256.chars().take(12).collect(),
        });

        let (state, error_code): (&'static str, Option<&'static str>) = match &version {
            None => ("missing", Some("E_DATASET_MISSING")),
            Some(_) if required_ok < required_total => {
                if errors >= 3 {
                    ("probe_failed", Some("E_PROBE_FAILED"))
                } else {
                    ("unavailable", Some("E_REQUIRED_CAPABILITY_MISSING"))
                }
            }
            Some(_) if optional_ok < optional_total => ("partial", None),
            Some(_) => ("ready", None),
        };

        let ops = DatasourceOpsDto {
            // Mock 为内存数据源，没有数据目录；用「manifest 可读」作为可读性等价事实。
            data_dir_readable: version.is_some(),
            // 没有磁盘目录就不编造 GB 数值，界面按 `—` 显示。
            disk_free_gb: None,
            note: Some("Mock 内存数据源无数据目录：数据由 manifest 描述，磁盘可用空间不适用"),
        };

        let status = DatasourceStatusDto {
            state,
            required_ok,
            required_total,
            optional_ok,
            optional_total,
            capabilities,
            ops,
            version,
            // tushare 本卡只做静态摘要，启用数恒为 0（交互归 S-07.01-02）。
            tushare_enabled: 0,
            tushare_total: 4,
            checked_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
            error_code,
        };

        self.telemetry.emit(
            EVENT_DATASOURCE_PROBE,
            vec![
                ("state", serde_json::json!(status.state)),
                ("requiredOk", serde_json::json!(status.required_ok)),
                ("requiredTotal", serde_json::json!(status.required_total)),
                ("optionalOk", serde_json::json!(status.optional_ok)),
                ("optionalTotal", serde_json::json!(status.optional_total)),
                ("datasetId", serde_json::json!(status
                    .version
                    .as_ref()
                    .map(|v| v.dataset_id.clone())
                    .unwrap_or_default())),
            ],
        );
        status
    }

    /// S-07.01-02：P9 健康检查 6 项（只读、0 网络）。
    /// ①失败 → ②~⑥ SKIP；②失败 → ③~⑥ SKIP；④必须由 provider 独立复算，不得回读 manifest 缓存。
    pub async fn data_health_check(&self, manifest_corrupt: bool) -> DataHealthDto {
        let total_started = Instant::now();
        let checked_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let manifest = self.dataset_manifest();

        let skip = |key: &str, label: &str| DataHealthItemDto {
            key: key.to_string(),
            label_zh: label.to_string(),
            status: "SKIP",
            duration_ms: 0,
            error_code: None,
            detail: Some("前置检查未通过，已跳过".to_string()),
            advice: None,
        };

        // 统一出口：落 `health.check`（只记汇总，不记 dataset 明细）。
        let finish = |report: DataHealthDto| {
            self.telemetry.emit(
                EVENT_HEALTH_CHECK,
                vec![
                    ("passed", serde_json::json!(report.passed)),
                    ("total", serde_json::json!(report.total)),
                    ("durationMs", serde_json::json!(report.duration_ms)),
                ],
            );
            report
        };

        let mut items: Vec<DataHealthItemDto> = Vec::with_capacity(6);
        let step = Instant::now();
        let present = manifest.is_some();
        items.push(DataHealthItemDto {
            key: "dataset_present".to_string(),
            label_zh: "数据集存在".to_string(),
            status: if present { "PASS" } else { "FAIL" },
            duration_ms: step.elapsed().as_millis() as u64,
            error_code: if present { None } else { Some("E_DATASET_MISSING") },
            detail: Some(if present {
                "模拟数据源已装配".to_string()
            } else {
                "未装配任何数据集".to_string()
            }),
            advice: if present { None } else { Some("去设置页重建样本包") },
        });

        if !present {
            for (key, label) in [
                ("manifest_parse", "manifest 可解析"),
                ("data_readable", "数据可读"),
                ("sha256_match", "sha256 匹配"),
                ("sample_rows", "行数抽检"),
                ("required_tables", "必需表齐全"),
            ] {
                items.push(skip(key, label));
            }
            return finish(DataHealthDto {
                items,
                passed: 0,
                total: 6,
                duration_ms: total_started.elapsed().as_millis() as u64,
                checked_at,
                dataset_id: None,
            });
        }
        let manifest = manifest.expect("present 分支已判定 manifest 存在");

        let step = Instant::now();
        let parse_ok = !manifest_corrupt
            && !manifest.dataset_id.trim().is_empty()
            && manifest.row_count > 0
            && Date::parse(&manifest.coverage_start).is_some()
            && Date::parse(&manifest.coverage_end).is_some()
            && manifest.sha256.len() == 64
            && manifest.sha256.chars().all(|ch| ch.is_ascii_hexdigit());
        items.push(DataHealthItemDto {
            key: "manifest_parse".to_string(),
            label_zh: "manifest 可解析".to_string(),
            status: if parse_ok { "PASS" } else { "FAIL" },
            duration_ms: step.elapsed().as_millis() as u64,
            error_code: if parse_ok { None } else { Some("E_MANIFEST_CORRUPT") },
            detail: Some(if manifest_corrupt {
                "manifest 不可解析（故障注入）".to_string()
            } else if parse_ok {
                format!(
                    "{} · {} 行 · {} ~ {}",
                    manifest.dataset_id, manifest.row_count, manifest.coverage_start, manifest.coverage_end
                )
            } else {
                "dataset_id / 行数 / 区间 / sha256 至少一项不合法".to_string()
            }),
            advice: if parse_ok { None } else { Some("去设置页重建样本包") },
        });

        if !parse_ok {
            for (key, label) in [
                ("data_readable", "数据可读"),
                ("sha256_match", "sha256 匹配"),
                ("sample_rows", "行数抽检"),
                ("required_tables", "必需表齐全"),
            ] {
                items.push(skip(key, label));
            }
            return finish(DataHealthDto {
                items,
                passed: 1,
                total: 6,
                duration_ms: total_started.elapsed().as_millis() as u64,
                checked_at,
                dataset_id: Some(manifest.dataset_id.clone()),
            });
        }

        // ③ 数据可读：真的取第一只标的的日线，不看能力自报。
        let step = Instant::now();
        let first = self.securities.first().map(|sec| sec.code.clone());
        let batch = match first.as_deref() {
            Some(code) => self.daily_batch(code, Adjust::None).await.ok(),
            None => None,
        };
        let readable = batch.as_ref().map(|batch| !batch.rows.is_empty()).unwrap_or(false);
        items.push(DataHealthItemDto {
            key: "data_readable".to_string(),
            label_zh: "数据可读".to_string(),
            status: if readable { "PASS" } else { "FAIL" },
            duration_ms: step.elapsed().as_millis() as u64,
            error_code: if readable { None } else { Some("E_DATA_UNREADABLE") },
            detail: Some(match (first.as_deref(), &batch) {
                (Some(code), Some(batch)) => format!("{} · {} 行", code, batch.rows.len()),
                (Some(code), None) => format!("{code} 日线读取失败"),
                (None, _) => "标的主表为空".to_string(),
            }),
            advice: if readable { None } else { Some("去设置页重建样本包") },
        });

        // ④ sha256 匹配：provider 独立重算，禁止回读缓存。
        let step = Instant::now();
        match self.provider.dataset_digest() {
            Some((sha, rows)) => {
                let matched = sha == manifest.sha256 && rows == manifest.row_count;
                items.push(DataHealthItemDto {
                    key: "sha256_match".to_string(),
                    label_zh: "sha256 匹配".to_string(),
                    status: if matched { "PASS" } else { "FAIL" },
                    duration_ms: step.elapsed().as_millis() as u64,
                    error_code: if matched { None } else { Some("E_SHA_MISMATCH") },
                    detail: Some(format!(
                        "复算 {}/{} 行，manifest {}/{} 行",
                        &sha[..12.min(sha.len())],
                        rows,
                        &manifest.sha256[..12.min(manifest.sha256.len())],
                        manifest.row_count
                    )),
                    advice: if matched { None } else { Some("数据可能已损坏，建议重建样本包") },
                });
            }
            None => items.push(skip("sha256_match", "sha256 匹配")),
        }

        // ⑤ 行数抽检：最近 5 个交易日必须存在、按日递增且开高低收合法。
        let step = Instant::now();
        let sample_ok = batch
            .as_ref()
            .map(|batch| {
                let rows = &batch.rows;
                rows.len() >= 5
                    && rows.windows(2).all(|pair| pair[0].date < pair[1].date)
                    && rows.iter().rev().take(5).all(|row| {
                        row.high >= row.low
                            && row.high >= row.open
                            && row.high >= row.close
                            && row.low <= row.open
                            && row.low <= row.close
                            && row.volume >= 0.0
                    })
            })
            .unwrap_or(false);
        items.push(DataHealthItemDto {
            key: "sample_rows".to_string(),
            label_zh: "行数抽检".to_string(),
            status: if sample_ok { "PASS" } else { "FAIL" },
            duration_ms: step.elapsed().as_millis() as u64,
            error_code: if sample_ok { None } else { Some("E_SAMPLE_ROWS") },
            detail: Some(match &batch {
                Some(batch) if batch.rows.len() >= 5 => {
                    let tail = &batch.rows[batch.rows.len() - 5..];
                    format!("最近 5 个交易日 {} ~ {}", tail[0].date.iso(), tail[4].date.iso())
                }
                Some(batch) => format!("仅有 {} 行，不足 5 日", batch.rows.len()),
                None => "无日线可抽检".to_string(),
            }),
            advice: if sample_ok { None } else { Some("去设置页重建样本包") },
        });

        // ⑥ 必需表齐全：主数据 / 日线 / 复权因子 / 交易日历四项能力。
        let step = Instant::now();
        let caps = self.provider.capabilities();
        let tables_ok = caps.securities && caps.daily_bars && caps.adjust_factors && caps.trading_calendar;
        items.push(DataHealthItemDto {
            key: "required_tables".to_string(),
            label_zh: "必需表齐全".to_string(),
            status: if tables_ok { "PASS" } else { "FAIL" },
            duration_ms: step.elapsed().as_millis() as u64,
            error_code: if tables_ok { None } else { Some("E_REQUIRED_TABLE_MISSING") },
            detail: Some(format!(
                "主数据 {} / 日线 {} / 复权 {} / 日历 {}",
                yes_no(caps.securities),
                yes_no(caps.daily_bars),
                yes_no(caps.adjust_factors),
                yes_no(caps.trading_calendar)
            )),
            advice: if tables_ok { None } else { Some("数据源能力缺失，检查 provider 配置") },
        });

        let passed = items.iter().filter(|item| item.status == "PASS").count() as u32;
        finish(DataHealthDto {
            items,
            passed,
            total: 6,
            duration_ms: total_started.elapsed().as_millis() as u64,
            checked_at,
            dataset_id: Some(manifest.dataset_id.clone()),
        })
    }
    /// S-08.02-03：启动校验（只读、0 网络）。
    ///
    /// 分类顺序固定：目录 → manifest → 必需表 → sha256 → DB。
    /// `readable` 为真时前端才给「只读浏览」；`DB_CORRUPT` 允许只读展示可读部分。
    pub fn dataset_integrity(&self, fault: DatasetFault) -> DatasetIntegrityDto {
        let checked_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let manifest = self.dataset_manifest();
        let mut report = DatasetIntegrityDto {
            state: "ok",
            error_code: None,
            title: None,
            detail: None,
            trace_id: trace_id(),
            dataset_path: DATASET_PATH.to_string(),
            readable: false,
            checked_at,
            dataset_id: manifest.as_ref().map(|m| m.dataset_id.clone()),
        };

        if fault == DatasetFault::Missing || manifest.is_none() {
            report.state = "blocked";
            report.error_code = Some("MISSING_DIR");
            report.title = Some("数据集未找到");
            report.detail = Some("数据集目录不存在，或未装配任何数据".to_string());
            return self.finish_dataset_integrity(report);
        }
        let manifest = manifest.expect("missing 分支已返回");

        let manifest_ok = fault != DatasetFault::Manifest
            && !manifest.dataset_id.trim().is_empty()
            && manifest.row_count > 0
            && Date::parse(&manifest.coverage_start).is_some()
            && Date::parse(&manifest.coverage_end).is_some()
            && manifest.sha256.len() == 64
            && manifest.sha256.chars().all(|ch| ch.is_ascii_hexdigit());
        if !manifest_ok {
            report.state = "blocked";
            report.error_code = Some("MANIFEST_INVALID");
            report.title = Some("数据集描述文件损坏");
            report.detail = Some("manifest 字段缺失或格式不合法".to_string());
            return self.finish_dataset_integrity(report);
        }

        let caps = self.provider.capabilities();
        let tables_ok =
            caps.securities && caps.daily_bars && caps.adjust_factors && caps.trading_calendar;
        if fault == DatasetFault::Table || !tables_ok {
            report.state = "blocked";
            report.error_code = Some("REQUIRED_TABLE_MISSING");
            report.title = Some("必需数据表缺失");
            report.detail = Some("主数据 / 日线 / 复权 / 日历至少一项不可用".to_string());
            return self.finish_dataset_integrity(report);
        }

        let short = |text: &str| text[..12.min(text.len())].to_string();
        let digest = self.provider.dataset_digest();
        let matched = digest
            .as_ref()
            .map(|(sha, rows)| sha == &manifest.sha256 && *rows == manifest.row_count)
            .unwrap_or(true);
        if fault == DatasetFault::Sha || !matched {
            report.state = "blocked";
            report.error_code = Some("SHA256_MISMATCH");
            report.title = Some("数据集校验失败");
            report.readable = true;
            report.detail = Some(match &digest {
                Some((sha, rows)) => format!(
                    "manifest {}（{} 行），复算 {}（{} 行）",
                    short(&manifest.sha256),
                    manifest.row_count,
                    short(sha),
                    rows
                ),
                None => "manifest 与实际数据摘要不一致".to_string(),
            });
            return self.finish_dataset_integrity(report);
        }

        if fault == DatasetFault::Db {
            report.state = "blocked";
            report.error_code = Some("DB_CORRUPT");
            report.title = Some("数据文件损坏");
            report.readable = true;
            report.detail = Some("部分数据不可读，仅展示可读部分".to_string());
            return self.finish_dataset_integrity(report);
        }

        self.finish_dataset_integrity(report)
    }

    /// 校验失败落 `dataset.error`（只记分类 / trace id / 路径，不记用户数据）。
    fn finish_dataset_integrity(&self, report: DatasetIntegrityDto) -> DatasetIntegrityDto {
        if let Some(code) = report.error_code {
            self.telemetry.emit(
                EVENT_DATASET_ERROR,
                vec![
                    ("type", serde_json::json!(code)),
                    ("traceId", serde_json::json!(report.trace_id)),
                    ("path", serde_json::json!(report.dataset_path)),
                ],
            );
        }
        report
    }

    pub fn quality_report(&self) -> Option<QualityReportDto> {
        let current = self.current_dataset_id();
        let mut guard = self.quality_report.lock().ok()?;
        guard.as_mut().map(|report| {
            report.current_dataset_id = current.clone();
            report.stale = report.based_on_dataset_id != current;
            report.clone()
        })
    }

    /// 全量扫描 6 项质量检查；成功后才覆盖缓存（失败保留上一次报告）。
    pub async fn quality_scan(&self) -> Result<QualityReportDto, AppError> {
        let started = std::time::Instant::now();
        let dataset_id = self.current_dataset_id();
        let has_adjust_factors = self.provider.capabilities().adjust_factors;

        let mut inputs = Vec::with_capacity(self.securities.len());
        let mut observed_dates = std::collections::BTreeSet::new();
        for security in &self.securities {
            let batch = self.daily_batch(&security.code, data_provider::Adjust::None).await?;
            for row in &batch.rows {
                observed_dates.insert(row.date);
            }
            inputs.push(SecurityQualityInput {
                security: security.clone(),
                bars: batch.rows.clone(),
                has_adjust_factors,
            });
        }

        let fallback: Vec<data_provider::Date> = observed_dates.into_iter().collect();
        let calendar = match &self.dataset_coverage {
            Some((start, end)) => {
                match (
                    data_provider::Date::parse(start),
                    data_provider::Date::parse(end),
                ) {
                    (Some(from), Some(to)) => self
                        .provider
                        .trading_calendar(from, to)
                        .await
                        .map_err(AppError::from)?,
                    _ => fallback,
                }
            }
            None => fallback,
        };

        let result = quality::scan(&calendar, &inputs);
        let duration_ms = started.elapsed().as_millis() as u64;
        let rows: Vec<QualityCheckDto> = result
            .rows
            .into_iter()
            .map(|row| QualityCheckDto {
                key: row.key,
                label_zh: row.label_zh,
                hits: row.hits,
                base: row.base,
                ratio_pct: row.ratio_pct,
                treatment: row.treatment,
                status: row.status.as_str(),
                error_code: row.error_code,
                examples: row
                    .examples
                    .into_iter()
                    .map(|example| QualityExampleDto {
                        security: example.security,
                        date: example.date,
                    })
                    .collect(),
            })
            .collect();

        let total_count = rows.len();
        let report = QualityReportDto {
            dataset_id: dataset_id.clone(),
            based_on_dataset_id: dataset_id.clone(),
            current_dataset_id: dataset_id,
            stale: false,
            scanned_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
            duration_ms,
            passed_count: result.passed_count,
            total_count,
            rows,
        };
        *self
            .quality_report
            .lock()
            .map_err(|_| AppError::internal("质量报告锁中毒"))? = Some(report.clone());

        self.telemetry.emit(
            EVENT_QUALITY_SCAN,
            vec![
                ("datasetId", serde_json::json!(report.dataset_id.clone())),
                ("durationMs", serde_json::json!(report.duration_ms)),
                ("passedCount", serde_json::json!(report.passed_count)),
                ("totalCount", serde_json::json!(report.total_count)),
                ("stale", serde_json::json!(false)),
            ],
        );
        Ok(report)
    }

    pub fn indicator_registry(&self, category: Option<&str>) -> RegistryResponse {
        let wanted = category.map(|c| c.to_ascii_lowercase());
        let indicators = all()
            .iter()
            .filter(|ind| match wanted.as_deref() {
                Some(key) if !key.is_empty() && key != "all" => {
                    category_key(ind.meta().category) == key
                }
                _ => true,
            })
            .map(|ind| indicator_meta_dto(*ind))
            .collect::<Vec<_>>();

        RegistryResponse {
            catalog_total: PLANNED_INDICATOR_COUNT,
            implemented_count: implemented_count(),
            indicators,
        }
    }

    pub async fn get_bars(&self, req: &GetBarsRequest) -> Result<BarsResponse, AppError> {
        let timeframe = parse_timeframe(&req.timeframe)?;
        let adj = Adjust::parse(&req.adj)
            .ok_or_else(|| AppError::invalid_argument(format!("未知复权口径：{}", req.adj)))?;
        let series = self.series_for(&req.security, timeframe, adj).await?;

        let total = series.len();
        let window = resolve_window(&series, req.from.as_deref(), req.to.as_deref())?;

        let bars = series
            .slice(window.start, window.end)
            .iter()
            .map(|candle| BarDto {
                ts: candle.ts,
                date: candle.date.clone(),
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: candle.volume,
                amount: candle.amount,
                adj_factor: candle.adj_factor,
                source: candle.source.clone(),
                quality: candle.quality.clone(),
                batch_id: candle.batch_id.clone(),
                ingested_at: candle.ingested_at,
            })
            .collect();

        Ok(BarsResponse {
            security: series.security.clone(),
            timeframe: series.timeframe.clone(),
            adj: series.adj.clone(),
            dataset_id: series.dataset_id.clone(),
            total_bars: total,
            bars,
            range: window.range,
            provenance: ProvenanceDto {
                provider: series.provider.clone(),
                dataset_id: series.dataset_id.clone(),
                data_version: series.data_version.clone(),
                dataset_generation: series.dataset_generation,
                simulated: series.simulated,
                generated_at: series.generated_at,
            },
        })
    }

    /// S-07.05-02：点单根 K 线取溯源；`raw_close` 走不复权序列，供除权日做复权前后价对照。
    pub async fn bar_provenance(
        &self,
        req: &BarProvenanceRequest,
    ) -> Result<BarProvenanceDto, AppError> {
        let timeframe = parse_timeframe(&req.timeframe)?;
        let adj = Adjust::parse(&req.adj)
            .ok_or_else(|| AppError::invalid_argument(format!("未知复权口径：{}", req.adj)))?;
        let series = self.series_for(&req.security, timeframe, adj).await?;
        let candle = series
            .candles
            .iter()
            .find(|candle| candle.date == req.date)
            .ok_or_else(|| {
                AppError::invalid_argument(format!(
                    "{} 在 {} 没有 {} 周期的 K 线",
                    req.security, req.date, req.timeframe
                ))
            })?;

        let raw_close = if adj == Adjust::None {
            candle.close
        } else {
            let raw = self.series_for(&req.security, timeframe, Adjust::None).await?;
            raw.candles
                .iter()
                .find(|raw_candle| raw_candle.date == candle.date)
                .map(|raw_candle| raw_candle.close)
                .unwrap_or(candle.close)
        };

        // 卡面要求 dataset_id 与 manifest 一致，不用序列缓存里的批次 id。
        let dataset_id = self.current_dataset_id();
        Ok(build_bar_provenance(
            &series.security,
            candle,
            &dataset_id,
            &series.adj,
            raw_close,
        ))
    }

    pub async fn calc_indicators(&self, req: &CalcRequest) -> Result<CalcResponse, AppError> {
        let timeframe = parse_timeframe(&req.timeframe)?;
        let adj = Adjust::parse(&req.adj)
            .ok_or_else(|| AppError::invalid_argument(format!("未知复权口径：{}", req.adj)))?;
        let series = self.series_for(&req.security, timeframe, adj).await?;

        let total = series.len();
        let window = resolve_window(&series, req.from.as_deref(), req.to.as_deref())?;
        let columns = SeriesColumns::new(&series);
        let view = columns.view();

        let mut computed_ms = 0.0;
        let mut cache_hit = true;
        let mut computed = 0u64;
        let mut skipped = 0u64;
        // 同请求内同键去重：5 个实例引用同一指标参数时只算一次，其余实例复用结果。
        let mut request_cache: HashMap<String, Arc<Vec<Vec<f64>>>> = HashMap::new();
        let mut output = Vec::with_capacity(req.instances.len());

        for (index, instance) in req.instances.iter().enumerate() {
            let indicator = lookup(&instance.indicator_id)
                .ok_or_else(|| AppError::unknown_indicator(&instance.indicator_id))?;
            let meta = indicator.meta();

            let params = merge_defaults(meta.params, &instance.params);
            validate(meta.params, &params).map_err(|err| param_error(meta.id, err))?;

            let warmup = (meta.warmup)(&params);
            // S-02.07-02 前置 2：预热不足的指标由引擎输出全段 NaN（`short_series_respects_warmup_for_every_indicator`
            // 已覆盖全部 44 个实现指标），不在这里让整个请求失败；否则月线 24 根时 T01/T03 也会被 T02 连坐。

            let key = calc_key(&series, meta, &params, &window.range);
            let params_hash = params_hash(&params);
            let context = telemetry_context(
                meta.id,
                &params_hash,
                &key,
                &series,
                window.end - window.start,
            );

            let raw = if let Some(values) = request_cache.get(&key) {
                skipped += 1;
                self.telemetry.emit(
                    EVENT_COMPUTE_SKIP,
                    vec![
                        ("indicatorId", serde_json::json!(meta.id)),
                        ("instanceId", serde_json::json!(instance.instance_id)),
                        ("reason", serde_json::json!("duplicateKey")),
                        ("cacheKey", serde_json::json!(key.clone())),
                    ],
                );
                values.clone()
            } else {
                let cached = self
                    .calc_cache
                    .lock()
                    .map_err(|_| AppError::internal("计算缓存锁中毒"))?
                    .get(&key);

                match cached {
                    Some(values) => {
                        self.telemetry.emit(EVENT_CACHE_HIT, context.clone());
                        values
                    }
                    None => {
                        cache_hit = false;
                        self.telemetry.emit(EVENT_CACHE_MISS, context.clone());
                        let started = Instant::now();
                        let mut values = vec![vec![f64::NAN; total]; meta.outputs.len()];
                        indicator
                            .calc(&view, &params, &mut values)
                            .map_err(|err| calc_error(meta.id, err))?;
                        // S-08.02-04 取证注入：正常启动与发布构建都编译掉，产品行为不变（W-47）。
                        #[cfg(debug_assertions)]
                        diag_inject_indefinite(index, window.end, &mut values);
                        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
                        computed_ms += elapsed_ms;
                        computed += 1;

                        let mut compute_fields = context.clone();
                        compute_fields.push(("computeMs", serde_json::json!(elapsed_ms)));
                        self.telemetry.emit(EVENT_INDICATOR_COMPUTE, compute_fields);
                        self.telemetry.record_cold_ms(
                            elapsed_ms,
                            vec![
                                ("indicatorId", serde_json::json!(meta.id)),
                                ("cacheKey", serde_json::json!(key.clone())),
                                ("barCount", serde_json::json!(window.end - window.start)),
                            ],
                        );

                        let values = Arc::new(values);
                        self.calc_cache
                            .lock()
                            .map_err(|_| AppError::internal("计算缓存锁中毒"))?
                            .insert(key.clone(), values.clone());
                        values
                    }
                }
            };

            request_cache.insert(key, raw.clone());

            let outputs = meta
                .outputs
                .iter()
                .zip(raw.iter())
                .map(|(spec, values)| {
                    let mut indefinite = false;
                    let mut out = Vec::with_capacity(window.end - window.start);
                    for value in &values[window.start..window.end] {
                        if value.is_finite() {
                            out.push(Some(*value));
                        } else {
                            if value.is_infinite() {
                                indefinite = true;
                            }
                            out.push(None);
                        }
                    }
                    if indefinite {
                        self.telemetry.emit(
                            EVENT_INDEFINITE,
                            vec![
                                ("code", Value::from("E_INDEFINITE")),
                                ("instanceId", Value::from(instance.instance_id.as_str())),
                                ("indicatorId", Value::from(meta.id)),
                                ("key", Value::from(spec.key)),
                            ],
                        );
                    }
                    OutputSeriesDto {
                        key: spec.key,
                        label_zh: spec.label_zh,
                        kind: spec.kind,
                        color: spec.color,
                        values: out,
                    }
                })
                .collect();

            output.push(SeriesDto {
                instance_id: instance.instance_id.clone(),
                indicator_id: meta.id.to_string(),
                outputs,
                warmup,
                engine_version: meta.engine_version,
            });
        }

        let mut stats = self
            .calc_stats
            .lock()
            .map_err(|_| AppError::internal("统计锁中毒"))?;
        if cache_hit {
            stats.hits += 1;
        } else {
            stats.misses += 1;
        }
        drop(stats);

        self.telemetry.emit(
            EVENT_COMPUTE_COUNT,
            vec![
                ("count", serde_json::json!(computed)),
                ("skip", serde_json::json!(skipped)),
                ("instances", serde_json::json!(req.instances.len())),
                ("cacheHit", serde_json::json!(cache_hit)),
            ],
        );

        Ok(CalcResponse {
            generation: req.generation,
            dataset_id: series.dataset_id.clone(),
            dataset_generation: series.dataset_generation,
            engine_version: ENGINE_VERSION,
            computed_ms: (computed_ms * 100.0).round() / 100.0,
            cache_hit,
            bar_count: window.end - window.start,
            range: window.range,
            series: output,
        })
    }

    async fn series_for(
        &self,
        security: &str,
        timeframe: Timeframe,
        adj: Adjust,
    ) -> Result<Arc<CandleSeries>, AppError> {
        let Some(found) = self.securities.iter().find(|s| s.code == security) else {
            return Err(AppError::unknown_security(security));
        };

        let key = SeriesKey {
            security: found.code.clone(),
            timeframe: timeframe.as_str().to_string(),
            adj: adj.as_str().to_string(),
        };

        if let Some(cached) = self.store_lock()?.get(&key) {
            return Ok(cached);
        }

        // 日/周/月都从同一份日线批次派生：周/月聚合只在 app-core 做一次口径转换。
        let batch = self.daily_batch(&found.code, adj).await?;
        let rows = match timeframe {
            Timeframe::Day => batch.rows.clone(),
            Timeframe::Week => aggregate_bars(&batch.rows, AggregatePeriod::Week),
            Timeframe::Month => aggregate_bars(&batch.rows, AggregatePeriod::Month),
        };

        let provider = batch.provider.as_str().to_string();
        let candles = rows
            .iter()
            .enumerate()
            .map(|(index, row)| {
                let mut quality: Vec<String> =
                    row.quality.iter().map(|q| q.as_str().to_string()).collect();
                let suspended = row
                    .quality
                    .iter()
                    .any(|flag| matches!(flag, data_provider::QualityFlag::Suspended));

                // 逐根派生标记，与质量报告同一套口径（S-07.05-01/S-07.05-02）。
                if !suspended && row.volume == 0.0 {
                    push_flag(&mut quality, QualityFlag::ZeroVolume.as_str());
                }
                if index > 0 {
                    let prev = &rows[index - 1];
                    let ex_rights = (prev.adj_factor - row.adj_factor).abs() > f64::EPSILON;
                    if ex_rights {
                        push_flag(&mut quality, QualityFlag::ExRights.as_str());
                    }
                    if !suspended && !ex_rights && prev.close > 0.0 {
                        let abnormal = row.close <= 0.0
                            || quality::board_limit_pct(found.board).map_or(false, |cap| {
                                let pct = (row.close / prev.close - 1.0).abs() * 100.0;
                                pct > cap + quality::PRICE_LIMIT_TOLERANCE_PCT
                            });
                        if abnormal {
                            push_flag(&mut quality, QualityFlag::PriceAnomaly.as_str());
                        }
                    }
                } else if row.close <= 0.0 {
                    push_flag(&mut quality, QualityFlag::PriceAnomaly.as_str());
                }

                Candle {
                    ts: row.date.epoch_secs(),
                    date: row.date.iso(),
                    open: row.open,
                    high: row.high,
                    low: row.low,
                    close: row.close,
                    volume: row.volume,
                    amount: row.amount,
                    adj_factor: row.adj_factor,
                    quality,
                    source: provider.clone(),
                    batch_id: row.batch_id.clone(),
                    ingested_at: row.ingested_at,
                }
            })
            .collect::<Vec<_>>();

        if candles.is_empty() {
            return Err(AppError::new(
                ErrorCode::DatasetMissing,
                format!(
                    "{} 在 {} 周期内没有可用 K 线（可能整段停牌）",
                    found.code,
                    timeframe.as_str()
                ),
            )
            .with_details(serde_json::json!({
                "security": found.code,
                "timeframe": timeframe.as_str(),
            })));
        }

        let series = Arc::new(CandleSeries {
            security: found.code.clone(),
            timeframe: timeframe.as_str().to_string(),
            adj: adj.as_str().to_string(),
            provider,
            dataset_id: batch.dataset_id.clone(),
            data_version: batch.data_version.clone(),
            dataset_generation: batch.dataset_generation,
            simulated: batch.simulated,
            generated_at: batch.generated_at,
            candles,
        });

        self.store_lock()?.put(key, series.clone());
        Ok(series)
    }

    /// 取数唯一入口：日/周/月与质量扫描都从这里拿原始日线批次。
    ///
    /// 同一标的/复权只取一次；周/月聚合在 `series_for` 内本地完成，不再打 provider。
    /// 缓存缺口（S-08.02-01）未实现前不存在第二个拉数入口。
    async fn daily_batch(&self, code: &str, adj: Adjust) -> Result<Arc<BarBatch>, AppError> {
        let key = format!("{}|{}", code, adj.as_str());
        if let Some(cached) = self
            .daily_batches
            .lock()
            .map_err(|_| AppError::internal("日线批次锁中毒"))?
            .get(&key)
            .cloned()
        {
            return Ok(cached);
        }

        let batch = self
            .provider
            .daily_bars(BarRequest {
                security: code.to_string(),
                timeframe: Timeframe::Day,
                adj,
                from: None,
                to: None,
            })
            .await
            .map_err(AppError::from)?;
        let batch = Arc::new(batch);
        self.daily_batches
            .lock()
            .map_err(|_| AppError::internal("日线批次锁中毒"))?
            .insert(key, batch.clone());
        Ok(batch)
    }

    fn store_lock(&self) -> Result<MutexGuard<'_, CandleStore>, AppError> {
        self.store
            .lock()
            .map_err(|_| AppError::internal("行情存储锁中毒"))
    }
}

fn indicator_meta_dto(indicator: &'static dyn Indicator) -> IndicatorMetaDto {
    let meta = indicator.meta();
    let defaults = merge_defaults(meta.params, &Params::new());
    IndicatorMetaDto {
        id: meta.id,
        name_zh: meta.name_zh,
        name_en: meta.name_en,
        category: meta.category,
        params: meta.params.to_vec(),
        outputs: meta.outputs.iter().copied().map(OutputSpecDto::from).collect(),
        inputs: InputsDto::from(meta.inputs),
        spec_status: meta.spec_status,
        engine_version: meta.engine_version,
        unit: meta.unit,
        notes: meta.notes,
        warmup: (meta.warmup)(&defaults),
        implemented: true,
    }
}

fn parse_timeframe(value: &str) -> Result<Timeframe, AppError> {
    Timeframe::parse(value)
        .ok_or_else(|| AppError::invalid_argument(format!("未知周期：{value}")))
}

/// 日历跨度上限（10 年）与返回根数上限，防止前端一次拉全历史把 IPC/渲染拖死。
const MAX_RANGE_DAYS: i64 = 3_660;
const MAX_RANGE_BARS: usize = 2_500;
/// S-EP05-05：计算缓存容量上限，超出后按首次插入顺序淘汰最早键。
const CALC_CACHE_MAX: usize = 512;

/// S-EP05-05：指标计算结果缓存。
///
/// 只做容量上限与 FIFO 淘汰：命中路径只读 `map`，不改顺序（不做真 LRU）；
/// 重复插入同键不改变首次插入顺序，保证 512 个互异键不会互相误淘汰。
#[derive(Default)]
struct CalcCache {
    map: HashMap<String, Arc<Vec<Vec<f64>>>>,
    order: VecDeque<String>,
}

impl CalcCache {
    fn get(&self, key: &str) -> Option<Arc<Vec<Vec<f64>>>> {
        self.map.get(key).cloned()
    }

    fn insert(&mut self, key: String, value: Arc<Vec<Vec<f64>>>) {
        if self.map.insert(key.clone(), value).is_none() {
            self.order.push_back(key);
        }
        while self.order.len() > CALC_CACHE_MAX {
            if let Some(oldest) = self.order.pop_front() {
                self.map.remove(&oldest);
            }
        }
    }

    #[cfg(test)]
    fn keys(&self) -> Vec<String> {
        self.map.keys().cloned().collect()
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.map.len()
    }
}

#[derive(Debug)]
struct ResolvedWindow {
    start: usize,
    end: usize,
    range: RangeDto,
}

/// 把请求的日期闭区间映射成半开下标区间 `[start, end)`。
///
/// 规则：
/// - 非交易日 / 停牌日不是错误，区间内没有 K 线就直接缺席；
/// - `from` 落在非交易日时吸附到其后第一根，`to` 吸附到其前最后一根；
/// - `to` 晚于最新交易日时截断到最新（`clamped = true`）；
/// - `from` 晚于最新交易日、或区间内无任何 K 线 → `INSUFFICIENT_DATA`；
/// - `from > to` → `INVALID_ARGUMENT`（区间倒置）；
/// - 日历跨度 > 10 年或返回根数 > 2500 → `INVALID_ARGUMENT`（超长区间）。
fn resolve_window(
    series: &CandleSeries,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<ResolvedWindow, AppError> {
    let requested_from = parse_bound(from, "from")?;
    let requested_to = parse_bound(to, "to")?;

    if let (Some(f), Some(t)) = (requested_from, requested_to) {
        if f > t {
            return Err(AppError::invalid_argument(format!("区间倒置：起始 {f} 晚于结束 {t}"))
                .with_details(serde_json::json!({"from": f.iso(), "to": t.iso()})));
        }
        if t.epoch_secs() / 86_400 - f.epoch_secs() / 86_400 > MAX_RANGE_DAYS {
            return Err(AppError::invalid_argument(format!(
                "区间超长：{f} 至 {t} 超过 {MAX_RANGE_DAYS} 天上限"
            ))
            .with_details(serde_json::json!({"maxDays": MAX_RANGE_DAYS})));
        }
    }

    let total = series.len();
    let first = series.candles.first().map(|c| c.date.as_str());
    let last = series.candles.last().map(|c| c.date.as_str());
    let empty_range = |code: ErrorCode, message: String| {
        AppError::new(code, message).with_details(serde_json::json!({
            "requestedFrom": requested_from.map(|d| d.iso()),
            "requestedTo": requested_to.map(|d| d.iso()),
            "availableFrom": first,
            "availableTo": last,
            "totalBars": total,
        }))
    };

    if total == 0 {
        return Err(empty_range(
            ErrorCode::InsufficientData,
            "数据集为空，无法按日期区间取数".to_string(),
        ));
    }

    let from_iso = requested_from.map(|d| d.iso());
    let to_iso = requested_to.map(|d| d.iso());

    let start = match from_iso.as_deref() {
        Some(bound) => series
            .candles
            .iter()
            .position(|c| c.date.as_str() >= bound)
            .ok_or_else(|| {
                empty_range(
                    ErrorCode::InsufficientData,
                    format!("起始日期 {bound} 晚于最新交易日 {last:?}"),
                )
            })?,
        None => 0,
    };
    let end = match to_iso.as_deref() {
        Some(bound) => series
            .candles
            .iter()
            .rposition(|c| c.date.as_str() <= bound)
            .map(|idx| idx + 1)
            .unwrap_or(0),
        None => total,
    };

    if start >= end {
        return Err(empty_range(
            ErrorCode::InsufficientData,
            "请求区间内没有可用的 K 线".to_string(),
        ));
    }

    let bar_count = end - start;
    if bar_count > MAX_RANGE_BARS {
        return Err(AppError::invalid_argument(format!(
            "区间包含 {bar_count} 根 K 线，超过 {MAX_RANGE_BARS} 根上限"
        ))
        .with_details(serde_json::json!({"maxBars": MAX_RANGE_BARS, "requestedBars": bar_count})));
    }

    let actual_from = series.candles[start].date.clone();
    let actual_to = series.candles[end - 1].date.clone();
    let clamped = from_iso.as_deref().is_some_and(|b| b != actual_from)
        || to_iso.as_deref().is_some_and(|b| b != actual_to);

    Ok(ResolvedWindow {
        start,
        end,
        range: RangeDto {
            requested_from: from_iso,
            requested_to: to_iso,
            returned_from: Some(actual_from),
            returned_to: Some(actual_to),
            bar_count,
            clamped,
        },
    })
}

fn parse_bound(value: Option<&str>, field: &str) -> Result<Option<Date>, AppError> {
    match value {
        None => Ok(None),
        Some(text) if text.trim().is_empty() => Ok(None),
        Some(text) => Date::parse(text.trim()).map(Some).ok_or_else(|| {
            AppError::invalid_argument(format!("{field} 不是合法日期（YYYY-MM-DD）：{text}"))
                .with_details(serde_json::json!({"field": field, "value": text}))
        }),
    }
}

/// 指标内核只接收切片，因此先把 K 线列拷成连续数组，避免在循环里反复分配。
struct SeriesColumns {
    open: Vec<f64>,
    high: Vec<f64>,
    low: Vec<f64>,
    close: Vec<f64>,
    volume: Vec<f64>,
    amount: Vec<f64>,
}

impl SeriesColumns {
    fn new(series: &CandleSeries) -> Self {
        let len = series.len();
        let mut open = Vec::with_capacity(len);
        let mut high = Vec::with_capacity(len);
        let mut low = Vec::with_capacity(len);
        let mut close = Vec::with_capacity(len);
        let mut volume = Vec::with_capacity(len);
        let mut amount = Vec::with_capacity(len);
        for candle in &series.candles {
            open.push(candle.open);
            high.push(candle.high);
            low.push(candle.low);
            close.push(candle.close);
            volume.push(candle.volume);
            amount.push(candle.amount);
        }
        Self {
            open,
            high,
            low,
            close,
            volume,
            amount,
        }
    }

    fn view(&self) -> OhlcvView<'_> {
        OhlcvView::new(
            &self.open,
            &self.high,
            &self.low,
            &self.close,
            &self.volume,
            &self.amount,
        )
    }
}

/// 参数指纹：FNV-1a(JSON 序列化后的 Params)，用于埋点与缓存键排查，不参与缓存键本体。
fn params_hash(params: &Params) -> String {
    let text = serde_json::to_string(params).unwrap_or_default();
    let mut hash = 0xCBF2_9CE4_8422_2325u64;
    for byte in text.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01B3);
    }
    format!("{hash:016x}")
}

fn telemetry_context(
    indicator_id: &'static str,
    params_hash: &str,
    cache_key: &str,
    series: &CandleSeries,
    bar_count: usize,
) -> Vec<(&'static str, serde_json::Value)> {
    vec![
        ("indicatorId", serde_json::json!(indicator_id)),
        ("paramsHash", serde_json::json!(params_hash)),
        ("cacheKey", serde_json::json!(cache_key)),
        ("security", serde_json::json!(series.security)),
        ("timeframe", serde_json::json!(series.timeframe)),
        ("adj", serde_json::json!(series.adj)),
        ("datasetId", serde_json::json!(series.dataset_id)),
        ("datasetGeneration", serde_json::json!(series.dataset_generation)),
        ("barCount", serde_json::json!(bar_count)),
    ]
}

/// 缓存键 = 7 个维度（数据集版本、标的、周期、复权、指标 id、参数、日期区间），
/// 逐段拼成 `v2|...`；日期区间取吸附后的实际起止日，未指定时记 `*`。
fn calc_key(
    series: &CandleSeries,
    meta: &'static indicator_core::Meta,
    params: &Params,
    range: &RangeDto,
) -> String {
    let params = serde_json::to_string(params).unwrap_or_default();
    format!(
        "v2|{}|{}|{}|{}|{}|{}|{}|{}~{}",
        ENGINE_VERSION,
        series.dataset_id,
        series.security,
        series.timeframe,
        series.adj,
        meta.id,
        params,
        range.returned_from.as_deref().unwrap_or("*"),
        range.returned_to.as_deref().unwrap_or("*"),
    )
}

fn param_error(indicator_id: &str, err: ParamError) -> AppError {
    AppError::new(
        ErrorCode::ParamOutOfRange,
        format!("{} 参数不合法：{}", indicator_id, err.message),
    )
    .with_details(serde_json::json!({
        "indicatorId": indicator_id,
        "field": err.field,
    }))
}

fn calc_error(indicator_id: &str, err: CalcError) -> AppError {
    match err {
        CalcError::InsufficientData { required, got } => AppError::new(
            ErrorCode::InsufficientData,
            format!("数据不足：需要 {required} 根，当前 {got} 根"),
        )
        .with_details(serde_json::json!({
            "indicatorId": indicator_id,
            "required": required,
            "got": got,
        })),
        CalcError::InvalidParam(message) => AppError::new(
            ErrorCode::ParamOutOfRange,
            format!("{indicator_id} 参数不合法：{message}"),
        ),
        CalcError::ParamOrder(message) => AppError::new(
            ErrorCode::ParamOrder,
            format!("{indicator_id} 参数顺序不合法：{message}"),
        ),
        CalcError::Internal(message) => AppError::internal(message),
    }
}

fn category_key(category: Category) -> &'static str {
    match category {
        Category::Trend => "trend",
        Category::Momentum => "momentum",
        Category::Volatility => "volatility",
        Category::Volume => "volume",
        Category::Stat => "stat",
        Category::Breadth => "breadth",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn series(from: Date, bars: usize) -> CandleSeries {
        let mut day = from;
        let mut candles = Vec::new();
        for i in 0..bars {
            candles.push(Candle {
                ts: day.epoch_secs(),
                date: day.iso(),
                open: 10.0 + i as f64,
                high: 11.0 + i as f64,
                low: 9.0 + i as f64,
                close: 10.5 + i as f64,
                volume: 1_000.0,
                amount: 10_500.0,
                adj_factor: 1.0,
                quality: vec![],
                source: "mock".to_string(),
                batch_id: None,
                ingested_at: None,
            });
            day = day.next_weekday();
        }
        CandleSeries {
            security: "600519.SH".into(),
            timeframe: "1d".into(),
            adj: "qfq".into(),
            provider: "mock".into(),
            dataset_id: "ds".into(),
            data_version: "v0".into(),
            dataset_generation: 1,
            simulated: true,
            generated_at: 0,
            candles,
        }
    }

    #[tokio::test]
    async fn indicator_favorites_seed_eight_and_toggle_is_idempotent() {
        let core = AppCore::new_mock()
            .await
            .unwrap()
            .with_state_db(StateDb::open_in_memory().unwrap());

        let seeded = core.indicator_favorites().unwrap();
        let ids: Vec<&str> = seeded
            .favorites
            .iter()
            .map(|f| f.indicator_id.as_str())
            .collect();
        assert_eq!(ids, DEFAULT_INDICATOR_FAVORITES.to_vec());
        assert!(seeded.favorites.iter().all(|f| f.is_default));
        assert_eq!(seeded.favorites[0].abbr, "SMA");
        assert_eq!(seeded.favorites[0].param_summary, "20");
        assert_eq!(
            seeded.favorites[3].param_summary, "12 / 26 / 9",
            "MACD 参数摘要按注册表默认值"
        );
        // W-51：默认 8 项必须全部 normal，planned/beta 一律不得进默认集。
        assert!(
            seeded.favorites.iter().all(|f| f.status == "normal"),
            "默认收藏只能是 normal 指标"
        );
        assert!(
            !seeded.favorites.iter().any(|f| f.indicator_id == "D11"),
            "D11（RVOL）为 planned，不得靠默认集硬塞"
        );

        // 重复收藏/取消：行数不变、不报错
        core.set_indicator_favorite("M03", true).unwrap();
        core.set_indicator_favorite("M03", true).unwrap();
        let after_add = core.indicator_favorites().unwrap();
        assert_eq!(after_add.favorites.len(), 9);
        assert_eq!(after_add.favorites[0].indicator_id, "M03", "新收藏排在最前");

        core.set_indicator_favorite("M03", false).unwrap();
        core.set_indicator_favorite("M03", false).unwrap();
        assert_eq!(core.indicator_favorites().unwrap().favorites.len(), 8);
    }

    #[tokio::test]
    async fn removed_indicator_stays_favorited_as_offline() {
        let core = AppCore::new_mock()
            .await
            .unwrap()
            .with_state_db(StateDb::open_in_memory().unwrap());
        core.indicator_favorites().unwrap();
        core.set_indicator_favorite("XX99", true).unwrap();
        let row = core
            .indicator_favorites()
            .unwrap()
            .favorites
            .into_iter()
            .find(|f| f.indicator_id == "XX99")
            .unwrap();
        assert_eq!(row.status, "offline");
        assert_eq!(row.name_zh, "XX99");
    }

    #[tokio::test]
    async fn deleting_all_favorites_is_not_reseeded() {
        let core = AppCore::new_mock()
            .await
            .unwrap()
            .with_state_db(StateDb::open_in_memory().unwrap());
        // 先完成首装（写入初始化标记），再删光
        assert_eq!(core.indicator_favorites().unwrap().favorites.len(), 8);
        for id in DEFAULT_INDICATOR_FAVORITES {
            core.set_indicator_favorite(id, false).unwrap();
        }
        assert!(core.indicator_favorites().unwrap().favorites.is_empty());
        // 再次读取（等价重启后的首次读取）不得补回默认项
        assert!(core.indicator_favorites().unwrap().favorites.is_empty());
    }

    #[tokio::test]
    async fn indicator_favorites_requires_state_db() {
        let core = AppCore::new_mock().await.unwrap();
        assert!(core.indicator_favorites().is_err());
    }

    #[tokio::test]
    async fn recent_views_map_names_prune_to_five_and_drop_stale() {
        let core = AppCore::new_mock()
            .await
            .unwrap()
            .with_state_db(StateDb::open_in_memory().unwrap());
        let codes: Vec<String> = core.securities.iter().map(|sec| sec.code.clone()).collect();
        assert!(codes.len() > 6);

        let rows = core.touch_recent_view(&codes[0]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].code, codes[0]);
        assert_eq!(
            rows[0].name,
            core.securities[0].name,
            "名称必须从数据集补齐，不能只回代码"
        );

        // 数据集里不存在的记录：读取时清理，不返回幽灵行。
        core.state_db().unwrap().touch_recent_view("999999.SZ").unwrap();
        let rows = core.recent_views().unwrap();
        assert!(rows.iter().all(|row| row.code != "999999.SZ"));
        assert!(core
            .state_db()
            .unwrap()
            .recent_views(10)
            .unwrap()
            .iter()
            .all(|row| row.code != "999999.SZ"));

        for code in codes.iter().take(6) {
            core.touch_recent_view(code).unwrap();
        }
        assert_eq!(core.recent_views().unwrap().len(), RECENT_VIEW_LIMIT);

        assert!(core.touch_recent_view("999999.SZ").is_err(), "未知标的不得写入");
    }

    #[tokio::test]
    async fn quality_scan_reports_six_checks_and_caches_result() {
        let core = AppCore::new_mock().await.unwrap();
        assert!(core.quality_report().is_none(), "未扫描前页面显示尚未检查");

        let report = core.quality_scan().await.unwrap();
        assert_eq!(report.total_count, 6);
        assert_eq!(report.rows.len(), 6);
        assert_eq!(
            report.dataset_id,
            core.dataset_manifest().unwrap().dataset_id,
            "报告必须绑定当前数据集 id"
        );
        assert!(!report.stale);
        assert_eq!(
            report
                .rows
                .iter()
                .map(|row| row.key)
                .collect::<Vec<_>>(),
            vec![
                "MISSING",
                "EX_RIGHTS",
                "SUSPENDED",
                "ZERO_VOLUME",
                "PRICE_ANOMALY",
                "ADJ_COVERAGE"
            ]
        );
        assert!(report.duration_ms < 10_000, "120×520 扫描不应超时");
        assert_eq!(report.passed_count, 6, "正常 mock 数据集 6/6 通过");

        let cached = core.quality_report().unwrap();
        assert_eq!(cached.scanned_at, report.scanned_at);
        assert!(!cached.stale);
        assert_eq!(cached.current_dataset_id, report.dataset_id);
    }

    #[tokio::test]
    async fn quality_scan_suspended_diagnostic_sample_hits_three_checks() {
        let core = AppCore::new(Box::new(
            data_provider::mock::MockProvider::new().with_diag_suspended_series(120, 80, 20),
        ))
        .await
        .unwrap();
        let report = core.quality_scan().await.unwrap();
        let suspended = report
            .rows
            .iter()
            .find(|row| row.key == "SUSPENDED")
            .unwrap();
        // 取证样本默认注入 DIAGSUSP.SZ：30 根中第 30 根停牌
        assert!(suspended.hits >= 1, "停牌样本必须被识别");
        assert_eq!(suspended.status, "info");
        assert!(!suspended.examples.is_empty(), "示例用于跳到单根 K 线");
    }

    /// S-07.01-01（补1）专用：交易日照常「可查询」但返回空表，等价于日历表被删。
    struct CalendarGoneProvider(data_provider::mock::MockProvider);

    #[async_trait::async_trait]
    impl data_provider::DataProvider for CalendarGoneProvider {
        fn id(&self) -> data_provider::ProviderId {
            self.0.id()
        }

        fn capabilities(&self) -> data_provider::Capabilities {
            self.0.capabilities()
        }

        async fn securities(
            &self,
            as_of: data_provider::Date,
        ) -> Result<data_provider::SecurityMaster, data_provider::ProviderError> {
            self.0.securities(as_of).await
        }

        async fn trading_calendar(
            &self,
            _from: data_provider::Date,
            _to: data_provider::Date,
        ) -> Result<Vec<data_provider::Date>, data_provider::ProviderError> {
            Ok(Vec::new())
        }

        async fn daily_bars(
            &self,
            req: data_provider::BarRequest,
        ) -> Result<data_provider::BarBatch, data_provider::ProviderError> {
            self.0.daily_bars(req).await
        }

        async fn adjust_factors(
            &self,
            security: &str,
        ) -> Result<data_provider::FactorBatch, data_provider::ProviderError> {
            self.0.adjust_factors(security).await
        }

        async fn index_members(
            &self,
            index: &str,
            as_of: data_provider::Date,
        ) -> Result<Vec<String>, data_provider::NotSupported> {
            self.0.index_members(index, as_of).await
        }

        async fn industry(
            &self,
            as_of: data_provider::Date,
        ) -> Result<Vec<(String, String)>, data_provider::NotSupported> {
            self.0.industry(as_of).await
        }

        async fn limit_flags(
            &self,
            req: data_provider::BarRequest,
        ) -> Result<Vec<data_provider::BarRow>, data_provider::NotSupported> {
            self.0.limit_flags(req).await
        }

        async fn minute_bars(
            &self,
            req: data_provider::BarRequest,
        ) -> Result<data_provider::BarBatch, data_provider::NotSupported> {
            self.0.minute_bars(req).await
        }

        fn rate_policy(&self) -> data_provider::RatePolicy {
            self.0.rate_policy()
        }

        async fn health(&self) -> data_provider::Health {
            self.0.health().await
        }

        fn dataset_coverage(&self) -> Option<(data_provider::Date, data_provider::Date)> {
            self.0.dataset_coverage()
        }

        fn dataset_manifest(&self) -> Option<data_provider::DatasetManifest> {
            self.0.dataset_manifest()
        }
    }

    #[tokio::test]
    async fn datasource_status_reports_required_green_optional_truthful_and_version_six() {
        let core = AppCore::new_mock().await.unwrap();
        let status = core.datasource_status().await;

        assert_eq!((status.required_ok, status.required_total), (4, 4));
        assert_eq!((status.optional_ok, status.optional_total), (0, 4));
        // mock 四项可选全缺 → 黄色「部分可用」，不是红「不可用」。
        assert_eq!(status.state, "partial");
        assert_eq!(status.error_code, None);

        let keys: Vec<&str> = status.capabilities.iter().map(|cap| cap.key).collect();
        assert_eq!(
            keys,
            vec![
                "daily_bars",
                "adjust_factors",
                "securities",
                "trading_calendar",
                "industry",
                "index_members",
                "limit_flags",
                "suspended_flags",
            ]
        );
        let st = status
            .capabilities
            .iter()
            .find(|cap| cap.key == "limit_flags")
            .unwrap();
        assert!(!st.available);
        assert_eq!(st.note, Some("无 ST 标记：涨跌停按普通规则推导"));

        // 数据版本 6 字段齐全（generated_at 交给界面按本地时区格式化）。
        let version = status.version.as_ref().unwrap();
        assert_eq!(version.row_count, 120 * 520);
        assert_eq!(version.sha256.len(), 64);
        assert_eq!(version.sha256_short.len(), 12);
        assert_eq!(version.coverage_start.len(), 10);
        assert_eq!(version.coverage_end.len(), 10);
        assert!(version.generated_at > 0);
        assert!(version.dataset_id.starts_with("sim-"));

        assert_eq!((status.tushare_enabled, status.tushare_total), (0, 4));
        assert!(status.ops.data_dir_readable);
        // Mock 无磁盘目录：不编造 GB 数值。
        assert_eq!(status.ops.disk_free_gb, None);

        let events = core.telemetry().summary(10);
        assert!(
            events.recent.iter().any(|event| event.name == EVENT_DATASOURCE_PROBE),
            "探测必须落 datasource.probe 事件"
        );
    }

    #[tokio::test]
    async fn datasource_status_calendar_table_gone_is_unavailable() {
        let core = AppCore::new(Box::new(CalendarGoneProvider(
            data_provider::mock::MockProvider::new(),
        )))
        .await
        .unwrap();
        let status = core.datasource_status().await;

        assert_eq!((status.required_ok, status.required_total), (3, 4));
        assert_eq!(status.state, "unavailable");
        assert_eq!(status.error_code, Some("E_REQUIRED_CAPABILITY_MISSING"));
        let calendar = status
            .capabilities
            .iter()
            .find(|cap| cap.key == "trading_calendar")
            .unwrap();
        assert!(!calendar.available, "日历查询为空时必须判不可用");
    }

    #[tokio::test]
    async fn health_check_all_six_pass_on_mock() {
        let core = AppCore::new_mock().await.unwrap();
        let report = core.data_health_check(false).await;

        assert_eq!(report.total, 6);
        assert_eq!(report.passed, 6);
        let keys: Vec<&str> = report.items.iter().map(|item| item.key.as_str()).collect();
        assert_eq!(
            keys,
            vec![
                "dataset_present",
                "manifest_parse",
                "data_readable",
                "sha256_match",
                "sample_rows",
                "required_tables",
            ]
        );
        assert!(report.items.iter().all(|item| item.status == "PASS"));
        assert!(report.items.iter().all(|item| item.error_code.is_none()));
        assert!(report.checked_at > 0);
        assert!(report.dataset_id.is_some());

        let events = core.telemetry().summary(10);
        assert!(
            events.recent.iter().any(|event| event.name == EVENT_HEALTH_CHECK),
            "健康检查必须落 health.check 事件"
        );
    }

    /// AC-07.01-02（补3）：manifest 损坏 → ②FAIL、③~⑥SKIP、汇总 1/6。
    #[tokio::test]
    async fn health_check_corrupt_manifest_fails_at_step_two() {
        let core = AppCore::new_mock().await.unwrap();
        let report = core.data_health_check(true).await;

        assert_eq!(report.items[0].status, "PASS", "样本包仍在，①应通过");
        assert_eq!(report.items[1].status, "FAIL");
        assert_eq!(report.items[1].error_code, Some("E_MANIFEST_CORRUPT"));
        assert!(report.items[2..].iter().all(|item| item.status == "SKIP"));
        assert_eq!(report.passed, 1);
    }

    /// S-08.02-03：正常数据集 → ok，且不落 dataset.error。
    #[tokio::test]
    async fn dataset_integrity_ok_on_mock() {
        let core = AppCore::new_mock().await.unwrap();
        let report = core.dataset_integrity(DatasetFault::None);

        assert_eq!(report.state, "ok");
        assert!(report.error_code.is_none());
        assert!(!report.readable, "正常数据集不进入只读浏览");
        assert!(report.trace_id.starts_with("TR-"));
        assert_eq!(report.dataset_path, DATASET_PATH);
        assert!(report.dataset_id.is_some());
        let events = core.telemetry().summary(10);
        assert!(
            !events.recent.iter().any(|event| event.name == EVENT_DATASET_ERROR),
            "正常启动不应落 dataset.error"
        );
    }

    /// AC-08.02-03 / 补1：五类错误分类互斥，只有 sha256 与 DB 损坏允许只读浏览。
    #[tokio::test]
    async fn dataset_integrity_classifies_faults() {
        let core = AppCore::new_mock().await.unwrap();
        for (fault, code, readable) in [
            (DatasetFault::Missing, "MISSING_DIR", false),
            (DatasetFault::Manifest, "MANIFEST_INVALID", false),
            (DatasetFault::Table, "REQUIRED_TABLE_MISSING", false),
            (DatasetFault::Sha, "SHA256_MISMATCH", true),
            (DatasetFault::Db, "DB_CORRUPT", true),
        ] {
            let report = core.dataset_integrity(fault);
            assert_eq!(report.state, "blocked", "{code} 必须阻断启动");
            assert_eq!(report.error_code, Some(code));
            assert_eq!(report.readable, readable, "{code} 只读可用性不符");
            assert!(report.title.is_some(), "{code} 缺少错误卡标题");
            assert!(report.detail.is_some(), "{code} 缺少错误说明");
        }

        let events = core.telemetry().summary(20);
        assert_eq!(
            events
                .recent
                .iter()
                .filter(|event| event.name == EVENT_DATASET_ERROR)
                .count(),
            5,
            "每次校验失败都应落一条 dataset.error"
        );
    }

    #[tokio::test]
    async fn market_snapshot_covers_all_securities_and_board_partitions() {
        let core = AppCore::new(Box::new(data_provider::mock::MockProvider::new())).await.unwrap();
        let snapshot = core.market_snapshot().await.unwrap();
        assert_eq!(snapshot.sample_count, core.securities.len());
        assert_eq!(snapshot.sample_count, 120, "模拟域样本口径应为 120 只");
        assert_eq!(snapshot.rows.len(), 120);
        assert!(snapshot.data_date.len() == 10, "数据时间应为最后一个交易日");
        // 卡 AC-01.01-01：页头日期同时要与 manifest coverage_end 对得上（独立来源）。
        assert_eq!(snapshot.coverage_end, snapshot.data_date);
        assert!(snapshot.coverage_start.len() == 10);

        for row in &snapshot.rows {
            assert!(row.last_price.is_some(), "{} 缺最新价", row.security);
            assert!(row.change_pct.is_some(), "{} 缺涨跌幅", row.security);
            assert!(row.amount.is_some(), "{} 缺成交额", row.security);
            if row.is_index {
                assert!(row.turnover_pct.is_none(), "指数不应有换手率");
                assert!(row.volume_ratio.is_none(), "指数量比应为 —");
            } else {
                assert!(row.turnover_pct.unwrap() >= 0.0);
            }
            assert!(!row.data_issue, "{} 关键字段缺失", row.security);
        }

        let mut boards: HashMap<&str, usize> = HashMap::new();
        let mut markets: HashMap<&str, usize> = HashMap::new();
        for row in &snapshot.rows {
            *boards.entry(row.board.as_str()).or_default() += 1;
            *markets.entry(row.market.as_str()).or_default() += 1;
        }
        let sum: usize = boards.values().sum();
        assert_eq!(sum, 120, "板块分区必须覆盖全部样本");
        let market_sum: usize = markets.values().sum();
        assert_eq!(market_sum, 120, "沪/深分区必须覆盖全部样本");
        assert!(boards.get("主板").copied().unwrap_or(0) > 0);
        assert!(boards.get("创业板").copied().unwrap_or(0) > 0);
        assert!(boards.get("科创板").copied().unwrap_or(0) > 0);
        assert!(boards.get("指数").copied().unwrap_or(0) > 0);
    }

    fn test_security() -> Security {
        Security {
            code: "TEST.SZ".into(),
            name: "测试标的".into(),
            market: data_provider::Market::Sz,
            board: data_provider::Board::SzMain,
            is_index: false,
            base_price: 10.0,
        }
    }

    fn test_rows(volumes: &[f64], close: f64) -> Vec<data_provider::BarRow> {
        let mut date = Date::new(2026, 1, 1);
        let mut rows = Vec::new();
        for &volume in volumes {
            rows.push(data_provider::BarRow {
                date,
                open: close,
                high: close,
                low: close,
                close,
                volume,
                amount: volume * close,
                adj_factor: 1.0,
                quality: vec![],
                batch_id: None,
                ingested_at: None,
            });
            date = date.next_weekday();
        }
        rows
    }

    #[test]
    fn suspended_row_hides_change_and_keeps_zero_amplitude() {
        let rows = test_rows(&[1_000.0, 1_000.0, 1_000.0, 1_000.0, 1_000.0, 0.0], 10.0);
        let row = summary_row(&test_security(), &rows);
        assert!(row.suspended, "最后一日成交量为 0 应判停牌");
        assert_eq!(row.volume, Some(0.0));
        assert_eq!(row.change_abs, None, "停牌日涨跌额应为 —");
        assert_eq!(row.change_pct, None, "停牌日涨跌幅应为 —");
        assert_eq!(row.amplitude_pct, Some(0.0), "停牌日振幅应为 0.00%");
        assert_eq!(row.volume_ratio, None, "停牌日量比应为 —");
    }

    #[test]
    fn zero_prior_volume_makes_ratio_indefinite() {
        let rows = test_rows(&[0.0, 0.0, 0.0, 0.0, 0.0, 1_000.0], 10.0);
        let row = summary_row(&test_security(), &rows);
        assert!(!row.suspended, "当日有成交不应判停牌");
        assert_eq!(
            row.volume_ratio, None,
            "过去 5 日均量为 0 时量比无定义，返回 None 而不是 Infinity"
        );
        assert_eq!(row.change_pct, Some(0.0));
    }

    #[tokio::test]
    async fn watchlist_toggle_groups_and_positions_use_state_db() {
        let core = AppCore::new(Box::new(data_provider::mock::MockProvider::new()))
            .await
            .unwrap()
            .with_state_db(data_store::state_db::StateDb::open_in_memory().unwrap());

        let first = core.toggle_watch("600519.SH", None).unwrap();
        assert!(first.watched);
        assert_eq!(first.total, 1);
        let off = core.toggle_watch("600519.SH", None).unwrap();
        assert!(!off.watched);
        assert_eq!(off.total, 0);

        core.create_watch_group("短线").unwrap();
        assert!(core.create_watch_group("短线").is_err(), "重名分组应拒绝");
        let added = core.toggle_watch("600519.SH", Some("短线")).unwrap();
        assert!(added.watched);
        let watchlist = core.watchlist().unwrap();
        assert_eq!(watchlist.total, 1);
        assert!(watchlist
            .groups
            .iter()
            .any(|group| group.name == "短线" && group.count == 1 && !group.is_builtin));

        core.rename_watch_group("短线", "波段").unwrap();
        assert!(core.delete_watch_group("全部").is_err(), "内置组不可删除");
        core.delete_watch_group("波段").unwrap();
        let after = core.watchlist().unwrap();
        assert_eq!(after.items[0].group_name, None, "删组后标的应回到未分组");
        assert!(
            after.groups.iter().any(|group| group.name == "未分组" && group.count == 1),
            "未分组应为只读派生视图"
        );

        core.save_position("600519.SH", 1500.0, 100).unwrap();
        assert!(core.save_position("600519.SH", -1.0, 100).is_err());
        assert_eq!(core.positions().unwrap()[0].shares, 100);
        core.delete_position("600519.SH").unwrap();
        assert!(core.positions().unwrap().is_empty());
    }

    #[tokio::test]
    async fn watchlist_cap_is_500_distinct_securities() {
        let core = AppCore::new(Box::new(data_provider::mock::MockProvider::new()))
            .await
            .unwrap()
            .with_state_db(data_store::state_db::StateDb::open_in_memory().unwrap());
        // 模拟域只有 120 只，直接写 500 条到 state.db 验证上限分支
        {
            let db = core.state_db().unwrap();
            for i in 0..500 {
                db.add_watch_with_limit(&format!("TEST{i}.SZ"), None, i, 500)
                    .unwrap();
            }
        }
        let err = core.toggle_watch("600519.SH", None).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidArgument);
        assert_eq!(err.details.as_ref().unwrap()["reason"], "WATCHLIST_LIMIT");
    }

    #[tokio::test]
    async fn watchlist_removes_security_that_left_the_dataset() {
        let core = AppCore::new(Box::new(data_provider::mock::MockProvider::new()))
            .await
            .unwrap()
            .with_state_db(data_store::state_db::StateDb::open_in_memory().unwrap());
        core.state_db()
            .unwrap()
            .add_watch_with_limit("DELISTED.SZ", None, 0, 500)
            .unwrap();
        // 不在数据集的已收藏标的：移出必须成功，新增仍被拒
        let out = core.toggle_watch("DELISTED.SZ", None).unwrap();
        assert!(!out.watched);
        assert!(core.watchlist().unwrap().items.is_empty());
        assert!(core.toggle_watch("DELISTED.SZ", None).is_err());
    }

    #[tokio::test]
    async fn watchlist_re_adds_security_after_it_returns_to_dataset() {
        let path = std::env::temp_dir().join(format!("aka-watchlist-readd-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        // 第一段：标的已离开数据集 → 移出成功，库里不留任何残行（没有软删除/墓碑）
        {
            let core = AppCore::new(Box::new(data_provider::mock::MockProvider::new()))
                .await
                .unwrap()
                .with_state_db(StateDb::open_with_fallback(&path));
            core.state_db()
                .unwrap()
                .add_watch_with_limit("DIAG020.SZ", None, 0, 500)
                .unwrap();
            assert!(!core.toggle_watch("DIAG020.SZ", None).unwrap().watched);
            assert!(core.state_db().unwrap().watchlist().unwrap().is_empty());
        }
        // 第二段：标的回到数据集（provider 里又有 DIAG020.SZ）→ 可重新收藏
        let core = AppCore::new(Box::new(
            data_provider::mock::MockProvider::new().with_diag_short_series(20),
        ))
        .await
        .unwrap()
        .with_state_db(StateDb::open_with_fallback(&path));
        let back = core.toggle_watch("DIAG020.SZ", None).unwrap();
        assert!(back.watched, "回到数据集后应能重新收藏");
        assert_eq!(back.total, 1);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn snaps_to_trading_day_and_clamps() {
        // 2024-12-20 周五起 10 个交易日；起点给周六，终点给周日之外
        let s = series(Date::new(2024, 12, 20), 10);
        let w = resolve_window(&s, Some("2024-12-21"), Some("2024-12-24")).unwrap();
        assert_eq!(s.candles[w.start].date, "2024-12-23");
        assert_eq!(s.candles[w.end - 1].date, "2024-12-24");
        assert_eq!(w.range.bar_count, 2);
        assert!(w.range.clamped);
    }

    #[test]
    fn to_beyond_last_is_clamped_not_error() {
        let s = series(Date::new(2024, 12, 20), 5);
        let w = resolve_window(&s, None, Some("2025-06-01")).unwrap();
        assert_eq!(w.end, 5);
        assert_eq!(w.range.returned_to.as_deref(), Some(s.candles.last().unwrap().date.as_str()));
        assert!(w.range.clamped);
    }

    #[test]
    fn from_after_last_is_insufficient_data() {
        let s = series(Date::new(2024, 12, 20), 5);
        let err = resolve_window(&s, Some("2025-06-01"), None).unwrap_err();
        assert_eq!(err.code, ErrorCode::InsufficientData);
        assert_eq!(err.details.as_ref().unwrap()["totalBars"], 5);
    }

    #[test]
    fn inverted_and_too_long_are_invalid() {
        let s = series(Date::new(2024, 12, 20), 5);
        let err = resolve_window(&s, Some("2024-12-24"), Some("2024-12-23")).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidArgument);

        let err = resolve_window(&s, Some("2014-01-01"), Some("2024-12-31")).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidArgument);
        assert_eq!(err.details.as_ref().unwrap()["maxDays"], MAX_RANGE_DAYS);
    }

    #[test]
    fn max_bars_detail_fields() {
        // 2501 个交易日约 9.6 年，日历跨度未超 10 年，但返回根数超上限。
        let s = series(Date::new(2020, 1, 2), MAX_RANGE_BARS + 1);
        let first = s.candles.first().unwrap().date.clone();
        let last = s.candles.last().unwrap().date.clone();
        let err = resolve_window(&s, Some(&first), Some(&last)).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidArgument);
        let details = err.details.as_ref().expect("超根数必须带 details");
        assert_eq!(details["maxBars"], MAX_RANGE_BARS);
        assert_eq!(details["requestedBars"], MAX_RANGE_BARS + 1);
    }

    #[test]
    fn bad_date_format_is_invalid() {
        let s = series(Date::new(2024, 12, 20), 5);
        let err = resolve_window(&s, Some("2024-02-30"), None).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidArgument);
        assert_eq!(err.details.as_ref().unwrap()["field"], "from");
    }

    #[test]
    fn default_window_covers_all_bars() {
        let s = series(Date::new(2024, 12, 20), 7);
        let w = resolve_window(&s, None, None).unwrap();
        assert_eq!((w.start, w.end), (0, 7));
        assert!(!w.range.clamped);
    }

    /// QA-S0 T-01：IPC 回参是 ISO 日期，不含任何下标字段。
    #[test]
    fn range_wire_format_is_dates_not_indexes() {
        let s = series(Date::new(2024, 12, 20), 5);
        let w = resolve_window(&s, Some("2024-12-20"), Some("2025-06-01")).unwrap();
        let json = serde_json::to_value(&w.range).unwrap();
        for key in ["requestedFrom", "requestedTo", "returnedFrom", "returnedTo", "barCount", "clamped"] {
            assert!(json.get(key).is_some(), "缺少字段 {key}: {json}");
        }
        for key in ["from", "to", "startIndex", "endIndex", "start", "end"] {
            assert!(json.get(key).is_none(), "不应出现下标/旧字段 {key}: {json}");
        }
        assert_eq!(json["requestedFrom"], "2024-12-20");
        assert_eq!(json["returnedFrom"], "2024-12-20");
    }

    /// QA-S0-033 / S-02.06-02：缓存键必须是七元组（含 DateRange），区间变化即换键。
    #[test]
    fn cache_key_includes_date_range() {
        let s = series(Date::new(2024, 12, 20), 10);
        let meta = lookup("ma").unwrap().meta();
        let params = merge_defaults(meta.params, &Params::new());
        let a = resolve_window(&s, Some("2024-12-20"), Some("2024-12-24")).unwrap();
        let b = resolve_window(&s, Some("2024-12-20"), Some("2024-12-26")).unwrap();
        let key_a = calc_key(&s, meta, &params, &a.range);
        let key_b = calc_key(&s, meta, &params, &b.range);
        assert_ne!(key_a, key_b, "区间变化必须产生不同缓存键");
        assert!(key_a.contains("2024-12-24~2024-12-24") || key_a.contains("2024-12-20~2024-12-24"));
        assert_eq!(key_a.matches('|').count(), 8, "v2 + 7 个维度 + 1 段 range");
    }

    /// S2：D/W/M 切换必须换缓存键，不得命中旧周期缓存。
    #[test]
    fn cache_key_includes_timeframe() {
        let daily = series(Date::new(2024, 12, 20), 10);
        let mut weekly = series(Date::new(2024, 12, 20), 10);
        weekly.timeframe = "1w".into();
        let mut monthly = series(Date::new(2024, 12, 20), 10);
        monthly.timeframe = "1m".into();
        let meta = lookup("ma").unwrap().meta();
        let params = merge_defaults(meta.params, &Params::new());
        let window = resolve_window(&daily, Some("2024-12-20"), Some("2024-12-26")).unwrap();
        let kd = calc_key(&daily, meta, &params, &window.range);
        let kw = calc_key(&weekly, meta, &params, &window.range);
        let km = calc_key(&monthly, meta, &params, &window.range);
        assert_ne!(kd, kw, "D→W 必须产生不同缓存键");
        assert_ne!(kw, km, "W→M 必须产生不同缓存键");
        assert!(kd.contains("|1d|") && kw.contains("|1w|") && km.contains("|1m|"));
    }

    /// S-EP05-04：只改复权口径必须换缓存键。
    #[test]
    fn cache_key_includes_adj() {
        let qfq = series(Date::new(2024, 12, 20), 10);
        let mut hfq = series(Date::new(2024, 12, 20), 10);
        hfq.adj = "hfq".into();
        let meta = lookup("ma").unwrap().meta();
        let params = merge_defaults(meta.params, &Params::new());
        let window = resolve_window(&qfq, Some("2024-12-20"), Some("2024-12-26")).unwrap();
        let kq = calc_key(&qfq, meta, &params, &window.range);
        let kh = calc_key(&hfq, meta, &params, &window.range);
        assert_ne!(kq, kh, "qfq→hfq 必须产生不同缓存键");
        assert!(kq.contains("|qfq|") && kh.contains("|hfq|"));
    }

    /// S-EP05-04：数据集重建（dataset_id 变化）必须换缓存键。
    #[test]
    fn cache_key_includes_dataset_id() {
        let a = series(Date::new(2024, 12, 20), 10);
        let mut b = series(Date::new(2024, 12, 20), 10);
        b.dataset_id = "ds-rebuilt".into();
        let meta = lookup("ma").unwrap().meta();
        let params = merge_defaults(meta.params, &Params::new());
        let window = resolve_window(&a, Some("2024-12-20"), Some("2024-12-26")).unwrap();
        let ka = calc_key(&a, meta, &params, &window.range);
        let kb = calc_key(&b, meta, &params, &window.range);
        assert_ne!(ka, kb, "dataset_id 变化必须产生不同缓存键");
        assert!(kb.contains("|ds-rebuilt|"));
    }

    /// S-EP05-04：参数内容相同、插入顺序不同，键必须相同（`Params` 为 `BTreeMap`）。
    #[test]
    fn cache_key_stable_for_equal_params() {
        let s = series(Date::new(2024, 12, 20), 10);
        let meta = lookup("ma").unwrap().meta();
        let forward = Params::from([
            ("fast".to_string(), indicator_core::ParamValue::Int(12)),
            ("slow".to_string(), indicator_core::ParamValue::Int(26)),
        ]);
        let backward = Params::from([
            ("slow".to_string(), indicator_core::ParamValue::Int(26)),
            ("fast".to_string(), indicator_core::ParamValue::Int(12)),
        ]);
        let window = resolve_window(&s, Some("2024-12-20"), Some("2024-12-26")).unwrap();
        assert_eq!(
            calc_key(&s, meta, &forward, &window.range),
            calc_key(&s, meta, &backward, &window.range),
            "参数插入顺序不得影响缓存键"
        );
    }

    /// S-EP05-04：`params_hash` 固定 16 位小写十六进制，仅用于埋点。
    #[test]
    fn params_hash_is_16_lower_hex() {
        let s = series(Date::new(2024, 12, 20), 10);
        let meta = lookup("ma").unwrap().meta();
        let params = merge_defaults(meta.params, &Params::new());
        let hash = params_hash(&params);
        assert_eq!(hash.len(), 16, "params_hash 必须固定 16 位：{hash}");
        assert!(
            hash.chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)),
            "params_hash 必须是小写十六进制：{hash}"
        );
        let window = resolve_window(&s, Some("2024-12-20"), Some("2024-12-26")).unwrap();
        assert!(
            !calc_key(&s, meta, &params, &window.range).contains(&hash),
            "params_hash 只进埋点，不参与缓存键"
        );
    }

    /// S-EP05-03 AC2/AC3：命中不是「全有或全无」——只有部分键命中时 cacheHit=false。
    #[tokio::test]
    async fn cache_hit_is_all_or_nothing() {
        let core = AppCore::new_mock().await.unwrap();
        let call = |second: bool| {
            let mut instances = vec![calc_instance("a", "T01", &[("period", 20)])];
            instances.push(if second {
                calc_instance("c", "T01", &[("period", 40)])
            } else {
                calc_instance("b", "T01", &[("period", 30)])
            });
            calc_request("D", instances)
        };

        let first = core.calc_indicators(&call(false)).await.unwrap();
        assert!(!first.cache_hit);

        let before = core.telemetry().summary(0).counts;
        let second = core.calc_indicators(&call(true)).await.unwrap();
        let after = core.telemetry().summary(0).counts;
        assert!(!second.cache_hit, "部分命中必须报 cacheHit=false");
        assert_eq!(
            after.get(crate::telemetry::EVENT_CACHE_HIT).copied().unwrap_or(0)
                - before.get(crate::telemetry::EVENT_CACHE_HIT).copied().unwrap_or(0),
            1
        );
        assert_eq!(
            after.get(crate::telemetry::EVENT_CACHE_MISS).copied().unwrap_or(0)
                - before.get(crate::telemetry::EVENT_CACHE_MISS).copied().unwrap_or(0),
            1
        );
    }

    /// S-EP05-03 AC3：全部命中时 computedMs 必须收敛为 0.0。
    #[tokio::test]
    async fn fully_cached_request_reports_zero_computed_ms() {
        let core = AppCore::new_mock().await.unwrap();
        let request = calc_request(
            "D",
            vec![
                calc_instance("a", "T01", &[("period", 20)]),
                calc_instance("b", "M06", &[("fast", 12), ("slow", 26), ("signal", 9)]),
            ],
        );
        let first = core.calc_indicators(&request).await.unwrap();
        assert!(first.computed_ms >= 0.0);
        let second = core.calc_indicators(&request).await.unwrap();
        assert!(second.cache_hit);
        assert_eq!(second.computed_ms, 0.0, "全命中不应再耗时计算");
    }

    /// S-EP05-07 AC2：`QualityFlag` 的 8 个 wire 串冻结（大小写混排，按原样输出）。
    #[test]
    fn quality_flag_wire_strings_are_exactly_eight() {
        use data_provider::QualityFlag::*;
        let flags = [
            Simulated,
            LimitUp,
            LimitDown,
            SplitDay,
            Suspended,
            ExRights,
            ZeroVolume,
            PriceAnomaly,
        ];
        let wires: Vec<&str> = flags.iter().map(|flag| flag.as_str()).collect();
        assert_eq!(
            wires,
            vec![
                "simulated",
                "limitUp",
                "limitDown",
                "splitDay",
                "SUSPENDED",
                "EX_RIGHTS",
                "ZERO_VOLUME",
                "PRICE_ANOMALY",
            ],
            "wire 串冻结，不得改名或统一大小写"
        );
    }

    /// S-EP05-06 AC1/AC2：日线只取一次；周/月从同一日线批次聚合，不重复取数。
    #[tokio::test]
    async fn series_reuses_daily_batch_and_store() {
        let core = AppCore::new_mock().await.unwrap();
        let request = calc_request("D", vec![calc_instance("a", "T01", &[("period", 20)])]);
        core.calc_indicators(&request).await.unwrap();
        assert_eq!(core.store.lock().unwrap().loaded_series(), 1);
        assert_eq!(core.daily_batches.lock().unwrap().len(), 1);

        core.calc_indicators(&request).await.unwrap();
        assert_eq!(core.store.lock().unwrap().loaded_series(), 1, "第二次应命中 store");
        assert_eq!(core.daily_batches.lock().unwrap().len(), 1);

        for timeframe in ["W", "M"] {
            let mut aggregated = request.clone();
            aggregated.timeframe = timeframe.into();
            core.calc_indicators(&aggregated).await.unwrap();
        }
        assert_eq!(
            core.daily_batches.lock().unwrap().len(),
            1,
            "周/月聚合不得新增日线取数批次"
        );
    }

    /// S-EP05-06 AC3：未知标的口径为 `E_UNKNOWN_SECURITY`，details 带 code。
    #[tokio::test]
    async fn unknown_security_maps_to_e_unknown_security() {
        let core = AppCore::new_mock().await.unwrap();
        let err = core
            .series_for("NOPE.SH", Timeframe::Day, Adjust::Qfq)
            .await
            .unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::UnknownSecurity);
        assert_eq!(
            err.details.as_ref().and_then(|d| d.get("security")),
            Some(&serde_json::json!("NOPE.SH"))
        );
    }

    /// S-EP05-05 AC1/AC2/AC5：513 个互异键后只保留 512，最早插入的键被淘汰。
    #[test]
    fn calc_cache_evicts_oldest_beyond_limit() {
        let mut cache = CalcCache::default();
        for i in 0..=CALC_CACHE_MAX {
            cache.insert(format!("k{i}"), Arc::new(vec![vec![i as f64]]));
        }
        assert_eq!(cache.len(), CALC_CACHE_MAX);
        assert!(cache.get("k0").is_none(), "最早插入的键必须被淘汰");
        assert!(cache.get("k1").is_some(), "只淘汰最早一个键");
        assert!(
            cache.get(&format!("k{CALC_CACHE_MAX}")).is_some(),
            "最后插入的键必须在"
        );
    }

    /// S-EP05-05 AC3：恰好 512 个互异键时一个都不能被误淘汰。
    #[test]
    fn calc_cache_keeps_exactly_512_hits() {
        let mut cache = CalcCache::default();
        for i in 0..CALC_CACHE_MAX {
            cache.insert(format!("k{i}"), Arc::new(vec![vec![i as f64]]));
        }
        assert_eq!(cache.len(), CALC_CACHE_MAX);
        for i in 0..CALC_CACHE_MAX {
            assert!(
                cache.get(&format!("k{i}")).is_some(),
                "第 {i} 个键被误淘汰"
            );
        }
    }

    /// S-EP05-05：重复插入同键不改变首次插入顺序，不额外占容量。
    #[test]
    fn calc_cache_reinsert_same_key_keeps_first_order() {
        let mut cache = CalcCache::default();
        for i in 0..CALC_CACHE_MAX {
            cache.insert(format!("k{i}"), Arc::new(vec![vec![0.0]]));
        }
        // 重写 k0：仍是首次插入位置，插入 k512 时应淘汰 k0 而不是别人。
        cache.insert("k0".into(), Arc::new(vec![vec![1.0]]));
        cache.insert("k512".into(), Arc::new(vec![vec![2.0]]));
        assert_eq!(cache.len(), CALC_CACHE_MAX);
        assert!(cache.get("k0").is_none(), "k0 仍是 FIFO 最早键");
        assert!(cache.get("k1").is_some());
        assert!(cache.get("k512").is_some());
    }

    fn bars_req(timeframe: &str, from: Option<&str>, to: Option<&str>) -> GetBarsRequest {
        GetBarsRequest {
            security: "600519.SH".into(),
            timeframe: timeframe.into(),
            adj: "qfq".into(),
            from: from.map(str::to_string),
            to: to.map(str::to_string),
        }
    }

    /// QA-S0-015：周/月线由日线聚合，根数 = ISO 周数 / 自然月数，首末 OHLC 与日线可核对。
    #[tokio::test]
    async fn weekly_and_monthly_aggregate_from_daily_batch() {
        let core = AppCore::new_mock().await.unwrap();
        let daily = core.get_bars(&bars_req("D", None, None)).await.unwrap();
        let weekly = core.get_bars(&bars_req("W", None, None)).await.unwrap();
        let monthly = core.get_bars(&bars_req("M", None, None)).await.unwrap();

        let mut weeks = Vec::new();
        let mut months = Vec::new();
        for bar in &daily.bars {
            let date = Date::parse(&bar.date).unwrap();
            let week = data_provider::iso_week(date);
            if weeks.last() != Some(&week) {
                weeks.push(week);
            }
            let month = data_provider::month_key(date);
            if months.last() != Some(&month) {
                months.push(month);
            }
        }
        assert_eq!(weekly.bars.len(), weeks.len(), "周线根数必须等于 ISO 周数");
        assert_eq!(monthly.bars.len(), months.len(), "月线根数必须等于自然月数");

        // 手算第一周：open 取首日、high/low 取极值、close 取末日、volume/amount 求和。
        let first_week: Vec<&BarDto> = daily
            .bars
            .iter()
            .take_while(|bar| {
                data_provider::iso_week(Date::parse(&bar.date).unwrap()) == weeks[0]
            })
            .collect();
        let week = &weekly.bars[0];
        assert_eq!(week.open, first_week[0].open);
        assert_eq!(week.close, first_week.last().unwrap().close);
        let high = first_week.iter().fold(f64::MIN, |acc, bar| acc.max(bar.high));
        let low = first_week.iter().fold(f64::MAX, |acc, bar| acc.min(bar.low));
        assert!((week.high - high).abs() < 1e-9);
        assert!((week.low - low).abs() < 1e-9);
        let volume: f64 = first_week.iter().map(|bar| bar.volume).sum();
        assert!((week.volume - volume).abs() < 1e-6);
        assert_eq!(week.date, first_week.last().unwrap().date);

        assert_eq!(weekly.bars.last().unwrap().close, daily.bars.last().unwrap().close);
        assert_eq!(monthly.bars.first().unwrap().open, daily.bars.first().unwrap().open);
        assert_eq!(monthly.bars.last().unwrap().close, daily.bars.last().unwrap().close);
        assert_eq!(weekly.provenance.dataset_generation, 1);
        assert_eq!(monthly.provenance.dataset_generation, 1);
        assert_eq!(monthly.bars.last().unwrap().date, daily.bars.last().unwrap().date);
    }

    /// S-07.05-02：单根必须先有溯源字段（provider/batch/ingested_at），再谈浮层展示。
    #[tokio::test]
    async fn daily_bars_carry_provenance_and_derived_quality_flags() {
        let core = AppCore::new_mock().await.unwrap();
        let daily = core.get_bars(&bars_req("D", None, None)).await.unwrap();

        // mock 溯源用固定批次与固定入库秒，不能取墙钟时间，否则 bench 快照不可复现。
        for bar in &daily.bars {
            assert_eq!(bar.source, "mock");
            assert_eq!(bar.batch_id.as_deref(), Some("b-20260101-01"));
            assert_eq!(bar.ingested_at, Some(1_767_225_600));
        }

        // 600519.SH 夹具在 2024-04-29 注入 2:1 拆分：该根必须标 EX_RIGHTS 且不误判价格异常。
        let split = daily
            .bars
            .iter()
            .find(|bar| bar.date == "2024-04-29")
            .expect("600519.SH 夹具应含 2024-04-29 除权日");
        assert!(
            split.quality.iter().any(|flag| flag == "EX_RIGHTS"),
            "除权日必须标记 EX_RIGHTS"
        );
        assert!(
            !split.quality.iter().any(|flag| flag == "PRICE_ANOMALY"),
            "除权日跳变不应判为价格异常"
        );

        // 周线聚合的溯源取最后成交日批次，字段不能丢。
        let weekly = core.get_bars(&bars_req("W", None, None)).await.unwrap();
        assert!(weekly
            .bars
            .iter()
            .all(|bar| bar.batch_id.as_deref() == Some("b-20260101-01")));

        // W-53：除权标记在周/月聚合根上同样显形；粒度只到周/月，不能定位到日。
        let monthly = core.get_bars(&bars_req("M", None, None)).await.unwrap();
        let split_date = Date::parse("2024-04-29").unwrap();
        let split_week = data_provider::iso_week(split_date);
        let week_bar = weekly
            .bars
            .iter()
            .find(|bar| data_provider::iso_week(Date::parse(&bar.date).unwrap()) == split_week)
            .expect("应存在包含 2024-04-29 的周线根");
        assert!(
            week_bar.quality.iter().any(|flag| flag == "EX_RIGHTS"),
            "包含除权日的周线根必须标 EX_RIGHTS"
        );
        let split_month = data_provider::month_key(split_date);
        let month_bar = monthly
            .bars
            .iter()
            .find(|bar| data_provider::month_key(Date::parse(&bar.date).unwrap()) == split_month)
            .expect("应存在 2024-04 月线根");
        assert!(
            month_bar.quality.iter().any(|flag| flag == "EX_RIGHTS"),
            "包含除权日的月线根必须标 EX_RIGHTS"
        );
    }

    /// S-07.05-02：点单根取六类溯源字段，除权根带 EX_RIGHTS 与复权前后价。
    #[tokio::test]
    async fn bar_provenance_returns_six_fields_and_adjacent_prices() {
        let core = AppCore::new_mock().await.unwrap();
        let req = |date: &str| BarProvenanceRequest {
            security: "600519.SH".into(),
            date: date.into(),
            timeframe: "D".into(),
            adj: "qfq".into(),
        };

        let split = core.bar_provenance(&req("2024-04-29")).await.unwrap();
        assert_eq!(split.provider, "mock");
        assert_eq!(split.batch_id.as_deref(), Some("b-20260101-01"));
        assert_eq!(split.ingested_at, Some(1_767_225_600));
        assert_eq!(
            split.dataset_id,
            core.dataset_manifest().unwrap().dataset_id
        );
        assert_eq!(split.adj_mode, "qfq");
        assert!(split.quality_flags.iter().any(|flag| flag == "EX_RIGHTS"));
        assert!(split.missing_fields.is_empty());
        assert!(split.error_code.is_none());

        // 拆分前一根按 qfq 折算，复权前后价必须不同，浮层才有对照可展示。
        let before = core.bar_provenance(&req("2024-04-26")).await.unwrap();
        assert!(
            (before.raw_close - before.close).abs() > 1e-6,
            "前复权根应给出不同的复权前后价"
        );
    }

    /// W-67：生产装配（provider BarRow → Candle）必须给批次元数据落值；
    /// `build_bar_provenance` 的透传只是最后一环，不能替代装配层的断言。
    #[tokio::test]
    async fn production_assembly_sets_batch_meta_on_candles() {
        let core = AppCore::new_mock().await.unwrap();
        for timeframe in [Timeframe::Day, Timeframe::Week] {
            let series = core
                .series_for("600519.SH", timeframe, Adjust::Qfq)
                .await
                .unwrap();
            assert!(!series.candles.is_empty(), "{timeframe:?} 序列为空");
            for candle in &series.candles {
                assert_eq!(
                    candle.batch_id.as_deref(),
                    Some("b-20260101-01"),
                    "{timeframe:?} {} 的 batch_id 未在装配时落值",
                    candle.date
                );
                assert_eq!(
                    candle.ingested_at,
                    Some(1_767_225_600),
                    "{timeframe:?} {} 的 ingested_at 未在装配时落值",
                    candle.date
                );
            }
        }
    }

    /// S-07.05-02 补4：清空 batch_id/ingested_at 时必须回 `E_PROVENANCE_MISSING`，不是空白。
    #[test]
    fn missing_batch_meta_yields_provenance_error_code() {
        let candle = Candle {
            ts: 0,
            date: "2024-04-29".into(),
            open: 10.0,
            high: 10.0,
            low: 10.0,
            close: 10.0,
            volume: 100.0,
            amount: 1_000.0,
            adj_factor: 1.0,
            quality: vec!["EX_RIGHTS".into()],
            source: "mock".into(),
            batch_id: None,
            ingested_at: None,
        };
        let dto = build_bar_provenance("600519.SH", &candle, "ds-test", "qfq", 10.0);
        assert_eq!(dto.missing_fields, vec!["batchId", "ingestedAt"]);
        assert_eq!(dto.error_code, Some(E_PROVENANCE_MISSING));
        assert_eq!(dto.provider, "mock", "其余字段照常返回");
    }

    /// S-07.05-02 补2：停牌根只标 SUSPENDED，不重复标 ZERO_VOLUME。
    #[tokio::test]
    async fn suspended_bars_are_not_flagged_as_zero_volume() {
        let core = AppCore::new(Box::new(
            data_provider::mock::MockProvider::new().with_diag_suspended_series(120, 80, 20),
        ))
        .await
        .unwrap();
        let req = GetBarsRequest {
            security: "DIAGSUSP.SZ".into(),
            timeframe: "D".into(),
            adj: "none".into(),
            from: None,
            to: None,
        };
        let bars = core.get_bars(&req).await.unwrap();
        let suspended: Vec<&BarDto> = bars
            .bars
            .iter()
            .filter(|bar| bar.quality.iter().any(|flag| flag == "SUSPENDED"))
            .collect();
        assert_eq!(suspended.len(), 20, "注入 20 根停牌");
        for bar in suspended {
            assert_eq!(bar.volume, 0.0);
            assert!(
                !bar.quality.iter().any(|flag| flag == "ZERO_VOLUME"),
                "停牌已单独标记，不应再叠 ZERO_VOLUME"
            );
        }
    }

    /// QA-S0-022 / 028 / 029：同请求去重、缓存命中、冷耗时都有结构化事件。
    #[tokio::test]
    async fn calc_telemetry_records_dedup_cache_and_cold_ms() {
        let core = AppCore::new_mock().await.unwrap();
        let request = |generation: u64| CalcRequest {
            security: "600519.SH".into(),
            timeframe: "D".into(),
            adj: "qfq".into(),
            from: None,
            to: None,
            generation,
            instances: vec![
                crate::dto::InstanceRequest {
                    instance_id: "a".into(),
                    indicator_id: "T01".into(),
                    params: std::collections::BTreeMap::from([(
                        "period".to_string(),
                        indicator_core::ParamValue::Int(20),
                    )]),
                },
                crate::dto::InstanceRequest {
                    instance_id: "b".into(),
                    indicator_id: "T01".into(),
                    params: std::collections::BTreeMap::from([(
                        "period".to_string(),
                        indicator_core::ParamValue::Int(20),
                    )]),
                },
                crate::dto::InstanceRequest {
                    instance_id: "c".into(),
                    indicator_id: "T01".into(),
                    params: std::collections::BTreeMap::from([(
                        "period".to_string(),
                        indicator_core::ParamValue::Int(30),
                    )]),
                },
            ],
        };

        let first = core.calc_indicators(&request(1)).await.unwrap();
        assert!(!first.cache_hit);
        assert_eq!(first.dataset_generation, 1);
        assert_eq!(first.series.len(), 3);

        let events = core.telemetry().events();
        let name = |event: &crate::telemetry::TelemetryEvent| event.name.clone();
        let counts = core.telemetry().summary(0).counts;
        assert_eq!(counts.get(crate::telemetry::EVENT_INDICATOR_COMPUTE), Some(&2));
        assert_eq!(counts.get(crate::telemetry::EVENT_CACHE_MISS), Some(&2));
        assert_eq!(counts.get(crate::telemetry::EVENT_COMPUTE_SKIP), Some(&1));
        let count_event = events
            .iter()
            .find(|event| name(event) == crate::telemetry::EVENT_COMPUTE_COUNT)
            .expect("必须有 compute.count");
        assert_eq!(count_event.fields["count"], 2);
        assert_eq!(count_event.fields["skip"], 1);
        assert_eq!(count_event.fields["instances"], 3);
        let skip_event = events
            .iter()
            .find(|event| name(event) == crate::telemetry::EVENT_COMPUTE_SKIP)
            .expect("必须有 compute.skip");
        assert_eq!(skip_event.fields["reason"], "duplicateKey");
        assert_eq!(skip_event.fields["instanceId"], "b");
        assert!(core.telemetry().cold_p95_ms().is_some());

        // 同请求再算一次：全部命中缓存，不再执行计算。
        let second = core.calc_indicators(&request(2)).await.unwrap();
        assert!(second.cache_hit);
        let counts = core.telemetry().summary(0).counts;
        assert_eq!(counts.get(crate::telemetry::EVENT_CACHE_HIT), Some(&2));
        assert_eq!(counts.get(crate::telemetry::EVENT_INDICATOR_COMPUTE), Some(&2));
    }

    /// S-EP05-02 AC3：多输出指标（MACD）命中同键去重时，全部输出列一起复用。
    #[tokio::test]
    async fn dedup_reuses_all_outputs_for_multi_output_indicator() {
        let core = AppCore::new_mock().await.unwrap();
        let request = CalcRequest {
            security: "600519.SH".into(),
            timeframe: "D".into(),
            adj: "qfq".into(),
            from: None,
            to: None,
            generation: 1,
            instances: vec![
                calc_instance("a", "M06", &[("fast", 12), ("slow", 26), ("signal", 9)]),
                calc_instance("b", "M06", &[("fast", 12), ("slow", 26), ("signal", 9)]),
            ],
        };
        let response = core.calc_indicators(&request).await.unwrap();
        assert_eq!(response.series.len(), 2);
        let first = &response.series[0];
        let second = &response.series[1];
        assert_eq!(first.outputs.len(), 3, "MACD 必须保留三条输出");
        assert_eq!(second.outputs.len(), 3);
        for (left, right) in first.outputs.iter().zip(&second.outputs) {
            assert_eq!(left.values, right.values, "去重实例必须逐点复用输出");
        }
        let counts = core.telemetry().summary(0).counts;
        assert_eq!(counts.get(crate::telemetry::EVENT_INDICATOR_COMPUTE), Some(&1));
        assert_eq!(counts.get(crate::telemetry::EVENT_COMPUTE_SKIP), Some(&1));
    }

    /// S-EP05-05 AC4：同一请求内 3 个实例同键，只新增 1 个缓存键（去重不额外占容量）。
    #[tokio::test]
    async fn calc_cache_same_key_dedup_adds_one_entry() {
        let core = AppCore::new_mock().await.unwrap();
        let instance = |id: &str| crate::dto::InstanceRequest {
            instance_id: id.into(),
            indicator_id: "T01".into(),
            params: std::collections::BTreeMap::from([(
                "period".to_string(),
                indicator_core::ParamValue::Int(20),
            )]),
        };
        let request = |generation: u64| CalcRequest {
            security: "600519.SH".into(),
            timeframe: "D".into(),
            adj: "qfq".into(),
            from: None,
            to: None,
            generation,
            instances: vec![instance("a"), instance("b"), instance("c")],
        };

        let first = core.calc_indicators(&request(1)).await.unwrap();
        assert!(!first.cache_hit);
        assert_eq!(
            core.calc_cache.lock().unwrap().len(),
            1,
            "3 个同键实例只应占 1 个缓存条目"
        );

        let second = core.calc_indicators(&request(2)).await.unwrap();
        assert!(second.cache_hit, "同键再请求必须命中缓存");
        assert_eq!(core.calc_cache.lock().unwrap().len(), 1);
    }

    /// QA-S0-028：主图 2 叠加 + 副图 3（M06 三次不同参数，含重复 id），5 个实例键全不重复
    /// → `compute.count=5`、`compute.skip=0`；与上面 3 实例用例的「含重复键 → skip=1」是不同场景。
    #[tokio::test]
    async fn calc_telemetry_counts_five_instances_without_skips() {
        let core = AppCore::new_mock().await.unwrap();
        let instance = |id: &str, indicator: &str, params: &[(&str, i64)]| crate::dto::InstanceRequest {
            instance_id: id.into(),
            indicator_id: indicator.into(),
            params: params
                .iter()
                .map(|(key, value)| (key.to_string(), indicator_core::ParamValue::Int(*value)))
                .collect(),
        };
        let request = CalcRequest {
            security: "600519.SH".into(),
            timeframe: "D".into(),
            adj: "qfq".into(),
            from: None,
            to: None,
            generation: 1,
            instances: vec![
                instance("main-sma", "T01", &[("period", 20)]),
                instance("main-ema", "T02", &[("period", 20)]),
                instance("sub-macd-1", "M06", &[("fast", 12), ("slow", 26), ("signal", 9)]),
                instance("sub-macd-2", "M06", &[("fast", 5), ("slow", 10), ("signal", 3)]),
                instance("sub-macd-3", "M06", &[("fast", 12), ("slow", 26), ("signal", 5)]),
            ],
        };

        let response = core.calc_indicators(&request).await.unwrap();
        assert!(!response.cache_hit);
        assert_eq!(response.series.len(), 5);

        let counts = core.telemetry().summary(0).counts;
        assert_eq!(counts.get(crate::telemetry::EVENT_INDICATOR_COMPUTE), Some(&5));
        assert_eq!(counts.get(crate::telemetry::EVENT_CACHE_MISS), Some(&5));
        assert_eq!(
            counts
                .get(crate::telemetry::EVENT_COMPUTE_SKIP)
                .copied()
                .unwrap_or(0),
            0,
            "5 个实例键各不相同，不应产生 compute.skip"
        );
        let count_event = core
            .telemetry()
            .events()
            .into_iter()
            .find(|event| event.name == crate::telemetry::EVENT_COMPUTE_COUNT)
            .expect("必须有 compute.count");
        assert_eq!(count_event.fields["count"], 5);
        assert_eq!(count_event.fields["skip"], 0);
        assert_eq!(count_event.fields["instances"], 5);
        assert_eq!(count_event.fields["cacheHit"], false);
    }

    /// TD-S0-07 微基准：把缓存命中路径拆成 5 段计时（非交付断言，手动运行）。
    ///
    /// ```text
    /// cargo test -p app-core --release microbench_breakdown -- --ignored --nocapture
    /// cargo test -p app-core           microbench_breakdown -- --ignored --nocapture   # dev 构建
    /// ```
    #[ignore = "微基准，手动运行"]
    #[tokio::test]
    async fn microbench_breakdown() {
        fn synth(security: &str, bars: usize) -> CandleSeries {
            let mut day = Date::new(2020, 1, 2);
            let mut candles = Vec::with_capacity(bars);
            let mut price = 10.0_f64;
            for i in 0..bars {
                // 带噪声的随机游走，避免全等值导致缓存/序列化偏快
                price += ((i as f64 * 0.37).sin() * 0.4) + 0.02;
                candles.push(Candle {
                    ts: day.epoch_secs(),
                    date: day.iso(),
                    open: price,
                    high: price + 0.3,
                    low: price - 0.3,
                    close: price + 0.1,
                    volume: 1_000.0 + i as f64,
                    amount: (1_000.0 + i as f64) * price,
                    adj_factor: 1.0,
                    quality: vec![],
                    source: "bench".to_string(),
                    batch_id: None,
                    ingested_at: None,
                });
                day = day.next_weekday();
            }
            CandleSeries {
                security: security.into(),
                timeframe: "D".into(),
                adj: "qfq".into(),
                provider: "bench".into(),
                dataset_id: "bench".into(),
                data_version: "v0".into(),
                dataset_generation: 1,
                simulated: true,
                generated_at: 0,
                candles,
            }
        }

        fn percentile(mut samples: Vec<f64>, ratio: f64) -> f64 {
            samples.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let index = ((samples.len() as f64 * ratio).ceil() as usize)
                .saturating_sub(1)
                .min(samples.len() - 1);
            samples[index]
        }

        fn run<F: FnMut()>(label: &str, iters: usize, mut body: F) -> f64 {
            let mut samples = Vec::with_capacity(iters);
            for _ in 0..iters {
                let started = Instant::now();
                body();
                samples.push(started.elapsed().as_secs_f64() * 1000.0);
            }
            let p50 = percentile(samples.clone(), 0.50);
            let p95 = percentile(samples.clone(), 0.95);
            let max = *samples
                .iter()
                .max_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
                .unwrap();
            println!("    {label:<34} p50={p50:8.3}ms p95={p95:8.3}ms max={max:8.3}ms");
            p50
        }

        for bars in [520_usize, 2_500] {
            let core = AppCore::new_mock().await.unwrap();
            let series = std::sync::Arc::new(synth("600519.SH", bars));
            let key = SeriesKey {
                security: "600519.SH".into(),
                timeframe: "D".into(),
                adj: "qfq".into(),
            };
            core.store_lock().unwrap().put(key.clone(), series.clone());

            // 实例集合 = 前端一次请求的真实规模（44 个已实现指标 + 空参数走默认值）
            let mut instance_ids: Vec<&'static str> =
                all().iter().map(|ind| ind.meta().id).collect();
            instance_ids.sort_unstable();
            instance_ids.dedup();
            let instances: Vec<crate::dto::InstanceRequest> = instance_ids
                .iter()
                .map(|id| crate::dto::InstanceRequest {
                    instance_id: format!("bench-{id}"),
                    indicator_id: id.to_string(),
                    params: Default::default(),
                })
                .collect();
            let request = |generation: u64| CalcRequest {
                security: "600519.SH".into(),
                timeframe: "D".into(),
                adj: "qfq".into(),
                from: None,
                to: None,
                generation,
                instances: instances.clone(),
            };

            let cold = core.calc_indicators(&request(1)).await.unwrap();
            assert!(cold.series.len() == instances.len());
            let warm = core.calc_indicators(&request(2)).await.unwrap();
            assert!(warm.cache_hit, "第 2 次请求必须全部命中缓存");
            let window = resolve_window(&series, None, None).unwrap();

            println!("\n=== TD-S0-07 微基准：{bars} 根 × {} 实例 ===", instances.len());

            // ① 从缓存取序列（Arc clone）+ 窗口解析
            run("① 从缓存取序列(Arc+window)", 200, || {
                assert!(core.store_lock().unwrap().get(&key).is_some());
            });

            // ② 序列拷贝/转换：CandleSeries → 6 列连续 f64
            run("② 序列拷贝(6 列 f64)", 100, || {
                let columns = SeriesColumns::new(&series);
                std::hint::black_box(&columns);
            });

            // ③ 每实例预处理：lookup + merge_defaults + validate + calc_key + params_hash + context
            run("③ 每实例预处理(key/hash/ctx)", 40, || {
                for instance in &instances {
                    let indicator = lookup(&instance.indicator_id).unwrap();
                    let meta = indicator.meta();
                    let params = merge_defaults(meta.params, &instance.params);
                    validate(meta.params, &params).unwrap();
                    let key = calc_key(&series, meta, &params, &window.range);
                    let hash = params_hash(&params);
                    let context = telemetry_context(
                        meta.id,
                        &hash,
                        &key,
                        &series,
                        window.end - window.start,
                    );
                    std::hint::black_box((key, hash, context));
                }
            });

            // ④ 每实例缓存取（Mutex + HashMap + Arc clone）
            run("④ 每实例缓存查表(Arc clone)", 200, || {
                for instance in &instances {
                    let indicator = lookup(&instance.indicator_id).unwrap();
                    let meta = indicator.meta();
                    let params = merge_defaults(meta.params, &instance.params);
                    let key = calc_key(&series, meta, &params, &window.range);
                    let hit = core.calc_cache.lock().unwrap().get(&key);
                    std::hint::black_box(hit);
                }
            });

            let mut missing: Vec<&'static str> = Vec::new();
            let raws: Vec<(&'static str, std::sync::Arc<Vec<Vec<f64>>>)> = instances
                .iter()
                .filter_map(|instance| {
                    let indicator = lookup(&instance.indicator_id).unwrap();
                    let meta = indicator.meta();
                    let params = merge_defaults(meta.params, &instance.params);
                    let key = calc_key(&series, meta, &params, &window.range);
                    match core.calc_cache.lock().unwrap().get(&key) {
                        Some(values) => Some((meta.id, values)),
                        None => {
                            missing.push(meta.id);
                            None
                        }
                    }
                })
                .collect();
            if !missing.is_empty() {
                let stored: Vec<String> = core
                    .calc_cache
                    .lock()
                    .unwrap()
                    .keys()
                    .into_iter()
                    .take(3)
                    .collect();
                let probe = {
                    let instance = instances
                        .iter()
                        .find(|item| item.indicator_id == missing[0])
                        .unwrap();
                    let indicator = lookup(&missing[0]).unwrap();
                    let meta = indicator.meta();
                    let params = merge_defaults(meta.params, &instance.params);
                    calc_key(&series, meta, &params, &window.range)
                };
                panic!("stored={stored:?}\nprobe={probe}\nrange={:?}", window.range);
            }

            // ⑤ DTO 组装：每输出 slice → Vec<Option<f64>>（NaN→null）
            run("⑤ DTO 组装(NaN→null)", 100, || {
                let built: Vec<SeriesDto> = instances
                    .iter()
                    .zip(raws.iter())
                    .map(|(instance, (id, raw))| SeriesDto {
                        instance_id: instance.instance_id.clone(),
                        indicator_id: id.to_string(),
                        outputs: raw
                            .iter()
                            .map(|values| OutputSeriesDto {
                                key: "bench",
                                label_zh: "基准",
                                kind: indicator_core::OutputKind::Line,
                                color: "--pos",
                                values: values[window.start..window.end]
                                    .iter()
                                    .map(|v| if v.is_finite() { Some(*v) } else { None })
                                    .collect(),
                            })
                            .collect(),
                        warmup: 0,
                        engine_version: 1,
                    })
                    .collect();
                std::hint::black_box(&built);
            });

            // ⑥ IPC 报文序列化（整份 CalcResponse 与前端收到的同形）
            let payload = CalcResponse {
                generation: 2,
                dataset_id: series.dataset_id.clone(),
                dataset_generation: series.dataset_generation,
                engine_version: ENGINE_VERSION,
                computed_ms: 0.0,
                cache_hit: true,
                bar_count: window.end - window.start,
                range: window.range.clone(),
                series: instances
                    .iter()
                    .zip(raws.iter())
                    .map(|(instance, (id, raw))| SeriesDto {
                        instance_id: instance.instance_id.clone(),
                        indicator_id: id.to_string(),
                        outputs: raw
                            .iter()
                            .map(|values| OutputSeriesDto {
                                key: "bench",
                                label_zh: "基准",
                                kind: indicator_core::OutputKind::Line,
                                color: "--pos",
                                values: values[window.start..window.end]
                                    .iter()
                                    .map(|v| if v.is_finite() { Some(*v) } else { None })
                                    .collect(),
                            })
                            .collect(),
                        warmup: 0,
                        engine_version: 1,
                    })
                    .collect(),
            };
            let json_bytes = serde_json::to_string(&payload).unwrap().len();
            run("⑥ 整份 Response 序列化", 40, || {
                let text = serde_json::to_string(&payload).unwrap();
                std::hint::black_box(text.len());
            });
            println!("    ⑥ 报文大小 = {:.1} KB", json_bytes as f64 / 1024.0);

            // ⑦ 埋点：每实例一条 cache.hit，分别测「仅内存」与「内存 + JSONL 追加写」
            let per_context = telemetry_context("T01", "deadbeef", "k", &series, 520);
            let fields = |id: &'static str| {
                let mut fields = per_context.clone();
                fields[0] = ("indicatorId", serde_json::json!(id));
                fields
            };
            let mem = Telemetry::in_memory();
            run("⑦a 埋点(内存环形队列)", 40, || {
                for id in &instance_ids {
                    mem.emit(EVENT_CACHE_HIT, fields(*id));
                }
            });
            let dir = std::env::temp_dir().join("aka-microbench-telemetry");
            let _ = std::fs::create_dir_all(&dir);
            let path = dir.join("telemetry.jsonl");
            let _ = std::fs::remove_file(&path);
            let sink = Telemetry::with_log_path(path.clone());
            run("⑦b 埋点(内存+JSONL 落盘)", 40, || {
                for id in &instance_ids {
                    sink.emit(EVENT_CACHE_HIT, fields(*id));
                }
            });
            let log_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            println!(
                "    ⑦ JSONL 体积 = {:.1} KB（{} 条事件 × 40 轮）",
                log_size as f64 / 1024.0,
                instance_ids.len() * 40
            );
            std::fs::remove_dir_all(&dir).ok();

            // ⑧ 端到端对照（含锁、事件、DTO 与序列化的完整 calc_indicators 墙钟）
            let mut e2e: Vec<f64> = Vec::with_capacity(40);
            for _ in 0..40 {
                let started = Instant::now();
                let response = core.calc_indicators(&request(2)).await.unwrap();
                std::hint::black_box(&response);
                e2e.push(started.elapsed().as_secs_f64() * 1000.0);
            }
            let p50 = percentile(e2e.clone(), 0.50);
            let p95 = percentile(e2e.clone(), 0.95);
            let max = *e2e
                .iter()
                .max_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
                .unwrap();
            println!("    ⑧ 端到端 calc_indicators(命中) p50={p50:8.3}ms p95={p95:8.3}ms max={max:8.3}ms");
        }
    }

    /// QA-S0-033：单实例 MACD 切走切回 → 日志 `cache.hit=1` 且逐点一致。
    /// 判据中的「耗时 ≤120ms」属实机 UI 取证，本用例不代证（TD-S0-07 仍为部分清偿）。
    #[tokio::test]
    async fn single_macd_cache_hit_logs_one_event_and_values_match() {
        let core = AppCore::new_mock().await.unwrap();
        let request = |generation: u64| CalcRequest {
            security: "600519.SH".into(),
            timeframe: "D".into(),
            adj: "qfq".into(),
            from: None,
            to: None,
            generation,
            instances: vec![crate::dto::InstanceRequest {
                instance_id: "macd".into(),
                indicator_id: "M06".into(),
                params: std::collections::BTreeMap::from([
                    ("fast".to_string(), indicator_core::ParamValue::Int(12)),
                    ("slow".to_string(), indicator_core::ParamValue::Int(26)),
                    ("signal".to_string(), indicator_core::ParamValue::Int(9)),
                ]),
            }],
        };

        let first = core.calc_indicators(&request(1)).await.unwrap();
        assert!(!first.cache_hit);
        let second = core.calc_indicators(&request(2)).await.unwrap();
        assert!(second.cache_hit);
        assert_eq!(second.series[0].outputs.len(), 3);
        for (before, after) in first.series[0].outputs.iter().zip(&second.series[0].outputs) {
            assert_eq!(before.key, after.key);
            assert_eq!(before.values, after.values, "缓存命中必须逐点一致");
        }

        let counts = core.telemetry().summary(0).counts;
        assert_eq!(counts.get(crate::telemetry::EVENT_CACHE_HIT), Some(&1));
        assert_eq!(counts.get(crate::telemetry::EVENT_INDICATOR_COMPUTE), Some(&1));
    }

    fn calc_instance(id: &str, indicator: &str, params: &[(&str, i64)]) -> crate::dto::InstanceRequest {
        crate::dto::InstanceRequest {
            instance_id: id.into(),
            indicator_id: indicator.into(),
            params: params
                .iter()
                .map(|(k, v)| ((*k).to_string(), indicator_core::ParamValue::Int(*v)))
                .collect(),
        }
    }

    fn calc_request(timeframe: &str, instances: Vec<crate::dto::InstanceRequest>) -> CalcRequest {
        CalcRequest {
            security: "600519.SH".into(),
            timeframe: timeframe.into(),
            adj: "qfq".into(),
            from: None,
            to: None,
            generation: 1,
            instances,
        }
    }

    /// S-EP05-01 AC1：响应顺序与请求 instances 顺序一致，不按 id 排序。
    #[tokio::test]
    async fn calc_response_keeps_request_instance_order() {
        let core = AppCore::new_mock().await.unwrap();
        let request = calc_request(
            "D",
            vec![
                calc_instance("c", "T01", &[("period", 30)]),
                calc_instance("a", "T01", &[("period", 10)]),
                calc_instance("b", "T01", &[("period", 20)]),
            ],
        );
        let response = core.calc_indicators(&request).await.unwrap();
        let ids: Vec<&str> = response
            .series
            .iter()
            .map(|series| series.instance_id.as_str())
            .collect();
        assert_eq!(ids, vec!["c", "a", "b"]);
    }

    /// S-EP05-01 AC2：每个输出列长度都等于 barCount。
    #[tokio::test]
    async fn calc_values_length_equals_bar_count() {
        let core = AppCore::new_mock().await.unwrap();
        let request = calc_request(
            "D",
            vec![
                calc_instance("a", "T01", &[("period", 20)]),
                calc_instance("b", "M06", &[("fast", 12), ("slow", 26), ("signal", 9)]),
            ],
        );
        let response = core.calc_indicators(&request).await.unwrap();
        assert!(response.bar_count > 0);
        for series in &response.series {
            for output in &series.outputs {
                assert_eq!(
                    output.values.len(),
                    response.bar_count,
                    "{} 输出长度必须等于 barCount",
                    series.instance_id
                );
            }
        }
    }

    /// S-EP05-01 AC3：未知指标号整单失败，不回半份结果。
    #[tokio::test]
    async fn calc_unknown_indicator_fails_whole_request() {
        let core = AppCore::new_mock().await.unwrap();
        let request = calc_request(
            "D",
            vec![
                calc_instance("ok", "T01", &[("period", 20)]),
                calc_instance("bad", "NOPE", &[]),
            ],
        );
        let err = core.calc_indicators(&request).await.unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::UnknownIndicator);
        assert_eq!(
            err.details.as_ref().and_then(|d| d.get("indicatorId")),
            Some(&serde_json::json!("NOPE"))
        );
    }

    /// S-EP05-09 AC1：线格式顶层键正好 9 个且全为 camelCase，无 snake_case 漏网。
    #[tokio::test]
    async fn calc_response_wire_shape_is_exactly_camel_case() {
        let core = AppCore::new_mock().await.unwrap();
        let request = calc_request("D", vec![calc_instance("a", "T01", &[("period", 20)])]);
        let response = core.calc_indicators(&request).await.unwrap();
        let value = serde_json::to_value(&response).unwrap();

        let mut keys: Vec<&str> = value
            .as_object()
            .expect("CalcResponse 必须是 JSON 对象")
            .keys()
            .map(|key| key.as_str())
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "barCount",
                "cacheHit",
                "computedMs",
                "datasetGeneration",
                "datasetId",
                "engineVersion",
                "generation",
                "range",
                "series",
            ]
        );

        let mut range_keys: Vec<&str> = value["range"]
            .as_object()
            .expect("range 必须是 JSON 对象")
            .keys()
            .map(|key| key.as_str())
            .collect();
        range_keys.sort_unstable();
        assert_eq!(
            range_keys,
            vec![
                "barCount",
                "clamped",
                "requestedFrom",
                "requestedTo",
                "returnedFrom",
                "returnedTo",
            ]
        );

        let mut series_keys: Vec<&str> = value["series"][0]
            .as_object()
            .expect("series 元素必须是 JSON 对象")
            .keys()
            .map(|key| key.as_str())
            .collect();
        series_keys.sort_unstable();
        assert_eq!(
            series_keys,
            vec!["engineVersion", "indicatorId", "instanceId", "outputs", "warmup"]
        );
    }

    /// S-EP05-09 AC2：预热段 NaN 一律出 null，不得出 NaN 或 0。
    #[tokio::test]
    async fn nan_values_serialize_as_null() {
        let core = AppCore::new_mock().await.unwrap();
        let request = calc_request("D", vec![calc_instance("ma", "T01", &[("period", 20)])]);
        let response = core.calc_indicators(&request).await.unwrap();
        let value = serde_json::to_value(&response).unwrap();
        let values = value["series"][0]["outputs"][0]["values"]
            .as_array()
            .expect("values 必须是 JSON 数组");
        let warmup = value["series"][0]["warmup"].as_u64().unwrap() as usize;

        assert!(warmup > 0, "T01(period=20) 必有预热段");
        assert!(
            values[..warmup].iter().all(serde_json::Value::is_null),
            "预热段必须逐点 null"
        );
        assert!(
            values[warmup].is_number(),
            "预热后首个点必须是数值（NaN 不得漏成 null 以外的形态）"
        );
        assert_eq!(
            values.iter().filter(|v| v.is_number()).count(),
            values.len() - warmup,
            "预热段之外不应再出现 null"
        );
    }

    /// S-EP05-09 AC3：全命中时 computedMs 为 0.0；未指定日期的键仍在且为 null。
    #[tokio::test]
    async fn zero_computed_ms_keeps_null_keys() {
        let core = AppCore::new_mock().await.unwrap();
        let request = calc_request("D", vec![calc_instance("a", "T01", &[("period", 20)])]);
        core.calc_indicators(&request).await.unwrap();
        let second = core.calc_indicators(&request).await.unwrap();
        assert!(second.cache_hit);
        assert_eq!(second.computed_ms, 0.0);

        let value = serde_json::to_value(&second).unwrap();
        assert_eq!(value["computedMs"].as_f64(), Some(0.0));
        let range = value["range"].as_object().unwrap();
        assert!(range.contains_key("requestedFrom"), "requestedFrom 键不得被省略");
        assert!(range.contains_key("requestedTo"), "requestedTo 键不得被省略");
        assert!(range["requestedFrom"].is_null());
        assert!(range["requestedTo"].is_null());
    }

    /// S-EP05-09 AC4：外层 engineVersion 为字符串，SeriesDto.engineVersion 为数字。
    #[tokio::test]
    async fn engine_version_types_differ_by_layer() {
        let core = AppCore::new_mock().await.unwrap();
        let request = calc_request("D", vec![calc_instance("a", "T01", &[("period", 20)])]);
        let response = core.calc_indicators(&request).await.unwrap();
        let value = serde_json::to_value(&response).unwrap();

        assert_eq!(value["engineVersion"].as_str(), Some(ENGINE_VERSION));
        assert!(
            value["series"][0]["engineVersion"].as_u64().is_some(),
            "SeriesDto.engineVersion 必须是数字"
        );
        assert_eq!(
            value["series"][0]["engineVersion"], serde_json::json!(response.series[0].engine_version)
        );
    }

}
