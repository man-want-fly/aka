# P09 / P10 交付说明（dev B，dev2）

> 用途：TL 签字、QA 复核的输入。不是台账，不进 gate-log。
> 范围：P09 `S-08.02-03`（`d0a2c60`）、P10 `S-01.03-01`（`9a5e504`）。
> 基线：`origin/main` `0c4fb28`；dev2 已同步（`ac0dabd`、`0cdae4b`）。
> 限制声明：本文所有数字来自静态代码与本地门禁（typecheck / build / verify:\* / cargo test）。dev B **未启动 `aka-desktop`、未跑运行层取证、未出 dump**；运行层结论一律以 BA 取证窗口为准。

---

## 1. P09 `S-08.02-03` 数据集损坏与只读模式

### 1.1 提交范围

`d0a2c60`，16 个文件，+1126 / −58（`git show --stat`）。核心是四块：

| 层 | 文件 | 作用 |
| --- | --- | --- |
| 数据层 | `app/crates/app-core/src/core.rs`、`dto.rs`、`error.rs` | `dataset_integrity(fault)` 五类分类、`readable` 可用性、`dataset.error` 埋点 |
| 启动/门禁 | `app/src-tauri/src/lib.rs`、`state.rs`、`commands.rs` | `--dataset-fault=missing\|manifest\|table\|sha\|db` 解析；`ensure_writable()` 写门禁；`dataset_regenerate` 重建后清故障位 |
| 页面 | `app/src/pages/dataset/DatasetErrorPage.tsx`、`App.tsx`、`app.css` | 全屏错误卡（码 / trace / 路径 / 三路动作）、只读红条 |
| 取证 | `app/src/features/dataset/s080203Diag.ts`、`app/scripts/diag-evidence.sh` | `P09-R1`–`P09-R10`；`s080203` 与 `s080203-readonly` 两个 case |

### 1.2 五类错误与可用性

| `--dataset-fault=` | 错误码 | 标题 | `readable` | 运行层证据 |
| --- | --- | --- | --- | --- |
| `missing` | `MISSING_DIR` | 数据集未找到 | false | `s080203`（有） |
| `manifest` | `MANIFEST_INVALID` | 数据集描述文件损坏 | false | **无**（仅单测） |
| `table` | `REQUIRED_TABLE_MISSING` | 必需数据表缺失 | false | **无**（仅单测） |
| `sha` | `SHA256_MISMATCH` | 数据集校验失败 | true | `s080203-readonly`（有） |
| `db` | `DB_CORRUPT` | 数据文件损坏 | true | **无**（仅单测） |

- 分类逻辑在 [core.rs](file:///Users/sixmillion/Documents/AKA-dev2/app/crates/app-core/src/core.rs#L1325-L1412)：`fault` 命中即短路；`fault=None` 时也有真实分支（`manifest.is_none()`、provider 能力位、`dataset_digest` 不一致）。
- 映射与 `readable` 矩阵由 `cargo test -p app-core` 的 `dataset_integrity_classifies_faults` 覆盖（5 类全断言）；这是**单测**，不是运行层证据。
- `s080203` / `s080203-readonly` 只接入了 `missing` 与 `sha` 两类；`manifest` / `table` / `db` 目前没有脚本 case。

### 1.3 AC ↔ check

| AC | check | 断言内容 | 触发条件 |
| --- | --- | --- | --- |
| AC-08.02-03（主） | `P09-R1` | 错误码 = 注入码；trace、路径非空；复制 / 重建 / 导出按钮存在 | `--dataset-fault=missing` |
| AC-08.02-03（主） | `P09-R3` | `MISSING_DIR` 不提供「只读浏览」 | 同上 |
| AC-08.02-03（主） | `P09-R5` | 全程外部网络请求 0 条 | 同上 |
| AC-08.02-03（主） | `P09-R4` | 重建后错误卡消失、进入 `#/market`、无只读红条、行情行可见 | 同上（**补4 共用**） |
| AC-08.02-03（补1） | `P09-R6` | 「仅只读浏览」红条常驻且无关闭按钮 | `--dataset-fault=sha` |
| AC-08.02-03（补1） | `P09-R7` | K 线可见、计算区提示「已禁用计算」、无计算错误卡 | 同上 |
| AC-08.02-03（补2） | `P09-R8` | 点星标被拒并提示「数据集不可写」，`watchlist` 计数前后不变 | 同上 |
| AC-08.02-03（补2） | `P09-R9` | 切主题被拒并提示「数据集不可写」 | 同上 |
| AC-08.02-03（补3） | `P09-R2` | 错误卡文本不含 `Error:` / 堆栈样式行 | `--dataset-fault=missing` |
| AC-08.02-03（主） | `P09-R10` | 全程外部网络请求 0 条 | `--dataset-fault=sha` |

### 1.4 覆盖边界（签字前请据此判）

1. **主 AC 的 Given 未真实执行**：卡面要求「删除 `data/sim` 目录」，证据全部走 `--dataset-fault=`。按 2026-11-08 证据判法（卡面 5716–5719 行）应记 `Blocked-AC`、`blocker=磁盘数据集未接入`，`sign_scope` 不含主 AC。dev 不替 TL/QA 下结论。
2. **`injected` ≠ 真实触发**：`fault=None` 的真实分支存在，但在 mock 数据下不可达；「只验了注入路径」与「验了真实触发」不等价。
3. **运行层只覆盖 2/5 类**：`manifest` / `table` / `db` 只有单测断言，没有 `diag-evidence.sh` case。
4. **「导出诊断包」只断言按钮存在**（`P09-R1`），未点击、未校验产物落盘。
5. **`DB_CORRUPT` 的「部分表可读」未断言**：只验错误码与只读入口，未验可读部分展示与「部分数据不可读」标注。
6. **0 网络只统计前端 `performance.getEntriesByType("resource")`**，不覆盖 Rust 侧出网；作为离线产品的辅助断言可，但不能当网络层证明。
7. **trace 历史 3 条**：`DatasetErrorPage` 有 `slice(0, 3)` 实现（第 60 行），但无 check 断言。
8. **错误卡上 ⌘K 禁用**：当前 P7 搜索浮层 absent，无实现对象，未断言。
9. **分类锚定已独立（2026-11-08，见附录 A）**：`P09-R1` 的期望码改为脚本 `--expect-code` 传入，与 DTO 比对不一致直接红；分支选择也按期望码走，不再由 DTO 自选分支。`P09-R9` 增加 `data-theme` / `localStorage` / `aria-pressed` 三路不变断言。

### 1.5 Mock / 前置数据

- 必须 debug 构建：`--dataset-fault` 只在 `diag_enabled()` 下解析（`lib.rs` 58–65 行），release 下恒为 `None`。
- 默认 mock 数据集与默认 `state.db`；两个 case 都声明「不改库」（`diag-evidence.sh` 220–234 行）。
- 无真实 `data/sim` 磁盘目录；无真实 sha256 校验对象（`dataset_digest` 在 mock 下的取值决定 `fault=None` 是否误报，需与数据层确认）。

### 1.6 TL 合并 / 签字需额外核

- [ ] 主 AC 是否接受 `Blocked-AC` + 补1–补4 条件签（`trigger=injected`），还是要求先接磁盘数据集。
- [ ] `sign_scope` 只写补1–补4，不含主 AC；`note` 记 `[条件签] trigger=injected`。
- [ ] 五类错误里 `manifest` / `table` / `db` 的运行层缺口是否记入台账备注。
- [ ] 只读写门禁清单是否够：当前 `ensure_writable()` 覆盖 `set_indicator_favorite`、`calc_indicators`、`watch_toggle`、`watch_group_create/rename/delete`、`view_state_set`、`position_save/delete`（`commands.rs` 9 处）。
- [ ] 合并后按 W-97 在新 tip 重取证据；`d0a2c60` 上的旧证据不迁移。

---

## 2. P10 `S-01.03-01` 持仓透视

### 2.1 提交范围

`9a5e504`，7 个文件，+984 / −65：

| 文件 | 作用 |
| --- | --- |
| `app/src/features/watchlist/positions.ts`（新） | 单一派生口径 + 复权模式读写 |
| `app/src/components/Watchlist.tsx` | 持仓块、填写/清除抽屉、校验、停牌徽标、复权提示 |
| `app/src/features/watchlist/s010301Diag.ts`（新） | `P10-R1`–`P10-R9` |
| `app/src/App.tsx`、`WorkbenchPage.tsx` | 诊断路由；复权切换派发 `aka:adj-change` |
| `app/src/styles/app.css` | 持仓块 / 抽屉 / 提示条样式 |
| `app/scripts/diag-evidence.sh` | `s010301` case |

### 2.2 实现口径（代码事实）

[positions.ts](file:///Users/sixmillion/Documents/AKA-dev2/app/src/features/watchlist/positions.ts#L29-L66)：

- 市值 = `lastPrice × shares`
- 浮盈亏 = `(lastPrice − costPrice) × shares`
- 盈亏比例 = `(lastPrice / costPrice − 1) × 100`
- `lastPrice == null` → 三值 `null`，界面「—」；成本价与数量照常显示。

最新价来源（[Watchlist.tsx](file:///Users/sixmillion/Documents/AKA-dev2/app/src/components/Watchlist.tsx#L138-L170)）：

- `ipc.getBars({ timeframe: "D", adj })` 取**当前复权口径**的日线，取**最后一根的 `close`**；不是实时价。
- `suspended = 最后一根 volume <= 0`；停牌徽标只在「有持仓 + 标的存在 + suspended」时显示。
- 缓存键为 `${adj}|${code}`；复权变化按新口径重取，不复用旧值。

### 2.3 AC ↔ check

| AC | check | 层次 | 断言内容 |
| --- | --- | --- | --- |
| AC-01.03-02 | `P10-R1` | 渲染 | 清空持仓后无 `[data-pos-cell]`，列表无 `0.00` / `0%` |
| AC-01.03-01 | `P10-R2` | 数据 | 1500 / 100 / 1682.40 → `168,240.00` / `+18,240.00` / `+12.16%` / `pos` |
| AC-01.03-01（补1） | `P10-R3` | 数据 | 成本改 1600 → 市值不变、`+8,240.00` / `+5.15%` |
| AC-01.03-03（编号见 §3-Q6） | `P10-R4` | 数据 | `lastPrice=null` → 成本 `1,500.00`、数量 `100`、其余「—」 |
| AC-01.03-01 | `P10-R5` | 渲染 | `600519.SH` 成本 1000 / 100 股，按真实末日收盘核算，`data-pos-sign=pos` + `.pos` 类 |
| AC-01.03-01（补1） | `P10-R6` | 渲染 | 改成本 1100 后同帧读三值 |
| AC-01.03-01（补4） | `P10-R7` | 渲染 | 切「不复权」→ 提示文案 + 按不复权收盘重算 |
| AC-01.03-01（补2） | `P10-R8` | 渲染 | `DIAGQSUP.SZ` 停牌徽标「停牌」+ 市值/浮盈亏照常计算 |
| AC-01.03-01（补3） | `P10-R9` | 渲染 | 成本输入 0 → 字段 `aria-invalid=true` + 错误文案，库内仍 1100 |

### 2.4 覆盖边界

1. **卡面例值与 Mock 不一致**：Mock `600519.SH` 末日收盘 **1477.92**，不是卡面的 1682.40。`P10-R2` / `P10-R3` 用 `positionTexts(1500, 100, 1682.4)` 在**数据层**锁定卡面数字；`P10-R5` 改用成本 1000 / 真实收盘，用「收盘×100」与「pnl=市值−100,000」独立核对公式与正红。**渲染层没有复现卡面的 1682.40**。
2. **独立期望值（2026-11-08 改写，见附录 A）**：`P10-R5`–`P10-R8` 已改为解析 DOM 数字后用**手算常量 / 恒等式 / 跨帧差值**核对，不再复用 `positionTexts`。`P10-R2`–`R4` 仍调 `positionTexts`，但对比的是**硬编码常量**，函数错即红。
3. **「标的不在数据集」只有数据层断言**（`P10-R4`），渲染层的灰显 / 「—」没有断言。
4. **停牌判定只看最后一根**：倒数第二根停牌、最后一根正常时不显示徽标；卡面未写该场景。
5. **AC-01.03-03 在卡面不存在**（见 §3-Q6），`P10-R4` 的 AC 归属需 TL 改。

### 2.5 Mock / 前置数据

- `state.db` 先备份到 `/tmp/aka-state-s010301-<label>.db`，套件自建 5 只自选与持仓，取证结束还原。
- 停牌样本 `DIAGQSUP.SZ` 由 `AKA_DIAG=1` 注入（30 根日线，末日停牌）。
- 需要复权控件（`[data-adj-mode="none"]`）可用；套件在工作台页运行。

### 2.6 TL / QA 需额外核

- [ ] 卡面「自选表新增 5 列」vs 实现「行下方持仓块（`data-pos`）」——按哪一种验收。
- [ ] 「市值 / 浮动盈亏」卡面字段格式写「2 位，万/亿」，实现走 `formatPrice`（纯千分位 2 位，无万/亿）；AC 例值 `168,240.00` 支持后者。以哪个为准。
- [ ] 卡面例值 1682.40 与样本包 1477.92 的冲突如何处置（改卡面例值 / 换样本 / 保留数据层断言）。
- [ ] 复权提示条的生命周期（出现后是否常驻、切回是否消失）卡面未写。
- [ ] `P10-R5` 使用成本 1000 而非卡面 1500，签字说明里是否接受。

---

## 3. 口径问题清单（dev 不自行裁定）

| 编号 | 问题 | 现状事实 | 需要谁定 |
| --- | --- | --- | --- |
| Q1 | 成本价是否含手续费 / 印花税 | 卡面写「真实买入价（原始成交价）」；实现按纯成交价，不含任何费用 | 产品 / TL |
| Q2 | 「最新价」是实时价还是最新收盘 | 实现取当前复权口径**最后一根日线收盘**；离线样本无实时价 | 产品 / TL |
| Q3 | 市值 / 浮盈亏格式：万/亿 还是千分位 2 位 | 卡面字段表写「2 位，万/亿」；实现 `formatPrice` 纯千分位；AC 例值支持后者 | TL |
| Q4 | 停牌「按停牌前收盘计」的取值契约 | 实现直接用最后一根日线 `close`；是否等于停牌前收盘取决于数据层对停牌日 `close` 的定义 | 数据层 / TL |
| Q5 | 复权提示条出现后何时消失 | 实现记 `adjChanged=true`，未见自动消失逻辑 | 产品 / TL |
| Q6 | `AC-01.03-03` 编号不存在 | `s010301Diag.ts` 的 `P10-R4` 引用 `AC-01.03-03`；故事卡全文无此编号 | TL（改归属或补 AC） |
| Q7 | 「标的不在数据集」的渲染形态 | 数据层已验证「—」；渲染层是否灰显未断言，CSS 未见专用灰显类 | QA |
| Q8 | 成本价小数位 | 卡面只写「2 位小数」；实现对 >2 位小数直接拒绝（「成本价最多 2 位小数」） | 产品 / TL |
| Q9 | 持仓块与「列」的语义 | 卡面写「列固定在涨跌幅之后」；实现为行下方块 | TL（同 §2.6 第 1 条） |

---

## 附录 A：取证断言独立性清单（2026-11-08）

扫描范围：dev B 写过的 `s080202Diag.ts`、`batchDiag.ts`（仅 P07 段）、`s080203Diag.ts`、`s010301Diag.ts`、`diag-evidence.sh`。目的是区分「能证明公式」与「只能证明接线」的断言。P06 / P07 套件当晚签字，**未改动**。

### A.1 原问题（清单当时的 6 处）

| # | 卡 | check | 原期望值来源 | 只能证明什么 | 独立替代来源 |
| --- | --- | --- | --- | --- | --- |
| 1 | P10 | `P10-R5` | `positionTexts(1000,100,close)`，与页面同一函数 | 接线 | 手算 `close×100`、恒等式 `pnl=市值−100,000` |
| 2 | P10 | `P10-R6` | 同上，成本 1100 | 接线 | 跨帧差值 `pnl(R6)=pnl(R5)−10,000`、市值同 R5 |
| 3 | P10 | `P10-R7` | 同上，`noneClose` | 接线 | 手算 `noneClose×100`、恒等式、且市值随口径变化 |
| 4 | P10 | `P10-R8` | 同上，停牌样本 | 接线 | 手算 `停牌前收盘×100`、恒等式 `pnl=市值−10,000` |
| 5 | P09 | `P09-R1` | `integrity.errorCode`（页面渲染的同一 DTO 字段） | 卡片显示 DTO | 脚本 `--expect-code` 独立给出期望码 |
| 6 | P09 | 分支选择 | 同一个 `integrity.errorCode` | 分类错时会跑错分支并「通过」 | 脚本期望码先比对，不一致直接红、不跑分支 |

### A.2 改写结果（第三档：仅 P06/P07 不动）

| check | 改写后的期望值来源 | 说明 |
| --- | --- | --- |
| `P10-R5` | 手算 `close×100`、`(close−1000)×100`、`(close/1000−1)×100` + 恒等式 `pnl=市值−100,000` + 格式正则 | `detail` 写明算式与 DOM 实值 |
| `P10-R6` | 市值应等于 R5；`pnl(R6)=pnl(R5)−10,000`；恒等式 `pnl=市值−110,000`；比例手算 | 跨帧差值属多路径交叉 |
| `P10-R7` | 手算 `noneClose×100`、`(noneClose−1100)×100`、恒等式；并断言 `marketValue(qfq) ≠ marketValue(none)`（两口径收盘不同时） | 最后一条才证到「按新口径重取」 |
| `P10-R8` | 手算 `停牌前收盘×100`、`(停牌前收盘−100)×100`、恒等式 `pnl=市值−10,000` | 徽标文本仍为字面量 |
| `P09-R1` | 期望码来自脚本 `--expect-code`；DOM 码必须等于期望码，且 DTO 码也必须等于期望码；`path` 与 DTO 比对 | 分类错误时 DTO 与期望码不一致 → 红 |
| `P09-R9` | 三路不变：`data-theme`、`localStorage["aka.theme"]`、按钮 `aria-pressed` | 提示文案出现但实际写成功会被抓到 |

### A.3 相邻弱断言（本次未改，需 TL 判）

1. `P07-R3` 的正则 `^\d\/6` 不校验分子，`6/6` 也会过；分子只靠 `P07-R5` 的 `startsWith("1/6")` 锁。**已交 TL，dev 未动。**
2. `P06` 无同函数期望值；`P06-R5` 的 `elapsed` 读被测元素，但边界（7000–9500ms）独立。
3. `diag-evidence.sh` 四个 case 只做环境编排，不含期望值计算。

### A.4 判定口径

- **能证公式**：期望值来自手算常量、恒等式或跨路径差值，实现改错必然红。
- **只能证接线**：期望值由被测实现同一函数/同一 DTO 现算，实现错时两边一起错。
- 本附录不改变签字权归属；QA 复核以本节为输入。

---

## 4. 附：本次未做的事

- 未启动 `aka-desktop`、未跑 `diag-evidence.sh`、未生成任何 dump。
- 未改台账、gate-log、签字台账、证据目录。
- 未合并 `main`、未推送 `dev2`。
- 未对 §3 的 Q1–Q9 做取舍或改代码。
