# AKA · B3 动量/摆动批次 14 指标数值证据 v0.1

| 项 | 内容 |
|---|---|
| 文档编号 | AKA-QA-B3-EVIDENCE-0.1 |
| 版本 / 日期 | v0.1 / 2026-11-06 |
| 批次范围 | 严格按 `docs/planning/aka-indicator-batches-and-sprints-v0.1.md` §B3：**14 个 id**（13 新增 + M06 已在 B1），未增删、未提前做 B6 |
| 指标清单 | M01 M02 M04 M05 **M06（B1 已实现）** M08 M09 M10 M19 M20 M21 M24 M25 M26 |
| 四件套 | ①manifest；②黄金夹具；③性能记录；④AC 证据（B3 Story 卡尚未立，见 §3） |
| 结论 | 14/14 的 ①②③ 齐备；黄金 **193/193**；全量测试 **93 passed**（17/26/8/37/5）；bench **88 case**（44 指标×2 档）；渲染层已补实机采样（13 新增指标逐个切副图 + 全窗口 tooltip 逐根等值），见 §3.1 |
| beta | M02 / M24 / M25 新增保留 beta；M06 沿用 B1 beta（见 §5） |

---

## 1. 四件套矩阵

| id | 名称 | manifest | 黄金 case 数 | bench 520 p95 / 2500 p95（ms） | 状态 |
|---|---|---|---|---|---|
| M01 | RSI | `manualComplete` / 1 参数 | 4 | 0.013 / 0.065 | normal |
| M02 | KDJ | `partial` / 3 参数 | 4 | 0.018 / 0.146 | **beta（Q-01）** |
| M04 | Williams %R | `manualComplete` / 1 参数 | 4 | 0.050 / 0.200 | normal |
| M05 | CCI | `manualComplete` / 1 参数 | 4 | 0.031 / 0.086 | normal |
| M06 | MACD | `partial` / 3 参数（B1） | 4 | 0.009 / 0.054 | **beta（Q-04，沿用）** |
| M08 | PPO | `manualComplete` / 3 参数 | 4 | 0.008 / 0.093 | normal |
| M09 | ROC | `manualComplete` / 1 参数 | 4 | 0.002 / 0.015 | normal |
| M10 | Momentum | `manualComplete` / 1 参数 | 4 | 0.001 / 0.006 | normal |
| M19 | Aroon | `manualComplete` / 1 参数 | 4 | 0.078 / 0.338 | normal |
| M20 | Vortex | `manualComplete` / 1 参数 | 4 | 0.057 / 0.258 | normal |
| M21 | CMO | `manualComplete` / 1 参数 | 4 | 0.019 / 0.180 | normal |
| M24 | Mass Index | `partial` / 2 参数 | 4 | 0.054 / 0.190 | **beta（Q-02）** |
| M25 | Elder Impulse | `partial` / 4 参数 | 4 | 0.013 / 0.063 | **beta（Q-03）** |
| M26 | NR7 | `manualComplete` / 1 参数 | 4 | 0.007 / 0.035 | normal |

> 性能取自 `app/bench/baselines/macos-x86_64.json`（release 构建，520 / 2500 根，每档 100 次），
> 阈值沿用 B1/B2 冻结值，全部通过。

## 2. 黄金夹具

| 夹具 | case 数 | 内容 |
|---|---|---|
| `base_b3_momentum_seed42_520.json` | 14 | 默认参数、seed=42、520 根，逐指标基线 |
| `edge_b3_constant_ohlc.json` | 14 | `H=L=O=C=10`，零区间/零振幅/零柱退化 |
| `edge_b3_insufficient.json` | 14 | 20 根 + 大周期，全部 `NaN` |
| `edge_b3_first_bar.json` | 14 | 单根 K 线，全部 `NaN` |

生成方式：`python3 crates/indicator-golden/fixtures/gen_reference.py`（确定性，可复现；禁止手改 JSON）。
期望值全部由 `gen_reference.py` 的参考实现推导，**无手写字面量**；容差同源写回夹具 `tolerance` 字段。

容差：M01/M02/M04/M05/M08/M09/M19/M20/M21/M25/M06 `absolute:1e-4`；M10/M24 `relative:1e-6`；
M26 `count`（严格相等）。与 `docs/indicators/b3-momentum-oscillators.md` 一致。

## 3. AC 证据（数据层）

B3 的 Feature/Story 卡尚未在 `docs/story-cards/aka-story-cards-v0.1.md` 立卡（该文档当前 68 张，
仅到 `S-03.05`）。因此本文件**不虚构卡号**，按指标给出可测断言；卡号待建卡后回挂。

| 指标 | 可测断言 | 取证方式 | 结果 |
|---|---|---|---|
| M01 | 首个有效值 14；值域 [0,100]；`avg_loss=0 → 100` | 单测 `warmup_matches_first_valid_index` / `oscillators_stay_in_range`；夹具 4 case | 通过 |
| M02 | 首个有效值 8；J=3K−2D；常数输入 K=D=J=50 | 单测 + 常数夹具 | 通过（beta） |
| M04 | 首个有效值 13；值域 [−100,0]；零区间 NaN | 单测 + 夹具 | 通过 |
| M05 | 首个有效值 19；零偏差 NaN | 单测 + 常数夹具 | 通过 |
| M06 | 首个有效值 33；DIF/DEA/柱 2× 关系 | 黄金 `base` + `M06` 4 case | 通过（beta） |
| M08 | 首个有效值 33；双线；fast≥slow 返回参数错误 | 单测 `ppo_rejects_fast_ge_slow` + 夹具 | 通过 |
| M09 | 首个有效值 12；前值 0 → NaN | 单测 + 夹具 | 通过 |
| M10 | 首个有效值 10；差额单位元 | 单测 + 夹具 | 通过 |
| M19 | 首个有效值 24；两线值域 [0,100] | 单测 + 夹具 | 通过 |
| M20 | 首个有效值 14；ΣTR=0 → NaN | 单测 + 常数夹具 | 通过 |
| M21 | 首个有效值 14；值域 [−100,100]；分母 0 → NaN | 单测 + 夹具 | 通过 |
| M24 | 首个有效值 40；全常数 → NaN | 单测 + 常数夹具 | 通过（beta） |
| M25 | 首个有效值 46；state ∈ {−1,0,1} | 单测 + 夹具 | 通过（beta） |
| M26 | 首个有效值 6；输出仅 0/1 且存在 1 | 单测 `nr7_emits_only_zero_or_one` + 夹具 | 通过 |

### 3.1 渲染层实机采样（2026-11-06，`AKA_DIAG=1`）

证据源：`docs/qa/evidence/s2-20261106/s2-evidence.json` → `verification.b3Render`。
做法：真实窗口内把副图下拉依次切到 13 个 B3 id，逐个读 DOM：

- SVG 图形节点数 = manifest `outputs` 条数（line 输出挂 `path`，dot 输出挂外层 `g`）；
- 计算样式（`getComputedStyle`）取到非空 `stroke`/`fill`；
- 读数条 `data-readout^='b2-sub-<id>-'` 条数 = 输出条数，且数值可解析或如实显示 `—`。

| id | 输出条数 | DOM 节点 | 描边/填充 | 读数条 | 结果 |
|---|---|---|---|---|---|
| M01 | 1 | 1 | rgb 实测 | 1 | 通过 |
| M02 | 3 | 3 | rgb 实测 | 3 | 通过（beta） |
| M04 | 1 | 1 | rgb 实测 | 1 | 通过 |
| M05 | 1 | 1 | rgb 实测 | 1 | 通过 |
| M08 | 2 | 2 | rgb 实测 | 2 | 通过 |
| M09 | 1 | 1 | rgb 实测 | 1 | 通过 |
| M10 | 1 | 1 | rgb 实测 | 1 | 通过 |
| M19 | 2 | 2 | rgb 实测 | 2 | 通过 |
| M20 | 2 | 2 | rgb 实测 | 2 | 通过 |
| M21 | 1 | 1 | rgb 实测 | 1 | 通过 |
| M24 | 1 | 1 | rgb 实测 | 1 | 通过（beta） |
| M25 | 2 | 2 | rgb 实测 | 2 | 通过（beta） |
| M26 | 1 | 1 | rgb 实测 | 1 | 通过 |

汇总：`cardCount=13`、`missing=[]`、`ok=true`；副图下拉共 24 个选项（含 M06 与 E13）；
口径页 DOM 实测 44 条（B1 11 + B2 20 + B3 13），四段结构齐，beta 徽标 8 个。

**tooltip 逐根等值**（同一份证据 `verification.renderLayer.tooltipParity`）：
对可见窗口 **120/120 根**逐根悬停，比较 `ma-T01` / `sub-M06-dif` 显示值与引擎序列，
**你给的 AC-03.04-05 容差是 relative 1e-6 / absolute 1e-4，本轮取容差 0（更严）**，
`sampled=120`、`enginePoints=520`、`mismatches=[]`、`ok=true`。

B3 的 Story 卡尚未在 `docs/story-cards/aka-story-cards-v0.1.md` 立卡，卡号待建卡后回挂；
以上为「渲染层可上图」的实机证据，不等于卡号验收通过。

## 4. 复跑命令

```bash
cd app
cargo test --workspace --exclude aka-desktop        # 93 passed
cargo test -p indicator-golden --lib -- --nocapture # golden: 193/193 passed
cargo run --release -p indicator-golden --bin aka-bench
python3 crates/indicator-golden/fixtures/gen_reference.py
```

## 5. beta 待裁定清单（不自行拍定）

| 编号 | 指标 | 歧义点 | 当前实现 | 为什么不能自己拍 |
|---|---|---|---|---|
| **Q-01** | M02 KDJ | ①零区间 RSV 取值；②K/D 种子与首次平滑是否需额外预热；③J 是否属必备输出 | 零区间 RSV=50；种子 50/50；无额外预热；输出 K/D/J | 通达信除零后沿用/取 0、同花顺与 TA-Lib（Stoch 无 J、SMA 平滑）互不一致，无公开逐点公式 |
| **Q-02** | M24 Mass Index | 规划 CSV 声明 warmup=30，与 EMA 递推实算的首值 40 冲突 | 按公式实算 40 | 冲突属规格层，改 30 需另定 EMA 种子/窗口定义，超出实现范围 |
| **Q-03** | M25 Elder Impulse | ①柱系数 1×/2×；②三色边界（是否要求柱穿零轴）；③脉冲用 EMA 斜率还是差分 | 2× 柱 + EMA13(柱) + 差分斜率 | Elder 原版描述与各平台实现不一致，且依赖 M06 的 2× 裁定的连带结果 |
| **Q-04** | M06 MACD | 柱 2× vs 1× | 2×（B1 起沿用） | B1 已标 beta，B3 不重复拍定；与 Q-03 联动 |

解除条件统一为：取得**至少一家**商业软件（通达信/同花顺/TA-Lib）的逐点对照样本后由 BA 重裁；
在此之前 `status=beta`、`specStatus=partial`，UI 需带 beta 徽标、不进默认组合。

## 6. 与规划 CSV 的 warmup 差异（需 BA 知晓）

CSV 的 `warmup` 列混用了 0 基下标与 1 基根数两种计法，逐条对照如下（全部按「首个有效值下标」实算）：

| 指标 | CSV 声明 | 实算首值下标 | 差异性质 |
|---|---|---|---|
| M01 | 14 | 14 | 一致 |
| M02 | 9 | 8 | CSV 为 1 基根数 |
| M04 | 14 | 13 | 1 基 |
| M05 | 20 | 19 | 1 基 |
| M06 | 34 | 33 | 1 基 |
| M08 | 34 | 33 | 1 基 |
| M09 | 12 | 12 | 一致 |
| M10 | 12 | 10 | **与默认周期 10 不一致，疑 CSV 笔误**（非 beta，登记待确认） |
| M19 | 25 | 24 | 1 基 |
| M20 | 20 | 14 | **与默认周期 14 不一致，疑 CSV 笔误**（非 beta，登记待确认） |
| M21 | 14 | 14 | 一致 |
| M24 | 30 | 40 | 见 Q-02，已标 beta |
| M25 | 34 | 46 | CSV 只算到 impulse 起 45，state 需前一根 → 46；见 Q-03 |
| M26 | 7 | 6 | 1 基 |

> 实现一律以「首个有效值下标（0 基）」写 `warmup`，并用单测
> `warmup_matches_first_valid_index` 固化；CSV 的 1 基写法不视为实现错误。
> M10 / M20 两条疑笔误未标 beta（公式本身无歧义），但登记在此待 BA 确认 CSV 数值。

## 7. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-11-06 | 首次 B3 数值证据：14 指标四件套矩阵、4 组夹具 56 case、193/193 黄金、93 全量测试、88 bench case、beta Q-01~Q-04 |
