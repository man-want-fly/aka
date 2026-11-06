import type { ParamSpec, RegistryResponse } from "../lib/types";
import type { WorkbenchParams } from "../features/workbench/model";
import { formatComputedMs } from "../lib/format";

interface Props {
  registry: RegistryResponse | null;
  params: WorkbenchParams;
  onChange: (next: WorkbenchParams) => void;
  onApply: () => void;
  busy: boolean;
  error: string | null;
  computedMs: number | null;
  cacheHit: boolean | null;
}

function findSpec(registry: RegistryResponse | null, indicatorId: string, key: string) {
  return registry?.indicators
    .find((item) => item.id === indicatorId)
    ?.params.find((item) => item.key === key);
}

function intBounds(spec: ParamSpec | undefined, fallbackMin: number, fallbackMax: number) {
  if (!spec || spec.kind !== "int") {
    return { min: fallbackMin, max: fallbackMax };
  }
  return { min: spec.min, max: spec.max };
}

export function ParamPanel({
  registry,
  params,
  onChange,
  onApply,
  busy,
  error,
  computedMs,
  cacheHit,
}: Props) {
  const maPeriodSpec = findSpec(registry, "T01", "period");
  const maTypeSpec = findSpec(registry, "T01", "maType");
  const fastSpec = findSpec(registry, "M06", "fast");
  const slowSpec = findSpec(registry, "M06", "slow");
  const signalSpec = findSpec(registry, "M06", "signal");

  const periodBounds = intBounds(maPeriodSpec, 2, 200);
  const fastBounds = intBounds(fastSpec, 2, 200);
  const slowBounds = intBounds(slowSpec, 2, 200);
  const signalBounds = intBounds(signalSpec, 2, 200);

  const variants =
    maTypeSpec && maTypeSpec.kind === "enum"
      ? maTypeSpec.variants
      : ["sma", "ema", "wma"];

  const update = (patch: Partial<WorkbenchParams>) => onChange({ ...params, ...patch });

  return (
    <aside className="side">
      <h2>指标参数</h2>
      <p className="sub">
        默认值与范围来自 Rust 注册表的 ParamSpec；提交后由后端再次校验。
      </p>

      <div className="param-card">
        <div className="param-card-head">
          <b>MA · 均线</b>
          <span>
            warmup{" "}
            {params.maType === "ema"
              ? Math.max(0, params.maPeriod * 3 - 1)
              : Math.max(0, params.maPeriod - 1)}
          </span>
        </div>
        <div className="param-row">
          <label htmlFor="ma-period">周期</label>
          <input
            id="ma-period"
            type="number"
            min={periodBounds.min}
            max={periodBounds.max}
            step={1}
            value={params.maPeriod}
            onChange={(event) => update({ maPeriod: Number(event.target.value) })}
          />
        </div>
        <div className="param-row">
          <label htmlFor="ma-type">均线类型</label>
          <select
            id="ma-type"
            value={params.maType}
            onChange={(event) =>
              update({ maType: event.target.value as WorkbenchParams["maType"] })
            }
          >
            {variants.map((variant) => (
              <option key={variant} value={variant}>
                {variant.toUpperCase()}
              </option>
            ))}
          </select>
        </div>
        <div className="param-hint">
          SMA / EMA / WMA 分别对应 PRD 的 T01 / T02 / T03；输出名与颜色沿用 manifest。
        </div>
      </div>

      <div className="param-card">
        <div className="param-card-head">
          <b>MACD · 指数平滑异同</b>
          <span>warmup {Math.max(0, params.slow + params.signal - 2)}</span>
        </div>
        <div className="param-row">
          <label htmlFor="macd-fast">快线</label>
          <input
            id="macd-fast"
            type="number"
            min={fastBounds.min}
            max={fastBounds.max}
            step={1}
            value={params.fast}
            onChange={(event) => update({ fast: Number(event.target.value) })}
          />
        </div>
        <div className="param-row">
          <label htmlFor="macd-slow">慢线</label>
          <input
            id="macd-slow"
            type="number"
            min={slowBounds.min}
            max={slowBounds.max}
            step={1}
            value={params.slow}
            onChange={(event) => update({ slow: Number(event.target.value) })}
          />
        </div>
        <div className="param-row">
          <label htmlFor="macd-signal">信号</label>
          <input
            id="macd-signal"
            type="number"
            min={signalBounds.min}
            max={signalBounds.max}
            step={1}
            value={params.signal}
            onChange={(event) => update({ signal: Number(event.target.value) })}
          />
        </div>
        <div className="param-hint">输出 DIF / DEA / HIST；HIST = 2 × (DIF − DEA)。</div>
      </div>

      <button type="button" className="btn primary" onClick={onApply} disabled={busy}>
        {busy ? "计算中…" : "应用参数"}
      </button>

      {error && <div className="error-box">{error}</div>}

      <div className="side-note">
        <div className="kv">
          <span>目录指标</span>
          <b>{registry?.catalogTotal ?? "—"}</b>
        </div>
        <div className="kv">
          <span>已实现</span>
          <b>{registry?.implementedCount ?? "—"}</b>
        </div>
        <div className="kv">
          <span>上次计算</span>
          <b>{computedMs === null ? "—" : `${formatComputedMs(computedMs)} ms`}</b>
        </div>
        <div className="kv">
          <span>缓存</span>
          <b>{cacheHit === null ? "—" : cacheHit ? "命中" : "未命中"}</b>
        </div>
        <div style={{ marginTop: 6 }}>
          骨架期仅注册 MA、MACD；其余 103 个 id 在后续 Sprint 按 ParamSpec 逐个补齐。
        </div>
      </div>
    </aside>
  );
}
