//! Tushare 主源骨架：MVP 不编译传输层、不读取 token、不发起网络请求。
//! 所有必需方法返回 `Unsupported`，让上层在「未配置真实源」时稳定降级到 mock。

use async_trait::async_trait;

use crate::date::Date;
use crate::provider::{BarBatch, BarRequest, DataProvider, FactorBatch, SecurityMaster};
use crate::types::{
    Capabilities, Health, NotSupported, ProviderError, ProviderId, RatePolicy,
};

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
        Err(ProviderError::Unsupported("tushare 传输层未接入"))
    }

    async fn trading_calendar(
        &self,
        _from: Date,
        _to: Date,
    ) -> Result<Vec<Date>, ProviderError> {
        Err(ProviderError::Unsupported("tushare 传输层未接入"))
    }

    async fn daily_bars(&self, _req: BarRequest) -> Result<BarBatch, ProviderError> {
        Err(ProviderError::Unsupported("tushare 传输层未接入"))
    }

    async fn adjust_factors(&self, _security: &str) -> Result<FactorBatch, ProviderError> {
        Err(ProviderError::Unsupported("tushare 传输层未接入"))
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
