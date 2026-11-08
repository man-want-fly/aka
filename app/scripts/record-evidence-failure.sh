#!/usr/bin/env bash
# W-94：取证失败/崩溃现场落盘（归档根 docs/qa/raw），替代「BA 人工补录」。
# 用法：record-evidence-failure.sh <raw-dir> <suite> <commit> <step> <exit-code> <command> <step-command> <log-file>
#   raw-dir       归档根（由 evidence-layout.json 提供，禁止写进证据根）
#   step          失败发生的位置：preflight / build:tsc / build:vite / build:cargo / collect / archive
#   step-command  失败那一步的实际命令（BASH_COMMAND，可为空）
#   log-file      当次取证日志（可为空；有则截取末尾进 logTail）
# 产物是**失败记录**：ok=false / blocked=true → verify:evidence 不计份数、不可签（第 31 条）。
# 失败记录 meta.dirty 必须为 false：调用方只在干净基线（PRE dirty=0）时调用。
set -euo pipefail

RAW_DIR="${1:?用法: record-evidence-failure.sh <raw-dir> <suite> <commit> <step> <exit-code> <command> <step-command> <log-file>}"
SUITE="${2:?缺 suite}"
COMMIT="${3:?缺 commit}"
STEP="${4:?缺 step}"
EXIT_CODE="${5:?缺 exit-code}"
COMMAND="${6:?缺 command}"
STEP_COMMAND="${7:-}"
LOG_FILE="${8:-}"

case "$SUITE" in *[!A-Za-z0-9._-]*) echo "EVIDENCE_FAIL: suite 含非法字符（${SUITE}）" >&2; exit 2;; esac
case "$COMMIT" in
  *[!0-9a-f]*|"") echo "EVIDENCE_FAIL: commit 非法（${COMMIT}）" >&2; exit 2;;
esac
[ "${#COMMIT}" -eq 40 ] || { echo "EVIDENCE_FAIL: commit 必须是 40 位 sha（${COMMIT}）" >&2; exit 2; }
[ -d "$RAW_DIR" ] || { echo "EVIDENCE_FAIL: 归档根不存在（${RAW_DIR}）" >&2; exit 2; }

python3 - "$RAW_DIR" "$SUITE" "$COMMIT" "$STEP" "$EXIT_CODE" "$COMMAND" "$STEP_COMMAND" "$LOG_FILE" <<'PY'
import datetime, hashlib, json, os, sys

raw_dir, suite, commit, step, exit_code, command, step_command, log_file = sys.argv[1:9]
stamp = commit[:12]
finished_at = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
label = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
name = f"{suite}-failure-{stamp}-{label}"
base = os.path.join(raw_dir, name)

log_tail = ""
if log_file and os.path.isfile(log_file):
    with open(log_file, encoding="utf-8", errors="replace") as fh:
        lines = fh.readlines()[-40:]
    log_tail = "".join(lines)[-4000:]

dump = {
    "schemaVersion": 1,
    "kind": "aka-evidence-failure",
    "suite": suite,
    "ok": False,
    # verify:evidence（第 31 条）认 blocked===true / error 非空 为失败记录：不计份数、不可签。
    "blocked": True,
    "error": f"步骤 {step} 失败（exit {exit_code}）",
    "step": step,
    "stepCommand": step_command,
    "command": command,
    "exitCode": int(exit_code),
    "finishedAt": finished_at,
    "logTail": log_tail,
}
meta = {
    "suite": suite,
    "commit": commit,
    "dirty": False,
    "command": command,
    "step": step,
    "stepCommand": step_command,
    "exitCode": int(exit_code),
    "finishedAt": finished_at,
    "label": label,
    "dump": {
        "archived": os.path.join(raw_dir, name + ".json"),
        "sha256": hashlib.sha256(json.dumps(dump, ensure_ascii=False, indent=2).encode("utf-8")).hexdigest(),
        "finishedAt": finished_at,
    },
}

with open(base + ".json", "w", encoding="utf-8") as fh:
    json.dump(dump, fh, ensure_ascii=False, indent=2)
with open(base + "-meta.json", "w", encoding="utf-8") as fh:
    json.dump(meta, fh, ensure_ascii=False, indent=2)
print(f"EVIDENCE_FAILURE_RECORDED: {os.path.join(raw_dir, name + '.json')}")
PY
