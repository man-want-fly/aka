//! 数据源抽象：provider 只负责「取数 + 归一化 + 能力声明」，不做指标、不写 UI。
//!
//! 依赖边界：本 crate 只允许依赖标准库与 `async-trait` / `serde` / `serde_json` / `thiserror`。
//! 禁止依赖 data-store / indicator-core / app-core / tauri。

pub mod aggregate;
pub mod calendar;
pub mod dataset_manifest;
pub mod date;
pub mod mock;
pub mod provider;
pub mod sha256;
pub mod sim_dataset;
pub mod tushare;
pub mod types;

pub use aggregate::{aggregate_bars, AggregatePeriod};
pub use calendar::{iso_week, month_key, week_start, IsoWeek, TradingCalendar};
pub use dataset_manifest::{DatasetManifest, ManifestIssue};
pub use date::Date;
pub use provider::{BarBatch, BarRequest, DataProvider, FactorBatch, SecurityMaster};
pub use types::{
    Adjust, AdjustFactor, BarRow, Board, Capabilities, Health, Market, NotSupported, ProviderError,
    ProviderId, QualityFlag, RatePolicy, Security, Timeframe,
};
