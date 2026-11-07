//! 指标注册表（B1：均线 / 回归底座 + MACD 存量）。
//!
//! id 统一为 PRD 编号（`T01`…`T22`、`E13`、`M06`），旧 `ma` / `macd` 保留 alias 一版，
//! 由 manifest 的 `aliases` 解析。实现入口仍是 `Indicator::calc(&OhlcvView, &Params, &mut [Vec<f64>])`。

use crate::kernels::{bias, ema, ema_of_valid, linreg, sma, wma};
use crate::meta::Meta;
use crate::param::param_int;
use crate::view::{CalcError, Indicator, OhlcvView};
use crate::Params;

pub mod b2;
pub mod b3;
pub mod b4;

pub use b2::{
    T08_ID, T09_ID, T10_ID, T11_ID, T12_ID, T13_ID, T14_ID, T15_ID, T16_ID, T23_ID, T24_ID,
    V01_ID, V02_ID, V03_ID, V04_ID, V05_ID, V07_ID, V08_ID, V09_ID, V10_ID,
};
pub use b3::{
    M01_ID, M02_ID, M04_ID, M05_ID, M08_ID, M09_ID, M10_ID, M19_ID, M20_ID, M21_ID, M24_ID,
    M25_ID, M26_ID,
};
pub use b4::D01_ID;

pub const PLANNED_INDICATOR_COUNT: usize = 105;

/// 兼容常量：主均线（SMA）与 MACD。旧代码可继续引用，但注册表 id 已是 PRD 编号。
pub const MA_ID: &str = "T01";
pub const MACD_ID: &str = "M06";

pub const T01_ID: &str = "T01";
pub const T02_ID: &str = "T02";
pub const T03_ID: &str = "T03";
pub const T04_ID: &str = "T04";
pub const T05_ID: &str = "T05";
pub const T19_ID: &str = "T19";
pub const T20_ID: &str = "T20";
pub const T21_ID: &str = "T21";
pub const T22_ID: &str = "T22";
pub const E13_ID: &str = "E13";

pub fn all() -> &'static [&'static dyn Indicator] {
    &ALL
}

pub fn implemented_count() -> usize {
    ALL.len()
}

/// 先按注册表 id 精确查；未命中再用 manifest alias 解析（`ma`→`T01`、`macd`→`M06`）。
pub fn lookup(id: &str) -> Option<&'static dyn Indicator> {
    if let Some(found) = ALL.iter().copied().find(|item| item.meta().id == id) {
        return Some(found);
    }
    let resolved = crate::manifest::entry(id)?;
    ALL.iter().copied().find(|item| item.meta().id == resolved.id)
}

static T01: Ma = Ma {
    id: T01_ID,
    kind: MaKind::Sma,
};
static T02: Ma = Ma {
    id: T02_ID,
    kind: MaKind::Ema,
};
static T03: Ma = Ma {
    id: T03_ID,
    kind: MaKind::Wma,
};
static T04: Dema = Dema;
static T05: Tema = Tema;
static T19: LinRegIndicator = LinRegIndicator {
    id: T19_ID,
    kind: LinRegKind::Forecast,
};
static T20: LinRegIndicator = LinRegIndicator {
    id: T20_ID,
    kind: LinRegKind::Intercept,
};
static T21: LinRegIndicator = LinRegIndicator {
    id: T21_ID,
    kind: LinRegKind::R2,
};
static T22: LinRegIndicator = LinRegIndicator {
    id: T22_ID,
    kind: LinRegKind::Slope,
};
static E13: Bias = Bias;
static M06: Macd = Macd;

static ALL: [&dyn Indicator; 45] = [
    &T01, &T02, &T03, &T04, &T05, &T19, &T20, &T21, &T22, &E13, &M06,
    &b2::T08, &b2::T09, &b2::T10, &b2::T11, &b2::T12, &b2::T13, &b2::T14, &b2::T15,
    &b2::T16, &b2::T23, &b2::T24,
    &b2::V01, &b2::V02, &b2::V03, &b2::V04, &b2::V05, &b2::V07, &b2::V08, &b2::V09, &b2::V10,
    &b3::M01, &b3::M02, &b3::M04, &b3::M05, &b3::M08, &b3::M09, &b3::M10, &b3::M19,
    &b3::M20, &b3::M21, &b3::M24, &b3::M25, &b3::M26,
    &b4::Obv,
];

#[derive(Debug, Clone, Copy)]
enum MaKind {
    Sma,
    Ema,
    Wma,
}

pub struct Ma {
    id: &'static str,
    kind: MaKind,
}

impl Indicator for Ma {
    fn meta(&self) -> &'static Meta {
        let warmup: fn(&Params) -> usize = match self.kind {
            MaKind::Ema => ema_warmup,
            _ => ma_warmup,
        };
        crate::manifest::meta_for(self.id, warmup)
    }

    fn calc(
        &self,
        view: &OhlcvView<'_>,
        params: &Params,
        out: &mut [Vec<f64>],
    ) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, self.id)?;
        let period = period_of(params, 20);
        out[0].fill(f64::NAN);
        if view.len() < period {
            return Ok(());
        }
        out[0] = match self.kind {
            MaKind::Sma => sma(view.close, period),
            MaKind::Ema => ema(view.close, period),
            MaKind::Wma => wma(view.close, period),
        };
        Ok(())
    }
}

pub struct Dema;

impl Indicator for Dema {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(T04_ID, dema_warmup)
    }

    fn calc(
        &self,
        view: &OhlcvView<'_>,
        params: &Params,
        out: &mut [Vec<f64>],
    ) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, T04_ID)?;
        let period = period_of(params, 20);
        out[0].fill(f64::NAN);
        if view.len() < period * 2 - 1 {
            return Ok(());
        }
        let first = ema(view.close, period);
        let second = ema_of_valid(&first, period);
        for i in 0..view.len() {
            if first[i].is_finite() && second[i].is_finite() {
                out[0][i] = 2.0 * first[i] - second[i];
            }
        }
        Ok(())
    }
}

pub struct Tema;

impl Indicator for Tema {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(T05_ID, tema_warmup)
    }

    fn calc(
        &self,
        view: &OhlcvView<'_>,
        params: &Params,
        out: &mut [Vec<f64>],
    ) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, T05_ID)?;
        let period = period_of(params, 20);
        out[0].fill(f64::NAN);
        if view.len() < period * 3 - 2 {
            return Ok(());
        }
        let first = ema(view.close, period);
        let second = ema_of_valid(&first, period);
        let third = ema_of_valid(&second, period);
        for i in 0..view.len() {
            if first[i].is_finite() && second[i].is_finite() && third[i].is_finite() {
                out[0][i] = 3.0 * first[i] - 3.0 * second[i] + third[i];
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy)]
enum LinRegKind {
    Forecast,
    Intercept,
    R2,
    Slope,
}

pub struct LinRegIndicator {
    id: &'static str,
    kind: LinRegKind,
}

impl Indicator for LinRegIndicator {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(self.id, linreg_warmup)
    }

    fn calc(
        &self,
        view: &OhlcvView<'_>,
        params: &Params,
        out: &mut [Vec<f64>],
    ) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, self.id)?;
        let period = period_of(params, 20);
        out[0].fill(f64::NAN);
        if view.len() < period {
            return Ok(());
        }
        let series = linreg(view.close, period);
        out[0].copy_from_slice(match self.kind {
            LinRegKind::Forecast => &series.forecast,
            LinRegKind::Intercept => &series.intercept,
            LinRegKind::R2 => &series.r2,
            LinRegKind::Slope => &series.slope,
        });
        Ok(())
    }
}

pub struct Bias;

impl Indicator for Bias {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(E13_ID, bias_warmup)
    }

    fn calc(
        &self,
        view: &OhlcvView<'_>,
        params: &Params,
        out: &mut [Vec<f64>],
    ) -> Result<(), CalcError> {
        ensure_shape(view, out, 3, E13_ID)?;
        let periods = [
            period_of_key(params, "period1", 6),
            period_of_key(params, "period2", 12),
            period_of_key(params, "period3", 24),
        ];
        for column in out.iter_mut() {
            column.fill(f64::NAN);
        }
        for (index, period) in periods.iter().enumerate() {
            if view.len() >= *period {
                out[index] = bias(view.close, *period);
            }
        }
        Ok(())
    }
}

pub struct Macd;

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
        ensure_shape(view, out, 3, MACD_ID)?;
        let fast = period_of_key(params, "fast", 12);
        let slow = period_of_key(params, "slow", 26);
        let signal = period_of_key(params, "signal", 9);
        if fast >= slow {
            return Err(CalcError::InvalidParam("fast 必须小于 slow".to_string()));
        }

        for column in out.iter_mut() {
            column.fill(f64::NAN);
        }
        if view.len() < slow {
            return Ok(());
        }

        let ema_fast = ema(view.close, fast);
        let ema_slow = ema(view.close, slow);
        let mut dif = vec![f64::NAN; view.len()];
        for i in 0..view.len() {
            if ema_fast[i].is_finite() && ema_slow[i].is_finite() {
                dif[i] = ema_fast[i] - ema_slow[i];
            }
        }

        let dea = ema_of_valid(&dif, signal);
        for i in 0..view.len() {
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

fn ensure_shape(
    view: &OhlcvView<'_>,
    out: &mut [Vec<f64>],
    expected_outputs: usize,
    id: &str,
) -> Result<(), CalcError> {
    if out.len() != expected_outputs || !view.columns_are_aligned() {
        return Err(CalcError::Internal(format!("{id} 输出/输入维度不一致")));
    }
    if out.iter().any(|column| column.len() != view.len()) {
        return Err(CalcError::Internal(format!("{id} 输出未预分配")));
    }
    Ok(())
}

fn period_of(params: &Params, fallback: usize) -> usize {
    period_of_key(params, "period", fallback as i64)
}

/// 参数范围只由 manifest 声明、由 `validate` 强制（越界返回 E_PARAM_OUT_OF_RANGE）。
/// 这里不做夹取：静默夹取会让越界值「看起来生效」（N=500 算成 200），比报错更糟。
fn period_of_key(params: &Params, key: &str, fallback: i64) -> usize {
    param_int(params, key).unwrap_or(fallback) as usize
}

fn period_warmup(params: &Params) -> usize {
    period_of(params, 20).saturating_sub(1)
}

fn ma_warmup(params: &Params) -> usize {
    period_warmup(params)
}

/// B1 口径：EMA 建议 3N 根观察期（默认 N=20 → 60 根）。
fn ema_warmup(params: &Params) -> usize {
    period_of(params, 20) * 3 - 1
}

fn dema_warmup(params: &Params) -> usize {
    period_of(params, 20) * 3 - 1
}

/// B1 口径：TEMA 建议 4.5N 根观察期（默认 N=20 → 90 根）。
fn tema_warmup(params: &Params) -> usize {
    period_of(params, 20) * 9 / 2 - 1
}

fn linreg_warmup(params: &Params) -> usize {
    period_warmup(params)
}

fn bias_warmup(params: &Params) -> usize {
    let periods = [
        period_of_key(params, "period1", 6),
        period_of_key(params, "period2", 12),
        period_of_key(params, "period3", 24),
    ];
    periods.iter().copied().min().unwrap_or(6).saturating_sub(1)
}

fn macd_warmup(params: &Params) -> usize {
    let slow = period_of_key(params, "slow", 26);
    let signal = period_of_key(params, "signal", 9);
    slow + signal - 2
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::param::merge_defaults;

    fn sample_close() -> Vec<f64> {
        (0..520)
            .map(|i| 100.0 + i as f64 * 0.05 + (i as f64 * 0.7).sin() * 2.0)
            .collect()
    }

    fn view_of(close: &[f64]) -> OhlcvView<'_> {
        OhlcvView::new(close, close, close, close, close, close)
    }

    fn params(meta: &Meta) -> Params {
        merge_defaults(meta.params, &Params::new())
    }

    fn run(id: &str, close: &[f64], outputs: usize) -> Vec<Vec<f64>> {
        let indicator = lookup(id).unwrap();
        let params = params(indicator.meta());
        let mut out = vec![vec![0.0; close.len()]; outputs];
        indicator.calc(&view_of(close), &params, &mut out).unwrap();
        out
    }

    #[test]
    fn t01_sma_matches_manual_mean() {
        let close = sample_close();
        let out = run(T01_ID, &close, 1);
        assert!(out[0][..19].iter().all(|v| v.is_nan()));
        let expected: f64 = close[..20].iter().sum::<f64>() / 20.0;
        assert!((out[0][19] - expected).abs() < 1e-9);
    }

    #[test]
    fn t02_ema_seed_is_sma() {
        let close = sample_close();
        let out = run(T02_ID, &close, 1);
        let seed: f64 = close[..20].iter().sum::<f64>() / 20.0;
        assert!((out[0][19] - seed).abs() < 1e-9);
        assert!(out[0][519].is_finite());
    }

    #[test]
    fn t03_wma_matches_manual() {
        let close = sample_close();
        let out = run(T03_ID, &close, 1);
        let mut numerator = 0.0;
        for k in 0..20 {
            numerator += (k + 1) as f64 * close[k];
        }
        assert!((out[0][19] - numerator / 210.0).abs() < 1e-9);
    }

    #[test]
    fn t04_dema_matches_two_ema_formula() {
        let close = sample_close();
        let out = run(T04_ID, &close, 1);
        let first = ema(&close, 20);
        let second = ema_of_valid(&first, 20);
        let i = 38;
        assert!((out[0][i] - (2.0 * first[i] - second[i])).abs() < 1e-9);
        assert!(out[0][..38].iter().all(|v| v.is_nan()));
    }

    #[test]
    fn t05_tema_matches_three_ema_formula() {
        let close = sample_close();
        let out = run(T05_ID, &close, 1);
        let first = ema(&close, 20);
        let second = ema_of_valid(&first, 20);
        let third = ema_of_valid(&second, 20);
        let i = 57;
        assert!((out[0][i] - (3.0 * first[i] - 3.0 * second[i] + third[i])).abs() < 1e-9);
        assert!(out[0][..57].iter().all(|v| v.is_nan()));
    }

    #[test]
    fn t19_to_t22_regression_columns_share_window() {
        let close = sample_close();
        let forecast = run(T19_ID, &close, 1);
        let intercept = run(T20_ID, &close, 1);
        let r2 = run(T21_ID, &close, 1);
        let slope = run(T22_ID, &close, 1);
        let i = 19;
        assert!((forecast[0][i] - (intercept[0][i] + slope[0][i] * 19.0)).abs() < 1e-9);
        assert!((0.0..=1.0).contains(&r2[0][i]));
    }

    #[test]
    fn e13_bias_has_three_periods() {
        let close = sample_close();
        let out = run(E13_ID, &close, 3);
        let mean6: f64 = close[..6].iter().sum::<f64>() / 6.0;
        assert!((out[0][5] - (close[5] - mean6) / mean6 * 100.0).abs() < 1e-9);
        assert!(out[1][..11].iter().all(|v| v.is_nan()));
        assert!(out[2][..23].iter().all(|v| v.is_nan()));
        assert!(out[2][23].is_finite());
    }

    #[test]
    fn macd_outputs_are_finite_after_warmup() {
        let close = sample_close();
        let meta = lookup(MACD_ID).unwrap().meta();
        let params = params(meta);
        let mut out = vec![vec![0.0; close.len()]; 3];
        lookup(MACD_ID)
            .unwrap()
            .calc(&view_of(&close), &params, &mut out)
            .unwrap();
        let warmup = (meta.warmup)(&params);
        assert!(out[0][..warmup].iter().all(|v| v.is_nan()));
        assert!(out[0][warmup].is_finite());
        let i = warmup + 2;
        assert!((out[2][i] - 2.0 * (out[0][i] - out[1][i])).abs() < 1e-9);
    }

    #[test]
    fn macd_rejects_fast_ge_slow() {
        let close = sample_close();
        let meta = lookup(MACD_ID).unwrap().meta();
        let mut params = params(meta);
        params.insert("fast".into(), crate::ParamValue::Int(30));
        params.insert("slow".into(), crate::ParamValue::Int(20));
        let mut out = vec![vec![0.0; close.len()]; 3];
        assert!(lookup(MACD_ID)
            .unwrap()
            .calc(&view_of(&close), &params, &mut out)
            .is_err());
    }

    #[test]
    fn ma_period_range_is_enforced_not_clamped() {
        // W-72：卡面 S-03.04 要求 MA period ∈ [2,500]；越界报错，不许静默夹取。
        let meta = lookup(T01_ID).unwrap().meta();
        let mut params = params(meta);
        params.insert("period".into(), crate::ParamValue::Int(500));
        assert!(crate::param::validate(meta.params, &params).is_ok());

        let close = sample_close();
        let mut out = vec![vec![0.0; close.len()]; 1];
        lookup(T01_ID)
            .unwrap()
            .calc(&view_of(&close), &params, &mut out)
            .unwrap();
        let mean: f64 = close[20..520].iter().sum::<f64>() / 500.0;
        assert!(
            (out[0][519] - mean).abs() < 1e-9,
            "N=500 必须按 500 计算，不许夹到 200"
        );
        assert!(out[0][..499].iter().all(|v| v.is_nan()));

        params.insert("period".into(), crate::ParamValue::Int(501));
        assert!(crate::param::validate(meta.params, &params).is_err(), "N=501 必须报错");
        params.insert("period".into(), crate::ParamValue::Int(1));
        assert!(crate::param::validate(meta.params, &params).is_err(), "N=1 必须报错");
    }

    #[test]
    fn registry_ids_and_aliases() {
        assert_eq!(implemented_count(), 45);
        assert_eq!(PLANNED_INDICATOR_COUNT, 105);
        for id in [
            T01_ID, T02_ID, T03_ID, T04_ID, T05_ID, T19_ID, T20_ID, T21_ID, T22_ID, E13_ID, MACD_ID,
            T08_ID, T09_ID, T10_ID, T11_ID, T12_ID, T13_ID, T14_ID, T15_ID, T16_ID, T23_ID, T24_ID,
            V01_ID, V02_ID, V03_ID, V04_ID, V05_ID, V07_ID, V08_ID, V09_ID, V10_ID,
            M01_ID, M02_ID, M04_ID, M05_ID, M08_ID, M09_ID, M10_ID, M19_ID, M20_ID, M21_ID,
            M24_ID, M25_ID, M26_ID, D01_ID,
        ] {
            assert!(lookup(id).is_some(), "缺少注册指标 {id}");
        }
        assert_eq!(lookup("ma").map(|item| item.meta().id), Some(T01_ID));
        assert_eq!(lookup("macd").map(|item| item.meta().id), Some(MACD_ID));
        assert!(lookup("not-exist").is_none());
    }

    /// 短序列边界：预热不足的指标全 NaN；预热为 0/1 的指标不 panic。
    #[test]
    fn short_series_respects_warmup_for_every_indicator() {
        let close = vec![100.0; 3];
        for indicator in all() {
            let params = params(indicator.meta());
            let warmup = (indicator.meta().warmup)(&params);
            let mut out = vec![vec![0.0; close.len()]; indicator.meta().outputs.len()];
            indicator
                .calc(&view_of(&close), &params, &mut out)
                .unwrap();
            if warmup >= close.len() {
                assert!(
                    out.iter().all(|column| column.iter().all(|v| v.is_nan())),
                    "{} 短序列应全 NaN",
                    indicator.meta().id
                );
            }
        }
    }

    /// 常数序列：均线/回归退化值应稳定，不出现 NaN（BIAS 除零除外）。
    #[test]
    fn constant_series_is_stable_except_bias() {
        let close = vec![10.0; 120];
        for id in [T01_ID, T02_ID, T03_ID, T04_ID, T05_ID, T19_ID, T20_ID, T21_ID, T22_ID] {
            let out = run(id, &close, 1);
            let last = out[0][119];
            assert!(last.is_finite(), "{id} 常数序列末根应有限");
            match id {
                T19_ID | T20_ID => assert!((last - 10.0).abs() < 1e-9, "{id} 常数序列应等于 10"),
                T21_ID => assert!((last - 1.0).abs() < 1e-9, "T21 常数序列 R² 定义为 1"),
                T22_ID => assert!(last.abs() < 1e-9, "T22 常数序列斜率应为 0"),
                _ => assert!((last - 10.0).abs() < 1e-9, "{id} 常数序列应等于 10"),
            }
        }
        let bias = run(E13_ID, &close, 3);
        assert!((bias[0][119]).abs() < 1e-12, "常数 10 的 BIAS 应为 0");
        let zeros = vec![0.0; 120];
        let zero_bias = run(E13_ID, &zeros, 3);
        assert!(
            zero_bias[0][119].is_nan(),
            "BIAS 零均值应输出 NaN 而不是 Infinity"
        );
    }
}
