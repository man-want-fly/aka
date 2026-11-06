#!/usr/bin/env bash
# 可重复执行：跑一次 S2 实机取证（内含 T09 反向负控），把 JSON 归档到 docs/qa/evidence/。
# 用法：scripts/diag-run.sh [标签]   # 默认标签=当天日期
# 前置：app/ 根目录执行
#   npm run build
#   cargo build --release -p aka-desktop --features tauri/custom-protocol
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIAG_DIR="$HOME/Library/Application Support/aka/diag"
JSON="$DIAG_DIR/s2-evidence.json"
LABEL="${1:-$(date +%Y%m%d)}"
OUT="$APP_DIR/../docs/qa/evidence"
mkdir -p "$OUT" "$DIAG_DIR"

before=0
if [ -f "$JSON" ]; then before=$(stat -f %m "$JSON"); fi

AKA_DIAG=1 AKA_DIAG_TARGET=s2 "$APP_DIR/target/release/aka-desktop" &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 180); do
  if [ -f "$JSON" ] && [ "$(stat -f %m "$JSON")" -gt "$before" ]; then
    # 落盘可能分两次写，等一拍再归档
    sleep 1
    cp "$JSON" "$OUT/s2-evidence-$LABEL.json"
    echo "已归档：$OUT/s2-evidence-$LABEL.json"
    # T09 反向负控是取证的一部分：每轮必须真的跑过且判红，缺一条就说明断言可能恒真。
    python3 - "$OUT/s2-evidence-$LABEL.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
clauses = [c for card in d["verification"]["b2Render"]["cards"] for c in card["clauses"]]
needed = ["T09 负控：错误虚实值必须被判红", "T09 负控：旧线值必须被判残留", "T09 负控：回切未重绘（仍显示 B 线）必须被判红"]
missing = [n for n in needed if not any(c["clause"] == n and c["status"] == "pass" for c in clauses)]
print("T09 负控：%d/%d 通过" % (len(needed) - len(missing), len(needed)))
if missing:
    print("缺失或未通过：" + "；".join(missing), file=sys.stderr)
    sys.exit(2)
w = d.get("warm", {})
print("热切回：样本 %s / 批 %s / max %sms / 判定 %s" % (
    w.get("sampleCount"), w.get("batchCount"), w.get("maxTotalMs"),
    "达标" if (w.get("maxTotalMs") or 999) <= 120 else "未达标"))
PY
    exit 0
  fi
  sleep 1
done

echo "超时：180 秒内未生成新的 s2-evidence.json（检查「自证状态」是否已跑完）" >&2
exit 1
