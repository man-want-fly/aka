#!/usr/bin/env bash
# 取证并归档：当次 evidence JSON + meta 一起落到 docs/qa/evidence/（W-41 第 2 项）。
# 用法：scripts/diag-evidence.sh watchlist|s0602
# 前置：app/ 根目录执行 npm run build 与 cargo build --release -p aka-desktop --features tauri/custom-protocol
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIAG_DIR="$HOME/Library/Application Support/aka/diag"
OUT="$APP_DIR/../docs/qa/evidence"
DB="$HOME/Library/Application Support/aka/state.db"
SUITE="${1:?用法: scripts/diag-evidence.sh watchlist|s0602}"
LABEL="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT" "$DIAG_DIR"

pkill -f "target/release/aka-desktop" 2>/dev/null || true
sleep 1

BAK=""
restore_db() {
  if [ -n "$BAK" ] && [ -f "$BAK" ]; then
    rm -f "$DB-wal" "$DB-shm"
    cp "$BAK" "$DB"
    echo "state.db 已还原：$BAK"
  fi
}

case "$SUITE" in
  watchlist)
    TARGET="watchlist@$LABEL"
    JSON="$DIAG_DIR/s0102-watchlist-evidence.json"
    NAME="s0102-watchlist-evidence"
    FIXTURE="state.db 直插 497 条 SEED0000.SZ~SEED0496.SZ（group_name=NULL，其中 SEED0000.SZ 不在数据集）；连同套件早前入集的 TINY 行共 498，取证后 sqlite3 .backup 还原，产品代码未改动"
    BAK="/tmp/aka-state-watchlist-$LABEL.db"
    sqlite3 "$DB" ".backup '$BAK'"
    python3 - "$DB" <<'PY'
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.execute("PRAGMA foreign_keys=ON")
rows = [(f"SEED{i:04d}.SZ", None, i, 1700000000 + i) for i in range(497)]
conn.executemany(
    "INSERT OR REPLACE INTO watchlist_items(security, group_name, sort_order, added_at) VALUES (?,?,?,?)",
    rows,
)
conn.commit()
print(f"fixture 已注入 {len(rows)} 条 SEED 标的")
PY
    ;;
  s0602)
    TARGET="s0602"
    JSON="$DIAG_DIR/s0602-display-evidence.json"
    NAME="s0602-display-evidence"
    FIXTURE="默认 state.db；自选为空时直插 1 条 600519.SH 供自选行高取证；取证后 sqlite3 .backup 还原，产品代码未改动"
    BAK="/tmp/aka-state-s0602-$LABEL.db"
    sqlite3 "$DB" ".backup '$BAK'"
    python3 - "$DB" <<'PY'
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
count = conn.execute("SELECT COUNT(*) FROM watchlist_items").fetchone()[0]
if count == 0:
    conn.execute(
        "INSERT OR REPLACE INTO watchlist_items(security, group_name, sort_order, added_at) VALUES (?,?,?,?)",
        ("600519.SH", None, 0, 1700000000),
    )
    conn.commit()
    print("fixture 已注入 1 条 600519.SH")
else:
    print(f"自选已有 {count} 条，无需注入")
PY
    ;;
  *)
    echo "未知套件：$SUITE" >&2
    exit 2
    ;;
esac

before=0
if [ -f "$JSON" ]; then before=$(stat -f %m "$JSON"); fi

AKA_DIAG=1 AKA_DIAG_TARGET="$TARGET" "$APP_DIR/target/release/aka-desktop" &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; sleep 1; restore_db' EXIT

ARCHIVED=0
for _ in $(seq 1 240); do
  if [ -f "$JSON" ] && [ "$(stat -f %m "$JSON")" -gt "$before" ]; then
    sleep 1
    cp "$JSON" "$OUT/$NAME.json"
    ARCHIVED=1
    break
  fi
  sleep 1
done

if [ "$ARCHIVED" -ne 1 ]; then
  echo "超时：240 秒内未生成新的 $JSON" >&2
  exit 1
fi

SCAN_FILE=""
SCAN_RC=""
if [ "$SUITE" = "s0602" ]; then
  SCAN_FILE="$OUT/number-format-scan.txt"
  if (cd "$APP_DIR" && node scripts/verify-number-format.mjs > "$SCAN_FILE" 2>&1); then
    SCAN_RC=0
  else
    SCAN_RC=$?
  fi
  cat "$SCAN_FILE"
fi

python3 - "$OUT/$NAME.json" "$OUT/$NAME-meta.json" "$LABEL" "$TARGET" "$FIXTURE" "$SCAN_FILE" "$SCAN_RC" <<'PY'
import json, subprocess, sys, datetime, hashlib
evidence_path, meta_path, label, target, fixture, scan_file, scan_rc = sys.argv[1:8]
d = json.load(open(evidence_path))
root = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
base = subprocess.check_output(["git", "-C", root, "rev-parse", "HEAD"], text=True).strip()
diff = subprocess.check_output(
    ["git", "-C", root, "diff", "-U3", "--", "app/src", "app/scripts", "app/package.json"], text=True
)
dirty = bool(diff.strip())
patch = f"sha256:{hashlib.sha256(diff.encode()).hexdigest()}" if dirty else None
now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(timespec="seconds")
meta = {
    "suite": d.get("suite", ""),
    "label": label,
    "runAt": now,
    "base": base,
    "dirty": dirty,
    "patch": patch,
    "command": f"AKA_DIAG=1 AKA_DIAG_TARGET=\"{target}\" target/release/aka-desktop",
    "fixture": fixture,
    "environment": "macOS 本机；vite build 产物 + cargo release --features tauri/custom-protocol",
    "formatScan": (
        {
            "command": "npm run verify:format",
            "exitCode": int(scan_rc),
            "output": open(scan_file, encoding="utf-8").read().strip().splitlines(),
        }
        if scan_file
        else None
    ),
    "result": {"ok": d.get("ok"), "layers": d.get("layers", {}), "blocked": d.get("blocked", [])},
}
json.dump(meta, open(meta_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"已归档：{evidence_path}")
print(f"已归档：{meta_path}")
print(f"ok={d.get('ok')} layers={d.get('layers')} blocked={len(d.get('blocked', []))} scan={scan_rc or 0}")
sys.exit(0 if d.get("ok") and (not scan_rc or int(scan_rc) == 0) else 2)
PY
