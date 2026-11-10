# AKA 重排 · EP-07 前端基座 · Story 卡 v1.0

| 项目 | 内容 |
|---|---|
| Epic | **EP-07 前端基座**（首屏主题、三态切换、涨跌色、密度、数字格式、SIM 标识） |
| 不在本 Epic | 不改业务页面布局与数据流（EP-05/EP-06 已定）、不改后端、不做设置页改版 |
| 卡数 / 点数 | **6 张，全部 P0；19 故事点** |
| 编写规则 | 《Story 卡编写规则》：标题动宾 / 产品三句话 / Given-When-Then / 优先级·故事点 / 依赖备注 / DoD |
| 编号规则 | `S-EP07-kk`。EP-05 = 编排/缓存/DTO，EP-06 = IPC 契约层，EP-07 = 前端基座；**`E-01…E-08` 是模块编号**，每卡头部标 `模块编号 + 原卡号` |
| 落点基准 | `main@3192b76`（worktree `AKA-ep0507`，分支 `ep0507/story-cards`） |
| 代码状态 | 已实现 4 张 / **部分实现 1 张**（`S-EP07-05` 门禁覆盖不全）/ **未实现 1 张**（`S-EP07-01` 首屏预置） |
| blocked | 2 项（`B-07-01` 首屏内联脚本与 CSP 收紧、`B-07-02` 字节/时长格式口径），均**不阻塞开工** |

---

## 0. 口径锁定（本 Epic 内禁止再讨论的既有事实）

| 事实 | 现值 | 出处 |
|---|---|---|
| 根节点初始属性 | `<html lang="zh-CN" data-theme="dark" data-colormode="redUp">`，**硬编码** | `app/index.html:2` |
| 主题色板 | `:root` 是深色（1-29 行）；只有 `html[data-theme="light"]`（31-55 行）覆盖 | `app/src/styles/tokens.css` |
| 涨跌色别名 | `--up/--down` 按主题定义；`--rise/--fall` 按 `data-colormode`；`--pos/--neg` 再别名（74-76） | `tokens.css:42-76` |
| 缺属性兜底 | `:root, html[data-colormode="redUp"]` 共享一个块（58-59），故缺 `data-colormode` 时按 redUp 渲染 | `tokens.css:58-64` |
| 语义类 | `.pos { color: var(--pos) }` / `.neg { color: var(--neg) }` / `.flat { color: var(--text2) }` | `app/src/styles/app.css:1291-1293` |
| 主题持久化 | `aka.theme` 存**模式**（含 `system`），`aka.colorMode` 存 `redUp`/`greenUp` | `app/src/lib/theme.ts:4-35` |
| 主题副作用时机 | 只在 `useEffect` 里调 `applyTheme`，即**首帧之后** | `app/src/App.tsx:60` |
| 系统变化监听 | `themeMode === "system"` 时绑 `matchMedia("(prefers-color-scheme: dark)")` 的 `change`，回调内**重新查询** `systemPrefersDark()` | `App.tsx:63-65` |
| 密度常量 | `ROW_HEIGHT = { compact: 28, comfy: 34 }` | `app/src/lib/settings.ts:13` |
| 密度 CSS | `--row-h: 28px`（compact）/ `34px`（comfy） | `app.css:36-42` |
| 密度消费点 | `height: var(--row-h)` 3 处（563 / 1490 / 3630） | `app.css` |
| 密度事件 | `applyDensity` 写 `dataset.density` + 派发 `aka:density` | `settings.ts:29-32` |
| 格式出口 | `format.ts` 头注释写「所有金额/量/涨跌文本只从这里出」，自身 5 行 `toFixed` | `app/src/lib/format.ts:1-92` |
| `toFixed` 存量 | **54 行 / 76 次**：features 39 行、lib 7 行、components 4 行、pages 4 行 | 本次逐文件统计 |
| 格式门禁 | `verify-number-format.mjs` **只扫 `src/components`**（4 处白名单），且 `verify:format` **未接入 `ci.yml`** | `app/scripts/verify-number-format.mjs`、`ci.yml:126-180` |
| SIM 徽标 | `SimBadge` 无 `simulated` 入参，恒显示；三处调用均 `<SimBadge />` | `app/src/components/SimBadge.tsx:5-11`、`MarketPage.tsx:438`、`IndexPage.tsx:96`、`WorkbenchPage.tsx:1994` |
| 模拟标志来源 | `MarketSnapshotDto.simulated`（`dto.rs:449`）、`BarsResponse.provenance.simulated`（`ProvenanceDto.simulated`，`dto.rs:119`） | `app/crates/app-core/src/dto.rs` |
| 类型门禁 | `npm run typecheck` = `tsc --noEmit`；CI 有 `npx tsc --noEmit` 与 `npm run build` | `package.json`、`ci.yml:181-185` |

> 全部 6 张卡都可用 Node 22 直接取证（`node` 原生支持 `.ts` 类型剥离），已实测 `import("../src/lib/theme.ts")` 与 `format.ts` 可用。

---

## S-EP07-01 · 首帧前预置主题与涨跌色，消除错色闪烁

- 模块编号：E-05 设置与主题 ｜ 原卡号：`S-06.01-01`（拆分）
- 优先级：P0 ｜ 故事点：3 ｜ 依赖：`S-EP07-02`（同算法，先有 `resolveTheme` 口径）
- 负责人：待 Sprint 规划指派 ｜ 备注：**未实现**。现状浅色用户首帧一定是深色、绿涨用户首帧一定是红涨

**用户故事（产品）**
作为用浅色主题的用户，我希望打开应用的第一帧就是浅色，
以便启动时不会先闪一片黑再变白。

**验收标准（BA）**
- 给定 `index.html:2`，当 读 `<html>` 标签，则 只剩 `lang`，**不再**含 `data-theme` / `data-colormode`
- 给定 `index.html`，当 读文档结构，则 `<head>` 内、`</head>` 之前存在一段内联 `<script>`，且它在 `<div id="root">` 之前执行
- 给定 该内联脚本，当 静态检查，则 同时满足：读 `localStorage.getItem("aka.theme")`、读 `localStorage.getItem("aka.colorMode")`、含 `matchMedia("(prefers-color-scheme: dark)")`、整体包在 `try { … } catch { … }` 内
- 给定 用桩 `localStorage` 执行该脚本，当 键为空，则 `documentElement.dataset` = `{ theme: "dark", colormode: "redUp" }`
- 给定 `aka.theme="light"`、`aka.colorMode="greenUp"`，当 首帧执行，则 `dataset` = `{ theme: "light", colormode: "greenUp" }`
- 给定 `aka.theme="system"`、系统 `prefers-color-scheme: dark = false`，则 `dataset.theme = "light"`
- 给定 `localStorage.getItem` 抛异常，则 脚本不抛出，`dataset` 回落 `{ theme: "dark", colormode: "redUp" }`，页面继续渲染
- 给定 `node app/scripts/verify_boot_theme.mjs`，当 运行，则 上述 6 组输入逐一断言通过，退出码 0

**技术决定（TL · 开发期不再讨论）**
- 落点：`app/index.html:2-7`，插入位置在 `<meta name="viewport">` 之后、`<title>` 之前；脚本必须**同步**执行（无 `async`/`defer`/`type="module"`）
- 脚本内容固定为（语义等价即可，不引入任何依赖、不引用 `/src`）：
  ```html
  <script>
    (function () {
      var theme = "dark", color = "redUp";
      try {
        var m = localStorage.getItem("aka.theme");
        if (m === "light" || m === "dark") theme = m;
        else if (m === "system") theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
        if (localStorage.getItem("aka.colorMode") === "greenUp") color = "greenUp";
      } catch (e) {}
      document.documentElement.setAttribute("data-theme", theme);
      document.documentElement.setAttribute("data-colormode", color);
    })();
  </script>
  ```
- 与 `theme.ts` 的一致性约束：解析规则必须与 `resolveTheme`（`theme.ts:22-27`）和 `loadColorMode`（`theme.ts:14-16`）逐条等价；`theme.ts` 是唯一真相，内联脚本是它在解析前的**镜像**，两边改动必须同 PR
- 用法差异：内联脚本用 `setAttribute` 而非 `dataset`（避免依赖 `dataset` 的兼容性假设）；`applyTheme` 后续写 `dataset`，两者写同一组属性，互不冲突
- 门禁契约（新建 `app/scripts/verify_boot_theme.mjs`）：
  1. 读 `index.html`，断言 `/<html[^>]*>/` 不含 `data-theme`、`data-colormode`
  2. 断言 `indexHtml.indexOf("<script>") < indexHtml.indexOf('<div id="root">')`，且脚本段在 `</head>` 之前
  3. 用 `/<script>([\s\S]*?)<\/script>/` 抽出脚本源码，`node:vm` 的 `runInNewContext` 执行，上下文注入 `localStorage`/`document.documentElement.setAttribute`/`window.matchMedia` 桩
  4. 6 组输入：`{}`、`{theme:"light"}`、`{theme:"dark"}`、`{theme:"system"}` + 系统浅/深、`{colorMode:"greenUp"}`、`localStorage` 抛错
  5. 退出码 0/1，失败逐组打印期望/实际
- 不做：不引 `js-cookie`/`zustand`/任何主题库；不在 `main.tsx` 里补第二套预置；不改 `applyTheme` 的签名

**可致红反例（QA）**
1. 删除整段内联脚本 → AC1/AC8 红（`<html>` 仍无属性，且脚本不存在）
2. 把键名写成 `"theme"`（丢 `aka.` 前缀）→ AC5/AC8 红（读不到，回落 dark）
3. 把 `system` 分支写成 `theme = "system"` → AC6/AC8 红（CSS 无 `[data-theme="system"]`，落到 `:root` 深色）
4. 把 `try/catch` 去掉且桩 `localStorage` 抛错 → AC7/AC8 红（脚本中断，后续 `setAttribute` 不执行）
5. 在 `<html>` 上保留 `data-theme="dark"` 并让脚本只覆盖 `colormode` → AC1 红

**Task 拆解（Dev）**
1. 改 `index.html`：`<html lang="zh-CN">`，插入内联脚本
2. 新建 `app/scripts/verify_boot_theme.mjs`（6 组断言 + 静态结构断言）
3. `package.json` 加 `"verify:boot-theme": "node scripts/verify_boot_theme.mjs"`；`ci.yml` node 段加 `run: npm run verify:boot-theme`
4. 在 `theme.ts:29` 的 `applyTheme` 上方补注释：「首帧预置与 `resolveTheme` 必须逐条等价，见 `index.html` 内联脚本」
5. 手工核对：dev（Vite 注入样式）与 `npm run build` 产物（`<link>` 在 head）两种形态下首帧 `dataset` 均正确

**完成定义 DoD**
单测通过（脚本 6 组退出 0）· 联调通过（dev + build 各一次首帧核对）· 产品验收 · 文档更新（`theme.ts` 注释 + `index.html` 单行注释说明镜像关系）

---

## S-EP07-02 · 固化三态主题矩阵与系统切换订阅

- 模块编号：E-05 设置与主题 ｜ 原卡号：`S-06.01-01`（拆分）
- 优先级：P0 ｜ 故事点：3 ｜ 依赖：`S-EP07-01`（首帧预置共用解析规则）
- 负责人：待 Sprint 规划指派 ｜ 备注：三态已实现，但「系统变化」与「手动切换」是两套写 DOM 的路径，且无矩阵断言

**用户故事（产品）**
作为跟随系统的用户，我希望白天切到浅色、晚上切到深色都自动生效，而且我手动选过的主题不会被系统抢走。

**验收标准（BA）**
- 给定 `applyTheme("system", "greenUp")` 且系统深色，当 调用，则 `dataset` = `{ theme: "dark", colormode: "greenUp" }`，`localStorage["aka.theme"]` = `"system"`（**存模式，不存解析结果**）
- 给定 `applyTheme("light", "redUp")`，则 `dataset.theme = "light"`，`localStorage["aka.theme"]` = `"light"`
- 给定 `themeMode="system"` 且派发 `change` 事件且 `event.matches = true`，当 回调执行，则 `dataset.theme = "dark"`，且回调**不重新调用** `matchMedia`（用事件自身的 `matches`）
- 给定 用户从 `system` 切到 `light` 后再派发 `change`（`matches = true`），则 `dataset.theme` 仍为 `"light"`（监听已解绑）
- 给定 `localStorage["aka.theme"]="weird"`，则 `loadThemeMode()` 返回 `"dark"`；`localStorage["aka.colorMode"]="RedUp"` 则 `loadColorMode()` 返回 `"redUp"`
- 给定 `node app/scripts/verify_theme.mjs`，当 运行，则 3 模式 × 2 配色 × 系统浅/深 = 覆盖 6 组主矩阵 + 3 组边界（非法值、解绑、事件取值），退出码 0

**技术决定（TL · 开发期不再讨论）**
- 落点：`app/src/lib/theme.ts:1-35`（纯函数，保持零依赖、零 React）；`app/src/App.tsx:58-68`（唯一订阅点）
- `App.tsx` 的 effect 改为：
  - `applyTheme(themeMode, colorMode)` 负责写两个属性 + 持久化（唯一写 `dataset.theme` 的入口）
  - `themeMode === "system"` 时追加 `const mq = window.matchMedia("(prefers-color-scheme: dark)"); const onChange = (e: MediaQueryListEvent) => { document.documentElement.dataset.theme = e.matches ? "dark" : "light"; }; mq.addEventListener("change", onChange); return () => mq.removeEventListener("change", onChange);`
  - 监听回调**只写 `dataset.theme`**，不写 `localStorage`（模式仍为 `system`，这是正确的：用户没换模式）
- 禁止：在回调里调 `systemPrefersDark()` 重新查询（事件已带 `matches`，重复查询在快速切换时可能读到新值，造成一帧错色）
- 门禁契约（新建 `app/scripts/verify_theme.mjs`，Node 22 直接 `import("../src/lib/theme.ts")`，已实测可用）：
  1. 桩：`window.matchMedia` 返回可配置 `matches` 的假 MQL，记录 `addEventListener`/`removeEventListener` 调用次数；`document.documentElement.dataset` 为普通对象；`localStorage` 为 Map 包装
  2. 断言 6 组主矩阵的 `dataset` + `localStorage` 双结果
  3. 断言 `applyTheme` 在 `system` 下 `localStorage["aka.theme"] === "system"`
  4. 断言非法值回落（`"weird"` → `dark`；`"RedUp"` → `redUp`）
  5. `App.tsx` 的监听用**文本断言**：`/addEventListener\("change"/` 存在、`/removeEventListener\("change"/` 存在、`/e\.matches/` 存在、`/systemPrefersDark\(\)/` 在该回调块内**不出现**
  6. 退出码 0/1
- 不做：不引 `react-use`/`use-media-query`；不把主题放进 React Context（当前 2 个 props 已够，改成 Context 会牵动 `AppShell` 与 `WorkbenchPage` 的 6 处 props）；不新增第四个模式（如 `"auto"`）

**可致红反例（QA）**
1. `theme.ts:33` 改成 `localStorage.setItem(THEME_KEY, resolved)` → AC1 红（存成 `"dark"`，用户的 `system` 选择丢失）
2. 删掉 `App.tsx` effect 的 `return () => mq.removeEventListener(...)` → AC4 红（切到 light 后被系统覆盖）
3. 监听回调改回 `dataset.theme = systemPrefersDark() ? "dark" : "light"` 且桩的初始 `matches=false`、事件 `matches=true` → AC3 红（读到 false，写成 light）
4. `loadColorMode` 改成 `return localStorage.getItem(COLOR_KEY) === "redUp" ? "greenUp" : "redUp"` → AC5 红（默认翻转）
5. 删掉 `resolveTheme` 的 `if (mode === "system")` 分支 → AC1 红（`dataset.theme = "system"`）

**Task 拆解（Dev）**
1. 新建 `app/scripts/verify_theme.mjs`（Node 22 直跑 `.ts`，含 9 组断言）
2. 改 `App.tsx:63-65` 为 `e.matches` 版本 + 保留 cleanup
3. `package.json` 加 `"verify:theme"`；`ci.yml` 加 `run: npm run verify:theme`
4. `theme.ts:1` 头注释补「三态矩阵由 `scripts/verify_theme.mjs` 守，改动需同步 `index.html` 内联脚本」

**完成定义 DoD**
单测通过（脚本 9 组退出 0）· 联调通过（系统深浅切换实测一次）· 产品验收 · 文档更新（`theme.ts` 头注释）

---

## S-EP07-03 · 涨跌配色只换语义变量，禁止组件硬编码色值

- 模块编号：E-05 设置与主题 ｜ 原卡号：`S-06.01-02`
- 优先级：P0 ｜ 故事点：3 ｜ 依赖：无（可与 `S-EP07-01` 并行）
- 负责人：待 Sprint 规划指派 ｜ 备注：已实现且组件层当前零色值，本卡是**加锁**，防止后续页面各写一套红绿

**用户故事（产品）**
作为习惯绿涨红跌的用户，我希望切换配色时全站（列表、图表、读数）一起变，
以便不会出现列表绿涨、图表还红涨的混搭。

**验收标准（BA）**
- 给定 `tokens.css`，当 搜索 `#c8342b` / `#0f7b54` 等涨跌色值，则 只出现在 `--up` / `--down` 的定义行，**不得**出现在 `.pos` / `.neg` / 任何选择器色值位置
- 给定 `html[data-colormode="greenUp"]`，当 解析 `--rise`，则 等于 `--down` 的值；`redUp` 下 `--rise` 等于 `--up`
- 给定 缺失 `data-colormode`，则 按 redUp 渲染（`:root` 与 `redUp` 共享一块，`tokens.css:58-59`）
- 给定 `app.css:1291-1293`，则 `.pos` 用 `var(--pos)`、`.neg` 用 `var(--neg)`、`.flat` 用 `var(--text2)`，三者不得互换
- 给定 `app/src/**/*.{ts,tsx}`，当 搜索 `#` + 6 位十六进制、`rgb(`、`color: "red"|"green"`，则 **0 命中**（现状 0，作为回归锁）
- 给定 组件需要涨跌色，则 只能走 `signClass()`（`format.ts:81-84`）产出 `pos|neg|flat` 三值之一的 className，不得内联 `style.color`
- 给定 `node app/scripts/verify_tokens.mjs`，当 运行，则 上述 5 项全通过，退出码 0

**技术决定（TL · 开发期不再讨论）**
- 落点：`app/src/styles/tokens.css:42-76`（色值与三层别名）、`app/src/styles/app.css:1291-1293`（语义类）、`app/src/lib/format.ts:81-84`（`signClass`）
- 三层变量职责（写死）：`--up/--down` = 主题色板（随 `data-theme` 变）；`--rise/--fall` = 语义方向（随 `data-colormode` 变）；`--pos/--neg` = 消费别名（组件/图表只用这一层）
- 图表例外：SVG 内 `stroke` / `fill` 允许直接 `var(--pos)` / `var(--neg)`，**不允许** `var(--up)` / `var(--down)`（否则切换配色时图表不变色）
- 门禁契约（新建 `app/scripts/verify_tokens.mjs`）：
  1. 解析 `tokens.css`，抓 `--up:` / `--down:` 的十六进制值，断言其出现次数 = 主题块数 × 2（deep + light 各一次），且不出现在其它选择器的声明值中
  2. 断言存在 `html[data-colormode="greenUp"]` 块，且块内 `--rise: var(--down)`、`--fall: var(--up)`
  3. 断言 `:root { --pos: var(--rise); --neg: var(--fall) }`
  4. 断言 `app.css` 的 `.pos`/`.neg`/`.flat` 三条声明逐字匹配
  5. 扫 `app/src/**/*.{ts,tsx}`：`/#[0-9a-fA-F]{6}\b/`、`/rgba?\(/`、`/color:\s*["']?(red|green)/` 命中数必须为 0（`tokens.css`/`app.css` 除外）
  6. 退出码 0/1，失败打印文件:行
- 不做：不引 Tailwind（会绕过 tokens）；不新增第三套配色（如 `"blueUp"`）；不改 `signClass` 的三值契约（`format.ts` 已冻结，`EP-08` 三态卡依赖它）

**可致红反例（QA）**
1. 在 `app/src/features/market/MarketRow.tsx` 加 `style={{ color: "#c8342b" }}` → AC5 红
2. 把 `tokens.css:67` 的 `--rise: var(--down)` 改成 `var(--up)` → AC2 红（`greenUp` 与 `redUp` 渲染相同）
3. 把 `.flat` 改成 `color: var(--muted)` → AC4 红
4. 删除 `tokens.css:74-76` 的 `--pos/--neg` 别名 → AC4 红（`var(--pos)` 无定义，涨跌文字回退成继承色）
5. 在 `CandleChart.tsx` 用 `stroke="var(--up)"` → AC5 不红但 AC2 的图表约束红（脚本站点 2 的白名单解析）

**Task 拆解（Dev）**
1. 新建 `app/scripts/verify_tokens.mjs`（6 条检查，含 CSS 变量解析与 TSX 色值扫描）
2. `package.json` 加 `"verify:tokens"`；`ci.yml` 加 `run: npm run verify:tokens`
3. 逐个核对 `CandleChart.tsx` / `IndicatorReadouts.tsx` 的 SVG 着色确实走 `--pos/--neg`（若不满足则改，属于本卡范围）
4. `tokens.css:57` 的注释补一句「三层别名职责：--up/--down 主题、--rise/--fall 方向、--pos/--neg 消费」

**完成定义 DoD**
单测通过（脚本 6 条退出 0）· 联调通过（切换配色后人工核对列表+图表+读数）· 产品验收 · 文档更新（`tokens.css` 注释）

---

## S-EP07-04 · 密度两档与行高常量单一来源

- 模块编号：E-05 设置与主题 ｜ 原卡号：`S-06.02-01`（拆分）
- 优先级：P0 ｜ 故事点：3 ｜ 依赖：无
- 负责人：待 Sprint 规划指派 ｜ 备注：TS 常量与 CSS 变量各写一份 28/34，无任何一致性校验

**用户故事（产品）**
作为用小屏笔记本的用户，我希望切到紧凑后每一行都真的变矮，
以便同屏能多看几行而不会出现「行高变了但文字被裁」的错位。

**验收标准（BA）**
- 给定 `settings.ts:13`，则 `ROW_HEIGHT` 恰为 `{ compact: 28, comfy: 34 }`
- 给定 `app.css:37/41`，则 `--row-h` 在 `[data-density="compact"]` 下为 `28px`、`comfy` 下为 `34px`，且与 `ROW_HEIGHT` 数值逐一相等
- 给定 行高消费点，则 只有 `var(--row-h)` 三处（`app.css:563/1490/3630`），页面 tsx 中无 `height: 28`/`34` 之类硬编码
- 给定 `applyDensity("comfy")`，则 `documentElement.dataset.density = "comfy"`，且派发 `aka:density` 事件，`event.detail === "comfy"`
- 给定 `currentDensity()` 在无 `data-density` 时，则 返回 `"compact"`；`sanitizeDisplay({density:"loose"})` 返回 `{density:"compact"}`
- 给定 `data-density="comfy"`，则 `app.css:2100` 的 `.wl-row-main` 覆盖块存在（自选行在舒适档单独加高）
- 给定 `node app/scripts/verify_density.mjs`，当 运行，则 上述 6 项通过，退出码 0

**技术决定（TL · 开发期不再讨论）**
- 落点：`app/src/lib/settings.ts:4-32`（常量与事件）、`app/src/styles/app.css:36-42`（CSS 变量）、`:563/:1490/:3630`（消费）、`:2100`（舒适档覆盖）
- 单一来源方向：**TS 常量是权威**，CSS 是它的镜像；不允许反向（CSS 无法被 TS 读取，且 `settings.ts` 导入 `./ipc`，无法在 Node 里直接 import）
- 因此 `settings.ts` **不拆分**（拆出 `density.ts` 属于为测试重构，超出本卡），门禁改为**静态解析**：
  1. 正则 `/ROW_HEIGHT[^=]*=\s*\{\s*compact:\s*(\d+),\s*comfy:\s*(\d+)\s*\}/` 抓 TS 常量
  2. 正则 `/--row-h:\s*(\d+)px/` 抓 CSS 两处，按出现顺序对应 compact/comfy
  3. 断言两组数值相等，并断言 `--row-h` 只出现在 `[data-density=...]` 两个块内
  4. 断言 `app/src/**/*.tsx` 中 `/height:\s*(28|34)\b/` 命中 0
  5. 断言 `applyDensity` 函数体内同时含 `dataset.density` 与 `dispatchEvent`
  6. 断言 `app.css` 含 `:root[data-density="comfy"] .wl-row-main`
  7. 退出码 0/1
- 默认档：`compact`（`DEFAULT_DISPLAY`，`settings.ts:15`），首帧无 `data-density` 时走 `:root` 缺省；CSS 在 `:root[data-density="compact"]` 才定义 `--row-h`，故无属性时 `var(--row-h)` **无值**——这是现状缺陷，本卡要求 `:root` 也定义 `--row-h: 28px` 作为兜底
- 不做：不新增第三档（`"spacious"`）；不把密度存 localStorage（已经走 `viewState`，改存储会分裂）；不改 `ROW_HEIGHT` 的值

**可致红反例（QA）**
1. 把 `app.css:37` 改成 `--row-h: 30px` → AC2 红
2. 把 `ROW_HEIGHT.comfy` 改成 `36` → AC2 红
3. 在 `MarketPage.tsx` 写 `style={{ height: 28 }}` → AC3 红
4. 删掉 `applyDensity` 里的 `dispatchEvent` → AC4 红（监听方静默失效）
5. 删掉 `:root` 的 `--row-h` 兜底 → AC2 红（首帧无 `data-density` 时行高塌陷）

**Task 拆解（Dev）**
1. `app.css:36` 前补 `:root { --row-h: 28px; }` 兜底
2. 新建 `app/scripts/verify_density.mjs`（7 条静态检查）
3. `package.json` 加 `"verify:density"`；`ci.yml` 加 `run: npm run verify:density`
4. `settings.ts:12` 注释补「CSS `--row-h` 是本常量的镜像，改一处必须改两处，门禁 `verify_density.mjs`」

**完成定义 DoD**
单测通过（脚本 7 条退出 0）· 联调通过（两档切换各看一屏）· 产品验收 · 文档更新（`settings.ts` 注释）

---

## S-EP07-05 · 收敛数字格式到单一出口并扩大门禁覆盖

- 模块编号：E-05 设置与主题（主）/ E-02 个股工作台 ｜ 原卡号：`S-06.02-01`（拆分）
- 优先级：P0 ｜ 故事点：4 ｜ 依赖：`S-EP07-04`（同一批 `format:*` 门禁）
- 负责人：待 Sprint 规划指派 ｜ 备注：**部分实现**。`format.ts` 头注释已写「只从这里出」，但门禁只扫 `components`，且 `verify:format` 从未在 CI 运行

**用户故事（产品）**
作为核对行情的用户，我希望列表、图表读数、安装页的数字长得一致，
以便不会同一屏里出现 `1.2万手` 和 `12345.67手` 两种写法。

**验收标准（BA）**
- 给定 全仓 `app/src`，当 统计 `toFixed(` 行数，则 基线为 **54 行 / 76 次**；本卡完成后降为 **50 行**（`changePct.ts` −2、`InstallPage.tsx` −3、`SettingsPage.tsx` −1，`format.ts` 新增 `formatBytes`/`formatDuration` 各 +1）
- 给定 `lib/changePct.ts:11-15`，则 `expectedChangePctText` 直接返回 `formatPct(value)`，自身**不再含** `toFixed`
- 给定 `formatPct`，则 形参放宽为 `value: number | null | undefined`，`null`/`NaN`/`Infinity` 一律返回 `—`，`0` 返回 `0.00%`（无正负号）
- 给定 `formatPct(0.0123)`，则 返回 `+0.01%`；`formatPct(1.23)` 返回 `+1.23%` —— **入参是百分数，不是比率**（现状即此，写死不再讨论）
- 给定 `InstallPage.tsx:29,34,35` 与 `SettingsPage.tsx:25-32`，则 字节/时长格式化改为 `formatBytes` / `formatDuration`，行为统一为 **1024 进制、1 位小数**（`1536 → 1.5 KB`、`90_000 → 1分30秒`）
- 给定 `verify-number-format.mjs`，则 扫描范围从 `src/components` 扩到 `src/{components,pages,features,lib}`；白名单为「4 处 SVG 几何精确行 + `*Diag.ts` 整文件豁免」
- 给定 `npm run verify:format`，当 运行，则 退出码 0；且该命令已出现在 `ci.yml` 中（现状缺失）
- 给定 `npm run typecheck`，则 `tsc --noEmit` 通过（`formatPct` 形参放宽不得引入 `any`）

**技术决定（TL · 开发期不再讨论）**
- 落点：`app/src/lib/format.ts:1-92`（新增两个函数、放宽一个形参）、`app/src/lib/changePct.ts:11-15`（改为委托）、`app/src/pages/install/InstallPage.tsx:29,34,35`、`app/src/pages/settings/SettingsPage.tsx:25-32`、`app/scripts/verify-number-format.mjs`
- 新增函数签名（写死）：
  - `export function formatBytes(bytes: number): string` —— `<1024` → `N B`；`<1024²` → `x.x KB`；`<1024³` → `x.x MB`；否则 `x.x GB`；非有限值 → `—`
  - `export function formatDuration(ms: number): string` —— `<1000` → `N ms`；`<60_000` → `x.x s`；否则 `m分s秒`（秒取整）；非有限值 → `—`
- `formatPct` 形参放宽的实现：`if (value == null || !Number.isFinite(value)) return DASH;`（`Number.isFinite(null)` 本身为 false，加 `== null` 只为让类型收窄，不改变行为）
- 白名单机制保持**精确行匹配**（现有 `verify-number-format.mjs` 的做法），不改成正则通配：白名单要能随行号漂移报红，才逼着改的人回来看一眼
- 扩展扫描后必须**排除**：`app/src/**/*Diag.ts`、`app/src/**/diag.ts`（39 行证据断言文本，故意用 `toFixed` 对齐 DOM 字符串）；以及以下 4 行 SVG 几何：`CandleChart.tsx:104/867/955`、`IndicatorReadouts.tsx:47`
- 不做：不改 `formatVolume` 的「股→手÷100」口径；不把 `formatCompact` 的下标（`format.ts:55` 标注「兼容旧调用」）删掉（仍有调用方）；不引入 `Intl.NumberFormat` 替换 `fixedAbs`（会改变千分位与全角符号，破坏既有 DOM 证据）

**可致红反例（QA）**
1. 在 `MarketPage.tsx` 写 `row.close.toFixed(2)` → 扩展后的 AC6 红（`pages/` 无白名单）
2. 把 `expectedChangePctText` 改回自带 `toFixed(2)` → AC2 红（`lib/changePct.ts` 不在白名单）
3. 把 `formatPct` 默认 `digits` 改 3 → `verify-r03-three-state.mjs` 红（期望 `+1.23%` 实得 `+1.230%`）
4. `formatBytes(1536)` 用 1000 进制 → AC5 红（得 `1.5 KB`? 1000 进制也是 1.5，改用 `formatBytes(1024)`：期望 `1.0 KB`，实得 `1.0 KB`… 故反例改为 `formatBytes(1023)` 期望 `1023 B`，1000 进制会得 `1.0 KB` → 红）
5. 从 `ci.yml` 删除 `verify:format` 步骤 → AC7 红

**Task 拆解（Dev）**
1. `format.ts` 新增 `formatBytes` / `formatDuration`，放宽 `formatPct` 形参；`format.ts:7` 头注释补两条口径
2. `changePct.ts` 改为 `import { formatPct } from "./format"` 并委托，删除本地 `DASH`/`MINUS`/两处 `toFixed`
3. `InstallPage.tsx` / `SettingsPage.tsx` 改用新函数，删除本地 `formatBytes`
4. `verify-number-format.mjs`：扫描根改为数组 `["components","pages","features","lib"]`；新增 `IGNORE_FILE = /(^|\/)(diag|[A-Za-z]*Diag)\.tsx?$/`；把 4 行几何白名单按「文件:精确行内容」登记
5. `ci.yml:126-180` 补 `run: npm run verify:format`（该 npm script 已存在，只是从未被 CI 调用）
6. 跑 `npm run verify:format && npm run verify:r03-three-state`（若脚本名不同，以 `package.json` 实际 key 为准）取证

**完成定义 DoD**
单测通过（`verify:format` 退出 0、`verify-r03-three-state` 不回归、`tsc --noEmit` 通过）· 联调通过（安装页/设置页/工作台各看一处数字）· 产品验收 · 文档更新（`format.ts` 头注释）

---

## S-EP07-06 · SIM 常驻标识改由数据源模拟标志驱动

- 模块编号：E-07 数据源与模拟环境 ｜ 原卡号：`S-07.02-01`
- 优先级：P0 ｜ 故事点：3 ｜ 依赖：`S-EP06-02`（`simulated` 字段已冻结在 DTO）
- 负责人：待 Sprint 规划指派 ｜ 备注：现实中三处 `simulated` 数据都已拿到（`snapshot`/`bars.provenance`），但组件恒显、不读字段

**用户故事（产品）**
作为验收同事，我希望只在数据确实是模拟的时候看到 SIM 角标，
以便将来接真实数据源后，界面不会继续谎称「非真实市场数据」。

**验收标准（BA）**
- 给定 `SimBadge` 的 `Props`，则 `simulated: boolean` 为**必填**，无默认值；`simulated === false` 时组件返回 `null`
- 给定 `MarketPage.tsx:438`，则 传参来自 `snapshot.simulated`（`MarketSnapshotDto.simulated`），不得传字面量
- 给定 `WorkbenchPage.tsx:1994`，则 传参来自 `bars.provenance.simulated`（`BarsResponse.provenance.simulated`），不得传字面量
- 给定 `IndexPage.tsx:96`，则 传 `simulated` 常量 `true` 并带 `TODO(PAGE-P6)` 注释（该页尚未接数据源，`ipc` 零调用）
- 给定 `simulated === true`，则 DOM 与现状逐字一致：`<span class="pill sim" title="行情由 mock provider 生成，非真实市场数据">SIM · 模拟数据</span>`（`compact` 时为 `SIM · 模拟`）
- 给定 全仓 `app/src`，则 不存在 `<SimBadge />`（无参数）用法
- 给定 `npm run typecheck`，则 通过（新增必填属性会让漏改的调用点直接红）
- 给定 `node app/scripts/verify_sim_badge.mjs`，当 运行，则 上述 6 项通过，退出码 0

**技术决定（TL · 开发期不再讨论）**
- 落点：`app/src/components/SimBadge.tsx:1-11`、`app/src/pages/market/MarketPage.tsx:438`、`app/src/pages/workbench/WorkbenchPage.tsx:1994`、`app/src/pages/indices/IndexPage.tsx:96`
- 组件契约（写死）：`interface Props { simulated: boolean; compact?: boolean }`，函数体首行 `if (!simulated) return null;`
- 数据来源映射：`MarketPage` 已有 `snapshot` state（`marketSnapshot()` 返回值）；`WorkbenchPage` 已有 `bars: BarsResponse`（`getBars()` 返回值）；两处都**不新增 IPC 调用**
- `IndexPage` 例外：该页是骨架（`ipc.` 调用 0 处），传 `true` 是当前唯一正确值；`TODO(PAGE-P6)` 是硬要求，接入快照后必须替换为 `snapshot.simulated`
- 不变式：**不改 `className`、`title`、文案**。既有取证（DOM 契约、截图基线、`*Diag.ts` 的文本断言）依赖这三个字符串，改动会连带 EP-08 的证据
- 门禁契约（新建 `app/scripts/verify_sim_badge.mjs`）：
  1. 读 `SimBadge.tsx`，断言 `Props` 含 `simulated: boolean` 且该行**不含** `=`
  2. 断言组件体含 `if (!simulated) return null`
  3. 读三个页面，抓 `<SimBadge[^>]*/?>`，断言每个标签都含 `simulated=`
  4. 断言 `MarketPage` 的实参文本匹配 `/snapshot\.simulated/`；`WorkbenchPage` 匹配 `/bars\.provenance\.simulated/`；`IndexPage` 匹配 `/simulated=\{true\}/` 且同文件含 `TODO(PAGE-P6)`
  5. 断言三处文案字符串未被改（比对 `SIM · 模拟数据` 与 `pill sim`）
  6. 退出码 0/1
- 不做：不改 `BarsResponse`/`MarketSnapshotDto`；不给 `IndexPage` 加 `ipc` 调用（会引入无意义 IPC）；不做全局 SIM 水印条（原卡是角标，不是横幅）

**可致红反例（QA）**
1. 给 `Props` 改成 `simulated?: boolean` 且默认 `true` → AC1 红（脚本站点 1 检测到 `=`）
2. `MarketPage` 改回 `<SimBadge />` → `tsc --noEmit` 红 + AC6 红
3. `WorkbenchPage` 传 `simulated={true}` → AC3 红（脚本要求 `bars.provenance.simulated`）
4. `IndexPage` 去掉 `TODO(PAGE-P6)` → AC4 红
5. 把文案改成 `SIM · 模拟` 且不区分 `compact` → AC5 红

**Task 拆解（Dev）**
1. 改 `SimBadge.tsx`：加必填 `simulated`、提前返回 `null`
2. 改三处调用点（`MarketPage` / `WorkbenchPage` / `IndexPage`）
3. 新建 `app/scripts/verify_sim_badge.mjs`（6 条检查）
4. `package.json` 加 `"verify:sim-badge"`；`ci.yml` 加 `run: npm run verify:sim-badge`
5. 跑 `npx tsc --noEmit` 确认无漏改调用点

**完成定义 DoD**
单测通过（脚本 6 条退出 0、`tsc --noEmit` 通过）· 联调通过（三页角标各看一次）· 产品验收 · 文档更新（`SimBadge.tsx` 注释说明 `IndexPage` 的临时常量）

---

## 附：本 Epic 卡间依赖与建议开工顺序

```
S-EP07-02 三态矩阵（theme.ts 纯函数 + 9 组断言）
   └─ S-EP07-01 首帧预置（index.html 内联脚本镜像 resolveTheme）★未实现

S-EP07-03 涨跌配色（verify_tokens）        ┐
S-EP07-04 密度行高（verify_density）        ├─ 互不依赖，可三人并行
S-EP07-05 数字格式（verify:format 扩围）    │
S-EP07-06 SIM 标识（verify_sim_badge）     ┘
```

- 建议并行度：`01` 与 `02` 由同一人做（同一算法两处镜像）；`03`/`04`/`05`/`06` 各一人，互不改同一文件
- 前置外部依赖：`S-EP06-02`（`simulated` 字段形状）、`EP-08` 三态卡依赖 `signClass` 与 `expectedChangePctText` 的现有输出（本 Epic 不改语义）
- 本 Epic 完成后：前端基座的 6 条不变量全部有脚本守门，后续页面开发不再各自决定主题、颜色、行高、数字格式、SIM 标识
