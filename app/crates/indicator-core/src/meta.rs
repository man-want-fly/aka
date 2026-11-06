use serde::Serialize;

use crate::param::{Params, ParamSpec};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    Trend,
    Momentum,
    Volatility,
    Volume,
    Stat,
    Breadth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SpecStatus {
    /// 口径页四段（公式/参数/预热/边界）全部人工校对
    ManualComplete,
    /// 公式可用，但边界说明仍待补
    Partial,
    /// 产品先定义、待人工校对
    ProductDefined,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OutputKind {
    Line,
    Histogram,
    Dot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutputSpec {
    pub key: &'static str,
    pub label_zh: &'static str,
    pub kind: OutputKind,
    /// 前端建议色；实际渲染仍受红涨绿跌模式影响
    pub color: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct InputReq {
    pub open: bool,
    pub high: bool,
    pub low: bool,
    pub close: bool,
    pub volume: bool,
    pub amount: bool,
}

impl InputReq {
    pub const CLOSE: Self = Self {
        open: false,
        high: false,
        low: false,
        close: true,
        volume: false,
        amount: false,
    };

    pub const OHLCV: Self = Self {
        open: true,
        high: true,
        low: true,
        close: true,
        volume: true,
        amount: false,
    };
}

#[derive(Debug, Clone, Copy)]
pub struct Meta {
    pub id: &'static str,
    pub name_zh: &'static str,
    pub name_en: &'static str,
    pub category: Category,
    pub params: &'static [ParamSpec],
    pub outputs: &'static [OutputSpec],
    pub inputs: InputReq,
    pub spec_status: SpecStatus,
    pub engine_version: u16,
    /// 输出单位/量纲：如「元」「%」「元/根」「无量纲」。
    pub unit: &'static str,
    /// 口径说明：公式要点、首个有效值、边界规则。
    pub notes: &'static str,
    /// 返回需要多少根「前置」数据；与参数有关，必须是纯函数
    pub warmup: fn(&Params) -> usize,
}
