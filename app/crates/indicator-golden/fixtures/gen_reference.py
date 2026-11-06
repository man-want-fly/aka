#!/usr/bin/env python3
"""黄金夹具参考值生成器（S0 / T-03）。

只用公开公式手算，不调用 Rust 引擎；生成后的 JSON 作为固定基线提交。
运行：python3 crates/indicator-golden/fixtures/gen_reference.py
"""
import json
import math
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


def roundv(x):
    return None if x is None else round(x, 6)


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


def case(indicator_id, params, outputs, tolerance="relative:1e-6"):
    entry = {"indicatorId": indicator_id, "params": params,
             "outputs": outputs, "tolerance": tolerance, "expected": {}}
    return entry


def write(name, payload):
    path = os.path.join(HERE, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    print("wrote", path)


def main():
    data = build_input(520, 42)
    closes = data["close"]
    cases = []
    for ma_type in ("sma", "ema", "wma"):
        fn = {"sma": sma, "ema": ema, "wma": wma}[ma_type](closes, 20)
        entry = case("ma", {"period": 20, "maType": ma_type}, ["ma"])
        entry["expected"] = {"ma": [roundv(v) for v in fn]}
        cases.append(entry)
    entry = case("macd", {"fast": 12, "slow": 26, "signal": 9},
                 ["dif", "dea", "hist"], "absolute:1e-4")
    entry["expected"] = {k: [roundv(v) for v in col]
                         for k, col in macd(closes, 12, 26, 9).items()}
    cases.append(entry)
    write("ma_macd_seed42_520.json", {
        "formatVersion": 1, "name": "ma_macd_seed42_520", "seed": 42,
        "bars": 520, "input": data, "cases": cases,
    })

    flat = [10.0] * 40
    entry = case("ma", {"period": 20, "maType": "sma"}, ["ma"])
    entry["expected"] = {"ma": [roundv(v) for v in sma(flat, 20)]}
    write("edge_ma_constant.json", {
        "formatVersion": 1, "name": "edge_ma_constant", "seed": 0, "bars": 40,
        "input": {"open": flat, "high": flat, "low": flat,
                  "close": flat, "volume": [0.0] * 40, "amount": [0.0] * 40},
        "cases": [entry],
    })

    zeros = [0.0] * 40
    entry = case("ma", {"period": 20, "maType": "sma"}, ["ma"])
    entry["expected"] = {"ma": [roundv(v) for v in sma(zeros, 20)]}
    write("edge_ma_all_zero.json", {
        "formatVersion": 1, "name": "edge_ma_all_zero", "seed": 0, "bars": 40,
        "input": {"open": zeros, "high": zeros, "low": zeros,
                  "close": zeros, "volume": [0.0] * 40, "amount": [0.0] * 40},
        "cases": [entry],
    })

    short = [100.0 + i for i in range(20)]
    entry = case("ma", {"period": 60, "maType": "sma"}, ["ma"])
    entry["expected"] = {"ma": [NAN] * 20}
    write("edge_ma_insufficient.json", {
        "formatVersion": 1, "name": "edge_ma_insufficient", "seed": 0, "bars": 20,
        "input": {"open": short, "high": short, "low": short,
                  "close": short, "volume": [0.0] * 20, "amount": [0.0] * 20},
        "cases": [entry],
    })

    one = [100.0]
    entry = case("macd", {"fast": 12, "slow": 26, "signal": 9},
                 ["dif", "dea", "hist"], "absolute:1e-4")
    entry["expected"] = {"dif": [NAN], "dea": [NAN], "hist": [NAN]}
    write("edge_macd_single_bar.json", {
        "formatVersion": 1, "name": "edge_macd_single_bar", "seed": 0, "bars": 1,
        "input": {"open": one, "high": one, "low": one,
                  "close": one, "volume": [0.0], "amount": [0.0]},
        "cases": [entry],
    })


if __name__ == "__main__":
    main()
