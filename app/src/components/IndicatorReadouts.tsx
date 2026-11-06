import type { SeriesDto } from "../lib/types";

interface Props {
  series: SeriesDto[];
  barCount: number;
  /** B2 主图叠加所选指标 */
  overlayIds: string[];
  /** 副图指标 id（M06 或 V01–V10） */
  subId: string;
  /** manifest 单位表 */
  units: Record<string, string>;
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
export function IndicatorReadouts({ series, barCount, overlayIds, subId, units }: Props) {
  const r2 = series.find((item) => item.indicatorId === "T21");
  const bias = series.find((item) => item.indicatorId === "E13");
  const b2Overlays = [...new Set(overlayIds)]
    .map((id) => series.find((item) => item.indicatorId === id))
    .filter((item): item is SeriesDto => Boolean(item));
  const b2Sub = series.find((item) => item.indicatorId === subId);
  if (!r2 && !bias && b2Overlays.length === 0 && !b2Sub) return null;

  const latest = (values: (number | null)[] | undefined) => {
    if (!values) return null;
    for (let i = values.length - 1; i >= 0; i -= 1) {
      const value = values[i];
      if (value !== null && Number.isFinite(value)) return value;
    }
    return null;
  };

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
              R² {latest(r2.outputs[0]?.values)?.toFixed(2) ?? "—"}
            </span>
            <span className="caption">无量纲</span>
            <Sparkline
              values={r2.outputs[0]?.values ?? []}
              color={r2.outputs[0]?.color ?? "var(--accent)"}
            />
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
                {value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`}
              </span>
              <Sparkline values={output.values} color={output.color} />
            </div>
          );
        })}
      </div>
      {barCount < 60 && (
        <div className="caption" data-readout="warmup-hint" style={{ marginTop: 4 }}>
          EMA / DEMA / TEMA 需要至少 59 根有效收盘价（3×N-1），当前 {barCount} 根，灰色段为预热缺失。
        </div>
      )}

      {(b2Overlays.length > 0 || b2Sub) && (
        <div
          data-verification="b2-render-layer"
          style={{ marginTop: 8, borderTop: "1px dashed var(--line)", paddingTop: 6 }}
        >
          <div className="caption" style={{ marginBottom: 4 }}>
            B2 读数同步 · 叠加 {overlayIds.join(" / ") || "无"} · 副图 {subId}
          </div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
            {b2Overlays.flatMap((item) =>
              item.outputs.map((output) => {
                const value = latest(output.values);
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
                    {item.indicatorId}·{output.key} {value === null ? "—" : value.toFixed(2)}
                    {unit ? ` ${unit}` : ""}
                  </span>
                );
              }),
            )}
            {b2Sub?.outputs.map((output) => {
              const value = latest(output.values);
              const unit = units[b2Sub.indicatorId] ?? "";
              return (
                <span
                  key={`b2-sub-${b2Sub.indicatorId}-${output.key}`}
                  className="mono"
                  data-readout={`b2-sub-${b2Sub.indicatorId}-${output.key}`}
                  data-value={value ?? ""}
                  data-unit={unit}
                  style={{ color: output.color, fontSize: 11 }}
                >
                  {b2Sub.indicatorId}·{output.key} {value === null ? "—" : value.toFixed(2)}
                  {unit ? ` ${unit}` : ""}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
