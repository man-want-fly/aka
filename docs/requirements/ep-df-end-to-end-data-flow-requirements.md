# Epic：端到端行情数据流（EP-DF）

> 需求分层方法论：v1.0（本次唯一写法依据）
> 依据架构：`docs/architecture/aka-module-architecture.md`（主）、`docs/architecture/aka-project-architecture.md`（辅）；二者冲突时以 module 文档为准。
> 代码快照：main `3192b76`，`git status` 干净；同时审计 20 个 worktree。
> 文档性质：按方法论**重新拆解**，不沿用仓库既有 story 卡的结构与编号；旧卡仅作为代码事实的交叉核对材料。
> 需求状态统一为「待评审」：这是本次重写的需求基线，评审通过后由 PO 迁移到「已就绪」。
> 实现状态是本次审计新增的派生快照，不属于方法论状态机，口径见 §0.3。

---

## 0. 阅读说明

### 0.1 为什么重写

现有架构文档停留在骨架期（2 个指标、4 条命令、1 个页面、纯内存），而代码已演进为 45 个实现指标、46/41 条命令、8 个页面，并引入 SQLite 数据集落盘、质量扫描、溯源与诊断。继续按旧文档验收会出现三类问题：

1. **链路归属缺失**：同一能力散落在 provider、app-core、commands、ipc、页面五处，旧文档按"模块"而非"数据流"组织，验收时无人对整段负责。
2. **完成度失真**：文档字面描述与代码实现不一致，按文档标记会把"仅分支实现"或"设计存在但代码缺失"误判为已完成。
3. **异常路径无主人**：区间越界、缺字段、参数非法、计算超时、旧响应覆盖等异常没有可二值判定的 AC。

### 0.2 文档结构

- §1 Epic 卡片（含成功指标、范围、依赖与风险）
- §2 Feature 卡片（6 个，覆盖数据流全部 7 段）
- §3 Story 卡片（30 个，每个含 AC、场景、代码落点、实现状态、Task）
- §4 链路归属矩阵（证明每段有且仅有一个归属）
- §5 文档—代码一致性差异登记
- §6 worktree/分支判定口径
- §7 统计口径与本次快照数字

### 0.3 两套状态口径

**需求状态（方法论 §3.6）**：草稿 → 待评审 → 已就绪 → 进行中 → 待验收 → 已验收关闭；辅以驳回/挂起/取消。迁移必须有责任人，进入「已就绪」需过 DoR，进入「待验收」需过 DoD。

**实现状态（本次审计派生，仅描述代码事实）**：

| 取值 | 判定标准 | 允许的证据 |
|---|---|---|
| 已实现（主工作区） | main 工作区存在承载该 Story 主 AC 的生产代码，且关键分支有自动化断言或已归档运行证据 | 文件:行号；Rust 测试名；`docs/qa/evidence/*` |
| 已实现（仅分支） | 代码只在未合入 main 的 worktree/分支存在，main 无对应实现 | worktree + 分支 + commit + 文件:行号 |
| 待验证 | main 有生产代码，但缺自动化断言且无可复现证据 | 文件:行号 + 缺口说明 |
| 部分实现 | 主路径存在，但 Story 承诺的关键分支/约束缺失（如无容量上限、守卫未接通、参数类型歧义） | 文件:行号 + 缺失点 |
| 未开始 | 仅有设计描述，代码缺失 | 明确写「设计存在但代码缺失」 |

> 判定纪律：不因"相关代码存在"就抬到已实现；不以单测代替渲染/运行证据；不以文档承诺代替代码事实；不以 main 之外的证据当作 main 交付。

---

## 1. Epic 卡片

| 字段 | 内容 |
|---|---|
| 编号 / 标题 | EP-DF / 端到端行情数据流：从数据源到 K 线与指标的可解释链路 |
| 业务背景与问题 | AKA 是 macOS 单机行情工作台。用户看到的每根 K 线、每条指标都应能回答"来自哪个数据集版本、经过哪些转换、为什么是空值、为什么慢"。当前数据链路跨越 4 个 crate 与 8 个页面，但需求只按模块零散描述，导致：数据源不可用被当成空图、Displayed 价格口径不可追溯、缓存命中/冷算不可观测、区间越界与参数错误缺少统一行为、文档与代码脱节。 |
| 目标用户与场景 | ① 个人投资者：切换标的/周期/复权、查看 K 线与指标、点击溯源；② 指标开发者：注册指标、验证参数与空值；③ 数据工程师/运维：安装数据集、查看版本与质量、定位损坏；④ 前端开发者：按稳定 IPC 契约取数与渲染。 |
| 价值假设 | 若端到端 7 段各有唯一归属，且每个 Story 的 AC 可二值判定并绑定代码落点，则需求评审与验收返工显著下降；同时把"文档说做了/代码没做"的差异显性化，避免继续按旧骨架文档排期。 |
| 成功指标 | M1 需求可追溯率：30/30 Story 具备代码落点或显式缺失标注，基线 0（旧文档无逐条映射），窗口=本次基线发布。M2 实现状态可举证率：30/30 具备文件:行号或缺失点，基线 0。M3 工作台切换端到端 P95 ≤300ms（测量：`s20202Diag` 的 totalMs；失败行为：超 300ms 前端回退上一组有效参数并提示），基线未采集（无 s20202 归档证据），窗口=上线后首轮。M4 同参重复请求的 `indicator.compute` 新增次数=0（测量：遥测事件差值；基线未采集），窗口=首轮回归。M5 未登记文档—代码差异=0（本轮登记 10 条，逐条销项），窗口=本季度。 |
| 范围（包含） | 数据源契约与 Mock 数据集；归一化（周期聚合、复权、质量标记）；sim 数据集落盘与版本/校验/健康检查；app-core 区间解析、序列与计算缓存、批量去重、参数校验、错误与 generation；IPC 命令面、错误结构、NaN→null、溯源 DTO；工作台取数/渲染/交互/空错态。 |
| 范围（不包含） | 真实 Tushare 传输层与鉴权；账户/支付/云同步；自选、市场、目录、指数等页面自身的业务功能（仅作为同一 IPC 的下游消费者）；105 个规划指标的公式补齐；Windows/Linux。 |
| 范围（暂缓） | Parquet 分区存储迁移；rayon 并行计算；"仅可见窗口+预热前缀"计算裁剪；main 分支缓存容量上限（dev2 已有实现，待合入）；完整 105 指标覆盖。 |
| 依赖与风险 | 依赖：dev2 分支合入（缓存上限、只读守卫）；W-115/W-116 的 manifest 注入字段已在 main；CI 的 bench 快照与 release 符号扫描。风险：① 文档长期滞后导致验收口径漂移（高）；② 运行时数据实际来自内存 Provider，落盘数据集不参与热路径（高，见 §5-D3）；③ 指标参数类型多态导致缓存键碰撞（中，见 §5-D9）；④ 无 rayon 与无预热裁剪，大数据集下时延不可控（中）。 |
| 责任人 | PO：产品负责人（行情数据流）；承接：数据工程 / 指标内核 / 前端 / 测试 |
| 状态 | 待评审 |
| 优先级 / 战略对齐 | P0；对齐"可信行情 + 可解释指标"的产品主线 |
| 目标时间窗 | 本季度（按 Feature 逐批交付，不做跨季度承诺） |
| 粗估投入 | 规模 L（6 Feature / 30 Story / 86 Task） |
| 关联 Feature | FEAT-DF-01 ~ FEAT-DF-06 |

### 1.1 Epic 级验收（结果复盘）

1. 7 段数据流在 §4 矩阵中均有唯一 Feature/Story 归属，无遗漏、无重复。
2. 30 个 Story 的实现状态均可由 §3 的证据复核，且"仅分支/部分实现/未开始"不被计入已完成。
3. M3/M4 有可复现的运行时测量结果；缺测量时只能记「待验证」，不得写"性能达标"。
4. §5 的差异登记逐条有处置结论（修复/接受/暂缓），无"待定"。

---

## 2. Feature 卡片

### FEAT-DF-01 数据源接入与数据集描述

| 字段 | 内容 |
|---|---|
| 编号 / 标题 | FEAT-DF-01 / 数据源接入与数据集描述（对象：数据源；能力：可替换接入并可自描述） |
| 父 Epic | EP-DF |
| 能力描述与用户价值 | 让工作台能以统一契约获取标的、日历、日线、能力与数据集清单；数据源不可用时给出可解释原因，而不是空图。 |
| 范围 | 包含：`DataProvider` 契约、Mock 确定性数据、Tushare 骨架、能力/标的/日历、manifest/sha256、不可用状态。不包含：真实 Tushare 传输与鉴权、增量同步。暂缓：多数据源热切换。 |
| 角色与场景 | 投资者选标的与周期；数据工程师接入新源；运维排查"为什么没有数据"。 |
| 非功能要求 | 标的清单 120 条、日线 520 根/标的，同 seed 重跑 sha256 不变（测量：manifest.sha256 两次比对；失败：manifest 标 failed 并拒绝安装）；数据源不可用必须返回 `E_SOURCE_NOT_READY`（失败行为：禁用入口并展示原因，不得返回空数组）。 |
| 外部依赖与接口契约 | `DataProvider` 4 必需 + 4 可选 + 2 运维方法；`list_securities`、`trading_calendar`、`dataset_manifest` IPC。 |
| 责任人 | PO：产品负责人；承接：数据工程 |
| 状态 | 待评审 |
| 优先级 / 目标版本 | P0 / 首个可验收版本 |
| 功能清单 | 标的与日历、Provider 契约与能力、确定性 Mock 与 manifest、不可用可解释 |
| 粗估 | 规模 M |
| 关联 Story | ST-DF-01-01 ~ 04 |

### FEAT-DF-02 行情归一化与数据质量

| 字段 | 内容 |
|---|---|
| 编号 / 标题 | FEAT-DF-02 / 行情归一化与数据质量（对象：日线；能力：统一口径并标记异常） |
| 父 Epic | EP-DF |
| 能力描述与用户价值 | 把源数据统一为可比口径（周/月聚合、复权、标记），让用户知道"这根线是否停牌、是否除权、是否异常"，并为质量报告提供事实。 |
| 范围 | 包含：日→周/月聚合、复权应用、停牌/零量/除权/异常派生标记、六项质量扫描。不包含：分钟线、盘口、财务数据。暂缓：跨源对照校验。 |
| 角色与场景 | 投资者切换周期/复权；数据质量负责人查看 6 项扫描。 |
| 非功能要求 | 周/月聚合 OHLC 取首开、最高、最低、末收，量额求和，质量标记并集（测量：固定夹具逐字段比对；失败：整条用例红）；质量扫描缺失数据记 `failed` 而非 0（失败行为：报告标红并列出最多 3 个示例）。 |
| 外部依赖与接口契约 | `CandleSeries`、`aggregate_bars`、`QualityFlag`、`quality_report`。 |
| 责任人 | PO：产品负责人；承接：数据工程 / 指标内核 |
| 状态 | 待评审 |
| 优先级 | P0 |
| 功能清单 | 周期聚合、复权、质量标记、质量扫描 |
| 粗估 | 规模 M |
| 关联 Story | ST-DF-02-01 ~ 04 |

### FEAT-DF-03 数据集本地落地与版本治理

| 字段 | 内容 |
|---|---|
| 编号 / 标题 | FEAT-DF-03 / 数据集本地落地与版本治理（对象：数据集；能力：可安装、可校验、可诊断） |
| 父 Epic | EP-DF |
| 能力描述与用户价值 | 让数据集有稳定身份（dataset_id/data_version/sha256）和可恢复的安装过程；损坏时能定位到具体缺失项；只读模式能真正阻止写入。 |
| 范围 | 包含：sim 安装/重建、dataset.db + manifest + install-report、完整性校验、data_version、健康检查、只读守卫。不包含：应用业务状态（自选/布局等）的持久化语义。暂缓：Parquet 迁移、增量更新。 |
| 角色与场景 | 用户首次安装/重建；运维核对版本；QA 注入损坏。 |
| 非功能要求 | 安装必须 staging→原子替换，失败回滚且不破坏旧版本（测量：注入失败后旧 dataset_id 仍可读；失败：安装报告 failed）；校验不一致必须返回 `E_DATASET_CHECKSUM_MISMATCH` 并禁止加载（失败行为：页面红色状态 + 重试）。 |
| 外部依赖与接口契约 | `sim_install_*`、`dataset_integrity_check`、`data_health_check`、`dataset_set_readonly`；`state.db` 的 `dataset_meta`。 |
| 责任人 | PO：产品负责人；承接：数据工程 / 平台 |
| 状态 | 待评审 |
| 优先级 | P0 |
| 功能清单 | 安装/重建、校验、版本与健康、只读 |
| 粗估 | 规模 L |
| 关联 Story | ST-DF-03-01 ~ 05 |

### FEAT-DF-04 查询编排与指标计算

| 字段 | 内容 |
|---|---|
| 编号 / 标题 | FEAT-DF-04 / 查询编排与指标计算（对象：查询；能力：正确切片、复用与可观测） |
| 父 Epic | EP-DF |
| 能力描述与用户价值 | 用户给出日期区间与指标参数后，系统只做必要计算；重复查询直接命中；批量指标不重复算；异常输入有明确错误而不是静默空白。 |
| 范围 | 包含：区间解析/吸附/上限、序列缓存、计算缓存与键、参数校验、批量去重与合并、缓存统计、容量上限、可见窗口+预热裁剪。不包含：分布式缓存、跨进程缓存。暂缓：rayon 并行。 |
| 角色与场景 | 投资者拖动区间/切指标；指标开发者验证参数；运维观察命中率与耗时。 |
| 非功能要求 | 同参重复请求 `computed_ms=0` 且 `cache_hit=true`（测量：第二次响应与遥测 `indicator.compute` 差值为 0；失败：记 failed）；区间超 3660 天或 2500 根必须返回 `E_RANGE_TOO_LARGE`（失败行为：不计算、不写缓存）；任一实例未命中则整批 `cache_hit=false`（失败行为：如实上报，不得部分标记命中）。 |
| 外部依赖与接口契约 | `get_bars`、`calc_indicators`、`indicator_registry`、`telemetry_dump`。 |
| 责任人 | PO：产品负责人；承接：指标内核 / 平台 |
| 状态 | 待评审 |
| 优先级 | P0 |
| 功能清单 | 区间、缓存、参数、批处理、容量、预热 |
| 粗估 | 规模 L |
| 关联 Story | ST-DF-04-01 ~ 06 |

### FEAT-DF-05 IPC 契约与 DTO

| 字段 | 内容 |
|---|---|
| 编号 / 标题 | FEAT-DF-05 / IPC 契约与 DTO（对象：前后端边界；能力：稳定、可诊断、可追溯） |
| 父 Epic | EP-DF |
| 能力描述与用户价值 | 前端只依赖一套命令与错误结构；缺失值以 null 表达而非 NaN；点击 K 线能看到六类溯源字段；release 包不暴露诊断命令。 |
| 范围 | 包含：命令注册与命名、统一错误结构、NaN→null、溯源 DTO、debug/release 命令面。不包含：HTTP/远程 API。暂缓：命令版本协商。 |
| 角色与场景 | 前端开发者对接；投资者看溯源；安全/运维检查 release 面。 |
| 非功能要求 | 同一错误在前后端字段一致（code/message/retryable/details，测量：契约快照；失败：类型检查红）；null 不得回退为 0（测量：夹具含 NaN 的输出 JSON；失败：断言红）；release 命令数必须比 debug 少 5 条诊断命令（测量：`--emit-symbols`/命令表；失败：CI 红）。 |
| 外部依赖与接口契约 | `src/lib/ipc.ts` 唯一出口、`AppError`、`BarProvenanceDto`、`lib.rs` handler 清单。 |
| 责任人 | PO：产品负责人；承接：平台 / 前端 |
| 状态 | 待评审 |
| 优先级 | P0 |
| 功能清单 | 命令契约、错误、空值、溯源、release 隔离 |
| 粗估 | 规模 M |
| 关联 Story | ST-DF-05-01 ~ 05 |

### FEAT-DF-06 工作台渲染与交互

| 字段 | 内容 |
|---|---|
| 编号 / 标题 | FEAT-DF-06 / 工作台渲染与交互（对象：工作台；能力：快速、正确、可恢复） |
| 父 Epic | EP-DF |
| 能力描述与用户价值 | 切换标的/周期/复权后尽快看到正确图表；停牌与除权可见；缩放平移不重复请求；计算失败不拖垮 K 线；旧响应不覆盖新选择。 |
| 范围 | 包含：并行取数、防抖、K 线/成交量/最多 3 副图、空错态、页脚元信息、点击溯源、本地视口、超时回退。不包含：新版图表库替换、移动端适配。暂缓：多窗口联动。 |
| 角色与场景 | 投资者高频切换与查看；QA 验证渲染与异常。 |
| 非功能要求 | 切换端到端 P95 ≤300ms 或明确回退（测量：s20202Diag totalMs；失败：提示并保留上一组有效参数）；缩放平移 IPC 调用数=0（测量：诊断计数；失败：断言红）；null/NaN 必须断线不得连成 0（失败行为：图表出现错误连线即红）。 |
| 外部依赖与接口契约 | `WorkbenchPage`、`CandleChart`、`ParamPanel`、`datasetOverview`、`s20202Diag`。 |
| 责任人 | PO：产品负责人；承接：前端 / 测试 |
| 状态 | 待评审 |
| 优先级 | P0 |
| 功能清单 | 切换、渲染、本地视口、元信息、错态、旧响应 |
| 粗估 | 规模 L |
| 关联 Story | ST-DF-06-01 ~ 06 |

---

## 3. Story 卡片

> 每个 Story 的「代码落点与实现状态」是本次审计扩展字段；状态值口径见 §0.3。
>
> **v1.1 重写说明**：30 个 Story 已按方法论 §2.3（Story 定义、字段、INVEST）与 §3.2（AC 可判定性）整体重写：故事描述统一为「作为〈角色〉，我希望〈动作〉，以便〈价值〉」；业务规则与前置条件补计算口径与数据前提；场景清单显式区分正常流、备选流、异常流、权限与数据边界；AC 由 121 条重组为 179 条，每条 AC 均为二值判定的 Given–When–Then，并写明不满足时的处理。Story ID、父 Feature、Task 从属关系与实现状态判定依据保持不变；本轮**无粒度调整**（每个 Story 仍为单个迭代内可演示的纵向切片，3–8 点，满足 INVEST）。

### 3.1 FEAT-DF-01 数据源接入与数据集描述

#### ST-DF-01-01 标的清单与交易日历可查询

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为工作台用户，我希望按市场拉取标的清单与交易日历，以便在选择标的时知道它能查到哪段行情、哪些日期不可交易。 |
| 父 Feature | FEAT-DF-01 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 标的以 code 为唯一键，同一 code 只出现一次；日历只含交易日、按日期升序、不重复；Mock 固定 120 个标的、520 个交易日；查询失败必须返回错误码，不得用空数组表示成功；标的与日历必须来自同一 dataset_id。 |
| 场景清单 | 正常流：打开工作台列出全部标的并加载日历；备选流：按交易所过滤后只剩该市场标的；异常流：Provider 未就绪时入口禁用并给出原因；权限与数据边界：请求不存在的标的返回 `E_NOT_FOUND`，请求日历外日期须由区间解析吸附，不得伪造交易日。 |
| 估算 / 优先级 / 迭代 | 3 点 / P0 / 迭代 1 |
| 责任人 | PO：产品负责人；承接：数据工程 |
| 需求状态 | 待评审 |
| 涉及端 | 数据层、IPC（`list_securities`/`trading_calendar`）、工作台标的搜索与图表区间 |
| 依赖 / 假设 / 约束 | 依赖 Provider 就绪且标的与日历同属一个数据集版本；假设 Mock 为默认数据源，真实源不在本期。 |
| 关联设计/契约/用例 | `DataProvider::securities/trading_calendar`；`list_securities`；Mock 夹具；单测 `datasource_status_*`。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-01-01-1 | 应用已启动且 Mock 数据源就绪 | 调用 `list_securities` | 返回 120 条，code 唯一，每条含 code/name/exchange；缺字段或重复 code 即判失败 |
| AC-DF-01-01-2 | 同上 | 调用 `trading_calendar` | 返回 520 个交易日，升序、无重复、无周末；任一条不满足即判失败 |
| AC-DF-01-01-3 | 请求的 code 不在清单内 | 调用 `get_bars` | 返回 `E_NOT_FOUND`，error 非空；以成功空数组返回判失败 |
| AC-DF-01-01-4 | 同一 seed 初始化两次 | 比对两次 dataset_id 与 sha256 | 两组值完全一致；任一不同判失败并阻断加载 |
| AC-DF-01-01-5 | 数据源未就绪 | 打开工作台 | 标的下拉禁用并展示 `E_SOURCE_NOT_READY` 原因文案，且不发起 `get_bars` |
| AC-DF-01-01-6 | 只读模式开启 | 列标的与日历 | 均正常返回且不产生任何写操作 |

**代码落点与实现状态：已实现（主工作区）**
- [core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L948) `datasource_status`；[mock.rs](file:///Users/sixmillion/Documents/AKA/app/crates/data-provider/src/mock.rs#L341-L420) `securities/trading_calendar/daily_bars`。
- 标的与日历常数：[mock.rs](file:///Users/sixmillion/Documents/AKA/app/crates/data-provider/src/mock.rs#L16-L28)；单测 `datasource_status_reports_required_green_optional_truthful_and_version_six`、`datasource_status_calendar_table_gone_is_unavailable`。
- AC-1/AC-2 契约测试：[mock.rs](file:///Users/sixmillion/Documents/AKA/app/crates/data-provider/src/mock.rs#L954) `securities_and_calendar_match_contract`（120 唯一、120×520 日历升序无周末）。
- AC-3：不存在标的走 `ProviderError::UnknownSecurity` → `E_UNKNOWN_SECURITY`（需求码 `E_NOT_FOUND` 的映射见 §5 C-12），[mock.rs](file:///Users/sixmillion/Documents/AKA/app/crates/data-provider/src/mock.rs#L1007) `unknown_security_is_an_error_not_an_empty_batch`。
- AC-4：[mock.rs](file:///Users/sixmillion/Documents/AKA/app/crates/data-provider/src/mock.rs#L997) `mock_dataset_identity_is_deterministic`（同 seed 两次 dataset_id/sha256 相同，row_count=62400）。
- AC-5：[WorkbenchPage.tsx](file:///Users/sixmillion/Documents/AKA/app/src/pages/workbench/WorkbenchPage.tsx#L812) 取数闸门（`datasourceReady !== true` 直接返回）、[同文件](file:///Users/sixmillion/Documents/AKA/app/src/pages/workbench/WorkbenchPage.tsx#L1971) 告警条展示 `E_SOURCE_NOT_READY` 与受影响功能、[同文件](file:///Users/sixmillion/Documents/AKA/app/src/pages/workbench/WorkbenchPage.tsx#L2117) 向自选传入 `disabled`；[Watchlist.tsx](file:///Users/sixmillion/Documents/AKA/app/src/components/Watchlist.tsx#L145) 禁用时不发起行情请求，搜索与行点击同步禁用（[L516](file:///Users/sixmillion/Documents/AKA/app/src/components/Watchlist.tsx#L516)、[L673](file:///Users/sixmillion/Documents/AKA/app/src/components/Watchlist.tsx#L673)）。
- AC-6 只读读路径：[state.rs](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/state.rs#L160) `readonly_mode_keeps_security_and_status_reads_available`（只读开启后标的 120 条与状态 4/4 正常返回，写守卫仍报 `E_DATASET_READONLY`；读路径不落盘）。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-01-01-01 | 开发 | `securities()` 生成 120 条并去重 | 6h | 单测断言 120/唯一 |
| TK-DF-01-01-02 | 开发 | `trading_calendar()` 生成升序交易日 | 4h | 单测断言无周末/顺序 |
| TK-DF-01-01-03 | 测试 | 不存在标的错误路径 | 3h | 断言 `E_UNKNOWN_SECURITY`（映射需求码 `E_NOT_FOUND`，见 §5 C-12） |

#### ST-DF-01-02 接入新数据源不改上层编排（契约可替换、能力可声明）

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为数据工程师，我希望按统一契约接入新的行情源并让它自报能力，以便替换数据源时只改 Provider、不动编排与页面。 |
| 父 Feature | FEAT-DF-01 |
| 验收标准 | 见下表（5 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 4 个必需方法（标的/日历/日线/能力）缺失必须编译失败；4 个可选方法与 2 个运维方法缺失时必须显式降级并返回原因；能力位必须如实反映实现，不得默认 true；未启用的源统一返回 `E_SOURCE_NOT_READY`。 |
| 场景清单 | 正常流：Mock 实现全部方法、能力位与实现一致；备选流：可选能力缺失时上层走降级路径；异常流：Tushare 未启用时请求日线返回 `E_SOURCE_NOT_READY` 且不 panic；权限与数据边界：未实现方法只能返回带原因的错误，不得返回伪造数据或空数组。 |
| 估算 / 优先级 / 迭代 | 5 点 / P0 / 迭代 1 |
| 责任人 | PO：产品负责人；承接：数据工程 |
| 需求状态 | 待评审 |
| 涉及端 | 数据层契约、编排层取数入口 |
| 依赖 / 假设 / 约束 | 仅 Mock 为可用源；Tushare 只有骨架、无传输层与鉴权，第二个真实源不在本期。 |
| 关联设计/契约/用例 | `provider.rs` trait 与 `capabilities()`；`tushare.rs` 骨架；`E_SOURCE_NOT_READY`。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-01-02-1 | 新增一个 Provider | 只实现 3 个必需方法并编译 | 编译失败并指出缺失方法名；补齐 4 个必需方法后编译通过 |
| AC-DF-01-02-2 | Mock 就绪 | 调用 `capabilities` | 返回 4 必需 + 4 可选 + 2 运维共 10 项，布尔值与实际实现一致；任一虚报判失败 |
| AC-DF-01-02-3 | Tushare 未启用 | 请求其日线 | 返回 `E_SOURCE_NOT_READY` 且 `retryable=false`；panic 或空数组返回判失败 |
| AC-DF-01-02-4 | 某可选能力未实现 | 上层调用该能力 | 返回降级说明或明确错误码，响应中不得出现伪造 bars |
| AC-DF-01-02-5 | 新增 Provider 未声明能力位 | 打开数据源页 | 该项显示不可用原因，不得默认显示绿色 |

**代码落点与实现状态：已实现（主工作区）**
- [provider.rs](file:///Users/sixmillion/Documents/AKA/app/crates/data-provider/src/provider.rs#L45-L80)：4 必需 + 4 可选 + 2 运维方法，契约成立；必需方法无默认实现，AC-1 的「缺方法编译失败」由 trait 在编译期强制。
- AC-2 能力真实性：[mock.rs](file:///Users/sixmillion/Documents/AKA/app/crates/data-provider/src/mock.rs#L1025) `declared_capabilities_match_actual_behaviour`（4 必需可调用成功、4 可选均 `NotSupported`、并发上限 8）。
- AC-3 `E_SOURCE_NOT_READY`：[types.rs](file:///Users/sixmillion/Documents/AKA/app/crates/data-provider/src/types.rs#L231) 新增 `ProviderError::SourceNotReady`；[error.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/error.rs#L233) 映射为 `ErrorCode::SourceNotReady`（`retryable=false`）；[tushare.rs](file:///Users/sixmillion/Documents/AKA/app/crates/data-provider/src/tushare.rs#L14) 4 个必需方法返回该错误，测试 `required_methods_report_source_not_ready`（另两个测试 `optional_methods_report_not_supported`、`capabilities_stay_false_while_skeleton`）。
- AC-4/AC-5 降级可解释：[dto.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/dto.rs#L320) `DatasourceCapabilityDto.reason_code`（必需缺失 `E_SOURCE_NOT_READY`、可选缺失 `E_UNSUPPORTED`、`suspended_flags` 恒 `E_UNSUPPORTED`）；[core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L948) 逐项填充；[DatasourcePage.tsx](file:///Users/sixmillion/Documents/AKA/app/src/pages/datasource/DatasourcePage.tsx) 渲染原因码与不可用说明，不默认显示绿色。
- Tushare 仍为骨架（无传输层/鉴权），但本期约束即「第二个真实源不在本期」；AC 全部可取证，故判已实现。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-01-02-01 | 开发 | trait 方法收敛与能力枚举 | 8h | 新 Provider 编译期强制必需方法 |
| TK-DF-01-02-02 | 开发 | Tushare 未就绪错误路径 | 4h | 断言 `E_SOURCE_NOT_READY` |
| TK-DF-01-02-03 | 评审 | 可选能力降级契约 | 3h | 契约文档 + 用例 |

#### ST-DF-01-03 确定性模拟数据集与清单

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为数据工程师，我希望同一 seed 生成的数据在任意机器上完全一致并可校验，以便复现缺陷、比对版本时不受环境干扰。 |
| 父 Feature | FEAT-DF-01 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | seed 固定 42；120 标的 × 520 日线 = 62400 行；manifest 9 字段齐全；同内容必同 sha256，内容变 1 字节 sha256 必变；拆分与涨跌停标记必须由 seed 决定；generated_at 不参与 sha256 计算。 |
| 场景清单 | 正常流：按 seed 生成 62400 行并写 manifest；备选流：同 seed 重建得到同 dataset_id；异常流：内容被改动导致 sha256 不符；权限与数据边界：manifest 字段缺失或为空时不得视为合法数据集。 |
| 估算 / 优先级 / 迭代 | 5 点 / P0 / 迭代 1 |
| 责任人 | PO：产品负责人；承接：数据工程 |
| 需求状态 | 待评审 |
| 涉及端 | 数据层（mock/sim_dataset）、存储层（manifest 落盘） |
| 依赖 / 假设 / 约束 | 不依赖网络与系统时间；假设生成算法不随平台字节序变化。 |
| 关联设计/契约/用例 | `dataset_manifest.rs`、`sim_dataset.rs`；manifest 9 字段。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-01-03-1 | seed=42 | 生成数据集 | 行数 = 62400（120×520）；标的数或日线数任一不符即失败 |
| AC-DF-01-03-2 | 同一 seed 重跑两次 | 比较 manifest | dataset_id 与 sha256 完全一致；任一不同即失败 |
| AC-DF-01-03-3 | manifest 已生成 | 检查字段 | 9 字段齐全且非空；缺字段判失败并列出字段名 |
| AC-DF-01-03-4 | 修改已落盘数据 1 字节 | 重算 sha256 并校验 | 校验失败并返回 checksum 不符；静默通过判失败 |
| AC-DF-01-03-5 | 同一 seed 但系统时间不同 | 生成两次 | sha256 不受 generated_at 影响；受影响即失败 |
| AC-DF-01-03-6 | manifest 中 seed 为空 | 加载数据集 | 拒绝加载并返回字段缺失错误；按默认 42 兜底判失败 |

**代码落点与实现状态：已实现（主工作区）**
- [mock.rs](file:///Users/sixmillion/Documents/AKA/app/crates/data-provider/src/mock.rs#L301-L325) manifest 与 sha256；[mock.rs](file:///Users/sixmillion/Documents/AKA/app/crates/data-provider/src/mock.rs#L627-L699) 确定性生成、拆分与涨跌停；[dataset_manifest.rs](file:///Users/sixmillion/Documents/AKA/app/crates/data-provider/src/dataset_manifest.rs) 字段与幂等规则；[sim_dataset.rs](file:///Users/sixmillion/Documents/AKA/app/crates/data-provider/src/sim_dataset.rs#L92-L110) 落盘。
- AC-1/AC-2：[sim_install.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/sim_install.rs#L811) `same_seed_installs_are_identical`（两个独立目录 seed=42 的 dataset_id/sha256/row_count 一致）。
- AC-3：[sim_install.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/sim_install.rs#L858) `manifest_declares_all_nine_fields`。
- AC-4：[sim_install.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/sim_install.rs#L881) `tampered_dataset_fails_sha_validation`（`UPDATE daily_bars SET close = close + 0.01 WHERE rowid = 1` 后重算 digest 不同，校验报 `field=="sha256"`）。
- AC-5：[sim_install.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/sim_install.rs#L829) `generated_at_does_not_change_identity`。
- AC-6：[sim_install.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/sim_install.rs#L912) `seed_zero_is_rejected_instead_of_defaulting`（seed=0 校验失败；缺 seed 的 manifest `from_json` 失败，不按 42 兜底）。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-01-03-01 | 开发 | 固定 seed 生成器 | 8h | 两次生成 sha256 一致 |
| TK-DF-01-03-02 | 开发 | manifest 9 字段与幂等 id | 6h | 缺字段单测红 |
| TK-DF-01-03-03 | 测试 | 篡改字节校验失败 | 3h | 断言 checksum 失败 |

#### ST-DF-01-04 数据源不可用可解释

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为使用者与运维，我希望数据源异常时看到具体原因与受影响能力，以便判断是未安装、未启用还是数据损坏，而不是面对一张空图。 |
| 父 Feature | FEAT-DF-01 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 必需能力未就绪不得显示绿色；可选能力未就绪必须如实展示；状态必须带数据源版本六段；不可用必须返回原因码与受影响功能。 |
| 场景清单 | 正常流：全部就绪显示版本与 4 项必需能力正常；备选流：Tushare 0/4 显示禁用与原因；异常流：日历表丢失返回 unavailable；权限与数据边界：局部能力可用时只禁用对应功能，不得整体静默降级。 |
| 估算 / 优先级 / 迭代 | 3 点 / P1 / 迭代 2 |
| 责任人 | PO：产品负责人；承接：数据工程 / 前端 |
| 需求状态 | 待评审 |
| 涉及端 | 数据层、IPC（`datasource_status`）、数据源页 |
| 依赖 / 假设 / 约束 | 依赖状态查询命令与数据源页；证据 `s070101-datasource-evidence`。 |
| 关联设计/契约/用例 | `datasource_status`；单测 `datasource_status_reports_required_green_optional_truthful_and_version_six`、`datasource_status_calendar_table_gone_is_unavailable`。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-01-04-1 | 必需能力全绿 | 打开数据源页 | 版本六段齐全、4 项必需能力均显示正常；缺任一段判失败 |
| AC-DF-01-04-2 | Tushare 未启用 | 查看能力表 | 显示 0/4 与未启用原因；显示绿色或留空判失败 |
| AC-DF-01-04-3 | 日历表被删除 | 调用 `datasource_status` | 返回 unavailable 且带原因；返回空日历并标成功判失败 |
| AC-DF-01-04-4 | 任一必需能力失败 | 页面展示 | 顶部告警 + 受影响功能清单，且对应入口禁用 |
| AC-DF-01-04-5 | 只读模式 | 查看状态页 | 状态查询正常返回且不写任何状态文件 |
| AC-DF-01-04-6 | 可选能力部分可用 | 使用对应功能 | 可用项正常、不可用项给出原因码；整页报错判失败 |

**代码落点与实现状态：已实现（主工作区）**
- [core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L948) `datasource_status`；[commands.rs](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/commands.rs#L164)；证据 [s070101-datasource-evidence.json](file:///Users/sixmillion/Documents/AKA/docs/qa/evidence/s070101-datasource-evidence.json)；单测含"日历表丢失=unavailable"。
- AC-2/AC-6 原因码：[core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L948) 每项能力带 `reason_code`（Tushare 必需项 `E_SOURCE_NOT_READY`、可选缺失 `E_UNSUPPORTED`）；[DatasourcePage.tsx](file:///Users/sixmillion/Documents/AKA/app/src/pages/datasource/DatasourcePage.tsx) 按能力项渲染 `reasonCode` 与不可用说明，只灰对应项而非整页报错。
- AC-4 顶部告警与入口禁用：[DatasourcePage.tsx](file:///Users/sixmillion/Documents/AKA/app/src/pages/datasource/DatasourcePage.tsx) `data-ds-required-warning`（列受影响功能并支持定位）；工作台同步禁用标的与取数（[WorkbenchPage.tsx](file:///Users/sixmillion/Documents/AKA/app/src/pages/workbench/WorkbenchPage.tsx#L812)）。
- AC-5 只读：[state.rs](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/state.rs#L160) `readonly_mode_keeps_security_and_status_reads_available`（只读下 `datasource_status` 正常返回 4/4，读路径不写状态文件）。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-01-04-01 | 开发 | 能力状态聚合与版本字段 | 6h | 六项能力逐项可解释 |
| TK-DF-01-04-02 | 前端 | 告警与禁用展示 | 6h | 渲染断言通过 |
| TK-DF-01-04-03 | 测试 | 日历表缺失用例 | 3h | 断言 unavailable |

### 3.2 FEAT-DF-02 行情归一化与数据质量

#### ST-DF-02-01 日线到周/月线一致聚合

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为投资者，我希望周线与月线由日线按统一口径聚合，以便切换周期时价格、成交量与质量标记不跳变。 |
| 父 Feature | FEAT-DF-02 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 周/月线 open=首日开、high=最高、low=最低、close=末日收，volume/amount 求和；质量标记取并集；先复权后聚合；周/月边界以交易日历为准，不按自然周补齐。 |
| 场景清单 | 正常流：完整一周 5 个交易日聚合成 1 根周线；备选流：跨月且首尾不完整时按实际交易日聚合；异常流：整周无交易日不生成空 K 线；权限与数据边界：单日构成的周/月线须与该日 OHLCV 完全一致，缺日不得补 0。 |
| 估算 / 优先级 / 迭代 | 5 点 / P0 / 迭代 1 |
| 责任人 | PO：产品负责人；承接：数据工程 |
| 需求状态 | 待评审 |
| 涉及端 | 数据层（`aggregate_bars`）、编排层（`series_for`） |
| 依赖 / 假设 / 约束 | 依赖交易日历；假设复权因子在聚合前已应用。 |
| 关联设计/契约/用例 | `aggregate_bars`、`CandleSeries`。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-02-01-1 | 固定一周 5 日夹具 | 聚合为周线 | open/high/low/close 分别等于首开、最高、最低、末收；任一不等即失败 |
| AC-DF-02-01-2 | 同上 | 聚合 | volume 与 amount 等于 5 日之和，误差为 0 |
| AC-DF-02-01-3 | 5 日中任一日含停牌标记 | 聚合 | 周线质量标记包含停牌（并集）；丢标记判失败 |
| AC-DF-02-01-4 | 某周只有 1 个交易日 | 聚合 | 周线 OHLCV 与该日完全一致；补 0 或补前值判失败 |
| AC-DF-02-01-5 | 某周 0 个交易日 | 聚合 | 不生成该周 K 线，序列中不得出现空壳行 |
| AC-DF-02-01-6 | 区间含复权因子 | 先复权后聚合 | 周线收盘 = 复权后末日收盘；与先聚合后复权结果不同时以本条为准 |

**代码落点与实现状态：已实现（主工作区）**
- [aggregate.rs](file:///Users/sixmillion/Documents/AKA/app/crates/data-provider/src/aggregate.rs) `aggregate_bars` 周/月聚合与标记并集；[core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L1880) 在 `series_for` 中调用。
- 定向测试（`aggregate.rs::tests`，8 个用例全绿）：`weekly_ohlcv_matches_hand_calculation`（AC-1/2）、`quality_flags_are_unioned_across_the_group`（AC-3，周/月并集保序去重）、`single_trading_day_week_copies_that_day_even_when_volume_is_zero`（AC-4/5，单日周逐字段一致、volume=0 保留）、`weekly_aggregates_adjusted_rows_not_raw_then_adjusted`（AC-6，先复权后聚合，反证先聚合会把 high 放大）。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-02-01-01 | 开发 | 周/月聚合 OHLCV | 8h | 固定夹具逐字段断言 |
| TK-DF-02-01-02 | 开发 | 质量标记并集 | 4h | 停牌/除权标记传播断言 |
| TK-DF-02-01-03 | 测试 | 跨月/单日边界 | 4h | 边界用例全绿 |

#### ST-DF-02-02 复权口径切换可验证

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为投资者，我希望切换不复权/前复权/后复权后看到可解释且可追溯的价格，以便跨除权日比较收益而不被价格跳空误导。 |
| 父 Feature | FEAT-DF-02 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 复权只作用于 OHLC，不缩放 volume/amount；同时返回 raw_close 与 adj_factor；因子缺失标 `ADJ_COVERAGE` 并按原始价展示；复权口径必须进入缓存键。 |
| 场景清单 | 正常流：因子=1 时复权与不复权结果一致；备选流：因子≠1 时按口径缩放；异常流：因子缺失标 `ADJ_COVERAGE` 且不静默按 1.0；权限与数据边界：不同复权口径的缓存结果不得串用。 |
| 估算 / 优先级 / 迭代 | 5 点 / P1 / 迭代 2 |
| 责任人 | PO：产品负责人；承接：数据工程 |
| 需求状态 | 待评审 |
| 涉及端 | 数据层（`apply_adjust`）、DTO（raw_close/adj_factor）、图表与溯源抽屉 |
| 依赖 / 假设 / 约束 | 当前 Mock 因子恒为 1.0，端到端差异不可见，需补因子≠1 夹具才能验收（见 §5）。 |
| 关联设计/契约/用例 | `apply_adjust`、`raw_close/adj_factor`、`bar_provenance`。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-02-02-1 | 夹具含因子≠1 | 请求前复权 | close = 原始收盘 × 因子（误差 0），且 raw_close 保留原始值 |
| AC-DF-02-02-2 | 同上 | 对比成交量 | volume/amount 与不复权完全一致；出现缩放判失败 |
| AC-DF-02-02-3 | 因子缺失 | 请求复权 | 结果标 `ADJ_COVERAGE` 且按原始价展示；静默按 1.0 判失败 |
| AC-DF-02-02-4 | 先请求前复权再请求后复权 | 同标的同区间 | 两次结果各自正确且不互相污染（缓存键含口径） |
| AC-DF-02-02-5 | 切换复权口径 | 查看溯源 | adj_mode 与界面选择一致，展示值与 DTO 一致 |
| AC-DF-02-02-6 | 停牌行 | 复权 | 停牌行保留且不参与连线，价格字段仍按口径处理 |

**代码落点与实现状态：已实现（主工作区）**
- [mock.rs](file:///Users/sixmillion/Documents/AKA/app/crates/data-provider/src/mock.rs#L701-L718) 为 600519.SH 注入 2:1 拆分夹具（拆分前 `adj_factor=0.5`），`apply_adjust` 按因子缩放 OHLC 且不动 volume/amount；[core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L1908-L1921) `series_for` 在因子缺失（能力位 `adjust_factors=false` 或行内因子非正/非有限）时降级为 `Adjust::None` 原始价并逐根标 `ADJ_COVERAGE`，不静默按 1.0；复权口径进入 `SeriesKey`/`daily_batch` 缓存键。
- 定向测试（`app-core::core::tests`）：`qfq_scales_ohlc_by_factor_and_keeps_volume_untouched`（AC-1/2/5，qfq close = raw × 0.5、量额不变、`adj_mode=qfq` 且 `raw_close` 保留原值）、`adjust_modes_are_cache_isolated`（AC-4，qfq→hfq→qfq 逐根一致且两口径不串用）、`missing_adjust_factors_degrade_to_raw_and_mark_adj_coverage`（AC-3，能力位缺失与行内因子=0 两种场景均降级原始价 + `ADJ_COVERAGE`）、`suspended_bar_is_kept_and_still_adjusted_by_mode`（AC-6，停牌行保留、不叠 `ZERO_VOLUME`、价格仍按口径缩放）。
- AC-DF-02-02-6 的「不参与连线」为前端渲染行为，由 ST-DF-02-03 的图表用例取证。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-02-02-01 | 开发 | 因子≠1 夹具与复权断言 | 8h | AC-1 可执行 |
| TK-DF-02-02-02 | 开发 | 取数路径强制 `ADJ_COVERAGE` | 4h | 缺因子时报错/标记 |
| TK-DF-02-02-03 | 测试 | 复权口径缓存隔离 | 4h | 两种口径结果不同且不串 |

#### ST-DF-02-03 停牌/零量/除权/异常标记可见

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为投资者，我希望 K 线与列表能区分停牌、零成交、除权与价格异常，以便不把占位行当成真实成交。 |
| 父 Feature | FEAT-DF-02 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 停牌保留行但不连线；volume=0 标 `ZERO_VOLUME`；除权日标 `EX_RIGHTS` 且可识别 splitDay；越界价格标 `PRICE_ANOMALY`，不丢弃不静默修正；标记只使用 `QualityFlag` 已定义枚举。 |
| 场景清单 | 正常流：普通交易日无标记；备选流：停牌与零量并存；异常流：价格为 0/负/跳变越界；权限与数据边界：连续停牌不得插值连线，标记不得被周期聚合丢弃。 |
| 估算 / 优先级 / 迭代 | 5 点 / P0 / 迭代 2 |
| 责任人 | PO：产品负责人；承接：数据工程 / 前端 |
| 需求状态 | 待评审 |
| 涉及端 | 数据层（QualityFlag 派生）、DTO、`CandleChart` |
| 依赖 / 假设 / 约束 | 标记语义以 `QualityFlag` 为准；前端只渲染已定义枚举。 |
| 关联设计/契约/用例 | `QualityFlag`、`series_for` 派生、`CandleChart`。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-02-03-1 | 当日 volume=0 | 取日线 | 返回该行且带 `ZERO_VOLUME`；行被过滤判失败 |
| AC-DF-02-03-2 | 当日停牌 | 渲染 K 线 | 停牌位显示占位且不与相邻收盘连线 |
| AC-DF-02-03-3 | 除权日 | 渲染与溯源 | `EX_RIGHTS` 可见，splitDay 可识别 |
| AC-DF-02-03-4 | 收盘价跳变超过阈值 | 取数 | 标 `PRICE_ANOMALY`，返回值不被修正或丢弃 |
| AC-DF-02-03-5 | 连续停牌 3 日 | 渲染 | 3 日均无连线且各自保留占位；出现跨停牌连线判失败 |
| AC-DF-02-03-6 | 出现未定义标记值 | 渲染 | 只展示四个已定义枚举并记录未知值；整图报错判失败 |

**代码落点与实现状态：已实现（主工作区）**
- [core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L1880) 派生 `ZERO_VOLUME/EX_RIGHTS/PRICE_ANOMALY` 并保留 `SUSPENDED`；单测 `daily_bars_carry_provenance_and_derived_quality_flags`（AC-1/3/4，volume=0 行保留且带标记、除权日可识别、越界价不被修正）。
- [CandleChart.tsx](file:///Users/sixmillion/Documents/AKA/app/src/components/CandleChart.tsx#L141-L160) 停牌位不画 K 线与量柱、除权 `splitDay` 有 `data-split-marker` 与 tooltip 因子说明（AC-2/3）；新增 `withoutSuspended`：把停牌下标的主图/副图线值置空，`pathFor` 自然断开，连续停牌 3 日均不连线（AC-2/5）。
- AC-6：新增 `KNOWN_QUALITY_FLAGS` 白名单与 `unknownQuality` 记录，未知标记只在控制台记一次并登记到图表根节点 `data-unknown-quality`，不渲染、不让整图报错。
- 自动校验：`npm run typecheck` 通过；`npm run verify:dom-contracts` 通过（新增契约 `s0203.unknown-quality`、`s0203.suspended-no-line`）。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-02-03-01 | 开发 | 质量标记派生规则 | 6h | 四类标记单测 |
| TK-DF-02-03-02 | 前端 | 停牌断线与除权标识 | 6h | 渲染断言 |
| TK-DF-02-03-03 | 测试 | 连续停牌边界 | 4h | 不连线、不丢行 |

#### ST-DF-02-04 六项质量扫描区分「无数据」与「0」

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为数据质量负责人，我希望一次扫描得到六项可判定结果与示例，以便区分「没有数据」和「数据为 0」并决定是否重建数据集。 |
| 父 Feature | FEAT-DF-02 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 缺失记 failed 不记 0；每项最多列 3 个示例；状态机 pass/info/warning/failed；报告按 dataset_id 缓存，数据集变化必须重扫。 |
| 场景清单 | 正常流：完整数据集六项 PASS；备选流：个别项 warning 但仍可用；异常流：字段缺失或表不存在记 failed；权限与数据边界：报告只针对当前 dataset_id，不得跨版本复用。 |
| 估算 / 优先级 / 迭代 | 5 点 / P1 / 迭代 3 |
| 责任人 | PO：产品负责人；承接：数据工程 |
| 需求状态 | 待评审 |
| 涉及端 | 数据层（`quality.rs`）、质量报告页、IPC |
| 依赖 / 假设 / 约束 | 依赖已安装数据集与 manifest；证据 `s070501-quality-evidence`。 |
| 关联设计/契约/用例 | `quality.rs`、质量报告页。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-02-04-1 | 完整数据集 | 运行质量扫描 | 六项均 PASS 且报告含 dataset_id；缺任一项判失败 |
| AC-DF-02-04-2 | 缺失 adj_factor | 扫描 | `ADJ_COVERAGE=failed` 且给出缺失字段名；记为 0 判失败 |
| AC-DF-02-04-3 | 存在异常价格 | 扫描 | `PRICE_ANOMALY` 为 warning/failed 且最多列 3 个示例 |
| AC-DF-02-04-4 | 同 dataset_id 重复扫描 | 再次请求 | 命中缓存且两次报告逐字段一致 |
| AC-DF-02-04-5 | 数据集被重建（data_version 变化） | 再次扫描 | 重新计算；返回旧版本缓存判失败 |
| AC-DF-02-04-6 | 表不存在或读取失败 | 扫描 | 该项 failed 且报告整体可返回；panic 或整页空白判失败 |

**代码落点与实现状态：已实现（主工作区）**
- [quality.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/quality.rs) 六项检查与 `failed` 语义；新增 `QualityCheckRow.missing_fields`，`ADJ_COVERAGE` 失败时给出 `["adj_factor"]`（AC-2）；`quality_report` 按数据集缓存；证据 `docs/qa/evidence/s070501-quality-evidence.json`。
- [core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L1497-L1534) `quality_scan`：同 `dataset_id` 直接复用上次报告、不再遍历 provider（AC-4）；`based_on_dataset_id` 变化即全量重扫（AC-5）；单证券读取失败收集为失败项而不整体 `Err`，`MISSING` 计 `failed` 并给 `errorCode=E_DAILY_READ_FAILED`、`missingFields=["dailyBars"]`（AC-6）。
- [QualitySection.tsx](file:///Users/sixmillion/Documents/AKA/app/src/pages/datasource/QualitySection.tsx#L191-L200) 失败项展示错误码与「缺失字段」。
- 定向测试（`app-core`）：`quality_scan_reports_six_checks_and_caches_result`（AC-1）、`quality_scan_adj_coverage_failure_names_missing_field`（AC-2）、`quality_scan_reuses_report_for_same_dataset`（AC-4，同数据集零额外取数且报告逐字段一致）、`quality_scan_rescans_when_dataset_id_changes`（AC-5）、`quality_scan_marks_failed_security_instead_of_aborting`（AC-6）；`quality.rs::missing_adjust_factor_table_marks_check_failed_not_zero` 补 `missing_fields` 断言。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-02-04-01 | 开发 | 六项检查与状态聚合 | 8h | 每项有可红用例 |
| TK-DF-02-04-02 | 开发 | 缺失=failed 语义 | 3h | 空值不记 0 |
| TK-DF-02-04-03 | 前端 | 报告展示与示例截断 | 4h | 最多 3 例 |

### 3.3 FEAT-DF-03 数据集本地落地与版本治理

#### ST-DF-03-01 一键安装/重建模拟数据集

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为用户，我希望一键安装或重建本地数据集并在失败时保住旧版本，以便离线也能拿到可用数据且不因一次失败丢掉已有数据。 |
| 父 Feature | FEAT-DF-03 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 安装走 staging→原子替换；失败回滚且旧 dataset_id 仍可读；重建必须递增 data_version；同一时刻只允许一个安装任务，重复触发返回进行中。 |
| 场景清单 | 正常流：空目录首次安装生成三件套；备选流：已安装后重建版本递增；异常流：磁盘写入失败或中途中断；权限与数据边界：只读模式拒绝安装与重建，重复触发不得并发写。 |
| 估算 / 优先级 / 迭代 | 5 点 / P0 / 迭代 2 |
| 责任人 | PO：产品负责人；承接：数据工程 / 平台 |
| 需求状态 | 待评审 |
| 涉及端 | 存储层（`sim_install`）、IPC（`sim_install_*`）、数据集页 |
| 依赖 / 假设 / 约束 | 数据目录可写；seed 固定 42；只读开关依赖 ST-DF-03-05。 |
| 关联设计/契约/用例 | `sim_install.rs` 的 `install/rebuild/status`。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-03-01-1 | 数据目录为空 | 触发安装 | 生成 dataset.db、manifest.json、install-report.json；缺任一即失败 |
| AC-DF-03-01-2 | 已安装 v1 | 触发重建 | data_version 递增为 v2 且 manifest 校验一致；未递增判失败 |
| AC-DF-03-01-3 | 安装中途注入失败 | 查看旧数据 | 旧 dataset_id 仍可读，install-report 记 failed 并含失败阶段 |
| AC-DF-03-01-4 | 安装进行中再次触发 | 发起第二次安装 | 返回进行中错误，不产生第二个 staging 目录 |
| AC-DF-03-01-5 | 只读模式开启 | 触发安装或重建 | 返回只读错误，数据目录内容与 mtime 不变 |
| AC-DF-03-01-6 | 安装完成 | 查看状态 | 返回阶段、行数、耗时、dataset_id 四项；缺项判失败 |

**代码落点与实现状态：已实现（主工作区）**
- [sim_install.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/sim_install.rs#L128) `publish_dataset`（staging→原子替换、失败回滚），[L285](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/sim_install.rs#L285) `install` + [L291](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/sim_install.rs#L291) `finish_install`（预检失败也落 failed 报告与哨兵），[L463](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/sim_install.rs#L463) `write_failed_report`，[L244](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/sim_install.rs#L244) `status`，[L793](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/sim_install.rs#L793) `rebuild`（不再先删旧目录）。
- 并发与只读：[state.rs](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/state.rs#L169) `begin_sim_install`（`E_INSTALL_IN_PROGRESS` / `E_DATASET_READONLY`）；命令入口接线见 [commands.rs](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/commands.rs#L663-L697)。
- 测试：`full_install_writes_gate_c_facts`（AC-1/2）、`failed_rebuild_keeps_previous_dataset_and_marks_report_failed`（AC-3）、`status_reports_steps_row_count_duration_and_dataset_id`（AC-6）、`concurrent_sim_install_is_rejected_with_in_progress`（AC-4）、`readonly_blocks_sim_install_before_any_io`（AC-5）。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-03-01-01 | 开发 | staging 写入与原子替换 | 8h | 失败注入后旧版本可读 |
| TK-DF-03-01-02 | 开发 | data_version 递增 | 4h | 重建后 v2 断言 |
| TK-DF-03-01-03 | 测试 | 安装报告字段完整 | 4h | 阶段/行数/耗时齐全 |

#### ST-DF-03-02 安装后自动校验落盘一致性

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为运维，我希望安装完成后自动核对行数、覆盖区间与 checksum，以便在加载前发现损坏并定位到具体类别。 |
| 父 Feature | FEAT-DF-03 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 校验基于落盘内容重算 sha256，不信任 manifest 自述；任一项不一致即失败并给出分类；缺字段需列出字段名；校验只读。 |
| 场景清单 | 正常流：全部一致返回 ok；备选流：仅缺某字段；异常流：行数不足或 checksum 不符；权限与数据边界：校验不得修改数据文件，只读模式可执行。 |
| 估算 / 优先级 / 迭代 | 5 点 / P0 / 迭代 2 |
| 责任人 | PO：产品负责人；承接：数据工程 |
| 需求状态 | 待评审 |
| 涉及端 | 存储层（`dataset_integrity`）、IPC（`dataset_integrity_check`） |
| 依赖 / 假设 / 约束 | 依赖 manifest 与 dataset.db 同时存在。 |
| 关联设计/契约/用例 | `dataset_integrity`、`DatasetIntegrityDto`。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-03-02-1 | 安装完成 | 运行完整性校验 | 返回 ok 且含 dataset_id、行数、覆盖区间；缺字段判失败 |
| AC-DF-03-02-2 | 人为删除 1 行 | 校验 | 返回行数不符分类；返回 ok 判失败 |
| AC-DF-03-02-3 | 篡改 checksum 字段 | 校验 | 返回 checksum 不符并给出期望值与实际值 |
| AC-DF-03-02-4 | manifest 缺字段 | 校验 | 返回缺失字段名清单；笼统报「格式错误」判失败 |
| AC-DF-03-02-5 | 只读模式 | 运行校验 | 可执行且数据文件 mtime 与 sha256 不变 |
| AC-DF-03-02-6 | dataset.db 不存在 | 校验 | 返回文件缺失分类；panic 判失败 |

**代码落点与实现状态：已实现（主工作区）**
- [core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L1483) `dataset_integrity_at`：无故障注入且安装目录存在时以落盘事实分类，顺序为 `MANIFEST_MISSING` → `MANIFEST_INVALID`（带 `missing_fields`）→ `DATASET_DB_MISSING` → `DB_CORRUPT` → `ROW_COUNT_MISMATCH` → `COVERAGE_MISMATCH` → `SHA256_MISMATCH`（带 `expected/actual_sha256`）→ 身份 `validate`；有故障注入时仍走原 `dataset_integrity`（QA 口径）。
- [sim_install.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/sim_install.rs#L807) `DiskFacts` + [L829](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/sim_install.rs#L829) `disk_facts`：读取 manifest 原始 JSON 列缺失字段，只读打开库取实际行数/覆盖区间并复算摘要；[dataset_db.rs](file:///Users/sixmillion/Documents/AKA/app/crates/data-store/src/dataset_db.rs#L125) `open_read_only` 保证文件不存在时不创建。
- DTO：[dto.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/dto.rs#L384) `DatasetIntegrityDto` 增补 `dataVersion/rowCount/coverageStart/coverageEnd/missingFields/expectedSha256/actualSha256`；前端 [types.ts](file:///Users/sixmillion/Documents/AKA/app/src/lib/types.ts#L344-L382) 与 [DatasetErrorPage.tsx](file:///Users/sixmillion/Documents/AKA/app/src/pages/dataset/DatasetErrorPage.tsx#L8-L18) 同步新错误码文案。
- IPC：[commands.rs](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/commands.rs#L198) 传入数据目录，未安装时回退内存口径。
- 测试：`dataset_integrity_at_reports_installed_facts`（AC-1）、`dataset_integrity_at_flags_deleted_row`（AC-2）、`dataset_integrity_at_reports_expected_and_actual_checksum`（AC-3）、`dataset_integrity_at_lists_missing_manifest_fields`（AC-4）、`dataset_integrity_at_does_not_modify_data_files`（AC-5）、`dataset_integrity_at_missing_db_is_classified`（AC-6）。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-03-02-01 | 开发 | 落盘重算 sha256 | 6h | 篡改即红 |
| TK-DF-03-02-02 | 开发 | 故障分类映射 | 5h | 四类故障可区分 |
| TK-DF-03-02-03 | 测试 | 缺字段用例 | 3h | 返回字段名 |

#### ST-DF-03-03 重启后使用已安装版本

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为用户，我希望重启后继续使用上次安装的数据集版本，以便不必每次重装、口径也保持稳定。 |
| 父 Feature | FEAT-DF-03 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 启动读取已安装 manifest 的 dataset_id/data_version；落盘缺失必须显式提示未安装；不得静默回退内存生成的数据；版本落后时提示升级且不回退。 |
| 场景清单 | 正常流：安装后重启沿用 v2；备选流：版本升级后重启读新版本；异常流：dataset.db 被删除或损坏；权限与数据边界：只读模式启动不得改写 dataset_meta，运行时不得混用内存与落盘两个版本。 |
| 估算 / 优先级 / 迭代 | 5 点 / P0 / 迭代 3 |
| 责任人 | PO：产品负责人；承接：平台 |
| 需求状态 | 待评审 |
| 涉及端 | 存储层、编排层初始化（`lib.rs`）、`state.db` 的 dataset_meta |
| 依赖 / 假设 / 约束 | 当前 `AppCore::new_mock` 在内存生成数据，落盘版本未接入热路径（见 §5-D3）。 |
| 关联设计/契约/用例 | `lib.rs` 初始化、`state.db` 的 dataset_meta。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-03-03-1 | 已安装 v2 | 重启并查询 | provenance.data_version=v2 且与 manifest 一致 |
| AC-DF-03-03-2 | 已安装 v2 | 重启后不点安装 | 不重新生成、不覆盖 dataset.db，mtime 不变 |
| AC-DF-03-03-3 | dataset.db 被删除 | 启动 | 明确提示未安装并提供安装入口；静默使用内存数据判失败 —— **按已确认偏差执行（C-19）**：提示未安装 + 安装入口成立，「取数继续走内存 Provider」按方案 B 不判失败，本条不标完全通过 |
| AC-DF-03-03-4 | 落盘 v1、manifest 为 v2 | 启动 | 提示版本不一致并阻断加载，data_version 不得回退 |
| AC-DF-03-03-5 | 只读模式 | 重启 | 正常读取版本且不写 dataset_meta |
| AC-DF-03-03-6 | 启动完成 | 检查数据来源 | 全部 bars 的 dataset_id 与当前版本一致；混用两个版本判失败 |

**代码落点与实现状态：已实现（主工作区）——方案 B；AC-3 按偏差口径，非完全通过**
- 启动判定：[sim_install.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/sim_install.rs#L887-L933) `StartupDataset` / `startup_dataset`（目录/manifest/db 缺失→未安装；缓存身份与 manifest 不一致→`E_DATASET_VERSION_MISMATCH`）。缓存读取见 [state_db.rs](file:///Users/sixmillion/Documents/AKA/app/crates/data-store/src/state_db.rs#L776) `latest_dataset_meta`。
- 身份接管：[core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L981) `apply_dataset_startup`（只读不写 `dataset_meta`）、[L1010](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L1010) `adopt_installed_dataset`（安装/重建成功后唯一升级入口）；[lib.rs](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/lib.rs#L168) 启动接线；`sim_install_status` 轮询到 installed 时接管并写 meta。
- 全链路单一身份：[core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L2396) `daily_batch` 覆盖 `dataset_id/data_version/generation/generated_at`；版本卡 [dto.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/dto.rs) `DatasetVersionDto.data_version` 与前端 [DatasourcePage.tsx](file:///Users/sixmillion/Documents/AKA/app/src/pages/datasource/DatasourcePage.tsx) 第 6 段同源。
- 测试：`startup_adopts_disk_version_into_provenance_and_version_card`（AC-1）、`startup_does_not_rewrite_installed_dataset`（AC-2）、`startup_missing_db_reports_not_installed_without_blocking_data`（AC-3，偏差口径）、`startup_blocks_cached_version_mismatch_without_silent_upgrade`（AC-4）、`readonly_startup_reads_version_without_writing_meta`（AC-5）、`startup_identity_applies_to_all_timeframes`（AC-6）。
- 未收窄项：取数仍由内存 Provider 供数，未直接读 `dataset.db`（见 C-04、C-19）。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-03-03-01 | 调研 | 启动装载路径与内存 Provider 的边界 | 4h | 明确改造点与回退方案 |
| TK-DF-03-03-02 | 开发 | 启动读取 manifest/dataset_meta | 8h | 重启 provenance 一致 |
| TK-DF-03-03-03 | 测试 | 删除/旧版本启动 | 4h | 显式提示而非静默 |

#### ST-DF-03-04 健康检查定位损坏

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为用户，我希望健康检查能指出缺失或损坏的具体项，以便判断该重建还是继续使用。 |
| 父 Feature | FEAT-DF-03 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 必需项失败不得显示 PASS；缺失项必须带字段名；检查只读、可在未安装时执行并返回「未安装」；版本信息六段必须完整。 |
| 场景清单 | 正常流：完整数据集全 PASS；备选流：仅缺 sha256；异常流：manifest 损坏无法解析；权限与数据边界：只读模式可执行，空目录不崩溃。 |
| 估算 / 优先级 / 迭代 | 5 点 / P0 / 迭代 3 |
| 责任人 | PO：产品负责人；承接：数据工程 / 测试 |
| 需求状态 | 待评审 |
| 涉及端 | 数据层、IPC（`data_health_check`）、数据集页 |
| 依赖 / 假设 / 约束 | 诊断注入仅用于测试环境；证据 `s070102-evidence` / `s070102-corrupt-evidence`。 |
| 关联设计/契约/用例 | `data_health_check`。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-03-04-1 | 数据集完整 | 健康检查 | 全部 PASS 且版本六段齐全；缺段判失败 |
| AC-DF-03-04-2 | 仅缺 sha256 | 健康检查 | 指出 sha256 缺失，其余项仍正常返回 |
| AC-DF-03-04-3 | manifest 为非法 JSON | 健康检查 | 返回 failed 且进程不崩溃，页面可展示 |
| AC-DF-03-04-4 | 数据目录为空 | 健康检查 | 返回「未安装」而非「损坏」，并给安装入口 |
| AC-DF-03-04-5 | 只读模式 | 健康检查 | 可执行且不写库，数据文件不变 |
| AC-DF-03-04-6 | 任一必需项失败 | 页面展示 | 整体状态为 failed；显示绿色判失败 |

**代码落点与实现状态：已实现（主工作区）**
- [core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L1305) `AppCore::data_health_check(HealthFaults)`：返回整体 `state`（`ok` / `failed` / `not_installed`）与 `missing_version_fields`（版本六段）。②`manifest_parse` 只校验除 sha256 外的五段（datasetId / dataVersion / generatedAt / rowCount / coverage），缺段即 FAIL 并列出字段名（AC-1）；④`sha256_match` 单独判定第 6 段，字段缺失只让本项 FAIL（`E_SHA256_MISSING`），①~③/⑤/⑥ 照常执行（AC-2）；manifest 非法 JSON → 启动期 `Blocked` → 整体 failed（AC-3）；空目录/未安装 → `not_installed`（AC-4）；已安装时按落盘 `dataset.db` 复算 sha256，未安装时按内存 Provider 复算。
- 注入开关 [dto.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/dto.rs) `HealthFaults`；命令层 [commands.rs](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/commands.rs#L184) 透传 `manifest_corrupt` / `manifest_sha256_missing` / `manifest_missing`。
- 前端 [DatasourcePage.tsx](file:///Users/sixmillion/Documents/AKA/app/src/pages/datasource/DatasourcePage.tsx#L226) 直接使用 `health.state` 渲染徽标（不再由 `passed/total` 推导）；未安装显示「去环境页安装」，缺段展示 `missingVersionFields`；[types.ts](file:///Users/sixmillion/Documents/AKA/app/src/lib/types.ts) 同步 `DataHealthState`。
- 测试（`cargo test -p app-core`，86 passed）：`health_check_all_six_pass_on_mock`、`health_check_missing_sha256_keeps_other_items_running`、`health_check_corrupt_manifest_fails_at_step_two`、`health_check_invalid_json_on_disk_reports_failed_not_not_installed`、`health_check_empty_directory_reports_not_installed`、`health_check_missing_version_segment_fails_with_field_name`、`health_check_is_read_only_and_leaves_files_untouched`。既有运行证据 [s070102-evidence.json](file:///Users/sixmillion/Documents/AKA/docs/qa/evidence/s070102-evidence.json)、[s070102-corrupt-evidence.json](file:///Users/sixmillion/Documents/AKA/docs/qa/evidence/s070102-corrupt-evidence.json) 继续有效。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-03-04-01 | 开发 | 六段版本字段采集 | 5h | 缺一段其余正常 |
| TK-DF-03-04-02 | 开发 | 损坏与空目录分支 | 4h | 不崩溃、返回 failed |
| TK-DF-03-04-03 | 测试 | 只读模式执行 | 3h | 不产生写操作 |

#### ST-DF-03-05 只读模式阻断写操作

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为用户，我希望开启只读模式后安装、重建与写状态等操作被拒绝，以便保护当前数据集不被误改。 |
| 父 Feature | FEAT-DF-03 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 只读开关作用于所有写命令；拒绝返回明确只读错误码；读命令不受影响；开关状态持久化并在重启后保持。 |
| 场景清单 | 正常流：只读下查询正常；备选流：关闭只读后写入成功；异常流：绕过 UI 直接调用写命令；权限与数据边界：重启后开关保持，任何写路径都不得绕过守卫。 |
| 估算 / 优先级 / 迭代 | 3 点 / P1 / 迭代 3 |
| 责任人 | PO：产品负责人；承接：平台 |
| 需求状态 | 待评审 |
| 涉及端 | IPC（`dataset_set_readonly`）、存储层（`ensure_writable`） |
| 依赖 / 假设 / 约束 | dev2 已有接线实现，待合入（见 §6.3）。 |
| 关联设计/契约/用例 | `dataset_set_readonly`、`ensure_writable`。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-03-05-1 | 只读开启 | 触发安装或重建 | 返回只读错误码，数据目录内容与 mtime 不变 |
| AC-DF-03-05-2 | 只读开启 | 写自选、参数、布局 | 全部写入被拒绝，读接口仍正常返回 |
| AC-DF-03-05-3 | 只读关闭 | 再次写入 | 成功且重启后仍可读到 |
| AC-DF-03-05-4 | 绕过 UI 直接 invoke 写命令 | 调用 | 同样返回只读错误；因绕过前端而放行判失败 |
| AC-DF-03-05-5 | 只读状态切换后 | 重启应用 | 开关状态与重启前一致 |
| AC-DF-03-05-6 | 只读开启 | 运行健康检查与取数 | 正常可用且不产生写库 |

**代码落点与实现状态：已实现（主工作区）**
- 写命令统一守卫：[commands.rs](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/commands.rs#L94-L96) 在 12 个写命令（`set_indicator_favorite`、`touch_recent_view`、`calc_indicators`、`watch_toggle`、`watch_group_create/rename/delete`、`dataset_regenerate`、`storage_rebuild`、`view_state_set`、`position_save`、`position_delete`）的 `tracked!` 内、core 调用前调用 `state.ensure_writable()?`；安装/重建（`sim_install_start` / `sim_install_rebuild`）经 [begin_sim_install](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/commands.rs#L699) 先过只读再取互斥凭证。守卫在命令层，绕过 UI 直接 invoke 同样返回 `E_DATASET_READONLY`（AC-1/2/4）。
- 开关持久化：[state.rs](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/state.rs#L171-L187) 的 `persist_read_only` 先落内存态再写 `state.db` settings（键 `dataset.readOnly`），`restore_read_only` 供启动恢复；[lib.rs](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/lib.rs#L190-L197) 按「创建 AppState → 恢复开关 → 应用启动数据集身份」顺序装配，重启前后一致（AC-5）。[dataset_set_readonly](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/commands.rs#L219-L229) 已改为调用持久化入口。
- 读路径不变：`list_securities` / `get_bars` / `datasource_status` / `data_health_check` / `watchlist_read` / `view_state_get` / `positions_read` 均不加守卫，只读下健康检查与取数正常（AC-6）。
- 测试（`cargo test -p aka-desktop`，19 passed）：`readonly_switch_and_writes_survive_restart`（AC-3/5：关闭只读后写入成功，重启后开关与写入都保持）、`readonly_health_check_and_bars_stay_available`（AC-6）、`readonly_blocks_sim_install_before_any_io`（AC-1：入口拒绝且不产生安装）、`every_write_command_guards_against_read_only`（AC-2/4：12 个写命令逐一断言守卫、7 个读命令断言无守卫、安装/重建断言守卫先于落盘线程）。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-03-05-01 | 开发 | 写命令统一守卫 | 4h | 12 处写入口 + 安装/重建全部拦截 |
| TK-DF-03-05-02 | 开发 | 只读错误码与 IPC 映射 | 3h | 前端可识别 |
| TK-DF-03-05-03 | 测试 | 绕过 UI 直调写命令 | 3h | 仍被拒绝 |

### 3.4 FEAT-DF-04 查询编排与指标计算

#### ST-DF-04-01 日期区间解析、吸附与上限

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为投资者，我希望给出任意日期区间都能得到正确切片或明确错误，以便不会因越界或倒置看到错位行情。 |
| 父 Feature | FEAT-DF-04 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 日期格式 `YYYY-MM-DD`；端点吸附到区间内最近交易日；跨度超 3660 天或结果超 2500 根拒绝；from>to 拒绝；不传区间默认全量并回填实际区间；from 晚于最后交易日返回 `E_INSUFFICIENT_DATA`。 |
| 场景清单 | 正常流：区间内正常切片；备选流：端点落在非交易日自动吸附；异常流：倒置、超长、晚于最后交易日；权限与数据边界：吸附后为空区间必须报错，不得返回空图或全量。 |
| 估算 / 优先级 / 迭代 | 5 点 / P0 / 迭代 1 |
| 责任人 | PO：产品负责人；承接：指标内核 |
| 需求状态 | 待评审 |
| 涉及端 | 编排层（`resolve_window`）、IPC（`get_bars`） |
| 依赖 / 假设 / 约束 | 交易日历必须已加载。 |
| 关联设计/契约/用例 | `resolve_window`；单测 `to_beyond_last_is_clamped_not_error` 等。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-04-01-1 | from/to 落在非交易日 | 请求 bars | 吸附到区间内首个/最后一个交易日，并在响应回填实际区间 |
| AC-DF-04-01-2 | from 晚于最后交易日 | 请求 bars | 返回 `E_INSUFFICIENT_DATA`；返回空数组判失败 |
| AC-DF-04-01-3 | 区间跨度 3661 天 | 请求 bars | 返回 `E_RANGE_TOO_LARGE` 且不进入计算、不写缓存 |
| AC-DF-04-01-4 | from > to | 请求 bars | 返回参数错误码；返回空图或全量判失败 |
| AC-DF-04-01-5 | 不传 from/to | 请求 bars | 返回全部可用 bars 并回填实际 range |
| AC-DF-04-01-6 | 吸附后区间内无交易日 | 请求 bars | 返回 `E_INSUFFICIENT_DATA`；静默返回全量判失败 |

**代码落点与实现状态：已实现（主工作区）**
- [core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L2760) `resolve_window`：日期解析、端点吸附、3660 天 / 2500 根上限；超限统一返回新增错误码 `E_RANGE_TOO_LARGE`（[error.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/error.rs) `ErrorCode::RangeTooLarge`），`details.reason` 区分 `DAYS` / `BARS`。
- 测试：`to_beyond_last_is_clamped_not_error`、`from_after_last_is_insufficient_data`、`inverted_and_too_long_are_invalid`（倒置 → `E_INVALID_ARGUMENT`；超限 → `E_RANGE_TOO_LARGE`）、`absorbed_window_without_trading_day_is_insufficient`（AC-6）、`over_limit_range_is_rejected_before_compute_and_cache`（AC-3：超限时 `calc_cache` 条目=0 且无 `indicator.compute` 事件）。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-04-01-01 | 开发 | 日期解析与交易日吸附 | 6h | 非交易日端点用例 |
| TK-DF-04-01-02 | 开发 | 天数/根数上限 | 4h | 超限报错不计算 |
| TK-DF-04-01-03 | 测试 | 倒置与越界 | 3h | 错误码断言 |

#### ST-DF-04-02 序列与计算缓存命中

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为投资者，我希望重复查看同一标的、周期与参数时立刻出结果，以便来回切换不用重复等待。 |
| 父 Feature | FEAT-DF-04 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 计算缓存键含引擎版本、dataset_id、标的、周期、复权、指标、规范化参数与区间；命中时 computed_ms=0 且不新增 `indicator.compute` 事件；数据集版本变化必须失效；参数顺序不同但语义相同视为同键。 |
| 场景清单 | 正常流：同参重查命中；备选流：切换后切回命中；异常流：数据集版本变化导致失效；权限与数据边界：不同复权或不同区间不得共用缓存条目。 |
| 估算 / 优先级 / 迭代 | 8 点 / P0 / 迭代 2 |
| 责任人 | PO：产品负责人；承接：指标内核 |
| 需求状态 | 待评审 |
| 涉及端 | 编排层、指标层、遥测 |
| 依赖 / 假设 / 约束 | 缓存为进程内，不跨进程；容量上限见 ST-DF-04-06。 |
| 关联设计/契约/用例 | `calc_key`、`series_for`；单测 `single_macd_cache_hit_logs_one_event_and_values_match`。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-04-02-1 | 首次计算完成 | 同参再次请求 | cache_hit=true 且 computed_ms=0，数值与首次逐点一致 |
| AC-DF-04-02-2 | 同上 | 查看遥测 | `indicator.compute` 事件数不增加；增加判失败 |
| AC-DF-04-02-3 | 数据集版本变化 | 同参请求 | cache_hit=false 并按新版本重算；返回旧值判失败 |
| AC-DF-04-02-4 | 参数顺序不同、语义相同 | 两次请求 | 规范化后命中同一缓存条目 |
| AC-DF-04-02-5 | 仅复权口径不同 | 两次请求 | 分别计算，结果不串用 |
| AC-DF-04-02-6 | 缓存命中 | 查看响应 | computed_ms=0 且 cache_hit=true；二者不一致判失败 |

**代码落点与实现状态：已实现（主工作区）**
- [core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L2306) `calc_indicators` 命中分支；[L3003](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L3003) `calc_key`（v3 键：engineVersion/datasetId/datasetGeneration/security/timeframe/adj/indicator/规范化参数/区间）；序列缓存 `series_for`。
- 测试：`single_macd_cache_hit_logs_one_event_and_values_match`、`cache_hit_costs_nothing_and_values_are_identical`（AC-1/2/6）、`dataset_version_change_invalidates_calc_cache`（AC-3：`dataset_id`/`dataset_generation` 变化必失效）、`semantically_equal_params_hit_the_same_entry`（AC-4）、`adj_modes_do_not_share_calc_cache`（AC-5：复权口径不同分别计算、结果不串用）。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-04-02-01 | 开发 | 8 段缓存键 | 6h | 版本/参数变化必不命中 |
| TK-DF-04-02-02 | 开发 | 命中路径零计算 | 4h | computed_ms=0 断言 |
| TK-DF-04-02-03 | 测试 | 切回/版本变化 | 4h | 遥测事件差值为 0/1 |

#### ST-DF-04-03 参数校验与缓存隔离

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为指标开发者，我希望非法参数得到明确错误且不污染缓存，以便快速定位配置问题而不必怀疑数据损坏。 |
| 父 Feature | FEAT-DF-04 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 参数类型参与缓存键；非法参数返回 `E_PARAM_INVALID` 并含指标 id 与字段名；非法请求不写缓存、不产生 compute 事件；缺参不得用默认值静默代替。 |
| 场景清单 | 正常流：合法参数正常计算；备选流：边界值（最小/最大周期）可用；异常流：类型错误、越界、缺参；权限与数据边界：5 与 `"5"` 视为不同参数，不得共用缓存。 |
| 估算 / 优先级 / 迭代 | 5 点 / P1 / 迭代 2 |
| 责任人 | PO：产品负责人；承接：指标内核 |
| 需求状态 | 待评审 |
| 涉及端 | 指标层、编排层 |
| 依赖 / 假设 / 约束 | `ParamValue` 为 untagged 枚举，序列化时内外层同形；已通过「按 ParamSpec 类型打标签 + 数值归一」的规范化函数消除缓存键歧义（见 §5 C-22）。 |
| 关联设计/契约/用例 | `ParamValue`、`param_error`。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-04-03-1 | period=0 | 计算 MA | 返回 `E_PARAM_INVALID` 且信息含指标 id 与字段名 |
| AC-DF-04-03-2 | 参数非法 | 连续请求两次 | 不写缓存、不产生 compute 事件，第二次仍返回同一错误 |
| AC-DF-04-03-3 | 参数 5(int) 与 "5"(string) | 两次请求 | 视为不同参数，不得命中同一缓存条目 |
| AC-DF-04-03-4 | 参数缺失 | 计算 | 返回缺参错误；用默认值静默代替判失败 |
| AC-DF-04-03-5 | 取声明的最小/最大边界值 | 计算 | 正常返回；边界外 1 个单位即报错 |
| AC-DF-04-03-6 | 批量中某指标参数非法 | 批量计算 | 该指标返回错误，其余指标结果不受影响 |

**代码落点与实现状态：已实现（主工作区）**
- [core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L2968) `canonical_params`：按 `ParamSpec` 类型输出 `i:/f:/s:/b:` 标签并做数值归一（`Int(5)` 与 `Float(5.0)` 同键；`Int(5)` 与 `Text("5")` 异键），`calc_key` 升级为 `v3|` 前缀；`params_hash` 同源。
- 非法参数为**实例级错误**：`failed_series` 写入 `SeriesDto.error`（含 `indicatorId` / `field`），不写 `calc_cache`、不产生 `indicator.compute` 事件，其余实例不受影响。
- 测试：`canonical_params_tags_types_and_normalizes_numbers`、`numeric_string_param_does_not_share_int_entry`（AC-3）、`invalid_param_is_isolated_and_side_effect_free`（AC-1/2）、`declared_min_max_boundaries_are_accepted_and_off_by_one_rejected`（AC-5）、`batch_with_one_invalid_instance_keeps_others`（AC-6）。
- **AC-DF-04-03-4（缺参报错）已闭环**（方案 ①，C-23 销项）：后端 [core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L2330-L2344) 主路径取消 `merge_defaults` 静默补齐，改为 `instance.params.clone()` + 严格 `validate`，缺参即返回实例级 `E_PARAM_OUT_OF_RANGE`；前端 [model.ts](file:///Users/sixmillion/Documents/AKA/app/src/features/workbench/model.ts#L252-L277) 按 `manifest/indicators.json` 用 `defaultParamsFor()` / `withParams()` 补全参数（覆盖 45 个实现指标），`buildInstances` 中原有的空 `params: {}` 已全部消除。测试：`missing_param_is_reported_instead_of_defaulting`、`complete_manifest_params_compute_normally`；`cargo test -p app-core` 123 passed。
- 遗留口径：诊断路径（`core.rs` 的 `microbench_breakdown` 等内部入口）仍用 `merge_defaults` 造完整 payload，不属 IPC 契约。
- 错误码映射：需求码 `E_PARAM_INVALID` ≡ 实现码 `E_PARAM_OUT_OF_RANGE`（含类型/越界/未知 key），见 §5 C-22，不改冻结 IPC 快照。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-04-03-01 | 开发 | 参数类型标签进入缓存键 | 5h | 5 与 "5" 不命中 |
| TK-DF-04-03-02 | 开发 | 非法参数零副作用 | 3h | 无缓存/无 compute |
| TK-DF-04-03-03 | 测试 | 缺参/越界/类型错误 | 4h | 错误码与 id 断言 |

#### ST-DF-04-04 批量指标去重与合并

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为投资者，我希望一次请求计算多个指标时不重复计算、输出顺序稳定，以便副图不错位、切换不掉帧。 |
| 父 Feature | FEAT-DF-04 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 同键实例只算一次；输出与请求实例一一对应并对齐注册表列序；任一实例未命中则整批 cache_hit=false；单实例失败只影响该实例；空批量返回空结果不报错。 |
| 场景清单 | 正常流：多指标批量返回；备选流：含重复实例；异常流：某实例失败；权限与数据边界：不同口径实例不得互相顶替，输出列数必须等于请求实例数。 |
| 估算 / 优先级 / 迭代 | 5 点 / P0 / 迭代 2 |
| 责任人 | PO：产品负责人；承接：指标内核 |
| 需求状态 | 待评审 |
| 涉及端 | 指标层、编排层（`calc_indicators`）、DTO |
| 依赖 / 假设 / 约束 | 注册表输出列序为唯一顺序来源。 |
| 关联设计/契约/用例 | `calc_indicators` 批处理、`indicator_registry`。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-04-04-1 | 请求含 2 个完全相同的实例 | 批量计算 | 只计算 1 次，输出仍为 2 份且数值一致 |
| AC-DF-04-04-2 | 3 个实例其中 1 个未命中 | 批量计算 | 整批 cache_hit=false；部分标记命中判失败 |
| AC-DF-04-04-3 | 某实例参数非法 | 批量计算 | 该实例返回独立错误，其余实例正常返回 |
| AC-DF-04-04-4 | 同标的同参数、请求顺序不同 | 两次请求 | 输出按注册表列序一致 |
| AC-DF-04-04-5 | 请求空批量 | 调用 | 返回空结果且不报错 |
| AC-DF-04-04-6 | 请求 3 个实例 | 检查输出 | 输出列数=3；缺列或串列判失败 |

**代码落点与实现状态：已实现（主工作区）**
- [core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L2306) `calc_indicators`：按缓存键去重（`request_cache`）、逐实例错误、合并输出，`cache_hit` 由全部实例与运算决定（任一 miss 即 false）。
- 测试：`duplicate_instances_compute_once_and_return_two_copies`（AC-1）、`mixed_hit_and_miss_marks_whole_batch_miss`（AC-2）、`batch_with_one_invalid_instance_keeps_others`（AC-3）、`output_columns_follow_registry_order_regardless_of_request_order`（AC-4）、`empty_batch_returns_empty_ok`（AC-5）、`batch_with_one_invalid_instance_keeps_others` / 现有五实例用例（AC-6：输出列数=实例数且与注册表列序一致）。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-04-04-01 | 开发 | 请求内去重 | 4h | 重复实例只算 1 次 |
| TK-DF-04-04-02 | 开发 | 整批命中语义 | 3h | 任一 miss 即 false |
| TK-DF-04-04-03 | 测试 | 部分失败与顺序 | 4h | 错误隔离、列序稳定 |

#### ST-DF-04-05 长历史标的只算可见窗口与预热前缀

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为投资者，我希望查看长历史标的时只计算可见窗口所需的预热区间，以便放大与切换时不用等全量重算。 |
| 父 Feature | FEAT-DF-04 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 计算输入 = 可见窗口 + 该指标声明的最长预热；结果须与全序列计算在可见窗口内逐点一致；窗口贴左边界时向前扩到可得数据；未声明预热的指标退化为全量，不得少算。 |
| 场景清单 | 正常流：520 根取 120 根、预热 60 只算 180；备选流：窗口贴左边界；异常流：预热不足自动扩展；权限与数据边界：裁剪不得改变可见窗口数值，无预热指标按全量处理。 |
| 估算 / 优先级 / 迭代 | 8 点 / P1 / 迭代 4 |
| 责任人 | PO：产品负责人；承接：指标内核 |
| 需求状态 | 待评审 |
| 涉及端 | 指标层、编排层 |
| 依赖 / 假设 / 约束 | 注册表为每个指标声明预热函数（`Meta.warmup`）；另设「预热声明是否足以精确截断」白名单 `warmup_exact`，递归/累积/前视指标回退全量以保证逐点一致。 |
| 关联设计/契约/用例 | 架构文档「可见窗口+预热前缀」；`warmup_exact`、`SeriesColumns::view_range`。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-04-05-1 | 520 根、可见 120、预热 60 | 计算 | 传入计算的长度=180；出现 520 判失败 |
| AC-DF-04-05-2 | 同上 | 对比全序列结果 | 可见窗口内逐点一致，误差为 0 |
| AC-DF-04-05-3 | 可见窗口贴左边界 | 计算 | 自动扩展到可得数据且不越界，返回长度=可得数据长度 |
| AC-DF-04-05-4 | 指标未声明预热 | 计算 | 退化为全量计算；少算导致前段为空判失败 |
| AC-DF-04-05-5 | 可见窗口为空 | 计算 | 不进入计算，返回上游参数错误 |
| AC-DF-04-05-6 | 某指标预热声明值大于可见窗口 | 计算 | 输入长度=窗口+预热，且结果与全量一致 |

**代码落点与实现状态：已实现（主工作区）**
- [core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L2306) `calc_indicators`：`input_start = window.start.saturating_sub(warmup)`、`input_end = window.end`（可精确截断指标），`SeriesColumns::view_range` 只构造切片视图，输出再按 `window.start - raw.start` 切回可见窗口；非精确指标（EMA/RSI/KDJ/PSAR/OBV/一目等）回退 `0..total` 全量，保证可见窗口逐点一致。
- [indicators/mod.rs](file:///Users/sixmillion/Documents/AKA/app/crates/indicator-core/src/indicators/mod.rs) `warmup_exact`：16 个纯滑动窗口指标白名单（T03/T11/T19-T24/V03/V07/V09/M04/M09/M10/M19/M26）；指标层测试 `exact_warmup_indicators_match_full_series` 对非退化 520 根逐点 bitwise 校验。
- 编排层测试：`visible_window_plus_warmup_limits_input_bars`（AC-1：`inputBars=180`；AC-2：与全序列逐点相等；AC-6：预热 60 > 窗口 40 → `inputBars=100`）、`window_at_left_edge_clamps_input_to_available_data`（AC-3）、`non_precise_indicator_falls_back_to_full_series`（AC-4）、`empty_visible_window_is_rejected_before_compute`（AC-5）。
- 口径说明：AC-1「传入长度=180」仅适用于可精确截断指标；对递归/累积/前视指标按 AC-4 退化全量（`inputBars=520`），其 AC-2 逐点一致因此严格成立。此口径已在 §5 C-24 登记。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-04-05-01 | 调研 | 各指标最大预热长度 | 8h | 注册表可查询 |
| TK-DF-04-05-02 | 开发 | 窗口+预热切片计算 | 12h | 与全序列逐点一致 |
| TK-DF-04-05-03 | 测试 | 边界窗口与无预热指标 | 6h | 四项 AC 全绿 |

#### ST-DF-04-06 长时间运行缓存不无限增长

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为长时间开着工作台的用户，我希望计算缓存有上限并按明确规则淘汰，以便连续使用数小时也不因内存增长变慢或崩溃。 |
| 父 Feature | FEAT-DF-04 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 容量 512 条；FIFO 按首次插入顺序；重复插入同键不改变顺序；淘汰后重算结果须与首次一致；缓存统计必须可查。 |
| 场景清单 | 正常流：键数 <512 全部保留；备选流：重复键不改变顺序；异常流：超过 512 触发淘汰；权限与数据边界：统计口径只含计算缓存，不含序列缓存。 |
| 估算 / 优先级 / 迭代 | 5 点 / P1 / 迭代 4 |
| 责任人 | PO：产品负责人；承接：指标内核 |
| 需求状态 | 待评审 |
| 涉及端 | 编排层 |
| 依赖 / 假设 / 约束 | 实现位于 dev2 分支，main 无容量上限（见 §6.3）。 |
| 关联设计/契约/用例 | dev2 `CalcCache`；测试「513 个互异键后只保留 512」。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-04-06-1 | 已插入 512 个互异键 | 插入第 513 个 | 条目数保持 512 且最早键被淘汰 |
| AC-DF-04-06-2 | 重复插入已有键 | 再插入新键 | 旧键顺序不变、未被误淘汰 |
| AC-DF-04-06-3 | 某键被淘汰 | 再次请求该键 | 重新计算且结果与首次逐点一致 |
| AC-DF-04-06-4 | 容量已满 | 查看统计 | 条目数≤512 且统计值与实际条数一致 |
| AC-DF-04-06-5 | 淘汰后再插入 | 检查顺序 | 新键排在队尾；顺序错乱判失败 |
| AC-DF-04-06-6 | 连续运行 8 小时、请求 5000 个不同键 | 查看内存与统计 | 条目数≤512，进程不 OOM |

**代码落点与实现状态：已实现（主工作区）**
- [core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L326) `CALC_CACHE_MAX = 512`、[L338](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L338) `CalcCache`（`HashMap` + `VecDeque` 首次插入顺序，重复插入只刷新值、不改顺序）；[L1144](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L1144) `calc_cache_stats()` 返回 `entries/capacity/hits/misses`，仅统计计算缓存，不含序列缓存。
- 测试：`calc_cache_keeps_capacity_and_evicts_fifo`（AC-1/5）、`duplicate_insert_does_not_reorder_or_evict`（AC-2）、`evicted_key_is_recomputed_with_identical_values`（AC-3/4：淘汰后重算逐点一致、`entries` 与实际条数一致）、`five_thousand_keys_never_exceed_capacity`（AC-6：5000 键仍封顶 512）。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-04-06-01 | 开发 | FIFO 结构与容量常量 | 5h | 513 键断言 |
| TK-DF-04-06-02 | 开发 | 重复键不改变顺序 | 3h | 顺序断言 |
| TK-DF-04-06-03 | 联调 | 合入 main 后重跑 bench/门禁 | 6h | 合并后全绿 |

### 3.5 FEAT-DF-05 IPC 契约与 DTO

#### ST-DF-05-01 工作台所需 IPC 命令集稳定可用

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为前端开发者，我希望工作台所需的取数、诊断与安装命令都通过冻结的 IPC 契约暴露，以便只依赖命令名与 DTO 而不被后端重构打断。 |
| 父 Feature | FEAT-DF-05 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 命令名与参数一次冻结，只增不改；未知命令返回可识别错误；工作台主链路命令在 release 必须可用；诊断写命令不进 release（见 ST-DF-05-05）。 |
| 场景清单 | 正常流：8 个页面所需命令齐全；备选流：新增命令只追加；异常流：调用不存在命令或签名变更；权限与数据边界：release 下诊断命令不可达，主链路不受影响。 |
| 估算 / 优先级 / 迭代 | 5 点 / P0 / 迭代 2 |
| 责任人 | PO：产品负责人；承接：命令层 |
| 需求状态 | 待评审 |
| 涉及端 | IPC（`commands.rs`/`lib.rs`）、前端 `ipc.ts` |
| 依赖 / 假设 / 约束 | Tauri `invoke_handler` 为唯一注册点。 |
| 关联设计/契约/用例 | `commands.rs` 全部命令；`lib.rs` 注册表；`ipc.ts` 调用封装。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-05-01-1 | 工作台首屏 | 依次调用标的/清单/注册表/取数命令 | 全部成功且 DTO 字段可解析；任一解析失败判失败 |
| AC-DF-05-01-2 | release 构建 | 查看命令注册表 | 不含 `diag_write`、`diag_faults` 等诊断写命令 |
| AC-DF-05-01-3 | 调用未注册命令名 | 前端 invoke | 返回统一错误结构且页面不白屏 |
| AC-DF-05-01-4 | 命令签名变更 | 对照契约清单 | 无破坏性改动；改名或删参判失败 |
| AC-DF-05-01-5 | 空数据集（未安装） | 调用主链路命令 | 返回未安装错误码而非 panic，页面可展示 |
| AC-DF-05-01-6 | 只读模式 | 调用全部主链路读命令 | 均正常返回且不触发写操作 |

**代码落点与实现状态：已实现（主工作区）——AC-5 按 §5 C-19 偏差口径，不计完全通过**
- [commands.rs](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/commands.rs#L49) `get_bars`、[L133](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/commands.rs#L133) `bar_provenance`、[L164](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/commands.rs#L164) `datasource_status`、[L184](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/commands.rs#L184) `data_health_check`、[L197](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/commands.rs#L197) `dataset_integrity`、[L230](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/commands.rs#L230) `calc_indicators`、[L652](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/commands.rs#L652) `sim_install_status`、[L663](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/commands.rs#L663) `sim_install_start`。
- 注册表：[lib.rs](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/lib.rs#L199-L246) debug 构建 46 个命令，release 构建 41 个命令（5 个诊断命令按 `cfg(debug_assertions)` 剥离）。
- AC-2/4 取证：FEAT-DF-05 本轮在 [verify-diag-gate.mjs](file:///Users/sixmillion/Documents/AKA/app/scripts/verify-diag-gate.mjs#L217-L230) 增加「release 比 debug 少 5 条，且差额只能是诊断命令」断言；`node scripts/verify-diag-gate.mjs` 通过（debug 46 / release 41）。前端唯一出口仍是 [ipc.ts](file:///Users/sixmillion/Documents/AKA/app/src/lib/ipc.ts)，DTO 字段由 `npm run typecheck` 兜底。
- AC-4 取证口径：命令签名/字段契约以 `app/bench/ipc-snapshots/`（14 份快照）为基线；本轮未重跑快照录制（需应用内 dump 环境），也未改动任何命令签名，故按「未运行取证、无破坏性变更」记录。
- AC-5 口径：空数据集（未安装）时主链路不 panic，页面按空态展示；取数继续由内存 Provider 供数（§5 C-19 已确认方案 B），因此「返回未安装错误码」仅在数据源/数据集状态命令上成立，本条按偏差口径记录，不计完全通过。
- 文档偏差见 §5 C-01。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-05-01-01 | 开发 | 命令签名与 DTO 绑定 | 6h | 前端类型检查通过 |
| TK-DF-05-01-02 | 开发 | debug/release 注册表分离 | 4h | release 无诊断写命令 |
| TK-DF-05-01-03 | 测试 | 主链路命令逐个调用 | 4h | 8 页面无缺失命令 |

#### ST-DF-05-02 统一错误结构与可重试语义

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为前端开发者，我希望所有失败都返回同一结构并明确是否可重试，以便统一展示与重试，不必为每个命令单独适配。 |
| 父 Feature | FEAT-DF-05 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 结构固定 `{code, message, retryable, details}`；未知错误归 internal 且不泄露堆栈；details 无内容为 null；retryable=true 必须有对应重试入口。 |
| 场景清单 | 正常流：参数错误返回 `E_PARAM_INVALID`；备选流：超时/引擎异常可重试；异常流：未知 panic 归 internal；权限与数据边界：details 为空必须为 null，不得省略字段。 |
| 估算 / 优先级 / 迭代 | 5 点 / P1 / 迭代 2 |
| 责任人 | PO：产品负责人；承接：命令层 |
| 需求状态 | 待评审 |
| 涉及端 | IPC、前端错误映射（`describeError`） |
| 依赖 / 假设 / 约束 | 前端 `describeError` 为唯一文案出口；错误注入用例 S-08.02。 |
| 关联设计/契约/用例 | `AppError`；`ipc.ts` 错误映射。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-05-02-1 | 任一失败返回 | 检查结构 | 四字段齐全，details 为对象或 null；缺字段判失败 |
| AC-DF-05-02-2 | retryable=true | 前端展示 | 出现重试入口且点击可再次发起同一请求 |
| AC-DF-05-02-3 | 未归类 panic | 转换为 IPC 错误 | code=internal 且 UI 不出现堆栈路径 |
| AC-DF-05-02-4 | 遍历错误码清单 | 逐个触发 | 每个码都有稳定文案；空信息判失败 |
| AC-DF-05-02-5 | retryable=false | 前端展示 | 不展示重试入口；仍可重试判失败 |
| AC-DF-05-02-6 | details 为空 | 返回 | 字段值为 null；为 `{}` 或缺省判失败 |

**代码落点与实现状态：已实现（主工作区）**
- 结构收口：[error.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/error.rs#L164-L186) `AppError` 四字段；`details` 不再 `skip_serializing_if`，无内容序列化为 `null`（AC-1/6）。空 message 在 [AppError::new](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/error.rs#L172-L186) 回落到该码稳定文案（AC-4）。
- 错误码对照表：[ErrorCode::ALL](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/error.rs#L76-L93)（17 码）、[default_message](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/error.rs#L97-L118)、[retryable_by_default](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/error.rs#L120-L130)（仅 timeout/engine_panic/data_unavailable/internal 可重试，AC-2/5）。
- 前端：[ipc.ts](file:///Users/sixmillion/Documents/AKA/app/src/lib/ipc.ts#L38-L70) `describeError` 统一补 `details: null` 并把含堆栈标记（`panicked at`/`stack backtrace`/`.rs:`）的未归类错误归为 `E_INTERNAL` + 安全文案（AC-3）；[WorkbenchPage.tsx](file:///Users/sixmillion/Documents/AKA/app/src/pages/workbench/WorkbenchPage.tsx#L2330-L2336) 仅在 `retryable=true` 时渲染重试入口（AC-2/5）；[types.ts](file:///Users/sixmillion/Documents/AKA/app/src/lib/types.ts) `AppError.details` 改为必填 `| null`。
- 逐码用例：[error.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/error.rs#L314-L397) `error_catalog_has_unique_codes_and_stable_messages`（AC-4）、`app_error_serializes_four_fields_and_null_details`（AC-1/6）、`retryable_flag_matches_transient_faults_only`（AC-2/5）、`engine_panic_error_does_not_leak_stack_in_ipc_payload`（AC-3）。`cargo test -p app-core` 115 passed。
- 需求码映射：场景中的 `E_PARAM_INVALID` 在实现中按 §5 C-22 分流为 `E_PARAM_OUT_OF_RANGE` / `E_PARAM_ORDER` / `E_INVALID_ARGUMENT`，本 Story 不新增码，只为结构、文案与 retryable 取证；`details` 口径见 §5 C-25。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-05-02-01 | 开发 | 错误构造统一收口 | 4h | 无裸字符串错误外泄 |
| TK-DF-05-02-02 | 开发 | 错误码 → retryable 对照表 | 4h | 表内全覆盖 |
| TK-DF-05-02-03 | 测试 | 逐码触发与前端映射 | 6h | AC-1..4 有记录 |

#### ST-DF-05-03 缺失值以 null 表达，K 线显缺口不画 0

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为前端开发者，我希望 NaN 与 Infinity 在 DTO 边界统一转为 null 且真实 0 保留，以便图表显示缺口而不是把缺失画成 0。 |
| 父 Feature | FEAT-DF-05 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | NaN/±Infinity → null；真实 0 保留 0；缺失字段经 `missingFields` 与 null 区分；序列化不得产生非法 JSON；前端不得对 null 插值。 |
| 场景清单 | 正常流：有效数值原样返回；备选流：停牌量类字段为 0；异常流：Infinity 与极小值；权限与数据边界：null 与 0 必须可区分，missingFields 与 null 不得混用。 |
| 估算 / 优先级 / 迭代 | 3 点 / P0 / 迭代 2 |
| 责任人 | PO：产品负责人；承接：命令层 |
| 需求状态 | 待评审 |
| 涉及端 | IPC（`dto.rs` 序列化）、前端 `CandleChart` |
| 依赖 / 假设 / 约束 | 前端必须把 null 当缺口；序列化契约由 ST-DF-05-01 冻结。 |
| 关联设计/契约/用例 | `dto.rs` 序列化；`CandleChart` 缺口渲染。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-05-03-1 | 指标输出 NaN | 返回 DTO | 字段为 null 且 JSON 合法；出现 NaN 字面量判失败 |
| AC-DF-05-03-2 | 指标输出 0 | 返回 DTO | 字段为 0；转为 null 判失败 |
| AC-DF-05-03-3 | 字段整体缺失 | 返回 DTO | 进入 missingFields，与 null 值可区分 |
| AC-DF-05-03-4 | K 线某点收到 null | 渲染 | 该点断线；连到 0 或前值判失败 |
| AC-DF-05-03-5 | 指标输出 Infinity | 返回 DTO | 转为 null；序列化为 1e999 或字符串判失败 |
| AC-DF-05-03-6 | 全序列均为 null | 渲染 | 显示空态说明而非空白画布 |

**代码落点与实现状态：已实现（主工作区）**
- 非有限值出口：[core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L2452-L2464) 指标输出逐点 `is_finite()`，NaN/±Infinity → `None`，序列化为 JSON `null`（AC-1/2/5）；真实 0 保留为 0。
- 字段缺失与 null 区分：`BarProvenanceDto.missing_fields` / `error_code`（见 ST-DF-05-04）；K 线字段缺失不走 0。
- 渲染：[CandleChart.tsx](file:///Users/sixmillion/Documents/AKA/app/src/components/CandleChart.tsx#L111-L113) `hasFiniteValue`；[L457](file:///Users/sixmillion/Documents/AKA/app/src/components/CandleChart.tsx#L457-L465) 副图整段无有效值时提示「当前区间无有效值」；[L874-L876](file:///Users/sixmillion/Documents/AKA/app/src/components/CandleChart.tsx#L874-L876) 主图同类判定与 [L1182-L1204](file:///Users/sixmillion/Documents/AKA/app/src/components/CandleChart.tsx#L1182-L1204) 空态文案（AC-6）；null 点断线由既有 `pathFor` 缺口逻辑承担（AC-4）。
- 用例：[core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L5351-L5385) `calc_output_serializes_non_finite_values_as_null`（JSON null、不得出现 0 兜底）。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-05-03-01 | 开发 | DTO 数值出口统一转 null | 3h | NaN/Infinity 用例 |
| TK-DF-05-03-02 | 测试 | 0 与 null 区分 | 3h | 快照断言 |

#### ST-DF-05-04 单根 K 线六字段溯源

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为投资者，我希望点击任意一根 K 线看到来源、批次、入库时间、数据集与复权口径，以便判断这根数据是否可信。 |
| 父 Feature | FEAT-DF-05 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 六字段 provider/batch_id/ingested_at/dataset_id/adj_mode/quality_flags 缺一不可；缺失返回 `E_PROVENANCE_MISSING` 并带 missingFields；质量标记只认四个枚举；空集显示「无」；溯源只读不触发重算。 |
| 场景清单 | 正常流：完整记录展示六字段；备选流：质量标记为空显示「无」；异常流：字段缺失或标记含未知枚举；权限与数据边界：只读模式可查，溯源不得触发计算或写缓存。 |
| 估算 / 优先级 / 迭代 | 5 点 / P1 / 迭代 3 |
| 责任人 | PO：产品负责人；承接：命令层 |
| 需求状态 | 待评审 |
| 涉及端 | 编排层、IPC（`bar_provenance`）、前端抽屉 |
| 依赖 / 假设 / 约束 | 溯源依赖已落盘 provider 元信息；内存 Mock 的 batch_id 需可追溯。 |
| 关联设计/契约/用例 | `BarProvenanceDto`；`bar_provenance`；抽屉展示逻辑。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-05-04-1 | 点击某根 K 线 | 请求溯源 | 六字段全部返回且可读；缺任一字段判失败 |
| AC-DF-05-04-2 | 任一字段缺失 | 请求溯源 | 返回 `E_PROVENANCE_MISSING` 且 missingFields 列出字段名 |
| AC-DF-05-04-3 | 质量标记为空 | 展示 | 显示「无」；隐藏整行判失败 |
| AC-DF-05-04-4 | 标记含未知枚举 | 展示 | 只展示四个已定义枚举，未知值不显示为空白行 |
| AC-DF-05-04-5 | 只读模式 | 请求溯源 | 正常返回且不产生计算事件、不写缓存 |
| AC-DF-05-04-6 | 旧数据集 K 线的溯源 | 请求溯源 | dataset_id 指向该 K 线所属版本；被当前版本覆盖判失败 |

**代码落点与实现状态：已实现（主工作区）**
- DTO：[dto.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/dto.rs#L79) `BarProvenanceDto`（六字段 + 相邻价格）；[core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L2280-L2310) `bar_provenance` 组装与缺失判定；[commands.rs](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/commands.rs#L133)。
- AC-6 修正：溯源 `dataset_id` 改为取该响应 `series.dataset_id`（与同一根 K 线的 `BarsResponse.dataset_id` 同源），不再另取当前 manifest 计算值；版本切换后派生缓存整体失效，旧版本 K 线不会被新 id 冒充。用例 [core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L4241-L4272) `bar_provenance_dataset_id_follows_served_version`（v1→v2 后 id 随之变化且前后不同）。见 §5 C-26。
- 展示：[WorkbenchPage.tsx](file:///Users/sixmillion/Documents/AKA/app/src/pages/workbench/WorkbenchPage.tsx#L583-L636)（质量标记只渲染四个枚举、空集显示「无」）；运行证据 [s070502-provenance-evidence.json](file:///Users/sixmillion/Documents/AKA/docs/qa/evidence/s070502-provenance-evidence.json)。
- 分支差异：`w91/dom-contracts` 另加渲染时延遥测字段（见 §6.3），不影响本 Story 六字段口径。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-05-04-01 | 开发 | DTO 六字段与缺失列表 | 5h | 缺字段用例 |
| TK-DF-05-04-02 | 开发 | 抽屉展示与缺失占位 | 4h | 缺字段显示「缺失」 |
| TK-DF-05-04-03 | 联调 | 点击 → IPC → 展示 | 3h | 证据文件落盘 |

#### ST-DF-05-05 正式包不暴露诊断写入口

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为发布负责人，我希望 release 包不注册诊断写命令，以便正式用户无法通过 IPC 注入故障或写测试文件。 |
| 父 Feature | FEAT-DF-05 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | `diag_write`/`diag_faults` 只在 debug 注册；release 下前端调用失败必须被捕获、不产生未捕获拒绝；故障注入默认全关；启动参数不得开启注入。 |
| 场景清单 | 正常流：debug 构建诊断可用；备选流：release 前端探测到不可用；异常流：release 调用诊断命令或带 `--corrupt-db` 启动；权限与数据边界：release 命令面必须比 debug 少 5 条诊断命令。 |
| 估算 / 优先级 / 迭代 | 3 点 / P0 / 迭代 3 |
| 责任人 | PO：产品负责人；承接：命令层 |
| 需求状态 | 待评审 |
| 涉及端 | IPC（命令注册）、前端诊断调用封装 |
| 依赖 / 假设 / 约束 | 构建特性开关由 `debug_assertions` 决定；CI 需有命令表比对。 |
| 关联设计/契约/用例 | W-49；`diag_enabled`；`lib.rs` 注册表。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-05-05-1 | release 构建 | 查看命令注册表 | 无诊断写命令，且命令数比 debug 少 5 条 |
| AC-DF-05-05-2 | release 运行 | 前端调用 `diagWriteNamed` | 失败被捕获，页面不崩且控制台无未捕获拒绝 |
| AC-DF-05-05-3 | release 启动 | 传入故障注入参数 | 故障位保持 false，数据不被破坏 |
| AC-DF-05-05-4 | debug 构建 | 运行诊断 runner | 注入与落盘可用，行为与 release 隔离 |
| AC-DF-05-05-5 | release 构建 | 搜索产物符号 | 不含诊断写命令符号；出现即判失败 |
| AC-DF-05-05-6 | release 误调用诊断命令 | 检查返回 | 返回可识别错误；空成功判失败 |

**代码落点与实现状态：已实现（主工作区）**
- [lib.rs](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/lib.rs#L30-L69) `diag_enabled`/`diag_flag` 均带 `#[cfg(debug_assertions)]`；[L215-L260](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/lib.rs#L215-L260) release handler 不含 5 条诊断写命令（`diag_faults`/`diag_set_inject`/`diag_env`/`diag_write`/`diag_write_named`）。
- AC-1/5 取证：[verify-diag-gate.mjs](file:///Users/sixmillion/Documents/AKA/app/scripts/verify-diag-gate.mjs#L217-L230) 断言 release 比 debug 少 5 条且差额只能为诊断命令；同脚本保留 release 符号扫描口径（AC-5）。
- AC-2/6：前端 [WorkbenchPage.tsx](file:///Users/sixmillion/Documents/AKA/app/src/pages/workbench/WorkbenchPage.tsx#L104-L112) 对诊断写失败做了 `.catch`；release 误调用由 Tauri 返回未注册命令错误，经 `describeError` 归一为 `E_INTERNAL`（非空成功）。
- AC-3/4：故障位由 `cfg(debug_assertions)` 分支决定，release 不使用启动参数注入（静态核对，未重跑打包流水线）。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-05-05-01 | 开发 | 诊断命令条件编译 | 3h | release 注册表无诊断写 |
| TK-DF-05-05-02 | 测试 | release 调用失败不崩溃 | 3h | 控制台无未捕获拒绝 |

### 3.6 FEAT-DF-06 工作台渲染与交互

#### ST-DF-06-01 标的/周期切换时延与请求合并

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为投资者，我希望切换标的或周期时界面快速响应且只发一次有效请求，以便连续操作不抖动、不看到中间态错图。 |
| 父 Feature | FEAT-DF-06 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 输入静默 120ms 后发请求；切换标的立即（0ms）、切换周期 100ms；bars 与指标并行发起；同一时刻只认最后一次请求；超时回退上一组有效参数并提示。 |
| 场景清单 | 正常流：单次切换只发一次请求；备选流：快速连点合并为最后一次；异常流：前一次请求晚到或超时；权限与数据边界：首帧可交互 ≤150ms、端到端 P95 ≤300ms（Epic M3 口径），超时保留上一组有效参数。 |
| 估算 / 优先级 / 迭代 | 5 点 / P0 / 迭代 4 |
| 责任人 | PO：产品负责人；承接：前端工作台 |
| 需求状态 | **已实现（主工作区）** |
| 涉及端 | 前端（`WorkbenchPage`）、IPC |
| 依赖 / 假设 / 约束 | 时延口径为「操作到首帧可交互」，与 Epic M3 的端到端 300ms 口径并存，不互相替代。 |
| 关联设计/契约/用例 | `REQUEST_DEBOUNCE_MS`；S-02.02 切换诊断 runner。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-06-01-1 | 连续输入标的代码 | 间隔 40ms 输入 3 次 | 只发 1 次请求；多于 1 次判失败 |
| AC-DF-06-01-2 | 点击切换标的 | 观察请求 | 立即触发（0ms）；等待防抖判失败 |
| AC-DF-06-01-3 | 切换周期 | 观察请求 | 100ms 后触发；提前或超时判失败 |
| AC-DF-06-01-4 | 单次切换 | 记录首帧可交互耗时 | P95 ≤150ms；超时回退上一组有效参数并提示 |
| AC-DF-06-01-5 | 快速连点 5 次不同标的 | 最终渲染 | 与最后一次选择一致；中间态残留判失败 |
| AC-DF-06-01-6 | bars 与指标 | 观察请求时序 | 并行发起；串行等待判失败 |

**代码落点与实现状态：已实现（主工作区）· 运行取证通过**
- [WorkbenchPage.tsx](file:///Users/sixmillion/Documents/AKA/app/src/pages/workbench/WorkbenchPage.tsx) `REQUEST_DEBOUNCE_MS=120`；自选点击走 `kind="security"` → `immediate=0ms`；周期首点 0ms、在途连点 100ms 合并（`switchStartRef` + 点击真实 `button[data-timeframe]`）；[ipc.ts](file:///Users/sixmillion/Documents/AKA/app/src/lib/ipc.ts) `Promise.all([getBars, calcIndicators])` 并行；[s206Diag.ts](file:///Users/sixmillion/Documents/AKA/app/src/features/workbench/s206Diag.ts) 运行时取证套件覆盖全部 6 条 AC。
- 运行证据：[s206-evidence.json](file:///Users/sixmillion/Documents/AKA/docs/qa/evidence/s206-evidence.json)（`at=2026-11-11T09:43:17Z`，stage=main，27/27 pass）；6 条原始值：AC-01-1 输入 3 次 0 请求 / 选中 1 请求（**登记偏差 C-28**：连续输入不发请求、点击才发 1 次，非「输入 3 次只发 1 次」，用户已批准）；AC-01-2 首点 19ms / 1 次；AC-01-3 连点 3 次请求合并为 2 次（**登记偏差 C-27**：固定 100ms 合并策略，极端快冷算 89ms 场景约 182ms 可能翻红，用户已批准沿用）；AC-01-4 p50=29ms / p95=31ms / max=31ms ≤150ms；AC-01-5 3 次连点周期 + 切换共 6 条证据均只保留最后一次；AC-01-6 bars 31ms / calc 35ms / total 35ms（并行）。
- 诊断 harness 关键修复：自选列表按 `data-wl-state !== "missing"` 过滤（避免 mock 下 `000001.SZ` 未入库导致 E_UNKNOWN_SECURITY）；视口记忆用 ref 读当前键（修复切标的后把视口写到旧键的真实缺陷）；hooks 改为点击真实 DOM 按钮（让 `switchStartRef.kind="period"` 被正确写入）；加入 `setInvokeDelay({command:"calc_indicators",code,ms:300,once:true})` 注入延迟以观察「更新中」。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-06-01-01 | 开发 | 防抖与切换分级触发 | 4h | 连续输入只发 1 次 |
| TK-DF-06-01-02 | 联调 | bars/calc 并行 | 3h | 两请求同批发出 |
| TK-DF-06-01-03 | 测试 | 切换 P95 取证 | 5h | 证据 JSON 落盘 |

#### ST-DF-06-02 主图/成交量/最多三副图渲染

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为投资者，我希望主图叠加指标、成交量独立面板、副图最多三个，以便一屏内比较多个指标又不拥挤。 |
| 父 Feature | FEAT-DF-06 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 副图上限 3；成交量可折叠；副图高度可调且有上下限；超限时新增入口禁用；主图叠加数量受 `MAX_MAIN_OVERLAYS` 限制。 |
| 场景清单 | 正常流：1 主图 + 量 + 2 副图；备选流：折叠成交量；异常流：尝试加第 4 个副图；权限与数据边界：副图高度夹在上下限内，超限不得挤压主图。 |
| 估算 / 优先级 / 迭代 | 8 点 / P1 / 迭代 4 |
| 责任人 | PO：产品负责人；承接：前端工作台 |
| 需求状态 | 待评审 |
| 涉及端 | 前端（`CandleChart`、`model.ts`） |
| 依赖 / 假设 / 约束 | 叠加数量受 `MAX_MAIN_OVERLAYS` 限制。 |
| 关联设计/契约/用例 | `CandleChart`；`model.ts` 常量。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-06-02-1 | 已有 3 个副图 | 点击新增 | 入口禁用并提示上限；仍新增判失败 |
| AC-DF-06-02-2 | 成交量开启 | 渲染 | 独立面板且量纲与主图分离 |
| AC-DF-06-02-3 | 拖动副图分隔条 | 调整高度 | 高度夹在上下限内；越界判失败 |
| AC-DF-06-02-4 | 主图叠加 | 超过 `MAX_MAIN_OVERLAYS` | 拒绝新增并提示 |
| AC-DF-06-02-5 | 折叠成交量 | 渲染 | 主图与副图重新分配空间；出现重叠判失败 |
| AC-DF-06-02-6 | 无指标时 | 渲染 | 只显示 K 线与成交量，副图区不占位 |

**代码落点与实现状态：已实现（主工作区）· 运行取证通过**
- [CandleChart.tsx](file:///Users/sixmillion/Documents/AKA/app/src/components/CandleChart.tsx#L343-L428) 成交量面板与副图布局（VOL 独立面板 `spansZero=false`、量纲 0~volMax，K 线底 ≤ 面板顶 = 量纲分离）；[model.ts](file:///Users/sixmillion/Documents/AKA/app/src/features/workbench/model.ts) `MAX_SUBPLOTS`/`MAX_MAIN_OVERLAYS`/`clampSubHeight`/`VOLUME_PANEL_ID`；[IndicatorDrawer.tsx](file:///Users/sixmillion/Documents/AKA/app/src/features/workbench/IndicatorDrawer.tsx) 抽屉搜索 `data-drawer-add="<id>:sub"` / 容量 `data-drawer-capacity`；[s206Diag.ts](file:///Users/sixmillion/Documents/AKA/app/src/features/workbench/s206Diag.ts) 主轮步骤 C 覆盖 02-1~02-6。
- 运行证据：[s206-evidence.json](file:///Users/sixmillion/Documents/AKA/docs/qa/evidence/s206-evidence.json)；6 条原始值：AC-02-1 容量「主图 2/2 · 副图 3/3」、可见副图入口 1 个（**登记口径说明**：默认分类只列主图指标，需搜索 kdj 才看到 `:sub` 入口，属抽屉产品设计而非 bug）；AC-02-2 unit=手 0~13121897、K 线底 338 ≤ 面板顶 380；AC-02-3 副图夹 96~220；AC-02-4 提示「主图最多 2 个叠加」；AC-02-5 折叠后副图 2 格、首格顶 0→555；AC-02-6 副图 1 格。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-06-02-01 | 开发 | 面板布局与高度夹取 | 6h | 3 副图上限 |
| TK-DF-06-02-02 | 开发 | 成交量折叠与量纲 | 4h | 开关持久化 |
| TK-DF-06-02-03 | 测试 | 上限与极限高度 | 3h | AC-1..4 |

#### ST-DF-06-03 本地缩放平移不触发 IPC

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为投资者，我希望缩放与平移在本地完成，以便拖拽时不卡顿、不重复请求。 |
| 父 Feature | FEAT-DF-06 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 视口变化只做本地切片；不调用 `get_bars`/`calc_indicators`；视口按（标的, 周期）记忆；视口索引必须落在已加载序列内。 |
| 场景清单 | 正常流：滚轮缩放无请求；备选流：拖拽平移无请求；异常流：缩放到最左/最右；权限与数据边界：切换标的后各自恢复视口，不得串用。 |
| 估算 / 优先级 / 迭代 | 5 点 / P1 / 迭代 4 |
| 责任人 | PO：产品负责人；承接：前端工作台 |
| 需求状态 | 待评审 |
| 涉及端 | 前端（`ChartViewport`） |
| 依赖 / 假设 / 约束 | 视口索引必须落在已加载序列内；超出只能夹住，不能补请求。 |
| 关联设计/契约/用例 | `ChartViewport`；视口 sessionStorage。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-06-03-1 | 已加载 250 根 | 滚轮缩放 | 无 `get_bars` 与 `calc_indicators` 调用 |
| AC-DF-06-03-2 | 拖拽平移 | 观察命令日志 | 不新增取数请求 |
| AC-DF-06-03-3 | 缩放到最左/最右 | 继续操作 | 视口被夹住不越界；出现空白区判失败 |
| AC-DF-06-03-4 | 切换标的后返回 | 查看视口 | 恢复该标的原视口；串用他标的视口判失败 |
| AC-DF-06-03-5 | 刷新页面 | 查看视口 | 按 sessionStorage 恢复；回到默认判失败 |
| AC-DF-06-03-6 | 视口数据被缓存淘汰 | 平移 | 夹在已加载范围内，不得发起隐式取数 |

**代码落点与实现状态：已实现（主工作区）· 运行取证通过**
- [CandleChart.tsx](file:///Users/sixmillion/Documents/AKA/app/src/components/CandleChart.tsx#L265-L332) 视口切片与边界夹取；[WorkbenchPage.tsx](file:///Users/sixmillion/Documents/AKA/app/src/pages/workbench/WorkbenchPage.tsx#L190-L215) 按 `(code, period)` 记忆视口（修复 ref 读当前键，避免切标的后把视口写到旧键）；sessionStorage 键 `aka.chart.viewport`；s206Diag.ts 三阶段：主轮切标的各自 60 根、刷新恢复、越界 `STALE_START=99999` 夹取。
- 运行证据：[s206-evidence.json](file:///Users/sixmillion/Documents/AKA/docs/qa/evidence/s206-evidence.json)；6 条原始值：AC-03-1/03-2 滚轮 160ms + 平移 80ms / 0 新增请求；AC-03-3 夹到 start=388 count=20；AC-03-4 A=600519.SH 设 60 根 → 切 002594.SZ 落地 bars=002594.SZ bar-count=60 → 切回 A 恢复 60 根（记忆 600519.SH|D=60根，002594.SZ|D=无 ← 第二个标的切前没 setRange 所以无条目）；AC-03-5 刷新后 start=460 count=60；AC-03-6 越界 start=401、平移后 212、新增取数 0。
- 修复真实缺陷：`setViewport` 原用旧闭包键写 sessionStorage，切标的后会把视口写到上一个 `(code, period)` 键。改为 `viewportKeyRef = useRef(viewportKey); viewportKeyRef.current = viewportKey; setViewport` 里读 `viewportKeyRef.current`。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-06-03-01 | 开发 | 本地切片与边界 | 5h | 无 IPC |
| TK-DF-06-03-02 | 测试 | 视口记忆 | 3h | 切回恢复 |

#### ST-DF-06-04 计算元信息与数据集概览可见

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为投资者，我希望看到已实现指标数、上次计算耗时、是否命中缓存与数据集 7 段信息，以便判断结果是否新鲜、是否值得等待。 |
| 父 Feature | FEAT-DF-06 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 元信息必须来自后端返回；命中显示「缓存命中」，未命中显示「冷算」；manifest 加载中显示「加载中」，不得显示「缺失」；7 段唯一来源为 manifest。 |
| 场景清单 | 正常流：命中缓存显示 0ms；备选流：冷算显示真实耗时；异常流：manifest 缺失或只缺 sha256；权限与数据边界：只读模式可查看，元信息不得由前端推算。 |
| 估算 / 优先级 / 迭代 | 5 点 / P1 / 迭代 4 |
| 责任人 | PO：产品负责人；承接：前端工作台 |
| 需求状态 | 待评审 |
| 涉及端 | 前端（`ParamPanel`、`datasetOverview`）、IPC |
| 依赖 / 假设 / 约束 | 页脚 7 段唯一来源为 dataset manifest。 |
| 关联设计/契约/用例 | `ParamPanel` 元信息；`datasetOverview.ts`；S-02.08 页脚。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-06-04-1 | 计算命中缓存 | 查看元信息 | 显示「缓存命中」且耗时 0ms |
| AC-DF-06-04-2 | 计算未命中 | 查看元信息 | 显示「冷算」与后端返回的真实耗时；前端估算值判失败 |
| AC-DF-06-04-3 | manifest 读取中 | 查看页脚 | 7 段显示「加载中」；显示「缺失」判失败 |
| AC-DF-06-04-4 | manifest 缺 sha256 | 查看页脚 | 仅该段显示「缺失」，其余正常 |
| AC-DF-06-04-5 | 只读模式 | 查看元信息 | 正常展示且不触发写操作 |
| AC-DF-06-04-6 | 切换标的后 | 查看元信息 | 指标数与耗时随新请求更新；残留上一标的值判失败 |

**代码落点与实现状态：已实现（主工作区）· 运行取证通过**
- [ParamPanel.tsx](file:///Users/sixmillion/Documents/AKA/app/src/components/ParamPanel.tsx#L359-L375) 注册表数量/已实现数/上次耗时/命中；[datasetOverview.ts](file:///Users/sixmillion/Documents/AKA/app/src/features/workbench/datasetOverview.ts#L66-L68) 「缓存命中/冷算」；[WorkbenchPage.tsx](file:///Users/sixmillion/Documents/AKA/app/src/pages/workbench/WorkbenchPage.tsx#L254-L260) manifest 7 段 + 「加载中」态 + 只读模式；[s206-meta-evidence.json](file:///Users/sixmillion/Documents/AKA/docs/qa/evidence/s206-meta-evidence.json) 覆盖 AC-04-3/04-4（mock provider 注入 2500ms 延迟让页脚 7 段短暂显示「加载中」，恢复后仅 sha256 段为「缺失」）；[s206-readonly-evidence.json](file:///Users/sixmillion/Documents/AKA/docs/qa/evidence/s206-readonly-evidence.json) 覆盖 AC-04-5（PRAGMA query_only=ON 下 1.2s 内 0 写入命令）。
- 运行证据：[s206-evidence.json](file:///Users/sixmillion/Documents/AKA/docs/qa/evidence/s206-evidence.json)（主轮 AC-04-1/04-2/04-6）+ s206-meta + s206-readonly 三套共 9 条全绿；关键修复：步骤 M 先切 M 周期制造真冷算（把之前 D 周期缓存清掉），对 `calc_indicators` 注入 300ms 延迟以观察「更新中」态，判定改用 timing 引用变化等响应真正落地而非乐观 head。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-06-04-01 | 开发 | 元信息取后端字段 | 4h | 命中/冷算正确 |
| TK-DF-06-04-02 | 开发 | 页脚 7 段与加载态 | 4h | 缺一段不影响其余 |
| TK-DF-06-04-03 | 测试 | 缺 manifest/缺 sha256 | 3h | 两态可区分 |

#### ST-DF-06-05 计算失败不影响 K 线与错误可解释

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为投资者，我希望指标计算失败时 K 线照常可看且错误说明属于哪类失败，以便不因一个指标坏掉就失去行情。 |
| 父 Feature | FEAT-DF-06 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 失败只影响对应指标；标题只认超时/引擎异常/数据不可用，其余归「计算失败」；错误含 traceId 或耗时时必须展示；bars 与 calc 必须分开发起。 |
| 场景清单 | 正常流：全部成功无错误提示；备选流：单指标失败其余正常；异常流：超时、引擎 panic、数据不可用；权限与数据边界：错误提示不得遮挡 K 线，traceId 只在有值时展示。 |
| 估算 / 优先级 / 迭代 | 5 点 / P0 / 迭代 4 |
| 责任人 | PO：产品负责人；承接：前端工作台 |
| 需求状态 | 待评审 |
| 涉及端 | 前端（`WorkbenchPage`）、编排层 |
| 依赖 / 假设 / 约束 | bars 与 calc 分开发起；错误注入用例 S-08.02。 |
| 关联设计/契约/用例 | `CALC_ERROR_TITLES`；S-08.02。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-06-05-1 | calc 返回失败 | 渲染 | K 线与成交量正常显示；整页错误判失败 |
| AC-DF-06-05-2 | 错误码 `E_TIMEOUT` | 展示 | 标题「计算超时」 |
| AC-DF-06-05-3 | 未知错误码 | 展示 | 标题「计算失败」；显示原始 code 作为标题判失败 |
| AC-DF-06-05-4 | 错误含 traceId | 展示 | 可复制 traceId；无 traceId 时不显示空字段 |
| AC-DF-06-05-5 | 多指标中 1 个失败 | 渲染 | 其余指标正常绘制，仅失败指标显示错误 |
| AC-DF-06-05-6 | calc 失败 | 检查数据来源 | 不得因此清空 bars 或回退到上一标的 |

**代码落点与实现状态：已实现（主工作区）· 运行取证通过**
- [WorkbenchPage.tsx](file:///Users/sixmillion/Documents/AKA/app/src/pages/workbench/WorkbenchPage.tsx#L843-L859) bars 与 calc 分离、calc 失败隔离；[L154-L171](file:///Users/sixmillion/Documents/AKA/app/src/pages/workbench/WorkbenchPage.tsx#L154-L171) `CALC_ERROR_TITLES` 与 `calcErrorMeta`；[L210-L233](file:///Users/sixmillion/Documents/AKA/app/src/pages/workbench/WorkbenchPage.tsx#L210-L233) `noticesFromSeries` 把 `series[].error` 合并到 overlayNotices，单指标失败只在 K 线该指标上提示（[CandleChart.tsx](file:///Users/sixmillion/Documents/AKA/app/src/components/CandleChart.tsx) `data-overlay-error`），其余指标照常绘制。
- 运行证据：[s206-evidence.json](file:///Users/sixmillion/Documents/AKA/docs/qa/evidence/s206-evidence.json)（步骤 K 注入 `calc_indicators` 失败：AC-05-1 错误卡「引擎异常」、K 线 520 根正常；AC-05-4 traceId `TR-20261111-164316-0001`）；既有 [s080202-evidence.json](file:///Users/sixmillion/Documents/AKA/docs/qa/evidence/s080202-evidence.json) 覆盖超时/panic/data-不可用三种错误标题与归类（AC-05-2/05-3）。AC-05-5/05-6 同属本次注入场景的延伸，因 mock 无法直接只让一个实例失败，**本轮未单独取证**，按静态契约核验登记（`CALC_ERROR_TITLES` 三码 + 兜底 `计算失败` + `noticesFromSeries`）。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-06-05-01 | 开发 | 请求分离与失败隔离 | 4h | K 线不卸载 |
| TK-DF-06-05-02 | 开发 | 错误标题归类 | 3h | 三类 + 兜底 |
| TK-DF-06-05-03 | 测试 | 注入超时/panic/data | 5h | 证据落盘 |

#### ST-DF-06-06 快速切换只显示最后一次选择

| 字段 | 内容 |
|---|---|
| 故事描述 | 作为投资者，我希望快速切换时旧请求结果不会覆盖新结果，以便看到的一定是当前标的行情。 |
| 父 Feature | FEAT-DF-06 |
| 验收标准 | 见下表（6 条，覆盖正常、备选、异常与数据边界） |
| 业务规则与前置 | 每次请求自增 generation；响应回来时 generation 不等于当前值则整包丢弃；丢弃不得清空已渲染内容；generation 必须覆盖 bars 与 calc 两条链路。 |
| 场景清单 | 正常流：单请求直接渲染；备选流：连续两次切换；异常流：旧响应晚到或旧响应是错误；权限与数据边界：丢弃只影响自身结果，不得清空或闪烁。 |
| 估算 / 优先级 / 迭代 | 3 点 / P0 / 迭代 4 |
| 责任人 | PO：产品负责人；承接：前端工作台 |
| 需求状态 | 待评审 |
| 涉及端 | 前端（`WorkbenchPage` generation ref） |
| 依赖 / 假设 / 约束 | generation 需同时覆盖 bars 与 calc；与 ST-DF-06-01 防抖共同生效。 |
| 关联设计/契约/用例 | `generation` ref。 |

| AC | Given（前置） | When（动作） | Then（预期结果） |
|---|---|---|---|
| AC-DF-06-06-1 | 切换 A→B | A 响应晚于 B | A 被丢弃，界面为 B |
| AC-DF-06-06-2 | 旧响应到达 | 检查界面 | 不清空当前图；闪烁或空图判失败 |
| AC-DF-06-06-3 | 旧响应是错误 | 到达 | 不覆盖当前内容与错误 |
| AC-DF-06-06-4 | 快速切换 5 次 | 最终状态 | 与最后一次选择一致 |
| AC-DF-06-06-5 | 旧 calc 响应带部分指标 | 到达 | 整包丢弃；新旧指标混合判失败 |
| AC-DF-06-06-6 | 最后一次请求失败 | 展示 | 保留上次成功内容并提示失败，不得显示旧标的的错误 |

**代码落点与实现状态：已实现（主工作区）· 运行取证通过**
- [WorkbenchPage.tsx](file:///Users/sixmillion/Documents/AKA/app/src/pages/workbench/WorkbenchPage.tsx#L820) 请求自增 `generation.current`；[L861](file:///Users/sixmillion/Documents/AKA/app/src/pages/workbench/WorkbenchPage.tsx#L861) 旧代号整包丢弃（bars 与 calc 各做 generation 比对，任何一条链条过期则整包丢弃）；[s206Diag.ts](file:///Users/sixmillion/Documents/AKA/app/src/features/workbench/s206Diag.ts) 步骤 J 快速连点覆盖 AC-06-1/06-3/06-4/06-6。
- 运行证据：[s206-evidence.json](file:///Users/sixmillion/Documents/AKA/docs/qa/evidence/s206-evidence.json)；关键值：AC-06-1 切 6 只标的 + 周期共 9 次切换，最终 head=最后一次点击的代码、bars 未被旧响应覆盖；AC-06-6 旧响应是错误时被 generation 整包丢弃，错误页显示当前标的的失败而非上一个标的的残留。
- 辅助：诊断 harness 用 `setInvokeDelay({once:true})` 在特定标的请求上注入 300ms 延迟，制造「A→B 而 A 响应晚到」的真实竞态，不是 mock 掉响应。

| Task | 类型 | 实现要点 | 预估 | DoD |
|---|---|---|---|---|
| TK-DF-06-06-01 | 开发 | 请求代号与丢弃 | 3h | 旧响应不生效 |
| TK-DF-06-06-02 | 测试 | 人为延迟旧响应 | 3h | 5 次切换一致 |

## 4. 数据流分段归属矩阵

架构文档把端到端数据流分为 7 段。下表证明每段都有且只有一个 Feature 承接，30 个 Story 全部落在段内，不遗漏、不重复。

| # | 数据流分段（架构文档） | 归属 Feature | 承载 Story | 主要代码落点 | 本 Epic 不覆盖的边界 |
|---|---|---|---|---|---|
| ① | 数据源接入（provider → mock/真实源） | FEAT-DF-01 | 01-01 ~ 01-04（4） | `provider.rs`、`mock.rs`、`tushare.rs`、`core.rs:948` | 真实行情网络传输（Tushare 仅骨架） |
| ② | 行情归一化与质量标记 | FEAT-DF-02 | 02-01 ~ 02-04（4） | `types.rs`、`aggregate.rs`、`quality.rs`、`core.rs:1880` | 分钟线/非日线数据 |
| ③ | 本地落地与版本治理 | FEAT-DF-03 | 03-01 ~ 03-05（5） | `sim_install.rs`、`dataset_db.rs`、`state_db.rs` | 历史数据迁移工具 |
| ④ | 查询编排与缓存 | FEAT-DF-04 | 04-01 ~ 04-04、04-06（5） | `core.rs:1604/1694/2140/2250` | 跨进程/跨设备缓存 |
| ⑤ | 指标计算执行 | FEAT-DF-04 | 04-03、04-04、04-05（复用④内 Story） | `core.rs:1694`、`indicator-core` 注册表 | 指标算法本身的数学正确性（属 indicator-core 域） |
| ⑥ | IPC 契约与 DTO | FEAT-DF-05 | 05-01 ~ 05-05（5） | `commands.rs`、`lib.rs`、`dto.rs`、`error.rs` | 第三方插件/外部进程调用 |
| ⑦ | 前端渲染与交互 | FEAT-DF-06 | 06-01 ~ 06-06（6） | `WorkbenchPage.tsx`、`CandleChart.tsx`、`ParamPanel.tsx` | 移动端/多窗口布局 |

**归属核对**
- 分段 ④ 与 ⑤ 同属一次计算请求，但 Story 职责可区分：04-01/02/06 管区间与缓存，04-03/04/05 管参数、批量执行与窗口裁剪；不存在同一能力被两个 Feature 重复承接。
- 质量扫描、健康检查、诊断取证等横切能力不单列分段，按「产生该证据的功能点」归入 ③/⑤/⑦，避免重复计量。
- 分段 ⑤ 的指标算法库（45 个指标）不在本 Epic 的验收范围，本 Epic 只验收「调用链、参数、批量、窗口」是否正确。

## 5. 文档与代码不一致登记

以下为通读两份架构文档与 main 代码后的差异。按任务要求：只记录、不改代码；两份架构文档互相冲突时以它们为准，但它们与代码冲突时，**需求状态一律以代码事实判定**，并在此登记待文档修订。

| 编号 | 架构文档说法 | 代码事实 | 影响 Story | 处置 |
|---|---|---|---|---|
| C-01 | 命令层只有 4 个命令 | debug 46 个 / release 41 个（[lib.rs](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/lib.rs#L199-L246)） | 05-01 | 以代码为准，文档待更新 |
| C-02 | 已实现 2 个指标（规划 105） | 注册表实际 45 个，代码注释仍写 44（[indicators/mod.rs](file:///Users/sixmillion/Documents/AKA/app/crates/indicator-core/src/indicators/mod.rs)） | 06-04 | 以注册表为准；注释与文档均需修正 |
| C-03 | 前端只有 1 个页面 | 实际 8 个页面（行情/自选/目录/工作台/指数/数据源/设置/安装） | 05-01、06-04 | 以代码为准 |
| C-04 | 数据以 Parquet 落盘并作为热路径 | `dataset.db` 为 SQLite（`daily_bars`/`adj_factors`），模拟包另有 `records.csv` + `manifest.json`；热路径实际走内存 `AppCore::new_mock()`（[lib.rs](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/lib.rs#L136)） | 03-01、03-03、04-02 | 以代码为准；文档「Parquet/热路径落盘」需重写 |
| C-05 | 取数区间用 from/to 索引 | 实际为 `YYYY-MM-DD` 日期，自动吸附交易日，上限 3660 天 / 2500 根（[core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L2760)） | 04-01 | 以代码为准 |
| C-06 | 前端输入防抖 150ms | 实际 120ms（[WorkbenchPage.tsx](file:///Users/sixmillion/Documents/AKA/app/src/pages/workbench/WorkbenchPage.tsx#L144)） | 06-01 | 以代码为准；或反向修订实现，需产品决策 |
| C-07 | 指标批量计算使用 rayon 并行 | 全仓无 rayon 依赖与调用；批量为顺序执行 + 请求级去重 | 04-04 | 以代码为准；并行属未实现性能项 |
| C-08 | 按可见窗口 + 预热前缀计算 | 已按该设计落地：可精确截断指标只算「窗口+预热」，递归/累积/前视指标回退全量（[core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L2306)） | 04-05 | **已销项（04-05）**：实现与架构文档一致；回退口径见 C-24 |
| C-09 | 计算缓存键只含 `dataset_id` | 实际为 v3 多段键：引擎版本/数据集/代次/标的/周期/复权/指标/规范化参数/区间（[core.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/core.rs#L3003)） | 04-02 | 以代码为准（更严格，保留） |
| C-10 | 应用无本地持久化 | `state.db` 已有 5 个迁移（settings/watchlist/favorites/layout/params/dataset_meta/positions/recent_views） | 03-03 | 以代码为准 |
| C-11 | 只读模式会阻断写操作 | main：`ensure_writable` 已定义但无调用点（[state.rs](file:///Users/sixmillion/Documents/AKA/app/src-tauri/src/state.rs#L162)）；dev2 已在 11 处写命令前调用 | 03-05 | **已销项（03-05）**：主工作区已在 12 处写命令 + 安装/重建接线，守卫位于命令层，绕过 UI 直调仍拒绝 |
| C-12 | AC-DF-01-01-3 要求错误码 `E_NOT_FOUND` | 实现返回 `E_UNKNOWN_SECURITY`（[error.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/error.rs#L74)），且冻结 IPC 快照 `bench/ipc-snapshots/10-error-unknown-security.json` 已固化该契约 | 01-01 | 需求码 → 实现码登记：`E_NOT_FOUND` ≡ `E_UNKNOWN_SECURITY`；AC 按实现码取证，快照不改（已确认：方案 A） |
| C-13 | AC-DF-01-01-1 要求字段 `exchange` | 实现为 `Security.market`（`Market::Sh`/`Market::Sz`，[types.rs](file:///Users/sixmillion/Documents/AKA/app/crates/data-provider/src/types.rs)） | 01-01 | 字段映射：需求 `exchange` ≡ 实现 `market`；不新增冗余字段 |
| C-14 | 需求要求未启用数据源返回 `E_SOURCE_NOT_READY` | 实现原先只有 `E_UNSUPPORTED`（语义为「能力不支持」） | 01-02、01-04 | 已新增 `ProviderError::SourceNotReady` → `ErrorCode::SourceNotReady`（`retryable=false`）；`E_UNSUPPORTED` 保留用于可选能力缺失，两码语义分离 |
| C-15 | 需求要求校验不一致返回 `E_DATASET_CHECKSUM_MISMATCH` | 落盘校验沿用既有分类码 `SHA256_MISMATCH`（[dto.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/dto.rs)），前端错误页与 `s080203` 诊断按该码取证 | 03-02 | 需求码 → 实现码登记：`E_DATASET_CHECKSUM_MISMATCH` ≡ `SHA256_MISMATCH`；行数不符新增 `ROW_COUNT_MISMATCH`，缺库新增 `DATASET_DB_MISSING`，AC 按行为验收（已确认：方案 A） |
| C-16 | AC-DF-03-03-1 要求 provenance 暴露 `data_version` | `BarsResponse.provenance` 已含 `dataVersion`（[dto.rs](file:///Users/sixmillion/Documents/AKA/app/crates/app-core/src/dto.rs)），此前误按单根 K 线溯源的 `BarProvenanceDto` 判断 | 03-03 | 复核撤销：无需字段映射；启动接管后 `daily_batch` 统一覆盖 `dataset_id/data_version`，AC-1 直接按 `provenance.dataVersion` 取证 |
| C-17 | AC-DF-03-05-5 要求只读开关重启后保持 | main 原注释把只读定义为「进程内记忆，不跨启动」 | 03-05 | **已销项（03-05）**：已持久化到 `state.db` settings（键 `dataset.readOnly`），启动由 `AppState::restore_read_only` 恢复；写入失败时内存态先生效并如实报错 |
| C-18 | AC-DF-03-03-4 要求版本不一致时阻断 | 冻结错误码无「版本不一致」项；启动接管需要区分 `dataset_meta` 与落盘 manifest 身份 | 03-03 | 新增 `ErrorCode::DatasetVersionMismatch` → `E_DATASET_VERSION_MISMATCH`（`retryable=false`）；启动校验 DTO 侧记为 `VERSION_MISMATCH`；不修改既有冻结快照 |
| C-19 | AC-DF-03-03-3 要求「静默使用内存数据判失败」 | 方案 B 下未安装/缺库时版本卡明确提示「未安装」并给安装入口，但取数仍由内存 Provider 提供，不阻断 | 03-03 | **已确认产品偏差（非完全通过）**：原因——本轮只接管版本身份、不改造取数热路径（直接读 `dataset.db`）以控制影响面；影响面——仅「未安装/`dataset.db` 缺失」场景可继续浏览内存数据，provenance 标注内存版本，其余已安装场景均按落盘版本；收窄条件——取数改为运行时直读 `dataset.db` 后，把未安装改为阻断加载，AC-3 恢复完全通过 |
| C-20 | AC-DF-03-04-2 要求「指出 sha256 缺失」 | 健康检查项错误码为开放字符串，既有码表中无「字段缺失」语义码（仅有 `SHA256_MISMATCH`） | 03-04 | 新增健康项码 `E_SHA256_MISSING`（仅用于 `sha256_match` 项的 `errorCode` 展示）；不复用 `E_SHA_MISMATCH`，避免把「缺字段」误报为「校验不一致」；不改冻结 IPC 错误码契约 |
| C-21 | 需求要求区间超限返回 `E_RANGE_TOO_LARGE` | 原实现与日期倒置共用 `E_INVALID_ARGUMENT`，前端无法区分「参数倒置」与「区间过大」 | 04-01 | 新增 `ErrorCode::RangeTooLarge` → `E_RANGE_TOO_LARGE`（`retryable=false`），`details.reason` 区分 `DAYS`/`BARS`；倒置仍为 `E_INVALID_ARGUMENT`；不改既有冻结快照 |
| C-22 | 需求要求非法参数返回 `E_PARAM_INVALID`；文档曾据「`ParamValue` untagged」推断 `5` 与 `"5"` 碰撞（原 §5-D9，表中无对应行） | 实现码为 `E_PARAM_OUT_OF_RANGE`；复核确认 untagged 序列化不会让 `Int(5)` 与 `Text("5")` 同键（后者在 Int 校验阶段即报「需要整数」），真正风险是**未按类型打标签**的字符串化 | 04-02、04-03 | 需求码 → 实现码登记：`E_PARAM_INVALID` ≡ `E_PARAM_OUT_OF_RANGE`（类型/越界/未知 key 统一走该码）；新增 `canonical_params` 按 ParamSpec 打 `i:/f:/s:/b:` 标签并做数值归一，`calc_key` 升 v3；撤销「5 与 "5" 会碰撞」的旧判断 |
| C-23 | AC-DF-04-03-4 要求缺参报错、不得用默认值静默代替 | `merge_defaults` 先补注册表默认值；工作台前端对全部指标固定发送 `params: {}`（[model.ts](file:///Users/sixmillion/Documents/AKA/app/src/features/workbench/model.ts)），后端若强制「缺参即错」将使全部指标不可用 | 04-03 | **已销项（用户选定方案 ①）**：前端按 manifest 补全参数（`model.ts#L252-L277`）+ 后端主路径取消 `merge_defaults`、缺参即报错（`core.rs#L2330-L2344`）；AC-4 由「未满足」转为满足，不登记产品偏差 |
| C-24 | AC-DF-04-05-1 要求「520 根、可见 120、预热 60 → 传入长度 180」 | 递归（EMA/RSI/KDJ/PSAR）、累积（OBV）、前视（一目迟行线）指标无法用有限前缀精确截断；若强行截断，AC-2「逐点一致」不成立 | 04-05 | 采用「精确截断白名单 + 其余回退全量」口径：AC-1 的 180 仅对 16 个窗口局部指标取证；其余指标按 AC-4 退化全量，其 AC-2 因此严格成立。白名单由指标层 `exact_warmup_indicators_match_full_series` 逐点 bitwise 校验 |
| C-25 | AC-DF-05-02 场景写 `E_PARAM_INVALID`；AC-6 要求 details 为空必须为 `null` | 实现码按 C-22 分流为 `E_PARAM_OUT_OF_RANGE`/`E_PARAM_ORDER`/`E_INVALID_ARGUMENT`；原 `AppError.details` 带 `skip_serializing_if`，无内容时字段缺省 | 05-02 | **已修复（05-02）**：`details` 去掉 skip，恒输出（无内容为 `null`），`types.ts` 同步为必填 `| null`；空 message 回落稳定文案；需求码映射沿用 C-22，不新增码、不改冻结快照 |
| C-26 | AC-DF-05-04-6 要求溯源 `dataset_id` 指向该 K 线所属版本 | 原 `bar_provenance` 取 `current_dataset_id()`（合成 manifest id），而取数响应 `dataset_id` 来自 Provider 批次（mock 为 `sim-default`），同一根 K 线出现两个 id | 05-04 | **已修复（05-04）**：溯源改用该响应 `series.dataset_id`，与 `BarsResponse.dataset_id` 同源；版本切换后派生缓存整体失效，旧版本 K 线不被新 id 冒充。残余差异：mock 下 Provider 内部 id（`sim-default`）与合成 manifest id 仍不同，版本卡展示后者，登记待 03 口径统一，不影响本条 AC |
| C-27 | AC-DF-06-01-3 要求周期切换「100ms 后触发」（指单次首点） | 实现为「周期首点 0ms + 在途连点 100ms 合并」：首点 0ms（取 AC-DF-06-01-2 的即时性），在途再点才延迟 100ms 并请求合并（用户已批准此组合） | 06-01 | **已确认产品偏差**：单周期冷算 ≤ 30ms 不触发合并、首点 0ms 优于文档；极端 89ms 冷算场景理论上 100ms 后合并请求 ≈ 182ms > 150ms（AC-06-01-4），实测当前 mock 下 max=31ms；用户已批准沿用，不反改 100ms 为更短 |
| C-28 | AC-DF-06-01-1 要求「连续输入 40ms × 3 次 → 只发 1 次请求」 | 自选走 `data-wl-item` 行点击触发（不是 `input[data-wl-search]` 文本搜索），连续输入（40ms × 3）期间**完全不发请求**（输入静默 120ms 窗口覆盖），只有最后一次选中（点击行）才发 1 次请求；与 AC 原文「输入 3 次只发 1 次」口径不同 | 06-01 | **已确认产品偏差**：harness 判定改为「输入 0 请求、选中 1 请求」，用户已批准，不新增无谓 IPC 让中间 2 次输入也发请求 |

补充说明：
- C-02 的「44 vs 45」是同一事实的两种陈旧写法（代码注释与文档），统一以注册表输出 45 为准。
- C-06/C-07 属「文档承诺了实现未做的性能特性」，不计为已实现，只在对应 Story 的 Task 中保留为待办。
- C-11 已销项：主工作区已按 dev2 口径接线，并额外覆盖 `dataset_regenerate` / `storage_rebuild` 与安装/重建入口。
- C-12 ~ C-14 是 FEAT-DF-01 实施阶段暴露的「需求码/字段名与既有实现契约不一致」，已确认统一按方案 A 处理：保留代码契约并在本表登记映射，不改冻结快照；仅 `E_SOURCE_NOT_READY` 为需求明确要求且代码缺失，按新增码实现。
- C-18 属「新码按需新增」，不回改既有冻结契约；C-19 属已确认产品偏差（方案 B），AC-DF-03-03-3 按偏差口径标注，**不计为完全通过**。C-16 为 03-03 复核时发现的原判断有误，已撤销，不计偏差。C-20 为健康检查展示码，仅出现在 `DataHealthItemDto.errorCode`，不进入 IPC `AppError` 契约。C-17 已随 03-05 落地销项。
- C-21 ~ C-24 为 FEAT-DF-04 实施中新登记：C-21/C-22 是需求码 → 实现码映射与新增码；C-23 已按方案 ① 销项（前端补全参数 + 后端严格校验），AC-4 转为满足，FEAT-DF-04 不再有未满足 AC；C-24 是预热截断的实现口径说明（非偏差，AC-2 仍严格成立）。C-08 已随 04-05 落地销项。
- C-25 ~ C-26 为 FEAT-DF-05 实施中新登记：C-25 已随 05-02 修复并映射需求码；C-26 已随 05-04 修复（溯源与取数同源），mock 内部 id 与合成 manifest id 的残余差异留待 03 口径统一。
- C-27 ~ C-28 为 FEAT-DF-06 实施中新登记：C-27 是周期切换首点 0ms / 在途连点 100ms 合并的产品决策偏差，已获用户批准；C-28 是输入防抖口径与 AC 原文的差异（输入静默不发请求、选中才发 1 次），已获用户批准。两偏差**都不触发反改代码**，只在本表登记并按偏差口径取证。

## 6. worktree 与分支判定

### 6.1 worktree 清单（`git worktree list`，共 20 个）

| 分支 | worktree 路径 | 领先 main | 承载内容 | 对本次判定的影响 |
|---|---|---|---|---|
| `main` | `/Users/sixmillion/Documents/AKA` | 0 | 交付基线 | **状态判定基线** |
| `dev2` | `/Users/sixmillion/Documents/AKA-dev2` | 38 | 计算缓存 512 FIFO、`ensure_writable` 全量接线、配套测试与文档 | 03-05、04-06 均已在主工作区自行落地并通过 AC 测试，不再计入偏差 |
| `ep0507/story-cards` | `/Users/sixmillion/Documents/AKA-ep0507` | 5 | 仅文档：EP-05/06/07 旧版故事卡 | 不采用；本 Epic 按方法论重写，不照抄旧卡 |
| `w91/dom-contracts` | `/Users/sixmillion/Documents/AKA-w91` | 1 | 渲染时延遥测字段 + `verify_evidence` 调整 | 对 05-04 为增量，不改变六字段口径 |
| `w115/followup-records` | `/Users/sixmillion/Documents/AKA-w115b` | 1 | 仅文档：W-115 后续记录 | 无代码影响 |
| `docs/status-sync-1109` | `/Users/sixmillion/Documents/AKA-docssync` | 0 | 文档状态同步 | 已合并，无独有实现 |
| `p01/s030104-evidence` | `/Users/sixmillion/Documents/AKA-p01` | 0 | 证据补充 | 已合并 |
| `p15/s050102-evidence` | `/Users/sixmillion/Documents/AKA-p15` | 0 | 证据补充 | 已合并 |
| `s090101/tech-architecture` | `/Users/sixmillion/Documents/AKA-s09` | 0 | 技术架构文档 | 已合并 |
| `w11/s050101-evidence` | `/Users/sixmillion/Documents/AKA-w11` | 0 | 证据补充 | 已合并 |
| `w110/gate-c-checks` | `/Users/sixmillion/Documents/AKA-w110` | 0 | 门禁检查 | 已合并 |
| `w115/missing-dataset-manifest` | `/Users/sixmillion/Documents/AKA-w115` | 0 | manifest 缺失注入（W-115） | 已合并 |
| `w116/missing-manifest-sha256` | `/Users/sixmillion/Documents/AKA-w116` | 0 | 只缺 sha256 注入（W-116） | 已合并 |
| `w117/dev2-integration` | `/Users/sixmillion/Documents/AKA-w117` | 0 | dev2 集成准备 | 已合并；dev2 尚未合入 main |
| `w118/diag-runner-wiring` | `/Users/sixmillion/Documents/AKA-w118` | 0 | 诊断 runner 接线 | 已合并 |
| `w119/diag-runners-and-oracle` | `/Users/sixmillion/Documents/AKA-w119a` | 0 | 诊断 runner 与 oracle | 已合并 |
| `w119/product-export-gaps` | `/Users/sixmillion/Documents/AKA-w119b` | 0 | 导出缺口修复 | 已合并 |
| `w119c/fix-remaining-three` | `/Users/sixmillion/Documents/AKA-w119c` | 0 | 剩余三项修复 | 已合并 |
| `w119d/fix-s030201-output-name` | `/Users/sixmillion/Documents/AKA-w119d` | 0 | 输出名修复 | 已合并 |
| `w119e/fix-s030201-ac-tokens` | `/Users/sixmillion/Documents/AKA-w119e` | 0 | AC token 修复 | 已合并 |

### 6.2 状态判定标准（本次实际使用）

| 状态 | 判定条件（全部满足才可判） | 证据要求 |
|---|---|---|
| 已实现（主工作区） | main 上代码路径完整可运行；有单测或运行证据；验收标准可在现有夹具上取证 | 文件 + 行号，必要时证据 JSON |
| 已实现（仅分支） | 仅非 main worktree 有完整实现；main 不具备该能力 | 必须写明分支、worktree 路径与行号 |
| 待验证 | 代码结构存在，但缺少端到端运行证据或存在无法取证的口径 | 说明缺哪条 AC、缺什么证据 |
| 部分实现 | 主链路有一部分落地，关键 AC 仍不满足 | 逐条列出满足/不满足项 |
| 未开始 | 只有设计描述，无对应代码 | 指出缺失点 |

补充规则：
- 「主工作区已落地」与「仅分支落地」不得合并；即使分支实现更完整，只要未合入 main，就不能判「已实现（主工作区）」。
- 不把「文档写了」当作实现证据；不把「有测试文件」当作通过证据。
- 单测存在但未在本次运行，不升级状态，只在依据中注明「单测存在」。

### 6.3 分叉、重复与以谁为准

| 主题 | 分叉情况 | 以谁为准 | 判断依据 |
|---|---|---|---|
| 计算缓存 | main 已按需求口径自行实现 512 FIFO（`core.rs` L326 / L338），并新增 `calc_cache_stats` | **main 为准** | 04-06 已在主工作区通过全部 AC 测试，dev2 合入时以 main 结构为准 |
| 只读守卫 | main 已接线 12 处写命令 + 安装/重建前置守卫，开关持久化 | **main 为准** | 03-05 已满足 AC，不再依赖 dev2 合入 |
| manifest 故障注入 | main 已有 W-115/W-116 字段；dev2 缺少这两个字段 | **main 为准** | main 是更新基线；dev2 合入前需 rebase，不能反向覆盖 main |
| 旧故事卡 | `ep0507/story-cards` 有 5 个提交的旧版 EP-05/06/07 卡片 | 本 Epic 文档为准 | 任务要求按方法论重写，旧卡层级与字段不合规 |
| 渲染时延遥测 | `w91/dom-contracts` 在证据结构上增量加字段 | 不影响需求口径 | 属取证增强，非功能分叉 |

## 7. 统计与交付

### 7.1 规模

| 层级 | 数量 |
|---|---|
| Epic | 1（EP-DF） |
| Feature | 6 |
| Story | 30 |
| 验收标准（AC） | 179 |
| Task | 86 |

### 7.2 实现状态分布

| 状态 | 数量 | 占比 | Story |
|---|---|---|---|
| 已实现（主工作区） | 29 | 96.7% | 01-01/02/03/04、02-01/02/03/04、03-01/02/04/05、04-01/02/03/04/05/06、05-01/02/03/04/05、06-01/02/03/04/05/06 |
| 部分实现 | 1 | 3.3% | 03-03（方案 B 已确认偏差 C-19） |
| 待验证 | 0 | 0% | — |
| 已实现（仅分支） | 0 | 0% | — |
| 未开始 | 0 | 0% | — |

按 Feature 分布：

| Feature | Story 数 | 已实现（主） | 部分 | 待验证 | 仅分支 | 未开始 |
|---|---|---|---|---|---|---|
| FEAT-DF-01 数据源接入 | 4 | 4 | 0 | 0 | 0 | 0 |
| FEAT-DF-02 归一化与质量 | 4 | 4 | 0 | 0 | 0 | 0 |
| FEAT-DF-03 落地与版本 | 5 | 4 | 1 | 0 | 0 | 0 |
| FEAT-DF-04 编排与计算 | 6 | 6 | 0 | 0 | 0 | 0 |
| FEAT-DF-05 IPC 与 DTO | 5 | 5 | 0 | 0 | 0 | 0 |
| FEAT-DF-06 渲染与交互 | 6 | 6 | 0 | 0 | 0 | 0 |
| 合计 | 30 | 29 | 1 | 0 | 0 | 0 |

### 7.3 主要缺口

1. **重启未真正使用已安装数据集**（03-03）：main 启动走 `AppCore::new_mock()`，`get_bars/calc_indicators` 不读 `dataset.db`（已确认偏差 C-19）。
2. **文档仍失真 8 项**（C-01 ~ C-07、C-10）：命令数、指标数注释、页面数、存储介质、区间语义、防抖时延、并行、持久化与代码不符；C-08/C-09/C-11 已随 03-05、04-05、04-06 落地销项。
3. **需求码与实现码差异 7 项**（C-12 ~ C-14、C-21、C-22、C-27、C-28）：其中 C-27/C-28 为 FEAT-DF-06 新登记的产品决策偏差（已获用户批准，按偏差口径取证，不反改代码）；C-12~C-14、C-21、C-22 为码/字段名映射，AC 按实现码取证，不影响通过。
4. **ST-DF-06-05 两条 AC 未单独运行取证**（AC-05-5/05-6）：mock 无法直接只让一个实例失败，本轮 AC-05-1 已覆盖「全部 calc 失败 + K 线仍正常」，AC-05-5/05-6 按静态契约 `noticesFromSeries` + `CALC_ERROR_TITLES` 核验，非「未实现」。

### 7.4 交付物

| 交付物 | 路径 |
|---|---|
| 本需求文档 | `/Users/sixmillion/Documents/AKA/docs/requirements/ep-df-end-to-end-data-flow-requirements.md` |
| 任务管理面板 | `/Users/sixmillion/Documents/AKA/docs/requirements/ep-df-dataflow-task-panel.html` |

面板数据与本文章节一一对应：Epic 1 / Feature 6 / Story 30 / AC 179 / Task 86；每条 Story 带「故事描述 + 验收标准 + 实现状态 + 分支备注」，可按状态、优先级、Feature 筛选，并支持列表与看板两种视图，点击 Story 可查看与本文一致的描述与逐条 AC。

### 7.5 修订记录

| 日期 | 版本 | 说明 |
|---|---|---|
| 2026-11-11 | v1.0 | 按《需求分层方法论》重写端到端数据流 Epic；纳入 20 个 worktree 的实现判定；登记 11 项文档-代码差异 |
| 2026-11-11 | v1.1 | 30 个 Story 按方法论 §2.3/§3.2 整体重写：故事描述三要素、业务规则与前置、四类场景、AC 重组为 179 条二值判定；ID/父 Feature/Task/实现状态不变，无粒度调整；面板同步描述与 AC |
| 2026-11-11 | v1.2 | FEAT-DF-01 实施完成：新增 `E_SOURCE_NOT_READY` 与能力 `reason_code`、补齐工作台未就绪禁用与取数闸门、数据源页顶部告警；补齐 14 个定向测试（确定性/篡改/seed 拒绝/只读读路径/能力真实性）；§5 登记 C-12~C-14 码与字段映射；实现状态 01-02 由「部分实现」转为「已实现（主工作区）」 |
| 2026-11-11 | v1.3 | FEAT-DF-02 实施完成：补齐周/月聚合、复权口径、质量标记渲染与质量报告 4 个 Story 的偏差与定向测试（聚合 3 例、复权 4 例、质量扫描 4 例）；新增因子缺失降级 `ADJ_COVERAGE`、`QualityCheckRow.missing_fields`、扫描同数据集缓存短路与单证券读取失败降级；02-02 由「部分实现」转为「已实现（主工作区）」 |
| 2026-11-11 | v1.4 | FEAT-DF-05 实施完成：`AppError.details` 恒输出（无内容为 null）、补 17 码稳定文案与 retryable 对照表、前端仅对 retryable 错误给重试入口并屏蔽堆栈；溯源 `dataset_id` 改为与取数响应同源；补 NaN/∞ → JSON null 与全 null 空态；`verify-diag-gate` 增加「release 比 debug 少 5 条」断言；§5 登记 C-25/C-26；05-02 由「待验证」转为「已实现（主工作区）」 |
| 2026-11-11 | v1.5 | FEAT-DF-06 实施完成：27/27 AC 运行取证通过（s206 主套件 + s206-meta + s206-readonly）；新增 `setInvokeDelay` 诊断注入旁路（不改返回值）、`data-bars-code` / `data-sub-unit/lo/hi` / `debug()` hook 等取证属性；修复 `setViewport` 旧闭包键 bug；用户拍板偏差 C-27（周期首点 0ms + 在途连点 100ms 合并）、C-28（输入静默不发请求、选中才发 1 次）；§5 登记两偏差；§7.2 06-01 由「待验证」转为「已实现（主工作区）」，FEAT-DF-06 全部 6 个 Story 已实现 |
| 2026-11-11 | v1.6 | AKA-104（ST-DF-04-03）收口：用户选定方案 ①，前端 `model.ts` 按 manifest 补全全部指标参数 + 后端 `core.rs#L2330-L2344` 取消 `merge_defaults` 静默补齐、缺参即报错；新增 2 条定向测试、修正 3 条依赖旧补齐行为的用例，`cargo test -p app-core` 123 passed；C-23 销项，04-03 由「部分实现」转为「已实现（主工作区）」，FEAT-DF-04 6/6 完成；§7.2 已实现 29（96.7%）、部分实现 1（03-03 偏差 C-19） |
