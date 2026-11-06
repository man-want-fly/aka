use serde::Serialize;
use serde_json::{json, Value};

use data_provider::ProviderError;

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
