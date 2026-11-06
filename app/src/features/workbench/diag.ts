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
  activeCode: string;
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
export function nearestRankP95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, index)];
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
async function collectRenderChecks(): Promise<Record<string, unknown>> {
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

  let tooltipBefore = attrs("[data-readout^='ma-']", "data-readout").length;
  let maEntries: Array<{ id: string; value: string; unit: string; text: string }> = [];
  let hoverIndex = "";
  let hoverError: string | null = null;
  let colorSamples: Record<string, string> = {};
  let chgFirst = { sign: "", text: "", color: "" };
  let chgSecond = { sign: "", text: "", color: "" };
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
      tooltipBefore = attrs("[data-readout^='ma-']", "data-readout").length;
      hoverIndex =
        document
          .querySelector("[data-readout-host='1']")
          ?.getAttribute("data-hover-index") ?? "";
      maEntries = Array.from(document.querySelectorAll("[data-readout^='ma-']")).map(
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
      // 再悬停下跌 K 线，取到相反方向的读数，证明 ▲▼ 双向都编码
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
      };
      svg.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
      await sleep(80);
    } catch (err) {
      hoverError = String(err);
    }
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
    (chgEncoded(chgFirst, "pos") || chgEncoded(chgSecond, "pos")) &&
    (chgEncoded(chgFirst, "neg") || chgEncoded(chgSecond, "neg"));
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
    hoverError,
    ok:
      Boolean(svg) &&
      overlayCount >= 8 &&
      macdCount === 3 &&
      histCount >= 2 &&
      colorOk &&
      statisticalCount >= 4 &&
      unitLabels.length >= 4 &&
      t21TwoDecimals &&
      tooltipBefore >= 8 &&
      hoverIndex !== "" &&
      decimalsOk &&
      maEntries.every((entry) => entry.value !== "" && entry.unit !== ""),
  };
}

/** 口径页证据：真实跳转 P4 路由，读 DOM 里的指标条目与四段结构。 */
async function collectCatalogCheck(): Promise<Record<string, unknown>> {
  const previous = window.location.hash;
  window.location.hash = "#/catalog";
  await sleep(600);
  const items = Array.from(document.querySelectorAll("[data-catalog-item]")).map(
    (element) => element.getAttribute("data-catalog-item") ?? "",
  );
  const sections = Array.from(document.querySelectorAll("[data-catalog-section]")).map(
    (element) => element.getAttribute("data-catalog-section") ?? "",
  );
  const betaCount = document.querySelectorAll("[data-catalog-beta='1']").length;
  const rootPresent = document.querySelectorAll("[data-catalog-root='p4']").length > 0;
  window.location.hash = previous || "#/workbench";
  await sleep(320);
  return {
    route: "#/catalog",
    rootPresent,
    items,
    itemCount: items.length,
    sections,
    betaCount,
    ok: rootPresent && items.length === 31 && sections.length === 4,
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
    return {
      label,
      inputs: values,
      inputGapMs: DEBOUNCE_INPUT_GAP_MS,
      quietMs: DEBOUNCE_QUIET_MS,
      requestsIssued: burst.length,
      computeCountEvents: computeDelta,
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
  await resetToBase();

  // ---- 2. 冷缓存切换 30 个标的（去重后保证每个都是新的缓存键）----
  hooks.setPhase("cold");
  const coldCodes = Array.from(new Set(hooks.codes))
    .filter((code) => code !== hooks.activeCode)
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

  // ---- 3. 切回前 10 个标的（缓存命中）----
  hooks.setPhase("warm");
  const warmTargets = coldCodes.slice(0, 10);
  const warm: Array<DiagSample & { matchesCold: boolean }> = [];
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
      matchesCold: coldRef ? coldRef.seriesHash === sample.seriesHash : false,
    });
  }
  const telAfterWarm = await hooks.telemetry();

  const warmMaxCalc = warm.reduce((max, item) => Math.max(max, item.calcMs), 0);
  const warmMaxTotal = warm.reduce((max, item) => Math.max(max, item.totalMs), 0);
  const warmP95 = nearestRankP95(warm.map((item) => item.totalMs));
  const warmAllHit = warm.every((item) => item.cacheHit);
  const warmAllMatch = warm.every((item) => item.matchesCold);
  const warmPassed = warm.length >= 10 && warmAllHit && warmAllMatch && warmMaxTotal <= 120;
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

  const renderLayer = await collectRenderChecks();
  const catalog = await collectCatalogCheck();
  if (!renderLayer.ok) notes.push("渲染层 DOM 断言未通过，见 verification.renderLayer");
  if (!catalog.ok) notes.push("口径页 DOM 断言未通过，见 verification.catalog");

  const payload = {
    schemaVersion: 1,
    kind: "aka-s2-evidence",
    generatedAt: new Date().toISOString(),
    engine: {
      engineVersion: telAfterWarm.counts ? "aka-engine-0.1.0" : "unknown",
      userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
    },
    debounce: {
      target: "1→12→120（台账判据）+ 1→12→60（成功单次 compute 佐证）",
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
      targetCount: 10,
      sampleCount: warm.length,
      allCacheHit: warmAllHit,
      allPointwiseMatch: warmAllMatch,
      p95TotalMs: warmP95 === null ? null : round2(warmP95),
      maxTotalMs: round2(warmMaxTotal),
      maxCalcMs: round2(warmMaxCalc),
      samples: warm.map((item) => ({
        security: item.security,
        timeframe: item.timeframe,
        adj: item.adj,
        barsMs: round2(item.barsMs),
        calcMs: round2(item.calcMs),
        totalMs: round2(item.totalMs),
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
