import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { BarDto, SeriesDto } from "../lib/types";
import { formatAmount, formatDate, formatPct, formatPrice, formatVolume } from "../lib/format";
import {
  VOLUME_PANEL_ID,
  clampSubHeight,
  type SubPlotSetting,
} from "../features/workbench/model";

/** 可视区间（含端点，绝对下标；start/end 都指向 bars 数组） */
export interface ChartViewport {
  start: number;
  end: number;
}

interface Props {
  bars: BarDto[];
  series: SeriesDto[];
  /** S-02.07-01 可视区间：由工作台持有（按 code+period 记忆），图表只读 */
  viewport: ChartViewport;
  onViewportChange: (next: ChartViewport) => void;
  /** B2 主图叠加所选指标（B1 的 8 条图线始终保留） */
  overlayIds: string[];
  /** 副图格（含成交量格 VOL）的形态与顺序，容量 3，见 S-02.03-01 */
  subPlots: SubPlotSetting[];
  /** 副图格顺序/高度变化回写工作台（工作台负责全局持久化） */
  onSubPlotsChange: (next: SubPlotSetting[]) => void;
  /** 单个副图数据不足时的内联提示（键为指标 id），不阻塞主图 */
  subNotices?: Record<string, string>;
  /** 副图面板标题（含参数口径，如 MACD(12,26,9)） */
  subLabels: Record<string, string>;
  /** 指标单位（来自 manifest，避免前端二次维护） */
  units: Record<string, string>;
  /** 当前复权口径：除权日 tooltip 的措辞按它区分（AC-02.07-03 补3） */
  adjMode: "none" | "qfq" | "hfq";
}

const W = 1000;
const LEFT = 6;
const RIGHT = 938;
/** 主图价格区顶边 */
const PRICE_TOP = 12;
/** 图表基准高度：副图少时主图吃满空出来的高度（S-02.03-01 补1） */
const CHART_H_BASE = 738;
/** 主图价格区最小高度，低于它则整体加高，避免把 K 线压扁 */
const PRICE_MIN_HEIGHT = 200;
/** 底部日期轴高度 */
const DATE_AXIS_H = 26;
/** 副图格之间的空隙 */
const SUB_GAP = 10;
/** 副图格标题条高度（同时是拖拽换序的抓手） */
const SUB_HEADER_H = 22;
/** 副图格底边改高抓手厚度 */
const SUB_RESIZE_H = 6;

/** S-02.07-01：最小可视 20 根 / 默认 120 根（双击复位）/ 滚轮单格 1.15 倍 */
const MIN_BARS = 20;
const DEFAULT_BARS = 120;
const ZOOM_RATIO = 1.15;
/** 拖到数据边界后的橡皮筋位移上限与回弹时长 */
const OVERSCROLL_MAX = 28;
const SPRING_MS = 120;

const B1_OVERLAY_IDS = ["T01", "T02", "T03", "T04", "T05", "T19", "T20", "T22"];

function digitsForUnit(unit: string): number {
  if (unit === "无量纲") return 4;
  if (unit === "%") return 2;
  return 2;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function pathFor(
  values: (number | null)[],
  xOf: (index: number) => number,
  yOf: (value: number) => number,
  from = 0,
): string {
  let path = "";
  let penDown = false;
  values.forEach((value, index) => {
    if (index < from) {
      penDown = false;
      return;
    }
    if (value === null || !Number.isFinite(value)) {
      penDown = false;
      return;
    }
    path += `${penDown ? "L" : "M"}${xOf(index).toFixed(2)} ${yOf(value).toFixed(2)} `;
    penDown = true;
  });
  return path.trim();
}

/** 中间 NaN（左右两侧都有有限值）的可见下标——用于断点空心点；预热段不画点 */
function hollowIndexes(
  values: (number | null)[],
  from: number,
  to: number,
): number[] {
  const finite = values.map((value) => value !== null && Number.isFinite(value));
  const nextFinite: number[] = new Array(values.length).fill(-1);
  let next = -1;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    nextFinite[index] = next;
    if (finite[index]) next = index;
  }
  const out: number[] = [];
  let prev = -1;
  for (let index = 0; index <= to; index += 1) {
    if (index >= from && !finite[index] && prev >= 0 && nextFinite[index] >= 0) {
      out.push(index);
    }
    if (finite[index]) prev = index;
  }
  return out;
}

function firstFiniteIndex(values: (number | null)[]): number {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] !== null && Number.isFinite(values[index])) return index;
  }
  return -1;
}

/** D-19 停牌合成行：量/额为 0（与行情层 `suspended = volume <= 0` 同源） */
function isSuspended(bar: BarDto): boolean {
  return !(bar.volume > 0);
}

function isSplitDay(bar: BarDto): boolean {
  return bar.quality.includes("splitDay");
}

/** 副图格内的一条输出线 */
interface PanelLine {
  key: string;
  label: string;
  kind: string;
  color: string;
  values: (number | null)[];
  firstValid: number;
}

/** 副图格（成交量格与指标格共用同一套几何，便于统一拖拽/改高） */
interface Panel {
  id: string;
  kind: "volume" | "indicator";
  title: string;
  unit: string;
  lines: PanelLine[];
  lo: number;
  hi: number;
  spansZero: boolean;
  /** 整格外框上下边（含标题条） */
  top: number;
  bottom: number;
  /** 可绘制区上下边（标题条之下） */
  plotTop: number;
  plotBottom: number;
  height: number;
  index: number;
  zeroY: number;
  yOf: (value: number) => number;
  warmup: number;
  insufficient: boolean;
  notice: string | undefined;
}

export function CandleChart({
  bars,
  series,
  viewport,
  onViewportChange,
  overlayIds,
  subPlots,
  onSubPlotsChange,
  subNotices,
  subLabels,
  units,
  adjMode,
}: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const [cursor, setCursor] = useState<{
    left: number;
    top: number;
    uy: number;
    hostW: number;
    hostH: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [springing, setSpringing] = useState(false);
  const [overdrag, setOverdrag] = useState(0);
  const overdragRef = useRef(0);
  const springTimer = useRef<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const moveRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const dragRef = useRef<{
    x0: number;
    start: number;
    end: number;
  } | null>(null);

  /** S-02.03-01：副图格拖拽（换序 / 改高），同一时刻只允许一个 */
  const panelDragRef = useRef<{
    id: string;
    kind: "reorder" | "resize";
    y0: number;
    height0: number;
    index0: number;
    height?: number;
    target?: number;
  } | null>(null);
  const [panelDrag, setPanelDrag] = useState<{
    id: string;
    kind: "reorder" | "resize";
    height?: number;
    target?: number;
  } | null>(null);

  /** 副图格纵向堆叠几何：自底向上排，主图吃满剩余高度（S-02.03-01 补1） */
  const layout = useMemo(() => {
    const plots = subPlots.slice(0, 3);
    const stackHeights =
      plots.reduce((sum, item) => sum + item.height, 0) +
      SUB_GAP * Math.max(0, plots.length - 1);
    const needed = PRICE_TOP + PRICE_MIN_HEIGHT + SUB_GAP + stackHeights + DATE_AXIS_H;
    const height = Math.max(CHART_H_BASE, needed);
    const stackTop = height - DATE_AXIS_H - stackHeights;
    const priceBottom = stackTop - SUB_GAP;
    let cursorY = stackTop;
    const boxes = plots.map((item) => {
      const box = { id: item.id, height: item.height, top: cursorY, bottom: cursorY + item.height };
      cursorY += item.height + SUB_GAP;
      return box;
    });
    return { H: height, priceBottom, boxes, plots };
  }, [subPlots]);

  const setOverdragBoth = (value: number) => {
    overdragRef.current = value;
    setOverdrag(value);
  };

  const view = useMemo(() => {
    if (bars.length === 0) return null;
    const total = bars.length;
    const startAbs = clamp(Math.round(viewport.start), 0, total - 1);
    const endAbs = clamp(Math.round(viewport.end), startAbs, total - 1);
    const count = endAbs - startAbs + 1;
    const visible = bars.slice(startAbs, endAbs + 1);

    // 主图叠加：只为用户所选的 overlayIds（容量 2，K 线本身不计入，S-02.02-02）
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
      /** 预热根数（引擎给出）：B1 建议观察期（EMA 3N、TEMA 4.5N）；其前输出视为未过观察期，不展示 */
      warmup: number;
      /** 整段数据不足以算该指标（total < warmup+1） */
      insufficient: boolean;
      firstValid: number;
    }> = [];
    overlayIds.forEach((indicatorId) => {
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
          values: output.values.slice(startAbs, endAbs + 1),
          warmup: item.warmup,
          insufficient: total < item.warmup + 1,
          firstValid: firstFiniteIndex(output.values),
        });
      });
    });

    let priceMin = Infinity;
    let priceMax = -Infinity;
    let volMax = 0;

    visible.forEach((bar) => {
      priceMin = Math.min(priceMin, bar.low);
      priceMax = Math.max(priceMax, bar.high);
      volMax = Math.max(volMax, bar.volume);
    });
    overlayLines.forEach((line) => {
      // 整段不足的线不参与量程，避免被隐藏的输出把价格轴撑歪
      if (line.insufficient) return;
      line.values.forEach((value) => {
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
      layout.priceBottom -
      ((value - priceMin) / (priceMax - priceMin)) * (layout.priceBottom - PRICE_TOP);

    // 副图格：成交量 + 指标合计最多 3 格，各自量程、按用户高度堆叠（S-02.03-01）
    const subPanels: Panel[] = layout.boxes.map((box, index) => {
      const plotTop = box.top + SUB_HEADER_H;
      const plotBottom = box.bottom;
      const base = {
        id: box.id,
        top: box.top,
        bottom: box.bottom,
        plotTop,
        plotBottom,
        height: box.height,
        index,
      };
      if (box.id === VOLUME_PANEL_ID) {
        const scaleMax = volMax > 0 ? volMax : 1;
        return {
          ...base,
          kind: "volume",
          title: "成交量",
          unit: "手",
          lines: [],
          lo: 0,
          hi: scaleMax,
          spansZero: false,
          zeroY: plotBottom,
          yOf: (value: number) =>
            plotBottom - (value / scaleMax) * (plotBottom - plotTop),
          warmup: 0,
          insufficient: false,
          notice: undefined,
        };
      }
      const sub = series.find((item) => item.indicatorId === box.id);
      const lines = (sub?.outputs ?? []).map((output) => ({
        key: output.key,
        label: output.labelZh,
        kind: output.kind,
        color: output.color,
        values: output.values.slice(startAbs, endAbs + 1),
        firstValid: firstFiniteIndex(output.values),
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
        const padValue = Math.max((max - min) * 0.08, Math.abs(max) * 0.04, 1e-6);
        lo = min - padValue;
        hi = max + padValue;
      }
      const warmup = sub?.warmup ?? 0;
      return {
        ...base,
        kind: "indicator",
        title: subLabels[box.id] ?? box.id,
        unit: units[box.id] ?? "",
        lines,
        lo,
        hi,
        spansZero,
        zeroY: (plotTop + plotBottom) / 2,
        yOf: (value: number) =>
          plotBottom - ((value - lo) / (hi - lo)) * (plotBottom - plotTop),
        warmup,
        // 整段数据不足：不画任何线段与平线，面板居中提示（S-02.07-02 AC-02.07-03）
        insufficient: sub ? total < warmup + 1 : false,
        notice: sub
          ? `${(subLabels[box.id] ?? box.id).split("(")[0]} 需要 ${warmup + 1} 根，当前 ${total} 根`
          : subNotices?.[box.id],
      };
    });

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
      for (let i = Math.max(1, startAbs); i <= endAbs; i += 1) {
        const longNow = long[i];
        const shortPrev = short[i - 1];
        const shortNow = short[i];
        const longPrev = long[i - 1];
        if (isFinite(longNow) && isFinite(shortPrev)) {
          t13Flips.push({ x: xOf(i - startAbs), y: yOfPrice(longNow) });
        } else if (isFinite(shortNow) && isFinite(longPrev)) {
          t13Flips.push({ x: xOf(i - startAbs), y: yOfPrice(shortNow) });
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
      let i = startAbs;
      while (i <= endAbs) {
        if (!okAt(i)) {
          i += 1;
          continue;
        }
        const sign = (a[i] as number) >= (b[i] as number) ? "pos" : "neg";
        let j = i;
        while (
          j + 1 <= endAbs &&
          okAt(j + 1) &&
          (((a[j + 1] as number) >= (b[j + 1] as number)) === (sign === "pos"))
        ) {
          j += 1;
        }
        const points: string[] = [];
        for (let k = i; k <= j; k += 1) {
          points.push(`${xOf(k - startAbs)},${yOfPrice(a[k] as number)}`);
        }
        for (let k = j; k >= i; k -= 1) {
          points.push(`${xOf(k - startAbs)},${yOfPrice(b[k] as number)}`);
        }
        cloudBands.push({ sign, d: `M${points.join(" L")} Z` });
        i = j + 1;
      }
    }

    // 除权日：质量标记 splitDay（后端复权因子在该行发生跳变）
    const splitMarkers = visible
      .map((bar, index) => ({ bar, index }))
      .filter((entry) => isSplitDay(entry.bar));

    return {
      total,
      startAbs,
      endAbs,
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
      splitMarkers,
      /** 图表可用区底边（日期轴之上） */
      chartBottom: layout.H - DATE_AXIS_H,
    };
  }, [bars, series, viewport.start, viewport.end, overlayIds, layout, subLabels, units, subNotices]);

  // 主题/尺寸无关的坐标换算：以 SVG 实际渲染尺寸为准（preserveAspectRatio=meet 居中）
  const geometry = () => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const scale = Math.min(rect.width / W, rect.height / layout.H);
    return {
      rect,
      scale,
      offsetX: (rect.width - W * scale) / 2,
      offsetY: (rect.height - layout.H * scale) / 2,
    };
  };

  const applyPointer = () => {
    rafRef.current = null;
    const point = moveRef.current;
    if (!point || !view) return;
    const geo = geometry();
    if (!geo) return;
    const x = (point.clientX - geo.rect.left - geo.offsetX) / geo.scale;
    const y = (point.clientY - geo.rect.top - geo.offsetY) / geo.scale;
    if (x < LEFT || x > RIGHT || y < PRICE_TOP || y > view.chartBottom) {
      setHover(null);
      setCursor(null);
      return;
    }
    const index = clamp(Math.floor((x - LEFT) / view.step), 0, view.count - 1);
    const host = hostRef.current;
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    setHover(index);
    setCursor({
      left: geo.rect.left - hostRect.left + geo.offsetX + x * geo.scale,
      top: geo.rect.top - hostRect.top + geo.offsetY + y * geo.scale,
      uy: y,
      hostW: host.clientWidth,
      hostH: host.clientHeight,
    });
  };

  // hover 走 mousemove（取证脚本也用它驱动）；拖拽走 pointermove 以获得指针捕获
  const handleMouseMove = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (dragRef.current || panelDragRef.current) return;
    moveRef.current = { clientX: event.clientX, clientY: event.clientY };
    if (rafRef.current === null) rafRef.current = window.requestAnimationFrame(applyPointer);
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragRef.current || !view) return;
    const geo = geometry();
    if (!geo) return;
    const drag = dragRef.current;
    const dxUser = (event.clientX - drag.x0) / geo.scale;
    const span = drag.end - drag.start + 1;
    const desiredStart = drag.start - dxUser / view.step;
    const maxStart = Math.max(0, view.total - span);
    const clampedStart = clamp(desiredStart, 0, maxStart);
    const nextStart = Math.round(clampedStart);
    if (nextStart !== view.startAbs) {
      onViewportChange({ start: nextStart, end: nextStart + span - 1 });
    }
    setOverdragBoth(
      clamp((desiredStart - clampedStart) * view.step, -OVERSCROLL_MAX, OVERSCROLL_MAX),
    );
  };

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || !view) return;
    const geo = geometry();
    if (!geo) return;
    const x = (event.clientX - geo.rect.left - geo.offsetX) / geo.scale;
    const y = (event.clientY - geo.rect.top - geo.offsetY) / geo.scale;
    if (x < LEFT || x > RIGHT || y < PRICE_TOP || y > view.chartBottom) return;
    dragRef.current = { x0: event.clientX, start: view.startAbs, end: view.endAbs };
    setDragging(true);
    setHover(null);
    setCursor(null);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 合成指针事件没有真实 pointerId 时会抛 NotFoundError；拖拽逻辑本身不依赖捕获
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // 同上：合成事件可能没有可释放的捕获
    }
    if (overdragRef.current !== 0) {
      // 橡皮筋回弹：120ms 内把越界位移收回 0（S-02.07-01 补2）
      if (springTimer.current !== null) window.clearTimeout(springTimer.current);
      setSpringing(true);
      setOverdragBoth(0);
      springTimer.current = window.setTimeout(() => {
        setSpringing(false);
        springTimer.current = null;
      }, SPRING_MS);
    }
  };

  const handleDoubleClick = () => {
    if (!view) return;
    const nextCount = Math.min(DEFAULT_BARS, view.total);
    onViewportChange({ start: view.total - nextCount, end: view.total - 1 });
    setHover(null);
    setCursor(null);
  };

  /** S-02.03-01：副图格标题条拖拽换序 / 底边拖拽改高（96–220px） */
  const beginPanelDrag = (
    event: ReactPointerEvent<SVGRectElement | SVGGElement>,
    panel: Panel,
    kind: "reorder" | "resize",
  ) => {
    if (event.button !== 0) return;
    // 不能让指针落到 SVG 根节点，否则会被当成图表平移
    event.stopPropagation();
    event.preventDefault();
    panelDragRef.current = {
      id: panel.id,
      kind,
      y0: event.clientY,
      height0: panel.height,
      index0: panel.index,
      height: panel.height,
      target: panel.index,
    };
    setPanelDrag({ id: panel.id, kind, height: panel.height, target: panel.index });
    setHover(null);
    setCursor(null);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 合成指针事件没有真实 pointerId
    }
  };

  const movePanelDrag = (event: ReactPointerEvent<SVGRectElement | SVGGElement>) => {
    const drag = panelDragRef.current;
    if (!drag) return;
    event.stopPropagation();
    const geo = geometry();
    if (!geo) return;
    if (drag.kind === "resize") {
      const dy = (event.clientY - drag.y0) / geo.scale;
      drag.height = clampSubHeight(drag.height0 + dy);
      setPanelDrag({ id: drag.id, kind: "resize", height: drag.height });
      return;
    }
    const y = (event.clientY - geo.rect.top - geo.offsetY) / geo.scale;
    let target = 0;
    layout.boxes.forEach((box, index) => {
      if (y > (box.top + box.bottom) / 2) target = Math.min(index + 1, layout.boxes.length - 1);
    });
    drag.target = target;
    setPanelDrag({ id: drag.id, kind: "reorder", target });
  };

  /** 移除副图格（成交量格常驻，不给 ×） */
  const removePanel = (id: string) => {
    onSubPlotsChange(subPlots.filter((item) => item.id !== id));
  };

  const endPanelDrag = (event: ReactPointerEvent<SVGRectElement | SVGGElement>) => {
    const drag = panelDragRef.current;
    if (!drag) return;
    event.stopPropagation();
    panelDragRef.current = null;
    setPanelDrag(null);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // 同上
    }
    if (drag.kind === "resize") {
      if (drag.height !== undefined && drag.height !== drag.height0) {
        onSubPlotsChange(
          subPlots.map((item) =>
            item.id === drag.id ? { ...item, height: drag.height as number } : item,
          ),
        );
      }
      return;
    }
    const target = drag.target ?? drag.index0;
    if (target === drag.index0) return;
    const moved = subPlots.find((item) => item.id === drag.id);
    if (!moved) return;
    const rest = subPlots.filter((item) => item.id !== drag.id);
    rest.splice(Math.min(target, rest.length), 0, moved);
    onSubPlotsChange(rest);
  };

  // 滚轮缩放：React 的 onWheel 在根节点是 passive，无法 preventDefault，改用原生监听
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !view) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      const geo = geometry();
      if (!geo) return;
      const x = (event.clientX - geo.rect.left - geo.offsetX) / geo.scale;
      if (x < LEFT || x > RIGHT) return;
      event.preventDefault();
      const oldCount = view.count;
      const zoomIn = event.deltaY < 0;
      const raw = oldCount * (zoomIn ? 1 / ZOOM_RATIO : ZOOM_RATIO);
      const nextCount = clamp(
        Math.round(raw),
        Math.min(MIN_BARS, view.total),
        view.total,
      );
      if (nextCount === oldCount) return;
      // 以光标所在根为锚点保持相对位置（1 格 ≈ 1.15 倍）
      const anchorAbs =
        view.startAbs + clamp((x - LEFT) / view.step - 0.5, 0, oldCount - 1);
      const ratio = (anchorAbs - view.startAbs) / Math.max(1, oldCount - 1);
      const nextStart = clamp(
        Math.round(anchorAbs - ratio * (nextCount - 1)),
        0,
        view.total - nextCount,
      );
      onViewportChange({ start: nextStart, end: nextStart + nextCount - 1 });
      setHover(null);
      setCursor(null);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [view, onViewportChange]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
      if (springTimer.current !== null) window.clearTimeout(springTimer.current);
    };
  }, []);

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
  // 换标的/换周期后旧光标下标可能越界：统一归一为 null，避免 tooltip 解引用 undefined
  const hovered = hover !== null ? (view.visible[hover] ?? null) : null;
  const hoveredPrev = hover !== null && hover > 0 ? view.visible[hover - 1] : null;
  const hoveredChg =
    hovered && hoveredPrev ? (hovered.close / hoveredPrev.close - 1) * 100 : Number.NaN;
  const hoveredSuspended = hovered ? isSuspended(hovered) : false;
  const hoveredSplit = hovered ? isSplitDay(hovered) : false;
  // 除权日 tooltip 复权因子：splitDay 当行的因子可能是 1.0（拆分后口径），
  // 展示「对历史段生效」的因子（取当行与前一根中更小的那个）更贴近用户理解。
  const splitFactorOf = (index: number): number => {
    const now = view.visible[index]?.adjFactor;
    const prev = index > 0 ? view.visible[index - 1]?.adjFactor : undefined;
    if (prev !== undefined && Number.isFinite(prev) && (!Number.isFinite(now) || prev < now)) {
      return prev;
    }
    return Number.isFinite(now) ? now : 1;
  };

  const insufficientOverlays = view.overlayLines.filter((line) => line.insufficient);
  const lastBox = layout.boxes[layout.boxes.length - 1];
  const insertY =
    panelDrag?.kind === "reorder" && panelDrag.target !== undefined
      ? panelDrag.target >= layout.boxes.length
        ? (lastBox?.bottom ?? layout.priceBottom) + SUB_GAP / 2
        : layout.boxes[panelDrag.target].top - SUB_GAP / 2
      : null;
  const dragBox = panelDrag ? layout.boxes.find((box) => box.id === panelDrag.id) : undefined;
  const previewY =
    dragBox && panelDrag?.height !== undefined ? dragBox.top + panelDrag.height : null;
  const hoverPanel =
    cursor && cursor.uy > layout.priceBottom
      ? view.subPanels.find((panel) => cursor.uy >= panel.top && cursor.uy <= panel.bottom) ?? null
      : null;

  return (
    <div className="chart-host" ref={hostRef}>
      <svg
        ref={svgRef}
        className="chart-svg"
        data-chart="candle"
        data-view-start={view.startAbs}
        data-view-end={view.endAbs}
        data-bar-count={view.total}
        viewBox={`0 0 ${W} ${layout.H}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ cursor: dragging ? "grabbing" : "crosshair", touchAction: "none" }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => {
          moveRef.current = null;
          if (rafRef.current !== null) {
            window.cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
          }
          if (!dragRef.current) setHover(null);
          setCursor(null);
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
      >
        <g
          data-overdrag={overdrag.toFixed(2)}
          data-springing={springing ? "1" : "0"}
          style={{
            transform: `translateX(${overdrag}px)`,
            transition: springing ? `transform ${SPRING_MS}ms ease-out` : undefined,
          }}
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

          {/* K 线：停牌合成行不画实体/影线（D-19 口径） */}
          {view.visible.map((bar, index) => {
            const x = view.xOf(index);
            if (isSuspended(bar)) {
              return (
                <g key={bar.date} data-suspended={bar.date} data-suspended-index={index}>
                  <rect
                    x={x - bodyWidth / 2}
                    y={PRICE_TOP}
                    width={bodyWidth}
                    height={layout.priceBottom - PRICE_TOP}
                    fill="transparent"
                  />
                </g>
              );
            }
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
                  data-candle={ rising ? "up" : "down" }
                  data-index={index}
                  data-date={bar.date}
                  data-close={formatPrice(bar.close)}
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

          {/* 除权日：K 线下方 4px 三角（S-02.07-02 补3） */}
          {view.splitMarkers.map(({ bar, index }) => {
            const x = view.xOf(index);
            const y = Math.min(layout.priceBottom - 2, view.yOfPrice(bar.low) + 5);
            const factor = splitFactorOf(index);
            return (
              <path
                key={`split-${bar.date}`}
                data-split-marker={bar.date}
                data-split-factor={Number.isFinite(factor) ? factor : ""}
                d={`M${(x - 3.5).toFixed(2)} ${y.toFixed(2)} L${(x + 3.5).toFixed(2)} ${y.toFixed(2)} L${x.toFixed(2)} ${(y - 4).toFixed(2)} Z`}
                fill="var(--accent)"
                opacity={0.9}
              />
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
                data-warmup={line.warmup}
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
              <g
                key={`overlay-${line.id}`}
                data-warmup={line.warmup}
                data-series-empty={line.insufficient ? "1" : undefined}
              >
                <path
                  data-overlay={line.indicatorId}
                  data-overlay-key={line.key}
                  data-valid-from={Math.max(line.firstValid, line.warmup)}
                  d={line.insufficient ? "" : pathFor(line.values, view.xOf, view.yOfPrice, Math.max(0, line.warmup - view.startAbs))}
                  fill="none"
                  stroke={line.color}
                  strokeWidth={1.3}
                  opacity={0.92}
                  strokeDasharray={
                    line.indicatorId === "T09" && line.key === "middle" ? "4 3" : undefined
                  }
                />
                {/* 中间 NaN 断点：空心点（预热段不画） */}
                {!line.insufficient &&
                  hollowIndexes(line.values, Math.max(0, line.warmup - view.startAbs), view.count - 1).map((index) => {
                    const prev =
                      line.values
                        .slice(0, index)
                        .reverse()
                        .find((value) => value !== null && Number.isFinite(value)) ?? 0;
                    return (
                      <circle
                        key={`hole-${index}`}
                        data-nan-dot={`${line.indicatorId}-${line.key}`}
                        cx={view.xOf(index)}
                        cy={view.yOfPrice(prev)}
                        r={2}
                        fill="none"
                        stroke={line.color}
                        strokeWidth={0.9}
                      />
                    );
                  })}
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

          {/* 全段 NaN：不画线，主图区居中提示（S-02.07-02 AC-02.07-03） */}
          {insufficientOverlays.length > 0 && (
            <g data-overlay-empty="1">
              {insufficientOverlays.map((line, index) => (
                <text
                  key={`overlay-empty-${line.id}`}
                  data-overlay-notice={`${line.indicatorId}-${line.key}`}
                  x={(LEFT + RIGHT) / 2}
                  y={
                    (PRICE_TOP + layout.priceBottom) / 2 +
                    (index - (insufficientOverlays.length - 1) / 2) * 13
                  }
                  textAnchor="middle"
                  fontSize={10.5}
                  fill="var(--accent)"
                  className="mono"
                >
                  {`${line.label} 需要 ${line.warmup + 1} 根，当前 ${view.total} 根`}
                </text>
              ))}
            </g>
          )}

          {/* 副图：最多 3 格（含成交量格），顺序与高度由 subPlots 决定（S-02.03-01） */}
          {view.subPanels.map((panel, panelIndex) => {
            const isMacd = panel.id === "M06";
            return (
              <g
                key={`sub-panel-${panel.id}`}
                data-sub-panel={panel.id}
                data-sub-index={panel.index}
                data-sub-height={panel.height}
                data-sub-empty={panel.insufficient ? "1" : undefined}
                data-warmup={panel.warmup}
                className="sub-panel"
              >
                {/* 标题条抓手：拖拽换序（S-02.03-01 / AC-02.03-03） */}
                <rect
                  data-panel-drag={panel.id}
                  x={LEFT}
                  y={panel.top}
                  width={RIGHT - LEFT}
                  height={SUB_HEADER_H}
                  fill="transparent"
                  style={{ cursor: "grab" }}
                  onPointerDown={(event) => beginPanelDrag(event, panel, "reorder")}
                  onPointerMove={movePanelDrag}
                  onPointerUp={endPanelDrag}
                  onPointerCancel={endPanelDrag}
                />
                {/* 底边抓手：拖拽改高，夹在 96~220px（S-02.03-01） */}
                <rect
                  data-panel-resize={panel.id}
                  x={LEFT}
                  y={panel.bottom - SUB_RESIZE_H}
                  width={RIGHT - LEFT}
                  height={SUB_RESIZE_H}
                  fill="transparent"
                  style={{ cursor: "ns-resize" }}
                  onPointerDown={(event) => beginPanelDrag(event, panel, "resize")}
                  onPointerMove={movePanelDrag}
                  onPointerUp={endPanelDrag}
                  onPointerCancel={endPanelDrag}
                />
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
                {panel.notice && (
                  <text
                    data-sub-notice={panel.id}
                    x={panel.insufficient ? (LEFT + RIGHT) / 2 : LEFT + 8}
                    y={panel.insufficient ? (panel.top + panel.bottom) / 2 : panel.top + 15}
                    textAnchor={panel.insufficient ? "middle" : undefined}
                    fontSize={9.5}
                    fill="var(--accent)"
                    className="mono"
                    pointerEvents="none"
                  >
                    {panel.notice}
                  </text>
                )}
                <text
                  data-sub-title={panel.title}
                  x={RIGHT - 18}
                  y={panel.top + 15}
                  textAnchor="end"
                  fontSize={10}
                  fill="var(--faint)"
                  className="mono"
                  pointerEvents="none"
                >
                  {panel.title}
                </text>
                {panel.kind !== "volume" && (
                  <text
                    data-panel-remove={panel.id}
                    x={RIGHT - 2}
                    y={panel.top + 15}
                    textAnchor="end"
                    fontSize={12}
                    fill="var(--muted)"
                    style={{ cursor: "pointer" }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      removePanel(panel.id);
                    }}
                  >
                    ×
                  </text>
                )}
                {/* 成交量格：柱高按当日量占视窗最大量，红涨绿跌（停牌日 0 高） */}
                {panel.kind === "volume" &&
                  view.visible.map((bar, index) => {
                    if (isSuspended(bar)) {
                      return (
                        <rect
                          key={`vol-${bar.date}`}
                          data-vol-suspended={bar.date}
                          x={view.xOf(index) - bodyWidth / 2}
                          y={panel.plotBottom}
                          width={bodyWidth}
                          height={0}
                          fill="transparent"
                        />
                      );
                    }
                    const rising = bar.close >= bar.open;
                    const height =
                      view.volMax > 0
                        ? (bar.volume / view.volMax) * (panel.plotBottom - panel.plotTop)
                        : 0;
                    return (
                      <rect
                        key={`vol-${bar.date}`}
                        x={view.xOf(index) - bodyWidth / 2}
                        y={panel.plotBottom - height}
                        width={bodyWidth}
                        height={height}
                        fill={rising ? "var(--pos)" : "var(--neg)"}
                        opacity={0.55}
                      />
                    );
                  })}
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
                                      : "var(--flat)"
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
                          d={panel.insufficient ? "" : pathFor(splitBySign(true), view.xOf, panel.yOf, Math.max(0, panel.warmup - view.startAbs))}
                          fill="none"
                          stroke="var(--pos)"
                          strokeWidth={1.3}
                        />
                        <path
                          data-sub-sign="neg"
                          d={panel.insufficient ? "" : pathFor(splitBySign(false), view.xOf, panel.yOf, Math.max(0, panel.warmup - view.startAbs))}
                          fill="none"
                          stroke="var(--neg)"
                          strokeWidth={1.3}
                        />
                        {!panel.insufficient &&
                          hollowIndexes(line.values, Math.max(0, panel.warmup - view.startAbs), view.count - 1).map((index) => (
                            <circle
                              key={`hole-${index}`}
                              data-nan-dot={`${panel.id}-${line.key}`}
                              cx={view.xOf(index)}
                              cy={panel.zeroY}
                              r={2}
                              fill="none"
                              stroke="var(--accent)"
                              strokeWidth={0.9}
                            />
                          ))}
                      </g>
                    );
                  }
                  return (
                    <g key={`sub-${line.key}`}>
                      <path
                        data-macd={isMacd ? line.key : undefined}
                        data-sub={isMacd ? undefined : panel.id}
                        data-sub-key={line.key}
                        data-valid-from={Math.max(line.firstValid, panel.warmup)}
                        d={panel.insufficient ? "" : pathFor(line.values, view.xOf, panel.yOf, Math.max(0, panel.warmup - view.startAbs))}
                        fill="none"
                        stroke={line.color}
                        strokeWidth={1.3}
                      />
                      {!panel.insufficient &&
                        hollowIndexes(line.values, Math.max(0, panel.warmup - view.startAbs), view.count - 1).map((index) => {
                          const prev =
                            line.values
                              .slice(0, index)
                              .reverse()
                              .find((value) => value !== null && Number.isFinite(value)) ?? 0;
                          return (
                            <circle
                              key={`hole-${index}`}
                              data-nan-dot={`${panel.id}-${line.key}`}
                              cx={view.xOf(index)}
                              cy={panel.yOf(prev)}
                              r={2}
                              fill="none"
                              stroke={line.color}
                              strokeWidth={0.9}
                            />
                          );
                        })}
                    </g>
                  );
                })}
              </g>
            );
          })}

          {/* 拖拽反馈：换序时 2px accent 插入线，改高时显示落点（S-02.03-01） */}
          {insertY !== null && (
            <line
              data-panel-insert={panelDrag?.target}
              x1={LEFT}
              x2={RIGHT}
              y1={insertY}
              y2={insertY}
              stroke="var(--accent)"
              strokeWidth={2}
              pointerEvents="none"
            />
          )}
          {previewY !== null && (
            <line
              data-panel-preview-height={panelDrag?.height}
              x1={LEFT}
              x2={RIGHT}
              y1={previewY}
              y2={previewY}
              stroke="var(--accent)"
              strokeWidth={2}
              strokeDasharray="6 4"
              pointerEvents="none"
            />
          )}

          {/* 日期刻度 */}
          {view.dateTicks.map((tick) => (
            <text
              key={`date-${tick.index}`}
              x={tick.x}
              y={layout.H - 8}
              fontSize={9.5}
              fill="var(--faint)"
              className="mono"
              textAnchor="middle"
            >
              {formatDate(view.visible[tick.index].date)}
            </text>
          ))}

          {/* 图例：0 叠加时整块隐藏，不占位（S-02.02-02） */}
          {overlayIds.length > 0 && (
            <g className="mono" fontSize={9.5} data-overlay-legend="1">
              <text x={RIGHT - 100} y={24} fill="var(--muted)">
                {view.subPanels.map((panel) => panel.id).join(" / ")}
              </text>
              <text x={RIGHT - 8} y={24} fill="var(--faint)" textAnchor="end">
                {view.subPanels
                  .flatMap((panel) => panel.lines.map((line) => line.label))
                  .join(" / ")}
              </text>
              {view.overlayLines.map((line, index) => (
                <text
                  key={`legend-${line.id}`}
                  data-legend-line={`${line.indicatorId}.${line.key}`}
                  x={RIGHT - 300}
                  y={24 + index * 11}
                  fill={line.color}
                  fontSize={9}
                >
                  {line.label}
                </text>
              ))}
            </g>
          )}

          {/* 十字光标：竖向虚线贯穿主图与全部副图；横向线只在光标所在面板 */}
          {hover !== null && (
            <line
              data-crosshair-v="1"
              data-crosshair-x={view.xOf(hover)}
              x1={view.xOf(hover)}
              x2={view.xOf(hover)}
              y1={PRICE_TOP}
              y2={lastBox ? lastBox.bottom : layout.priceBottom}
              stroke="var(--accent)"
              strokeWidth={0.8}
              strokeDasharray="3 3"
              pointerEvents="none"
            />
          )}
          {cursor !== null && (
            <line
              data-crosshair-h="1"
              x1={LEFT}
              x2={RIGHT}
              y1={cursor.uy}
              y2={cursor.uy}
              stroke="var(--accent)"
              strokeWidth={0.7}
              strokeDasharray="3 3"
              opacity={0.7}
              pointerEvents="none"
            />
          )}
        </g>
      </svg>

      <div
        className={`chart-readout ${hovered ? "visible" : ""}`}
        data-readout="1"
        data-hover-index={hover ?? ""}
      >
        {hovered && hover !== null && (
          <>
            <span>{hovered.date}</span>
            {hoveredSuspended ? (
              <>
                <span data-suspended-readout="1" style={{ color: "var(--muted)" }}>
                  停牌
                </span>
                <span>量 {formatVolume(hovered.volume)}</span>
              </>
            ) : (
              <>
                <span>开 {formatPrice(hovered.open)}</span>
                <span>高 {formatPrice(hovered.high)}</span>
                <span>低 {formatPrice(hovered.low)}</span>
                <span>收 {formatPrice(hovered.close)}</span>
                <span>量 {formatVolume(hovered.volume)}</span>
                <span>额 {formatAmount(hovered.amount)}</span>
              </>
            )}
            {hoveredSplit && (
              <span data-split-readout="1" style={{ color: "var(--accent)" }}>
                除权日 · {`因子 ${formatPrice(splitFactorOf(hover), 4)}`}
              </span>
            )}
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
              {hoveredSuspended ? (
              <span data-readout="chg" data-sign="flat" style={{ color: "var(--muted)" }}>
                —
              </span>
            ) : (
              <span
                data-readout="chg"
                data-sign={hoveredChg >= 0 ? "pos" : "neg"}
                style={{ color: hoveredChg >= 0 ? "var(--pos)" : "var(--neg)" }}
              >
                {hoveredChg >= 0 ? "▲" : "▼"} {formatPct(hoveredChg)}
              </span>
            )}
          </>
        )}
      </div>

      {/* S-02.07-01 tooltip：跟随光标、偏移 12px，近边界翻转到另一侧 */}
      {cursor !== null && hovered !== null && hover !== null && (
        <div
          className="chart-tooltip"
          data-chart-tooltip="1"
          data-hover-index={hover}
          data-region={hoverPanel ? hoverPanel.id : "price"}
          style={{
            left: cursor.left + 12,
            top: cursor.top + 12,
            transform: `translate(${cursor.left + 12 > cursor.hostW / 2 ? "-100%" : "0"}, ${
              cursor.top + 12 > cursor.hostH / 2 ? "-100%" : "0"
            })`,
          }}
        >
          <div className="chart-tooltip-date">{hovered.date}</div>
          {hoveredSuspended ? (
            <div data-tooltip-suspended="1" style={{ color: "var(--muted)" }}>
              停牌
            </div>
          ) : (
            <>
              <div className="mono">
                开 {formatPrice(hovered.open)} · 高 {formatPrice(hovered.high)}
              </div>
              <div className="mono">
                低 {formatPrice(hovered.low)} · 收 {formatPrice(hovered.close)}
              </div>
              <div className="mono">
                量 {formatVolume(hovered.volume)} · 额 {formatAmount(hovered.amount)}
              </div>
            </>
          )}
          {hoveredSplit && (
            <div data-tooltip-split="1" data-adj-mode={adjMode} style={{ color: "var(--accent)" }}>
              除权日 ·{" "}
              {adjMode === "none"
                ? `不复权（因子 ${formatPrice(splitFactorOf(hover), 4)}）`
                : `前复权已调整（因子 ${formatPrice(splitFactorOf(hover), 4)}）`}
            </div>
          )}
          {view.subPanels.flatMap((panel) =>
            panel.lines.map((line) => {
              const value = line.values[hover];
              return (
                <div
                  key={`tip-${panel.id}-${line.key}`}
                  className="mono"
                  data-tooltip-sub={`${panel.id}-${line.key}`}
                  data-value={value ?? ""}
                  style={{ color: line.color }}
                >
                  {line.label} {formatPrice(value ?? Number.NaN, digitsForUnit(panel.unit))}
                  {panel.unit ? ` ${panel.unit}` : ""}
                </div>
              );
            }),
          )}
        </div>
      )}

      <div className="watermark">SIMULATED · 模拟数据</div>
    </div>
  );
}
