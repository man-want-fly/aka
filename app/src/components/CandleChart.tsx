import { useMemo, useState, type MouseEvent } from "react";
import type { BarDto, SeriesDto } from "../lib/types";
import { formatAmount, formatDate, formatPct, formatPrice, formatVolume } from "../lib/format";

interface Props {
  bars: BarDto[];
  series: SeriesDto[];
  windowSize: number;
  /** B2 主图叠加所选指标（B1 的 8 条图线始终保留） */
  overlayIds: string[];
  /** 副图指标 id：M06 或 V01–V10 */
  subId: string;
  /** 指标单位（来自 manifest，避免前端二次维护） */
  units: Record<string, string>;
}

const W = 1000;
const H = 560;
const LEFT = 6;
const RIGHT = 938;
const PRICE_TOP = 12;
const PRICE_BOTTOM = 300;
const VOL_TOP = 316;
const VOL_BOTTOM = 376;
/** 副图区（原 MACD 区，现按所选副图指标复用） */
const MACD_TOP = 394;
const MACD_BOTTOM = 522;
const DATE_Y = 546;

const B1_OVERLAY_IDS = ["T01", "T02", "T03", "T04", "T05", "T19", "T20", "T22"];

function digitsForUnit(unit: string): number {
  if (unit === "无量纲") return 4;
  if (unit === "%") return 2;
  return 2;
}

function pathFor(
  values: (number | null)[],
  xOf: (index: number) => number,
  yOf: (value: number) => number,
): string {
  let path = "";
  let penDown = false;
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      penDown = false;
      return;
    }
    path += `${penDown ? "L" : "M"}${xOf(index).toFixed(2)} ${yOf(value).toFixed(2)} `;
    penDown = true;
  });
  return path.trim();
}

export function CandleChart({ bars, series, windowSize, overlayIds, subId, units }: Props) {
  const [hover, setHover] = useState<number | null>(null);

  const view = useMemo(() => {
    if (bars.length === 0) return null;
    const count = Math.min(windowSize, bars.length);
    const start = bars.length - count;
    const visible = bars.slice(start);

    // 主图叠加：B1 的 8 条固定 + B2 所选（多输出指标逐条展开）
    const seen = new Set<string>();
    const overlayLines: Array<{
      id: string;
      indicatorId: string;
      key: string;
      label: string;
      unit: string;
      color: string;
      kind: string;
      values: (number | null)[];
    }> = [];
    [...B1_OVERLAY_IDS, ...overlayIds].forEach((indicatorId) => {
      if (seen.has(indicatorId)) return;
      const item = series.find((entry) => entry.indicatorId === indicatorId);
      if (!item) return;
      seen.add(indicatorId);
      item.outputs.forEach((output) => {
        overlayLines.push({
          id: `${indicatorId}-${output.key}`,
          indicatorId,
          key: output.key,
          label: output.labelZh,
          unit: units[indicatorId] ?? "",
          color: output.color,
          kind: output.kind,
          values: output.values.slice(start),
        });
      });
    });

    // 副图：M06 或任一 B2 波动指标
    const sub = series.find((item) => item.indicatorId === subId);
    const subLines = (sub?.outputs ?? []).map((output) => ({
      key: output.key,
      label: output.labelZh,
      kind: output.kind,
      color: output.color,
      values: output.values.slice(start),
    }));
    const subUnit = units[subId] ?? "";

    let priceMin = Infinity;
    let priceMax = -Infinity;
    let volMax = 0;
    let subMin = Infinity;
    let subMax = -Infinity;

    visible.forEach((bar, index) => {
      priceMin = Math.min(priceMin, bar.low);
      priceMax = Math.max(priceMax, bar.high);
      volMax = Math.max(volMax, bar.volume);
      overlayLines.forEach((line) => {
        const value = line.values[index];
        if (value !== null && value !== undefined && Number.isFinite(value)) {
          priceMin = Math.min(priceMin, value);
          priceMax = Math.max(priceMax, value);
        }
      });
    });
    subLines.forEach((line) => {
      line.values.forEach((value) => {
        if (value !== null && value !== undefined && Number.isFinite(value)) {
          subMin = Math.min(subMin, value);
          subMax = Math.max(subMax, value);
        }
      });
    });

    if (!Number.isFinite(priceMin) || !Number.isFinite(priceMax)) return null;
    const pad = Math.max((priceMax - priceMin) * 0.06, 0.02);
    priceMin -= pad;
    priceMax += pad;

    // 副图量程：跨零时对称（MACD 口径），否则按 min~max 留白
    const subSpansZero = Number.isFinite(subMin) && Number.isFinite(subMax) && subMin <= 0 && subMax >= 0;
    let subLo: number;
    let subHi: number;
    if (!Number.isFinite(subMin) || !Number.isFinite(subMax)) {
      subLo = -1;
      subHi = 1;
    } else if (subSpansZero) {
      const extent = Math.max(Math.abs(subMin), Math.abs(subMax), 1e-9);
      subLo = -extent;
      subHi = extent;
    } else {
      const subPad = Math.max((subMax - subMin) * 0.08, Math.abs(subMax) * 0.04, 1e-6);
      subLo = subMin - subPad;
      subHi = subMax + subPad;
    }

    const step = (RIGHT - LEFT) / count;
    const xOf = (index: number) => LEFT + index * step + step / 2;
    const yOfPrice = (value: number) =>
      PRICE_BOTTOM - ((value - priceMin) / (priceMax - priceMin)) * (PRICE_BOTTOM - PRICE_TOP);
    const yOfSub = (value: number) =>
      MACD_BOTTOM - ((value - subLo) / (subHi - subLo)) * (MACD_BOTTOM - MACD_TOP);

    const priceTicks = Array.from({ length: 5 }, (_, i) => {
      const value = priceMin + ((priceMax - priceMin) * i) / 4;
      return { value, y: yOfPrice(value) };
    });

    const dateTicks = [0.1, 0.35, 0.6, 0.85].map((ratio) => {
      const index = Math.min(count - 1, Math.round((count - 1) * ratio));
      return { index, x: xOf(index) };
    });

    return {
      count,
      visible,
      step,
      xOf,
      yOfPrice,
      yOfSub,
      priceTicks,
      dateTicks,
      overlayLines,
      subLines,
      subId,
      subUnit,
      subSpansZero,
      volMax,
    };
  }, [bars, series, windowSize, overlayIds, subId, units]);

  if (!view) {
    return (
      <div className="empty">
        <div>
          暂无 K 线数据
          <br />
          请确认 Tauri 后端已启动并选择标的
        </div>
      </div>
    );
  }

  const bodyWidth = Math.min(7, Math.max(1, view.step * 0.62));
  const zeroY = (MACD_TOP + MACD_BOTTOM) / 2;
  const hovered = hover !== null ? view.visible[hover] : null;
  const hoveredPrev = hover !== null && hover > 0 ? view.visible[hover - 1] : null;
  const hoveredChg =
    hovered && hoveredPrev ? (hovered.close / hoveredPrev.close - 1) * 100 : Number.NaN;

  const handleMove = (event: MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = Math.min(rect.width / W, rect.height / H);
    const offsetX = (rect.width - W * scale) / 2;
    const offsetY = (rect.height - H * scale) / 2;
    const x = (event.clientX - rect.left - offsetX) / scale;
    const y = (event.clientY - rect.top - offsetY) / scale;
    if (x < LEFT || x > RIGHT || y < PRICE_TOP || y > MACD_BOTTOM) {
      setHover(null);
      return;
    }
    const index = Math.floor((x - LEFT) / view.step);
    setHover(Math.max(0, Math.min(view.count - 1, index)));
  };

  return (
    <div className="chart-host">
      <svg
        className="chart-svg"
        data-chart="candle"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* 价格网格 */}
        {view.priceTicks.map((tick, index) => (
          <g key={`grid-${index}`}>
            <line
              x1={LEFT}
              x2={RIGHT}
              y1={tick.y}
              y2={tick.y}
              stroke="var(--line)"
              strokeWidth={0.7}
            />
            <text
              x={RIGHT + 8}
              y={tick.y + 3}
              fontSize={10}
              fill="var(--muted)"
              className="mono"
            >
              {formatPrice(tick.value)}
            </text>
          </g>
        ))}

        {/* K 线 */}
        {view.visible.map((bar, index) => {
          const x = view.xOf(index);
          const rising = bar.close >= bar.open;
          const color = rising ? "var(--pos)" : "var(--neg)";
          const bodyTop = view.yOfPrice(Math.max(bar.open, bar.close));
          const bodyBottom = view.yOfPrice(Math.min(bar.open, bar.close));
          const bodyHeight = Math.max(1, bodyBottom - bodyTop);
          return (
            <g key={bar.date}>
              <line
                x1={x}
                x2={x}
                y1={view.yOfPrice(bar.high)}
                y2={view.yOfPrice(bar.low)}
                stroke={color}
                strokeWidth={0.9}
              />
              <rect
                data-candle={rising ? "up" : "down"}
                data-index={index}
                x={x - bodyWidth / 2}
                y={bodyTop}
                width={bodyWidth}
                height={bodyHeight}
                fill={rising ? color : "transparent"}
                stroke={color}
                strokeWidth={0.9}
              />
            </g>
          );
        })}

        {/* 指标叠加层：B1 的 8 条 + B2 所选 */}
        {view.overlayLines.map((line) =>
          line.kind === "dot" ? (
            <g
              key={`overlay-${line.id}`}
              data-overlay={line.indicatorId}
              data-overlay-key={line.key}
            >
              {line.values.map((value, index) =>
                value !== null && Number.isFinite(value) ? (
                  <circle
                    key={`dot-${index}`}
                    cx={view.xOf(index)}
                    cy={view.yOfPrice(value)}
                    r={2.2}
                    fill={line.color}
                  />
                ) : null,
              )}
            </g>
          ) : (
            <path
              key={`overlay-${line.id}`}
              data-overlay={line.indicatorId}
              data-overlay-key={line.key}
              d={pathFor(line.values, view.xOf, view.yOfPrice)}
              fill="none"
              stroke={line.color}
              strokeWidth={1.3}
              opacity={0.92}
            />
          ),
        )}

        {/* 成交量 */}
        <line
          x1={LEFT}
          x2={RIGHT}
          y1={VOL_BOTTOM}
          y2={VOL_BOTTOM}
          stroke="var(--line)"
          strokeWidth={0.7}
        />
        <text x={RIGHT + 8} y={VOL_TOP + 10} fontSize={9.5} fill="var(--faint)" className="mono">
          VOL
        </text>
        {view.visible.map((bar, index) => {
          const rising = bar.close >= bar.open;
          const height = view.volMax > 0 ? (bar.volume / view.volMax) * (VOL_BOTTOM - VOL_TOP) : 0;
          return (
            <rect
              key={`vol-${bar.date}`}
              x={view.xOf(index) - bodyWidth / 2}
              y={VOL_BOTTOM - height}
              width={bodyWidth}
              height={height}
              fill={rising ? "var(--pos)" : "var(--neg)"}
              opacity={0.55}
            />
          );
        })}

        {/* 副图：M06 或 B2 波动指标（线性/柱状/散点按 output.kind 渲染） */}
        {view.subSpansZero && (
          <line x1={LEFT} x2={RIGHT} y1={zeroY} y2={zeroY} stroke="var(--line2)" strokeWidth={0.7} />
        )}
        <text x={RIGHT + 8} y={MACD_TOP + 10} fontSize={9.5} fill="var(--faint)" className="mono">
          {view.subId}
        </text>
        {view.subLines.map((line) => {
          const isMacd = view.subId === "M06";
          if (line.kind === "histogram") {
            return (
              <g
                key={`sub-${line.key}`}
                data-macd={isMacd ? "hist" : undefined}
                data-sub-hist={isMacd ? undefined : view.subId}
              >
                {line.values.map((value, index) => {
                  if (value === null || !Number.isFinite(value)) return null;
                  const y = view.yOfSub(value);
                  const top = Math.min(y, zeroY);
                  const height = Math.max(1, Math.abs(y - zeroY));
                  return (
                    <rect
                      key={`hist-${index}`}
                      data-hist={value >= 0 ? "pos" : "neg"}
                      x={view.xOf(index) - bodyWidth / 2}
                      y={top}
                      width={bodyWidth}
                      height={height}
                      fill={value >= 0 ? "var(--pos)" : "var(--neg)"}
                      opacity={0.42}
                    />
                  );
                })}
              </g>
            );
          }
          if (line.kind === "dot") {
            return (
              <g
                key={`sub-${line.key}`}
                data-sub={isMacd ? undefined : view.subId}
                data-sub-key={line.key}
              >
                {line.values.map((value, index) =>
                  value !== null && Number.isFinite(value) ? (
                    <circle
                      key={`sub-dot-${index}`}
                      cx={view.xOf(index)}
                      cy={view.yOfSub(value)}
                      r={1.8}
                      fill={line.color}
                    />
                  ) : null,
                )}
              </g>
            );
          }
          return (
            <path
              key={`sub-${line.key}`}
              data-macd={isMacd ? line.key : undefined}
              data-sub={isMacd ? undefined : view.subId}
              data-sub-key={line.key}
              d={pathFor(line.values, view.xOf, view.yOfSub)}
              fill="none"
              stroke={line.color}
              strokeWidth={1.3}
            />
          );
        })}

        {/* 日期刻度 */}
        {view.dateTicks.map((tick) => (
          <text
            key={`date-${tick.index}`}
            x={tick.x}
            y={DATE_Y}
            fontSize={9.5}
            fill="var(--faint)"
            className="mono"
            textAnchor="middle"
          >
            {formatDate(view.visible[tick.index].date)}
          </text>
        ))}

        {/* 图例 */}
        <g className="mono" fontSize={9.5}>
          <text x={RIGHT - 300} y={24} fill="var(--muted)">
            T01–T05 · T19/T20/T22{overlayIds.length > 0 ? ` · B2 ×${overlayIds.length}` : ""}
          </text>
          <text x={RIGHT - 100} y={24} fill="var(--muted)">
            {view.subId}
          </text>
          <text x={RIGHT - 8} y={24} fill="var(--faint)" textAnchor="end">
            {view.subLines.map((line) => line.label).join(" / ")}
          </text>
        </g>

        {/* 十字光标 */}
        {hover !== null && (
          <line
            x1={view.xOf(hover)}
            x2={view.xOf(hover)}
            y1={PRICE_TOP}
            y2={MACD_BOTTOM}
            stroke="var(--accent)"
            strokeWidth={0.8}
            strokeDasharray="3 3"
            pointerEvents="none"
          />
        )}
      </svg>

      <div
        className={`chart-readout ${hovered ? "visible" : ""}`}
        data-readout-host="1"
        data-hover-index={hover ?? ""}
      >
        {hovered && hover !== null && (
          <>
            <span>{hovered.date}</span>
            <span>开 {formatPrice(hovered.open)}</span>
            <span>高 {formatPrice(hovered.high)}</span>
            <span>低 {formatPrice(hovered.low)}</span>
            <span>收 {formatPrice(hovered.close)}</span>
            <span>量 {formatVolume(hovered.volume)}</span>
            <span>额 {formatAmount(hovered.amount)}</span>
            {view.overlayLines.map((line) => {
              const isB1 = B1_OVERLAY_IDS.includes(line.indicatorId);
              const value = line.values[hover];
              return (
                <span
                  key={`readout-${line.id}`}
                  data-readout={
                    isB1 ? `ma-${line.indicatorId}` : `ov-${line.indicatorId}-${line.key}`
                  }
                  data-value={value ?? ""}
                  data-unit={line.unit}
                  style={{ color: line.color }}
                >
                  {isB1 ? line.indicatorId : `${line.indicatorId}·${line.key}`}{" "}
                  {formatPrice(value ?? Number.NaN)}
                  {line.unit ? ` ${line.unit}` : ""}
                </span>
              );
            })}
            {view.subLines.map((line) => {
              const value = line.values[hover];
              return (
                <span
                  key={`readout-sub-${line.key}`}
                  data-readout={`sub-${view.subId}-${line.key}`}
                  data-sub-readout={view.subId}
                  data-value={value ?? ""}
                  data-unit={view.subUnit}
                  style={{ color: line.color }}
                >
                  {line.label} {formatPrice(value ?? Number.NaN, digitsForUnit(view.subUnit))}
                  {view.subUnit ? ` ${view.subUnit}` : ""}
                </span>
              );
            })}
            <span
              data-readout="chg"
              data-sign={hoveredChg >= 0 ? "pos" : "neg"}
              style={{ color: hoveredChg >= 0 ? "var(--pos)" : "var(--neg)" }}
            >
              {hoveredChg >= 0 ? "▲" : "▼"} {formatPct(hoveredChg)}
            </span>
          </>
        )}
      </div>

      <div className="watermark">SIMULATED · 模拟数据</div>
    </div>
  );
}
