use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};

use data_provider::ProviderError;

/// 页面上要展示的追踪号：可读的本地时间 + 进程内序号，同一 id 同时写 telemetry。
pub fn trace_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    // 产品面向 A 股（Asia/Shanghai，无夏令时），日志时间和用户报号按同一时区。
    let (date, time) = local_stamp(now.as_secs() as i64 + 8 * 3600);
    format!("TR-{date}-{time}-{:04}", SEQ.fetch_add(1, Ordering::Relaxed))
}

/// `YYYYMMDD` + `HHMMSS`（epoch 秒已按 +08:00 偏移）。
fn local_stamp(secs: i64) -> (String, String) {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    (
        format!("{year:04}{month:02}{day:02}"),
        format!("{:02}{:02}{:02}", rem / 3_600, (rem / 60) % 60, rem % 60),
    )
}

/// Howard Hinnant `civil_from_days`：epoch 天 → (年, 月, 日)。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    UnknownSecurity,
    DatasetMissing,
    /// 数据源整体未配置/未启用（AC-DF-01-02-3）：与「不支持该能力」区分。
    SourceNotReady,
    Unsupported,
    InvalidArgument,
    UnknownIndicator,
    ParamOutOfRange,
    ParamOrder,
    /// ST-DF-04-01：区间跨度或根数超过上限，拒绝计算且不写缓存。
    RangeTooLarge,
    InsufficientData,
    /// S-08.02-02：单次指标计算超过 8s。
    Timeout,
    /// S-08.02-02：引擎异常（不向用户暴露堆栈）。
    EnginePanic,
    /// S-08.02-02：数据层不可用。
    DataUnavailable,
    /// S-08.02-03：只读浏览下拒绝写操作。
    DatasetReadonly,
    /// ST-DF-03-01：同一进程内已有安装/重建在跑。
    InstallInProgress,
    /// ST-DF-03-03：缓存 dataset_meta 与落盘 manifest 身份不一致，阻断加载。
    DatasetVersionMismatch,
    /// S-04.01-01：数据集存在但内容不可用（如指数全缺失）。
    DatasetCorrupt,
    Internal,
}

impl ErrorCode {
    /// ST-DF-05-02：错误码全集，逐码校验文案与 retryable 的用例以此为准。
    pub const ALL: [ErrorCode; 18] = [
        ErrorCode::UnknownSecurity,
        ErrorCode::DatasetMissing,
        ErrorCode::SourceNotReady,
        ErrorCode::Unsupported,
        ErrorCode::InvalidArgument,
        ErrorCode::UnknownIndicator,
        ErrorCode::ParamOutOfRange,
        ErrorCode::ParamOrder,
        ErrorCode::RangeTooLarge,
        ErrorCode::InsufficientData,
        ErrorCode::Timeout,
        ErrorCode::EnginePanic,
        ErrorCode::DataUnavailable,
        ErrorCode::DatasetReadonly,
        ErrorCode::InstallInProgress,
        ErrorCode::DatasetVersionMismatch,
        ErrorCode::DatasetCorrupt,
        ErrorCode::Internal,
    ];

    /// AC-DF-05-02-4：每个码都有稳定兜底文案；构造时 message 为空不得把空串抛给页面。
    pub fn default_message(self) -> &'static str {
        match self {
            ErrorCode::UnknownSecurity => "未知标的",
            ErrorCode::DatasetMissing => "数据集缺失",
            ErrorCode::SourceNotReady => "数据源未就绪",
            ErrorCode::Unsupported => "数据源暂不支持该能力",
            ErrorCode::InvalidArgument => "请求参数非法",
            ErrorCode::UnknownIndicator => "未知指标",
            ErrorCode::ParamOutOfRange => "指标参数超出范围",
            ErrorCode::ParamOrder => "指标参数顺序错误",
            ErrorCode::RangeTooLarge => "请求区间超出上限，请缩小日期范围",
            ErrorCode::InsufficientData => "可用数据不足，无法计算",
            ErrorCode::Timeout => "计算超时，可重试或降低计算量",
            ErrorCode::EnginePanic => "引擎异常，已记录",
            ErrorCode::DataUnavailable => "数据层不可用",
            ErrorCode::DatasetReadonly => "数据集不可写：当前为只读浏览",
            ErrorCode::InstallInProgress => "数据集安装/重建正在进行中",
            ErrorCode::DatasetVersionMismatch => "数据集版本不一致，已阻断加载",
            ErrorCode::DatasetCorrupt => "数据集内容损坏，请重新生成或诊断",
            ErrorCode::Internal => "内部错误",
        }
    }

    /// AC-DF-05-02-2/5：只有瞬时故障可重试；参数/数据/只读类错误重试必然再次失败。
    pub fn retryable_by_default(self) -> bool {
        matches!(
            self,
            ErrorCode::Timeout
                | ErrorCode::EnginePanic
                | ErrorCode::DataUnavailable
                | ErrorCode::Internal
        )
    }

    /// W-75：错误码以 PRD L1328 错误码表为唯一权威，统一 `E_` 前缀。
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::UnknownSecurity => "E_UNKNOWN_SECURITY",
            ErrorCode::DatasetMissing => "E_DATASET_MISSING",
            ErrorCode::SourceNotReady => "E_SOURCE_NOT_READY",
            ErrorCode::Unsupported => "E_UNSUPPORTED",
            ErrorCode::InvalidArgument => "E_INVALID_ARGUMENT",
            ErrorCode::UnknownIndicator => "E_UNKNOWN_INDICATOR",
            ErrorCode::ParamOutOfRange => "E_PARAM_OUT_OF_RANGE",
            ErrorCode::ParamOrder => "E_PARAM_ORDER",
            ErrorCode::RangeTooLarge => "E_RANGE_TOO_LARGE",
            ErrorCode::InsufficientData => "E_INSUFFICIENT_DATA",
            ErrorCode::Timeout => "E_TIMEOUT",
            ErrorCode::EnginePanic => "E_ENGINE_PANIC",
            ErrorCode::DataUnavailable => "E_DATA_UNAVAILABLE",
            ErrorCode::DatasetReadonly => "E_DATASET_READONLY",
            ErrorCode::InstallInProgress => "E_INSTALL_IN_PROGRESS",
            ErrorCode::DatasetVersionMismatch => "E_DATASET_VERSION_MISMATCH",
            ErrorCode::DatasetCorrupt => "E_DATASET_CORRUPT",
            ErrorCode::Internal => "E_INTERNAL",
        }
    }
}

impl Serialize for ErrorCode {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// 跨 IPC 的统一错误形状；前端按 `code` 分支，不解析 message。
/// AC-DF-05-02-1/6：四字段必须齐全，`details` 无内容时序列化为 `null`，不得省略字段。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    pub details: Option<Value>,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        let message = message.into();
        // AC-DF-05-02-4：空文案不得外泄，回落到该码的稳定兜底文案。
        let message = if message.trim().is_empty() {
            code.default_message().to_string()
        } else {
            message
        };
        Self {
            code,
            message,
            retryable: code.retryable_by_default(),
            details: None,
        }
    }

    /// AC-DF-05-02-1：任一失败都必须带 `details` 字段；无内容时显式置 null。
    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }

    pub fn unknown_security(code: &str) -> Self {
        Self::new(ErrorCode::UnknownSecurity, format!("未知标的：{code}"))
            .with_details(json!({ "security": code }))
    }

    pub fn unknown_indicator(id: &str) -> Self {
        Self::new(ErrorCode::UnknownIndicator, format!("未知指标：{id}"))
            .with_details(json!({ "indicatorId": id }))
    }

    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidArgument, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message).retryable(true)
    }

    /// state.db 不可恢复损坏：页面展示 message + trace id，动作「重新生成数据」。
    pub fn storage_corrupt(message: impl Into<String>) -> Self {
        let id = trace_id();
        Self::new(ErrorCode::Internal, message)
            .retryable(false)
            .with_details(json!({ "traceId": id }))
    }

    /// S-08.02-02：计算超时；trace id 同时用于页面与 `calc.timeout` 日志对齐。
    pub fn timeout(elapsed_ms: u64, threshold_ms: u64, indicator: Option<&str>) -> Self {
        let id = trace_id();
        Self::new(
            ErrorCode::Timeout,
            format!(
                "已等待 {} 秒未完成，可重试或降低计算量",
                (threshold_ms as f64 / 1000.0).round() as u64
            ),
        )
        .retryable(true)
        .with_details(json!({
            "traceId": id,
            "elapsedMs": elapsed_ms,
            "thresholdMs": threshold_ms,
            "indicator": indicator,
        }))
    }

    /// S-08.02-02：引擎异常；堆栈只进日志，不进 IPC。
    pub fn engine_panic(indicator: Option<&str>) -> Self {
        let id = trace_id();
        Self::new(ErrorCode::EnginePanic, "引擎异常，已记录")
            .retryable(true)
            .with_details(json!({ "traceId": id, "indicator": indicator }))
    }

    /// S-08.02-02：数据层不可用，给「查看数据源状态」。
    pub fn data_unavailable(detail: impl Into<String>) -> Self {
        let id = trace_id();
        Self::new(ErrorCode::DataUnavailable, detail)
            .retryable(true)
            .with_details(json!({ "traceId": id }))
    }

    /// S-08.02-03：只读浏览下所有写操作统一拒绝，message 直接给用户看的原因。
    pub fn dataset_readonly() -> Self {
        Self::new(ErrorCode::DatasetReadonly, "数据集不可写：当前为只读浏览")
    }

    /// ST-DF-03-01：安装/重建互斥，第二次触发立即失败，不产生第二个 staging。
    pub fn install_in_progress() -> Self {
        Self::new(ErrorCode::InstallInProgress, "数据集安装/重建正在进行中")
    }

    /// ST-DF-04-01：区间超上限；不重试（重试同一区间必然再次失败）。
    pub fn range_too_large(details: Value) -> Self {
        Self::new(ErrorCode::RangeTooLarge, "请求区间超出上限，请缩小日期范围")
            .with_details(details)
    }

    /// 页面可见的追踪号；没有 trace id 的错误返回 None。
    pub fn trace_id(&self) -> Option<&str> {
        self.details.as_ref()?.get("traceId")?.as_str()
    }
}

impl From<data_store::state_db::DbError> for AppError {
    fn from(err: data_store::state_db::DbError) -> Self {
        let retryable = err.retryable();
        let raw = err.to_string();
        // SQLite 只读报错统一收成用户可见的「磁盘只读」，不要把英文原文抛到页面。
        let lower = raw.to_ascii_lowercase();
        if lower.contains("readonly") || lower.contains("read-only") {
            return AppError::new(ErrorCode::Internal, "磁盘只读").retryable(true);
        }
        AppError::new(ErrorCode::Internal, raw).retryable(retryable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AC-DF-01-02-3：数据源未就绪跨 IPC 后是 E_SOURCE_NOT_READY，且不可重试；
    /// 与「可选能力不支持」的 E_UNSUPPORTED 明确区分。
    #[test]
    fn source_not_ready_maps_to_distinct_non_retryable_code() {
        let error: AppError = ProviderError::SourceNotReady("tushare 未启用").into();
        assert_eq!(error.code.as_str(), "E_SOURCE_NOT_READY");
        assert!(!error.retryable, "未就绪不应标成可重试");
        assert!(error.message.contains("数据源未就绪"));

        let unsupported: AppError = ProviderError::Unsupported("minute_bars").into();
        assert_eq!(unsupported.code.as_str(), "E_UNSUPPORTED");
    }

    /// AC-DF-05-02-4：错误码全集唯一、统一 `E_` 前缀，且每码都有稳定非空文案。
    #[test]
    fn error_catalog_has_unique_codes_and_stable_messages() {
        use std::collections::HashSet;

        let codes: HashSet<&'static str> = ErrorCode::ALL.iter().map(|code| code.as_str()).collect();
        assert_eq!(codes.len(), ErrorCode::ALL.len(), "错误码不得重复");
        for code in ErrorCode::ALL {
            assert!(
                code.as_str().starts_with("E_"),
                "{} 必须使用 E_ 前缀",
                code.as_str()
            );
            assert!(!code.default_message().trim().is_empty());
            // 空 message 不得外泄，必须回落到稳定文案；连续两次结果一致。
            let first = AppError::new(code, "");
            let second = AppError::new(code, "   ");
            assert_eq!(first.message, code.default_message());
            assert_eq!(second.message, first.message, "同码文案必须稳定");
            assert_eq!(first.code.as_str(), code.as_str());
        }
    }

    /// AC-DF-05-02-1/6：四字段齐全；details 无内容时为 null（既不能缺省也不能是 `{}`）。
    #[test]
    fn app_error_serializes_four_fields_and_null_details() {
        let error = AppError::new(ErrorCode::InvalidArgument, "参数非法");
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["code"], "E_INVALID_ARGUMENT");
        assert_eq!(value["message"], "参数非法");
        assert_eq!(value["retryable"], false);
        assert!(
            value.get("details").is_some(),
            "details 字段不得缺省：{value}"
        );
        assert!(value["details"].is_null(), "details 无内容必须为 null");

        let with_details =
            AppError::new(ErrorCode::UnknownSecurity, "未知标的").with_details(json!({ "security": "X" }));
        let value = serde_json::to_value(&with_details).unwrap();
        assert_eq!(value["details"]["security"], "X");
    }

    /// AC-DF-05-02-2/5：只有瞬时故障可重试；参数/数据/只读类错误重试必然再次失败。
    #[test]
    fn retryable_flag_matches_transient_faults_only() {
        for code in ErrorCode::ALL {
            let expected = matches!(
                code,
                ErrorCode::Timeout
                    | ErrorCode::EnginePanic
                    | ErrorCode::DataUnavailable
                    | ErrorCode::Internal
            );
            assert_eq!(
                AppError::new(code, "x").retryable,
                expected,
                "{} 的 retryable 与对照表不一致",
                code.as_str()
            );
        }
        assert!(AppError::timeout(9_000, 8_000, Some("MA")).retryable);
        assert!(AppError::engine_panic(Some("MA")).retryable);
        assert!(AppError::data_unavailable("网络中断").retryable);
        assert!(!AppError::dataset_readonly().retryable);
        assert!(!AppError::range_too_large(json!({ "reason": "DAYS" })).retryable);
        assert!(!AppError::storage_corrupt("坏库").retryable);
    }

    /// AC-DF-05-02-3：引擎异常只给稳定文案与 trace id，IPC JSON 不得出现堆栈路径。
    #[test]
    fn engine_panic_error_does_not_leak_stack_in_ipc_payload() {
        let error = AppError::engine_panic(Some("MA"));
        assert_eq!(error.code, ErrorCode::EnginePanic);
        let raw = serde_json::to_string(&error).unwrap();
        for forbidden in ["panicked at", "stack backtrace", ".rs:", "RUST_BACKTRACE"] {
            assert!(
                !raw.contains(forbidden),
                "IPC 错误不得包含 {forbidden}：{raw}"
            );
        }
        assert_eq!(error.message, "引擎异常，已记录");
    }
}

impl From<ProviderError> for AppError {
    fn from(err: ProviderError) -> Self {
        match err {
            ProviderError::UnknownSecurity(code) => AppError::unknown_security(&code),
            ProviderError::SourceNotReady(reason) => AppError::new(
                ErrorCode::SourceNotReady,
                format!("数据源未就绪：{reason}"),
            ),
            ProviderError::Unsupported(feature) => AppError::new(
                ErrorCode::Unsupported,
                format!("数据源暂不支持：{feature}"),
            )
            .with_details(json!({ "feature": feature })),
            ProviderError::Network(message) => {
                AppError::internal(format!("数据源网络错误：{message}"))
            }
            ProviderError::Parse(message) => AppError::new(
                ErrorCode::DatasetMissing,
                format!("数据解析失败：{message}"),
            ),
            ProviderError::Internal(message) => AppError::internal(message),
        }
    }
}
