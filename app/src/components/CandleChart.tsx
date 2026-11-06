import { useMemo, useState, type MouseEvent } from "react";
import type { BarDto, SeriesDto } from "../lib/types";
import { formatAmount, formatDate, formatPct, formatPrice, formatVolume } from "../lib/format";

interface Props {
  bars: BarDto[];
  series: SeriesDto[];
  windowSize: number;
}

const W = 1000;
const H = 560;
const LEFT = 6;
const RIGHT = 938;
const PRICE_TOP = 12;
const PRICE_BOTTOM = 300;
const VOL_TOP = 316;
const VOL_BOTTOM = 376;
const MACD_TOP = 394;
const MACD_BOTTOM = 522;
const DATE_Y = 546;

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

export function CandleChart({ bars, series, windowSize }: Props) {
  const [hover, setHover] = useState<number | null>(null);

  const view = useMemo(() => {
    if (bars.length === 0) return null;
    const count = Math.min(windowSize, bars.length);
    const start = bars.length - count;
    const visible = bars.slice(start);

    const overlayIds = ["T01", "T02", "T03", "T04", "T05", "T19", "T20", "T22"];
    const overlayUnits: Record<string, string> = {
      T01: "元",
      T02: "元",
      T03: "元",
      T04: "元",
      T05: "元",
      T19: "元",
      T20: "元",
      T22: "元/根",
    };
    const seen = new Set<string>();
    const overlays = series
      .filter((item) => overlayIds.includes(item.indicatorId))
      .filter((item) => (seen.has(item.indicatorId) ? false : seen.add(item.indicatorId) && true))
      .map((item) => ({
        id: item.instanceId,
        indicatorId: item.indicatorId,
        label: item.outputs[0]?.labelZh ?? item.indicatorId,
        unit: overlayUnits[item.indicatorId] ?? "",
        color: item.outputs[0]?.color ?? "var(--warn)",
        values: item.outputs[0]?.values.slice(start) ?? [],
      }));
    const macd = series.find((item) => item.indicatorId === "M06");
    const macdOutput = (key: string) =>
      macd?.outputs.find((item) => item.key === key)?.values.slice(start) ?? [];
    const dif = macdOutput("dif");
    const dea = macdOutput("dea");
    const hist = macdOutput("hist");

    let priceMin = Infinity;
    let priceMax = -Infinity;
    let volMax = 0;
    let macdAbs = 0;

    visible.forEach((bar, index) => {
      priceMin = Math.min(priceMin, bar.low);
      priceMax = Math.max(priceMax, bar.high);
      volMax = Math.max(volMax, bar.volume);
      overlays.forEach((line) => {
        const value = line.values[index];
        if (value !== null && value !== undefined && Number.isFinite(value)) {
          priceMin = Math.min(priceMin, value);
          priceMax = Math.max(priceMax, value);
        }
      });
      [dif[index], dea[index], hist[index]].forEach((value) => {
        if (value !== null && value !== undefined) {
          macdAbs = Math.max(macdAbs, Math.abs(value));
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
    const yOfMacd = (value: number) =>
      (MACD_TOP + MACD_BOTTOM) / 2 -
      (value / (macdAbs || 1)) * ((MACD_BOTTOM - MACD_TOP) / 2);

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
      yOfMacd,
      priceTicks,
      dateTicks,
      overlays,
      dif,
      dea,
      hist,
      difColor: "#4FA3C7",
      deaColor: "#D9A340",
      volMax,
      macdAbs,
    };
  }, [bars, series, windowSize]);

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

        {/* 指标叠加层：T01–T05 / T19 / T20 / T22 */}
        {view.overlays.map((line) => (
          <path
            key={`overlay-${line.id}`}
            data-overlay={line.indicatorId}
            d={pathFor(line.values, view.xOf, view.yOfPrice)}
            fill="none"
            stroke={line.color}
            strokeWidth={1.3}
            opacity={0.92}
          />
        ))}

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

        {/* MACD */}
        <line x1={LEFT} x2={RIGHT} y1={zeroY} y2={zeroY} stroke="var(--line2)" strokeWidth={0.7} />
        <text x={RIGHT + 8} y={MACD_TOP + 10} fontSize={9.5} fill="var(--faint)" className="mono">
          MACD
        </text>
        <g data-macd="hist">
          {view.hist.map((value, index) => {
            if (value === null) return null;
            const y = view.yOfMacd(value);
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
        <path
          data-macd="dif"
          d={pathFor(view.dif, view.xOf, view.yOfMacd)}
          fill="none"
          stroke={view.difColor}
          strokeWidth={1.3}
        />
        <path
          data-macd="dea"
          d={pathFor(view.dea, view.xOf, view.yOfMacd)}
          fill="none"
          stroke={view.deaColor}
          strokeWidth={1.3}
        />

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
          <text x={RIGHT - 210} y={24} fill="var(--muted)">
            T01–T05 · T19/T20/T22
          </text>
          <text x={RIGHT - 100} y={24} fill={view.difColor}>
            DIF
          </text>
          <text x={RIGHT - 62} y={24} fill={view.deaColor}>
            DEA
          </text>
          <text x={RIGHT - 8} y={24} fill="var(--muted)" textAnchor="end">
            HIST
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
            {view.overlays.map((line) => (
              <span
                key={`readout-${line.id}`}
                data-readout={`ma-${line.indicatorId}`}
                data-value={line.values[hover] ?? ""}
                data-unit={line.unit}
                style={{ color: line.color }}
              >
                {line.indicatorId} {formatPrice(line.values[hover] ?? Number.NaN)}
                {line.unit ? ` ${line.unit}` : ""}
              </span>
            ))}
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
