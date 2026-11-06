# AKA · S2 实机取证报告（TD-S0-04 / 06 / 07 + W/M + 渲染层 + 口径页）

| 项 | 内容 |
|---|---|
| 文档编号 | AKA-QA-S2-EVIDENCE-0.1 |
| 版本 / 日期 | v0.1 / 2026-11-06 |
| 取证对象 | `TD-S0-04` 参数防抖、`TD-S0-06` 冷算 P95、`TD-S0-07` 缓存命中与切回、前端 W/M 周期切换、`TD-B1-02` 渲染层、`TD-B1-03` 口径页 |
| 取证环境 | macOS（Intel i7-9750H / x86_64）、Tauri 2 真窗口（`AKA_DIAG=1 npm run tauri dev`，非浏览器 mock）、数据集 `sim-default`（520 根日线） |
| 原始证据 | [`evidence/s2-20261106/s2-evidence.json`](./evidence/s2-20261106/s2-evidence.json)（55,692 字节）、[`telemetry-excerpt.jsonl`](./evidence/s2-20261106/telemetry-excerpt.jsonl)（610 行） |
| 结论 | `TD-S0-06 / 07` 判据满足；`TD-S0-04` 经判据裁定后满足（见 `aka-td-s0-04-criterion-ruling-v0.1.md`）；W/M 与缓存键、渲染层、口径页**均已取证** |
| 未达成 | ① M 周期仅 24 根月线：`T02/T04/T05/M06` 共 4 项未达预热，其余 7 项（`T01/T03/T19/T20/T21/T22/E13`）可算，但本次仍只取证到行情层聚合，未逐项取证；② 连键 `1→12→120` 的 120 组触发 `INSUFFICIENT_DATA`（TEMA 观察期 540 根 > 520 根），故按 BA 裁定 R-S0-04-01 以当前最大合法档位 `1→12→60` 佐证「只发一次且 compute 只增 1」 |

---

## 0. 取证方式（如实说明）

**截图不可用**：本机 `screencapture -x` 被系统屏幕录制权限拒绝（TCC），无法产出界面截图。因此本报告的证据形态固定为三件：

1. **DOM 断言**：前端在真实 Tauri 窗口内经 `invoke` 读回页面 DOM（`data-chart` / `data-overlay` / `data-readout` / `data-catalog-item` 等数据属性），由应用自身序列化成 JSON；
2. **日志摘要**：`~/Library/Application Support/aka/logs/telemetry.jsonl` 的结构化事件（`compute.count` / `compute.skip` / `cache.hit` / `cache.miss` / `indicator.cold_ms` / `indicator.compute`），压缩摘要已入库；
3. **采样表**：每次切换记录 `barsMs`（取行情）、`calcMs`（取指标）、`totalMs`（端到端墙钟，`performance.now()` 差值）、`cacheHit`、`barCount`、`seriesHash`（对全部数值 token 做 FNV-1a，用于逐点一致性比对）。

三件证据均由**真实进程**产出，未经任何 mock 替换：诊断入口 `app/src/features/workbench/diag.ts` 只调用与用户操作完全相同的 `ipc.getBars` / `ipc.calcIndicators`，并落盘至 `~/Library/Application Support/aka/diag/s2-evidence.json`。

**复跑方式**：

```bash
cd app && AKA_DIAG=1 npm run tauri dev
# 窗口启动后自动跑一轮诊断（每会话一次，sessionStorage 键 aka.s2.diag.once）
# 结果：~/Library/Application Support/aka/diag/s2-evidence.json，状态栏显示 diag-status
```

---

## 1. TD-S0-04 · 参数防抖（判据：连键 1→12→120 只触发一次 compute）

| 组 | 输入序列 | 输入间隔 | 静默阈值 | 实际发出请求数 | `compute.count` 增量 | 附加观测 | 判定 |
|---|---|---|---|---|---|---|---|
| A | 1 → 12 → 120 | 40ms | 120ms | **1** | 0 | 该请求执行到 TEMA 时 `INSUFFICIENT_DATA`（需 540 根，实际 520 根），`totalMs=14` | 通过 |
| B | 1 → 12 → 60 | 40ms | 120ms | **1** | **+1** | `barsMs=11`、`calcMs=15`、`totalMs=18`、`barCount=520`、`seriesPoints=7575`、`seriesHash=1ccf8fcd`；事件原文见下 | 通过 |

B 组 `indicator.compute` 事件原文（`debounce.burst60.computeEvent`，逐字摘录）：`indicatorId=T05`、`paramsHash=0d154e14a228d636`、`cacheKey=v2|aka-engine-0.1.0|sim-default|300750.SZ|D|qfq|T05|{"period":60}|2023-01-02~2024-12-27`、`security=300750.SZ`、`timeframe=D`、`adj=qfq`、`datasetId=sim-default`、`datasetGeneration=1`、`barCount=520`、`computeMs=0.0959`。

- 判据落地：**A 组证明「120ms 静默窗口吞掉中间 11 次输入」**（只发 1 条请求）；**B 组证明「这唯一一条请求只发起 1 个计算批次」**（`compute.count` 相对基线增量恰为 1）。`compute.count` 是**批次计数**，一条 `calc` 请求可含 12 个实例，事件 `count=12` 表示本批实算 12 个实例——断言的是请求批次只发生 1 次，不是「只算 1 个实例」。
- A 组为何 `compute.count` 为 0：`period=120` 的 TEMA 预热需 `4.5N−1 = 539` 根，模拟集仅 520 根，引擎在参数校验阶段直接返回 `INSUFFICIENT_DATA`，未进入计算。这是**数据长度限制**，不是防抖失效——请求数仍为 1，正是防抖要证明的量。
- 代码位置：前端 `REQUEST_DEBOUNCE_MS = 120`（`WorkbenchPage.tsx`）、输入间隔 `DEBOUNCE_INPUT_GAP_MS = 40`（`diag.ts`）；Rust 侧同一口径单测 `debounce_fires_once_after_120ms_quiet_with_40ms_inputs`。

## 2. TD-S0-06 · 冷缓存 30 次切换 P95（判据：P95 ≤300ms，报价头 ≤60ms）

30 个**互不相同**的标的（已去重，避免重复标的命中缓存），每次切到目标标的后取 D/前复权全区间并计算工作台 12 个实例。

| 指标 | 数值 | 阈值 | 判定 |
|---|---|---|---|
| 样本数 | 30 | 30 | 通过 |
| 全部 `cacheHit=false`（`allMiss`） | true | 必须全 miss | 通过 |
| `barsMs` P95（报价头） | **20ms** | ≤60ms | 通过 |
| `calcMs` P95（指标计算） | **28ms** | — | — |
| `totalMs` P95（端到端墙钟） | **31ms** | ≤300ms | 通过 |
| `totalMs` max | **67ms** | ≤300ms | 通过 |
| 引擎侧 `indicator.cold_ms` P95（350 样本） | **0.65ms** | 参考值 | — |

最近秩 P95：30 个样本取第 `⌈0.95×30⌉ = 29` 位。`totalMs` 排序后第 29 位 = 31ms（第 30 位 = 67ms，为 601003.SH 的单次抖动）。

**采样表（30 行，单位 ms）**

| # | 标的 | bars | calc | total | computed |
|---|---|---|---|---|---|
| 1 | 600519.SH | 17 | 26 | 28 | 2.79 |
| 2 | 002594.SZ | 17 | 24 | 26 | 2.86 |
| 3 | 601318.SH | 17 | 22 | 25 | 2.59 |
| 4 | 600036.SH | 17 | 23 | 25 | 2.58 |
| 5 | 000858.SZ | 17 | 21 | 23 | 2.61 |
| 6 | 688981.SH | 20 | 22 | 24 | 2.80 |
| 7 | 300059.SZ | 17 | 21 | 23 | 2.78 |
| 8 | 601899.SH | 13 | 16 | 18 | 3.28 |
| 9 | 002415.SZ | 16 | 24 | 26 | 3.01 |
| 10 | 600030.SH | 17 | 23 | 25 | 2.65 |
| 11 | 601012.SH | 16 | 21 | 24 | 3.68 |
| 12 | 000651.SZ | 17 | 24 | 27 | 3.53 |
| 13 | 600900.SH | 17 | 21 | 24 | 2.55 |
| 14 | 000001.SH | 13 | 19 | 21 | 1.84 |
| 15 | 399001.SZ | 20 | 27 | 29 | 3.63 |
| 16 | 399006.SZ | 18 | 23 | 25 | 2.95 |
| 17 | 601000.SH | 17 | 25 | 28 | 3.08 |
| 18 | 601001.SH | 17 | 28 | 31 | 5.31 |
| 19 | 601002.SH | 16 | 24 | 27 | 4.79 |
| 20 | 601003.SH | 17 | 66 | 67 | 5.52 |
| 21 | 601004.SH | 17 | 23 | 25 | 3.00 |
| 22 | 601005.SH | 16 | 22 | 24 | 2.85 |
| 23 | 601006.SH | 16 | 25 | 27 | 2.83 |
| 24 | 601007.SH | 17 | 23 | 25 | 2.66 |
| 25 | 601008.SH | 17 | 24 | 26 | 2.61 |
| 26 | 601009.SH | 17 | 22 | 24 | 2.15 |
| 27 | 601010.SH | 20 | 25 | 27 | 2.79 |
| 28 | 601011.SH | 16 | 25 | 28 | 4.64 |
| 29 | 601013.SH | 17 | 26 | 27 | 2.89 |
| 30 | 601014.SH | 19 | 25 | 26 | 3.23 |

## 3. TD-S0-07 · 切回缓存（判据：≤120ms 且数值逐点一致）

对上节前 10 个标的**切回**（各标的的 12 个实例此时全部在缓存内）。

| 指标 | 数值 | 阈值 | 判定 |
|---|---|---|---|
| 样本数 | 10 | 10 | 通过 |
| 全部 `cacheHit=true` | true | 必须全命中 | 通过 |
| 与冷算 `seriesHash` 逐一相等（逐点一致） | **10/10** | 10/10 | 通过 |
| `totalMs` P95 | **21ms** | ≤120ms | 通过 |
| `totalMs` max | **21ms** | ≤120ms | 通过 |
| `calcMs` max | **20ms** | — | — |

**采样表（10 行，单位 ms）**

| # | 标的 | bars | calc | total | cacheHit | hash 一致 |
|---|---|---|---|---|---|---|
| 1 | 600519.SH | 18 | 19 | 21 | true | true |
| 2 | 002594.SZ | 17 | 20 | 21 | true | true |
| 3 | 601318.SH | 17 | 18 | 21 | true | true |
| 4 | 600036.SH | 17 | 19 | 21 | true | true |
| 5 | 000858.SZ | 17 | 18 | 19 | true | true |
| 6 | 688981.SH | 11 | 18 | 20 | true | true |
| 7 | 300059.SZ | 13 | 14 | 16 | true | true |
| 8 | 601899.SH | 17 | 18 | 20 | true | true |
| 9 | 002415.SZ | 17 | 17 | 19 | true | true |
| 10 | 600030.SH | 16 | 17 | 19 | true | true |

- 「逐点一致」的判定方式：`seriesHash` 由 `CalcResponse` 的三条输出按「指标 id + 序列名 + 每个数值 token（保留 17 位有效数字）」拼接后做 FNV-1a；冷算与缓存直返的哈希相等即等价于逐点相等（不是抽样比对）。
- 原始事件：`cache.hit` 共 138 条、`cache.miss` 350 条、`indicator.cold_ms` 350 条（见 `telemetry-excerpt.jsonl`）。

## 4. 前端 W/M 周期切换与缓存键

| 项 | 证据 | 判定 |
|---|---|---|
| 工具栏三档 | 周期按钮 `D / W / M`，`aria-pressed` 跟随 `timeframe` 状态 | 打通 |
| UI 切 W | 600030.SH：`barCount=104`、`cacheHit=false`、`totalMs=15`、`seriesPoints=1279`、`seriesHash=1766e23e` | 通过 |
| 切回 D | 同标的：`barCount=520`、`cacheHit=true`、`totalMs=21`、`seriesPoints=7935`、`seriesHash=0b15d02f` | 通过 |
| 行情层三档根数 | `probeBars`：D=520 / W=104 / M=24，`datasetId=sim-default` | 通过 |
| 聚合顺序 | `app-core::series_for` 先取 `daily_batch(code, adj)`（复权在 provider 内逐行完成），再 `aggregate_bars(Week/Month)` | 先复权后聚合 |
| 缓存键随周期变化 | 日志实测两条键：D=`v2\|aka-engine-0.1.0\|sim-default\|600030.SH\|D\|qfq\|T01\|{"period":20}\|2023-01-02~2024-12-27`；W=`…\|600030.SH\|W\|qfq\|T01\|{"period":20}\|2023-01-06~2024-12-27` | 不命中旧缓存 |
| 单测 | `cache_key_includes_timeframe`：`1d/1w/1m` 三个键两两不等且各自含周期段 | 通过 |

说明：W 的区间起点 `2023-01-06` 与 D 的 `2023-01-02` 不同，是 ISO 周对齐后的首根自然结果，也反证了「周期进入缓存键」。

**未达成（如实登记）**：M 周期只有 24 根月线。按 `warmup+1` 门核算，**`T02/T04/T05/M06` 共 4 项不可算**（按 `warmup+1` 最长需 60 根）；**`T01/T03/T19/T20/T21/T22` 共 6 项可算**，`E13`（warmup 23）恰好卡界、需 24 根，合计 **7 项可算**。本次 M 周期只取证到**行情层聚合**（24 根），未逐项取证可算指标的数值；日志与 payload 的 `monthlyNote` 已按上述 4 项不可算 / 7 项可算记录数据量限制（依据 [`aka-s2-qa-report-v0.1.md`](./aka-s2-qa-report-v0.1.md) §2.3）。

## 5. TD-B1-02 · 渲染层证据（DOM 断言）

在真实窗口主图悬停第 76 根（`hoverIndex=76`）后读取 DOM：

| 证据点 | DOM 断言 | 实测 |
|---|---|---|
| 图表存在 | `data-chart="candle"` | true |
| 主图叠加线去重后 8 条 | `data-overlay` | T01 T02 T03 T04 T05 T19 T20 T22（`overlayCount=8`，T01 的重复渲染已去掉） |
| MACD 双线 | `data-macd="dif" / "dea"` | 2 条 |
| 统计读数条 | `data-readout` | T21-r2 / E13-bias6 / E13-bias12 / E13-bias24（4 条） |
| 读数宿主与悬停帧 | `data-readout-host="1"`、`data-hover-index` | 存在 / `76` |
| 单位 | `data-unit` | `无量纲`（R²）、`%`×3（BIAS 三线） |
| tooltip 与引擎同帧 | `data-value` + 2 位小数文本 | 8 条 MA tooltip：T01 25.65 元 / T02 25.50 元 / T03 25.61 元 / T04 25.75 元 / T05 25.63 元 / T19 25.53 元 / T20 25.77 元 / T22 -0.01 元/根 |
| tooltip 逐根等值 | tooltip `data-value` vs 引擎序列逐点比对（容差 **0**） | `sampled=6`、`enginePoints=520`、`mismatches=[]`、`ok=true`；采样根 400/424/448/471/495/519，每根同时比 T01 SMA 与 M06 DIF 两点（12/12 全等） |
| 小数位 | `decimalsOk` | true |
| 悬停异常 | `hoverError` | null |

**§5.1 配色证据（`getComputedStyle` 计算样式采样，源 `verification.renderLayer.colorSamples`）**

| 证据点 | DOM 对象 | 计算样式实测 |
|---|---|---|
| 语义 token | `--pos` / `--neg` | `rgb(228, 72, 63)` / `rgb(23, 166, 115)` |
| 上涨 K 线描边 | `[data-candle][data-dir='up']` → `stroke` | `rgb(228, 72, 63)`（与 `--pos` 相等） |
| 下跌 K 线描边 | `[data-candle][data-dir='down']` → `stroke` | `rgb(23, 166, 115)`（与 `--neg` 相等） |
| MACD 正柱 | `[data-macd='hist'][data-sign='pos']` → `fill` | `rgb(228, 72, 63)` |
| MACD 负柱 | `[data-macd='hist'][data-sign='neg']` → `fill` | `rgb(23, 166, 115)` |
| 涨跌文字三重编码（色 + 符号 + 数值） | 报价头 `chgFirst` / `chgSecond` | `pos\|rgb(228, 72, 63)\|▲ +2.74%` / `neg\|rgb(23, 166, 115)\|▼ -9.98%` |

判定 `colorOk=true`：四个图形对象（上/下 K 线、正/负柱）的 `stroke`/`fill` 与 `--pos`/`--neg` token 逐项相等，且涨跌文字在「颜色 + ▲/▼ 符号 + 带符号数值」三重维度上同时编码，不是单靠颜色区分。该证据来自**应用内真实窗口的计算样式**，非手抄期望值。

覆盖 `AC-03.04-05`（MA 图线与 tooltip 同帧、2 位小数、NaN 留白；逐根等值由 `tooltipParity` 单独承担）、`AC-03.04-05（补1）`（**仅**数据不足提示「59 根 / 3N−1」，未按 AC 停止画线，故该条只登记部分满足）、`AC-03.04-11`（T19/T20/T22 入图与单位，T21 为独立读数，3/4 满足）、`AC-03.04-15`（BIAS 三线读数带符号 2 位小数与 `%`，副图折线未做）。

## 6. TD-B1-03 · 口径页（`#/catalog`）

| 证据点 | DOM 断言 | 实测 |
|---|---|---|
| 路由 | `#/catalog`（P4 路由，hash 路由表内） | 可访问 |
| 页面根 | `data-catalog-root="p4"` | 存在 |
| 收录指标数 | `data-catalog-item` | **31**（B1 11：T01 T02 T03 T04 T05 T19 T20 T21 T22 E13 M06；B2 20：T08–T16、T23、T24、V01–V05、V07–V10） |
| 四段口径 | `data-catalog-section` | formula / params / warmup / boundary |
| beta 徽标 | `data-catalog-beta` | 5 个（T03 / T19 / T21 / M06 / T16，与 manifest `specStatus=partial` 逐项对应） |

页面是**应用内真实页面**（React 路由 + DOM 渲染），不是 Markdown 文档冒充；内容源为 `app/src/features/catalog/content.ts`，与 manifest 同源校对。

## 7. 证据文件与复跑命令

| 文件 | 内容 |
|---|---|
| [`evidence/s2-20261106/s2-evidence.json`](./evidence/s2-20261106/s2-evidence.json) | 完整诊断 payload：防抖两组、冷切 30 行、回切 10 行、W/M、渲染层、口径页、遥测汇总 |
| [`evidence/s2-20261106/telemetry-excerpt.jsonl`](./evidence/s2-20261106/telemetry-excerpt.jsonl) | 610 条结构化事件压缩摘要（保留 `compute.count` / `cache.hit` / `cache.miss` / `indicator.cold_ms` / `compute.skip`） |
| `~/Library/Application Support/aka/logs/telemetry.jsonl` | 全量遥测（1277 条） |
| `~/Library/Application Support/aka/diag/s2-evidence.json` | 应用落盘原始件（仓库内为拷贝） |

| 命令 | 作用 |
|---|---|
| `cargo test --workspace --exclude aka-desktop` | Rust 单测（含防抖、缓存键、聚合、遥测） |
| `cargo test -p indicator-golden -- --nocapture` | 黄金夹具 **137/137** case 对拍（输出 `golden: 137/137 passed`） |
| `cargo run -p indicator-golden --bin aka-bench --release` | 62 项性能基线（B2 占 40 项） |
| `AKA_DIAG=1 npm run tauri dev` | 本报告全部实机证据的产出方式 |

---

## 8. 台账更新口径

- `TD-S0-06 / 07`：判据满足，**改「已清偿」**（修订见 `aka-tech-debt-s0-v0.1.md`）。
- `TD-S0-04`：原判据 `1→12→120` 在本数据集不可观测；BA 已裁定修订为「当前最大合法档位（60）」（R-S0-04-01），按修订判据满足，**可由开发改「已清偿」**；状态行由开发更新。
- `TD-B1-02 / 03`：证据已落地，但**「是否结项」不由开发判定**，交 BA 复核（见 `aka-b1-card-reconciliation-v0.1.md`）。
