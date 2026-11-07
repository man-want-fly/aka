#!/usr/bin/env bash
# 取证并归档：当次 evidence JSON + meta 一起落到 docs/qa/evidence/（W-41 第 2 项）。
# 用法：scripts/diag-evidence.sh watchlist|watchlist-empty|watchlist-corrupt|watchlist-readonly|s0602|star|s080204
# 前置：app/ 根目录执行 npm run build 与 cargo build -p aka-desktop --features tauri/custom-protocol
# 取证必须用 debug 构建：QA 注入开关在 release 里已整体编译掉（W-47）。
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_BIN="$APP_DIR/target/debug/aka-desktop"
DIAG_DIR="$HOME/Library/Application Support/aka/diag"
TELEMETRY="$HOME/Library/Application Support/aka/logs/telemetry.jsonl"
OUT="$APP_DIR/../docs/qa/evidence"
DB="$HOME/Library/Application Support/aka/state.db"
SUITE="${1:?用法: scripts/diag-evidence.sh watchlist|watchlist-empty|watchlist-corrupt|watchlist-readonly|s0602|star|s080204}"
LABEL="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT" "$DIAG_DIR"
FLAGS=""
EXTRA_ENV=""

pkill -f "target/debug/aka-desktop" 2>/dev/null || true
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
  watchlist-empty)
    TARGET="watchlist-empty@$LABEL"
    JSON="$DIAG_DIR/s0102-watchlist-empty-evidence.json"
    NAME="s0102-watchlist-empty-evidence"
    FLAGS="--empty-dataset"
    FIXTURE="state.db 直插 30 条 EMPTY000.SZ~EMPTY029.SZ（group_name=NULL）；启动带 --empty-dataset 让 list_securities 返回 0 只；取证后 .backup 还原"
    BAK="/tmp/aka-state-watchlist-empty-$LABEL.db"
    sqlite3 "$DB" ".backup '$BAK'"
    python3 - "$DB" <<'PY'
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.execute("DELETE FROM watchlist_items")
rows = [(f"EMPTY{i:03d}.SZ", None, i, 1700000000 + i) for i in range(30)]
conn.executemany(
    "INSERT OR REPLACE INTO watchlist_items(security, group_name, sort_order, added_at) VALUES (?,?,?,?)",
    rows,
)
conn.commit()
print(f"fixture 已注入 {len(rows)} 条 EMPTY 标的")
PY
    ;;
  watchlist-corrupt)
    TARGET="watchlist-corrupt@$LABEL"
    JSON="$DIAG_DIR/s0102-watchlist-corrupt-evidence.json"
    NAME="s0102-watchlist-corrupt-evidence"
    FLAGS="--corrupt-db"
    FIXTURE="启动带 --corrupt-db：真实库复制到临时目录并留 state.db.orig，只在副本写坏；真实 state.db 不动"
    BAK=""
    ;;
  watchlist-readonly)
    TARGET="watchlist-readonly@$LABEL"
    JSON="$DIAG_DIR/s0102-watchlist-readonly-evidence.json"
    NAME="s0102-watchlist-readonly-evidence"
    FLAGS="--readonly-db"
    FIXTURE="启动带 --readonly-db（PRAGMA query_only=ON）；直插分组「诊断只读组」6 只标的 + 「诊断只读移出」1 条；取证后 .backup 还原"
    BAK="/tmp/aka-state-watchlist-readonly-$LABEL.db"
    sqlite3 "$DB" ".backup '$BAK'"
    python3 - "$DB" <<'PY'
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.execute("PRAGMA foreign_keys=ON")
conn.execute("DELETE FROM watchlist_items")
conn.execute("DELETE FROM watchlist_groups WHERE is_builtin = 0")
conn.execute(
    "INSERT OR REPLACE INTO watchlist_groups(name, sort_order, is_builtin, created_at) VALUES (?,?,?,?)",
    ("诊断只读组", 0, 0, 0),
)
rows = [(f"RDO{i:03d}.SZ", "诊断只读组", i, 1700000000 + i) for i in range(6)]
rows.append(("诊断只读移出", None, 0, 1700000000))
conn.executemany(
    "INSERT OR REPLACE INTO watchlist_items(security, group_name, sort_order, added_at) VALUES (?,?,?,?)",
    rows,
)
conn.commit()
print(f"fixture 已注入 {len(rows)} 条只读标的（组内 6 + 待移出 1）")
PY
    ;;
  s080204)
    TARGET="s080204"
    JSON="$DIAG_DIR/s080204-evidence.json"
    NAME="s080204-evidence"
    FIXTURE="默认 state.db；AKA_DIAG_INF=1 把工作台首实例（T01）窗口末值注入 +∞，验证 Infinity→「—」且日志记 E_INDEFINITE；只读行情/目录/工作台，不改库"
    BAK=""
    export AKA_DIAG_INF=1
    EXTRA_ENV="AKA_DIAG_INF=1"
    ;;
  star)
    TARGET="s010201"
    JSON="$DIAG_DIR/s010201-star-evidence.json"
    NAME="s010201-star-evidence"
    FIXTURE="默认 state.db；行情页星标套件自行加入/移出并清理；取证后 .backup 还原"
    BAK="/tmp/aka-state-star-$LABEL.db"
    sqlite3 "$DB" ".backup '$BAK'"
    ;;
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

AKA_DIAG=1 AKA_DIAG_TARGET="$TARGET" "$APP_BIN" $FLAGS &
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

# W-48：页面 trace id 必须能在 telemetry.jsonl 里查到，否则「可查」只是页面装饰。
if [ "$SUITE" = "watchlist-corrupt" ]; then
  python3 - "$OUT/$NAME.json" "$TELEMETRY" <<'PY'
import json, pathlib, re, sys

evidence_path, telemetry_path = sys.argv[1:3]
data = json.load(open(evidence_path, encoding="utf-8"))
page_ids = sorted(
    set(re.findall(r"TR-\d{8}-\d{6}-\d{4}", json.dumps(data, ensure_ascii=False)))
)
log_path = pathlib.Path(telemetry_path)
log = log_path.read_text(encoding="utf-8") if log_path.exists() else ""
hit = [item for item in page_ids if item in log]
data.setdefault("checks", []).append(
    {
        "id": "WL-23-log",
        "card": "S-01.02-03",
        "ac": "AC-01.02-04（补3）",
        "layer": "data",
        "passed": bool(hit),
        "blocked": False,
        "detail": (
            f"页面 trace id {hit[0]} ∈ telemetry.jsonl"
            if hit
            else f"页面 trace id {page_ids or '无'} 未命中 {log_path}"
        ),
    }
)
layers = {}
for check in data["checks"]:
    total, passed = layers.get(check["layer"], (0, 0))
    layers[check["layer"]] = (total + 1, passed + (1 if check["passed"] else 0))
data["layers"] = {key: f"{passed}/{total}" for key, (total, passed) in layers.items()}
data["ok"] = all(check["passed"] for check in data["checks"])
json.dump(data, open(evidence_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"WL-23-log passed={bool(hit)} ids={page_ids}")
PY
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

python3 - "$OUT/$NAME.json" "$OUT/$NAME-meta.json" "$LABEL" "$TARGET" "$FIXTURE" "$SCAN_FILE" "$SCAN_RC" "$FLAGS" "$EXTRA_ENV" <<'PY'
import json, subprocess, sys, datetime
evidence_path, meta_path, label, target, fixture, scan_file, scan_rc, flags, extra_env = sys.argv[1:10]
d = json.load(open(evidence_path))
root = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
commit = subprocess.check_output(["git", "-C", root, "rev-parse", "HEAD"], text=True).strip()
status = subprocess.check_output(
    ["git", "-C", root, "status", "--porcelain", "--", "app"], text=True
)
dirty = bool(status.strip())
now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(timespec="seconds")
meta = {
    "suite": d.get("suite", ""),
    "label": label,
    "runAt": now,
    "commit": commit,
    "dirty": dirty,
    "command": f"AKA_DIAG=1 AKA_DIAG_TARGET=\"{target}\" {extra_env} target/debug/aka-desktop {flags}".replace("  ", " ").strip(),
    "fixture": fixture,
    "environment": "macOS 本机；vite build 产物 + cargo build（debug，含 QA 注入）--features tauri/custom-protocol",
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
print(f"ok={d.get('ok')} layers={d.get('layers')} blocked={len(d.get('blocked', []))} commit={commit} dirty={dirty}")
sys.exit(0 if d.get("ok") and (not scan_rc or int(scan_rc) == 0) else 2)
PY
