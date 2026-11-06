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

> **数据来源**：本节全部数字取自 `generatedAt=2026-11-06T16:50:18.641Z` 的 diag 批次（即 `docs/qa/evidence/s2-20261106/s2-evidence.json` 当前版本）。`compute.count` 取自同期 `~/Library/Application Support/aka/logs/telemetry.jsonl` 的 `tsMs=1793983776258` 事件。此后任何一次 diag 重跑，本节数字必须随之同步。

| 组 | 输入序列 | 输入间隔 | 静默阈值 | 实际发出请求数 | `compute.count` 增量 | 附加观测 | 判定 |
|---|---|---|---|---|---|---|---|
| A | 1 → 12 → 120 | 40ms | 120ms | **1** | 0 | 该请求执行到 TEMA 时 `INSUFFICIENT_DATA`（需 540 根，实际 520 根），`totalMs=16`、`barCount=0`（`tsMs=1793983774827`） | 通过 |
| B | 1 → 12 → 60 | 40ms | 120ms | **1** | **+1** | `barsMs=17`、`calcMs=24`、`totalMs=32`、`barCount=520`、`seriesPoints=39182`、`seriesHash=c84fa833`、`computedMs=0.14` | 通过 |

B 组 `indicator.compute` 事件原文（`debounce.burst60.computeEvent`，逐字摘录，`tsMs=1793983776257`）：`indicatorId=T05`、`paramsHash=0d154e14a228d636`、`cacheKey=v2|aka-engine-0.1.0|sim-default|300750.SZ|D|qfq|T05|{"period":60}|2023-01-02~2024-12-27`、`security=300750.SZ`、`timeframe=D`、`adj=qfq`、`datasetId=sim-default`、`datasetGeneration=1`、`barCount=520`、`computeMs=0.014795`。

- 判据落地：**A 组证明「120ms 静默窗口吞掉中间 11 次输入」**（只发 1 条请求）；**B 组证明「这唯一一条请求只发起 1 个计算批次」**（`compute.count` 事件数相对基线增量为 1）。`compute.count` 是**批次计数**，一次 `calc` 请求含 50 个实例；同期事件 `tsMs=1793983776258` 实为 `count=5 / instances=50 / skip=6`（5 个实算、6 个 skip、其余命中缓存）。断言的是请求批次只发生 1 次，不是「只算 1 个实例」。
- A 组为何 `compute.count` 为 0：`period=120` 的 TEMA 预热需 `4.5N−1 = 539` 根，模拟集仅 520 根，引擎在参数校验阶段直接返回 `INSUFFICIENT_DATA`，未进入计算。这是**数据长度限制**，不是防抖失效——请求数仍为 1，正是防抖要证明的量。
- 代码位置：前端 `REQUEST_DEBOUNCE_MS = 120`（`WorkbenchPage.tsx`）、输入间隔 `DEBOUNCE_INPUT_GAP_MS = 40`（`diag.ts`）；Rust 侧同一口径单测 `debounce_fires_once_after_120ms_quiet_with_40ms_inputs`。

## 2. TD-S0-06 · 冷缓存 30 次切换 P95（判据：P95 ≤300ms，报价头 ≤60ms）

30 个**互不相同**的标的（已去重，避免重复标的命中缓存），每次切到目标标的后取 D/前复权全区间并计算工作台 12 个实例。

| 指标 | 数值 | 阈值 | 判定 |
|---|---|---|---|
| 样本数 | 30 | 30 | 通过 |
| 全部 `cacheHit=false`（`allMiss`） | true | 必须全 miss | 通过 |
| `barsMs` P95（报价头） | **15ms** | ≤60ms | 通过 |
| `calcMs` P95（指标计算） | **25ms** | — | — |
| `totalMs` P95（端到端墙钟） | **34ms** | ≤300ms | 通过 |
| `totalMs` max | **41ms** | ≤300ms | 通过 |
| 引擎侧 `indicator.cold_ms` P95（1373 样本） | **0.12ms** | 参考值 | — |

最近秩 P95：30 个样本取第 `⌈0.95×30⌉ = 29` 位。`totalMs` 排序后第 29 位 = 34ms（第 30 位 = 41ms，为 601001.SH 的单次抖动）。数据取自 `generatedAt=2026-11-06T16:50:18.641Z` 批次。

**采样表（30 行，单位 ms）**

| # | 标的 | bars | calc | total | computed |
|---|---|---|---|---|---|
| 1 | 600519.SH | 12 | 22 | 31 | 2.65 |
| 2 | 002594.SZ | 15 | 25 | 34 | 2.00 |
| 3 | 601318.SH | 13 | 25 | 33 | 1.67 |
| 4 | 600036.SH | 13 | 17 | 24 | 1.66 |
| 5 | 000858.SZ | 14 | 18 | 25 | 1.58 |
| 6 | 688981.SH | 12 | 15 | 21 | 1.41 |
| 7 | 300059.SZ | 14 | 18 | 25 | 1.63 |
| 8 | 601899.SH | 14 | 23 | 32 | 1.56 |
| 9 | 002415.SZ | 14 | 18 | 25 | 1.60 |
| 10 | 600030.SH | 14 | 18 | 25 | 1.51 |
| 11 | 601012.SH | 11 | 15 | 21 | 1.16 |
| 12 | 000651.SZ | 14 | 24 | 34 | 1.74 |
| 13 | 600900.SH | 13 | 23 | 31 | 1.64 |
| 14 | 000001.SH | 14 | 18 | 26 | 1.73 |
| 15 | 399001.SZ | 15 | 20 | 28 | 1.94 |
| 16 | 399006.SZ | 13 | 24 | 33 | 1.55 |
| 17 | 601000.SH | 10 | 14 | 22 | 1.33 |
| 18 | 601001.SH | 14 | 33 | 41 | 2.28 |
| 19 | 601002.SH | 13 | 23 | 31 | 1.63 |
| 20 | 601003.SH | 13 | 22 | 30 | 1.94 |
| 21 | 601004.SH | 12 | 22 | 29 | 1.57 |
| 22 | 601005.SH | 10 | 12 | 18 | 1.11 |
| 23 | 601006.SH | 13 | 17 | 24 | 1.49 |
| 24 | 601007.SH | 14 | 18 | 25 | 1.60 |
| 25 | 601008.SH | 14 | 18 | 25 | 1.64 |
| 26 | 601009.SH | 13 | 17 | 24 | 1.59 |
| 27 | 601010.SH | 13 | 23 | 31 | 1.53 |
| 28 | 601011.SH | 10 | 14 | 20 | 1.13 |
| 29 | 601013.SH | 14 | 23 | 31 | 1.53 |
| 30 | 601014.SH | 13 | 23 | 31 | 1.59 |

## 3. TD-S0-07 · 切回缓存（判据：`totalMs` max ≤120ms 且数值逐点一致）→ **已清偿**

结论先说：**修复前两批 10 样本的 192ms / 132ms 原样留档（本节表 A / 表 B），修复后在安静机器上连跑 4 批 × 30 样本，其中连续 3 批 max 为 48 / 58 / 40ms，判据（max ≤120ms）未改。** 修复前 10 样本如下。

对上节前 10 个标的**切回**（各标的的 50 个实例此时全部在缓存内）。两批次数据均留档：

| 指标 | `a212660` | `7ded2bc` | 阈值 | 判定 |
|---|---|---|---|---|
| 运行时间 | 2026-11-06T15:34:10.542Z（`generatedAt`） | 2026-11-06T15:49:23.236Z | — | — |
| 样本数 | 10 | 10 | 10 | 通过 |
| 全部 `cacheHit=true` | true | true | 必须全命中 | 通过 |
| 与冷算 `seriesHash` 逐一相等 | **10/10** | **10/10** | 10/10 | 通过 |
| `totalMs` P95 | **192ms** | **132ms** | ≤120ms | **未达标** |
| `totalMs` max | **192ms** | **132ms** | ≤120ms | **未达标** |
| `calcMs` max | **187ms** | **125ms** | — | — |

> 原文「P95 21 / max 21」为 S2 早期批次残留，与上述 JSON 矛盾，已作废并从所有文档删除。
> 30 样本批次（含 `opt-level=1` 与埋点句柄复用修复）见本节末尾。

**采样表 A（`a212660`，10 行，单位 ms）**

| # | 标的 | bars | calc | total | cacheHit | hash 一致 |
|---|---|---|---|---|---|---|
| 1 | 600519.SH | 46 | 120 | 128 | true | true |
| 2 | 002594.SZ | 15 | 83 | 89 | true | true |
| 3 | 601318.SH | 14 | 187 | 192 | true | true |
| 4 | 600036.SH | 17 | 90 | 97 | true | true |
| 5 | 000858.SZ | 18 | 177 | 184 | true | true |
| 6 | 688981.SH | 19 | 58 | 67 | true | true |
| 7 | 300059.SZ | 18 | 55 | 63 | true | true |
| 8 | 601899.SH | 15 | 53 | 60 | true | true |
| 9 | 002415.SZ | 14 | 55 | 63 | true | true |
| 10 | 600030.SH | 12 | 42 | 47 | true | true |

超线段：128 / 184 / 192（3 条）。高值出现在第 3、第 5 个样本，**不是冷启首切**；原 `notes` 的「回切异常 max 192ms」即此。

**采样表 B（`7ded2bc`，10 行，单位 ms）**

| # | 标的 | bars | calc | total | cacheHit | hash 一致 |
|---|---|---|---|---|---|---|
| 1 | 600519.SH | 11 | 47 | 55 | true | true |
| 2 | 002594.SZ | 9 | 37 | 42 | true | true |
| 3 | 601318.SH | 17 | 49 | 57 | true | true |
| 4 | 600036.SH | 17 | 51 | 58 | true | true |
| 5 | 000858.SZ | 11 | 48 | 56 | true | true |
| 6 | 688981.SH | 17 | 54 | 61 | true | true |
| 7 | 300059.SZ | 17 | 125 | 132 | true | true |
| 8 | 601899.SH | 16 | 90 | 97 | true | true |
| 9 | 002415.SZ | 17 | 65 | 73 | true | true |
| 10 | 600030.SH | 17 | 87 | 94 | true | true |

超线段：132（1 条）。高值出现在第 7 个样本，仍非首切。

- 「逐点一致」的判定方式：`seriesHash` 由 `CalcResponse` 的三条输出按「指标 id + 序列名 + 每个数值 token（保留 17 位有效数字）」拼接后做 FNV-1a；冷算与缓存直返的哈希相等即等价于逐点相等（不是抽样比对）。
- 原始事件：摘要文件 `telemetry-excerpt.jsonl`（610 行快照）含 `cache.hit` 138 / `cache.miss` 350 / `indicator.cold_ms` 350；全量 `~/Library/Application Support/aka/logs/telemetry.jsonl`（102,200 行，跨多轮重跑累计）含 `cache.hit` 20,999 / `cache.miss` 24,788 / `indicator.cold_ms` 24,787。

### 3.1 根因：命中路径的耗时到底在哪一段

Rust 侧微基准 `app-core::core::microbench_breakdown`（`#[ignore]`，命中路径，44 实例；payload 641.5KB@520 根、3.13MB@2500 根；下表为 **p50**，dev = 修复前未加 `opt-level` 的 dev 构建，release = `--release`）：

| 段（按测试内实际编号） | 520 dev | 520 release | 2500 dev | 2500 release |
|---|---|---|---|---|
| ① 从缓存取序列（Arc clone + 窗口解析） | 0.001 | 0.000 | 0.001 | 0.000 |
| ② 序列拷贝（`CandleSeries` → 6 列连续 f64） | 0.027 | 0.006 | 0.131 | 0.028 |
| ③ 每实例预处理（lookup / merge_defaults / validate / calc_key / params_hash / ctx） | 0.885 | 0.203 | 0.905 | 0.202 |
| ④ 每实例缓存查表（Mutex + HashMap + Arc clone） | 0.693 | 0.134 | 0.702 | 0.129 |
| ⑤ DTO 组装 + NaN→null | 0.722 | 0.062 | **5.290** | 1.826 |
| ⑥ 整份 `CalcResponse` JSON 序列化（IPC 报文） | **27.30** | 1.61 | **125.5** | 6.52 |
| ⑦a 埋点（内存环形队列） | 0.0x 级 | 0.0x 级 | 同左 | 同左 |
| ⑦b 埋点（内存 + JSONL 落盘） | 6.10 | 3.46 | 4.60 | 3.78 |
| ⑧ 端到端 `calc_indicators`（命中，含锁/事件/DTO/序列化） | 2.54 | 0.47 | 6.77 | 1.99 |

> ⑦a 未单独记入上表：它只往内存环 push，三个档位都在 0.0x ms 量级，不构成瓶颈；瓶颈证据全部在 ⑥ 与 ⑦b。

**瓶颈结论：不是缓存、不是 DTO、不是逐点 clone。** ①+②+④ 合计 p50 < 0.75ms，⑤ 在 520 根只有 0.72ms；占绝对大头的是 ⑥ 未优化 dev 构建下的整包 JSON 序列化（520 根 dev p50 27.3ms、2500 根 dev p50 **125.5ms**，与实测 192ms 同量级），其次是 ⑦b 埋点每条事件 `open` 一次文件（dev p50 6.1ms）。因此修复方向是构建与 I/O，而不是把 `Vec<f64>` 改成零拷贝——后者对 <1ms 的段没有收益。零拷贝视图（`&[f64]` + Arrow）留作后续，仅在 payload 进一步变大时才有必要。

**修复后同一微基准复测（`opt-level=1` + 埋点复用文件句柄，p50 / p95 / max，单位 ms）**

| 段 | 520 根 | 2500 根 |
|---|---|---|
| ① 从缓存取序列 | 0.000 / 0.000 / 0.000 | 0.000 / 0.000 / 0.001 |
| ② 序列拷贝（6 列 f64） | 0.005 / 0.006 / 0.007 | 0.028 / 0.028 / 0.041 |
| ③ 每实例预处理 | 0.237 / 0.588 / 0.973 | 0.261 / 0.455 / 0.614 |
| ④ 每实例缓存查表 | 0.156 / 0.243 / 0.556 | 0.161 / 0.350 / 0.595 |
| ⑤ DTO 组装 + NaN→null | 0.076 / 0.084 / 1.426 | 1.957 / 2.962 / 4.135 |
| ⑥ **整份 Response 序列化** | **2.338 / 3.453 / 3.794** | **10.702 / 12.289 / 14.225** |
| ⑦a 埋点（内存） | 0.139 / 0.164 / 0.166 | 0.136 / 0.150 / 0.161 |
| ⑦b 埋点（JSONL） | 0.679 / 2.115 / 79.335 | 0.487 / 1.013 / 2.116 |
| ⑧ 端到端 `calc_indicators`（命中） | **1.005 / 4.015 / 6.156** | 2.522 / 4.318 / 4.834 |

⑥ 27.30 → **2.338ms**（11.7×）、125.5 → **10.702ms**（11.7×）；⑦b 6.10 → **0.679ms**（p50）。
⑦b 的 520 根 max=79.3ms 是单次磁盘 flush 抖动（p95 仍 2.1ms），在 30 样本实机批次中未出现。
**复核注**：QA 复跑 dev ⑦b 得 19.158ms，0.679ms 未复现（磁盘落盘噪声）；0.679 仅是单次观测，不作稳定结论引用。
复测命令：`cargo test -p app-core microbench_breakdown -- --ignored --nocapture`。

### 3.2 修复后：4 批 × 30 样本（判据不变，仍是 max ≤120ms）

| 批次 | `generatedAt` | 样本 | P50 | P95 | max | 备注 |
|---|---|---|---|---|---|---|
| #1 | 2026-11-06T16:34Z | 30 | 25 | 33 | **123** | `opt-level=1` 构建刚结束的首批，单点越线，**无独立 JSON（仅本文档+台账，弱于 192/132）**，原样留档 |
| #2 | 2026-11-06T16:45:00.891Z | 30 | 23 | 33 | 48 | 通过 |
| #3 | 2026-11-06T16:47Z | 30 | 24 | 50 | 58 | 通过 |
| #4 | 2026-11-06T16:50:18.641Z | 30 | 24 | 34 | 40 | 通过（当前入库批次） |

判定：连续 3 批（#2–#4，共 90 样本）max 48 / 58 / 40ms，全部 ≤120ms，且全部 `cacheHit=true`、`seriesHash` 与冷算 30/30 一致。**#1 的 123ms 单点不剔除、不解释成「偶然」，原样保留在表内；若后续安静机器复跑再出现 >120ms，本条立即回退「部分清偿」。** 修复前后对比：192 / 132 → 48 / 58 / 40。

**30 样本采样（#4，单位 ms）**

| # | 标的 | bars | calc | total | engineMs | hash 一致 |
|---|---|---|---|---|---|---|
| 1 | 600519.SH | 14 | 18 | 26 | 0 | true |
| 2 | 002594.SZ | 13 | 17 | 24 | 0 | true |
| 3 | 601318.SH | 10 | 13 | 18 | 0 | true |
| 4 | 600036.SH | 13 | 16 | 21 | 0 | true |
| 5 | 000858.SZ | 12 | 16 | 22 | 0 | true |
| 6 | 688981.SH | 14 | 18 | 25 | 0 | true |
| 7 | 300059.SZ | 12 | 16 | 23 | 0 | true |
| 8 | 601899.SH | 14 | 18 | 25 | 0 | true |
| 9 | 002415.SZ | **34** | **34** | **40** | 0 | true |
| 10 | 600030.SH | 11 | 13 | 18 | 0 | true |
| 11 | 601012.SH | 9 | 12 | 17 | 0 | true |
| 12 | 000651.SZ | 12 | 16 | 23 | 0 | true |
| 13 | 600900.SH | 13 | 17 | 25 | 0 | true |
| 14 | 000001.SH | 14 | 20 | 29 | 0 | true |
| 15 | 399001.SZ | 16 | 21 | 29 | 0 | true |
| 16 | 399006.SZ | 6 | 21 | 29 | 0 | true |
| 17 | 601000.SH | 14 | 18 | 25 | 0 | true |
| 18 | 601001.SH | 13 | 17 | 24 | 0 | true |
| 19 | 601002.SH | 13 | 17 | 23 | 0 | true |
| 20 | 601003.SH | 9 | 12 | 17 | 0 | true |
| 21 | 601004.SH | 14 | 17 | 24 | 0 | true |
| 22 | 601005.SH | 14 | 17 | 25 | 0 | true |
| 23 | 601006.SH | 12 | 16 | 23 | 0 | true |
| 24 | 601007.SH | 14 | 18 | 24 | 0 | true |
| 25 | 601008.SH | 13 | 17 | 24 | 0 | true |
| 26 | 601009.SH | 14 | 18 | 26 | 0 | true |
| 27 | 601010.SH | 13 | 25 | 34 | 0 | true |
| 28 | 601011.SH | 13 | 17 | 24 | 0 | true |
| 29 | 601013.SH | 12 | 16 | 23 | 0 | true |
| 30 | 601014.SH | 12 | 16 | 23 | 0 | true |

`engineMs` 全 0 的原因：命中路径不进入 `indicator.calc`，引擎耗时事件 `indicator.compute` 不产生，前端取不到分项。P50 24 / P95 34 / max 40 均由 `verification.warm` 的 `nearestRankPercentile` 算出，与上表逐行可复算。

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
| 主图叠加线 13 条 | `[data-overlay][data-overlay-key]` | T01 T02 T03 T04 T05 T19 T20 T22（B1 8 条）+ T09×3（上/中/下轨）+ T24×2（HHV/LLV大关），`overlayCount=13` |
| MACD 三线 | `data-macd="dif" / "dea" / "hist"` | 3 条（`macdHistCount=120` 根柱） |
| 统计读数条 | `data-readout` | T21-r2 / E13-bias6 / E13-bias12 / E13-bias24（4 条） |
| 读数宿主与悬停帧 | `data-readout-host="1"`、`data-hover-index` | 存在 / `76` |
| 单位 | `data-unit` | `无量纲`（R²）、`%`×3（BIAS 三线） |
| tooltip 与引擎同帧 | `data-value` + 2 位小数文本 | 8 条 MA tooltip：T01 235.51 元 / T02 235.97 元 / T03 234.78 元 / T04 233.27 元 / T05 232.98 元 / T19 233.32 元 / T20 237.70 元 / T22 -0.23 元/根 |
| tooltip 逐根等值 | tooltip `data-value` vs 引擎序列逐点比对（容差 **0**） | `sampled=120`、`enginePoints=520`、`mismatches=[]`、`ok=true`；每根同时比 T01 SMA 与 M06 DIF 两点（240/240 全等），跨周期边界由 `data-hover-index` 校正，校正后错位 0 |
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
| 涨跌文字三重编码（色 + 符号 + 数值） | 报价头 `chgFirst` / `chgSecond` / `chgPos`（另补采一根上涨 K 线） | `neg\|rgb(23, 166, 115)\|▼ -1.01%` / `neg\|rgb(23, 166, 115)\|▼ -1.34%` / `pos\|rgb(228, 72, 63)\|▲ +2.65%` |

判定 `colorOk=true`：四个图形对象（上/下 K 线、正/负柱）的 `stroke`/`fill` 与 `--pos`/`--neg` token 逐项相等，且涨跌文字在「颜色 + ▲/▼ 符号 + 带符号数值」三重维度上同时编码，不是单靠颜色区分。该证据来自**应用内真实窗口的计算样式**，非手抄期望值。

覆盖 `AC-03.04-05`（MA 图线与 tooltip 同帧、2 位小数、NaN 留白；逐根等值由 `tooltipParity` 单独承担）、`AC-03.04-05（补1）`（**仅**数据不足提示「59 根 / 3N−1」，未按 AC 停止画线，故该条只登记部分满足）、`AC-03.04-11`（T19/T20/T22 入图与单位，T21 为独立读数，3/4 满足）、`AC-03.04-15`（BIAS 三线读数带符号 2 位小数与 `%`，副图折线未做）。

### 5.2 B2 八卡渲染 AC（按条款逐条断言，不再是通用四检查）

`verification.b2Render`：**8 卡 / 60 条 clause / failCount=0 / dataLimited=1（非缺陷，见下）**。每条 clause 有自己的断言语义与 `detail`，不是「选中 + 节点数 + paint 非空 + 读数形状」。

| 卡 | AC | 类型 | clause 数 | 关键条款（QA 点名的项已逐条覆盖） |
|---|---|---|---|---|
| S-03.05-01 | AC-03.05-05 | overlay | 8 | 中轨**虚线** `4px,3px` vs 上下轨 `none`（取 `getComputedStyle` 的 `stroke-dasharray`）；upper/middle/lower **各自** `segments=1`（数据不足处断开）；图例三线颜色=线色；**切标的后不残留旧线** |
| S-03.05-02 | AC-03.05-10 | sub | 11 | V01/V02/V09/V10 各自的读数与单位；**每条线** `segments=1` 断开；ATR 以元、ATRP 以比值显示；**切标的后读数与当前引擎一致**、旧值不残留 |
| S-03.05-03 | AC-03.05-16 | overlay | 7 | 仅显示激活侧；**翻转根有 `data-flip-dir` 标记**；**翻转后新侧不继承旧侧值**；long/short NaN 段各自断开 |
| S-03.05-04 | AC-03.05-20 | overlay | 10 | 云带按多空着色（`data-cloud-sign`）；先行带末根截断（`lastFinite == barsLength-1`）；迟行线尾端 26 根 NaN（与 `gen_reference.py:344` 位移方向一致）；五线各自断开 |
| S-03.05-05 | AC-03.05-24 | overlay | 5 | `path[data-overlay='T16']` 数量为 0（**点不连成线**）；**反转箭头数量与方向**（`[data-flip='T16']` 数量 == 引擎侧翻转根数，`data-flip-dir` 的 up/down 分别 == 引擎侧方向计数）；多空色取实际色值比对 `--pos`/`--neg` |
| S-03.05-06 | AC-03.05-27 | overlay | 5 | 首根无值；**切周期后三线重算**（从 `tf.afterWeekly` 快照取值，`weeklyBars !== dailyBars` 且至少 1 个数值不同）；切周期后旧线不残留 |
| S-03.05-07 | AC-03.05-31 | sub | 9 | V03/V04/V05 读数与单位且**各自断开**；带宽以比值显示；**%B 文本小数位恰为 2**（从显示文本提取数字 token 判小数位，不看 `data-value` 原始 double） |
| S-03.05-08 | AC-03.05-35 | sub | 5 | **0 轴可见**（`[data-sub-zero='1']` 恰 1 条）；**正负分色取实际色值**（`[data-sub='V08'] path[data-sub-sign='pos'|'neg']` 的 `stroke` 比对 `--pos`/`--neg`）；正负路径按符号断开；切标的不残留 |

`dataLimited=1` 是 S-03.05-07 的 clause「零带宽段显示 —」：当前数据集 520 根内不存在连续零带宽段，该 clause 无法构造输入，标 `n/a`，已在 payload 中如实记录，不是 pass。

### 5.3 B3 十三卡渲染采样（`expect` 从 manifest 动态取）

`verification.b3Render`：**13 卡 / 24 个切换选项 / missing=[] / 13/13 ok**。期望值不再是硬编码常量，而是运行时读 `manifest/indicators.json` 每项的 `outputs.length`：

```ts
expect[id] = outputCounts.get(id) ?? -1;   // 来自 manifest, 缺失时 -1 直接判失败
ok = nodes === expect[id] && paintCount === expect[id] && paintOk && readouts === expect[id] && readoutOk;
```

因此以后指标新增一条输出线，`nodes` 与实际不一致会立刻失败，而不是静默失配。逐卡输出条数实测：M01 1 / M02 3 / M04 1 / M05 1 / M08 2 / M09 1 / M10 1 / M19 2 / M20 2 / M21 1 / M24 1 / M25 2 / M26 1。M25 的三色分色另有独立断言 `triColor`（120 根柱，唯一色集合恰为 `rgb(228,72,63)` / `rgb(23,166,115)` / `rgb(59,130,246)`）。

## 6. TD-B1-03 · 口径页（`#/catalog`）

| 证据点 | DOM 断言 | 实测 |
|---|---|---|
| 路由 | `#/catalog`（P4 路由，hash 路由表内） | 可访问 |
| 页面根 | `data-catalog-root="p4"` | 存在 |
| 收录指标数 | `data-catalog-item` | **44**（B1 11 + B2 20 + B3 13），`itemCountOk=true` |
| 四段口径 | `data-catalog-section` | formula / params / warmup / boundary，每卡 4 个 section 齐全 |
| B2 逐项四段断言 | 每个 `data-catalog-item` 的四个 `data-catalog-section` 均存在**且文本非空**，并与 manifest 对应字段交叉比对 | **20/20 全 pass**（`verification.catalog.cards` 逐项给出 `formula / params / warmup / boundary` 的 `ok` 与 `detail`，不是汇总计数） |
| 逐项字段口径 | 同上 | `params` 行数与 manifest `params` 条数相等（如 T08 `rows=2 expected=2`）；`warmup` 文本首值下标与 manifest `warmup` 相等（如 T08 `text="…下标 19（0 基）…" expected=19`）；`formula` 与 `boundary` 取正文比对关键词 |
| beta 徽标 | `data-catalog-beta` | **4** 个（T03 / T19 / T21 / T16，与 manifest `specStatus=partial` 逐项对应） |

页面是**应用内真实页面**（React 路由 + DOM 渲染），不是 Markdown 文档冒充；内容源为 `app/src/features/catalog/content.ts`，与 manifest 同源校对。

## 7. 证据文件与复跑命令

| 文件 | 内容 |
|---|---|
| [`evidence/s2-20261106/s2-evidence.json`](./evidence/s2-20261106/s2-evidence.json) | 完整诊断 payload（`generatedAt=2026-11-06T16:50:18.641Z`）：防抖两组、冷切 30 行、**回切 30 行（含 P50/P95/max）**、W/M、渲染层、**B2 8 卡 60 条 clause**、**B3 13 卡（含动态 `expect`）**、**catalog 44 项逐项四段**、遥测汇总 |
| [`evidence/s2-20261106/telemetry-excerpt.jsonl`](./evidence/s2-20261106/telemetry-excerpt.jsonl) | 610 条结构化事件压缩摘要（保留 `compute.count` / `cache.hit` / `cache.miss` / `indicator.cold_ms` / `compute.skip`）；为早期快照，**新数字以全量文件为准** |
| `~/Library/Application Support/aka/logs/telemetry.jsonl` | 全量遥测（102,200 行，跨多轮重跑累计） |
| `~/Library/Application Support/aka/diag/s2-evidence.json` | 应用落盘原始件（仓库内为拷贝） |

| 命令 | 作用 |
|---|---|
| `cargo test --workspace --exclude aka-desktop` | Rust 单测（含防抖、缓存键、聚合、遥测） |
| `cargo test -p indicator-golden -- --nocapture` | 黄金夹具 **193/193** case 对拍（输出 `golden: 193/193 passed`） |
| `cargo test -p indicator-core --lib b3::tests` | B3 指标单测（含 KDJ / %R 两分支、M25 三支 eps） |
| `cargo run -p indicator-golden --bin aka-bench --release` | 88 项性能基线（**44 指标 × 2 档**，B3 占 26 项） |
| `cargo test -p app-core microbench_breakdown -- --ignored --nocapture` | TD-S0-07 命中路径 8 段微基准 |
| `AKA_DIAG=1 npm run tauri dev` | 本报告全部实机证据的产出方式 |

---

## 8. 台账更新口径

- `TD-S0-06`：判据满足（P95 34ms ≤300ms、报价头 P95 15ms ≤60ms），`TD-S0-07`：安静机器连续 3 批 30 样本 max 48/58/40ms ≤120ms，逐点一致，均**改「已清偿」**（修订见 `aka-tech-debt-s0-v0.1.md`）。
- `TD-S0-04`：原判据 `1→12→120` 在本数据集不可观测；BA 已裁定修订为「当前最大合法档位（60）」（R-S0-04-01），按修订判据满足，且文档数字已同步至 `16:50:18.641Z` 批次，**状态行已改为「已清偿」**。
- **归属更正（避免误读）**：`T08–T16 / T23 / T24 / V01–V10 / M01–M26` 中 4 项状态为 `normal` 的裁定来自 **BA 正式裁定 Q-01~Q-04**（提交 `6551d9a`），不是本开发侧私自改判；`b3-beta-rulings.md` v0.2 勘误为 BA 提交（`ba0cbb8`），开发侧不持有其改动。
- `TD-B1-02 / 03`：证据已落地（B2 8 卡 60 条、catalog 44 项逐项四段、B3 13 卡动态 `expect`），但**「是否结项」不由开发判定**，交 BA / QA 复核（见 `aka-b1-card-reconciliation-v0.1.md`）。
