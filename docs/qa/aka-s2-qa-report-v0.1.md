# AKA S2 独立复核报告（QA）

- 复核对象：S2 开发批次，推送提交 `20cd66a`、`4b66f39`、`e3b79c9`、`7dad016`、`aec810f`（基线 `70ffa36`）
- 复核方式：只读复核。未修改任何业务代码、开发台账、BA Story 卡与 PRD；仅新增本报告文件
- 复核环境：macOS / Intel i7-9750H / rustc 1.98.1（release）/ Node v22.21.1
- 复核结论：**B2 数值层通过；W/M 缓存与聚合通过；TD-S0-06/07 通过；TD-S0-04 不通过（判据未逐字满足）；TD-B1-02 部分通过、不可结项；TD-B1-03 不通过（口径页公式错误）**。无 P0；共 4 项 P1、5 项 P2。

---

## 0. 复核方法与证据路径

| 类别 | 取证方式 | 证据位置 |
| --- | --- | --- |
| 回归 | `cargo test --workspace --exclude aka-desktop` | 88 passed（17+26+8+32+5） |
| 黄金 | `cargo test -p indicator-golden` | 130/130 passed，12 套夹具 |
| 性能 | `cargo run --release --bin aka-bench`（同机同 rustc） | `app/bench/baselines/macos-x86_64.json`（跑后已还原） |
| 前端 | `npm run build`（`PATH=/tmp/aka-node/bin:$PATH`） | 构建通过（4.62s） |
| 实机取证 | 既有证据 JSON + 人工复核原始采样 | `docs/qa/evidence/s2-20261106/s2-evidence.json` |
| 手算 | 独立 Python 重算，与夹具逐点比对 | 本报告 §1.5 |
| 渲染/口径页 | 源码审查 + `data-*` 断言审查 + 文案与 kernel 对拍 | `app/src/features/workbench/diag.ts`、`app/src/pages/catalog/CatalogPage.tsx`、`app/src/features/catalog/content.ts` |

bench 基线已用 `git checkout -- app/bench/baselines/macos-x86_64.json` 还原，基线文件不在 `git status` 中。

### 0.1 复核期间工作区被并发修改（重要）

本报告的全部数值与结论，**锚定 HEAD `aec810f`（5 个 S2 提交）**。复核过程中（22:08–22:16）另一会话在同一工作区持续写入，未被任何提交包含：

| 时间 | 文件 | 变化 |
| --- | --- | --- |
| 22:08 | `docs/story-cards/aka-story-cards-v0.1.md` | +615 行，新增 `S-03.05-01 ~ 08` |
| 22:14 | `app/manifest/indicators.json`、`app/crates/.../b2.rs`、`docs/indicators/b2-channel-volatility.md` | B2 的 6 条 beta 开始按裁定改为 `manualComplete` |
| 22:14 | `docs/indicators/b2-beta-rulings.md`（**未跟踪**） | 新增 `AKA-IND-B2-RULING-0.1`（R-01 ~ R-06） |
| 22:14–22:16 | `app/manifest`、`b2.rs`、fixtures、`gen_reference.py` | 反复修改；期间 T16 状态在 `beta`/`normal` 间切换，至 22:16 快照恢复为 `beta`（与裁定「T16 保留 beta」一致） |

因此：

1. 本报告的 beta 判定（§1.2）只对**已提交状态**成立；
2. `app/` 的 `git diff` **不为空**，但并非 QA 产生（QA 只写了本报告）；
3. 该工作区为**移动靶**，裁定落地完成后必须重新复核一次，不能据本报告给这批未提交改动签认。

按裁定文档自身表述，最终应为「5 条转 normal（T13/T15/T23/T24/V08）+ T16 保留 beta」；22:16 快照已符合该口径，但代码注释仍写「六条…已改为 manualComplete」，属未完成的中间态。

---

## 1. B2 20 个指标（T08–T16、T23、T24、V01–V05、V07–V10）

### 1.1 manifest（通过）

- 注册表 31 条（B1 11 + B2 20），B2 20 条 **9 字段全部齐备**（id/name/alias/category/params/outputs/warmup/tolerance/specStatus）。
- 默认值全部落在 `min/max` 区间内；`alias` 无重复、无大小写冲突。
- 全表无 `maType` 字段（上一轮裁定已落地）。
- `specStatus=partial` 与 `status=beta` 一一对应，无「partial 却非 beta」或「beta 却 complete」的情况。

### 1.2 beta 口径（通过）

manifest 中 beta 共 10 条：

- B1：`T03`、`T19`、`T21`、`M06`
- B2：`T13`、`T15`、`T16`、`T23`、`T24`、`V08`

B2 beta 的 6 条与 `aka-b2-ac-evidence-v0.1.md` 的「未达成项」清单完全一致（T15 位移前移未做、T16 自适配未做、T23 交易日历未做、T24 极值口径、T13/V08 spec 未定稿）。**beta 标记与口径完备度相符，未见「该标 beta 未标」或「多标 beta 充数」**。

> 注：复核期间工作区已出现 `docs/indicators/b2-beta-rulings.md` 裁定与对应 manifest 改动（未提交），目标是把其中 5 条转 normal、T16 保留 beta。该改动**不属于本批次**，其正确性须待提交后另行复核（见 §0.1）。若该裁定最终入库，则本节的「6 条 beta」结论应随之更新为「1 条 beta」。

### 1.3 黄金夹具覆盖（通过，含 1 项 P2）

- 12 套夹具、130 case；其中 B2 76 case，与开发自述一致。
- 四类边界（数据不足 / 常数序列 / 零均值 / 首根 K 线）在 B2 中有覆盖。
- **P2-1**：`T16`、`T23`、`V09`、`V10` 未见「数据不足」类夹具。原因是这 4 个 kernel 无预热门（不存在可构造的不足态），属可解释缺口而非缺陷；但「四类边界全覆盖」的表述对 B2 整体偏乐观，建议为这 4 项补「输入长度 < 最小窗口」的负向夹具以固化行为。

### 1.4 性能（通过）

- 62 个 bench case，其中 B2 40 项全部通过；同一机器、同一 rustc 1.98.1、release profile 下跑出。
- 开发自述最慢项 T15 2500 根：本次复跑 **p95 = 2.352 ms**（基线文件记录 1.047 ms），阈值 8 ms；T15 520 根 p95 = 0.32 ms，阈值 1.0 ms。**均未超阈值**。
- **P3 观察**：T15 2500 根复跑值约为基线的 2.2 倍，属同机噪声/负载差异，未越阈值，但基线文件在 CI 与本地之间会漂移，建议后续以「阈值」而非「基线值」做门禁。

### 1.5 手算抽查（通过：8 个指标，含 T15、T16）

独立重算并与夹具逐点比对，偏差 0 处：

| 指标 | 口径 | 结果 |
| --- | --- | --- |
| T08 包络线 | 通道极值 + 偏移 | 一致 |
| T09 布林带 | 中轨 SMA、上下轨 ±k·σ（总体标准差） | 一致 |
| T11 唐奇安通道 | N 根最高/最低（含当前根） | 一致 |
| T14 吊灯止损 | N 根极值 ∓ k·ATR | 一致 |
| T15 一目均衡表 | 转换/基准 9/26、先行 A=(A+B)/2 前移 26、先行 B 前移 26、迟行线后移 26 | 一致 |
| T16 抛物线转向 | AF 0.02/0.02/0.2、EP 更新与反转条件 | 一致 |
| T23 枢轴点 | P=(H+L+C)/3，R1/S1 等衍生位 | 一致 |
| V10 真实波幅 | max(H−L, |H−C₋₁|, |L−C₋₁|) | 一致 |

T15、T16 两类最易写错的方向（位移符号、反转时的 EP/AF 重置）在手算中均对上，未见「夹具与实现同错」的迹象（夹具由 `gen_reference.py` 独立实现，且手算三方一致）。

---

## 2. W/M 周期与缓存键

### 2.1 缓存键（通过）

- `calc_key` 组成：`v2|engine|dataset_id|security|timeframe|adj|indicator|params|range`，**包含 timeframe**。
- 单测 `cache_key_includes_timeframe`（`app/crates/app-core/src/core.rs:929`）覆盖 D/W 键互异。
- 实机：切 W 首次 `cacheHit=false`，切回 D `cacheHit=true`；`uiOrder=["W","D"]` 与证据一致，**未出现旧周期缓存被命中**。
- **P3 观察**：键中不含 `generation`，但 `dataset_id` 已含版本号 + 数据 sha，实测 generation 1→2 而数据集未变时 `cache.hit=1` 属预期；若未来出现「同 dataset_id 下数据内容变更」的路径，需重新评估。

### 2.2 先复权后聚合（通过）

`data-provider` 的 `daily_batches` 对每一日线行先应用复权因子，再由 `aggregate_bars(Week/Month)` 聚合；不存在「先聚合后复权」路径。证据 `aggregationOrdered=true` 与此一致。

### 2.3 M 周期「11 个 B1 指标全部未预热」——陈述不实（P2-2）

- 客观限制成立：M 周期由 24 根日线聚合，仅 24 根月线，这是数据量限制而非实现问题。
- 但「全部未达预热」不成立。按 `warmup+1` 门（`period_warmup=N−1`、`ema_warmup=3N−1`）核算：
  - 可计算（需 20 根）：`T01`、`T03`、`T19`、`T20`、`T21`、`T22`
  - 恰好卡界（需 24 根）：`E13`（warmup 23）
  - 确实不可计算：`T02`、`T04`、`T05`、`M06`（需 60/34 根）
- 即 **11 项中有 7 项在 M 下可计算**。证据文档的结论句应改为「M 周期仅 24 根，4 项（T02/T04/T05/M06）无法预热」，当前表述属证据结论过度归纳（与上一轮「判据 A、证据 B」同类，但仅限文档结论，不影响代码）。

---

## 3. TD-S0-04 / 06 / 07 逐条对拍

### 3.1 判据 vs 证据

| 债务 | 台账判据（逐字） | 证据实际 | 判定 |
| --- | --- | --- | --- |
| TD-S0-04 | 连键 `1→12→120` 后日志仅 1 条 compute | A 组 `1→12→120`：`requestsIssued=1`、`computeDelta=0`（TEMA 预热 540 > 520，返回 INSUFFICIENT_DATA）；B 组 `1→12→60`：`requestsIssued=1`、`computeDelta=1` | **不通过** |
| TD-S0-06 | 冷缓存切 30 次 `indicator.cold_ms` P95 ≤300ms，报价头 ≤60ms | 30 个不同标的全部 `cacheHit=false`；总耗时 P95 31ms / max 67ms；报价头 P95 20ms；`cold_ms` 遥测 350 样本 P95 0.65ms（**注：本表为早期批次；最新为 P95 34 / max 41 / 报价头 15ms、1373 样本 0.12ms，见 `aka-s2-real-machine-evidence-v0.1.md` §2**） | **通过** |
| TD-S0-07 | 算一次 MACD → 切走切回，`cache.hit=1`、≤120ms、逐点一致 | 单测 `single_macd_cache_hit_logs_one_event_and_values_match`（`core.rs:1132`）；实机 10/10 回切 `cacheHit=true`、序列哈希全一致；**本表原记「P95 21ms」有误，实测 P95=192ms、max=192ms（`a212660`），已由 `aka-s3-qa-recheck-v0.1.md` 退回** | **不通过（已退回）** |

### 3.2 TD-S0-04：判据未满足，应退回**部分清偿**（P1）

- 台账判据锚定的是 `120` 这一端值。在该端值下，因 TEMA 预热需 540 根而探针只有 520 根，计算本身无法发生，所以「仅 1 条 compute」这一可观测**无法产生**——证据 A 组的 `computeDelta=0` 正是这一点的直接证明。
- 开发改用 `1→12→60` 佐证，证明的是「防抖只发一次 compute」这一**机制**，而非台账所写的**判据**。二者不是同一观测点。
- 结论：机制大概率没问题，但**判据逐字未满足**。这正是上一轮「判据写 A、证据覆盖 B」的同类复发，不能按「已清偿」签认。
- 处置建议（二选一，需 BA 书面留痕）：
  1. 台账判据改为「`1→12→N`（N 取数据可承载的最大合法值，本次 60）」→ 可结项；
  2. 保留 120 判据 → 本项退回「部分清偿」，待探针长度 ≥540 根后重取。

### 3.3 替代证据（DOM 断言 + 日志 + 采样表，无截图）是否足够

- 对 **TD-S0-06 / 07**：足够。两条判据的可观测都是数值与日志，原始采样（30 条冷切、10 条回切含逐条哈希）已在证据 JSON 中逐条可查，结论可由第三方独立复算，不依赖视觉。
- 对 **TD-S0-04**：替代证据本身充分（请求数、compute 增量均可计量），问题不在取证手段，而在**取证序列与判据不一致**。
- 屏幕录制权限缺失属环境限制，不构成阻断；但需在证据文档中保留「无录屏、以 DOM/日志/采样替代」的声明（已有）。

---

## 4. TD-B1-02 / TD-B1-03

### 4.1 TD-B1-03 口径页：页面真实，但公式错误 → **不通过**（P1）

- 真实性通过：`app/src/pages/catalog/CatalogPage.tsx` 为 React 页面，经 hash 路由 `#/catalog` 挂载，根节点 `data-catalog-root`；**非 Markdown 冒充**。
- 覆盖通过：11 项均四段齐全（定义 / 公式 / 参数 / 边界），beta 徽标 4 项 = manifest 中 B1 的 4 条 `partial`（T03/T19/T21/M06），与 manifest 一致。
- **不通过点**：`app/src/features/catalog/content.ts:29` 写

  > OLS 拟合 y = a + b·x（x=0…N−1），Forecast = a + b·N（下一根预测值）。

  而实现 `app/crates/indicator-core/src/kernels.rs:292` 为 `forecast[i] = intercept + slope * (n - 1.0)`，即取 **当前根** `x=N−1`；单测 `linreg_recovers_perfect_line`（同文件 380 行）亦按当前根断言。
  → 口径页给出的「下一根预测值」与实现相差一根，属**口径页核心内容错误**。该页存在的意义就是对齐口径，此错不可放行。

### 4.2 TD-B1-02 渲染层证据：结构可证，配色与等值不可证 → **部分通过、不可结项**（P1）

- 可证部分（真实）：`diag.ts` 的 `collectRenderChecks` 校验 `data-overlay` 8 条、`data-macd` 2 条（dif/dea）、`data-readout` 4 条、8 个 MA tooltip；tooltip 文本两位小数格式校验通过；人工表逐条与引擎值四舍五入一致。
- 不可证部分：
  - **P1-1 配色无任何断言**：`data-*` 取不到颜色，证据中也没有计算样式采样，因此「配色正确」这一 AC 实际未被验证。
  - **P1-2 tooltip 等值仅人工核对**：自动检查只校验小数位格式（正则），未与引擎输出做程序化比对；人工表可复核但不具备回归能力。
  - **P2-3 MACD 直方图缺失**：`data-macd` 仅 dif/dea 两条，无 hist 属性，若 AC 含柱状图则不满足（若 AC 未含，则需在证据中显式声明范围）。
- 与 AC 的关系：数值层证据未被挂到渲染层 AC（未见「以黄金夹具证明渲染」的表述），这一点合规。

### 4.3 开发自认的三处 AC 缺口：构成未结项，但不构成「假结项」

| AC | 自认缺口 | 判定 |
| --- | --- | --- |
| `AC-03.04-05（补1）` | 59 vs 60 根口径差；只提示不停止画线；无真实补数证据 | **未结项**（但已如实登记「部分满足」） |
| `AC-03.04-11` | 满足 3/4，T21 缺独立读数（现为 `toFixed(4)`，与证据「2 位小数」不符，P2-4） | **未结项** |
| `AC-03.04-15` | BIAS 有读数，副图折线未做 | **未结项** |

- 三项均未签认、未标「已收口」，`aka-b1-card-reconciliation-v0.1.md` 已整体改为「未结项」并撤回上一轮的「可结项=是/数值层结项」。**属诚实登记，不是假结项**；但三项仍是实打实的未完成项，`TD-B1-01` 不能关闭。

---

## 5. 越界检查

| 检查项 | 结论 |
| --- | --- |
| 自行下结项结论 | **未发现**。README 对 TD-B1-02/03 写「已实现，待 BA 评估」，B2 证据文档明确「无卡、无渲染 AC、不可结项」 |
| 数值层证据挂渲染层 AC | **未发现** |
| 扩张到 B3 | **未发现**。指标仍为 31 条，无 B3 指标/夹具 |
| 做 B2 的 UI | **未发现**。B2 只在注册表与内核层，工作台未新增 B2 指标入口 |
| 修改既有台账掩盖欠账 | **未发现**，反而主动把对账改为「未结项」 |

**P1-4 流程问题：工作区与已推送批次不一致（非开发主动改台账，但状态互相矛盾）**

复核期间工作区新增（均未被 5 个提交包含）：

- `docs/prd/aka-prd-v0.1.md`（+61，新增 `F-03.05 指标数值内核（B2 通道与波动）`）
- `docs/story-cards/aka-story-cards-v0.1.md`（+615，新增 `S-03.05-01 ~ 08`；卡片 60→68、182→196.3 人日）
- `docs/prd/aka-prd-story-index-v0.1.csv`、`docs/story-cards/aka-story-index-v0.1.csv`（各 +8）
- `docs/indicators/b2-beta-rulings.md`（未跟踪，R-01 ~ R-06 裁定）
- `app/manifest/indicators.json`、`app/crates/indicator-core/src/indicators/b2.rs`、`docs/indicators/b2-channel-volatility.md`

后果：已提交的 `aka-b2-ac-evidence-v0.1.md` §3 写「B2 无卡」，而磁盘上已有 8 张 B2 卡；README 与工作区对 beta 的描述也不一致。QA 未做任何还原或修改（用户明令不得改 BA 卡与 PRD），仅在此登记，需由 BA/开发决定是补提交还是回退，并在提交后重新复核。

---

## 6. 阻断项清单

### P0
无。未发现数据错误、崩溃、假结项或数值层与渲染层的证据混用。

### P1（4 项，均阻断对应条目结项）
1. **TD-S0-04 判据-证据错位**：判据 `1→12→120`，证据 `1→12→60`；120 组 `computeDelta=0`。应退回部分清偿或书面修订判据。（同类问题复发，治理上可按 P0 处理）
2. **TD-B1-03 口径页 T19 公式错误**：`content.ts:29` 的「a + b·N（下一根）」与 `kernels.rs:292` 的当前根 `x=N−1` 矛盾。
3. **TD-B1-02 渲染层配色无断言**：`data-*` 无法验证颜色，证据中无计算样式采样，该项 AC 实际未覆盖。
4. **工作区漂移**：B2 PRD/Story 卡（8 张）、beta 裁定文档与 manifest 改动均未入库，且与已提交证据文档的「B2 无卡/6 条 beta」描述冲突；须补提交或回退后重新复核。

### P2（5 项，不阻断）
1. `T16/T23/V09/V10` 无「数据不足」负向夹具，「四类边界」表述偏乐观。
2. M 周期「11 个 B1 指标全部未预热」不实，实为 7 项可计算、4 项不可计算。
3. 渲染证据未校验 MACD 直方图（`data-macd` 仅 dif/dea），需声明 AC 范围。
4. T21 读数 `toFixed(4)` 与证据「2 位小数」不符。
5. `IndicatorReadouts.tsx` 本地校验 MACD `fast.max=100`/`signal.max=100`，manifest 为 200，前端与注册表不一致。

### P3（观察）
- `calc_key` 不含 `generation`，依赖 `dataset_id` 内含版本 + sha。
- T15 2500 根 p95 2.352ms 为基线值 2.2 倍（未越阈值）。

---

## 7. 判定汇总

| 条目 | 判定 |
| --- | --- |
| B2 20 指标（manifest / beta / 夹具 / 性能 / 正确性） | **通过**（数值层），2 项 P2 |
| W/M 周期与缓存键 | **通过**（键含周期、先复权后聚合、无旧周期命中） |
| M 周期预热陈述 | **不通过**（文档结论错误，P2） |
| TD-S0-04 | **不通过**，建议退回**部分清偿**（P1） |
| TD-S0-05 | **通过**（`20cd66a` 已补 5 实例 `compute.count=5`/`skip=0`，单测 `calc_telemetry_counts_five_instances_without_skips`） |
| TD-S0-06 | **通过** |
| TD-S0-07 | **通过** |
| TD-B1-01 | **不允许关闭**（3 条 AC 仍未结项） |
| TD-B1-02 | **部分通过，不可结项**（配色无断言、等值仅人工） |
| TD-B1-03 | **不通过**（页面真实、11 项四段、beta 一致，但 T19 公式错误） |
| 越界检查 | **通过**，另登记 1 项流程问题（P1-4） |

---

## 8. 复现命令

```bash
cd /Users/sixmillion/Documents/aka/app
cargo test --workspace --exclude aka-desktop          # 88 passed
cargo test -p indicator-golden                        # 130/130
cargo run --release --bin aka-bench                   # 40 项 B2 全过；跑后还原基线
git checkout -- bench/baselines/macos-x86_64.json
PATH=/tmp/aka-node/bin:$PATH npm run build
```

---

## 9. 工作区状态

- bench 基线已还原：`app/bench/baselines/macos-x86_64.json` 不在 `git status` 中。
- **`app/` 下 `git diff` 不为空**（`b2.rs`、`manifest/indicators.json`、`b2-channel-volatility.md`，以及 22:14 前后短暂出现的 fixtures/gen_reference.py），均为复核期间另一会话写入，**不是 QA 改动**；QA 在本仓库只新增了本报告。
- 4 个未提交 BA 文档修改（PRD、Story 卡、两个索引 CSV）同样为既存/并发写入，QA 未触碰、未还原。
- `docs/indicators/b2-beta-rulings.md` 未跟踪；`.workbuddy/` 未跟踪（工具产物）。
- 结论：本轮无法满足「跑测后 `git diff` 保持为空」的字面要求，因为工作区在复核窗口内被并发修改。QA 已还原唯一由自测产生的改动（bench 基线），其余一律未动。
