use crate::meta::Meta;
use crate::param::{param_int, param_text};
use crate::view::{CalcError, Indicator, OhlcvView};
use crate::Params;

pub const PLANNED_INDICATOR_COUNT: usize = 105;
pub const MA_ID: &str = "ma";
pub const MACD_ID: &str = "macd";

pub fn all() -> &'static [&'static dyn Indicator] {
    &ALL
}

pub fn implemented_count() -> usize {
    ALL.len()
}

pub fn lookup(id: &str) -> Option<&'static dyn Indicator> {
    ALL.iter()
        .copied()
        .find(|item| item.meta().id == id)
}

static MA: Ma = Ma;
static MACD: Macd = Macd;
static ALL: [&dyn Indicator; 2] = [&MA, &MACD];

pub struct Ma;
pub struct Macd;

impl Indicator for Ma {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(MA_ID, ma_warmup)
    }

    fn calc(
        &self,
        view: &OhlcvView<'_>,
        params: &Params,
        out: &mut [Vec<f64>],
    ) -> Result<(), CalcError> {
        if out.len() != 1 || !view.columns_are_aligned() {
            return Err(CalcError::Internal("MA 输出/输入维度不一致".to_string()));
        }
        let len = view.len();
        if out[0].len() != len {
            return Err(CalcError::Internal("MA 输出未预分配".to_string()));
        }

        let period = param_int(params, "period").unwrap_or(20).max(1) as usize;
        let ma_type = param_text(params, "maType").unwrap_or("sma");

        out[0].fill(f64::NAN);
        if len < period {
            return Ok(());
        }

        match ma_type {
            "ema" => out[0] = ema(view.close, period),
            "wma" => {
                for i in (period - 1)..len {
                    let start = i + 1 - period;
                    let mut num = 0.0;
                    let mut den = 0.0;
                    for k in 0..period {
                        let weight = (k + 1) as f64;
                        num += weight * view.close[start + k];
                        den += weight;
                    }
                    out[0][i] = num / den;
                }
            }
            _ => {
                let mut sum: f64 = view.close[..period].iter().sum();
                out[0][period - 1] = sum / period as f64;
                for i in period..len {
                    sum += view.close[i] - view.close[i - period];
                    out[0][i] = sum / period as f64;
                }
            }
        }
        Ok(())
    }
}

fn ma_warmup(params: &Params) -> usize {
    param_int(params, "period").unwrap_or(20).max(2) as usize - 1
}

impl Indicator for Macd {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(MACD_ID, macd_warmup)
    }

    fn calc(
        &self,
        view: &OhlcvView<'_>,
        params: &Params,
        out: &mut [Vec<f64>],
    ) -> Result<(), CalcError> {
        if out.len() != 3 || !view.columns_are_aligned() {
            return Err(CalcError::Internal("MACD 输出/输入维度不一致".to_string()));
        }
        let len = view.len();
        if out.iter().any(|column| column.len() != len) {
            return Err(CalcError::Internal("MACD 输出未预分配".to_string()));
        }

        let fast = param_int(params, "fast").unwrap_or(12).max(1) as usize;
        let slow = param_int(params, "slow").unwrap_or(26).max(1) as usize;
        let signal = param_int(params, "signal").unwrap_or(9).max(1) as usize;
        if fast >= slow {
            return Err(CalcError::InvalidParam(
                "fast 必须小于 slow".to_string(),
            ));
        }

        out[0].fill(f64::NAN);
        out[1].fill(f64::NAN);
        out[2].fill(f64::NAN);
        if len < slow {
            return Ok(());
        }

        let ema_fast = ema(view.close, fast);
        let ema_slow = ema(view.close, slow);
        let mut dif = vec![f64::NAN; len];
        for i in 0..len {
            if ema_fast[i].is_finite() && ema_slow[i].is_finite() {
                dif[i] = ema_fast[i] - ema_slow[i];
            }
        }

        let dea = ema_of_valid(&dif, signal);
        for i in 0..len {
            if dif[i].is_finite() && dea[i].is_finite() {
                out[0][i] = dif[i];
                out[1][i] = dea[i];
                // A 股展示惯例：柱 = 2 × (DIF − DEA)
                out[2][i] = 2.0 * (dif[i] - dea[i]);
            }
        }
        Ok(())
    }
}

fn macd_warmup(params: &Params) -> usize {
    let slow = param_int(params, "slow").unwrap_or(26).max(2) as usize;
    let signal = param_int(params, "signal").unwrap_or(9).max(2) as usize;
    slow + signal - 2
}

/// EMA：前 period 根用 SMA 种子，之后按 α = 2/(n+1) 递推。与口径页约定一致。
pub(crate) fn ema(values: &[f64], period: usize) -> Vec<f64> {
    let len = values.len();
    let mut out = vec![f64::NAN; len];
    if period == 0 || len < period {
        return out;
    }
    let seed: f64 = values[..period].iter().sum::<f64>() / period as f64;
    out[period - 1] = seed;
    let alpha = 2.0 / (period as f64 + 1.0);
    for i in period..len {
        out[i] = alpha * values[i] + (1.0 - alpha) * out[i - 1];
    }
    out
}

/// 对含 NaN 前缀的序列做 EMA：从第一个有限值开始，取连续 period 个有限值做种子。
fn ema_of_valid(values: &[f64], period: usize) -> Vec<f64> {
    let len = values.len();
    let mut out = vec![f64::NAN; len];
    let Some(start) = values.iter().position(|value| value.is_finite()) else {
        return out;
    };
    let end = start + period;
    if end > len || values[start..end].iter().any(|value| !value.is_finite()) {
        return out;
    }
    let seed: f64 = values[start..end].iter().sum::<f64>() / period as f64;
    out[end - 1] = seed;
    let alpha = 2.0 / (period as f64 + 1.0);
    for i in end..len {
        if values[i].is_finite() && out[i - 1].is_finite() {
            out[i] = alpha * values[i] + (1.0 - alpha) * out[i - 1];
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::param::merge_defaults;

    fn sample_close() -> Vec<f64> {
        (0..80)
            .map(|i| 100.0 + i as f64 * 0.5 + (i as f64 * 0.7).sin() * 2.0)
            .collect()
    }

    fn view_of(close: &[f64]) -> OhlcvView<'_> {
        OhlcvView::new(close, close, close, close, close, close)
    }

    fn params(meta: &Meta) -> Params {
        merge_defaults(meta.params, &Params::new())
    }

    #[test]
    fn ma_sma_has_warmup_nan_and_then_value() {
        let close = sample_close();
        let meta = MA.meta();
        let params = params(meta);
        let mut out = vec![vec![0.0; close.len()]];
        MA.calc(&view_of(&close), &params, &mut out).unwrap();

        assert!(out[0][..19].iter().all(|v| v.is_nan()));
        assert!(out[0][19].is_finite());
        let expected: f64 = close[..20].iter().sum::<f64>() / 20.0;
        assert!((out[0][19] - expected).abs() < 1e-9);
    }

    #[test]
    fn ma_ema_seed_matches_sma() {
        let close = sample_close();
        let meta = MA.meta();
        let mut params = params(meta);
        params.insert("maType".into(), crate::ParamValue::Text("ema".into()));
        let mut out = vec![vec![0.0; close.len()]];
        MA.calc(&view_of(&close), &params, &mut out).unwrap();
        let sma_seed: f64 = close[..20].iter().sum::<f64>() / 20.0;
        assert!((out[0][19] - sma_seed).abs() < 1e-9);
        assert!(out[0][80 - 1].is_finite());
    }

    #[test]
    fn macd_outputs_are_finite_after_warmup() {
        let close = sample_close();
        let meta = MACD.meta();
        let params = params(meta);
        let mut out = vec![vec![0.0; close.len()]; 3];
        MACD.calc(&view_of(&close), &params, &mut out).unwrap();
        let warmup = (meta.warmup)(&params);
        assert!(out[0][..warmup].iter().all(|v| v.is_nan()));
        assert!(out[0][warmup].is_finite());
        assert!(out[1][warmup].is_finite());
        assert!(out[2][warmup].is_finite());
        // 柱 = 2 × (DIF − DEA)
        let i = warmup + 2;
        assert!((out[2][i] - 2.0 * (out[0][i] - out[1][i])).abs() < 1e-9);
    }

    #[test]
    fn macd_rejects_fast_ge_slow() {
        let close = sample_close();
        let meta = MACD.meta();
        let mut params = params(meta);
        params.insert("fast".into(), crate::ParamValue::Int(30));
        params.insert("slow".into(), crate::ParamValue::Int(20));
        let mut out = vec![vec![0.0; close.len()]; 3];
        assert!(MACD.calc(&view_of(&close), &params, &mut out).is_err());
    }

    #[test]
    fn registry_size_is_derived() {
        assert_eq!(implemented_count(), 2);
        assert_eq!(PLANNED_INDICATOR_COUNT, 105);
        assert!(lookup("ma").is_some());
        assert!(lookup("macd").is_some());
        assert!(lookup("not-exist").is_none());
    }
}
