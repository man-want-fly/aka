# B1 趋势与回归底座 · 口径页（v0.1）

> 适用范围：S1 / B1 批次的 10 个指标 + 存量 M06 MACD。
> 所有公式以**收盘价 `C`** 为输入，缺失值统一 `NaN`，不补零、不插值。
> 黄金夹具由 `app/crates/indicator-golden/fixtures/gen_reference.py` 生成，
> **禁止手工修改夹具 JSON**。

## 通用约定

| 项 | 口径 |
| --- | --- |
| 窗口 | `period=N`，前 `N-1` 根输出 `NaN` |
| 预热 | `Meta.warmup` 返回「前置根数」，应用层要求 `bars >= warmup+1` |
| 浮点容差 | 价格/斜率类（元、元/根、元/日）：`relative 1e-6`（分母 `max(\|expected\|,1.0)`）；R²（无量纲）：`absolute 1e-6`；BIAS（%）与 MACD 副图：`absolute 1e-4`。逐 case 容差写在夹具里，默认按指标类别取；手算样例可单 case 收紧（如 `edge_manual_nonlinear` 用 `absolute 1e-9`），`tolerance_rules_are_frozen` 锁定默认映射。 |
| 数据不足 | 全部输出 `NaN`，不报错（错误由 app-core 的 warmup 门禁统一给出） |
| 常数序列 | 均线/回归退化为常数；BIAS 均值为 0 时输出 `NaN` |
| 首根 K 线 | 窗口未满，输出 `NaN` |

## T01 SMA

- 公式：`SMA_t = (1/N) · Σ_{k=0}^{N-1} C_{t-k}`
- 首个有效值：`t=N-1`；`warmup=N-1`（默认 20 → 19）。
- 边界：`N<2`、`bars<N` → 全 `NaN`。

## T02 EMA

- 种子：`EMA_{N-1} = SMA_N(C_0..C_{N-1})`
- 递推：`EMA_t = α·C_t + (1-α)·EMA_{t-1}`，`α = 2/(N+1)`
- 首个有效值：`t=N-1`；应用层按 B1 建议 **3N 根观察期**，`warmup=3N-1`（默认 59）。
- 边界：种子窗口含 `NaN` → 全 `NaN`。

## T03 WMA

- 公式：`WMA_t = Σ_{k=1}^{N} k · C_{t-N+k} / (N(N+1)/2)`
- 权重 1..N，**最新一根权重最大**。
- 首个有效值：`t=N-1`；`warmup=N-1`。
- 状态：B1 标记「完整▲」，边界说明仍待补，manifest 暂标 `beta`。

## T04 DEMA

- `E1 = EMA(N, C)`，`E2 = EMA(N, E1)`
- `DEMA = 2·E1 − E2`
- 首个有效值：`t=2N-2`；应用层按 B1 建议 3N 根，`warmup=3N-1`（默认 59）。
- 边界：`E2` 使用 `E1` 的前 `N` 个有限值做种子，`E1` 的 `NaN` 前缀不参与。

## T05 TEMA

- `E1 = EMA(N, C)`，`E2 = EMA(N, E1)`，`E3 = EMA(N, E2)`
- `TEMA = 3·E1 − 3·E2 + E3`
- 首个有效值：`t=3N-3`；应用层按 B1 建议 4.5N 根，`warmup=4.5N-1`（默认 89）。
- 边界：逐级 EMA 的种子只取前一级连续有限值。

## T19 LinReg Forecast

- 窗口 `y_k = C_{t-N+1+k}`，`x_k = k`（`k=0..N-1`）
- OLS：`slope = Sxy/Sxx`，`intercept = ȳ − slope·x̄`
- `Forecast_t = intercept + slope·(N-1)`，即**当前根**的拟合值。
- **自定口径**：不取下一根 `x=N`；此终点选择暂标 `beta`。
- 首个有效值：`t=N-1`；`warmup=N-1`。

## T20 LinReg Intercept

- 同上 OLS，输出 `intercept`，即窗口首根（`x=0`）的拟合值。
- 首个有效值：`t=N-1`；`warmup=N-1`。

## <a id="t21-r2"></a>T21 LinReg R²

- `Sxx = N(N²-1)/12`，`Sxy = Σ(x−x̄)(y−ȳ)`，`Syy = Σ(y−ȳ)²`
- `R² = Sxy²/(Sxx·Syy)`，裁剪到 `[0,1]`
- **自定口径**：`Syy=0`（常数序列）时 `R²=1.0`，避免 `0/0`；暂标 `beta`。
- 首个有效值：`t=N-1`；`warmup=N-1`。

## T22 LinReg Slope

- 输出 `slope = Sxy/Sxx`
- 单位：**元/根**；首个有效值 `t=N-1`；`warmup=N-1`。

## E13 BIAS

- `BIAS_N = (C_t − SMA_N(C_t)) / SMA_N(C_t) × 100%`
- 默认三周期 `6/12/24`，三列独立输出，各自在自己的窗口满足后出现有限值。
- `SMA=0` 时输出 `NaN`，不产生 `Infinity`。
- `warmup = min(period1, period2, period3) - 1`（默认 5）。

## M06 MACD

- `DIF = EMA(fast, C) − EMA(slow, C)`
- `DEA = EMA(signal, DIF)`
- `HIST = 2 × (DIF − DEA)`（A 股展示惯例）
- 默认 `12/26/9`；`warmup = slow + signal − 2`（默认 33）。
- 参数约束：`fast < slow`，否则返回 `CalcError::InvalidParam`。
- 旧 id `macd` 保留 alias 一版。
