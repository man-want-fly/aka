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
    /// 复权因子（1.0 = 不复权原始价）；S-02.07-02 除权日 tooltip 要显示实际调整因子
    pub adj_factor: f64,
    /// 行级溯源
    pub source: String,
    pub quality: Vec<String>,
    /// S-07.05-02：生成批次与入库时间；缺失时前端显示「缺失」并给出 E_PROVENANCE_MISSING
    pub batch_id: Option<String>,
    pub ingested_at: Option<i64>,
}

/// S-07.05-02：单根 K 线溯源浮层的六类字段 + 复权前后价。
/// `missing_fields` / `error_code` 由内核判定，前端只照常渲染「缺失」，不再自行猜测。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BarProvenanceDto {
    pub security: String,
    pub date: String,
    pub provider: String,
    pub batch_id: Option<String>,
    pub ingested_at: Option<i64>,
    pub dataset_id: String,
    pub adj_mode: String,
    pub quality_flags: Vec<String>,
    /// 复权前收盘（原始价）
    pub raw_close: f64,
    /// 当前视图复权口径下的收盘
    pub close: f64,
    pub adj_factor: f64,
    /// 缺失字段名（camelCase）；空 = 六类字段齐全
    pub missing_fields: Vec<String>,
    /// 有缺失时为 `E_PROVENANCE_MISSING`
    pub error_code: Option<&'static str>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BarProvenanceRequest {
    pub security: String,
    /// 交易日 `YYYY-MM-DD`
    pub date: String,
    #[serde(default = "default_timeframe")]
    pub timeframe: String,
    #[serde(default = "default_adj")]
    pub adj: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceDto {
    pub provider: String,
    pub dataset_id: String,
    pub data_version: String,
    /// 数据集重建代数（TD-S0-08）：每次重建 +1
    pub dataset_generation: u64,
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
/// T-01 口径：`requested*` = 用户请求；`returned*` = 实际命中的首末交易日；
/// `clamped` = 是否发生吸附/截断；区间无数据时以 `INSUFFICIENT_DATA` 返回。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeDto {
    pub requested_from: Option<String>,
    pub requested_to: Option<String>,
    /// 实际返回的第一根 K 线日期；空区间时为 None
    pub returned_from: Option<String>,
    /// 实际返回的最后一根 K 线日期
    pub returned_to: Option<String>,
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
    /// 输出单位/量纲
    pub unit: &'static str,
    /// 口径说明（公式要点、首个有效值、边界）
    pub notes: &'static str,
    pub warmup: usize,
    /// 骨架期注册表里只有已实现指标；目录规划总量（含已实现）由 `catalogTotal` 给出。
    pub implemented: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryResponse {
    /// 目录规划总量（含已实现），不是 status=planned 的条数
    pub catalog_total: usize,
    pub implemented_count: usize,
    pub indicators: Vec<IndicatorMetaDto>,
}

/// 收藏 chip：注册表已移除时 `status = "offline"`，UI 显示「已下线」且不可加入图表。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorFavoriteDto {
    pub indicator_id: String,
    pub abbr: String,
    pub name_zh: String,
    /// `normal` | `beta` | `planned` | `offline`
    pub status: &'static str,
    pub panel: &'static str,
    /// 参数摘要，如 `20` / `12 / 26 / 9`
    pub param_summary: String,
    pub is_default: bool,
    pub added_at: i64,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorFavoritesResponse {
    pub favorites: Vec<IndicatorFavoriteDto>,
}

/// 最近查看条目：名称与板块由数据集补齐；数据集里已不存在的记录读取时清理。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentViewDto {
    pub code: String,
    pub name: String,
    pub board: &'static str,
    pub is_index: bool,
    pub viewed_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityExampleDto {
    pub security: String,
    pub date: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityCheckDto {
    /// `MISSING` / `EX_RIGHTS` / `SUSPENDED` / `ZERO_VOLUME` / `PRICE_ANOMALY` / `ADJ_COVERAGE`
    pub key: &'static str,
    pub label_zh: &'static str,
    pub hits: i64,
    pub base: i64,
    pub ratio_pct: f64,
    pub treatment: &'static str,
    /// `pass` / `info` / `warning` / `failed`
    pub status: &'static str,
    pub error_code: Option<&'static str>,
    pub examples: Vec<QualityExampleDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityReportDto {
    pub dataset_id: String,
    /// 报告所属数据集 id；与 `current_dataset_id` 不一致即「已过期」
    pub based_on_dataset_id: String,
    pub current_dataset_id: String,
    pub stale: bool,
    /// epoch 秒
    pub scanned_at: i64,
    pub duration_ms: u64,
    pub passed_count: usize,
    pub total_count: usize,
    pub rows: Vec<QualityCheckDto>,
}

/// S-07.01-01：单项能力探测结果（4 必需 + 4 可选）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasourceCapabilityDto {
    /// `daily_bars` / `adjust_factors` / `securities` / `trading_calendar` /
    /// `industry` / `index_members` / `limit_flags` / `suspended_flags`
    pub key: &'static str,
    pub label_zh: &'static str,
    pub required: bool,
    pub available: bool,
    /// 可选能力缺失时的降级说明；可用时为 None。
    pub note: Option<&'static str>,
}

/// S-07.01-01：运维两项。Mock 为内存数据源，没有磁盘目录，`disk_free_gb` 保持 None。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasourceOpsDto {
    pub data_dir_readable: bool,
    pub disk_free_gb: Option<f64>,
    pub note: Option<&'static str>,
}

/// S-07.01-01：数据版本 6 字段，全部只读。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetVersionDto {
    pub dataset_id: String,
    /// 截断展示用短码；完整值仍在 `dataset_id`。
    pub dataset_id_short: String,
    /// epoch 秒；界面按本地时区格式化为 `YYYY-MM-DD HH:mm`。
    pub generated_at: i64,
    pub row_count: u64,
    pub coverage_start: String,
    pub coverage_end: String,
    pub sha256: String,
    /// 完整 64 位 sha256 的前 12 位，供界面展示与复制。
    pub sha256_short: String,
}

/// S-07.01-01：P9 首卡数据源状态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasourceStatusDto {
    /// `ready` / `partial` / `unavailable` / `missing` / `probe_failed`
    pub state: &'static str,
    pub required_ok: usize,
    pub required_total: usize,
    pub optional_ok: usize,
    pub optional_total: usize,
    pub capabilities: Vec<DatasourceCapabilityDto>,
    pub ops: DatasourceOpsDto,
    pub version: Option<DatasetVersionDto>,
    pub tushare_enabled: usize,
    pub tushare_total: usize,
    /// epoch 秒
    pub checked_at: i64,
    pub error_code: Option<&'static str>,
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
    /// 数据集重建代数；与请求 `generation` 独立，前端不得混用
    pub dataset_generation: u64,
    pub engine_version: &'static str,
    pub computed_ms: f64,
    pub cache_hit: bool,
    pub bar_count: usize,
    pub range: RangeDto,
    pub series: Vec<SeriesDto>,
}

// ---------- E-01 行情列表 ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSnapshotDto {
    /// 样本口径：当前模拟数据集内全部标的数
    pub sample_count: usize,
    /// 最新一根日线的交易日（列表「数据时间」列）
    pub data_date: String,
    /// 数据集 manifest `coverage_start`：与 `data_date` 独立来源，供页头核对
    pub coverage_start: String,
    /// 数据集 manifest `coverage_end`：数据集的最后交易日
    pub coverage_end: String,
    pub provider: String,
    pub dataset_id: String,
    pub data_version: String,
    pub dataset_generation: u64,
    pub simulated: bool,
    pub generated_at: i64,
    pub rows: Vec<MarketRowDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketRowDto {
    pub security: String,
    pub code: String,
    pub name: String,
    pub market: String,
    /// 主板 / 创业板 / 科创板 / 指数
    pub board: String,
    pub is_index: bool,
    pub suspended: bool,
    pub last_price: Option<f64>,
    pub prev_close: Option<f64>,
    pub change_abs: Option<f64>,
    pub change_pct: Option<f64>,
    pub volume: Option<f64>,
    pub amount: Option<f64>,
    pub turnover_pct: Option<f64>,
    pub volume_ratio: Option<f64>,
    pub amplitude_pct: Option<f64>,
    /// 涨跌停等数据质量标记（如 LIMIT_UP / LIMIT_DOWN）
    pub flags: Vec<String>,
    /// 关键字段缺失，前端显示「数据异常」而不是 0
    pub data_issue: bool,
}

// ---------- E-01 自选 ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchGroupDto {
    pub name: String,
    pub count: i64,
    pub sort_order: i64,
    pub is_builtin: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchItemDto {
    pub security: String,
    /// `null` = 未分组
    pub group_name: Option<String>,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchlistDto {
    pub limit: i64,
    pub total: i64,
    pub groups: Vec<WatchGroupDto>,
    pub items: Vec<WatchItemDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchToggleResult {
    /// 操作后该标的是否在任一自选分组内
    pub watched: bool,
    pub total: i64,
}

// ---------- E-01 持仓 ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionDto {
    pub security: String,
    pub cost_price: f64,
    pub shares: i64,
    pub updated_at: i64,
}


// ---------- E-07 数据源健康检查（S-07.01-02） ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataHealthItemDto {
    pub key: String,
    pub label_zh: String,
    /// PASS / FAIL / SKIP
    pub status: &'static str,
    pub duration_ms: u64,
    pub error_code: Option<&'static str>,
    pub detail: Option<String>,
    pub advice: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataHealthDto {
    pub items: Vec<DataHealthItemDto>,
    pub passed: u32,
    pub total: u32,
    pub duration_ms: u64,
    /// 检查完成时间（epoch ms）；页面按本地时区渲染。
    pub checked_at: i64,
    pub dataset_id: Option<String>,
}
