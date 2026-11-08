# 第 29 条变异验证补丁（批次 B1：P06 / P07）

基线：批次 B1 窗口启动时的 `main` HEAD，**不早于 `774ec69`**；自 `f50b54f` 起 `app/src` 无改动（P09/P10 已移出批次，不在 tip 内）。补丁只改一行，均可 `git apply -R` 精确回退。

执行人：BA（取证窗口内）。dev 不跑运行层、不出 dump；以下命令由 BA 执行。提供者（dev B）与执行者（BA）不得同一人。

补丁 sha256：

```text
511adcd622c60116ef46b2fb0bd005a08df4a57a77821086de9658d4076e726a  01-error-code-title.patch
de2e10ac12e6be617887f84ee1b2c1ee9e1f84be306fe43831e705acc8b3bd70  02-health-skip-status.patch
```

---

## 0.0 正式产物一律走 `evidence-run.sh`（2026-11-08 起硬规则）

**正式证据必须由 `app/scripts/evidence-run.sh <suite>` 生成。** 它负责写入 `meta.dump`、`meta.reproduce`、`env` 与焦点字段；用 `diag-evidence.sh` + 手工快照产出的文件**不含 `reproduce`/`meta.dump`**，`verify:evidence` 会直接判红（BA 基线实测 6 项 FAIL）。

- `evidence-run.sh`：唯一可计入证据份数的入口，窗口内所有正式产物用它。
- `diag-evidence.sh` + 手工快照：**只允许基线自检**（证明环境能开），产物不入库、不计份数、不作签字依据。

## 0. 打补丁前先跑绿（必须，缺此步本次变异记录作废）

没有基线绿，只有「打补丁后红」不能证明红点来自变异。BA 在窗口开始、应用任何补丁之前先跑**基线自检**：

```bash
cd <批次 B1 检出根目录>
git status --short                     # 必须为空
cd app
npm run build
cargo build -p aka-desktop --features tauri/custom-protocol
scripts/evidence-run.sh s080202          # 期望：全 PASS，P06-R1 绿；产物可入账
scripts/evidence-run.sh s070102-corrupt  # 期望：②FAIL / ③~⑥ SKIP / 1/6，P07-R5 绿
```

两套都必须先绿；任一不绿即停，先查环境，不得继续打补丁。

## 0.1 基线自检快照（不计份数；正式产物不得走此流程）

`diag-evidence.sh` 会把 dump 复制进 `docs/qa/evidence/`（已跟踪），复制完工作树就脏了。**仅基线自检时**可快照并恢复：

```bash
mkdir -p /tmp/b1-baseline/<run-name>
cp -R docs/qa/evidence/. /tmp/b1-baseline/<run-name>/
git checkout -- docs/qa/evidence
git clean -fd docs/qa/evidence        # 只清本次新增的未跟踪 dump
git status --short                    # 必须为空
```

- 这些快照**只用于自检**，**不得复制回 `docs/qa/evidence/`**，不得计入证据份数。
- 正式产物由 `evidence-run.sh` 直接写入，窗口末一次性提交；不需要手工快照恢复。

## 0.2 变异必须在一次性分支上提交（否则 `meta.dirty=true`）

`git apply` 后直接跑，dump 的 `meta.dirty` 会是 `true`，该条变异记录不能入账。每个变异用一次性分支提交后再跑，跑完删分支回到签 tip：

```bash
SIGN_TIP=$(git rev-parse HEAD)        # 窗口启动时 main HEAD；先确认 git status --short 为空
git switch -c mutation/b1-01
git apply docs/qa/mutations/b1/01-error-code-title.patch
git add -A && git commit -m "mutation(b1-01): E_ENGINE_PANIC title"
MUT01=$(git rev-parse HEAD)           # dump 的 commit；其 parent = SIGN_TIP
cd app && npm run build && scripts/evidence-run.sh s080202
cd .. && git switch main && git branch -D mutation/b1-01
```

- 变异 ② 同法：`git switch -c mutation/b1-02`、应用 02、`cargo build`、跑 `s070102-corrupt`。
- 台账记 `mutation_of=<SIGN_TIP>`、`mutation_commit=<MUT01/MUT02>`；**禁止**把变异提交带回 main，**禁止**在签 tip 上 apply 后不提交直接跑。
- 不用 `git worktree`：B1 的 `app/node_modules` 不在 repo 内，worktree 需要额外软链，反而多一处环境变量；一次性分支在同一棵树上更稳。

## 变异 ①：错误码→标题映射改错

- 目标文件：`app/src/pages/workbench/WorkbenchPage.tsx`
- 变异：`CALC_ERROR_TITLES.E_ENGINE_PANIC` 由 `引擎异常` 改为 `引擎故障`
- 命中 check：`s080202` 的 `P06-R1`（AC-08.02.02）必须红，其余 check 应保持原结论

```bash
cd <批次 B1 检出根目录>
SIGN_TIP=$(git rev-parse HEAD)          # 先确认 git status --short 为空
git switch -c mutation/b1-01
git apply --check docs/qa/mutations/b1/01-error-code-title.patch   # 失败即停，不许 --reject
git apply docs/qa/mutations/b1/01-error-code-title.patch
git add -A && git commit -m "mutation(b1-01): E_ENGINE_PANIC title"
MUT01=$(git rev-parse HEAD)
cd app && npm run build                 # 前端变异，需重建 dist
scripts/evidence-run.sh s080202         # 期望：P06-R1 = FAIL（标题不再是「引擎异常」）
cd .. && git switch main && git branch -D mutation/b1-01
cd app && npm run build && scripts/evidence-run.sh s080202   # 回退后复绿
```

## 变异 ②：健康检查 SKIP 逻辑改错

- 目标文件：`app/crates/app-core/src/core.rs`
- 变异：`data_health_check` 内 `skip` 闭包的 `status: "SKIP"` 改为 `status: "PASS"`
- 命中 check：`s070102-corrupt` 的 `P07-R5`（AC-07.01-02 补3）必须红；`P07-R2` 仍绿（PASS 属合法状态）、`P07-R3` 仍绿（汇总仍是 `1/6`）

```bash
cd <批次 B1 检出根目录>
SIGN_TIP=$(git rev-parse HEAD)
git switch -c mutation/b1-02
git apply --check docs/qa/mutations/b1/02-health-skip-status.patch  # 失败即停，不许 --reject
git apply docs/qa/mutations/b1/02-health-skip-status.patch
git add -A && git commit -m "mutation(b1-02): health skip status PASS"
MUT02=$(git rev-parse HEAD)
cd app && cargo build -p aka-desktop --features tauri/custom-protocol
scripts/evidence-run.sh s070102-corrupt   # 期望：P07-R5 = FAIL（③~⑥不再为 SKIP）
cd .. && git switch main && git branch -D mutation/b1-02
cd app && cargo build -p aka-desktop --features tauri/custom-protocol
scripts/evidence-run.sh s070102-corrupt   # 回退后应恢复 1/6，P07-R5 绿
```

## 可逆性说明

- 两份补丁已在批次 B1 tip 上验证：`git apply --check` 通过；应用后 `git apply -R` 可精确回退。
- 两份补丁不要同时应用：变异 ① 打前端、变异 ② 打后端，分开跑、分开回退，便于定位红点。
- 若窗口 HEAD 在应用前继续前进导致上下文漂移，先 `git apply --check`；失败即停止，不要 `--reject` 后手工拼接。
