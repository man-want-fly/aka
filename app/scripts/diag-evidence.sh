#!/usr/bin/env bash
# 取证并归档：当次 evidence JSON + meta 一起落到 docs/qa/evidence/（W-41 第 2 项）。
# 用法：scripts/diag-evidence.sh watchlist|watchlist-empty|watchlist-corrupt|watchlist-readonly|s0602|star|s080204|market|s2|s070503
# 前置：app/ 根目录执行 npm run build 与 cargo build -p aka-desktop --features tauri/custom-protocol
# 取证必须用 debug 构建：QA 注入开关在 release 里已整体编译掉（W-47）。
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_BIN="$APP_DIR/target/debug/aka-desktop"
DIAG_DIR="$HOME/Library/Application Support/aka/diag"
TELEMETRY="$HOME/Library/Application Support/aka/logs/telemetry.jsonl"
# 证据根由 scripts/evidence-layout.json 单一提供（制度第 27 条）。
LAYOUT="$APP_DIR/scripts/evidence-layout.json"
EVIDENCE_REL="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1],encoding="utf-8"))["evidenceRoot"])' "$LAYOUT")"
OUT="$APP_DIR/../$EVIDENCE_REL"
DB="$HOME/Library/Application Support/aka/state.db"
SUITE="${1:?用法: scripts/diag-evidence.sh watchlist|watchlist-empty|watchlist-corrupt|watchlist-readonly|s0602|star|s080204|market}"
LABEL="$(date +%Y%m%d-%H%M%S)"
# 本次取证运行的起始时刻（epoch ms）：文件断言只认此时间窗之后落盘的文件，排除历史残档。
RUN_STARTED_MS="$(python3 -c 'import time; print(int(time.time()*1000))')"
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
  market)
    TARGET="market"
    JSON="$DIAG_DIR/e01-market-evidence.json"
    NAME="e01-market-evidence"
    FIXTURE="默认 state.db；E-01 行情套件（数据层 + 渲染层）直接打真实 DOM 与 state.db；只读，不改库"
    EXTRA_ENV="AKA_DIAG_NO_SAMPLES=1"
    BAK=""
    ;;
  s2)
    TARGET="s2"
    JSON="$DIAG_DIR/s2-evidence.json"
    NAME="s2-evidence"
    FIXTURE="默认固定批次（instances=50 = 1 主图均线 + 5 叠加 + 5 统计 + 1 M06 + 20 B2 + 13 B3 + 5 B1，skip=6）；冷/热各切 30/90 次标的；连键 1→12→120 与 1→12→60；只读行情，不改库"
    BAK=""
    ;;
  s070503)
    TARGET="s070503"
    JSON="$DIAG_DIR/s070503-evidence.json"
    NAME="s070503-evidence"
    FIXTURE="默认 state.db；debug 注入 DIAGPROV.SZ（40 根，末根清空 batch_id/ingested_at）与 DIAGSUSP.SZ（120 根，80~99 停牌）；点击 600519.SH/DIAGSUSP.SZ/DIAGPROV.SZ 三根 bar；只读行情，不改库"
    BAK=""
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
  s030104)
    TARGET="s030104"
    JSON="$DIAG_DIR/s030104-evidence.json"
    NAME="s030104-evidence"
    FIXTURE="默认 state.db；App 清空 aka.last.code 后验证无标的引导，再按「副图满仓 / 留出空位」两阶段验证容量、去重与规划项；只改 localStorage，不改库"
    BAK=""
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
  s060302)
    TARGET="s060302"
    JSON="$DIAG_DIR/s060302-evidence.json"
    NAME="s060302-evidence"
    FIXTURE="默认 state.db；自选注入 600519.SH 供隐私 grep 反证；关于页点导出，落 ~/Downloads/aka-diagnostics-*.zip；取证后 .backup 还原"
    BAK="/tmp/aka-state-s060302-$LABEL.db"
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
  s070102)
    TARGET="s070102"
    JSON="$DIAG_DIR/s070102-evidence.json"
    NAME="s070102-evidence"
    FIXTURE="默认 state.db；P9 健康检查全 PASS 路径 + tushare 0/4 禁用卡；只读，不改库"
    BAK=""
    ;;
  s070102-corrupt)
    TARGET="s070102"
    JSON="$DIAG_DIR/s070102-evidence.json"
    NAME="s070102-corrupt-evidence"
    FLAGS="--corrupt-manifest"
    FIXTURE="默认 state.db；--corrupt-manifest 注入 manifest 不可解析，验证 ②FAIL → ③~⑥SKIP（1/6）与「重建样本包」入口；只读"
    BAK=""
    ;;
  s080202)
    TARGET="s080202"
    JSON="$DIAG_DIR/s080202-evidence.json"
    NAME="s080202-evidence"
    FIXTURE="默认 state.db；工作台真实计算 + diag_set_inject 注入（panic×3 / data / timeout 8s），关闭注入后恢复；不改库"
    BAK=""
    ;;
  *)
    echo "未知套件：$SUITE" >&2
    exit 2
    ;;
esac

before=0
if [ -f "$JSON" ]; then before=$(stat -f %m "$JSON"); fi

AKA_DIAG=1 AKA_DIAG_TARGET="$TARGET" env $EXTRA_ENV "$APP_BIN" $FLAGS &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; sleep 1; restore_db' EXIT

# W-89：前置聚焦。窗口未聚焦时运行层判「不可判定 = FAIL」，取证链路必须先真正把窗口拉到前台。
# 硬约束（BA 现场带回）：置前只做**一次**。实测「每 3 秒重复激活」会打断采集 → 240 秒超时、零 dump；
# 改成单次激活后约 40 秒正常。因此这里只等待进程/窗口就绪（不激活），随后一次性置前，
# 失败或置后前台不是 aka-desktop 就 exit 2，不进入采集（禁止轮询式/重复激活）。
ACTIVATE_ATTEMPTS=0
FOCUSED_AT_LAUNCH=""
for _ in $(seq 1 20); do
  if pgrep -x aka-desktop >/dev/null 2>&1; then break; fi
  sleep 0.5
done
if ! pgrep -x aka-desktop >/dev/null 2>&1; then
  echo "置前失败：10 秒内 aka-desktop 进程未启动（activateAttempts=0），中止取证" >&2
  exit 2
fi
# 只等待窗口创建，不做任何激活；固定等待 2 秒后再执行唯一一次置前。
sleep 2
ACTIVATE_ATTEMPTS=1
if ! osascript -e 'tell application "System Events" to set frontmost of process "aka-desktop" to true' >/dev/null 2>&1; then
  echo "置前失败：单次激活未成功（activateAttempts=1），中止取证" >&2
  exit 2
fi
sleep 1
FRONTMOST="$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null || true)"
if [ "$FRONTMOST" != "aka-desktop" ]; then
  echo "置前失败：前台进程=${FRONTMOST:-未知}（activateAttempts=1），中止取证" >&2
  exit 2
fi
FOCUSED_AT_LAUNCH=1

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
  python3 - "$OUT/$NAME.json" "$TELEMETRY" "$RUN_STARTED_MS" <<'PY'
import glob, json, os, pathlib, re, sys, time

evidence_path, telemetry_path, run_started_ms = sys.argv[1], sys.argv[2], int(sys.argv[3])
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

# W-63/W-64：落盘断言按支绑定，且只认本次运行时间窗（mtime > runStartedAt），
# 并解析 JSON 校验 code/message/traceId 与页面一致、文件名里的 traceId 精确匹配。
ANCHOR = "S-08.02-04·导出四态（渲染层）"
snapshot = data.get("snapshot") or {}
trace = str(snapshot.get("trace") or (page_ids[0] if page_ids else ""))
page_code = str(snapshot.get("code") or "")
page_message = " ".join(str(snapshot.get("message") or "").split())
start_ms = int(snapshot.get("runStartedAt") or run_started_ms)
expected_files = snapshot.get("files") or {}


def normalized(value: str) -> str:
    return " ".join(str(value).split())


def collect(expected: str):
    """本次运行之后落盘的候选文件（精确名或浏览器重名后缀），按 mtime 升序。"""
    if not expected:
        return []
    stem = expected[:-5]
    found = []
    for path in glob.glob(os.path.expanduser(f"~/Downloads/{stem}*.json")):
        base = os.path.basename(path)
        if not re.fullmatch(re.escape(stem) + r"(?:[- ][0-9]+)?\.json", base):
            continue
        # mtime 为秒级分辨率，容差 1s；更早的残档一律不算。
        if os.path.getmtime(path) * 1000 >= start_ms - 1000:
            found.append(path)
    return sorted(found, key=os.path.getmtime)


def present(expected: str):
    files = collect(expected)
    if not files:
        return False, f"未找到本次运行（runStartedAt={start_ms}）落盘的 {expected or '（快照缺失）'}"
    path = files[-1]
    base = os.path.basename(path)
    match = re.fullmatch(
        r"aka-diagnostics-(TR-\d{8}-\d{6}-\d{4})-(?:ok|no-copy|no-download|both-fail)(?:[- ][0-9]+)?\.json",
        base,
    )
    trace_ok = bool(match) and match.group(1) == trace
    size = os.path.getsize(path)
    try:
        payload = json.load(open(path, encoding="utf-8"))
    except Exception:
        payload = {}
    content_ok = (
        normalized(payload.get("code") or "") == normalized(page_code)
        and normalized(payload.get("message") or "") == page_message
        and payload.get("traceId") == trace
    )
    return size > 0 and trace_ok and content_ok, (
        f"{path} size={size}B mtime={time.strftime('%H:%M:%S', time.localtime(os.path.getmtime(path)))} "
        f"文件名trace匹配={trace_ok} 内容(code/message/traceId)匹配={content_ok}"
    )


def absent(expected: str):
    files = collect(expected)
    if files:
        return False, f"本应无落盘，但本次运行发现 {files}"
    return True, f"未落盘（{expected or '（快照缺失）'}）"


for check_id in ("WL-23-file-C1", "WL-23-file-C2"):
    passed, detail = present(str(expected_files.get(check_id, "")))
    data["checks"].append(
        {
            "id": check_id,
            "card": "S-08.02-04",
            "ac": ANCHOR,
            "layer": "data",
            "passed": passed,
            "blocked": False,
            "detail": detail,
        }
    )
for check_id in ("WL-23-file-C3", "WL-23-file-C4"):
    passed, detail = absent(str(expected_files.get(check_id, "")))
    data["checks"].append(
        {
            "id": check_id,
            "card": "S-08.02-04",
            "ac": ANCHOR,
            "layer": "data",
            "passed": passed,
            "blocked": False,
            "detail": detail,
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

python3 - "$OUT/$NAME.json" "$OUT/$NAME-meta.json" "$LABEL" "$TARGET" "$FIXTURE" "$SCAN_FILE" "$SCAN_RC" "$FLAGS" "$EXTRA_ENV" "$ACTIVATE_ATTEMPTS" "$FOCUSED_AT_LAUNCH" <<'PY'
import json, os, subprocess, sys, datetime
(
    evidence_path, meta_path, label, target, fixture, scan_file, scan_rc,
    flags, extra_env, attempts_raw, launch_focus_raw,
) = sys.argv[1:12]
d = json.load(open(evidence_path))
# W-89 补：置前/断言分离记录。activateAttempts 只可能是 0/1（置前只做一次），
# focusedAtLaunch 由脚本在唯一一次置前之后实测（前台进程 = aka-desktop），
# focusedAtAssert 直接取 dump 顶层 windowFocused（它本就在断言点采样）。
d["activateAttempts"] = int(attempts_raw)
d["focusedAtLaunch"] = launch_focus_raw == "1"
d["focusedAtAssert"] = d.get("windowFocused") if isinstance(d.get("windowFocused"), bool) else None
focus_bad = d["focusedAtAssert"] is False
if focus_bad:
    print(
        "::error::置前后断言时 windowFocused 仍为 false"
        f"（focusedAtLaunch={d['focusedAtLaunch']}, activateAttempts={d['activateAttempts']}）"
        " → 不可判定，不得签",
        file=sys.stderr,
    )
json.dump(d, open(evidence_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
root = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
commit = subprocess.check_output(["git", "-C", root, "rev-parse", "HEAD"], text=True).strip()
# W-89 第 1 项：dirty 只认 evidence-run.sh 落盘前导出的 PRE 快照；
# 单独跑本脚本时才回退到现场 git status（此时产物还没写，不存在自污染）。
pre_dirty = os.environ.get("AKA_EVIDENCE_DIRTY")
if pre_dirty is None:
    status = subprocess.check_output(
        ["git", "-C", root, "status", "--porcelain", "--", "app"], text=True
    )
    dirty = bool(status.strip())
else:
    dirty = pre_dirty == "1"
now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(timespec="seconds")
# W-89：按 schema 分支。s2 dump 是 build/dataset/engine/... 的专用 schema，
# 只有新构建的 diag.ts 才会额外产出统一的 suite/ok/checks 外层；
# 缺 checks 时给出精确原因并 exit 2，不许把旧产物当成「大概跑完了」。
checks = d.get("checks")
if not isinstance(checks, list) or not checks:
    if d.get("kind") == "aka-s2-evidence" or d.get("suite") == "s2":
        schema = ",".join(sorted(d.keys()))
        print(
            f"::error::s2 dump 缺 checks[]（实际 schema=[{schema}]）；"
            "该产物来自 W-89 之前的 diag.ts，必须重新构建后再取证",
            file=sys.stderr,
        )
    else:
        print("::error::dump 缺 checks[]，无法聚合归属", file=sys.stderr)
    sys.exit(2)
bad = [i for i, c in enumerate(checks) if not isinstance(c, dict) or not c.get("card")]
if bad:
    print(f"::error::dump checks[{bad[0]}] 不是含 card 的对象", file=sys.stderr)
    sys.exit(2)
card_order = []
card_stats = {}
for check in checks:
    card = check.get("card")
    if not card:
        continue
    if card not in card_stats:
        card_stats[card] = {"passed": 0, "total": 0, "layers": {}}
        card_order.append(card)
    stat = card_stats[card]
    stat["total"] += 1
    if check.get("passed"):
        stat["passed"] += 1
    layer = check.get("layer", "?")
    passed, total = stat["layers"].get(layer, (0, 0))
    stat["layers"][layer] = (passed + (1 if check.get("passed") else 0), total + 1)


def layer_text(stat):
    return {key: f"{passed}/{total}" for key, (passed, total) in sorted(stat["layers"].items())}


result = {"ok": d.get("ok"), "blocked": d.get("blocked", [])}
if card_order:
    primary = card_order[0]
    result["card"] = primary
    result["layers"] = layer_text(card_stats[primary])
    result["otherCards"] = [
        {
            "card": card,
            "checks": f"{card_stats[card]['passed']}/{card_stats[card]['total']}",
            "layers": layer_text(card_stats[card]),
        }
        for card in card_order[1:]
    ]
else:
    result["layers"] = d.get("layers", {})

meta = {
    "suite": d.get("suite", ""),
    "label": label,
    "runAt": now,
    "commit": commit,
    "dirty": dirty,
    "command": f"AKA_DIAG=1 AKA_DIAG_TARGET=\"{target}\" {extra_env} target/debug/aka-desktop {flags}".replace("  ", " ").strip(),
    "fixture": fixture,
    "buildMode": "dev",
    "environment": "macOS 本机；NODE_ENV=development vite build（mode=dev，含 dev-only 导出注入）+ cargo build（debug，含 QA 注入）--features tauri/custom-protocol。静态零命中检查跑 release dist，与四支运行时证据不是同一产物。",
    "formatScan": (
        {
            "command": "npm run verify:format",
            "exitCode": int(scan_rc),
            "output": open(scan_file, encoding="utf-8").read().strip().splitlines(),
        }
        if scan_file
        else None
    ),
    "result": result,
}
json.dump(meta, open(meta_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"已归档：{evidence_path}")
print(f"已归档：{meta_path}")
print(f"ok={d.get('ok')} layers={d.get('layers')} blocked={len(d.get('blocked', []))} commit={commit} dirty={dirty}")
# W-89 第 2 项：把本次 meta 的绝对路径显式交接给 evidence-run.sh；
# 禁止调用方按 `ls -t` 猜（会挑中历史套件的 meta，混进旧格式）。
print(f"EVIDENCE_META={meta_path}")
sys.exit(0 if d.get("ok") and (not scan_rc or int(scan_rc) == 0) and not focus_bad else 2)
PY
