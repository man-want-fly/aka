/**
 * S-02.02-02 复权切换实机取证（AC-02.02-03 及补1/补2、AC-02.02-04 及补1/补2）。
 *
 * 数据层：直接走 `get_bars`，覆盖 `600519.SH` 在 2024-04-29 的显式除权夹具——
 *   前复权连续、不复权出现约 -50% 断崖、后复权连续且价格高于不复权；
 *   锚点取数据集首末交易日，不随请求区间变化；三口径成交量完全相同。
 * 渲染层：全部通过真实 DOM（分段按钮 / 主图叠加多选 / 抽屉按钮 / 悬停读数）驱动与断言，
 *   不读 React 状态来替代 DOM。
 * 运行时：点真实「周期 / 复权」按钮，从 telemetry 读 `switch.period_ms`、`switch.adj_ms`，
 *   要求 ≤150ms（AC-02.02-02）。
 */

import { ipc } from "../../lib/ipc";
import type { BarsResponse, CalcResponse, TelemetrySummary } from "../../lib/types";

type Adj = "none" | "qfq" | "hfq";

interface Check {
  id: string;
  ac: string;
  layer: "data" | "render" | "runtime";
  passed: boolean;
  detail: string;
}

export interface S20202Hooks {
  getActiveCode: () => string;
  setCode: (code: string) => void;
  bars: () => BarsResponse | null;
  calc: () => CalcResponse | null;
  setDateRange: (from: string, to: string) => void;
  clearDateRange: () => void;
  waitReady: (label: string, timeoutMs?: number) => Promise<void>;
  telemetry: () => Promise<TelemetrySummary>;
}

const SECURITY = "600519.SH";
const SPLIT_DATE = "2024-04-29";
const APR_FROM = "2024-04-01";
const APR_TO = "2024-05-31";

/** 与 CandleChart 同口径的绘图区常量 */
const LEFT = 6;
const RIGHT = 938;

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
const q = <T extends Element>(selector: string) => document.querySelector<T>(selector);
const qa = <T extends Element>(selector: string) => Array.from(document.querySelectorAll<T>(selector));
const num = (element: Element | null, name: string) =>
  Number(element?.getAttribute(name) ?? "NaN");

const svg = () => {
  const node = q<SVGSVGElement>('[data-chart="candle"]');
  if (!node) throw new Error("图表未渲染");
  return node;
};

/** 图表 viewBox 高度：副图多时 CandleChart 会加高，不能写死 */
const chartHeight = () => {
  const box = (svg().getAttribute("viewBox") ?? "0 0 1000 738").trim().split(/\s+/);
  return Number(box[3]);
};

const geometry = () => {
  const rect = svg().getBoundingClientRect();
  const scale = Math.min(rect.width / 1000, rect.height / chartHeight());
  return {
    rect,
    scale,
    offsetX: (rect.width - 1000 * scale) / 2,
    offsetY: (rect.height - chartHeight() * scale) / 2,
  };
};

const clientPoint = (xUser: number, yUser: number) => {
  const { rect, scale, offsetX, offsetY } = geometry();
  return {
    clientX: rect.left + offsetX + xUser * scale,
    clientY: rect.top + offsetY + yUser * scale,
  };
};

const viewInfo = () => {
  const node = svg();
  return {
    start: num(node, "data-view-start"),
    end: num(node, "data-view-end"),
    total: num(node, "data-bar-count"),
    count: num(node, "data-view-end") - num(node, "data-view-start") + 1,
  };
};

const candleRect = (date: string) =>
  q(`[data-candle][data-date="${date}"]`);

const closeOf = (date: string) => {
  const value = Number(candleRect(date)?.getAttribute("data-close"));
  if (!Number.isFinite(value)) throw new Error(`${date} 的 K 线不在可视区`);
  return value;
};

const badge = () => q("[data-adj-badge]");

const readoutValue = (selector: string) =>
  q(selector)?.getAttribute("data-value") ?? null;

const volumeText = () =>
  qa("[data-readout='1'] span")
    .map((element) => (element.textContent ?? "").trim())
    .find((text) => text.startsWith("量 ")) ?? "";

const overlayPath = (id: string, key: string) =>
  q<SVGPathElement>(`[data-overlay="${id}"][data-overlay-key="${key}"]`);

const pathOf = (id: string, key: string) => {
  const path = overlayPath(id, key);
  if (!path) throw new Error(`叠加线 ${id}.${key} 未渲染`);
  return path.getAttribute("d") ?? "";
};

const pathBreaks = (d: string) => (d.match(/M/g) ?? []).length;

const seriesValue = (calc: CalcResponse | null, indicatorId: string, key: string, index: number) => {
  const output = calc?.series
    .find((item) => item.indicatorId === indicatorId)
    ?.outputs.find((item) => item.key === key);
  const value = output?.values[index];
  return value !== null && value !== undefined && Number.isFinite(value) ? value : null;
};

const barsOf = (adj: Adj, from?: string, to?: string) =>
  ipc.getBars({ security: SECURITY, timeframe: "D", adj, from, to });

const closeRatio = (bars: BarsResponse, index: number) =>
  bars.bars[index].close / bars.bars[index - 1].close;

const indexOfDate = (bars: BarsResponse, date: string) =>
  bars.bars.findIndex((bar) => bar.date === date);

const volumeByDate = (bars: BarsResponse) =>
  Object.fromEntries(bars.bars.map((bar) => [bar.date, bar.volume]));

/** 点真实分段按钮；已选中时不重复点击（重复点击不产生切换事件）。 */
const switchAdj = async (hooks: S20202Hooks, mode: Adj) => {
  const button = q<HTMLButtonElement>(`[data-adj-mode="${mode}"]`);
  if (!button) throw new Error(`复权按钮 ${mode} 不存在`);
  if (button.getAttribute("aria-pressed") === "true") return;
  button.click();
  await hooks.waitReady(`切换到复权 ${mode}`);
};

const switchTimeframe = async (hooks: S20202Hooks, mode: "D" | "W" | "M") => {
  const button = q<HTMLButtonElement>(`[data-timeframe="${mode}"]`);
  if (!button) throw new Error(`周期按钮 ${mode} 不存在`);
  if (button.getAttribute("aria-pressed") === "true") return;
  button.click();
  await hooks.waitReady(`切换到周期 ${mode}`);
};

/** 用工具栏多选（真实 DOM 点击事件）设置主图叠加，模拟用户勾选/取消。 */
const setOverlays = async (hooks: S20202Hooks, ids: string[], label: string) => {
  const select = q<HTMLSelectElement>("[data-b2-overlay-select]");
  if (!select) throw new Error("主图叠加多选不存在");
  // React 对 <select> 的 onChange 走原生 change 事件（select 不区分 single/multiple），
  // 但 select.value 只取首个选中项，直接改选中态再发事件仍可能被判定为「无变化」；
  // 先清空再设目标，且 change / click 都发，保证状态一定推进。
  const selectOptions = (values: string[]) => {
    Array.from(select.options).forEach((option) => {
      option.selected = values.includes(option.value);
    });
    select.dispatchEvent(new Event("change", { bubbles: true }));
    select.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  };
  selectOptions([]);
  await sleep(120);
  const afterClear = Number(
    q("[data-b2-overlay-select]")?.getAttribute("data-overlay-count") ?? "-9",
  );
  if (ids.length > 0) selectOptions(ids);
  await sleep(120);
  const afterSet = Number(
    q("[data-b2-overlay-select]")?.getAttribute("data-overlay-count") ?? "-9",
  );
  let count = -1;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sleep(220);
    count = Number(
      q("[data-b2-overlay-select]")?.getAttribute("data-overlay-count") ?? "-1",
    );
    if (count === ids.length) break;
  }
  if (count !== ids.length) {
    throw new Error(
      `主图叠加未按预期更新：期望 ${ids.length} 个，清空后 ${afterClear} / 设置后 ${afterSet} / 轮询 ${count} 个`,
    );
  }
  await hooks.waitReady(label, 3000);
};

/** 同理设置副图指标（成交量格固定在第一格，不在此列）。 */
const setSubs = async (hooks: S20202Hooks, ids: string[], label: string) => {
  const select = q<HTMLSelectElement>("[data-b2-sub-select]");
  if (!select) throw new Error("副图多选不存在");
  const selectOptions = (values: string[]) => {
    Array.from(select.options).forEach((option) => {
      option.selected = values.includes(option.value);
    });
    select.dispatchEvent(new Event("change", { bubbles: true }));
    select.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  };
  selectOptions([]);
  await sleep(120);
  if (ids.length > 0) selectOptions(ids);
  let panels: string[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sleep(220);
    panels = qa("[data-sub-panel]").map(
      (element) => element.getAttribute("data-sub-panel") ?? "",
    );
    if (ids.every((id) => panels.includes(id))) break;
  }
  if (!ids.every((id) => panels.includes(id))) {
    throw new Error(`副图未按预期更新：期望 ${ids.join(",")}，实际 ${panels.join(",")}`);
  }
  await hooks.waitReady(label, 3000);
};

const openDrawer = async () => {
  if (q("[data-indicator-drawer]")) return;
  const trigger = q<HTMLElement>("[data-drawer-trigger]");
  if (!trigger) throw new Error("抽屉触发按钮不存在");
  trigger.click();
  for (let attempt = 0; attempt < 40 && !q("[data-indicator-drawer]"); attempt += 1) {
    await sleep(60);
  }
  await sleep(120);
};

const closeDrawer = async () => {
  q<HTMLElement>("[data-drawer-close]")?.click();
  await sleep(120);
};

const searchDrawer = async (text: string) => {
  const field = q<HTMLInputElement>("[data-drawer-search]");
  if (!field) throw new Error("抽屉搜索框不存在");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(320);
};

/** 悬停到可视窗口内第 rel 根（0 起），以图表自身 data-hover-index 为准确认落地。 */
const hoverRel = async (rel: number) => {
  const node = svg();
  const { count } = viewInfo();
  const step = (RIGHT - LEFT) / Math.max(1, count);
  const point = clientPoint(LEFT + rel * step + step / 2, 150);
  const dispatch = () =>
    node.dispatchEvent(
      new MouseEvent("mousemove", {
        clientX: point.clientX,
        clientY: point.clientY,
        bubbles: true,
        cancelable: true,
      }),
    );
  dispatch();
  await sleep(90);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = Number(q('[data-readout="1"]')?.getAttribute("data-hover-index") ?? "NaN");
    if (Number.isFinite(current) && current === rel) return;
    dispatch();
    await sleep(140);
  }
  throw new Error(`悬停未落到第 ${rel} 根`);
};

/** 悬停到指定日期，返回该根的读数（T01 SMA、T09 三轨、成交量、叠加路径） */
const probeDate = async (date: string) => {
  const frame = hooksBars();
  if (!frame) throw new Error("K 线未就绪");
  const absolute = indexOfDate(frame, date);
  if (absolute < 0) throw new Error(`${date} 不在当前区间`);
  const rel = absolute - viewInfo().start;
  if (rel < 0 || rel >= viewInfo().count) throw new Error(`${date} 不在可视区`);
  await hoverRel(rel);
  const t01 = readoutValue('[data-readout="ma-T01"]');
  const boll = qa('[data-readout^="ov-T09-"]').map((element) =>
    element.getAttribute("data-value") ?? "",
  );
  return {
    volume: volumeText(),
    t01: t01 === null || t01 === "" ? null : Number(t01),
    boll: boll.map((value) => (value === "" ? null : Number(value))),
    t01Path: pathOf("T01", "sma"),
    bollUpperPath: pathOf("T09", "upper"),
  };
};

/** 由调用方在 runS20202Diagnostics 内注入，避免 probeDate 再传参 */
let hooksBars: () => BarsResponse | null = () => null;

const waitTelemetry = async (
  hooks: S20202Hooks,
  names: string[],
  minCount: number,
  timeoutMs = 3000,
) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const summary = await hooks.telemetry();
    const hits = summary.recent.filter((event) => names.includes(event.name));
    if (hits.length >= minCount || Date.now() > deadline) return hits;
    await sleep(120);
  }
};

export async function runS20202Diagnostics(hooks: S20202Hooks) {
  hooksBars = hooks.bars;
  const checks: Check[] = [];
  const push = (
    id: string,
    ac: string,
    layer: Check["layer"],
    passed: boolean,
    detail: string,
  ) => checks.push({ id, ac, layer, passed, detail });
  const attempt = async (
    id: string,
    ac: string,
    layer: Check["layer"],
    run: () => Promise<{ passed: boolean; detail: string }>,
  ) => {
    try {
      const result = await run();
      push(id, ac, layer, result.passed, result.detail);
    } catch (err) {
      push(
        id,
        ac,
        layer,
        false,
        `异常：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // ---------------- 数据层：直接走 get_bars ----------------
  const qfqApril = await barsOf("qfq", APR_FROM, APR_TO);
  const noneApril = await barsOf("none", APR_FROM, APR_TO);
  const hfqApril = await barsOf("hfq", APR_FROM, APR_TO);
  const splitIndex = indexOfDate(qfqApril, SPLIT_DATE);

  await attempt("D-01", "AC-02.02-03", "data", async () => {
    if (splitIndex < 1) throw new Error("4/29 不在前复权区间内");
    const ratio = closeRatio(qfqApril, splitIndex);
    return {
      passed: Math.abs(ratio - 1) <= 0.105,
      detail: `前复权 ${SPLIT_DATE} 收盘 ${qfqApril.bars[splitIndex].close.toFixed(2)} / 前一日 ${qfqApril.bars[
        splitIndex - 1
      ].close.toFixed(2)}，比值 ${ratio.toFixed(4)}（阈值 ±10.5%）`,
    };
  });

  await attempt("D-02", "AC-02.02-03", "data", async () => {
    if (splitIndex < 1) throw new Error("4/29 不在不复权区间内");
    const ratio = closeRatio(noneApril, splitIndex);
    return {
      passed: ratio <= 0.6,
      detail: `不复权 ${SPLIT_DATE} 比值 ${ratio.toFixed(4)}（应出现约 -50% 断崖，阈值 ≤0.6）`,
    };
  });

  await attempt("D-03", "AC-02.02-03", "data", async () => {
    if (splitIndex < 1) throw new Error("4/29 不在后复权区间内");
    const ratio = closeRatio(hfqApril, splitIndex);
    const levelOk = hfqApril.bars[splitIndex].close >= noneApril.bars[splitIndex].close;
    return {
      passed: Math.abs(ratio - 1) <= 0.105 && levelOk,
      detail: `后复权 ${SPLIT_DATE} 比值 ${ratio.toFixed(4)}（阈值 ±10.5%）· 收盘 ${hfqApril.bars[
        splitIndex
      ].close.toFixed(2)} ≥ 不复权 ${noneApril.bars[splitIndex].close.toFixed(2)}=${levelOk}`,
    };
  });

  await attempt("D-04", "AC-02.02-03（补1）", "data", async () => {
    const qfqFull = await barsOf("qfq");
    const noneFull = await barsOf("none");
    const anchorQfq = qfqFull.bars[qfqFull.bars.length - 1];
    const anchorNone = noneFull.bars[noneFull.bars.length - 1];
    const anchorOk =
      anchorQfq.date === anchorNone.date && Math.abs(anchorQfq.close - anchorNone.close) <= 0.01;
    // 锚点固定：同一交易日在「四月子区间」与「全量」的前复权收盘必须一致
    const subClose = qfqApril.bars[splitIndex].close;
    const fullClose = qfqFull.bars.find((bar) => bar.date === SPLIT_DATE)?.close ?? Number.NaN;
    const fixed = Math.abs(subClose - fullClose) <= 0.01;
    // 子区间前一日按当日因子换算：qfq = none × adj / anchorAdj
    const prevIndex = splitIndex - 1;
    const factor = noneApril.bars[prevIndex].adjFactor / anchorNone.adjFactor;
    const expected = noneApril.bars[prevIndex].close * factor;
    const converted = Math.abs(qfqApril.bars[prevIndex].close - expected) <= 0.02;
    return {
      passed: anchorOk && fixed && converted,
      detail: `锚点 ${anchorQfq.date} qfq=${anchorQfq.close.toFixed(2)} / none=${anchorNone.close.toFixed(
        2,
      )}；${SPLIT_DATE} 子区间=${subClose.toFixed(2)} 全量=${fullClose.toFixed(
        2,
      )}；前一日因子 ${factor} 期望 ${expected.toFixed(2)} 实际 ${qfqApril.bars[prevIndex].close.toFixed(2)}`,
    };
  });

  await attempt("D-05", "AC-02.02-03（补2）", "data", async () => {
    const qfqVol = volumeByDate(qfqApril);
    const hfqVol = volumeByDate(hfqApril);
    const diffs = noneApril.bars.filter(
      (bar) => qfqVol[bar.date] !== bar.volume || hfqVol[bar.date] !== bar.volume,
    );
    const sample = noneApril.bars[splitIndex]?.volume ?? Number.NaN;
    return {
      passed: diffs.length === 0 && sample === 12_345_600,
      detail: `三口径成交量逐日一致 ${noneApril.bars.length}/${noneApril.bars.length}（差异 ${diffs.length} 根）· ${SPLIT_DATE} 样本 ${sample} 股`,
    };
  });

  // ---------------- 渲染层：真实 DOM 驱动 ----------------
  let setupError: string | null = null;
  try {
    if (hooks.getActiveCode() !== SECURITY) {
      hooks.setCode(SECURITY);
      await hooks.waitReady(`切到 ${SECURITY}`);
    }
    await switchAdj(hooks, "qfq");
    await setOverlays(hooks, ["T01", "T09"], "归一化双叠加");
    hooks.setDateRange(APR_FROM, APR_TO);
    await hooks.waitReady("四月窗口");
  } catch (err) {
    setupError = err instanceof Error ? err.message : String(err);
    try {
      await ipc.diagWriteNamed(
        "s20202-probe.json",
        JSON.stringify(
          {
            at: new Date().toISOString(),
            error: setupError,
            href: window.location.href,
            readyState: document.readyState,
            bodyChildren: document.body.childElementCount,
            allNodes: document.querySelectorAll("*").length,
            charts: document.querySelectorAll("[data-chart]").length,
            candles: document.querySelectorAll("[data-candle]").length,
            errorBox:
              document.querySelector(".error-box")?.textContent?.slice(0, 200) ?? null,
            chartEmpty:
              document.querySelector('[class*="chart"]')?.textContent?.slice(0, 120) ?? null,
            adj: window.localStorage.getItem("aka.chart.adj"),
            overlays: window.localStorage.getItem("aka.chart.overlays"),
          },
          null,
          2,
        ),
      );
    } catch {
      /* 探针失败不覆盖原始异常 */
    }
  }

  if (setupError) {
    for (const id of ["R-01", "R-02", "R-03", "R-04", "R-05"]) {
      push(id, "S-02.02-02", "render", false, `初始化失败：${setupError}`);
    }
  } else {
    const prevDate = qfqApril.bars[splitIndex - 1].date;
    const qfqProbe = {
      close: closeOf(SPLIT_DATE),
      prevClose: closeOf(prevDate),
    };
    const qfqSnapshot = await probeDate(SPLIT_DATE).catch(() => null);
    const qfqBars = hooks.bars();
    const qfqCalc = hooks.calc();
    const qfqCalcIndex = qfqBars ? indexOfDate(qfqBars, SPLIT_DATE) : -1;

    // ---- 不复权 ----
    await switchAdj(hooks, "none");
    const noneProbe = {
      close: closeOf(SPLIT_DATE),
      prevClose: closeOf(prevDate),
    };
    const noneSnapshot = await probeDate(SPLIT_DATE).catch(() => null);
    const noneBars = hooks.bars();
    const noneCalc = hooks.calc();
    const noneCalcIndex = noneBars ? indexOfDate(noneBars, SPLIT_DATE) : -1;
    const badgeNone = badge();
    const noneText = (badgeNone?.textContent ?? "").trim();

    push(
      "R-01",
      "AC-02.02-03",
      "render",
      qfqProbe.close / qfqProbe.prevClose >= 0.895 &&
        noneProbe.close / noneProbe.prevClose <= 0.6 &&
        Math.abs(qfqProbe.prevClose - noneProbe.prevClose) > 1 &&
        badgeNone !== null &&
        noneText === "不复权",
      `前复权 DOM 比值 ${(qfqProbe.close / qfqProbe.prevClose).toFixed(4)}（${qfqProbe.prevClose.toFixed(
        2,
      )}→${qfqProbe.close.toFixed(2)}）· 不复权 DOM 比值 ${(
        noneProbe.close / noneProbe.prevClose
      ).toFixed(4)}（${noneProbe.prevClose.toFixed(2)}→${noneProbe.close.toFixed(
        2,
      )}）· 前一日收盘差 ${Math.abs(qfqProbe.prevClose - noneProbe.prevClose).toFixed(
        2,
      )} · 徽标「${noneText}」`,
    );

    push(
      "R-02",
      "AC-02.02-03（补2）",
      "render",
      Boolean(qfqSnapshot && noneSnapshot) &&
        qfqSnapshot!.volume === noneSnapshot!.volume &&
        qfqSnapshot!.volume.startsWith("量 ") &&
        /万\s*手/.test(qfqSnapshot!.volume),
      `同日悬停成交量 前复权「${qfqSnapshot?.volume ?? "无"}」/ 不复权「${
        noneSnapshot?.volume ?? "无"
      }」（须完全相同；12,345,600 股 → 全局口径「${
        qfqSnapshot?.volume.replace(/^量\s*/, "") ?? "—"
      }」）`,
    );

    push(
      "R-03",
      "AC-02.02-04（补2）",
      "render",
      Boolean(qfqSnapshot && noneSnapshot) &&
        qfqSnapshot!.t01 !== null &&
        noneSnapshot!.t01 !== null &&
        Math.abs(qfqSnapshot!.t01! - noneSnapshot!.t01!) > 0.5 &&
        qfqSnapshot!.t01Path !== noneSnapshot!.t01Path &&
        qfqSnapshot!.bollUpperPath !== noneSnapshot!.bollUpperPath &&
        pathBreaks(qfqSnapshot!.t01Path) === 1 &&
        pathBreaks(noneSnapshot!.t01Path) === 1 &&
        pathBreaks(noneSnapshot!.bollUpperPath) === 1,
      `SMA 读数 前复权 ${qfqSnapshot?.t01 ?? "—"} / 不复权 ${noneSnapshot?.t01 ?? "—"} · 路径段数 ${
        qfqSnapshot ? pathBreaks(qfqSnapshot.t01Path) : "—"
      }/${noneSnapshot ? pathBreaks(noneSnapshot.t01Path) : "—"}（1 = 无断裂）`,
    );

    // 数据层：切换复权后叠加与副图指标按新口径重算（取同一根的序列值）
    await attempt("D-06", "AC-02.02-02", "data", async () => {
      const idxOk = qfqCalcIndex === noneCalcIndex && qfqCalcIndex >= 0;
      const qfqT01 = seriesValue(qfqCalc, "T01", "sma", qfqCalcIndex);
      const noneT01 = seriesValue(noneCalc, "T01", "sma", noneCalcIndex);
      const qfqDif = seriesValue(qfqCalc, "M06", "dif", qfqCalcIndex);
      const noneDif = seriesValue(noneCalc, "M06", "dif", noneCalcIndex);
      const recalced =
        qfqT01 !== null &&
        noneT01 !== null &&
        qfqDif !== null &&
        noneDif !== null &&
        Math.abs(qfqT01 - noneT01) > 0.5 &&
        Math.abs(qfqDif - noneDif) > 0.05;
      const barsAdjOk = noneBars?.adj === "none" && qfqBars?.adj === "qfq";
      return {
        passed: idxOk && recalced && barsAdjOk,
        detail: `同一根索引 ${qfqCalcIndex} · SMA 前复权 ${qfqT01?.toFixed(2) ?? "—"} / 不复权 ${
          noneT01?.toFixed(2) ?? "—"
        } · MACD.dif ${qfqDif?.toFixed(3) ?? "—"} / ${
          noneDif?.toFixed(3) ?? "—"
        } · bars.adj=${qfqBars?.adj}/${noneBars?.adj}`,
      };
    });

    // ---- 后复权 ----
    await switchAdj(hooks, "hfq");
    const hfqProbe = {
      close: closeOf(SPLIT_DATE),
      prevClose: closeOf(prevDate),
    };
    const hfqSnapshot = await probeDate(SPLIT_DATE).catch(() => null);
    push(
      "R-04",
      "AC-02.02-03",
      "render",
      Math.abs(hfqProbe.close / hfqProbe.prevClose - 1) <= 0.105 &&
        hfqProbe.close >= noneProbe.close &&
        badge() === null &&
        Boolean(hfqSnapshot) &&
        hfqSnapshot!.volume === (qfqSnapshot?.volume ?? ""),
      `后复权 DOM 比值 ${(hfqProbe.close / hfqProbe.prevClose).toFixed(4)}（${hfqProbe.prevClose.toFixed(
        2,
      )}→${hfqProbe.close.toFixed(2)}）· 高于不复权=${hfqProbe.close >= noneProbe.close} · 徽标=${badge() ? "有" : "无"} · 成交量「${
        hfqSnapshot?.volume ?? "无"
      }」`,
    );

    await switchAdj(hooks, "qfq");
    push(
      "R-05",
      "AC-02.02-03",
      "render",
      badge() === null,
      `切回前复权后口径徽标=${badge() ? "仍存在" : "已移除"}`,
    );

    // ---- 容量与移除（先恢复全量区间） ----
    hooks.clearDateRange();
    await hooks.waitReady("恢复全量区间");
    await setOverlays(hooks, ["T01", "T09"], "容量用例前归一化");

    let capacityDetail = "";
    let capacityOk = false;
    await openDrawer();
    try {
      await searchDrawer("Envelopes");
      const button = q<HTMLButtonElement>('[data-drawer-add="T08:main"]');
      if (!button) throw new Error("T08 主图按钮不在抽屉列表");
      const full = button.getAttribute("data-drawer-full") === "1";
      const ariaDisabled = button.getAttribute("aria-disabled") === "true";
      const title = button.getAttribute("title") ?? "";
      button.click();
      await sleep(160);
      const hint = (q("[data-drawer-hint]")?.textContent ?? "").trim();
      const count = q("[data-b2-overlay-select]")?.getAttribute("data-overlay-count") ?? "";
      capacityOk =
        full &&
        ariaDisabled &&
        title === "主图最多 2 个叠加，请先移除一个" &&
        hint === "主图最多 2 个叠加，请先移除一个" &&
        count === "2" &&
        qa('[data-overlay="T08"]').length === 0;
      capacityDetail = `T08 full=${full} aria-disabled=${ariaDisabled} title「${title}」点击提示「${hint}」叠加数 ${count}·T08 未上图=${qa(
        '[data-overlay="T08"]',
      ).length === 0}`;
    } finally {
      await closeDrawer();
    }
    push("R-06", "AC-02.02-04", "render", capacityOk, capacityDetail);

    const beforeRemove = {
      legend: Boolean(q("[data-overlay-legend]")),
      t01: Boolean(q('[data-legend-line="T01.sma"]')),
    };
    await setOverlays(hooks, ["T01"], "只留 SMA");
    const oneOverlay = {
      legend: Boolean(q("[data-overlay-legend]")),
      t01: Boolean(q('[data-legend-line="T01.sma"]')),
      t09: qa('[data-overlay="T09"]').length,
    };
    await setOverlays(hooks, [], "清空叠加");
    const zeroOverlay = {
      legend: Boolean(q("[data-overlay-legend]")),
      lines: qa("[data-legend-line]").length,
      overlayPaths: qa("[data-overlay]").length,
      candles: qa("[data-candle]").length,
    };
    let drawerUnchecked: boolean | null = null;
    await openDrawer();
    try {
      await searchDrawer("SMA");
      drawerUnchecked =
        q('[data-drawer-add="T01:main"]')?.getAttribute("data-drawer-added") === "0";
    } finally {
      await closeDrawer();
    }
    push(
      "R-07",
      "AC-02.02-04（补1）",
      "render",
      beforeRemove.legend &&
        beforeRemove.t01 &&
        oneOverlay.legend &&
        oneOverlay.t01 &&
        oneOverlay.t09 === 0 &&
        !zeroOverlay.legend &&
        zeroOverlay.lines === 0 &&
        zeroOverlay.overlayPaths === 0 &&
        zeroOverlay.candles > 0 &&
        drawerUnchecked === true,
      `移除前图例=${beforeRemove.legend}/T01 线=${beforeRemove.t01}；只剩 T01 时图例=${oneOverlay.legend}/T09=${oneOverlay.t09}；清空后图例=${zeroOverlay.legend}、图例行=${zeroOverlay.lines}、叠加路径=${zeroOverlay.overlayPaths}、K 线 ${zeroOverlay.candles} 根；抽屉 T01 未勾选=${drawerUnchecked}`,
    );
    await setOverlays(hooks, ["T01", "T09"], "恢复默认双叠加");

    // ---------------- 运行时：真实按钮 + telemetry ----------------
    // AC-02.02-02 要求 3 个副图（成交量、MACD、RSI）全部按周线重算，先把副图归一到这三格
    await setSubs(hooks, ["M06", "M01"], "归一化三副图");
    const subPanels = qa("[data-sub-panel]").map(
      (element) => element.getAttribute("data-sub-panel") ?? "",
    );
    const dailyBars = Number(svg().getAttribute("data-bar-count") ?? "NaN");
    const dailyMacd = q<SVGPathElement>('[data-macd="dif"]')?.getAttribute("d") ?? "";
    const dailyRsi = q<SVGPathElement>('[data-sub="M01"][data-sub-key="rsi"]')?.getAttribute("d") ?? "";
    const rangeDaily = q("[data-readout='1'] span")?.textContent ?? "";

    await switchTimeframe(hooks, "W");
    const weeklyBars = Number(svg().getAttribute("data-bar-count") ?? "NaN");
    const weeklyMacd = q<SVGPathElement>('[data-macd="dif"]')?.getAttribute("d") ?? "";
    const weeklyRsi = q<SVGPathElement>('[data-sub="M01"][data-sub-key="rsi"]')?.getAttribute("d") ?? "";
    await switchTimeframe(hooks, "D");

    const switchEvents = await waitTelemetry(
      hooks,
      ["switch.period_ms", "switch.adj_ms"],
      5,
    );
    const periodEvents = switchEvents.filter((event) => event.name === "switch.period_ms");
    const adjEvents = switchEvents.filter((event) => event.name === "switch.adj_ms");
    const msOf = (event: { fields: Record<string, unknown> }) =>
      Number(event.fields.total_ms ?? event.fields.ms);

    const subsOk =
      subPanels.includes("VOL") &&
      subPanels.includes("M06") &&
      subPanels.includes("M01") &&
      subPanels.length === 3 &&
      Number.isFinite(dailyBars) &&
      Number.isFinite(weeklyBars) &&
      dailyBars !== weeklyBars &&
      dailyMacd !== "" &&
      weeklyMacd !== "" &&
      dailyMacd !== weeklyMacd &&
      dailyRsi !== "" &&
      weeklyRsi !== "" &&
      dailyRsi !== weeklyRsi;

    push(
      "RT-01",
      "AC-02.02-02",
      "runtime",
      periodEvents.length >= 2 &&
        periodEvents.every((event) => msOf(event) <= 150) &&
        subsOk,
      `switch.period_ms ${periodEvents.length} 条：${periodEvents
        .map((event) => `${msOf(event).toFixed(2)}ms`)
        .join(" / ") || "无"}（阈值 ≤150ms）· 副图 ${subPanels.join(
        "+",
      )}（${subPanels.length}/3）· 日→周 K 线 ${dailyBars}→${weeklyBars} 根 · MACD.dif 路径变化=${
        dailyMacd !== weeklyMacd
      } · RSI 路径变化=${dailyRsi !== weeklyRsi} · ${rangeDaily}`,
    );

    push(
      "RT-02",
      "AC-02.02-02",
      "runtime",
      adjEvents.length >= 3 &&
        adjEvents.every((event) => msOf(event) <= 150) &&
        adjEvents.every((event) =>
          ["none", "qfq", "hfq"].includes(String(event.fields.adj ?? "")),
        ),
      `switch.adj_ms ${adjEvents.length} 条：${adjEvents
        .map((event) => `${event.fields.adj ?? "?"}=${msOf(event).toFixed(2)}ms`)
        .join(" / ") || "无"}（阈值 ≤150ms）`,
    );

    // ---------------- 本地持久化 ----------------
    await attempt("D-07", "S-02.02-02", "data", async () => {
      const adj = window.localStorage.getItem("aka.chart.adj");
      let overlays: unknown = null;
      try {
        overlays = JSON.parse(window.localStorage.getItem("aka.chart.overlays") ?? "null");
      } catch {
        overlays = null;
      }
      const overlayOk =
        Array.isArray(overlays) &&
        (overlays as string[]).length === 2 &&
        ["T01", "T09"].every((id) => (overlays as string[]).includes(id));
      return {
        passed: adj === "qfq" && overlayOk,
        detail: `chart.adj=${adj} · chart.overlays=${JSON.stringify(overlays)}`,
      };
    });
  }

  const summary = (["data", "render", "runtime"] as const).map((layer) => {
    const list = checks.filter((check) => check.layer === layer);
    return `${layer} ${list.filter((check) => check.passed).length}/${list.length}`;
  });

  const report = {
    ok: checks.every((check) => check.passed),
    target: SECURITY,
    finishedAt: new Date().toISOString(),
    summary,
    checks,
  };
  await ipc.diagWriteNamed("s20202-evidence.json", JSON.stringify(report, null, 2));
  return report;
}
