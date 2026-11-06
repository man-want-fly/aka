//! B1 底座数值内核：均线、Wilder 平滑、滚动窗口与一元线性回归（OLS）。
//!
//! 约束（S1 冻结）：
//! - 输入 `&[f64]`，输出 `Vec<f64>`，缺失值一律 `f64::NAN`，不补零；
//! - 纯函数、无 IO、无 async、不依赖任何上层 crate；
//! - 所有函数对 `period < 2` 或 `len < period` 返回全 `NAN`，由注册表层保证参数合法；
//! - 窗口内含 `NAN` 时，该点输出 `NAN`（不跳过、不插值）。

use std::f64;

/// 滚动求和：`out[i] = sum(values[i-n+1..=i])`，前 `n-1` 根为 `NAN`。
pub fn rolling_sum(values: &[f64], period: usize) -> Vec<f64> {
    let len = values.len();
    let mut out = vec![f64::NAN; len];
    if period < 1 || len < period {
        return out;
    }
    let mut sum: f64 = values[..period].iter().sum();
    out[period - 1] = sum;
    for i in period..len {
        sum += values[i] - values[i - period];
        out[i] = sum;
    }
    out
}

/// 简单均线 SMA：滚动求和的均值。
pub fn sma(values: &[f64], period: usize) -> Vec<f64> {
    let mut out = rolling_sum(values, period);
    if period == 0 {
        return out;
    }
    for value in out.iter_mut() {
        if value.is_finite() {
            *value /= period as f64;
        }
    }
    out
}

/// 加权均线 WMA：权重 1..N，最新一根权重最大。
pub fn wma(values: &[f64], period: usize) -> Vec<f64> {
    let len = values.len();
    let mut out = vec![f64::NAN; len];
    if period < 1 || len < period {
        return out;
    }
    let denominator = period as f64 * (period as f64 + 1.0) / 2.0;
    for i in (period - 1)..len {
        let start = i + 1 - period;
        let mut numerator = 0.0;
        let mut finite = true;
        for k in 0..period {
            let value = values[start + k];
            if !value.is_finite() {
                finite = false;
                break;
            }
            numerator += (k + 1) as f64 * value;
        }
        if finite {
            out[i] = numerator / denominator;
        }
    }
    out
}

/// EMA：前 `period` 根用 SMA 作种子，之后 `α = 2/(N+1)` 递推。
pub fn ema(values: &[f64], period: usize) -> Vec<f64> {
    let len = values.len();
    let mut out = vec![f64::NAN; len];
    if period < 2 || len < period {
        return out;
    }
    if values[..period].iter().any(|value| !value.is_finite()) {
        return out;
    }
    let seed: f64 = values[..period].iter().sum::<f64>() / period as f64;
    out[period - 1] = seed;
    let alpha = 2.0 / (period as f64 + 1.0);
    for i in period..len {
        if !values[i].is_finite() {
            break;
        }
        out[i] = alpha * values[i] + (1.0 - alpha) * out[i - 1];
    }
    out
}

/// 对含 `NAN` 前缀的序列做 EMA：从第一个有限值起取连续 `period` 个有限值做种子。
pub fn ema_of_valid(values: &[f64], period: usize) -> Vec<f64> {
    let len = values.len();
    let mut out = vec![f64::NAN; len];
    if period < 2 {
        return out;
    }
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

/// Wilder 平滑（RMA）：SMA 种子后 `(prev*(N-1) + x) / N`。
pub fn wilder(values: &[f64], period: usize) -> Vec<f64> {
    let len = values.len();
    let mut out = vec![f64::NAN; len];
    if period < 2 || len < period {
        return out;
    }
    if values[..period].iter().any(|value| !value.is_finite()) {
        return out;
    }
    let seed: f64 = values[..period].iter().sum::<f64>() / period as f64;
    out[period - 1] = seed;
    let n = period as f64;
    for i in period..len {
        if !values[i].is_finite() {
            break;
        }
        out[i] = (out[i - 1] * (n - 1.0) + values[i]) / n;
    }
    out
}

/// 对含 `NAN` 前缀的序列做 Wilder RMA：从第一个有限值起取连续 `period` 个有限值做种子。
pub fn wilder_of_valid(values: &[f64], period: usize) -> Vec<f64> {
    let len = values.len();
    let mut out = vec![f64::NAN; len];
    if period < 2 {
        return out;
    }
    let Some(start) = values.iter().position(|value| value.is_finite()) else {
        return out;
    };
    let end = start + period;
    if end > len || values[start..end].iter().any(|value| !value.is_finite()) {
        return out;
    }
    let seed: f64 = values[start..end].iter().sum::<f64>() / period as f64;
    out[end - 1] = seed;
    let n = period as f64;
    for i in end..len {
        if values[i].is_finite() && out[i - 1].is_finite() {
            out[i] = (out[i - 1] * (n - 1.0) + values[i]) / n;
        }
    }
    out
}

/// 滚动最大值：`out[i] = max(values[i-n+1..=i])`；窗口含 `NAN` 或长度不足时输出 `NAN`。
pub fn rolling_max(values: &[f64], period: usize) -> Vec<f64> {
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
        out[i] = window.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    }
    out
}

/// 滚动最小值：`out[i] = min(values[i-n+1..=i])`；窗口含 `NAN` 或长度不足时输出 `NAN`。
pub fn rolling_min(values: &[f64], period: usize) -> Vec<f64> {
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
        out[i] = window.iter().copied().fold(f64::INFINITY, f64::min);
    }
    out
}

/// 滚动样本标准差（ddof=1）：`sqrt(Σ(x-x̄)²/(N-1))`；N<2 或窗口含 `NAN` 时输出 `NAN`。
pub fn rolling_std(values: &[f64], period: usize) -> Vec<f64> {
    let len = values.len();
    let mut out = vec![f64::NAN; len];
    if period < 2 || len < period {
        return out;
    }
    for i in (period - 1)..len {
        let window = &values[i + 1 - period..=i];
        if window.iter().any(|value| !value.is_finite()) {
            continue;
        }
        let mean = window.iter().sum::<f64>() / period as f64;
        let variance = window.iter().map(|value| (value - mean).powi(2)).sum::<f64>()
            / (period - 1) as f64;
        out[i] = variance.max(0.0).sqrt();
    }
    out
}

/// 真实波幅：首根 `NAN`；其后 `max(H-L, |H-PC|, |L-PC|)`。
pub fn true_range(high: &[f64], low: &[f64], close: &[f64]) -> Vec<f64> {
    let len = high.len();
    let mut out = vec![f64::NAN; len];
    for i in 1..len {
        let previous = close[i - 1];
        if !previous.is_finite() || !high[i].is_finite() || !low[i].is_finite() {
            continue;
        }
        out[i] = (high[i] - low[i])
            .abs()
            .max((high[i] - previous).abs())
            .max((low[i] - previous).abs());
    }
    out
}

/// 一元线性回归的四条输出曲线；长度均等于输入，前缀为 `NAN`。
#[derive(Debug, Clone)]
pub struct LinRegSeries {
    /// 斜率，单位「价格/根」
    pub slope: Vec<f64>,
    /// 截距，窗口首根处的拟合值
    pub intercept: Vec<f64>,
    /// 决定系数 R²，落在 [0,1]；常数序列定义为 1.0
    pub r2: Vec<f64>,
    /// 当前根（窗口末根）的拟合值
    pub forecast: Vec<f64>,
}

/// 滚动 OLS：`x` 在窗口内取 `0..N-1`，`y` 为输入值。
///
/// 使用中心化公式避免大价格下的消去误差：
/// `Sxx = N(N²-1)/12`、`Sxy = Σ(x-x̄)(y-ȳ)`、`slope = Sxy/Sxx`、
/// `intercept = ȳ - slope·x̄`、`R² = Sxy²/(Sxx·Syy)`。
/// `Syy = 0`（常数序列）时 `R² = 1.0`，`slope = 0`。
pub fn linreg(values: &[f64], period: usize) -> LinRegSeries {
    let len = values.len();
    let mut series = LinRegSeries {
        slope: vec![f64::NAN; len],
        intercept: vec![f64::NAN; len],
        r2: vec![f64::NAN; len],
        forecast: vec![f64::NAN; len],
    };
    if period < 2 || len < period {
        return series;
    }

    let n = period as f64;
    let x_bar = (period as f64 - 1.0) / 2.0;
    let sxx = n * (n * n - 1.0) / 12.0;

    for i in (period - 1)..len {
        let window = &values[i + 1 - period..=i];
        if window.iter().any(|value| !value.is_finite()) {
            continue;
        }
        let y_bar = window.iter().sum::<f64>() / n;
        let mut sxy = 0.0;
        let mut syy = 0.0;
        for (k, value) in window.iter().enumerate() {
            let dx = k as f64 - x_bar;
            let dy = value - y_bar;
            sxy += dx * dy;
            syy += dy * dy;
        }
        let slope = sxy / sxx;
        let intercept = y_bar - slope * x_bar;
        let r2 = if syy == 0.0 {
            1.0
        } else {
            (sxy * sxy / (sxx * syy)).clamp(0.0, 1.0)
        };
        series.slope[i] = slope;
        series.intercept[i] = intercept;
        series.r2[i] = r2;
        series.forecast[i] = intercept + slope * (n - 1.0);
    }
    series
}

/// BIAS 乖离率：`(value - SMA_N) / SMA_N × 100`；SMA 为零时输出 `NAN`，不产生 `Infinity`。
pub fn bias(values: &[f64], period: usize) -> Vec<f64> {
    let mean = sma(values, period);
    let mut out = vec![f64::NAN; values.len()];
    for i in 0..values.len() {
        if values[i].is_finite() && mean[i].is_finite() && mean[i] != 0.0 {
            out[i] = (values[i] - mean[i]) / mean[i] * 100.0;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close_up(n: usize) -> Vec<f64> {
        (0..n).map(|i| 100.0 + i as f64).collect()
    }

    #[test]
    fn rolling_sum_and_sma_match_manual() {
        let values = close_up(10);
        let sum = rolling_sum(&values, 5);
        assert!(sum[..4].iter().all(|v| v.is_nan()));
        assert!(sum[4].is_finite());
        assert!((sum[4] - 510.0).abs() < 1e-9);
        let mean = sma(&values, 5);
        assert!((mean[4] - 102.0).abs() < 1e-9);
        assert!((mean[9] - 107.0).abs() < 1e-9);
    }

    #[test]
    fn wma_weights_latest_more() {
        let values = close_up(10);
        let out = wma(&values, 5);
        // 100..104，权重 1..5：分子=100*1+101*2+102*3+103*4+104*5=1540，分母=15
        assert!((out[4] - 1540.0 / 15.0).abs() < 1e-9);
        // 105..109：分子=105*1+106*2+107*3+108*4+109*5=1615，分母=15
        assert!((out[9] - 1615.0 / 15.0).abs() < 1e-9);
    }

    #[test]
    fn ema_seed_is_sma_then_recursive() {
        let values = close_up(30);
        let out = ema(&values, 10);
        let seed = values[..10].iter().sum::<f64>() / 10.0;
        assert!((out[9] - seed).abs() < 1e-9);
        let alpha = 2.0 / 11.0;
        let expected = alpha * values[10] + (1.0 - alpha) * seed;
        assert!((out[10] - expected).abs() < 1e-9);
    }

    #[test]
    fn wilder_uses_sma_seed_and_rma_recursion() {
        let values = close_up(10);
        let out = wilder(&values, 5);
        let seed = values[..5].iter().sum::<f64>() / 5.0;
        assert!((out[4] - seed).abs() < 1e-9);
        // (seed*4 + 105) / 5
        assert!((out[5] - (seed * 4.0 + values[5]) / 5.0).abs() < 1e-9);
    }

    #[test]
    fn ema_of_valid_starts_at_first_finite_window() {
        let mut values = vec![f64::NAN; 10];
        values.extend(close_up(20));
        let out = ema_of_valid(&values, 5);
        assert!(out[..14].iter().all(|v| v.is_nan()));
        assert!((out[14] - 102.0).abs() < 1e-9);
        assert!(out[15].is_finite());
    }

    #[test]
    fn linreg_recovers_perfect_line() {
        // y = 2x + 3
        let values: Vec<f64> = (0..20).map(|x| 2.0 * x as f64 + 3.0).collect();
        let out = linreg(&values, 10);
        assert!(out.slope[..9].iter().all(|v| v.is_nan()));
        let i = 9;
        assert!((out.slope[i] - 2.0).abs() < 1e-9);
        assert!((out.intercept[i] - 3.0).abs() < 1e-9);
        assert!((out.r2[i] - 1.0).abs() < 1e-9);
        assert!((out.forecast[i] - (3.0 + 2.0 * 9.0)).abs() < 1e-9);
    }

    #[test]
    fn linreg_constant_series_slope_zero_r2_one() {
        let values = vec![10.0_f64; 20];
        let out = linreg(&values, 10);
        let i = 9;
        assert!((out.slope[i]).abs() < 1e-12);
        assert!((out.intercept[i] - 10.0).abs() < 1e-12);
        assert!((out.r2[i] - 1.0).abs() < 1e-12);
        assert!((out.forecast[i] - 10.0).abs() < 1e-12);
    }

    #[test]
    fn linreg_nan_window_stays_nan() {
        let mut values = close_up(20);
        values[3] = f64::NAN;
        let out = linreg(&values, 10);
        for i in 9..=12 {
            assert!(out.slope[i].is_nan(), "第 {i} 根窗口含 NaN 应输出 NaN");
        }
        assert!(out.slope[13].is_finite());
    }

    #[test]
    fn insufficient_data_is_all_nan() {
        let values = close_up(10);
        for period in [11, 20, 200] {
            assert!(sma(&values, period).iter().all(|v| v.is_nan()));
            assert!(ema(&values, period).iter().all(|v| v.is_nan()));
            assert!(wilder(&values, period).iter().all(|v| v.is_nan()));
            assert!(wma(&values, period).iter().all(|v| v.is_nan()));
            assert!(linreg(&values, period).slope.iter().all(|v| v.is_nan()));
            assert!(bias(&values, period).iter().all(|v| v.is_nan()));
        }
    }

    #[test]
    fn bias_percent_and_zero_mean_guard() {
        let values = close_up(10);
        let out = bias(&values, 5);
        // 104 vs SMA 102：+1.960784%
        assert!((out[4] - (2.0 / 102.0 * 100.0)).abs() < 1e-9);
        let zeros = vec![0.0_f64; 10];
        assert!(bias(&zeros, 5)[4].is_nan());
    }
}
