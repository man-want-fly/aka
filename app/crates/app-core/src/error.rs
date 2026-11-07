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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    UnknownSecurity,
    DatasetMissing,
    Unsupported,
    InvalidArgument,
    UnknownIndicator,
    ParamOutOfRange,
    InsufficientData,
    Internal,
}

/// 跨 IPC 的统一错误形状；前端按 `code` 分支，不解析 message。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
            details: None,
        }
    }

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
            .with_details(json!({ "traceId": id }))
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

impl From<ProviderError> for AppError {
    fn from(err: ProviderError) -> Self {
        match err {
            ProviderError::UnknownSecurity(code) => AppError::unknown_security(&code),
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
