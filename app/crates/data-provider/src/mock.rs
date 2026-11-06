use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;

use crate::date::Date;
use crate::provider::{BarBatch, BarRequest, DataProvider, FactorBatch, SecurityMaster};
use crate::types::{
    Adjust, AdjustFactor, BarRow, Board, Capabilities, Health, Market, NotSupported, ProviderError,
    ProviderId, QualityFlag, RatePolicy, Security, Timeframe,
};

pub const MOCK_DATASET_ID: &str = "sim-default";
pub const MOCK_DATA_VERSION: &str = "sim-v1.0";
/// mock 数据集为固定内容，重建代数为 1；真实/sim 生成器写入的代数由 manifest 派生。
pub const MOCK_DATASET_GENERATION: u64 = 1;
pub const MOCK_SECURITY_COUNT: usize = 120;
pub const MOCK_BARS_PER_SECURITY: usize = 520;
pub const MOCK_FIRST_DATE: Date = Date::new(2023, 1, 2);

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(if seed == 0 { 0x9E37_79B9_7F4A_7C15 } else { seed })
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// 近似标准正态：12 个均匀分布求和减 6。
    fn normal(&mut self) -> f64 {
        let mut sum = 0.0;
        for _ in 0..12 {
            sum += self.unit();
        }
        sum - 6.0
    }
}

fn fnv1a(text: &str) -> u64 {
    let mut hash = 0xCBF2_9CE4_8422_2325u64;
    for byte in text.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01B3);
    }
    hash
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// MVP 主数据源：完全离线、确定性、无需 token。
/// 生成规则：120 只标的 × 520 根工作日日线（2023-01-02 起），部分标的含 1 次 2:1 拆分。
pub struct MockProvider {
    securities: Vec<Security>,
    calendar: Vec<Date>,
    generated_at: i64,
    raw_cache: std::sync::Mutex<HashMap<String, std::sync::Arc<Vec<BarRow>>>>,
}

impl Default for MockProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl MockProvider {
    pub fn new() -> Self {
        let calendar = build_calendar(MOCK_FIRST_DATE, MOCK_BARS_PER_SECURITY);
        Self {
            securities: build_securities(),
            calendar,
            generated_at: now_epoch(),
            raw_cache: std::sync::Mutex::new(HashMap::new()),
        }
    }

    pub fn dataset_id(&self) -> &'static str {
        MOCK_DATASET_ID
    }

    pub fn data_version(&self) -> &'static str {
        MOCK_DATA_VERSION
    }

    pub fn security_count(&self) -> usize {
        self.securities.len()
    }

    pub fn bars_per_security(&self) -> usize {
        self.calendar.len()
    }

    pub fn first_date(&self) -> Date {
        *self.calendar.first().unwrap_or(&MOCK_FIRST_DATE)
    }

    pub fn last_date(&self) -> Date {
        *self.calendar.last().unwrap_or(&MOCK_FIRST_DATE)
    }

    fn find_security(&self, code: &str) -> Option<&Security> {
        self.securities.iter().find(|s| s.code == code)
    }

    fn raw_bars(&self, code: &str) -> Option<std::sync::Arc<Vec<BarRow>>> {
        if let Some(cached) = self.raw_cache.lock().ok()?.get(code).cloned() {
            return Some(cached);
        }
        let security = self.find_security(code)?;
        let bars = std::sync::Arc::new(generate_bars(security, &self.calendar));
        if let Ok(mut cache) = self.raw_cache.lock() {
            cache.insert(code.to_string(), bars.clone());
        }
        Some(bars)
    }
}

#[async_trait]
impl DataProvider for MockProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Mock
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            securities: true,
            trading_calendar: true,
            daily_bars: true,
            adjust_factors: true,
            index_members: false,
            industry: false,
            limit_flags: false,
            minute_bars: false,
        }
    }

    async fn securities(&self, _as_of: Date) -> Result<SecurityMaster, ProviderError> {
        Ok(SecurityMaster {
            provider: ProviderId::Mock,
            dataset_id: MOCK_DATASET_ID.to_string(),
            securities: self.securities.clone(),
        })
    }

    async fn trading_calendar(
        &self,
        from: Date,
        to: Date,
    ) -> Result<Vec<Date>, ProviderError> {
        Ok(self
            .calendar
            .iter()
            .copied()
            .filter(|d| *d >= from && *d <= to)
            .collect())
    }

    async fn daily_bars(&self, req: BarRequest) -> Result<BarBatch, ProviderError> {
        if !matches!(req.timeframe, Timeframe::Day) {
            return Err(ProviderError::Unsupported("mock 骨架仅生成日线"));
        }
        let security = self
            .find_security(&req.security)
            .ok_or_else(|| ProviderError::UnknownSecurity(req.security.clone()))?;
        let raw = self
            .raw_bars(&security.code)
            .ok_or_else(|| ProviderError::UnknownSecurity(req.security.clone()))?;

        let from = req.from.unwrap_or(self.first_date());
        let to = req.to.unwrap_or(self.last_date());

        let mut rows = Vec::new();
        for row in raw.iter() {
            if row.date < from || row.date > to {
                continue;
            }
            let mut row = row.clone();
            apply_adjust(&mut row, req.adj);
            rows.push(row);
        }

        Ok(BarBatch {
            provider: ProviderId::Mock,
            dataset_id: MOCK_DATASET_ID.to_string(),
            data_version: MOCK_DATA_VERSION.to_string(),
            dataset_generation: MOCK_DATASET_GENERATION,
            simulated: true,
            rows,
            generated_at: self.generated_at,
        })
    }

    async fn adjust_factors(&self, security: &str) -> Result<FactorBatch, ProviderError> {
        let sec = self
            .find_security(security)
            .ok_or_else(|| ProviderError::UnknownSecurity(security.to_string()))?;
        let raw = self
            .raw_bars(&sec.code)
            .ok_or_else(|| ProviderError::UnknownSecurity(security.to_string()))?;
        let mut factors = Vec::new();
        for row in raw.iter() {
            if row.adj_factor != 1.0 {
                factors.push(AdjustFactor {
                    date: row.date,
                    factor: row.adj_factor,
                });
            }
        }
        if let Some(last) = raw.last() {
            factors.push(AdjustFactor {
                date: last.date,
                factor: 1.0,
            });
        }
        Ok(FactorBatch {
            provider: ProviderId::Mock,
            factors,
        })
    }

    async fn index_members(
        &self,
        _index: &str,
        _as_of: Date,
    ) -> Result<Vec<String>, NotSupported> {
        Err(NotSupported {
            feature: "index_members",
        })
    }

    async fn industry(&self, _as_of: Date) -> Result<Vec<(String, String)>, NotSupported> {
        Err(NotSupported { feature: "industry" })
    }

    async fn limit_flags(&self, _req: BarRequest) -> Result<Vec<BarRow>, NotSupported> {
        Err(NotSupported {
            feature: "limit_flags",
        })
    }

    async fn minute_bars(&self, _req: BarRequest) -> Result<BarBatch, NotSupported> {
        Err(NotSupported {
            feature: "minute_bars",
        })
    }

    fn rate_policy(&self) -> RatePolicy {
        RatePolicy {
            max_requests_per_minute: u32::MAX,
            max_concurrent: 8,
            note: "本地生成，无网络与配额限制",
        }
    }

    async fn health(&self) -> Health {
        Health {
            reachable: true,
            quota_remaining: None,
            last_error: None,
            checked_at: now_epoch(),
        }
    }
}

fn build_calendar(start: Date, count: usize) -> Vec<Date> {
    let mut dates = Vec::with_capacity(count);
    let mut cursor = start;
    while dates.len() < count {
        if !cursor.is_weekend() {
            dates.push(cursor);
        }
        cursor = cursor.next_day();
    }
    dates
}

fn build_securities() -> Vec<Security> {
    let mut list = Vec::with_capacity(MOCK_SECURITY_COUNT);

    let known: [(&str, &str, Board, f64); 14] = [
        ("300750.SZ", "宁德时代", Board::ChiNext, 218.60),
        ("600519.SH", "贵州茅台", Board::ShMain, 1628.33),
        ("002594.SZ", "比亚迪", Board::SzMain, 268.40),
        ("601318.SH", "中国平安", Board::ShMain, 51.28),
        ("600036.SH", "招商银行", Board::ShMain, 37.15),
        ("000858.SZ", "五粮液", Board::SzMain, 138.42),
        ("688981.SH", "中芯国际", Board::Star, 92.68),
        ("300059.SZ", "东方财富", Board::ChiNext, 15.72),
        ("601899.SH", "紫金矿业", Board::ShMain, 17.45),
        ("002415.SZ", "海康威视", Board::SzMain, 31.06),
        ("600030.SH", "中信证券", Board::ShMain, 28.34),
        ("601012.SH", "隆基绿能", Board::ShMain, 18.92),
        ("000651.SZ", "格力电器", Board::SzMain, 42.75),
        ("600900.SH", "长江电力", Board::ShMain, 28.16),
    ];

    for (code, name, board, price) in known {
        list.push(make_security(code, name, board, false, price));
    }

    // 指数：让前端「指数」分组有真实感
    list.push(make_security("000001.SH", "上证指数", Board::Index, true, 3200.0));
    list.push(make_security("399001.SZ", "深证成指", Board::Index, true, 10800.0));
    list.push(make_security("399006.SZ", "创业板指", Board::Index, true, 2150.0));

    let groups: [(&str, usize, Board); 4] = [
        ("601", 40, Board::ShMain),
        ("002", 40, Board::SzMain),
        ("300", 15, Board::ChiNext),
        ("688", 8, Board::Star),
    ];

    let mut serial = 1;
    for (prefix, count, board) in groups {
        for offset in 0..count {
            let code = if prefix == "601" {
                format!("{:06}.SH", 601_000 + offset)
            } else {
                format!("{}{:03}.SZ", prefix, 100 + offset)
            };
            // 科创板与沪深主板后缀不同
            let code = if prefix == "688" {
                format!("{}{:03}.SH", prefix, 100 + offset)
            } else if prefix == "300" {
                format!("{}{:03}.SZ", prefix, 100 + offset)
            } else {
                code
            };
            let name = format!("示例标的 {serial:03}");
            let price = 5.0 + (fnv1a(&code) % 2000) as f64 / 10.0;
            list.push(make_security(&code, &name, board, false, price));
            serial += 1;
        }
    }

    list
}

fn make_security(code: &str, name: &str, board: Board, is_index: bool, price: f64) -> Security {
    let market = if code.ends_with(".SH") {
        Market::Sh
    } else {
        Market::Sz
    };
    Security {
        code: code.to_string(),
        name: name.to_string(),
        market,
        board,
        is_index,
        base_price: if is_index { price } else { price.round() },
    }
}

fn generate_bars(security: &Security, calendar: &[Date]) -> Vec<BarRow> {
    let seed = fnv1a(&security.code);
    let mut rng = Rng::new(seed);
    let has_split = !security.is_index && seed % 5 == 0;
    let split_at = MOCK_BARS_PER_SECURITY / 2;

    let limit = match security.board {
        Board::ChiNext | Board::Star => 0.20,
        Board::Index => 0.0,
        _ => 0.10,
    };
    let volatility = if security.is_index { 0.009 } else { 0.018 };

    let target = security.base_price.max(1.0);
    let start = target * 0.74;
    let drift = (target / start).ln() / calendar.len() as f64;

    let base_volume = if security.is_index {
        target * 1_000_000.0
    } else {
        (target * 120_000.0).clamp(4_000_000.0, 80_000_000.0)
    };

    let mut rows = Vec::with_capacity(calendar.len());
    let mut prev_close = start;

    for (i, date) in calendar.iter().enumerate() {
        let mut return_pct = drift + 0.0012 * ((i as f64) / 37.0).sin() + rng.normal() * volatility;
        let mut quality = vec![QualityFlag::Simulated];

        if limit > 0.0 {
            if rng.unit() < 0.004 {
                let direction = if rng.unit() < 0.5 { 1.0 } else { -1.0 };
                return_pct = direction * limit;
            }
            if return_pct >= limit {
                return_pct = limit;
                quality.push(QualityFlag::LimitUp);
            } else if return_pct <= -limit {
                return_pct = -limit;
                quality.push(QualityFlag::LimitDown);
            }
        }

        let gap = rng.normal() * volatility * 0.25;
        let open = (prev_close * (1.0 + gap)).max(0.01);
        let close = (prev_close * (1.0 + return_pct)).max(0.01);
        let high = open.max(close) * (1.0 + rng.unit() * 0.008);
        let low = (open.min(close) * (1.0 - rng.unit() * 0.008)).max(0.01);
        let volume = base_volume * (0.55 + rng.unit() * 1.6);
        let amount = volume * (high + low + close) / 3.0;

        let mut row = BarRow {
            date: *date,
            open: round2(open),
            high: round2(high),
            low: round2(low),
            close: round2(close),
            volume: volume.round(),
            amount: round2(amount),
            adj_factor: 1.0,
            quality,
        };

        // 2:1 拆分：拆分前价格按历史实际翻倍、成交量减半；复权时再还原。
        if has_split && i < split_at {
            row.open = round2(row.open * 2.0);
            row.high = round2(row.high * 2.0);
            row.low = round2(row.low * 2.0);
            row.close = round2(row.close * 2.0);
            row.volume = (row.volume * 0.5).round();
            row.amount = round2(row.volume * (row.high + row.low + row.close) / 3.0);
            row.adj_factor = 0.5;
        }
        if has_split && i == split_at {
            row.quality.push(QualityFlag::SplitDay);
        }

        prev_close = row.close / if has_split && i < split_at { 2.0 } else { 1.0 };
        rows.push(row);
    }

    rows
}

fn apply_adjust(row: &mut BarRow, adj: Adjust) {
    let factor = match adj {
        Adjust::None => return,
        Adjust::Qfq => row.adj_factor,
        // 后复权：以拆分前价格为基准，拆分后价格 ×2
        Adjust::Hfq => 1.0 / row.adj_factor,
    };
    if (factor - 1.0).abs() < f64::EPSILON {
        return;
    }
    row.open = round2(row.open * factor);
    row.high = round2(row.high * factor);
    row.low = round2(row.low * factor);
    row.close = round2(row.close * factor);
    row.volume = (row.volume / factor).round();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dataset_shape_is_stable() {
        let provider = MockProvider::new();
        assert_eq!(provider.security_count(), MOCK_SECURITY_COUNT);
        assert_eq!(provider.bars_per_security(), MOCK_BARS_PER_SECURITY);
        assert_eq!(provider.first_date(), Date::new(2023, 1, 2));
    }

    #[test]
    fn bars_are_deterministic_and_ordered() {
        let provider = MockProvider::new();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime");
        let batch = runtime.block_on(async {
            provider
                .daily_bars(BarRequest {
                    security: "600519.SH".into(),
                    timeframe: Timeframe::Day,
                    adj: Adjust::Qfq,
                    from: None,
                    to: None,
                })
                .await
                .expect("bars")
        });
        assert_eq!(batch.rows.len(), MOCK_BARS_PER_SECURITY);
        assert!(batch.rows.windows(2).all(|w| w[0].date < w[1].date));
        assert!(batch.rows.iter().all(|r| r.high >= r.open.max(r.close)));
        assert!(batch.rows.iter().all(|r| r.low <= r.open.min(r.close)));
    }

    #[test]
    fn qfq_removes_split_gap() {
        let provider = MockProvider::new();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime");
        // 找一个带拆分的标的
        let split_code = provider
            .securities
            .iter()
            .find(|s| !s.is_index && fnv1a(&s.code) % 5 == 0)
            .map(|s| s.code.clone())
            .expect("split security");
        let batch = runtime.block_on(async {
            provider
                .daily_bars(BarRequest {
                    security: split_code,
                    timeframe: Timeframe::Day,
                    adj: Adjust::Qfq,
                    from: None,
                    to: None,
                })
                .await
                .expect("bars")
        });
        let split_index = batch
            .rows
            .iter()
            .position(|r| r.quality.contains(&QualityFlag::SplitDay))
            .expect("split day");
        let before = batch.rows[split_index - 1].close;
        let after = batch.rows[split_index].close;
        let ratio = after / before;
        assert!(
            (0.85..1.15).contains(&ratio),
            "复权后拆分日不应出现断崖，实际比值 {ratio}"
        );
    }
}
