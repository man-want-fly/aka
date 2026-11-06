import { useMemo, useState, type MouseEvent } from "react";
import type { BarDto, SeriesDto } from "../lib/types";
import { formatAmount, formatDate, formatPct, formatPrice, formatVolume } from "../lib/format";

interface Props {
  bars: BarDto[];
  series: SeriesDto[];
  windowSize: number;
  /** B2 主图叠加所选指标（B1 的 8 条图线始终保留） */
  overlayIds: string[];
  /** 副图指标 id 列表（M06 或 V/M 系列），容量 3 */
  subIds: string[];
  /** 副图面板标题（含参数口径，如 MACD(12,26,9)） */
  subLabels: Record<string, string>;
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
/** 多副图之间的空隙（2~3 个副图时等分副图区） */
const SUB_GAP = 10;
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

export function CandleChart({ bars, series, windowSize, overlayIds, subIds, subLabels, units }: Props) {
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

    // 副图：最多 3 个（S-02.04-02 容量口径），每个独立量程、纵向等分副图区
    const bandCount = Math.max(1, subIds.length);
    const bandHeight = (MACD_BOTTOM - MACD_TOP - SUB_GAP * (bandCount - 1)) / bandCount;
    const subPanels = subIds.map((id, index) => {
      const sub = series.find((item) => item.indicatorId === id);
      const lines = (sub?.outputs ?? []).map((output) => ({
        key: output.key,
        label: output.labelZh,
        kind: output.kind,
        color: output.color,
        values: output.values.slice(start),
      }));
      let min = Infinity;
      let max = -Infinity;
      lines.forEach((line) => {
        line.values.forEach((value) => {
          if (value !== null && value !== undefined && Number.isFinite(value)) {
            min = Math.min(min, value);
            max = Math.max(max, value);
          }
        });
      });
      const spansZero = Number.isFinite(min) && Number.isFinite(max) && min <= 0 && max >= 0;
      let lo: number;
      let hi: number;
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        lo = -1;
        hi = 1;
      } else if (spansZero) {
        const extent = Math.max(Math.abs(min), Math.abs(max), 1e-9);
        lo = -extent;
        hi = extent;
      } else {
        const pad = Math.max((max - min) * 0.08, Math.abs(max) * 0.04, 1e-6);
        lo = min - pad;
        hi = max + pad;
      }
      const top = MACD_TOP + index * (bandHeight + SUB_GAP);
      const bottom = top + bandHeight;
      const yOf = (value: number) =>
        bottom - ((value - lo) / (hi - lo)) * (bottom - top);
      return {
        id,
        title: subLabels[id] ?? id,
        unit: units[id] ?? "",
        lines,
        lo,
        hi,
        spansZero,
        top,
        bottom,
        zeroY: (top + bottom) / 2,
        yOf,
      };
    });

    let priceMin = Infinity;
    let priceMax = -Infinity;
    let volMax = 0;

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

    if (!Number.isFinite(priceMin) || !Number.isFinite(priceMax)) return null;
    const pad = Math.max((priceMax - priceMin) * 0.06, 0.02);
    priceMin -= pad;
    priceMax += pad;

    const step = (RIGHT - LEFT) / count;
    const xOf = (index: number) => LEFT + index * step + step / 2;
    const yOfPrice = (value: number) =>
      PRICE_BOTTOM - ((value - priceMin) / (priceMax - priceMin)) * (PRICE_BOTTOM - PRICE_TOP);

    const priceTicks = Array.from({ length: 5 }, (_, i) => {
      const value = priceMin + ((priceMax - priceMin) * i) / 4;
      return { value, y: yOfPrice(value) };
    });

    const dateTicks = [0.1, 0.35, 0.6, 0.85].map((ratio) => {
      const index = Math.min(count - 1, Math.round((count - 1) * ratio));
      return { index, x: xOf(index) };
    });

    // T13 翻转根标记：新激活侧当根有值、旧激活侧上一根有值，即在 xOf 处打点
    const t13 = series.find((item) => item.indicatorId === "T13");
    const t13Flips: Array<{ x: number; y: number }> = [];
    if (t13) {
      const isFinite = (value: number | null | undefined): value is number =>
        value !== null && value !== undefined && Number.isFinite(value);
      const long = t13.outputs.find((output) => output.key === "long")?.values ?? [];
      const short = t13.outputs.find((output) => output.key === "short")?.values ?? [];
      for (let i = Math.max(1, start); i < bars.length; i += 1) {
        const longNow = long[i];
        const shortPrev = short[i - 1];
        const shortNow = short[i];
        const longPrev = long[i - 1];
        if (isFinite(longNow) && isFinite(shortPrev)) {
          t13Flips.push({ x: xOf(i - start), y: yOfPrice(longNow) });
        } else if (isFinite(shortNow) && isFinite(longPrev)) {
          t13Flips.push({ x: xOf(i - start), y: yOfPrice(shortNow) });
        }
      }
    }

    // T15 云带：先行带 A/B 之间的填充，按 A≥B（多，红）/ A<B（空，绿）分段着色
    const t15 = series.find((item) => item.indicatorId === "T15");
    const cloudBands: Array<{ sign: "pos" | "neg"; d: string }> = [];
    if (t15) {
      const a = t15.outputs.find((output) => output.key === "senkouA")?.values ?? [];
      const b = t15.outputs.find((output) => output.key === "senkouB")?.values ?? [];
      const okAt = (index: number) => {
        const av = a[index];
        const bv = b[index];
        return (
          av !== null && av !== undefined && Number.isFinite(av) &&
          bv !== null && bv !== undefined && Number.isFinite(bv)
        );
      };
      let i = Math.max(0, start);
      while (i < bars.length) {
        if (!okAt(i)) {
          i += 1;
          continue;
        }
        const sign = (a[i] as number) >= (b[i] as number) ? "pos" : "neg";
        let j = i;
        while (
          j + 1 < bars.length &&
          okAt(j + 1) &&
          (((a[j + 1] as number) >= (b[j + 1] as number)) === (sign === "pos"))
        ) {
          j += 1;
        }
        const points: string[] = [];
        for (let k = i; k <= j; k += 1) {
          points.push(`${xOf(k - start)},${yOfPrice(a[k] as number)}`);
        }
        for (let k = j; k >= i; k -= 1) {
          points.push(`${xOf(k - start)},${yOfPrice(b[k] as number)}`);
        }
        cloudBands.push({ sign, d: `M${points.join(" L")} Z` });
        i = j + 1;
      }
    }

    return {
      count,
      visible,
      step,
      xOf,
      yOfPrice,
      priceTicks,
      dateTicks,
      overlayLines,
      subPanels,
      volMax,
      t13Flips,
      cloudBands,
    };
  }, [bars, series, windowSize, overlayIds, subIds, subLabels, units]);

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

        {/* T15 云带填充：A≥B 红 / B>A 绿（半透明，压在线下） */}
        {view.cloudBands.map((band, index) => (
          <path
            key={`cloud-${index}`}
            data-cloud="T15"
            data-cloud-sign={band.sign}
            d={band.d}
            fill={band.sign === "pos" ? "var(--rise)" : "var(--fall)"}
            opacity={0.12}
            stroke="none"
          />
        ))}

        {/* 指标叠加层：B1 的 8 条 + B2 所选 */}
        {view.overlayLines.map((line) =>
          line.kind === "dot" ? (
            <g
              key={`overlay-${line.id}`}
              data-overlay={line.indicatorId}
              data-overlay-key={line.key}
            >
              {(() => {
                if (line.indicatorId !== "T16") {
                  return line.values.map((value, index) =>
                    value !== null && Number.isFinite(value) ? (
                      <circle
                        key={`dot-${index}`}
                        cx={view.xOf(index)}
                        cy={view.yOfPrice(value)}
                        r={2.2}
                        fill={line.color}
                      />
                    ) : null,
                  );
                }
                // T16：SAR 在收盘价下方视为多头（红），上方视为空头（绿）；方向翻转根补箭头
                const dirs = line.values.map((value, index) =>
                  value !== null && Number.isFinite(value)
                    ? value <= view.visible[index].close
                      ? 1
                      : -1
                    : 0,
                );
                const prevDir = (index: number) => {
                  for (let i = index - 1; i >= 0; i -= 1) if (dirs[i] !== 0) return dirs[i];
                  return 0;
                };
                return (
                  <>
                    {line.values.map((value, index) =>
                      value !== null && Number.isFinite(value) ? (
                        <circle
                          key={`dot-${index}`}
                          cx={view.xOf(index)}
                          cy={view.yOfPrice(value)}
                          r={2.2}
                          fill={dirs[index] > 0 ? "var(--rise)" : "var(--fall)"}
                        />
                      ) : null,
                    )}
                    {line.values.map((value, index) => {
                      if (value === null || !Number.isFinite(value)) return null;
                      const prev = prevDir(index);
                      if (dirs[index] === 0 || prev === 0 || prev === dirs[index]) return null;
                      const x = view.xOf(index);
                      const y = view.yOfPrice(value);
                      const d =
                        dirs[index] > 0
                          ? `M${x - 2.6} ${y + 5} L${x + 2.6} ${y + 5} L${x} ${y}`
                          : `M${x - 2.6} ${y - 5} L${x + 2.6} ${y - 5} L${x} ${y}`;
                      return (
                        <path
                          key={`arrow-${index}`}
                          data-flip="T16"
                          data-flip-dir={dirs[index] > 0 ? "up" : "down"}
                          d={d}
                          fill={dirs[index] > 0 ? "var(--rise)" : "var(--fall)"}
                        />
                      );
                    })}
                  </>
                );
              })()}
            </g>
          ) : (
            <g key={`overlay-${line.id}`}>
              <path
                data-overlay={line.indicatorId}
                data-overlay-key={line.key}
                d={pathFor(line.values, view.xOf, view.yOfPrice)}
                fill="none"
                stroke={line.color}
                strokeWidth={1.3}
                opacity={0.92}
                strokeDasharray={
                  line.indicatorId === "T09" && line.key === "middle" ? "4 3" : undefined
                }
              />
              {line.indicatorId === "T13" && line.key === "long"
                ? view.t13Flips.map((point, index) => (
                    <circle
                      key={`flip-${index}`}
                      data-flip="T13"
                      cx={point.x}
                      cy={point.y}
                      r={2.8}
                      fill="var(--accent)"
                    />
                  ))
                : null}
            </g>
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

        {/* 副图：最多 3 个（S-02.04-02 容量口径），等分副图区、各自量程 */}
        {view.subPanels.map((panel, panelIndex) => {
          const isMacd = panel.id === "M06";
          return (
            <g key={`sub-panel-${panel.id}`} data-sub-panel={panel.id} className="sub-panel">
              {panelIndex > 0 && (
                <line
                  data-sub-sep="1"
                  x1={LEFT}
                  x2={RIGHT}
                  y1={panel.top - SUB_GAP / 2}
                  y2={panel.top - SUB_GAP / 2}
                  stroke="var(--line)"
                  strokeWidth={0.7}
                />
              )}
              {panel.spansZero && (
                <line
                  data-sub-zero={panel.id}
                  x1={LEFT}
                  x2={RIGHT}
                  y1={panel.zeroY}
                  y2={panel.zeroY}
                  stroke="var(--line2)"
                  strokeWidth={0.7}
                />
              )}
              <text
                data-sub-title={panel.title}
                x={RIGHT + 8}
                y={panel.top + 10}
                fontSize={9.5}
                fill="var(--faint)"
                className="mono"
              >
                {panel.title}
              </text>
              {panel.lines.map((line) => {
                if (line.kind === "histogram") {
                  return (
                    <g
                      key={`sub-${line.key}`}
                      data-macd={isMacd ? "hist" : undefined}
                      data-sub-hist={isMacd ? undefined : panel.id}
                    >
                      {line.values.map((value, index) => {
                        if (value === null || !Number.isFinite(value)) return null;
                        const y = panel.yOf(value);
                        const top = Math.min(y, panel.zeroY);
                        const height = Math.max(1, Math.abs(y - panel.zeroY));
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
                      data-sub={isMacd ? undefined : panel.id}
                      data-sub-key={line.key}
                    >
                      {line.values.map((value, index) =>
                        value !== null && Number.isFinite(value) ? (
                          <circle
                            key={`sub-dot-${index}`}
                            cx={view.xOf(index)}
                            cy={panel.yOf(value)}
                            r={1.8}
                            fill={
                              panel.id === "M25" && line.key === "state"
                                ? value > 0
                                  ? "var(--rise)"
                                  : value < 0
                                    ? "var(--fall)"
                                    : "#3b82f6"
                                : line.color
                            }
                          />
                        ) : null,
                      )}
                    </g>
                  );
                }
                // V08 Gapo 需正负分色：按符号拆成两条路径，各自只保留同号点
                if (panel.id === "V08" && line.key === "gapo") {
                  const splitBySign = (positive: boolean) =>
                    line.values.map((value) =>
                      value !== null && Number.isFinite(value) && (positive ? value > 0 : value < 0)
                        ? value
                        : null,
                    );
                  return (
                    <g key={`sub-${line.key}`} data-sub={panel.id} data-sub-key={line.key}>
                      <path
                        data-sub-sign="pos"
                        d={pathFor(splitBySign(true), view.xOf, panel.yOf)}
                        fill="none"
                        stroke="var(--pos)"
                        strokeWidth={1.3}
                      />
                      <path
                        data-sub-sign="neg"
                        d={pathFor(splitBySign(false), view.xOf, panel.yOf)}
                        fill="none"
                        stroke="var(--neg)"
                        strokeWidth={1.3}
                      />
                    </g>
                  );
                }
                return (
                  <path
                    key={`sub-${line.key}`}
                    data-macd={isMacd ? line.key : undefined}
                    data-sub={isMacd ? undefined : panel.id}
                    data-sub-key={line.key}
                    d={pathFor(line.values, view.xOf, panel.yOf)}
                    fill="none"
                    stroke={line.color}
                    strokeWidth={1.3}
                  />
                );
              })}
            </g>
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
            T01–T05 · T19/T20/T22{overlayIds.length > 0 ? ` · B2: ${overlayIds.join("/")}` : ""}
          </text>
          <text x={RIGHT - 100} y={24} fill="var(--muted)">
            {view.subPanels.map((panel) => panel.id).join(" / ")}
          </text>
          <text x={RIGHT - 8} y={24} fill="var(--faint)" textAnchor="end">
            {view.subPanels
              .flatMap((panel) => panel.lines.map((line) => line.label))
              .join(" / ")}
          </text>
          {view.overlayLines
            .filter((line) => overlayIds.includes(line.indicatorId))
            .map((line, index) => (
              <text
                key={`legend-${line.id}`}
                data-legend-line={`${line.indicatorId}.${line.key}`}
                x={RIGHT - 300}
                y={38 + index * 11}
                fill={line.color}
                fontSize={9}
              >
                {line.label}
              </text>
            ))}
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
            {view.subPanels.flatMap((panel) =>
              panel.lines.map((line) => {
                const value = line.values[hover];
                return (
                  <span
                    key={`readout-sub-${panel.id}-${line.key}`}
                    data-readout={`sub-${panel.id}-${line.key}`}
                    data-sub-readout={panel.id}
                    data-value={value ?? ""}
                    data-unit={panel.unit}
                    style={{ color: line.color }}
                  >
                    {line.label} {formatPrice(value ?? Number.NaN, digitsForUnit(panel.unit))}
                    {panel.unit ? ` ${panel.unit}` : ""}
                  </span>
                );
              }),
            )}
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
