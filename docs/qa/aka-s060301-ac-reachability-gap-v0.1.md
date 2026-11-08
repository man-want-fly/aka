# S-06.03-01（P04-R3）AC 可达性缺口说明 v0.1

## 事实

- 卡面 AC（补3）：数据目录不可用 → 关于页显示「目录不存在」并提供「重建样本包」入口。
- 实现：`dataDirMissing = datasource !== null && datasource.version === null`（`app/src/pages/settings/SettingsPage.tsx`）。
- 取证夹具：`s060301` 用 `--empty-dataset`，它只让 `list_securities` 返回 0（`app/src-tauri/src/commands.rs`）；`datasource_status().version` 来自 `dataset_manifest()`，mock provider 恒返回 `Some`（`app/crates/data-provider/src/mock.rs:352`）。
- 结论：`state === "missing"` 在常规环境和 `--empty-dataset` 下都不可达；`P04-R3` 从签字起就是死的。

## 三条路（不选，交 TL/产品判断）

### A. 夹具注入「目录缺失」启动参数
- 做法：新增如 `--no-dataset-manifest`，让 provider 在取证模式下返回 `None`。
- 代价：小到中；需要产品侧加一个分支（或测试模式分支），即要另开一张卡。
- 影响面：只动取证路径，正常用户行为不变；但必须证明正常启动路径不受影响。

### B. mock provider 增加「无 manifest」分支
- 做法：沿用已有的 `Option<DatasetManifest>`，mock 按开关返回 `None`。
- 代价：中；改 `data-provider` + `AppState` 传参，`core` 内多处 `dataset_manifest()` 调用要定义 `None` 行为（数据版本、覆盖、workspace 等）。
- 影响面：面大，容易引出新的不可达/panic 路径，需补一组 `None` 分支测试。

### C. 改 AC 口径为「数据集为空 / 未就绪」
- 做法：把现有「空数据集」状态映射到关于页提示，卡面与断言一起改。
- 代价：小（只改卡面文案与断言），但改变产品语义。
- 影响面：只影响一张卡；需产品确认「空数据集」是否等同「目录不存在」。
- 风险：若将来真有目录缺失场景，仍然没有覆盖。

## 给 TL 的规则提案

> AC 状态值可达性：卡面 AC 里出现的每个状态值（如 `missing` / `empty` / `full` / `disabled`），必须在实现里有至少一条可达路径，并在卡面标注路径类型（正常进入 / 夹具注入 / 仅异常环境）。验收时状态值与可达路径一并核对；没有可达路径的状态值视为死 AC，不得签字。

现有反例：`state === "missing"` 写在卡面上，产品里没有任何路能走到它。
