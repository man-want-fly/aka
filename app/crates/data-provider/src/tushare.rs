//! Tushare 主源骨架：MVP 不编译传输层、不读取 token、不发起网络请求。
//! 所有必需方法返回 `SourceNotReady`（`E_SOURCE_NOT_READY`），让上层区分
//! 「整个数据源未启用」与「可选能力不支持」两种情况。

use async_trait::async_trait;

use crate::date::Date;
use crate::provider::{BarBatch, BarRequest, DataProvider, FactorBatch, SecurityMaster};
use crate::types::{
    Capabilities, Health, NotSupported, ProviderError, ProviderId, RatePolicy,
};

/// 必需能力统一的原因：传输层与 token 均未接入，数据源整体不可用。
const SELF_NOT_READY: &str = "tushare 传输层与鉴权均未接入";

pub struct TushareProvider {
    /// TODO(sprint-data-1)：token 只从系统钥匙串读取，禁止写进配置文件或日志。
    token_present: bool,
}

impl TushareProvider {
    pub fn new(token_present: bool) -> Self {
        Self { token_present }
    }
}

#[async_trait]
impl DataProvider for TushareProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Tushare
    }

    fn capabilities(&self) -> Capabilities {
        // 骨架期一律 false：能力声明必须和真实实现同步打开。
        Capabilities {
            securities: false,
            trading_calendar: false,
            daily_bars: false,
            adjust_factors: false,
            index_members: false,
            industry: false,
            limit_flags: false,
            minute_bars: false,
        }
    }

    async fn securities(&self, _as_of: Date) -> Result<SecurityMaster, ProviderError> {
        Err(ProviderError::SourceNotReady(SELF_NOT_READY))
    }

    async fn trading_calendar(
        &self,
        _from: Date,
        _to: Date,
    ) -> Result<Vec<Date>, ProviderError> {
        Err(ProviderError::SourceNotReady(SELF_NOT_READY))
    }

    async fn daily_bars(&self, _req: BarRequest) -> Result<BarBatch, ProviderError> {
        Err(ProviderError::SourceNotReady(SELF_NOT_READY))
    }

    async fn adjust_factors(&self, _security: &str) -> Result<FactorBatch, ProviderError> {
        Err(ProviderError::SourceNotReady(SELF_NOT_READY))
    }

    async fn index_members(
        &self,
        _index: &str,
        _as_of: Date,
    ) -> Result<Vec<String>, NotSupported> {
        Err(NotSupported {
            feature: "index_members",
        })
    }

    async fn industry(&self, _as_of: Date) -> Result<Vec<(String, String)>, NotSupported> {
        Err(NotSupported { feature: "industry" })
    }

    async fn limit_flags(&self, _req: BarRequest) -> Result<Vec<crate::types::BarRow>, NotSupported> {
        Err(NotSupported {
            feature: "limit_flags",
        })
    }

    async fn minute_bars(&self, _req: BarRequest) -> Result<BarBatch, NotSupported> {
        Err(NotSupported {
            feature: "minute_bars",
        })
    }

    fn rate_policy(&self) -> RatePolicy {
        RatePolicy {
            max_requests_per_minute: 500,
            max_concurrent: 2,
            note: "Tushare 积分制，按接口配额限流",
        }
    }

    async fn health(&self) -> Health {
        Health {
            reachable: false,
            quota_remaining: None,
            last_error: Some(if self.token_present {
                "传输层未接入（骨架）".to_string()
            } else {
                "未配置 token".to_string()
            }),
            checked_at: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Adjust, Timeframe};

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime")
    }

    fn request() -> BarRequest {
        BarRequest {
            security: "600519.SH".into(),
            timeframe: Timeframe::Day,
            adj: Adjust::None,
            from: None,
            to: None,
        }
    }

    /// AC-DF-01-02-3：未启用的数据源，4 个必需方法统一返回 SourceNotReady，
    /// 不得 panic、不得返回空数组。
    #[test]
    fn required_methods_report_source_not_ready() {
        let provider = TushareProvider::new(false);
        let runtime = runtime();

        let cases = [
            runtime.block_on(provider.securities(Date::new(2026, 1, 1))).err(),
            runtime
                .block_on(provider.trading_calendar(Date::new(2023, 1, 1), Date::new(2023, 12, 31)))
                .err(),
            runtime.block_on(provider.daily_bars(request())).err(),
            runtime.block_on(provider.adjust_factors("600519.SH")).err(),
        ];
        for case in cases {
            match case {
                Some(ProviderError::SourceNotReady(reason)) => {
                    assert!(!reason.is_empty(), "原因不得为空");
                }
                other => panic!("必需方法必须返回 SourceNotReady，实际 {other:?}"),
            }
        }
    }

    /// AC-DF-01-02-4：可选能力缺失必须走 NotSupported 降级，不能伪装成成功。
    #[test]
    fn optional_methods_report_not_supported() {
        let provider = TushareProvider::new(false);
        let runtime = runtime();
        assert!(runtime
            .block_on(provider.index_members("000300.SH", Date::new(2024, 1, 1)))
            .is_err());
        assert!(runtime.block_on(provider.industry(Date::new(2024, 1, 1))).is_err());
        assert!(runtime.block_on(provider.limit_flags(request())).is_err());
        assert!(runtime.block_on(provider.minute_bars(request())).is_err());
    }

    /// AC-DF-01-02-5：骨架期能力位必须全部为 false，避免页面默认显示绿色。
    #[test]
    fn capabilities_stay_false_while_skeleton() {
        let caps = TushareProvider::new(true).capabilities();
        assert!(!caps.securities);
        assert!(!caps.trading_calendar);
        assert!(!caps.daily_bars);
        assert!(!caps.adjust_factors);
        assert!(!caps.index_members);
        assert!(!caps.industry);
        assert!(!caps.limit_flags);
        assert!(!caps.minute_bars);
    }
}
