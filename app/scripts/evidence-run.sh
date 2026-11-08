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

# W-94：失败/崩溃现场自动落归档根（docs/qa/raw），不依赖 BA 人工补录。
# 只在「确实开始取证」之后记录（preflight 失败属于用法错误，不往 raw 里堆记录）；
# 记录本身是失败记录（ok=false / blocked=true），verify:evidence 不计份数、不可签（第 31 条）。
STEP="preflight"
STEP_CMD=""
DIAG_LOG=""
RECORD_READY=0
FAILURE_RECORDED=0
on_error() {
  STEP_CMD="${BASH_COMMAND}"
}
on_exit() {
  rc=$?
  [ "$rc" -ne 0 ] || return 0
  [ "$RECORD_READY" = "1" ] || return 0
  [ "$FAILURE_RECORDED" = "1" ] && return 0
  FAILURE_RECORDED=1
  "$APP_DIR/scripts/record-evidence-failure.sh" \
    "$RAW" "$SUITE" "$(git -C "$ROOT" rev-parse HEAD)" "$STEP" "$rc" \
    "app/scripts/evidence-run.sh $SUITE" "${STEP_CMD}" "${DIAG_LOG}" \
    || echo "EVIDENCE_FAIL: 失败现场落盘失败（见上方 stderr）" >&2
  [ -n "$DIAG_LOG" ] && rm -f "$DIAG_LOG" || true
}
trap on_error ERR
trap on_exit EXIT

# 1) 位置与干净度：只在 main 干净树取证；dump 的 commit 允许等于或祖先于最终 sign_commit（第 25 条）。
branch="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
# W-112：macOS 自带 bash 3.2 会把紧跟变量的全角字符吞进变量名（`$branch）` → unbound variable）。
# 一律写成 ${branch}，保证分支≠main 时走 EVIDENCE_FAIL，而不是解释器崩在 set -u 上。
[ "$branch" = "main" ] || fail "只允许在 main 取证（当前 ${branch}）；分支 dump 仅作参考"
[ -z "$(git -C "$ROOT" status --porcelain)" ] || fail "工作区不干净（dirty=true），先提交或清理"
commit="$(git -C "$ROOT" rev-parse HEAD)"

# W-89 第 1 项：dirty/commit 只在这里取一次（PRE 快照，任何产物落盘之前）。
# 取证会往 docs/qa/evidence、docs/qa/raw 写文件；落盘之后再算 git status 必然为 true，
# 于是同一事实出现两个答案（meta.dirty=false / env.dirty=true）。构建期与 meta 一律继承下面的值。
export AKA_EVIDENCE_DIRTY=0
export AKA_EVIDENCE_COMMIT="$commit"
PRE_DIRTY="$AKA_EVIDENCE_DIRTY"

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

RECORD_READY=1

# 3) 构建：前端用真 Node 直跑 tsc/vite；后端 debug（QA 注入仅 debug 存在，W-47）。
STEP="build:tsc"
(cd "$APP_DIR" && "$NODE_BIN" node_modules/typescript/bin/tsc --noEmit)
STEP="build:vite"
(cd "$APP_DIR" && NODE_ENV=development "$NODE_BIN" node_modules/vite/bin/vite.js build)
STEP="build:cargo"
(cd "$APP_DIR" && cargo build -p aka-desktop --features tauri/custom-protocol)

# 4) 取证并归档（脚本固定，禁止 open /tmp/xxx.command 之类的人工步骤）。
STEP="collect"
# W-89 第 2/3 项：meta 路径由 diag-evidence.sh 用 EVIDENCE_META= 显式交接，
# 禁止 `ls -t` 猜最新——那会挑中历史套件的 meta（dump 是字符串、没有 env），
# 把旧格式混进本次证据（BA 实测 meta.dump.finishedAt=null、meta.electron=null）。
DIAG_LOG="$(mktemp)"
"$APP_DIR/scripts/diag-evidence.sh" "$SUITE" 2>&1 | tee "$DIAG_LOG"
META="$(sed -n 's/^EVIDENCE_META=//p' "$DIAG_LOG" | tail -1)"
rm -f "$DIAG_LOG"
[ -n "$META" ] && [ -f "$META" ] \
  || fail "diag-evidence.sh 未输出有效的 EVIDENCE_META=（拒绝按 mtime 猜 meta）"

# 5) 补齐第 19 条五项并落固定产物；缺一即失败。
STEP="archive"
python3 - "$ROOT" "$APP_DIR" "$META" "$SUITE" "$commit" "$RAW" "$PRE_DIRTY" <<'PY'
import datetime, hashlib, json, os, shutil, sys

root, app_dir, meta_path, suite, commit, raw_dir, pre_dirty_raw = sys.argv[1:8]
pre_dirty = pre_dirty_raw == "1"
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


def abort(message):
    print(f"EVIDENCE_FAIL: {message}", file=sys.stderr)
    sys.exit(2)


binary = os.path.join(app_dir, "target", "debug", "aka-desktop")
dist_index = os.path.join(app_dir, "dist", "index.html")
for path in (binary, dist_index, evidence_path):
    if not os.path.exists(path):
        abort(f"缺产物 {path}")

# W-89 第 2 项：finishedAt 的唯一口径是 dump 顶层 finishedAt；有 env 的运行层 dump
# 缺失即失败，不回退 mtime（回退会让 dump 与 meta 各说一套）。
# 旧套件 dump 没有 env（纯渲染层证据），沿用 mtime 兜底，不享受运行层口径。
try:
    dump = json.load(open(evidence_path, encoding="utf-8"))
except (OSError, ValueError) as error:
    abort(f"dump 不可解析（{error}）")
if not isinstance(dump, dict):
    abort("dump 顶层不是对象")
env = dump.get("env")
strict = isinstance(env, dict)
finished_at = dump.get("finishedAt")
if not isinstance(finished_at, str) or not finished_at.strip():
    if strict:
        abort("dump 顶层缺 finishedAt（不得回退 mtime，须重新取证）")
    finished_at = datetime.datetime.fromtimestamp(os.path.getmtime(evidence_path)).astimezone().isoformat(
        timespec="seconds"
    )

if strict:
    # W-89 第 1/3 项：dump.env 是运行层唯一真源，meta 只做副本；缺一项或与 PRE 不一致即失败。
    if not isinstance(env.get("dirty"), bool):
        abort(f"env.dirty={env.get('dirty')!r} 不是布尔")
    if env["dirty"] != pre_dirty:
        abort(f"env.dirty={env['dirty']} 与 PRE 快照 dirty={pre_dirty} 不一致（构建期不得另行现算）")
    if str(env.get("commit") or "") != commit:
        abort(f"env.commit={env.get('commit')!r} 与 PRE commit={commit} 不一致")
    if not isinstance(env.get("runtime"), dict):
        abort("env.runtime 缺失")
    if not isinstance(env.get("build"), dict):
        abort("env.build 缺失")
    if not str(env.get("command") or "").strip():
        abort("env.command 为空")

# W-89 补：置前只允许一次（重复激活会打断采集，现场实测 240 秒超时零 dump）。
# focusedAtLaunch 是脚本在唯一一次置前后实测的前台状态；focusedAtAssert 取断言点 windowFocused。
attempts = dump.get("activateAttempts")
if isinstance(attempts, bool) or not isinstance(attempts, int) or attempts != 1:
    abort(f"dump.activateAttempts={attempts!r}，置前必须且只能激活一次（禁止轮询式/重复激活）")
if dump.get("focusedAtLaunch") is not True:
    abort("dump.focusedAtLaunch 不是 true（置前未成功，不得继续归档）")
if isinstance(dump.get("windowFocused"), bool):
    if dump.get("focusedAtAssert") != dump.get("windowFocused"):
        abort("dump.focusedAtAssert 与 windowFocused 不一致（断言时聚焦态口径不同）")
    if dump["windowFocused"] is False:
        abort("断言时 windowFocused=false → 不可判定，不得签（聚焦仍是硬条件）")

stamp = commit[:12]
raw_json = os.path.join(raw_dir, f"{name}-{stamp}-{label}.json")
raw_meta = os.path.join(raw_dir, f"{name}-{stamp}-{label}-meta.json")
shutil.copy2(evidence_path, raw_json)

# runtime/build/command/commit/dirty 全部从 dump.env 回填：同一事实只留一处真源。
# 没有 env 的旧套件不写 runtime/build/command/reproduce，避免被 R-EV-02 新格式判红。
meta["commit"] = commit
meta["dirty"] = pre_dirty
meta["dump"] = {
    "archived": os.path.relpath(raw_json, root),
    "sha256": sha256(raw_json),
    "finishedAt": finished_at,
}
if strict:
    meta["runtime"] = dict(env["runtime"])
    meta["build"] = dict(env["build"])
    meta["command"] = env["command"]
    meta["reproduce"] = f"app/scripts/evidence-run.sh {suite}"
else:
    meta.pop("reproduce", None)

json.dump(meta, open(raw_meta, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump(meta, open(meta_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

print(f"EVIDENCE_OK: {meta['dump']['archived']}")
print(f"meta: {os.path.relpath(raw_meta, root)} dirty={pre_dirty} commit={stamp} runLayer={'env' if strict else 'legacy'}")
PY
