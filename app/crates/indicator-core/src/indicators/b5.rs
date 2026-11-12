//! B5：价格代理指标（E08 中价 / E09 典型价 / E10 加权收盘）。
//!
//! 三者都是单根 K 线价格的算术组合，无预热；缺失输入返回 `NaN`。

use crate::meta::Meta;
use crate::param::Params;
use crate::view::{CalcError, Indicator, OhlcvView};

use super::ensure_shape;

pub const E08_ID: &str = "E08";
pub const E09_ID: &str = "E09";
pub const E10_ID: &str = "E10";

/// E08 中价：`(H + L) / 2`。
pub struct MedianPrice;

impl Indicator for MedianPrice {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(E08_ID, warmup_zero)
    }

    fn calc(
        &self,
        view: &OhlcvView<'_>,
        _params: &Params,
        out: &mut [Vec<f64>],
    ) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, E08_ID)?;
        for i in 0..view.len() {
            let (high, low) = (view.high[i], view.low[i]);
            out[0][i] = if high.is_finite() && low.is_finite() {
                (high + low) / 2.0
            } else {
                f64::NAN
            };
        }
        Ok(())
    }
}

/// E09 典型价：`(H + L + C) / 3`。
pub struct TypicalPrice;

impl Indicator for TypicalPrice {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(E09_ID, warmup_zero)
    }

    fn calc(
        &self,
        view: &OhlcvView<'_>,
        _params: &Params,
        out: &mut [Vec<f64>],
    ) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, E09_ID)?;
        for i in 0..view.len() {
            let (high, low, close) = (view.high[i], view.low[i], view.close[i]);
            out[0][i] = if high.is_finite() && low.is_finite() && close.is_finite() {
                (high + low + close) / 3.0
            } else {
                f64::NAN
            };
        }
        Ok(())
    }
}

/// E10 加权收盘价：`(H + L + 2C) / 4`，收盘价权重占一半。
pub struct WeightedClose;

impl Indicator for WeightedClose {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(E10_ID, warmup_zero)
    }

    fn calc(
        &self,
        view: &OhlcvView<'_>,
        _params: &Params,
        out: &mut [Vec<f64>],
    ) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, E10_ID)?;
        for i in 0..view.len() {
            let (high, low, close) = (view.high[i], view.low[i], view.close[i]);
            out[0][i] = if high.is_finite() && low.is_finite() && close.is_finite() {
                (high + low + 2.0 * close) / 4.0
            } else {
                f64::NAN
            };
        }
        Ok(())
    }
}

fn warmup_zero(_params: &Params) -> usize {
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{lookup, merge_defaults};

    fn run(id: &str, open: &[f64], high: &[f64], low: &[f64], close: &[f64]) -> Vec<f64> {
        let indicator = lookup(id).unwrap();
        let params = merge_defaults(indicator.meta().params, &Params::new());
        let view = OhlcvView::new(open, high, low, close, close, close);
        let mut out = vec![vec![0.0; close.len()]; indicator.meta().outputs.len()];
        indicator.calc(&view, &params, &mut out).unwrap();
        out.remove(0)
    }

    #[test]
    fn price_proxies_match_manual_arithmetic() {
        let open = [10.0, 12.0];
        let high = [11.0, 14.0];
        let low = [9.0, 8.0];
        let close = [10.0, 10.0];
        assert_eq!(run(E08_ID, &open, &high, &low, &close), vec![10.0, 11.0]);
        assert_eq!(
            run(E09_ID, &open, &high, &low, &close),
            vec![10.0, 32.0 / 3.0]
        );
        assert_eq!(
            run(E10_ID, &open, &high, &low, &close),
            vec![10.0, 10.5]
        );
        assert_eq!(crate::manifest::entry(E08_ID).unwrap().status, "normal");
        assert_eq!(crate::manifest::entry(E09_ID).unwrap().status, "normal");
        assert_eq!(crate::manifest::entry(E10_ID).unwrap().status, "normal");
    }

    #[test]
    fn price_proxies_are_nan_when_required_input_missing() {
        let one = [10.0];
        let nan = [f64::NAN];
        assert!(run(E08_ID, &one, &nan, &one, &one)[0].is_nan(), "中价缺 H");
        assert!(
            run(E09_ID, &one, &one, &one, &nan)[0].is_nan(),
            "典型价缺 C"
        );
        assert!(
            run(E10_ID, &one, &one, &nan, &one)[0].is_nan(),
            "加权收盘缺 L"
        );
    }
}
