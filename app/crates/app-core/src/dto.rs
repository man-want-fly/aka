use std::collections::BTreeMap;

use indicator_core::{
    Category, InputReq, OutputKind, OutputSpec, ParamSpec, ParamValue, SpecStatus,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityDto {
    pub code: String,
    pub name: String,
    pub market: &'static str,
    pub board: &'static str,
    pub is_index: bool,
    pub base_price: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSecuritiesRequest {
    #[serde(default)]
    pub market: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetBarsRequest {
    pub security: String,
    #[serde(default = "default_timeframe")]
    pub timeframe: String,
    #[serde(default = "default_adj")]
    pub adj: String,
    /// 起始日期（含），`YYYY-MM-DD`；None = 数据集起点。
    /// 非交易日/停牌日不是错误：自动吸附到区间内第一根有数据的 K 线。
    #[serde(default)]
    pub from: Option<String>,
    /// 结束日期（含），`YYYY-MM-DD`；None = 数据集末尾。
    /// 晚于最新数据时截断到最新交易日。
    #[serde(default)]
    pub to: Option<String>,
}

fn default_timeframe() -> String {
    "D".to_string()
}

fn default_adj() -> String {
    "qfq".to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BarDto {
    pub ts: i64,
    pub date: String,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
    pub amount: f64,
    /// 行级溯源
    pub source: String,
    pub quality: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceDto {
    pub provider: String,
    pub dataset_id: String,
    pub data_version: String,
    pub simulated: bool,
    pub generated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BarsResponse {
    pub security: String,
    pub timeframe: String,
    pub adj: String,
    pub dataset_id: String,
    pub total_bars: usize,
    pub bars: Vec<BarDto>,
    pub range: RangeDto,
    pub provenance: ProvenanceDto,
}

/// 请求日期区间与实际返回区间的回显。前端据此判断是否发生了吸附/截断。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeDto {
    pub requested_from: Option<String>,
    pub requested_to: Option<String>,
    /// 实际返回的第一根 K 线日期；空区间时为 None
    pub from: Option<String>,
    /// 实际返回的最后一根 K 线日期
    pub to: Option<String>,
    /// 实际返回的 K 线根数
    pub bar_count: usize,
    /// true 表示请求区间被数据集边界吸附/截断
    pub clamped: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryRequest {
    #[serde(default)]
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputsDto {
    pub open: bool,
    pub high: bool,
    pub low: bool,
    pub close: bool,
    pub volume: bool,
    pub amount: bool,
}

impl From<InputReq> for InputsDto {
    fn from(req: InputReq) -> Self {
        Self {
            open: req.open,
            high: req.high,
            low: req.low,
            close: req.close,
            volume: req.volume,
            amount: req.amount,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSpecDto {
    pub key: &'static str,
    pub label_zh: &'static str,
    pub kind: OutputKind,
    pub color: &'static str,
}

impl From<OutputSpec> for OutputSpecDto {
    fn from(spec: OutputSpec) -> Self {
        Self {
            key: spec.key,
            label_zh: spec.label_zh,
            kind: spec.kind,
            color: spec.color,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorMetaDto {
    pub id: &'static str,
    pub name_zh: &'static str,
    pub name_en: &'static str,
    pub category: Category,
    pub params: Vec<ParamSpec>,
    pub outputs: Vec<OutputSpecDto>,
    pub inputs: InputsDto,
    pub spec_status: SpecStatus,
    pub engine_version: u16,
    pub warmup: usize,
    /// 骨架期注册表里只有已实现指标；目录里 105 条规划数由 `plannedCount` 给出。
    pub implemented: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryResponse {
    pub planned_count: usize,
    pub implemented_count: usize,
    pub indicators: Vec<IndicatorMetaDto>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceRequest {
    pub instance_id: String,
    pub indicator_id: String,
    #[serde(default)]
    pub params: BTreeMap<String, ParamValue>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalcRequest {
    pub security: String,
    #[serde(default = "default_timeframe")]
    pub timeframe: String,
    #[serde(default = "default_adj")]
    pub adj: String,
    /// 起始日期（含），`YYYY-MM-DD`；None = 数据集起点。
    #[serde(default)]
    pub from: Option<String>,
    /// 结束日期（含），`YYYY-MM-DD`；None = 数据集末尾。
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub generation: u64,
    pub instances: Vec<InstanceRequest>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSeriesDto {
    pub key: &'static str,
    pub label_zh: &'static str,
    pub kind: OutputKind,
    pub color: &'static str,
    /// NaN 一律转 null；前端不得当 0 渲染
    pub values: Vec<Option<f64>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesDto {
    pub instance_id: String,
    pub indicator_id: String,
    pub outputs: Vec<OutputSeriesDto>,
    pub warmup: usize,
    pub engine_version: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalcResponse {
    pub generation: u64,
    pub dataset_id: String,
    pub engine_version: &'static str,
    pub computed_ms: f64,
    pub cache_hit: bool,
    pub bar_count: usize,
    pub range: RangeDto,
    pub series: Vec<SeriesDto>,
}
