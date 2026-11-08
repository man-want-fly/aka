# 第 29 条变异验证补丁（批次 B1：P06 / P07）

基线：批次 B1 窗口启动时的 `main` HEAD（代码等于 `f50b54f`；P09/P10 已移出批次，不在 tip 内）。补丁只改一行，均可 `git apply -R` 精确回退。

执行人：BA（取证窗口内）。dev 不跑运行层、不出 dump；以下命令由 BA 执行。提供者（dev B）与执行者（BA）不得同一人。

补丁 sha256：

```text
511adcd622c60116ef46b2fb0bd005a08df4a57a77821086de9658d4076e726a  01-error-code-title.patch
de2e10ac12e6be617887f84ee1b2c1ee9e1f84be306fe43831e705acc8b3bd70  02-health-skip-status.patch
```

---

## 0. 打补丁前先跑绿（必须，缺此步本次变异记录作废）

没有基线绿，只有「打补丁后红」不能证明红点来自变异。BA 在窗口开始、应用任何补丁之前先跑：

```bash
cd <批次 B1 检出根目录>
git status --short                     # 必须为空
cd app
npm run build
cargo build -p aka-desktop --features tauri/custom-protocol
scripts/diag-evidence.sh s080202          # 期望：全 PASS，P06-R1 绿
scripts/diag-evidence.sh s070102-corrupt  # 期望：②FAIL / ③~⑥ SKIP / 1/6，P07-R5 绿
```

两套都必须先绿；任一不绿即停，先查环境，不得继续打补丁。

## 变异 ①：错误码→标题映射改错

- 目标文件：`app/src/pages/workbench/WorkbenchPage.tsx`
- 变异：`CALC_ERROR_TITLES.E_ENGINE_PANIC` 由 `引擎异常` 改为 `引擎故障`
- 命中 check：`s080202` 的 `P06-R1`（AC-08.02.02）必须红，其余 check 应保持原结论

```bash
cd <批次 B1 检出根目录>
git apply --check docs/qa/mutations/b1/01-error-code-title.patch   # 失败即停，不许 --reject
git apply docs/qa/mutations/b1/01-error-code-title.patch
cd app && npm run build                # 前端变异，需重建 dist
scripts/diag-evidence.sh s080202       # 期望：P06-R1 = FAIL（标题不再是「引擎异常」）
cd .. && git apply -R docs/qa/mutations/b1/01-error-code-title.patch
git status --short                     # 必须为空
cd app && npm run build                # 回退后重建，再跑一次 s080202 应恢复全绿
```

## 变异 ②：健康检查 SKIP 逻辑改错

- 目标文件：`app/crates/app-core/src/core.rs`
- 变异：`data_health_check` 内 `skip` 闭包的 `status: "SKIP"` 改为 `status: "PASS"`
- 命中 check：`s070102-corrupt` 的 `P07-R5`（AC-07.01-02 补3）必须红；`P07-R2` 仍绿（PASS 属合法状态）、`P07-R3` 仍绿（汇总仍是 `1/6`）

```bash
cd <批次 B1 检出根目录>
git apply --check docs/qa/mutations/b1/02-health-skip-status.patch  # 失败即停，不许 --reject
git apply docs/qa/mutations/b1/02-health-skip-status.patch
cd app && cargo build -p aka-desktop --features tauri/custom-protocol
scripts/diag-evidence.sh s070102-corrupt   # 期望：P07-R5 = FAIL（③~⑥不再为 SKIP）
cd .. && git apply -R docs/qa/mutations/b1/02-health-skip-status.patch
git status --short                     # 必须为空
cd app && cargo build -p aka-desktop --features tauri/custom-protocol
scripts/diag-evidence.sh s070102-corrupt   # 回退后应恢复 1/6，P07-R5 绿
```

## 可逆性说明

- 两份补丁已在批次 B1 tip 上验证：`git apply --check` 通过；应用后 `git apply -R` 可精确回退。
- 两份补丁不要同时应用：变异 ① 打前端、变异 ② 打后端，分开跑、分开回退，便于定位红点。
- 若窗口 HEAD 在应用前继续前进导致上下文漂移，先 `git apply --check`；失败即停止，不要 `--reject` 后手工拼接。
