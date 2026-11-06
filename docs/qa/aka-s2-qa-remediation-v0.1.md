# S2 QA 复核整改记录（P1×4 + P2×5）

- 日期：2026-11-06
- 来源：《S2 QA 复核报告》`docs/qa/aka-s2-qa-report-v0.1.md`
- 实机证据：`~/Library/Application Support/aka/diag/s2-evidence.json`（本次重跑，`generatedAt=2026-11-06T14:33:28Z`，`kind=aka-s2-evidence`）
- 复跑命令：`AKA_DIAG=1 npm run tauri dev`（真实 Tauri WebView + 真实 IPC，无截图）

## P1 级

### P1-1 TD-S0-04 判据与证据错位 → 按 BA 裁定回「已清偿」

- 裁定：`docs/qa/aka-td-s0-04-criterion-ruling-v0.1.md`（方案 A，取当前数据集可算范围内最大合法档位，现为 60）。
- 台账：`docs/qa/aka-tech-debt-s0-v0.1.md` 状态行已更新为「已清偿（按 R-S0-04-01；B 组 `1→12→60` 取证）」，并注明**数据扩到 ≥540 根后判据自动回到 120 端**。
- 证据分层（本次实机重跑）：
  - A 组 `1→12→120`：`requestsIssued=1`，但 `computeCountEvents=0`，唯一一次请求返回
    `INSUFFICIENT_DATA: 三重指数移动平均线 需要至少 540 根 K 线（预热 539），当前 520 根`
    —— 只证明「连键只发 1 条请求」，不冒充计算证据。
  - B 组 `1→12→60`：`requestsIssued=1`、`computeCountEvents=1`、`barCount=520`、
    `seriesPoints=7575`、`seriesHash=1ccf8fcd` —— 计算证据落在这一组。
    **（2026-11-06 后续批次更新：以 `generatedAt=2026-11-06T16:50:18.641Z` 为准，现为
    `seriesPoints=39182`、`seriesHash=c84fa833`、`totalMs=32`、`computeMs=0.014795`；
    本行数字属早期批次，已被取代。）**
- 提交：`950c0ae`。

### P1-2 口径页 T19 公式错误 → 文案与实现对齐

- 实现：`app/crates/indicator-core/src/kernels.rs` 的 `slope*(N−1)`（当前根拟合值）。
- 修正：`app/src/features/catalog/content.ts` 的 T19 `formula`
  改为「Forecast = a + b·(N−1)（当前根拟合值，不外推下一根）」。
- 证据：`npm run build` 通过；`#/catalog` 实机 `catalog.items` 含 `T19`，`sections=['formula','params','warmup','boundary']`。
- 提交：`d6e0544`。

### P1-3 涨跌配色零断言 → 三重编码实机采样

- 代码：
  - `app/src/styles/tokens.css` 新增语义别名 `--pos: var(--rise)`、`--neg: var(--fall)`（仍受 `data-colormode` 控制）。
  - `CandleChart.tsx`：K 线/成交量/MACD 柱/涨跌读数全部改用 `var(--pos)`/`var(--neg)`；
    K 线补 `data-candle=up|down`、`data-index`；MACD 柱补 `data-hist=pos|neg`；
    涨跌读数补 `data-readout="chg"`、`data-sign`，并加 ▲/▼。
  - `diag.ts`：新增 `resolveColor()` 与 `chgEncoded()`，用 `getComputedStyle` 断言。
- 实机采样（2026-11-06T14:33:28Z）：

| 断言 | 采样值 | 结果 |
|---|---|---|
| `--pos` 解析 | `rgb(228, 72, 63)` | — |
| `--neg` 解析 | `rgb(23, 166, 115)` | — |
| 上涨 K 线 stroke | `rgb(228, 72, 63)`（= `--pos`） | pass |
| 下跌 K 线 stroke | `rgb(23, 166, 115)`（= `--neg`） | pass |
| MACD 正柱 fill | `rgb(228, 72, 63)`（= `--pos`） | pass |
| MACD 负柱 fill | `rgb(23, 166, 115)`（= `--neg`） | pass |
| 涨读数 | `pos｜rgb(228, 72, 63)｜▲ +2.74%` | 颜色+箭头+正号 |
| 跌读数 | `neg｜rgb(23, 166, 115)｜▼ -9.98%` | 颜色+箭头+负号 |

- 结论：`verification.renderLayer.ok=true`、`colorOk=true`，颜色/箭头/正负号三重编码均有计算样式采样。
- 提交：`d6e0544`（配色与断言）、本次补 `data-index` + 双向采样同批提交。

### P1-4 工作区漂移 → 原子提交

- 已按「每完成一个可工作的原子改动就提交」执行，本轮提交：
  - `fcfbeb5` fix(b2)：裁定落地（5 条转 normal / T16 保留 beta / V08 ATR14）+ BA 卡与 PRD 入库
  - `d6e0544` fix(web)：P1-2 / P1-3 / P2-3 / P2-4 / P2-5 / P2-2（diag 文案）
  - `2e29c7d` test(golden)：数据不足负向夹具
  - `950c0ae` docs(qa)：B2 证据重挂、T16 回退 beta、TD-S0-04 状态、QA 报告与裁定入库
- 说明：`docs/qa/aka-b1-card-reconciliation-v0.1.md` 等仍有其他会话在写的改动，本会话未代为提交；`git status` 中非本会话改动保持原样。

## P2 级

| 项 | 处理 | 证据 |
|---|---|---|
| P2-1 T16/T23/V09/V10 缺「数据不足」夹具 | 新增 `edge_b2_below_min_window`（1 根）：T16/T23 全 NaN、V10 NaN、V09 振幅=1.0 | `gen_reference.py` + 夹具入库（`2e29c7d`），`cargo test -p indicator-golden` 通过 |
| P2-2 M 周期「11 个 B1 全未预热」不准 | 改为「T02/T04/T05/M06 共 4 项不可算，T01/T03/T19/T20/T21/T22/E13 共 7 项可算」 | `diag.ts` `monthlyNote`；`docs/qa/aka-s2-real-machine-evidence-v0.1.md` 由裁定同步更正 |
| P2-3 `data-macd` 缺 hist | MACD hist 包为 `<g data-macd="hist">`，每根柱 `data-hist`；diag 断言 `macdCount=3` 且 `macdHistCount>=2` | 实机：`macd=['hist','dif','dea']`、`macdHistCount=120` |
| P2-4 T21 读数 `toFixed(4)` 与「2 位」不符 | 改 `toFixed(2)`；diag 断言 `R²` 恰好两位且无第三位 | 实机：`t21Text="R² 0.30无量纲"`、`t21TwoDecimals=true` |
| P2-5 前端 MACD `max=100` 未跟 manifest 200 | `model.ts` 信号上限改 200 | `npm run build` 通过；manifest 与前端一致 |

## 复跑与回归

```bash
cd app
cargo test --workspace --exclude aka-desktop   # 通过
cargo test -p indicator-golden                 # 81 个 B2 case 全过
npm run build                                  # 通过（tsc --noEmit + vite build）
AKA_DIAG=1 npm run tauri dev                   # 实机证据，renderLayer.ok=true / colorOk=true
```

## 仍然如实说明

- M 周期：模拟数据集只有 520 根日线（≈24 个月），24 根月线不足 B1 的 4 项预热；
  本轮只取到行情层聚合，未伪造指标层证据。
- T16：仍为 beta（R-03 保留），未取得商业软件逐点对照。
- 渲染层证据首轮仅覆盖 B1 的 11 个指标；B2 的 8 条渲染层 AC（`S-03.05-01~08`）已在 `aka-b2-ac-evidence-v0.1.md` §6 补齐。

---

## 第二轮定点复核整改（2026-11-06，P1×2 + P2×5）

- 来源：`docs/qa/aka-s2-qa-recheck-v0.1.md`（QA 在独立 worktree、基线 `2247e0d` 上定点复核）。
- 结论口径修正：**全量测试 = 88 passed**（`app_core 17 / indicator_core 32 / data_provider 26 / data_store 8 / indicator_golden 5`，命令 `cargo test --workspace --exclude aka-desktop`）；黄金 **137/137**（`cargo test -p indicator-golden -- --nocapture` 输出 `golden: 137/137 passed`）；B2 夹具 **83 case**（bases 21×3 + insufficient 16 + below-min 4）。此前「45 项」只是 `indicator_core + data_store + indicator_golden` 三项之和，属口径错误，已弃用。**（2026-11-06 B3 增量后：全量 **97 passed**、黄金 **193/193**，本段为当时批次口径。）**

### P1-1 TD-S0-04 证据挂接（第三次同类问题）

- 做法：选「补真实事件原文」，不再用「代码里有」代替「证据文件里有」。
- `diag.ts` 的 `runBurst` 从遥测 `after.recent` 取最后一条 `indicator.compute` 原文，落盘为 `debounce.burst60.computeEvent`。
- 实机字段（**以 `generatedAt=2026-11-06T16:50:18.641Z` 批次、`tsMs=1793983776257` 为准**）：`indicatorId=T05`、`paramsHash=0d154e14a228d636`、`cacheKey=v2|aka-engine-0.1.0|sim-default|300750.SZ|D|qfq|T05|{"period":60}|2023-01-02~2024-12-27`、`security=300750.SZ`、`timeframe=D`、`adj=qfq`、`datasetId=sim-default`、`datasetGeneration=1`、`barCount=520`、`computeMs=0.014795`。早期批次曾记 `computeMs=0.0959`，已作废。
- 文档对齐：`aka-td-s0-04-criterion-ruling-v0.1.md`、`aka-tech-debt-s0-v0.1.md`、`aka-s2-real-machine-evidence-v0.1.md` 的字段清单改为上述**事件实际字段**（原写的 `code/period` 实际以 `security/timeframe` 落盘）。
- 语义更正：`compute.count` 是**请求批次计数**；当前一次 `calc` 请求含 **50** 个实例，`tsMs=1793983776258` 事件为 `count=5 / instances=50 / skip=6`（5 实算、6 skip、其余命中）。早期文档写的 `count=12` 属旧批次，已作废。断言目标是「只发 1 次请求、只发起 1 个计算批次」，不是「只算 1 个实例」。

### P1-2 tooltip 逐根等值（`AC-03.04-05`）

- `diag.ts` 新增 `tooltipParity`：从可见窗口取 120 根，派发真实 `mousemove` 后读 tooltip 的 `data-value`，与引擎序列同索引逐点比对，**容差 0**（每根同时比 T01 SMA 与 M06 DIF）。
- 实机结果（最新批次）：`sampled=120`、`enginePoints=520`、`mismatches=[]`、`ok=true`（240/240 点全等）。早前 `sampled=6` 已扩到 120，并针对屏幕→viewBox 取整造成的 5 处错位用 `data-hover-index` 校正至 0。
- `verification.renderLayer.ok` 已把 `tooltipParity.ok` 纳入必要条件。

### P2 五项

| 项 | 处理 | 证据 |
|---|---|---|
| P2-1 MACD `fast.max` 仍 100 | `model.ts` 本地校验与 `ParamPanel.tsx` 回退上限统一为 200（`fast/slow/signal` 三条与 manifest 一致） | `npm run build` 通过；manifest `fast/slow/signal` 均 `max=200` |
| P2-2 「11 个 B1 全部未达预热」残留 | 证据文档 §0 结论表与 §4 未达成段均改为「`T02/T04/T05/M06` 4 项不可算；`T01/T03/T19/T20/T21/T22/E13` 7 项可算，本次只取证行情层聚合」 | 文档全库检索无「11 个…未达预热」表述 |
| P2-3 证据文档缺配色行 | §5 增「§5.1 配色证据（`getComputedStyle`）」6 行：token、上/下 K 线描边、正/负柱 fill、涨跌文字三重编码 | 与 `verification.renderLayer.colorSamples` 逐字对应 |
| P2-4 below-min 期望值来源未标注 | `gen_reference.py` 注释 + 夹具顶层 `note` 字段：4 条期望值为**规格固化**（手写字面量 `NAN`/`1.0`），非参考实现推导 | 重生成后仅 `edge_b2_below_min_window.json` 增加 `note`，数值未变 |
| P2-5 报数口径 | 统一按全量：**88** / 黄金 **137/137** / B2 夹具 **83 case**；证据文档 §6 收录 **31** 指标、beta **5** 个（T03/T19/T21/M06/T16）；复跑命令改为 `cargo test -p indicator-golden -- --nocapture` | 本轮实跑输出 |

### 复跑结果（本轮）

```bash
cargo test --workspace --exclude aka-desktop   # 88 passed（17/32/26/8/5）
cargo test -p indicator-golden -- --nocapture  # golden: 137/137 passed
npm run build                                  # 通过
```

- 边界：`docs/indicators/b1-trend-kernels.md`、`docs/qa/aka-b1-card-reconciliation-v0.1.md`、`docs/story-cards/aka-story-cards-v0.1.md` 存在其他会话（BA）的改动，本会话不代为提交。
