# 第 29 条变异记录（批次 W119：W-115 同源 oracle 恒真锚点 + s050101 六条 AC 判定）

基线：分支 `w119/diag-runners-and-oracle` 的 commit `bc4cb7a`（自 `main` 的 `ca87236` 起）。
补丁只改一行，均可 `git apply -R` 精确回退。

**本批变异对象是静态门禁脚本（node），不是运行层 GUI 证据**：

- 与 B1 批次不同，这里跑的是 `node scripts/verify_*.mjs`（纯静态源码判定），**不产生
  `docs/qa/evidence/` 产物、不触碰 `evidence-run.sh`**，因此不属第 23/25/28 条的运行层取证范畴，
  由 dev（手法提供者）在本地自查即可；BA 若要复核，按下列命令原样执行即可。
- 三条补丁各自独立，**一次只应用一条**（02 与 03 都改 `app/src/features/qa/batchDiag.ts`，
  同时应用会让上下文漂移）。

补丁 sha256：

```text
f180f4522037b685589f150b3fa8d297bb206442e430575e55ea938549b9b143  01-p04r3-injection-chain.patch
0127e259209b4f165f1c1b452e65ab905d04df0c15555de5a29c0e044eb75d8e  02-s050102-judgement-weaken.patch
68f49cb2f16c22a216e576f3fe57eeb5caa4320cebf09ab474ac5536d8fde581  03-s050101-judgement-weaken.patch
```

---

## 0. 为什么有这批记录

W-115 遗留：`verify_p04r3_injection.mjs` 与 `verify_s050102.mjs` 的「变异锚点」写成
`new Function(..., "return true;")` —— 一个与被测源码无关的硬编码常量，恒等于 `true`，
只能证明「`true === true`」。QA 明确**不豁免**（P2 同源 oracle）。

W-119 已把两处改成**双向自证**：判据抽成纯函数 `runChecks(sources)`，同一套判据对
「原样源码」必须判绿、对「被变异源码」必须判红；两处的变异对象**不同源**：

| 门禁 | 被测常量 | 变异对象 | 变异手法 |
| --- | --- | --- | --- |
| `verify:p04r3` | P04-R3 判定表达式 + Rust 注入链 + 关于页派生链 | `app/src-tauri/src/commands.rs`（上游注入链） | 注入分支不再返回 `None` |
| `verify:s050102` | 7 条 obs 判定表达式 | `app/src/features/qa/batchDiag.ts`（下游判定表达式） | `&&` 弱化为 `||` |
| `verify:diag-runner-wiring`（J4） | s050101 六条 AC 的判定表达式 | `app/src/features/qa/batchDiag.ts`（下游判定表达式） | 一个观察量替换为 `true` |

---

## 1. 变异 ①：P04-R3 上游注入链断裂

- 目标文件：`app/src-tauri/src/commands.rs`
- 变异：`dataset_manifest` 在 `manifest_missing` 注入分支里由 `return Ok(None);` 改为
  `return Ok(Some(state.core.dataset_manifest()?));`（注入形同失效）
- 期望红点：`verify:p04r3` 报「dataset_manifest 注入时未返回 None」

```bash
cd <W119 检出根目录>
git apply --check docs/qa/mutations/w119/01-p04r3-injection-chain.patch   # 失败即停，不许 --reject
node app/scripts/verify_p04r3_injection.mjs    # 期望：exit 1，输出「dataset_manifest 注入时未返回 None」
git apply -R docs/qa/mutations/w119/01-p04r3-injection-chain.patch
node app/scripts/verify_p04r3_injection.mjs    # 期望：exit 0，原样判绿
```

实测（W-119 自查，基线 `bc4cb7a`）：变异后 `exit=1`，回退后 `exit=0`。

## 2. 变异 ②：P15 判定表达式被弱化

- 目标文件：`app/src/features/qa/batchDiag.ts`
- 变异：`S050102-R1` 的判定由 `obs.downSelectedSecond && obs.enterOpenedSecond && obs.escClearedInput`
  改为 `||` 联结（「全满足」被弱化成「任一满足」）
- 期望红点：`verify:s050102` 报「S050102-R1 反例 obs 未判红（断言恒绿，等于没有验收）」

```bash
cd <W119 检出根目录>
git apply --check docs/qa/mutations/w119/02-s050102-judgement-weaken.patch
node app/scripts/verify_s050102.mjs            # 期望：exit 1，输出「S050102-R1 反例 obs 未判红」
git apply -R docs/qa/mutations/w119/02-s050102-judgement-weaken.patch
node app/scripts/verify_s050102.mjs            # 期望：exit 0，原样判绿
```

实测：变异后 `exit=1`，回退后 `exit=0`。

## 3. 变异 ③：P14（s050101）补2 判定被弱化

- 目标文件：`app/src/features/qa/batchDiag.ts`
- 变异：`S050101-R4` 的判定里 `obs.truncatedNotice`（列表底部「仅显示前 20 条」是否出现）
  被替换为 `true` → 底部提示消失也判绿
- 期望红点：`verify:diag-runner-wiring` 的 J4 报「S050101-R4 反例 obs 未判红」

```bash
cd <W119 检出根目录>
git apply --check docs/qa/mutations/w119/03-s050101-judgement-weaken.patch
node app/scripts/verify_diag_runner_wiring.mjs  # 期望：exit 2，输出「FAIL J4 S050101-R4 反例 obs 未判红」
git apply -R docs/qa/mutations/w119/03-s050101-judgement-weaken.patch
node app/scripts/verify_diag_runner_wiring.mjs  # 期望：exit 0，反例 13/13 判红
```

实测：变异后 `exit=2`，回退后 `exit=0`。

## 可逆性说明

- 三份补丁在基线 `bc4cb7a` 上验证：`git apply --check` 通过；应用后 `git apply -R` 可精确回退。
- 三份补丁不要同时应用；02 与 03 都改 `app/src/features/qa/batchDiag.ts`。
- 若基线继续前进导致上下文漂移，先 `git apply --check`；失败即停止，不要 `--reject` 后手工拼接。
