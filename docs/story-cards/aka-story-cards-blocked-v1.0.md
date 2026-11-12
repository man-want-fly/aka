# AKA 重排 · Story 卡阻塞清单 v1.0

| 项目 | 内容 |
|---|---|
| 用途 | 写卡时口径定不下来的项一律登记在此。**未裁定的技术选择 = 卡标 Blocked = 踢出可开工集合**，不允许「先写死、以后再说」 |
| 影响判定 | `Blocked` = 卡面出现未裁定的技术选择，需指定裁定人裁定后才能开工；`已关闭` = 按代码事实可复算关闭，不需要人裁定（附关闭依据命令） |
| 计数口径 | 全部由脚本产出：`grep -c '^### B-' 本文件`（=8）、`grep -c '判定：\*\*Blocked\*\*' 本文件`（=6 项）、`grep -c '判定：\*\*已关闭\*\*' 本文件`（=2 项）；**6 项 Blocked 连带 7 张卡**（`B-05-01` 覆盖 3 张、`B-06-02` + `B-06-03` 同卡） |
| 登记时间 | 2026-11-10（2026-11-11 按「未裁定即 Blocked」口径全量重判） |
| 覆盖范围 | EP-05 / EP-06 / EP-07 |

## 状态总览

| 编号 | 影响卡 | 判定 | 缺谁的裁定 |
|---|---|---|---|
| `B-05-01` | `S-EP05-05`、`S-EP05-06`、`S-EP05-03`（依赖连带） | Blocked | TL + 数据侧 owner |
| `B-05-02` | `S-EP05-07` | Blocked | IPC 契约 owner |
| `B-05-03` | 无（已关闭） | 已关闭 | 不需要（代码事实） |
| `B-06-01` | `S-EP06-05` | Blocked | TL + 产品 |
| `B-06-02` | `S-EP06-04` | Blocked | IPC 契约 owner（TL） |
| `B-06-03` | `S-EP06-04` | Blocked | TL + QA 取证 owner |
| `B-07-01` | 无（已关闭） | 已关闭 | 不需要（代码事实） |
| `B-07-02` | `S-EP07-05` | Blocked | 产品 + TL |

Blocked 卡合计 7 张：EP-05 `03/05/06/07`、EP-06 `04/05`、EP-07 `05`（`03` 因依赖 `05` 连带）。复算：`grep -c '^- 状态：Blocked' aka-story-cards-ep05-v1.0.md aka-story-cards-ep06-v1.0.md aka-story-cards-ep07-v1.0.md`（=4 / 2 / 1）。

---

## EP-05 编排、缓存与 DTO

### B-05-01 · 数据集重建后的缓存失效口径未定
- 类型：口径缺失 ｜ 影响卡：`S-EP05-05`、`S-EP05-06`、`S-EP05-03` ｜ 判定：**Blocked**
- 缺什么：仓库里没有明确的「数据集重建」命令入口。`AppCore::replace_state_db`（`core.rs:422`）与 `rebuild_state_db`（`core.rs:430`）操作的是 `state.db`（自选/持仓/设置），**不是**行情数据集；`CandleStore` 的 `SeriesKey` 只有三字段（`data-store/src/lib.rs:66-71`），不含 `dataset_id`，一旦行情数据集被替换，`CandleStore` 会命中旧序列。
- 缺谁的裁定：TL + 数据侧 owner。要回答三问：①「数据集重建」是哪个命令/哪个启动路径；②重建时是否必须清空 `CandleStore` 与 `daily_batches`；③清空由 `AppCore` 自持还是由命令层调用新方法。
- 裁定后要改的卡：`S-EP05-05` 技术决定补「重建时 `invalidate()`」；`S-EP05-06` 增加一条「重建后同参请求必须 miss」的 AC 与反例。
- 卡面现状：`S-EP05-05` / `S-EP05-06` 已标 Blocked；`S-EP05-03` 因依赖 `S-EP05-05` 连带 Blocked。**不得**在裁定前把它们写进 Sprint 排期。

### B-05-02 · `QualityFlag` 线上字符串大小写分裂
- 类型：契约不一致 ｜ 影响卡：`S-EP05-07` ｜ 判定：**Blocked**
- 事实：8 个变体的 `as_str()` 分两套风格 —— `simulated` / `limitUp` / `limitDown` / `splitDay`（camelCase）与 `SUSPENDED` / `EX_RIGHTS` / `ZERO_VOLUME` / `PRICE_ANOMALY`（UPPER_SNAKE），出处 `app/crates/data-provider/src/types.rs:143-153`（复算：`grep -c '=> "' app/crates/data-provider/src/types.rs`）。
- 缺谁的裁定：IPC 契约 owner。要回答：是否统一为 UPPER_SNAKE（会导致现有 `quality` 数组值变化，牵动质量报告页与既有证据）。
- 裁定后要改的卡：`S-EP05-07` AC6 的 8 值表 + EP-06 的 DTO 冻结清单。
- 卡面现状：`S-EP05-07` 已标 Blocked，技术决定段只写事实与两种候选，不预设结论。

### B-05-03 · 仓库无 `npm test` / ESLint / `check:dto` / `audit:ipc`
- 类型：门禁缺失 ｜ 影响范围：EP-05/06/07 全部卡 ｜ 判定：**已关闭**
- 关闭依据（脚本可复算，不需人裁定）：Rust 侧测试早已在 CI 运行 —— `.github/workflows/ci.yml:102` `cargo test --workspace --exclude aka-desktop -- --nocapture`，另有 `ci.yml:105` `cargo test -p indicator-golden`。因此「无 `npm test`」不构成阻塞：EP-05/06 的 Rust 侧 DoD 直接以该命令取证。
- 仍然成立的事实（写卡时必须遵守，不需裁定）：`app/package.json` 无 `test`、无 `check:dto`、无 `audit:ipc`（复算 `grep -c '"test"\|"check:dto"\|"audit:ipc"' app/package.json` = 0）；已有 34 个 `verify:*` npm script（`grep -o '"verify:[^"]*"' app/package.json | wc -l`），`ci.yml` 调起其中 16 个（`grep -c 'npm run verify:' .github/workflows/ci.yml`），另有 10 处直接 `node app/scripts/...`（`grep -c 'node app/scripts' .github/workflows/ci.yml`，位于 `ci.yml:35-69`）；`verify:format` 已定义却未接入 CI（`grep -c 'verify:format' .github/workflows/ci.yml` = 0）。
- 写卡硬规则（已落到三套卡）：**禁止**出现 `npm test` / `npm run check:dto` / `npm run audit:ipc` / `eslint`（这些命令不存在）；新增门禁一律 `verify:*` 命名 + 登记进 `ci.yml`，卡面以 `[新增]` 标注。

---

## EP-06 IPC 契约层

### B-06-01 · 大载荷硬阈值与「超限后是否回退」无人签字
- 类型：口径缺失 ｜ 影响卡：`S-EP06-05` ｜ 判定：**Blocked**
- 缺什么：仓库没有任何载荷上限口径，也没有超限后的产品处置。现状是全 JSON 一次返回，无埋点、无阈值、无回退。
- 缺谁的裁定：TL + 产品。要回答：①`calc ≤ 2 MiB` / `get_bars ≤ 256 KiB` 是否可作为发布门禁（超过即视为缺陷）；②若真实场景超限，接受「界面变慢」还是要求前端拆批（拆批会破坏 `cacheHit` 单次语义，需 EP-05 配合）。
- 裁定后要改的卡：`S-EP06-05` AC1 的阈值数字、反例 1 的构造方式；若选拆批，需新增一张 EP-07 卡承接前端分批与合并。
- 卡面现状：`S-EP06-05` 已标 Blocked，「待裁定」段列出两个阈值与「只埋点不降级」的候选，不写死数值。

### B-06-02 · 模拟安装的 10 个错误码是否并入 `ErrorCode`
- 类型：契约不一致 ｜ 影响卡：`S-EP06-04` ｜ 判定：**Blocked**
- 事实：`sim_install.rs` 用 10 个 `E_` 前缀自由串（`E_DIR_NOT_WRITABLE` 等，复算 `grep -o '"E_[A-Z_]*"' app/crates/app-core/src/sim_install.rs | sort -u | wc -l` = 10），与 `ErrorCode` 13 值**同前缀不同命名空间**；前端 `describeError` 收到 `SimErrorInfo` 时按 `AppError` 直通，因此这 10 个码会原样出现在错误卡上，但 `ErrorCode` 里查不到。
- 缺谁的裁定：IPC 契约 owner（TL）。要回答：①是否把 10 个并入 `ErrorCode`（会变 13 → 23 值，牵动错误卡文案表与既有证据）；②是否允许前端拿未登记 code（当前允许，`describeError` 不校验白名单）。
- 裁定后要改的卡：`S-EP06-04` AC3/AC4 与 DTO 冻结清单；若并入，`S-EP06-04` 的脚本站点 3 从「断言不撞名」改为「断言是同集合」。
- 卡面现状：`S-EP06-04` 已标 Blocked，`SimErrorInfo` 段的结论留空给裁定。

### B-06-03 · `diag_write` / `diag_write_named` 的裸字符串错误是否收口
- 类型：契约不一致 ｜ 影响卡：`S-EP06-04` ｜ 判定：**Blocked**
- 事实：这两条命令返回 `Result<String, String>`（`commands.rs:569-574`、`:593-606`），不走 `AppError`，因此也无法进 `tracked!`（宏内写死 `Result<_, AppError>`），是全仓唯一 2 条无遥测、无错误码的 `pub async fn` 命令（复算 `grep -c 'Result<String, String>' app/src-tauri/src/commands.rs` = 3，含私有 `write_diag`）。
- 缺谁的裁定：TL + QA 取证 owner。要回答：①是否把两条改为 `Result<String, AppError>`（需新增一个 `E_DIAG_WRITE` 或复用 `E_INTERNAL`）；②改动会牵动 38 处调用（`ipc.diagWrite(` 1 + `ipc.diagWriteNamed(` 37，全仓 `diagWrite` 引用 43 处），是否接受。
- 裁定后要改的卡：`S-EP06-04` 的「待裁定」段与反例 3；`S-EP06-01` 的遥测覆盖数 39/7 变为 41/5。
- 卡面现状：`S-EP06-04` 已标 Blocked，脚本站点 4 按 `Result<String, String>` 恰好 2 个判红，防止扩散。

---

## EP-07 前端基座（壳 / 主题 / 格式 / SIM）

### B-07-01 · 首屏内联脚本与将来的 CSP `script-src` 收紧是否冲突
- 类型：口径缺失 ｜ 影响卡：`S-EP07-01`（已解除） ｜ 判定：**已关闭**
- 关闭依据（脚本可复算，不需人裁定）：仓库当前没有任何 CSP —— `grep -c 'Content-Security-Policy' app/index.html` = 0，`app/src-tauri/tauri.conf.json:24` 为 `"csp": null`（`grep -c '"csp": null' app/src-tauri/tauri.conf.json` = 1）。既然不启用 CSP，内联同步脚本不存在冲突；本 Epic 也不引入 CSP。
- 仍然成立的事实（写卡时必须遵守）：门禁 `[新增] app/scripts/verify_boot_theme.mjs` 同时断言「脚本存在于 `index.html`」「位置先于 `#root`」「无 `async`/`defer`/`type=\"module\"`」。将来若谁引入 CSP，这条断言会先红，届时由引入者同 PR 补 `nonce` 或 `sha256` 白名单。
- 结论：`S-EP07-01` 保持可开工；卡面「不碰 `tauri.conf.json` / 构建配置」的边界不变。

### B-07-02 · 字节/时长的格式化口径无产品签字
- 类型：口径缺失 ｜ 影响卡：`S-EP07-05` ｜ 判定：**Blocked**
- 缺什么：`InstallPage.tsx:26-37` 与 `SettingsPage.tsx:30-33` 各自内联了字节与时长格式化，两处进制、小数位、单位大小写都不一致，且仓库没有任何文档规定该用 1024 还是 1000 进制、时长到「分秒」还是「秒」。同卡的 `formatPct(0.0123) → +0.01%` 说明既有口径是**入参为百分数而非比率**，但这条只写在代码里，没有文字依据。
- 缺谁的裁定：产品 + TL。要回答：①字节用 1024（KiB 语义但标 KB）还是 1000；②安装耗时是否需要「分秒」粒度，还是统一秒；③`formatPct` 的百分数入参是否借本次一并改名为 `formatPctValue`（改名会牵动 EP-08 三态卡的 `expectedChangePctText`）。
- 裁定后要改的卡：`S-EP07-05` AC5 的具体样例值、反例 4 的构造；若改名 `formatPct`，需同步 EP-08 三态卡与 `app/scripts/verify-r03-three-state.mjs` 的引用。
- 卡面现状：`S-EP07-05` 已标 Blocked，函数签名与调用点已写死（`formatBytes` / `formatDuration` 的参数与返回类型、四类调用点位置），只把「进位阈值 / 单位后缀 / 小数位 / 粒度」留给裁定，开发不需要再做别的选择。
