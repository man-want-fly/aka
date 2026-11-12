//! B4：量类指标（W-54 起步：OBV；AKA-41 首批：A/D、CMF、Chaikin、MFI、Force、PVO）。

use crate::meta::Meta;
use crate::param::Params;
use crate::view::{CalcError, Indicator, OhlcvView};

use super::{ensure_shape, period_of_key};

pub const D01_ID: &str = "D01";
pub const D02_ID: &str = "D02";
pub const D03_ID: &str = "D03";
pub const D04_ID: &str = "D04";
pub const D05_ID: &str = "D05";
pub const D06_ID: &str = "D06";
pub const D10_ID: &str = "D10";
pub const D12_ID: &str = "D12";

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

/// 单根资金流乘数：`MFM = ((C−L) − (H−C)) / (H−L)`；`H=L` 时记 0。
///
/// 返回 `None` 表示该根数据缺失或零量，调用方应按 D-19 断线处理。
fn money_flow_multiplier(high: f64, low: f64, close: f64, volume: f64) -> Option<f64> {
    if !high.is_finite() || !low.is_finite() || !close.is_finite() || !volume.is_finite() {
        return None;
    }
    if volume <= 0.0 {
        return None;
    }
    if high > low {
        Some(((close - low) - (high - close)) / (high - low))
    } else {
        Some(0.0)
    }
}

/// A/D 累计序列：首根作基准（NaN），零量/缺失根断线但累计值保留。
fn ad_series(view: &OhlcvView<'_>) -> Vec<f64> {
    let len = view.len();
    let mut out = vec![f64::NAN; len];
    let mut acc = 0.0;
    for i in 1..len {
        let Some(mfm) = money_flow_multiplier(
            view.high[i],
            view.low[i],
            view.close[i],
            view.volume[i],
        ) else {
            continue;
        };
        acc += mfm * view.volume[i];
        out[i] = acc;
    }
    out
}

/// 窗口求和：窗口内含缺失值时整窗返回 `NaN`。
fn window_sum(values: &[f64], period: usize) -> Vec<f64> {
    let len = values.len();
    let mut out = vec![f64::NAN; len];
    if period == 0 || len < period {
        return out;
    }
    for i in (period - 1)..len {
        let window = &values[i + 1 - period..=i];
        if window.iter().any(|value| !value.is_finite()) {
            continue;
        }
        out[i] = window.iter().sum();
    }
    out
}

/// 跳过缺失值的 EMA：缺失根输出 `NaN`，但内部状态保留，恢复后继续递推。
fn ema_skip_nan(values: &[f64], period: usize) -> Vec<f64> {
    let len = values.len();
    let mut out = vec![f64::NAN; len];
    if period < 2 || len < period {
        return out;
    }
    let start = (0..=len - period)
        .find(|&i| values[i..i + period].iter().all(|value| value.is_finite()));
    let Some(start) = start else {
        return out;
    };
    let seed = values[start..start + period].iter().sum::<f64>() / period as f64;
    out[start + period - 1] = seed;
    let alpha = 2.0 / (period as f64 + 1.0);
    let mut state = seed;
    for i in (start + period)..len {
        if values[i].is_finite() {
            state = alpha * values[i] + (1.0 - alpha) * state;
            out[i] = state;
        }
    }
    out
}

/// D02 累积派发线：`A/D(t) = A/D(t−1) + MFM(t) × V(t)`。
pub struct AdLine;

impl Indicator for AdLine {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(D02_ID, ad_warmup)
    }

    fn calc(
        &self,
        view: &OhlcvView<'_>,
        _params: &Params,
        out: &mut [Vec<f64>],
    ) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, D02_ID)?;
        out[0].fill(f64::NAN);
        if view.len() < 2 {
            return Ok(());
        }
        out[0].copy_from_slice(&ad_series(view));
        Ok(())
    }
}

fn ad_warmup(_params: &Params) -> usize {
    1
}

/// D03 钱德资金流：`CMF = Σ(MFM×V, N) / Σ(V, N)`，范围 −1~+1。
pub struct Cmf;

impl Indicator for Cmf {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(D03_ID, cmf_warmup)
    }

    fn calc(
        &self,
        view: &OhlcvView<'_>,
        params: &Params,
        out: &mut [Vec<f64>],
    ) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, D03_ID)?;
        let period = period_of_key(params, "period", 20);
        out[0].fill(f64::NAN);
        if period < 2 || view.len() < period {
            return Ok(());
        }

        let len = view.len();
        let mut flow = vec![f64::NAN; len];
        let mut volume = vec![f64::NAN; len];
        for i in 0..len {
            let Some(mfm) = money_flow_multiplier(
                view.high[i],
                view.low[i],
                view.close[i],
                view.volume[i],
            ) else {
                continue;
            };
            flow[i] = mfm * view.volume[i];
            volume[i] = view.volume[i];
        }
        let flow_sum = window_sum(&flow, period);
        let volume_sum = window_sum(&volume, period);
        for i in 0..len {
            if flow_sum[i].is_finite() && volume_sum[i].is_finite() && volume_sum[i] > 0.0 {
                out[0][i] = flow_sum[i] / volume_sum[i];
            }
        }
        Ok(())
    }
}

fn cmf_warmup(params: &Params) -> usize {
    period_of_key(params, "period", 20).saturating_sub(1)
}

/// D04 蔡金振荡：`Chaikin = EMA(A/D, fast) − EMA(A/D, slow)`。
pub struct ChaikinOsc;

impl Indicator for ChaikinOsc {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(D04_ID, chaikin_warmup)
    }

    fn calc(
        &self,
        view: &OhlcvView<'_>,
        params: &Params,
        out: &mut [Vec<f64>],
    ) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, D04_ID)?;
        let fast = period_of_key(params, "fast", 3);
        let slow = period_of_key(params, "slow", 10);
        if fast >= slow {
            return Err(CalcError::ParamOrder("fast 必须小于 slow".to_string()));
        }
        out[0].fill(f64::NAN);
        if view.len() <= slow {
            return Ok(());
        }
        let ad = ad_series(view);
        let fast_ema = ema_skip_nan(&ad, fast);
        let slow_ema = ema_skip_nan(&ad, slow);
        for i in 0..view.len() {
            if fast_ema[i].is_finite() && slow_ema[i].is_finite() {
                out[0][i] = fast_ema[i] - slow_ema[i];
            }
        }
        Ok(())
    }
}

fn chaikin_warmup(params: &Params) -> usize {
    period_of_key(params, "slow", 10)
}

/// D05 资金流量：`MFI = 100 − 100/(1 + Σ正MF/Σ负MF)`，`N=14`。
///
/// 零成交量根按 PRD D-21 断线：只要窗口内含停牌/零量根，该点输出 `NaN`。
pub struct Mfi;

impl Indicator for Mfi {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(D05_ID, mfi_warmup)
    }

    fn calc(
        &self,
        view: &OhlcvView<'_>,
        params: &Params,
        out: &mut [Vec<f64>],
    ) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, D05_ID)?;
        let period = period_of_key(params, "period", 14);
        out[0].fill(f64::NAN);
        if period < 2 || view.len() <= period {
            return Ok(());
        }

        let len = view.len();
        let mut positive = vec![0.0; len];
        let mut negative = vec![0.0; len];
        let mut broken = vec![true; len];
        let mut prev_tp: Option<f64> = None;
        for i in 0..len {
            let (high, low, close, volume) =
                (view.high[i], view.low[i], view.close[i], view.volume[i]);
            if !high.is_finite() || !low.is_finite() || !close.is_finite() || !volume.is_finite()
                || volume <= 0.0
            {
                prev_tp = None;
                continue;
            }
            let typical = (high + low + close) / 3.0;
            if let Some(previous) = prev_tp {
                let flow = typical * volume;
                if typical > previous {
                    positive[i] = flow;
                } else if typical < previous {
                    negative[i] = flow;
                }
                broken[i] = false;
            }
            prev_tp = Some(typical);
        }

        let positive_sum = window_sum(&positive, period);
        let negative_sum = window_sum(&negative, period);
        for i in period..len {
            let start = i + 1 - period;
            if broken[start..=i].iter().any(|flag| *flag) {
                continue;
            }
            let (up, down) = (positive_sum[i], negative_sum[i]);
            if !up.is_finite() || !down.is_finite() {
                continue;
            }
            if up <= 0.0 && down <= 0.0 {
                continue;
            }
            out[0][i] = if down <= 0.0 {
                100.0
            } else if up <= 0.0 {
                0.0
            } else {
                100.0 - 100.0 / (1.0 + up / down)
            };
        }
        Ok(())
    }
}

fn mfi_warmup(params: &Params) -> usize {
    period_of_key(params, "period", 14)
}

/// D06 力度指数：`Force = (C − C(1)) × V`；`FI = EMA(Force, 13)`。
pub struct ForceIndex;

impl Indicator for ForceIndex {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(D06_ID, force_warmup)
    }

    fn calc(
        &self,
        view: &OhlcvView<'_>,
        params: &Params,
        out: &mut [Vec<f64>],
    ) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, D06_ID)?;
        let period = period_of_key(params, "period", 13);
        out[0].fill(f64::NAN);
        if period < 2 || view.len() <= period {
            return Ok(());
        }

        let len = view.len();
        let mut force = vec![f64::NAN; len];
        for i in 1..len {
            let (close, previous, volume) = (view.close[i], view.close[i - 1], view.volume[i]);
            if close.is_finite() && previous.is_finite() && volume.is_finite() && volume > 0.0 {
                force[i] = (close - previous) * volume;
            }
        }
        out[0].copy_from_slice(&ema_skip_nan(&force, period));
        Ok(())
    }
}

fn force_warmup(params: &Params) -> usize {
    period_of_key(params, "period", 13)
}

/// D10 量能振荡：`PVO = (EMA(V,fast) − EMA(V,slow)) / EMA(V,slow) × 100`，
/// 信号线为 `EMA(PVO, signal)`。
pub struct Pvo;

impl Indicator for Pvo {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(D10_ID, pvo_warmup)
    }

    fn calc(
        &self,
        view: &OhlcvView<'_>,
        params: &Params,
        out: &mut [Vec<f64>],
    ) -> Result<(), CalcError> {
        ensure_shape(view, out, 2, D10_ID)?;
        let fast = period_of_key(params, "fast", 12);
        let slow = period_of_key(params, "slow", 26);
        let signal = period_of_key(params, "signal", 9);
        if fast >= slow {
            return Err(CalcError::ParamOrder("fast 必须小于 slow".to_string()));
        }
        for column in out.iter_mut() {
            column.fill(f64::NAN);
        }
        if view.len() < slow + signal {
            return Ok(());
        }

        let len = view.len();
        let mut volume = vec![f64::NAN; len];
        for i in 0..len {
            if view.volume[i].is_finite() && view.volume[i] > 0.0 {
                volume[i] = view.volume[i];
            }
        }
        let fast_ema = ema_skip_nan(&volume, fast);
        let slow_ema = ema_skip_nan(&volume, slow);
        let mut pvo = vec![f64::NAN; len];
        for i in 0..len {
            if fast_ema[i].is_finite() && slow_ema[i].is_finite() && slow_ema[i] != 0.0 {
                pvo[i] = (fast_ema[i] - slow_ema[i]) / slow_ema[i] * 100.0;
            }
        }
        out[0].copy_from_slice(&pvo);
        out[1].copy_from_slice(&ema_skip_nan(&pvo, signal));
        Ok(())
    }
}

fn pvo_warmup(params: &Params) -> usize {
    let slow = period_of_key(params, "slow", 26);
    let signal = period_of_key(params, "signal", 9);
    slow + signal - 2
}

/// D12 均势指标（BOP）：`BOP = (C − O) / (H − L)`。
///
/// 口径：
/// - 单根即可计算，无预热；
/// - `H = L`（一字板）时分母为 0，记 0，不产生无穷值；
/// - 任一价格缺失时该根为 `NaN`。
pub struct Bop;

impl Indicator for Bop {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(D12_ID, bop_warmup)
    }

    fn calc(
        &self,
        view: &OhlcvView<'_>,
        _params: &Params,
        out: &mut [Vec<f64>],
    ) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, D12_ID)?;
        for i in 0..view.len() {
            let open = view.open[i];
            let high = view.high[i];
            let low = view.low[i];
            let close = view.close[i];
            if !open.is_finite() || !high.is_finite() || !low.is_finite() || !close.is_finite() {
                out[0][i] = f64::NAN;
                continue;
            }
            let range = high - low;
            out[0][i] = if range > 0.0 {
                (close - open) / range
            } else {
                0.0
            };
        }
        Ok(())
    }
}

fn bop_warmup(_params: &Params) -> usize {
    0
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

    fn run_bars(id: &str, high: &[f64], low: &[f64], close: &[f64], volume: &[f64]) -> Vec<Vec<f64>> {
        let indicator = lookup(id).unwrap();
        let params = merge_defaults(indicator.meta().params, &Params::new());
        let view = OhlcvView::new(close, high, low, close, volume, volume);
        let mut out = vec![vec![0.0; close.len()]; indicator.meta().outputs.len()];
        indicator.calc(&view, &params, &mut out).unwrap();
        out
    }

    #[test]
    fn d02_ad_line_matches_manual_accumulation() {
        let high = [10.0, 11.0, 11.0, 10.0, 10.0, 11.0];
        let low = [9.0, 9.0, 9.0, 10.0, 10.0, 9.0];
        let close = [9.5, 11.0, 9.0, 10.0, 10.0, 11.0];
        let volume = [100.0, 200.0, 300.0, 100.0, 0.0, 50.0];
        let out = run_bars(D02_ID, &high, &low, &close, &volume);
        assert!(out[0][0].is_nan(), "首根只作基准");
        assert_eq!(out[0][1], 200.0);
        assert_eq!(out[0][2], -100.0);
        assert_eq!(out[0][3], -100.0, "H=L 时 MFM 记 0");
        assert!(out[0][4].is_nan(), "零量根断线");
        assert_eq!(out[0][5], -50.0, "复牌后接续累计");
    }

    #[test]
    fn d03_cmf_matches_manual_window_ratio() {
        let high = [11.0; 4];
        let low = [9.0; 4];
        let close = [11.0, 9.0, 10.0, 11.0];
        let volume = [100.0, 300.0, 100.0, 100.0];
        let indicator = lookup(D03_ID).unwrap();
        let mut params = merge_defaults(indicator.meta().params, &Params::new());
        params.insert("period".into(), crate::param::ParamValue::Int(3));
        let view = OhlcvView::new(&close, &high, &low, &close, &volume, &volume);
        let mut out = vec![vec![0.0; close.len()]];
        indicator.calc(&view, &params, &mut out).unwrap();
        assert!(out[0][..2].iter().all(|v| v.is_nan()));
        assert!((out[0][2] + 0.4).abs() < 1e-12, "第 3 根 = -200/500");
        assert!((out[0][3] + 0.4).abs() < 1e-12, "第 4 根 = -200/500");
    }

    #[test]
    fn d04_chaikin_converges_to_ema_lag_gap() {
        // A/D 每根 +100 的线性斜坡：EMA3 与 EMA10 稳态相差 (9-2)/2 × 100 = 350。
        let len = 300;
        let high = vec![11.0; len];
        let low = vec![9.0; len];
        let close = vec![11.0; len];
        let volume = vec![100.0; len];
        let out = run_bars(D04_ID, &high, &low, &close, &volume);
        assert!(out[0][..10].iter().all(|v| v.is_nan()), "slow=10 前无输出");
        assert!((out[0][len - 1] - 350.0).abs() < 1e-6, "稳态 = 3.5 × 100");
    }

    #[test]
    fn d05_mfi_saturates_on_one_way_flow_and_breaks_on_zero_volume() {
        let rising: Vec<f64> = (1..=20).map(|i| i as f64).collect();
        let volume = vec![100.0; 20];
        let out = run_bars(D05_ID, &rising, &rising, &rising, &volume);
        assert!(out[0][..14].iter().all(|v| v.is_nan()));
        assert!((out[0][14] - 100.0).abs() < 1e-12, "单调上行时 MFI=100");

        let falling: Vec<f64> = (0..20).map(|i| 20.0 - i as f64).collect();
        let out = run_bars(D05_ID, &falling, &falling, &falling, &volume);
        assert!((out[0][14] - 0.0).abs() < 1e-12, "单调下行时 MFI=0");

        let mut holed = vec![100.0; 30];
        holed[10] = 0.0;
        let long: Vec<f64> = (1..=30).map(|i| i as f64).collect();
        let out = run_bars(D05_ID, &long, &long, &long, &holed);
        assert!(out[0][10].is_nan(), "零量根断线");
        assert!(out[0][24].is_nan(), "窗口仍含零量根时保持断线");
        assert!(out[0][25].is_finite(), "窗口滚出后恢复");
    }

    #[test]
    fn d06_force_index_ema_of_constant_increment() {
        let close: Vec<f64> = (0..40).map(|i| 100.0 + i as f64).collect();
        let high: Vec<f64> = close.iter().map(|v| v + 1.0).collect();
        let low: Vec<f64> = close.iter().map(|v| v - 1.0).collect();
        let volume = vec![100.0; 40];
        let out = run_bars(D06_ID, &high, &low, &close, &volume);
        assert!(out[0][..13].iter().all(|v| v.is_nan()));
        assert!((out[0][13] - 100.0).abs() < 1e-9);
        assert!((out[0][39] - 100.0).abs() < 1e-9);
    }

    #[test]
    fn d10_pvo_is_zero_for_constant_volume_and_has_signal() {
        let close = vec![10.0; 80];
        let volume = vec![1000.0; 80];
        let out = run_bars(D10_ID, &close, &close, &close, &volume);
        assert_eq!(out.len(), 2, "PVO 必须包含信号线");
        assert!(out[0][..25].iter().all(|v| v.is_nan()), "slow=26 前无 PVO");
        assert!(out[0][25..].iter().all(|v| v.abs() < 1e-12));
        assert!(out[1][..33].iter().all(|v| v.is_nan()), "信号线需要 9 根 PVO");
        assert!(out[1][33].is_finite());
    }

    #[test]
    fn volume_batch_meta_is_normal_and_declares_inputs() {
        for id in [D02_ID, D03_ID, D04_ID, D05_ID, D06_ID, D10_ID] {
            let indicator = lookup(id).unwrap();
            let meta = indicator.meta();
            assert_eq!(meta.id, id);
            assert!(meta.inputs.volume, "{id} 需要成交量");
            assert_eq!(crate::manifest::entry(id).unwrap().status, "normal");
        }
        assert!(lookup(D03_ID).unwrap().meta().inputs.high);
        assert!(lookup(D05_ID).unwrap().meta().inputs.high);
        assert!(lookup(D06_ID).unwrap().meta().inputs.close);
        assert!(!lookup(D10_ID).unwrap().meta().inputs.close, "PVO 只依赖成交量");
        assert_eq!(
            lookup(D10_ID).unwrap().meta().outputs.len(),
            2,
            "PVO 输出 value + signal"
        );
    }

    #[test]
    fn d12_bop_matches_manual_ratio_and_handles_flat_bar() {
        let open = [10.0, 10.0, 11.0, 10.0];
        let high = [11.0, 12.0, 11.0, 11.0];
        let low = [9.0, 8.0, 11.0, 9.0];
        let close = [11.0, 9.0, 11.0, 10.0];
        let indicator = lookup(D12_ID).unwrap();
        let params = merge_defaults(indicator.meta().params, &Params::new());
        let view = OhlcvView::new(&open, &high, &low, &close, &close, &close);
        let mut out = vec![vec![0.0; close.len()]; 1];
        indicator.calc(&view, &params, &mut out).unwrap();
        assert_eq!(out[0][0], 0.5, "收在区间上半部");
        assert_eq!(out[0][1], -0.25, "收在区间下半部");
        assert_eq!(out[0][2], 0.0, "一字板 H=L 记 0");
        assert_eq!(out[0][3], 0.0, "收在开盘价");
        assert!(indicator.meta().inputs.open, "BOP 需要开盘价");
    }
}
