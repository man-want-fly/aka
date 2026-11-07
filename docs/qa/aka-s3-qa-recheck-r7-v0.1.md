# AKA S3 独立复核 R7（2026-11-07）

- 复核对象：`origin/main` tip **`1445feb86ed8aef608d59bf06f21620d7f778480`**（2026-11-07 20:18）。
- 方式：独立 worktree `/tmp/aka-r8`（detached，代码树 = 该 commit）；debug/release 均在本 worktree 重编；未采信仓库内自报，全部证据由本次实跑或逐行读码产生。
- 范围外：主树 `origin/main..main` 还有 4 个未推提交（`204482f` W-49 签字、`8373e3d`、`8add7ce`、`0f40a4b`）；`dev2` 领先 6 个。本报告结论**不覆盖**这些提交。

---

## 1. `W-41` 证据纪律 —— **有条件**

1. 公式确认：`ok: checks.every((check) => !check.blocked && check.passed)`（`app/src/features/watchlist/watchlistDiag.ts:674`），与自报一致；`layers` 是 `tally()` 的 **check 计数**（同文件 678–679）。
2. 数字性质：`7/7`、`14/14`、`9/9`、`1/1` 全部是 **check 数**，不是 AC 覆盖数。本次按 `card+ac` 去重后三张卡的 AC 覆盖为 **5/5、6/6、8/8**，check 数分别为 **21、20、12+9**，即每条 AC 至少一条 check，无 AC 空白。
3. 当前文本未再把 check 数写成 AC 覆盖：审计 4.7.17 已有口径注记（`aka-card-decision-audit-v0.1.md:1033`）；但 gate-log 仍写「21 项全绿」「9 项」而不标「check」，读者仍易误读。
4. 残留缺口（TL 未发现／未写入门禁）：
   - **零 check 真空真**：`every()` 对空数组返回 true；一旦套件漏注册 check，`ok=true` 且 `layers={}` 仍会绿。
   - **star meta 无分母**：`s010201-star-evidence-meta.json` 的 `layers={}`，`ok=true` 来自 9 条 check，meta 自身不给出分母；且 star check 无 `card`（gate-log 也承认）。
   - **s0602 meta 不钉提交**：`s0602-display-evidence-meta.json` 无 `commit`、`dirty=true`，无法按 meta 复算。
5. 证据可复现性（TL 未发现）：正常套件 fixture **只插 497 条 SEED，不清空旧自选**，隐含「自选必须为空」前置。我本机原有 2 条时 `WL-10` 红（`data 6/7`、`render 13/14`）；清空后复绿 `7/7+14/14`。脚本既未清除也未断言该前置。

结论：公式成立、AC 覆盖已齐；但「分母」语义、零 check、star/s0602 meta 与普通套件前置仍需补，故**有条件**。

---

## 2. 三张 watchlist 卡（`S-01.02-01/02/03`，`7abf3b8`）—— **能签（附条件）**

### 2.1 五套件独立复跑（pin 处重编 debug）

| 套件 | 本次结果 | 自报 | 一致 |
|---|---|---|---|
| 正常 | `ok=true`，`data 7/7`、`render 14/14`，`blocked=[]` | 7/7+14/14 | 是（需空自选前置） |
| empty | `ok=true`，`data 0/0`、`render 1/1` | 1/1 | 是 |
| corrupt | `ok=true`，`data 1/1`、`render 1/1`（含 `WL-23-log`） | 1/1+1/1 | 是 |
| readonly | `ok=true`，`data 1/1`、`render 2/2` | 1/1+2/2 | 是 |
| star | `ok=true`，9 条 check 全绿，`layers` 缺失 | 9/9 | 是（check 数） |

归档 meta 五份均为 `commit=7abf3b8…` / `dirty=false`（star 的 `layers={}`）。

### 2.2 反向验证（改一字 / 换 trace）

同一份代码上做四处人为破坏，重编后实跑：

| 破坏 | 预期断言 | 实测 |
|---|---|---|
| `当前数据集为空` → `当前数据集为控` | `WL-22` | **红**：empty `render 0/1` |
| `移出失败，请重试` → `移出失败，请重拭` | `WL-24` | **红**：readonly `render 1/2` |
| `这个分组还没有标的` → `这个分组还没有选中` | `WL-02` | **红**：正常 `render 13/14` |
| 页面 trace 末四位改 `9999`（格式不变） | `WL-23` 应仍绿、`WL-23-log` 应红 | **符合**：`WL-23` 绿，`WL-23-log` red（`data 0/1`） |

另发现：先试过「只在原句后追加一个字」，三处断言**仍绿**——因为断言是 `includes` 子串而非整句相等。「逐字文案」目前只锁住被引用的短语，不锁整句。

### 2.3 附条件

- 普通套件 fixture 必须先清空自选并断言 `total==0`，否则「7/7」依赖开发者本机库状态。
- star 报告补 `card` 与 `layers`，否则 meta 无分母。
- 若「逐字」指整句，应改严格相等或加负向断言（当前后缀可蒙过）。

---

## 3. `S-06.02-01` format 白名单（`ae8f263`）—— **能签（附条件）**

1. 白名单不是「命中即入白名单」：`verify-number-format.mjs` 仅 4 条，全部为几何：
   - `IndicatorReadouts.tsx` 迷你走势 `x/y` 路径；
   - `CandleChart.tsx` 折线路径、`data-overdrag`、箭头 marker 路径。
   分类计数 `几何 4 / 诊断 0 / 读数 0`，无百分比/价格/量/额被白名单兜住；`白名单外 0` 是扫描结果，非循环自证。
2. `formatIndicator` 静态调用确为 **3 处**，但覆盖是 **`%`、`元`、`股`（股→手）**：
   - `%` → `formatPct`；`元` → `formatPrice`；`股` → `formatVolume`（÷100 后 1 位 + 手）。
   - **`手` 不走 `formatIndicator`**：`*手` 分支是 `formatFixed(1)+单位`。因此「3 处 = %、手、元」的说法与代码不符；但该分支仍走 `lib/format`，AC 补3「必须走 format」字面满足。
3. 口径边界：`元` 读数走 `formatPrice`（千分位、2 位），**不做万/亿归一**。B2 实测值小（`DIF 4.80 元` 等）未暴露；若未来出现 ≥1 万的「元」读数，与四类数值里「额→万/亿」冲突。
4. 扫描器只查 `src/components` 内的字面 `toFixed(`（与 AC 补3 描述一致），不覆盖 `Intl.NumberFormat`/`toLocaleString`，也不覆盖 `src/pages`。

---

## 4. `W-47` / `W-48` / `W-49`

### 4.1 `W-47` 四符号 —— 字面达标，**意图不达标（不能签）**

- pin 处重编 release 后 `strings`：`AKA-DIAG-CORRUPT=0`、`--corrupt-db=0`、`--readonly-db=0`、`--empty-dataset=0`，**字面 4/4 为 0**。
- 但同一 release 产物仍含：`AKA_DIAG=2`、`diag_write_named=1`、`diag_write=2`、`diag_faults=1`、`s2-evidence=1`、`AKA_DIAG_TARGET=1`（另有前端 bundle 的 invoke 串）。
- 关键：`diag_write_named` / `write_diag`（`app/src-tauri/src/commands.rs:249-276`）**既无 `#[cfg(debug_assertions)]`、也无运行时开关**，且无条件注册在 `generate_handler!`（`lib.rs:177-178`）。release 下任何前端脚本仍可调用它，把任意文本写到 `~/Library/Application Support/aka/diag/`。`diag_target`（`commands.rs:189`）在 release 下仍读 `AKA_DIAG_TARGET`。
- 结论：W-47「release 不含注入入口」被 4 符号子集掩盖，**不能签**；需给三个 diag 命令加 `cfg` 或把上述串纳入门禁。

### 4.2 `W-48` trace id —— **能签**

- 运行验证：正常 corrupt 跑 `WL-23-log` 绿（页面 `TR-20261107-222138-0002` 命中 `telemetry.jsonl`）；把展示末四位改 `9999`（格式不变）后 `WL-23-log` **红**。说明「页面 id ∈ 日志」是可证伪的同串校验，不是装饰。
- 代码侧同一 `trace_id()` 同时进 `AppError.details.traceId` 与 `telemetry.emit("storage.corrupt", traceId…)`（`error.rs:10-17`、`core.rs:381-395`）。

### 4.3 `W-49` 边界 —— **过宽，不能按现文签**

- 门禁确实会在红路径红：拿 debug（含 4 符号）跑 CI 同款循环 → `gate_exit=1`；pin 处 release → `0`。CI 逻辑本身有效。
- 但「保证交付的 release 二进制不含注入符号」不成立：它只保证**这 4 个串**为 0。上面 `AKA_DIAG`/`diag_write_named` 等仍在产物里，且是活入口。边界一应改写为「门禁只覆盖 4 个指定串，不保证其余注入符号，也不证源码无死引用」。
- 边界二（`db_path` 点重建会打真库）描述准确，保留。

---

## 5. 内容库 44/44（`verify:docs`）

- pin 处实跑：`覆盖 44/44`、`failed=0 skipped=0`、结论 `PASS`；`--self-test` **10/10**。
- V3-02 逐 output：manifest 72 个 output，**逐项命中 formula**；其中 30 个字面命中、42 个经 manifest 别名命中（V3-02 明文允许 `key∪aliases`）。别名均为语义别名（如 `upper←上轨`、`massIndex←Mass`），非凑数。
- 四段无整段重复（44 页四段两两无同文）；抽读 `V09`、`M02` 为实质内容，非模板空话。
- 弱锚点（可被蒙过但不影响本条 PASS）：
  - `V3-01` 是「任一 anchor 命中即过」；`V09` 的 `abbr="High − Low"` 按空格拆出 **`−`（U+2212）**，公式含减号即命中 → `High`/`Low` 均未命中也能过。
  - `M02` 的 `k/d/j`、`T23` 的 `P` 是单字符锚点，天然易命中。
- CI 侧：`verify:docs` 在 `ci.yml` 仍是 `continue-on-error: true`，注释还写「未交付前预期 red」。现在已 44/44，却仍不进门禁——文档绿了但发布不会被它挡。

结论：内容与判据**能签**；建议把 `continue-on-error` 摘掉，并给 V3-01 加「全部 abbr token 命中」或过滤单符号 token。

---

## 6. 分卡结论

| 项 | 结论 |
|---|---|
| W-41 证据纪律 | **有条件** |
| S-01.02-01/02/03 | **能签（附 3 条条件）** |
| S-06.02-01 format | **能签（附 2 条口径注记）** |
| W-47 | **不能签**（4 符号达标，活注入入口仍在） |
| W-48 | **能签** |
| W-49 | **不能签**（边界描述过宽） |
| 内容库 44/44 | **能签（附 CI 门禁条件）** |

## 7. TL 没发现、本次发现

1. **正常 watchlist 套件依赖「自选为空」而未声明**：2 条存量即令 `WL-10` 红；fixture 不清空、不断言。
2. **release 仍可调用 `diag_write_named`**：无 cfg、无运行时门，4 符号门禁看不见；`AKA_DIAG`、`s2-evidence`、`diag_target` 串仍在产物。
3. **`verify:docs` 已 44/44 但 CI 仍 `continue-on-error`**，与「发布门禁」叙事不符。
4. **V3-01 可被单符号锚点蒙过**（`V09` 的 `−`），且只要求任一命中。
5. **`includes` 断言的「逐字」边界**：原句后追加字符不会红，只锁短语不锁整句。
6. **star meta 无 `layers`/无 `card`；s0602 meta 无 `commit` 且 `dirty=true`**，分母与可复算性缺口。
7. **「formatIndicator 3 处 = %/手/元」措辞不准**：`手` 不经 `formatIndicator`，`元` 不做万/亿归一。
