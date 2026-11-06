#!/usr/bin/env python3
"""B1 黄金夹具参考值生成器（S1）。

只用公开公式手算，不调用 Rust 引擎；生成后的 JSON 作为固定基线提交。
数据源固定为本脚本（seed=42 / 520 根，边界套件独立生成），**禁止手工修改 JSON**。

运行：python3 crates/indicator-golden/fixtures/gen_reference.py
"""
import json
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
NAN = None


def sma(values, period):
    out = [NAN] * len(values)
    if len(values) < period:
        return out
    s = sum(values[:period])
    out[period - 1] = s / period
    for i in range(period, len(values)):
        s += values[i] - values[i - period]
        out[i] = s / period
    return out


def ema(values, period):
    """前 period 根用 SMA 作种子，之后 alpha = 2/(n+1) 递推。"""
    out = [NAN] * len(values)
    if period == 0 or len(values) < period:
        return out
    seed = sum(values[:period]) / period
    out[period - 1] = seed
    alpha = 2.0 / (period + 1.0)
    for i in range(period, len(values)):
        out[i] = alpha * values[i] + (1 - alpha) * out[i - 1]
    return out


def wma(values, period):
    out = [NAN] * len(values)
    den = period * (period + 1) / 2.0
    for i in range(period - 1, len(values)):
        start = i + 1 - period
        num = sum((k + 1) * values[start + k] for k in range(period))
        out[i] = num / den
    return out


def ema_of_valid(values, period):
    out = [NAN] * len(values)
    start = next((i for i, v in enumerate(values) if v is not None), None)
    if start is None:
        return out
    end = start + period
    if end > len(values):
        return out
    seed = sum(values[start:end]) / period
    out[end - 1] = seed
    alpha = 2.0 / (period + 1.0)
    for i in range(end, len(values)):
        if values[i] is not None and out[i - 1] is not None:
            out[i] = alpha * values[i] + (1 - alpha) * out[i - 1]
    return out


def dema(values, period):
    first = ema(values, period)
    second = ema_of_valid(first, period)
    out = [NAN] * len(values)
    for i in range(len(values)):
        if first[i] is not None and second[i] is not None:
            out[i] = 2.0 * first[i] - second[i]
    return out


def tema(values, period):
    first = ema(values, period)
    second = ema_of_valid(first, period)
    third = ema_of_valid(second, period)
    out = [NAN] * len(values)
    for i in range(len(values)):
        if first[i] is not None and second[i] is not None and third[i] is not None:
            out[i] = 3.0 * first[i] - 3.0 * second[i] + third[i]
    return out


def linreg(values, period):
    """返回 slope / intercept / r2 / forecast；常数序列 R² 定义为 1.0。"""
    n = len(values)
    columns = {key: [NAN] * n for key in ("slope", "intercept", "r2", "forecast")}
    if period < 2 or n < period:
        return columns
    x_bar = (period - 1) / 2.0
    sxx = period * (period * period - 1) / 12.0
    for i in range(period - 1, n):
        window = values[i + 1 - period:i + 1]
        y_bar = sum(window) / period
        sxy = 0.0
        syy = 0.0
        for k, value in enumerate(window):
            dx = k - x_bar
            dy = value - y_bar
            sxy += dx * dy
            syy += dy * dy
        slope = sxy / sxx
        intercept = y_bar - slope * x_bar
        r2 = 1.0 if syy == 0.0 else max(0.0, min(1.0, sxy * sxy / (sxx * syy)))
        columns["slope"][i] = slope
        columns["intercept"][i] = intercept
        columns["r2"][i] = r2
        columns["forecast"][i] = intercept + slope * (period - 1)
    return columns


def bias(values, period):
    mean = sma(values, period)
    out = [NAN] * len(values)
    for i in range(len(values)):
        if mean[i] is not None and mean[i] != 0.0:
            out[i] = (values[i] - mean[i]) / mean[i] * 100.0
    return out


def macd(closes, fast, slow, signal):
    ef, es = ema(closes, fast), ema(closes, slow)
    dif = [NAN] * len(closes)
    for i in range(len(closes)):
        if ef[i] is not None and es[i] is not None:
            dif[i] = ef[i] - es[i]
    dea = ema_of_valid(dif, signal)
    dif_out = [NAN] * len(closes)
    dea_out = [NAN] * len(closes)
    hist = [NAN] * len(closes)
    for i in range(len(closes)):
        if dif[i] is not None and dea[i] is not None:
            dif_out[i] = dif[i]
            dea_out[i] = dea[i]
            hist[i] = 2.0 * (dif[i] - dea[i])
    return {"dif": dif_out, "dea": dea_out, "hist": hist}


# ----------------------------- B2 通道 / 波动 -----------------------------
def wilder_of_valid(values, period):
    out = [NAN] * len(values)
    start = next((i for i, v in enumerate(values) if v is not None), None)
    if start is None or period < 2:
        return out
    end = start + period
    if end > len(values) or any(v is None for v in values[start:end]):
        return out
    seed = sum(values[start:end]) / period
    out[end - 1] = seed
    for i in range(end, len(values)):
        if values[i] is not None and out[i - 1] is not None:
            out[i] = (out[i - 1] * (period - 1) + values[i]) / period
    return out


def rolling_max(values, period):
    out = [NAN] * len(values)
    if period < 1 or len(values) < period:
        return out
    for i in range(period - 1, len(values)):
        window = values[i + 1 - period:i + 1]
        if any(v is None for v in window):
            continue
        out[i] = max(window)
    return out


def rolling_min(values, period):
    out = [NAN] * len(values)
    if period < 1 or len(values) < period:
        return out
    for i in range(period - 1, len(values)):
        window = values[i + 1 - period:i + 1]
        if any(v is None for v in window):
            continue
        out[i] = min(window)
    return out


def rolling_std(values, period):
    out = [NAN] * len(values)
    if period < 2 or len(values) < period:
        return out
    for i in range(period - 1, len(values)):
        window = values[i + 1 - period:i + 1]
        if any(v is None for v in window):
            continue
        mean = sum(window) / period
        var = sum((v - mean) ** 2 for v in window) / (period - 1)
        out[i] = max(0.0, var) ** 0.5
    return out


def true_range(high, low, close):
    out = [NAN] * len(high)
    for i in range(1, len(high)):
        if high[i] is None or low[i] is None or close[i - 1] is None:
            continue
        pc = close[i - 1]
        out[i] = max(abs(high[i] - low[i]), abs(high[i] - pc), abs(low[i] - pc))
    return out


def atr(high, low, close, period):
    return wilder_of_valid(true_range(high, low, close), period)


def boll(closes, period, mult):
    mid = sma(closes, period)
    sd = rolling_std(closes, period)
    upper = [NAN] * len(closes)
    lower = [NAN] * len(closes)
    for i in range(len(closes)):
        if mid[i] is not None and sd[i] is not None:
            upper[i] = mid[i] + mult * sd[i]
            lower[i] = mid[i] - mult * sd[i]
    return {"upper": upper, "middle": mid, "lower": lower}


def envelopes(closes, period, pct):
    mid = sma(closes, period)
    upper = [NAN] * len(closes)
    lower = [NAN] * len(closes)
    for i in range(len(closes)):
        if mid[i] is not None:
            upper[i] = mid[i] * (1.0 + pct / 100.0)
            lower[i] = mid[i] * (1.0 - pct / 100.0)
    return {"upper": upper, "middle": mid, "lower": lower}


def atr_bands(closes, high, low, period, mult):
    mid = sma(closes, period)
    a = atr(high, low, closes, period)
    upper = [NAN] * len(closes)
    middle = [NAN] * len(closes)
    lower = [NAN] * len(closes)
    for i in range(len(closes)):
        if mid[i] is not None and a[i] is not None:
            middle[i] = mid[i]
            upper[i] = mid[i] + mult * a[i]
            lower[i] = mid[i] - mult * a[i]
    return {"upper": upper, "middle": middle, "lower": lower}


def keltner(closes, high, low, period, mult):
    mid = ema(closes, period)
    a = atr(high, low, closes, period)
    upper = [NAN] * len(closes)
    middle = [NAN] * len(closes)
    lower = [NAN] * len(closes)
    for i in range(len(closes)):
        if mid[i] is not None and a[i] is not None:
            middle[i] = mid[i]
            upper[i] = mid[i] + mult * a[i]
            lower[i] = mid[i] - mult * a[i]
    return {"upper": upper, "middle": middle, "lower": lower}


def atr_trail(closes, high, low, period, k):
    a = atr(high, low, closes, period)
    long_out = [NAN] * len(closes)
    short_out = [NAN] * len(closes)
    start = next((i for i, v in enumerate(a) if v is not None), None)
    if start is None:
        return {"long": long_out, "short": short_out}
    long_state = closes[start] >= closes[start - 1] if start > 0 else True
    long_stop = closes[start] - k * a[start]
    short_stop = closes[start] + k * a[start]
    if long_state:
        long_out[start] = long_stop
    else:
        short_out[start] = short_stop
    for i in range(start + 1, len(closes)):
        if a[i] is None:
            continue
        if long_state:
            candidate = max(closes[i] - k * a[i], long_stop)
            if closes[i] < long_stop:
                long_state = False
                short_stop = closes[i] + k * a[i]
                long_out[i] = long_stop
                short_out[i] = short_stop
            else:
                long_stop = candidate
                long_out[i] = long_stop
        else:
            candidate = min(closes[i] + k * a[i], short_stop)
            if closes[i] > short_stop:
                long_state = True
                long_stop = closes[i] - k * a[i]
                long_out[i] = long_stop
                short_out[i] = short_stop
            else:
                short_stop = candidate
                short_out[i] = short_stop
    return {"long": long_out, "short": short_out}


def chandelier(closes, high, low, period, mult):
    a = atr(high, low, closes, period)
    hh = rolling_max(high, period)
    ll = rolling_min(low, period)
    long_out = [NAN] * len(closes)
    short_out = [NAN] * len(closes)
    for i in range(len(closes)):
        if a[i] is not None and hh[i] is not None and ll[i] is not None:
            long_out[i] = hh[i] - mult * a[i]
            short_out[i] = ll[i] + mult * a[i]
    return {"long": long_out, "short": short_out}


def midline(high, low, period):
    hh = rolling_max(high, period)
    ll = rolling_min(low, period)
    out = [NAN] * len(high)
    for i in range(len(high)):
        if hh[i] is not None and ll[i] is not None:
            out[i] = (hh[i] + ll[i]) / 2.0
    return out


def ichimoku(closes, high, low, tenkan, kijun, senkou, displacement):
    tk = midline(high, low, tenkan)
    kj = midline(high, low, kijun)
    sb = midline(high, low, senkou)
    out = {key: [NAN] * len(closes)
           for key in ("tenkan", "kijun", "senkouA", "senkouB", "chikou")}
    for i in range(len(closes)):
        out["tenkan"][i] = tk[i]
        out["kijun"][i] = kj[i]
    for i in range(len(closes)):
        target = i + displacement
        if target < len(closes):
            if tk[i] is not None and kj[i] is not None:
                out["senkouA"][target] = (tk[i] + kj[i]) / 2.0
            if sb[i] is not None:
                out["senkouB"][target] = sb[i]
    for j in range(max(0, len(closes) - displacement)):
        out["chikou"][j] = closes[j + displacement]
    return out


def psar(closes, high, low, step, increment, max_af):
    out = [NAN] * len(closes)
    if len(closes) < 2:
        return {"psar": out}
    up = closes[1] >= closes[0]
    sar = low[0] if up else high[0]
    extreme = high[1] if up else low[1]
    af = step
    out[1] = sar
    for i in range(2, len(closes)):
        nxt = sar + af * (extreme - sar)
        if up:
            nxt = min(nxt, low[i - 1], low[i - 2])
            if low[i] < nxt:
                up = False
                nxt = extreme
                extreme = low[i]
                af = step
            elif high[i] > extreme:
                extreme = high[i]
                af = min(af + increment, max_af)
        else:
            nxt = max(nxt, high[i - 1], high[i - 2])
            if high[i] > nxt:
                up = True
                nxt = extreme
                extreme = high[i]
                af = step
            elif low[i] < extreme:
                extreme = low[i]
                af = min(af + increment, max_af)
        sar = nxt
        out[i] = sar
    return {"psar": out}


def pivot(high, low, close):
    p = [NAN] * len(close)
    r1 = [NAN] * len(close)
    s1 = [NAN] * len(close)
    for i in range(1, len(close)):
        if high[i - 1] is None or low[i - 1] is None or close[i - 1] is None:
            continue
        value = (high[i - 1] + low[i - 1] + close[i - 1]) / 3.0
        p[i] = value
        r1[i] = 2.0 * value - low[i - 1]
        s1[i] = 2.0 * value - high[i - 1]
    return {"pivot": p, "r1": r1, "s1": s1}


def bb_width(closes, period, mult):
    mid = sma(closes, period)
    sd = rolling_std(closes, period)
    out = [NAN] * len(closes)
    for i in range(len(closes)):
        if mid[i] is not None and sd[i] is not None and mid[i] != 0.0:
            out[i] = 2.0 * mult * sd[i] / mid[i]
    return out


def percent_b(closes, period, mult):
    mid = sma(closes, period)
    sd = rolling_std(closes, period)
    out = [NAN] * len(closes)
    for i in range(len(closes)):
        if mid[i] is None or sd[i] is None:
            continue
        width = 2.0 * mult * sd[i]
        if width != 0.0:
            out[i] = (closes[i] - (mid[i] - mult * sd[i])) / width
    return out


def ulcer(closes, period):
    out = [NAN] * len(closes)
    if len(closes) < period:
        return out
    for i in range(period - 1, len(closes)):
        window = closes[i + 1 - period:i + 1]
        if any(v is None for v in window):
            continue
        peak = max(window)
        if peak <= 0.0:
            continue
        total = sum(((v - peak) / peak * 100.0) ** 2 for v in window)
        out[i] = (total / period) ** 0.5
    return out


def gapo(opens, closes, high, low, period):
    a = atr(high, low, closes, period)
    out = [NAN] * len(closes)
    for i in range(1, len(closes)):
        if a[i] is not None and a[i] != 0.0 and closes[i - 1] is not None:
            out[i] = (opens[i] - closes[i - 1]) / a[i] * 100.0
    return out


def amplitude(high, low):
    return [NAN if (high[i] is None or low[i] is None) else high[i] - low[i]
            for i in range(len(high))]



def roundv(value):
    return None if value is None else round(value, 9)


def build_input(bars, seed):
    rng = random.Random(seed)
    closes, opens = [], []
    highs, lows, vols, amounts = [], [], [], []
    prev = 100.0
    for _ in range(bars):
        ret = rng.gauss(0, 0.015)
        close = max(1.0, round(prev * (1 + ret), 3))
        openp = round(prev, 3)
        spread = abs(rng.gauss(0, 0.006))
        high = round(max(openp, close) * (1 + spread), 3)
        low = round(min(openp, close) * (1 - spread), 3)
        vol = round(1_000_000 * (0.5 + abs(rng.gauss(0, 1))), 0)
        amount = round(vol * close, 2)
        opens.append(openp)
        closes.append(close)
        highs.append(high)
        lows.append(low)
        vols.append(vol)
        amounts.append(amount)
        prev = close
    return {"open": opens, "high": highs, "low": lows,
            "close": closes, "volume": vols, "amount": amounts}


def case(indicator_id, params, outputs, expected, tolerance=None):
    if tolerance is None:
        tolerance = tolerance_for(indicator_id)
    return {"indicatorId": indicator_id, "params": params, "outputs": outputs,
            "tolerance": tolerance,
            "expected": {key: [roundv(v) for v in column]
                         for key, column in expected.items()}}


# 容差口径（与 docs/indicators/b1-trend-kernels.md、b2-channel-volatility.md 一致，
# 测试 `tolerance_rules_are_frozen` 锁定）：
# - 价格/金额口径（元、元/根）：relative 1e-6，分母 max(|expected|, 1.0)
# - 无量纲比率（T21 R²）：absolute 1e-6
# - 百分比振荡（E13 BIAS，%）与 MACD 副图：absolute 1e-4
# - B2 无量纲振荡（V02/V04/V05/V07/V08）：absolute 1e-4
# - T24 为原始窗口最值直取，用 absolute 1e-9 等价精确（容差 0）
# - 手算类夹具（edge_manual_nonlinear / edge_arithmetic_regression）允许单 case 收紧到 absolute 1e-9
TOLERANCE_RULES = (
    "relative:1e-6=价格/斜率类（元、元/根），分母 max(|expected|,1.0)；"
    "absolute:1e-6=R²（无量纲）；"
    "absolute:1e-4=BIAS(%)、MACD 副图、B2 无量纲振荡（ATRP/带宽/%B/ULCER/GAPO）；"
    "absolute:1e-9=仅手算夹具单 case 收紧，或 T24 原始值直取（容差 0）；"
    "count=计数严格相等"
)
TOLERANCE_BY_INDICATOR = {
    "T21": "absolute:1e-6",
    "E13": "absolute:1e-4",
    "M06": "absolute:1e-4",
    "T24": "absolute:1e-9",
    "V02": "absolute:1e-4",
    "V04": "absolute:1e-4",
    "V05": "absolute:1e-4",
    "V07": "absolute:1e-4",
    "V08": "absolute:1e-4",
}
DEFAULT_TOLERANCE = "relative:1e-6"


def tolerance_for(indicator_id):
    return TOLERANCE_BY_INDICATOR.get(indicator_id, DEFAULT_TOLERANCE)


def write(name, payload):
    path = os.path.join(HERE, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    print("wrote", path)


def suite(name, seed, bars, closes, cases, volume=None):
    if volume is None:
        volume = [0.0] * bars
    flat = closes
    return {"formatVersion": 1, "name": name, "seed": seed, "bars": bars,
            "toleranceRules": TOLERANCE_RULES,
            "input": {"open": flat, "high": flat, "low": flat,
                      "close": closes, "volume": volume,
                      "amount": [0.0] * bars},
            "cases": cases}


def suite_ohlc(name, seed, data, cases):
    bars = len(data["close"])
    return {"formatVersion": 1, "name": name, "seed": seed, "bars": bars,
            "toleranceRules": TOLERANCE_RULES,
            "input": {"open": data["open"], "high": data["high"], "low": data["low"],
                      "close": data["close"], "volume": data["volume"],
                      "amount": data["amount"]},
            "cases": cases}


def b2_cases(data):
    """B2 默认参数下的 20 个指标基线（含开高低收的真实数据）。"""
    o, h, l, c = data["open"], data["high"], data["low"], data["close"]
    return [
        case("T08", {"period": 20, "pct": 2.5}, ["upper", "middle", "lower"],
             envelopes(c, 20, 2.5)),
        case("T09", {"period": 20, "mult": 2.0}, ["upper", "middle", "lower"],
             boll(c, 20, 2.0)),
        case("T10", {"period": 20, "mult": 2.0}, ["upper", "middle", "lower"],
             keltner(c, h, l, 20, 2.0)),
        case("T11", {"period": 20}, ["upper", "lower"],
             {"upper": rolling_max(h, 20), "lower": rolling_min(l, 20)}),
        case("T12", {"period": 20, "mult": 2.0}, ["upper", "middle", "lower"],
             atr_bands(c, h, l, 20, 2.0)),
        case("T13", {"period": 14, "mult": 3.5}, ["long", "short"],
             atr_trail(c, h, l, 14, 3.5)),
        case("T14", {"period": 22, "mult": 3.0}, ["long", "short"],
             chandelier(c, h, l, 22, 3.0)),
        case("T15", {"tenkan": 9, "kijun": 26, "senkou": 52, "displacement": 26},
             ["tenkan", "kijun", "senkouA", "senkouB", "chikou"],
             ichimoku(c, h, l, 9, 26, 52, 26)),
        case("T16", {"step": 0.02, "increment": 0.02, "max": 0.2}, ["psar"],
             psar(c, h, l, 0.02, 0.02, 0.2)),
        case("T23", {}, ["pivot", "r1", "s1"], pivot(h, l, c)),
        case("T24", {"period": 20}, ["hhv", "llv"],
             {"hhv": rolling_max(h, 20), "llv": rolling_min(l, 20)}),
        case("V01", {"period": 14}, ["atr"], {"atr": atr(h, l, c, 14)}),
        case("V02", {"period": 14}, ["atrp"],
             {"atrp": [NAN if (a is None or c[i] == 0.0) else a / c[i]
                       for i, a in enumerate(atr(h, l, c, 14))]}),
        case("V03", {"period": 20}, ["std"], {"std": rolling_std(c, 20)}),
        case("V04", {"period": 20, "mult": 2.0}, ["width"], {"width": bb_width(c, 20, 2.0)}),
        case("V05", {"period": 20, "mult": 2.0}, ["percentB"], {"percentB": percent_b(c, 20, 2.0)}),
        case("V07", {"period": 14}, ["ulcer"], {"ulcer": ulcer(c, 14)}),
        case("V08", {"period": 20}, ["gapo"], {"gapo": gapo(o, c, h, l, 20)}),
        case("V08", {"period": 14}, ["gapo"], {"gapo": gapo(o, c, h, l, 14)}),
        case("V09", {}, ["amplitude"], {"amplitude": amplitude(h, l)}),
        case("V10", {}, ["tr"], {"tr": true_range(h, l, c)}),
    ]


def main():
    data = build_input(520, 42)
    closes = data["close"]
    base = [
        case("T01", {"period": 20}, ["sma"], {"sma": sma(closes, 20)}),
        case("T02", {"period": 20}, ["ema"], {"ema": ema(closes, 20)}),
        case("T03", {"period": 20}, ["wma"], {"wma": wma(closes, 20)}),
        case("T04", {"period": 20}, ["dema"], {"dema": dema(closes, 20)}),
        case("T05", {"period": 20}, ["tema"], {"tema": tema(closes, 20)}),
        case("T19", {"period": 20}, ["forecast"],
             {"forecast": linreg(closes, 20)["forecast"]}),
        case("T20", {"period": 20}, ["intercept"],
             {"intercept": linreg(closes, 20)["intercept"]}),
        case("T21", {"period": 20}, ["r2"], {"r2": linreg(closes, 20)["r2"]}),
        case("T22", {"period": 20}, ["slope"], {"slope": linreg(closes, 20)["slope"]}),
        case("E13", {"period1": 6, "period2": 12, "period3": 24},
             ["bias6", "bias12", "bias24"],
             {"bias6": bias(closes, 6), "bias12": bias(closes, 12),
              "bias24": bias(closes, 24)}),
        case("M06", {"fast": 12, "slow": 26, "signal": 9},
             ["dif", "dea", "hist"], macd(closes, 12, 26, 9), "absolute:1e-4"),
    ]
    write("base_trend_seed42_520.json",
          suite("base_trend_seed42_520", 42, 520, closes, base))

    short = [100.0 + i for i in range(20)]
    insufficient = [
        case("T01", {"period": 60}, ["sma"], {"sma": sma(short, 60)}),
        case("T02", {"period": 60}, ["ema"], {"ema": ema(short, 60)}),
        case("T03", {"period": 60}, ["wma"], {"wma": wma(short, 60)}),
        case("T04", {"period": 20}, ["dema"], {"dema": dema(short, 20)}),
        case("T05", {"period": 20}, ["tema"], {"tema": tema(short, 20)}),
        case("T19", {"period": 60}, ["forecast"],
             {"forecast": linreg(short, 60)["forecast"]}),
        case("T20", {"period": 60}, ["intercept"],
             {"intercept": linreg(short, 60)["intercept"]}),
        case("T21", {"period": 60}, ["r2"], {"r2": linreg(short, 60)["r2"]}),
        case("T22", {"period": 60}, ["slope"], {"slope": linreg(short, 60)["slope"]}),
        case("M06", {"fast": 12, "slow": 26, "signal": 9},
             ["dif", "dea", "hist"], macd(short, 12, 26, 9)),
        case("E13", {"period1": 6, "period2": 12, "period3": 24},
             ["bias6", "bias12", "bias24"],
             {"bias6": bias(short, 6), "bias12": bias(short, 12),
              "bias24": bias(short, 24)}),
    ]
    write("edge_data_insufficient.json",
          suite("edge_data_insufficient", 0, 20, short, insufficient))

    flat = [10.0] * 40
    constant = [
        case("T01", {"period": 20}, ["sma"], {"sma": sma(flat, 20)}),
        case("T02", {"period": 20}, ["ema"], {"ema": ema(flat, 20)}),
        case("T03", {"period": 20}, ["wma"], {"wma": wma(flat, 20)}),
        case("T04", {"period": 20}, ["dema"], {"dema": dema(flat, 20)}),
        case("T05", {"period": 10}, ["tema"], {"tema": tema(flat, 10)}),
        case("T19", {"period": 20}, ["forecast"],
             {"forecast": linreg(flat, 20)["forecast"]}),
        case("T20", {"period": 20}, ["intercept"],
             {"intercept": linreg(flat, 20)["intercept"]}),
        case("T21", {"period": 20}, ["r2"], {"r2": linreg(flat, 20)["r2"]}),
        case("T22", {"period": 20}, ["slope"], {"slope": linreg(flat, 20)["slope"]}),
        case("M06", {"fast": 12, "slow": 26, "signal": 9},
             ["dif", "dea", "hist"], macd(flat, 12, 26, 9)),
        case("E13", {"period1": 6, "period2": 12, "period3": 24},
             ["bias6", "bias12", "bias24"],
             {"bias6": bias(flat, 6), "bias12": bias(flat, 12),
              "bias24": bias(flat, 24)}),
    ]
    write("edge_constant_series.json",
          suite("edge_constant_series", 0, 40, flat, constant))

    zeros = [0.0] * 40
    zero_bias = [
        case("E13", {"period1": 6, "period2": 12, "period3": 24},
             ["bias6", "bias12", "bias24"],
             {"bias6": bias(zeros, 6), "bias12": bias(zeros, 12),
              "bias24": bias(zeros, 24)}),
    ]
    write("edge_bias_zero_mean.json",
          suite("edge_bias_zero_mean", 0, 40, zeros, zero_bias))

    one = [100.0]
    first_bar = [
        case("T01", {"period": 20}, ["sma"], {"sma": sma(one, 20)}),
        case("T02", {"period": 20}, ["ema"], {"ema": ema(one, 20)}),
        case("T03", {"period": 20}, ["wma"], {"wma": wma(one, 20)}),
        case("T04", {"period": 20}, ["dema"], {"dema": dema(one, 20)}),
        case("T05", {"period": 20}, ["tema"], {"tema": tema(one, 20)}),
        case("T19", {"period": 20}, ["forecast"],
             {"forecast": linreg(one, 20)["forecast"]}),
        case("T20", {"period": 20}, ["intercept"],
             {"intercept": linreg(one, 20)["intercept"]}),
        case("T21", {"period": 20}, ["r2"], {"r2": linreg(one, 20)["r2"]}),
        case("T22", {"period": 20}, ["slope"], {"slope": linreg(one, 20)["slope"]}),
        case("E13", {"period1": 6, "period2": 12, "period3": 24},
             ["bias6", "bias12", "bias24"],
             {"bias6": bias(one, 6), "bias12": bias(one, 12),
              "bias24": bias(one, 24)}),
        case("M06", {"fast": 12, "slow": 26, "signal": 9},
             ["dif", "dea", "hist"], macd(one, 12, 26, 9), "absolute:1e-4"),
    ]
    write("edge_first_bar.json",
          suite("edge_first_bar", 0, 1, one, first_bar))

    # 非平凡手算对拍：close = [1,2,4,5,8]（非常数、非线性），period=5。
    # 推导（见 manual_regression_notes.md）：
    #   x̄=2, ȳ=4, Sxx=10, Sxy=17, Syy=30
    #   slope=17/10=1.7；intercept=4-1.7*2=0.6；forecast(x=4)=0.6+1.7*4=7.4
    #   R²=17²/(10*30)=289/300=0.963333333...
    nonlinear = [1.0, 2.0, 4.0, 5.0, 8.0]
    tail = lambda value: [NAN, NAN, NAN, NAN, value]
    manual = [
        case("T19", {"period": 5}, ["forecast"],
             {"forecast": tail(7.4)}, "absolute:1e-9"),
        case("T20", {"period": 5}, ["intercept"],
             {"intercept": tail(0.6)}, "absolute:1e-9"),
        case("T21", {"period": 5}, ["r2"],
             {"r2": tail(289.0 / 300.0)}, "absolute:1e-9"),
        case("T22", {"period": 5}, ["slope"],
             {"slope": tail(1.7)}, "absolute:1e-9"),
    ]
    write("edge_manual_nonlinear.json",
          suite("edge_manual_nonlinear", 0, 5, nonlinear, manual))

    # 等差序列手算（BA 裁定 §4 表 #6）：close = 10.00 + 0.15·k（k=0..19），period=20。
    # x̄=9.5、ȳ=11.425、b=0.15、a=10.00、forecast(x=19)=12.85、R²=1.0。
    arithmetic = [10.00 + 0.15 * k for k in range(20)]
    last_only = lambda n, value: [NAN] * (n - 1) + [value]
    arithmetic_cases = [
        case("T19", {"period": 20}, ["forecast"], {"forecast": last_only(20, 12.85)}),
        case("T20", {"period": 20}, ["intercept"], {"intercept": last_only(20, 10.00)}),
        case("T21", {"period": 20}, ["r2"], {"r2": last_only(20, 1.0)}),
        case("T22", {"period": 20}, ["slope"], {"slope": last_only(20, 0.15)}),
    ]
    write("edge_arithmetic_regression.json",
          suite("edge_arithmetic_regression", 0, 20, arithmetic, arithmetic_cases))

    # T21 常数窗口（BA 裁定 §4 表 #7）：前 20 根线性、后 20 根恒为 9.0。
    # 第 39 根窗口全常数 → Syy=0 → R² 定义为 1.0（manifest notes / 口径页一致）。
    jumpy = [10.0 + 0.1 * k for k in range(20)] + [9.0] * 20
    write("edge_t21_constant_window.json",
          suite("edge_t21_constant_window", 0, 40, jumpy,
                [case("T21", {"period": 20}, ["r2"], {"r2": linreg(jumpy, 20)["r2"]})]))

    # ----------------------------- B2 夹具 -----------------------------
    write("base_b2_channel_seed42_520.json",
          suite_ohlc("base_b2_channel_seed42_520", 42, data, b2_cases(data)))

    # 常数 OHLC：H=L=O=C=10；验证零带宽、零振幅、零 ATR 的退化口径。
    flat_bars = 40
    flat_data = {
        "open": [10.0] * flat_bars, "high": [10.0] * flat_bars,
        "low": [10.0] * flat_bars, "close": [10.0] * flat_bars,
        "volume": [0.0] * flat_bars, "amount": [0.0] * flat_bars,
    }
    write("edge_b2_constant_ohlc.json",
          suite_ohlc("edge_b2_constant_ohlc", 0, flat_data, b2_cases(flat_data)))

    # 首根：1 根 K 线；仅 V09（H-L）当根有效，其余全部 NaN。
    first_data = {
        "open": [100.0], "high": [101.0], "low": [99.0], "close": [100.0],
        "volume": [0.0], "amount": [0.0],
    }
    first_cases = b2_cases({**first_data,
                            "open": [100.0], "high": [101.0], "low": [99.0],
                            "close": [100.0]})
    write("edge_b2_first_bar.json",
          suite_ohlc("edge_b2_first_bar", 0, first_data, first_cases))

    # 预热不足：20 根数据 + 周期 60（T15 默认需 78 根），周期驱动类全 NaN。
    short_b2 = build_input(20, 7)
    insufficient_b2 = [
        case("T08", {"period": 60, "pct": 2.5}, ["upper", "middle", "lower"],
             envelopes(short_b2["close"], 60, 2.5)),
        case("T09", {"period": 60, "mult": 2.0}, ["upper", "middle", "lower"],
             boll(short_b2["close"], 60, 2.0)),
        case("T10", {"period": 60, "mult": 2.0}, ["upper", "middle", "lower"],
             keltner(short_b2["close"], short_b2["high"], short_b2["low"], 60, 2.0)),
        case("T11", {"period": 60}, ["upper", "lower"],
             {"upper": rolling_max(short_b2["high"], 60),
              "lower": rolling_min(short_b2["low"], 60)}),
        case("T12", {"period": 60, "mult": 2.0}, ["upper", "middle", "lower"],
             atr_bands(short_b2["close"], short_b2["high"], short_b2["low"], 60, 2.0)),
        case("T13", {"period": 60, "mult": 3.5}, ["long", "short"],
             atr_trail(short_b2["close"], short_b2["high"], short_b2["low"], 60, 3.5)),
        case("T14", {"period": 60, "mult": 3.0}, ["long", "short"],
             chandelier(short_b2["close"], short_b2["high"], short_b2["low"], 60, 3.0)),
        case("T15", {"tenkan": 9, "kijun": 26, "senkou": 52, "displacement": 26},
             ["tenkan", "kijun", "senkouA", "senkouB", "chikou"],
             ichimoku(short_b2["close"], short_b2["high"], short_b2["low"], 9, 26, 52, 26)),
        case("T24", {"period": 60}, ["hhv", "llv"],
             {"hhv": rolling_max(short_b2["high"], 60),
              "llv": rolling_min(short_b2["low"], 60)}),
        case("V01", {"period": 60}, ["atr"],
             {"atr": atr(short_b2["high"], short_b2["low"], short_b2["close"], 60)}),
        case("V02", {"period": 60}, ["atrp"],
             {"atrp": [NAN] * len(short_b2["close"])}),
        case("V03", {"period": 60}, ["std"],
             {"std": rolling_std(short_b2["close"], 60)}),
        case("V04", {"period": 60, "mult": 2.0}, ["width"],
             {"width": bb_width(short_b2["close"], 60, 2.0)}),
        case("V05", {"period": 60, "mult": 2.0}, ["percentB"],
             {"percentB": percent_b(short_b2["close"], 60, 2.0)}),
        case("V07", {"period": 60}, ["ulcer"], {"ulcer": ulcer(short_b2["close"], 60)}),
        case("V08", {"period": 60}, ["gapo"],
             {"gapo": gapo(short_b2["open"], short_b2["close"],
                           short_b2["high"], short_b2["low"], 60)}),
    ]
    write("edge_b2_insufficient.json",
          suite_ohlc("edge_b2_insufficient", 7, short_b2, insufficient_b2))


if __name__ == "__main__":
    main()
