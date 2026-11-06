#!/usr/bin/env python3
"""周/月聚合独立对拍（TD-S0-01 证据）。

读取 `bench/aggregates/daily-<code>.csv`，用 Python 标准库 `date.isocalendar()` 重新分组，
生成 weekly/monthly 期望值并与 Rust 导出 CSV 逐行比对。Python 与 Rust 聚合实现互不共享代码。

用法：python3 tools/verify_aggregates.py
退出码 0 = 全部一致；1 = 存在差异（打印前 10 条）。
"""
import csv
import json
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BENCH = ROOT / "bench" / "aggregates"
PRICE_TOL = 1e-9
AMOUNT_TOL = 0.011
VOLUME_TOL = 1e-6


def rows(path):
    with path.open(newline="") as fh:
        for raw in csv.DictReader(fh):
            yield {
                "date": date.fromisoformat(raw["date"]),
                "open": float(raw["open"]),
                "high": float(raw["high"]),
                "low": float(raw["low"]),
                "close": float(raw["close"]),
                "volume": float(raw["volume"]),
                "amount": float(raw["amount"]),
            }


def aggregate(source, period):
    groups = []
    current_key = None
    for row in source:
        if period == "W":
            iso = row["date"].isocalendar()
            key = (iso[0], iso[1])
        else:
            key = (row["date"].year, row["date"].month)
        if key != current_key:
            current_key = key
            groups.append(dict(row))
        else:
            bar = groups[-1]
            bar["date"] = row["date"]
            bar["high"] = max(bar["high"], row["high"])
            bar["low"] = min(bar["low"], row["low"])
            bar["close"] = row["close"]
            bar["volume"] += row["volume"]
            bar["amount"] += row["amount"]
    return groups


def compare(code, period, expected, actual_path):
    actual = list(rows(actual_path))
    problems = []
    if len(expected) != len(actual):
        problems.append(f"{code} {period}: 根数 {len(expected)} vs {len(actual)}")
    for index, (want, got) in enumerate(zip(expected, actual)):
        if want["date"] != got["date"]:
            problems.append(f"{code} {period} #{index}: date {want['date']} vs {got['date']}")
            continue
        for field in ("open", "high", "low", "close"):
            if abs(want[field] - got[field]) > PRICE_TOL:
                problems.append(f"{code} {period} #{index}: {field} {want[field]} vs {got[field]}")
        if abs(want["volume"] - got["volume"]) > VOLUME_TOL:
            problems.append(f"{code} {period} #{index}: volume {want['volume']} vs {got['volume']}")
        if abs(want["amount"] - got["amount"]) > AMOUNT_TOL:
            problems.append(f"{code} {period} #{index}: amount {want['amount']} vs {got['amount']}")
    return len(expected), problems


def main():
    report = {"formatVersion": 1, "comparator": "python3 tools/verify_aggregates.py", "codes": []}
    failed = False
    for daily_path in sorted(BENCH.glob("daily-*.csv")):
        code = daily_path.stem.replace("daily-", "")
        source = list(rows(daily_path))
        entry = {"security": code, "dailyBars": len(source)}
        for period, suffix in (("W", "weekly"), ("M", "monthly")):
            expected = aggregate(source, period)
            count, problems = compare(code, suffix, expected, BENCH / f"{suffix}-{code}.csv")
            entry[f"{suffix}Bars"] = count
            entry[f"{suffix}Mismatches"] = len(problems)
            if problems:
                failed = True
                print("\n".join(problems[:10]))
        report["codes"].append(entry)
        print(
            f"{code}: D={entry['dailyBars']} W={entry['weeklyBars']}(mismatch {entry['weeklyMismatches']}) "
            f"M={entry['monthlyBars']}(mismatch {entry['monthlyMismatches']})"
        )

    report["result"] = "failed" if failed else "passed"
    (BENCH / "compare-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(f"compare-report: {BENCH / 'compare-report.json'} → {report['result']}")
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
