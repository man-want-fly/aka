//! 本地行情存储：内存 K 线缓存 + SQLite `state.db`（自选/设置/参数/数据版本）。
//!
//! 依赖边界：本 crate 不认识 provider、指标与 Tauri；DB 路径由调用方注入。

use std::collections::HashMap;
use std::sync::Arc;

pub mod state_db;

#[derive(Debug, Clone, PartialEq)]
pub struct Candle {
    /// epoch 秒（UTC 零点）
    pub ts: i64,
    /// ISO 日期 `YYYY-MM-DD`，由 provider 归一化时写入
    pub date: String,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
    pub amount: f64,
    pub adj_factor: f64,
    /// `QualityFlag::as_str()` 的字符串，store 不依赖 provider 类型
    pub quality: Vec<String>,
    /// 行级溯源：mock / tushare / ...
    pub source: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CandleSeries {
    pub security: String,
    pub timeframe: String,
    pub adj: String,
    pub provider: String,
    pub dataset_id: String,
    pub data_version: String,
    pub simulated: bool,
    pub generated_at: i64,
    pub candles: Vec<Candle>,
}

impl CandleSeries {
    pub fn len(&self) -> usize {
        self.candles.len()
    }

    pub fn is_empty(&self) -> bool {
        self.candles.is_empty()
    }

    /// `to` 为开区间；超出范围自动收敛。
    pub fn slice(&self, from: usize, to: usize) -> &[Candle] {
        let start = from.min(self.candles.len());
        let end = to.min(self.candles.len()).max(start);
        &self.candles[start..end]
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SeriesKey {
    pub security: String,
    pub timeframe: String,
    pub adj: String,
}

#[derive(Debug, Default)]
pub struct CandleStore {
    series: HashMap<SeriesKey, Arc<CandleSeries>>,
}

impl CandleStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, key: &SeriesKey) -> Option<Arc<CandleSeries>> {
        self.series.get(key).cloned()
    }

    pub fn put(&mut self, key: SeriesKey, series: Arc<CandleSeries>) {
        self.series.insert(key, series);
    }

    pub fn loaded_series(&self) -> usize {
        self.series.len()
    }

    /// 骨架期无淘汰策略；后续按内存预算做 LRU。
    pub fn clear(&mut self) {
        self.series.clear();
    }
}

/// 简易 LRU 计数骨架，供后续落盘层复用。
#[derive(Debug, Default)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
}

impl CacheStats {
    pub fn hit_rate(&self) -> f64 {
        let total = self.hits + self.misses;
        if total == 0 {
            0.0
        } else {
            self.hits as f64 / total as f64
        }
    }
}
