use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;

use crate::date::Date;
use crate::dataset_manifest::DatasetManifest;
use crate::provider::{BarBatch, BarRequest, DataProvider, FactorBatch, SecurityMaster};
use crate::sha256::sha256_hex;
use crate::sim_dataset::canonical_csv;
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

/// 单根 K 线溯源（S-07.05-02）：mock 为离线固定内容，批次与入库时间写死，
/// 保证 bench 快照可复现；真实/sim 数据集由 manifest 派生。
pub const MOCK_BATCH_ID: &str = "b-20260101-01";
/// 2026-01-01T00:00:00Z
pub const MOCK_INGESTED_AT: i64 = 1_767_225_600;

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
    /// 全量数据集 manifest（S-02.08-01 页脚）；按需计算一次后缓存。
    manifest: std::sync::OnceLock<crate::dataset_manifest::DatasetManifest>,
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
            manifest: std::sync::OnceLock::new(),
        }
    }

    /// 取证专用短序列（仅由 `AKA_DIAG=1` 装配时开启）：
    /// 提供一只只有 `count` 根日线的样本，用于 AC-02.05-04 补3（数据不足）实机取证。
    pub fn with_diag_short_series(self, count: usize) -> Self {
        self.push_diag_series("DIAG020.SZ", "诊断短序列", count)
    }

    /// 取证专用：自选「数据不足（K 线 < 20）」样本，用 12 根明确低于阈值。
    pub fn with_diag_tiny_series(self, count: usize) -> Self {
        self.push_diag_series("DIAG012.SZ", "诊断极短序列", count)
    }

    fn push_diag_series(mut self, code: &str, name: &str, count: usize) -> Self {
        if count == 0 || self.find_security(code).is_some() {
            return self;
        }
        let security = make_security(code, name, Board::SzMain, false, 10.0);
        let mut bars = generate_bars(&security, &self.calendar);
        bars.truncate(count);
        self.securities.push(security);
        if let Ok(mut cache) = self.raw_cache.lock() {
            cache.insert(code.to_string(), std::sync::Arc::new(bars));
        }
        self
    }

    /// 取证专用：停牌样本（D-19 合成行：OHLC=停牌前收盘、量/额为 0）。
    /// 用于 AC-02.07-03 补2/补4：停牌日 K 线不画、量柱 0、光标落该位显示「停牌」。
    pub fn with_diag_suspended_series(
        self,
        count: usize,
        start: usize,
        len: usize,
    ) -> Self {
        self.push_diag_suspended("DIAGSUSP.SZ", "诊断停牌序列", count, start, len)
    }

    fn push_diag_suspended(
        mut self,
        code: &str,
        name: &str,
        count: usize,
        start: usize,
        len: usize,
    ) -> Self {
        if count == 0 || len == 0 || self.find_security(code).is_some() {
            return self;
        }
        let security = make_security(code, name, Board::SzMain, false, 10.0);
        let mut bars = generate_bars(&security, &self.calendar);
        bars.truncate(count);
        if start < bars.len() {
            let anchor = if start > 0 { bars[start - 1].close } else { bars[0].open };
            for index in start..(start + len).min(bars.len()) {
                bars[index].open = anchor;
                bars[index].high = anchor;
                bars[index].low = anchor;
                bars[index].close = anchor;
                bars[index].volume = 0.0;
                bars[index].amount = 0.0;
                bars[index].quality.push(QualityFlag::Suspended);
            }
        }
        self.securities.push(security);
        if let Ok(mut cache) = self.raw_cache.lock() {
            cache.insert(code.to_string(), std::sync::Arc::new(bars));
        }
        self
    }

    /// 取证专用：报价头样本（AC-02.01-01 补2/补3/补4）。
    /// - `DIAGQ10.SZ` 前收 10.00、`DIAGQ1003.SZ` 前收 10.03：主板 10% 推导容差与两位小数；
    /// - `DIAGQNEW.SZ` 仅剩 1 根（上市首日，无昨收）；
    /// - `DIAGQSUP.SZ` 末日停牌；`000300.SH` 为指数。
    pub fn with_diag_quote_samples(mut self) -> Self {
        self = self.push_diag_quote("DIAGQ10.SZ", "诊断报价十元", 10.00, 10.10);
        self = self.push_diag_quote("DIAGQ1003.SZ", "诊断报价十元零三", 10.03, 10.20);
        self = self.push_diag_quote("DIAGQNEW.SZ", "诊断上市首日", 10.00, 10.30);
        if let Ok(mut cache) = self.raw_cache.lock() {
            if let Some(bars) = cache.get_mut("DIAGQNEW.SZ") {
                if let Some(last) = bars.last().cloned() {
                    *bars = std::sync::Arc::new(vec![last]);
                }
            }
        }
        self = self.push_diag_suspended("DIAGQSUP.SZ", "诊断停牌末日", 30, 29, 1);
        self.push_diag_index("000300.SH", "沪深300", 3200.0)
    }

    fn push_diag_quote(
        mut self,
        code: &str,
        name: &str,
        prev_close: f64,
        last_close: f64,
    ) -> Self {
        if self.find_security(code).is_some() {
            return self;
        }
        let security = make_security(code, name, Board::SzMain, false, prev_close);
        let mut bars = generate_bars(&security, &self.calendar);
        bars.truncate(30);
        let len = bars.len();
        if len >= 2 {
            let prev = &mut bars[len - 2];
            prev.close = prev_close;
            prev.high = prev.high.max(prev_close);
            prev.low = prev.low.min(prev_close);
            let last = &mut bars[len - 1];
            last.close = last_close;
            last.high = last.high.max(last_close);
            last.low = last.low.min(last_close);
        }
        self.securities.push(security);
        if let Ok(mut cache) = self.raw_cache.lock() {
            cache.insert(code.to_string(), std::sync::Arc::new(bars));
        }
        self
    }

    fn push_diag_index(mut self, code: &str, name: &str, price: f64) -> Self {
        if self.find_security(code).is_some() {
            return self;
        }
        let security = make_security(code, name, Board::Index, true, price);
        let bars = generate_bars(&security, &self.calendar);
        self.securities.push(security);
        if let Ok(mut cache) = self.raw_cache.lock() {
            cache.insert(code.to_string(), std::sync::Arc::new(bars));
        }
        self
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

    /// 全量数据集摘要：按标的主表顺序拼接各自的规范 CSV（含表头）再取 sha256。
    /// 页面不确定这条记录怎么来——它只消费 manifest，不自己算行数或区间。
    fn build_dataset_manifest(&self) -> DatasetManifest {
        let mut csv = String::new();
        let mut rows = 0_u64;
        for security in &self.securities {
            // 取证样本（DIAG*、000300.SH）只在诊断进程里存在，不属于对外数据集，不能进 manifest
            if is_diag_only(&security.code) {
                continue;
            }
            if let Some(bars) = self.raw_bars(&security.code) {
                rows += bars.len() as u64;
                csv.push_str(&canonical_csv(&bars));
            }
        }
        let sha = sha256_hex(csv.as_bytes());
        DatasetManifest::build(
            "sim",
            fnv1a(MOCK_DATASET_ID),
            &self.first_date().iso(),
            &self.last_date().iso(),
            rows,
            "v1.0",
            &sha,
            self.generated_at,
        )
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

    /// mock 数据集的 manifest 覆盖区间即日历首末日。
    fn dataset_coverage(&self) -> Option<(Date, Date)> {
        Some((self.first_date(), self.last_date()))
    }

    fn dataset_manifest(&self) -> Option<DatasetManifest> {
        Some(
            self.manifest
                .get_or_init(|| self.build_dataset_manifest())
                .clone(),
        )
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

        // 复权锚点取数据集首末交易日的因子（不是请求区间端点，AC-02.02-03 补1）
        let first_adj = raw.first().map(|row| row.adj_factor).unwrap_or(1.0);
        let last_adj = raw.last().map(|row| row.adj_factor).unwrap_or(1.0);

        let mut rows = Vec::new();
        for row in raw.iter() {
            if row.date < from || row.date > to {
                continue;
            }
            let mut row = row.clone();
            apply_adjust(&mut row, req.adj, first_adj, last_adj);
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

/// 诊断专用样本：只随取证进程注入，不属于对外数据集。
fn is_diag_only(code: &str) -> bool {
    code.starts_with("DIAG") || code == "000300.SH"
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

    // 生成组不得与已列出的已知标的/指数撞码（曾出现 601012 重复，导致 120 条仅 119 唯一）。
    let mut used: std::collections::HashSet<String> =
        list.iter().map(|security| security.code.clone()).collect();

    let groups: [(&str, usize, Board); 4] = [
        ("601", 40, Board::ShMain),
        ("002", 40, Board::SzMain),
        ("300", 15, Board::ChiNext),
        ("688", 8, Board::Star),
    ];

    let mut serial = 1;
    for (prefix, count, board) in groups {
        let mut offset = 0;
        let mut added = 0;
        while added < count {
            let code = match prefix {
                // 科创板上交所后缀，其余生成组按深交所处理
                "601" => format!("{:06}.SH", 601_000 + offset),
                "688" => format!("688{:03}.SH", 100 + offset),
                _ => format!("{}{:03}.SZ", prefix, 100 + offset),
            };
            offset += 1;
            if used.contains(&code) {
                continue;
            }
            used.insert(code.clone());
            let name = format!("示例标的 {serial:03}");
            let price = 5.0 + (fnv1a(&code) % 2000) as f64 / 10.0;
            list.push(make_security(&code, &name, board, false, price));
            serial += 1;
            added += 1;
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
    // AC-02.02-03 夹具：600519.SH 在 2024-04-29 显式注入一次 2:1 拆分（除权事件）
    let fixture_split = if security.code == "600519.SH" {
        calendar
            .iter()
            .position(|date| *date == Date::new(2024, 4, 29))
    } else {
        None
    };
    let has_split = !security.is_index && (seed % 5 == 0 || fixture_split.is_some());
    let split_at = fixture_split.unwrap_or(MOCK_BARS_PER_SECURITY / 2);

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
            batch_id: Some(MOCK_BATCH_ID.to_string()),
            ingested_at: Some(MOCK_INGESTED_AT),
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
            // AC-02.02-03 补2 的给定样本：除权日成交量固定 12,345,600 股（123,456 手）
            if fixture_split.is_some() {
                row.volume = 12_345_600.0;
                row.amount = round2(row.volume * (row.high + row.low + row.close) / 3.0);
            }
        }

        prev_close = row.close / if has_split && i < split_at { 2.0 } else { 1.0 };
        rows.push(row);
    }

    rows
}

fn apply_adjust(row: &mut BarRow, adj: Adjust, first_adj: f64, last_adj: f64) {
    let factor = match adj {
        Adjust::None => return,
        // 前复权锚定数据集最新交易日
        Adjust::Qfq => row.adj_factor / last_adj,
        // 后复权锚定数据集最早交易日（拆分后价格按历史因子抬升，保证除权日连续）
        Adjust::Hfq => row.adj_factor / first_adj,
    };
    if (factor - 1.0).abs() < f64::EPSILON {
        return;
    }
    row.open = round2(row.open * factor);
    row.high = round2(row.high * factor);
    row.low = round2(row.low * factor);
    row.close = round2(row.close * factor);
    // 成交量不受复权影响（本卡集口径 §0.1、AC-02.02-03 补2）
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

        // 代码必须唯一：生成组曾与已知标的撞码，导致 120 条只有 119 个唯一代码。
        let mut codes: Vec<&str> = provider
            .securities
            .iter()
            .map(|security| security.code.as_str())
            .collect();
        codes.sort_unstable();
        let before = codes.len();
        codes.dedup();
        assert_eq!(before, MOCK_SECURITY_COUNT);
        assert_eq!(codes.len(), MOCK_SECURITY_COUNT);
    }

    /// 生成数据的系统性校验：代码唯一、名称唯一、分区标注与代码前缀一致。
    #[test]
    fn mock_security_metadata_is_unique_and_consistent() {
        let provider = MockProvider::new();
        let total = provider.security_count();

        let mut codes: Vec<&str> = provider
            .securities
            .iter()
            .map(|security| security.code.as_str())
            .collect();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), total, "存在重复代码");

        let mut names: Vec<&str> = provider
            .securities
            .iter()
            .map(|security| security.name.as_str())
            .collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), total, "存在重复名称");

        for security in &provider.securities {
            let (digits, suffix) = security.code.split_at(6);
            let consistent = match security.board {
                Board::Index => suffix == ".SH" || suffix == ".SZ",
                Board::ShMain => {
                    matches!(&digits[..3], "600" | "601" | "603" | "605") && suffix == ".SH"
                }
                Board::SzMain => {
                    matches!(&digits[..3], "000" | "001" | "002" | "003") && suffix == ".SZ"
                }
                Board::ChiNext => matches!(&digits[..3], "300" | "301") && suffix == ".SZ",
                Board::Star => matches!(&digits[..3], "688" | "689") && suffix == ".SH",
            };
            assert!(
                consistent,
                "{} 分区标注为 {}，与代码前缀/后缀不一致",
                security.code,
                security.board.label_zh()
            );
        }
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

    /// AC-02.02-03 夹具：600519.SH 在 2024-04-29 的显式除权事件。
    #[test]
    fn fixture_600519_ex_rights_on_2024_04_29() {
        let provider = MockProvider::new();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime");
        let fetch = |adj| {
            runtime.block_on(async {
                provider
                    .daily_bars(BarRequest {
                        security: "600519.SH".into(),
                        timeframe: Timeframe::Day,
                        adj,
                        from: None,
                        to: None,
                    })
                    .await
                    .expect("bars")
            })
        };
        let qfq = fetch(Adjust::Qfq);
        let none = fetch(Adjust::None);
        let index = qfq
            .rows
            .iter()
            .position(|row| row.date == Date::new(2024, 4, 29))
            .expect("2024-04-29 应在交易日历内");
        assert!(qfq.rows[index]
            .quality
            .contains(&QualityFlag::SplitDay));

        let qfq_ratio = qfq.rows[index].close / qfq.rows[index - 1].close;
        assert!(
            (qfq_ratio - 1.0).abs() <= 0.105,
            "前复权不应跳空，实际比值 {qfq_ratio}"
        );
        let none_ratio = none.rows[index].close / none.rows[index - 1].close;
        assert!(
            (none_ratio - 0.5).abs() < 0.12,
            "不复权应看到约 50% 的除权断崖，实际比值 {none_ratio}"
        );

        // 成交量不受复权影响：同一交易日在三种口径下完全相同
        let hfq = fetch(Adjust::Hfq);
        assert_eq!(none.rows[index].volume, 12_345_600.0);
        for offset in [index - 1, index] {
            assert_eq!(qfq.rows[offset].volume, none.rows[offset].volume);
            assert_eq!(qfq.rows[offset].volume, hfq.rows[offset].volume);
        }

        // 后复权同样不应跳空，且拆分前价格 ≥ 不复权
        let hfq_ratio = hfq.rows[index].close / hfq.rows[index - 1].close;
        assert!(
            (hfq_ratio - 1.0).abs() <= 0.105,
            "后复权不应跳空，实际比值 {hfq_ratio}"
        );
        assert!(hfq.rows[index - 1].close >= none.rows[index - 1].close);

        // 最新交易日锚点：前复权收等于原始收盘（最新因子 = 1.00000000）
        assert_eq!(qfq.rows.last().unwrap().date, Date::new(2024, 12, 27));
        assert_eq!(
            qfq.rows.last().unwrap().close,
            none.rows.last().unwrap().close
        );
    }
}
