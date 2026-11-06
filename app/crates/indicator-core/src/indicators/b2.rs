//! B2 通道 / 波动 / 止损批次（20 个指标）。
//!
//! 本文件是 B2 的 append-only 注册模块：不改动 B1 内核 API，只追加指标结构与
//! `warmup` 纯函数。所有公式细节见 `docs/indicators/b2-channel-volatility.md`。
//!
//! 口径标记：
//! - `beta`：T13（状态机的翻空/翻多阈值）、T15（位移的 NaN 对齐）、T16（PSAR 初始化）、
//!   T23（日/周由图表周期决定，不设参数）、T24（规划标「完整▲」）、V08（GAPO 跳空口径）。

use crate::kernels::{
    ema, rolling_max, rolling_min, rolling_std, sma, true_range, wilder_of_valid,
};
use crate::meta::Meta;
use crate::param::ParamValue;
use crate::view::{CalcError, Indicator, OhlcvView};
use crate::Params;

use super::{ensure_shape, period_of, period_of_key};

pub const T08_ID: &str = "T08";
pub const T09_ID: &str = "T09";
pub const T10_ID: &str = "T10";
pub const T11_ID: &str = "T11";
pub const T12_ID: &str = "T12";
pub const T13_ID: &str = "T13";
pub const T14_ID: &str = "T14";
pub const T15_ID: &str = "T15";
pub const T16_ID: &str = "T16";
pub const T23_ID: &str = "T23";
pub const T24_ID: &str = "T24";
pub const V01_ID: &str = "V01";
pub const V02_ID: &str = "V02";
pub const V03_ID: &str = "V03";
pub const V04_ID: &str = "V04";
pub const V05_ID: &str = "V05";
pub const V07_ID: &str = "V07";
pub const V08_ID: &str = "V08";
pub const V09_ID: &str = "V09";
pub const V10_ID: &str = "V10";

pub static T08: Envelopes = Envelopes;
pub static T09: Boll = Boll;
pub static T10: Keltner = Keltner;
pub static T11: Donchian = Donchian;
pub static T12: AtrBands = AtrBands;
pub static T13: AtrTrail = AtrTrail;
pub static T14: Chandelier = Chandelier;
pub static T15: Ichimoku = Ichimoku;
pub static T16: Psar = Psar;
pub static T23: Pivot = Pivot;
pub static T24: HhvLlv = HhvLlv;
pub static V01: Atr = Atr;
pub static V02: Atrp = Atrp;
pub static V03: StdDev = StdDev;
pub static V04: BbWidth = BbWidth;
pub static V05: PercentB = PercentB;
pub static V07: Ulcer = Ulcer;
pub static V08: Gapo = Gapo;
pub static V09: Amplitude = Amplitude;
pub static V10: TrueRangeIndicator = TrueRangeIndicator;

fn percent_of(params: &Params, key: &str, fallback: f64) -> f64 {
    params
        .get(key)
        .and_then(ParamValue::as_f64)
        .unwrap_or(fallback)
}

fn atr_series(view: &OhlcvView<'_>, period: usize) -> Vec<f64> {
    let tr = true_range(view.high, view.low, view.close);
    wilder_of_valid(&tr, period)
}

/// T08 均线包络：中轨 SMA，上下轨按百分比对称外扩。
pub struct Envelopes;

impl Indicator for Envelopes {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(T08_ID, warmup_period_minus_one)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 3, T08_ID)?;
        for column in out.iter_mut() {
            column.fill(f64::NAN);
        }
        let period = period_of(params, 20);
        let pct = percent_of(params, "pct", 2.5);
        if view.len() < period {
            return Ok(());
        }
        let middle = sma(view.close, period);
        for i in 0..view.len() {
            if middle[i].is_finite() {
                out[0][i] = middle[i] * (1.0 + pct / 100.0);
                out[1][i] = middle[i];
                out[2][i] = middle[i] * (1.0 - pct / 100.0);
            }
        }
        Ok(())
    }
}

/// T09 布林带：SMA 中轨 + 样本标准差。
pub struct Boll;

impl Indicator for Boll {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(T09_ID, warmup_period_minus_one)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 3, T09_ID)?;
        for column in out.iter_mut() {
            column.fill(f64::NAN);
        }
        let period = period_of(params, 20);
        let mult = percent_of(params, "mult", 2.0);
        if view.len() < period {
            return Ok(());
        }
        let middle = sma(view.close, period);
        let std = rolling_std(view.close, period);
        for i in 0..view.len() {
            if middle[i].is_finite() && std[i].is_finite() {
                out[0][i] = middle[i] + mult * std[i];
                out[1][i] = middle[i];
                out[2][i] = middle[i] - mult * std[i];
            }
        }
        Ok(())
    }
}

/// T10 肯特纳通道：EMA 中轨 + ATR 倍数。
pub struct Keltner;

impl Indicator for Keltner {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(T10_ID, warmup_period)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 3, T10_ID)?;
        for column in out.iter_mut() {
            column.fill(f64::NAN);
        }
        let period = period_of(params, 20);
        let mult = percent_of(params, "mult", 2.0);
        if view.len() < period {
            return Ok(());
        }
        let middle = ema(view.close, period);
        let atr = atr_series(view, period);
        for i in 0..view.len() {
            if middle[i].is_finite() && atr[i].is_finite() {
                out[0][i] = middle[i] + mult * atr[i];
                out[1][i] = middle[i];
                out[2][i] = middle[i] - mult * atr[i];
            }
        }
        Ok(())
    }
}

/// T11 唐奇安通道：N 根最高价 / 最低价。
pub struct Donchian;

impl Indicator for Donchian {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(T11_ID, warmup_period_minus_one)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 2, T11_ID)?;
        let period = period_of(params, 20);
        out[0] = rolling_max(view.high, period);
        out[1] = rolling_min(view.low, period);
        Ok(())
    }
}

/// T12 ATR 通道：SMA 中轨 + ATR 倍数。
pub struct AtrBands;

impl Indicator for AtrBands {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(T12_ID, warmup_period)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 3, T12_ID)?;
        for column in out.iter_mut() {
            column.fill(f64::NAN);
        }
        let period = period_of(params, 20);
        let mult = percent_of(params, "mult", 2.0);
        if view.len() < period {
            return Ok(());
        }
        let middle = sma(view.close, period);
        let atr = atr_series(view, period);
        for i in 0..view.len() {
            if middle[i].is_finite() && atr[i].is_finite() {
                out[0][i] = middle[i] + mult * atr[i];
                out[1][i] = middle[i];
                out[2][i] = middle[i] - mult * atr[i];
            }
        }
        Ok(())
    }
}

/// T13 ATR 移动止损：多空状态机，未激活一侧输出 `NaN`。
///
/// 状态定义（beta）：首根有效 ATR 处按 `close >= prev_close` 定为多头，止损 =
/// `close - k*ATR`；收盘跌破前值止损时翻空并把空头止损设为 `close + k*ATR`；
/// 反之翻多。已冻结的一侧沿用旧值，避免线条跳变。
pub struct AtrTrail;

impl Indicator for AtrTrail {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(T13_ID, warmup_period)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 2, T13_ID)?;
        for column in out.iter_mut() {
            column.fill(f64::NAN);
        }
        let period = period_of(params, 14);
        let k = percent_of(params, "mult", 3.5);
        let atr = atr_series(view, period);
        let start = atr.iter().position(|value| value.is_finite());
        let Some(start) = start else {
            return Ok(());
        };
        let mut long_state = view.close[start] >= view.close[start.saturating_sub(1)];
        let mut long_stop = view.close[start] - k * atr[start];
        let mut short_stop = view.close[start] + k * atr[start];
        if long_state {
            out[0][start] = long_stop;
        } else {
            out[1][start] = short_stop;
        }
        for i in (start + 1)..view.len() {
            if !atr[i].is_finite() {
                continue;
            }
            if long_state {
                let candidate = (view.close[i] - k * atr[i]).max(long_stop);
                if view.close[i] < long_stop {
                    long_state = false;
                    short_stop = view.close[i] + k * atr[i];
                    out[0][i] = long_stop;
                    out[1][i] = short_stop;
                } else {
                    long_stop = candidate;
                    out[0][i] = long_stop;
                }
            } else {
                let candidate = (view.close[i] + k * atr[i]).min(short_stop);
                if view.close[i] > short_stop {
                    long_state = true;
                    long_stop = view.close[i] - k * atr[i];
                    out[0][i] = long_stop;
                    out[1][i] = short_stop;
                } else {
                    short_stop = candidate;
                    out[1][i] = short_stop;
                }
            }
        }
        Ok(())
    }
}

/// T14 吊灯止损：滚动最高价 - k*ATR / 滚动最低价 + k*ATR。
pub struct Chandelier;

impl Indicator for Chandelier {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(T14_ID, warmup_period)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 2, T14_ID)?;
        for column in out.iter_mut() {
            column.fill(f64::NAN);
        }
        let period = period_of(params, 22);
        let mult = percent_of(params, "mult", 3.0);
        if view.len() < period {
            return Ok(());
        }
        let atr = atr_series(view, period);
        let highest = rolling_max(view.high, period);
        let lowest = rolling_min(view.low, period);
        for i in 0..view.len() {
            if atr[i].is_finite() && highest[i].is_finite() && lowest[i].is_finite() {
                out[0][i] = highest[i] - mult * atr[i];
                out[1][i] = lowest[i] + mult * atr[i];
            }
        }
        Ok(())
    }
}

/// T15 一目均衡：五线 + 位移 26；未来段一律 `NaN`。
pub struct Ichimoku;

impl Indicator for Ichimoku {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(T15_ID, warmup_ichimoku)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 5, T15_ID)?;
        for column in out.iter_mut() {
            column.fill(f64::NAN);
        }
        let tenkan_period = period_of_key(params, "tenkan", 9);
        let kijun_period = period_of_key(params, "kijun", 26);
        let senkou_period = period_of_key(params, "senkou", 52);
        let displacement = period_of_key(params, "displacement", 26);
        let len = view.len();
        let tenkan = midline(view, tenkan_period);
        let kijun = midline(view, kijun_period);
        let senkou_b_base = midline(view, senkou_period);

        for i in 0..len {
            if tenkan[i].is_finite() {
                out[0][i] = tenkan[i];
            }
            if kijun[i].is_finite() {
                out[1][i] = kijun[i];
            }
        }
        for i in 0..len {
            let target = i + displacement;
            if target < len {
                if tenkan[i].is_finite() && kijun[i].is_finite() {
                    out[2][target] = (tenkan[i] + kijun[i]) / 2.0;
                }
                if senkou_b_base[i].is_finite() {
                    out[3][target] = senkou_b_base[i];
                }
            }
        }
        for j in 0..len.saturating_sub(displacement) {
            let source = j + displacement;
            if view.close[source].is_finite() {
                out[4][j] = view.close[source];
            }
        }
        Ok(())
    }
}

fn warmup_ichimoku(params: &Params) -> usize {
    let senkou = period_of_key(params, "senkou", 52);
    let displacement = period_of_key(params, "displacement", 26);
    senkou.saturating_sub(1) + displacement
}

fn midline(view: &OhlcvView<'_>, period: usize) -> Vec<f64> {
    let high = rolling_max(view.high, period);
    let low = rolling_min(view.low, period);
    let mut out = vec![f64::NAN; view.len()];
    for i in 0..view.len() {
        if high[i].is_finite() && low[i].is_finite() {
            out[i] = (high[i] + low[i]) / 2.0;
        }
    }
    out
}

/// T16 抛物线转向（Wilder PSAR）。beta：初始方向与首根 SAR 取上一根极值。
pub struct Psar;

impl Indicator for Psar {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(T16_ID, warmup_one)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, T16_ID)?;
        out[0].fill(f64::NAN);
        let len = view.len();
        if len < 2 {
            return Ok(());
        }
        let step = percent_of(params, "step", 0.02);
        let increment = percent_of(params, "increment", 0.02);
        let max_af = percent_of(params, "max", 0.2);
        if !step.is_finite() || !increment.is_finite() || !max_af.is_finite() {
            return Err(CalcError::InvalidParam("PSAR 参数必须为有限数".to_string()));
        }

        let mut up = view.close[1] >= view.close[0];
        let mut sar = if up { view.low[0] } else { view.high[0] };
        let mut extreme = if up { view.high[1] } else { view.low[1] };
        let mut af = step;
        out[0][1] = sar;
        for i in 2..len {
            let mut next = sar + af * (extreme - sar);
            if up {
                next = next.min(view.low[i - 1]).min(view.low[i - 2]);
                if view.low[i] < next {
                    up = false;
                    next = extreme;
                    extreme = view.low[i];
                    af = step;
                } else if view.high[i] > extreme {
                    extreme = view.high[i];
                    af = (af + increment).min(max_af);
                }
            } else {
                next = next.max(view.high[i - 1]).max(view.high[i - 2]);
                if view.high[i] > next {
                    up = true;
                    next = extreme;
                    extreme = view.high[i];
                    af = step;
                } else if view.low[i] < extreme {
                    extreme = view.low[i];
                    af = (af + increment).min(max_af);
                }
            }
            sar = next;
            out[0][i] = sar;
        }
        Ok(())
    }
}

/// T23 轴心点：由上一根 H/L/C 推导 P / R1 / S1。
///
/// beta：日/周口径由图表周期（D/W）决定，指标本身不设 `basis` 参数；
/// 周线图上即得到周轴心点。
pub struct Pivot;

impl Indicator for Pivot {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(T23_ID, warmup_one)
    }

    fn calc(&self, view: &OhlcvView<'_>, _params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 3, T23_ID)?;
        for column in out.iter_mut() {
            column.fill(f64::NAN);
        }
        for i in 1..view.len() {
            let high = view.high[i - 1];
            let low = view.low[i - 1];
            let close = view.close[i - 1];
            if high.is_finite() && low.is_finite() && close.is_finite() {
                let pivot = (high + low + close) / 3.0;
                out[0][i] = pivot;
                out[1][i] = 2.0 * pivot - low;
                out[2][i] = 2.0 * pivot - high;
            }
        }
        Ok(())
    }
}

/// T24 最高最低（HHV/LLV）：滑窗最值，原始值直取。
pub struct HhvLlv;

impl Indicator for HhvLlv {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(T24_ID, warmup_period_minus_one)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 2, T24_ID)?;
        let period = period_of(params, 20);
        out[0] = rolling_max(view.high, period);
        out[1] = rolling_min(view.low, period);
        Ok(())
    }
}

/// V01 ATR：Wilder 平滑真实波幅。
pub struct Atr;

impl Indicator for Atr {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(V01_ID, warmup_period)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, V01_ID)?;
        let period = period_of(params, 14);
        out[0] = atr_series(view, period);
        Ok(())
    }
}

/// V02 归一化 ATR：ATR / 收盘（无量纲比值）。
pub struct Atrp;

impl Indicator for Atrp {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(V02_ID, warmup_period)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, V02_ID)?;
        out[0].fill(f64::NAN);
        let period = period_of(params, 14);
        let atr = atr_series(view, period);
        for i in 0..view.len() {
            if atr[i].is_finite() && view.close[i].is_finite() && view.close[i] != 0.0 {
                out[0][i] = atr[i] / view.close[i];
            }
        }
        Ok(())
    }
}

/// V03 样本标准差（ddof=1）。
pub struct StdDev;

impl Indicator for StdDev {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(V03_ID, warmup_period_minus_one)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, V03_ID)?;
        let period = period_of(params, 20);
        out[0] = rolling_std(view.close, period);
        Ok(())
    }
}

/// V04 布林带宽：(上轨 - 下轨) / 中轨；中轨为 0 时 `NaN`。
pub struct BbWidth;

impl Indicator for BbWidth {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(V04_ID, warmup_period_minus_one)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, V04_ID)?;
        out[0].fill(f64::NAN);
        let period = period_of(params, 20);
        let mult = percent_of(params, "mult", 2.0);
        if view.len() < period {
            return Ok(());
        }
        let middle = sma(view.close, period);
        let std = rolling_std(view.close, period);
        for i in 0..view.len() {
            if middle[i].is_finite() && std[i].is_finite() && middle[i] != 0.0 {
                out[0][i] = (2.0 * mult * std[i]) / middle[i];
            }
        }
        Ok(())
    }
}

/// V05 布林 %B：(收盘 - 下轨) / (上轨 - 下轨)；零带宽输出 `NaN`。
pub struct PercentB;

impl Indicator for PercentB {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(V05_ID, warmup_period_minus_one)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, V05_ID)?;
        out[0].fill(f64::NAN);
        let period = period_of(params, 20);
        let mult = percent_of(params, "mult", 2.0);
        if view.len() < period {
            return Ok(());
        }
        let middle = sma(view.close, period);
        let std = rolling_std(view.close, period);
        for i in 0..view.len() {
            if middle[i].is_finite() && std[i].is_finite() {
                let width = 2.0 * mult * std[i];
                if width != 0.0 {
                    out[0][i] = (view.close[i] - (middle[i] - mult * std[i])) / width;
                }
            }
        }
        Ok(())
    }
}

/// V07 溃疡指数：N 窗口内回撤百分比平方均值的平方根。
pub struct Ulcer;

impl Indicator for Ulcer {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(V07_ID, warmup_period_minus_one)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, V07_ID)?;
        out[0].fill(f64::NAN);
        let period = period_of(params, 14);
        if view.len() < period {
            return Ok(());
        }
        for i in (period - 1)..view.len() {
            let window = &view.close[i + 1 - period..=i];
            if window.iter().any(|value| !value.is_finite()) {
                continue;
            }
            let peak = window.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            if peak <= 0.0 {
                continue;
            }
            let sum: f64 = window
                .iter()
                .map(|value| ((value - peak) / peak * 100.0).powi(2))
                .sum();
            out[0][i] = (sum / period as f64).sqrt();
        }
        Ok(())
    }
}

/// V08 GAPO：跳空相对 ATR 的百分比。
///
/// beta：规划仅写「跳空持续口径」，本实现取 `(open - prev_close) / ATR * 100`。
pub struct Gapo;

impl Indicator for Gapo {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(V08_ID, warmup_period)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, V08_ID)?;
        out[0].fill(f64::NAN);
        let period = period_of(params, 20);
        let atr = atr_series(view, period);
        for i in 1..view.len() {
            let previous = view.close[i - 1];
            if atr[i].is_finite() && atr[i] != 0.0 && previous.is_finite() && view.open[i].is_finite() {
                out[0][i] = (view.open[i] - previous) / atr[i] * 100.0;
            }
        }
        Ok(())
    }
}

/// V09 振幅：单根 `High - Low`（元）。
pub struct Amplitude;

impl Indicator for Amplitude {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(V09_ID, warmup_zero)
    }

    fn calc(&self, view: &OhlcvView<'_>, _params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, V09_ID)?;
        for i in 0..view.len() {
            out[0][i] = if view.high[i].is_finite() && view.low[i].is_finite() {
                view.high[i] - view.low[i]
            } else {
                f64::NAN
            };
        }
        Ok(())
    }
}

/// V10 真实波幅：单根 TR，首根 `NaN`。
pub struct TrueRangeIndicator;

impl Indicator for TrueRangeIndicator {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(V10_ID, warmup_one)
    }

    fn calc(&self, view: &OhlcvView<'_>, _params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, V10_ID)?;
        out[0] = true_range(view.high, view.low, view.close);
        Ok(())
    }
}

fn warmup_zero(_params: &Params) -> usize {
    0
}

fn warmup_one(_params: &Params) -> usize {
    1
}

fn warmup_period(params: &Params) -> usize {
    period_of(params, 20)
}

fn warmup_period_minus_one(params: &Params) -> usize {
    period_of(params, 20).saturating_sub(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indicators::{lookup, all};
    use crate::param::merge_defaults;

    fn sample_view(len: usize) -> (Vec<f64>, Vec<f64>, Vec<f64>, Vec<f64>) {
        let close: Vec<f64> = (0..len)
            .map(|i| 100.0 + i as f64 * 0.05 + (i as f64 * 0.7).sin() * 2.0)
            .collect();
        let high: Vec<f64> = close.iter().map(|c| c + 0.6).collect();
        let low: Vec<f64> = close.iter().map(|c| c - 0.5).collect();
        let open: Vec<f64> = close.iter().map(|c| c - 0.1).collect();
        (open, high, low, close)
    }

    fn run(id: &str, len: usize) -> Vec<Vec<f64>> {
        let (open, high, low, close) = sample_view(len);
        let volume = vec![1.0; len];
        let amount = vec![1.0; len];
        let view = OhlcvView::new(&open, &high, &low, &close, &volume, &amount);
        let indicator = lookup(id).unwrap();
        let params = merge_defaults(indicator.meta().params, &Params::new());
        let mut out = vec![vec![0.0; len]; indicator.meta().outputs.len()];
        indicator.calc(&view, &params, &mut out).unwrap();
        out
    }

    #[test]
    fn v10_first_bar_is_nan_and_later_finite() {
        let out = run(V10_ID, 40);
        assert!(out[0][0].is_nan());
        assert!(out[0][1].is_finite());
    }

    #[test]
    fn v01_atr_is_wilder_mean_of_true_range() {
        let len = 60;
        let (open, high, low, close) = sample_view(len);
        let volume = vec![1.0; len];
        let amount = vec![1.0; len];
        let view = OhlcvView::new(&open, &high, &low, &close, &volume, &amount);
        let tr = true_range(&high, &low, &close);
        let expected = wilder_of_valid(&tr, 14);
        let out = run(V01_ID, len);
        for i in 14..len {
            assert!(out[0][i].is_finite());
        }
        assert!((out[0][14] - expected[14]).abs() < 1e-12);
    }

    #[test]
    fn t24_is_exact_window_extreme() {
        let len = 40;
        let (_, high, low, _) = sample_view(len);
        let out = run(T24_ID, len);
        let i = 25;
        let max = high[i - 19..=i].iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let min = low[i - 19..=i].iter().copied().fold(f64::INFINITY, f64::min);
        assert!((out[0][i] - max).abs() < 1e-12);
        assert!((out[1][i] - min).abs() < 1e-12);
    }

    #[test]
    fn v03_sample_stddev_excludes_denominator_n() {
        let values = vec![1.0, 2.0, 3.0, 4.0];
        let out = rolling_std(&values, 4);
        assert!((out[3] - 1.2909944487358056).abs() < 1e-12);
    }

    #[test]
    fn v02_atrp_is_atr_over_close() {
        let len = 40;
        let (open, high, low, close) = sample_view(len);
        let volume = vec![1.0; len];
        let amount = vec![1.0; len];
        let view = OhlcvView::new(&open, &high, &low, &close, &volume, &amount);
        let atr = atr_series(&view, 14);
        let out = run(V02_ID, len);
        let i = 20;
        assert!((out[0][i] - atr[i] / close[i]).abs() < 1e-12);
    }

    #[test]
    fn every_b2_indicator_has_nan_prefix_and_no_panic_on_short_series() {
        for indicator in all() {
            if !indicator.meta().id.starts_with('T') && !indicator.meta().id.starts_with('V') {
                continue;
            }
            let params = merge_defaults(indicator.meta().params, &Params::new());
            let warmup = (indicator.meta().warmup)(&params);
            let len = 3;
            let close = vec![100.0; len];
            let view = OhlcvView::new(&close, &close, &close, &close, &close, &close);
            let mut out = vec![vec![0.0; len]; indicator.meta().outputs.len()];
            indicator.calc(&view, &params, &mut out).unwrap();
            if warmup >= len {
                assert!(out.iter().all(|column| column.iter().all(|v| v.is_nan())));
            }
        }
    }
}
