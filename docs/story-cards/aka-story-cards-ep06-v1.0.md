# AKA 重排 · EP-06 IPC 契约层 · Story 卡 v1.0

| 项目 | 内容 |
|---|---|
| Epic | **EP-06 IPC 契约层**（命令面、DTO 线上形状、旧命令处置、错误码边界、载荷预算、前端出口唯一化） |
| 不在本 Epic | 不改指标公式与缓存语义（EP-05）、不做页面状态与渲染（EP-07）、不改数据源实现 |
| 卡数 / 点数 | **7 张，全部 P0；20 故事点** |
| 编写规则 | 《Story 卡编写规则》，逐条执行：标题动宾 / 产品三句话 / Given-When-Then / 优先级·故事点 / 依赖备注 / DoD |
| 卡面结构 | 规则六项必含字段在前；**技术决定（TL，开发期不再讨论）**、**可致红反例（QA）**、**Task 拆解（Dev）** 在后 |
| 编号规则 | `S-EP{两位 Epic}-{两位序号}`。EP-05 = 编排/缓存/DTO，EP-06 = IPC 契约层，EP-07 = 前端基座；**既有 `E-01…E-08` 是模块编号，不作为 Epic 编号**。每张卡头部标 `模块编号 + 原卡号` |
| 落点基准 | `main@3192b76`（worktree `AKA-ep0507`，分支 `ep0507/story-cards`），行号可直接跳转核对 |
| 代码状态 | 已实现 6 张 / **未实现 1 张**（`S-EP06-07` 参数值归一化） |
| blocked | 1 项（`B-06-01` 载荷阈值上限谁签字），登记见 `aka-story-cards-blocked-v1.0.md`；不阻塞开工 |

---

## 0. 口径锁定（本 Epic 内禁止再讨论的既有事实）

| 事实 | 现值 | 出处 |
|---|---|---|
| 命令注册表 | **debug 46 条** | `app/src-tauri/src/lib.rs:200-247` |
| 命令注册表 | **release 41 条** | `app/src-tauri/src/lib.rs:249-291` |
| release 差集 | 恰 5 条：`diag_env` / `diag_faults` / `diag_set_inject` / `diag_write` / `diag_write_named`；release-only 为空 | 本次脚本比对，`lib.rs` 两份 handler |
| 命令实现 | 46 个 `#[tauri::command] pub async fn`，无重复名 | `app/src-tauri/src/commands.rs` |
| 前端出口 | `app/src/lib/ipc.ts` 内 **46 个 wrapper**，与 debug 注册表 **1:1 双向相等** | `ipc.ts:73-233`；`calcIndicators` 在 `ipc.ts:143-144` |
| Tauri 依赖面 | 全仓只有 `ipc.ts:1` 一处 `import ... from "@tauri-apps/api/core"` | `rg "@tauri-apps/api" app/src` |
| 遥测覆盖 | 46 条中 **39 条**走 `tracked!`；**7 条不记**（无 `State` 参数）：`diag_enabled` / `diag_target` / `diag_build_info` / `diag_env` / `diag_write` / `diag_write_named` / `reveal_diagnostics` | `commands.rs:20-33` |
| DTO 数量 | `dto.rs` 共 **39 个 `pub struct`**，全部 `#[serde(rename_all = "camelCase")]` | `app/crates/app-core/src/dto.rs` |
| 前端类型 | `types.ts` 共 **64 个** `interface/type`；39 个同名 DTO **字段零漂移**（本次逐字段比对） | `app/src/lib/types.ts` |
| 错误码 A | `ErrorCode` **13 值**，全 `E_` 前缀，随 `AppError` 出口 | `app/crates/app-core/src/error.rs:46-85` |
| 错误码 B | `DatasetErrorCode` **5 值**，**无前缀**，只是 `DatasetIntegrityDto.errorCode` 的字段值，不是错误返回 | `app/src/lib/types.ts:343-348`、`dto.rs:590-591` |
| 错误码 C | `SimErrorInfo.code` **自由字符串**，同一语义多值（`E_DIR_NOT_WRITABLE` 出现 3 次：`sim_install.rs:184/252/274`） | `app/crates/app-core/src/sim_install.rs:48-51` |
| 错误码 D | `diag_write` / `diag_write_named` 返回 `Result<String, String>`，**裸字符串错误**，不满足 `AppError` 形状 | `commands.rs:569-574`、`593-606` |
| `tracked!` 约束 | 宏内部写死 `Result<_, AppError>`，因此 D 类两条无法接入遥测 | `commands.rs:23-27` |
| 规划命令残留 | 架构文档 §4 仍写「只注册了 4 条」，并列 6 条「规划（未注册）」命令：`app_info` / `provider_status` / `indicator_spec` / `load_state` / `save_state` / `rebuild_dataset` —— 代码里**一条都不存在** | `docs/architecture/aka-module-architecture.md:115-133` |
| 工程门禁现状 | 无 `check:dto`、无 `audit:ipc`、无 `npm test`、无 ESLint；但已有 **34 个 `verify:*` npm script**，`ci.yml` 调起其中 **16 个**（另 10 处直接 `node app/scripts/…`）；`verify:format` 已定义却**未接入 CI** | `app/package.json:6-47`、`.github/workflows/ci.yml:126-180` |

> 读卡顺序：`01 → 02 → 04 → 06` 是契约主线；`03 → 05 → 07` 可并行。

---

## S-EP06-01 · 冻结命令面 46 与 41 的条件注册差集

- 模块编号：E-01…E-08 全量（命令清单横跨 8 个模块）｜原卡号：`S-IPC-01`（规划工作台）
- 优先级：P0 ｜ 故事点：3 ｜ 依赖：无（本 Epic 首卡）
- 负责人：待 Sprint 规划指派 ｜ 备注：只冻结「哪些命令存在、哪些只在 debug 存在」，不新增命令

**用户故事（产品）**
作为运维与 QA，我希望发布包里根本不包含诊断写盘命令，
以便用户装到的正式版本没有任何可被诱导写文件的入口。

**验收标准（BA）**
- 给定 debug 构建，当 读 `lib.rs:200-247` 的 `generate_handler!` 列表，则 恰 **46** 条、无重复、每条都能在 `commands.rs` 找到同名 `#[tauri::command]`
- 给定 release 构建，当 读 `lib.rs:249-291`，则 恰 **41** 条，且 `debug − release` 恰为 `{diag_env, diag_faults, diag_set_inject, diag_write, diag_write_named}`，`release − debug` 为空集
- 给定 `app/src/lib/ipc.ts`，当 提取全部 `invoke<...>("…")`，则 46 个 wrapper、46 个唯一命令名，与 debug 注册表**双向相等**（`used − registered = ∅` 且 `registered − used = ∅`）
- 给定 全仓 `app/src`，当 搜索 `@tauri-apps/api`，则 命中行数 = 1，且文件为 `app/src/lib/ipc.ts`
- 给定 5 条 debug-only 命令，当 扫描 `app/src`，则 调用点只出现在 `*Diag*.ts` / `App.tsx` 取证路径，`pages/**` 下**零命中**
- 给定 门禁脚本 `node app/scripts/verify_ipc_surface.mjs`，当 在 `main` 上运行，则 退出码 0 并打印 `46/41/5/46`

**技术决定（TL · 开发期不再讨论）**
- 落点：`app/src-tauri/src/lib.rs:200`（debug builder）、`lib.rs:249`（release builder）；`#[cfg(debug_assertions)]` **同时**作用在 `commands.rs` 的函数定义与 `lib.rs` 的注册项上，两处必须成对
- 前端唯一出口：`app/src/lib/ipc.ts:67` 的 `const invoke = <T>(command, args?) => { invokeAudit?.(command); return tauriInvoke<T>(command, args); }`；`ipc` 对象 `ipc.ts:73-233`
- 门禁脚本契约（新建 `app/scripts/verify_ipc_surface.mjs`，ESM，`node:` 内置模块，零依赖）：
  1. 用 `/#\[cfg\(debug_assertions\)\]\s*let builder = builder\.invoke_handler\(tauri::generate_handler!\[(.*?)\]\);/s` 与 `/#\[cfg\(not\(debug_assertions\)\)\]\s*let builder = builder\.invoke_handler\(tauri::generate_handler!\[(.*?)\]\);/s` 各取一段
  2. 段内 `commands::(\w+)` 去重后计数，断言 `46 / 41`
  3. 断言差集字面等于上述 5 元组（顺序无关）
  4. 读 `app/src/lib/ipc.ts`，`/invoke<[^>]*>\("(\w+)"/g` 取命令名，断言集合相等
  5. 读 `app/src/**/*.{ts,tsx}`，断言 `@tauri-apps/api` 只出现在 `lib/ipc.ts`
  6. 扫 `ipc.(diagWrite|diagWriteNamed|diagFaults|diagSetInject|diagEnv)` 的调用文件，断言文件名含 `Diag` 或等于 `App.tsx`
  7. 退出码：全部通过 0；任一失败 1，并打印 `期望 / 实际` 两列，禁止只打印一句「不一致」
- 登记方式：`app/package.json` 新增 `"verify:ipc": "node scripts/verify_ipc_surface.mjs"`（与既有 34 个 `verify:*` 同构），并在 `.github/workflows/ci.yml` 的 node 段（`ci.yml:126-180`）追加 `run: npm run verify:ipc`；**不新增 `npm test` / `check:dto` / `audit:ipc`**（这三条命令不存在，见 `B-05-03`）
- 不做：不把 5 条 debug 命令并入 release；不改任何命令名；不引入 `plugin-*` 命令命名空间

**可致红反例（QA）**
1. 在 `lib.rs:250` 后加一行 `commands::diag_write,` → 脚本打印 `release=42`、`release-only=[diag_write]` → AC2 红
2. 删除 `lib.rs:200` 上方的 `#[cfg(debug_assertions)]`（改为无条件注册同一列表）→ release 变 46 条 → AC2 红
3. 删除 `ipc.ts:160` 的 `diagEnv` wrapper → 脚本 `registered − used = [diag_env]` → AC3 红
4. 在 `app/src/pages/market/MarketPage.tsx` 顶部加 `import { invoke } from "@tauri-apps/api/core"` → AC4 红（命中 2 行）
5. 在 `MarketPage.tsx` 渲染路径调用 `ipc.diagWriteNamed("x", "{}")` → 脚本第 6 项命中 `pages/` → AC5 红

**Task 拆解（Dev）**
1. 新建 `app/scripts/verify_ipc_surface.mjs`，按上述 7 条实现，先跑出当前基线 `46/41/5/46` 并写入脚本头注释
2. `package.json` 加 `"verify:ipc"`，`ci.yml` 加 `run: npm run verify:ipc`；本地以 `node app/scripts/verify_ipc_surface.mjs` 取证
3. `commands.rs:1-19` 头部补 6 行注释：46/41/5、39 tracked / 7 untracked，注明差集 5 条命令名
4. 不写 Rust 单测（本卡是文件级契约，Rust 侧无运行期行为可断言）

**完成定义 DoD**
单测通过（脚本退出 0）· 联调通过 · 产品验收 · 文档更新（`commands.rs` 头注释）

---

## S-EP06-02 · 冻结 DTO 线上形状与前端类型零漂移

- 模块编号：E-01 行情与自选 / E-02 个股工作台 / E-03 指标库 / E-07 数据源 / E-08 错误态 ｜原卡号：`S-IPC-02`（规划工作台）
- 优先级：P0 ｜ 故事点：4 ｜ 依赖：`S-EP05-09`（DTO 形状六条 AC 已冻结外层：`engineVersion` 字符串、`warmup` 数字）
- 负责人：待 Sprint 规划指派 ｜ 备注：本卡只冻结**字段名与可空性**，不改业务取值

**用户故事（产品）**
作为前端开发，我希望所有跨进程字段一次性冻结成 camelCase 且可空性明确，
以便后端改一个字段名不会在发布后才以「界面上少一列」的形式暴露。

**验收标准（BA）**
- 给定 `app/crates/app-core/src/dto.rs`，当 统计 `pub struct`，则 = **39**，且每个 struct 上有 `#[serde(rename_all = "camelCase")]`
- 给定 `app/src/lib/types.ts`，当 逐个同名结构比对字段集，则 39 个同名 DTO **字段集合完全相等**（实测 0 漂移，作为基线）
- 给定 `BarDto`，当 序列化一根 K 线，则 键为 `ts/date/open/high/low/close/volume/amount/adjFactor/source/quality/batchId/ingestedAt`，`quality` 是 `string[]`，`batchId`/`ingestedAt` 缺值时为 `null` 而**不是**省略键
- 给定 `CalcResponse`，当 序列化，则 `engineVersion` 是**字符串**，`series[i].engineVersion` 是**数字**（外层 `&'static str`、内层 `u16`，两者不是同一字段）
- 给定 任意 `Option<T>` 字段缺值，当 序列化，则 键存在且值为 `null`；**唯一例外**是 `AppError.details`（`error.rs:100` 带 `skip_serializing_if = "Option::is_none"`，缺值时键不出现）
- 给定 `node app/scripts/verify_dto_ts.mjs`，当 在 `main` 上运行，则 退出码 0，打印 `39 matched / 0 drifted`
- 给定 `kind`/`category`/`status` 等枚举位置，当 序列化，则 值为 camelCase（如 `line` / `histogram` / `dot` / `trend`），**不得**出现 Rust 变体名（`Line` / `Trend`）

**技术决定（TL · 开发期不再讨论）**
- 落点：`app/crates/app-core/src/dto.rs`（39 个 struct）；`app/crates/indicator-core/src/meta.rs:7-13,30-33`（`Category` / `OutputKind` 均 `rename_all = "camelCase"`）；`app/crates/indicator-core/src/param.rs:69-76`（`ParamValue` 为 `#[serde(untagged)]`，见 `S-EP06-07`）
- 前端镜像：`app/src/lib/types.ts`，**手工维护**，不加代码生成（不引 `ts-rs` / `specta`，见本条「不做」）
- 门禁脚本契约（新建 `app/scripts/verify_dto_ts.mjs`）：
  1. 解析 `dto.rs` 的 `pub struct (\w+) {…}`，取 `pub (\w+):` 字段名并转 camelCase
  2. 解析 `types.ts` 的 `export interface (\w+) {…}`，取 `(\w+)\??:` 字段名
  3. 只比对**两侧同名**的结构；断言字段集相等，输出 `rust-only` / `ts-only` 两列
  4. 断言同名结构数 = 39；`dto.rs` 中未出现在 `types.ts` 的只允许 `ListSecuritiesRequest` / `RegistryRequest`（入参不在前端声明）
  5. 退出码 0/1，失败时逐结构打印差异
- 冻结清单（本卡签发，后续 EP 不得改）：`SecurityDto` `ListSecuritiesRequest` `GetBarsRequest` `BarDto` `BarProvenanceDto` `BarProvenanceRequest` `ProvenanceDto` `BarsResponse` `RangeDto` `RegistryRequest` `InputsDto` `OutputSpecDto` `IndicatorMetaDto` `RegistryResponse` `IndicatorFavoriteDto` `IndicatorFavoritesResponse` `RecentViewDto` `QualityExampleDto` `QualityCheckDto` `QualityReportDto` `DatasourceCapabilityDto` `DatasourceOpsDto` `DatasetVersionDto` `DatasourceStatusDto` `InstanceRequest` `CalcRequest` `OutputSeriesDto` `SeriesDto` `CalcResponse` `MarketSnapshotDto` `MarketRowDto` `WatchGroupDto` `WatchItemDto` `WatchlistDto` `WatchToggleResult` `PositionDto` `DataHealthItemDto` `DataHealthDto` `DatasetIntegrityDto`
- 不做：不引 `ts-rs` / `specta` / `json-schema` 生成（会与 `types.ts` 现有 64 个手写类型冲突）；不改 `AppError.details` 的 `skip_serializing_if`（会破坏 EP-08 错误卡「无 details 就不渲染详情行」）

**可致红反例（QA）**
1. 把 `types.ts` 里 `BarDto.adjFactor` 改名为 `adj_factor` → 脚本 `BarDto ts-only=[adj_factor] rust-only=[adjFactor]` → AC2 红
2. 在 `dto.rs:66` 把 `pub adj_factor: f64` 改名 `adj` → AC3 红（键名断言）+ AC2 红
3. 给 `CalcResponse.engine_version` 加 `#[serde(serialize_with = ...)]` 输出数字 → AC4 红
4. 给 `dto.rs:71` 的 `batch_id` 加 `#[serde(skip_serializing_if = "Option::is_none")]` → AC5 红（键消失）
5. 把 `meta.rs:29` 的 `OutputKind` 去掉 `rename_all = "camelCase"` → AC7 红（出现 `"Line"`）

**Task 拆解（Dev）**
1. 新建 `app/scripts/verify_dto_ts.mjs`，先跑基线 `39 matched / 0 drifted`
2. `package.json` 加 `"verify:dto"`，`ci.yml` node 段加 `run: npm run verify:dto`
3. `dto.rs:1-7` 头注释补一行「39 个 DTO，字段名改动必须同步 `app/src/lib/types.ts`，门禁 `verify_dto_ts.mjs`」
4. Rust 侧补 2 个序列化单测（放 `dto.rs` 底部 `#[cfg(test)]`）：`option_fields_serialize_as_null`、`output_kind_is_camel_case`

**完成定义 DoD**
单测通过（2 个新 Rust 单测 + 脚本退出 0）· 联调通过 · 产品验收 · 文档更新（`dto.rs` 头注释）

---

## S-EP06-03 · 清理架构文档里的规划命令与过期条数

- 模块编号：E-01 行情与自选 / E-07 数据源与模拟 ｜原卡号：`S-IPC-03`（规划工作台）
- 优先级：P0 ｜ 故事点：2 ｜ 依赖：`S-EP06-01`（先有 46/41 的权威清单）
- 负责人：待 Sprint 规划指派 ｜ 备注：只改文档，不改代码；**不得**为了对齐文档去补实现

**用户故事（产品）**
作为新加入的开发，我希望架构文档里的命令表就是代码里真实存在的命令，
以便我照文档接线时不会调用一条根本不存在的命令。

**验收标准（BA）**
- 给定 `docs/architecture/aka-module-architecture.md:115`，当 读该句，则 不再出现「只注册了 **4 条**」；改为「已注册 **46 条**（release 41 条，debug 多 5 条诊断命令）」
- 给定 同一文档 `:117-131` 的命令表，当 逐行核对 `commands.rs`，则 表中每一行都对应真实命令；6 条规划命令 `app_info` / `provider_status` / `indicator_spec` / `load_state` / `save_state` / `rebuild_dataset` **全部删除**
- 给定 `:120` 的 `get_bars` 行，当 读请求字段说明，则 写「`from`/`to` 为 `YYYY-MM-DD` 日期区间，含端点，非交易日自动吸附」，删除「**数组下标**」表述
- 给定 `:133` 的整段引注，当 读，则 删除（该段只在「下标」口径下成立，现已过期）
- 给定 `:125` 的 `dataset_manifest` 行，则 状态从「规划（未注册）」改为「已实现」，请求改为「无」、响应改为 `DatasetManifest | null`
- 给定 文档表格行数，当 与 46 条命令比对，则 覆盖 46 条中的**全部**，允许拆分到「业务命令 / 诊断命令」两张表
- 给定 `node app/scripts/verify_ipc_surface.mjs --docs`，当 运行，则 断言文档命令表与 `lib.rs` 注册表一致，退出码 0

**技术决定（TL · 开发期不再讨论）**
- 落点：`docs/architecture/aka-module-architecture.md:113-135`
- 表格结构固定为两张：
  - 「业务命令（41 条，release 可见）」列：命令 / 请求 / 响应 / 错误码 / 状态
  - 「诊断命令（debug 专属 5 条）」列：命令 / 请求 / 响应 / 说明
- 数据来源：`commands.rs` 的 46 个 `pub async fn` 签名 + `dto.rs` 的 39 个 struct + `error.rs:46-85` 的 13 个错误码
- 脚本扩展：`verify_ipc_surface.mjs` 增 `--docs` 分支，用 `^\| \`(\w+)\` \|` 抓文档表格命令名，与注册表求差集；差集非空即退出 1
- 不做：不新增命令补齐文档；不保留「规划中」占位行（未实现的命令一律不写进表）

**可致红反例（QA）**
1. 保留 `provider_status` 一行 → `--docs` 报 `docs-only=[provider_status]` → AC2/AC7 红
2. 把 `:120` 改回「`from`/`to` 为数组下标」→ AC3 红（脚本文本断言 + 人工复核）
3. 文档只列 41 条业务命令、漏掉 5 条诊断命令 → AC6 红（覆盖 41/46）

**Task 拆解（Dev）**
1. 重写 `aka-module-architecture.md` §4 为两张表，命令名逐条从 `lib.rs` 复制
2. 删除 `:133` 引注，修正 `:120` / `:125`
3. `verify_ipc_surface.mjs` 增 `--docs` 分支
4. `package.json` 加 `"verify:ipc:docs": "node scripts/verify_ipc_surface.mjs --docs"`，`ci.yml` 加对应 `npm run`

**完成定义 DoD**
单测通过（脚本 `--docs` 退出 0）· 联调通过 · 产品验收 · 文档更新

---

## S-EP06-04 · 划清四类错误形状的边界与出口

- 模块编号：E-08 空态·错误态（主）/ E-07 数据源与模拟（sim 段）｜原卡号：`S-IPC-04`（规划工作台）
- 优先级：P0 ｜ 故事点：4 ｜ 依赖：`S-EP06-02`（DTO 冻结后才有稳定的错误载体）
- 负责人：待 Sprint 规划指派 ｜ 备注：原卡写「三套错误码」，代码事实是**四套形状**（A/B/C/D），本卡按事实写

**用户故事（产品）**
作为用户，我希望任何失败都给出同一个可判断的形状与一个能报给客服的追踪号，
以便我不会看到「一串英文异常」这种无处申诉的提示。

**验收标准（BA）**
- 给定 任一业务命令（`commands.rs` 中 46 条里的 44 条），当 失败，则 返回 `AppError { code, message, retryable, details? }`，`code` ∈ `ErrorCode` 的 **13** 个 `E_` 前缀值
- 给定 `ErrorCode`，当 枚举 `as_str()`，则 13 个值逐一等于：`E_UNKNOWN_SECURITY` `E_DATASET_MISSING` `E_UNSUPPORTED` `E_INVALID_ARGUMENT` `E_UNKNOWN_INDICATOR` `E_PARAM_OUT_OF_RANGE` `E_PARAM_ORDER` `E_INSUFFICIENT_DATA` `E_TIMEOUT` `E_ENGINE_PANIC` `E_DATA_UNAVAILABLE` `E_DATASET_READONLY` `E_INTERNAL`，**全部带 `E_` 前缀**
- 给定 `DatasetIntegrityDto`，当 `state = "blocked"`，则 `errorCode` 取 5 个**无前缀**值之一：`MISSING_DIR` / `MANIFEST_INVALID` / `REQUIRED_TABLE_MISSING` / `SHA256_MISMATCH` / `DB_CORRUPT`；该值**只作字段**，不构成 `AppError`
- 给定 `SimInstallStatus.error`，当 安装失败，则 形状为 `{ code: string, message: string }`，`code` 复用 `E_` 前缀但**不在** `ErrorCode` 13 值内；实有 **10** 个：`E_DIR_NOT_WRITABLE` / `E_DISK_INSUFFICIENT` / `E_SENTINEL_WRITE` / `E_DB_OPEN` / `E_DB_WRITE` / `E_DB_VERIFY` / `E_GATE_C_FAILED` / `E_MANIFEST_WRITE` / `E_REPORT_WRITE` / `E_REBUILD_DELETE`
- 给定 `diag_write` / `diag_write_named` 失败，当 前端 `describeError` 收到，则 归入 `E_INTERNAL` 且 `retryable=false`；**此为已知例外**，本卡不改命令签名，只登记
- 给定 超时，当 `calc_indicators` 超过 `CALC_TIMEOUT_MS = 8_000`，则 `code = "E_TIMEOUT"`、`retryable = true`、`details = { traceId, elapsedMs, thresholdMs, indicator }`，且同时落 `calc.timeout` 遥测
- 给定 任一 `AppError` 带 `traceId`，则 `details.traceId` 形如 `TR-YYYYMMDD-HHMMSS-NNNN`，且错误卡展示该串
- 给定 `node app/scripts/verify_error_codes.mjs`，当 运行，则 抓 `error.rs` 的 `as_str` 13 值 + `types.ts:343-348` 的 5 值 + `sim_install.rs` 的 `io_error("E_...")` 实参，打印三张清单并断言互不越界，退出码 0

**技术决定（TL · 开发期不再讨论）**
- 落点：`app/crates/app-core/src/error.rs:46-85`（13 值）、`:94-102`（`AppError` 形状）、`:150-187`（`timeout` / `engine_panic` / `data_unavailable` / `dataset_readonly` 构造器）、`:208-227`（`From<ProviderError>` 映射）
- 映射表（冻结，不再讨论）：`ProviderError::UnknownSecurity → E_UNKNOWN_SECURITY`；`Unsupported → E_UNSUPPORTED`（`details.feature`）；`Network → E_INTERNAL`（`retryable=true`）；`Parse → E_DATASET_MISSING`；`Internal → E_INTERNAL`
- `DatasetIntegrityDto.error_code` 类型是 `Option<&'static str>`（`dto.rs:591`），**不是** `ErrorCode`，禁止改成 `ErrorCode`（会破坏 5 个无前缀值）
- `SimErrorInfo` 在 `sim_install.rs:48-51`，`code: String` 自由串；本卡**不**收敛为枚举，只在文档标注「sim 段独立命名空间」
- 门禁脚本契约（新建 `app/scripts/verify_error_codes.mjs`）：
  1. 正则 `"E_[A-Z_]+"` 抓 `error.rs:66-85` 的 `as_str` 分支值，断言 13 个且唯一
  2. 正则 `\| "(MISSING_DIR|MANIFEST_INVALID|REQUIRED_TABLE_MISSING|SHA256_MISMATCH|DB_CORRUPT)"` 抓 `types.ts`，断言 5 个
  3. 正则 `"(E_[A-Z_]+)"` 抓 `sim_install.rs` 全量字符串字面量（实有 10 个，其中 9 个经 `io_error(...)`、`E_DISK_INSUFFICIENT` 走别的分支，故不能用 `io_error` 正则）、断言每个值都不在 `as_str` 的 13 值内（避免两套语义撞名）
  4. 断言 `commands.rs` 中返回 `Result<_, String>` 的函数恰为 2 个（`diag_write` / `diag_write_named`），多一个即红
- 前端归一：`app/src/lib/ipc.ts:37-58` `describeError` 是唯一归一入口；非 `AppError` 一律 `E_INTERNAL`、`retryable=false`
- 不做：不新增错误码；不把 `DatasetErrorCode` 加 `E_` 前缀（会牵动 `DatasetErrorPage.tsx:8-14` 的 5 键映射与既有取证）；不改 `diag_write` 签名（改动会牵动 38 处取证调用：`ipc.diagWrite(` 1 处 + `ipc.diagWriteNamed(` 37 处）

**可致红反例（QA）**
1. 在 `error.rs:82` 把 `"E_INTERNAL"` 改成 `"INTERNAL"` → AC2 红 + 前端 `describeError` 归一断言红
2. 在 `types.ts:343-348` 给 5 个值加 `E_` 前缀 → AC3 红（`DatasetErrorPage.tsx` 的 `Record<DatasetErrorCode, string>` 5 键不匹配 → `tsc --noEmit` 红）
3. 新增第 3 个 `Result<_, String>` 命令 → AC8 脚本站点 4 红
4. 把 `error.rs:159` 的 `.retryable(true)` 去掉 → AC6 红（超时不可重试）
5. 把 `sim_install.rs:262` 的 `"E_DISK_INSUFFICIENT"` 改成 `"E_INTERNAL"` → AC8 脚本第 3 项红（撞名 13 值）

**Task 拆解（Dev）**
1. 新建 `app/scripts/verify_error_codes.mjs`（4 条检查 + 三张清单打印）
2. 新增 `docs/reference/error-codes.md`：A/B/C/D 四段各一张表，注明「A 是唯一 `AppError` 出口」
3. `error.rs:1-8` 头注释补「13 值冻结，新增错误码需同步 `verify_error_codes.mjs` 与 `docs/reference/error-codes.md`」
4. Rust 单测 2 个：`error_codes_are_prefixed_and_unique`、`timeout_details_carry_trace_id`
5. `package.json` 加 `"verify:errors"`，`ci.yml` node 段加 `run: npm run verify:errors`

**完成定义 DoD**
单测通过（2 个 Rust 单测 + 脚本退出 0）· 联调通过 · 产品验收 · 文档更新（`docs/reference/error-codes.md`）

---

## S-EP06-05 · 锁定全 JSON 载荷预算并禁止二进制旁路

- 模块编号：E-02 个股工作台（主）/ E-01 行情与自选 ｜原卡号：`S-IPC-05`（规划工作台）
- 优先级：P0 ｜ 故事点：3 ｜ 依赖：`S-EP06-02`（形状冻结后才能算字节）
- 负责人：待 Sprint 规划指派 ｜ 备注：本卡**只定预算与观测**，不改协议、不分页、不引二进制

**用户故事（产品）**
作为盯盘用户，我希望切标的时界面不卡顿，
以便我不会因为一次刷新要传十几兆数据而看到半秒白屏。

**验收标准（BA）**
- 给定 44 个指标实例 × 520 根日线（4 副图满载基线），当 序列化整份 `CalcResponse`，则 JSON 字节数 ≤ **2 MiB**，且测试打印实际 KB
- 给定 单标的 `get_bars` 520 根，当 序列化 `BarsResponse`，则 字节数 ≤ **256 KiB**
- 给定 任一响应超过阈值，当 序列化，则 **仍成功返回**：不截断 `values`、不省略 `null`、不报错；同时落一条 `ipc.payload.large` 遥测，字段 `{command, bytes, instances, bars}`
- 给定 `Cargo.toml`（`app/Cargo.toml` 与各 crate），当 检查依赖，则 **不含** `arrow` / `arrow2` / `serde_bytes` / `bincode` / `rmp-serde`；`commands.rs` 中 **不出现** `tauri::ipc::Response` / `ipc::InvokeBody`
- 给定 `CalcResponse.series[i].outputs[j].values`，当 反序列化为 JSON，则 每个元素是 `number` 或 `null`；**不得**是 `"123.45"` 字符串或 `{ "$number": ... }` 包装
- 给定 `node app/scripts/verify_payload_budget.mjs`，当 运行，则 断言依赖清单与 `tauri::ipc::Response` 零命中，退出码 0
- 给定 Rust 测试 `calc_payload_under_budget`，当 `cargo test -p app-core payload`，则 通过并 stdout 打印 `calc=NNN KB / bars=NNN KB`

**技术决定（TL · 开发期不再讨论）**
- 落点：序列化发生在 Tauri 命令返回值边界，`app/src-tauri/src/commands.rs:231-293`（`calc_indicators`）、`:49-57`（`get_bars`）；DTO 定义在 `dto.rs:396-430`
- 预算来源（写死在测试里，不写成文档口号）：44 实例 × 平均 3 输出 × 520 根 × 8 token/值 ≈ 549 KB（真实 2 位小数价）；最坏 17 位有效数字时 ≈ 1.31 MiB，故硬阈值取 **2 MiB = 2_097_152 B**
- 遥测事件名 `ipc.payload.large`，走 `state.core.telemetry().emit_dynamic(name, fields)`（`commands.rs:584` 同款用法）；阈值判断放命令层，不进 `app-core`
- 测试构造：`app/crates/app-core/src/core.rs` 测试模块内复用既有 `series(...)` 造 520 根 + 44 个 `SeriesDto`，`serde_json::to_string(&payload).unwrap().len()`
- 拒绝的替代方案（写死，不再复议）：arrow IPC（新增 2 个 crate 与前端解包器，收益 < 30%）、分页拉取（破坏 `cacheHit` 单次语义与 generation 丢弃）、压缩（Tauri 传输层不可控，且 CPU 抖动影响 8s 超时预算）
- 不做：不新增命令；不改 `CalcResponse` 字段；不加 `compressed`/`page`/`cursor` 字段

**可致红反例（QA）**
1. 在 `core.rs:1799-1835` 把切片改成只回最后 250 根 → AC1 通过（更小）但 `S-EP05-01` AC2 红；本卡致红方式改为：删掉 `ipc.payload.large` 埋点后把某实例 `outputs` 复制 20 份造 3 MiB 载荷 → AC3 红（无埋点）
2. 在 `app/Cargo.toml` 加 `arrow = "53"` → AC4 红
3. 给 `OutputSeriesDto.values` 加 `#[serde(with = "string_f64")]` 输出字符串 → AC5 红
4. 把 `dto.rs:405` 的 `values: Vec<Option<f64>>` 改成 `Vec<f64>`（NaN 变 `null` 能力丢失）→ AC5 红
5. 把 `commands.rs:231` 的返回类型改为 `tauri::ipc::Response` → AC4 红

**Task 拆解（Dev）**
1. `core.rs` 测试模块新增 `calc_payload_under_budget`（44×3×520，断言 ≤ 2 MiB，打印 KB）
2. 新增 `bars_payload_under_budget`（520 根，断言 ≤ 256 KiB）
3. `commands.rs` `calc_indicators` 内加超阈值埋点（`ipc.payload.large`），只在超阈值时发
4. 新建 `app/scripts/verify_payload_budget.mjs`（依赖清单 + `tauri::ipc::Response` 扫描）
5. `package.json` 加 `"verify:payload"`，`ci.yml` node 段加 `run: npm run verify:payload`

**完成定义 DoD**
单测通过（2 个预算测试 + 脚本退出 0）· 联调通过 · 产品验收 · 文档更新（预算与拒绝方案写入 `docs/reference/error-codes.md` 同目录的 `ipc-contract.md`）

---

## S-EP06-06 · 收敛前端 IPC 出口到单一模块

- 模块编号：E-01…E-08 全量（8 个 `pages/` 目录、9 个 `features/` 目录）｜原卡号：`S-IPC-06`（规划工作台）
- 优先级：P0 ｜ 故事点：3 ｜ 依赖：`S-EP06-01`（46 条清单先冻结）
- 负责人：待 Sprint 规划指派 ｜ 备注：原卡写「六模块」，代码事实是 **8 个 `pages/` + 9 个 `features/`**，按事实写

**用户故事（产品）**
作为维护者，我希望所有跨进程调用都从一个出口走，
以便排查「某页面为什么不刷新」时只需要看一个文件。

**验收标准（BA）**
- 给定 `app/src` 全量 `.ts/.tsx`，当 搜索 `@tauri-apps/api`，则 命中 1 处（`app/src/lib/ipc.ts:1`）
- 给定 `app/src/pages/` 的 8 个目录（`catalog dataset datasource indices install market settings workbench`）与 `app/src/features/` 的 9 个目录（`catalog dataset indicators market qa search settings watchlist workbench`），当 检查每个目录，则 全部通过 `ipc.<method>()` 调用，**无**直接 `invoke`
- 给定 `ipc.ts` 的 46 个 wrapper，当 与 `lib.rs` debug 注册表比对，则 一一对应、无遗漏无多余（`S-EP06-01` AC3 已断言，本卡引用不复述）
- 给定 任一 wrapper，当 与后端签名比对参数名，则 参数名必须为 camelCase 且与 `#[tauri::command]` 形参一致；`set_indicator_favorite(indicator_id, favorited)` → `{ indicatorId, favorited }`；`dataset_set_readonly(read_only)` → `{ readOnly }`；`watch_group_rename(old, new)` → `{ old, new }`（**不转 camelCase**）
- 给定 `savePosition(security, costPrice, shares)`，当 调用，则 实参键为 `{ security, costPrice, shares }`，与 `position_save` 形参 `security/cost_price/shares` 的 camelCase 对应
- 给定 `node app/scripts/verify_ipc_surface.mjs`，当 运行，则 除 `S-EP06-01` 的 5 项外，追加断言：46 个 wrapper 的参数键集合与 `commands.rs` 形参集合（去 `state`/`app`）逐一相等
- 给定 新增一条命令，当 只改 Rust 不加 wrapper，则 脚本红（`registered − used` 非空）

**技术决定（TL · 开发期不再讨论）**
- 落点：`app/src/lib/ipc.ts:67-70`（唯一 `invoke`）、`:73`（`export const ipc`）、`:206-218`（`viewState*` / `position*`）
- 参数名映射规则（冻结）：Rust 形参 `snake_case` → 前端实参 `camelCase`，**唯二例外**是 `watch_group_rename(old, new)` 与 `view_state_set(scope, value)`（单词形参，无下划线，无需转换）
- 参数解析实现：脚本从 `commands.rs` 抓 `pub async fn (\w+)\((.*?)\) ->`，切分形参，剔除 `state: State<…>` 与 `app: tauri::AppHandle`，再 camelCase
- 前端 wrapper 解析：`(\w+): \((.*?)\): Promise<` 抓形参名，再抓函数体内 `invoke<…>\("(\w+)", \{ (.*?) \}\)` 的对象字面量键
- `invokeAudit`（`ipc.ts:59-65`）是取证旁路，**不是**第二出口：它只旁听不转发，禁止在业务代码里 `setInvokeAudit`
- 不做：不引入 React Query / SWR 包装层（会把 46 个 wrapper 变成 46 个 hook，超出本 Epic）；不改 wrapper 函数名（已与 `pages/` 调用点耦合）

**可致红反例（QA）**
1. 在 `app/src/features/market/quotes.ts` 加 `import { invoke } from "@tauri-apps/api/core"` → AC1 红（命中 2）
2. 把 `ipc.ts:131` 的 `{ readOnly }` 改成 `{ read_only: readOnly }` → AC4 红
3. 把 `ipc.ts:215` 的 `{ costPrice, shares }` 改成 `{ cost_price: costPrice }` → AC5 红
4. 在 `commands.rs` 新增一条命令并注册，但不加 wrapper → AC7 红
5. 把 `ipc.ts:194` 的 `{ old: oldName, new: newName }` 改成 `{ oldName, newName }` → AC4 红

**Task 拆解（Dev）**
1. `verify_ipc_surface.mjs` 增「形参 ↔ 实参键」第 8 项检查（含 46 条白名单快照）
2. 逐条核对 46 个 wrapper 的键名，修正不一致（若存在）；基线为全一致，测试应一次通过
3. `ipc.ts:1-5` 头注释补一行「唯一 Tauri 出口；新增命令必须同时改 `lib.rs`、`commands.rs`、本文件、`types.ts`」
4. 不写前端单测（无测试框架，见 `B-05-03`）

**完成定义 DoD**
单测通过（脚本 8 项全绿）· 联调通过 · 产品验收 · 文档更新（`ipc.ts` 头注释）

---

## S-EP06-07 · 归一化参数值线上形状，消除整数与浮点的键分裂

- 模块编号：E-02 个股工作台 / E-03 指标库与口径 ｜原卡号：**新补**（无旧卡）
- 优先级：P0 ｜ 故事点：2 ｜ 依赖：`S-EP05-04`（`calc_key` 的 `params_json` 段）、`S-EP06-02`（`ParamValue` 形状冻结）
- 负责人：待 Sprint 规划指派 ｜ 备注：**本卡是 EP-06 唯一未实现项**，现状是真缺陷，不是补测试

**用户故事（产品）**
作为手动调参的用户，我希望把参数从 20 改成 20.0 再改回 20 时不要重新算一遍，
以便调参时不会每敲一次小数点就卡一下。

**验收标准（BA）**
- 给定 Int 规格参数 `period`，当 先请求 `{"period": 20}` 再请求 `{"period": 20.0}`（同标的、同区间、同数据集），则 第二次 `cacheHit = **true**`（**现状为 `false`，本卡修正**）
- 给定 Float 规格参数（如 `mult`），当 先请求 `{"mult": 2}` 再请求 `{"mult": 2.0}`，则 第二次 `cacheHit = **true**`（现状 `false`）
- 给定 `normalize_params(&[ParamSpec::Int{key:"period",..}], {"period": Float(20.0)})`，则 返回 `Ok({"period": Int(20)})`；反向 `ParamSpec::Float` 收 `Int(20)` 则返回 `Float(20.0)`
- 给定 Int 规格参数收到 `20.9`，当 校验，则 返回 `E_PARAM_OUT_OF_RANGE`、`details.field = "period"`、message 含「需要整数」，**不得**静默截断为 20
- 给定 归一化后 `serde_json::to_string(params)`，当 `20` 与 `20.0` 两路入参，则 产出**同一字符串**（`{"period":20}` 与 `{"period":20.0}` 不得并存）
- 给定 `params_hash(&params)`，当 两种数值字面量归一化后，则 哈希相等（现状不等，`core.rs:1726` 未归一化）
- 给定 Enum 规格收 `12`、Bool 规格收 `"true"`、未知 key `typo`，当 校验，则 三者均拒绝且 message 分别为「需要枚举文本」「需要布尔值」「未知参数」（**现状已满足，作为回归断言，改动后必须仍绿**）
- 给定 `param.rs` 的 `ParamValue`，则 仍为 `#[serde(untagged)]`、变体顺序仍为 `Bool → Int → Float → Text`，前端 `ParamValueMap` 类型不变
- 给定 `cargo test -p app-core param_normalize`，则 4 个单测全绿（`int_literal_for_float_spec` / `float_literal_for_int_spec` / `non_integral_int_rejected` / `same_key_for_two_literals`）

**技术决定（TL · 开发期不再讨论）**
- 缺陷机理（写死，不再讨论）：`param.rs:69-76` 的 `ParamValue` 是 `#[serde(untagged)]`，变体顺序 `Bool → Int → Float → Text`。JSON `20` 命中 `Int(20)`、`20.0` 命中 `Float(20.0)`；`param.rs:193-199` 的 `value_to_int` 只在**校验时**容忍 `Float(20.0)`，**不改存储值**，所以 `core.rs:2279` 的 `serde_json::to_string(params)` 仍产出 `{"period":20}` 与 `{"period":20.0}` 两个字符串 → `calc_key` 不同 → 跨请求缓存永不命中，`params_hash`（`core.rs:1726`）也一分为二
- 落点：`app/crates/indicator-core/src/param.rs:191` 之后（`validate` 函数末尾之后）新增
  `pub fn normalize_params(specs: &[ParamSpec], params: Params) -> Result<Params, ParamError>`
- 归一化规则（**按规格类型，不按入参类型**；输出仍是 `Params = BTreeMap<String, ParamValue>`）：
  - `ParamSpec::Int` ← `Int` 原样；`Float(f)` 且 `f.fract() == 0.0` 且 `f.abs() <= i64::MAX as f64` → `Int(f as i64)`；否则 `Err(ParamError { field, message: "需要整数" })`
  - `ParamSpec::Float` ← `Int(i)` → `Float(i as f64)`；`Float(f)` 原样
  - `ParamSpec::Enum` ← 仅 `Text`；其它 → `Err("需要枚举文本")`（与 `param.rs:170` 现有措辞一致）
  - `ParamSpec::Bool` ← 仅 `Bool`；其它 → `Err("需要布尔值")`
  - 规格外的 key：原样保留，交给 `validate` 报「未知参数」，`normalize_params` 不吞掉它
- 调用点：`app/crates/app-core/src/core.rs:1718-1719`，顺序固定为
  `merge_defaults(meta.params, &instance.params)` → `normalize_params(...)` → `validate(...)`；
  失败统一走既有 `param_error(meta.id, err)`（`core.rs:2294`），映射为 `ErrorCode::ParamOutOfRange`
- 序列化：`ParamValue::Float(20.0)` 的 `serde_json` 输出即 `20.0`，故 Float 规格下 `20` 与 `20.0` 都落 `20.0`；`Int(20)` 恒为 `20`
- 不做：不改 `ParamValue` 的 `untagged` 与变体顺序（改 tagged 会破坏 `app/src/lib/types.ts` 的 `ParamValueMap` 字面量与既有取证 payload）；不在前端做归一（前端持有用户输入原文，后端是唯一权威）；不改 `value_to_int`（`validate` 仍需它做兜底）

**可致红反例（QA）**
1. 删掉 `core.rs:1719` 与 `1718` 之间的 `normalize_params` 调用 → AC1/AC2/AC5/AC6 全红
2. 把 Int 分支写成 `Float(f) => Int(f as i64)`（无 `fract()` 判断）→ AC4 红（`20.9` 静默变 20）
3. 删掉 Float 分支的 `Int(i) => Float(i as f64)` → AC2/AC3 红（`2` 仍落 `Int(2)`，键与 `2.0` 分叉）
4. 写成 `let _ = normalize_params(...)` 丢弃返回值、继续用原 `params` → AC1 红（键仍分裂）
5. 在 `normalize_params` 里加 `out.retain(|k, _| specs.iter().any(|s| s.key() == k))` 丢弃规格外 key → AC7 红（`typo` 被静默吞掉，不再报「未知参数」）

**Task 拆解（Dev）**
1. `param.rs` 新增 `normalize_params`，紧接 `validate` 之后；在 `param.rs:212` 起的测试模块补 4 个单测（`int_literal_for_float_spec` / `float_literal_for_int_spec` / `non_integral_int_rejected` / `same_key_for_two_literals`，最后一个直接断言 `serde_json::to_string` 两路相等）
2. `core.rs:1718-1719` 接入，保持 `param_error` 映射不变
3. `core.rs` 测试模块新增集成测试 `same_params_different_numeric_literal_hits_cache`：Int 规格与 Float 规格各发两次请求，断言第二次 `cache_hit == true`
4. 回归既有 `param.rs:225-242` 的 `defaults_and_validation` / `unknown_key_is_rejected`，不改断言语义
5. `ci.yml` 已由 `cargo test --workspace`（`ci.yml:102`）覆盖，无需新增步骤

**完成定义 DoD**
单测通过（4 + 1 个新测，既有 2 个不回归）· 联调通过 · 产品验收 · 文档更新（`param.rs` 头注释补「按规格归一化，键稳定」）

---

## 附：本 Epic 卡间依赖与建议开工顺序

```
S-EP06-01 命令面 46/41/5（首卡，门禁脚本 verify_ipc_surface）
   ├─ S-EP06-03 旧命令与文档清理（--docs 分支复用 01 的脚本）
   ├─ S-EP06-06 前端出口唯一化（复用 01 的脚本 + 形参比对）
   └─ S-EP06-02 DTO 形状冻结（verify_dto_ts）
        ├─ S-EP06-04 四类错误形状（依赖形状冻结）
        ├─ S-EP06-05 载荷预算（依赖形状冻结才能算字节）
        └─ S-EP06-07 参数归一化（唯一未实现项，依赖 S-EP05-04 的键）
```

- 建议并行度：开发者 1 做 `01→03→06`（契约清单与出口），开发者 2 做 `02→04→05→07`（形状、错误、预算、归一化）
- 前置外部依赖：`S-EP05-09`（DTO 形状六条 AC）、`S-EP05-04`（`calc_key` 的 `params_json` 段）
- 本 Epic 完成后解锁：`EP-07` 可假定「46 条命令、39 个 DTO、13 个错误码、`ipc.ts` 单出口」为稳定前提，前端基座不再做契约兜底
