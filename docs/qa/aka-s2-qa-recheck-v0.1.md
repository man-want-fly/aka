# AKA S2 整改定点复核报告（QA）

- 复核对象：S2 整改 5 提交 `fcfbeb5` → `d6e0544` → `2e29c7d` → `950c0ae` → `2247e0d`
- 复核方式：**独立 git worktree 钉在 `2247e0d`**（`/tmp/aka-qa-2247e0d`），不触碰主工作区（S3 使用中）
- 复核环境：macOS / rustc 1.98.1 / Node v22.21.1（`tsc --noEmit && vite build`）
- 结论摘要：配色断言**真实可证伪**；T19 已修；V08@14 为独立重算；T16 已退回 beta；TD-S0-04 差一项证据挂接；P2 五项中 2 项未闭环。**无 P0**；共 2 项 P1、5 项 P2。

---

## 0. 取证方式与洁净性

| 项 | 说明 |
| --- | --- |
| worktree | `git worktree add --detach /tmp/aka-qa-2247e0d 2247e0d`，全程只在其中读写 |
| 回归 | `cargo test --workspace --exclude aka-desktop` → **88 passed**（app-core 17 / indicator-core 32 / data-provider 26 / data-store 8 / indicator-golden 5） |
| 黄金 | `cargo test -p indicator-golden` → **137/137 passed**，13 套夹具 |
| 前端 | `tsc --noEmit && vite build` → 通过（1.37s，48 modules） |
| 实机证据 | `~/Library/Application Support/aka/diag/s2-evidence.json`（22:33 生成）与仓库内 `docs/qa/evidence/s2-20261106/s2-evidence.json` 双向比对 |
| 配色 | 用 `tokens.css` 真实文件在无头 Chromium（`chrome-headless-shell`）中实跑 `getComputedStyle`，见 §1 |
| bench | 本轮无性能项，未跑；worktree `git status` 为空、`git diff` 为空 |
| 未改动 | 主工作区、开发台账、BA 卡、PRD 均未改；仅新增本报告 |

---

## 1. 配色断言是否真能证伪（P1-1 复核）

**判定：通过。断言取自实时计算值，不是抄常量。**

### 1.1 代码取证

- `diag.ts:108` `resolveColor()` 动态创建探针 `span`，设 `color: var(--pos)`，再 `getComputedStyle(probe).color` —— 取的是当前 DOM 解析后的实际值。
- `diag.ts:194-207` 取 `data-candle='up'|'down'` 的 `stroke`、`data-hist='pos'|'neg'` 的 `fill`、`data-readout='chg'` 的 `color`。
- `diag.ts:226-242` `colorOk` 的等式：K 线 stroke / MACD 柱 fill / 涨跌读数 color 是否分别等于**同一时刻解析出的** `--pos` / `--neg`。
- `diag.ts` 全文无 `rgb(`、无 `#e4483f`、无任何 16 进制色值 —— 不存在「期望值常量」。
- `CandleChart.tsx:217/281/306/402` 全部使用 `var(--pos)` / `var(--neg)`，未硬编码颜色。

### 1.2 实跑验证（独立于应用）

用仓库真实 `app/src/styles/tokens.css` + 一个只含 `stroke=var(--pos)` 的矩形，在无头 Chromium 中切换 `data-theme` × `data-colormode`：

| 组合 | `--pos` | `--neg` | K 线 stroke | MACD 负柱 fill | 读数 color |
| --- | --- | --- | --- | --- | --- |
| dark / redUp | rgb(228,72,63) | rgb(23,166,115) | 228,72,63 | 23,166,115 | 228,72,63 |
| dark / greenUp | rgb(23,166,115) | rgb(228,72,63) | 23,166,115 | 228,72,63 | 23,166,115 |
| light / redUp | rgb(200,52,43) | rgb(15,123,84) | 200,52,43 | 15,123,84 | 200,52,43 |
| light / greenUp | rgb(15,123,84) | rgb(200,52,43) | 15,123,84 | 200,52,43 | 15,123,84 |

- 四种组合**全部不同** → 采样随主题与红涨/绿涨切换而变化，断言验到了东西。
- 证据 JSON 的 `colorSamples`（`posToken=rgb(228, 72, 63)`、`negToken=rgb(23, 166, 115)`、`chgFirst=pos|…|▲ +2.74%`、`chgSecond=neg|…|▼ -9.98%`）与上表 dark/redUp 行**逐字一致**，说明实机采样确为该主题下的真实值。
- 若把 K 线 stroke 改成写死 `rgb(228,72,63)`，在 greenUp 下 `colorOk` 会立即为 false —— 断言具备证伪能力。

### 1.3 残留（P2）

- 一次运行只覆盖**一个**主题组合；断言本身不自带跨主题自检（需人工切主题再跑）。这不是缺陷，但「双向配色」只覆盖了 ▲/▼ 双向，未覆盖「深浅 × 红绿」四向。
- AC-03.04-05 要求「tooltip 与引擎输出逐根一致（误差 0）」，`diag.ts:218` 仍只校验两位小数格式，未与引擎值程序化比对（`maTooltip` 为文本快照）。**TD-B1-02 因此仍不能整条签认。**

---

## 2. TD-S0-04 分层证据

| 判据（R-S0-04-01 方案 A，端值 60） | 证据 | 复核 |
| --- | --- | --- |
| ① `requestsIssued = 1` | A 组 120：1；B 组 60：1 | **满足** |
| ② `compute.count` 增量 = 1 | B 组 `computeCountEvents=1`；A 组 `=0`（`INSUFFICIENT_DATA`） | **字面满足**，口径见下 |
| ③ 该条 `indicator.compute` 日志含 `code/period/adj/indicatorId/paramsHash/cacheKey/datasetId/barCount` | 裁定表写「`s2-evidence.json` debounce 段」 | **不满足（证据挂接错误）** |
| ④ 60 为当前最大合法档位 | `WorkbenchPage.tsx:49-51` 仅 `12/60/120`；TEMA N=120 需 540 > 520 | **满足** |

- **A 组不冒充计算**：`diag.ts:343` `passed: burst.length === 1`，A 组 `passed=true` 只代表请求数；`s2-qa-remediation-v0.1.md:17` 明写「不冒充计算证据」。上一轮的「判据 A / 证据 B」在此已纠正为「分层」。
- **B 组 seriesHash 可复算**：`1ccf8fcd` 在**两次独立实机运行**（证据 JSON `generatedAt` 13:41Z 与 14:33Z）完全相同；30 个冷标的哈希逐条一致，且 30 个标的哈希各不相同 —— 哈希是按序列值实时计算，非硬编码。
- ③ 的问题：`debounce` 采样的字段只有 `phase/security/timeframe/adj/barsMs/calcMs/totalMs/cacheHit/computedMs/barCount/seriesHash/seriesPoints`，**没有** `code/period/paramsHash/cacheKey/datasetId`。裁定表把这些字段写成 debounce 段证据，与实际 JSON 不符，属同类「证据挂接偏差」。
- 代码可证字段存在：`core.rs:257-304` 用 `telemetry_context()`（含 indicatorId / paramsHash / cacheKey / security / timeframe / adj / datasetId / datasetGeneration / barCount）拼装 `indicator.compute`；`telemetry.recent` 里 `cache.hit` 事件已带同构字段。但**没有一条 compute 事件原文留档**。
- ② 的口径弱点：`compute.count` 是**批次**计数（一次请求 +1，`instances`/`count` 另记），并不等于「指标只计算一次」；一次请求实际会 compute 12 个实例。判据按字面满足，但建议把 ② 改为 `indicator.compute` 增量或在裁定里注明为批次口径。

**判定：暂不能无条件判「已清偿」——差 ③。** 若补一条真实 `indicator.compute` 事件（含上述字段）或把裁定表证据改为「代码 + telemetry 事件字段」，可判已清偿。①②④ 已满足。

---

## 3. T19 公式修正

**判定：通过。**

- `content.ts:29` 已改为：`Forecast = a + b·(N−1)（当前根拟合值，不外推下一根）`，与 `kernels.rs` `slope * (n - 1.0)` 及单测一致。
- 全仓残留扫描（`app/`、`docs/`）中「下一根」仅出现在正确语境：`README:210`「不取下一根」、`b1-trend-kernels.md:58`「不取下一根」、卡 `S-03.04-02` 3C「不预测下一根」、口径页「不外推下一根」。**无旧写法残留。**
- 唯一含旧原文的是历史 QA 报告 `aka-s2-qa-report-v0.1.md` §4.1 的引用行（作为当时问题记录，不应改）。

---

## 4. V08 改 ATR14 后夹具

**判定：通过（期望值为新算，非旧值改标签）。**

- 新增 `V08 @ period=14` 共 3 个 case（base / edge_constant / edge_first_bar 各 1）。同键（period=20）的旧 case 期望值**一字未变**。
- 独立手算（Wilder ATR(14)，seed=SMA(TR[1..14])，首值下标 14；`GAPO=(O−C₋₁)/ATR×100`）与 base 夹具 520 点逐点比对：**0 处不一致**，首值位置 14 相符。
- 注：`gen_reference.py` 对 V08 走的是常规计算路径，未见字面量。

---

## 5. T16 是否退回 beta

**判定：通过。**

- `manifest`：`T16 specStatus=partial`、`status=beta`，notes 写「裁定 R-03 保留 beta；初始方向与首根 SAR 通达信/同花顺/TA-Lib 三家不一致」。
- 与 `b2-beta-rulings.md` R-03「T16 保留 beta」一致；其余 5 条（T13/T15/T23/T24/V08）为 `manualComplete`/`normal`，与 R-01/R-02/R-04/R-05/R-06 对应。
- 工作区漂移问题（上一轮 P1-4）已消除：8 张 B2 卡随 `fcfbeb5` 入库，`aka-b2-ac-evidence-v0.1.md` §3 已改为「B2 有卡」。

---

## 6. 数字对账（45 vs 88）

**结论：统计口径错误，非测试减少。**

- 实测仍为 **88 passed**，与上一轮一致；`#[test]`/`#[tokio::test]` 计数同为 88。
- 代码净改动 `aec810f..2247e0d`：`b2.rs` 7+/8−，无任何 `#[test]` 行被删除，无测试文件删除。
- `45` 恰好等于 **indicator-core 32 + data-store 8 + indicator-golden 5**，即三包之和；漏计 app-core 17 与 data-provider 26。属统计漏项。
- 黄金：**137/137**（上一轮 130，+7）；B2 case **83**（上一轮 76，+7 = below-min 4 + V08@14 3）。开发报「81 个 B2 case」偏少 2（仅按 4+1 计的漏项）。

---

## 7. P2 五项逐项

| 项 | 状态 | 证据 |
| --- | --- | --- |
| ① 1 根数据不足夹具 | **通过（附注）** | `edge_b2_below_min_window.json`：T16/T23/V10=`NaN`、V09=`1.0`；`V09=H−L=10.5−9.5=1.0` 与实现口径一致。**附注**：这 4 条期望值在 `gen_reference.py` 中是手写字面量（`NAN`/`1.0`），属「规格固化」而非独立参考实现复算，建议在夹具注释里标注这一性质 |
| ② M 周期文案 | **部分通过（P2）** | `diag.ts:566-567` 已改为「T02/T04/T05/M06 共 4 项不可算，T01/T03/T19/T20/T21/T22/E13 共 7 项可算」；但 `aka-s2-real-machine-evidence-v0.1.md:11` 与 `:142` 仍保留「11 个 B1 指标全部未达预热」的旧结论，未同步 |
| ③ `data-macd` hist | **通过** | `CandleChart.tsx:292 data-macd="hist"` + 每根 `data-hist=pos/neg`，fill 用 `var(--pos/--neg)`；diag 断言 `histCount>=2` 且正负 fill 与 token 相等 |
| ④ T21 两位小数 | **通过** | `IndicatorReadouts.tsx:80 toFixed(2)`；`diag.ts:220` 用严格正则 `R² [-+]?\d+\.\d{2}(?!\d)` |
| ⑤ 前端 MACD `max=200` | **部分通过（P2）** | `model.ts:62` signal 已 200；**`model.ts:60` fast 仍为 100**，manifest `M06.fast.max=200` → 仍未对齐 |

---

## 8. 越界检查

**判定：通过。**

- manifest 仍 31 条（B1 11 + B2 20），无 B3 指标；`git diff` 中无新增指标 id。
- 工作台 `model.ts`/`CandleChart.tsx` 未出现任何 B2 指标 id（T08–T16、T23/T24、V01–V05/V07–V10）；无 B2 的 UI。
- README `TD-B1-02/03` 仍写「已实现，待 BA 评估」，未自签结项。
- `fcfbeb5` 只改了 BA 卡/PRD/裁定文档与 manifest；`d6e0544`/`2247e0d` 只改前端；`2e29c7d` 只改夹具/参考实现。

---

## 9. 阻断项

### P0
无。

### P1（2）
1. **TD-S0-04 ③ 证据挂接错误**：裁定表把 `s2-evidence.json` debounce 段写成「含 code/period/paramsHash/cacheKey/datasetId」，实际该段无这些字段；无 compute 事件原文。①②④ 已满足，补证后可清偿。
2. **渲染层等值仍未自动化**：AC-03.04-05 要求 tooltip 与引擎逐根一致，`diag.ts` 仅校验两位小数格式；配色虽已闭环，`TD-B1-02` 仍不能整条签认。

### P2（5）
1. `IndicatorReadouts` / `model.ts:60` MACD `fast.max` 仍 100，manifest 为 200。
2. `aka-s2-real-machine-evidence-v0.1.md` §4 仍称「11 个 B1 全部未预热」，与已修正的运行时文案矛盾。
3. 证据文档未收录配色采样（§5 无配色行），配色证据只存在于 JSON 与整改说明。
4. `edge_b2_below_min_window` 4 条期望值为手写字面量，未标注「规格固化」性质。
5. 数字口径：`45`（应为 88）、`81 个 B2 case`（应为 83）两处统计错误，易误导验收。

### P3
- 一次实机运行只覆盖单一主题组合，配色跨主题需再跑一次才能覆盖四向。
- `compute.count` 为批次计数，② 的「只计算一次」表述建议澄清。

---

## 10. 判定汇总

| 条目 | 判定 |
| --- | --- |
| 配色断言 | **通过**（实测随主题/红绿切换变化，可证伪） |
| TD-S0-04 | **有条件不通过**：①②④ 满足、③ 证据挂接错误；补 1 条 compute 日志后可判**已清偿** |
| TD-B1-01 | **不可关闭**：AC-03.04-05（补1）仍 59 根文案 + 不停止画线；AC-03.04-11 仍 3/4（T21 只有读数，未进主图叠加，证据 §5 叠加仍为 T01/T02/T03/T04/T05/T19/T20/T22）；AC-03.04-15 仍无 BIAS 副图折线 |
| TD-B1-02 | **部分通过**：配色闭环；tooltip 等值仍人工；三条 AC 未整条签认 → 不可结项 |
| TD-B1-03 | **通过**：`#/catalog` 真实页面、11 项四段、beta 4 与 manifest 一致、T19 公式已修正 |
| V08 ATR14 | **通过**（独立重算 0 偏差，旧 20 值未动） |
| T16 beta | **通过**（partial/beta + R-03 notes） |
| P2 五项 | 3 通过、2 部分通过（MACD fast 上限、M 文案残留） |
| 越界 | **通过** |
| 数字对账 | 88 实测成立；45/81 为口径错误，无测试删减 |

---

## 11. 「抄期望值」排查结论

| 断言/夹具 | 是否抄期望值 | 依据 |
| --- | --- | --- |
| 配色 `colorOk` | **否** | `resolveColor` + `getComputedStyle` 实时取值；diag 无任何色值常量；四主题实跑值各异 |
| `seriesHash` | **否** | 两次独立运行一致、30 标的互异 |
| V08@14 期望 | **否** | 独立 Wilder ATR14 手算逐点一致 |
| `below_min_window` 4 条 | **是（规格固化）** | `gen_reference.py` 直接写字面量 `NAN`/`1.0`，非参考实现推导；V09=1.0 与 H−L 口径一致，可接受，但需注明性质 |
| 冷/热切换耗时 | **否** | 采样含逐标的真实耗时与哈希 |

---

## 12. 复现命令

```bash
git -C /Users/sixmillion/Documents/AKA worktree add --detach /tmp/aka-qa-2247e0d 2247e0d
cd /tmp/aka-qa-2247e0d/app
cargo test --workspace --exclude aka-desktop      # 88 passed
cargo test -p indicator-golden -- --nocapture     # golden: 137/137 passed
ln -s /Users/sixmillion/Documents/AKA/app/node_modules node_modules
PATH=/tmp/aka-node/bin:$PATH npm run build         # tsc --noEmit && vite build 通过
rm node_modules && rm -rf dist
```

配色探针：`/tmp/color-probe/index.html`（引用真实 `tokens.css`），用 `chrome-headless-shell --dump-dom` 读取四种主题组合的 `getComputedStyle`。
