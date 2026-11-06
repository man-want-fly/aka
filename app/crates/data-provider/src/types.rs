use std::fmt;

use crate::date::Date;

/// provider 身份。每行数据的溯源最终都落到这里。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProviderId {
    Mock,
    Tushare,
    Baostock,
    Akshare,
}

impl ProviderId {
    pub const fn as_str(self) -> &'static str {
        match self {
            ProviderId::Mock => "mock",
            ProviderId::Tushare => "tushare",
            ProviderId::Baostock => "baostock",
            ProviderId::Akshare => "akshare",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Market {
    Sh,
    Sz,
}

impl Market {
    pub const fn as_str(self) -> &'static str {
        match self {
            Market::Sh => "SH",
            Market::Sz => "SZ",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Board {
    ShMain,
    SzMain,
    ChiNext,
    Star,
    Index,
}

impl Board {
    pub const fn label_zh(self) -> &'static str {
        match self {
            Board::ShMain => "沪主板",
            Board::SzMain => "深主板",
            Board::ChiNext => "创业板",
            Board::Star => "科创板",
            Board::Index => "指数",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Security {
    /// 带交易所后缀，例如 `600519.SH`。
    pub code: String,
    pub name: String,
    pub market: Market,
    pub board: Board,
    pub is_index: bool,
    /// mock 生成基准价；真实 provider 忽略该字段。
    pub base_price: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Timeframe {
    Day,
    Week,
    Month,
}

impl Timeframe {
    pub const fn as_str(self) -> &'static str {
        match self {
            Timeframe::Day => "D",
            Timeframe::Week => "W",
            Timeframe::Month => "M",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "D" | "d" => Some(Timeframe::Day),
            "W" | "w" => Some(Timeframe::Week),
            "M" | "m" => Some(Timeframe::Month),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Adjust {
    None,
    Qfq,
    Hfq,
}

impl Adjust {
    pub const fn as_str(self) -> &'static str {
        match self {
            Adjust::None => "none",
            Adjust::Qfq => "qfq",
            Adjust::Hfq => "hfq",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "none" => Some(Adjust::None),
            "qfq" => Some(Adjust::Qfq),
            "hfq" => Some(Adjust::Hfq),
            _ => None,
        }
    }
}

/// 单行质量标记。前端只展示 `Simulated`，其余留给质量报告页。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QualityFlag {
    Simulated,
    LimitUp,
    LimitDown,
    SplitDay,
}

impl QualityFlag {
    pub const fn as_str(self) -> &'static str {
        match self {
            QualityFlag::Simulated => "simulated",
            QualityFlag::LimitUp => "limitUp",
            QualityFlag::LimitDown => "limitDown",
            QualityFlag::SplitDay => "splitDay",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct BarRow {
    pub date: Date,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    /// 股
    pub volume: f64,
    /// 元
    pub amount: f64,
    /// 1.0 = 不复权原始价；复权时按 provider 口径给出
    pub adj_factor: f64,
    pub quality: Vec<QualityFlag>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AdjustFactor {
    pub date: Date,
    pub factor: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Capabilities {
    pub securities: bool,
    pub trading_calendar: bool,
    pub daily_bars: bool,
    pub adjust_factors: bool,
    pub index_members: bool,
    pub industry: bool,
    pub limit_flags: bool,
    pub minute_bars: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RatePolicy {
    pub max_requests_per_minute: u32,
    pub max_concurrent: u8,
    pub note: &'static str,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Health {
    pub reachable: bool,
    pub quota_remaining: Option<u64>,
    pub last_error: Option<String>,
    pub checked_at: i64,
}

/// 可选能力未实现时返回它，调用方据此降级而不是当作崩溃。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotSupported {
    pub feature: &'static str,
}

impl fmt::Display for NotSupported {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "provider 不支持：{}", self.feature)
    }
}

impl std::error::Error for NotSupported {}

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("provider 不支持该能力：{0}")]
    Unsupported(&'static str),
    #[error("未知标的：{0}")]
    UnknownSecurity(String),
    #[error("数据源网络错误：{0}")]
    Network(String),
    #[error("数据解析失败：{0}")]
    Parse(String),
    #[error("provider 内部错误：{0}")]
    Internal(String),
}
