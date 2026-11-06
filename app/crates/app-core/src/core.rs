use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use data_provider::mock::MockProvider;
use data_provider::{
    aggregate_bars, Adjust, AggregatePeriod, BarBatch, BarRequest, DataProvider, Date,
    Security, Timeframe,
};
use data_store::state_db::StateDb;
use data_store::{CacheStats, Candle, CandleSeries, CandleStore, SeriesKey};
use indicator_core::{
    all, implemented_count, lookup, merge_defaults, validate, CalcError, Category, Indicator,
    OhlcvView, ParamError, Params, ENGINE_VERSION, PLANNED_INDICATOR_COUNT,
};

use crate::dto::{
    BarDto, BarsResponse, CalcRequest, CalcResponse, GetBarsRequest, IndicatorMetaDto, InputsDto,
    ListSecuritiesRequest, OutputSeriesDto, OutputSpecDto, ProvenanceDto, RangeDto,
    RegistryResponse, SecurityDto, SeriesDto,
};
use crate::error::{AppError, ErrorCode};
use crate::telemetry::{
    Telemetry, EVENT_CACHE_HIT, EVENT_CACHE_MISS, EVENT_COMPUTE_COUNT, EVENT_COMPUTE_SKIP,
    EVENT_INDICATOR_COMPUTE,
};

/// 编排层：唯一知道「provider + store + 指标 + 缓存」如何协作的地方。
/// 命令层不得绕过它直接访问任一子系统。
pub struct AppCore {
    provider: Box<dyn DataProvider>,
    securities: Vec<Security>,
    store: Mutex<CandleStore>,
    /// 日线原始批次（按「标的|复权」缓存）：日/周/月都从同一份日线派生，避免重复取数。
    daily_batches: Mutex<HashMap<String, Arc<BarBatch>>>,
    calc_cache: Mutex<HashMap<String, Arc<Vec<Vec<f64>>>>>,
    calc_stats: Mutex<CacheStats>,
    telemetry: Telemetry,
    /// rusqlite `Connection` 是 `Send` 但不是 `Sync`，因此包一层 Mutex 才能随 `AppCore`
    /// 被 Tauri 的 `State` 共享。
    state: Option<Mutex<StateDb>>,
}

impl AppCore {
    pub async fn new(provider: Box<dyn DataProvider>) -> Result<Self, AppError> {
        let master = provider
            .securities(data_provider::Date::new(2026, 1, 1))
            .await
            .map_err(AppError::from)?;
        Ok(Self {
            provider,
            securities: master.securities,
            store: Mutex::new(CandleStore::new()),
            daily_batches: Mutex::new(HashMap::new()),
            calc_cache: Mutex::new(HashMap::new()),
            calc_stats: Mutex::new(CacheStats::default()),
            telemetry: Telemetry::in_memory(),
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
        Self::new(Box::new(MockProvider::new())).await
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

    /// 指标 manifest：目录的唯一事实来源，前端据此生成指标目录（含未实现项）。
    pub fn indicator_manifest(&self) -> &'static indicator_core::Manifest {
        indicator_core::manifest()
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
            planned_count: PLANNED_INDICATOR_COUNT,
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
                source: candle.source.clone(),
                quality: candle.quality.clone(),
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

        for instance in &req.instances {
            let indicator = lookup(&instance.indicator_id)
                .ok_or_else(|| AppError::unknown_indicator(&instance.indicator_id))?;
            let meta = indicator.meta();

            let params = merge_defaults(meta.params, &instance.params);
            validate(meta.params, &params).map_err(|err| param_error(meta.id, err))?;

            let warmup = (meta.warmup)(&params);
            if total < warmup + 1 {
                return Err(AppError::new(
                    ErrorCode::InsufficientData,
                    format!(
                        "{} 需要至少 {} 根 K 线（预热 {}），当前 {} 根",
                        meta.name_zh,
                        warmup + 1,
                        warmup,
                        total
                    ),
                )
                .with_details(serde_json::json!({
                    "indicatorId": meta.id,
                    "required": warmup + 1,
                    "got": total,
                })));
            }

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
                    .get(&key)
                    .cloned();

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
                .map(|(spec, values)| OutputSeriesDto {
                    key: spec.key,
                    label_zh: spec.label_zh,
                    kind: spec.kind,
                    color: spec.color,
                    values: values[window.start..window.end]
                        .iter()
                        .map(|v| if v.is_finite() { Some(*v) } else { None })
                        .collect(),
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
            .map(|row| Candle {
                ts: row.date.epoch_secs(),
                date: row.date.iso(),
                open: row.open,
                high: row.high,
                low: row.low,
                close: row.close,
                volume: row.volume,
                amount: row.amount,
                adj_factor: row.adj_factor,
                quality: row.quality.iter().map(|q| q.as_str().to_string()).collect(),
                source: provider.clone(),
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

    /// 日线原始批次缓存：同一标的/复权只取一次，换算周/月时不重复打 provider。
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

/// 缓存键 = 6 个原有维度（数据集版本、标的、周期、复权、指标 id、参数）+ DateRange，
/// 共 7 维；DateRange 用规范化后的实际起止日参与哈希（未指定时记 `*`）。
/// 不再保留旧六元组键：日期区间变化必须视为新的计算结果。
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
        assert!(core.telemetry().cold_p95_ms().is_some());

        // 同请求再算一次：全部命中缓存，不再执行计算。
        let second = core.calc_indicators(&request(2)).await.unwrap();
        assert!(second.cache_hit);
        let counts = core.telemetry().summary(0).counts;
        assert_eq!(counts.get(crate::telemetry::EVENT_CACHE_HIT), Some(&2));
        assert_eq!(counts.get(crate::telemetry::EVENT_INDICATOR_COMPUTE), Some(&2));
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
                    let hit = core.calc_cache.lock().unwrap().get(&key).cloned();
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
                    match core.calc_cache.lock().unwrap().get(&key).cloned() {
                        Some(values) => Some((meta.id, values)),
                        None => {
                            missing.push(meta.id);
                            None
                        }
                    }
                })
                .collect();
            if !missing.is_empty() {
                let stored: Vec<String> = core.calc_cache.lock().unwrap().keys().cloned().take(3).collect();
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
}
