use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};

use data_provider::ProviderError;

/// 页面上要展示的追踪号：同一进程内单调，便于按号检索日志。
pub fn trace_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("TR-{nanos:x}-{:04x}", SEQ.fetch_add(1, Ordering::Relaxed))
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
