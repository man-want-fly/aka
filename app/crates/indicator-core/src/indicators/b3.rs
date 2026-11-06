//! B3 动量 / 摆动批次（14 个指标，其中 M06 MACD 已在 B1 实现）。
//!
//! 本文件是 B3 的 append-only 注册模块：不动 B1 内核 API，只追加 13 个新指标
//! 与 `warmup` 纯函数。公式与边界见 `docs/indicators/b3-momentum-oscillators.md`。
//!
//! 口径标记：M02（KDJ 种子/平滑）、M24（预热与 CSV 声明不一致）、M25（Elder 三色规则）
//! 标 `partial`/beta，不自行拍定；M06 沿用 B1 的 beta 状态。

use crate::kernels::{
    ema, ema_of_valid, rolling_max, rolling_min, sma, true_range, wilder_of_valid,
};
use crate::meta::Meta;
use crate::view::{CalcError, Indicator, OhlcvView};
use crate::Params;

use super::{ensure_shape, period_of, period_of_key};

pub const M01_ID: &str = "M01";
pub const M02_ID: &str = "M02";
pub const M04_ID: &str = "M04";
pub const M05_ID: &str = "M05";
pub const M08_ID: &str = "M08";
pub const M09_ID: &str = "M09";
pub const M10_ID: &str = "M10";
pub const M19_ID: &str = "M19";
pub const M20_ID: &str = "M20";
pub const M21_ID: &str = "M21";
pub const M24_ID: &str = "M24";
pub const M25_ID: &str = "M25";
pub const M26_ID: &str = "M26";

pub static M01: Rsi = Rsi;

fn rsi_warmup(params: &Params) -> usize {
    period_of(params, 14)
}

fn roc_warmup(params: &Params) -> usize {
    period_of(params, 12)
}

fn momentum_warmup(params: &Params) -> usize {
    period_of(params, 10)
}

fn vortex_warmup(params: &Params) -> usize {
    period_of(params, 14)
}

fn cmo_warmup(params: &Params) -> usize {
    period_of(params, 14)
}

pub static M02: Kdj = Kdj;
pub static M04: WilliamsR = WilliamsR;
pub static M05: Cci = Cci;
pub static M08: Ppo = Ppo;
pub static M09: Roc = Roc;
pub static M10: Momentum = Momentum;
pub static M19: Aroon = Aroon;
pub static M20: Vortex = Vortex;
pub static M21: Cmo = Cmo;
pub static M24: MassIndex = MassIndex;
pub static M25: ElderImpulse = ElderImpulse;
pub static M26: Nr7 = Nr7;

/// 滚动求和，但跳过含 `NaN` 的窗口（与内核 `rolling_sum` 的「遇 NaN 永久污染」不同）。
fn window_sum(values: &[f64], period: usize) -> Vec<f64> {
    let len = values.len();
    let mut out = vec![f64::NAN; len];
    if period < 1 || len < period {
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

/// 窗口内最近一次极值的下标；`latest` 为 true 取最大，否则取最小。
fn arg_extreme(values: &[f64], period: usize, latest: bool) -> Vec<Option<usize>> {
    let len = values.len();
    let mut out = vec![None; len];
    if period < 1 || len < period {
        return out;
    }
    for i in (period - 1)..len {
        let start = i + 1 - period;
        let window = &values[start..=i];
        if window.iter().any(|value| !value.is_finite()) {
            continue;
        }
        let mut best = 0usize;
        for (offset, value) in window.iter().enumerate() {
            let better = if latest {
                *value >= window[best]
            } else {
                *value <= window[best]
            };
            if better {
                best = offset;
            }
        }
        out[i] = Some(start + best);
    }
    out
}

fn macd_columns(view: &OhlcvView<'_>, fast: usize, slow: usize, signal: usize) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let ema_fast = ema(view.close, fast);
    let ema_slow = ema(view.close, slow);
    let mut dif = vec![f64::NAN; view.len()];
    for i in 0..view.len() {
        if ema_fast[i].is_finite() && ema_slow[i].is_finite() {
            dif[i] = ema_fast[i] - ema_slow[i];
        }
    }
    let dea = ema_of_valid(&dif, signal);
    let mut hist = vec![f64::NAN; view.len()];
    for i in 0..view.len() {
        if dif[i].is_finite() && dea[i].is_finite() {
            hist[i] = 2.0 * (dif[i] - dea[i]);
        }
    }
    (dif, dea, hist)
}

/// M01 RSI：Wilder 平滑的涨幅/跌幅，`RSI = 100 - 100/(1+RS)`。
pub struct Rsi;

impl Indicator for Rsi {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(M01_ID, rsi_warmup)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, M01_ID)?;
        out[0].fill(f64::NAN);
        let period = period_of(params, 14);
        if view.len() <= period {
            return Ok(());
        }
        let mut gain = vec![f64::NAN; view.len()];
        let mut loss = vec![f64::NAN; view.len()];
        for i in 1..view.len() {
            if view.close[i].is_finite() && view.close[i - 1].is_finite() {
                let delta = view.close[i] - view.close[i - 1];
                gain[i] = delta.max(0.0);
                loss[i] = (-delta).max(0.0);
            }
        }
        let avg_gain = wilder_of_valid(&gain, period);
        let avg_loss = wilder_of_valid(&loss, period);
        for i in 0..view.len() {
            if !avg_gain[i].is_finite() || !avg_loss[i].is_finite() {
                continue;
            }
            out[0][i] = if avg_loss[i] == 0.0 {
                100.0
            } else if avg_gain[i] == 0.0 {
                0.0
            } else {
                100.0 - 100.0 / (1.0 + avg_gain[i] / avg_loss[i])
            };
        }
        Ok(())
    }
}

/// M02 KDJ：RSV 的递推平滑，K/D 种子 50，J = 3K - 2D。
pub struct Kdj;

impl Indicator for Kdj {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(M02_ID, kdj_warmup)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 3, M02_ID)?;
        for column in out.iter_mut() {
            column.fill(f64::NAN);
        }
        let period = period_of(params, 9);
        let k_period = period_of_key(params, "k", 3);
        let d_period = period_of_key(params, "d", 3);
        if view.len() < period {
            return Ok(());
        }
        let hhv = rolling_max(view.high, period);
        let llv = rolling_min(view.low, period);
        let mut prev_k = 50.0;
        let mut prev_d = 50.0;
        for i in 0..view.len() {
            if !hhv[i].is_finite() || !llv[i].is_finite() || !view.close[i].is_finite() {
                continue;
            }
            let range = hhv[i] - llv[i];
            let rsv = if range == 0.0 {
                50.0
            } else {
                (view.close[i] - llv[i]) / range * 100.0
            };
            let k = ((k_period - 1) as f64 * prev_k + rsv) / k_period as f64;
            let d = ((d_period - 1) as f64 * prev_d + k) / d_period as f64;
            out[0][i] = k;
            out[1][i] = d;
            out[2][i] = 3.0 * k - 2.0 * d;
            prev_k = k;
            prev_d = d;
        }
        Ok(())
    }
}

/// M04 Williams %R：`(HHV - C)/(HHV - LLV) × -100`，值域 [-100, 0]。
pub struct WilliamsR;

impl Indicator for WilliamsR {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(M04_ID, warmup_period_minus_one)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, M04_ID)?;
        out[0].fill(f64::NAN);
        let period = period_of(params, 14);
        if view.len() < period {
            return Ok(());
        }
        let hhv = rolling_max(view.high, period);
        let llv = rolling_min(view.low, period);
        for i in 0..view.len() {
            if !hhv[i].is_finite() || !llv[i].is_finite() || !view.close[i].is_finite() {
                continue;
            }
            let range = hhv[i] - llv[i];
            if range != 0.0 {
                out[0][i] = (hhv[i] - view.close[i]) / range * -100.0;
            }
        }
        Ok(())
    }
}

/// M05 CCI：典型价均值偏差口径，`(TP - SMA(TP))/(0.015 × 平均绝对偏差)`。
pub struct Cci;

impl Indicator for Cci {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(M05_ID, warmup_period_minus_one)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, M05_ID)?;
        out[0].fill(f64::NAN);
        let period = period_of(params, 20);
        if view.len() < period {
            return Ok(());
        }
        let mut typical = vec![f64::NAN; view.len()];
        for i in 0..view.len() {
            if view.high[i].is_finite() && view.low[i].is_finite() && view.close[i].is_finite() {
                typical[i] = (view.high[i] + view.low[i] + view.close[i]) / 3.0;
            }
        }
        let mean = sma(&typical, period);
        for i in (period - 1)..view.len() {
            if !mean[i].is_finite() {
                continue;
            }
            let window = &typical[i + 1 - period..=i];
            if window.iter().any(|value| !value.is_finite()) {
                continue;
            }
            let deviation = window.iter().map(|value| (value - mean[i]).abs()).sum::<f64>()
                / period as f64;
            if deviation != 0.0 {
                out[0][i] = (typical[i] - mean[i]) / (0.015 * deviation);
            }
        }
        Ok(())
    }
}

/// M08 PPO：`(EMA(fast) - EMA(slow))/EMA(slow) × 100`，信号线为 PPO 的 EMA。
pub struct Ppo;

impl Indicator for Ppo {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(M08_ID, ppo_warmup)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 2, M08_ID)?;
        for column in out.iter_mut() {
            column.fill(f64::NAN);
        }
        let fast = period_of_key(params, "fast", 12);
        let slow = period_of_key(params, "slow", 26);
        let signal = period_of_key(params, "signal", 9);
        if fast >= slow {
            return Err(CalcError::InvalidParam("fast 必须小于 slow".to_string()));
        }
        if view.len() < slow {
            return Ok(());
        }
        let ema_fast = ema(view.close, fast);
        let ema_slow = ema(view.close, slow);
        let mut ppo = vec![f64::NAN; view.len()];
        for i in 0..view.len() {
            if ema_fast[i].is_finite() && ema_slow[i].is_finite() && ema_slow[i] != 0.0 {
                ppo[i] = (ema_fast[i] - ema_slow[i]) / ema_slow[i] * 100.0;
            }
        }
        out[0].copy_from_slice(&ppo);
        out[1].copy_from_slice(&ema_of_valid(&ppo, signal));
        Ok(())
    }
}

/// M09 ROC：`(C - C[-N])/C[-N] × 100`，分母为零 NaN。
pub struct Roc;

impl Indicator for Roc {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(M09_ID, roc_warmup)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, M09_ID)?;
        out[0].fill(f64::NAN);
        let period = period_of(params, 12);
        if view.len() <= period {
            return Ok(());
        }
        for i in period..view.len() {
            let previous = view.close[i - period];
            if view.close[i].is_finite() && previous.is_finite() && previous != 0.0 {
                out[0][i] = (view.close[i] - previous) / previous * 100.0;
            }
        }
        Ok(())
    }
}

/// M10 Momentum：`C - C[-N]`，单位元。
pub struct Momentum;

impl Indicator for Momentum {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(M10_ID, momentum_warmup)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, M10_ID)?;
        out[0].fill(f64::NAN);
        let period = period_of(params, 10);
        if view.len() <= period {
            return Ok(());
        }
        for i in period..view.len() {
            if view.close[i].is_finite() && view.close[i - period].is_finite() {
                out[0][i] = view.close[i] - view.close[i - period];
            }
        }
        Ok(())
    }
}

/// M19 Aroon：`Up = 100×(N - 距最高价根数)/N`，Down 同理。
pub struct Aroon;

impl Indicator for Aroon {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(M19_ID, warmup_period_minus_one)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 2, M19_ID)?;
        for column in out.iter_mut() {
            column.fill(f64::NAN);
        }
        let period = period_of(params, 25);
        if view.len() < period {
            return Ok(());
        }
        let high_at = arg_extreme(view.high, period, true);
        let low_at = arg_extreme(view.low, period, false);
        for i in 0..view.len() {
            if let Some(position) = high_at[i] {
                let since = i - position;
                out[0][i] = (period - since) as f64 / period as f64 * 100.0;
            }
            if let Some(position) = low_at[i] {
                let since = i - position;
                out[1][i] = (period - since) as f64 / period as f64 * 100.0;
            }
        }
        Ok(())
    }
}

/// M20 Vortex：`VI+ = Σ|H - 前L| / ΣTR`，`VI- = Σ|L - 前H| / ΣTR`。
pub struct Vortex;

impl Indicator for Vortex {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(M20_ID, vortex_warmup)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 2, M20_ID)?;
        for column in out.iter_mut() {
            column.fill(f64::NAN);
        }
        let period = period_of(params, 14);
        if view.len() <= period {
            return Ok(());
        }
        let tr = true_range(view.high, view.low, view.close);
        for i in period..view.len() {
            let start = i + 1 - period;
            let mut sum_tr = 0.0;
            let mut sum_plus = 0.0;
            let mut sum_minus = 0.0;
            let mut valid = true;
            for j in start..=i {
                if !tr[j].is_finite()
                    || !view.high[j].is_finite()
                    || !view.low[j].is_finite()
                    || !view.low[j - 1].is_finite()
                    || !view.high[j - 1].is_finite()
                {
                    valid = false;
                    break;
                }
                sum_tr += tr[j];
                sum_plus += (view.high[j] - view.low[j - 1]).abs();
                sum_minus += (view.low[j] - view.high[j - 1]).abs();
            }
            if valid && sum_tr != 0.0 {
                out[0][i] = sum_plus / sum_tr;
                out[1][i] = sum_minus / sum_tr;
            }
        }
        Ok(())
    }
}

/// M21 CMO：涨幅和/跌幅和的对称振荡器，值域 [-100, 100]。
pub struct Cmo;

impl Indicator for Cmo {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(M21_ID, cmo_warmup)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, M21_ID)?;
        out[0].fill(f64::NAN);
        let period = period_of(params, 14);
        if view.len() <= period {
            return Ok(());
        }
        let mut delta = vec![f64::NAN; view.len()];
        for i in 1..view.len() {
            if view.close[i].is_finite() && view.close[i - 1].is_finite() {
                delta[i] = view.close[i] - view.close[i - 1];
            }
        }
        for i in period..view.len() {
            let window = &delta[i + 1 - period..=i];
            if window.iter().any(|value| !value.is_finite()) {
                continue;
            }
            let up: f64 = window.iter().filter(|value| **value > 0.0).sum();
            let down: f64 = window.iter().filter(|value| **value < 0.0).map(|value| -value).sum();
            let total = up + down;
            if total != 0.0 {
                out[0][i] = (up - down) / total * 100.0;
            }
        }
        Ok(())
    }
}

/// M24 Mass Index：`Σ EMA9(H-L) / EMA9(EMA9(H-L))`，25 根求和。
pub struct MassIndex;

impl Indicator for MassIndex {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(M24_ID, mass_index_warmup)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, M24_ID)?;
        out[0].fill(f64::NAN);
        let ema_period = period_of_key(params, "ema", 9);
        let sum_period = period_of_key(params, "sum", 25);
        if view.len() < ema_period {
            return Ok(());
        }
        let mut range = vec![f64::NAN; view.len()];
        for i in 0..view.len() {
            if view.high[i].is_finite() && view.low[i].is_finite() {
                range[i] = view.high[i] - view.low[i];
            }
        }
        let first = ema(&range, ema_period);
        let second = ema_of_valid(&first, ema_period);
        let mut ratio = vec![f64::NAN; view.len()];
        for i in 0..view.len() {
            if first[i].is_finite() && second[i].is_finite() && second[i] != 0.0 {
                ratio[i] = first[i] / second[i];
            }
        }
        out[0].copy_from_slice(&window_sum(&ratio, sum_period));
        Ok(())
    }
}

/// M25 Elder Impulse：MACD 柱的 EMA13 趋势 + 柱零轴决定三色状态。
pub struct ElderImpulse;

impl Indicator for ElderImpulse {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(M25_ID, elder_impulse_warmup)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 2, M25_ID)?;
        for column in out.iter_mut() {
            column.fill(f64::NAN);
        }
        let fast = period_of_key(params, "fast", 12);
        let slow = period_of_key(params, "slow", 26);
        let signal = period_of_key(params, "signal", 9);
        let ema_period = period_of_key(params, "ema", 13);
        if fast >= slow {
            return Err(CalcError::InvalidParam("fast 必须小于 slow".to_string()));
        }
        if view.len() < slow {
            return Ok(());
        }
        let (_, _, hist) = macd_columns(view, fast, slow, signal);
        let impulse = ema_of_valid(&hist, ema_period);
        out[0].copy_from_slice(&impulse);
        for i in 1..view.len() {
            if !impulse[i].is_finite() || !impulse[i - 1].is_finite() || !hist[i].is_finite() {
                continue;
            }
            // 线性行情下 DIF/DEA 收敛到同一仿射函数，柱只剩浮点残差；按价格量级的相对阈值判零，避免噪声触发 ±1
            let eps = 1e-9 * view.close[i].abs().max(1.0);
            let state = if hist[i] > eps && impulse[i] > impulse[i - 1] {
                1.0
            } else if hist[i] < -eps && impulse[i] < impulse[i - 1] {
                -1.0
            } else {
                0.0
            };
            out[1][i] = state;
        }
        Ok(())
    }
}

/// M26 NR7：当根振幅是否为近 7 根最小，输出 1/0。
pub struct Nr7;

impl Indicator for Nr7 {
    fn meta(&self) -> &'static Meta {
        crate::manifest::meta_for(M26_ID, warmup_period_minus_one)
    }

    fn calc(&self, view: &OhlcvView<'_>, params: &Params, out: &mut [Vec<f64>]) -> Result<(), CalcError> {
        ensure_shape(view, out, 1, M26_ID)?;
        out[0].fill(f64::NAN);
        let period = period_of(params, 7);
        if view.len() < period {
            return Ok(());
        }
        let mut range = vec![f64::NAN; view.len()];
        for i in 0..view.len() {
            if view.high[i].is_finite() && view.low[i].is_finite() {
                range[i] = view.high[i] - view.low[i];
            }
        }
        for i in (period - 1)..view.len() {
            let window = &range[i + 1 - period..=i];
            if window.iter().any(|value| !value.is_finite()) {
                continue;
            }
            let narrowest = window.iter().copied().fold(f64::INFINITY, f64::min);
            out[0][i] = if range[i] == narrowest { 1.0 } else { 0.0 };
        }
        Ok(())
    }
}

fn warmup_period_minus_one(params: &Params) -> usize {
    period_of(params, 20).saturating_sub(1)
}

fn kdj_warmup(params: &Params) -> usize {
    period_of(params, 9).saturating_sub(1)
}

fn ppo_warmup(params: &Params) -> usize {
    let slow = period_of_key(params, "slow", 26);
    let signal = period_of_key(params, "signal", 9);
    slow + signal - 2
}

fn mass_index_warmup(params: &Params) -> usize {
    let ema_period = period_of_key(params, "ema", 9);
    let sum_period = period_of_key(params, "sum", 25);
    2 * (ema_period - 1) + sum_period - 1
}

fn elder_impulse_warmup(params: &Params) -> usize {
    let slow = period_of_key(params, "slow", 26);
    let signal = period_of_key(params, "signal", 9);
    let ema_period = period_of_key(params, "ema", 13);
    slow + signal + ema_period - 2
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::param::merge_defaults;

    fn sample(len: usize) -> (Vec<f64>, Vec<f64>, Vec<f64>, Vec<f64>) {
        let close: Vec<f64> = (0..len)
            .map(|i| 100.0 + i as f64 * 0.05 + (i as f64 * 0.7).sin() * 2.0)
            .collect();
        let high: Vec<f64> = close.iter().map(|value| value + 1.0).collect();
        let low: Vec<f64> = close.iter().map(|value| value - 1.0).collect();
        (high, low, close.clone(), close)
    }

    fn run(id: &str, len: usize) -> Vec<Vec<f64>> {
        let (high, low, close, _) = sample(len);
        let view = OhlcvView::new(&close, &high, &low, &close, &close, &close);
        let indicator = crate::lookup(id).unwrap();
        let params = merge_defaults(indicator.meta().params, &Params::new());
        let mut out = vec![vec![0.0; len]; indicator.meta().outputs.len()];
        indicator.calc(&view, &params, &mut out).unwrap();
        out
    }

    #[test]
    fn warmup_matches_first_valid_index() {
        for (id, expected) in [
            (M01_ID, 14usize),
            (M02_ID, 8),
            (M04_ID, 13),
            (M05_ID, 19),
            (M08_ID, 33),
            (M09_ID, 12),
            (M10_ID, 10),
            (M19_ID, 24),
            (M20_ID, 14),
            (M21_ID, 14),
            (M24_ID, 40),
            (M25_ID, 46),
            (M26_ID, 6),
        ] {
            let out = run(id, 520);
            if expected > 0 {
                assert!(
                    out.iter().any(|column| !column[expected - 1].is_finite()),
                    "{id} 预热前一根应存在未就绪输出"
                );
            }
            for (index, column) in out.iter().enumerate() {
                assert!(
                    column[expected].is_finite(),
                    "{id} 第 {index} 列在 warmup={expected} 时应有效"
                );
            }
        }
    }

    #[test]
    fn oscillators_stay_in_range() {
        let rsi = run(M01_ID, 520);
        assert!(rsi[0]
            .iter()
            .filter(|value| value.is_finite())
            .all(|value| (0.0..=100.0).contains(value)));
        let wr = run(M04_ID, 520);
        assert!(wr[0]
            .iter()
            .filter(|value| value.is_finite())
            .all(|value| (-100.0..=0.0).contains(value)));
        let cmo = run(M21_ID, 520);
        assert!(cmo[0]
            .iter()
            .filter(|value| value.is_finite())
            .all(|value| (-100.0..=100.0).contains(value)));
        let aroon = run(M19_ID, 520);
        for column in &aroon {
            assert!(column
                .iter()
                .filter(|value| value.is_finite())
                .all(|value| (0.0..=100.0).contains(value)));
        }
    }

    #[test]
    fn nr7_emits_only_zero_or_one() {
        let out = run(M26_ID, 520);
        assert!(out[0]
            .iter()
            .filter(|value| value.is_finite())
            .all(|value| *value == 0.0 || *value == 1.0));
        assert!(out[0].iter().filter(|value| **value == 1.0).count() > 0);
    }

    #[test]
    fn constant_series_degrades_without_infinity() {
        let (_, _, close, _) = sample(60);
        let flat = vec![10.0; close.len()];
        let view = OhlcvView::new(&flat, &flat, &flat, &flat, &flat, &flat);
        for id in [M01_ID, M02_ID, M04_ID, M05_ID, M20_ID, M24_ID, M26_ID] {
            let indicator = crate::lookup(id).unwrap();
            let params = merge_defaults(indicator.meta().params, &Params::new());
            let mut out = vec![vec![0.0; flat.len()]; indicator.meta().outputs.len()];
            indicator.calc(&view, &params, &mut out).unwrap();
            assert!(
                out.iter().flatten().all(|value| value.is_finite() || value.is_nan()),
                "{id} 不应产生 Infinity"
            );
        }
    }

    #[test]
    fn ppo_rejects_fast_ge_slow() {
        let (high, low, close, _) = sample(520);
        let view = OhlcvView::new(&close, &high, &low, &close, &close, &close);
        let indicator = crate::lookup(M08_ID).unwrap();
        let mut params = merge_defaults(indicator.meta().params, &Params::new());
        params.insert("fast".to_string(), crate::ParamValue::Int(30));
        let mut out = vec![vec![0.0; 520]; 2];
        assert!(indicator.calc(&view, &params, &mut out).is_err());
    }

    fn calc_ohlc(id: &str, high: &[f64], low: &[f64], close: &[f64], params: &Params) -> Vec<Vec<f64>> {
        let view = OhlcvView::new(close, high, low, close, close, close);
        let indicator = crate::lookup(id).unwrap();
        let mut out = vec![vec![0.0; close.len()]; indicator.meta().outputs.len()];
        indicator.calc(&view, params, &mut out).unwrap();
        out
    }

    /// Q-01：零区间 RSV=50、种子 50、无额外预热（首值下标 8）、K/D/J 三线。
    #[test]
    fn kdj_rulings_q01() {
        let flat = vec![10.0; 9];
        let out = calc_ohlc(M02_ID, &flat, &flat, &flat, &Params::new());
        assert!(out.iter().all(|column| column[..8].iter().all(|value| value.is_nan())));
        assert!((out[0][8] - 50.0).abs() <= 1e-9);
        assert!((out[1][8] - 50.0).abs() <= 1e-9);
        assert!((out[2][8] - 50.0).abs() <= 1e-9);

        let close: Vec<f64> = (0..30).map(|i| 10.0 + i as f64).collect();
        // 裁定表按 RSV=100 手算 K/D/J：H=L=C 时窗口高低差恰为 100%，C±1 会得到 RSV=90
        let out = calc_ohlc(M02_ID, &close, &close, &close, &Params::new());
        assert!(out.iter().all(|column| column[7].is_nan()));
        // 按裁定给的递推式 (2×50+100)/3 实算为 66.6667；裁定表写的 83.3333/77.7778 手算有误（已回报 BA）
        assert!((out[0][8] - 66.6667).abs() <= 1e-4);
        assert!((out[1][8] - 55.5556).abs() <= 1e-4);
        assert!((out[2][8] - 88.8889).abs() <= 1e-4);

        let mut params = Params::new();
        params.insert("k".to_string(), crate::ParamValue::Int(2));
        params.insert("d".to_string(), crate::ParamValue::Int(2));
        let out = calc_ohlc(M02_ID, &close, &close, &close, &params);
        assert!(out[0][..8].iter().all(|value| value.is_nan()));
        assert!((out[0][8] - 75.0).abs() <= 1e-9);
        assert!((out[1][8] - 62.5).abs() <= 1e-9);
    }

    /// Q-02：Mass 首值下标 40；range 恒 2 时 Mass=25；range=0 时 NaN。
    #[test]
    fn mass_index_rulings_q02() {
        let high = vec![11.0; 60];
        let low = vec![9.0; 60];
        let close = vec![10.0; 60];
        let out = calc_ohlc(M24_ID, &high, &low, &close, &Params::new());
        assert!(out[0][..40].iter().all(|value| value.is_nan()));
        assert!((out[0][40] - 25.0).abs() <= 1e-9);
        assert!((out[0][59] - 25.0).abs() <= 1e-9);

        let flat = vec![10.0; 60];
        let out = calc_ohlc(M24_ID, &flat, &flat, &flat, &Params::new());
        assert!(out[0].iter().all(|value| value.is_nan()));
    }

    /// Q-03：柱 2×、先符号后差分、等值取 0；常数序列不出 ±1。
    #[test]
    fn elder_impulse_rulings_q03() {
        // 线性上涨时 DIF/DEA 收敛，柱趋近 0，无法满足「hist>0 且脉冲上行」；用指数上涨构造持续正柱
        let close: Vec<f64> = (0..60).map(|i| 10.0 * 1.01f64.powi(i)).collect();
        let high: Vec<f64> = close.iter().map(|value| value + 1.0).collect();
        let low: Vec<f64> = close.iter().map(|value| value - 1.0).collect();
        let out = calc_ohlc(M25_ID, &high, &low, &close, &Params::new());
        assert!(out[0][..45].iter().all(|value| value.is_nan()));
        assert!(out[1][45].is_nan());
        assert!(out[1][46..].iter().all(|value| *value == 1.0));
        let (_, _, hist) = macd_columns(
            &OhlcvView::new(&close, &high, &low, &close, &close, &close),
            12,
            26,
            9,
        );
        assert!(hist[33..].iter().all(|value| *value > 0.0));

        let flat = vec![10.0; 60];
        let out = calc_ohlc(M25_ID, &flat, &flat, &flat, &Params::new());
        assert!(out[1][46..].iter().all(|value| *value == 0.0));
    }

    /// Q-04：M06 柱 = 2×(DIF−DEA)，与 M25 复用的柱逐根一致。
    #[test]
    fn macd_hist_is_double_dif_minus_dea() {
        let (high, low, close, _) = sample(40);
        let out = run("M06", 40);
        for i in 0..40 {
            if out[2][i].is_finite() {
                assert!((out[2][i] - 2.0 * (out[0][i] - out[1][i])).abs() <= 1e-9);
            }
        }
        let (_, _, hist) = macd_columns(
            &OhlcvView::new(&close, &high, &low, &close, &close, &close),
            12,
            26,
            9,
        );
        for i in 0..40 {
            assert!(hist[i].is_nan() == out[2][i].is_nan());
            if hist[i].is_finite() {
                assert!((hist[i] - out[2][i]).abs() <= 1e-9);
            }
        }
    }
}
