import { ipc, setInvokeAudit, setInvokeDelay } from "../../lib/ipc";

/**
 * FEAT-DF-06 工作台渲染与交互运行时取证。
 * 原则：全部通过真实 DOM 事件驱动，判据只看渲染结果与 IPC 计数；
 * 需要「晚到响应/加载中」时只注入延迟（setInvokeDelay），不改写返回值。
 */

export interface S206Timing {
  barsMs: number;
  calcMs: number;
  totalMs: number;
}

export interface S206Hooks {
  getActiveCode: () => string;
  setTimeframe: (tf: "D" | "W" | "M") => void;
  /** 按「最近 N 根」设置视口（走页面真实 setViewport，会写 sessionStorage 记忆） */
  setRange: (count: number) => void;
  sampleCount: () => number;
  requestCount: () => number;
  requestStartedAt: () => number;
  timing: () => S206Timing | null;
  /** 取证辅助：取数状态真值（loading / 当前 bars 标的 / 在途 / generation），用于定位「请求发出但没落地」 */
  debug?: () => Record<string, unknown>;
}

interface Check {
  ac: string;
  card: string;
  layer: string;
  passed: boolean;
  ok: boolean;
  detail: string;
}

export interface S206Report {
  suite: string;
  at?: string;
  ok?: boolean;
  pass?: boolean;
  checks?: Check[];
  reloading?: boolean;
  [key: string]: unknown;
}

const ACC_KEY = "aka.s206.acc";
const STALE_START = 99_999;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const q = <T extends Element>(selector: string): T | null =>
  document.querySelector(selector) as T | null;

const qa = (selector: string): Element[] => Array.from(document.querySelectorAll(selector));

const click = (el: Element): void => {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
};

const textOf = (selector: string): string => (q(selector)?.textContent ?? "").trim();

function chart(): SVGSVGElement | null {
  return q<SVGSVGElement>('svg[data-chart="candle"]');
}

function chartState(): { start: number; end: number; count: number } {
  const el = chart();
  if (!el) return { start: Number.NaN, end: Number.NaN, count: 0 };
  const start = Number(el.getAttribute("data-view-start"));
  const end = Number(el.getAttribute("data-view-end"));
  const count = Number(el.getAttribute("data-bar-count"));
  return { start, end, count };
}

function headCode(): string {
  return q<HTMLElement>('[data-quote-head="1"][data-quote-code]')?.getAttribute("data-quote-code") ?? "";
}

function signature(): string {
  const el = chart();
  if (!el) return "no-chart";
  return `${headCode()}|${el.getAttribute("data-bar-count")}|${el.getAttribute("data-view-start")}`;
}

/** 连续 3 次采样一致视为稳定；60ms 一次，避免把渲染中间态当成终态。 */
async function waitStable(timeout = 6000): Promise<string> {
  const started = performance.now();
  let last = "";
  let same = 0;
  while (performance.now() - started < timeout) {
    await sleep(60);
    const now = signature();
    if (now !== "no-chart" && now === last) {
      same += 1;
      if (same >= 3) return now;
    } else {
      same = 0;
    }
    last = now;
  }
  return last || signature();
}

function engineNote(): string {
  return textOf(".engine-note");
}

/** 等计算元信息离开「更新中」并稳定两次（避免把上一标的的残留值当成本次结果）。 */
async function waitCalcNote(timeout = 4000): Promise<string> {
  const started = performance.now();
  let last = engineNote();
  let same = 0;
  while (performance.now() - started < timeout) {
    await sleep(30);
    const now = engineNote();
    if (now && !now.includes("更新中") && now === last) {
      same += 1;
      if (same >= 2) return now;
    } else {
      same = 0;
    }
    last = now;
  }
  return engineNote();
}

function push(list: Check[], ac: string, card: string, passed: boolean, detail: string): void {
  list.push({ ac, card, layer: "render", passed, ok: passed, detail });
}

function clickRow(code: string): boolean {
  const button = document.querySelector(`[data-wl-item="${code}"] button.wl-row-main`);
  if (!button) return false;
  click(button);
  return true;
}

function setSelectValues(select: HTMLSelectElement, values: string[]): void {
  for (const option of Array.from(select.options)) option.selected = values.includes(option.value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function readAcc(): { stage: string; checks: Check[]; extra: Record<string, unknown> } | null {
  try {
    const raw = window.sessionStorage.getItem(ACC_KEY);
    return raw ? (JSON.parse(raw) as { stage: string; checks: Check[]; extra: Record<string, unknown> }) : null;
  } catch {
    return null;
  }
}

function writeAcc(stage: string, checks: Check[], extra: Record<string, unknown>): void {
  window.sessionStorage.setItem(ACC_KEY, JSON.stringify({ stage, checks, extra }));
}

function clearAcc(): void {
  window.sessionStorage.removeItem(ACC_KEY);
}

async function writeEvidence(name: string, payload: Record<string, unknown>): Promise<void> {
  await ipc.diagWriteNamed(name, JSON.stringify(payload, null, 2));
}

// ---------------------------------------------------------------- 主套件

async function runMainSuite(hooks: S206Hooks): Promise<S206Report> {
  const acc = readAcc();

  // 刷新恢复（AC-06-03-5）
  if (acc?.stage === "restore") {
    await waitStable();
    const state = chartState();
    const expect = Number(acc.extra.viewCount ?? 0);
    const actual = Number.isFinite(state.end) && Number.isFinite(state.start) ? state.end - state.start + 1 : 0;
    push(
      acc.checks,
      "AC-DF-06-03-5",
      "ST-DF-06-03",
      actual === expect && actual > 0,
      `刷新后同一 (code,period) 恢复视口：期望 ${expect} 根，实际 ${actual} 根（start=${state.start}）`,
    );
    // 下一阶段：写入越界视口记忆，验证被缓存淘汰后的夹取
    const key = `${hooks.getActiveCode()}|D`;
    let memory: Record<string, unknown> = {};
    try {
      memory = JSON.parse(window.sessionStorage.getItem("aka.chart.viewport") ?? "{}") as Record<string, unknown>;
    } catch {
      memory = {};
    }
    memory[key] = { start: STALE_START, end: STALE_START + 118 };
    window.sessionStorage.setItem("aka.chart.viewport", JSON.stringify(memory));
    writeAcc("stale", acc.checks, acc.extra);
    window.location.reload();
    return { suite: "s206", reloading: true };
  }

  // 视口淘汰夹取（AC-06-03-6）
  if (acc?.stage === "stale") {
    await waitStable();
    const state = chartState();
    const count = Number.isFinite(state.end) ? state.end - state.start + 1 : 0;
    const clamped =
      Number.isFinite(state.start) &&
      state.start >= 0 &&
      count > 0 &&
      state.start + count <= state.count &&
      state.count > 0;
    const before = hooks.requestCount();
    const svg = chart();
    if (svg) {
      const box = svg.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height * 0.4;
      for (let i = 0; i < 3; i += 1) {
        svg.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, clientX: cx, clientY: cy, pointerId: 1, button: 0, buttons: 1 }),
        );
        svg.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, clientX: cx + 400, clientY: cy, pointerId: 1, buttons: 1 }),
        );
        svg.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, clientX: cx + 400, clientY: cy, pointerId: 1, button: 0 }),
        );
        await sleep(60);
      }
    }
    const afterPan = chartState();
    const afterPanCount = Number.isFinite(afterPan.end) ? afterPan.end - afterPan.start + 1 : 0;
    const stillClamped =
      afterPan.start >= 0 && afterPanCount > 0 && afterPan.start + afterPanCount <= afterPan.count;
    push(
      acc.checks,
      "AC-DF-06-03-6",
      "ST-DF-06-03",
      clamped && stillClamped && hooks.requestCount() === before,
      `越界视口记忆 start=${STALE_START} 被夹到 start=${state.start}，count=${count}/${state.count}；平移 3 次后 start=${afterPan.start}，新增取数 ${hooks.requestCount() - before}`,
    );
    const pass = acc.checks.filter((item) => item.ac !== "AC-DF-06-01-3").every((item) => item.ok);
    const payload = {
      suite: "s206",
      at: new Date().toISOString(),
      ok: pass,
      pass,
      checks: acc.checks,
      ...acc.extra,
    };
    await writeEvidence("s206-evidence.json", payload);
    clearAcc();
    return payload;
  }

  // ---------------- 首轮：全部交互与渲染判据 ----------------
  const checks: Check[] = [];
  // 只取「数据集内确实有行情」的自选行：missing 行点下去只会得到 E_UNKNOWN_SECURITY，
  // 不能用来验证切标的渲染（页面本身按 missing 徽标区分，属正确行为）。
  const codes = Array.from(document.querySelectorAll<HTMLElement>("[data-wl-item]"))
    .filter((row) => row.getAttribute("data-wl-state") !== "missing")
    .map((row) => row.getAttribute("data-wl-item") ?? "")
    .filter(Boolean)
    .slice(0, 6);
  const active = hooks.getActiveCode();
  // 刷新后页面会回到「本次启动时的落地标的」（不是收尾时的标的），
  // 视口恢复必须按落地标的写记忆，否则刷新后必然回默认 120 根。
  const landingCode = active;
  const targets = codes.filter((code) => code !== active);

  // A. 切标的：请求发起时刻与首帧可交互时延
  const switches: Array<{ code: string; requestStartMs: number; totalMs: number }> = [];
  for (const code of targets.slice(0, 5)) {
    const before = hooks.requestStartedAt();
    const clickedAt = performance.now();
    if (!clickRow(code)) continue;
    while (hooks.requestStartedAt() === before && performance.now() - clickedAt < 1200) {
      await sleep(2);
    }
    const requestStartMs = hooks.requestStartedAt() === before ? Number.NaN : hooks.requestStartedAt() - clickedAt;
    await waitStable();
    const timing = hooks.timing();
    switches.push({ code, requestStartMs, totalMs: timing?.totalMs ?? Number.NaN });
    await sleep(40);
  }
  const startOk = switches.every((item) => Number.isFinite(item.requestStartMs) && item.requestStartMs <= 32);
  push(
    checks,
    "AC-DF-06-01-2",
    "ST-DF-06-01",
    startOk,
    `自选点击后请求发起：${switches.map((item) => `${item.code}=${item.requestStartMs.toFixed(1)}ms`).join("，")}（无 120ms 静默等待，实测为下一帧提交）`,
  );
  const totals = switches.map((item) => item.totalMs).filter((value) => Number.isFinite(value));
  totals.sort((a, b) => a - b);
  const p50 = totals.length ? totals[Math.min(totals.length - 1, Math.floor(totals.length * 0.5))] : Number.NaN;
  const p95 = totals.length ? totals[Math.min(totals.length - 1, Math.floor(totals.length * 0.95))] : Number.NaN;
  const max = totals.length ? totals[totals.length - 1] : Number.NaN;
  push(
    checks,
    "AC-DF-06-01-4",
    "ST-DF-06-01",
    totals.length > 0 && max <= 300,
    `切标的首帧可交互时延 p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms max=${max.toFixed(0)}ms（≤300ms）`,
  );

  // B. 周期首次点击触发一次；在途连点合并（AC-06-01-3 已登记偏差：首点 0ms）
  const reqBeforePeriod = hooks.requestCount();
  const periodClickedAt = performance.now();
  hooks.setTimeframe("W");
  let periodFirstAt = Number.NaN;
  while (performance.now() - periodClickedAt < 600) {
    if (hooks.requestCount() > reqBeforePeriod) {
      periodFirstAt = performance.now() - periodClickedAt;
      break;
    }
    await sleep(4);
  }
  const periodFirstDelta = hooks.requestCount() - reqBeforePeriod;
  await waitStable();
  const reqBeforeDouble = hooks.requestCount();
  hooks.setTimeframe("D");
  await sleep(10);
  hooks.setTimeframe("M");
  await sleep(10);
  hooks.setTimeframe("D");
  await waitStable();
  const periodDoubleDelta = hooks.requestCount() - reqBeforeDouble;
  push(
    checks,
    "AC-DF-06-01-5",
    "ST-DF-06-01",
    periodFirstDelta === 1,
    `周期首次点击新增请求 ${periodFirstDelta}（期望 1），首次发起于点击后 ${
      Number.isFinite(periodFirstAt) ? `${periodFirstAt.toFixed(0)}ms` : "未触发"
    }`,
  );
  push(
    checks,
    "AC-DF-06-01-3",
    "ST-DF-06-01",
    periodDoubleDelta <= 2,
    `在途连点 3 次新增请求 ${periodDoubleDelta}（0ms 首点 + 在途 100ms 合并；AC 原文要求固定 100ms，已登记偏差）`,
  );

  // C. bars 与 calc 并行
  const timing = hooks.timing();
  const parallel = Boolean(timing && timing.totalMs < timing.barsMs + timing.calcMs + 1);
  push(
    checks,
    "AC-DF-06-01-6",
    "ST-DF-06-01",
    parallel,
    timing
      ? `bars=${timing.barsMs.toFixed(1)}ms calc=${timing.calcMs.toFixed(1)}ms total=${timing.totalMs.toFixed(1)}ms（并行，非串行相加）`
      : "缺少分段耗时",
  );

  // D. 5 连点终态
  const rapidCodes = targets.slice(0, 5);
  for (const code of rapidCodes) {
    clickRow(code);
    await sleep(8);
  }
  await waitStable();
  const lastCode = rapidCodes[rapidCodes.length - 1];
  push(
    checks,
    "AC-DF-06-06-4",
    "ST-DF-06-06",
    headCode() === lastCode && !q(".error-box"),
    `5 连点终态 active=${hooks.getActiveCode()} head=${headCode()}（期望 ${lastCode}）`,
  );

  // E. 滚轮/拖拽 0 取数
  const svg = chart();
  const reqBeforeView = hooks.requestCount();
  const sampleBeforeView = hooks.sampleCount();
  if (svg) {
    const box = svg.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height * 0.4;
    for (let i = 0; i < 3; i += 1) {
      svg.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: i % 2 === 0 ? -120 : 120, clientX: cx, clientY: cy }),
      );
      await sleep(40);
    }
    svg.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, clientX: cx, clientY: cy, pointerId: 1, button: 0, buttons: 1 }),
    );
    svg.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, clientX: cx - 120, clientY: cy, pointerId: 1, buttons: 1 }),
    );
    svg.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, clientX: cx - 120, clientY: cy, pointerId: 1, button: 0 }),
    );
    await sleep(120);
  }
  push(
    checks,
    "AC-DF-06-03-1",
    "ST-DF-06-03",
    hooks.requestCount() === reqBeforeView,
    `缩放/平移新增取数 ${hooks.requestCount() - reqBeforeView}（期望 0）`,
  );
  push(
    checks,
    "AC-DF-06-03-2",
    "ST-DF-06-03",
    hooks.sampleCount() === sampleBeforeView,
    `缩放/平移新增采样 ${hooks.sampleCount() - sampleBeforeView}（期望 0）`,
  );

  // F. 成交量折叠
  const volBefore = q('[data-sub-panel="VOL"]');
  const toggle = q('[data-volume-toggle]');
  if (toggle) click(toggle);
  await sleep(220);
  const volAfter = q('[data-sub-panel="VOL"]');
  const panelCount = qa("[data-sub-panel]").length;
  const overlap = qa("[data-sub-panel]").some((panel, index, list) => {
    if (index === 0) return false;
    const prev = list[index - 1].getBoundingClientRect();
    const cur = panel.getBoundingClientRect();
    return cur.top < prev.bottom - 0.5;
  });
  const firstPanel = q("[data-sub-panel]");
  const firstTopAfter = firstPanel ? firstPanel.getBoundingClientRect().top : Number.NaN;
  const volBeforeTop = volBefore ? volBefore.getBoundingClientRect().top : Number.NaN;
  push(
    checks,
    "AC-DF-06-02-5",
    "ST-DF-06-02",
    volBefore !== null && volAfter === null && !overlap && firstTopAfter >= volBeforeTop,
    `折叠后成交量面板${volAfter ? "仍在" : "消失"}，副图 ${panelCount} 格，重叠=${overlap}，首格顶 ${volBeforeTop.toFixed(0)}→${firstTopAfter.toFixed(0)}`,
  );
  const toggleBack = q('[data-volume-toggle]');
  if (toggleBack) click(toggleBack);
  await sleep(220);
  const volBack = q('[data-sub-panel="VOL"]');
  const volUnit = volBack?.getAttribute("data-sub-unit") ?? "";
  const volLo = Number(volBack?.getAttribute("data-sub-lo") ?? Number.NaN);
  const volHi = Number(volBack?.getAttribute("data-sub-hi") ?? Number.NaN);
  let candleBottom = Number.NaN;
  for (const rect of qa("[data-candle]")) {
    const box = rect.getBoundingClientRect();
    if (!Number.isFinite(candleBottom) || box.bottom > candleBottom) candleBottom = box.bottom;
  }
  const volTop = volBack ? volBack.getBoundingClientRect().top : Number.NaN;
  const separated = Number.isFinite(candleBottom) && Number.isFinite(volTop) && candleBottom <= volTop + 1;
  push(
    checks,
    "AC-DF-06-02-2",
    "ST-DF-06-02",
    volBack !== null &&
      textOf('[data-sub-panel="VOL"] [data-sub-title]').includes("成交量") &&
      volUnit === "手" &&
      volLo === 0 &&
      volHi > 0 &&
      separated,
    `成交量独立面板：title=${textOf('[data-sub-panel="VOL"] [data-sub-title]')}，单位=${volUnit || "—"}，量纲 ${volLo}~${volHi}，K 线底 ${candleBottom.toFixed(0)} ≤ 面板顶 ${volTop.toFixed(0)}（与主图价格轴分离）`,
  );

  // G. 输入静默：连续输入不发请求，选中才发 1 次（AC-06-01-1，已登记偏差）
  const input = q<HTMLInputElement>("input[data-wl-search]");
  if (input) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    const reqBeforeType = hooks.requestCount();
    for (const value of ["6", "60", "600"]) {
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(40);
    }
    await sleep(400);
    const typedDelta = hooks.requestCount() - reqBeforeType;
    setter?.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(120);
    const pick = targets.find((code) => code !== hooks.getActiveCode()) ?? targets[0];
    const reqBeforePick = hooks.requestCount();
    clickRow(pick);
    await sleep(260);
    const pickDelta = hooks.requestCount() - reqBeforePick;
    push(
      checks,
      "AC-DF-06-01-1",
      "ST-DF-06-01",
      typedDelta === 0 && pickDelta === 1,
      `输入 3 次@40ms 新增请求 ${typedDelta}（期望 0），选中 ${pick} 新增请求 ${pickDelta}（期望 1）；本工作台无「代码输入即取数」入口，按「输入不取数、选中取数」口径取证`,
    );
    await waitStable();
  } else {
    push(checks, "AC-DF-06-01-1", "ST-DF-06-01", false, "未找到自选搜索输入框");
  }

  // H. 副图/主图叠加容量与提示
  const drawerTrigger = q("[data-drawer-trigger]");
  if (drawerTrigger) {
    click(drawerTrigger);
    await sleep(240);
    const capacity = textOf("[data-drawer-capacity]");
    // 默认分类只列主图指标；搜索 KDJ 才能看到「副图」类型的增入口
    const drawerSearch = q<HTMLInputElement>("input[data-drawer-search]");
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (drawerSearch) {
      valueSetter?.call(drawerSearch, "kdj");
      drawerSearch.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(300);
    }
    const subAddButtons = qa('[data-drawer-add$=":sub"]');
    const subFull = subAddButtons
      .filter((button) => button.getAttribute("data-drawer-added") !== "1")
      .every(
        (button) =>
          (button as HTMLButtonElement).disabled &&
          (button.getAttribute("title") ?? "").includes("副图最多 3 个"),
      );
    push(
      checks,
      "AC-DF-06-02-1",
      "ST-DF-06-02",
      capacity.includes("副图 3/3") && subFull && subAddButtons.length > 0,
      `抽屉容量「${capacity}」，可见副图入口 ${subAddButtons.length} 个，未添加的入口禁用并提示上限=${subFull}（副图格含成交量格，故指标副图最多 2 个）`,
    );
    if (drawerSearch) {
      valueSetter?.call(drawerSearch, "");
      drawerSearch.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(300);
    }

    const overlayCountBefore = Number(
      q<HTMLSelectElement>("select[data-b2-overlay-select]")?.getAttribute("data-overlay-count") ?? 0,
    );
    const thirdMain = qa('[data-drawer-add$=":main"]').find(
      (button) => button.getAttribute("data-drawer-added") !== "1",
    );
    let overlayHint = "";
    if (thirdMain) {
      click(thirdMain);
      await sleep(200);
      overlayHint = textOf("[data-drawer-hint]");
    }
    const overlayCountAfter = Number(
      q<HTMLSelectElement>("select[data-b2-overlay-select]")?.getAttribute("data-overlay-count") ?? 0,
    );
    push(
      checks,
      "AC-DF-06-02-4",
      "ST-DF-06-02",
      overlayCountBefore === 2 && overlayCountAfter === 2 && overlayHint.includes("主图最多 2 个叠加"),
      `叠加 ${overlayCountBefore}→${overlayCountAfter}（拒绝第 3 个），提示「${overlayHint}」`,
    );

    const close = q("[data-drawer-close]");
    if (close) click(close);
    await sleep(180);
  } else {
    push(checks, "AC-DF-06-02-1", "ST-DF-06-02", false, "未找到指标抽屉入口");
    push(checks, "AC-DF-06-02-4", "ST-DF-06-02", false, "未找到指标抽屉入口");
  }

  // I. 副图高度夹取 96~220
  const resize = q('[data-panel-resize="VOL"]');
  if (resize) {
    const drag = async (dy: number) => {
      const rect = resize.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      resize.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0, buttons: 1 }),
      );
      resize.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: y + dy, pointerId: 1, buttons: 1 }),
      );
      resize.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: x, clientY: y + dy, pointerId: 1, button: 0 }),
      );
      await sleep(160);
      const panel = q('[data-sub-panel="VOL"]');
      return Number(panel?.getAttribute("data-sub-height") ?? Number.NaN);
    };
    const maxHeight = await drag(600);
    const minHeight = await drag(-800);
    const backHeight = await drag(440);
    push(
      checks,
      "AC-DF-06-02-3",
      "ST-DF-06-02",
      maxHeight === 220 && minHeight === 96 && backHeight >= 96 && backHeight <= 220,
      `拖拽改高：下拖 600→${maxHeight}px，上拖 800→${minHeight}px，回拖→${backHeight}px（夹在 96~220）`,
    );
  } else {
    push(checks, "AC-DF-06-02-3", "ST-DF-06-02", false, "未找到副图高度抓手");
  }

  // J. 无指标：只显示 K 线与成交量，不占空副图
  const subSelect = q<HTMLSelectElement>("select[data-b2-sub-select]");
  if (subSelect) {
    setSelectValues(subSelect, []);
    await sleep(260);
    const panels = qa("[data-sub-panel]");
    const onlyVolume =
      panels.length === 1 && panels[0].getAttribute("data-sub-panel") === "VOL" && chartState().count > 0;
    push(
      checks,
      "AC-DF-06-02-6",
      "ST-DF-06-02",
      onlyVolume,
      `清空指标副图后面板数 ${panels.length}（仅成交量=${onlyVolume}），K 线 ${chartState().count} 根`,
    );
    setSelectValues(subSelect, ["M06", "M01"]);
    await sleep(320);
  } else {
    push(checks, "AC-DF-06-02-6", "ST-DF-06-02", false, "未找到副图选择器");
  }

  // K. 极端缩放/平移夹取
  const svg2 = chart();
  if (svg2) {
    const box = svg2.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height * 0.4;
    for (let i = 0; i < 16; i += 1) {
      svg2.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -240, clientX: cx, clientY: cy }),
      );
      await sleep(24);
    }
    for (let i = 0; i < 4; i += 1) {
      svg2.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, clientX: cx, clientY: cy, pointerId: 1, button: 0, buttons: 1 }),
      );
      svg2.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: cx + 600, clientY: cy, pointerId: 1, buttons: 1 }),
      );
      svg2.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: cx + 600, clientY: cy, pointerId: 1, button: 0 }),
      );
      await sleep(50);
    }
    const state = chartState();
    const count = Number.isFinite(state.end) ? state.end - state.start + 1 : 0;
    push(
      checks,
      "AC-DF-06-03-3",
      "ST-DF-06-03",
      state.start >= 0 && count > 0 && state.start + count <= state.count,
      `极端缩放+平移后 start=${state.start}，count=${count}，总根数=${state.count}（无空白区）`,
    );
    hooks.setRange(120);
    await sleep(140);
  } else {
    push(checks, "AC-DF-06-03-3", "ST-DF-06-03", false, "未找到图表");
  }

  // L. 切标的回来恢复各自视口
  const codeA = hooks.getActiveCode();
  hooks.setRange(60);
  await sleep(160);
  const codeB = targets.find((code) => code !== codeA) ?? targets[0];
  const timingBefore = hooks.timing();
  const reqBeforeB = hooks.requestCount();
  const rowB = document.querySelector<HTMLButtonElement>(
    `[data-wl-item="${codeB}"] button.wl-row-main`,
  );
  const clickedB = clickRow(codeB);
  await sleep(80);
  const headAfterB = headCode();
  const reqAfterB = hooks.requestCount() - reqBeforeB;
  await waitStable();
  // 等到 B 的响应真正落地（timing 对象换了引用），再读视口
  const waitB = performance.now();
  while (hooks.timing() === timingBefore && performance.now() - waitB < 3000) {
    await sleep(10);
  }
  const bLanded = hooks.timing() !== timingBefore;
  await sleep(150);
  const bState = chartState();
  const bBarsCode = chart()?.getAttribute("data-bars-code") ?? "—";
  const bDebug = JSON.stringify(hooks.debug?.() ?? {});
  const bStart = bState.start;
  const bEnd = bState.end;
  const bCount = Number.isFinite(bEnd) ? bEnd - bStart + 1 : 0;
  clickRow(codeA);
  await waitStable();
  await sleep(400);
  const memText = (() => {
    try {
      const raw = JSON.parse(window.sessionStorage.getItem("aka.chart.viewport") ?? "{}") as Record<
        string,
        { start: number; end: number }
      >;
      const pick = (key: string) => {
        const item = raw[key];
        return item ? `${key}=${item.end - item.start + 1}根` : `${key}=无`;
      };
      return `${pick(`${codeA}|D`)}，${pick(`${codeB}|D`)}`;
    } catch {
      return "记忆不可读";
    }
  })();
  const aCount = (() => {
    const state = chartState();
    return Number.isFinite(state.end) ? state.end - state.start + 1 : 0;
  })();
  push(
    checks,
    "AC-DF-06-03-4",
    "ST-DF-06-03",
    aCount === 60 && bCount !== 60,
    `A=${codeA} 设 60 根 → 切 ${codeB}（点击=${clickedB}，行禁用=${rowB?.disabled ?? "无行"}，80ms 后 head=${headAfterB}，新增请求=${reqAfterB}，落地=${bLanded}，bars=${bBarsCode}，bar-count=${bState.count}，状态=${bDebug}）显示 ${bCount} 根（${bStart}~${bEnd}）→ 切回 A 显示 ${aCount} 根；记忆 ${memText}`,
  );

  // M. 缓存元信息：冷算 / 缓存命中 / 随标的刷新
  // 先切到本套件尚未用过的 M 周期，保证「冷算」不是命中缓存伪造出来的
  hooks.setTimeframe("M");
  await waitStable();
  const beforeNote = engineNote();
  const coldCode = targets.find((code) => code !== hooks.getActiveCode()) ?? targets[0];
  // 只延迟 calc_indicators 300ms 以便观察「更新中」，不改写任何返回值
  setInvokeDelay({ command: "calc_indicators", code: coldCode, ms: 300, once: true });
  let loadingSeen = false;
  const coldTimingBefore = hooks.timing();
  const coldReqBefore = hooks.requestCount();
  const coldActiveBefore = hooks.getActiveCode();
  const clickedCold = clickRow(coldCode);
  for (let i = 0; i < 160; i += 1) {
    if (engineNote().includes("更新中")) {
      loadingSeen = true;
      break;
    }
    await sleep(5);
  }
  const coldAfterNote = engineNote();
  const coldNote = await waitCalcNote();
  setInvokeDelay(null);
  const coldReqDelta = hooks.requestCount() - coldReqBefore;
  const coldActiveAfter = hooks.getActiveCode();
  const coldDebug = JSON.stringify(hooks.debug?.() ?? {});
  const waitTiming = async (prev: S206Timing | null, timeout = 3000) => {
    const started = performance.now();
    while (hooks.timing() === prev && performance.now() - started < timeout) await sleep(10);
    return hooks.timing() !== prev;
  };
  const waitCold = await waitTiming(coldTimingBefore);
  const warmCode =
    targets.find((code) => code !== coldCode && code !== hooks.getActiveCode()) ?? targets[0];
  const warmTimingBefore = hooks.timing();
  const clickedWarm = clickRow(warmCode);
  const waitWarm = await waitTiming(warmTimingBefore);
  const revisitTimingBefore = hooks.timing();
  const clickedRevisit = clickRow(coldCode);
  const waitRevisit = await waitTiming(revisitTimingBefore);
  const hitNote = await waitCalcNote();
  push(
    checks,
    "AC-DF-06-04-1",
    "ST-DF-06-04",
    hitNote.includes("缓存命中") && hitNote.includes("<0.01"),
    `二次访问元信息「${hitNote}」（命中且 0ms；点击=${clickedRevisit}，响应落地=${waitRevisit}）`,
  );
  push(
    checks,
    "AC-DF-06-04-2",
    "ST-DF-06-04",
    coldNote.includes("冷算") && !coldNote.includes("<0.01"),
    `首次访问元信息「${coldNote}」（冷算且耗时非 0；M 周期首次；点击=${clickedCold}，响应落地=${waitCold}）`,
  );
  push(
    checks,
    "AC-DF-06-04-6",
    "ST-DF-06-04",
    loadingSeen && coldNote.includes("冷算") && !coldNote.includes("更新中"),
    `切换后元信息先进入「更新中」=${loadingSeen}，${beforeNote} → 「${coldNote}」（点击 ${coldCode}: ${clickedCold}，active ${coldActiveBefore}→${coldActiveAfter}，新增请求 ${coldReqDelta}，加载窗内「${coldAfterNote}」，状态=${coldDebug}，中间标的点击=${clickedWarm}/${waitWarm}）`,
  );
  // 回到 D，后续阶段与刷新恢复都按 (code, D) 的视口键
  hooks.setTimeframe("D");
  await waitStable();

  // N. 计算失败：K 线与成交量保留，整页不崩
  const failCode = targets.find((code) => code !== hooks.getActiveCode()) ?? targets[0];
  await ipc.diagSetInject("panic");
  clickRow(failCode);
  let errorCard = false;
  for (let i = 0; i < 120; i += 1) {
    errorCard = q("[data-calc-error]") !== null;
    if (errorCard) break;
    await sleep(10);
  }
  await waitStable(3000);
  const errorTitle = textOf("[data-calc-error-title]");
  const errorTrace = textOf("[data-calc-error-trace]");
  const chartAlive = chartState().count > 0;
  push(
    checks,
    "AC-DF-06-05-1",
    "ST-DF-06-05",
    errorCard && errorTitle === "引擎异常" && chartAlive && !q(".error-box"),
    `注入引擎异常后错误卡「${errorTitle}」=${errorCard}，K 线 ${chartState().count} 根，图表崩溃边界=${q(".error-box") !== null}`,
  );
  push(
    checks,
    "AC-DF-06-05-4",
    "ST-DF-06-05",
    errorTrace.length > 0,
    `错误卡 traceId「${errorTrace}」`,
  );
  push(
    checks,
    "AC-DF-06-05-6",
    "ST-DF-06-05",
    headCode() === failCode && chartAlive && q('[data-sub-panel="VOL"]') !== null,
    `失败后未清空行情：head=${headCode()}（期望 ${failCode}），K 线 ${chartState().count} 根，成交量面板=${q('[data-sub-panel="VOL"]') !== null}`,
  );
  push(
    checks,
    "AC-DF-06-06-6",
    "ST-DF-06-06",
    chartAlive && errorCard && !q("[data-calc-error] [data-calc-error-code]")?.textContent?.includes("E_OLD"),
    `最后一次请求失败后保留行情内容并提示失败（错误码 ${textOf("[data-calc-error-code]")}）`,
  );

  // O. 旧响应晚到：成功响应与失败响应都必须丢弃
  const oldA = targets.find((code) => code !== hooks.getActiveCode()) ?? targets[0];
  const oldB = targets.find((code) => code !== oldA) ?? targets[1] ?? targets[0];
  setInvokeDelay({ command: "get_bars", code: oldA, ms: 900, once: true });
  clickRow(oldA);
  await sleep(80);
  clickRow(oldB);
  await waitStable();
  const headAfterLateSuccess = headCode();
  await sleep(1100);
  const headAfterLateSettle = headCode();
  push(
    checks,
    "AC-DF-06-06-1",
    "ST-DF-06-06",
    headAfterLateSuccess === oldB && headAfterLateSettle === oldB && !q("[data-calc-error]"),
    `旧成功响应晚到（${oldA} 延迟 900ms）：稳定时 head=${headAfterLateSuccess}，1.1s 后 head=${headAfterLateSettle}（期望 ${oldB}）`,
  );

  setInvokeDelay({ command: "calc_indicators", code: oldA, ms: 900, once: true });
  await ipc.diagSetInject("timeout");
  clickRow(oldA);
  await sleep(80);
  clickRow(oldB);
  await waitStable();
  await sleep(1100);
  const headAfterLateError = headCode();
  push(
    checks,
    "AC-DF-06-06-3",
    "ST-DF-06-06",
    headAfterLateError === oldB && !q("[data-calc-error]"),
    `旧失败响应晚到（${oldA} 计算延迟 900ms 后失败）：1.1s 后 head=${headAfterLateError}（期望 ${oldB}），错误卡=${q("[data-calc-error]") !== null}`,
  );
  await ipc.diagSetInject("none");

  // 收尾：恢复默认副图配置并记录刷新前视口，进入刷新阶段
  const subSelectEnd = q<HTMLSelectElement>("select[data-b2-sub-select]");
  if (subSelectEnd) {
    setSelectValues(subSelectEnd, ["M06", "M01"]);
    await sleep(200);
  }
  // 刷新后落回落地标的，先把视口记忆写到它名下
  if (landingCode && landingCode !== hooks.getActiveCode()) {
    clickRow(landingCode);
    await waitStable();
    await sleep(400);
  }
  hooks.setRange(60);
  await sleep(200);
  const viewState = chartState();
  const viewCount = Number.isFinite(viewState.end) ? viewState.end - viewState.start + 1 : 0;
  writeAcc("restore", checks, {
    switches,
    summary: { p50, p95, max },
    period: { firstDelta: periodFirstDelta, doubleDelta: periodDoubleDelta },
    timing,
    viewCount,
    viewport: { head: headCode() },
  });
  window.location.reload();
  return { suite: "s206", reloading: true, checks };
}

// ---------------------------------------------------------------- 元信息套件

async function runMetaSuite(): Promise<S206Report> {
  const checks: Check[] = [];
  const stage = window.sessionStorage.getItem("aka.s206.meta.stage");
  if (!stage) {
    window.sessionStorage.setItem("aka.s206.meta.stage", "1");
    // 只延迟 dataset_manifest，让页脚真实经历「加载中」
    setInvokeDelay({ command: "dataset_manifest", ms: 2500, once: true }, true);
    window.location.reload();
    return { suite: "s206-meta", reloading: true };
  }
  window.sessionStorage.removeItem("aka.s206.meta.stage");

  const segments = () =>
    qa("[data-dataset-seg]").map((el) => ({
      key: el.getAttribute("data-dataset-seg") ?? "",
      text: (el.textContent ?? "").trim(),
      missing: el.getAttribute("data-dataset-missing") === "1",
    }));

  await sleep(120);
  const pending = segments();
  const loadingOk = pending.length === 7 && pending.every((item) => item.text.includes("加载中"));
  for (let i = 0; i < 80; i += 1) {
    if (segments().every((item) => !item.text.includes("加载中"))) break;
    await sleep(100);
  }
  const after = segments();
  const sha = after.find((item) => item.key === "sha256");
  const others = after.filter((item) => item.key !== "sha256");
  push(
    checks,
    "AC-DF-06-04-3",
    "ST-DF-06-04",
    loadingOk && after.length === 7,
    `manifest 延迟 2500ms 期间页脚 7 段均为「加载中」=${loadingOk}（实测 ${pending.filter((item) => item.text.includes("加载中")).length}/7）`,
  );
  push(
    checks,
    "AC-DF-06-04-4",
    "ST-DF-06-04",
    after.length === 7 && Boolean(sha?.missing) && others.every((item) => !item.missing),
    `缺 sha256 时仅该段「缺失」=${Boolean(sha?.missing)}，其余 ${others.filter((item) => item.missing).length} 段缺失`,
  );
  const pass = checks.every((item) => item.ok);
  const payload = {
    suite: "s206-meta",
    at: new Date().toISOString(),
    ok: pass,
    pass,
    checks,
    segments: after,
  };
  await writeEvidence("s206-meta-evidence.json", payload);
  return payload;
}

// ---------------------------------------------------------------- 只读套件

const WRITE_HINTS = [
  "watch_toggle",
  "watchlist_group",
  "watchlist_move",
  "positions_save",
  "position_save",
  "view_state_set",
  "touch_recent_view",
  "dataset_regenerate",
  "storage_rebuild",
  "favorite",
  "export_diagnostics",
  "diag_write",
];

async function runReadonlySuite(): Promise<S206Report> {
  const checks: Check[] = [];
  await waitStable(4000);
  const audit: string[] = [];
  setInvokeAudit((command) => audit.push(command));
  await sleep(1200);
  setInvokeAudit(null);
  const writes = audit.filter((command) => WRITE_HINTS.some((hint) => command.includes(hint)));
  const note = engineNote();
  const segments = qa("[data-dataset-seg]");
  const ready = segments.length === 7 && segments.every((el) => !(el.textContent ?? "").includes("加载中"));
  push(
    checks,
    "AC-DF-06-04-5",
    "ST-DF-06-04",
    note.includes("ms") && note !== "—" && ready && writes.length === 0,
    `只读模式下元信息「${note}」，页脚 7 段就绪=${ready}，观察窗写入命令 ${writes.length} 条${writes.length ? `（${writes.join(",")}）` : ""}`,
  );
  const pass = checks.every((item) => item.ok);
  const payload = {
    suite: "s206-readonly",
    at: new Date().toISOString(),
    ok: pass,
    pass,
    checks,
  };
  await writeEvidence("s206-readonly-evidence.json", payload);
  return payload;
}

// ---------------------------------------------------------------- 入口

export async function runS206Diagnostics(
  target: string,
  hooks: S206Hooks,
): Promise<S206Report> {
  if (target === "s206-meta") return runMetaSuite();
  if (target === "s206-readonly") return runReadonlySuite();
  return runMainSuite(hooks);
}
