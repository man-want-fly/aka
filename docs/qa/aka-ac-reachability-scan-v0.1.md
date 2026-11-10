# 全卡 AC 状态值可达性扫描（v0.1）

- 基线：`main@6259b9f` + W-115（`w115/missing-dataset-manifest`，仅新增 debug 注入与反例）
- 卡面：`docs/story-cards/aka-story-cards-v0.1.md`（74 卡）
- 方法：从卡面 AC 行提取「错误/不可由用户常规操作产生」的候选 74 条（覆盖 39 卡），逐条找状态产生点与进入路径；再用 ledger 状态区分「已交付」与「未开工」
- 口径：
  - **正常进入**：用户常规操作或常规数据即可进入
  - **夹具注入**：debug 启动开关、诊断命令、单测加工数据、人工变异脚本
  - **仅异常环境**：真实磁盘/网络故障，CI 无法制造
  - **无路**：所有入口都到不了；再分「已实现但不可达（真死 AC）」「功能未实现（未开工）」「仅 dev2 可达（main 未合）」
  - **非状态值**：否定式断言、格式/静态检查，不属于本扫描口径
- 依据里的路径均相对 `app/`。ledger 只用于区分交付状态，**不作为可达性依据**（已知台账滞后）。

## 结论先说

1. **本卡修好一条**：`S-06.03-01 / P04-R3` 的 `state === "missing"` 过去无路，W-115 的 `--missing-dataset-manifest` 使其可达，并配「注入未生效必红」反例。
2. **新发现 1 条真死 AC（卡在 main、已实现、状态无路）**：
   - `S-02.08-01 / AC-02.08-01（补2）`：工作台页脚「单段缺失」要求 manifest 缺 `sha256` 时该段 `—`、其余 6 段正常。页脚确实由字段空派生 `missing`（`src/features/workbench/datasetOverview.ts:58-71`），但 manifest 来源恒完整：命令 `dataset_manifest` 直接返回 provider 结果（`src-tauri/src/commands.rs:123-130`），mock 恒 `Some` 且 `sha256` 恒有值（`crates/data-provider/src/mock.rs:352-358`）。现有 `--corrupt-manifest` 只让健康检查②失败、`--missing-dataset-manifest` 让整份 manifest 为空（7 段全 `—`），**都无法制造「只缺一段」**。→ 建议单独开卡（卡号待 TL 给）。
3. **批量缺口（与「合并丢 case」同类，但性质是未合代码）**：main 上 12 条 AC（另 2 条部分）的状态只在 `dev2` 可达，靠 `--dataset-fault=` / `DatasetErrorPage`。而 **`--dataset-fault=` 在 main 不存在**——用户前提里的「项目已有三个注入开关」在 main 只成立了两个。清单见下方「仅 dev2」组，需 TL 确认 P9/P10 合并计划，不应按死 AC 处理。
4. **其余「无路」均不是死 AC**：17 条属未开工（页面/视图不存在），2 条属 V1 已移出，5 条非状态值。
5. 没有任何条目需要标「待核」：判定都能落到代码位置或明确说明「无实现」。

## 逐条清单

| # | 卡号 | AC | 状态值 | 结论 | 路径类型 | 依据 / 无路说明 |
|---|---|---|---|---|---|---|
| 1 | S-01.01-01 | AC-01.01-01（补1） | `changePct=null` → `—` | 有路 | 夹具注入 | 渲染分支 `src/pages/market/MarketPage.tsx:616-620`；停牌末日样本 `crates/data-provider/src/mock.rs:224` |
| 2 | S-01.02-01 | 卡面自注 | — | 非状态值 | — | 说明行（「真实磁盘只读未覆盖」），与补3 重复，不构成独立状态 |
| 3 | S-01.02-01 | AC-01.02-01（补2） | 唯一记录被移除（`UNIQUE(code)`） | 有路 | 正常进入 | `crates/app-core/src/core.rs:701` `toggle_watch` |
| 4 | S-01.02-01 | AC-01.02-01（补3） | 磁盘只读 → 「自选未保存：磁盘只读」 | 有路 | 夹具注入 | `src-tauri/src/lib.rs:46` + 只读映射 `src-tauri/src/lib.rs:139-141` |
| 5 | S-01.02-02 | AC-01.02-02（补2） | 同名分组内联提示 + 提交禁用 | 有路 | 正常进入 | `src/components/Watchlist.tsx:171`、`src/features/watchlist/watchlistDiag.ts:512` |
| 6 | S-01.02-02 | AC-01.02-02（补4） | 创建组写失败 → 回滚 | 有路 | 夹具注入 | 同 #4（query_only 让任意写失败） |
| 7 | S-01.02-03 | AC-01.02-04（补3） | `state.db` 损坏 → 不可恢复错误页 | 有路 | 夹具注入 | `src-tauri/src/lib.rs:45`（`--corrupt-db`）；恢复入口 `src-tauri/src/commands.rs:315` |
| 8 | S-01.02-03 | AC-01.02-04（补4） | 移出失败 → 错误条 | 有路 | 夹具注入 | 同 #4 |
| 9 | S-01.02-03 | AC-01.02-04（补7） | 12 根 K → 「数据不足」徽标 | 有路 | 夹具注入 | `crates/app-core/src/core.rs:333`（`with_diag_tiny_series`）、`crates/data-provider/src/mock.rs:116` |
| 10 | S-01.03-01 | AC-01.03-02 | 未填持仓 → 无持仓块 | 无路 | 未实现 | 全仓无 `data-pos`；S-01.03-01 ledger=未开始 |
| 11 | S-02.02-01 | AC-02.02-01（补2） | 整周停牌 → 该周无 K | 有路 | 单测夹具 | `crates/data-provider/src/aggregate.rs:165`（2024-03-11~15 夹具） |
| 12 | S-02.04-02 | AC-02.04-03（补3） | planned 项置灰 | 有路 | 正常进入 | 指标登记表 `planned` 状态；目录页渲染 |
| 13 | S-02.05-01 | AC-02.05-03（补2） | >300ms → 超时提示 | 有路 | 夹具注入 | 判定 `src/pages/workbench/WorkbenchPage.tsx:839`；测试缝 `src/features/workbench/s20501Diag.ts:274` |
| 14 | S-02.06-01 | AC-02.06-01（补3） | 引擎错误 → 计算失败卡 | 有路 | 夹具注入 | `src-tauri/src/lib.rs:50-57`（`--inject=panic`）；错误卡 `src/pages/workbench/WorkbenchPage.tsx:144` |
| 15 | S-02.08-01 | AC-02.08-01（补2） | manifest 缺 `sha256` → 该段 `—`、其余 6 段正常 | **无路（真死 AC）** | 已实现但不可达 | 派生 `src/features/workbench/datasetOverview.ts:60-79`；但 `src-tauri/src/commands.rs:315-320` 直取 provider，mock 恒 `Some` 且 sha 恒有值 `crates/data-provider/src/mock.rs:352-358`；无「单字段缺失」注入 |
| 16 | S-03.03-02 | AC-03.03-03（补3） | `NOT_EXIST` → 参数错误页 | 有路 | 正常进入 | 路由可手改；`src/pages/catalog/CatalogPage.tsx:734` |
| 17 | S-03.03-03 | AC-03.03-04（补2） | `completion_note` 清空 → 报告红 | 有路 | 夹具注入/人工变异 | `scripts/verify_indicator_docs.mjs:267-330`，夹具构造 `:462` |
| 18 | S-03.05-02 | AC-03.05-06（补1） | 3 根手算中间量 | 有路 | 单测夹具 | `crates/indicator-core/src/indicators/b2.rs:782`（手工序列夹具） |
| 19 | S-03.05-08 | AC-03.05-34 | ATR 窗口全 0 → NaN 或 DIVIDE_BY_ZERO | 有路 | 单测夹具 | `crates/indicator-core/src/indicators/b2.rs:490-500`（`atr_series` 产 NaN，不产 Infinity） |
| 20 | S-03.05-08 | AC-03.05-35 | V08 副图未就绪段断开 | 有路 | 正常进入 | `crates/indicator-core/src/indicators/b2.rs:36`（V08_ID）；V08 在副图清单 `src/features/workbench/model.ts:222` |
| 21 | S-03.06-03 | AC-03.06-11 | `C[0]=0` → NaN | 有路 | 单测夹具 | `crates/indicator-core/src/indicators/b3.rs:325-338,673`（M09 分母为零 NaN） |
| 22 | S-04.01-01 | AC-04.01-01（补4） | `index_count=6` → 「样本缺失（6/8）」 | 无路 | 未实现 | 全仓无「样本缺失」；无指数概览页；ledger=未开始 |
| 23 | S-04.02-02 | AC-04.02-05 | 板块空 `sector` → 样本缺失 | 无路 | 判据失效（V1） | ledger=S-04.02-02 已标 V1 移出 MVP |
| 24 | S-04.02-02 | AC-04.02-05（补1） | 12 板块空态 | 无路 | 判据失效（V1） | 同上 |
| 25 | S-05.01-01 | AC-05.01-01（补4） | `/   ` 查询无异常 | 无路 | 未实现 | `src/pages` 只有 catalog/datasource/market/settings/workbench，无搜索页 |
| 26 | S-05.01-04 | AC-05.01-04 | 断网 → 0 外部请求 | 无路 | 未实现 | 同上（同类断言在浮层 S-08.01-02 已实现） |
| 27 | S-05.01-03 | AC-05.01-03 | `zzzz` → 列表空 + 无结果提示 | 无路 | 未实现 | 同上 |
| 28 | S-06.01-01 | AC-06.01-01（补3） | 只读库 → 「设置未保存：磁盘只读」 | 有路 | 夹具注入 | 同 #4 |
| 29 | S-06.01-03 | AC-06.01-03 | 无硬编码色 | 非状态值 | — | 源码静态检查 |
| 30 | S-06.02-02 | AC-06.02-02 | 数值格式一致 | 非状态值 | — | 静态/快照检查 |
| 31 | S-06.03-01 | AC-06.03-01 | 关于页正常展示 | 有路 | 正常进入 | `src/pages/settings/SettingsPage.tsx:318-346` |
| 32 | S-06.03-01 | AC-06.03-01（补3）/ P04-R3 | 「目录不存在」+ 重建入口 | 有路（本卡修复） | 夹具注入 | `src-tauri/src/lib.rs:48` → `src-tauri/src/commands.rs:135-147`；页面派生 `src/pages/settings/SettingsPage.tsx:66,325-346`；反例 `scripts/verify_p04r3_injection.mjs` |
| 33 | S-06.03-02 | AC-06.03-02（补2） | 磁盘仅 2MB → 导出前拦截 | 有路 | 夹具注入 | `src-tauri/src/diagnostics.rs:189-203`（`AKA_DIAG_FREE_MB` 环境注入） |
| 34 | S-07.01-01 | AC-07.01-01（补1） | 删交易日历表 → ①不可用 | 无路（main） | 仅 dev2 | dev2 `crates/app-core/src/core.rs:1421` 表级故障；main 无该枚举 |
| 35 | S-07.01-02 | AC-07.01-02（补1） | 断网健康检查 | 有路 | 仅异常环境 | 健康检查纯本地 `crates/app-core/src/core.rs:1090-1120`；无法在 CI 断网 |
| 36 | S-07.01-02 | AC-07.01-02（补3） | 删 manifest → ②FAIL、汇总 1/6 | 有路 | 夹具注入 | `src-tauri/src/lib.rs:47`；`crates/app-core/src/core.rs:1160-1202`；`src-tauri/src/commands.rs:153-164` |
| 37 | S-07.02-01 | AC-07.02-01（补1） | 不存在 dismiss 按钮 | 非状态值 | — | 否定式断言（只证明「没有」） |
| 38 | S-07.02-01 | AC-07.02-01（补4） | 数据集损坏错误页 + 「模拟」标识 | 无路（main） | 仅 dev2 | dev2 `src/pages/datasource/DatasetErrorPage.tsx:28`；main 无该页 |
| 39 | S-07.02-02 | AC-07.02-02 | 重建只改 `sim`，`real` 不变 | 无路 | 未实现 | `src-tauri/src/commands.rs:301-311` 只清 flag，不落盘；Given 的真目录重建不可能由 UI 触发 |
| 40 | S-07.02-02 | AC-07.02-02（补1） | `dataset_generation` +1 | 无路 | 未实现 | 同上；重建不 bump generation |
| 41 | S-07.02-03 | AC-07.02-03（补1） | 重建后 `dataset_id` 更新 | 无路 | 未实现 | 同上；provider 常量不变 |
| 42 | S-07.03-02 | AC-07.03-03（补2） | 删 `seed` → manifest 视图缺失 8 项 | 无路 | 未实现 | main 无 manifest 视图页/`seed` 展示（全仓 grep `seed` 无 UI 命中） |
| 43 | S-07.03-03 | AC-07.03-03（补3） | `seed=1/2` 重建 | 无路 | 未实现 | 无重建 UI、无 seed 选择 |
| 44 | S-07.03-03 | AC-07.03-04 | 取消重建 | 无路 | 未实现 | 无重建对话框/进度 |
| 45 | S-07.03-04 | AC-07.03-04（补1） | 重建后重开自动恢复 | 无路 | 未实现 | 同上 |
| 46 | S-07.03-04 | AC-07.03-04（补2） | 重建中遮罩 + 进度 | 无路 | 未实现 | 同上 |
| 47 | S-07.03-03 | AC-07.03-05 | 篡改 sha256 → 校验失败错误页 | 无路（main） | 仅 dev2 | dev2 `crates/app-core/src/core.rs:1435`（SHA256_MISMATCH） |
| 48 | S-07.03-03 | AC-07.03-05（补1） | 错误页只读浏览 | 无路（main） | 仅 dev2 | dev2 `DatasetErrorPage.tsx` |
| 49 | S-07.03-03 | AC-07.03-05（补2） | 导出 manifest-check | 无路（main） | 仅 dev2 | dev2 错误页导出分支 |
| 50 | S-07.04-01 | AC-07.04-02（补1） | 断网 P9 方案表 | 无路 | 未实现 | `src/pages/datasource/DatasourcePage.tsx` 无「方案」表（grep 0） |
| 51 | S-07.05-01 | AC-07.05-01（补1） | 3 天停牌命中 | 有路 | 单测夹具 | `crates/app-core/src/quality.rs:426` |
| 52 | S-07.05-01 | AC-07.05-01（补2） | 除权事件命中 | 有路 | 单测夹具 | `crates/app-core/src/quality.rs:443` |
| 53 | S-07.05-01 | AC-07.05-01（补3） | `close=-1` → PRICE_ANOMALY | 有路 | 单测夹具 | `crates/app-core/src/quality.rs:291`（测试构造异常价） |
| 54 | S-07.05-03 | AC-07.05-03 | 重建后报告过期（A→B） | 无路 | 未实现 | 同 #39-41：重建不改 `dataset_id`，过期态无法出现 |
| 55 | S-07.05-01 | AC-07.05-03（补1） | 删 `adj_factor` 表 | 无路（main） | 仅 dev2 | dev2 `crates/app-core/src/core.rs:1421` 表级故障 |
| 56 | S-07.05-02 | AC-07.05-02 | 溯源浮层正常展示 | 有路 | 正常进入 | `src/pages/workbench/WorkbenchPage.tsx:433-434,620-635` |
| 57 | S-07.05-02 | AC-07.05-02（补4） | `batch_id` 缺失 | 有路 | 夹具注入 | `crates/app-core/src/core.rs:336-337`（`with_diag_missing_provenance`）、`crates/data-provider/src/mock.rs:148` |
| 58 | S-07.05-04 | AC-07.05-04 | 六字段溯源展示 | 有路 | 正常进入 | 同 #56 |
| 59 | S-08.01-02 | AC-08.01-02 | 输入 `zzzz` → 「未找到指标」+ 清空 | 有路 | 正常进入 | 目录页指标搜索空态 `src/pages/catalog/CatalogPage.tsx:644-655` |
| 60 | S-08.01-03 | AC-08.01-03（补2） | grep 硬编码「暂无数据」=0 | 非状态值 | — | 静态 grep |
| 61 | S-08.01-05 | AC-08.01-05 | 各空态有下一步 | 有路（部分） | 正常进入/部分未实现 | 目录/自选空态有（`src/pages/catalog/CatalogPage.tsx:611-628,644-660`）；板块空态无页面 |
| 62 | S-08.02-02 | AC-08.02-02 | 注入 timeout → `E_TIMEOUT` 卡 | 有路 | 夹具注入 | `src-tauri/src/lib.rs:50-57`；`WorkbenchPage.tsx:144` |
| 63 | S-08.02-02 | AC-08.02-02（补1） | 关闭注入后重试成功 | 有路 | 夹具注入 | `diag_set_inject` 命令；`src/features/workbench/s080202Diag.ts` |
| 64 | S-08.02-02 | AC-08.02-02（补2） | 切标的取消排队计算 | 有路 | 夹具注入 | 同上 + `WorkbenchPage.tsx:839` 前后链路 |
| 65 | S-08.02-02 | AC-08.02-02（补3） | 连续 3 次超时 → 导出入口 | 有路 | 夹具注入 | `s080202Diag` 重复 re-arm；导出入口 `WorkbenchPage.tsx` 诊断区块 |
| 66 | S-08.02-03 | AC-08.02-03 | 删 `data/sim` → `MISSING_DIR` 卡 | 无路（main） | 仅 dev2 | dev2 `crates/app-core/src/core.rs:1394`；main 无 P9 故障枚举 |
| 67 | S-08.02-03 | AC-08.02-03（补1） | sha 失配 → 只读 | 无路（main） | 仅 dev2 | dev2 `DatasetErrorPage.tsx` |
| 68 | S-08.02-03 | AC-08.02-03（补2） | 只读数据源写操作被拒 | 无路（main） | 仅 dev2 | dev2 只读标志 |
| 69 | S-08.02-03 | AC-08.02-03（补3） | 错误卡不展示堆栈 | 无路（main） | 仅 dev2 | dev2 `DatasetErrorPage.tsx` |
| 70 | S-08.02-03 | AC-08.02-03（补4） | 错误卡内重建入口 | 无路（main） | 仅 dev2 | dev2 `DatasetErrorPage.tsx` |
| 71 | S-08.02-04 | AC-08.02-05 | 任意错误卡 5 要素 | 有路（部分） | 正常进入/部分仅 dev2 | 超时/参数越界/存储损坏有（`WorkbenchPage.tsx:144,839`；`SettingsPage` 存储页）；「数据不可用」仅 dev2 |
| 72 | S-08.02-04 | AC-08.02-05（补1） | 损坏错误卡无重试 | 无路（main） | 仅 dev2 | dev2 `DatasetErrorPage.tsx` |
| 73 | S-09.01-01 | AC-09.01-04 | 架构文档路径 100% 存在 | 无路 | 未实现 | ledger=未开始；main 未产出对应架构/Mermaid 文档，无路径校验脚本 |
| 74 | S-09.01-01 | AC-09.01-06 | Mermaid 渲染 | 无路 | 未实现 | 同上 |

## 分组汇总

| 结论 | 条数 | 条目 |
|---|---|---|
| 有路·正常进入 | 9 | #3 #5 #12 #16 #20 #31 #56 #58 #59（#61 部分） |
| 有路·夹具注入 | 18 | #1 #4 #6 #7 #8 #9 #13 #14 #17 #28 #32 #33 #36 #57 #62 #63 #64 #65 |
| 有路·单测夹具 | 7 | #11 #18 #19 #21 #51 #52 #53 |
| 有路·仅异常环境 | 1 | #35 |
| 部分有路 | 2 | #61（板块空态未实现）、#71（损坏/数据不可用仅 dev2） |
| **无路·已实现但不可达（真死 AC）** | **1** | **#15** |
| 无路·未实现（未开工/数值层） | 17 | #10 #22 #25 #26 #27 #39 #40 #41 #42 #43 #44 #45 #46 #50 #54 #73 #74 |
| 无路·仅 dev2（main 未合） | 12 | #34 #38 #47 #48 #49 #55 #66 #67 #68 #69 #70 #72 |
| 非状态值 | 5 | #2 #29 #30 #37 #60 |
| 判据失效（V1 移出） | 2 | #23 #24 |

## 建议

1. **单独开卡**：`AC-02.08-01（补2）`（真死 AC）。修法与 W-115 同构：新增 debug-only「单字段缺失」注入，或让页脚 missing 判定可由诊断夹具直接驱动；反例必须是「注入未生效时该段不得为 `—`」。**（已由 `W-116` 承接，见「后续记录」第 1 条，不再重复开卡。）**
2. **不按死 AC 开卡**：未实现 17 条属于未开工清单；仅 dev2 的 12 条属于合并计划，应并入 P9/P10 合并核对，不重复开卡。
3. **对规则的补充**：卡面 AC 出现状态值时，除「有可达路径」外，还应区分「已实现但无路」与「未实现」——后者是排期问题，前者才是判据自欺。建议 ledger 增一列 `state_reachability`，交付前必须填。
4. **前提更正**：`--dataset-fault=` 在 main 不存在（只在 dev2），W-115 之后 main 的注入开关是 `--empty-dataset` / `--corrupt-db` / `--readonly-db` / `--corrupt-manifest` / `--inject=` / `--missing-dataset-manifest`（W-116 合入后另有 `--missing-manifest-sha256`）。

## 后续记录（TL 裁定 2026-11-10）

本节的四笔是对上面清单的处置结论，只记录事实与归属，不改产品、不改台账、不改卡面。

1. **#15 真死 AC 已开卡，不再重复开**：`AC-02.08-01（补2）` 对应 `W-116`（`w116/missing-manifest-sha256`，`dd907e2` 已在 main）。实现为 debug-only `--missing-manifest-sha256`：只清 `sha256`、其余 8 字段原样、仍返回 `Some`，页脚 version 段派生 `—`（`app/src-tauri/src/commands.rs` 的 `dataset_manifest`）。清单里摸清的三件前提作为该卡背景保留：**manifest 来源恒完整**、`--corrupt-manifest` 只让健康检查②失败、`--missing-dataset-manifest` 让整份为空（7 段全 `—`）——三者都造不出「只缺一段」，这是该卡存在的理由。
2. **仅 dev2 的 12 条（另 2 条部分）并入 P9/P10 核对**，不重复开卡；它们是未合代码，不是设计死路。
3. **卡面前提写错一笔（单独记录，不是实现缺陷）**：派单时的前提「项目已有 `--empty-dataset`、`--corrupt-manifest`、`--dataset-fault=` 三个注入开关」在 main 上只成立两个——`--dataset-fault=` 只存在于 dev2。凡以「已有三个开关」为前提推导出的方案可行性，都需要按 main 重核；本清单的判定均按 main 实际开关给出。
4. **台账 `S-06.03-01` 应重新进候选**：现状仍为「未开始 / 无关于页」（`docs/qa/aka-story-completion-ledger-v0.1.md`），但关于页与 `P04-R3` 代码都在 main，`W-115`（`aec0785` 合入）之后该状态可经 `--missing-dataset-manifest` 进入。这不是改一个状态词：卡应回到候选，按实际实现重核交付口径。台账由 BA/TL 维护，dev 不代改。
