# AKA Story 卡待裁定问题分析（v1.0）

| 项 | 内容 |
|---|---|
| 主对象 | 8 项阻塞：`B-05-01` `B-05-02` `B-05-03` `B-06-01` `B-06-02` `B-06-03` `B-07-01` `B-07-02` |
| 对应卡面 | `aka-story-cards-ep05-v1.0.md`（9 张）/ `ep06`（7 张）/ `ep07`（6 张） |
| 分支 | `ep0507/story-cards`，基线 `main@3192b76` |
| 编号 | `D-R1…D-R8` 为本文件内部裁定项编号，与 `B-xx-yy` 一一对应，末节给对应表 |
| 读法 | 每项固定五段：**事实**（带 `文件:行号`）→ **可选处置**（逐项列代价与影响面）→ **卡的落点** → **建议与理由** → **裁定人** |

**裁定生效前的执行口径**：本文件只提供裁定输入，**不产生临时口径**。8 项中有未裁定项对应的卡一律标 `Blocked` 并从可开工集合移出（见 `aka-story-cards-blocked-v1.0.md`）；裁定落定后改卡、恢复可开工，卡面不保留「暂按」类表述。

**等级说明**：`A` = 选错会造成线上错误或返工；`B` = 只影响体验或维护成本；`C` = 只影响文档一致性。

---

## D-R1 · 数据集重建后，进程内缓存凭什么失效

**对应**：`B-05-01` ｜ 等级 **A** ｜ 阻塞 `S-EP05-05`、`S-EP05-06`

### 事实

1. 进程内有三层缓存，都是裸 `HashMap`，只在构造时初始化为空：
   - `core.rs:314` — `daily_batches: Mutex<HashMap<String, Arc<BarBatch>>>`，注释写明「按『标的|复权』缓存：日/周/月都从同一份日线派生」。
   - `core.rs:317` — `calc_cache: Mutex<HashMap<String, Arc<Vec<Vec<f64>>>>>`，无容量上限、无版本字段。
   - `core.rs:319-320` — `quality_report: Mutex<Option<QualityReportDto>>`，注释已注明「按 `dataset_id` 缓存」。
   - 三者初始化位置：`core.rs:389`、`core.rs:391`、`core.rs:394`。
2. `daily_batches` 的键**不含数据集身份**：`core.rs:1996` 是 `let key = format!("{}|{}", code, adj.as_str());`。同一进程内只要标的名与复权方式不变，键就永远相同。
3. 全文件搜 `.clear()` 在 `app-core/src/core.rs` 命中 **0 次**。也就是说，没有任何代码路径在数据集切换/重建后清空 `daily_batches`。
4. `calc_cache` 的键**含**数据集身份：`core.rs:2273-2292` 的 `calc_key` 第 2 维是 `series.dataset_id`（`core.rs:2283`）。而 `dataset_id` 的生成规则含行数与内容哈希（`dataset_manifest.rs:7` 注释、`dataset_manifest.rs:61` 的 `format!`：`{provider}-{seed}-{coverage_start}_{coverage_end}-{row_count}-{data_version}-{sha256[..8]}`），重建后内容一变，`dataset_id` 必变。
5. 结论性差异：**`calc_cache` 事实上是安全的**（键随 `dataset_id` 自动失效，旧键只会残留占内存）；**`daily_batches` 不安全**——重建后同标的同复权会命中旧批次，K 线、成交量、`provenance: { datasetId, datasetGeneration, batchId }` 全部指向旧数据集，且 `dataset_generation` 不会进位。

### 可选处置

| 选项 | 做法 | 代价 | 影响面 |
|---|---|---|---|
| A | 数据集切换/重建后**整体重建 `AppCore`**（换 provider 时构造新实例），缓存随实例一起丢弃 | 改动集中在装配层；但 `AppState` 需支持替换内部 `AppCore`，所有命令的 `State<'_, AppState>` 取用方式要复查；切库瞬间在途请求会失败 | `lib.rs` 装配、`commands.rs` 全部命令、`S-EP05-05` 容量卡可不动 |
| B | `daily_batches` 的键加数据集身份前缀，改为 `dataset_id|code|adj` | 一处 3 行改动（`core.rs:1996`）；旧键仍残留，必须与 `S-EP05-05` 的容量上限一起做，否则内存只增不减 | 仅 `core.rs`；`calc_cache` 不用改 |
| C | 读取时校验：`cached.dataset_generation` 与当前 provider 的 generation 不一致则丢弃重取 | 语义最精确；但要求 provider 每次都能报出当前 generation，`daily_batch` 里得多打一次轻量调用，等于用一次 IO 换一次内存命中 | `core.rs:1995-2023`、`DataProvider` trait |
| D | 不处理，接受「重建后必须重启应用」 | 零改动；但用户装完新数据集看不到变化时会当成 Bug，且 `provenance` 会给出错误的自证材料 | 全部数据类页面 |

### 卡的落点

- `S-EP05-06`「按标的周期复权缓存 K 线序列并共用日线批次」——本卡的缓存正确性 AC 直接依赖本裁定。
- `S-EP05-05`「计算缓存设置容量上限并淘汰最早键」——若选 A，容量上限的紧迫性下降；若选 B/C，容量上限必须同批做。

### 建议

**选 B**，理由：①错的是键少了维度，不是缓存架构错了，改键是唯一与缺陷等价的修法；②改动面只有一处 `format!`，可被一条 AC 直接断言（切库前后同一标的返回不同 `batchId`）；③A 需要动装配层与在途请求语义，收益不比 B 大；④C 把内存问题换成 IO 问题，与本卡「避免重复取数」的初衷相反。B 的残留内存问题交给 `S-EP05-05` 的容量上限兜住，两张卡同批交付。

补充要求（写进 `S-EP05-06` 的 AC）：断言「切换数据集后再取同一标的，`batchId` 必须变化」，反例是「把键改回 `code|adj` → 该 AC 红」。

### 由谁裁定

**TL（架构 owner）+ 数据源 owner**，需数据源 owner 确认「重建一定会产出新 `dataset_id`」这条前提（依据是 `dataset_manifest.rs:61` 的哈希段，若某次重建允许内容相同但 `dataset_id` 复用，则 B 仍成立但断言要改写）。

---

## D-R2 · `QualityFlag` 线上字符串为什么一半 camelCase 一半大写

**对应**：`B-05-02` ｜ 等级 **A** ｜ 阻塞 `S-EP05-07`、`S-EP06-02`

### 事实

1. 枚举 8 个变体，定义在 `data-provider/src/types.rs:127-140`：`Simulated` / `LimitUp` / `LimitDown` / `SplitDay` / `Suspended` / `ExRights` / `ZeroVolume` / `PriceAnomaly`。
2. `as_str()` 在 `types.rs:143-153`，输出**两套风格混用**：
   - 前 4 个 camelCase：`"simulated"`（145）、`"limitUp"`（146）、`"limitDown"`（147）、`"splitDay"`（148）；
   - 后 4 个全大写：`"SUSPENDED"`（149）、`"EX_RIGHTS"`（150）、`"ZERO_VOLUME"`（151）、`"PRICE_ANOMALY"`（152）。
3. 这套字符串直接上线：`core.rs:1914` 把 `row.quality.iter().map(|q| q.as_str().to_string())` 灌进 `BarDto.quality`，随后又在 `core.rs:1922/1928/1937/1941` 用 `as_str()` 继续追加同类字符串。
4. 后端测试已经把大写字面量固化成断言：`core.rs:3206`（`== "EX_RIGHTS"`）、`core.rs:3210`（`== "PRICE_ANOMALY"`）、`core.rs:3231`（`== "EX_RIGHTS"`）。改字符串会直接打红这三处。
5. 前端没有任何约束：`types.ts:192` 是 `quality: string[]`，不是字面量联合类型。前端拿到 `"EX_RIGHTS"` 与 `"simulated"` 都当字符串处理，拼错也不会报错。
6. 8 变体里前端只展示 `Simulated`（`types.ts` 该字段上方注释与 `types.rs:125` 的注释一致：其余留给质量报告页）。

### 可选处置

| 选项 | 做法 | 代价 | 影响面 |
|---|---|---|---|
| A | 全部统一成 camelCase（`suspended` / `exRights` / `zeroVolume` / `priceAnomaly`），前端改字面量联合类型 | 要改 `types.rs:149-152`、3 处后端测试、前端质量报告页取 `"EX_RIGHTS"` 的判断、以及任何证据 JSON 里的历史取值 | `data-provider`、`app-core`、前端质量报告页、已归档的证据文件 |
| B | 全部统一成 SCREAMING_SNAKE（`SIMULATED` / `LIMIT_UP`…） | 改动面更大：`simulated` 这个值在 `ProvenanceDto`/`MarketSnapshotDto` 侧另有布尔字段承载，字符串侧改大写会与「布尔 `simulated`」形成新的风格冲突 | 同上 + 前端所有展示位 |
| C | 保持现状，只补契约：把 8 个字符串写成常量表 + 前端改字面量联合类型 + 门禁断言字符串集合 | 改动最小；但「一半驼峰一半大写」会被永久固化，后来者照抄 | `types.rs`、`types.ts`、新增一条门禁脚本 |
| D | 后端枚举加 `#[serde(rename_all = "camelCase")]` 让序列化自动统一 | **行不通**：`BarDto.quality` 是 `Vec<String>`，走的是手写 `as_str()`，不经过 serde 的枚举重命名；加了也不生效，属于假修复 | — |

### 卡的落点

- `S-EP05-07`「逐根派生质量标记并冻结线上字符串」——冻结的正是这 8 个字符串。
- `S-EP06-02`「冻结 DTO 线上形状与前端类型零漂移」——`BarDto.quality` 是 39 个 DTO 之一，零漂移检查会把它算进去。

### 建议

**选 C，并把「统一风格」单独立项，不塞进本次重构**。理由：①真正的缺陷是「前端无约束、无门禁」（`types.ts:192` 是 `string[]`），不是风格不一致；②A/B 都要动已归档证据 JSON 里的历史字符串，会让 EP-06 的「零漂移」基线失去可比性；③C 能让「新增第 9 个 flag 时忘记同步前端」立刻变红，这是当下能拿到的全部收益，成本 1 个脚本 + 1 个联合类型。

若产品/前端坚持统一，则**选 A（camelCase）**，并明确「证据文件中的历史值不追溯改写，门禁只校验当前代码产出的集合」。

### 由谁裁定

**TL + 前端 owner**。需前端 owner 确认质量报告页是否直接比较过 `"EX_RIGHTS"` 字面量（若比较过，选 A 时该处必须同批改）。

---

## D-R3 · 门禁体系怎么补：34 个脚本、16 个进 CI、10 个直连，缺统一入口

**对应**：`B-05-03` ｜ 等级 **B**（但覆盖面最大）｜ 原阻塞 `S-EP06-06`，**已按代码事实关闭**（`ci.yml:102` 已有 `cargo test --workspace`、`:105` 已有 `cargo test -p indicator-golden`），不再阻塞任何卡

### 事实

1. `app/package.json` 现有 **34** 个 `verify:*` npm script（`grep -o '"verify:[^"]*"' package.json | wc -l` = 34）。
2. `.github/workflows/ci.yml` 只调起其中 **16** 个（`grep -c 'npm run verify:'` = 16）；另有 **10** 处绕过 npm 直连 `node app/scripts/*.mjs`（ci.yml 第 35-69 行）。
3. `verify:format` 在 `package.json` 里有定义，但 `ci.yml` 里**一次都没调**——这正是 `S-EP07-05` 要修的那条门禁，目前处于「写了但从不运行」状态。
4. 仓库**没有** `test` 脚本、没有 `check:dto`、没有 `audit:ipc`、没有 ESLint 配置。类型检查只有一处：`ci.yml:181-182` 的 `npx tsc --noEmit`（`package.json` 的 `typecheck` 同命令）。
5. 后果：卡面写的「新门禁」若直接写 `npm run check:dto`，在仓库里跑不通；必须写成「新增 `verify:*` script + ci.yml 加一行」，三套卡已按此口径改写。

### 可选处置

| 选项 | 做法 | 代价 | 影响面 |
|---|---|---|---|
| A | 只做接线：`verify:format` 等已存在的脚本补进 CI，新卡新增的 9 个 `verify_*.mjs` 各自登记 script + CI 一行 | 每张卡改 2 个文件（script + yml）；CI 时长线性增加 | `package.json`、`ci.yml`、5 张 EP-07 卡 + 4 张 EP-06 卡 |
| B | 建一个 `verify:all` 聚合脚本，CI 只调它；脚本内并行跑全部 34+ 个 | 一次性改造；但聚合脚本自身出错会让整条 CI 变红且难定位；并行跑会把内存峰值推高 | 全部门禁、CI 配置 |
| C | 引入 ESLint + vitest，用成熟框架替代手写 `verify_*.mjs` | 能拿到规则复用与报告；但仓库现有 34 个脚本全部要移植或共存，且无 `test` 基础设施，属于新工程的量级 | 整个前端 + CI + 团队习惯 |
| D | 维持现状，不接线 | 零成本；但 `S-EP07-05` 的「扩围」等于没落地（脚本存在、CI 不跑，回归随时发生） | 全部格式/主题类卡 |

### 卡的落点

- `S-EP06-06`「收敛前端 IPC 出口到单一模块」——`blocked` 字段直接引用本项（新增 `verify_ipc_surface.mjs` 要落进 CI）。
- `S-EP07-05`「收敛数字格式到单一出口并扩大门禁覆盖」——`verify:format` 从未运行是本卡的核心缺陷之一。
- 其余卡（`S-EP06-01/02/04/05`、`S-EP07-01/03/04`）的 DoD 都写了「新脚本需登记并接入 CI」，口径同源。

### 建议

**选 A**，理由：①本项是「缺接线」而不是「缺工具」，A 与缺陷等价；②B/C 都会把交付周期从「加 2 行」推到「改基础设施」，而 22 张卡正等着开工；③C 值得做，但应作为独立 Epic（比如 EP-09 工程基座），不应阻塞任何一张业务卡。

附带要求：A 执行时把 `ci.yml` 里 10 处直连 `node app/scripts/...` 也一并改成 `npm run verify:*`，让「一个入口」成立，否则下一个人仍然找不到全貌。

### 由谁裁定

**TL + QA owner + CI/DevOps owner**。QA 定「哪些脚本算发布门禁」，DevOps 定「CI 时长上限」。

---

## D-R4 · 大载荷的硬阈值定多少、超限之后怎么办

**对应**：`B-06-01` ｜ 等级 **B** ｜ 阻塞 `S-EP06-05`

### 事实

1. 仓库**没有任何载荷上限口径**：在 `app/` 与 `docs/` 全量搜 `MiB` / `1024 * 1024` / `PAYLOAD`，命中的只有 `diagnostics.rs:46-47`（日志 200 MB、磁盘余量 5 MB）、`diagnostics.rs:304`（单位换算）、`sim_seed.rs:31`（模拟数据 180 MB 估算），与 IPC 载荷无关。
2. 现状是全 JSON 一次返回，无分页、无压缩、无二进制通道。
3. 量级依据（已写进 `S-EP06-05`）：44 个指标实例 × 520 根日线满载时，按 8 token/值估算约 **549 KB**，最坏（17 位有效数字）约 **1.31 MiB**。卡面据此把硬阈值定为 **2 MiB = 2_097_152 B**，`get_bars` 定为 **256 KiB**。
4. `S-EP06-05` 同时写死「超限**不截断、不分页、不报错**，只发 `ipc.payload.large` 遥测」，并明确拒绝 arrow / 分页 / 压缩三条替代路线。

### 可选处置

| 选项 | 做法 | 代价 | 影响面 |
|---|---|---|---|
| A | 采纳卡面：`calc ≤ 2 MiB`、`get_bars ≤ 256 KiB`，超限只埋点 | 阈值来自估算而非实测，首次真实压测可能发现超限频繁；但改阈值只需改一处常量 | `S-EP06-05` 一条 AC、一条遥测 |
| B | 阈值改成「相对基线」：以当前实测 P95 的 1.5 倍为门禁，避免固定数字过期 | 门禁依赖基线文件，基线一变门禁就变，容易出现「把基线改大就通过」 | 需新增基线文件与更新流程 |
| C | 只埋点不设门禁（记录字节数，不判红） | 零误报；但没有门禁就无法阻止载荷悄悄翻倍 | `S-EP06-05` 的 AC 全部退化为观测 |
| D | 超限即回退：分页或截断到 250 根 | 能压住体积；但破坏 `cacheHit` 的单次语义（`S-EP05-03`），且用户看到的是残缺序列，属于产品可见变更 | `S-EP05-01/03`、`S-EP06-05`、图表渲染 |

### 卡的落点

- `S-EP06-05`「锁定全 JSON 载荷预算并禁止二进制旁路」——`blocked` 字段引用本项。阈值与「超限后是否回退」两个问题都在本卡内。

### 建议

**选 A**。理由：①2 MiB 与实测最坏值 1.31 MiB 之间留了 50% 余量，属于合理工程裕度；②A 的失败模式是「门禁偶尔红」，可现场调常量，而 D 的失败模式是「用户拿到残缺数据」，不可逆；③B 的基线漂移问题在只有一条 CI 的仓库里会退化成橡皮图章。

需产品明确的一件事（本项真正的裁定点）：**若真实场景超限，产品接受「界面变慢」还是要求前端拆批？** 卡面按「接受变慢 + 埋点」写死；若产品选拆批，`S-EP06-05` 与 `S-EP05-01` 需同批改。

### 由谁裁定

**TL（阈值）+ 产品（超限后的用户可见行为）**。TL 定数字，产品定「慢」还是「拆」。

---

## D-R5 · 模拟安装的 10 个 `E_` 自由串要不要并进 `ErrorCode`

**对应**：`B-06-02` ｜ 等级 **B** ｜ 阻塞 `S-EP06-04`

### 事实

1. `ErrorCode` 是 13 值的封闭枚举：`app-core/src/error.rs:46-64`，`as_str` 在 `66-85`（`E_INTERNAL` 在 82），值域是 `E_UNKNOWN_SECURITY` / `E_DATASET_MISSING` / `E_UNSUPPORTED` / `E_INVALID_ARGUMENT` / `E_UNKNOWN_INDICATOR` / `E_PARAM_OUT_OF_RANGE` / `E_PARAM_ORDER` / `E_INSUFFICIENT_DATA` / `E_TIMEOUT` / `E_ENGINE_PANIC` / `E_DATA_UNAVAILABLE` / `E_DATASET_READONLY` / `E_INTERNAL`。
2. 模拟安装走的是另一条通道：`sim_install.rs:46-51` 定义 `SimErrorInfo { code: String, message: String }`，`code` 是**自由字符串**，不是枚举。
3. 该通道实际产出 **10 个错误码**（去重后）：`E_SENTINEL_WRITE`（182/186）、`E_DIR_NOT_WRITABLE`（184/252/274）、`E_DISK_INSUFFICIENT`（262）、`E_DB_OPEN`（291/293）、`E_DB_WRITE`（431/434/446/449/451/470/474/476/496/498）、`E_DB_VERIFY`（511/648/653/672）、`E_GATE_C_FAILED`（532）、`E_MANIFEST_WRITE`（549/554）、`E_REPORT_WRITE`（585/590）、`E_REBUILD_DELETE`（706）。
4. 另有第 11 个**不是错误码**的字符串：`E_SLOW_INSTALL`（`sim_install.rs:88`），注释明确「超过 60s 时置 true 并记 `E_SLOW_INSTALL`，但不判失败」——它只进遥测，不进错误面。
5. 两套码风格一致（都 `E_` 前缀 + SCREAMING_SNAKE），但**归属不同**：`ErrorCode` 描述「命令执行失败」，模拟安装码描述「装库过程失败」，且后者带 `message`（面向用户可读文案），前者带结构化 `details`（`error.rs:100`）。

### 可选处置

| 选项 | 做法 | 代价 | 影响面 |
|---|---|---|---|
| A | 10 个全并进 `ErrorCode`（枚举 13 → 23），`SimErrorInfo` 只留 message | `ErrorCode` 是封闭枚举，23 值会让所有 `match` 变长；且安装期错误与运行期错误混在一个值域，前端无法按域分流 | `error.rs`、`as_str`、所有 `match ErrorCode` 处、前端错误映射 |
| B | 保留自由串，但抽成 `sim_install` 内的 `const` 表 + 门禁断言「只许出现表内的值」 | 改动小；错误码仍是字符串，前端拿不到编译期约束 | `sim_install.rs`、新增一条门禁 |
| C | 新建独立枚举 `SimErrorCode`（10 值）+ `as_str`，`SimErrorInfo.code` 改成该枚举 | 与 `ErrorCode` 平级，职责清晰；需改 31 处调用点的字面量（见事实 3 的行号） | `sim_install.rs`、`types.ts` 的 `errorCode: string | null`、`S-EP06-04` 的边界定义 |
| D | 不动 | 零成本；但 `sim_install.rs` 里 31 处硬编码字符串，拼错一个就产生前端不认识的新码 | 仅模拟安装链路 |

### 卡的落点

- `S-EP06-04`「划清四类错误形状的边界与出口」——本卡已把错误面写成「`ErrorCode` 13 值 / `DatasetErrorCode` 5 值 / `SimErrorInfo` 10 自由串 / 2 条 `Result<String, String>`」，第 3 类就是这 10 个码。

### 建议

**选 C**。理由：①A 把「安装期失败」塞进「命令执行失败」的值域，前端要区分「装库失败」和「取数失败」只能靠码名前缀，等于没解决；②B 只是把字符串换了个存放位置，没有拿到类型约束，收益低于成本；③C 的成本集中在一次性替换 31 处字面量，之后每加一个安装错误都由编译器兜住，且前端可拿到 `SimErrorCode` 的联合类型（顺带修掉 `types.ts` 里 `errorCode: string | null` 的松散）。

若决定不做（只求稳），退到 **B**，但必须同时把 `E_SLOW_INSTALL` 与 10 个错误码在文档里分开列，避免后来者把它当错误码并入。

### 由谁裁定

**数据源 owner（安装链路的负责人）+ TL**。数据源 owner 定「安装错误是否需要独立值域」，TL 定「是否改动 `ErrorCode` 的封闭性」。

---

## D-R6 · `diag_write` / `diag_write_named` 的裸字符串要不要收口

**对应**：`B-06-03` ｜ 等级 **C** ｜ 阻塞 `S-EP06-04`、`S-EP06-01`

### 事实

1. 两条诊断写盘命令的签名是 `Result<String, String>`，不是 `Result<_, AppError>`：
   - `diag_write`：`commands.rs:567-574`，`#[cfg(debug_assertions)]` + `#[tauri::command]`，返回 `write_diag(&app, "s2-evidence.json", &payload)`。
   - `diag_write_named`：`commands.rs:591-606`，同样的条件编译；`603` 行直接 `return Err("非法诊断文件名".to_string())`，是中文自由文案，没有码。
   - 底层 `write_diag`：`commands.rs:609`，签名同为 `Result<String, String>`。
2. 这两条不走 `tracked!`（该宏内部写死 `Result<_, AppError>`），所以也不进遥测、不产生 `traceId`。全仓 46 条命令里共 7 条不入 `tracked!`，它们是：`diag_enabled`、`diag_target`、`diag_build_info`、`diag_env`、`diag_write`、`diag_write_named`、`reveal_diagnostics`——全部是诊断/自检类。
3. 两条命令都只在 debug 构建注册与编译（`commands.rs:566`、`590` 的注释；注册表见 `lib.rs:200-247` 与 `:249-291` 的 5 条差集）。

### 可选处置

| 选项 | 做法 | 代价 | 影响面 |
|---|---|---|---|
| A | 改成 `Result<String, AppError>`，错误码复用 `E_INTERNAL` | 会把这 2 条拉进 `tracked!` 体系，产生 `traceId`；但诊断命令是「证据采集工具」，失败原因通常是路径/权限，套 `E_INTERNAL` 反而丢信息（原始 io 错误文案被吞进 `details`） | `commands.rs` 2 处、`ipc.ts` 2 个 wrapper 的返回类型、前端调用点 |
| B | 保持裸串，但在 `S-EP06-04` 里显式登记为「豁免：诊断命令不参与错误面」，并在前端 `describeError`（`ipc.ts:37-58`）确认能兜住裸串 | 零代码改动，只补一条文档豁免；风险是后来者照抄 | 仅文档与 `S-EP06-04` 的边界表 |
| C | 统一成 `{ code, message }` 结构体，由前端映射 | 要新增一个 debug-only DTO；收益是错误结构一致 | `commands.rs`、`dto.rs`、`ipc.ts` |

### 卡的落点

- `S-EP06-04`（四类错误形状的边界）——第 4 类「2 条 `Result<String, String>`」就是它。
- `S-EP06-01`（冻结 46/41 命令面）——差集 5 条里有这 2 条，改签名会改动命令面的回合。

### 建议

**选 B**。理由：①这两条只在 debug 存在，release 里连符号都没有（`#[cfg(debug_assertions)]` 包住整条命令），不构成线上错误面；②它们的 payload 是前端采样结果，失败时要保留**原始 io 文案**给开发者看，`AppError` 的结构化包装反而降低可读性；③B 的成本是「写一段豁免理由」，A/C 的成本是改签名 + 改前端 + 改 command 面冻结断言，收益只是形式统一。

执行要求：B 必须写进 `S-EP06-04`，且 `describeError`（`ipc.ts:37-58`）要有一条断言覆盖「后端返回裸字符串时前端不崩、能显示原文」。

### 由谁裁定

**TL**（单人可定，不需要产品参与）。若 TL 倾向统一错误面，改选 A，并接受诊断证据里丢失原始 io 文案。

---

## D-R7 · 首屏内联脚本与将来的 CSP 收紧是否冲突

**对应**：`B-07-01` ｜ 等级 **B** ｜ 阻塞 `S-EP07-01`

### 事实

1. 缺陷是真实的：`app/index.html:2` 把主题写死为 `<html lang="zh-CN" data-theme="dark" data-colormode="redUp">`。而主题的真正应用发生在 `App.tsx:60` 的 `applyTheme(...)`，即 React 挂载后的 effect 里——晚于首帧。
2. 结果：浅色用户（`aka.theme = "light"`）首帧看到深色底；绿涨用户（`aka.colorMode = "greenUp"`）首帧看到红涨色。两处都是用户可配置项，必然复现。
3. 当前**没有任何 CSP**：`app/src-tauri/tauri.conf.json` 的 `app.security.csp` 为 `null`；`index.html` 全文 12 行，没有 `Content-Security-Policy` meta。
4. 卡面已写死修法：在 `<head>` 里放同步内联脚本，读 `localStorage` 的 `aka.theme` / `aka.colorMode`，在 CSS 与 `#root` 之前写 `data-theme` / `data-colormode`。脚本全文在 `S-EP07-01` 技术决定段落。
5. 风险点：一旦引入 `script-src 'self'`，该内联段会被浏览器拦截，失效方式是「看起来正常、只是闪一下」，不会报错到用户面前。

### 可选处置

| 选项 | 做法 | 代价 | 影响面 |
|---|---|---|---|
| A | 内联同步脚本（卡面现状），不加 `nonce`，不引外部库 | 0 依赖；CSP 收紧时需迁移 | `index.html` 1 处、`verify_boot_theme.mjs` |
| B | 外部同步脚本 `<script src="/boot-theme.js">`（非 module） | 不受 `script-src 'self'` 限制；但多一次网络/磁盘请求，首帧前多一次阻塞加载，Tauri 下收益不确定，且 Vite 需配置把它原样拷进产物 | `index.html`、`vite.config.ts`、构建产物 |
| C | 不做首帧预置，接受闪烁（把 `index.html:2` 的硬编码值改成「跟随系统」的近似值） | 只改一个属性值；但 light 用户仍会看到一次系统色到用户色的跳变，绿涨用户问题不变 | `index.html` 1 处 |
| D | 引入 CSP 并给内联段配 `sha256`/`nonce` 白名单 | 最安全；需要确定 CSP 全量策略（img/font/connect），属于安全工程，不是本卡范围 | `tauri.conf.json`、构建流程、全部内联资源 |

### 卡的落点

- `S-EP07-01`「首帧前预置主题与涨跌色，消除错色闪烁」——本卡的技术决定就是 A 形态，`blocked` 字段引用本项。

### 建议

**选 A，并接受它是过渡方案**。理由：①首帧闪烁是用户每天都会看到的缺陷，CSP 是「将来可能引入」的风险，用确定性缺陷换不确定性风险不划算；②A 与 B 的差异只在加载时序，A 更早、更确定；③D 需要安全 owner 先出 CSP 全量策略，不应被本卡绑架。

配套要求（已写进卡）：`verify_boot_theme.mjs` 同时断言「内联脚本存在」与「脚本出现在 `#root` 之前」，这样将来有人为过 CSP 删掉脚本，门禁先红。CSP 收紧时按 D 的 `nonce`/`sha256` 方案迁移，迁移点已在卡面注明。

### 由谁裁定

**安全 owner + TL**。安全 owner 只需回答一句「近期是否计划上 CSP」；答「否」则 A 立即生效，答「是」则按 D 的迁移路径排期。

---

## D-R8 · 字节与时长的显示口径无产品签字

**对应**：`B-07-02` ｜ 等级 **B** ｜ 阻塞 `S-EP07-05`

### 事实

1. 仓库里有两份互不相同的 `formatBytes`：
   - `InstallPage.tsx:32-36`：`< 1 MiB` 时 `(bytes / 1024).toFixed(0)` 拼 `KB`；否则 `(bytes / 1024 / 1024).toFixed(1)` 拼 `MB`；`<= 0` 或非有限值返回 `"—"`。
   - `SettingsPage.tsx:30-33`：`>= 1 MiB` 时同上；否则 `Math.max(0, Math.round(bytes / 1024))` 拼 `KB`；0 值显示 `"0 KB"` 而不是 `"—"`。
   - 差异有两处真实可见：**0 值文案不同**（`—` vs `0 KB`）；**取整方式不同**（`toFixed(0)` 与 `Math.round` 在 .5 边界可能差 1）。
2. `InstallPage.tsx:26-30` 的 `formatDuration` 是全仓唯一实现：`< 1000ms` 显示 `N ms`，否则 `(ms/1000).toFixed(1) s`。**没有「分秒」分支**——安装耗时超过 60s 会显示成 `73.4 s` 而不是 `1分13秒`。
3. `formatPct` 的入参语义是**百分数不是比率**：`format.ts:40-44`，`formatPct(0.0123)` 输出 `+0.01%`（即把入参当 0.0123%，不是 1.23%）。同一算法在 `changePct.ts:11-15` 的 `expectedChangePctText` 里**字面重复实现了一遍**。
4. 全仓 `toFixed` 共 **54 行 / 76 次**（54 是行数，76 是出现次数）。其中 `lib/` 7 行（`format.ts` 5 + `changePct.ts` 2）、`pages/` 4 行（`InstallPage` 3 + `SettingsPage` 1）。
5. 现有门禁 `verify-number-format.mjs` **只扫 `src/components`**，54 行里只覆盖 4 行；且 `verify:format` 从未在 CI 运行（见 D-R3）。

### 可选处置

| 选项 | 做法 | 代价 | 影响面 |
|---|---|---|---|
| A | `format.ts` 增 `formatBytes(bytes)` / `formatDuration(ms)`，按 **1024 进制、1 位小数**、0 值统一 `"—"`；两处调用改 import | 改 2 个页面 + 1 个 lib；输出字面与现值有 2 处变化（0 值、.5 边界） | `format.ts`、`InstallPage`、`SettingsPage`、`verify-number-format.mjs` |
| B | 按 **1000 进制**并把单位改成 `kB`/`MB`（十进制语义） | 需同时改文案与可能存在的 DOM 证据；与「文件大小」习惯（Windows 1024 / macOS 1000）存在平台争议 | 同上 + 任何截图证据 |
| C | 两份实现都不动，只加门禁断言「两处输出一致」 | 零行为变更；但两处不一致的现状会被固化成「必须不一致」 | 仅门禁 |
| D | A + 把 `changePct.ts` 删掉，统一走 `formatPct` | 少一份重复实现；但 `verify-r03-three-state.mjs` 直接 import 了 `changePct.ts`（该脚本自述「判据与页面共用」），删除会连带打断 EP-08 的三态证据 | `changePct.ts`、`verify-r03-three-state.mjs`、EP-08 卡 |

### 卡的落点

- `S-EP07-05`「收敛数字格式到单一出口并扩大门禁覆盖」——本卡写死了 `formatBytes` / `formatDuration` 的签名与样例值，`blocked` 字段引用本项。

### 建议

**选 A，`changePct.ts` 不删、改为委托**。理由：①两份 `formatBytes` 的差异是「0 值文案」和「.5 取整」，A 用一次统一消除，且不动单位字面（避免碰任何 DOM 证据）；②B 的进制之争没有产品结论前不应落地，`KB` 保持现状最安全；③D 里的删除动作会打断 `verify-r03-three-state.mjs` 与 EP-08，改成「`changePct.ts` 内部调用 `formatPct`、输出逐字不变」即可拿到「单一出口」的收益而不动证据链。

需产品确认的三点（本项真正的裁定点）：**①字节用 1024 还是 1000；②安装耗时是否需要「分秒」粒度（当前 >60s 显示 `73.4 s`）；③`formatPct` 的「入参是百分数」是否借机改名为 `formatPctValue`**（改名会牵动 EP-08 三态卡的 `expectedChangePctText`）。

### 由谁裁定

**产品（进制、粒度、文案）+ TL（是否改名）**。裁定未落定前 `S-EP07-05` 标 `Blocked`，卡面不写临时口径、不先行实现。

---

## 对应表

`D-R*` 为本文件编号；`B-*` 为阻塞清单编号；「同类」指是否与另一项属于同一个根问题。

| 裁定项 | 阻塞编号 | 卡面 `blocked` 字段落在 | 主题 | 同类判定 |
|---|---|---|---|---|
| D-R1 | `B-05-01` | `S-EP05-05`、`S-EP05-06` | 缓存生命周期 / 失效维度 | **独立**。`calc_cache` 键已含 `dataset_id`（`core.rs:2283`），只是 `daily_batches` 键缺（`core.rs:1996`），与其余 7 项无关 |
| D-R2 | `B-05-02` | `S-EP05-07`、`S-EP06-02` | 线上字符串契约（质量标记） | **同族**，见下 |
| D-R3 | `B-05-03` | `S-EP06-06`（并被 22 张卡 DoD 引用） | 工程门禁接线 | **独立**，但与 D-R8 有交叉：D-R3 决定「门禁怎么进 CI」，D-R8 决定「格式规则的内容」 |
| D-R4 | `B-06-01` | `S-EP06-05` | 性能预算 / 超限处置 | **独立** |
| D-R5 | `B-06-02` | `S-EP06-04` | 错误码值域（安装链路） | **同族**，见下 |
| D-R6 | `B-06-03` | `S-EP06-04`、`S-EP06-01` | 错误载体（诊断链路） | **同族**，见下 |
| D-R7 | `B-07-01` | `S-EP07-01` | 安全策略 / 首帧渲染 | **独立** |
| D-R8 | `B-07-02` | `S-EP07-05` | 显示口径（字节/时长/百分比） | **独立**（与 D-R3 交叉，见上） |

### 同族说明

- **线上字符串契约族 = D-R2 + D-R5 + D-R6**。三者都是「后端产出的字符串被前端当契约用，但既无类型约束也无门禁」：
  - D-R2 是**枚举值风格分裂**（camelCase 与大写混用，`types.rs:143-153`）；
  - D-R5 是**自由字符串承载错误码**（10 个 `E_` 串硬编码在 `sim_install.rs` 31 处）；
  - D-R6 是**裸字符串承载错误**（`Result<String, String>` 两条 debug 命令）。
  - 三者可以由**同一次会议、同一个 owner（TL）**裁定，机制也同源（要么加枚举，要么加门禁）。但**影响面各不相同**（D-R2 触及已归档证据，D-R5 触及 31 处调用点，D-R6 只触及 debug 路径），因此仍各自跟踪、各自验收，不合并成一张卡。
- **交叉但不合并**：D-R3 × D-R8。D-R3 是「脚本有没有被 CI 跑」，D-R8 是「脚本里写的规则对不对」。`verify:format` 恰好同时踩两者：它存在（D-R3 的接线问题），且只扫 `components`（D-R8 的覆盖问题）。

### 建议裁定顺序

1. **先 D-R1、D-R2**（EP-05 当前在开发，两张卡的缓存与质量标记 AC 依赖它们）。
2. **再 D-R4、D-R5、D-R6**（EP-06 错误面与载荷预算，可一次会议合并 D-R5/D-R6）。
3. **D-R3 已关闭**（`B-05-03` 按 `ci.yml` 既有 `cargo test` 关闭），不再占用裁定会；新增门禁只按「登记 `verify:*` + CI 一行」执行。
4. **最后 D-R7、D-R8**（`B-07-01` 已按「无 CSP」关闭，`S-EP07-01` 可直接开工；`B-07-02` 未定，`S-EP07-05` 保持 `Blocked`）。

---

## 附：本次核验修正的卡面偏差（已同步改卡）

| 位置 | 原写 | 改为 | 判据 |
|---|---|---|---|
| `aka-story-cards-blocked-v1.0.md` `B-05-03` 事实段 | 「40 个 `verify:*` npm script」 | **34 个** | `grep -o '"verify:[^"]*"' app/package.json \| wc -l` = 34 |
| 同上，CI 调用数 | 「另 2 处直接 `node app/scripts/...`（`ci.yml:35-53`）」 | 「另 **10 处**直接 `node app/scripts/...`（`ci.yml:35-69`）」 | `grep -c 'npm run verify:' ci.yml` = 16；`grep -c 'node app/scripts' ci.yml` = 10 |
| `aka-story-cards-ep06-v1.0.md` §0 口径表「工程门禁现状」 | 「40 个 / 另 2 处」 | 「34 个 / 另 10 处」 | 同上 |
| `aka-story-cards-ep06-v1.0.md` `S-EP06-01` Task 登记方式 | 「与既有 40 个 `verify:*` 同构」 | 「与既有 **34 个** `verify:*` 同构」 | 同上 |

`verify:format` 已定义但 CI 未调用这一条，经复核**成立**，无需修正。
