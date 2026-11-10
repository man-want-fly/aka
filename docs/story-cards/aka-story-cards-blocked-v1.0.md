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

### B-06-01 · 大载荷硬阈值与「超限后是否回退」无人签字
- 类型：口径缺失 ｜ 影响卡：`S-EP06-05` ｜ 判定：**不阻塞**（已按临时口径写死）
- 缺什么：仓库没有任何载荷上限口径，也没有超限后的产品处置。现状是全 JSON 一次返回，`calc_indicators` 44 实例 × 520 根的最坏体积约 1.31 MiB，无埋点、无阈值、无回退。
- 临时口径（已写进卡）：硬阈值 `calc ≤ 2 MiB` / `get_bars ≤ 256 KiB`；超限**不截断、不分页、不报错**，只发 `ipc.payload.large` 遥测；明确拒绝 arrow / 分页 / 压缩三条替代路线。
- 需谁定：TL + 产品。要回答：①2 MiB 是否可作为发布门禁（超过即视为缺陷）；②若真实场景超限，接受「界面变慢」还是要求前端拆批（拆批会破坏 `cacheHit` 单次语义，需 EP-05 配合）。
- 裁定后要改的卡：`S-EP06-05` AC1 的阈值数字、反例 1 的构造方式；若选拆批，需新增一张 EP-07 卡承接前端分批与合并。

### B-06-02 · 模拟安装的 10 个错误码是否并入 `ErrorCode`
- 类型：契约不一致 ｜ 影响卡：`S-EP06-04` ｜ 判定：**不阻塞**（已冻结现值）
- 事实：`sim_install.rs` 用 10 个 `E_` 前缀自由串（`E_DIR_NOT_WRITABLE` 等），与 `ErrorCode` 13 值**同前缀不同命名空间**；前端 `describeError` 收到 `SimErrorInfo` 时按 `AppError` 直通，因此这 10 个码会原样出现在错误卡上，但 `ErrorCode` 里查不到。
- 临时口径（已写进卡）：**冻结为独立命名空间**，不并入 `ErrorCode`；文档 `docs/reference/error-codes.md` 单列 C 段。
- 需谁定：IPC 契约 owner。要回答：①是否把 10 个并入 `ErrorCode`（会变 13 → 23 值，牵动错误卡文案表与既有证据）；②是否允许前端拿未登记 code（当前允许，`describeError` 不校验白名单）。
- 裁定后要改的卡：`S-EP06-04` AC3/AC4 与 DTO 冻结清单；若并入，`S-EP06-04` 的脚本站点 3 从「断言不撞名」改为「断言是同集合」。

### B-06-03 · `diag_write` / `diag_write_named` 的裸字符串错误是否收口
- 类型：契约不一致 ｜ 影响卡：`S-EP06-04` ｜ 判定：**不阻塞**（已冻结现值，只登记）
- 事实：这两条命令返回 `Result<String, String>`（`commands.rs:569-574`、`593-606`），不走 `AppError`，因此也无法进 `tracked!`（宏内写死 `Result<_, AppError>`），是全仓唯一 2 条无遥测、无错误码的命令。
- 临时口径（已写进卡）：不改签名；前端依赖 `describeError` 的兜底归入 `E_INTERNAL`；在脚本站点 4 断言「`Result<_, String>` 恰好 2 个」，防止扩散。
- 需谁定：TL。要回答：①是否把两条改为 `Result<String, AppError>`（需新增一个 `E_DIAG_WRITE` 或复用 `E_INTERNAL`）；②改动会牵动 38 处取证调用（`ipc.diagWrite(` 1 + `ipc.diagWriteNamed(` 37），是否接受。
- 裁定后要改的卡：`S-EP06-04` 技术决定最后一条「不改签名」+ 反例 3；`S-EP06-01` 的遥测覆盖数 39/7 变为 41/5。

---

## EP-07 前端基座（壳 / 主题 / 格式 / SIM）

（待 EP-07 写卡时登记）
