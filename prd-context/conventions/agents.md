# AGENTS.md - app/crates/app-core

## 约定
- `Core::calc_indicators` 是唯一指标计算入口；实例级失败通过 `failed_series(...)` 写入 `SeriesDto.error`，不中断整批。
- 校验顺序固定：lookup → 参数校验 → 计算；非法参数不写 `calc_cache`、不发 `indicator.compute`。
- 参数错误映射集中在 `param_error(indicator_id, err)`，错误码 `E_PARAM_OUT_OF_RANGE`（≡ 需求 `E_PARAM_INVALID`），不得改动。
- 缓存键由 `calc_key` / `canonical_params` 生成，带 `v3|` 前缀；改参数处理时必须保证键不变（否则缓存失效）。
- 单测与被测代码同文件（`#[cfg(test)] mod tests`），命名用行为描述句，如 `invalid_param_is_isolated_and_side_effect_free`。

## 文件说明
- `core.rs`：Core 门面、取数/计算/缓存/参数校验、诊断路径与全部单测。
- `dto.rs`：IPC DTO（`CalcRequest` / `SeriesDto` / `BarDto`）。
- `error.rs`：`AppError` 与错误码映射。
