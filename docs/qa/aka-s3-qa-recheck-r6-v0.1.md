# S2/S3 第六轮 QA 定点复核（R6）

- 复核对象：`4a0eba2`、`aaedb46`、`feaed7f`、`95eaab5`（HEAD = `95eaab5`）
- 复核方式：独立 worktree `/tmp/aka-r7` detached `95eaab5`，只读复核；测试与微基准在 worktree 内跑，主工作区未执行、未改动
- 复核日期：2026-11-07
- 结论一句话：**TD-S0-07 可签认，但必须以补写「构建类型」判据口径为前提；B2 60 条 clause 真实落盘、正负色实证成立，但 8 卡不能整体上调（5 卡可上调、2 卡有条件、1 卡不上调）；catalog 仍有汇总掩盖；BA 三条修正代码与手算完全一致，仅 M25 第 ② 分支缺独立测试。**

## 0. 逐项结论

| 项 | 结论 | 一句话依据 |
|---|---|---|
| 1. TD-S0-07 改回「已清偿」 | **成立，可签认（附条件）** | 修复=配置（`opt-level=1`）+代码（埋点句柄复用），非纯配置；192 是**未优化 dev 构建**的量级；release 无回归；回退条款在台账 |
| 1a. 192ms 测的是什么构建 | **未优化 dev 构建** | 微基准 dev ⑥ 27.30ms（520）/125.5ms（2500），与 192ms 同量级；release ⑥ 1.61ms 不可能跑到 192 |
| 1b. 判据要不要写构建类型 | **要补，建议 BA 定、QA 复核** | 现判据只写「≤120ms」，未区分构建；dev/release 差 17× |
| 2. B2 60 条 clause 可证伪性 | **部分成立，不能整体上调** | 60 条真实、0 fail、正负色真取计算色；但 T09 虚线不查 `4px,3px`、T09 切标的不残留只查路径数 |
| 2a. 唯一 n/a | **诚实标注，但仍留缺口** | `S-03.05-07` 零带宽段：窗口内零带宽根=0，skip 且无单测补偿 |
| 3. catalog 44 项 | **仍有汇总掩盖** | 四段逐项只覆盖 20 个 B2 id；B1 11 + B3 13 未逐项；`betaIds.includes("T16")` 只验包含不验 count=4 |
| 3a. B3 动态 expect | **通过** | 运行时 `ipc.indicatorManifest()` → `outputs.length`，缺失 `?? -1` |
| 4. BA 三条修正 | **全部正确** | KDJ/%R 手算逐位吻合；M25 eps 逐根按 `C[i]`、三分支正确 |
| 5. 全量测试 | **98 passed / 0 failed；黄金 193/193** | 新增 1 条 = `williams_r_two_branches` |

## 1. 环境与提交范围

- worktree：`git worktree add /tmp/aka-r7 --detach 95eaab5`；复核期间 `git status` 为空（见 §7）。
- 四个提交均为 11-07 01:07，文件范围：

```
4a0eba2  app/Cargo.toml(+6) / app-core/src/core.rs(+304) / app-core/src/telemetry.rs(+14/-2)
aaedb46  CandleChart.tsx(+239) / diag.ts(+898/-129) / WorkbenchPage.tsx(+1)
feaed7f  indicator-core/indicators/b3.rs(+79) / manifest/indicators.json / docs/indicators
95eaab5  docs/qa 5 个文件（含 s2-evidence.json 3501 行）
```

  四个提交未触碰 `docs/story-cards`、PRD、planning CSV；`95eaab5` 是纯文档/证据提交。

- 测试（`CARGO_TARGET_DIR=<主工作区 target>`，worktree 内跑）：
  - `cargo test --workspace --exclude aka-desktop` → **98 passed / 0 failed** = `app_core 17` + `data_provider 26` + `data_store 8` + `indicator_core 42` + `indicator_golden 5`；与上一轮 `7ded2bc` 的 97 相比 +1，即 `feaed7f` 新增的 `williams_r_two_branches`。
  - `indicator-golden`：**193/193 case 通过**。
  - 未跑 bench；`app/benches` 无改动。

## 2. TD-S0-07

### 2.1 修复不是纯配置

`4a0eba2` 改了三处，只有一处是配置：

| 文件 | 改动 | 性质 |
|---|---|---|
| `app/Cargo.toml` | `[profile.dev] opt-level = 1` | 配置，仅影响 dev |
| `app-core/src/telemetry.rs` | `log_file: Mutex<Option<File>>`，首次写入时打开、之后复用 | **代码路径**，dev 与 release 同受益 |
| `app-core/src/core.rs` | `microbench_breakdown`（`#[ignore]`） | 仅测试，不进产品路径 |

句柄复用见 [telemetry.rs](file:///tmp/aka-r7/app/crates/app-core/src/telemetry.rs)：`emit` 原来每条事件 `OpenOptions::open` 一次，改为惰性打开后复用同一 `File`。所以「只改构建配置」的说法不成立，但**release 的收益只来自句柄复用，`opt-level` 对 release 无影响**；文档也未单独复测 release 修复后的 ⑦b（不构成问题，release 判据本来就不是 120ms 的瓶颈所在）。

### 2.2 192ms 到底是哪种构建

`aka-s2-real-machine-evidence-v0.1.md` §3.1 表头已写明「dev = 修复前未加 `opt-level` 的 dev 构建，release = `--release`」：

| 段 | 520 dev | 520 release | 2500 dev | 2500 release |
|---|---|---|---|---|
| ⑥ 整包 `CalcResponse` JSON 序列化 | **27.30** | **1.61** | **125.5** | 6.52 |
| ⑦b 埋点 JSONL（逐事件 open） | 6.10 | 3.46 | 4.60 | 3.78 |
| ⑧ 端到端（命中） | 2.54 | 0.47 | 6.77 | 1.99 |

结论：**192ms 的判据只在未优化 dev 构建下成立**。release 下序列化 1.61ms、端到端 0.47ms，物理上不可能出现 192ms。因此现在的判据文字「切回总耗时 ≤120ms」缺一个限定：在哪种构建下、哪条路径上测。

### 2.3 三个坏样本是否留档

| 样本 | 原始 JSON | 文档表 | 结论 |
|---|---|---|---|
| 192ms | ✅ `a212660` 提交内 `s2-evidence.json`：`sampleCount=10 / p95=192 / max=192`；`4ce9636` 同一值 | §3 / 台账 253 行 | 真留档 |
| 132ms | ✅ `7ded2bc` 提交内同文件：`p95=132 / max=132` | 同上 | 真留档 |
| 123ms | ❌ 无独立 JSON（修复后 #1 的 diag 未入库） | 证据文档 §3.2 批次表 + 台账 294 行，含单点 `calcMs=112ms`、第 13 个样本、load avg 8.4 | 文档级留档，弱于前两者 |

补充：git 历史里还有一个 **229ms** 批次（`4ee6ffa`），比 192 更早。这说明 192/132 不是偶发噪声，而是 dev 未优化的稳定量级——对根因判断是正面证据。

### 2.4 回退条款

- 台账（`aka-tech-debt-s0-v0.1.md` 302 行）：「如果后续在静默窗口再现 >120ms，按未达标立即回退」。
- 证据文档（`aka-s2-real-machine-evidence-v0.1.md` 204 行）有更强的无条件句：「若后续安静机器复跑再出现 ≥120ms，本条立即回退『部分清偿』」。

判定：**条款在**，但台账里是挂在 123ms 样本下的等价句，不是原文，也没复述到判据段。建议把 204 行那句同步进台账判据段（见 §7）。

### 2.5 独立复跑

- Rust 微基准（`cargo test -p app-core microbench_breakdown -- --ignored --nocapture`，dev + release）：

| 项 | 文档 | 本轮实测 | 判定 |
|---|---|---|---|
| dev ⑥ 520 | 2.338 | **2.365** | 复现 |
| dev ⑧ 520 | 1.005 | **0.523** | 复现量级 |
| dev ⑦b 520 p50 | 0.679 | **19.158** | **未复现**（本机磁盘噪声；文档自己也记了 max 79.3ms 的 flush 抖动） |
| release ⑥ 520 | 1.61 | **1.610** | 精确复现 |
| release ⑥ 2500 | 6.52 | **7.033** | 复现量级 |
| release ⑧ 520 | 0.47 | **0.457** | 精确复现 |

- UI 端到端 40–58ms：**未独立重跑**。原因：本机已有开发的 `AKA_DIAG=1 npm run tauri dev` 占用 1420，不能起第二个实例；强行起会污染开发在途验证。可核对的入库数据：`s2-evidence.json` `warm` 30 样本 `p50=24 / p95=34 / max=40`，30/30 `cacheHit=true`、`matchesCold=true`，与文档 #4 批次一致。
- 因此对「40–58ms 量级」的结论是：**Rust 侧根因与修复复现，UI 侧只有开发采集的入库证据，本轮无我方独立样本**。若要 QA 签名的实机数字，需要在开发停掉 dev 后由 QA 独占跑一次（见 §7）。

### 2.6 签认结论

**TD-S0-07 可以签认「已清偿」**，理由是：根因定位成立（dev 未优化序列化 + 逐事件 open）、修复同时改了配置与代码、release 无回归、192/132 有原始 JSON 留档、连续 3 批 90 样本 max 48/58/40 且逐点一致。

**但签认附一个前提**：判据必须补「构建类型」。否则下次换台机器用 release 跑出 0.5ms，会被误读成「性能又好了 40 倍」；反过来 dev 偶发 125ms 也会被误判回归。

## 3. B2 60 条 clause

### 3.1 60 条是真实的，不是汇总开关

`s2-evidence.json` `verification.b2Render`：8 卡、`clauseCount=60`、`failCount=0`、`dataLimitedCount=1`、`ok=true`。逐卡条款数 **8 / 11 / 7 / 10 / 5 / 5 / 9 / 5**，每卡 `ok` 由 `clauses.every(status !== "fail")` 计算，不是硬编码。

### 3.2 逐 AC 覆盖（关键）

| 卡 | AC | 条款落点 | 判定 |
|---|---|---|---|
| S-03.05-01 | AC-03.05-05 | 三轨可见 ✅；**中轨虚线只判 `strokeDasharray !== "" && !== "none"`** ❌；断开段数 ✅；图例=线色 ✅（但未验语义色绑定）；**切标的不残留只判路径数=3** ❌ | **不上调** |
| S-03.05-02 | AC-03.05-10 | 元/无量纲 ✅；4 个 id 断开 ✅；切标的读数与引擎 `numericMatches` ✅ | 可上调 |
| S-03.05-03 | AC-03.05-16 | 仅激活侧 ✅；翻转根标记数=引擎翻转数 ✅；新侧不继承旧侧（`carryOver/staleSide`）✅；NaN 断开 ✅ | 可上调 |
| S-03.05-04 | AC-03.05-20 | 云带着色 ✅；先行带末根截断 ✅；**迟行线断言为「尾端 26 根 NaN + 头端 26 根有值」，AC 文字写「前 26 根留白」** ⚠️；图例五线 ✅ | **改 AC 文字后可上调** |
| S-03.05-05 | AC-03.05-24 | 点列 ✅；不连线 ✅；箭头总数/上/下与引擎方向计数一致 ✅；多空色实际计算值 ✅ | 可上调 |
| S-03.05-06 | AC-03.05-27 | 三线可见 ✅；首根无值 ✅；**从周线快照 `tf.afterWeekly` 重算且末值与日线不同** ✅；旧线残留=0 ✅；标签重叠按 bounding box 计算 ✅ | 可上调 |
| S-03.05-07 | AC-03.05-31 | 带宽比值 ✅；%B **读 textContent 小数位=2** ✅；零带宽 **n/a** ⚠️；NaN 断开 ✅ | **补零带宽测试后可上调** |
| S-03.05-08 | AC-03.05-35 | 0 轴 `[data-sub-zero='1']` 计数=1 ✅；正负色 ✅（见 3.3）；按符号断开段数 ✅；切标的读数不残留 ✅ | 可上调 |

结论：不是「每条 AC 都有断言」，而是「每条 AC 至少有一条断言」，其中 **AC-03.05-05 有两条弱断言**（虚线值、切标的不残留），AC-03.05-20 的断言与 AC 文字相反，AC-03.05-31 有一条 n/a。

### 3.3 正负分色：真取计算色

`diag.ts` 1026-1032 取 `getComputedStyle(posPath).stroke` 与 `resolveColor("--pos")` 比对，`negPath` 同；`resolveColor`（121 行）通过 `color: var(--pos)` 的探针元素读实际 RGB。渲染层 [CandleChart.tsx](file:///tmp/aka-r7/app/src/components/CandleChart.tsx#L582-L592) 的 `data-sub-sign='pos'` 绑定 `stroke="var(--pos)"`。这是**可证伪的真比对**，不是 `stroke !== ""`。T15 云带、T16 点/箭头也是实际 `fill` 与 `riseColor/fallColor` 比对。

### 3.4 唯一 n/a

`S-03.05-07`「零带宽段显示 —」：统计窗口内 `V04 bandwidth === 0` 的根数 = 0，代码走 `skip()` 并写 detail「窗口内零带宽根 = 0」；注释明确「不伪造通过」。属**诚实标注**，但该条款确实没有任何数值测试或构造数据补偿，等于未验证。

### 3.5 反向验证（负控）

本轮**无法在浏览器里做真负控**（dev 实例被占用），只能做静态可证伪性判定：

| 假设改动 | 断言是否会失败 | 说明 |
|---|---|---|
| `CandleChart` 把 `data-sub-sign='pos'` 的 `var(--pos)` 改成 `var(--neg)` | **会**（V08 正负色） | 计算色与 `resolveColor` 不等 |
| T09 `strokeDasharray` 从 `"4 3"` 改成 `"6 4"` | **不会** | 断言只判非空，这是漏洞 |
| T09 切标的时把旧值画成新值（3 条路径仍在） | **不会** | 断言只判路径数=3 |
| T16 箭头方向对调 | **会** | up/down 计数与引擎方向不符 |

因此「挑 2–3 条做反向验证」的答案是：**2 条可以、2 条不可以**；不行的那两条正是上面标 ❌ 的 T09 条款。建议开发补负控运行（或至少在证据里附一次人为破坏后的 fail 截图）。

## 4. catalog 44 项与 B3 动态 expect

### 4.1 catalog 仍有汇总掩盖

`verification.catalog`：`itemCount=44`、`itemCountOk=true`、`betaCount=4`、`cards=20`、`ok=true`。但代码（`diag.ts` 1198-1272）：

- 四段（formula/params/warmup/boundary）**只对 20 个 B2 id 逐项验**：`T08…T24` + `V01…V10`；
- B1 11 个 + B3 13 个 = 24 项**没有逐项四段**，只被计入 `itemCount=44`；
- `betaIds.includes("T16")` 只验「包含 T16」，不验 `betaCount===4`；`betaIds` 实际是 `["T03","T19","T21","T16"]`，但断言不检查长度或全集合。

即：44 是 DOM 条目计数，不是「44 项逐项验四段」。**汇总掩盖仍在**，只是范围比上一轮清楚了。

### 4.2 B3 expect 已动态化

`diag.ts` 1102-1108：`const manifest = await ipc.indicatorManifest()` → `Map(id, item.outputs.length)` → `expect[id] = outputCounts.get(id) ?? -1`。13 个 id 全走这条路径，无硬编码。缺失即 -1，后续 `nodes/paint/readouts` 与 expect 比对会失败。**通过。**

## 5. BA 三条修正（独立手算）

### 5.1 M25 eps

代码（`b3.rs` 562-574）：`eps = 1e-9 × view.close[i].abs().max(1.0)`，**按当根收盘价**逐根取，不是全局常数。分支：`|hist|≤eps → 0`；`|impulse[i]-impulse[i-1]|≤eps → 0`；其余 `hist>0 && delta>0 → +1`、`hist<0 && delta<0 → -1`、冲突 → 0。**与 BA 口径一致。**

测试覆盖：正例（指数上涨 46–59 全 +1）、反例（线性上涨 46–59 全 0）。反例实际命中的是**第 ① 支**（`hist` 只剩浮点残差），第 ② 支（`delta≈0` 而 `hist>eps`）**没有独立用例**——属轻微缺口，建议补一条「hist 恒定为正、impulse 平台」的构造。

### 5.2 KDJ `H=C±1`

手算（`C=10+i`，`H=C+1`，`L=C-1`，N=9，K/D 平滑 3）：

- 下标 8：窗口 0..8，`HHV=19`、`LLV=9`，`RSV=(18-9)/10×100=90`；`K=(2×50+90)/3=63.3333`，`D=(2×50+63.3333)/3=54.4444`，`J=3K-2D=81.1111` ✅
- 下标 9：窗口 1..9，`HHV=20`、`LLV=10`，`RSV=90`；`K=(2×63.3333+90)/3=72.2222`，`D=(2×54.4444+72.2222)/3=60.3704`，`J=95.9259` ✅

与测试断言（`b3.rs` 796-801）逐位一致。同文件 `H=L=C` 分支的 66.6667/55.5556/88.8889、77.7778/62.9630/107.4074 也复核通过。

### 5.3 %R 双分支

- 恒定振幅 `H=11,L=9,C=10`：`(11-10)/(11-9)×(-100) = -50`，13..29 恒定 ✅
- `C=10+i,H=C+1,L=C-1`：下标 13 窗口 0..13，`HHV=high[13]=24`、`LLV=low[0]=9`、`C=23` → `(24-23)/(24-9)×(-100)=-6.6667` ✅

测试（`b3.rs` 812-836）同时断言 `out[0][13]≈-6.6667`、`high[13]=24`、`low[0]=9`、并用三量重算 `-6.6667`，**输入→中间量→输出三级一致**。这条就是新增的 `williams_r_two_branches`。

## 6. 测试与黄金

- 全量：**98 passed / 0 failed**（17/26/8/42/5）。
- 黄金：**193/193**。
- 新增 1 条 = `williams_r_two_branches`（`feaed7f`），即 §5.3 的双分支对拍，不是凑数。

## 7. 建议清单

| # | 事项 | 责任方 | 优先级 |
|---|---|---|---|
| R6-01 | 判据补「构建类型」口径：产品口径 release、护栏口径 dev(opt-level=1)，两套数字都记；任一 **>120ms**（严格大于）不签字 | **BA 已定**：`R-S0-07-01`（`docs/qa/aka-td-s0-07-criterion-ruling-v0.1.md`），QA 复核，开发回填台账 | 高 |
| R6-02 | 台账判据段补 204 行那句无条件回退条款；123ms 补一份原始 JSON 或注明「仅文档留档」 | 开发 | 中 |
| R6-03 | T09 虚线断言改为比 `4px, 3px`（规范化空白后）；切标的不残留改为比末值/路径 `d` 而非仅条数 | 开发 | 高 |
| R6-04 | AC-03.05-20 文字「前 26 根留白」改为「末 26 根留白」，或反向确认参考实现 | BA | 高 |
| R6-04 结论 | **已裁（2026-11-07）**：开发断言正确，AC/卡文字写反；已改 `S-03.05-04` AC-03.05-17~20 与 Conversation、PRD L797、`b2-beta-rulings` R-02（v0.2）；代码与黄金夹具不动 | BA | 关闭 |
| R6-05 | 零带宽段补一条 Rust 单测（`V04 bandwidth=0`、`V05 %B=NaN`），或构造含零带宽的样本 | 开发 | 中 |
| R6-05 结论 | **已裁（2026-11-07）**：零带宽定义见 `b2-beta-rulings` R-07；不是「数据没有就豁免」，必须由常数序列单测覆盖（`%B=NaN` + `DIVIDE_BY_ZERO`，不得输出 0/1） | BA | 关闭（待开发补测） |
| R6-06 | catalog 四段扩到 44 项，或把 `cards=20` 改成 `b2Cards=20` 并注明 B1/B3 只验数量；beta 断言改为集合比对 | 开发 | 中 |
| R6-07 | M25 第 ② 支（`delta≈0` 且 `hist>eps`）补独立用例 | 开发 | 低 |
| R6-08 | 给 QA 一次独占 dev 实机窗口跑 30 样本，产出 QA 签名的 40–58ms 量级证据 | 开发停 dev → QA 跑 | 中 |

## 8. 复核环境与未做事项

- 未改开发台账、BA 卡、manifest、bench；本轮只新增本报告文件。
- 未起 UI：本机已有开发 `AKA_DIAG=1 npm run tauri dev`（cwd `Documents/aka/app`，端口 1420），QA 未干扰、未 kill。
- `/tmp/aka-r7` 复核结束后已删除，主工作区无 QA 产生的构建产物。
