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
| `ca87236` | docs(qa) 收口连续逐卡取证与逐卡签字状态（3 签入账 + 5 不可判留痕） | `42740511675` success | 自身 |
| `0672c18` | merge(app) 合入 W119 product-export-gaps（B） | 无独立 run（CI 仅 main push 触发，相邻 commit 共享 tip run） | `42763901338`（`ce260298`，树包含本提交） |
| `ce260298` | merge(app) 合入 W119 diag-runners-and-oracle（A） | `42763901338` success | 自身 |
| `ccfe544` | evidence(qa) 归档 s050101 取证失败记录 | `42765220017` success | 自身 |
| `8e0d3f2` | evidence(qa) 归档 s020801 运行层证据（1/1，P24 驳回不签） | `42765619492` **failure**（**红**：红因为提交信息缺 `Sign-Invalidates` 与 `连带修正` 两个行首直写 trailer，属提交信息缺陷、**非产品/证据缺陷**） | `42766367991`（`fe3bd30`，树包含本提交）及后续 tip 绿 run `42816552332`（`2e1d90c`）；不改写历史 |
| `fe3bd30` | evidence(qa) 归档 s060302 第 1 次置前失败记录 | `42766367991` success | 自身 |
| `7a624a6` | evidence(qa) 归档 s060302 运行层证据 4/4（P05 条件签依据） | `42766871620` success | 自身 |
| `0bfcf1a` | docs(qa) 裁定 4.7.101（归档提交只写事实、纠结论不删档案） | `42766973271` success | 自身 |
| `61b812a` | evidence(qa) 归档 s030104 取证失败记录 | `42767698013` success | 自身 |
| `91942de` | evidence(qa) 归档 s030201 取证失败记录 | `42768946463` success | 自身 |
| `a5ec7f5` | evidence(qa) 归档 s030302 运行层证据 5/5（P03 条件签依据） | `42769360154` success | 自身 |
| `41dcfac` | evidence(qa) 归档 s060301 运行层证据 4/4（P04 原签失效改绑依据） | `42769907582` success | 自身 |
| `532c88e` | merge(app) 合入 W119c 三张不可判卡修复（C） | `42778666541` success | 自身 |
| `f10e077` | evidence(qa) 归档 s050101 运行层证据 6/6（P14 条件签依据） | `42783935668` success | 自身 |
| `bc19f9f` | evidence(qa) 归档 s030104 运行层证据 6/6（P01 条件签依据） | `42784783160` success | 自身 |
| `3b12483` | evidence(qa) 归档 s030201 取证产物留痕（套件产出名与冻结白名单冲突） | `42801520952` success | 自身 |
| `669cc55` | merge(app) 合入 W119d s030201 写盘名与冻结白名单解冲突（D） | `42804740799` success | 自身 |
| `9a923c2` | evidence(qa) 归档 s030201 新产出名取证留痕 | `42805716338` success | 自身 |
| `f9ccb22` | merge(app) 合入 W119e s030201 AC 标签映射修正（E，P02 条件签 sign_commit） | `42809938913` success | 自身 |
| `0e654c4` | evidence(qa) 采集 S-03.02-01 运行层 GUI 证据 8/8 | `42810492583` **failure**（**红**：红因提交信息把 `连带修正：…`/`Sign-Invalidates: none` 写成 `- ` 前缀列表项，`verify:delivery` 规则 6 以行首 `^` 锚定判缺两 trailer，属提交信息缺陷、**非产品/证据缺陷**） | `42816552332`（`2e1d90c`，新 HEAD 绿 run、树包含本提交）；红 run 已由 TL 在 `aka-ci-sign-ledger` `cancelled_runs` 登记，不改写历史 |
| `2e1d90c` | sign(qa) TL 按 QA G4 总表逐卡条件签 6 张、P24 驳回留痕（tip） | `42816552332` success（headSha 精确匹配） | 自身 |

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

- 2026-11-10 补记（BA 收口）：本批 dev 五轮修复 W119 A–E（`ce260298`/`0672c18`/`532c88e`/`669cc55`/`f9ccb22`，另有 `c38252e`/`4534965`/`bc4cb7a`/`7aab477`/`75c4db0`/`0b9abb8`/`d8043f1`/`6d1ad9e`/`a3c0dbf` 等 dev 内部 commit）与 7 张逐卡取证的 commit→run 按 `git log` + `gh run list --branch main` 实查补入上表，run id 均为真实 CI run、未编造；`0672c18` 及上列无独立 run 的 dev commit 按「相邻 commit 共享后续 tip 绿 run」口径覆盖（CI 只在 main push 触发）。
- 2026-11-10 补记：**两笔 failure 的红因均为提交信息缺陷、非产品/证据缺陷**——`42810492583`（`0e654c4`）与 `42765619492`（`8e0d3f2`）都因提交信息缺 `Sign-Invalidates:` 与 `连带修正：` 两个**行首直写** trailer（写成 `- ` 前缀列表项不算行首），由 `verify:delivery` 规则 6 判红（实查失败 job「签字覆盖台账」日志：`触碰 gate-log / 签字台账 / 证据，但提交信息缺 Sign-Invalidates:` + `触碰签字产物，但提交信息缺「连带修正：文件 L行 原值→新值」`）。两笔红 run 均由后续绿 run（树包含该提交的 tip run `42816552332` 等）覆盖，**不改写历史**、**不进 `aka-main-known-reds.csv`**（该清单只登记 `verify:evidence` 裁定）；`0e654c4` 红 run 已由 TL `2e1d90c` 在 `aka-ci-sign-ledger` 的 `cancelled_runs` 以 `42810492583@0e654c4563c992a2d3e32a7a6ed70d71d383efed` 登记并点名红因与覆盖关系。TL `2e1d90c` 用行首直写 `连带修正：…` + `Sign-Invalidates: none` 转绿（`42816552332` success）。
- 2026-11-10 流程教训：**`连带修正：<文件> L<行> <原值> → <新值>`（逐项）与 `Sign-Invalidates: none` 必须行首直写、不得带 `- ` 前缀**；证据提交 `0e654c4` 因 `- ` 前缀判红、TL `2e1d90c` 用行首直写转绿。本批 BA 收口提交沿用行首直写格式。
