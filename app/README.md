# AKA · A 股桌面分析工作台（MVP 骨架）

macOS 单机、离线、免费、无账户的 A 股分析工作台骨架。技术栈：**Tauri 2 + React 18 + TypeScript + Vite**，指标引擎为 **Rust workspace**（无 Python sidecar、无本地 HTTP 端口）。

> 当前行情全部为 **mock 模拟数据**，界面已固定标注「模拟数据 · 非真实行情」。本仓库只搭骨架，不含投资建议，也未接入任何真实行情。

## 目录

```text
app/
├─ Cargo.toml                 # Rust workspace（6 个成员）
├─ package.json               # 前端脚本与依赖
├─ vite.config.ts  tsconfig.json  index.html
├─ src/                       # 前端
│  ├─ main.tsx  App.tsx       # 入口 · 主题状态
│  ├─ app/AppShell.tsx        # 左侧 rail 与导航（仅工作台可用）
│  ├─ pages/workbench/        # 最小工作台页
│  ├─ features/workbench/     # 参数模型 / 实例组装 / 本地预校验
│  ├─ components/             # K 线图、自选列表、参数面板、模拟徽标
│  ├─ lib/                    # ipc.ts（唯一 invoke 出口）、types.ts、theme.ts、format.ts
│  └─ styles/                 # tokens.css（深/浅/红涨绿跌）、app.css
├─ src-tauri/                 # crate `aka-desktop`：Tauri 壳 + 命令层
│  ├─ tauri.conf.json  build.rs  capabilities/default.json
│  ├─ icons/                  # 构建必需（icon.png / icon.icns）
│  └─ src/main.rs  lib.rs  commands.rs  state.rs
└─ crates/
   ├─ app-core/               # 编排、缓存、DTO、错误映射
   ├─ indicator-core/         # 注册表 + ParamSpec + MA/MACD
   ├─ data-provider/          # DataProvider trait + MockProvider + Tushare 骨架
   ├─ data-store/             # Candle 模型 + 内存 CandleStore
   └─ indicator-golden/       # 黄金用例夹具（dev-only）
```

架构图（上一阶段产物）：

- [`../docs/architecture/aka-project-architecture.html`](../docs/architecture/aka-project-architecture.html)
- [`../docs/architecture/aka-module-architecture.html`](../docs/architecture/aka-module-architecture.html)

## 启动

```bash
cd app
npm install
npm run tauri dev        # 需要 Rust 工具链；会自动起 Vite(1420) 并编译 Tauri
```

只验证前端（不打开窗口）：

```bash
npm run build            # tsc --noEmit && vite build
```

Rust：

```bash
cargo check --workspace
cargo test -p indicator-core -p data-provider -p indicator-golden
```

打包（未签名，仅本地验证）：

```bash
npm run tauri build
```

## 已实现（骨架范围）

- **一条完整链路**：`MockProvider → app-core → indicator-core → Tauri IPC → React 工作台`。
- **mock 数据源**：120 只标的（含 14 只知名标的与 3 个指数）× 520 根工作日日线，确定性随机（xorshift64*），部分标的含 2:1 拆分；支持 `none / qfq / hfq`，每根 K 线带 `source` 与 `quality` 标记。
- **指标引擎**：静态注册表 + `ParamSpec` 校验 + 2 个示例指标 **MA**（SMA/EMA/WMA）与 **MACD**；NaN 在 DTO 边界转 `null`；结果可缓存（缓存键含引擎版本与数据集版本）。
- **IPC 4 条命令**：`list_securities`、`get_bars`、`indicator_registry`、`calc_indicators`；错误统一为 `{ code, message, retryable, details }`。
- **工作台**：自选列表、日线 K 线 + MA 叠加 + 成交量 + MACD 副图、参数修改、区间切换、深/浅/跟随系统主题、红涨绿跌切换、模拟数据标识与状态栏。
- **验证**：`cargo check --workspace` 通过；Rust 单测 13 个全部通过；`npm run build` 通过。

## 未实现（后续 Sprint 边界）

- 周/月周期（工具栏 W/M 已禁用）、分钟线。
- 其余 103 个规划指标、指标口径页与黄金用例库。
- 持久化：`state.db`、Parquet 分区、`manifest`、数据集重建；当前 mock 数据仅在内存。
- 真实数据源：tushare 仅接口骨架（默认不可用）、baostock/akshare 仅有占位；无网络层。
- 多页面（行情/指标库/设置等）、自选持久化、诊断包导出、更新通道、代码签名与公证。
- 打包图标为脚本生成的占位图，发布前需替换为正式设计资产。

## 工具链与环境说明

- 已验证环境：macOS 26.7.1、rustc/cargo 1.98.1、Node v22.21.1、Tauri 2。
- **本机注意**：`~/.local/bin/node` 是一个 Electron shim（`ELECTRON_RUN_AS_NODE=1`）。用它跑 Vite 会因 `@rollup/rollup-darwin-x64` 原生模块签名冲突报 `ERR_DLOPEN_FAILED`。验证时使用了官方 Node v22.21.1（解压到 `/tmp/aka-node`，通过 `PATH` 前置）。这只影响本机验证，不影响源码；正常机器安装官方 Node 20+ 即可。
- `src-tauri/icons/` 中的图标由本地脚本生成（深色圆角 + 4 根蜡烛），仅用于让 `generate_context!` 与打包通过。

## 关键约定

- Rust 依赖方向固定：`aka-desktop → app-core → {indicator-core, data-provider, data-store}`；三个底层 crate 互不依赖（见模块架构图）。
- 参数范围与默认值只有一份事实来源：`indicator-core` 的注册表；前端按 `ParamSpec` 渲染并做预校验，后端再校验。
- 前端只有 `src/lib/ipc.ts` 调用 `invoke`；组件不拼命令字符串。
- `from` / `to` 当前是**序列下标**（含端点），不是日期区间；接入真实数据源时再改为日期。
