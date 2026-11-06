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


def case(indicator_id, params, outputs, expected, tolerance="relative:1e-6"):
    return {"indicatorId": indicator_id, "params": params, "outputs": outputs,
            "tolerance": tolerance,
            "expected": {key: [roundv(v) for v in column]
                         for key, column in expected.items()}}


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
            "input": {"open": flat, "high": flat, "low": flat,
                      "close": closes, "volume": volume,
                      "amount": [0.0] * bars},
            "cases": cases}


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


if __name__ == "__main__":
    main()
