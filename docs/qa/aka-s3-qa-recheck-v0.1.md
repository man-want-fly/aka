# S2/S3 第五轮 QA 定点复核（R5）

- 复核对象：`a212660`（用户点名的 10 个提交；其上的 `6551d9a`、`a212660` 为 **BA** 的裁定/文档提交）
- 复核方式：独立 worktree `/tmp/aka-r5` detached `a212660`，只读复核；测试在 worktree 内跑，主工作区未执行
- 复核日期：2026-11-06
- 修订：v0.2（2026-11-06）按用户反馈更正 `7ded2bc` / `b3-beta-rulings.md` 的角色归属，并把测试数拆清为「a212660 = 93 / 7ded2bc = 97」
- 结论一句话：**P1-2、B3、4ce9636 文件范围通过；P1-1 仍不通过；B2 8 条渲染 AC 证据不足；TD-S0-07 实测未达标，应退回部分清偿；Q-01~Q-04 由 BA 在 `6551d9a` 正式裁定，开发在 `7ded2bc` 奉命转 normal，流程合规。**

## 0. 逐项结论

| 项 | 结论 | 说明 |
|---|---|---|
| P1-1 TD-S0-04 | **不通过（维持部分清偿）** | 事件本体为真、9 字段齐全；但裁定/台账数字仍停留在上一版 diag，`count=12` 与实机 `count=5/instances=50/skip=6` 不符 |
| P1-2 tooltip 逐根等值 | **通过（有范围说明）** | 120/120 根可见窗口逐根悬停，比对引擎 `snapshot.calc.series`，`mismatches=[]`、容差 0；但比的是 `data-value` 原始 double，不是 tooltip 可见文本 |
| B2 20 指标接 UI | **通过** | 8 张卡覆盖 20/20，选中、节点、读数均有实机样本 |
| B2 8 条渲染层 AC | **不通过** | 不是单一 `cardCount:8` 总开关，但每卡只断言同一套 4 项通用条件，AC 的差异条款（虚线/断开/分色/标记/切标的残留/切周期重算等）无证据 |
| B2 口径页 20 项四段 | **静态齐全，实机逐项不足** | `B2_FORMULAS` 20/20 均在 manifest，页面四段模板对每项成立；实机证据只断言 `items` 总数 + 4 个 section 容器，没有逐项点开 20 项 |
| B3 渲染层 13 id | **通过（仅限其声明的三项断言）** | 13/13 逐个切副图，`nodes=输出条数`、`paints` 全非空、`readouts=输出条数`，均在 JSON 中逐 id 落盘 |
| TD-S0-07 回切缓存 | **未达标 → 退回部分清偿** | `P95=192ms`、`max=192ms`，阈值 120ms；10/10 命中、逐点一致成立，但耗时 3/10 超阈；diag 自身已写「回切异常」 |
| 4ce9636 文件范围 | **通过** | 恰好 3 个文件，未含 BA 文档 |
| Q-01~Q-04 beta | **通过（归属已更正）** | a212660 manifest 仍为 `beta/partial`；BA 在 `6551d9a` 出裁定（`b3-beta-rulings.md`），开发在 `7ded2bc` 按裁定转 `normal/manualComplete`，是**奉命执行**，不是私改 |
| 提交顺序说法 | **时间线不支持** | 实际为 B2（22:44–22:50）→ P1（23:02）→ B3（23:18–23:35），不是「先 P1 后 B2」；按要求不作为问题追责 |

## 1. 环境、测试与提交范围

- worktree：`git worktree add /tmp/aka-r5 --detach a212660`；复核结束 `git status` 为空。
- 测试：`CARGO_TARGET_DIR=<主工作区 target> cargo test --workspace --exclude aka-desktop`
  - **`a212660`：本轮复跑 93 passed / 0 failed** = `app_core 17` + `data_provider 26` + `data_store 8` + `indicator_core 37` + `indicator_golden 5`；与 B3 证据文档的 93 一致。
  - **`7ded2bc`：按 `--list` 计数 97**（17/26/8/**41**/5）；本轮抽跑 4 条裁定单测 **4 passed / 0 failed**，未整套重跑。97 - 93 的 4 条正是 Q-01~Q-04 裁定单测（见 §7.2），不是凑数测试。
  - 更正说明：v0.1 把 97 记在 `a212660` 上是错的；97 与 `7ded2bc` 的计数一致，但 `a212660` 的 `--list` 与复跑均为 93。具体是复核环境（worktree / 共享 target）哪一步串了版本，不再追溯；以本轮逐包 `--list` + 全量复跑为准。
  - `indicator-golden` 5 个测试函数通过（193 个 case）；未跑 bench，bench 文件未改动。
- `4ce9636` 文件范围：

```
app/src/features/workbench/diag.ts
docs/qa/evidence/s2-20261106/s2-evidence.json
docs/qa/aka-b3-numeric-evidence-v0.1.md
```

  3 个文件，未含 `docs/story-cards`、PRD、planning CSV 或 BA 裁定文件。**通过。**

- 提交时间线（作者/提交时间一致，取提交时间）：

| 时间 | 提交 | 内容 |
|---|---|---|
| 22:44 | `868c211` | B2 接 UI |
| 22:48 | `d60d864` | B2 diag |
| 22:50 | `03e4e3a` | B2 文档 |
| 23:02 | `fe1e511` / `4ee6ffa` / `7374897` / `13a6a50` | P1 整改 / 证据 / 文档 / 黄金 |
| 23:18 | `4cd148b` | B3 接入 |
| 23:20 | `20da057` | B3 UI |
| 23:35 | `4ce9636` | B3 渲染采样 + tooltip 全窗口 |
| 23:35 | `6551d9a` | **BA**：B3 beta 裁定 / 补卡（文档） |
| 23:44 | `a212660` | **BA**：M24 完备度（文档） |
| **23:53** | **`7ded2bc`** | **开发：按 BA 裁定落地 Q-01~Q-04 + 证据回挂** |

  即：**B2 先于 P1**。用户已说明不把顺序当问题，本报告只记录事实，不据此判违规。
  角色说明：三个提交的 git 作者字段相同（`mwf`），但按用户提供的实际角色，`6551d9a` / `a212660` 是 BA 交付，`7ded2bc` 是开发执行。

## 2. P1-1 · TD-S0-04

### 2.1 `computeEvent` 是否为事件原文、9 字段是否齐全 —— 是

- 代码 `diag.ts:615-618` 从 `after.recent`（telemetry 原始事件）中取最后一条 `indicator.compute`，未拼装、未改写。
- 实机 telemetry（`~/Library/Application Support/aka/logs/telemetry.jsonl`）在 `tsMs=1793979222260` 存在同一条事件，字段与 JSON **完全一致**，可证明是真事件原文。
- `debounce.burst60.computeEvent.fields` 实际键：

```
adj, barCount, cacheKey, computeMs, datasetGeneration, datasetId,
indicatorId, paramsHash, security, timeframe
```

  用户点名的 9 个字段全部存在；额外的 `computeMs` 是事件本身字段，不算缺项。
- `indicatorId=T05`、`paramsHash=0d154e14a228d636`、`cacheKey=v2|aka-engine-0.1.0|sim-default|300750.SZ|D|qfq|T05|{"period":60}|2023-01-02~2024-12-27`、`security=300750.SZ`、`timeframe=D`、`adj=qfq`、`datasetId=sim-default`、`datasetGeneration=1`、`barCount=520` 均齐。

**这一小项通过。**

### 2.2 裁定表字段清单是否与 JSON 逐字一致 —— 裁定表通过，台账仍不通过

- `docs/qa/aka-td-s0-04-criterion-ruling-v0.1.md:31` 的字段清单与 JSON 的 9 个字段逐字一致，没有 `code/period`。**通过。**
- 但 `docs/qa/aka-tech-debt-s0-v0.1.md:90` 的清零判据仍写：

```
code/period/adj/indicatorId/paramsHash/datasetId/barCount
```

  仍是旧字段名，未同步为 `security/timeframe/adj/...`。**不通过。**

### 2.3 `compute.count` 批次语义是否落进文档 —— 方向落了，示例数字错误

- JSON `debounce.computeCountSemantics`、裁定 `§2 ②`、台账明细都写了「`compute.count` 是批次计数，一条 calc 可含多个实例；断言的是请求批次只发生 1 次，不是只算 1 个实例」。**语义澄清已落地。**
- 但三处配套示例仍写「本项目 12 个」「事件 `count=12`，本批实算 12 个实例」（`aka-s2-real-machine-evidence-v0.1.md:44`、`aka-tech-debt-s0-v0.1.md:190`、裁定 `§3`）。
- 本次实机同一 `tsMs` 的 `compute.count` 事件实际是：

```
instances=50, count=5, skip=6
```

  即 `count=5`，不是 12；一条请求含 50 个实例，也不是 12。**示例数字与实机不符。**

### 2.4 同一段「逐字摘录」的数值对账

| 项 | 当前 `s2-evidence.json` | 证据文档 | 结果 |
|---|---|---|---|
| B 组 `barsMs` | 16 | 11 | 不一致 |
| B 组 `calcMs` | 45 | 15 | 不一致 |
| B 组 `totalMs` | 54 | 18 | 不一致 |
| B 组 `seriesPoints` | 39182 | 7575 | 不一致 |
| B 组 `seriesHash` | `c84fa833` | `1ccf8fcd` | 不一致 |
| 事件 `computeMs` | 0.119485 | 0.0959 | 不一致 |
| A 组 `totalMs` | 16 | 14 | 不一致 |
| B 组 `requestsIssued` | 1 | 1 | 一致 |
| B 组 `computeCountEvents` | 1 | 1 | 一致 |

根因：`4ce9636`（23:35）重跑了整份 diag（JSON `generatedAt` 23:34，88,516 字节），而 TD-S0-04/07 的文档最后一次更新是 23:02 左右，引用的还是上一版 JSON（文档自述 55,692 字节）。**字段清单修对了，数值没有跟着重跑同步。**

### 2.5 TD-S0-04 判定

- **机制层**：`requestsIssued=1`、`computeCountEvents=1`、`60` 为当前数据集最大合法档位、事件原文可核，四条判据的实质均成立。
- **证据层**：不通过。裁定表字段清单虽已对齐，但台账仍留旧字段名；`count=12`、`totalMs=18`、`seriesHash=1ccf8fcd`、`computeMs=0.0959` 均与本次 JSON 不符。
- **判定：TD-S0-04 本轮不签「已清偿」，维持「部分清偿」。** 需把 `aka-tech-debt-s0-v0.1.md`、`aka-s2-real-machine-evidence-v0.1.md`、裁定 `§3/§4` 的数值全部按 `a212660` 的 JSON 重写（或删除具体示例只留字段清单），并把 `count=12` 改为本次实际 `count=5/instances=50/skip=6` 或改为不写死数字，才能再签。

## 3. P1-2 · tooltip 逐根等值

- `verification.renderLayer.tooltipParity`：`sampled=120`、`enginePoints=520`、`tolerance=0`、`mismatches=[]`；样本 `bar` 连续覆盖 `400–519`。
- 代码 `diag.ts:225-269`：`count=min(windowSize,barsLength)=120`、`offset=400`，对 120 根可见 K 线逐根派发 `mousemove`（每根 50ms），读 `[data-readout='ma-T01']` 与 `[data-readout='sub-M06-dif']` 的 `data-value`，左侧取 `snapshot.calc.series` 的 T01 / M06 dif 全序列，按 `absolute=offset+visible` 对齐。**确实是逐个悬停取的，不是一次悬停复制 120 行。**
- 比对对象是引擎返回的 `snapshot.calc.series`（原始 520 点），不是页面自己重算或缓存的值；页面侧是 `CandleChart` 的 `values.slice(start)` 视图，索引对齐后与引擎值逐点相等。
- 「另 400 根不在可视窗口」成立：`CandleChart.tsx:61-63` 用 `start=bars.length-count` 只渲染最后 120 根；DOM 中只有 120 个 `[data-candle]`，前 400 根不渲染，无法悬停。
- **范围说明**：比对的是 `data-value` 原始 double，不是 tooltip 可见文本；tooltip 文案的 2 位小数由 `maTooltip`/`decimalsOk` 另行验证（8 条 MA 读数）。因此这条证据证明的是「索引对齐 + 原始数值同源」，不是「格式化后的显示字符串逐字相等」。若 AC 的原意是后者，需要再补一条读取可见文本的断言；按当前 AC-03.04-05 的「tooltip 值 vs 引擎值」口径，**通过**。

## 4. B2 接 UI 与 8 条渲染层 AC

### 4.1 20 个指标是否真能在界面上选中、用到、读到数 —— 通过

- `verification.b2Render` 有 8 张卡、`cardCount=8`、20 个唯一指标：

```
S-03.05-01  T08 T09 T11 T24
S-03.05-03  T10 T12 T13 T14
S-03.05-04  T15
S-03.05-05  T16
S-03.05-06  T23
S-03.05-02  V01 V02 V09 V10
S-03.05-07  V03 V04 V05
S-03.05-08  V07 V08
```

- 主图叠加为多选（`[data-b2-overlay-select] multiple`），`setOverlays` 逐项 `option.selected`；副图为单选 `[data-b2-sub-select]`，逐 id `select.value + change`。
- 每张卡都有 `samples`（每个指标的 `nodes`、`paint`、`points`）与 `readouts`（`data-value`/`data-unit`/显示文本），20/20 均有读数。**选中、用到、读到数三项成立。**

### 4.2 8 条渲染层 AC 是否逐条有证据 —— 不通过

- 形式上有 8 个独立 card 对象，不是单一 `cardCount:8, ok:true`；这一点比上一轮好。
- 但 `diag.ts:419-436 / 454-464` 每张卡的 `ok` 只由 4 个通用条件合成：

```
selected（仅 overlay）
nodes.length === expected
paint !== "" && paint !== "none"
readoutShapeOk（至少一个有限值，空值显示—）
```

- 它没有覆盖各 AC 的差异条款：

| AC | 已验 | 未验的关键子句 |
|---|---|---|
| AC-03.05-05 T09 | 3 节点、首节点描边非空、读数 | 中轨虚线、窗口不足断开、图例/语义色、切标的后不残留旧线 |
| AC-03.05-10 V01/V02 | 4 条读数、单位 | 窗口不足断开、切标的后不残留旧值 |
| AC-03.05-16 T13 | long/short 两节点、未激活侧显示— | 翻转根标记、翻转后线不跳变、NaN 段断开 |
| AC-03.05-20 T15 | 5 节点、读数 | 云带多空着色、先行带最后一根截断、迟行前 26 根留白、图例五线齐全 |
| AC-03.05-24 T16 | 1 个散点组、120 点 | 反转根箭头、点不连成线、多空颜色正确 |
| AC-03.05-27 T23 | 3 节点、读数 | 切周期后重算、首根无值、切周期无旧线、标签不重叠 |
| AC-03.05-31 V04/V05 | 各 1 节点、读数 | %B 两位小数、零带宽段—、NaN 段断开 |
| AC-03.05-35 V08 | 1 节点、描边、读数 | 0 轴可见、正负分色、ATR 未就绪段断开、切标的不残留 |

- 另外 `paint` 每指标只取**首节点**的 `stroke/fill`，无法证明多线/多空/云带的颜色是否正确；B3 的 `paints` 才是逐节点数组，B2 不是。
- `docs/qa/aka-b2-ac-evidence-v0.1.md:107-113` 自己也只声明了这 3 类断言（节点数、描边非空、读数），并没有声明覆盖 AC 子句。
- Story card 仍写「B2/B3 十二卡一律 数值层未挂 / 渲染层未做 / 整卡未结项」（`aka-story-cards-v0.1.md:10`），与「8 条渲染 AC 已取证」的说法不一致。
- **判定：8 条渲染 AC 证据不足，不能据以关闭；只可登记为「通用渲染冒烟通过」。**

### 4.3 口径页 B2 段 20 项四段 —— 静态齐全，实机逐项不足

- `content.ts` 的 `B2_FORMULAS` 恰 20 项；20/20 均在 `manifest/indicators.json`，且都有 `outputs`、`params`、`notes`；`CatalogPage` 对当前选中项固定渲染 formula/params/warmup/boundary 四段。**静态结构齐全。**
- 实机 `verification.catalog` 只断言 `items=44`、`sections=4`、`betaIds` 含 T16；这是**整个口径页的总开关**，没有逐项点开 B2 的 20 项检查每项四段非空。
- B2 文档写「口径页 31 条四段（`items=31`、`sections=4`）」（`aka-b2-ac-evidence-v0.1.md:126`）是 B2 当时范围（B1 11 + B2 20）；当前已并入 B3 13 条，总数 44。不是错误，但需要读者知道这是批次范围，不是逐项覆盖。
- **判定：静态 20/20 四段成立；若要求实机逐项 20 项，证据不足，需补逐项采样。**

## 5. B3 渲染层采样

- `verification.b3Render`：`cardCount=13`、`optionsCount=24`、`missing=[]`、13/13 `ok`；逐 id 数据：

```
M01 1/1/1   M02 3/3/3   M04 1/1/1   M05 1/1/1
M08 2/2/2   M09 1/1/1   M10 1/1/1   M19 2/2/2
M20 2/2/2   M21 1/1/1   M24 1/1/1   M25 2/2/2
M26 1/1/1
```

  （`nodes / paintCount / readouts`）
- 代码 `diag.ts:485-532` 对每个 id 执行：切副图 → `nodes = [data-sub='id']` 数量 → 逐节点 `getComputedStyle` 取 `stroke`（path）或子元素 `fill`（dot/histogram）→ 读 `[data-readout^='b2-sub-...']` 数；`ok = nodes===expect && paints.length===nodes && 每条非空/非none/非NaN && readouts===expect`。
- 这不是「只验能切过去不报错」；三项断言都真实落在 JSON 里。**通过。**
- 限制：`expect` 是硬编码的 1/2/3 条数，不是从 `manifest.outputs` 动态读取；若输出定义变更，测试不会自动发现。**开发已确认将改为从 manifest `outputs` 长度动态取值，本轮尚未落地，列入下轮复核基线。** 另 B3 四卡在 a212660 仍写「渲染层未做」，本采样只能算「渲染冒烟」，不等同 AC 关闭。

## 6. TD-S0-07 · 回切缓存耗时

- 判据字面：`aka-tech-debt-s0-v0.1.md:122`「算一次 MACD → 切走切回，日志 `cache.hit=1`、耗时 ≤120ms、逐点一致」；diag 实现 `diag.ts:705`：

```
warmPassed = warm.length >= 10 && warmAllHit && warmAllMatch && warmMaxTotal <= 120
```

  即**当前实现就是 max 口径**，不是 P95。
- 本次证据：`warm.sampleCount=10`、`allCacheHit=true`、`allPointwiseMatch=true`、`p95TotalMs=192`、`maxTotalMs=192`、`maxCalcMs=187`；10 个样本中 128/184/192 三个 >120。
- diag 自己已命中失败分支并写入 notes：

```
回切异常：样本 10 / cacheHit true / 逐点一致 true / max 192ms
```

  文档却仍写「`totalMs` P95 21ms、max 21ms（≤120ms）」并标「已清偿」（`aka-tech-debt-s0-v0.1.md:218-225`、`aka-s2-real-machine-evidence-v0.1.md` §3），与本次 JSON 直接矛盾。
- **判定：未达标。** 字面 max≤120ms 不满足；即使改读 P95，本次 P95=192ms 也不满足。因此**不存在用「改 P95 口径」救回本批证据的空间**。
- 判据修改权限：判据属 BA 书面裁定范围（参照 `R-S0-04-01` 的做法），QA 不能自行改写。若 BA 仍决定改为 P95，必须另发书面裁定，写清样本量、分位算法（如 nearest-rank）、是否允许单次冷启动剔除；但按现有 192ms，改了也仍不通过。
- **处理建议：TD-S0-07 状态由「已清偿」退回「部分清偿」；`aka-tech-debt-s0-v0.1.md:35/224-225` 与实机文档 §3 的数字回滚；待开发在安静机器上重跑且 max≤120ms 后再签。** 同时 `cache.hit 567 / cache.miss 1373` 与文档 `138 / 350` 也不一致，需一并重写。

### 6.1 根因定性（初步，待 30 次重跑确认）

- **不是机器噪声的特征**：`a212660` 的 10 个样本 `totalMs` 为 47–192，其中 `calcMs` 为 42–187，**calc 占 total 的 91%–97%**；噪声通常落在渲染/调度（total 与 calc 的差额），而不是稳定地集中在 calc。
- **不是冷启首切的一次性开销**：高值出现在第 3、5 个样本（192/184），第 1 个样本只有 128；`7ded2bc` 重跑 10 次（`max=132`、`p95=132`）高值出现在第 7 个，也不是首切。说明每次回切都可能重走一段重路径，而不是只付一次预热成本。
- **`7ded2bc` 重跑参考（非本轮判据）**：`allCacheHit=true`、10/10 逐点一致，`max=132ms`、`calcMs=125ms`；比 `a212660` 的 192 降了，但仍 >120ms，且 `calc/total` 仍是 95%。这支持「缓存命中路径本身在做事」，而不是「没命中」。
- **初步判断**：`cache.hit=true` 时 `calcMs` 仍达 47–187ms，说明计时区间内的重活不是指标递推本身，就是每次请求都在重建/拷贝全量序列（本数据集 `seriesPoints=39182`）、重建 DTO 或做序列序列化。**这是缓存路径问题，不是负载噪声，也不应按一次性冷启豁免。**
- **30 次重跑的判据（下轮执行）**：
  1. 先看 `cacheHit` 是否仍 10/10/30/30 为 true；若有 miss，先排除缓存失效。
  2. 看 `calcMs` 与 `totalMs` 的差：若 `calcMs` 高而差额小 → 计算/序列拷贝；若差额大 → 渲染/IPC。
  3. 看 30 次里 `calcMs` 是否随 `seriesPoints` 固定量级重复，而不是偶发尖峰；偶发尖峰可判噪声，稳定重复则判代码路径。
  4. 需开发补一个「Rust 侧 cache-hit 直接返回」的微基准，把「取缓存 + 反序列化/DTO」与「重新 calc」分开计时；仅凭前端 totalMs 无法把二者拆开。

## 7. 越界、文件纪律与 Q-01~Q-04

- `4ce9636` 只含 3 个文件，未碰 BA 的 story cards / PRD / planning CSV / 裁定文件。**通过。**
- 在 `a212660` 上，manifest 的 8 条非 normal 项仍包含 `M02 / M06 / M24 / M25`，均为 `status=beta`、`specStatus=partial`。**a212660 上 Q-01~Q-04 保持 beta，通过。**

### 7.1 归属更正（v0.1 误判，已在 v0.2 撤回）

- **v0.1 原文**：称 `7ded2bc` 是「未裁定 beta 被私自改判」、`6551d9a` 新增 `b3-beta-rulings.md` 是「文档层越权」。**这两条不成立，特此更正。**
- `6551d9a`、`a212660` 是 **BA** 的提交。`docs/indicators/b3-beta-rulings.md` 是 BA 正式裁定（文档编号 `AKA-BA-B3-RULING-0.1`、角色栏「BA」），明确写「本文件只定口径，不改 manifest；manifest 由开发按 §5 表格改」。
- `7ded2bc` 是开发按该裁定执行：把 `M02 / M06 / M24 / M25` 四条改为 `normal` + `manualComplete`，beta 徽标 8→4；这四条正是 Q-01~Q-04 的处置项，未见越出裁定范围。**流程合规，通过。**
- 说明：三个提交的 git 作者字段都是 `mwf`，仅凭 `git log` 无法区分角色；v0.1 据此把开发会话里看到的 `7ded2bc` 反推为「开发私改」，属于只看提交、不看 BA 交付记录造成的归属错误。

### 7.2 97 与 4 条裁定单测的来源核查

- **a212660：本轮复跑 93 passed**（17/26/8/**37**/5）；**7ded2bc：`--list` 计数 97**（17/26/8/**41**/5）。97 - 93 = 4，增量全部在 `app/crates/indicator-core/src/indicators/b3.rs`。
- 4 条测试实名（`cargo test -p indicator-core -- --list` 在独立 worktree 实取）；在 `7ded2bc` 上单独执行结果为 **4 passed / 0 failed（37 filtered out，总数 41）**：

```
indicators::b3::tests::kdj_rulings_q01
indicators::b3::tests::mass_index_rulings_q02
indicators::b3::tests::elder_impulse_rulings_q03
indicators::b3::tests::macd_hist_is_double_dif_minus_dea   // Q-04
```

- 逐条看断言，**不是凑数**：
  - Q-01：零区间 `H=L=C=10` 断言下标 0–7 全 NaN、下标 8 `K=D=J=50`；`k=2,d=2` 参数下断言首值位置与 `75.0/62.5`。
  - Q-02：`range` 恒 2 断言首值下标 40、`Mass=25`；`range=0` 断言全 NaN。
  - Q-03：断言下标 45 前 NaN、脉冲状态只取 `+1/0`、常数序列取 0，并交叉核对共用 `macd_columns` 的柱。
  - Q-04：断言 M06 柱逐根等于 `2×(DIF−DEA)`，且与共用 `macd_columns` 的输出 NaN 位置与数值一致。
- **一处需 BA 修正的文档缺陷**：Q-01 测试内注释写明「裁定表 Q-01-B 的 83.3333/77.7778 手算有误（已回报 BA）」，测试按递推式断言 `66.6667/55.5556`。按 `K=(2×50+100)/3` 计算，66.6667 才是正确值，裁定文档的这两个数应改，否则「文档期望值」与「测试期望值」不一致。这是**裁定文档算错**，不是测试凑数。
- **勘误进展（工作区未提交）**：复核结束时主工作区已出现 `b3-beta-rulings.md` 的未提交 v0.2 改动，把 Q-01-B 拆成 `H=L=C`（RSV=100）和 `H=C+1/L=C−1`（RSV=90）两条自洽断言，并标「Q-01-B 勘误」。该改动尚未提交，本轮不纳入判定；提交后此条可关闭。

### 7.3 其余文件纪律

- 复核结束时主工作区除上述未跟踪项外，还有 4 个**未提交的开发在途改动**：`app/src/components/CandleChart.tsx`（+179/−?，B2 渲染 AC 重做）、`docs/indicators/b3-beta-rulings.md`（v0.2 Q-01 勘误）、`docs/indicators/b3-momentum-oscillators.md`、`docs/story-cards/aka-story-cards-v0.1.md`。这些不属于 `7ded2bc`，也不在本轮复核范围；QA 未修改、未提交、未 cleanup。
- 本轮报告另存，不改开发台账/BA 卡。worktree `/tmp/aka-r5`、`/tmp/aka-r6` 均已删除且干净。

## 8. 发现的「总开关式证据」

1. **`verification.catalog`**：`items=44`、`sections=4`、`betaIds` 三项汇总，掩盖了「B2 20 项是否每项四段齐全」；实机只看了默认项的 4 个 section 容器。
2. **`verification.b2Render.ok / cardCount:8`**：形式上是 8 个 card，不是单一 boolean；但每张卡的 `ok` 是同一套 4 项通用断言的合取，AC 的差异条款全部没有断言，属于「模板式总开关」，不是「逐 AC 条款证据」。
3. **`verification.b3Render.ok`**：有逐 id 的 nodes/paints/readouts，不是总开关；但 `expect` 硬编码（开发已承诺改为从 manifest `outputs` 动态取，待下轮验证），且没有 AC 语义断言。
4. **`decimalsOk / colorOk`**：是 boolean，但背后有 `maTooltip` 与 `colorSamples` 明细，可接受。
5. **`warm`**：JSON 没有 `ok` 字段，diag 用 notes 报「回切异常」；文档却用「P95 21 / max 21」一句汇总掩盖 192ms，属于以汇总结论替代逐样本核对的写法。

## 9. 复核命令与边界

```bash
git worktree add /tmp/aka-r5 --detach a212660
cd /tmp/aka-r5/app
CARGO_TARGET_DIR=/Users/sixmillion/Documents/AKA/app/target \
  cargo test --workspace --exclude aka-desktop
# 93 passed / 0 failed（a212660）

# 单测来源核对（v0.2 追加，独立 worktree）
git worktree add /tmp/aka-r6 --detach a212660
cd /tmp/aka-r6/app
CARGO_TARGET_DIR=/Users/sixmillion/Documents/AKA/app/target cargo test -p indicator-core -- --list
# 37 tests
git checkout --detach 7ded2bc
CARGO_TARGET_DIR=/Users/sixmillion/Documents/AKA/app/target cargo test -p indicator-core -- --list
# 41 tests：新增 kdj_rulings_q01 / mass_index_rulings_q02
#          elder_impulse_rulings_q03 / macd_hist_is_double_dif_minus_dea
cd /tmp/aka-r5 && git status --porcelain   # 空
```

- 主工作区未跑测试、未改开发台账、未改 BA 卡、未改 bench。
- 本报告写入 `docs/qa/aka-s3-qa-recheck-v0.1.md`。
- `7ded2bc` 仅在本轮补充核对了「归属、文件范围、4 条单测」三项，未做完整逐文件复核；B2 AC 重做与 TD-S0-07 30 次重跑待开发新提交后另开一轮。

## 10. 下轮 B2 渲染 AC 复核判据（预先登记）

> 开发承诺「按 AC 条款逐条加断言」，本轮不预判结果，只先把「什么算真能证伪」写死，避免下轮又验收成「非空即通过」。

| AC | 必须能证伪的断言 |
|---|---|
| AC-03.05-05 T09 | 中轨虚线的 `stroke-dasharray` 实际值 ≠ 空/none；窗口不足时该线 `path` 段缺失或 `d` 断开；颜色与 manifest 语义色一致 |
| AC-03.05-10 V01/V02 | 窗口不足时读数显示「—」或空，不得为 0；切标的后旧值不在 DOM |
| AC-03.05-16 T13 | 翻转根存在独立标记节点；翻转前后相邻点数值连续（容差内）；NaN 段有断线而非连成直线 |
| AC-03.05-20 T15 | 云带填充色按正负/多空分组；先行带最后一根截断；迟行前 26 根无节点；图例 5 条线与 manifest 输出逐条对应 |
| AC-03.05-24 T16 | 反转根箭头节点存在；散点不连成 `polyline/path`；多空点颜色与 `--pos/--neg` 实际计算值一致 |
| AC-03.05-27 T23 | 切周期后节点数/首值随新周期变化；首根无值；切回后无旧周期残线；标签不重叠 |
| AC-03.05-31 V04/V05 | %B 读数的小数位与显示文本逐字匹配（两位）；零带宽段显示「—」；NaN 段断开 |
| AC-03.05-35 V08 | `0` 轴元素可见（非 `display:none`、非空 `d`）；正负柱/线颜色分别等于 `getComputedStyle` 取到的 `--pos/--neg` 实际色值，而不是「颜色非空」；ATR 未就绪段断开；切标的不残留 |

- **正负分色的最低证据**：读取 `getComputedStyle(el).stroke`/`fill` 的实际 RGB/hex，与同页面 `getComputedStyle(root).getPropertyValue('--pos')` 和 `--neg` 的实际解析值比对；只断言 `stroke !== ""` 或 `!== "none"` **不算**。
- **切标的不残留的最低证据**：切换标的后，旧标的的专属读数/节点必须消失（数量或 key 上可核对），不是只看新值出现。
- **每条 AC 至少一个「反向失败样本」**：例如把 `stroke-dasharray` 改成 `none`、把正负色对调，断言应失败；没有反向样本的测试，只能算冒烟。
