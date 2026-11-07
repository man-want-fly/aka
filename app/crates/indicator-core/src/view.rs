use std::fmt;

use crate::meta::Meta;
use crate::param::Params;

#[derive(Debug, Clone, Copy)]
pub struct OhlcvView<'a> {
    pub open: &'a [f64],
    pub high: &'a [f64],
    pub low: &'a [f64],
    pub close: &'a [f64],
    pub volume: &'a [f64],
    pub amount: &'a [f64],
}

impl<'a> OhlcvView<'a> {
    pub fn new(
        open: &'a [f64],
        high: &'a [f64],
        low: &'a [f64],
        close: &'a [f64],
        volume: &'a [f64],
        amount: &'a [f64],
    ) -> Self {
        Self {
            open,
            high,
            low,
            close,
            volume,
            amount,
        }
    }

    pub fn len(&self) -> usize {
        self.close.len()
    }

    pub fn is_empty(&self) -> bool {
        self.close.is_empty()
    }

    /// 骨架期只校验所有列长度一致；真实计算只读取所需列。
    pub fn columns_are_aligned(&self) -> bool {
        self.len() == self.open.len()
            && self.len() == self.high.len()
            && self.len() == self.low.len()
            && self.len() == self.volume.len()
            && self.len() == self.amount.len()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum CalcError {
    InsufficientData { required: usize, got: usize },
    InvalidParam(String),
    ParamOrder(String),
    Internal(String),
}

impl fmt::Display for CalcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CalcError::InsufficientData { required, got } => {
                write!(f, "数据不足：需要 {required} 根，当前 {got} 根")
            }
            CalcError::InvalidParam(msg) => write!(f, "参数不合法：{msg}"),
            CalcError::ParamOrder(msg) => write!(f, "参数顺序不合法：{msg}"),
            CalcError::Internal(msg) => write!(f, "指标内核错误：{msg}"),
        }
    }
}

impl std::error::Error for CalcError {}

/// 指标内核的唯一接口：纯函数、无 IO、无 async。
pub trait Indicator: Send + Sync {
    fn meta(&self) -> &'static Meta;

    /// `out` 的长度等于 `meta().outputs.len()`，且每个 `Vec` 已预分配为 `view.len()`。
    /// 缺失值一律填 `f64::NAN`，不得补零。
    fn calc(
        &self,
        view: &OhlcvView<'_>,
        params: &Params,
        out: &mut [Vec<f64>],
    ) -> Result<(), CalcError>;
}
