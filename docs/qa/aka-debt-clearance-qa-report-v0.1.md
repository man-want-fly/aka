# AKA S0 旧债清偿 + B1 非阻断修复 复核报告 v0.1

| 项 | 内容 |
| --- | --- |
| 复核对象 | 提交 `70ffa36`（`70ffa361b35b6075d2d876cb08f610b58694c472`），CI run `42216459161` |
| 复核角色 | QA（只验证，不改业务代码、不改 PRD / Story 卡 / 台账） |
| 复核日期 | 2026-11-06 |
| 复核范围 | 9 条 S0 债务、B 组 4 项修复、manifest 裁定落地、越界检查、回归风险 |
| 总体结论 | **代码与数值证据真实；台账「6 已清偿」不成立（应为 5 已清偿 + 4 部分清偿）；本轮完成新卡证据挂载，属越界** |
| S2 结论 | **代码底座可开工；但「S0 已清零」不成立，两项 P1 未整改前不得签认 S0 清零** |

---

## 0. 验证环境与自跑结果

| 项 | 实测 |
| --- | --- |
| 提交 / 分支 | `70ffa36`，`git log -1` 与任务给定一致 |
| 工作区 | `git diff` 为空；仅 `?? .workbuddy/`（工具目录，非仓库产物） |
| `cargo test --workspace --exclude aka-desktop` | **79/79 通过**（app-core 14、data-provider 26、data-store 8、indicator-core 26、indicator-golden 5），0 failed |
| `cargo test -p indicator-golden -- --nocapture` | `golden: 54/54 passed` |
| `PATH=/tmp/aka-node/bin:$PATH npm run build` | `tsc --noEmit` + Vite 构建通过，`✓ built in 1.18s`（44 modules） |
| CI `42216459161` | `conclusion=success`，`headSha=70ffa361…c472`（`gh run view` 实查） |
| `python3 tools/verify_aggregates.py` | 3 标的 `D=520 / W=104(mismatch 0) / M=24(mismatch 0)`，`compare-report.json → passed` |

> 构建说明：本机默认 `node` 为 Electron shim，Rollup 原生模块会报签名错误；官方 Node（`/tmp/aka-node/bin/node`，v22.21.1）可正常构建。属本机环境问题，不计仓库缺陷。

---

## 1. 9 条 S0 债务逐条结论

| 编号 | 文档现状态 | 复核结论 | 独立证据 |
| --- | --- | --- | --- |
| TD-S0-01 | 已清偿 | **通过** | 自跑 `verify_aggregates.py` 三标的 W/M mismatch 0；`compare-report.json` = `passed`；`bench/ipc-snapshots/index.json` count=10 且报文非空 |
| TD-S0-02 | 已清偿 | **通过** | 两份 manifest 均 9 字段；sha256 独立重算一致；两 seed 差异 4 字段（`datasetId/dataVersion/seed/sha256`）；`generation-report.json` 含 seed-42 v1(gen1)/v2(gen2) 且 `verified=true` |
| TD-S0-03 | 已清偿 | **通过** | `weekly_and_monthly_aggregate_from_daily_batch`、`calendar` ISO 周年界测试通过；Python 独立对拍 mismatch 0 |
| TD-S0-04 | 部分清偿 | **通过（缺口属实）** | 机制真实存在：`indicator.compute` JSONL、`ParamDebouncer(40/120)`、前端 `REQUEST_DEBOUNCE_MS=120`；判据要求的「实机连键 1→12→120 仅 1 条日志」确未取证，标部分清偿诚实 |
| TD-S0-05 | 已清偿 | **不通过（详见 P1-01）** | 判据要求「5 实例 `compute.count=5`、`compute.skip=0`」；实际唯一测试为 **3 实例**（a/b 同 T01-20、c T01-30），断言 `compute.count=2 / compute.skip=1`，与判据不符 |
| TD-S0-06 | 部分清偿 | **通过（缺口属实）** | `indicator.cold_ms` + 就近秩 P95 已落地；`thirty_cold_samples_produce_p95` 为**合成样本**（0..29 → P95=28.0），非实机 30 次冷切墙钟；「≤300ms / 报价头 ≤60ms」确未取证 |
| TD-S0-07 | 部分清偿 | **通过（缺口属实）** | `cache.hit/cache.miss` 已发事件，二次请求 `cache.hit=2`、`indicator.compute` 不增长；但「切回 ≤120ms + 逐点一致」无实机计时取证，缺口属实 |
| TD-S0-08 | 已清偿 | **通过** | 按生成器同算法独立复算 `data/real` 摘要 = `9e44c1e2ccb2a5d987d522192d1484a1db6d180e72192e519f55b5c8584d303e`；`generation-report.json.realDir` 前后相同、`changed=false`；`generator_refuses_real_directories` 存在 |
| TD-S0-09 | 已清偿 | **通过** | seed-42/seed-7 `records.csv` sha256 独立重算与 manifest 完全一致；`sha_is_recomputable_and_changes_on_any_tamper`（改 close +0.01 后摘要变化）真实存在；规范 CSV 与 sha256 契约见 `app/README.md` §101 |

**逐条小结**

- 真正达标：TD-S0-01 / 02 / 03 / 08 / 09，共 **5 条**。
- 诚实标为部分清偿：TD-S0-04 / 06 / 07，共 **3 条**；缺口描述确实指向「实机 UI / 墙钟取证」，不是把未做写成「待 UI」蒙混。
- **TD-S0-05 被误标为已清偿**：这是本轮唯一一条「已清偿」成口号的问题。它并非完全没做事——去重与计数埋点确实实现了——但其**自己写下的清零判据没有被任何测试对拍**，台账与 README 还直接把 `count=2 / skip=1` 当作「已清偿」证据陈列，逻辑上自相矛盾。

> 因此当前正确口径应为：**5 已清偿 + 4 部分清偿（TD-S0-04/05/06/07）**。

---

## 2. B 组 4 项修复

| 编号 | 检查项 | 结论 | 证据 |
| --- | --- | --- | --- |
| B-1 | 容差口径文档与实现一致 | **通过** | `docs/indicators/b1-trend-kernels.md` 第 14 行已改为：价格/斜率为 `relative 1e-6`（分母 `max(|expected|,1.0)`）、R² 为 `absolute 1e-6`、BIAS% 与 MACD 为 `absolute 1e-4`；8 个夹具全部含 `toleranceRules`；全量 54 case 逐 case 校验 **0 处偏离** |
| B-2 | T19/T21 非平凡手算样例 | **通过** | `edge_manual_nonlinear`（`[1,2,4,5,8]`，period 5）：forecast `7.4`、intercept `0.6`、slope `1.7`、R² `0.963333333`；QA 独立笔算：x̄=2、ȳ=4、Sxx=10、Sxy=17 → b=1.7、a=0.6、T19=0.6+1.7×4=7.4、Syy=30 → R²=289/300=0.9633333，数值完全正确 |
| B-3 | 4 个边界夹具存在且非空 | **通过** | ① M06 常数序列：40 根 10.00，dif/dea/hist 前 33 根 null、33–39 共 7 个 `0.0`（DEA 首值 26+9−1=33，公式正确）；② T20/T21/T22 insufficient：20 根、period 60 → 全 null；③ M06 insufficient：20 根、12/26/9 → 全 null（慢线需 26 根）；④ T21 常数窗口：`r2[19]=1.0`、`r2[39]=1.0`，中段为非常数序列的真实 R²。golden 54/54 逐 case 断言，不存在空文件放行 |
| B-4 | 收紧容差是否合规 | **通过** | 仅 `edge_manual_nonlinear` 的 T19–T22 使用 `absolute:1e-9`（4 case），文档第 14 行明确允许「手算样例可单 case 收紧」；`tolerance_rules_are_frozen` 断言：收紧只允许出现在 `edge_manual` / `edge_arithmetic`，其余 case 必须严格等于 T21=`absolute:1e-6`、E13/M06=`absolute:1e-4`、其他=`relative:1e-6` |

补充：`tolerance_rules_are_frozen` 不只是字符串检查，它逐 case 校验指标→容差映射，并锁定 8 个夹具的 `toleranceRules` 必须覆盖 5 类口径（`relative:1e-6 / absolute:1e-6 / absolute:1e-4 / absolute:1e-9 / count`），文档改动会立即打红测试。证据强度足够。

---

## 3. manifest 裁定落地

| 裁定 | 期望 | 实测 | 结论 |
| --- | --- | --- | --- |
| R-01 T02 EMA 默认 | 20 | `T02.params[0].default = 20`（min 2 / max 200） | **通过** |
| R-02 M06 参数上限 | fast/signal 均为 200 | `fast.max=200`、`slow.max=200`、`signal.max=200` | **通过** |
| R-03 无 `maType` | 不存在 | 全 11 条 manifest 中 `maType` 命中 0 | **通过** |
| M06 公式口径 | 固定 EMA、12/26/9 | 默认 `12/26/9`；notes 写明 `DIF=EMA(fast)-EMA(slow)`、`DEA=EMA(signal)(DIF)`、柱=2×(DIF−DEA) | **通过** |

补充：T19/T21 的自定口径已写入 `manifest.notes`（「取当前根 x=N−1，不是下一根预测」「Syy=0 定义为 1.0」），不是只写在汇报里。

---

## 4. 越界检查

| 禁止项 | 现状 | 判定 |
| --- | --- | --- |
| 新卡 `S-03.04-01/02/03` 的证据挂载 | **已做**，且做成「可结项」表述 | **不通过（P1-02）** |
| P4 指标口径页 | 未做：`src/` 无任何口径页 / 指标库页面，`package.json` 无前端测试脚本 | 通过（未越界） |
| 渲染层取证 | 未做：仓库无渲染截图/前端测试；`README` 覆盖表与 `TD-B1-02/03` 均标「未结项」 | 通过（未越界） |

**P1-02 具体事实（提交 `70ffa36` 内）**

- 新增 PRD `F-03.04`（39 行）与 Story 卡 `S-03.04-01 ~ 03`（293 行增改）。
- 新增 `docs/qa/aka-b1-card-reconciliation-v0.1.md`（166 行），第 11 行写「B1 可按『数值层结项』签认」，第 19–23 行 P1-01~05 标「已收口」，第 36–49 行 12 条测试挂接表多数标「可结项=是」，第 144 行 `TD-B1-01` 标「已关闭」。
- `app/README.md` 第 172–184 行把黄金夹具/单测挂到 `S-03.04-01/02/03` 的数值 AC。

这三点正是本轮明确要求「应仍未做」的动作；其中「可结项=是 / 已收口 / 数值层结项 / TD-B1-01 已关闭」构成「已覆盖」式表述，直接判为问题。

需要区分的是：**补建卡片本身**可以由上一轮 QA 的补卡建议承接；但**把测试证据挂到新 AC 并宣告可结项**是超出本轮范围的动作。P4 页面与渲染层证据确实仍未做，README 与 Story 卡对这两项的「未结项」表述是诚实的，不构成越界。

---

## 5. 回归风险

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| 79 个测试独立复跑 | **通过** | 14+26+8+26+5=79，0 failed；无 ignored、无 filtered |
| 黄金 54/54 | **属实** | `golden: 54/54 passed`，8 套夹具，case 数 11+4+1+11+11+11+4+1=54 |
| 周/月聚合是否影响日线 | **否** | `series_for` 中 `Timeframe::Day => batch.rows.clone()`，W/M 由同一日线批次 `aggregate_bars` 派生（`core.rs:408-410`）；`weekly_and_monthly_aggregate_from_daily_batch`、`default_window_covers_all_bars` 均通过 |
| 前端构建 | **通过** | 官方 Node 下 `tsc --noEmit` 与 Vite 构建成功；前端仅新增 120ms 请求防抖，无页面结构变更 |
| 工作区洁净 | **通过** | `git diff` 为空；sim 生成产物与 bench 基线均未残留改动 |

未见日线路径被周/月聚合污染，也未见到对既有 11 指标算法与黄金期望值的改动（夹具仅新增 case 与 `toleranceRules`，原有 case 未被放宽）。

---

## 6. 问题清单（分级 + 复现步骤）

### P1-01 · TD-S0-05 被误标「已清偿」，判据未对拍

- **性质**：台账失真（阻断 S0 清零签认，不阻断编码）。
- **事实**：`docs/qa/aka-tech-debt-s0-v0.1.md` 第 91 行判据为「5 实例请求日志 `compute.count=5`、未挂载 `compute.skip=0`」；第 183–184 行给出的证据却是 `compute.count=2`、`compute.skip=1`；`app/README.md` 第 142 行同样以 `count=2 / skip=1` 标「已清偿」。
- **实际测试**：`app/crates/app-core/src/core.rs:999-1040`，仅 3 个实例（a/b 同为 T01 period=20，c 为 period=30），断言 `indicator.compute=2`、`cache.miss=2`、`compute.skip=1`、`compute.count=2`。
- **影响**：去重机制可证，但验收清单 `QA-S0-028` 要求的「主图 2 叠加 + 副图 3 共 5 实例（含重复 id）」场景未被任何测试覆盖；S0 债务实际仍有 1 条未清。
- **复现**：

```bash
cd /Users/sixmillion/Documents/aka/app
cargo test -p app-core calc_telemetry_records_dedup_cache_and_cold_ms -- --nocapture
sed -n '83,92p' ../docs/qa/aka-tech-debt-s0-v0.1.md
sed -n '140,143p' README.md
```

- **整改建议（二选一）**：
  1. 补一条 5 实例测试（2 主图 + 3 副图，含重复 id），断言 `compute.count=5`、`compute.skip=0`，或按验收清单语义给出 `count/skip` 的期望口径；
  2. 若本轮不做 5 实例，则把状态改回 **部分清偿**，并将缺口写明「5 实例端到端计数未取证」。

### P1-02 · 越界完成新卡证据挂载并宣告数值层结项

- **性质**：范围/治理越界（阻断签认，不阻断编码）。
- **事实**：`70ffa36` 新增 `S-03.04-01/02/03` 与 `F-03.04`，并在 `docs/qa/aka-b1-card-reconciliation-v0.1.md` 挂接 12 条测试证据、标「可结项=是」「已收口」「B1 可按数值层结项签认」，同时关闭 `TD-B1-01`；`app/README.md` 覆盖表把数值 AC 挂到新卡。
- **影响**：与「本轮新卡证据挂载应仍未做」直接冲突；若据此签认，等于用本轮禁止的动作把 B1 卡层「做成已覆盖」。
- **复现**：

```bash
cd /Users/sixmillion/Documents/aka
git show --stat 70ffa36 -- docs/
grep -n "可结项\|数值层结项\|已收口\|已关闭" docs/qa/aka-b1-card-reconciliation-v0.1.md
sed -n '170,190p' app/README.md
```

- **整改建议**：保留卡片（如补卡已获授权），但撤回「测试名 → 新 AC」的挂接表与「可结项=是 / 已收口 / 数值层结项 / TD-B1-01 已关闭」结论，统一改为「未结项，随 S2 统一签认」；README 覆盖表的数值列恢复为「待签认」或明确「证据存在但本轮不挂接」。

### P2-01 · `TD-S0-09` 契约文档表述偏简（非阻断）

- **事实**：`app/README.md` §101 写了「规范 CSV → sha256（仓库内自实现，已知向量测试）」，但未显式写明「对 canonical CSV 字节计算 sha256、按 date 升序」这一算法定义；实现与测试是对的（`verify_sim_dataset` 复算一致、篡改即变）。
- **影响**：不影响本轮判据通过；仅降低外部复算者的可操作性。
- **建议**：在 `data/real/README.md` 或 `app/README.md` 补一句算法定义（可选，不阻塞）。

> 说明：TD-S0-04/06/07 的「部分清偿」缺口描述属实，不列为缺陷；B 组容差、手算、边界夹具、manifest 裁定均未发现问题，不为凑数拔高。

---

## 7. S2 能否开工

**结论：代码底座可以开工；「S0 已清零」不成立，不得据此签认。**

- **可以开工的部分**：数值内核（11 指标）、黄金 54/54、79 个单测、周/月聚合与日线隔离、sim/real 数据集闭环均经独立复跑通过，无回归；S2 前端与后续指标开发不会被底座阻塞。
- **不能签认的部分**：台账当前是「5 已清偿 + 4 部分清偿」，不是「6 + 3」。若组织把「S0 全部清零」作为 S2 硬门禁，则**当前不满足**。
- **开工前必须完成的两项 P1**：
  1. `TD-S0-05` 补 5 实例计数测试，或改回部分清偿并写清缺口；
  2. 撤回新卡证据挂接与「数值层结项 / 可结项=是 / 已收口 / TD-B1-01 已关闭」表述，恢复「未结项，随 S2 签认」。
- 完成上述两项后，可签认「S0 清零（4 条部分清偿按 S2 UI 取证关闭）」并启动 S2。

---

## 8. 附：本轮关键命令

```bash
cd /Users/sixmillion/Documents/aka/app
cargo test --workspace --exclude aka-desktop          # 79 passed
cargo test -p indicator-golden -- --nocapture         # golden: 54/54 passed
python3 tools/verify_aggregates.py                    # 3 标的 W/M mismatch 0, passed
PATH=/tmp/aka-node/bin:$PATH npm run build            # built in 1.18s
cd /Users/sixmillion/Documents/aka
git status --porcelain                                # 仅 ?? .workbuddy/
git diff --stat                                       # 空
```
