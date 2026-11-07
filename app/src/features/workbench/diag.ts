/**
 * S2 实机取证编排（TD-S0-04 / 06 / 07）。
 *
 * 只在 `AKA_DIAG=1` 启动且运行在 Tauri 容器内时由 WorkbenchPage 调用：
 * 1. 参数连键 1→12→120（间隔 40ms）→ 统计真实发出的请求数，应为 1；
 * 2. 冷缓存切换 30 个标的 → 记录「请求发出→结果返回」墙钟，算 P95；
 * 3. 切回前 10 个标的 → 记录墙钟与 series 逐点签名，与冷样本比对。
 *
 * 采样只在真实 IPC 路径上产生（`WorkbenchPage` 的请求 effect），
 * 不构造任何合成数据；落盘由 Rust `diag_write` 写到
 * `~/Library/Application Support/aka/diag/s2-evidence.json`。
 */

import { ipc } from "../../lib/ipc";
import type { CalcResponse, TelemetrySummary } from "../../lib/types";
import type { WorkbenchParams } from "./model";

export type DiagPhase = "off" | "debounce" | "cold" | "warm" | "done";

export type TimeframeCode = "D" | "W" | "M";

export interface DiagSample {
  phase: "debounce" | "cold" | "warm";
  security: string;
  timeframe: string;
  adj: string;
  /** 请求发出 → 行情返回（ms） */
  barsMs: number;
  /** 请求发出 → 指标返回（ms） */
  calcMs: number;
  /** 请求发出 → 两者都就绪（ms） */
  totalMs: number;
  cacheHit: boolean;
  computedMs: number;
  barCount: number;
  /** 全量 series 的逐点签名（FNV-1a over 每个数值 token） */
  seriesHash: string;
  seriesPoints: number;
  /** 仅在失败样本出现：错误码 + 文案 */
  error?: string;
}

export interface DiagHooks {
  codes: string[];
  /** 实时读取当前标的（不能用启动时的快照，否则「切回原标的」会切到启动时的标的） */
  getActiveCode: () => string;
  baseParams: WorkbenchParams;
  setPhase: (phase: DiagPhase) => void;
  setCode: (code: string) => void;
  setParams: (params: WorkbenchParams) => void;
  setTimeframe: (timeframe: TimeframeCode) => void;
  nextSample: (timeoutMs?: number) => Promise<DiagSample | null>;
  drainSamples: () => DiagSample[];
  telemetry: () => Promise<TelemetrySummary>;
  probeBars: (
    timeframe: TimeframeCode,
  ) => Promise<{ timeframe: string; barCount: number; datasetId: string }>;
  write: (payload: string) => Promise<string>;
  /** 请求形状留档（口径 R-S0-07-01）：当前一次指标响应的体积与实例数 */
  probePayload: () => {
    datasetId: string;
    barCount: number;
    instanceCount: number;
    payloadBytes: number;
  };
  /** 渲染层逐根比对用：当前引擎结果 + 可见窗口参数 */
  snapshot: () => {
    calc: CalcResponse | null;
    barsLength: number;
    windowSize: number;
    /** S-02.07-01 视口起点（绝对下标），默认 120 根时为 barsLength-windowSize */
    viewStart: number;
    /** 逐根收盘价（T16 方向判定等渲染断言与图表口径对齐） */
    barsClose: number[];
  };
}

export const DEBOUNCE_INPUT_GAP_MS = 40;
export const DEBOUNCE_QUIET_MS = 120;

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** 逐点签名：占位 null 也参与哈希，只有数值完全一致才可能得到相同签名。 */
export function seriesSignature(calc: CalcResponse): {
  hash: string;
  points: number;
} {
  const parts: string[] = [];
  let points = 0;
  for (const series of calc.series) {
    parts.push(`${series.instanceId}|${series.indicatorId}|w${series.warmup}`);
    for (const output of series.outputs) {
      parts.push(output.key);
      for (const value of output.values) {
        if (value === null) {
          parts.push("n");
          continue;
        }
        points += 1;
        parts.push(value.toString());
      }
    }
  }
  return { hash: fnv1a(parts.join(",")), points };
}

/** 就近秩 P95（与 Rust `cold_p95_ms` 同口径）。 */
export function nearestRankPercentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(ratio * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

export function nearestRankP95(values: number[]): number | null {
  return nearestRankPercentile(values, 0.95);
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** 把 CSS 自定义属性解析成浏览器最终颜色（rgb/rgba 字符串），用于配色断言。 */
function resolveColor(variable: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${variable})`;
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

/** 渲染层证据：直接读真实 DOM（Tauri WebView 内），不依赖截图权限。 */
async function collectRenderChecks(hooks: DiagHooks): Promise<Record<string, unknown>> {
  const attrs = (selector: string, name: string) =>
    Array.from(document.querySelectorAll(selector)).map(
      (element) => element.getAttribute(name) ?? "",
    );

  const overlays = attrs("[data-overlay]", "data-overlay");
  const macd = attrs("[data-macd]", "data-macd");
  const statistical = attrs(
    "[data-readout='T21-r2'], [data-readout^='E13-']",
    "data-readout",
  );
  const readoutHost = document.querySelectorAll("[data-readout-host='1']").length;

  let tooltipBefore = attrs("[data-readout^='ma-'], [data-readout^='ov-']", "data-readout").length;
  let maEntries: Array<{ id: string; value: string; unit: string; text: string }> = [];
  let hoverIndex = "";
  let hoverError: string | null = null;
  let colorSamples: Record<string, string> = {};
  let chgFirst = { sign: "", text: "", color: "" };
  let chgSecond = { sign: "", text: "", color: "" };
  let chgPos = { sign: "", text: "", color: "" };
  const svg = document.querySelector<SVGSVGElement>("[data-chart='candle']");
  if (svg) {
    try {
      const rect = svg.getBoundingClientRect();
      svg.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          clientX: rect.left + rect.width * 0.6,
          clientY: rect.top + rect.height * 0.3,
        }),
      );
      await sleep(160);
      tooltipBefore = attrs("[data-readout^='ma-'], [data-readout^='ov-']", "data-readout").length;
      hoverIndex =
        document
          .querySelector("[data-readout-host='1']")
          ?.getAttribute("data-hover-index") ?? "";
      maEntries = Array.from(
        document.querySelectorAll("[data-readout^='ma-'], [data-readout^='ov-']"),
      ).map(
        (element) => ({
          id: element.getAttribute("data-readout") ?? "",
          value: element.getAttribute("data-value") ?? "",
          unit: element.getAttribute("data-unit") ?? "",
          text: element.textContent?.trim() ?? "",
        }),
      );
      // 配色三重编码：颜色（--pos/--neg）+ 箭头（▲/▼）+ 正负号
      const chgOf = () => {
        const element = document.querySelector<HTMLElement>("[data-readout='chg']");
        return {
          sign: element?.getAttribute("data-sign") ?? "",
          text: element?.textContent?.trim() ?? "",
          color: element ? getComputedStyle(element).color : "",
        };
      };
      chgFirst = chgOf();
      // 再悬停上涨 K 线取正号样本，悬停下跌 K 线取负号样本，证明 ▲▼ 双向都编码
      const upBars = Array.from(
        document.querySelectorAll<SVGElement>("[data-candle='up'][data-index]"),
      ).slice(0, 16);
      for (const bar of upBars) {
        const barRect = bar.getBoundingClientRect();
        svg.dispatchEvent(
          new MouseEvent("mousemove", {
            bubbles: true,
            clientX: barRect.left + barRect.width / 2,
            clientY: barRect.top + barRect.height / 2,
          }),
        );
        await sleep(90);
        const sample = chgOf();
        if (/^▲\s*\+/.test(sample.text)) {
          chgPos = sample;
          break;
        }
      }
      // 收平/开高收低的 K 线可能出现「▼ —」，多试几根直到拿到带负号的读数
      const downBars = Array.from(
        document.querySelectorAll<SVGElement>("[data-candle='down'][data-index]"),
      ).slice(0, 16);
      for (const bar of downBars) {
        const barRect = bar.getBoundingClientRect();
        svg.dispatchEvent(
          new MouseEvent("mousemove", {
            bubbles: true,
            clientX: barRect.left + barRect.width / 2,
            clientY: barRect.top + barRect.height / 2,
          }),
        );
        await sleep(90);
        chgSecond = chgOf();
        if (/^▼\s*-/.test(chgSecond.text)) break;
      }
      const upCandle = document.querySelector<SVGElement>("[data-candle='up']");
      const downCandle = document.querySelector<SVGElement>("[data-candle='down']");
      const histPos = document.querySelector<SVGElement>("[data-hist='pos']");
      const histNeg = document.querySelector<SVGElement>("[data-hist='neg']");
      colorSamples = {
        posToken: resolveColor("--pos"),
        negToken: resolveColor("--neg"),
        upCandleStroke: upCandle ? getComputedStyle(upCandle).stroke : "",
        downCandleStroke: downCandle ? getComputedStyle(downCandle).stroke : "",
        histPosFill: histPos ? getComputedStyle(histPos).fill : "",
        histNegFill: histNeg ? getComputedStyle(histNeg).fill : "",
        chgFirst: `${chgFirst.sign}|${chgFirst.color}|${chgFirst.text}`,
        chgSecond: `${chgSecond.sign}|${chgSecond.color}|${chgSecond.text}`,
        chgPos: `${chgPos.sign}|${chgPos.color}|${chgPos.text}`,
      };
      svg.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
      await sleep(80);
    } catch (err) {
      hoverError = String(err);
    }
  }

  // 逐根等值：tooltip/读数条显示值 vs 引擎 series（AC-03.04-05，容差 0）
  let tooltipParity: Record<string, unknown> = { sampled: 0, mismatches: [], ok: false };
  const snapshot = hooks.snapshot();
  if (svg && snapshot.calc) {
    const count = Math.min(snapshot.windowSize, snapshot.barsLength);
    const offset = snapshot.viewStart ?? snapshot.barsLength - count;
    const candles = Array.from(
      document.querySelectorAll<SVGElement>("[data-candle][data-index]"),
    );
    const sma =
      snapshot.calc.series.find((item) => item.indicatorId === "T01")?.outputs[0]?.values ?? [];
    const dif =
      snapshot.calc.series
        .find((item) => item.indicatorId === "M06")
        ?.outputs.find((output) => output.key === "dif")?.values ?? [];
    // 全窗口逐根：每根可见 K 线都悬停一次，读 tooltip 显示值并与引擎序列逐点等值
    const picks = Array.from({ length: count }, (_, index) => index);
    // 屏幕像素 → 图表 band 的换算：相邻两根 K 线中心的距离即 1 根 band 的像素宽度。
    // 直接用 K 线中心会因 screen→viewBox 的取整在 band 边界差 1 根（实测 5/120），
    // 这里读 `data-hover-index` 校正：若图表认为悬停的不是目标根，按差值平移后重发。
    const centerOf = (visible: number) => {
      const candle =
        candles.find((element) => Number(element.getAttribute("data-index")) === visible) ??
        candles[visible];
      if (!candle) return null;
      const box = candle.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    };
    const first = centerOf(0);
    const second = centerOf(1);
    const bandPx = first && second && Math.abs(second.x - first.x) > 0 ? Math.abs(second.x - first.x) : 1;
    const hoverIndexNow = () =>
      Number(document.querySelector("[data-readout]")?.getAttribute("data-hover-index") ?? "-1");
    const rows: Array<Record<string, unknown>> = [];
    for (const visible of picks) {
      const center = centerOf(visible);
      if (!center) continue;
      const absolute = offset + visible;
      // 最多校正两次，第二次仍不中就按实际 hoverIndex 记录失败（不伪造）
      let shownAt = -1;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const currentHover = hoverIndexNow();
        const shift = attempt === 0 || currentHover < 0 ? 0 : visible - currentHover;
        svg.dispatchEvent(
          new MouseEvent("mousemove", {
            bubbles: true,
            clientX: center.x + shift * bandPx,
            clientY: center.y,
          }),
        );
        await sleep(attempt === 0 ? 50 : 25);
        shownAt = hoverIndexNow();
        if (shownAt === visible) break;
      }
      const shownSma =
        document.querySelector("[data-readout='ma-T01']")?.getAttribute("data-value") ?? "";
      const shownDif =
        document.querySelector("[data-readout='sub-M06-dif']")?.getAttribute("data-value") ?? "";
      const engineSma = sma[absolute] ?? null;
      const engineDif = dif[absolute] ?? null;
      const smaOk = engineSma === null ? shownSma === "" : Number(shownSma) === engineSma;
      const difOk = engineDif === null ? shownDif === "" : Number(shownDif) === engineDif;
      rows.push({
        bar: absolute,
        hoverIndex: shownAt,
        engineSma,
        shownSma,
        engineDif,
        shownDif,
        ok: smaOk && difOk,
      });
    }
    tooltipParity = {
      tolerance: 0,
      enginePoints: sma.length,
      sampled: rows.length,
      samples: rows,
      mismatches: rows.filter((row) => row.ok !== true).map((row) => row.bar),
      ok: rows.length === count && rows.every((row) => row.ok === true),
    };
    svg.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    await sleep(60);
  }

  const unitLabels = Array.from(
    document.querySelectorAll("[data-readout='T21-r2'] [data-unit], [data-readout^='E13-'] [data-unit]"),
  ).map((element) => element.getAttribute("data-unit") ?? "");
  const decimalsOk = maEntries.every((entry) => /\d[.,]\d{2}/.test(entry.text));
  const t21Text = document.querySelector("[data-readout='T21-r2']")?.textContent?.trim() ?? "";
  const t21TwoDecimals = /R² [-+]?\d+\.\d{2}(?!\d)/.test(t21Text);
  const overlayCount = overlays.length;
  const macdCount = macd.length;
  const histCount = document.querySelectorAll("[data-hist]").length;
  const posColor = colorSamples.posToken;
  const negColor = colorSamples.negToken;
  const chgEncoded = (sample: { sign: string; text: string; color: string }, direction: "pos" | "neg") =>
    sample.sign === direction &&
    sample.color === (direction === "pos" ? posColor : negColor) &&
    (direction === "pos" ? /^▲\s*\+/.test(sample.text) : /^▼\s*-/.test(sample.text));
  const colorOk =
    posColor !== "" &&
    negColor !== "" &&
    colorSamples.upCandleStroke === posColor &&
    colorSamples.downCandleStroke === negColor &&
    colorSamples.histPosFill === posColor &&
    colorSamples.histNegFill === negColor &&
    (chgEncoded(chgFirst, "pos") || chgEncoded(chgSecond, "pos") || chgEncoded(chgPos, "pos")) &&
    (chgEncoded(chgFirst, "neg") || chgEncoded(chgSecond, "neg") || chgEncoded(chgPos, "neg"));
  const statisticalCount = statistical.length;
  return {
    chartPresent: Boolean(svg),
    overlays,
    overlayCount,
    macd,
    macdCount,
    macdHistCount: histCount,
    colorSamples,
    colorOk,
    statisticalReadouts: statistical,
    statisticalReadoutCount: statisticalCount,
    statisticalUnits: unitLabels,
    t21Text,
    t21TwoDecimals,
    readoutHost,
    hoverIndex,
    maTooltipCount: tooltipBefore,
    maTooltip: maEntries,
    decimalsOk,
    tooltipParity,
    hoverError,
    ok:
      Boolean(svg) &&
      // S-02.02-02 起主图叠加容量 2（默认 SMA20 + BOLL，共 4 条输出线），不再是固定 8 线
      overlayCount >= 4 &&
      macdCount === 3 &&
      histCount >= 2 &&
      colorOk &&
      statisticalCount >= 4 &&
      unitLabels.length >= 4 &&
      t21TwoDecimals &&
      tooltipBefore >= 4 &&
      hoverIndex !== "" &&
      decimalsOk &&
      tooltipParity.ok === true &&
      maEntries.every((entry) => entry.value !== "" && entry.unit !== ""),
  };
}

/** B2 渲染层 8 条 AC：按 Story 卡 S-03.05-01~08 的条款逐条断言（非通用四检查）。 */
async function collectB2RenderChecks(hooks: DiagHooks): Promise<Record<string, unknown>> {
  type Clause = { clause: string; status: "pass" | "fail" | "n/a"; detail?: unknown };
  const pass = (clause: string, ok: boolean, detail?: unknown): Clause => ({
    clause,
    status: ok ? "pass" : "fail",
    detail,
  });
  const skip = (clause: string, detail?: unknown): Clause => ({ clause, status: "n/a", detail });
  // 任一 clause 明确失败 → 该卡不成立；`n/a` 仅用于「当前数据集无可观察样本」，
  // 必须带 detail 说明原因，并在卡片的 `dataLimited` 里单列，不能当成通过。
  const verdict = (clauses: Clause[]) => clauses.every((item) => item.status !== "fail");
  const dataLimited = (clauses: Clause[]) =>
    clauses.filter((item) => item.status === "n/a").length;

  const posColor = resolveColor("--pos");
  const negColor = resolveColor("--neg");
  const riseColor = resolveColor("--rise");
  const fallColor = resolveColor("--fall");

  const snapshotOf = () => hooks.snapshot();
  const windowStart = () => {
    const snap = snapshotOf();
    return snap.viewStart ?? Math.max(0, snap.barsLength - snap.windowSize);
  };
  const valuesOf = (id: string, key: string): Array<number | null> | null => {
    const series = snapshotOf().calc?.series.find((item) => item.indicatorId === id);
    return series?.outputs.find((output) => output.key === key)?.values ?? null;
  };
  const finite = (value: number | null | undefined): value is number =>
    value !== null && value !== undefined && Number.isFinite(value);
  const finiteRuns = (values: Array<number | null>, from: number) => {
    let runs = 0;
    let inRun = false;
    for (let index = from; index < values.length; index += 1) {
      const ok = finite(values[index]);
      if (ok && !inRun) runs += 1;
      inRun = ok;
    }
    return runs;
  };
  const segments = (d: string | null | undefined) => (d?.match(/M/g) ?? []).length;
  const lastFiniteIndex = (values: Array<number | null>) => {
    for (let index = values.length - 1; index >= 0; index -= 1) {
      if (finite(values[index])) return index;
    }
    return -1;
  };
  const overlayPath = (id: string, key: string) =>
    document.querySelector<SVGPathElement>(`[data-overlay='${id}'][data-overlay-key='${key}']`);
  const overlayPaths = (id: string) =>
    Array.from(document.querySelectorAll<SVGPathElement>(`[data-overlay='${id}'][data-overlay-key]`));
  const legendLines = (id: string) =>
    Array.from(document.querySelectorAll<SVGTextElement>(`[data-legend-line^='${id}.']`));
  const subPaths = (id: string) =>
    Array.from(document.querySelectorAll<SVGPathElement>(`[data-sub='${id}']`));

  // 切走再切回：用于「切标的后旧线/旧值不残留」
  /** 切到另一标的再切回；probe 在「切走后」被调用，用于抓取 B 标的的渲染结果。 */
  const switchAwayAndBack = async (probe?: () => unknown) => {
    const original = hooks.getActiveCode();
    const target = hooks.codes.find((code) => code !== original);
    if (!target) return { ok: false, away: undefined };
    hooks.setPhase("warm");
    const away = hooks.nextSample(4000);
    hooks.setCode(target);
    if (!(await away)) {
      hooks.setPhase("done");
      return { ok: false, away: undefined };
    }
    // 采样回调先于图表重绘触发，等两帧再抓 B 的路径，否则拿到的是 A 的残留值。
    await sleep(120);
    const awayProbe = probe?.();
    const back = hooks.nextSample(4000);
    hooks.setCode(original);
    if (!(await back)) {
      hooks.setPhase("done");
      return { ok: false, away: awayProbe };
    }
    await sleep(900);
    hooks.setPhase("done");
    return { ok: true, away: awayProbe };
  };
  const switchTimeframeAndBack = async () => {
    const before = snapshotOf();
    hooks.setPhase("warm");
    const weekly = hooks.nextSample(4000);
    hooks.setTimeframe("W");
    const weeklySample = await weekly;
    const afterWeekly = snapshotOf();
    const daily = hooks.nextSample(4000);
    hooks.setTimeframe("D");
    const dailySample = await daily;
    await sleep(260);
    hooks.setPhase("done");
    return { before, afterWeekly, weeklySample, dailySample, afterDaily: snapshotOf() };
  };

  const setOverlays = async (ids: string[]) => {
    const select = document.querySelector<HTMLSelectElement>("[data-b2-overlay-select]");
    if (!select) return false;
    for (const option of Array.from(select.options)) {
      option.selected = ids.includes(option.value);
    }
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(260);
    return true;
  };
  const setSub = async (id: string) => {
    const select = document.querySelector<HTMLSelectElement>("[data-b2-sub-select]");
    if (!select) return false;
    select.value = id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(260);
    return true;
  };

  const readoutsOf = (prefix: string) =>
    Array.from(document.querySelectorAll<HTMLElement>(`[data-readout^='${prefix}']`)).map(
      (element) => ({
        readout: element.getAttribute("data-readout") ?? "",
        value: element.getAttribute("data-value") ?? "",
        unit: element.getAttribute("data-unit") ?? "",
        text: element.textContent?.trim() ?? "",
      }),
    );
  // 当前根读数：有效值必须是有限数；故意 NaN 的尾部（位移/未激活）必须显示 —
  const readoutShapeOk = (entries: Array<{ value: string; text: string }>) =>
    entries.length > 0 &&
    entries.some((entry) => entry.value !== "") &&
    entries.every((entry) =>
      entry.value !== ""
        ? Number.isFinite(Number(entry.value))
        : entry.text.includes("—"),
    );

  const cards: Array<Record<string, unknown>> = [];
  const primaryValues = (id: string): Array<number | null> | null => {
    const series = snapshotOf().calc?.series.find((item) => item.indicatorId === id);
    return series?.outputs[0]?.values ?? null;
  };
  const flipsInWindow = (
    long: Array<number | null>,
    short: Array<number | null>,
    from: number,
  ) => {
    let count = 0;
    for (let index = Math.max(1, from); index < long.length; index += 1) {
      if (finite(long[index]) && finite(short[index - 1])) count += 1;
      else if (finite(short[index]) && finite(long[index - 1])) count += 1;
    }
    return count;
  };
  const signRuns = (values: Array<number | null>, from: number, positive: boolean) => {
    let runs = 0;
    let inRun = false;
    for (let index = from; index < values.length; index += 1) {
      const value = values[index];
      const ok = finite(value) && (positive ? value > 0 : value < 0);
      if (ok && !inRun) runs += 1;
      inRun = ok;
    }
    return runs;
  };
  const numericMatches = (raw: string, expected: number) => {
    if (raw === "" || !Number.isFinite(Number(raw))) return false;
    return Math.abs(Number(raw) - expected) <= 1e-9 * Math.max(1, Math.abs(expected));
  };

  // S-03.05-01 / AC-03.05-05：三轨可见、中轨虚线、NaN 断开、图例语义色、切标的后不残留
  {
    const selected = await setOverlays(["T08", "T09", "T11", "T24"]);
    const keys = ["upper", "middle", "lower"];
    const paths = keys.map((key) => overlayPath("T09", key));
    const blocks = paths.map((path) => segments(path?.getAttribute("d")));
    const clauses: Clause[] = [
      pass("T09 三轨可见", selected && blocks.every((count) => count > 0), {
        nodes: overlayPaths("T09").length,
        blocks,
      }),
    ];
    const dashOf = (path: SVGPathElement | null | undefined) =>
      path ? getComputedStyle(path).strokeDasharray : "";
    const middleDash = dashOf(paths[1]).replace(/\s+/g, " ");
    const othersSolid = [dashOf(paths[0]), dashOf(paths[2])].every(
      (value) => value === "" || value === "none",
    );
    clauses.push(
      pass(
        "T09 中轨虚线、上下轨实线（虚实可区分）",
        // 精确值比对：源代码写死 `4 3`，浏览器计算值为 `4px, 3px`；改成任意其它值必须失败
        middleDash === "4px, 3px" && othersSolid,
        { middleDash, expected: "4px, 3px", upper: dashOf(paths[0]), lower: dashOf(paths[2]) },
      ),
    );
    const start = windowStart();
    for (const key of keys) {
      const values = valuesOf("T09", key);
      const path = overlayPath("T09", key);
      const measured = segments(path?.getAttribute("d"));
      clauses.push(
        values
          ? pass(`T09 ${key} 数据不足处断开`, measured === finiteRuns(values, start), {
              segments: measured,
              runs: finiteRuns(values, start),
            })
          : skip(`T09 ${key} 数据不足处断开`, "引擎无该输出"),
      );
    }
    const legend = legendLines("T09");
    const legendByKey = new Map(
      legend.map((element) => [
        (element.getAttribute("data-legend-line") ?? "").slice("T09.".length),
        getComputedStyle(element).fill,
      ]),
    );
    const strokeByKey = new Map(
      keys.map((key) => [key, paths[keys.indexOf(key)] ? getComputedStyle(paths[keys.indexOf(key)] as SVGPathElement).stroke : ""]),
    );
    clauses.push(
      pass(
        "T09 图例三线齐全且颜色=线色",
        legend.length === 3 && keys.every((key) => legendByKey.get(key) === strokeByKey.get(key)),
        { legendKeys: [...legendByKey.keys()], legendByKey: [...legendByKey], strokeByKey: [...strokeByKey] },
      ),
    );
    const readouts = readoutsOf("b2-overlay-T09-");
    clauses.push(
      pass("T09 读数条 3 条", readoutShapeOk(readouts) && readouts.length === 3, {
        count: readouts.length,
      }),
    );
    // 残留检测必须能证伪：记录 A 的三条路径，切到 B 抓取 B 的路径，切回 A 后要求逐条与 A 完全一致，
    // 且 B 的路径确实与 A 不同（否则场景本身无效）。
    const dOfKeys = () => keys.map((key) => overlayPath("T09", key)?.getAttribute("d") ?? "");
    // 等图表在新叠加层下重绘稳定后再取基准，否则拿到的是中间帧，切回时必然比对失败。
    const candleProfile = () =>
      Array.from(document.querySelectorAll<SVGRectElement>("[data-candle]"))
        .map((rect) => `${rect.getAttribute("x")},${rect.getAttribute("y")},${rect.getAttribute("height")}`)
        .join("|");
    const axisTexts = () =>
      Array.from(document.querySelectorAll<SVGTextElement>('[data-chart="candle"] text'))
        .map((node) => (node.textContent ?? "").trim())
        .filter((text) => text !== "");
    await sleep(900);
    const beforeA = dOfKeys();
    const candlesBeforeA = candleProfile();
    const axisBeforeA = axisTexts();
    const switched = await switchAwayAndBack(() => dOfKeys());
    const afterPaths = overlayPaths("T09").length;
    const afterA = dOfKeys();
    const awayB = (switched.away as string[] | undefined) ?? [];
    const awayDiffers = awayB.length === 3 && awayB.every((d, index) => d !== "" && d !== beforeA[index]);
    // 同一条线在换标的再切回后，y 轴自适应范围可能不同（坐标数字随之变化），
    // 所以「是否同一条线」按归一化形状比对：x 按首尾归一、y 按自身极值归一。
    // 旧线若残留，形状必然不同；负控注入旧值也会被判红。
    const shapeOf = (d: string) => {
      const nums = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      const points: Array<[number, number]> = [];
      for (let index = 0; index + 1 < nums.length; index += 2) {
        points.push([nums[index], nums[index + 1]]);
      }
      return points;
    };
    // 换标的再切回后，绘图区宽度/y 轴域可能重新测量（x、y 直角坐标整体变化），
    // 因此只比对「数据形状」：把 y 序列按自身极值归一，逐点等值。
    // 旧线若残留，y 序列来自另一只标的，形状必然不同。
    const yProfile = (d: string) => {
      const points = shapeOf(d);
      if (points.length < 2) return "";
      const ys = points.map((point) => point[1]);
      const y0 = Math.min(...ys);
      const span = Math.max(...ys) - y0 || 1;
      return ys.map((y) => ((y - y0) / span).toFixed(4)).join(",");
    };
    const backMatches = afterA.length === 3 && afterA.every((d, index) => yProfile(d) === yProfile(beforeA[index]));
    // 回切后可能仍在重绘（宽/域重测量），再等一拍看是否稳定，并量化「离 A 近还是离 B 近」。
    await sleep(500);
    const afterA2 = dOfKeys();
    const profileDelta = (a: string, b: string) => {
      const av = a === "" ? [] : a.split(",").map(Number);
      const bv = b === "" ? [] : b.split(",").map(Number);
      if (av.length === 0 || av.length !== bv.length) return { max: 1, mean: 1 };
      let max = 0;
      let sum = 0;
      for (let index = 0; index < av.length; index += 1) {
        const diff = Math.abs(av[index] - bv[index]);
        max = Math.max(max, diff);
        sum += diff;
      }
      return { max, mean: sum / av.length };
    };
    const shapeDelta = (from: string[], to: string[]) => {
      const parts = from.map((d, index) => profileDelta(yProfile(d), yProfile(to[index] ?? "")));
      return {
        max: Number(Math.max(...parts.map((part) => part.max)).toFixed(4)),
        mean: Number((parts.reduce((sum, part) => sum + part.mean, 0) / parts.length).toFixed(4)),
      };
    };
    const toA = shapeDelta(afterA, beforeA);
    const toB = shapeDelta(afterA, awayB);
    const stableAfter = afterA.length === 3 && afterA.every((d, index) => yProfile(d) === yProfile(afterA2[index] ?? ""));
    // 诊断：K 线几何是否也变了（变了说明可见窗口/数据源变了，而不是叠加线残留）
    const candlesAfterA = candleProfile();
    const candlesSame = candlesBeforeA === candlesAfterA;
    const axisAfterA = axisTexts();
    const axisSame = axisBeforeA.join("|") === axisAfterA.join("|");
    // 判据：回切后 3 条线仍在、确实换过标的、形状稳定、且离 A 的差 ≤0.05 而离 B 的差至少是它的 3 倍。
    // 旧线若残留（或图表没重绘），形状会等于 B（toB≈0）而 toA 变大，本条必然判红（见负控）。
    const looksLikeA = stableAfter && toA.max <= 0.05 && toB.max > toA.max * 3;
    const noResidue = switched.ok && afterPaths === 3 && awayDiffers && (backMatches || looksLikeA);
    clauses.push(
      pass(
        "切标的后不残留旧线",
        noResidue,
        { switched: switched.ok, afterPaths, awayDiffers, backMatches, stableAfter, candlesSame, candleCount: candlesAfterA.split("|").length, axisSame, axisBeforeA: axisBeforeA.slice(0, 12), axisAfterA: axisAfterA.slice(0, 12), toA, toB, beforeA: beforeA.map((d) => d.length), awayB: awayB.map((d) => d.length), afterA: afterA.map((d) => d.length), pointsA: beforeA.map((d) => shapeOf(d).length), pointsBack: afterA.map((d) => shapeOf(d).length), backSameAsAway: afterA.map((d, index) => yProfile(d) === yProfile(awayB[index] ?? "")) },
      ),
    );
    // 负控：每轮取证都执行，证明上面两条断言可被证伪（不是恒真）。
    {
      const middle = paths[1];
      let dashInjected = "";
      let dashRejected = false;
      if (middle) {
        const original = middle.style.strokeDasharray;
        middle.style.strokeDasharray = "6 4";
        dashInjected = dashOf(middle).replace(/\s+/g, " ");
        dashRejected = dashInjected !== "4px, 3px";
        middle.style.strokeDasharray = original;
      }
      const residualFree = (newer: string[], older: string[]) =>
        newer.length === 3 && newer.every((d, index) => d !== older[index]);
      const injectedOld = [
        beforeA[0] ?? "",
        awayB[1] ?? beforeA[1] ?? "",
        awayB[2] ?? beforeA[2] ?? "",
      ];
      const residualRejected = !residualFree(injectedOld, beforeA) && residualFree(awayB, beforeA);
      clauses.push(
        pass("T09 负控：错误虚实值必须被判红", dashRejected, {
          injected: dashInjected,
          expected: "4px, 3px",
        }),
      );
      clauses.push(
        pass("T09 负控：旧线值必须被判残留", residualRejected, {
          awayEqualsA: awayB.map((d, index) => d === beforeA[index]),
        }),
      );
      // 负控：把「回切后仍是 B 的线」当作 afterA 喂给同一判据，必须判红（防止形状阈值宽到恒真）。
      const stale = awayB.length === 3 ? awayB : [];
      const staleToA = shapeDelta(stale, beforeA);
      const staleToB = shapeDelta(stale, awayB);
      const staleRejected = stale.length === 3 && !(staleToB.max > staleToA.max * 3 && staleToA.max <= 0.05);
      clauses.push(
        pass("T09 负控：回切未重绘（仍显示 B 线）必须被判红", staleRejected, {
          staleToA,
          staleToB,
        }),
      );
    }
    cards.push({
      card: "S-03.05-01",
      ac: "AC-03.05-05",
      kind: "overlay",
      selected,
      clauses,
      ok: verdict(clauses),
    });
  }

  // S-03.05-02 / AC-03.05-10：ATR 元、ATRP 比值、NaN 断开、切标的后旧值不残留
  {
    const clauses: Clause[] = [];
    const units: Record<string, string> = {};
    const start = windowStart();
    for (const id of ["V01", "V02", "V09", "V10"]) {
      const selected = await setSub(id);
      const readouts = readoutsOf(`b2-sub-${id}-`);
      units[id] = readouts[0]?.unit ?? "";
      clauses.push(
        pass(`${id} 读数与单位`, selected && readoutShapeOk(readouts) && readouts.length === 1 && units[id] !== "", {
          count: readouts.length,
          unit: units[id],
        }),
      );
      const values = primaryValues(id);
      const path = subPaths(id)[0];
      const measured = segments(path?.getAttribute("d"));
      clauses.push(
        values
          ? pass(`${id} 数据不足处断开`, measured === finiteRuns(values, start), {
              segments: measured,
              runs: finiteRuns(values, start),
            })
          : skip(`${id} 数据不足处断开`, "引擎无该输出"),
      );
    }
    clauses.push(pass("ATR 以元显示", units.V01 === "元", { unit: units.V01 }));
    clauses.push(pass("ATRP 以比值显示", units.V02 === "无量纲", { unit: units.V02 }));
    await setSub("V01");
    const switched = await switchAwayAndBack();
    const readout = readoutsOf("b2-sub-V01-")[0];
    const values = primaryValues("V01");
    const last = values ? lastFiniteIndex(values) : -1;
    const expectLast = last >= 0 && values && finite(values[last]) ? (values[last] as number) : Number.NaN;
    clauses.push(
      pass(
        "切标的后读数与当前引擎一致（旧值不残留）",
        switched.ok && readout !== undefined && numericMatches(readout.value, expectLast),
        { readout: readout?.value ?? "", expectLast },
      ),
    );
    cards.push({ card: "S-03.05-02", ac: "AC-03.05-10", kind: "sub", clauses, ok: verdict(clauses), dataLimited: dataLimited(clauses) });
  }

  // S-03.05-03 / AC-03.05-16：仅显示激活侧、翻转根标记、翻转后不跳变、NaN 断开
  {
    const selected = await setOverlays(["T10", "T12", "T13", "T14"]);
    const long = valuesOf("T13", "long");
    const short = valuesOf("T13", "short");
    const start = windowStart();
    const lastBar = snapshotOf().barsLength - 1;
    const clauses: Clause[] = [
      pass("T13 两轨可见", selected && overlayPaths("T13").length === 2, {
        nodes: overlayPaths("T13").length,
      }),
    ];
    clauses.push(
      pass(
        "T13 仅显示激活侧",
        long !== null && short !== null && finite(long[lastBar]) !== finite(short[lastBar]),
        { long: long?.[lastBar] ?? null, short: short?.[lastBar] ?? null },
      ),
    );
    const markers = document.querySelectorAll("[data-flip='T13']").length;
    const flips = long && short ? flipsInWindow(long, short, start) : 0;
    clauses.push(pass("T13 翻转根有标记", markers > 0 && markers === flips, { markers, flips }));
    // 裁定 R-01：翻转当根两侧同时有值（旧侧冻结），次根起旧侧转 NaN；
    // 新侧止损必须由新方向重算，不得与被冻结的旧侧值相等（否则就是继承旧值跳变）。
    let flipBars = 0;
    let carryOver = 0;
    let staleSide = 0;
    if (long && short) {
      const isFlip = (index: number) =>
        index >= 1 &&
        ((finite(long[index]) && finite(short[index - 1]) && !finite(long[index - 1])) ||
          (finite(short[index]) && finite(long[index - 1]) && !finite(short[index - 1])));
      for (let index = Math.max(1, start); index < long.length; index += 1) {
        if (!isFlip(index)) continue;
        flipBars += 1;
        const toLong = finite(long[index]) && finite(short[index - 1]);
        const newValue = (toLong ? long[index] : short[index]) as number;
        const frozen = (toLong ? short[index] : long[index]) as number | null;
        if (frozen !== null && finite(frozen)) {
          if (Math.abs(newValue - frozen) <= 1e-9 * Math.max(1, Math.abs(frozen))) carryOver += 1;
        } else {
          // 翻转当根必须冻结旧侧值，缺失说明状态机没有保留旧值
          carryOver += 1;
        }
        const next = index + 1;
        if (next < long.length && !isFlip(next)) {
          if (toLong && finite(short[next])) staleSide += 1;
          if (!toLong && finite(long[next])) staleSide += 1;
        }
      }
    }
    clauses.push(
      pass(
        "T13 翻转后新侧不继承旧侧值",
        long !== null && short !== null && flipBars > 0 && carryOver === 0 && staleSide === 0,
        { flipBars, carryOver, staleSide },
      ),
    );
    for (const [key, values] of [["long", long], ["short", short]] as const) {
      const path = overlayPath("T13", key);
      const measured = segments(path?.getAttribute("d"));
      clauses.push(
        values
          ? pass(`T13 ${key} NaN 段断开`, measured === finiteRuns(values, start), {
              segments: measured,
              runs: finiteRuns(values, start),
            })
          : skip(`T13 ${key} NaN 段断开`, "引擎无该输出"),
      );
    }
    clauses.push(
      pass("T13 读数条 2 条", readoutsOf("b2-overlay-T13-").length === 2, {
        count: readoutsOf("b2-overlay-T13-").length,
      }),
    );
    cards.push({ card: "S-03.05-03", ac: "AC-03.05-16", kind: "overlay", selected, clauses, ok: verdict(clauses), dataLimited: dataLimited(clauses) });
  }

  // S-03.05-04 / AC-03.05-20：云带多空着色、先行带截断、迟行留白、五线图例、NaN 断开
  {
    const selected = await setOverlays(["T15"]);
    const clouds = Array.from(document.querySelectorAll<SVGPathElement>("[data-cloud='T15']"));
    const signs = new Set(clouds.map((path) => path.getAttribute("data-cloud-sign")));
    const fills = clouds.map((path) => getComputedStyle(path).fill);
    const snapshot = snapshotOf();
    const senkouA = valuesOf("T15", "senkouA");
    const senkouB = valuesOf("T15", "senkouB");
    const chikou = valuesOf("T15", "chikou");
    const clauses: Clause[] = [
      pass(
        "T15 云带按多空着色",
        selected &&
          clouds.length > 0 &&
          signs.has("pos") &&
          signs.has("neg") &&
          fills.every((fill) => fill === riseColor || fill === fallColor),
        { count: clouds.length, signs: Array.from(signs), fills },
      ),
      pass(
        "T15 先行带在最后一根截断（不越过未来区）",
        senkouA !== null &&
          senkouB !== null &&
          lastFiniteIndex(senkouA) === snapshot.barsLength - 1 &&
          lastFiniteIndex(senkouB) === snapshot.barsLength - 1 &&
          clouds.length > 0,
        { lastA: senkouA ? lastFiniteIndex(senkouA) : -1, lastB: senkouB ? lastFiniteIndex(senkouB) : -1, bars: snapshot.barsLength },
      ),
      // AC-03.05-18/20 文字写「前 26 根留白」，但参考实现 `gen_reference.py:344`
      // （`out["chikou"][j] = closes[j + displacement]`）把位移落在尾端：首 26 根有值、末 26 根 NaN。
      // 这里按参考实现断言「26 根留白在尾端」，并在 detail 里保留头/尾计数，供 BA 更正 AC 文字。
      pass(
        "T15 迟行线 26 根留白（位移在尾端）",
        chikou !== null &&
          chikou.slice(-26).every((value) => !finite(value)) &&
          chikou.slice(0, 26).every((value) => finite(value)),
        {
          tailNaN: chikou ? chikou.slice(-26).filter((value) => !finite(value)).length : -1,
          headFinite: chikou ? chikou.slice(0, 26).filter((value) => finite(value)).length : -1,
        },
      ),
    ];
    const legend = legendLines("T15");
    clauses.push(pass("T15 图例五线齐全", legend.length === 5, { legendCount: legend.length }));
    const start = windowStart();
    for (const key of ["tenkan", "kijun", "senkouA", "senkouB", "chikou"]) {
      const values = valuesOf("T15", key);
      const path = overlayPath("T15", key);
      const measured = segments(path?.getAttribute("d"));
      clauses.push(
        values
          ? pass(`T15 ${key} NaN 段断开`, measured === finiteRuns(values, start), {
              segments: measured,
              runs: finiteRuns(values, start),
            })
          : skip(`T15 ${key} NaN 段断开`, "引擎无该输出"),
      );
    }
    const readouts = readoutsOf("b2-overlay-T15-");
    clauses.push(pass("T15 读数条 5 条", readoutShapeOk(readouts) && readouts.length === 5, { count: readouts.length }));
    cards.push({ card: "S-03.05-04", ac: "AC-03.05-20", kind: "overlay", selected, clauses, ok: verdict(clauses), dataLimited: dataLimited(clauses) });
  }

  // S-03.05-05 / AC-03.05-24：点列、不连线、反转箭头、多空颜色
  {
    const selected = await setOverlays(["T16"]);
    const circles = Array.from(document.querySelectorAll<SVGCircleElement>("[data-overlay='T16'] circle"));
    const fills = circles.map((circle) => getComputedStyle(circle).fill);
    const psar = primaryValues("T16");
    const closes = snapshotOf().barsClose;
    const start = windowStart();
    let expectedFlips = 0;
    let expectedUp = 0;
    let expectedDown = 0;
    let hasBull = false;
    let hasBear = false;
    if (psar && closes.length > 0) {
      let prevDir = 0;
      for (let index = Math.max(0, start); index < psar.length && index < closes.length; index += 1) {
        const value = psar[index];
        if (!finite(value)) continue;
        const dir = value <= closes[index] ? 1 : -1;
        if (dir > 0) hasBull = true;
        else hasBear = true;
        if (prevDir !== 0 && dir !== prevDir) {
          expectedFlips += 1;
          if (dir > 0) expectedUp += 1;
          else expectedDown += 1;
        }
        prevDir = dir;
      }
    }
    const arrows = Array.from(document.querySelectorAll<SVGPathElement>("[data-flip='T16']"));
    const upArrows = arrows.filter((path) => path.getAttribute("data-flip-dir") === "up");
    const downArrows = arrows.filter((path) => path.getAttribute("data-flip-dir") === "down");
    const clauses: Clause[] = [
      pass("T16 以点列显示", selected && circles.length > 0, { dots: circles.length }),
      pass("T16 点不连成线", document.querySelectorAll("path[data-overlay='T16'][data-overlay-key]").length === 0, {
        lines: document.querySelectorAll("path[data-overlay='T16'][data-overlay-key]").length,
      }),
      pass(
        "T16 反转箭头数量与方向正确",
        expectedFlips > 0 &&
          arrows.length === expectedFlips &&
          upArrows.length === expectedUp &&
          downArrows.length === expectedDown,
        { arrows: arrows.length, expectedFlips, up: upArrows.length, expectedUp, down: downArrows.length, expectedDown },
      ),
      pass(
        "T16 多空颜色正确（红涨绿跌）",
        fills.length > 0 &&
          fills.every((fill) => fill === riseColor || fill === fallColor) &&
          (!hasBull || fills.includes(riseColor)) &&
          (!hasBear || fills.includes(fallColor)),
        { colors: Array.from(new Set(fills)), rise: riseColor, fall: fallColor, hasBull, hasBear,
          upArrowColors: Array.from(new Set(upArrows.map((path) => getComputedStyle(path).fill))),
          downArrowColors: Array.from(new Set(downArrows.map((path) => getComputedStyle(path).fill))) },
      ),
      pass("T16 读数条 1 条", readoutsOf("b2-overlay-T16-").length === 1, {
        count: readoutsOf("b2-overlay-T16-").length,
      }),
    ];
    cards.push({ card: "S-03.05-05", ac: "AC-03.05-24", kind: "overlay", selected, clauses, ok: verdict(clauses), dataLimited: dataLimited(clauses) });
  }

  // S-03.05-06 / AC-03.05-27：三线随周期重算、首根无值、切周期无残留、标签不重叠
  {
    const selected = await setOverlays(["T23"]);
    const clauses: Clause[] = [
      pass("T23 三线可见", selected && overlayPaths("T23").length === 3, {
        nodes: overlayPaths("T23").length,
      }),
    ];
    const pivot = valuesOf("T23", "pivot");
    clauses.push(pass("T23 首根无值", pivot !== null && !finite(pivot[0]), { first: pivot?.[0] ?? null }));
    const tf = await switchTimeframeAndBack();
    const weeklyBars = tf.afterWeekly.barsLength;
    const dailyBars = tf.afterDaily.barsLength;
    // 必须从周线快照里读，不能用当前（已切回日线）的 snapshot，否则比的是自己
    const valuesIn = (snap: typeof tf.before, id: string, key: string) =>
      snap.calc?.series.find((item) => item.indicatorId === id)?.outputs.find((output) => output.key === key)?.values ?? null;
    const keys23 = ["pivot", "r1", "s1"];
    const weeklyOut = keys23.map((key) => valuesIn(tf.afterWeekly, "T23", key));
    const dailyOut = keys23.map((key) => valuesIn(tf.afterDaily, "T23", key));
    const lastOf = (values: Array<number | null> | null) =>
      values ? values[lastFiniteIndex(values)] : null;
    const weeklyLasts = weeklyOut.map(lastOf);
    const dailyLasts = dailyOut.map(lastOf);
    const allFinite = weeklyLasts.every((value) => finite(value)) && dailyLasts.every((value) => finite(value));
    const differ = keys23.filter((_, index) => {
      const weekly = weeklyLasts[index];
      const daily = dailyLasts[index];
      return finite(weekly) && finite(daily) && Math.abs(weekly - daily) > 1e-9;
    });
    clauses.push(
      pass(
        "T23 切周期后三线重算",
        Boolean(tf.weeklySample) &&
          Boolean(tf.dailySample) &&
          weeklyBars > 0 &&
          weeklyBars !== dailyBars &&
          dailyBars === tf.before.barsLength &&
          allFinite &&
          differ.length >= 1,
        { weeklyBars, dailyBars, weeklyLasts, dailyLasts, differ },
      ),
    );
    const residual = ["T08", "T10", "T12", "T13", "T14", "T16", "T24"].reduce(
      (total, id) => total + overlayPaths(id).length,
      0,
    );
    clauses.push(
      pass("T23 切周期后旧线不残留", overlayPaths("T23").length === 3 && residual === 0, {
        nodes: overlayPaths("T23").length,
        residual,
      }),
    );
    const spans = Array.from(
      document.querySelectorAll<HTMLElement>("[data-readout^='b2-overlay-T23-']"),
    ).map((element) => element.getBoundingClientRect());
    let overlap = 0;
    for (let i = 0; i < spans.length; i += 1) {
      for (let j = i + 1; j < spans.length; j += 1) {
        const dx = Math.min(spans[i].right, spans[j].right) - Math.max(spans[i].left, spans[j].left);
        const dy = Math.min(spans[i].bottom, spans[j].bottom) - Math.max(spans[i].top, spans[j].top);
        if (dx > 1 && dy > 1) overlap += 1;
      }
    }
    clauses.push(pass("T23 读数标签不重叠", spans.length === 3 && overlap === 0, { count: spans.length, overlap }));
    cards.push({ card: "S-03.05-06", ac: "AC-03.05-27", kind: "overlay", selected, clauses, ok: verdict(clauses), dataLimited: dataLimited(clauses) });
  }

  // S-03.05-07 / AC-03.05-31：带宽比值、%B 两位小数、零带宽 —、NaN 断开
  {
    const clauses: Clause[] = [];
    const units: Record<string, string> = {};
    const texts: Record<string, string> = {};
    const start = windowStart();
    for (const id of ["V03", "V04", "V05"]) {
      const selected = await setSub(id);
      const readouts = readoutsOf(`b2-sub-${id}-`);
      units[id] = readouts[0]?.unit ?? "";
      texts[id] = readouts[0]?.text ?? "";
      clauses.push(
        pass(`${id} 读数与单位`, selected && readoutShapeOk(readouts) && readouts.length >= 1 && units[id] !== "", {
          count: readouts.length,
          unit: units[id],
        }),
      );
      const values = primaryValues(id);
      const path = subPaths(id)[0];
      const measured = segments(path?.getAttribute("d"));
      clauses.push(
        values
          ? pass(`${id} 数据不足处断开`, measured === finiteRuns(values, start), {
              segments: measured,
              runs: finiteRuns(values, start),
            })
          : skip(`${id} 数据不足处断开`, "引擎无该输出"),
      );
    }
    clauses.push(
      pass("带宽以比值显示", units.V04 === "无量纲" && !texts.V04.includes("%"), {
        unit: units.V04,
        text: texts.V04,
      }),
    );
    const percentBReadout = readoutsOf("b2-sub-V05-")[0];
    // `data-value` 是原始双精度值（供下游计算），用户看到的是 textContent（含读数标签与单位）；
    // 「保留 2 位」是显示层条款，必须断在 text 里那个数字的小数位上。
    const percentBText = percentBReadout?.text ?? "";
    const percentBDecimals = percentBText.match(/-?\d+\.(\d+)/);
    clauses.push(
      pass("%B 保留两位小数", percentBDecimals !== null && percentBDecimals[1].length === 2, {
        text: percentBText,
        decimals: percentBDecimals ? percentBDecimals[1].length : -1,
        value: percentBReadout?.value ?? "",
      }),
    );
    // 零带宽在 520 根模拟数据里没有样本（`V04` 无 0 值根），该条由「NaN → —」渲染路径覆盖：
    // 读数条对空值统一显示 —，`readoutShapeOk` 已断言；这里记录数据限制，不伪造通过。
    const bandwidth = valuesOf("V04", "bandwidth") ?? primaryValues("V04");
    const zeroBandwidth = bandwidth
      ? bandwidth
          .slice(start)
          .filter((value) => value !== null && Number.isFinite(value) && (value as number) === 0).length
      : -1;
    clauses.push(
      skip("零带宽段显示 —", `窗口内零带宽根 = ${zeroBandwidth}（无样本时由 NaN→— 路径覆盖）`),
    );
    cards.push({ card: "S-03.05-07", ac: "AC-03.05-31", kind: "sub", clauses, ok: verdict(clauses), dataLimited: dataLimited(clauses) });
  }

  // S-03.05-08 / AC-03.05-35：0 轴可见、正负分色、未就绪段断开、切标的后不残留
  {
    const clauses: Clause[] = [];
    await setSub("V08");
    const start = windowStart();
    clauses.push(
      pass("V08 0 轴可见", document.querySelectorAll("[data-sub-zero='1']").length === 1, {
        zeroAxis: document.querySelectorAll("[data-sub-zero='1']").length,
      }),
    );
    // `data-sub` 挂在 <g> 上，`data-sub-sign` 挂在两条 <path> 上，属性选择器不会继承
    const posPath = document.querySelector<SVGPathElement>("[data-sub='V08'] path[data-sub-sign='pos']");
    const negPath = document.querySelector<SVGPathElement>("[data-sub='V08'] path[data-sub-sign='neg']");
    const posStroke = posPath ? getComputedStyle(posPath).stroke : "";
    const negStroke = negPath ? getComputedStyle(negPath).stroke : "";
    clauses.push(
      pass("V08 正负分色", Boolean(posPath) && Boolean(negPath) && posStroke === posColor && negStroke === negColor, {
        posStroke,
        negStroke,
      }),
    );
    const gapo = primaryValues("V08");
    clauses.push(
      pass(
        "V08 正负路径按符号断开",
        gapo !== null &&
          segments(posPath?.getAttribute("d")) === signRuns(gapo, start, true) &&
          segments(negPath?.getAttribute("d")) === signRuns(gapo, start, false),
        {
          posSegments: segments(posPath?.getAttribute("d")),
          negSegments: segments(negPath?.getAttribute("d")),
          posRuns: gapo ? signRuns(gapo, start, true) : -1,
          negRuns: gapo ? signRuns(gapo, start, false) : -1,
        },
      ),
    );
    clauses.push(
      pass("V08 读数与单位", readoutShapeOk(readoutsOf("b2-sub-V08-")) && readoutsOf("b2-sub-V08-").length === 1, {
        count: readoutsOf("b2-sub-V08-").length,
      }),
    );
    const switched = await switchAwayAndBack();
    const last = gapo ? lastFiniteIndex(gapo) : -1;
    const expectLast = last >= 0 && gapo && finite(gapo[last]) ? (gapo[last] as number) : Number.NaN;
    const readout = readoutsOf("b2-sub-V08-")[0];
    clauses.push(
      pass(
        "切标的后不残留",
        switched.ok && document.querySelectorAll("[data-sub='V08'] path[data-sub-sign]").length === 2 && readout !== undefined && numericMatches(readout.value, expectLast),
        { switched: switched.ok, nodes: document.querySelectorAll("[data-sub='V08'] path[data-sub-sign]").length, readout: readout?.value ?? "", expectLast },
      ),
    );
    cards.push({ card: "S-03.05-08", ac: "AC-03.05-35", kind: "sub", clauses, ok: verdict(clauses), dataLimited: dataLimited(clauses) });
  }

  // 复位默认视图，避免取证改变用户看到的叠加/副图
  await setOverlays(["T09", "T24"]);
  await setSub("M06");

  const clauseCount = cards.reduce(
    (total, card) => total + ((card.clauses as Clause[] | undefined)?.length ?? 0),
    0,
  );
  const failCount = cards.reduce(
    (total, card) =>
      total +
      ((card.clauses as Clause[] | undefined) ?? []).filter((clause) => clause.status === "fail").length,
    0,
  );
  const dataLimitedCount = cards.reduce(
    (total, card) => total + Number(card.dataLimited ?? 0),
    0,
  );
  return {
    cardCount: cards.length,
    clauseCount,
    failCount,
    dataLimitedCount,
    cards,
    ok: cards.length === 8 && failCount === 0 && cards.every((item) => Boolean(item.ok)),
  };
}

/** B3 渲染层证据：13 个动量/摆动指标逐个切副图，读 DOM 节点数/描边/读数。 */
async function collectB3RenderChecks(): Promise<Record<string, unknown>> {
  const ids = [
    "M01", "M02", "M04", "M05", "M08", "M09", "M10",
    "M19", "M20", "M21", "M24", "M25", "M26",
  ];
  const manifest = await ipc.indicatorManifest();
  // 期望输出条数一律从 manifest 动态取：以后指标加线不会静默失配
  const outputCounts = new Map(
    manifest.indicators.map((item) => [item.id, item.outputs.length] as const),
  );
  const expect: Record<string, number> = {};
  for (const id of ids) expect[id] = outputCounts.get(id) ?? -1;
  const select = document.querySelector<HTMLSelectElement>("[data-b2-sub-select]");
  const options = select ? Array.from(select.options).map((option) => option.value) : [];
  const missing = ids.filter((id) => !options.includes(id));

  const cards: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    if (!select) {
      cards.push({ id, ok: false, reason: "副图下拉缺失" });
      continue;
    }
    select.value = id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(260);
    const nodes = Array.from(document.querySelectorAll<SVGElement>(`[data-sub='${id}']`));
    // line 输出把 data-sub 挂 path 上；dot/histogram 输出挂在外层 g 上，需下钻取子元素样式
    const paints = nodes.map((node) => {
      if (node.tagName.toLowerCase() === "path") return getComputedStyle(node).stroke;
      const child = node.querySelector<SVGElement>("circle, rect");
      return child ? getComputedStyle(child).fill : "";
    });
    const paintOk =
      paints.length === nodes.length &&
      paints.every((paint) => paint !== "" && paint !== "none" && !paint.includes("NaN"));
    const readouts = Array.from(
      document.querySelectorAll<HTMLElement>(`[data-readout^='b2-sub-${id}-']`),
    ).map((element) => ({
      value: element.getAttribute("data-value") ?? "",
      text: element.textContent?.trim() ?? "",
    }));
    const readoutOk =
      readouts.length === expect[id] &&
      readouts.some((entry) => entry.value !== "") &&
      readouts.every((entry) =>
        entry.value !== "" ? Number.isFinite(Number(entry.value)) : entry.text.includes("—"),
      );
    // Q-03：M25 state 必须按值三色（+1 红 / −1 绿 / 0 蓝），不得回落到 manifest 默认灰
    let triColor: Record<string, unknown> | null = null;
    if (id === "M25") {
      const fills = Array.from(
        document.querySelectorAll<SVGElement>("[data-sub='M25'] circle"),
      ).map((circle) => getComputedStyle(circle).fill);
      const unique = Array.from(new Set(fills));
      triColor = {
        fillCount: fills.length,
        unique,
        ok: unique.length >= 2 && unique.length <= 3 && !unique.includes("rgb(148, 163, 184)"),
      };
    }
    cards.push({
      id,
      nodes: nodes.length,
      paintCount: paints.length,
      paintOk,
      paints,
      readouts: readouts.length,
      readoutOk,
      triColor,
      ok:
        nodes.length === expect[id] &&
        paintOk &&
        readoutOk &&
        (triColor ? Boolean(triColor.ok) : true),
    });
  }

  // 复位默认副图
  if (select) {
    select.value = "M06";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(260);
  }

  return {
    cardCount: cards.length,
    optionsCount: options.length,
    missing,
    expect,
    cards,
    ok: cards.length === 13 && missing.length === 0 && Object.keys(expect).every((id) => expect[id] > 0) && cards.every((item) => Boolean(item.ok)),
  };
}

/** 口径页证据：真实跳转 P4 路由，逐个 B2 指标点击后校验四段存在且有内容。 */
async function collectCatalogCheck(): Promise<Record<string, unknown>> {
  const previous = window.location.hash;
  window.location.hash = "#/catalog";
  await sleep(600);
  const registry = await ipc.indicatorRegistry();
  const manifest = await ipc.indicatorManifest();
  const registryById = new Map(registry.indicators.map((item) => [item.id, item] as const));
  // 逐项覆盖全部已实现指标（44），不再只抽样 B2 的 20 个
  const targetIds = registry.indicators.map((item) => item.id);
  const expectedBetaIds = manifest.indicators
    .filter((item) => item.status === "beta")
    .map((item) => item.id)
    .sort();
  const listed = Array.from(document.querySelectorAll("[data-catalog-item]")).map(
    (element) => element.getAttribute("data-catalog-item") ?? "",
  );
  const betaIds = Array.from(
    document.querySelectorAll<HTMLElement>("[data-catalog-item][data-catalog-beta='1']"),
  ).map((element) => element.getAttribute("data-catalog-item") ?? "");
  const rootPresent = document.querySelectorAll("[data-catalog-root='p4']").length > 0;

  const sectionText = (name: string) => {
    const section = document.querySelector<HTMLElement>(`[data-catalog-section='${name}']`);
    if (!section) return null;
    return section;
  };
  const cards: Array<Record<string, unknown>> = [];
  for (const id of targetIds) {
    const button = document.querySelector<HTMLElement>(`[data-catalog-item='${id}']`);
    if (!button) {
      cards.push({ id, ok: false, reason: "条目缺失" });
      continue;
    }
    button.click();
    await sleep(180);
    const meta = registryById.get(id);
    if (!meta) {
      cards.push({ id, ok: false, reason: "registry 无此指标" });
      continue;
    }
    const formula = sectionText("formula");
    const params = sectionText("params");
    const warmup = sectionText("warmup");
    const boundary = sectionText("boundary");
    const formulaText = formula?.querySelector("p")?.textContent?.trim() ?? "";
    const boundaryText = boundary?.querySelector("p")?.textContent?.trim() ?? "";
    const warmupText = warmup?.querySelector("p")?.textContent?.trim() ?? "";
    const warmupMatch = warmupText.match(/首个有效值下标\s*(\d+)/);
    const paramRows = params?.querySelectorAll("tbody tr").length ?? 0;
    const noParamHint = (params?.textContent ?? "").includes("无参数");
    const clauses = {
      formula: { ok: formulaText.length > 0, detail: formulaText.slice(0, 60) },
      params: {
        ok:
          meta.params.length === 0
            ? noParamHint
            : paramRows === meta.params.length,
        detail: `rows=${paramRows} expected=${meta.params.length}`,
      },
      warmup: {
        ok: Boolean(warmupMatch) && Number(warmupMatch?.[1]) === meta.warmup,
        detail: `text="${warmupText.slice(0, 40)}" expected=${meta.warmup}`,
      },
      boundary: { ok: boundaryText.length > 0, detail: boundaryText.slice(0, 60) },
    };
    const ok = clauses.formula.ok && clauses.params.ok && clauses.warmup.ok && clauses.boundary.ok;
    cards.push({ id, clauses, ok });
  }

  window.location.hash = previous || "#/workbench";
  await sleep(320);
  const betaIdsSorted = [...betaIds].sort();
  return {
    route: "#/catalog",
    rootPresent,
    itemCount: listed.length,
    itemCountOk: listed.length === registry.indicators.length,
    betaIds,
    betaCount: betaIds.length,
    expectedBetaCount: expectedBetaIds.length,
    targetIds,
    cards,
    ok:
      rootPresent &&
      listed.length === registry.indicators.length &&
      targetIds.every((id) => listed.includes(id)) &&
      betaIdsSorted.length === expectedBetaIds.length &&
      betaIdsSorted.every((id, index) => id === expectedBetaIds[index]) &&
      cards.length === targetIds.length &&
      cards.every((item) => Boolean(item.ok)),
  };
}

export async function runS2Diagnostics(hooks: DiagHooks): Promise<Record<string, unknown>> {
  const notes: string[] = [];

  // 等首屏请求结束，避免把挂载时的请求混进连键样本
  await sleep(1_800);
  hooks.drainSamples();

  const resetToBase = async () => {
    hooks.setParams(hooks.baseParams);
    await sleep(DEBOUNCE_QUIET_MS + 400);
    hooks.drainSamples();
  };

  /**
   * 连键三连击：间隔 40ms 的 3 次输入，静默 120ms 后才允许发出请求。
   * 返回真实发出的请求条数与 `compute.count` 增量。
   */
  const runBurst = async (values: [number, number, number], label: string) => {
    hooks.setPhase("debounce");
    const before = await hooks.telemetry();
    const countBefore = before.counts["compute.count"] ?? 0;
    const inputs = values.map((maPeriod) => ({ ...hooks.baseParams, maPeriod }));

    hooks.setParams(inputs[0]);
    await sleep(DEBOUNCE_INPUT_GAP_MS);
    hooks.setParams(inputs[1]);
    await sleep(DEBOUNCE_INPUT_GAP_MS);
    hooks.setParams(inputs[2]);
    await sleep(DEBOUNCE_QUIET_MS + 700);

    const burst = hooks.drainSamples();
    const after = await hooks.telemetry();
    const computeDelta = (after.counts["compute.count"] ?? 0) - countBefore;
    // 事件原文：cacheKey / paramsHash / datasetId / barCount 等字段逐字落盘
    const computeEvent =
      [...(after.recent ?? [])]
        .reverse()
        .find((event) => event.name === "indicator.compute") ?? null;
    return {
      label,
      inputs: values,
      inputGapMs: DEBOUNCE_INPUT_GAP_MS,
      quietMs: DEBOUNCE_QUIET_MS,
      requestsIssued: burst.length,
      computeCountEvents: computeDelta,
      computeEvent,
      samples: burst,
      passed: burst.length === 1,
    };
  };

  // ---- 1. 连键 1 → 12 → 120（台账原判据）----
  const burst120 = await runBurst([1, 12, 120], "1→12→120");
  await resetToBase();

  // ---- 1b. 连键 1 → 12 → 60：120 组合在 520 根数据集上会撞 TEMA 4.5N 观察期，
  // 用 60 组合再证一次「只发一次请求且真的算成功一次」----
  const burst60 = await runBurst([1, 12, 60], "1→12→60");
  const burst120Error = burst120.samples.find((item) => item.error)?.error ?? null;
  if (burst120.requestsIssued !== 1) {
    notes.push(`连键 ${burst120.label} 请求数异常：${burst120.requestsIssued}`);
  }
  if (burst120Error) {
    notes.push(`连键 ${burst120.label} 的结果：${burst120Error}`);
  }
  if (burst60.requestsIssued !== 1 || burst60.computeCountEvents !== 1) {
    notes.push(
      `连键 ${burst60.label} 异常：请求 ${burst60.requestsIssued} / compute.count ${burst60.computeCountEvents}`,
    );
  }
  if (!burst60.computeEvent) {
    notes.push("连键 1→12→60 缺少 indicator.compute 事件原文（cacheKey/paramsHash/datasetId/barCount）");
  }
  await resetToBase();

  // ---- 2. 冷缓存切换 30 个标的（去重后保证每个都是新的缓存键）----
  hooks.setPhase("cold");
  const coldCodes = Array.from(new Set(hooks.codes))
    .filter((code) => code !== hooks.getActiveCode())
    .slice(0, 30);
  const cold: DiagSample[] = [];
  for (const code of coldCodes) {
    const pending = hooks.nextSample(4_000);
    hooks.setCode(code);
    const sample = await pending;
    if (!sample) {
      notes.push(`冷请求超时：${code}`);
      continue;
    }
    cold.push({ ...sample, phase: "cold" });
  }
  const telAfterCold = await hooks.telemetry();

  const coldCalcP95 = nearestRankP95(cold.map((item) => item.calcMs));
  const coldTotalP95 = nearestRankP95(cold.map((item) => item.totalMs));
  const coldBarsP95 = nearestRankP95(cold.map((item) => item.barsMs));
  const coldAllMiss = cold.every((item) => !item.cacheHit);

  // ---- 3. 切回前 30 个标的 × 3 批（缓存命中，批间不插冷算/改参/换数据集/重启）----
  // 口径 R-S0-07-01：每批 30 连续热切回，合计 ≥90 样本；判定取 max。
  hooks.setPhase("warm");
  const warmTargets = coldCodes.slice(0, 30);
  const warmBatches = 3;
  const warm: Array<DiagSample & { matchesCold: boolean; batch: number }> = [];
  for (let batch = 1; batch <= warmBatches; batch += 1) {
    for (const code of warmTargets) {
      const pending = hooks.nextSample(4_000);
      hooks.setCode(code);
      const sample = await pending;
      if (!sample) {
        notes.push(`回切请求超时：${code}`);
        continue;
      }
      const coldRef = cold.find((item) => item.security === code) ?? null;
      warm.push({
        ...sample,
        phase: "warm",
        batch,
        matchesCold: coldRef ? coldRef.seriesHash === sample.seriesHash : false,
      });
    }
  }
  const telAfterWarm = await hooks.telemetry();
  // 请求形状（R-S0-07-01 留档）：取热切回结束时的 D 周期响应体积。
  const requestShape = hooks.probePayload();

  const warmMaxCalc = warm.reduce((max, item) => Math.max(max, item.calcMs), 0);
  const warmMaxTotal = warm.reduce((max, item) => Math.max(max, item.totalMs), 0);
  const warmP95 = nearestRankP95(warm.map((item) => item.totalMs));
  const warmP50 = nearestRankPercentile(warm.map((item) => item.totalMs), 0.5);
  const warmP50Calc = nearestRankPercentile(warm.map((item) => item.calcMs), 0.5);
  const warmAllHit = warm.every((item) => item.cacheHit);
  const warmAllMatch = warm.every((item) => item.matchesCold);
  const warmBatchMax = Array.from({ length: warmBatches }, (_, index) =>
    round2(warm.filter((item) => item.batch === index + 1).reduce((max, item) => Math.max(max, item.totalMs), 0)),
  );
  const warmPassed = warm.length >= 90 && warmAllHit && warmAllMatch && warmMaxTotal <= 120;
  if (!warmPassed) {
    notes.push(
      `回切异常：样本 ${warm.length} / cacheHit ${warmAllHit} / 逐点一致 ${warmAllMatch} / max ${round2(warmMaxTotal)}ms`,
    );
  }

  // ---- 4. D/W/M 周期切换 ----
  // W 走完整 UI 链路（行情 + 指标）；M 在当前模拟数据集（520 根日线≈24 月）下
  // 按 warmup+1 门：T02/T04/T05/M06 不可算，其余 7 项可算，故 M 只取行情层聚合，并如实登记。
  hooks.setPhase("cold");
  const timeframeSamples: Array<DiagSample & { timeframe: TimeframeCode }> = [];
  for (const tf of ["W", "D"] as TimeframeCode[]) {
    const pending = hooks.nextSample(4_000);
    hooks.setTimeframe(tf);
    const sample = await pending;
    if (!sample) {
      notes.push(`周期切换超时：${tf}`);
      continue;
    }
    timeframeSamples.push({ ...sample, phase: "cold", timeframe: tf });
  }
  const tfW = timeframeSamples.find((item) => item.timeframe === "W") ?? null;
  const tfD = timeframeSamples.find((item) => item.timeframe === "D") ?? null;
  const wCold = Boolean(tfW) && !tfW!.cacheHit;
  if (!tfW || !tfD || !wCold) {
    notes.push(
      `周期切换异常：W ${tfW ? `${tfW.barCount} 根/冷 ${!tfW.cacheHit}` : "缺失"}；D 回切 ${tfD ? (tfD.cacheHit ? "命中" : "未命中") : "缺失"}`,
    );
  }

  const probes: Array<{ timeframe: string; barCount: number; datasetId: string }> = [];
  for (const tf of ["D", "W", "M"] as TimeframeCode[]) {
    try {
      probes.push(await hooks.probeBars(tf));
    } catch (err) {
      notes.push(`行情周期探针 ${tf} 失败：${String(err)}`);
    }
  }
  const probeD = probes.find((item) => item.timeframe === "D") ?? null;
  const probeW = probes.find((item) => item.timeframe === "W") ?? null;
  const probeM = probes.find((item) => item.timeframe === "M") ?? null;
  const aggregationOrdered =
    Boolean(probeD && probeW && probeM) &&
    probeD!.barCount > probeW!.barCount &&
    probeW!.barCount > probeM!.barCount;
  if (!aggregationOrdered) {
    notes.push(
      `行情聚合异常：D ${probeD?.barCount ?? 0} / W ${probeW?.barCount ?? 0} / M ${probeM?.barCount ?? 0}`,
    );
  }

  hooks.setPhase("done");
  // 复位到默认参数，避免取证把工作台留在 p=60 或 W/M
  hooks.setParams(hooks.baseParams);
  hooks.setTimeframe("D");
  await sleep(600);

  const renderLayer = await collectRenderChecks(hooks);
  const b2Render = await collectB2RenderChecks(hooks);
  const b3Render = await collectB3RenderChecks();
  const catalog = await collectCatalogCheck();
  if (!renderLayer.ok) notes.push("渲染层 DOM 断言未通过，见 verification.renderLayer");
  if (!b2Render.ok) notes.push("B2 渲染层 8 卡断言未通过，见 verification.b2Render");
  if (!b3Render.ok) notes.push("B3 渲染层 13 指标断言未通过，见 verification.b3Render");
  if (!catalog.ok) notes.push("口径页 DOM 断言未通过，见 verification.catalog");

  const payload = {
    schemaVersion: 1,
    kind: "aka-s2-evidence",
    generatedAt: new Date().toISOString(),
    // 口径 R-S0-07-01 的构建类型留档：P 线必须是 release/opt-level 3，dev 数字不作性能结论。
    build: await ipc.diagBuildInfo().catch(() => null),
    // 请求形状固定：形状变化视为新口径（R-S0-07-01 §2.3）
    dataset: {
      ...requestShape,
      indicatorSet: "workbench-default",
      timeframe: "D",
      adj: "qfq",
    },
    engine: {
      engineVersion: telAfterWarm.counts ? "aka-engine-0.1.0" : "unknown",
      userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
      hardwareConcurrency:
        typeof navigator === "undefined" ? null : navigator.hardwareConcurrency ?? null,
    },
    debounce: {
      target: "1→12→120（台账判据）+ 1→12→60（成功单次 compute 佐证）",
      computeCountSemantics:
        "compute.count 为请求批次计数：一条 calc 请求可含多个实例（本项目 50 个），事件 count=本批实算实例数；连键断言的是「请求只发 1 次」，不是「只算 1 个实例」",
      burst120,
      burst60,
      telemetry: {
        computeCount: telAfterWarm.counts["compute.count"] ?? 0,
        indicatorCompute: telAfterWarm.counts["indicator.compute"] ?? 0,
      },
    },
    cold: {
      targetCount: 30,
      sampleCount: cold.length,
      codes: cold.map((item) => item.security),
      allMiss: coldAllMiss,
      p95CalcMs: coldCalcP95 === null ? null : round2(coldCalcP95),
      p95TotalMs: coldTotalP95 === null ? null : round2(coldTotalP95),
      p95BarsMs: coldBarsP95 === null ? null : round2(coldBarsP95),
      maxTotalMs: round2(cold.reduce((max, item) => Math.max(max, item.totalMs), 0)),
      telemetryColdSamples: telAfterCold.coldSamples,
      telemetryColdP95Ms: telAfterCold.coldP95Ms,
      samples: cold.map((item) => ({
        security: item.security,
        timeframe: item.timeframe,
        adj: item.adj,
        barsMs: round2(item.barsMs),
        calcMs: round2(item.calcMs),
        totalMs: round2(item.totalMs),
        cacheHit: item.cacheHit,
        computedMs: round2(item.computedMs),
        barCount: item.barCount,
        seriesHash: item.seriesHash,
        seriesPoints: item.seriesPoints,
        error: item.error,
      })),
    },
    warm: {
      targetCount: 30,
      batchCount: warmBatches,
      criterion:
        "口径 R-S0-07-01：每批 30 连续热切回 × 3 批（≥90），批间不插冷算；全部 cacheHit 且逐点一致，判定取 max ≤ 120ms",
      sampleCount: warm.length,
      allCacheHit: warmAllHit,
      allPointwiseMatch: warmAllMatch,
      p50TotalMs: warmP50 === null ? null : round2(warmP50),
      p50CalcMs: warmP50Calc === null ? null : round2(warmP50Calc),
      p95TotalMs: warmP95 === null ? null : round2(warmP95),
      maxTotalMs: round2(warmMaxTotal),
      maxCalcMs: round2(warmMaxCalc),
      batchMaxTotalMs: warmBatchMax,
      samples: warm.map((item) => ({
        security: item.security,
        batch: item.batch,
        timeframe: item.timeframe,
        adj: item.adj,
        barsMs: round2(item.barsMs),
        calcMs: round2(item.calcMs),
        totalMs: round2(item.totalMs),
        /** 引擎自报耗时：命中路径应为 0（`computed_ms`），非 0 说明该实例发生重算 */
        engineMs: round2(item.computedMs),
        cacheHit: item.cacheHit,
        matchesCold: item.matchesCold,
        seriesHash: item.seriesHash,
        seriesPoints: item.seriesPoints,
        error: item.error,
      })),
    },
    timeframes: {
      uiOrder: ["W", "D"],
      wCold,
      uiSamples: timeframeSamples.map((item) => ({
        timeframe: item.timeframe,
        security: item.security,
        barCount: item.barCount,
        cacheHit: item.cacheHit,
        barsMs: round2(item.barsMs),
        calcMs: round2(item.calcMs),
        totalMs: round2(item.totalMs),
        seriesHash: item.seriesHash,
        seriesPoints: item.seriesPoints,
        error: item.error,
      })),
      aggregationOrdered,
      barProbes: probes.map((item) => ({
        timeframe: item.timeframe,
        barCount: item.barCount,
        datasetId: item.datasetId,
      })),
      monthlyNote:
        "当前模拟数据集仅 520 根日线（≈24 个月）；M 周期按 warmup+1 门：T02/T04/T05/M06 共 4 项不可算，T01/T03/T19/T20/T21/T22/E13 共 7 项可算；本次 M 只取证到行情层聚合",
    },
    verification: {
      renderLayer,
      b2Render,
      b3Render,
      catalog,
    },
    telemetry: {
      path: telAfterWarm.path,
      total: telAfterWarm.total,
      counts: telAfterWarm.counts,
      coldSamples: telAfterWarm.coldSamples,
      coldP95Ms: telAfterWarm.coldP95Ms,
      recent: telAfterWarm.recent.slice(-40),
    },
    notes,
  };

  const written = await hooks.write(JSON.stringify(payload, null, 2));
  return { ...payload, writtenTo: written };
}
