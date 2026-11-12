# AKA MVP · 四层级需求文档

> Epic → Feature → Story → Task
> 版本 v1.1 · 日期 2026-11-11
> 依据 `aka-module-architecture.html` v1.0 与 `aka-project-architecture.html` v1.0

---

## 全局索引

| Epic ID | Epic 名称 | 业务域 | 优先级 | Feature 数 | Story 数 | 架构约束映射 |
|---------|-----------|--------|--------|-----------|---------|-------------|
| E-01 | Rust 核心引擎层 | 技术基建 / 计算内核 | P0 | 5 | 21 | 模块架构图 §1 §5 |
| E-02 | 前端工作台与图表 | 用户主场景 / 盘后复盘 | P0 | 6 | 18 | 模块架构图 §2 §3 |
| E-03 | 前端页面生态与导航 | 扩展功能 / 信息架构 | P1 | 5 | 16 | 项目架构图 §1 |
| E-04 | 数据持久化与版本管理 | 存储 / 缓存 / 元数据 | P1 | 4 | 13 | 模块架构图 §3 §6 |
| E-05 | 运维诊断与外部边界 | 诊断 / 安全 / 预留接口 | P2 | 4 | 10 | 项目架构图 §4 |

---

## Epic E-01 · Rust 核心引擎层

**一句话**：构建 6 crate 单向依赖的 Rust workspace，提供数据源 trait、指标计算内核、编排缓存、命令层。

**战略目标**：为整个 AKA 提供可单测、可被 CLI / 服务端复用的核心计算能力，确保架构分层稳固、依赖方向永不倒流。

**上游依赖**：无（系统最底层）
**下游被依赖**：E-02（前端工作台）、E-03（前端页面）、E-04（持久化）、E-05（运维）

**架构硬约束（必须全部满足）**：

| 约束 ID | 描述 | 来源 |
|---------|------|------|
| ARCH-01 | crate 依赖链严格单向：`aka-desktop → app-core → {indicator-core, data-provider, data-store}` | 模块架构图 §1 |
| ARCH-02 | 三个底层 crate 互不依赖、禁止反向、禁止认识 Tauri / Arrow / SQLite | 模块架构图 §1 |
| ARCH-03 | `aka-desktop` 命令函数体 < 15 行，业务逻辑全部下沉 `app-core` | 模块架构图 §2 |
| ARCH-04 | `indicator-core` 除零返回 NaN、禁止 unwrap、输入仅 `&[f64]` 切片 | 模块架构图 §5.2 |
| ARCH-05 | `data-provider` 与 `data-store` 互不依赖，`app-core` 是唯一映射层 | 模块架构图 §1 |
| ARCH-06 | 6 crate 全部通过 `cargo check --workspace` + `cargo metadata` 白名单断言 | 模块架构图 §7 |

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| 编译 | `cargo check --workspace` 零警告通过 | CI 自动执行 |
| 依赖 | `cargo metadata` 断言白名单外出边为 0 | CI 脚本 `check-deps.py` |
| 单测 | `cargo test -p indicator-core` 全部通过（MA / MACD + 夹具） | CI 自动执行 |
| 边界 | `indicator-core` / `data-provider` / `data-store` 的 `Cargo.toml` 不含 tauri / arrow / rusqlite | 静态 grep |
| 代码量 | `commands.rs` 每个 `#[tauri::command]` 函数体 ≤ 15 行 | `wc -l` + lint |
| 可复用 | 单独编译 `indicator-core` 不链接 Tauri；为未来 CLI / 服务端复用预留 | `cargo build -p indicator-core --no-default-features` |

---

### Feature F-01.1 · aka-desktop 应用壳与命令层

**描述**：Tauri 2 宿主壳，负责窗口、菜单、`State<AppCore>` 注入、IPC 命令注册与错误映射。

**架构定位**：系统顶层薄层——目标是「换壳（CLI / 服务端）不重写业务」，因此本 Feature **绝对不能**包含任何业务判断。

**上游依赖（必须全部就绪后才能开发）**：

| 依赖 | 类型 | 依赖原因 |
|------|------|---------|
| F-01.2 app-core | 内部依赖 | 所有命令函数调用 `app_core.xxx_service()`；Tauri builder 注入 `State<AppCore>` |
| F-01.3 indicator-core | 隐式依赖 | 命令层需要知道有哪些指标命令，间接依赖 registry |
| F-01.4 data-provider | 隐式依赖 | MockProvider 是 AppCore 默认注册的数据源 |
| F-01.5 data-store | 隐式依赖 | CandleStore 是 AppCore 默认持有的存储 |

**下游被依赖**：F-02.1 WorkbenchPage（通过 4 条 IPC）、E-03 全部页面（通过 IPC）

**硬约束**：
- 命令函数体 ≤ 15 行（含注释、不含空行）
- 只做三件事：反序列化 → 调 app-core → 错误映射
- 不缓存、不算指标、不读文件、不创建线程

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| 启动 | `cargo tauri dev` 可启动双宿主应用（WebView + Rust） | 手动 + CI e2e |
| 架构 | `commands.rs` 所有 `#[tauri::command]` 函数体 ≤ 15 行 | 代码审查 + lint |
| 错误 | AppError 序列化结构固定：`{ code, message, retryable, indicatorId?, field?, got?, min?, max? }` | 单元测试断言 JSON schema |
| 权限 | `capabilities/default.json` 仅放行 `core:invoke`、`core:window`、`core:app` | 静态检查 |
| 窗口 | 关闭时触发 AppCore graceful shutdown（刷新缓存统计 + 写 state.db） | e2e 测试 |
| 隔离 | 单独编译 `src-tauri` 不含 arrow / rusqlite / reqwest | `cargo tree` 检查 |

---

### Feature F-01.2 · app-core 编排层

**描述**：唯一知道数据从哪来、怎么算、怎么返回 UI 的层；负责查询编排、缓存、DTO、复权归一、溯源。

**架构定位**：系统「大脑」——同时认识三个底层 crate，是唯一的映射层。换数据源 / 换 UI / 换存储格式**只改这一层**。

**上游依赖（必须全部就绪后才能开发）**：

| 依赖 | 类型 | 依赖原因 |
|------|------|---------|
| F-01.3 indicator-core | 内部硬依赖 | CalcService 调用 `Indicator::calc()`、读取 `Meta.warmup()`、`ParamSpec` 校验 |
| F-01.4 data-provider | 内部硬依赖 | ProviderRegistry 持有 `Box<dyn DataProvider>`、调用 `daily_bars()` / `securities()` |
| F-01.5 data-store | 内部硬依赖 | QuoteService 写入 / 查询 CandleStore |

**下游被依赖**：F-01.1 aka-desktop（命令层全部调用 app-core 方法）

**硬约束**：
- 不得依赖 tauri / rusqlite / arrow 的直接 API
- `CacheKey` 必须包含完整上下文，不能只靠标的+周期
- `generation` 递增器必须 `AtomicU64::fetch_add(1, SeqCst)` 保证无竞争

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| 缓存 | `CacheKey` 包含：securityId + timeframe + adj + indicatorId + params_hash + data_version + window_start + window_end | 单元测试断言字段覆盖 |
| 命中 | 同一请求第二次调用缓存命中率 ≥ 95% | 基准测试（120 只 × 3 周期 × 3 复权 × 2 指标） |
| 并发 | 100 并发 calc_indicators 请求无 generation 竞争、无 panic | `cargo test -- --test-threads=1 --test-threads=100` 压力测试 |
| 并行 | rayon 并行计算 CPU 利用率 ≥ 80%（8 核机器） | flamegraph 采样 |
| 溯源 | 每根 BarDto 携带 provider / datasetId / qualityFlags / adjMode | 结构断言测试 |
| NaN | f64 NaN 在 DTO 边界转 null，不渲染为 0 | e2e 截图：MACD 首 25 根为 null → 断线 |
| DTO | 所有 DTO `#[serde(rename_all = "camelCase")]`，字段名与 TS interface 完全对齐 | gen-ipc-types 脚本自动断言 |

---

### Feature F-01.3 · indicator-core 指标计算内核

**描述**：纯计算 crate，只吃 `&[f64]` 切片，输出 `Vec<f64>`，NaN 语义明确；规划 105 个指标 id，骨架实现 MA + MACD。

**架构定位**：系统「算力核心」——零副作用、纯函数、可被任何宿主复用。这层的抽象质量决定了新增一个指标是否需要改 app-core 分支。

**上游依赖**：无（最底层纯计算 crate，仅可选 serde）
**下游被依赖**：F-01.2 app-core（CalcService 调用）、F-01.6 indicator-golden（dev-only 夹具）

**硬约束**：
- 零 IO、零 async、零 trait object 开销（除 `Indicator` 本身）
- 输入 `&OhlcvView`（借用视图），输出 `&mut [Vec<f64>]`（预分配）
- 禁止 unwrap、禁止 `.unwrap()`、禁止 panic；除零返回 NaN
- engine_version 公式变更必须 bump，进缓存 key

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| 纯度 | `Cargo.toml` 不含 tauri / tokio / arrow / rusqlite | 静态检查 |
| 计算 | MA / MACD 单测全部通过，黄金用例容差 < 1e-9 | `cargo test -p indicator-core` |
| 注册 | `registry::all().len()` 由已注册实例派生，CI 断言「目录行数 = 已实现数」 | CI 自动断言 |
| NaN | OhlcvView 前 N 根不足 warmup → 输出 Vec 前 N-1 根为 NaN（不补零） | 单测断言 |
| 并行 | 同一 OhlcvView 被多个指标借用 → 内存共享无拷贝 | flamegraph 采样 allocation count |
| 扩展 | 新增一个指标只需 `impl Indicator` + `registry::register()`；不修改 app-core 分支 | 代码审查三问「新指标是否只加在 indicator-core？」 |

---

### Feature F-01.4 · data-provider 数据源层

**描述**：`DataProvider` trait + MockProvider（MVP 主路径）+ TushareProvider 骨架。

**架构定位**：系统「数据源抽象层」——定义统一契约，让真实源接入（tushare / baostock / akshare）不影响上层代码。MVP 中 MockProvider 是**唯一激活**的实现。

**上游依赖**：无（纯 trait crate，仅依赖 async-trait / serde / thiserror）
**下游被依赖**：F-01.2 app-core（ProviderRegistry 持有）、F-04.1 Parquet 写入管线

**硬约束**：
- 4 必需方法：securities / trading_calendar / daily_bars / adjust_factors
- 4 可选方法返回 `Result<T, NotSupported>`（不 panic、不伪造实现）
- 每行输出必须带 provider_id / dataset_id / quality_flags（不向上层隐瞒来源）
- 归一化**不在这里做**，归一化归 app-core

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| 确定性 | 同一 seed 输入 → 同一 daily_bars 输出（120 只 × 10 年数据 SHA256 固定） | 基准测试 |
| 覆盖 | MockProvider securities 覆盖沪深各 60 只（主板 40 / 创业板 10 / 科创板 5 / 指数 5） | 单元测试断言列表长度与板块分布 |
| 归一 | 代码归一：6 位 .SH/.SZ；单位归一：元/股 | 归一化管道单测 |
| 骨架 | TushareProvider `feature = "live-tushare"` 默认 off，release build 不下载 reqwest | `cargo build --release && cargo tree | grep reqwest` → 空 |
| 可选 | index_members / industry / limit_flags / minute_bars 返回 NotSupported 错误，不伪造数据 | 单元测试 |
| 溯源 | 每行 BarBatch 带 provider_id + dataset_id + quality_flags | 结构断言 |

---

### Feature F-01.5 · data-store 存储层

**描述**：骨架期内存 `CandleStore`；后续 Parquet 分区 + SQLite state.db + manifest/data_version。

**架构定位**：系统「列式存储抽象层」——骨架期仅内存，但 API 设计必须能无缝替换为 Parquet/SQLite 后端。与 data-provider 互不依赖，app-core 是唯一映射者。

**上游依赖**：无（骨架期零外部依赖；后续 arrow / parquet / rusqlite）
**下游被依赖**：F-01.2 app-core（QuoteService 读写）、E-04 持久化层

**硬约束**：
- Candle 模型不认识 ProviderId / DatasetId 以外的任何上游概念
- OhlcvView 必须是零拷贝借用视图（从 `Vec<Candle>` 生成 `&[f64]`）
- data/real 物理隔离，MVP 不创建（目录不存在即视为未启用）

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| 骨架 | `Cargo.toml` 无外部依赖（骨架期） | 静态检查 |
| 借用 | `OhlcvView<'a>` 生命周期绑定 `&'a Vec<Candle>`，无 Clone / Copy | 编译器生命周期检查 |
| 索引 | `CandleStore` 插入 / 查询复杂度 O(log N)（BTreeMap 内部） | 基准测试 10 万 bars 查询 ≤ 1ms |
| 分区 | Parquet 按 `{security_id}.parquet` 分区，列式存储 ts / open / high / low / close / volume | parquet-tools schema 验证 |
| 版本 | `data_version` 字段：Mock 生成 v1，rebuild 时 +1；进缓存 key | rebuild_dataset 管线端到端测试 |
| 隔离 | `data/real/` 目录不存在即视为未启用，MVP 启动时**不创建** | 文件系统检查 |

---

## Epic E-02 · 前端工作台与图表

**一句话**：用户的主场景——盘后复盘工作台，K 线 + 副图 + 参数面板，支持缩放平移十字光标。

**战略目标**：MVP 唯一可运行页面必须具备「首装 → 行情 → 工作台 → 指标改参」全链路能力，且所有交互可离线完成。

**上游依赖**：E-01（通过 IPC 调用 F-01.1 / F-01.2 / F-01.3）
**下游被依赖**：E-03（页面间导航、路由骨架）

**架构硬约束（必须全部满足）**：

| 约束 ID | 描述 | 来源 |
|---------|------|------|
| FRONT-01 | 前端模块分层单向：main → app → pages/features → components → lib；页面不直接 invoke | 模块架构图 §2 |
| FRONT-02 | 所有 invoke 经 `lib/ipc.ts` 出口；错误码 + generation 在同一处处理 | 模块架构图 §2 |
| FRONT-03 | 参数变更 150ms 防抖；同 id 同参批量请求内只算一次 | 模块架构图 §3 |
| FRONT-04 | 平移 / 缩放 / 十字光标只读已取回数据 + 前端缓存，不产生 IPC | 模块架构图 §3 |
| FRONT-05 | 全局模拟标识（dataset manifest 驱动）不可关闭 | 模块架构图 §2 |
| FRONT-06 | MVP 运行时网络请求 = 0（tshark 抓包零外部连接） | 项目架构图 §4 |

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| 链路 | 首装 → 启动 → 看到 K 线 → 改 MA 参数 → 新线出现在图上（全链路无联网） | e2e 测试 + 抓包 |
| 首屏 | 3 副图 × 2000 根 bars 冷算 ≤ 120ms；单参变更触发重算 ≤ 60ms | 火焰图 / console.time 基准 |
| 交互 | 平移 / 缩放 不发 IPC（浏览器 devtools Network 面板零新请求） | e2e 断言 |
| 视觉 | 红涨绿跌可切换；深/浅主题切换；NaN 断线渲染；停牌时间轴占位无实体 | 截图对比 + 视觉回归 |
| 类型 | `tsc --noEmit` 零错误；IPC 类型与 Rust DTO camelCase 完全对齐 | CI 自动执行 |

---

### Feature F-02.1 · WorkbenchPage 页面骨架

**描述**：MVP 唯一可运行页面，组合 QuoteHeader + MainChart + SubChart×3 + ParamPanel + IndicatorDrawer。

**架构定位**：MVP 门面——首屏交付物，所有组件在此组合。不直接 invoke，经 features/workbench 数据层。

**上游依赖**：

| 依赖 | 类型 | 依赖原因 |
|------|------|---------|
| F-01.1 aka-desktop | 硬依赖 | 调用 4 条 IPC：`list_securities` / `get_bars` / `indicator_registry` / `calc_indicators` |
| F-02.2 K 线图表 | 内部依赖 | 渲染 MainChart + SubChart×3 |
| F-02.3 渲染规则 | 内部依赖 | lib/ipc.ts + theme.ts + SimBadge |

**下游被依赖**：E-03 所有页面（路由骨架）

**硬约束**：
- 页面组件不调用 `invoke()`，只通过 `features/workbench` 的自定义 hooks 获取数据
- 左侧 Rail 的 6 个入口中仅 Workbench 激活，其余置灰
- IndicatorDrawer 主图最多叠加 2 个、副图最多 3 格（超限 toast）

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| 布局 | 1280×800 窗口内无溢出；最小 1024×640 不出现关键元素截断 | 手动调整窗口 + e2e |
| 导航 | 点击左侧 5 个未激活入口 → 无跳转 / 置灰 / 非预期行为 | e2e 测试 |
| 选证 | QuoteHeader 搜索框输入 600519 → 实时过滤 → 回车 → 切换到贵州茅台数据 | e2e 测试 |
| 参数 | MA period 从 20 改为 30 → 150ms 后新 MA30 线出现，旧 MA20 线消失 | e2e + console.time 检查 |
| 去重 | 快速连续改 5 次参数 → 后端实际只收到 1 次 calc_indicators（防抖生效） | Network 面板断言请求数 |

---

### Feature F-02.2 · K 线图表渲染

**描述**：主图 K 线 + 最多 2 个叠加、副图最多 3 格、十字光标、缩放平移。

**架构定位**：数据→视图转换层——纯展示、零计算、零业务规则。所有计算结果已由 app-core 完成。

**上游依赖**：

| 依赖 | 类型 | 依赖原因 |
|------|------|---------|
| F-01.2 app-core | 硬依赖（通过 DTO） | BarDto 含 OHLCV + adjMode + qualityFlags；SeriesDto 含指标值 + generation |

**下游被依赖**：F-02.1 WorkbenchPage（组合 MainChart + SubChart）

**硬约束**：
- 图表组件不调用 `invoke()`
- NaN 值渲染为断线（SVG path break），不是补零
- 停牌 K 线仅时间轴占位，不渲染实体/影线
- 数据不足显示「需要 N 根，当前 M 根」空态卡片

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| K 线 | 影线 + 实体正确渲染；红涨绿跌（可互换）；成交量柱独立显示 | 截图对比 |
| 叠加 | 主图 MA 叠加线渲染正确；NaN 处断线不连起来 | 视觉检查（MACD 前 25 根空区域） |
| 交互 | 十字光标跟随鼠标；滚轮缩放窗口；拖拽平移 → 边界不越界 | e2e 鼠标事件测试 |
| 性能 | 2000 根 K 线渲染 < 8ms（requestAnimationFrame 一次绘制完成） | 基准测试 |
| 空态 | INSUFFICIENT_DATA → 显示「指标需要 N 根，当前 M 根」卡片（数据源驱动文案） | mock bars 数不足时 e2e 检查 |

---

### Feature F-02.3 · 渲染与状态规则

**描述**：150ms 防抖、generation 丢弃旧结果、主题切换、模拟标识。

**架构定位**：全局横切关注点——所有页面/组件共享的渲染规范与状态管理规则。

**上游依赖**：

| 依赖 | 类型 | 依赖原因 |
|------|------|---------|
| F-01.1 aka-desktop | 硬依赖 | lib/ipc.ts 封装 invoke 调用；AppError 码映射 |

**下游被依赖**：F-02.1 WorkbenchPage、E-03 所有页面

**硬约束**：
- 所有 invoke 必须经 `lib/ipc.ts`，页面/组件不直接 `import { invoke } from '@tauri-apps/api/core'`
- generation 递增在 GenerationManager 中原子完成
- 模拟标识不可关闭（dataset manifest `sim=true` 时自动渲染）
- tokens.css 用 CSS 变量驱动主题切换，chart.css 只读变量

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| 封装 | grep `import.*invoke.*from '@tauri-apps'` → 除 lib/ipc.ts 外零匹配 | 静态 grep |
| 旧响应 | 切周期瞬间（D → W）→ 如果 W 响应到达晚于 D 的新 generation，旧响应被丢弃、UI 显示 W 周期 | e2e 模拟延迟场景 |
| 主题 | 深 ↔ 浅切换瞬间（< 50ms）；图表颜色同步切换；红涨绿跌互换 | e2e + 视觉检查 |
| 标识 | 顶栏 SimBadge + QuoteHeader 渠道徽标（绿色 mock 标签）在所有页面可见，无关闭按钮 | e2e + 人工验证不可关闭 |
| 错误 | PARAM_OUT_OF_RANGE → 表单字段红色边框 + 错误文案（含 got/min/max） | 改 MA period=1 触发校验 → e2e 截图 |

---

## Epic E-03 · 前端页面生态与导航

**一句话**：工作台之外的 5 个一级入口——行情浏览、自选列表、指标目录、设置、数据源——骨架占位，后续 Sprint 填充。

**战略目标**：信息架构完整，页面间导航不返工，每个页面有明确的可交付边界。

**上游依赖**：E-01（通过 IPC）、E-02（渲染组件 / lib）
**下游被依赖**：无（最末端用户界面）

**架构硬约束**：

| 约束 ID | 描述 | 来源 |
|---------|------|------|
| PAGES-01 | 所有页面经 features/* 组合数据层，不直接 invoke | 模块架构图 §2 |
| PAGES-02 | Watchlist / Settings 状态持久化经 save_state（E-04） | 项目架构图 §2 |
| PAGES-03 | DataSource 页面「切换数据源」按钮 MVP 不可启用（置灰） | 项目架构图 §4 |

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| 骨架 | 5 个页面目录存在 + 导出空组件 + 路由占位 | 构建检查 |
| 导航 | 点击左侧 Rail → 切换到对应页面（当前骨架单页，后续接入 Router） | 手动验证 |
| 禁用 | DataSource 「切换数据源」按钮置灰 + 不可点击 | e2e 测试 |

---

### Feature F-03.1 · Market 行情浏览页

**描述**：按市场/板块浏览全部证券，支持搜索、排序、批量加入自选。

**架构定位**：行情浏览入口——与 Workbench 形成「列表 → 详情」导航。

**上游依赖**：

| 依赖 | 类型 | 依赖原因 |
|------|------|---------|
| F-01.1 aka-desktop | 硬依赖 | `list_securities` IPC 获取 120 只样本 |
| F-04.3 SQLite | 后续依赖（P1） | 批量加入自选 → save_state(watchlist) |

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| 列表 | 表格渲染 120 行：code / name / market / board / latestPrice | e2e 验证行数量 |
| 搜索 | 输入 "600" → 实时过滤沪市主板；输入 "创业板" → 板块过滤 | e2e 模拟输入 |
| 跳转 | 双击某行 → 跳转到该证券的 Workbench | e2e 点击事件 |

---

### Feature F-03.2 · Watchlist 自选列表页

**描述**：用户自选证券列表，分组管理，实时行情刷新。

**架构定位**：用户个性化数据入口——唯一需要跨页面状态持久化的页面。

**上游依赖**：

| 依赖 | 类型 | 依赖原因 |
|------|------|---------|
| F-01.1 aka-desktop | 硬依赖 | `load_state` / `save_state` IPC |
| F-04.3 SQLite | 硬依赖 | 后端 state.db 持久化 |
| F-01.2 app-core | 硬依赖 | `get_bars` 取最新价刷新 |

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| 持久化 | 添加自选贵州茅台 → 重启应用 → 自选仍在 | e2e：添加 → 重启 → 检查 |
| 分组 | 默认组 + 用户自定义组；拖拽排序 | 手动验证 |
| 实时 | Watchlist 列表每 5 分钟自动刷新最新价（MVP 骨架期用 mock） | 定时器验证 |

---

### Feature F-03.3 · Catalog 指标目录 + Spec 口径页

**描述**：指标目录按 category 分组浏览；点击进入口径页（indicator_spec IPC）。

**架构定位**：指标知识中心——连接 indicator-core 注册表与用户文档需求。

**上游依赖**：

| 依赖 | 类型 | 依赖原因 |
|------|------|---------|
| F-01.3 indicator-core | 硬依赖 | `registry::all()` 取注册表；`indicator_spec` IPC 取口径页 |
| F-01.1 aka-desktop | 硬依赖 | `indicator_registry` / `indicator_spec` IPC |

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| 目录 | 按 6 category 分组展示 105 个指标；已实现（2）有绿色徽章、规划（103）灰色骨架 | e2e 视觉检查 |
| 口径 | 四段式：公式定义 + 参数说明 + 输出字段 + 使用场景 + engineVersion 徽章 | Spec 页 e2e 截图 |
| 未实现 | 未实现指标 Spec 页显示「待实现」 + 预估 Sprint | mock indicator_spec 返回 NOT_IMPLEMENTED → 前端空态处理 |

---

### Feature F-03.4 · Settings 设置页

**描述**：通用偏好设置——主题、红涨绿跌、数字精度、周期默认值。

**架构定位**：全局偏好入口——所有设置必须持久化，重启恢复。

**上游依赖**：

| 依赖 | 类型 | 依赖原因 |
|------|------|---------|
| F-02.3 渲染规则 | 硬依赖 | theme.ts 消费主题选择 |
| F-04.3 SQLite | 硬依赖 | save_state(settings) 持久化 |

**硬约束**：参数不持久化（D-14 约束——指标实例参数只在当前会话生效，重启回注册表默认值）

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| 持久化 | 改主题为深 → 重启 → 仍是深主题 | e2e 修改 → 重启 → 检查 |
| 即时 | 切换红涨绿跌 → 下一个渲染帧生效（< 50ms） | console.time + 视觉对比 |
| 排除 | 指标参数不在 Settings 页出现，不在 state.db 持久化 schema 中 | schema grep + SettingsPage 代码审查 |

---

### Feature F-03.5 · DataSource 数据源管理页

**描述**：查看 provider_status、切换数据源（骨架期 mock-only）。

**架构定位**：数据源运维面板——MVP 中仅展示 Mock 状态，切换入口置灰。

**上游依赖**：

| 依赖 | 类型 | 依赖原因 |
|------|------|---------|
| F-01.4 data-provider | 硬依赖 | ProviderRegistry.capabilities / health |
| F-01.5 data-store | 硬依赖 | manifest.json 元数据 |

**硬约束**：切换数据源按钮 MVP 不可启用（置灰 + 工具提示「即将推出」）

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| 展示 | ProviderCard 显示 Mock ID + 10 项 Capabilities 矩阵；ManifestCard 显示 datasetId / securityCount / barCount | e2e 视觉检查 |
| 禁用 | 切换数据源按钮置灰，点击无响应 | e2e 点击事件断言 |

---

## Epic E-04 · 数据持久化与版本管理

**一句话**：Parquet 分区存储行情 + SQLite 持久化状态 + manifest 元数据 + 缓存版本控制。

**战略目标**：从骨架期的「全内存」过渡到「内存索引 + 磁盘持久化」，确保行情可落盘、可重建、可校验。

**上游依赖**：E-01（data-store / data-provider / app-core）
**下游被依赖**：E-05（诊断包导出、数据质量检查）

**架构硬约束**：

| 约束 ID | 描述 | 来源 |
|---------|------|------|
| STORE-01 | data/sim 与 data/real 物理隔离子目录；MVP 不创建 data/real | 项目架构图 §2 |
| STORE-02 | 参数不持久化（D-14）；只有自选/设置/收藏持久化 | 项目架构图 §2 |
| STORE-03 | manifest.sha256 = SHA256(concat(parquet bytes))；启动校验 | 数据流 §③ |
| STORE-04 | 切换数据源 / rebuild → data_version +1 → 旧缓存整体失效 | 模块架构图 §3 |

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| 启动 | 首次启动无 data/sim → Mock 生成 120 只 → 并行写入 Parquet → 创建 manifest → 启动时间 < 5s | 冷启动计时 |
| 重启 | 已有 data/sim → 跳过 Mock → 直接加载 Parquet → 启动时间 < 2s | 热启动计时 |
| 校验 | manifest.sha256 不匹配 → quality_flags 标记 CORRUPTED → 前端显示警告 | 篡改 parquet 文件 → e2e 检查警告条 |
| 重建 | rebuild_dataset → 删旧 Parquet → 新 seed Mock → 新 Parquet → data_version+1 → 缓存清空 | 端到端流程测试 |

---

### Feature F-04.1 · Parquet 分区写入与读取

**描述**：data/sim/ 按 security_id 分区存储 MockProvider 生成的行情。

**上游依赖**：

| 依赖 | 类型 | 依赖原因 |
|------|------|---------|
| F-01.4 data-provider | 硬依赖 | MockProvider.daily_bars() 输出 Candle 数据 |
| F-01.5 data-store | 硬依赖 | Candle 模型 + CandleStore 内存索引 |

**硬约束**：data/real 物理隔离，MVP 不创建

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| 分区 | data/sim/{security_id}.parquet，共 120 个文件 | ls data/sim/ |
| 列式 | parquet-tools schema 验证字段：ts / open / high / low / close / volume / amount / adj_factor | parquet-tools |
| 并行 | 120 只行情写入总耗时 < 3s（rayon 并行） | 基准 |
| 隔离 | data/real/ 目录不存在（MVP 启动时不创建） | 文件系统检查 |

---

### Feature F-04.2 · manifest.json + data_version 管理

**描述**：每个数据集有唯一 manifest，sha256 可校验完整性，data_version 可让缓存整体失效。

**上游依赖**：F-04.1 Parquet 写入（生成完成后创建 manifest）

**硬约束**：sha256 必须包含所有 Parquet 文件字节拼接，不是只算 manifest 自己

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| 完整性 | manifest.json 字段齐全：datasetId / provider / generatedAt / securityCount / barCount / from / to / seed / sim / sha256 / dataVersion | 字段断言 |
| 校验 | 启动时校验 sha256，不匹配 → Candle 行标记 qualityFlags=CORRUPTED → 前端警告条 | e2e：篡改一个 parquet 字节 |
| 失效 | rebuild_dataset → dataVersion + 1 → app-core 缓存所有键整体失效（命中率归零） | 基准测试：重建前 vs 重建后首次 calc |

---

### Feature F-04.3 · SQLite state.db 状态持久化

**描述**：settings / watchlist / watchlist_group / favorites 四张表。

**上游依赖**：无（直接 rusqlite）
**下游被依赖**：F-03.2 Watchlist、F-03.4 Settings（load_state / save_state）

**硬约束**：参数不持久化（D-14）——指标实例参数只在会话内，重启回注册表默认值

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| Schema | 4 表：settings(key, value) / watchlist_group(id, name, sort) / watchlist(id, group_id, security_id) / favorites(id, security_id, note) | rusqlite `.schema` |
| WAL | PRAGMA journal_mode = WAL | 启动日志检查 |
| 写入 | save_state debounce 500ms → 连续 10 次快速变更只写最后一次 | 前端连续触发 → 后端 SQLite 日志计数 |
| 排除 | 参数 schema 中无 settings 相关存储；SettingsPage 无参数持久化入口 | 代码审查 |

---

### Feature F-04.4 · rebuild_dataset 重建能力

**描述**：用户手动触发重新生成 Mock 行情（换 seed、换数量）。

**上游依赖**：F-04.1 Parquet 写入、F-04.2 manifest、F-01.4 MockProvider

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| 管线 | 完整流程：删旧目录 → Mock 生成 → 写 Parquet → 更新 manifest(data_version+1) → 清缓存 | rebuild_dataset IPC 端到端测试 |
| 参数 | 支持 seed + securityCount 自定义 | 传 seed=42 → data/sim 内容 SHA256 固定 |
| UI | DataSourcePage 有「重建」按钮 + 进度 toast + 完成后自动刷新 Workbench | e2e 点击 + 截图 |

---

## Epic E-05 · 运维诊断与外部边界

**一句话**：唯一会离开本机的产物是用户手动导出的诊断包；MVP 关闭所有外部边界（tushare / 更新通道 / 云服务）。

**战略目标**：安全、离线优先；任何联网需求必须先改 PRD 冻结决策 D-02 / D-09 / D-10。

**上游依赖**：E-01（依赖守卫）、E-04（诊断包内容需持久化层支持）
**下游被依赖**：无（最末端）

**架构硬约束**：

| 约束 ID | 描述 | 来源 |
|---------|------|------|
| SEC-01 | 运行时网络请求 = 0（tshark 抓包零外部连接） | 项目架构图 §4 |
| SEC-02 | 无账户 / 无登录 / 无支付 / 无订阅 / 无云控制面 / 无遥测 | 项目架构图 §4 |
| SEC-03 | 诊断包默认关闭，需用户点击导出；排除行情原始数据、自选代码、持仓 | 项目架构图 §4 |
| SEC-04 | TushareProvider feature gate 默认 off，release 不下载 reqwest | 项目架构图 §4 |

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| 抓包 | 启动 AKA 后 tshark / tcpdump 抓包 10 分钟 → 零外部连接（除 macOS 系统服务） | 抓包工具 |
| 构建 | `cargo build --release && cargo tree | grep -i reqwest` → 空（tushare HTTP crate 不下载） | cargo tree |
| 导出 | 诊断包 zip 内容检查：含版本/日志/注册表/manifest/系统信息；不含 parquet/watchlist/favorites | 解压 zip → 文件清单 |
| UI | SettingsPage 无「检查更新」按钮；About 窗口只显示版本号不发请求 | e2e 点击检查 |

---

### Feature F-05.1 · 诊断包导出

**描述**：本地生成 zip，用户手动导出；排除行情数据、自选代码、持仓。

**上游依赖**：

| 依赖 | 类型 | 依赖原因 |
|------|------|---------|
| F-01.1 aka-desktop | 硬依赖 | `quality_report` / `export_diagnostics` IPC |
| F-01.3 indicator-core | 硬依赖 | 注册表摘要进诊断包 |
| F-04.2 manifest | 硬依赖 | manifest.json 进诊断包 |

**硬约束**：诊断包默认关闭；用户手动导出；排除清单硬编码在代码中

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| 质量 | quality_report 6 项检查独立函数：完整性 / 连续性 / 价格合理性 / 量额一致性 / 复权有效性 / manifest 匹配 | 单元测试 mock 各项边界条件 |
| 排除 | 硬编码 blacklist：data/sim/*.parquet / watchlist / favorites / state.db（除 settings 部分） | zip 清单断言 |
| 手动 | 菜单「文件 → 导出诊断包」→ 触发 native save dialog → 用户选路径 → 生成 zip | e2e 全流程 |
| 隐私 | zip 不含任何用户标识（除系统信息）；不含持仓、交易、自选代码 | 解压审查 |

---

### Feature F-05.2 · 依赖守卫与 CI

**描述**：cargo metadata 断言依赖白名单、TSC 类型检查、Vite 构建、注册表计数断言。

**架构定位**：全局守门人——开发时 + CI 运行的自动化防线，防止架构退化。

**上游依赖**：无（基础设施层）
**下游被依赖**：E-01（每次提交必须通过才能合入）

**硬约束**：白名单外出边一律 fail，不允许 bypass

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| 白名单 | scripts/check-deps.py 实现：解析 cargo metadata → 每个 crate 的 dependencies 遍历 → 白名单外即 exit 1 | CI 运行 + 注入违规依赖测试 |
| 例外 | indicator-golden → indicator-core 仅在 dev-dependencies 例外；release profile 不通过 | release profile 单独跑 check-deps |
| 前端 | tsc --noEmit 零错误；vite build 零警告；gen-ipc-types 自动生成 TS interface 与 Rust DTO 对齐 | CI 自动执行 |
| 计数 | indicator_registry 响应 plannedCount=105（硬编码，来自架构规划）、implementedCount=all().len()（动态） | 代码审查 + 运行时日志 |

---

### Feature F-05.3 · Tushare 预留接口

**描述**：MVP 不启用，但接口预留完整。

**上游依赖**：F-01.4 data-provider（TushareProvider 实现 DataProvider trait）

**硬约束**：feature gate 默认 off；release build 不下载 HTTP crate

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| Gate | `[features] live-tushare = ["dep:reqwest", "data-provider/tushare"]` 默认 off；`cargo build` 不触发 | Cargo.toml + cargo build |
| 开启 | `cargo build --features live-tushare` → 编译 reqwest + TushareProvider → 前端 token 输入框可见 | 手动开启验证 |
| UI | MVP DataSourcePage 无 Tushare token 输入框（或置灰「feature 未启用」） | e2e 检查 |

---

### Feature F-05.4 · 更新通道预留

**描述**：MVP 关闭；未来签名 dmg + 公证 + 更新源。

**上游依赖**：无（未来外部服务）

**硬约束**：MVP SettingsPage 无更新检查入口；About 窗口只显示版本号

**详细验收标准**：

| 维度 | 验收项 | 验证方式 |
|------|--------|---------|
| 关闭 | SettingsPage 无「检查更新」按钮；菜单无「About → Check for Updates」 | UI 审查 |
| About | About 窗口显示版本号 / engineVersion / 架构标识，不发任何网络请求 | 抓包 + UI 测试 |

---

## 全局依赖拓扑图（Feature 级）

```
                    ┌───────────────────────────────────────────────┐
                    │           F-01.3  indicator-core              │
                    │           F-01.4  data-provider              │ ← 三兄弟平级、
                    │           F-01.5  data-store                 │   互不依赖
                    └─────┬─────────────┬─────────────┬─────────────┘
                          │             │             │
                    ┌─────▼─────────────▼─────────────▼─────────────┐
                    │              F-01.2  app-core                  │
                    │         （唯一编排 + 唯一映射层）                 │
                    └─────────────────────┬─────────────────────────┘
                                          │
                    ┌─────────────────────▼─────────────────────────┐
                    │             F-01.1  aka-desktop               │
                    │         （命令层 < 15 行 / 薄壳原则）            │
                    └─────────────────────┬─────────────────────────┘
                                          │ 4 条 IPC
                    ┌─────────────────────▼─────────────────────────┐
                    │        E-02 前端工作台  /  E-03 前端页面        │
                    │    F-02.1 WorkbenchPage / F-02.2 K线 / F-02.3   │
                    └────────────────────────────────────────────────┘

                    F-04.1 Parquet ──→ F-04.2 manifest ──→ F-04.4 rebuild
                    F-04.3 SQLite ← E-03 Watchlist / Settings

                    E-05 依赖守卫 + 诊断包（横切全局）
                    F-05.3 / F-05.4（feature gate，MVP 不启用）
```

## Sprint 建议排期（按依赖拓扑）

| Sprint | 交付范围 | 关键依赖 | 预期 Story |
|--------|---------|---------|-----------|
| S1 · 基建 | F-01.3 + F-01.4 + F-01.5 骨架 + F-05.2 守卫 | 无 | 8 |
| S2 · 编排 | F-01.2 app-core 完整 | S1 | 5 |
| S3 · 应用壳 | F-01.1 aka-desktop 完整 | S2 | 4 |
| S4 · 工作台 | F-02.1 + F-02.2 + F-02.3 | S3 | 10 |
| S5 · 持久化 | F-04.1 + F-04.2 + F-04.3 + F-04.4 | S1 | 9 |
| S6 · 扩展页面 | F-03.1 + F-03.2 + F-03.3 + F-03.4 | S4 + S5 | 6 |
| S7 · 诊断 | F-05.1 | S3 + S5 | 2 |
| S8 · 指标扩展 | F-01.3-S-05 · 84 指标分批 | S2 | 84 批 |

---

## MVP 验收清单（来自架构文档的硬约束）

| # | 验收项 | 来源 | 验证方式 |
|---|--------|------|---------|
| 1 | 单进程：UI 在 WebView，Rust 在 tokio 主进程，无 sidecar、无端口 | 项目架构图 §3 | `ps aux` 单进程；无 netstat 监听 |
| 2 | 指标按需计算：可见窗口 + warmup 前缀，不预计算全市场 | 数据流 §④ | flamegraph 采样：冷算集中在可见窗口 |
| 3 | 缓存键 = 标的+周期+复权+指标+参数+data_version+窗口 | 数据流 §④ | CacheKey 单元测试字段覆盖 |
| 4 | 参数变更只重算受影响实例；旧 generation 结果丢弃 | 数据流 §④ | e2e：切周期 → 旧响应被 generation 过滤 |
| 5 | 每根 K 线携带 provider / dataset_id / qualityFlags / adjMode | 数据流 §③ | BarDto 结构断言 |
| 6 | NaN 不补零、不前向填充；指标线在 NaN 处断开 | indicator-core | MA 前 19 根 NaN → SVG path break |
| 7 | 依赖单向 aka-desktop → app-core → {indicator-core, data-provider, data-store} | 模块架构图 §1 | cargo metadata 白名单断言 |
| 8 | 三兄弟之间互不依赖；禁止反向 | 模块架构图 §1 | cargo tree 三兄弟无相互依赖 |
| 9 | 命令函数体 < 15 行，业务下沉 app-core | 模块架构图 §2 | 代码审查三问 + lint |
| 10 | 运行时网络请求 = 0（tushare 默认不编译） | 项目架构图 §④ | tshark 抓包零外部连接；cargo tree 无 reqwest |
| 11 | 无账户 / 无登录 / 无支付 / 无订阅 / 无云控制面 | 项目架构图 §4 | grep 零匹配（login/payment/subscription） |
| 12 | 首装 → 行情 → 工作台 → 指标改参 全链路可离线完成 | 项目架构图 §0 | 断网环境 e2e 测试 |

---

*文档结束 — v1.1 补充 Epic/Feature 详细验收标准与依赖关系*
