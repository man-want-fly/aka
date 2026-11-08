#!/usr/bin/env bash
# 运行层 GUI 证据统一入口（制度第 23 条）。
# 用法：scripts/evidence-run.sh <suite> [--check]
#   <suite> 必须是 diag-evidence.sh 的 case 名（如 s2 / s070503 / watchlist）；
#   --check 必须是**第二个参数**，只验前置（分支 / 干净度 / 真 Node / 套件存在），不构建、不取证。
# 约束：只在 main 主树的干净工作区跑；dev2/worktree 的 dump 只作参考、不计证据。
# 产物路径由 scripts/evidence-layout.json 单一提供（制度第 27 条，禁止各写一份）：
#   evidenceRoot = docs/qa/evidence（当次 dump）；archiveRoot = docs/qa/raw（归档，证据根下不得建子目录）
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$APP_DIR/.." && pwd)"
SUITE="${1:?用法: scripts/evidence-run.sh <suite> [--check]}"
MODE="${2:-run}"

fail() {
  echo "EVIDENCE_FAIL: $*" >&2
  exit 2
}

LAYOUT="$APP_DIR/scripts/evidence-layout.json"
[ -f "$LAYOUT" ] || fail "缺 scripts/evidence-layout.json（第 27 条路径常量真源）"
IFS=$'\t' read -r EVIDENCE_REL ARCHIVE_REL < <(python3 - "$LAYOUT" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
print(d["evidenceRoot"], d["archiveRoot"], sep="\t")
PY
) || fail "解析 evidence-layout.json 失败"
[ -n "${EVIDENCE_REL:-}" ] && [ -n "${ARCHIVE_REL:-}" ] || fail "evidence-layout.json 缺 evidenceRoot/archiveRoot"
case "$EVIDENCE_REL$ARCHIVE_REL" in *..*) fail "路径常量不得含 ..";; esac
OUT="$ROOT/$EVIDENCE_REL"
RAW="$ROOT/$ARCHIVE_REL"

# 1) 位置与干净度：只在 main 干净树取证；dump 的 commit 允许等于或祖先于最终 sign_commit（第 25 条）。
branch="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || fail "只允许在 main 取证（当前 $branch）；分支 dump 仅作参考"
[ -z "$(git -C "$ROOT" status --porcelain)" ] || fail "工作区不干净（dirty=true），先提交或清理"
commit="$(git -C "$ROOT" rev-parse HEAD)"

# 2) 真 Node：本机 PATH 上的 node 是 Electron 垫片，未签名 rollup native 会导致 vite build 失败。
NODE_BIN="${EVIDENCE_NODE:-}"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(npx -y node@22 -e 'process.stdout.write(process.execPath)' 2>/dev/null || true)"
fi
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || fail "找不到真 Node（可设 EVIDENCE_NODE=/path/to/node）"
"$NODE_BIN" -e 'process.exit(process.versions.electron ? 1 : 0)' \
  || fail "EVIDENCE_NODE 是 Electron 垫片，不是真 Node"

# 套件必须真实存在：diag-evidence.sh 的 case 分支是唯一事实源（W-88：s2 曾为空壳，禁再犯）。
grep -qE "^  ${SUITE}\)" "$APP_DIR/scripts/diag-evidence.sh" \
  || fail "未知套件 ${SUITE}（diag-evidence.sh 无对应 case；先补分支再跑）"

if [ "$MODE" = "--check" ]; then
  echo "EVIDENCE_OK: branch=main commit=${commit:0:12} node=$("$NODE_BIN" -v) electron=none"
  exit 0
fi

# 3) 构建：前端用真 Node 直跑 tsc/vite；后端 debug（QA 注入仅 debug 存在，W-47）。
(cd "$APP_DIR" && "$NODE_BIN" node_modules/typescript/bin/tsc --noEmit)
(cd "$APP_DIR" && NODE_ENV=development "$NODE_BIN" node_modules/vite/bin/vite.js build)
(cd "$APP_DIR" && cargo build -p aka-desktop --features tauri/custom-protocol)

# 4) 取证并归档（脚本固定，禁止 open /tmp/xxx.command 之类的人工步骤）。
"$APP_DIR/scripts/diag-evidence.sh" "$SUITE"

# 5) 补齐第 19 条五项并落固定产物；缺一即失败。
META="$(ls -t "$OUT"/*-meta.json | head -1)"
python3 - "$ROOT" "$APP_DIR" "$META" "$NODE_BIN" "$SUITE" "$commit" "$RAW" <<'PY'
import datetime, hashlib, json, os, platform, shutil, subprocess, sys

root, app_dir, meta_path, node_bin, suite, commit, raw_dir = sys.argv[1:8]
meta = json.load(open(meta_path, encoding="utf-8"))
label = meta.get("label") or datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
name = os.path.basename(meta_path)[: -len("-meta.json")]
evidence_path = meta_path[: -len("-meta.json")] + ".json"
os.makedirs(raw_dir, exist_ok=True)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def mtime_iso(path):
    return datetime.datetime.fromtimestamp(os.path.getmtime(path)).astimezone().isoformat(
        timespec="seconds"
    )


binary = os.path.join(app_dir, "target", "debug", "aka-desktop")
dist_index = os.path.join(app_dir, "dist", "index.html")
for path in (binary, dist_index, evidence_path):
    if not os.path.exists(path):
        print(f"EVIDENCE_FAIL: 缺产物 {path}", file=sys.stderr)
        sys.exit(2)

# R-EV-02：finishedAt 只从 dump 内读，缺失回退落盘时刻；不允许在 meta 里手写。
try:
    dump = json.load(open(evidence_path, encoding="utf-8"))
except (OSError, ValueError):
    dump = {}
finished_at = dump.get("finishedAt") if isinstance(dump.get("finishedAt"), str) else ""
if not finished_at.strip():
    finished_at = mtime_iso(evidence_path)

stamp = commit[:12]
raw_json = os.path.join(raw_dir, f"{name}-{stamp}-{label}.json")
raw_meta = os.path.join(raw_dir, f"{name}-{stamp}-{label}-meta.json")
shutil.copy2(evidence_path, raw_json)

try:
    rustv = subprocess.check_output(["rustc", "-vV"], text=True)
    host_target = next(
        (line.split(":", 1)[1].strip() for line in rustv.splitlines() if line.startswith("host:")),
        "unknown",
    )
except Exception:
    host_target = "unknown"

meta["runtime"] = {
    "os": platform.system(),
    "arch": platform.machine(),
    "node": subprocess.check_output([node_bin, "-v"], text=True).strip(),
    # 本产品是 Tauri（WebKit WebView）宿主，从不跑在 Electron 里；
    # 显式写 "none" 表示「不适用」，与「字段缺失」是两回事（第 19 条）。
    "electron": "none",
    "hostTarget": f"tauri-webkit ({host_target})",
    "launch": "target/debug/aka-desktop --features tauri/custom-protocol（AKA_DIAG=1）",
}
meta["build"] = {
    "frontend": "tsc --noEmit + NODE_ENV=development vite build（mode=dev）",
    "frontendAt": mtime_iso(dist_index),
    "distIndexSha256": sha256(dist_index),
    "cargoProfile": "debug",
    "features": "tauri/custom-protocol",
    "binary": "app/target/debug/aka-desktop",
    "binaryAt": mtime_iso(binary),
    "binarySha256": sha256(binary),
}
meta["dump"] = {
    "archived": os.path.relpath(raw_json, root),
    "sha256": sha256(raw_json),
    "finishedAt": finished_at,
}
meta["command"] = meta.get("command", "")
meta["reproduce"] = f"app/scripts/evidence-run.sh {suite}"
meta["commit"] = commit
meta["dirty"] = False

json.dump(meta, open(raw_meta, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump(meta, open(meta_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

missing = [
    key
    for key, value in {
        "commit": meta.get("commit"),
        "dirty=false": meta.get("dirty") is False,
        "runtime": (
            meta["runtime"].get("node")
            and meta["runtime"].get("os")
            and meta["runtime"].get("hostTarget")
            and "electron" in meta["runtime"]
            and meta["runtime"]["electron"] is not None
        ),
        "build": meta["build"].get("binarySha256") and meta["build"].get("distIndexSha256"),
        "command": meta["command"],
        "dump": meta["dump"].get("sha256") and meta["dump"].get("finishedAt"),
    }.items()
    if not value
]
if missing:
    print(f"EVIDENCE_FAIL: 第 19 条五项缺失 {missing}", file=sys.stderr)
    sys.exit(2)
print(f"EVIDENCE_OK: {meta['dump']['archived']}")
print(f"meta: {os.path.relpath(raw_meta, root)}")
PY
