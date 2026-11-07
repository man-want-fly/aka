#!/usr/bin/env python3
"""S-02.07-01：周线/月线上的指标逐点独立复算。

输入是前端实机取证落盘的 `s207-wm-series.json`（D/W/M 的 bars + 12 个指标实例的 series）。
本脚本不复用 Rust 实现，也不复用前端实现：

1. 用日线按 ISO 周 / 自然月重聚合，与后端返回的周线/月线逐根比对（开高低收/量/额/日期）；
2. 用 indicator-golden 的 Python 参考公式从 W/M 的源码序列重算指标，与前端收到的 series 逐点比对；
3. 逐点比对每个指标的数值（参考实现的全段 NaN 是合法结果：月线 24 根不足以过观察期）。

任何一项超容差 → 退出码 1。报告写到 `bench/wm-indicators/compare-report.json`。
"""

import argparse
import importlib.util
import json
import math
import os
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REFERENCE_PATH = ROOT / "crates" / "indicator-golden" / "fixtures" / "gen_reference.py"
DEFAULT_DUMP = Path(
    os.path.expanduser("~/Library/Application Support/aka/diag/s207-wm-series.json")
)
REPORT_PATH = ROOT / "bench" / "wm-indicators" / "compare-report.json"

PRICE_TOL = 1e-9
VOLUME_TOL = 1e-6
AMOUNT_TOL = 0.011

# 与 gen_reference 的 TOLERANCE_BY_INDICATOR 对齐
ABS_TOL = {"E13": 1e-4, "M06": 1e-4, "V08": 1e-4, "T21": 1e-6}
REL_TOL = 1e-6


def load_reference():
    spec = importlib.util.spec_from_file_location("gen_reference", REFERENCE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def iso_key(value: date):
    iso = value.isocalendar()
    return (iso[0], iso[1])


def aggregate(source, period):
    """与 verify_aggregates 同规则：首日开、末日收、极值、量额累加。"""
    groups = []
    current_key = None
    for row in source:
        key = iso_key(row["date"]) if period == "W" else (row["date"].year, row["date"].month)
        if key != current_key:
            current_key = key
            groups.append(
                {
                    "date": row["date"],
                    "open": row["open"],
                    "high": row["high"],
                    "low": row["low"],
                    "close": row["close"],
                    "volume": row["volume"],
                    "amount": row["amount"],
                }
            )
        else:
            last = groups[-1]
            last["high"] = max(last["high"], row["high"])
            last["low"] = min(last["low"], row["low"])
            last["close"] = row["close"]
            last["volume"] += row["volume"]
            last["amount"] += row["amount"]
            last["date"] = row["date"]
    return groups


def as_rows(bars):
    return [
        {
            "date": date.fromisoformat(bar["date"]),
            "open": bar["open"],
            "high": bar["high"],
            "low": bar["low"],
            "close": bar["close"],
            "volume": bar["volume"],
            "amount": bar["amount"],
        }
        for bar in bars
    ]


def compare_bars(expected, actual):
    problems = []
    if len(expected) != len(actual):
        problems.append(f"根数 {len(expected)} vs {len(actual)}")
    max_price = 0.0
    max_volume = 0.0
    max_amount = 0.0
    for index, (want, got) in enumerate(zip(expected, actual)):
        if want["date"].isoformat() != got["date"]:
            problems.append(f"#{index} 日期 {want['date']} vs {got['date']}")
            continue
        for field in ("open", "high", "low", "close"):
            max_price = max(max_price, abs(want[field] - got[field]))
        max_volume = max(max_volume, abs(want["volume"] - got["volume"]))
        max_amount = max(max_amount, abs(want["amount"] - got["amount"]))
    if max_price > PRICE_TOL:
        problems.append(f"价格最大差 {max_price:.3e}")
    if max_volume > VOLUME_TOL:
        problems.append(f"量最大差 {max_volume:.3e}")
    if max_amount > AMOUNT_TOL:
        problems.append(f"额最大差 {max_amount:.3e}")
    return problems, max_price, max_volume, max_amount


def expected_series(ref, indicator_id, params, bars):
    """返回 {outputKey: values}；参数与 dump 里 instances 一致。"""
    closes = [bar["close"] for bar in bars]
    highs = [bar["high"] for bar in bars]
    lows = [bar["low"] for bar in bars]
    opens = [bar["open"] for bar in bars]
    period = params.get("period", 20)
    if indicator_id == "T01":
        return {"sma": ref.sma(closes, period)}
    if indicator_id == "T02":
        return {"ema": ref.ema(closes, period)}
    if indicator_id == "T03":
        return {"wma": ref.wma(closes, period)}
    if indicator_id == "T04":
        return {"dema": ref.dema(closes, period)}
    if indicator_id == "T05":
        return {"tema": ref.tema(closes, period)}
    if indicator_id in ("T19", "T20", "T21", "T22"):
        column = {"T19": "forecast", "T20": "intercept", "T21": "r2", "T22": "slope"}[indicator_id]
        return {column: ref.linreg(closes, period)[column]}
    if indicator_id == "E13":
        return {
            "bias6": ref.bias(closes, params["period1"]),
            "bias12": ref.bias(closes, params["period2"]),
            "bias24": ref.bias(closes, params["period3"]),
        }
    if indicator_id == "M06":
        return ref.macd(closes, params["fast"], params["slow"], params["signal"])
    if indicator_id == "V08":
        return {"gapo": ref.gapo(opens, closes, highs, lows, period)}
    raise KeyError(f"未覆盖指标 {indicator_id}")


def tolerance(indicator_id):
    absolute = ABS_TOL.get(indicator_id)
    if absolute is not None:
        return ("abs", absolute)
    return ("rel", REL_TOL)


def is_finite(value):
    """参考实现用 None 表示无效，前端用 null；统一按「非有限」处理。"""
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def compare_values(indicator_id, key, expected, actual):
    if len(expected) != len(actual):
        return [f"{key}: 长度 {len(expected)} vs {len(actual)}"], 0.0
    mode, limit = tolerance(indicator_id)
    mismatches = []
    max_diff = 0.0
    for index, (want, got) in enumerate(zip(expected, actual)):
        want_finite = is_finite(want)
        got_finite = is_finite(got)
        if not want_finite and not got_finite:
            continue
        if want_finite != got_finite:
            mismatches.append(f"#{index} 有效性 {want} vs {got}")
            continue
        diff = abs(want - got)
        max_diff = max(max_diff, diff)
        if mode == "abs":
            if diff > limit:
                mismatches.append(f"#{index} 差 {diff:.3e}")
        else:
            denom = max(abs(want), 1.0)
            if diff / denom > limit:
                mismatches.append(f"#{index} 相对差 {diff / denom:.3e}")
    return mismatches, max_diff


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dump", type=Path, default=DEFAULT_DUMP)
    args = parser.parse_args()

    if not args.dump.exists():
        print(f"找不到 dump：{args.dump}", file=sys.stderr)
        return 2
    dump = json.loads(args.dump.read_text())
    ref = load_reference()

    report = {
        "formatVersion": 1,
        "comparator": "python3 tools/verify_wm_indicators.py",
        "generatedAt": dump.get("generatedAt"),
        "dumpPath": str(args.dump),
        "codes": [],
        "ok": True,
    }

    for security, payload in dump["codes"].items():
        entry = {"security": security, "periods": {}}
        daily = as_rows(payload["bars"]["D"]["bars"])
        for period, label in (("W", "weekly"), ("M", "monthly")):
            bars = payload["bars"][period]["bars"]
            expected_bars = aggregate(daily, period)
            problems, max_price, max_volume, max_amount = compare_bars(expected_bars, bars)
            period_entry = {
                "bars": len(bars),
                "aggregateOk": not problems,
                "aggregateProblems": problems,
                "maxPriceDiff": max_price,
                "maxVolumeDiff": max_volume,
                "maxAmountDiff": max_amount,
                "series": [],
            }
            # 指标复算：用后端返回的 W/M bars（已与重聚合比对过）作为输入
            for item in payload["series"][period]:
                params = next(
                    (inst["params"] for inst in dump["instances"] if inst["indicatorId"] == item["indicatorId"]),
                    {},
                )
                expected = expected_series(ref, item["indicatorId"], params, bars)
                series_entry = {"indicatorId": item["indicatorId"], "outputs": []}
                for output in item["outputs"]:
                    key = output["key"]
                    if key not in expected:
                        series_entry["outputs"].append(
                            {"key": key, "ok": False, "problems": ["参考实现缺少该输出"]}
                        )
                        continue
                    mismatches, max_diff = compare_values(
                        item["indicatorId"], key, expected[key], output["values"]
                    )
                    finite = sum(1 for value in expected[key] if is_finite(value))
                    warmup_actual = item.get("warmup")
                    warmup_first_finite = next(
                        (i for i, value in enumerate(expected[key]) if is_finite(value)), -1
                    )
                    series_entry["outputs"].append(
                        {
                            "key": key,
                            "ok": not mismatches,
                            # 引擎 warmup 是 B1 建议观察期（EMA 3N、TEMA 4.5N），与参考实现的首个有效下标不同，
                            # 仅作信息记录，不作为失败判据（展示层按 warmup 裁剪）。
                            "warmup": warmup_actual,
                            "warmupFirstFinite": warmup_first_finite
                            if key == item["outputs"][0]["key"]
                            else None,
                            "finite": finite,
                            "maxDiff": max_diff,
                            "problems": mismatches[:5],
                        }
                    )
                entry["periods"].setdefault(label, period_entry)
                series_entry["ok"] = all(output["ok"] for output in series_entry["outputs"])
                period_entry["series"].append(series_entry)
            entry["periods"].setdefault(label, period_entry)
            # 兜底：aggregate 失败也算失败
            period_entry["ok"] = period_entry["aggregateOk"] and all(
                series["ok"] for series in period_entry["series"]
            )
            if not period_entry["ok"]:
                report["ok"] = False
        report["codes"].append(entry)

    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2))

    for entry in report["codes"]:
        for label, period in entry["periods"].items():
            failed = [series["indicatorId"] for series in period["series"] if not series["ok"]]
            total = len(period["series"])
            print(
                f"{entry['security']} {label}: {period['bars']} 根 · 聚合{'一致' if period['aggregateOk'] else '不一致'}"
                f" · 指标 {total - len(failed)}/{total} 通过{'' if not failed else ' · 失败: ' + ','.join(failed)}"
            )
            for series in period["series"]:
                for output in series["outputs"]:
                    if not output["ok"]:
                        print(
                            f"  ! {series['indicatorId']}.{output['key']} "
                            f"warmup {output.get('warmup')}（首个有效 {output.get('warmupFirstFinite')}）"
                            f" {'；'.join(output['problems'])}"
                        )
    print(f"报告：{REPORT_PATH}")
    print("PASS" if report["ok"] else "FAIL")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
