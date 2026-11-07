/**
 * S-02.07-01 / S-02.07-02 实机取证。
 *
 * 分两段：
 * 1. 数据层：D/W/M 三个周期取同一标的的 bars + series，落盘 `s207-wm-series.json`；
 *    在本文件内用 ISO 周/自然月重新聚合 D 线，与后端 W/M 逐根比对（Python 侧
 *    `tools/verify_wm_indicators.py` 对同一份 dump 做二次独立复算）。
 * 2. 渲染层：直接驱动真实 DOM（滚轮/拖拽/双击/鼠标移动），只断言 DOM 与计算样式。
 *
 * 几何常量与 `CandleChart` 同口径（断言只比较相对位置与同一映射下的 x）。
 */

import { ipc } from "../../lib/ipc";
import type { BarsResponse, CalcResponse, SeriesDto } from "../../lib/types";
import type { WorkbenchParams } from "./model";

interface Check {
  id: string;
  ac: string;
  layer: "data" | "render";
  passed: boolean;
  detail: string;
}

export interface S207Hooks {
  getActiveCode: () => string;
  setCode: (code: string) => void;
  setTimeframe: (tf: "D" | "W" | "M") => void;
  setAdj: (adj: "none" | "qfq" | "hfq") => void;
  setParams: (params: WorkbenchParams) => void;
  setDateRange: (from: string, to: string) => void;
  clearDateRange: () => void;
  setSubIds: (ids: string[]) => void;
  bars: () => BarsResponse | null;
  calc: () => CalcResponse | null;
  viewport: () => { start: number; end: number } | null;
  waitReady: (label: string, timeoutMs?: number) => Promise<void>;
}

const LEFT = 6;
const RIGHT = 938;
const PRICE_TOP = 12;
const PRICE_BOTTOM = 300;
const MACD_TOP = 394;
const MACD_BOTTOM = 522;

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

const q = <T extends Element>(selector: string) => document.querySelector<T>(selector);
const qa = <T extends Element>(selector: string) => Array.from(document.querySelectorAll<T>(selector));

const svg = () => {
  const node = q<SVGSVGElement>('[data-chart="candle"]');
  if (!node) throw new Error("图表未渲染");
  return node;
};

const num = (element: Element | null, name: string) =>
  Number(element?.getAttribute(name) ?? "NaN");

const viewInfo = () => {
  const node = svg();
  return {
    start: num(node, "data-view-start"),
    end: num(node, "data-view-end"),
    total: num(node, "data-bar-count"),
    count: num(node, "data-view-end") - num(node, "data-view-start") + 1,
  };
};

/** 与 CandleChart 的 pointer 换算一致：viewBox meet 居中 */
const geometry = () => {
  const node = svg();
  const rect = node.getBoundingClientRect();
  const scale = Math.min(rect.width / 1000, rect.height / 560);
  return {
    rect,
    scale,
    offsetX: (rect.width - 1000 * scale) / 2,
    offsetY: (rect.height - 560 * scale) / 2,
  };
};

const clientPoint = (index: number, yUser: number) => {
  const { rect, scale, offsetX, offsetY } = geometry();
  const { count } = viewInfo();
  const step = (RIGHT - LEFT) / count;
  const xUser = LEFT + index * step + step / 2;
  return {
    clientX: rect.left + offsetX + xUser * scale,
    clientY: rect.top + offsetY + yUser * scale,
    xUser,
  };
};

const moveTo = async (index: number, yUser: number) => {
  const point = clientPoint(index, yUser);
  const dispatch = () =>
    svg().dispatchEvent(
      new MouseEvent("mousemove", {
        clientX: point.clientX,
        clientY: point.clientY,
        bubbles: true,
        cancelable: true,
      }),
    );
  dispatch();
  await sleep(60);
  // hover 走 rAF 合帧；应用在后台窗口时 rAF 可能被节流，一次 dispatch 可能还没落地。
  // 以图表自身的 data-hover-index 为准轮询，未对齐则重投一次，避免取证脚手架假失败。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = Number(q('[data-readout="1"]')?.getAttribute("data-hover-index") ?? "NaN");
    if (Number.isFinite(current) && current === index) break;
    dispatch();
    await sleep(120);
  }
  return point;
};

const wheelAt = async (index: number, deltaY: number) => {
  const point = clientPoint(index, 150);
  svg().dispatchEvent(
    new WheelEvent("wheel", {
      deltaY,
      clientX: point.clientX,
      clientY: point.clientY,
      bubbles: true,
      cancelable: true,
    }),
  );
  await sleep(90);
};

const zoomInUntil = async (maxCount: number, limit = 16) => {
  let guard = 0;
  while (viewInfo().count > maxCount && guard < limit) {
    await wheelAt(Math.floor(viewInfo().count / 2), -120);
    guard += 1;
  }
  return viewInfo();
};

/** 指针拖拽：dx 为正 = 向右拖（回到更早的区间） */
const dragBy = async (dx: number, hold = false) => {
  const node = svg();
  const from = clientPoint(Math.floor(viewInfo().count / 2), 150);
  const pointer = (type: string, clientX: number) =>
    node.dispatchEvent(
      new PointerEvent(type, {
        clientX,
        clientY: from.clientY,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        pointerId: 1,
        pointerType: "mouse",
        bubbles: true,
        cancelable: true,
      }),
    );
  pointer("pointerdown", from.clientX);
  await sleep(30);
  pointer("pointermove", from.clientX + dx);
  await sleep(90);
  const during = Number(q('[data-chart="candle"] > g')?.getAttribute("data-overdrag") ?? "NaN");
  if (!hold) {
    pointer("pointerup", from.clientX + dx);
    await sleep(220);
  }
  return during;
};

const pathSegments = (path: string) => path.split("M").length - 1;

/** 路径里的所有点坐标（M/L 绝对坐标） */
const pathPoints = (path: string) =>
  Array.from(path.matchAll(/[ML]([\d.+-]+) ([\d.+-]+)/g)).map((match) => ({
    x: Number(match[1]),
    y: Number(match[2]),
  }));

const firstPathX = (path: string) => {
  const points = pathPoints(path);
  return points.length > 0 ? points[0].x : Number.NaN;
};

const isoWeekKey = (isoDate: string) => {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (date.getUTCDay() + 6) % 7; // 周一 = 0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // 本周周四
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / 604800000);
  return `${isoYear}-W${week}`;
};

interface Tally {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
  date: string;
}

/** 与后端 aggregate 同规则：首日开、末日收、极值、量额累加；W=ISO 周，M=自然月 */
function aggregateFromDaily(
  bars: BarsResponse["bars"],
  period: "W" | "M",
): Tally[] {
  const groups: Tally[] = [];
  let current = "";
  for (const bar of bars) {
    const key = period === "W" ? isoWeekKey(bar.date) : bar.date.slice(0, 7);
    if (key !== current) {
      current = key;
      groups.push({
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        amount: bar.amount,
        date: bar.date,
      });
    } else {
      const last = groups[groups.length - 1];
      last.high = Math.max(last.high, bar.high);
      last.low = Math.min(last.low, bar.low);
      last.close = bar.close;
      last.volume += bar.volume;
      last.amount += bar.amount;
      last.date = bar.date;
    }
  }
  return groups;
}

const WM_INSTANCES = [
  ["T01", { period: 20 }],
  ["T02", { period: 20 }],
  ["T03", { period: 20 }],
  ["T04", { period: 20 }],
  ["T05", { period: 20 }],
  ["T19", { period: 20 }],
  ["T20", { period: 20 }],
  ["T21", { period: 20 }],
  ["T22", { period: 20 }],
  ["E13", { period1: 6, period2: 12, period3: 24 }],
  ["M06", { fast: 12, slow: 26, signal: 9 }],
  ["V08", { period: 14 }],
] as const;

const finiteCount = (values: (number | null)[]) =>
  values.filter((value) => value !== null && Number.isFinite(value)).length;


export async function runS207Diagnostics(hooks: S207Hooks) {
  const checks: Check[] = [];
  const push = (
    id: string,
    ac: string,
    layer: Check["layer"],
    passed: boolean,
    detail: string,
  ) => {
    checks.push({ id, ac, layer, passed, detail });
  };
  const attempt = async (
    id: string,
    ac: string,
    layer: Check["layer"],
    fn: () => Promise<{ passed: boolean; detail: string }>,
  ) => {
    try {
      const result = await fn();
      push(id, ac, layer, result.passed, result.detail);
    } catch (error) {
      push(id, ac, layer, false, `异常：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // ---------------- 数据层：W/M 聚合与指标 ----------------
  const dumpCodes = ["600519.SH", "002594.SZ"];
  const dump: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    comparator: "app/tools/verify_wm_indicators.py",
    instances: WM_INSTANCES.map(([id, params]) => ({ indicatorId: id, params })),
    codes: {},
  };
  const seriesByCode = new Map<string, Record<string, SeriesDto>>();
  const barsByCode = new Map<string, Record<string, BarsResponse>>();

  for (const code of dumpCodes) {
    const bars: Record<string, BarsResponse> = {};
    const series: Record<string, SeriesDto[]> = {};
    for (const timeframe of ["D", "W", "M"] as const) {
      const barsResponse = await ipc.getBars({ security: code, timeframe, adj: "none" });
      const calcResponse = await ipc.calcIndicators({
        security: code,
        timeframe,
        adj: "none",
        generation: 1,
        instances: WM_INSTANCES.map(([id, params]) => ({
          instanceId: `wm-${id}`,
          indicatorId: id,
          params: params as Record<string, number>,
        })),
      });
      bars[timeframe] = barsResponse;
      series[timeframe] = calcResponse.series;
    }
    barsByCode.set(code, bars);
    const flat: Record<string, SeriesDto> = {};
    for (const timeframe of ["W", "M"] as const) {
      for (const item of series[timeframe]) flat[`${timeframe}|${item.indicatorId}`] = item;
    }
    seriesByCode.set(code, flat);
    (dump.codes as Record<string, unknown>)[code] = {
      bars: Object.fromEntries(
        (["D", "W", "M"] as const).map((tf) => [
          tf,
          {
            security: bars[tf].security,
            timeframe: bars[tf].timeframe,
            datasetId: bars[tf].datasetId,
            bars: bars[tf].bars.map((bar) => ({
              date: bar.date,
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
              volume: bar.volume,
              amount: bar.amount,
              adjFactor: bar.adjFactor,
              quality: bar.quality,
            })),
          },
        ]),
      ),
      series: Object.fromEntries(
        (["W", "M"] as const).map((tf) => [
          tf,
          series[tf].map((item) => ({
            instanceId: item.instanceId,
            indicatorId: item.indicatorId,
            warmup: item.warmup,
            outputs: item.outputs.map((output) => ({
              key: output.key,
              labelZh: output.labelZh,
              values: output.values,
            })),
          })),
        ]),
      ),
    };
  }

  const dumpPath = await ipc.diagWriteNamed("s207-wm-series.json", JSON.stringify(dump));
  push(
    "D-00",
    "S-02.07-01 W/M",
    "data",
    dumpPath.endsWith("s207-wm-series.json"),
    `W/M 指标独立复算 dump：${dumpPath}（${dumpCodes.join(" / ")} × D/W/M × ${WM_INSTANCES.length} 指标）`,
  );

  await attempt("D-01", "S-02.07-01 W/M", "data", async () => {
    const problems: string[] = [];
    for (const code of dumpCodes) {
      const bars = barsByCode.get(code);
      if (!bars) throw new Error(`缺 ${code} bars`);
      for (const period of ["W", "M"] as const) {
        const expected = aggregateFromDaily(bars.D.bars, period);
        const actual = bars[period].bars;
        if (expected.length !== actual.length) {
          problems.push(`${code} ${period} 根数 ${expected.length} vs ${actual.length}`);
          continue;
        }
        let maxPrice = 0;
        let maxVolume = 0;
        let maxAmount = 0;
        expected.forEach((want, index) => {
          const got = actual[index];
          if (want.date !== got.date) problems.push(`${code} ${period}#${index} date`);
          maxPrice = Math.max(
            maxPrice,
            Math.abs(want.open - got.open),
            Math.abs(want.high - got.high),
            Math.abs(want.low - got.low),
            Math.abs(want.close - got.close),
          );
          maxVolume = Math.max(maxVolume, Math.abs(want.volume - got.volume));
          maxAmount = Math.max(maxAmount, Math.abs(want.amount - got.amount));
        });
        if (maxPrice > 1e-9) problems.push(`${code} ${period} 价格差 ${maxPrice}`);
        if (maxVolume > 1e-6) problems.push(`${code} ${period} 量差 ${maxVolume}`);
        if (maxAmount > 0.011) problems.push(`${code} ${period} 额差 ${maxAmount}`);
      }
    }
    const counts = dumpCodes
      .map((code) => {
        const bars = barsByCode.get(code)!;
        return `${code} D${bars.D.bars.length}/W${bars.W.bars.length}/M${bars.M.bars.length}`;
      })
      .join(" · ");
    return {
      passed: problems.length === 0,
      detail: `${counts}；ISO 周/自然月重聚合逐根比对${problems.length === 0 ? "一致" : `差异 ${problems.slice(0, 3).join("；")}`}`,
    };
  });

  await attempt("D-02", "S-02.07-01 W/M", "data", async () => {
    const problems: string[] = [];
    const warmups: string[] = [];
    for (const code of dumpCodes) {
      const flat = seriesByCode.get(code)!;
      for (const [id] of WM_INSTANCES) {
        const w = flat[`W|${id}`].warmup;
        const m = flat[`M|${id}`].warmup;
        if (w !== m) problems.push(`${code} ${id} warmup W${w}≠M${m}`);
        if (code === "600519.SH") warmups.push(`${id}:${w}`);
      }
    }
    return {
      passed: problems.length === 0,
      detail: `warmup 与周期无关（同一参数下 W 与 M 相同）：${warmups.join(" ")}${problems.length ? `；${problems.join("；")}` : ""}`,
    };
  });

  await attempt("D-03", "AC-02.07-03", "data", async () => {
    const flat = seriesByCode.get("600519.SH")!;
    // 引擎 warmup 是 B1 建议观察期（EMA 3N、TEMA 4.5N），不是「首个有限值下标」：
    // T02 在 24 根时仍有 5 个有限值（索引 19~23），但 total < warmup+1 → 展示层按整段不足处理。
    const insufficient = ["T02", "T04", "T05", "M06"].filter(
      (id) => flat[`M|${id}`].warmup + 1 > 24,
    );
    const partial = ["T01", "T03", "T19", "T20", "T21", "T22"].filter(
      (id) => flat[`M|${id}`].warmup + 1 <= 24,
    );
    return {
      passed: insufficient.length === 4 && partial.length === 6,
      detail: `M=24 根：不足观察期 ${insufficient
        .map((id) => `${id}(warmup ${flat[`M|${id}`].warmup})`)
        .join("/")} · 可算 ${partial
        .map((id) => `${id}:${finiteCount(flat[`M|${id}`].outputs[0].values)}`)
        .join(" ")}`,
    };
  });

  // ---------------- 渲染层 ----------------
  const originalCode = hooks.getActiveCode();
  hooks.setAdj("none");
  hooks.setParams({
    maPeriod: 20,
    maType: "sma",
    fast: 12,
    slow: 26,
    signal: 9,
  });
  hooks.clearDateRange();
  hooks.setSubIds(["M06"]);
  hooks.setCode("600519.SH");
  hooks.setTimeframe("D");
  await hooks.waitReady("复位到 600519.SH 日线");

  // 复位默认视口
  svg().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await sleep(120);

  await attempt("R-01", "AC-02.07-01", "render", async () => {
    const zoomed = await zoomInUntil(40);
    if (zoomed.count > 41 || zoomed.count < 20) {
      return { passed: false, detail: `缩放后根数 ${zoomed.count}` };
    }
    const point = await moveTo(10, 150);
    const vLine = q('[data-crosshair-v="1"]');
    const hLine = q('[data-crosshair-h="1"]');
    const readout = q('[data-readout="1"]');
    const candle = q('[data-candle][data-index="10"]');
    const candleX = num(candle, "x") + num(candle, "width") / 2;
    const crossX = num(vLine, "data-crosshair-x");
    const tooltip = q('[data-chart-tooltip="1"]');
    const tipText = tooltip?.textContent ?? "";
    const subReadouts = qa('[data-readout^="sub-M06-"]');
    const values = subReadouts.map((entry) => entry.getAttribute("data-value") ?? "");
    const dif = q('[data-macd="dif"]');
    const step = (RIGHT - LEFT) / viewInfo().count;
    // 副图首个可见点必须与可视区第 0 根同 x（同一套 x 映射），而不是只看第一个有限值
    const subAligned = Math.abs(firstPathX(dif?.getAttribute("d") ?? "") - (LEFT + step / 2)) <= 1;
    const horizontalInPrice =
      num(hLine, "y1") === num(hLine, "y2") &&
      num(hLine, "y1") >= PRICE_TOP &&
      num(hLine, "y1") <= PRICE_BOTTOM;
    const verticalSpans =
      num(vLine, "x1") === num(vLine, "x2") &&
      num(vLine, "y1") === PRICE_TOP &&
      num(vLine, "y2") === MACD_BOTTOM;
    const passed =
      Math.abs(crossX - candleX) <= 1 &&
      Math.abs(crossX - point.xUser) <= 1 &&
      verticalSpans &&
      horizontalInPrice &&
      num(readout, "data-hover-index") === 10 &&
      subReadouts.length === 3 &&
      values.every((value) => value !== "") &&
      tipText.includes("开") &&
      tipText.includes("高") &&
      tipText.includes("量") &&
      subAligned;
    return {
      passed,
      detail: `40 根视口=${zoomed.count} · 十字线 x=${crossX} 与 K 线中心 ${candleX} 差 ${Math.abs(crossX - candleX).toFixed(2)}px · 竖线贯穿 ${num(vLine, "y1")}~${num(vLine, "y2")} · 横线仅在主图=${horizontalInPrice} · tooltip 含开/高/量=${tipText.includes("开") && tipText.includes("高") && tipText.includes("量")} · 副图 x 对齐=${subAligned} · 副图读数 ${values.join("/")}`,
    };
  });

  await attempt("R-02", "AC-02.07-01", "render", async () => {
    await moveTo(10, 450);
    const tooltip = q('[data-chart-tooltip="1"]');
    const region = tooltip?.getAttribute("data-region") ?? "";
    const hLine = q('[data-crosshair-h="1"]');
    const y = num(hLine, "y1");
    const inSub = y >= MACD_TOP && y <= MACD_BOTTOM;
    return {
      passed: region === "M06" && inSub,
      detail: `鼠标移到副图：tooltip 面板=${region} · 横线 y=${y}（副图 ${MACD_TOP}~${MACD_BOTTOM}）=${inSub}`,
    };
  });

  await attempt("R-03", "AC-02.07-01 补1", "render", async () => {
    await zoomInUntil(20);
    const atMin = viewInfo().count;
    for (let i = 0; i < 3; i += 1) await wheelAt(3, -120);
    const after = viewInfo();
    return {
      // 补1 只要求「根数保持 20、无空白右边界」：以光标为锚点放大时右端会同步左移，不强制停在末根
      passed:
        atMin === 20 &&
        after.count === 20 &&
        after.start >= 0 &&
        after.end <= after.total - 1,
      detail: `缩到 ${atMin} 根后再放大 3 次 → ${after.count} 根（视口 ${after.start}~${after.end} / 共 ${after.total}）`,
    };
  });

  await attempt("R-04", "AC-02.07-01 补3", "render", async () => {
    svg().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await sleep(160);
    const view = viewInfo();
    const expected = Math.min(120, view.total);
    return {
      passed: view.count === expected && view.end === view.total - 1,
      detail: `双击复位 → ${view.count} 根（期望 ${expected}），末端 ${view.end}/${view.total - 1}`,
    };
  });

  await attempt("R-05", "AC-02.07-01 补2", "render", async () => {
    const allButton = qa<HTMLButtonElement>(".seg button").find(
      (button) => button.textContent?.trim() === "全部",
    );
    if (!allButton) throw new Error("找不到「全部」按钮");
    allButton.click();
    await sleep(160);
    const before = viewInfo();
    const overdrag = await dragBy(140);
    await sleep(240);
    const g = q('[data-chart="candle"] > g');
    const after = viewInfo();
    return {
      passed:
        before.start === 0 &&
        Number.isFinite(overdrag) &&
        Math.abs(overdrag) > 0 &&
        Math.abs(overdrag) <= 28 &&
        after.start === 0 &&
        Number(q('[data-chart="candle"] > g')?.getAttribute("data-overdrag")) === 0 &&
        after.count === after.total,
      detail: `全历史视口 start=${before.start} · 越界拖拽位移 ${overdrag.toFixed(2)}px · 松手后位移 ${g?.getAttribute(
        "data-overdrag",
      )} · start=${after.start} · 根数 ${after.count}/${after.total}`,
    };
  });

  await attempt("R-06", "AC-02.07-01 补4", "render", async () => {
    const zoomed = await zoomInUntil(40);
    const remembered = { start: zoomed.start, end: zoomed.end, count: zoomed.count };
    hooks.setCode("300750.SZ");
    await hooks.waitReady("切到 300750.SZ");
    const other = viewInfo();
    hooks.setCode("600519.SH");
    await hooks.waitReady("切回 600519.SH");
    const back = viewInfo();
    const otherDefault = Math.min(120, other.total);
    return {
      passed:
        back.start === remembered.start &&
        back.end === remembered.end &&
        other.count === otherDefault,
      detail: `600519 缩放到 ${remembered.count} 根 [${remembered.start},${remembered.end}] → 300750 默认 ${other.count} 根（期望 ${otherDefault}）→ 切回 [${back.start},${back.end}]（${back.count} 根）`,
    };
  });

  // 38 根 + MA60：整段数据不足（AC-02.07-03）
  await attempt("R-07", "AC-02.07-03", "render", async () => {
    hooks.setParams({ maPeriod: 60, maType: "sma", fast: 12, slow: 26, signal: 9 });
    hooks.setDateRange("2024-11-06", "2024-12-27");
    await hooks.waitReady("38 根 + MA60");
    const total = viewInfo().total;
    const notices = qa('[data-overlay-notice]');
    const maPaths = qa('[data-overlay]').filter(
      (element) =>
        ["T01", "T02", "T03", "T04", "T05"].includes(
          element.getAttribute("data-overlay") ?? "",
        ) && (element.getAttribute("d") ?? "").length > 0,
    );
    const noticeTexts = notices.map((element) => element.textContent ?? "");
    const t01 = noticeTexts.find((text) => text.includes("需要"));
    const overlayInfo = ["T01", "T02", "T03", "T04", "T05"]
      .map((id) => {
        const element = qa("[data-overlay]").find(
          (node) => node.getAttribute("data-overlay") === id,
        );
        return `${id}:${element ? (element.getAttribute("d") ?? "").length : "missing"}`;
      })
      .join(" ");
    const priceTicks = qa('[data-chart="candle"] text').filter(
      (element) => Math.abs(num(element, "x") - (RIGHT + 8)) < 0.5,
    ).length;
    const candles = qa("[data-candle]").length;
    const passed =
      total === 38 &&
      notices.length === 5 &&
      maPaths.length === 0 &&
      noticeTexts.every((text) => text.includes("当前 38 根")) &&
      priceTicks >= 5 &&
      candles > 0;
    return {
      passed,
      detail: `总数 ${total} · 提示 ${notices.length} 条（${t01 ?? "无"}）· T01~T05 线段 ${maPaths.length} 条 · d 长度 ${overlayInfo} · y 轴刻度 ${priceTicks} · K 线 ${candles} 根（占位保留）`,
    };
  });

  await attempt("R-08", "AC-02.07-03 补5", "render", async () => {
    // 补足数据：清掉日期范围（同参数下自动重算，无需手动刷新）
    hooks.clearDateRange();
    await hooks.waitReady("补足数据");
    const total = viewInfo().total;
    const notices = qa('[data-overlay-notice]').length;
    const maPaths = qa('[data-overlay]').filter((element) =>
      ["T01", "T03"].includes(element.getAttribute("data-overlay") ?? ""),
    );
    return {
      passed: total >= 520 && notices === 0 && maPaths.length > 0,
      detail: `清日期范围后 ${total} 根 · 数据不足提示 ${notices} 条 · T01/T03 线段 ${maPaths.length} 条（自动出现）`,
    };
  });

  // 月线：不足预热如何呈现（一次定清）
  await attempt("R-09", "AC-02.07-03 W/M", "render", async () => {
    hooks.setParams({ maPeriod: 20, maType: "sma", fast: 12, slow: 26, signal: 9 });
    hooks.setTimeframe("M");
    await hooks.waitReady("月线");
    const view = viewInfo();
    const overlayNotices = qa('[data-overlay-notice]').map((element) => element.textContent ?? "");
    const t01 = q('[data-overlay="T01"]');
    const points = (t01?.getAttribute("d") ?? "").split("L").length;
    const subPanel = q('[data-sub-panel="M06"]');
    const subNotice = q('[data-sub-notice="M06"]')?.textContent ?? "";
    const subPath = q('[data-macd="dif"]');
    const subD = subPath?.getAttribute("d") ?? "";
    const empty =
      subPanel?.getAttribute("data-sub-empty") === "1" &&
      subNotice.includes("需要") &&
      subD.length === 0 &&
      overlayNotices.length === 3 &&
      points === 5 &&
      view.total === 24;
    return {
      passed: empty,
      detail: `月线 ${view.total} 根 · 整段不画线提示 ${overlayNotices.length} 条（${overlayNotices
        .join(" | ")}）· T01 有效点 ${points} · M06 副图 empty=${subPanel?.getAttribute(
        "data-sub-empty",
      )} 文案「${subNotice}」· 副图路径长度 ${subD.length}`,
    };
  });

  await attempt("R-10", "AC-02.07-01 W", "render", async () => {
    hooks.setTimeframe("W");
    await hooks.waitReady("周线");
    const view = viewInfo();
    const t01 = q('[data-overlay="T01"]');
    const warmup = num(t01, "data-valid-from");
    const bodyCount = qa("[data-candle]").length;
    const subPath = q('[data-macd="dif"]');
    const subFirst = (subPath?.getAttribute("d") ?? "").match(/M([\d.+-]+) ([\d.+-]+)/);
    const step = (RIGHT - LEFT) / view.count;
    const expectedX = LEFT + num(subPath, "data-valid-from") * step + step / 2;
    const aligned = subFirst ? Math.abs(Number(subFirst[1]) - expectedX) <= 1 : false;
    return {
      passed: view.total === 104 && warmup === 19 && bodyCount === view.count && aligned,
      detail: `周线 ${view.total} 根 · 可视 ${view.count} 根 / K 线 ${bodyCount} 根 · T01 首个有效下标 ${warmup} · 副图首点 x 对齐=${aligned}`,
    };
  });

  await attempt("R-11", "AC-02.07-01 W/M", "render", async () => {
    // 数据不足导致副图 NaN 时，十字光标在副图读数为「—」，主图读数照常
    hooks.setTimeframe("M");
    await hooks.waitReady("月线读数");
    await moveTo(3, 450);
    const subReadout = q('[data-readout="sub-M06-dif"]');
    const priceReadout = q('[data-readout="ma-T01"]');
    const tipText = q('[data-chart-tooltip="1"]')?.textContent ?? "";
    return {
      passed:
        subReadout !== null &&
        (subReadout.getAttribute("data-value") ?? "") === "" &&
        subReadout.textContent?.includes("—") === true &&
        priceReadout !== null &&
        tipText.includes("—"),
      detail: `月线第 3 根：副图读数「${subReadout?.textContent ?? "无"}」· 主图读数「${priceReadout?.textContent ?? "无"}」· tooltip 含「—」=${tipText.includes("—")}`,
    };
  });

  // 停牌：DIAGSUSP.SZ 第 80~99 根
  await attempt("R-12", "AC-02.07-03 补2/补4", "render", async () => {
    hooks.setTimeframe("D");
    hooks.setCode("DIAGSUSP.SZ");
    await hooks.waitReady("停牌样本");
    const view = viewInfo();
    const suspended = qa("[data-suspended]").length;
    const volSuspended = qa("[data-vol-suspended]").length;
    const candles = qa("[data-candle]").length;
    const visible = view.count;
    const bars = hooks.bars()?.bars ?? [];
    const startAbs = view.start;
    const suspendedFromBars = bars
      .slice(startAbs, startAbs + visible)
      .filter((bar) => !(bar.volume > 0)).length;
    await moveTo(90, 150);
    const readout = q('[data-suspended-readout="1"]');
    const hoverIndex = Number(q('[data-readout="1"]')?.getAttribute("data-hover-index") ?? "NaN");
    const tooltip = q('[data-chart-tooltip="1"]');
    const tipText = tooltip?.textContent ?? "";
    const noOhlc = !tipText.includes("开 ") && !tipText.includes("高 ");
    return {
      passed:
        suspended === 20 &&
        volSuspended === 20 &&
        candles === visible - 20 &&
        suspendedFromBars === 20 &&
        hoverIndex === 90 &&
        readout !== null &&
        q('[data-tooltip-suspended="1"]') !== null &&
        noOhlc,
      detail: `视口 ${view.start}~${view.end} · 停牌组 ${suspended} 个（行情层 ${suspendedFromBars}）· 量柱 ${volSuspended} 根 · K 线实体 ${candles} 根 · hover=${hoverIndex} · 读数 ${readout ? "有" : "无"} · tooltip 停牌区=${q('[data-tooltip-suspended="1"]') ? "有" : "无"} · 「${tipText.replace(/\s+/g, " ").slice(0, 50)}」不含 OHLC=${noOhlc}`,
    };
  });

  // 除权：mock 里带拆分的样本（seed%5==0），601012.SH 第 260 根 = 2024-01-01
  await attempt("R-13", "AC-02.07-03 补3", "render", async () => {
    hooks.setTimeframe("D");
    hooks.setCode("601012.SH");
    hooks.setDateRange("2023-12-01", "2024-02-29");
    await hooks.waitReady("除权样本");
    const marker = q('[data-split-marker="2024-01-01"]');
    const factor = marker ? num(marker, "data-split-factor") : Number.NaN;
    const bars = hooks.bars()?.bars ?? [];
    const firstDate = bars[0]?.date ?? "";
    const index = bars.findIndex((bar) => bar.date === "2024-01-01");
    await moveTo(index, 150);
    const hoverIndex = q("[data-readout='1']")?.getAttribute("data-hover-index") ?? "";
    const splitQuality = bars[index]?.quality?.includes("splitDay") ?? false;
    const group = q('[data-tooltip-split="1"]');
    const noneText = group?.textContent ?? "";
    const noneOk =
      marker !== null &&
      Number.isFinite(factor) &&
      noneText.includes("除权日") &&
      noneText.includes("不复权") &&
      group?.getAttribute("data-adj-mode") === "none";
    hooks.setAdj("qfq");
    await hooks.waitReady("切前复权");
    await moveTo(index, 150);
    const qfqGroup = q('[data-tooltip-split="1"]');
    const qfqText = qfqGroup?.textContent ?? "";
    const qfqMarker = q('[data-split-marker="2024-01-01"]');
    return {
      passed:
        splitQuality &&
        hoverIndex === String(index) &&
        noneOk &&
        qfqMarker !== null &&
        qfqText.includes("已调整"),
      detail: `首根 ${firstDate} · [2024-01-01] index=${index} · hover=${hoverIndex} · splitDay 标记=${splitQuality} · q=${[index - 1, index, index + 1]
        .map((i) => `${i}:${bars[i]?.date ?? "-"}/${(bars[i]?.quality ?? []).join(",")}`)
        .join(" ")} · marker ${marker?.tagName ?? "无"} ${(marker?.outerHTML ?? "").slice(0, 140)} · 不复权 tooltip「${noneText}」因子=${factor} · 前复权 tooltip「${qfqText}」标记仍在=${qfqMarker !== null}`,
    };
  });

  // 中间 NaN：M04 威廉 %R 在停牌合成行（高低差为 0）的窗口里为 NaN，左右两侧都有有效值
  // → 断线 + 空心点。（V08 Gapo 的 ATR=0 在真实数据上不可复现，故改用 M04）
  await attempt("R-14", "AC-02.07-03 补1", "render", async () => {
    hooks.setAdj("none");
    hooks.clearDateRange();
    hooks.setSubIds(["M04"]);
    hooks.setTimeframe("D");
    hooks.setCode("DIAGSUSP.SZ");
    await hooks.waitReady("中间 NaN 样本");
    const dots = qa('[data-nan-dot="M04-wr"]');
    const path = q('[data-sub="M04"]');
    const d = path?.getAttribute("d") ?? "";
    const holes = dots.map((element) => Number(element.getAttribute("cx")));
    const spans = d
      .split("M")
      .filter((segment) => segment.trim() !== "")
      .flatMap((segment) => {
        const pts = pathPoints(`M${segment}`);
        return pts.slice(1).map((point, index) => [pts[index].x, point.x] as const);
      });
    const crossing = spans.filter(([x1, x2]) =>
      holes.some((hole) => hole > Math.min(x1, x2) && hole < Math.max(x1, x2)),
    ).length;
    const distinct = new Set(holes.map((value) => value.toFixed(1))).size;
    const panel = hooks
      .calc()
      ?.series.find((item) => item.indicatorId === "M04") as
      | { warmup?: number; outputs?: { key: string; values: (number | null)[] }[] }
      | undefined;
    const panelValues = panel?.outputs?.[0]?.values ?? [];
    const finite = panelValues.filter((value) => value !== null && Number.isFinite(value)).length;
    return {
      passed:
        dots.length >= 3 && distinct === dots.length && crossing === 0 && pathSegments(d) >= 2,
      detail: `空心点 ${dots.length} 个（x 去重 ${distinct}）· 折线 ${pathSegments(d)} 段 · 跨越空洞的线段 ${crossing} · 面板 ${path ? "有" : "无"} · 序列 ${panelValues.length} 根/有效 ${finite}/warmup ${panel?.warmup} · 视口 ${viewInfo().start}~${viewInfo().end}`,
    };
  });

  // 还原现场
  hooks.setSubIds(["M06"]);
  hooks.setCode(originalCode);
  hooks.setTimeframe("D");
  hooks.setAdj("none");
  hooks.setParams({ maPeriod: 20, maType: "sma", fast: 12, slow: 26, signal: 9 });
  hooks.clearDateRange();

  const report = {
    ok: checks.every((check) => check.passed),
    finishedAt: new Date().toISOString(),
    generatedAt: (dump as { generatedAt: string }).generatedAt,
    wmDump: dumpPath,
    checks,
  };
  const written = await ipc.diagWriteNamed("s207-evidence.json", JSON.stringify(report, null, 2));
  return { ...report, writtenTo: written };
}
