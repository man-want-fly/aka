use async_trait::async_trait;

use crate::date::Date;
use crate::types::{
    Adjust, AdjustFactor, BarRow, Capabilities, Health, NotSupported, ProviderError, ProviderId,
    RatePolicy, Security,
};

#[derive(Debug, Clone, PartialEq)]
pub struct BarRequest {
    pub security: String,
    pub timeframe: crate::types::Timeframe,
    pub adj: Adjust,
    /// 含首日；None = 数据集起点
    pub from: Option<Date>,
    /// 含末日；None = 数据集末尾
    pub to: Option<Date>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BarBatch {
    pub provider: ProviderId,
    pub dataset_id: String,
    pub data_version: String,
    /// 数据集重建代数：每次重建 +1，前端据此丢弃旧缓存（TD-S0-08）。
    pub dataset_generation: u64,
    pub simulated: bool,
    pub rows: Vec<BarRow>,
    pub generated_at: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SecurityMaster {
    pub provider: ProviderId,
    pub dataset_id: String,
    pub securities: Vec<Security>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FactorBatch {
    pub provider: ProviderId,
    pub factors: Vec<AdjustFactor>,
}

/// 4 必需 + 4 可选 + 2 运维。可选能力必须先看 `capabilities()` 再调用。
#[async_trait]
pub trait DataProvider: Send + Sync {
    fn id(&self) -> ProviderId;
    fn capabilities(&self) -> Capabilities;

    async fn securities(&self, as_of: Date) -> Result<SecurityMaster, ProviderError>;
    async fn trading_calendar(&self, from: Date, to: Date)
        -> Result<Vec<Date>, ProviderError>;
    async fn daily_bars(&self, req: BarRequest) -> Result<BarBatch, ProviderError>;
    async fn adjust_factors(&self, security: &str) -> Result<FactorBatch, ProviderError>;

    async fn index_members(&self, index: &str, as_of: Date)
        -> Result<Vec<String>, NotSupported>;
    async fn industry(&self, as_of: Date) -> Result<Vec<(String, String)>, NotSupported>;
    async fn limit_flags(&self, req: BarRequest) -> Result<Vec<BarRow>, NotSupported>;
    async fn minute_bars(&self, req: BarRequest) -> Result<BarBatch, NotSupported>;

    fn rate_policy(&self) -> RatePolicy;
    async fn health(&self) -> Health;

    /// 数据集覆盖区间（manifest `coverage_start` / `coverage_end`）。
    /// 与行内最新交易日独立：行情页用它核对「页头日期 = 数据集终点」。
    fn dataset_coverage(&self) -> Option<(Date, Date)> {
        None
    }

    /// 数据集 manifest（S-02.08-01 页脚同源字段）；不支持或不提供时返回 `None`。
    fn dataset_manifest(&self) -> Option<crate::dataset_manifest::DatasetManifest> {
        None
    }
}
