# AKA Sprint-6 规划（v0.1）

> 编制：2026-11-11｜状态：待 TL 评审
> 依据：Linear `Aka` Sprint-1~5 收口状态、`docs/qa/aka-dispatch-pool-v0.1.csv`（last_check `c8bfec3`）、`docs/qa/aka-story-completion-ledger-v0.1.md`、`docs/qa/aka-card-gate-log-v0.1.csv`
> 口径声明：Sprint 编号以 Linear 标签 `Sprint-N` 为准；本文取代 `docs/planning/aka-sprints-v0.1.csv` 中 S6 的旧口径（旧口径的 B6 与抽屉/目录入口已在 Sprint-3~4 交付）。

## 0. 一页结论

- **主题**：指数页数据面 + 前端小口收口 + 签字债清账。**不新增指标内核**。
- **承诺 7 单 / 12.0 人日**：dev A 6.0（W-122~126），dev B 6.0（W-120/121）。
- **出口**：P11/P12 数据 AC 自验通过（禁 fixture）、P24 转绿、AKA-63/69/33 收口、签字债 17 → ≤9。
- AKA-83（更新检查关闭态）已核满足 AC（SettingsPage 无更新入口、无 About 联网页），0 人日核验关票，不占产能。
- **不做**：P13 六桶广度（4.0）、AKA-41 指标扩展（当前 45/84）、S-04.02-02、P18/P19、S-09.01-01 → Sprint-7。

## 1. 基线盘点与对账

Linear Sprint-1~5 共 39 个 Story，已 38 Done（AKA-75 未打 Sprint 标但代码已合）。剩余 Story 与仓库实况对账如下，**避免重复建设**：

| Linear | 票面状态 | 仓库实况（已核） | Sprint-6 处置 |
|---|---|---|---|
| AKA-63 行情页 | Backlog | [MarketPage.tsx](file:///Users/sixmillion/Documents/AKA/app/src/pages/market/MarketPage.tsx) 689 行已合 main：五板块、9 列排序、星标、密度、诊断齐全；**缺搜索/代码跳转** | 收口 1.5，不重写 |
| AKA-69 IndicatorSpecPage | Todo | [CatalogPage.tsx](file:///Users/sixmillion/Documents/AKA/app/src/pages/catalog/CatalogPage.tsx#L829-L897) 已渲染四段（公式/参数/预热/边界）；**缺 engineVersion 与独立深链入口** | 降为 1.0 收口，不新建页面 |
| AKA-41 指标扩至 84 | Backlog | `app/manifest/indicators.json`：105 条，`normal 43 + beta 2`，`planned 60`，即**实现 45/84** | Sprint-7 主线，本 Sprint 不发车 |
| AKA-33 原生菜单 | Backlog | `src-tauri/src/lib.rs` 无 `MenuBuilder` | 入 Sprint-6（1.0） |
| AKA-83 更新检查 | Backlog | Settings 页无更新入口、无 About 联网页 | 已满足 AC，核验后关票（0 pd） |
| AKA-31/32/34 骨架 | Backlog | 壳层已在 main | 建议随后续对账批量关票，不在本 Sprint 排期 |

**结论**：Sprint-6 的真实增量在 P6 指数页（P11/P12 占位态），前端小卡只是收口；`AKA-69` 若按票面从零建页会与 CatalogPage 四段式重复，已按上表改口径。

## 2. 承诺范围

| 工单 | 卡 / 票 | 内容 | Owner | pd | 依赖 |
|---|---|---|---|---|---|
| W-120 | P11 / S-04.01-01（AKA-85） | `index_snapshot` IPC：8 指数快照（点位/涨跌额/涨跌幅/成交额/样本数）+ 4 KPI + 8 行表 + 样本缺失/无成分/损坏态 | dev B | 4.0 | dataset.db 指数日线（已具备） |
| W-121 | P12 / S-04.01-02（AKA-86） | 今日/5日/20日交易日区间累计（`close[last]/close[last-k-1]-1`）+ 点击进 P2 指数字段集 + 返回态 | dev B | 2.0 | W-120 |
| W-122 | P24 / S-02.08-01 | 修复页脚 7 段中缺失 5 段断言（当前真实 `passed:false`），重采证据 | dev A | 1.5 | BA 给 5 段文案 |
| W-123 | P17 / S-07.05-03 | 搜索浮层收口（只落浮层；补1 仍 Blocked-AC） | dev A | 1.0 | — |
| W-124 | AKA-63 | 行情页搜索框 + 名称/代码/拼音检索 + 回车进工作台 | dev A | 1.5 | 搜索索引 `searchIndex.ts` 已有 |
| W-125 | AKA-69 | 口径页显示 `engineVersion` + 目录行/工作台指标卡深链入口 | dev A | 1.0 | `indicator_catalog` IPC 已有 |
| W-126 | AKA-33 | 原生菜单（文件/视图/帮助）+ 路由与快捷键一致 + 窗口关闭行为 | dev A | 1.0 | — |

产能：dev A = 1.5+1.0+1.5+1.0+1.0 = **6.0**；dev B = 4.0+2.0 = **6.0**；合计 **12.0**。

## 3. 治理轨道（BA/TL，不占 dev 编码）

当前非 Done 卡共 **17 张**：条件交付 7（P01~P07）、待签 9（P08/P09/P10/P15/P16/P21/P22/PG-P6/PG-P7）、P24 待签 1。

- **G6-1 条件交付 7 张**：保持条件签，逐张把排除项（`sign_scope` 之外）落成下一卡或明确不做；**不得升为「已交付」**。
- **G6-2 待签 8 张**：P08/P09/P10/P16/P21/P22/PG-P6/PG-P7 按 tip 重跑证据后签；PG-P6/PG-P7 只能作为页面层证据，不得作为数据 AC 证据。
- **G6-3 P15**：按 7 条 AC `sign_scope` 签，P2 变异锚点恒真问题留痕不豁免。
- 目标：17 → **≤9**；Sprint-6 结束时若未达，本 Sprint 不计完成。

## 4. 验收门与必跑

每卡按 Gate A（卡面/口径）→ Gate B（实现）→ Gate C（`--card` 判红）顺序；证据必须 `dirty=false`、`layer` 与 AC 标注一致。

```bash
# Rust
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
python3 scripts/check-deps.py

# 前端
cd app && npm run typecheck && npm run build
npm run verify:gate-log && npm run verify:gate-c
npm run verify:evidence-suites && npm run verify:dom-contracts
```

P11/P12 额外要求：数据 AC 用数据集真实值自验（`index_members` 256 条可复算），**骨架与 fixture 不得作证据**；页面文本扫描 0 处「全市场 / 真实行情」。

## 5. 顺序与并行

1. 第 1 天：W-122 先启动（P24 是唯一「真实断言失败」的待签卡，越晚越堵签字）；W-120 启动 IPC 与快照查询。
2. 第 2~3 天：W-120 渲染与状态；W-124 搜索（复用 `searchIndex.ts`）；W-125 engineVersion。
3. 第 4 天：W-121 区间累计接 W-120；W-126 菜单。
4. 第 5 天：证据重采 + 签字批次 G6-2；AKA-83 核验关票。

## 6. 明确不做

- P13 六桶广度与涨跌停推导（4.0）/ S-04.02-02 板块（V1，缺 `sector_members`）→ Sprint-7 首发。
- AKA-41 指标扩展 45→84（约 39 个指标）→ Sprint-7 主线，避免与指数页抢 index 数据面。
- AKA-82 Tushare 实源、AKA-48 契约冻结 → 待 Sprint-7 评估。
- S-08.01-02（P18）整卡 Blocked、S-09.01-01（P20）文档线 → 不排。

## 7. 风险与对策

| 风险 | 证据 | 对策 |
|---|---|---|
| P11 数据源误判为缺失 | 已核：`dataset.db` 含 120 证券（112 股 + 8 指数），指数日线由 mock 生成；`sim_install` 已写入 | 直接用 `dataset_db::read_bars` 按指数代码取值，不改种子；若某指数不足 2 根日线，该行隐藏并写 `index.missing` |
| P24 5 段文案无来源 | 卡面只写「7 段」，未给文案 | W-122 开工前 BA 提供 5 段文案；未提供则本卡降级为「部分修复」，不得签 |
| 签字债挤压 BA 产能 | 17 张、每张需重跑证据 | 分两批（D2/D4），每批 4~5 张；条件签不重复全量重采 |
| W-121 区间口径歧义 | 卡面要求 `last-k-1` 前收，非「首日收盘」 | 验收断言三条区间逐个可复算；数据不足显示 `—`，不缩短窗口 |
| 前端 4 张小卡分散注意力 | dev A 6.0 满负荷 | 满负荷不外溢；W-124 若搜索索引缺拼音字段，降为代码/名称两路 |

## 8. 出口判据（Sprint-6 Done）

1. P11/P12 全部数据 AC 自验通过，指数页脱离占位态，且无「全市场/真实行情」字样。
2. P24 转绿并整卡签；P17 收口签。
3. AKA-63 搜索/跳转、AKA-69 engineVersion、AKA-33 菜单三张票关闭。
4. 签字债 17 → ≤9，且无「已交付待签」被直接改「已交付」。
5. 第 4 节命令全绿；证据 metadata `dirty=false`。

## 9. Linear / 派单池变更

- 新建标签 `Sprint-6`；新建 Feature `AKA-84 [Feature] IndexPage 指数与板块页`，其下 `AKA-85` / `AKA-86` 分别映射 P11 / P12（AKA-86 `blockedBy` AKA-85）。
- AKA-63 / AKA-69 / AKA-33 加 `Sprint-6` 标签并补 estimate；AKA-69 描述改为「四段式已由 CatalogPage 承接，剩余 engineVersion + 入口」；AKA-63 置 In Progress（代码已合、缺搜索）。
- AKA-83 仅追加核验结论，不加 Sprint-6 标（0 pd、BA 取证后关票）。
- 派单池：P11/P12 的 note 追加「Sprint-6 承诺（W-120/121），owner dev B」，P13 追加「Sprint-7 首发」；P17/P24 owner 与 eligibility 不变。

## 10. 参考

- [派单池](file:///Users/sixmillion/Documents/AKA/docs/qa/aka-dispatch-pool-v0.1.csv)
- [完成台账](file:///Users/sixmillion/Documents/AKA/docs/qa/aka-story-completion-ledger-v0.1.md)
- [卡门禁日志](file:///Users/sixmillion/Documents/AKA/docs/qa/aka-card-gate-log-v0.1.csv)
- [故事卡 S-04.01-01/02](file:///Users/sixmillion/Documents/AKA/docs/story-cards/aka-story-cards-v0.1.md#L3413-L3536)
