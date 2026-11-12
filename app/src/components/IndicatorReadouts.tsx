import type { SeriesDto } from "../lib/types";
import { formatFixed, formatIndicator, formatPct } from "../lib/format";
import { MAX_SUBPLOTS } from "../features/workbench/model";

interface Props {
  series: SeriesDto[];
  barCount: number;
  /** B2 主图叠加所选指标 */
  overlayIds: string[];
  /** 副图指标 id（M06 或 V01–V10） */
  subIds: string[];
  /** 副图格总数（含成交量格，S-02.03-01） */
  subCount: number;
  /** manifest 单位表 */
  units: Record<string, string>;
  /** 指标卡深链：跳到目录页同一份口径（S-03.03-02） */
  onOpenDetail?: (indicatorId: string) => void;
}

const E13_LABELS: Record<string, string> = {
  bias6: "BIAS6",
  bias12: "BIAS12",
  bias24: "BIAS24",
};

function Sparkline({
  values,
  color,
}: {
  values: (number | null)[];
  color: string;
}) {
  const points = values.slice(-60);
  const finite = points.filter((value): value is number => value !== null && Number.isFinite(value));
  if (finite.length < 2) return <svg width={160} height={26} aria-hidden />;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min || 1;
  const step = 160 / Math.max(1, points.length - 1);
  let path = "";
  let penDown = false;
  points.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      penDown = false;
      return;
    }
    const x = index * step;
    const y = 24 - ((value - min) / span) * 22;
    path += `${penDown ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)} `;
    penDown = true;
  });
  return (
    <svg width={160} height={26} aria-label="指标走势">
      <path d={path.trim()} fill="none" stroke={color} strokeWidth={1.2} />
    </svg>
  );
}

/** TD-B1-02 渲染层证据：R² 与 BIAS 三线以最新值 + 迷你走势呈现；B2 追加叠加/副图读数同步。 */
export function IndicatorReadouts({
  series,
  barCount,
  overlayIds,
  subIds,
  subCount,
  units,
  onOpenDetail,
}: Props) {
  const r2 = series.find((item) => item.indicatorId === "T21");
  const bias = series.find((item) => item.indicatorId === "E13");
  const b2Overlays = [...new Set(overlayIds)]
    .map((id) => series.find((item) => item.indicatorId === id))
    .filter((item): item is SeriesDto => Boolean(item));
  const b2Subs = subIds
    .map((id) => series.find((item) => item.indicatorId === id))
    .filter((item): item is SeriesDto => Boolean(item));
  if (!r2 && !bias && b2Overlays.length === 0 && b2Subs.length === 0) return null;

  const latest = (values: (number | null)[] | undefined) => {
    if (!values) return null;
    for (let i = values.length - 1; i >= 0; i -= 1) {
      const value = values[i];
      if (value !== null && Number.isFinite(value)) return value;
    }
    return null;
  };
  // B2 读数取「当前根」而不是最近有效值：位移/未激活输出尾部为 NaN，显示 — 才如实
  const current = (values: (number | null)[] | undefined) => {
    if (!values || values.length === 0) return null;
    const value = values[values.length - 1];
    return value !== null && Number.isFinite(value) ? value : null;
  };

  // 带单位读数按四类口径分流：% 走 formatPct、元/价格走 formatPrice、量走手口径、无量纲定点
  const formatReadout = (value: number, unit: string): string => {
    if (unit === "%") return formatIndicator(value, "percent");
    if (unit === "元" || unit === "元/根") return `${formatIndicator(value, "price")} ${unit}`;
    if (unit === "股") return formatIndicator(value, "volume");
    if (unit.endsWith("手")) return `${formatFixed(value, 1)}${unit}`;
    return `${formatFixed(value, 2)}${unit ? ` ${unit}` : ""}`;
  };

  const r2Value = r2 ? latest(r2.outputs[0]?.values) : null;

  return (
    <div
      className="indicator-readouts"
      data-verification="td-b1-02-render-layer"
      style={{ padding: "6px 12px 10px", borderTop: "1px solid var(--line)" }}
    >
      <div className="caption" style={{ marginBottom: 4 }}>
        B1 统计层 · 渲染层证据（T21 / E13）
      </div>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center" }}>
        {r2 && (
          <div data-readout="T21-r2" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              className="mono"
              data-value={latest(r2.outputs[0]?.values) ?? ""}
              data-unit="无量纲"
              style={{ color: r2.outputs[0]?.color }}
            >
              R² {r2Value === null ? "—" : formatFixed(r2Value, 2)}
            </span>
            <span className="caption">无量纲</span>
            <Sparkline
              values={r2.outputs[0]?.values ?? []}
              color={r2.outputs[0]?.color ?? "var(--accent)"}
            />
            {onOpenDetail && (
              <button
                type="button"
                className="fav-chip__detail caption"
                data-readout-spec="T21"
                onClick={() => onOpenDetail("T21")}
              >
                口径
              </button>
            )}
          </div>
        )}
        {bias?.outputs.map((output) => {
          const value = latest(output.values);
          return (
            <div
              key={output.key}
              data-readout={`E13-${output.key}`}
              style={{ display: "flex", alignItems: "center", gap: 8 }}
            >
              <span
                className="mono"
                data-value={value ?? ""}
                data-unit="%"
                style={{ color: output.color }}
              >
                {E13_LABELS[output.key] ?? output.key}{" "}
                {value === null ? "—" : formatPct(value)}
              </span>
              <Sparkline values={output.values} color={output.color} />
            </div>
          );
        })}
        {bias && onOpenDetail && (
          <button
            type="button"
            className="fav-chip__detail caption"
            data-readout-spec="E13"
            onClick={() => onOpenDetail("E13")}
          >
            口径
          </button>
        )}
      </div>
      {barCount < 60 && (
        <div className="caption" data-readout="warmup-hint" style={{ marginTop: 4 }}>
          EMA / DEMA / TEMA 需要至少 59 根有效收盘价（3×N-1），当前 {barCount} 根，灰色段为预热缺失。
        </div>
      )}

      {(b2Overlays.length > 0 || b2Subs.length > 0) && (
        <div
          data-verification="b2-render-layer"
          style={{ marginTop: 8, borderTop: "1px dashed var(--line)", paddingTop: 6 }}
        >
          <div className="caption" style={{ marginBottom: 4 }} data-sub-capacity={subCount}>
            B2 读数同步 · 叠加 {overlayIds.join(" / ") || "无"} · 副图 {subCount}/{MAX_SUBPLOTS}
          </div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
            {b2Overlays.flatMap((item) =>
              item.outputs.map((output) => {
                const value = current(output.values);
                const unit = units[item.indicatorId] ?? "";
                return (
                  <span
                    key={`b2-ov-${item.indicatorId}-${output.key}`}
                    className="mono"
                    data-readout={`b2-overlay-${item.indicatorId}-${output.key}`}
                    data-value={value ?? ""}
                    data-unit={unit}
                    style={{ color: output.color, fontSize: 11 }}
                  >
                    {item.indicatorId}·{output.key} {value === null ? "—" : formatReadout(value, unit)}
                  </span>
                );
              }),
            )}
            {b2Subs.flatMap((sub) =>
              sub.outputs.map((output) => {
                const value = current(output.values);
                const unit = units[sub.indicatorId] ?? "";
                return (
                  <span
                    key={`b2-sub-${sub.indicatorId}-${output.key}`}
                    className="mono"
                    data-readout={`b2-sub-${sub.indicatorId}-${output.key}`}
                    data-value={value ?? ""}
                    data-unit={unit}
                    style={{ color: output.color, fontSize: 11 }}
                  >
                    {sub.indicatorId}·{output.key} {value === null ? "—" : formatReadout(value, unit)}
                  </span>
                );
              }),
            )}
            {onOpenDetail &&
              [...new Set([...b2Overlays, ...b2Subs].map((item) => item.indicatorId))].map((id) => (
                <button
                  key={`b2-spec-${id}`}
                  type="button"
                  className="fav-chip__detail caption"
                  data-readout-spec={id}
                  onClick={() => onOpenDetail(id)}
                >
                  {id} 口径
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
