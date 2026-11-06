//! 指标计算内核：注册表、参数规格、纯数值内核。
//!
//! 本 crate 刻意不依赖 tokio / tauri / arrow / provider / store：
//! 输入是切片，输出是 `Vec<f64>`，缺失值统一用 `f64::NAN`。
//! MVP 骨架只注册 MA 与 MACD 两个示例，规划总数为 105。

pub mod indicators;
pub mod manifest;
pub mod meta;
pub mod param;
pub mod view;

pub use indicators::{all, implemented_count, lookup, MACD_ID, MA_ID, PLANNED_INDICATOR_COUNT};
pub use manifest::{
    manifest, Manifest, ManifestIndicator, ManifestInputs, ManifestOutput, ManifestParam,
};
pub use meta::{Category, InputReq, Meta, OutputKind, OutputSpec, SpecStatus};
pub use param::{merge_defaults, param_int, param_text, validate, ParamError, ParamSpec, ParamValue, Params};
pub use view::{CalcError, Indicator, OhlcvView};

/// 注册表/公式的版本号，参与 app-core 的缓存键。
pub const ENGINE_VERSION: &str = "aka-engine-0.1.0";
