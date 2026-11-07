//! 编排层：组合 data-provider、data-store、indicator-core，并向命令层暴露用例。
//!
//! 依赖边界：app-core 可以依赖三个底层 crate；底层禁止反向依赖它。

pub mod core;
pub mod dto;
pub mod error;
pub mod quality;
pub mod telemetry;

pub use core::AppCore;
pub use dto::*;
pub use error::{AppError, ErrorCode};
pub use telemetry::{
    ParamDebouncer, Telemetry, TelemetryEvent, TelemetrySummary, DEFAULT_DEBOUNCE_QUIET_MS,
    TYPICAL_INPUT_GAP_MS,
};
pub use indicator_core::{Manifest, ManifestIndicator, ManifestInputs, ManifestParam, ManifestOutput};
pub use data_provider::DatasetManifest;
