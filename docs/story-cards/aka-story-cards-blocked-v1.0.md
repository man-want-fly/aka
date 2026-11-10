# AKA 重排 · Story 卡阻塞清单 v1.0

| 项目 | 内容 |
|---|---|
| 用途 | 写卡过程中口径定不下来的项，一律登记在此，**不中断写卡**，跳到下一张继续 |
| 影响判定 | `阻塞开工` = 该卡无法写出可断言的 AC 或无法写死技术决定；`不阻塞` = 已按临时口径写死，后续裁定后改口径 |
| 登记时间 | 2026-11-10 |
| 覆盖范围 | EP-05 / EP-06 / EP-07 |

---

## EP-05 编排、缓存与 DTO

### B-05-01 · 数据集重建后的缓存失效口径未定
- 类型：口径缺失 ｜ 影响卡：`S-EP05-05`、`S-EP05-06` ｜ 判定：**不阻塞**（已按临时口径写死）
- 缺什么：仓库里没有明确的「数据集重建」命令入口。`AppCore::replace_state_db`（`core.rs:422`）与 `rebuild_state_db`（`core.rs:430`）操作的是 `state.db`（自选/持仓/设置），**不是**行情数据集；`CandleStore` 的 `SeriesKey` 只有三字段（`data-store/src/lib.rs:66-71`），不含 `dataset_id`，一旦行情数据集被替换，`CandleStore` 会命中旧序列。
- 临时口径（已写进卡）：`calc_cache` 键含 `dataset_id`，天然失效；`CandleStore` 不做主动重置；`calc_cache` 只做容量上限（512 键 FIFO）。
- 需谁定：TL + 数据侧 owner。要回答三问：①「数据集重建」是哪个命令/哪个启动路径；②重建时是否必须清空 `CandleStore` 与 `daily_batches`；③清空由 `AppCore` 自持还是由命令层调用新方法。
- 裁定后要改的卡：`S-EP05-05` 技术决定补「重建时 `invalidate()`」；`S-EP05-06` 增加一条「重建后同参请求必须 miss」的 AC 与反例。

### B-05-02 · `QualityFlag` 线上字符串大小写分裂
- 类型：契约不一致 ｜ 影响卡：`S-EP05-07` ｜ 判定：**不阻塞**（已冻结现值）
- 事实：8 个变体的 `as_str()` 分两套风格 —— `simulated` / `limitUp` / `limitDown` / `splitDay`（camelCase）与 `SUSPENDED` / `EX_RIGHTS` / `ZERO_VOLUME` / `PRICE_ANOMALY`（UPPER_SNAKE），出处 `app/crates/data-provider/src/types.rs:127-160`。
- 临时口径（已写进卡）：**冻结现值不统一**，新增标记一律 UPPER_SNAKE；前端只展示 `simulated`。
- 需谁定：IPC 契约 owner（EP-06 一并裁）。要回答：是否统一为 UPPER_SNAKE（会导致现有 `quality` 数组值变化，牵动质量报告页与既有证据）。
- 裁定后要改的卡：`S-EP05-07` AC6 的 8 值表 + EP-06 的 DTO 冻结清单。

### B-05-03 · 仓库无 `npm test` / ESLint / `check:dto` / `audit:ipc`
- 类型：门禁缺失 ｜ 影响范围：EP-05/06/07 全部卡 ｜ 判定：**不阻塞**（DoD 取证方式改口径）
- 事实：`app/package.json` 无 `test`、无 `check:dto`、无 `audit:ipc`；`app/` 下无 ESLint 配置；前端 34 个 `app/scripts/*.mjs` 由 `.github/workflows/ci.yml` 逐个调起，不是 npm script。
- 临时口径（已写进卡）：Rust 侧 DoD 以 `cargo test -p app-core` 取证；前端侧以 `node app/scripts/<具体脚本>.mjs` 取证；**不得**在卡里写 `npm test`、`npm run check:dto`、`npm run audit:ipc`、`eslint`。
- 需谁定：TL（是否新增统一入口）。属于工程化改造，不在本三 Epic 的交付范围。

---

## EP-06 IPC 契约层

（待 EP-06 写卡时登记）

---

## EP-07 前端基座（壳 / 主题 / 格式 / SIM）

（待 EP-07 写卡时登记）
