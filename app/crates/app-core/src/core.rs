use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use data_provider::mock::MockProvider;
use data_provider::{Adjust, BarRequest, DataProvider, Security, Timeframe};
use data_store::{CacheStats, Candle, CandleSeries, CandleStore, SeriesKey};
use indicator_core::{
    all, implemented_count, lookup, merge_defaults, validate, CalcError, Category, Indicator,
    OhlcvView, ParamError, Params, ENGINE_VERSION, PLANNED_INDICATOR_COUNT,
};

use crate::dto::{
    BarDto, BarsResponse, CalcRequest, CalcResponse, GetBarsRequest, IndicatorMetaDto, InputsDto,
    ListSecuritiesRequest, OutputSeriesDto, OutputSpecDto, ProvenanceDto, RegistryResponse,
    SecurityDto, SeriesDto,
};
use crate::error::{AppError, ErrorCode};

/// 编排层：唯一知道「provider + store + 指标 + 缓存」如何协作的地方。
/// 命令层不得绕过它直接访问任一子系统。
pub struct AppCore {
    provider: Box<dyn DataProvider>,
    securities: Vec<Security>,
    store: Mutex<CandleStore>,
    calc_cache: Mutex<HashMap<String, Arc<Vec<Vec<f64>>>>>,
    calc_stats: Mutex<CacheStats>,
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
            calc_cache: Mutex::new(HashMap::new()),
            calc_stats: Mutex::new(CacheStats::default()),
        })
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
        let (start, end) = window(total, req.from, req.to)?;

        let bars = series
            .slice(start, end)
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
            provenance: ProvenanceDto {
                provider: series.provider.clone(),
                dataset_id: series.dataset_id.clone(),
                data_version: series.data_version.clone(),
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
        let (start, end) = window(total, req.from, req.to)?;
        let columns = SeriesColumns::new(&series);
        let view = columns.view();

        let mut computed_ms = 0.0;
        let mut cache_hit = true;
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

            let key = calc_key(&series, meta, &params);
            let cached = self
                .calc_cache
                .lock()
                .map_err(|_| AppError::internal("计算缓存锁中毒"))?
                .get(&key)
                .cloned();

            let raw = match cached {
                Some(values) => values,
                None => {
                    cache_hit = false;
                    let started = Instant::now();
                    let mut values = vec![vec![f64::NAN; total]; meta.outputs.len()];
                    indicator
                        .calc(&view, &params, &mut values)
                        .map_err(|err| calc_error(meta.id, err))?;
                    computed_ms += started.elapsed().as_secs_f64() * 1000.0;
                    let values = Arc::new(values);
                    self.calc_cache
                        .lock()
                        .map_err(|_| AppError::internal("计算缓存锁中毒"))?
                        .insert(key, values.clone());
                    values
                }
            };

            let outputs = meta
                .outputs
                .iter()
                .zip(raw.iter())
                .map(|(spec, values)| OutputSeriesDto {
                    key: spec.key,
                    label_zh: spec.label_zh,
                    kind: spec.kind,
                    color: spec.color,
                    values: values[start..end]
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

        Ok(CalcResponse {
            generation: req.generation,
            dataset_id: series.dataset_id.clone(),
            engine_version: ENGINE_VERSION,
            computed_ms: (computed_ms * 100.0).round() / 100.0,
            cache_hit,
            bar_count: end - start,
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
        if !matches!(timeframe, Timeframe::Day) {
            return Err(AppError::new(
                ErrorCode::DatasetMissing,
                "骨架期仅支持日线（D）；周/月线由后续 Sprint 聚合生成",
            )
            .with_details(serde_json::json!({ "timeframe": timeframe.as_str() })));
        }

        let key = SeriesKey {
            security: found.code.clone(),
            timeframe: timeframe.as_str().to_string(),
            adj: adj.as_str().to_string(),
        };

        if let Some(cached) = self.store_lock()?.get(&key) {
            return Ok(cached);
        }

        let batch = self
            .provider
            .daily_bars(BarRequest {
                security: found.code.clone(),
                timeframe,
                adj,
                from: None,
                to: None,
            })
            .await
            .map_err(AppError::from)?;

        let provider = batch.provider.as_str().to_string();
        let candles = batch
            .rows
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

        let series = Arc::new(CandleSeries {
            security: found.code.clone(),
            timeframe: timeframe.as_str().to_string(),
            adj: adj.as_str().to_string(),
            provider,
            dataset_id: batch.dataset_id,
            data_version: batch.data_version,
            simulated: batch.simulated,
            generated_at: batch.generated_at,
            candles,
        });

        self.store_lock()?.put(key, series.clone());
        Ok(series)
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
        warmup: (meta.warmup)(&defaults),
        implemented: true,
    }
}

fn parse_timeframe(value: &str) -> Result<Timeframe, AppError> {
    Timeframe::parse(value)
        .ok_or_else(|| AppError::invalid_argument(format!("未知周期：{value}")))
}

/// `to` 为含端点索引；返回半开区间 `[start, end)`。
fn window(
    total: usize,
    from: Option<usize>,
    to: Option<usize>,
) -> Result<(usize, usize), AppError> {
    if total == 0 {
        return Ok((0, 0));
    }
    let start = from.unwrap_or(0).min(total - 1);
    let end = to.map(|t| t.min(total - 1)).unwrap_or(total - 1);
    if start > end {
        return Err(AppError::invalid_argument(format!(
            "区间非法：from={start} 大于 to={end}"
        )));
    }
    Ok((start, end + 1))
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

fn calc_key(
    series: &CandleSeries,
    meta: &'static indicator_core::Meta,
    params: &Params,
) -> String {
    let params = serde_json::to_string(params).unwrap_or_default();
    format!(
        "{}|{}|{}|{}|{}|{}|{}",
        ENGINE_VERSION, series.dataset_id, series.security, series.timeframe, series.adj, meta.id, params
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
