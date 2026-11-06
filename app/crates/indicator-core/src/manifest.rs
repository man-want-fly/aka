//! 指标 manifest：指标目录的单一事实来源（Sprint 0）。
//!
//! 文件：`app/manifest/indicators.json`（编译期 `include_str!`，运行时零 IO）。
//! 注册表不再手写 `Meta` 字面量：`meta()` 从 manifest 构建，`impl` 里只保留公式与
//! `warmup` 纯函数（预热是参数函数，无法用 JSON 表达，manifest 用 `warmup` 文案记录）。
//!
//! 一致性门禁：`manifest::tests::registry_matches_manifest` 逐字段比对注册表与
//! manifest；不一致直接红，避免两份数据静默漂移。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::meta::{Category, InputReq, Meta, OutputKind, OutputSpec, SpecStatus};
use crate::param::{ParamSpec, Params};

const RAW: &str = include_str!("../../../manifest/indicators.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema_version: u32,
    /// 目录规划总量（含已实现），不是 status=planned 的条数
    pub catalog_total: usize,
    /// 缓存键维度（只作文档用途，实际实现在 app-core::calc_key）
    #[serde(default)]
    pub cache_key: Vec<String>,
    pub indicators: Vec<ManifestIndicator>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestIndicator {
    pub id: String,
    /// PRD 附录 A 的编号（如 `T01`），后续 id 统一时以前者为准
    pub prd_id: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub name_zh: String,
    pub name_en: String,
    pub category: String,
    pub inputs: ManifestInputs,
    pub params: Vec<ManifestParam>,
    pub outputs: Vec<ManifestOutput>,
    pub formula_ref: String,
    pub version: u16,
    pub spec_status: String,
    /// `normal` | `beta`：beta = 口径未完成人工校对
    pub status: String,
    /// 输出单位/量纲
    #[serde(default)]
    pub unit: String,
    /// 口径说明：公式要点、首个有效值、边界规则
    #[serde(default)]
    pub notes: String,
    /// 目录缩写（如 `MACD`），用于搜索与条目主标识
    #[serde(default)]
    pub abbr: String,
    /// 中文名拼音首字母（如 `kdj`），用于拼音搜索
    #[serde(default)]
    pub pinyin_initials: String,
    /// 面板归属：`主` / `副`
    #[serde(default)]
    pub panel: String,
    /// 公式摘要（目录元信息一行展示）
    #[serde(default)]
    pub formula_summary: String,
    /// 优先级：`P0` / `P1`
    #[serde(default)]
    pub priority: String,
    /// PRD 附录 A 的预热根数（文档用途，实际以 `warmup` 纯函数为准）
    #[serde(default)]
    pub warmup_bars: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestInputs {
    #[serde(default)]
    pub open: bool,
    #[serde(default)]
    pub high: bool,
    #[serde(default)]
    pub low: bool,
    #[serde(default)]
    pub close: bool,
    #[serde(default)]
    pub volume: bool,
    #[serde(default)]
    pub amount: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ManifestParam {
    Int {
        key: String,
        label: String,
        min: i64,
        max: i64,
        default: i64,
        step: i64,
    },
    Float {
        key: String,
        label: String,
        min: f64,
        max: f64,
        default: f64,
        step: f64,
        #[serde(default)]
        unit: Option<String>,
    },
    Enum {
        key: String,
        label: String,
        variants: Vec<String>,
        default: String,
    },
    Bool {
        key: String,
        label: String,
        default: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestOutput {
    pub key: String,
    pub label_zh: String,
    pub kind: String,
    pub color: String,
}

pub fn manifest() -> &'static Manifest {
    static PARSED: OnceLock<Manifest> = OnceLock::new();
    PARSED.get_or_init(|| {
        serde_json::from_str(RAW).expect("manifest/indicators.json 解析失败（这是构建期错误）")
    })
}

pub fn entry(id: &str) -> Option<&'static ManifestIndicator> {
    manifest()
        .indicators
        .iter()
        .find(|item| item.id == id || item.aliases.iter().any(|alias| alias == id))
}

/// 从 manifest 构建注册表 `Meta`；首次调用后泄漏为 `'static`（进程内只构建一次）。
pub fn meta_for(id: &str, warmup: fn(&Params) -> usize) -> &'static Meta {
    static CACHE: OnceLock<Mutex<HashMap<String, &'static Meta>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = cache.lock().unwrap_or_else(|err| err.into_inner());
    if let Some(meta) = guard.get(id) {
        return meta;
    }
    let built = build_meta(id, warmup);
    guard.insert(id.to_string(), built);
    built
}

fn build_meta(id: &str, warmup: fn(&Params) -> usize) -> &'static Meta {
    let entry = entry(id).unwrap_or_else(|| panic!("manifest 缺少指标 {id}"));
    let category = match entry.category.as_str() {
        "trend" => Category::Trend,
        "momentum" => Category::Momentum,
        "volatility" => Category::Volatility,
        "volume" => Category::Volume,
        "stat" => Category::Stat,
        "breadth" => Category::Breadth,
        other => panic!("manifest 指标 {id} 的 category 非法：{other}"),
    };
    let spec_status = match entry.spec_status.as_str() {
        "manualComplete" => SpecStatus::ManualComplete,
        "partial" => SpecStatus::Partial,
        "productDefined" => SpecStatus::ProductDefined,
        other => panic!("manifest 指标 {id} 的 specStatus 非法：{other}"),
    };

    let params: Vec<ParamSpec> = entry.params.iter().map(leak_param).collect();
    let outputs: Vec<OutputSpec> = entry
        .outputs
        .iter()
        .map(|output| OutputSpec {
            key: Box::leak(output.key.clone().into_boxed_str()),
            label_zh: Box::leak(output.label_zh.clone().into_boxed_str()),
            kind: match output.kind.as_str() {
                "line" => OutputKind::Line,
                "histogram" => OutputKind::Histogram,
                "dot" => OutputKind::Dot,
                other => panic!("manifest 指标 {id} 的 output kind 非法：{other}"),
            },
            color: Box::leak(output.color.clone().into_boxed_str()),
        })
        .collect();

    Box::leak(Box::new(Meta {
        id: Box::leak(entry.id.clone().into_boxed_str()),
        name_zh: Box::leak(entry.name_zh.clone().into_boxed_str()),
        name_en: Box::leak(entry.name_en.clone().into_boxed_str()),
        category,
        params: Box::leak(params.into_boxed_slice()),
        outputs: Box::leak(outputs.into_boxed_slice()),
        inputs: InputReq {
            open: entry.inputs.open,
            high: entry.inputs.high,
            low: entry.inputs.low,
            close: entry.inputs.close,
            volume: entry.inputs.volume,
            amount: entry.inputs.amount,
        },
        spec_status,
        engine_version: entry.version,
        unit: Box::leak(entry.unit.clone().into_boxed_str()),
        notes: Box::leak(entry.notes.clone().into_boxed_str()),
        warmup,
    }))
}

fn leak_param(param: &ManifestParam) -> ParamSpec {
    match param {
        ManifestParam::Int {
            key,
            label,
            min,
            max,
            default,
            step,
        } => ParamSpec::Int {
            key: Box::leak(key.clone().into_boxed_str()),
            label: Box::leak(label.clone().into_boxed_str()),
            min: *min,
            max: *max,
            default: *default,
            step: *step,
        },
        ManifestParam::Float {
            key,
            label,
            min,
            max,
            default,
            step,
            unit,
        } => ParamSpec::Float {
            key: Box::leak(key.clone().into_boxed_str()),
            label: Box::leak(label.clone().into_boxed_str()),
            min: *min,
            max: *max,
            default: *default,
            step: *step,
            unit: unit
                .clone()
                .map(|text| Box::leak(text.into_boxed_str()) as &'static str),
        },
        ManifestParam::Enum {
            key,
            label,
            variants,
            default,
        } => {
            let leaked: Vec<&'static str> = variants
                .iter()
                .map(|variant| Box::leak(variant.clone().into_boxed_str()) as &'static str)
                .collect();
            ParamSpec::Enum {
                key: Box::leak(key.clone().into_boxed_str()),
                label: Box::leak(label.clone().into_boxed_str()),
                variants: Box::leak(leaked.into_boxed_slice()),
                default: Box::leak(default.clone().into_boxed_str()),
            }
        }
        ManifestParam::Bool { key, label, default } => ParamSpec::Bool {
            key: Box::leak(key.clone().into_boxed_str()),
            label: Box::leak(label.clone().into_boxed_str()),
            default: *default,
        },
    }
}

#[cfg(test)]
mod tests {
    use crate::indicators::all;

    use super::*;

    #[test]
    fn manifest_parses_and_ids_are_unique() {
        let manifest = manifest();
        assert_eq!(manifest.schema_version, 1);
        assert!(manifest.catalog_total >= manifest.indicators.len());
        let mut ids = std::collections::BTreeSet::new();
        let mut visible = std::collections::BTreeSet::new();
        for item in &manifest.indicators {
            assert!(ids.insert(item.id.as_str()), "manifest id 重复：{}", item.id);
            assert!(
                visible.insert(item.id.as_str()),
                "manifest id 与 alias 冲突：{}",
                item.id
            );
            for alias in &item.aliases {
                assert!(
                    visible.insert(alias.as_str()),
                    "manifest alias 重复或与 id 冲突：{alias}"
                );
            }
            assert!(!item.formula_ref.is_empty(), "{} 缺少公式引用", item.id);
            assert!(!item.unit.is_empty(), "{} 缺少单位/量纲说明", item.id);
            assert!(!item.notes.is_empty(), "{} 缺少口径说明", item.id);
        }
    }

    #[test]
    fn manifest_covers_prd_catalog_and_metadata() {
        use std::collections::BTreeMap;

        let manifest = manifest();
        assert_eq!(manifest.indicators.len(), 105, "目录应为 PRD 的 105 条");
        assert_eq!(manifest.catalog_total, 105);

        let mut counts = BTreeMap::new();
        for item in &manifest.indicators {
            *counts.entry(item.category.as_str()).or_insert(0_usize) += 1;
            assert!(!item.abbr.is_empty(), "{} 缺 abbr", item.id);
            assert!(!item.pinyin_initials.is_empty(), "{} 缺拼音首字母", item.id);
            assert!(item.panel == "主" || item.panel == "副", "{} 面板非法：{}", item.id, item.panel);
            assert!(!item.formula_summary.is_empty(), "{} 缺公式摘要", item.id);
            assert!(item.priority == "P0" || item.priority == "P1", "{} 优先级非法", item.id);
        }
        assert_eq!(
            counts,
            BTreeMap::from([
                ("trend", 24),
                ("momentum", 26),
                ("volatility", 10),
                ("volume", 15),
                ("stat", 14),
                ("breadth", 16),
            ])
        );

        let implemented = manifest
            .indicators
            .iter()
            .filter(|item| item.status != "planned")
            .count();
        assert_eq!(implemented, 44, "已实现条目数不得被规划项污染");
        assert_eq!(manifest.indicators.iter().filter(|i| i.status == "planned").count(), 61);
    }

    #[test]
    fn registry_matches_manifest() {
        for indicator in all() {
            let meta = indicator.meta();
            let entry = entry(meta.id).unwrap_or_else(|| panic!("manifest 缺少 {}", meta.id));
            assert_eq!(meta.name_zh, entry.name_zh, "{} nameZh 不一致", meta.id);
            assert_eq!(meta.name_en, entry.name_en, "{} nameEn 不一致", meta.id);
            assert_eq!(category_str(meta.category), entry.category, "{} category 不一致", meta.id);
            assert_eq!(spec_status_str(meta.spec_status), entry.spec_status, "{} specStatus 不一致", meta.id);
            assert_eq!(meta.engine_version, entry.version, "{} version 不一致", meta.id);
            assert_eq!(status_str(meta.spec_status), entry.status, "{} status 不一致", meta.id);
            assert_eq!(meta.unit, entry.unit, "{} unit 不一致", meta.id);
            assert_eq!(meta.notes, entry.notes, "{} notes 不一致", meta.id);

            assert_eq!(meta.params.len(), entry.params.len(), "{} 参数数量不一致", meta.id);
            for (spec, source) in meta.params.iter().zip(entry.params.iter()) {
                assert_eq!(spec.key(), param_key(source), "{} 参数 key 顺序不一致", meta.id);
            }
            assert_eq!(meta.outputs.len(), entry.outputs.len(), "{} 输出数量不一致", meta.id);
            for (spec, source) in meta.outputs.iter().zip(entry.outputs.iter()) {
                assert_eq!(spec.key, source.key, "{} 输出 key 顺序不一致", meta.id);
                assert_eq!(spec.label_zh, source.label_zh, "{} 输出中文名不一致", meta.id);
            }
            let inputs = manifest_inputs(meta.inputs);
            assert_eq!(inputs, entry.inputs, "{} inputs 不一致", meta.id);
        }
    }

    fn category_str(category: Category) -> &'static str {
        match category {
            Category::Trend => "trend",
            Category::Momentum => "momentum",
            Category::Volatility => "volatility",
            Category::Volume => "volume",
            Category::Stat => "stat",
            Category::Breadth => "breadth",
        }
    }

    fn spec_status_str(status: SpecStatus) -> &'static str {
        match status {
            SpecStatus::ManualComplete => "manualComplete",
            SpecStatus::Partial => "partial",
            SpecStatus::ProductDefined => "productDefined",
        }
    }

    fn status_str(status: SpecStatus) -> &'static str {
        match status {
            SpecStatus::ManualComplete => "normal",
            _ => "beta",
        }
    }

    fn param_key(param: &ManifestParam) -> &str {
        match param {
            ManifestParam::Int { key, .. }
            | ManifestParam::Float { key, .. }
            | ManifestParam::Enum { key, .. }
            | ManifestParam::Bool { key, .. } => key,
        }
    }

    fn manifest_inputs(req: InputReq) -> ManifestInputs {
        ManifestInputs {
            open: req.open,
            high: req.high,
            low: req.low,
            close: req.close,
            volume: req.volume,
            amount: req.amount,
        }
    }

    impl PartialEq for ManifestInputs {
        fn eq(&self, other: &Self) -> bool {
            self.open == other.open
                && self.high == other.high
                && self.low == other.low
                && self.close == other.close
                && self.volume == other.volume
                && self.amount == other.amount
        }
    }
}
