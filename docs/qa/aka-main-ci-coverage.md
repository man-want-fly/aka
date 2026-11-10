# main 提交 → CI 覆盖表（自 T1 `aec655f` 起）

口径：每个落进 `main` 的 commit 必须指得出一个**在其树内容上跑过且为绿**的 run；自身 run 为红且属已知红的，在「已知红清单」里登记（`aka-main-known-reds.csv`）。CI 只在 `main` push 时触发，故相邻 commit 常共享同一次 tip run。

| commit | 说明 | 自身 run | 覆盖它的绿 run |
|---|---|---|---|
| `aec655f` | T1 证据 | `42490407984` success | 自身 |
| `97c3b52` | merge W-112 | `42491099861` cancelled → 重跑 attempt 2 **红**（R-002 消息缺 SHA） | `42492239109`（`402f2ca`，树包含本提交） |
| `983e63d` | merge W-94 | `42491132598` **红**（R-002 消息缺 SHA） | `42492239109` |
| `6c599aa` | W-100 后端 | 无独立 run | `42492239109` |
| `5d3628c` | W-100 前端 | 无独立 run | `42492239109` |
| `4360966` | W-100 适配（readOnly） | `42492019002` 红（build，已被下一笔修） | `42492239109` |
| `402f2ca` | W-100 适配（ensure_writable） | `42492239109` success | 自身 |
| `4959df5` | merge W-101 | `42493107498` success | 自身 |
| `9a6a0bf` | W-111 | 无独立 run | `42494624601`（`05c94c1`，树包含本提交） |
| `83a2a34` | W-103 | 无独立 run | `42494624601` |
| `fbd4a28` | W-114 | `42494348513` 红（`perf` 不在枚举，已改枚举） | `42494624601` |
| `05c94c1` | merge 文档批次 | `42494624601` success | 自身 |
| `a53371c` | W-93 | `42495270372` 红（R-001 s2 证据） | `19bc043`（s2 重采补 latency 后证据门禁转绿） |
| `cf3dc70` | 文档收口 | `42496026497` 红（R-001 同一处） | `19bc043` |
| `4407246` | 已知红清单 + 裁定 | `42542733594` success | 自身 |
| `4c7697c` | 覆盖表补正 | `42543031799` cancelled（被 `7b093e3` push 取代） | `7b093e3` 的 run |
| `19bc043` | s2 重采补 latency + P10 注册表 | `42543168375` | 自身 |
| `7b093e3` | trailer 空提交补正 | 见 tip run | 自身 |
| `3213ae3` | R-001 转绿删行 + 覆盖表补正（此前漏记，本轮补入） | `42543328131` success | 自身 |
| `9d87f58` | merge P01 `s030104` 取证入口与卡↔套件门禁 | `42557855108` success | 自身 |
| `aec0785` | merge W-115 P04-R3 数据目录注入反例与可达性扫描 | `42558825438` success | 自身 |
| `3b71a57` | 派单池按 aec0785 重核并认领 W-116/P14 | `42563972879` success | 自身 |
| `e9725a5` | merge P14 `s050101` 取证入口 | `42569003287` success | 自身 |
| `36bba90` | merge W-116 `--missing-manifest-sha256` 单字段缺失注入 | `42569681835` success | 自身 |
| `847fb51` | merge W-117 dev2 遗留产品实现接线（P6 骨架 / `S-01.03-01` / `S-08.02-03`） | `42580867197` success（tip，headSha 精确匹配） | 自身 |
| `47d6913` | 状态提交：按 c8bfec3 重核卡池并认领 W-110 / P15（双线取卡状态同步） | `42595057577` success | 自身 |
| `9d4662a` | 代码合并：merge(app) 合入 P15 S-05.01-02 键盘/无结果/最近查看 | `42626999132` success | 自身 |
| `5c64f6f` | 证据提交：evidence(qa) 采集 S-05.01-02 运行层 GUI 证据（s050102） | `42629655330` success（tip） | 自身 |
| `f38fc5c` | 条件签前置：docs(qa) 补齐 S-05.01-02 的 G4 驳回 BA 侧签字前置 | `42634147774` success | 自身 |
| `2ec7841` | 条件签 P15 S-05.01-02（限定 7 条 AC，不升已交付） | `42638396098` failure（**红**：红因为 P7 注册表滞后导致 verify:card-pages 判红，非代码缺陷；由本次修复提交的绿 run 覆盖，不改写历史） | `42651697784`（`172e337`，树包含本提交） |
| `172e337` | docs(qa) 修正 P7 注册表滞后并收口 P15 条件签台账至 v0.31 | `42651697784` success（attempt2） | 自身 |
| `d377348` | merge(app) 合入 W-118 取证 runner 接线修复（死 runner / 失败落盘 / 落地页跳转） | `42675179408` success | 自身 |
| `e513370` | evidence(qa) 采集 S-08.02-02 运行层 GUI 证据（s080202） | `42667417213` success | 自身 |
| `d2994d2` | evidence(qa) 采集 S-07.01-02 运行层 GUI 证据（s070102） | `42667879167` success | 自身 |
| `fe4f4d7` | evidence(qa) 采集 S-05.01-01 运行层 GUI 证据（s050101，证据不足签） | `42683790967` success | 自身 |
| `89a00a2` | evidence(qa) 采集 S-06.03-01 运行层 GUI 证据（s060301） | `42697829390` success | 自身 |
| `ebb296d` | evidence(qa) 归档 s030104 取证失败记录（不可判 / BLOCKED） | `42683045739` success | 自身 |
| `ea0d3f9` | evidence(qa) 归档 s020801 取证失败记录（不可判 / BLOCKED） | `42684715606` success | 自身 |
| `240eda2` | evidence(qa) 归档 s030201 取证失败记录（不可判 / BLOCKED） | `42695148678` success | 自身 |
| `d9b4215` | evidence(qa) 归档 s030302 取证超时失败记录（不可判 / BLOCKED） | `42696381176` success | 自身 |
| `32ac0b6` | evidence(qa) 归档 s060302 取证失败记录（不可判 / BLOCKED） | `42697144996` success | 自身 |
| `2594e97` | sign(qa) 逐卡签 P04/P06/P07（1 整卡 + 2 条件签，P14 驳回） | `42727743201` failure（**红**：红因为完成台账 `S-06.03-01` 状态词用了词表外的「待验收（…）」，`verify:gate-log` 规则 5 判「有签字行但台账无此卡」——**属台账状态词缺陷、非代码缺陷**；由本次台账修复提交的绿 run 覆盖，不改写历史） | 自身 |

说明：
- 2026-11-09 再补记：QA G4 驳回「覆盖表缺口」——按已复核事实补入 `47d6913`→`42595057577`、`9d4662a`→`42626999132`、`5c64f6f`→`42629655330` 三笔绿 run（conclusion=success），均为对应 commit 自身 run；`5c64f6f` 为当前 tip、其证据 `commit=9d4662a` 为直接父。CI 只在 main push 触发，相邻 commit 常共享 tip run，本表仅登记指得出绿 run 的 commit；完成台账三数口径 17/8/9 本轮不变、无卡升 `已交付`。
- R-001 已按「红转绿就删行」移除：`19bc043` 重采后 `s2-evidence.json` 的 `b2Render.latency` 七字段齐备，`verify:evidence` 转绿。
- `983e63d` / `97c3b52` 的红是历史提交信息缺陷（R-002），不改写历史，仅登记；两笔仍在清单内，非活动。
- `fbd4a28` 的 `perf` 红已通过扩枚举修正；其树内容由 `05c94c1` 的绿 run 覆盖。
- `2ec7841` 的红因 P7 注册表滞后导致 `verify:card-pages` 判红（`S-05.01-02` 条件交付引用 `absent` 的 P7），属注册表历史滞后、**非代码缺陷**；P7 三列已按 §5.7 由 BA 落 `exists` 命中锚点，该红由本次修复提交的绿 run 覆盖，**不改写历史**（与 `fbd4a28`/`983e63d` 同构，不进 `aka-main-known-reds.csv`，该清单只登记 `verify:evidence` 裁定）；`f38fc5c` 自身 run `42634147774` 为 success。
- 本表由 `docs/qa/aka-main-known-reds.csv` 驱动判定，CI 步骤「已知红裁定」只放行清单内的红，清单转绿未删行会直接红。
- 2026-11-09 补记：`3213ae3`（此前漏记）及本轮 6 个 commit（`9d87f58`/`aec0785`/`3b71a57`/`e9725a5`/`36bba90`/`847fb51`）全部自身 run success，逐行补入上表；当前清单仅剩 R-002（`gate=history`，历史非活动），R-001 已转绿删行，判定仍由该清单驱动，无活动红。
- 2026-11-09 再补记：`172e337`（P7 注册表修正 + 台账收口）自身 run `42651697784` 的 attempt1 中 `macOS build / test / golden` job 被 runner 侧 cancelled（`steps` 为空、一个 step 未跑，非门禁红、非代码/文档缺陷），另两个 job（含 `verify:delivery`/`verify:gate-log`/`verify:sign`/`verify:sign-impact`）均 success；`gh run rerun --failed` 后 attempt2 三个 job 全 success、`conclusion=success`、`headSha=172e337d2bc7a8f9934dc2b428ea22daab3494cc` 精确匹配。该绿 run 覆盖 `2ec7841` 的红，不改写历史；`2ec7841` 仍不进 `aka-main-known-reds.csv`（该清单只管 `verify:evidence` 裁定）。
- 2026-11-10 补记：本轮连续逐卡取证 7 张（成功 4 张 `s080202`/`s070102`/`s050101`/`s060301`，不可判 5 张 `s030104`/`s030201`/`s030302`/`s020801`/`s060302` 失败记录按第 27/31 条留痕 `docs/qa/raw/`），TL `2594e97` 逐卡签 3 张（1 整卡 + 2 条件签）、QA 驳回 `S-05.01-01`；`2594e97` 的 run `42727743201` 为 failure，红因为台账状态词词表外写法、由本轮台账修复提交的绿 run 覆盖，不改写历史、不进 `aka-main-known-reds.csv`（该清单只管 `verify:evidence` 裁定）。
