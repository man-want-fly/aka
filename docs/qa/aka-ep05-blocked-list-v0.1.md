# EP-05（编排、缓存与 DTO）阻塞清单 v0.2

- 记录角色：dev B（数据层/指标内核）
- 工作区：`/Users/sixmillion/Documents/AKA-dev2`，分支 `dev2`
- 记录基线：`a21b009`（2026-11-10）
- 说明：本清单只登记阻塞、待拍板项与卡面比对差异，不替代 Story 卡的 AC 判据。

## 1. 范围口径

按 TL 口径：以重排后的模块编号为准，仓库里的 E-01…E-08 不作为 EP 编号使用。

| 编号 | 范围 | 落点 |
| --- | --- | --- |
| EP-05 | 编排、缓存与 DTO | `app-core`、`core.rs` 一带 |
| EP-06 | IPC 契约层 | `commands.rs`、`ipc.ts` |
| EP-07 | 前端基座 | 壳 / 主题 / 格式 / SIM |

EP-05 的权威卡面为 `AKA-ep0507` 工作区 `docs/story-cards/aka-story-cards-ep05-v1.0.md`
（commit `45c6c26`），共 9 张：S-EP05-01 … S-EP05-09，全部 P0、25 故事点。

## 2. 新旧卡逐张比对（差异以新版为准）

旧卡（`docs/story-cards/aka-story-cards-v0.1.md`）7 张 → 新卡 9 张：

| 旧卡 | 新卡 | 差异与处置 |
| --- | --- | --- |
| S-02.06-01 批量计算 | S-EP05-01 | 卡面细化：请求顺序、`values.length == barCount`、未知指标整单失败、`generation` 回显、预热不足全 null 不报错。实现已覆盖，无代码变更 |
| S-02.06-01 区间/序列 | S-EP05-06 + S-EP05-08 | 拆成「K 线序列缓存」与「日期区间归一化」两张；`E_UNKNOWN_SECURITY` / `E_DATASET_MISSING` / 吸附与上限判据不变。实现已覆盖 |
| S-02.06-02 去重 | S-EP05-02 | 埋点判据写死：`indicator.compute=2`、`compute.skip=1`、`compute.count{count,skip,instances}`、去重原因 `duplicateKey`。实现已覆盖 |
| S-02.06-02 跨请求缓存 | S-EP05-03 | 判据细化到「全命中 `computedMs=0.0`」「部分命中 `cacheHit=false`」「统计按请求清零」。实现已覆盖 |
| S-02.06-02 缓存键 | S-EP05-04 | 明确 7 维 + 区间、`params_hash` 16 位小写十六进制且**不进键**。本轮补 4 条单测（`a21b009`） |
| S-02.06-02 缓存容量 | S-EP05-05 | **口径变更**：旧「条目 200 / 内存 256MB / LRU / `last_bar_date` 双保险」→ 新「`CALC_CACHE_MAX=512` / FIFO 按首次插入淘汰 / 无字节预算 / 无 TTL / 不做数据集重建清空」。以新版为准，`4ae09cf` 重做；`953a3ed` 保留不改 |
| S-02.08-01 契约 | S-EP05-09 | 明确 DTO 顶层键集合、NaN→null、`computedMs` 数值 0.0、`engineVersion` 外层字符串/内层数值。实现已覆盖 |
| S-07.02-02 模拟标记 | EP-07（前端） | 「结果未渲染」不再属 EP-05，重写索引已移到前端世代引用；EP-05 只保证 `simulated` 字段随 DTO 返回 |
| S-07.05-02 质量/溯源 | S-EP05-07 | 8 个 `QualityFlag` wire 串冻结，大小写混排（见 B-05-02）。实现已覆盖 |

比对结论：

1. **S-EP05-05 是唯一实现缺口**，已由 `4ae09cf` 补齐；新增单测 `calc_cache_evicts_oldest_beyond_limit`、
   `calc_cache_keeps_exactly_512_hits`、`calc_cache_reinsert_same_key_keeps_first_order` 与
   联调用例 `calc_cache_same_key_dedup_adds_one_entry`。
2. `953a3ed` 引入的独立 `cache.rs` 模块、字节预算、真 LRU、`last_bar_date` 校验与
   `cache.evict` / `cache.skip_oom` / `cache.stale_suspect` 三类埋点**在新版卡面无依据**，
   已在 `4ae09cf` 中整体移除，结构落回 `core.rs`。
3. 卡数 7→9、卡号全部改为 `S-EP05-xx`；旧卡号仅作追溯，不再使用。

## 3. 阻塞项

| 编号 | 状态 | 卡/范围 | 阻塞内容 | 解除条件 |
| --- | --- | --- | --- | --- |
| B-01 | **已关闭** | EP-05 全部 | 重写版卡面已落盘（`45c6c26`），逐张比对完成，结论见第 2 节 | 已解除 |
| B-02 | blocked | S-EP05-09 AC-07.02-03（原 S-07.02-02） | 模拟/真实隔离提示的**渲染**不在 EP-05；已拆到 S-07.05-03，归 dev A / EP-07 | dev A 完成渲染层 |
| B-03 | **已关闭（口径变更）** | 原 S-02.06-02 AC-02.06-04 补1 | 原「LRU 淘汰运行层证据」随新版 S-EP05-05 改为 FIFO 512 条后失效；新 AC 判据在数据层单测可判红，不再需要 GUI 取证 | 已解除 |
| B-04 | blocked | S-02.08-01 | 实现已在，签字因签 tip 变更失效，属签字流程而非代码缺口 | TL/BA 在绑定 commit 上重签 |
| B-05 | 待拍板 | 原 S-02.06-02 AC-02.06-03 补1 | `last_bar_date` 字段名与比对对象（`coverage_end`）语义不一致；新版已删除该字段，但口径未由 TL 明确，本轮**不自行定名** | TL 确认口径 |
| B-06 | blocked（引用 TL 清单） | S-EP05-05 / S-EP05-06 | 数据集重建后 `calc_cache` 不清空、`CandleStore` 的 `SeriesKey` 也不含 `dataset_id`，理论上会命中陈旧序列；新卡面明确本轮不做，对应 TL 清单 B-05-01 | TL 给出失效策略后新开卡 |
| B-07 | blocked（引用 TL 清单） | S-EP05-07 | `QualityFlag` 8 个 wire 串大小写混排已冻结，但前端/契约侧缺统一映射说明，对应 TL 清单 B-05-02 | 契约文档冻结映射 |
| B-08 | blocked（引用 TL 清单） | S-EP05-04 ~ 09 | 前端无 `npm test` / ESLint 基线，对应 TL 清单 B-05-03；不影响 EP-05 数据层判据 | 前端测试基线建立 |

## 4. 本轮落地

| 卡 | 内容 | 证据层 | commit |
| --- | --- | --- | --- |
| S-EP05-05 | `CalcCache` 512 条 FIFO；字段/初始化/读写/微基准 3 处调用点同步；移除旧 LRU/字节预算/日期校验与三类埋点 | 数据层：4 个新单测 + 既有缓存用例全绿 | `4ae09cf` |
| S-EP05-04 | 补 `cache_key_includes_adj`、`cache_key_includes_dataset_id`、`cache_key_stable_for_equal_params`、`params_hash_is_16_lower_hex`；注释统一为「7 维 + 区间」 | 数据层：4 个单测 | `a21b009` |

## 5. 9 张卡当前状态

| 卡 | 实现 | 本轮核对结论 |
| --- | --- | --- |
| S-EP05-01 | 已在 | 无代码变更 |
| S-EP05-02 | 已在 | 无代码变更 |
| S-EP05-03 | 已在 | 无代码变更 |
| S-EP05-04 | 已在 | 补 4 条单测（`a21b009`） |
| S-EP05-05 | **本轮补齐** | `4ae09cf` |
| S-EP05-06 | 已在 | 无代码变更 |
| S-EP05-07 | 已在 | wire 串映射见 B-07 |
| S-EP05-08 | 已在 | 无代码变更 |
| S-EP05-09 | 已在 | 渲染项见 B-02 |
