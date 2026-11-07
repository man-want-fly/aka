//! B4：量类指标（W-54 起步：OBV）。

use crate::meta::Meta;
use crate::param::Params;
use crate::view::{CalcError, Indicator, OhlcvView};

use super::ensure_shape;

pub const D01_ID: &str = "D01";

/// D01 能量潮（OBV）：`OBV(t) = OBV(t−1) + V(t)·sign(C(t)−C(t−1))`。
///
/// 口径：
/// - 首根只作基准，不产出（`warmup = 1`）；
/// - 平盘日 sign=0，OBV 沿用前值；
/// - 停牌/零量根按 D-19 返回 `NaN`（断线），累计值保留，复牌后继续累加；
/// - 缺失输入一律 `NaN`，不补零。
pub struct Obv;

impl Indicator for Obv {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(D01_ID, obv_warmup)
    }

    fn calc(
        &self,
        view: &OhlcvView<'_>,
        _params: &Params,
        out: &mut [Vec<f64>],
    ) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, D01_ID)?;
        out[0].fill(f64::NAN);
        if view.len() < 2 {
            return Ok(());
        }

        let mut acc = 0.0;
        for i in 1..view.len() {
            let prev = view.close[i - 1];
            let close = view.close[i];
            let volume = view.volume[i];
            if !prev.is_finite() || !close.is_finite() || !volume.is_finite() || volume <= 0.0 {
                // 停牌/零量：该根断线，但不打断累计口径。
                continue;
            }
            acc += if close > prev {
                volume
            } else if close < prev {
                -volume
            } else {
                0.0
            };
            out[0][i] = acc;
        }
        Ok(())
    }
}

fn obv_warmup(_params: &Params) -> usize {
    1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{lookup, merge_defaults};

    fn calc(close: &[f64], volume: &[f64]) -> Vec<f64> {
        let indicator = lookup(D01_ID).unwrap();
        let params = merge_defaults(indicator.meta().params, &Params::new());
        let view = OhlcvView::new(close, close, close, close, volume, volume);
        let mut out = vec![vec![0.0; close.len()]; indicator.meta().outputs.len()];
        indicator.calc(&view, &params, &mut out).unwrap();
        out.remove(0)
    }

    #[test]
    fn obv_matches_manual_cumulative_sign() {
        let close = [10.0, 11.0, 10.0, 10.0, 12.0];
        let volume = [100.0, 200.0, 300.0, 400.0, 500.0];
        let obv = calc(&close, &volume);
        assert!(obv[0].is_nan(), "首根只作基准");
        assert_eq!(&obv[1..], &[200.0, -100.0, -100.0, 400.0]);
    }

    #[test]
    fn suspended_bar_breaks_line_but_keeps_accumulation() {
        let close = [10.0, 11.0, 11.0, 12.0];
        let volume = [100.0, 200.0, 0.0, 300.0];
        let obv = calc(&close, &volume);
        assert_eq!(obv[1], 200.0);
        assert!(obv[2].is_nan(), "停牌/零量根必须断线");
        assert_eq!(obv[3], 500.0, "复牌后从上次累计继续");
    }

    #[test]
    fn obv_meta_is_normal_and_needs_volume() {
        let indicator = lookup(D01_ID).unwrap();
        let meta = indicator.meta();
        assert_eq!(meta.outputs.len(), 1);
        assert_eq!(meta.outputs[0].key, "value");
        assert!(meta.inputs.close);
        assert!(meta.inputs.volume, "OBV 必须声明需要成交量");
        assert_eq!(crate::manifest::entry(D01_ID).unwrap().status, "normal");
        assert_eq!((meta.warmup)(&Params::new()), 1);
    }
}
