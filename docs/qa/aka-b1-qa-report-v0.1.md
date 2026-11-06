# AKA · B1 底座批次 QA 核对报告（v0.1）

> **核对对象**：`/Users/sixmillion/Documents/aka`，提交 `2ff5266`（`main`，核对时 HEAD）。
> **核对日期**：2026-11-06。
> **QA 边界**：只读核验；未修改业务代码、PRD、Story 卡。性能基线文件在跑测后被还原，`git diff` 为空。
> **核对环境**：macOS 26.7.1（25G241）/ `x86_64-apple-darwin` / Intel Core i7-9750H @ 2.60GHz / rustc 1.98.1 (48a229cea 2026-09-01) / 官方 Node v22.21.1 / npm 10.9.4。

## 0. 总结论

**B1 数值底座在代码层可以接受**：本地 `cargo check`、56 个测试、黄金 40/40、官方 Node 下的前端构建、11 指标 × 2 规模的 bench 全部通过；未发现指标算法错误或越界实现。

**但“按 Story 卡验收”的口径不成立**：README 把 T01/T02/T03 指向 `S-02.05-01 / AC-02.05-01`、把 M06 指向 `S-02.03-01 / AC-02.03-03（补2）` 与 `S-03.03-01 / AC-03.03-01`，这些 AC 都是 `[渲染层]` 的 UI/页面验收，而提供的证据全部是 Rust 数值测试与黄金夹具；`S-03.03-01` 的 P4 口径页在本提交中根本不存在。**测试真实存在且指向具体用例，但不能证明所挂的 AC。**

因此：
- **B1 数值底座**：通过（无代码级阻断）。
- **B1 按卡结项**：不通过（P1 证据链问题），需先修正验收表述或补齐渲染层证据。
- **7 个指标无卡**：属实；但 README 称其“属技术债”，这 7 项并未登记进 9 条 S0 技术债台账，属于台账缺口。

## 1. 逐项结论表

| # | 核对项 | 结论 | 关键证据 | 阻断级别 |
|---|---|---|---|---|
| 1 | 可复现性 | **通过** | `cargo check` 0 告警；workspace 56/56；golden 40/40；官方 Node 构建退出 0 | 无 |
| 2 | manifest 一致性 | **通过**（附 P2/P3 观察） | 11 条、9 项逻辑字段齐全、alias 唯一、默认值均在界内、beta 名单一致 | 无 |
| 3 | 正确性证据强度 | **通过**（附条件） | 4 类边界均在；T19/T21 只证明“自定口径自洽”，beta 标记正确 | 无 |
| 4 | Story 卡对账 | **不通过** | T01/T02/T03/M06 的 AC 为渲染层，现有证据不覆盖；7 项无卡属实 | **P1** |
| 5 | 性能基线 | **通过** | 22/22 pass；同机同 rustc；p95 最大偏差 0.070ms，远低于阈值 | 无 |
| 6 | 技术债状态 | **通过**（附 1 条台账缺口） | 9 条全部“未清偿”，合计 3.5 人日；无“已清偿/已通过”暗示 | 无（缺口 P2） |
| 7 | 越界检查 | **通过** | 注册表仅 11 指标；无 B2 指标；前端仅工作台可用；无账户/支付/网络请求 | 无 |

## 2. 可复现性（QA 实跑）

执行目录：`app/`。命令与真实结果：

| 命令 | 结果 | 说明 |
|---|---|---|
| `cargo check --workspace --all-targets` | **退出 0**，0 warning | dev profile，4.00s |
| `cargo test --workspace --exclude aka-desktop` | **56 passed / 0 failed** | 8(app-core)+10(data-provider)+8(data-store)+26(indicator-core)+4(golden) |
| `cargo test -p indicator-golden -- --nocapture` | **4 passed**；输出 `golden: 40/40 passed` | 40 个 case 的分布见 §4 |
| `npm run build`（默认 `node`） | **失败** | 本机 `~/.local/bin/node` 是 Electron shim，Rollup 原生模块报 `ERR_DLOPEN_FAILED`（Team ID 签名冲突） |
| `PATH=/tmp/aka-node/bin:$PATH npm run build` | **退出 0** | 官方 Node v22.21.1；`tsc --noEmit` + vite 通过，`✓ built in 1.00s` |

**结论：通过。** 前端构建失败是本机 Node 运行时问题，不是仓库缺陷；README 第 183–184 行已预先记录该环境和 `/tmp/aka-node` 规避方式。CI 使用标准 Node，不受影响。

工作区状态：`git diff` 为空；仅有未跟踪的 `.workbuddy/`（不在 `2ff5266` 内），见 §9 P3-02。

## 3. manifest 一致性

核对文件：[app/manifest/indicators.json](../../app/manifest/indicators.json)。

| id | status | specStatus | 参数（默认 / 上下界） | unit | notes | formulaRef 锚点 |
|---|---|---|---|---|---|---|
| T01 | normal | manualComplete | period 20 / 2–200 | 元 | 有 | `#t01-sma` OK |
| T02 | normal | manualComplete | period 20 / 2–200 | 元 | 有 | `#t02-ema` OK |
| T03 | **beta** | partial | period 20 / 2–200 | 元 | 有（边界待补） | `#t03-wma` OK |
| T04 | normal | manualComplete | period 20 / 2–200 | 元 | 有 | `#t04-dema` OK |
| T05 | normal | manualComplete | period 20 / 2–200 | 元 | 有 | `#t05-tema` OK |
| T19 | **beta** | partial | period 20 / 2–200 | 元 | 有（当前根 `x=N-1`） | `#t19-linreg-forecast` OK |
| T20 | normal | manualComplete | period 20 / 2–200 | 元 | 有 | `#t20-linreg-intercept` OK |
| T21 | **beta** | partial | period 20 / 2–200 | 无量纲 | 有（`Syy=0 → 1.0`） | `#t21-linreg-r2` 锚点疑似失效（P3-03） |
| T22 | normal | manualComplete | period 20 / 2–200 | 元/根 | 有 | `#t22-linreg-slope` OK |
| E13 | normal | manualComplete | period1/2/3 = 6/12/24，均 2–200 | % | 有 | `#e13-bias` OK |
| M06 | **beta** | partial | fast 12（2–100）、slow 26（2–200）、signal 9（2–100） | 元 | 有（`2×(DIF-DEA)`） | `#m06-macd` OK |

核对结论：

- **9 项逻辑字段齐全**：id、显示名（`nameZh`/`nameEn`）、分类、ParamSpec、公式引用、版本、状态、单位、口径说明，11 条均有值；`formulaRef`、`unit`、`notes` 由 `manifest_parses_and_ids_are_unique` 断言非空。
- **id 与注册表一致**：`registry_matches_manifest`（[manifest.rs](../../app/crates/indicator-core/src/manifest.rs#L296-L322)）逐字段比对名称、分类、specStatus、version、status、unit、notes、参数 key 顺序、输出顺序与 inputs；通过。
- **alias 不冲突**：`ma → T01`、`macd → M06`；测试把 id 与 alias 放进同一集合做唯一性断言，`registry_ids_and_aliases` 另验证 `lookup("ma")`/`lookup("macd")` 解析正确。
- **ParamSpec 默认值与上下界可校验**：QA 用脚本逐条核验 11 条的 int 默认值均在 `[min,max]`、`step>0`，结果 PASS；运行时 `param::validate` 覆盖 Int/Float/Enum/Bool 的类型、缺失、未知 key 与越界。[param.rs](../../app/crates/indicator-core/src/param.rs#L118-L180)
- **beta 名单一致**：`T03 / T19 / T21 / M06`，与开发自述完全一致；其余 7 条 normal。`status` 实际由 `spec_status` 派生（`manualComplete → normal`，其余 `beta`），测试又断言 manifest 的 `status` 等于派生值，因此两者被强制一致；这是“冗余但受约束”的字段，不是矛盾。
- **P2/P3 观察**：
  1. 没有“manifest 全量默认值必须在界内”的自动化断言；本次是 QA 脚本人工核验通过。建议补一条测试，防止后续新增指标时默认值越界。
  2. T21 的 `formulaRef` 写成 `#t21-linreg-r2`，而文档标题是 `## T21 LinReg R²`，GitHub 风格锚点很可能为 `#t21-linreg-r²`，链接会失效；建议把标题改成 `R2` 或加显式锚点。
  3. 与 Story 卡的参数口径存在差异（非本批次缺陷，见 §9 P2-04）：卡片写 EMA 默认 12、MACD 快/慢/信号上限 200 且有“均线类型 EMA/SMA”，manifest 实际是 EMA 默认 20、MACD 上限 100/100、无 `maType`。README 已把 EMA 默认 20 记为“S1 自定口径”，但 MACD 两项差异未记录。

## 4. 正确性证据强度

### 4.1 夹具与边界覆盖

黄金套件共 **40 个 case**：base 11、data-insufficient 7、constant 10、zero-mean 1、first-bar 11。

| 指标 | 黄金 case 数 | 数据不足 | 常数序列 | 零均值 | 首根 K 线 | 单测 | 证明强度 |
|---|---:|---|---|---|---|---|---|
| T01 SMA | 4 | 夹具 | 夹具 | — | 夹具 | `t01_sma_matches_manual_mean` 手算均值 | 强 |
| T02 EMA | 4 | 夹具 | 夹具 | — | 夹具 | `t02_ema_seed_is_sma` 只验种子；递推靠夹具 | 中强 |
| T03 WMA | 4 | 夹具 | 夹具 | — | 夹具 | `t03_wma_matches_manual` 手算加权 | 强（数值层） |
| T04 DEMA | 4 | 夹具 | 夹具 | — | 夹具 | `t04_dema_matches_two_ema_formula` 调用同一 kernels | 中 |
| T05 TEMA | 4 | 夹具 | 夹具 | — | 夹具 | `t05_tema_matches_three_ema_formula` 调用同一 kernels | 中 |
| T19 Forecast | 4 | 夹具 | 夹具 | — | 夹具 | 与 T20/T21/T22 共用 1 条关系断言 | 弱（自定口径） |
| T20 Intercept | 3 | 单测 `short_series` | 夹具 | — | 夹具 | 共用关系断言 | 中强（OLS 标准） |
| T21 R² | 3 | 单测 `short_series` | 夹具 | — | 夹具 | 共用关系断言，只验 `0..=1` | 弱（退化口径） |
| T22 Slope | 3 | 单测 `short_series` | 夹具 | — | 夹具 | 共用关系断言 | 中强（OLS 标准） |
| E13 BIAS | 5 | 夹具 | 夹具 | 夹具（全 0 价格） | 夹具 | `e13_bias_has_three_periods` 验 6 日手算 | 强 |
| M06 MACD | 2 | 单测 `short_series` | **缺** | — | 夹具 | `macd_outputs_are_finite_after_warmup` 单点验 `2×(DIF-DEA)` | 中 |

**四类边界**：类别层面齐全；“数据不足”由夹具 7 条 + 单测 `short_series_is_all_nan_for_every_indicator`（3 根输入覆盖全部 11 指标）兜底；“首根 K 线”覆盖全部 11；“常数序列”覆盖 10（**M06 缺**）；“零均值”只有 E13（设计上只有 BIAS 有除零风险）。所以“是否含四类边界”成立，但**逐指标矩阵不完整**。

### 4.2 公开公式手算与自定口径

- [gen_reference.py](../../app/crates/indicator-golden/fixtures/gen_reference.py) 不调用 Rust 引擎，用 Python 独立实现 SMA/WMA/EMA/EMA-of-valid/DEMA/TEMA/OLS/BIAS/MACD；这满足“独立对拍”，但**不是第三方库交叉验证**，且 T19/T21 与 Rust 共享同一套自定约定，只能证明“实现与自定口径自洽”。
- T19 的“取当前根 `x=N-1`、不取下一根”已写入 manifest `notes` 与 [b1-trend-kernels.md](../../docs/indicators/b1-trend-kernels.md#L53-L59)；T21 的“`Syy=0 → R²=1.0`”也已写入 manifest `notes` 与文档第 66–71 行。**不是只写在汇报里，这一项通过。**
- **证明强度不足的指标**：
  - **T19 / T21**：自定口径，黄金生成器与 Rust 共享约定；没有外部参考或独立手算非平凡样例，当前只能证明自洽，标 beta 是恰当的。
  - **T04 / T05**：单测直接调用同一 `kernels::ema`/`ema_of_valid`，属同源自证；真正独立的是 Python 生成器，强度中等。
  - **M06**：只有 `warmup+2` 一个点的公式断言 + 黄金夹具；没有常数序列（DIF/DEA/HIST 应恒 0）与非平凡手算用例，强度中等。
  - T20/T22 的 OLS 公式无歧义、黄金覆盖完整，强度足够。

### 4.3 容差

- 实际夹具：除 M06 用 `absolute:1e-4` 外，其余全部 `relative:1e-6`（[gen_reference.py](../../app/crates/indicator-golden/fixtures/gen_reference.py#L174-L220)）。
- `Tolerance::Relative` 的分母是 `max(|expected|, 1.0)`（[lib.rs](../../app/crates/indicator-golden/src/lib.rs#L131-L137)）。价格类期望值约 100 时，实际绝对容差约 **1e-4**，合理；M06 的 1e-4 对副图展示也合理。
- **文档不一致（P2-01）**：文档第 14 行写“R²/斜率 `absolute 1e-6`；BIAS `absolute 1e-4`”，但夹具实际用 relative 1e-6。对 E13 而言比文档更严（约 1–5e-6），对斜率大于 1 的值可能比文档更松（1e-6×|slope|）。**不是数值错误，但口径应统一**。

## 5. Story 卡对账

对照 [aka-story-cards-v0.1.md](../story-cards/aka-story-cards-v0.1.md)，README 的 B1 覆盖表位于 [app/README.md](../../app/README.md#L131-L148)。

| 指标 | README 声称的卡 / AC | 测试是否真实存在 | 测试实际证明 | AC 实际要求 | 结论 |
|---|---|---|---|---|---|
| T01 | S-02.05-01 / AC-02.05-01 | 是，`t01_sma_matches_manual_mean` | SMA 前 20 根手算均值 | 参数抽屉手输 `1` 标红、保留 1、图线仍为 MA20、显示“参数无效” | **不通过（错配）** |
| T02 | 同上 | 是，`t02_ema_seed_is_sma` | EMA 种子等于 SMA20 | 同上（UI 行为） | **不通过（错配）** |
| T03 | 同上 | 是，`t03_wma_matches_manual` | WMA 手算加权 | 同上（UI 行为） | **不通过（错配）** |
| M06 | S-02.03-01 / AC-02.03-03（补2） | 是，`macd_outputs_are_finite_after_warmup` | `warmup+2` 一点 `HIST=2×(DIF-DEA)` | 每根柱与同帧 tooltip 对账误差 0，且正红负绿 | **不通过（仅数据层）** |
| M06 | S-03.03-01 / AC-03.03-01 | 无页面证据 | 只有 Markdown 口径文档 | P4 口径页第 01 段逐字包含三行公式并注明“柱为 2 倍差” | **不通过（页面不存在）** |

关键判断：

1. 这些测试**真实存在、名称准确、断言具体**，不是开发编造的；问题是**证据层级与 AC 层级不匹配**。Story 卡第 0.3 节要求每条 AC 标注证据层，S-02.05-01、S-02.03-01 的相关 AC 都是 `[渲染层]`，仓库里没有前端测试或截图证据。
2. `S-03.03-01` 是 P4 指标口径页的 Story；本次只新增了 `docs/indicators/b1-trend-kernels.md`，README 自己也写明“完整指标口径页未实现”。因此“M06 对 S-03.03-01 / AC-03.03-01 有证据”**明确不成立**。
3. **7 个指标无卡属实**：在 Story 卡全文中，`T04`、`T05`、`T19`、`T20`、`T21`、`T22`、`E13` 的出现次数均为 **0**（T01/T02/T03 也没有以“数值实现”为对象的卡，只被 S-02.05-01 间接引用）。
4. **“属技术债”未入账**：README 说这 7 项“无卡，属技术债”，但 [aka-tech-debt-s0-v0.1.md](./aka-tech-debt-s0-v0.1.md) 只有 9 条 S0 阻塞项，没有这 7 张卡的登记、工作量、责任人或偿还时点。这是台账缺口（P2-05），不是 9 条 S0 债本身的问题。

### 5.1 补卡建议

Story 卡编号体系里没有 B1 数值实现的位置（S-01 是 E-01 行情与自选，S-03 是 E-03 指标库与口径）。建议在 **E-03 下新增 F-03.04「指标数值内核（B1 底座）」**，避免改动任何现有编号：

| 建议编号 | 归属 | 覆盖指标 | 核心 AC 建议 |
|---|---|---|---|
| **S-03.04-01** | E-03 / F-03.04 | T01 SMA、T02 EMA、T03 WMA、T04 DEMA、T05 TEMA | 公式、首个有效值、warmup、常数/不足/首根边界；T03 补“边界说明闭环” |
| **S-03.04-02** | E-03 / F-03.04 | T19 Forecast、T20 Intercept、T21 R²、T22 Slope | OLS 口径、T19 当前根约定、T21 退化 `R²=1`、非平凡手算样例 |
| **S-03.04-03** | E-03 / F-03.04 | E13 BIAS 6/12/24 | 三周期独立输出、SMA=0 → NaN、零均值边界 |

责任人建议：**BA 负责补卡与 AC 写法，QA 负责证据层验收，开发参与口径评审**；补卡完成时点建议 **S2 开工前**。若 PM 更倾向“一指标一卡”，可在上述三个卡下拆子卡，但不要改现有 S-02/S-03 编号。

同时建议把 README 的 B1 表改名为“**关联卡（未闭合）**”，并增加一列“AC 验收状态”：
- T01/T02/T04/T05/T20/T22/E13：数值层已验，卡未建；
- T03/T19/T21/M06：数值层已验，beta 原因已记录，卡/页面未闭合；
- S-03.03-01：未开始，不得写成已有证据。

## 6. 性能基线

执行：`cargo run --release -p indicator-golden --bin aka-bench`。跑测后已用 `git checkout -- bench/baselines/macos-x86_64.json` 还原，`git diff` 为空。

**机器与编译器**：Intel Core i7-9750H @ 2.60GHz、macOS 26.7.1、`x86_64-apple-darwin`、rustc 1.98.1。与基线 `machine` 字段逐项相同（os/arch/cpu/rustc/profile/engineVersion/benchVersion），**同机同编译器，完全可比**。

| 指标 | 520 p95 基线 | 520 实测 | 2500 p95 基线 | 2500 实测 | 阈值 | 判定 |
|---|---:|---:|---:|---:|---:|---|
| T01 | 0.002 | 0.002 | 0.008 | 0.008 | 1.0 / 8.0 | pass |
| T02 | 0.008 | 0.002 | 0.008 | 0.008 | 1.0 / 8.0 | pass |
| T03 | 0.038 | 0.049 | 0.132 | 0.063 | 1.0 / 8.0 | pass |
| T04 | 0.007 | 0.006 | 0.040 | 0.092 | 1.0 / 8.0 | pass |
| T05 | 0.010 | 0.009 | 0.045 | 0.041 | 1.0 / 8.0 | pass |
| T19 | 0.033 | 0.030 | 0.292 | 0.257 | 1.0 / 8.0 | pass |
| T20 | 0.058 | 0.057 | 0.318 | 0.227 | 1.0 / 8.0 | pass |
| T21 | 0.031 | 0.031 | 0.316 | 0.261 | 1.0 / 8.0 | pass |
| T22 | 0.091 | 0.075 | 0.315 | 0.247 | 1.0 / 8.0 | pass |
| E13 | 0.013 | 0.019 | 0.057 | 0.127 | 1.0 / 8.0 | pass |
| M06 | 0.009 | 0.009 | 0.134 | 0.044 | 1.0 / 8.0 | pass |

单位 ms。22/22 pass。p50 偏差均 ≤0.013ms；p95 最大绝对偏差是 **E13 2500 的 +0.070ms**（0.057→0.127），仍是阈值的 1.6%；T04 2500 的 +0.052ms、T03 520 的 +0.011ms 同属微秒级抖动。个别 `maxMs` 尖峰（如 T03 520 的 0.350ms）不影响以 p95 为门禁的判定。

**跨机可比性**：基线文件名只到 `macos-x86_64`，但内容带 CPU 与 rustc。当前只能与同 CPU/同 rustc 的 Intel Mac 直接比较；换 Apple Silicon 或其他 Intel 型号必须重跑生成对应基线，不应拿这份 x86_64 基线做跨机结论。本报告的同机对比有效。

## 7. 技术债状态

核对 [aka-tech-debt-s0-v0.1.md](./aka-tech-debt-s0-v0.1.md)：

- 9 条 `TD-S0-01 … TD-S0-09`，状态列**全部为“未清偿”**。
- 偿还时点**全部为“S2 开工前 3.5 人日清零”**；工作量合计 1.0+0.8+0.4+0.2+0.2+0.2+0.2+0.25+0.25 = **3.5 人日**，与文首声明一致。
- 全仓检索 `已清偿 / 清偿 / 清零 / 已通过 / 已修复`：没有把 9 条债写成已清偿的表述；README 第 106–108 行明确写“全部未清偿”，文档中的“已通过”只出现在“不得写成已通过”的禁止句中。
- **台账缺口（P2-05）**：README 把 7 个无卡指标称为“属技术债”，但这 7 项不在上述 9 条台账内，没有编号、工作量、责任人或偿还时点。建议新增一条文档债（例如 `TD-B1-01`，BA 补卡 3 张，0.5 人日，S2 开工前），避免“口头技术债”。

已知范围事实（周/月聚合、6 类日志埋点、`data/sim` 实物与 sha256）确为登记在案的 S0 债，本批次不要求；本报告不将其重复计为 B1 缺陷。

## 8. 越界检查

- **指标范围**：注册表 `ALL` 恰为 11 项（T01/T02/T03/T04/T05/T19/T20/T21/T22/E13/M06）；`implemented_count() == 11`；manifest `plannedCount=105` 但 `indicators` 只有 11 条。检索 `KDJ/BOLL/RSI/OBV/ATR` 无注册实现。**未实现 B2 及之后指标。**
- **业务功能**：前端只有 `src/pages/workbench/WorkbenchPage.tsx` 一个页面；`AppShell` 的“行情/指标库/设置”均 `disabled`，只有“工作台”可用；`src` 中检索 `fetch/http/tushare/登录/支付/账户` 无业务调用。**未夹带新页面、账户、支付、真实数据源。**
- **Tushare**：后端仍是 S0 已有的接口骨架，默认不可用，未在本提交接入。**不算越界。**
- **工作台暴露范围**：MA 类型选择映射到 T01/T02/T03，MACD 用 M06；T04/T05/T19-T22/E13 未进 UI，符合“只暴露 SMA/EMA/WMA/MACD”的已知范围。
- **P3 观察**：`kernels::wilder` 已实现且有单测，但 B1 没有指标使用它（更像是为 RSI 预留）。它不是 B2 指标，不构成越界，但属当前未消费代码；建议在 B2 首次使用前保留覆盖，或按 YAGNI 移除。

## 9. 问题清单（分级 / 复现 / 修复）

分级口径：
- **P1 阻断**：阻断“B1 按 Story 卡结项”的验收表述；不阻断数值引擎本身。
- **P2 非阻断**：不阻断 B1 数值验收，但应在 S2 开工前或 S2 首周修复。
- **P3 记录/建议**：文档、环境、代码整洁类，不阻塞交付。

### P1-01 · T01/T02/T03 的 AC 证据错配

- **问题**：README 把三个数值单测挂到 `S-02.05-01 / AC-02.05-01`。该 AC 要求参数抽屉手输 `1` 时红框、保留 1、图线仍为 MA20、显示“参数无效”，是纯 `[渲染层]` 行为；现有测试只证明 SMA/EMA/WMA 数值。
- **复现**：
  1. `sed -n '1124,1126p' docs/story-cards/aka-story-cards-v0.1.md`，确认 AC-02.05-01 是渲染层。
  2. `sed -n '138,140p' app/README.md`，确认证据列只有 `t01_*`/`t02_*`/`t03_*` 与夹具名。
  3. 在 `app/src` 检索 `AC-02.05-01` 或参数红框断言：无相关前端测试。
- **修复**：把该列改为“数值层证据（不覆盖 AC-02.05-01）”；在 README 增加“AC 验收状态=未验收（渲染层待 S2）”。不要删除测试；它们对数值层仍有效。

### P1-02 · M06 副图 AC 只有数据层证据

- **问题**：`S-02.03-01 / AC-02.03-03（补2）` 要求逐柱与同帧 tooltip 对账、误差 0、正红负绿；`macd_outputs_are_finite_after_warmup` 只在 `warmup+2` 验了一次公式，没有 tooltip/颜色/渲染。
- **复现**：`sed -n '893,899p' docs/story-cards/aka-story-cards-v0.1.md`；`cargo test -p indicator-core macd_outputs_are_finite_after_warmup -- --nocapture` 只输出数值断言；前端无对应测试。
- **修复**：同 P1-01，改标注为“数值层证据”；渲染层证据留到 S2 的副图/参数卡验收。

### P1-03 · M06 对 `S-03.03-01 / AC-03.03-01` 的声明不成立

- **问题**：该 AC 要求 P4 口径页第 01 段逐字渲染三行公式；本提交没有口径页，只有 `docs/indicators/b1-trend-kernels.md`。README 自己也在“未实现”中写明“完整指标口径页”未做。
- **复现**：`git show --name-only --format="" 2ff5266 | grep -i workbench` 只看到工作台文件；`find app/src -type f` 无口径页/路由；`grep -n "完整指标口径页" app/README.md` 命中未实现清单。
- **修复**：从 B1 证据表中移除 `S-03.03-01 / AC-03.03-01`，改记“关联下游卡，待 S-03 实现”；或把口径内容文档明确标为“内容草稿，不是 AC 证据”。

### P1-04 · 7 个指标无卡，且未被技术债台账登记

- **问题**：T04/T05/T19/T20/T21/T22/E13 在 Story 卡中 0 次出现；README 称“无卡，属技术债”，但 9 条 S0 债台账中没有这 7 项。
- **复现**：
  ```bash
  for k in T04 T05 T19 T20 T21 T22 E13; do
    echo "$k $(grep -c "$k" docs/story-cards/aka-story-cards-v0.1.md)"
  done
  grep -n "TD-S0\|无卡\|技术债" docs/qa/aka-tech-debt-s0-v0.1.md
  ```
  结果：7 个指标均为 0；台账只有 TD-S0-01…09。
- **修复**：按 §5.1 新增 `S-03.04-01/02/03`（E-03 / F-03.04），由 BA 在 S2 开工前补卡；同时在技术债文档新增一条补卡债（责任人/工作量/时点）。这是 S2 的卡基线，不建议拖到 B2 开发中途。

### P2-01 · 容差文档与夹具不一致

- **问题**：文档声明 R²/斜率 `absolute 1e-6`、BIAS `absolute 1e-4`；夹具实际全部 `relative:1e-6`（M06 除外）。
- **复现**：
  ```bash
  python3 - <<'PY'
  import json,glob
  for f in glob.glob('app/crates/indicator-golden/fixtures/*.json'):
      for c in json.load(open(f))['cases']:
          print(c['indicatorId'], c['tolerance'])
  PY
  ```
  对照 `docs/indicators/b1-trend-kernels.md` 第 14 行。
- **修复**：二选一——把文档改成“夹具实际容差：relative 1e-6，M06 absolute 1e-4”；或在生成器里按输出类型写入 `absolute:1e-6`/`absolute:1e-4` 并重生成夹具。建议同时加一条 `tolerance_rules_are_frozen` 与文档的一致性检查。

### P2-02 · 部分指标证明强度不足

- **问题**：T19/T21 只证明自定口径自洽；T04/T05 单测同源自证；M06 只有单点公式断言、无常数序列夹具；T20/T21/T22/M06 在 `edge_data_insufficient` 中没有夹具 case（虽然 `short_series` 单测覆盖全部 11）。
- **复现**：见 §4.1 表格；`sed -n '452,461p' app/crates/indicator-core/src/indicators/mod.rs` 只有一条关系断言与范围断言；`gen_reference.py` 的 insufficient 列表不含 T20/T21/T22/M06，constant 列表不含 M06。
- **修复建议**：
  1. T19/T21 增加非平凡手算样例：如线性序列 `1..20` 断言 slope=1、intercept=1、forecast=20、R²=1；再选一组已知非线性序列手算 R²。
  2. M06 增加常数序列（40 根 10.0）：断言 DIF/DEA/HIST 全 0 且无 NaN。
  3. 补 T20/T21/T22/M06 的 insufficient 夹具（可用 `gen_reference.py` 的 `short` 输入）。
  4. T04/T05 可保留“同源公式”测试，但明确其定位为 smoke，不作为独立正确性证据。

### P2-03 · manifest 自动化与锚点小缺口

- **问题**：没有全量“默认值在界内”的自动断言（当前人工核验通过）；T21 的 `formulaRef` 锚点与标题 `R²` 可能不匹配。
- **复现**：`cargo test -p indicator-core manifest_parses_and_ids_are_unique` 只检查 formulaRef/unit/notes 非空；`grep -n "## T21" docs/indicators/b1-trend-kernels.md` 与 manifest 的 `#t21-linreg-r2` 对比。
- **修复**：在 `manifest::tests` 增加遍历断言（int/float 默认值 `min..=max`、step>0、enum 默认值在 variants 内）；把标题改为 `T21 LinReg R2` 或加显式锚点。

### P2-04 · manifest 参数与 Story 卡口径差异

- **问题**：卡片写 EMA 默认 12、MACD 快/慢/信号上限 200、均线类型 EMA/SMA；manifest 是 EMA 默认 20、MACD 上限 100/100、无 `maType`。EMA 默认差异已在 README 记录，MACD 两项未记录。
- **复现**：`sed -n '1095,1098p' docs/story-cards/aka-story-cards-v0.1.md` 对照 `app/manifest/indicators.json` 的 T02/M06。
- **修复**：由 BA/PM 在补卡时统一口径；若 manifest 是准绳，更新卡片字段表；若卡片是准绳，改 manifest 并重跑参数测试。此项不影响当前数值正确性，但会影响 S2 参数抽屉验收。

### P3-01 · 本机 Node 运行时

- **问题**：默认 `node` 是 Electron shim，直接 `npm run build` 会失败；官方 Node 22 下通过。
- **复现**：`node -v` 指向 `~/.local/bin/node`；`npm run build` 报 Rollup `ERR_DLOPEN_FAILED`；`PATH=/tmp/aka-node/bin:$PATH npm run build` 通过。
- **修复**：无需改仓库；README 已记录。建议 QA/CI 固定 Node 20+，不要把本机 shim 的失败计为构建缺陷。

### P3-02 · 未跟踪 `.workbuddy/`

- **问题**：仓库根有未跟踪目录 `.workbuddy/`，不在 `2ff5266` 内。
- **复现**：`git status --short` 显示 `?? .workbuddy/`。
- **修复**：确认归属后清理或加入 `.gitignore`；不影响本批次验收。

### P3-03 · `wilder` 预留内核

- **问题**：`kernels::wilder` 有实现与单测，B1 无指标使用。
- **复现**：`grep -rn "wilder" app/crates` 只命中定义与自身测试。
- **修复**：保留到 B2 首次使用，或按 YAGNI 移除；不影响 B1。

## 10. S2 开工前的关闭条件

**必须先完成（阻断 S2 开工/结项表述）**：

1. **9 条 S0 技术债按既有裁定清零**（3.5 人日）。这是用户已拍板的 S2 前置条件，不是 B1 缺陷；本报告只确认“仍未清偿”。
2. **修正 README 的 B1 证据表**（P1-01/02/03）：不得把 Rust 数值测试写成 `S-02.05-01`、`S-02.03-01` 渲染 AC 的证据；不得声明 `S-03.03-01` 已有证据。
3. **BA 补齐 7 个无卡指标的 Story 卡**（建议 `S-03.04-01/02/03`，E-03 / F-03.04），并在技术债台账登记补卡债（P1-04 / P2-05）。

**建议在 S2 首周完成（不阻断 B1 数值验收，但阻断 beta 升 normal 或 B2 复用）**：

4. 统一 manifest 与 Story 卡的参数口径（EMA 默认、MACD 上限、`maType`）——P2-04。
5. 补 T19/T21 的非平凡手算、M06 的常数序列、T20-T22/M06 的 insufficient 夹具——P2-02。
6. 统一容差文档与夹具，并增加 manifest 默认值越界测试——P2-01 / P2-03。

**B1 数值层本身**：不需要返工。11 个指标的公式实现、边界 NaN 行为、alias 兼容、bench 性能均达到底座批次要求；T03/T19/T21/M06 的 beta 标记与自定口径披露是诚实且一致的。

---

### 附：QA 实跑命令清单

```bash
cd /Users/sixmillion/Documents/aka/app
cargo check --workspace --all-targets
cargo test --workspace --exclude aka-desktop
cargo test -p indicator-golden -- --nocapture
npm run build                                   # 本机默认 node 会失败（Electron shim）
PATH=/tmp/aka-node/bin:$PATH npm run build      # 官方 Node v22.21.1，退出 0
cargo run --release -p indicator-golden --bin aka-bench
# 跑完 bench 后还原基线，避免 QA 改动入库：
cd /Users/sixmillion/Documents/aka
git checkout -- app/bench/baselines/macos-x86_64.json
```
