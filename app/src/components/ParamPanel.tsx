import { useEffect, useState } from "react";
import type { ParamSpec, RegistryResponse } from "../lib/types";
import type { WorkbenchParams } from "../features/workbench/model";
import { formatComputedMs } from "../lib/format";

interface Props {
  registry: RegistryResponse | null;
  params: WorkbenchParams;
  onChange: (next: WorkbenchParams) => void;
  onApply: () => void;
  onRestore: () => void;
  isDefault: boolean;
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

function floatBounds(spec: ParamSpec | undefined, fallbackMin: number, fallbackMax: number) {
  if (!spec || spec.kind !== "float") {
    return { min: fallbackMin, max: fallbackMax };
  }
  return { min: spec.min, max: spec.max };
}

/**
 * 小数规范化走 half-up（S-02.05-01）：
 * 2.55 → 2.6、2.54 → 2.5、2.56 → 2.6。
 * 不能用 `Math.round(v * 10) / 10`：2.55 * 10 在 IEEE754 里是 25.4999…，会错回 2.5。
 */
export function roundHalfUp1(raw: string): number {
  const text = raw.trim();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match) return Number.NaN;
  const sign = match[1] === "-" ? -1 : 1;
  const intPart = match[2] || "0";
  const frac = match[3] ?? "";
  const truncated = Number(`${intPart}.${frac.slice(0, 1) || "0"}`);
  const nextDigit = frac.slice(1, 2);
  const bump = nextDigit && nextDigit >= "5" ? 0.1 : 0;
  return sign * (truncated + bump);
}

function formatValue(value: number, digits: number) {
  return digits === 0 ? String(value) : value.toFixed(digits);
}

interface NumRowProps {
  id: string;
  inputId: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  digits?: number;
  onCommit: (value: number) => void;
}

function NumRow({ id, inputId, label, value, min, max, step, digits = 0, onCommit }: NumRowProps) {
  const [text, setText] = useState(() => formatValue(value, digits));

  useEffect(() => {
    setText(formatValue(value, digits));
  }, [value, digits]);

  const badText = text.trim() === "" || !Number.isFinite(Number(text));
  const outOfRange = !badText && (Number(text) < min || Number(text) > max);
  const invalid = badText || outOfRange || !Number.isFinite(value);

  const commit = (raw: string, blur: boolean) => {
    if (blur && digits > 0) {
      const normalized = roundHalfUp1(raw);
      if (Number.isFinite(normalized)) {
        onCommit(normalized);
        setText(formatValue(normalized, digits));
      }
      return;
    }
    const parsed = Number(raw);
    if (raw.trim() !== "" && Number.isFinite(parsed)) onCommit(parsed);
    if (blur) {
      if (Number.isFinite(parsed)) setText(formatValue(parsed, digits));
    }
  };

  const bump = (delta: number) => {
    const next = Math.min(max, Math.max(min, value + delta * step));
    onCommit(Number(next.toFixed(digits)));
  };

  return (
    <div className="param-row" data-param-key={id}>
      <label htmlFor={inputId}>{label}</label>
      <button
        type="button"
        className="param-step"
        data-param-minus="1"
        aria-label={`${label}减`}
        disabled={value <= min}
        onClick={() => bump(-1)}
      >
        −
      </button>
      <input
        id={inputId}
        data-param-input={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={text}
        aria-invalid={invalid}
        className={invalid ? "invalid" : undefined}
        onChange={(event) => {
          setText(event.target.value);
          commit(event.target.value, false);
        }}
        onBlur={(event) => commit(event.target.value, true)}
      />
      <button
        type="button"
        className="param-step"
        data-param-plus="1"
        aria-label={`${label}加`}
        disabled={value >= max}
        onClick={() => bump(1)}
      >
        +
      </button>
      {invalid && (
        <div className="param-invalid" data-param-invalid={id}>
          {badText
            ? `请输入数字：${label}`
            : `参数无效：${label}需在 ${min}–${max} 之间`}
        </div>
      )}
    </div>
  );
}

export function ParamPanel({
  registry,
  params,
  onChange,
  onApply,
  onRestore,
  isDefault,
  busy,
  error,
  computedMs,
  cacheHit,
}: Props) {
  const [restoreNotice, setRestoreNotice] = useState(false);
  const maPeriodSpec = findSpec(registry, "T01", "period");
  const maTypeSpec = findSpec(registry, "T01", "maType");
  const fastSpec = findSpec(registry, "M06", "fast");
  const slowSpec = findSpec(registry, "M06", "slow");
  const signalSpec = findSpec(registry, "M06", "signal");
  const bollPeriodSpec = findSpec(registry, "T09", "period");
  const bollMultSpec = findSpec(registry, "T09", "mult");

  const periodBounds = intBounds(maPeriodSpec, 2, 200);
  const fastBounds = intBounds(fastSpec, 2, 200);
  const slowBounds = intBounds(slowSpec, 2, 200);
  const signalBounds = intBounds(signalSpec, 2, 200);
  const bollPeriodBounds = intBounds(bollPeriodSpec, 2, 200);
  const bollMultBounds = floatBounds(bollMultSpec, 0.5, 5.0);

  const variants =
    maTypeSpec && maTypeSpec.kind === "enum"
      ? maTypeSpec.variants
      : ["sma", "ema", "wma"];

  const update = (patch: Partial<WorkbenchParams>) => onChange({ ...params, ...patch });

  return (
    <aside className="side">
      <h2>指标参数</h2>
      <p className="sub">改动即时重算（120ms 防抖）；默认值与范围来自 Rust 注册表的 ParamSpec。</p>

      <div className="param-card" data-param-card="MA">
        <div className="param-card-head">
          <b>MA · 均线</b>
          <span>
            warmup{" "}
            {params.maType === "ema"
              ? Math.max(0, params.maPeriod * 3 - 1)
              : Math.max(0, params.maPeriod - 1)}
          </span>
        </div>
        <NumRow
          id="maPeriod"
          inputId="ma-period"
          label="周期"
          value={params.maPeriod}
          min={periodBounds.min}
          max={periodBounds.max}
          step={1}
          onCommit={(value) => update({ maPeriod: value })}
        />
        <div className="param-row">
          <label htmlFor="ma-type">均线类型</label>
          <select
            id="ma-type"
            className="param-select"
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

      <div className="param-card" data-param-card="MACD">
        <div className="param-card-head">
          <b>MACD · 指数平滑异同</b>
          <span>warmup {Math.max(0, params.slow + params.signal - 2)}</span>
        </div>
        <NumRow
          id="fast"
          inputId="macd-fast"
          label="快线"
          value={params.fast}
          min={fastBounds.min}
          max={fastBounds.max}
          step={1}
          onCommit={(value) => update({ fast: value })}
        />
        <NumRow
          id="slow"
          inputId="macd-slow"
          label="慢线"
          value={params.slow}
          min={slowBounds.min}
          max={slowBounds.max}
          step={1}
          onCommit={(value) => update({ slow: value })}
        />
        <NumRow
          id="signal"
          inputId="macd-signal"
          label="信号"
          value={params.signal}
          min={signalBounds.min}
          max={signalBounds.max}
          step={1}
          onCommit={(value) => update({ signal: value })}
        />
        {params.fast >= params.slow && (
          <div className="param-invalid" data-param-invalid="fastSlow">
            参数无效：快线需小于慢线
          </div>
        )}
        <div className="param-hint">输出 DIF / DEA / HIST；HIST = 2 × (DIF − DEA)。</div>
      </div>

      <div className="param-card" data-param-card="BOLL">
        <div className="param-card-head">
          <b>BOLL · 布林带</b>
          <span>
            warmup {Math.max(0, params.bollPeriod - 1)}
          </span>
        </div>
        <NumRow
          id="bollPeriod"
          inputId="boll-period"
          label="周期"
          value={params.bollPeriod}
          min={bollPeriodBounds.min}
          max={bollPeriodBounds.max}
          step={1}
          onCommit={(value) => update({ bollPeriod: value })}
        />
        <NumRow
          id="bollMult"
          inputId="boll-mult"
          label="标准差倍数"
          value={params.bollMult}
          min={bollMultBounds.min}
          max={bollMultBounds.max}
          step={0.1}
          digits={1}
          onCommit={(value) => update({ bollMult: value })}
        />
        <div className="param-hint">中轨 = SMA(周期)，上下轨 = 中轨 ± 倍数 × 标准差。</div>
      </div>

      <button type="button" className="btn primary" onClick={onApply} disabled={busy}>
        {busy ? "计算中…" : "应用参数"}
      </button>
      <button
        type="button"
        className="btn"
        data-param-restore="1"
        onClick={() => {
          onRestore();
          setRestoreNotice(true);
          window.setTimeout(() => setRestoreNotice(false), 2000);
        }}
        disabled={busy || isDefault}
        title={isDefault ? "当前即为默认参数" : "恢复为 manifest 默认参数"}
        aria-disabled={busy || isDefault}
      >
        恢复默认
      </button>
      {restoreNotice && (
        <div className="caption" data-param-restored="1" role="status">
          ✓ 已恢复默认参数
        </div>
      )}

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
      </div>
    </aside>
  );
}
