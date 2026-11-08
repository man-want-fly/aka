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
import type { CalcResponse, TelemetryEventDto, TelemetrySummary } from "../../lib/types";
import type { WorkbenchParams } from "./model";

export type DiagPhase = "off" | "debounce" | "cold" | "warm" | "done";

/** R-EV-02 运行层五项：commit/dirty 来自构建期 define，runtime/build 来自 Rust，command 由本函数拼装。 */
export interface EvidenceEnv {
  commit: string;
  dirty: boolean;
  runtime: {
    launchMode: string;
    node: string;
    os: string;
    arch: string;
    hostTarget: string;
    /** 本产品是 Tauri WebKit 宿主，必须显式写 "none"；缺键才 FAIL。 */
    electron: string;
  };
  build: {
    entry: string;
    builtAt: string;
    cargoProfile: string;
    features: string[];
    binary: { path: string; sha256: string };
  };
  command: string;
}

/**
 * 采集 R-EV-02 env 块。任何一项读不到都抛错（而不是写空占位），
 * 让运行层证据在 verify:evidence 处 failed，避免「自证通过」。
 */
export async function collectEvidenceEnv(targetHint = "s2"): Promise<EvidenceEnv> {
  const [buildInfo, env] = await Promise.all([
    ipc.diagBuildInfo(),
    ipc.diagEnv(),
  ]);
  const commit = __AKA_BUILD_COMMIT__;
  if (!commit) throw new Error("构建期 commit 未注入（vite define 缺失）");
  const command = env.binary ? `AKA_DIAG=1 AKA_DIAG_TARGET="${targetHint}" ${env.binary}` : "";
  return {
    commit,
    dirty: __AKA_BUILD_DIRTY__,
    runtime: {
      launchMode: "cargo+custom-protocol",
      node: __AKA_BUILD_NODE__,
      os: env.os,
      arch: env.arch,
      // Tauri WebKit 的 platform / Rust host triple；与 evidence-run.sh 的 meta 同口径。
      hostTarget: `tauri-webkit(${buildInfo.targetTriple})`,
      // 非 Electron 宿主：显式 none 记通过，字段缺失才 FAIL（第 19 条）。
      // runtime 的唯一真源在本函数：evidence-run.sh 的 meta.runtime 直接回填本对象，不得另写一份。
      electron: "none",
    },
    build: {
      entry: __AKA_BUILD_ENTRY__,
      builtAt: __AKA_BUILD_AT__,
      cargoProfile: buildInfo.buildProfile,
      features: __AKA_BUILD_FEATURES__,
      binary: { path: env.binary, sha256: env.binarySha256 },
    },
    command,
  };
}

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

// W-89：取证前把主图叠加/副图归一化到产品默认基线。
// 持久化的 overlayIds/subIds 会随上一次操作泄漏（BA 实测主图只剩 T09/T24、副图无 M06），
// 导致 colorOk/macdCount/shownSma 全部假红；这不是产品缺陷，是取证状态未归一。
const BASELINE_OVERLAYS = ["T01", "T09"];
const BASELINE_SUBS = ["M06", "M01"];

async function setMultiSelect(selector: string, ids: string[]): Promise<boolean> {
  const select = document.querySelector<HTMLSelectElement>(selector);
  if (!select) return false;
  for (const option of Array.from(select.options)) option.selected = ids.includes(option.value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(260);
  return true;
}

/** 归一化到默认基线并在渲染稳定后返回；任一选择器缺失即 false（由调用方记入证据）。 */
async function applyBaselineSelection(): Promise<boolean> {
  const overlaysOk = await setMultiSelect("[data-b2-overlay-select]", BASELINE_OVERLAYS);
  const subsOk = await setMultiSelect("[data-b2-sub-select]", BASELINE_SUBS);
  if (!overlaysOk || !subsOk) return false;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    if (
      document.querySelectorAll("[data-overlay]").length >= 4 &&
      document.querySelectorAll("[data-macd]").length >= 3 &&
      document.querySelectorAll("[data-macd='hist'] rect").length >= 2
    ) {
      return true;
    }
    await sleep(100);
  }
  return false;
}

/** 窗口聚焦/应用激活：缺字段即「不可判定 = FAIL」，不许写成「环境问题」。 */
export function collectFocus(): { windowFocused: boolean; appActive: boolean } {
  return {
    windowFocused: document.hasFocus(),
    appActive: document.visibilityState === "visible" && !document.hidden,
  };
}

/** 渲染层证据：直接读真实 DOM（Tauri WebView 内），不依赖截图权限。 */
async function collectRenderChecks(hooks: DiagHooks): Promise<Record<string, unknown>> {
  // 先归一化基线，再采样；否则持久化选择会让 macd/shownSma 假红。
  const baselineApplied = await applyBaselineSelection();
  const focus = collectFocus();
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
  // CandleChart 的读数宿主属性是 data-readout="1"（不是 data-readout-host）。
  const readoutHost = document.querySelectorAll("[data-readout='1']").length;

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
        document.querySelector("[data-readout='1']")?.getAttribute("data-hover-index") ?? "";
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
      // MACD 柱实际契约是 [data-macd='hist'] 下的 rect（不是 data-hist='pos'/'neg'）：
      // 正负柱共用同一组 rect，按最终 fill 区分。
      const posToken = resolveColor("--pos");
      const negToken = resolveColor("--neg");
      const histFills = Array.from(
        document.querySelectorAll<SVGElement>("[data-macd='hist'] rect"),
      ).map((element) => getComputedStyle(element).fill);
      colorSamples = {
        posToken,
        negToken,
        upCandleStroke: upCandle ? getComputedStyle(upCandle).stroke : "",
        downCandleStroke: downCandle ? getComputedStyle(downCandle).stroke : "",
        histPosFill: histFills.find((fill) => fill === posToken) ?? "",
        histNegFill: histFills.find((fill) => fill === negToken) ?? "",
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
    let perBar =
      first && second && Math.abs(second.x - first.x) > 0 ? Math.abs(second.x - first.x) : 1;
    const hoverIndexNow = () => {
      const raw =
        document.querySelector("[data-readout='1']")?.getAttribute("data-hover-index") ?? "";
      const value = Number(raw);
      return raw.trim() === "" || !Number.isFinite(value) ? -1 : value;
    };
    const rows: Array<Record<string, unknown>> = [];
    // W-89 第 4 项：采样点必须推进到目标根，不能停在上一根（BA 实测 105→105 重复）。
    // 用上一次实际观测 (`x`, `hoverIndex`) 自校准「一根 = 多少像素」，
    // 再由反馈闭环推进；前 4 次整格、末 2 次半格细化，避免在 band 边界来回振荡。
    let previous: { x: number; index: number } | null = null;
    for (const visible of picks) {
      const center = centerOf(visible);
      if (!center) continue;
      const absolute = offset + visible;
      let shownAt = -1;
      let clicks = 0;
      let x = center.x;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        clicks += 1;
        svg.dispatchEvent(
          new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: center.y }),
        );
        await sleep(attempt === 0 ? 50 : 25);
        shownAt = hoverIndexNow();
        if (shownAt === visible) {
          previous = { x, index: shownAt };
          break;
        }
        if (shownAt < 0) break;
        // 两次反馈的 |Δx / Δindex| 就是真实的每根像素宽度（含取整误差）。
        if (previous && shownAt !== previous.index && Math.abs(x - previous.x) > 0) {
          const candidate = (x - previous.x) / (shownAt - previous.index);
          if (Number.isFinite(candidate) && candidate > 0.2 && candidate < 1000) {
            perBar = Math.abs(candidate);
          }
        }
        previous = { x, index: shownAt };
        const delta = visible - shownAt;
        const step =
          attempt >= 4
            ? Math.min(Math.abs(delta) * perBar, perBar / 2)
            : Math.abs(delta) * perBar;
        x += (delta > 0 ? 1 : -1) * Math.max(step, 0.5);
      }
      const shownSma =
        document.querySelector("[data-readout='ma-T01']")?.getAttribute("data-value") ?? "";
      const shownDif =
        document.querySelector("[data-readout='sub-M06-dif']")?.getAttribute("data-value") ?? "";
      const engineSma = sma[absolute] ?? null;
      const engineDif = dif[absolute] ?? null;
      const smaOk =
        engineSma === null
          ? shownSma.trim() === ""
          : shownSma.trim() !== "" && Number(shownSma) === engineSma;
      const difOk =
        engineDif === null
          ? shownDif.trim() === ""
          : shownDif.trim() !== "" && Number(shownDif) === engineDif;
      rows.push({
        bar: absolute,
        targetIndex: visible,
        hoverIndex: shownAt,
        clicks,
        engineSma,
        shownSma,
        engineDif,
        shownDif,
        ok: smaOk && difOk,
      });
    }
    const outOfSync = rows.filter((row) => row.hoverIndex !== row.targetIndex).map((row) => row.bar);
    tooltipParity = {
      tolerance: 0,
      enginePoints: sma.length,
      sampled: rows.length,
      samples: rows,
      // 采样点没推进到目标根 = 必须失败（不许把上一根的值当成目标根的值）。
      mismatches: rows
        .filter((row) => row.ok !== true || row.hoverIndex !== row.targetIndex)
        .map((row) => row.bar),
      unresolvedHover: outOfSync,
      ok:
        rows.length === count &&
        rows.every((row) => row.ok === true && row.hoverIndex === row.targetIndex),
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
  const histCount = document.querySelectorAll("[data-macd='hist'] rect").length;
  const posColor = colorSamples.posToken;
  const negColor = colorSamples.negToken;
  // 负号是 formatPct 输出的 U+2212「−」，不是 ASCII "-"；只认 ASCII 会让 colorOk 假红。
  const POS_TEXT_RE = /^▲\s*\+/;
  const NEG_TEXT_RE = /^▼\s*[-\u2212]/;
  const chgEncoded = (sample: { sign: string; text: string; color: string }, direction: "pos" | "neg") =>
    sample.sign === direction &&
    sample.color === (direction === "pos" ? posColor : negColor) &&
    (direction === "pos" ? POS_TEXT_RE : NEG_TEXT_RE).test(sample.text);
  const posSample = [chgFirst, chgSecond, chgPos].find((sample) => chgEncoded(sample, "pos"));
  const negSample = [chgFirst, chgSecond, chgPos].find((sample) => chgEncoded(sample, "neg"));
  const describeChg = (sample: { sign: string; text: string; color: string } | undefined) =>
    sample ? `sign=${sample.sign} color=${sample.color} text=${JSON.stringify(sample.text)}` : "无匹配样本";
  // W-89 第 5 项：复合判据逐子项留痕——只报 colorOk=false 等于不可审计。
  const colorParts = [
    { item: "posToken", pass: posColor !== "", actual: posColor, expected: "非空 CSS 颜色" },
    { item: "negToken", pass: negColor !== "", actual: negColor, expected: "非空 CSS 颜色" },
    {
      item: "upCandleStroke",
      pass: colorSamples.upCandleStroke === posColor,
      actual: colorSamples.upCandleStroke,
      expected: posColor,
    },
    {
      item: "downCandleStroke",
      pass: colorSamples.downCandleStroke === negColor,
      actual: colorSamples.downCandleStroke,
      expected: negColor,
    },
    {
      item: "histPosFill",
      pass: colorSamples.histPosFill === posColor,
      actual: colorSamples.histPosFill,
      expected: posColor,
    },
    {
      item: "histNegFill",
      pass: colorSamples.histNegFill === negColor,
      actual: colorSamples.histNegFill,
      expected: negColor,
    },
    {
      item: "chgPos",
      pass: Boolean(posSample),
      actual: describeChg(posSample),
      expected: `sign=pos color=${posColor} text=${POS_TEXT_RE}`,
    },
    {
      item: "chgNeg",
      pass: Boolean(negSample),
      actual: describeChg(negSample),
      expected: `sign=neg color=${negColor} text=${NEG_TEXT_RE}`,
    },
  ];
  const colorFailures = colorParts
    .filter((part) => !part.pass)
    .map((part) => `${part.item}: actual=${JSON.stringify(part.actual)} expected=${JSON.stringify(part.expected)}`);
  const colorOk = colorFailures.length === 0;
  const statisticalCount = statistical.length;
  // 每个子项都带 item/actual/expected；失败时逐条打印，不接受只有一个 false。
  type Subcheck = { item: string; pass: boolean; actual: unknown; expected: unknown };
  const subchecks: Subcheck[] = [
    { item: "chartPresent", pass: Boolean(svg), actual: Boolean(svg), expected: true },
    { item: "baselineApplied", pass: baselineApplied, actual: baselineApplied, expected: true },
    { item: "windowFocused", pass: focus.windowFocused, actual: focus.windowFocused, expected: true },
    { item: "appActive", pass: focus.appActive, actual: focus.appActive, expected: true },
    { item: "overlayCount", pass: overlayCount >= 4, actual: overlayCount, expected: ">= 4" },
    { item: "macdCount", pass: macdCount === 3, actual: macdCount, expected: 3 },
    { item: "macdHistCount", pass: histCount >= 2, actual: histCount, expected: ">= 2" },
    {
      item: "color",
      pass: colorOk,
      actual: colorOk ? colorParts : colorFailures,
      expected: "8 个配色子项全部通过",
    },
    {
      item: "statisticalReadoutCount",
      pass: statisticalCount >= 4,
      actual: statisticalCount,
      expected: ">= 4",
    },
    {
      item: "statisticalUnitCount",
      pass: unitLabels.length >= 4,
      actual: unitLabels.length,
      expected: ">= 4",
    },
    { item: "t21TwoDecimals", pass: t21TwoDecimals, actual: t21Text, expected: "R² 保留两位小数" },
    { item: "maTooltipCount", pass: tooltipBefore >= 4, actual: tooltipBefore, expected: ">= 4" },
    {
      item: "hoverIndexPresent",
      pass: hoverIndex !== "",
      actual: hoverIndex,
      expected: "非空 data-hover-index",
    },
    {
      item: "decimalsOk",
      pass: decimalsOk,
      actual: maEntries.filter((entry) => !/\d[.,]\d{2}/.test(entry.text)).map((entry) => entry.text),
      expected: "每条读数含两位小数",
    },
    {
      item: "tooltipParity",
      pass: tooltipParity.ok === true,
      actual: {
        sampled: tooltipParity.sampled,
        mismatches: tooltipParity.mismatches,
        unresolvedHover: tooltipParity.unresolvedHover,
      },
      expected: "每一根 hoverIndex===targetIndex 且读数与引擎逐点等值",
    },
    {
      item: "maFields",
      pass: maEntries.every((entry) => entry.value !== "" && entry.unit !== ""),
      actual: maEntries
        .filter((entry) => entry.value === "" || entry.unit === "")
        .map((entry) => entry.id),
      expected: "所有 ma-*/ov-* 的 data-value / data-unit 非空",
    },
  ];
  const failures = subchecks
    .filter((part) => !part.pass)
    .map((part) => `${part.item}: actual=${JSON.stringify(part.actual)} expected=${JSON.stringify(part.expected)}`);
  return {
    chartPresent: Boolean(svg),
    overlays,
    overlayCount,
    macd,
    macdCount,
    macdHistCount: histCount,
    colorSamples,
    colorOk,
    colorParts,
    colorFailures,
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
    baselineApplied,
    focus,
    focusOk: focus.windowFocused && focus.appActive,
    subchecks,
    failures,
    ok: failures.length === 0,
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

  const focus = collectFocus();
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
  const setSubs = async (ids: string[]) => {
    const select = document.querySelector<HTMLSelectElement>("[data-b2-sub-select]");
    if (!select) return false;
    for (const option of Array.from(select.options)) option.selected = ids.includes(option.value);
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
    // 主图叠加容量 2：选 4 个会被 slice 成前两个，T13 不渲染（nodes=0 假红）。
    const selected = await setOverlays(["T13", "T14"]);
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
      // CandleChart 的 0 轴属性值是面板 id（data-sub-zero="V08"），不是固定的 "1"。
      pass("V08 0 轴可见", document.querySelectorAll("[data-sub-zero='V08']").length === 1, {
        zeroAxis: document.querySelectorAll("[data-sub-zero='V08']").length,
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

  // 复位到产品默认基线（T01+T09 / M06+M01），避免取证改变视图并让下一次 renderLayer 状态泄漏
  await setOverlays(BASELINE_OVERLAYS);
  await setSubs(BASELINE_SUBS);

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
  // W-89 第 6 项：ok 与 failCount 的算法摊开并写明（第 10 条：不可判定 ≠ 通过 ≠ 失败）。
  // - assertionsOk：8 张卡齐全且没有任何 status="fail" 的 clause（产品断言，不含聚焦）；
  // - dataLimited（status="n/a"，如 V05 零带宽段）不算 fail、也不改 assertionsOk，只在卡片里单列；
  // - focusOk 是运行时前置条件；signable = assertionsOk && focusOk 是「可签」的唯一判据。
  const assertionsOk =
    cards.length === 8 && failCount === 0 && cards.every((item) => Boolean(item.ok));
  const focusOk = focus.windowFocused && focus.appActive;
  return {
    cardCount: cards.length,
    clauseCount,
    failCount,
    dataLimitedCount,
    assertionsOk,
    focusOk,
    failedCards: cards.filter((item) => !item.ok).map((item) => item.card),
    dataLimitedCards: cards
      .filter((item) => Number(item.dataLimited ?? 0) > 0)
      .map((item) => item.card),
    okRule:
      "ok = assertionsOk（产品断言，不含聚焦）；signable = assertionsOk && focusOk（可签的唯一判据）；status=n/a（dataLimited）不计 failCount、也不让 ok=false；未聚焦记 focusOk=false → 不可判定，不得签",
    cards,
    focus,
    ok: assertionsOk,
    signable: assertionsOk && focusOk,
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

/**
 * 口径页证据：真实跳转指标目录路由（P3），六分类全部展开后逐个已实现指标点选，
 * 校验四段存在且内容与 manifest 同源。
 *
 * P3 目录相对旧 P4 页有三处契约变化，选择器必须跟着变：
 * 1. 根标记 `data-catalog-root='p3'`；
 * 2. 分类懒挂载（首屏只挂 trend 24 行），必须先点开全部分类，DOM 才等于 manifest 全量；
 * 3. 行容器 `<li data-catalog-item>` 无点击 handler，真正的选择按钮是内部
 *    `button.catalog-row__select`；beta 由 `data-catalog-status` 承载
 *    （`data-catalog-completeness` 是「口径完整度」，与 status 不同维度，不得混用）。
 */
async function collectCatalogCheck(): Promise<Record<string, unknown>> {
  const previous = window.location.hash;
  window.location.hash = "#/catalog";
  const waitFor = async <T,>(probe: () => T | null, timeoutMs = 5_000, stepMs = 40) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = probe();
      if (value) return value;
      if (Date.now() > deadline) return null;
      await sleep(stepMs);
    }
  };

  const registry = await ipc.indicatorRegistry();
  const manifest = await ipc.indicatorManifest();
  const registryById = new Map(registry.indicators.map((item) => [item.id, item] as const));
  const manifestById = new Map(manifest.indicators.map((item) => [item.id, item] as const));
  // 逐项覆盖全部已实现指标（manifest 中 status != planned，当前 45），不再只抽样 B2 的 20 个
  const targetIds = registry.indicators.map((item) => item.id);
  const expectedBetaIds = manifest.indicators
    .filter((item) => item.status === "beta")
    .map((item) => item.id)
    .sort();

  const root = await waitFor(() => document.querySelector<HTMLElement>("[data-catalog-root='p3']"));
  if (root) {
    // 先等分组挂载：root 在 manifest 就绪前就已存在，过早扫 toggles 会拿到 0 个而漏展开。
    await waitFor(() => document.querySelectorAll("[data-catalog-cat-toggle]").length > 0, 5_000, 30);
    const toggles = Array.from(document.querySelectorAll<HTMLElement>("[data-catalog-cat-toggle]"));
    for (const toggle of toggles) {
      if (toggle.getAttribute("aria-expanded") !== "true") {
        toggle.click();
        await sleep(60);
      }
    }
    await waitFor(
      () =>
        document.querySelectorAll("[data-catalog-item]").length === manifest.indicators.length
          ? true
          : null,
      2_000,
      30,
    );
  }

  const listed = Array.from(document.querySelectorAll("[data-catalog-item]")).map(
    (element) => element.getAttribute("data-catalog-item") ?? "",
  );
  const betaIds = Array.from(
    document.querySelectorAll<HTMLElement>("[data-catalog-item][data-catalog-status='beta']"),
  ).map((element) => element.getAttribute("data-catalog-item") ?? "");
  const rootPresent = root !== null;

  const section = (name: string) =>
    document.querySelector<HTMLElement>(`[data-catalog-section='${name}']`);
  const activeOf = () =>
    document
      .querySelector<HTMLElement>("[data-catalog-detail]")
      ?.getAttribute("data-catalog-active") ?? "";

  const cards: Array<Record<string, unknown>> = [];
  for (const id of targetIds) {
    const row = document.querySelector<HTMLElement>(`[data-catalog-item='${id}']`);
    if (!row) {
      cards.push({ id, ok: false, reason: "条目缺失" });
      continue;
    }
    const select = row.querySelector<HTMLElement>("button.catalog-row__select");
    if (!select) {
      cards.push({ id, ok: false, reason: "缺少行内选择按钮" });
      continue;
    }
    select.click();
    // 点行容器不会切 activeId；必须等 detail 的 data-catalog-active 落到该项再读数
    const picked = await waitFor(() => (activeOf() === id ? id : null), 1_500, 30);
    if (!picked) {
      cards.push({ id, ok: false, reason: "选中未切换", active: activeOf() });
      continue;
    }
    const item = manifestById.get(id);
    const register = registryById.get(id);
    if (!item && !register) {
      cards.push({ id, ok: false, reason: "registry/manifest 无此指标" });
      continue;
    }
    const paramsCount = item ? item.params.length : (register?.params.length ?? 0);
    const warmupBars = item ? item.warmupBars : (register?.warmup ?? 0);
    const formula = section("formula");
    const params = section("params");
    const warmup = section("warmup");
    const boundary = section("boundary");
    const formulaText = formula?.querySelector("p")?.textContent?.trim() ?? "";
    const boundaryText = boundary?.querySelector("p")?.textContent?.trim() ?? "";
    const paramsText = params?.textContent ?? "";
    const warmupText = warmup?.querySelector("p")?.textContent?.trim() ?? "";
    const warmupMatch = warmupText.match(/首个有效值下标\s*(\d+)/);
    const paramRows = params?.querySelectorAll("tbody tr").length ?? 0;
    const expectedWarmupIndex = warmupBars > 0 ? warmupBars - 1 : null;
    const clauses = {
      formula: { ok: formulaText.length > 0, detail: formulaText.slice(0, 60) },
      params: {
        // 零参数项页面渲染「无参数。」/「默认参数 …」，不能按表格行数判
        ok:
          paramsCount === 0
            ? paramsText.includes("无参数") || paramsText.includes("默认参数")
            : paramRows === paramsCount,
        detail: `rows=${paramRows} expected=${paramsCount}`,
      },
      warmup: {
        ok:
          expectedWarmupIndex === null
            ? warmupText === "—"
            : Boolean(warmupMatch) &&
              Number(warmupMatch?.[1]) === expectedWarmupIndex &&
              warmupText.includes(String(warmupBars)),
        detail: `text="${warmupText.slice(0, 40)}" expected=${warmupBars}`,
      },
      boundary: { ok: boundaryText.length > 0, detail: boundaryText.slice(0, 60) },
    };
    const ok = clauses.formula.ok && clauses.params.ok && clauses.warmup.ok && clauses.boundary.ok;
    cards.push({ id, clauses, ok });
  }

  window.location.hash = previous || "#/workbench";
  await sleep(320);
  const betaSorted = [...betaIds].sort();
  const listedUnique = new Set(listed).size;
  return {
    route: "#/catalog",
    rootPresent,
    itemCount: listed.length,
    itemCountUnique: listedUnique,
    declaredCount: manifest.indicators.length,
    itemCountOk: listed.length === manifest.indicators.length && listedUnique === listed.length,
    betaIds,
    betaCount: betaIds.length,
    expectedBetaCount: expectedBetaIds.length,
    targetIds,
    cards,
    ok:
      rootPresent &&
      listed.length === manifest.indicators.length &&
      listedUnique === listed.length &&
      targetIds.every((id) => listed.includes(id)) &&
      betaSorted.length === expectedBetaIds.length &&
      betaSorted.every((id, index) => id === expectedBetaIds[index]) &&
      cards.length === targetIds.length &&
      cards.every((item) => Boolean(item.ok)),
  };
}

/** `compute.count` 事件原文。S-02.06-01 口径：count=本批新增实算（cache miss、去重后）、
 * instances=批内实例总数、skip=批内去重跳过；count=0 且 instances>0 表示热缓存全命中，不是零批次。 */
export interface ComputeCountEvent {
  tsMs: number;
  count: number;
  instances: number;
  skip: number;
  cacheHit: boolean;
  fields: Record<string, unknown>;
}

function lastComputeCount(events: TelemetryEventDto[] | undefined): ComputeCountEvent | null {
  const event = [...(events ?? [])].reverse().find((item) => item.name === "compute.count");
  if (!event) return null;
  const num = (key: string) => {
    const value = event.fields[key];
    return typeof value === "number" ? value : Number.NaN;
  };
  return {
    tsMs: event.tsMs,
    count: num("count"),
    instances: num("instances"),
    skip: num("skip"),
    cacheHit: event.fields["cacheHit"] === true,
    fields: event.fields,
  };
}

/** 冷/热批次形状判定：instances=50（批内总数）、skip=6（去重）、count 按冷 44 / 热 0。 */
function batchShapeOk(
  event: ComputeCountEvent | null,
  expect: { count: number; cacheHit: boolean },
): boolean {
  return (
    event !== null &&
    event.instances === 50 &&
    event.skip === 6 &&
    event.count === expect.count &&
    event.cacheHit === expect.cacheHit
  );
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
      computeCountEvent: lastComputeCount(after.recent),
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
  const coldComputeCount = lastComputeCount(telAfterCold.recent);

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
  const warmComputeCount = lastComputeCount(telAfterWarm.recent);
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

  // ---- 3b. S-02.06-01 批次口径：冷缓存 count=新增实算 44 / 热缓存 0，instances=50、skip=6 ----
  const coldBatchOk = batchShapeOk(coldComputeCount, { count: 44, cacheHit: false });
  const warmBatchOk = batchShapeOk(warmComputeCount, { count: 0, cacheHit: true });
  if (!coldBatchOk) {
    notes.push(`冷缓存批次口径不符：${JSON.stringify(coldComputeCount)}`);
  }
  if (!warmBatchOk) {
    notes.push(`热缓存批次口径不符：${JSON.stringify(warmComputeCount)}`);
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
  // W-93：b2Render.latency 只做字段化留档，**不设阈值**、不参与 ok / signable。
  // 291ms（回切样本 90 的单次 max）与 P95=31ms（跨样本 P95）不是同一统计量，
  // 加阈值就会被人拿来互相比较、折算成「变快了」，得出假结论。
  const b2Render: Record<string, unknown> = {
    ...(await collectB2RenderChecks(hooks)),
    latency: {
      scope: "warm 热切回（30 标的 × 3 批；maxMs=单次回切 max，p95Ms=跨样本 P95）",
      sample: warm.length,
      cacheHit: warmAllHit,
      pointwiseEqual: warmAllMatch,
      maxMs: round2(warmMaxTotal),
      p95Ms: warmP95 === null ? null : round2(warmP95),
      advisory:
        "仅供追因：maxMs 与 p95Ms 是不同统计量（单次样本 max vs 跨样本分位），不得互相比较或折算为「变快/变慢」；不设阈值、不参与 ok 与 signable。",
    },
  };
  const b3Render = await collectB3RenderChecks();
  const catalog = await collectCatalogCheck();
  if (!renderLayer.ok) notes.push("渲染层 DOM 断言未通过，见 verification.renderLayer");
  if (!b2Render.ok) notes.push("B2 渲染层 8 卡断言未通过，见 verification.b2Render");
  else if (b2Render.signable !== true) {
    notes.push("B2 渲染层断言通过但窗口未聚焦 → 不可判定，不得据此签（见 verification.b2Render.focusOk）");
  }
  if (!b3Render.ok) notes.push("B3 渲染层 13 指标断言未通过，见 verification.b3Render");
  if (!catalog.ok) notes.push("口径页 DOM 断言未通过，见 verification.catalog");

  // R-EV-02：env 由 diag.ts 统一写；commit 来自构建期 define，runtime/build 来自 Rust。
  const env = await collectEvidenceEnv("s2");
  const focus = collectFocus();
  // 统一外层 checks（S-02.06-01 四项），供 diag-evidence.sh 按 schema 聚合归属。
  const checks = [
    {
      id: "s20601-event-count-burst120",
      card: "S-02.06-01",
      ac: "AC-02.06-01",
      layer: "runtime",
      passed: burst120.passed && burst120.requestsIssued === 1,
      detail: `连键 1→12→120：请求 ${burst120.requestsIssued} 次（应为 1）`,
    },
    {
      id: "s20601-event-count-burst60",
      card: "S-02.06-01",
      ac: "AC-02.06-01",
      layer: "runtime",
      passed: burst60.passed && burst60.requestsIssued === 1,
      detail: `连键 1→12→60：请求 ${burst60.requestsIssued} 次（应为 1）`,
    },
    {
      id: "s20601-batch-cold",
      card: "S-02.06-01",
      ac: "AC-02.06-01",
      layer: "runtime",
      passed: coldBatchOk && coldAllMiss,
      detail: `冷缓存批次 count/instances/skip=${JSON.stringify(coldComputeCount)}，全 miss=${coldAllMiss}`,
    },
    {
      id: "s20601-batch-warm",
      card: "S-02.06-01",
      ac: "AC-02.06-01",
      layer: "runtime",
      passed: warmBatchOk && warmAllHit && warmAllMatch,
      detail: `热缓存批次 count/instances/skip=${JSON.stringify(warmComputeCount)}，全命中=${warmAllHit}，逐点一致=${warmAllMatch}`,
    },
  ];
  // 第 30 条：顶层 ok 必须覆盖全部 verification 子块——漏一个维度就等于让红证据显示通过。
  // 历史事故：catalog 整块未聚合，45 张目录卡全红（rootPresent=false、25 个条目缺失）而顶层 ok=true。
  const verificationBlocks = { renderLayer, b2Render, b3Render, catalog };
  const checksOk = checks.every((item) => item.passed);
  const verificationOk = Object.values(verificationBlocks).every((block) => block.ok === true);
  const catalogOk = Boolean(catalog.ok);
  const ok = checksOk && verificationOk;

  const payload = {
    schemaVersion: 1,
    kind: "aka-s2-evidence",
    suite: "s2",
    ok,
    checksOk,
    verificationOk,
    catalogOk,
    checks,
    env,
    windowFocused: focus.windowFocused,
    appActive: focus.appActive,
    generatedAt: new Date().toISOString(),
    // R-EV-02：dump 自带 finishedAt，供 evidence-run 回填到 meta.dump（禁止手写）
    finishedAt: new Date().toISOString(),
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
        "compute.count 每次 calc 请求发 1 条；字段 count=本批新增实算条数（cache miss，去重后）、instances=批内实例总数（本项目 50）、skip=批内去重跳过（6）、cacheHit=全命中；热缓存 count=0 不等于没算过。连键断言的是「请求只发 1 次」，不是「只算 1 个实例」",
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
      /** S-02.06-01：最近一次冷切换的 compute.count 原文（count=新增实算、instances、skip、cacheHit） */
      computeCount: coldComputeCount,
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
      /** S-02.06-01：最近一次热切回的 compute.count 原文（count=0、instances=50 → 全命中，不是零批次） */
      computeCount: warmComputeCount,
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
    /** S-02.06-01 批次口径判据：一次切换 1 个 compute.count；cold.count=44 / warm.count=0；instances=50 才是非零批次 */
    batchCompute: {
      criterion:
        "count=本批新增实算（cache miss、去重后）；instances=批内实例总数 50；skip=批内去重 6；冷缓存 count=44、热缓存 count=0；count=0 且 instances>0 为全命中，不是零批次",
      cold: coldComputeCount,
      warm: warmComputeCount,
      coldOk: coldBatchOk,
      warmOk: warmBatchOk,
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
