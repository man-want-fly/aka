# AKA S3 独立复核 R10（W-58 / W-63 返工）

- 复核对象：最终绿 `11405ed`（run `42395425939`）；红 `2228f2f`（run `42394835110`）；漏项 `50a9f02`（run `42395059436`）。
- 独立 worktree `/tmp/aka-r11`；本地跑源码门禁绿、复算 merge 脚本；不采信自报数字。
- 三份 run 已核：红=failure 且日志点名 `diag_write_named`；漏项=success；最终=success；`git diff --quiet a9745e9 HEAD` 返回 0。

## 1. 红 / 漏项

- 红路径是真的：`2228f2f` 把 `diag_write_named` 与 `write_diag` 移出 cfg、注册进 release，日志三条失败（`diag_write_named`、`write_diag`、`aka/diag`）。不是造红。
- 漏项实验也是真的：`50a9f02` 把 `diag_write_named` 从 CI 与源码脚本两份清单都删掉，release 里保留真实的写入口（`fs::write` 内联、路径用 `.join("aka").join("diag")` 拆开），门禁全绿（字面量从 12 降到 9）。
- **判：清单该从源码派生。** 现门禁守的是「表里的名字没出现」，不是「源码里没有写入口」。漏项 run 已经证明：删表项 + 保留活入口 = 绿。建议：
  1. 从 `#[tauri::command]` 函数体扫 `fs::write`/`create_dir_all` 等写能力，写命令必须 release 不注册，不靠 3 个名字；
  2. 解析 debug 与 release 两份 `invoke_handler`，对差集要求「只能是 diag 前缀」；release 侧出现任何 diag/write 注册即红；
  3. env/args 字面量从调用点派生（`diag_flag(&args, "...")`、`env::var("AKA_...")`、路径拼接），对所在 fn/语句断言 cfg，不维护名字表；
  4. `strings` 保留为第二层。`aka/diag` 这种整串断言可被路径拼接绕过（漏项 commit 就是这么绕的）。

## 2. W-63 四支

- 断言形态已改对：`WL-23C1..C4` 各一条、全等匹配、无 `||`；四支在同一次取证里都绿。
- 但四支是**注入造出来的分支**，不是真实通道：
  - `ok` / `no-download` 直接把 `copied=true`，**没调剪贴板**；「已复制」成功从未真实发生；
  - `no-copy` / `both-fail` 直接把 `copied=false`；
  - `both-fail` 直接 `downloaded=false`，不是 `anchor.click()`/剪贴板真的同时抛；
  - 只有下载是真调用（`ok`、`no-copy` 各下一次）。
- 没有红 run：四支只有一次绿，`WL-23C4` 从未红过。全等断言「能红」，但没有红证据。
- `WL-23-file`：文件名为 `aka-diagnostics-<trace>*.json`、内容 `traceId` 匹配、`size>0`，trace 这一层够严。但：
  - 按 mtime 取最新，没有「本次运行开始时间之后」的时间窗；
  - 实际文件是 `...-0002 (1).json`，说明有同名前一份；`ok` 支也真下载，文件不绑定 `no-copy` 支；
  - 只校验 size>0，不校验 `code`/`message`/期望字节数；
  - 因此同 trace 的残 file / 前一支落盘可以满足它。
- **release 产物问题**：CI 的零命中检查是 `npm run build`（production dist），这一步没问题。但**运行时四支证据不可能来自这个 production 产物**：`import.meta.env.DEV` 在 `vite build` 下为 false，四个 mode 全部失效，四支会落成同一个「已下载（剪贴板不可用）」；实际却拿到四种不同文案，说明取证用的是 dev 模式包（或 dev server）。meta 只写「vite build 产物」、未记 mode，不可复现。结论：静态零命中=release 产物，成立；四支运行时证据=dev 产物，不是 release 产物，两者被拼在一份结论里。

## 3. 前三条回归

- 600ms 已撤：`waitFor` 上限 300ms（200ms 防抖 + 100ms 余量），20ms 轮询；超时抛错。注意：上限是 300ms，不是卡面的 200ms；250ms 的产品仍会过。且超时会让整个套件中止（不写 evidence，脚本 240s 后 exit 1），不是单条 R-03 变红。
- `R-06` 已改归 `AC-02.04-02（补3）` / `S-02.04-01`；`S-08.01-02` 改为 `pending 0/1`，不再拿假 1/1。S-02.04-01 现为 8/8 checks、6/6 AC。
  - 但 R-06 断言偏弱：只查 `[data-drawer-empty]` 存在 + 点击后行数>0；未校验「没有匹配的指标」文案、未校验搜索框已清空；清除按钮还有 `.state-card__action` 兜底，可能点到无关动作。补3 名义覆盖，实质弱。
- `S-02.05-02` 的 4/4 已由 `merge-restart-evidence.mjs` 现算；我用两份 phase 文件独立复算，得 17/17、4/4、uncovered=[]，不再手写。但 phase 证据是 `8b399c8`（23:55）旧跑，merge 是事后计算，不是最终 tip 的复跑。
- 证据档期：`s20401` / corrupt 两份 meta 记 `commit=366634c`、`dirty=true`（01:00 与 00:48，早于 `a9745e9` 的 01:03）；内容虽已含返工，但按 commit 不可复现。签字前应干净复跑。

## 结论

| 项 | 结论 |
|---|---|
| W-58 红/漏项/源码级 | 三项齐了，红与漏项都真实；但门禁仍是手维护清单，漏项 run 已证明可绕过 → **不能签**，需从源码派生 |
| W-63 四支 | 四支文案分开了、可各自红；但 C1/C3「已复制」是假 true、C4 是强制 double-fail、文件未绑定 C2；无红 run → **有条件** |
| W-63 release 零命中 | 静态检查是 production dist，成立；运行时四支证据是 dev 产物 → 口径需写清 |
| 600ms / R-06 / 4/4 | 600ms 撤了（上限 300ms）；R-06 归卡对但断言弱；4/4 现算成立；证据为 dirty 档 |

## TL 没发现、我发现的

1. 四支证据的构建模式没记；production `vite build` 下注入必失效，实际证据只能来自 dev 包——与「release 产物」不是同一个东西。
2. `WL-23-file` 不绑定 `no-copy` 支，且无本次运行时间窗；`ok` 支也真下载，`(1)` 残 file 可满足。
3. 源码门禁仍是名字表；漏项 commit 用路径拼接 `.join("aka").join("diag")` 绕过 `aka/diag` 整串断言。
4. `R-06` 只验空态节点与行数，未验「没有匹配的指标」文案/清空状态。
5. `s20401` / corrupt 证据 meta 是 `366634c dirty=true`，不是最终 `11405ed` 的干净复跑。
