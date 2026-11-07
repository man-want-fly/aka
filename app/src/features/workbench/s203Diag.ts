/**
 * S-02.03-01 副图三格实机取证。
 *
 * 两轮：
 * 1. 第一轮在默认三格上驱动真实 DOM（抽屉、拖拽换序、改高、HIST 柱），
 *    把「换序 + 高度 200」写进 localStorage，留下重启标记。
 * 2. 第二轮（同一 AKA_DIAG_TARGET=s203，重启后再跑）先断言上轮设置原样恢复，
 *    再做「移除 MACD → 2 格」「20 根数据不足」两项。
 *
 * 所有几何与 `CandleChart` 同口径：viewBox 高度来自 SVG，指针坐标按 meet 居中换算。
 */

import { ipc } from "../../lib/ipc";
import type { BarsResponse, CalcResponse } from "../../lib/types";
import {
  DEFAULT_SUB_PLOTS,
  MAX_SUBPLOTS,
  SUB_HEIGHT_DEFAULT,
  SUB_HEIGHT_MAX,
  SUB_HEIGHT_MIN,
  VOLUME_PANEL_ID,
  type SubPlotSetting,
} from "./model";

interface Check {
  id: string;
  ac: string;
  layer: "data" | "render";
  passed: boolean;
  detail: string;
}

export interface S203Hooks {
  getSubPlots: () => SubPlotSetting[];
  setSubPlots: (next: SubPlotSetting[]) => void;
  setDateRange: (from: string, to: string) => void;
  clearDateRange: () => void;
  bars: () => BarsResponse | null;
  calc: () => CalcResponse | null;
  waitReady: (label: string, timeoutMs?: number) => Promise<void>;
}

const PHASE_KEY = "aka.s203.diag.phase";
const EXPECT_KEY = "aka.s203.diag.expect";
const STORAGE_KEY = "aka.workbench.subplots.v1";

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

/** 图表 viewBox 高度（副图多时 CandleChart 会加高，不能写死 560/738） */
const chartHeight = () => {
  const box = (svg().getAttribute("viewBox") ?? "0 0 1000 738").trim().split(/\s+/);
  return Number(box[3]);
};

const geometry = () => {
  const node = svg();
  const rect = node.getBoundingClientRect();
  const scale = Math.min(rect.width / 1000, rect.height / chartHeight());
  return {
    rect,
    scale,
    offsetX: (rect.width - 1000 * scale) / 2,
    offsetY: (rect.height - chartHeight() * scale) / 2,
  };
};

/** 用户坐标（SVG viewBox 内）→ 客户端坐标 */
const client = (xUser: number, yUser: number) => {
  const { rect, scale, offsetX, offsetY } = geometry();
  return {
    clientX: rect.left + offsetX + xUser * scale,
    clientY: rect.top + offsetY + yUser * scale,
  };
};

const panels = () =>
  qa<SVGGElement>("[data-sub-panel]").sort(
    (a, b) => Number(a.getAttribute("data-sub-index")) - Number(b.getAttribute("data-sub-index")),
  );
const panelIds = () => panels().map((panel) => panel.getAttribute("data-sub-panel") ?? "");
const panelHeight = (id: string) => num(q(`[data-sub-panel="${id}"]`), "data-sub-height");
const panelTitles = () =>
  qa("[data-sub-title]").map((element) => element.getAttribute("data-sub-title") ?? "");
const stored = (): SubPlotSetting[] | null => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SubPlotSetting[]) : null;
  } catch {
    return null;
  }
};
const storedKey = () =>
  (stored() ?? [])
    .map((item) => `${item.id}:${item.height}`)
    .join("|");

const fire = (
  element: Element,
  type: string,
  point: { clientX: number; clientY: number },
  buttons: number,
) => {
  element.dispatchEvent(
    new PointerEvent(type, {
      clientX: point.clientX,
      clientY: point.clientY,
      button: 0,
      buttons,
      pointerId: 1,
      pointerType: "mouse",
      bubbles: true,
      cancelable: true,
    }),
  );
};

const waitFor = async <T,>(probe: () => T | null, timeoutMs = 3_000, stepMs = 60) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(stepMs);
  }
};

const setSearch = async (text: string) => {
  const field = await waitFor(() => q<HTMLInputElement>("[data-drawer-search]"));
  if (!field) throw new Error("抽屉搜索框不存在");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(260);
};

const openDrawer = async () => {
  if (q("[data-indicator-drawer]")) return;
  const trigger = await waitFor(() => q<HTMLElement>("[data-drawer-trigger]"));
  if (!trigger) throw new Error("抽屉触发按钮不存在");
  trigger.click();
  await waitFor(() => q("[data-indicator-drawer]"));
  await sleep(120);
};

const closeDrawer = async () => {
  const close = q<HTMLElement>("[data-drawer-close]");
  if (close) close.click();
  await sleep(120);
};

/** 拖副图标题条到指定用户坐标 y（换序）；拖动中回调用于断言插入线 */
const dragTitleToY = async (
  id: string,
  yUser: number,
  duringDrag?: () => void,
) => {
  const handle = q(`[data-panel-drag="${id}"]`);
  if (!handle) throw new Error(`副图 ${id} 标题抓手不存在`);
  const y = num(handle, "y");
  const h = num(handle, "height");
  const from = client(500, y + h / 2);
  const to = client(500, yUser);
  fire(handle, "pointerdown", from, 1);
  await sleep(40);
  fire(handle, "pointermove", to, 1);
  await sleep(80);
  duringDrag?.();
  fire(handle, "pointerup", to, 0);
  await sleep(160);
};

/** 拖副图底边改高，dyUser 为 viewBox 单位 */
const dragResizeBy = async (id: string, dyUser: number, assertPreview?: (height: number) => void) => {
  const handle = q(`[data-panel-resize="${id}"]`);
  if (!handle) throw new Error(`副图 ${id} 改高抓手不存在`);
  const y = num(handle, "y");
  const h = num(handle, "height");
  const from = client(500, y + h / 2);
  const to = client(500, y + h / 2 + dyUser);
  fire(handle, "pointerdown", from, 1);
  await sleep(40);
  fire(handle, "pointermove", to, 1);
  await sleep(80);
  if (assertPreview) {
    const preview = q("[data-panel-preview-height]");
    assertPreview(Number(preview?.getAttribute("data-panel-preview-height") ?? "NaN"));
  }
  fire(handle, "pointerup", to, 0);
  await sleep(160);
};

/** 悬停到可视区某根，等 data-hover-index 落地（rAF 后台可能被节流，最多重投 3 次） */
const hoverIndex = async (index: number, yUser = 150) => {
  const node = svg();
  const step = (938 - 6) / Math.max(1, viewCount());
  const point = client(6 + index * step + step / 2, yUser);
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
  await sleep(80);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = Number(q('[data-readout="1"]')?.getAttribute("data-hover-index") ?? "NaN");
    if (Number.isFinite(current) && current === index) break;
    dispatch();
    await sleep(140);
  }
};

const viewCount = () => {
  const node = svg();
  return num(node, "data-view-end") - num(node, "data-view-start") + 1;
};

const viewStart = () => num(svg(), "data-view-start");

export async function runS203Diagnostics(hooks: S203Hooks) {
  const checks: Check[] = [];
  const attempt = async (
    id: string,
    ac: string,
    layer: Check["layer"],
    run: () => Promise<{ passed: boolean; detail: string }>,
  ) => {
    try {
      const result = await run();
      checks.push({ id, ac, layer, ...result });
    } catch (err) {
      checks.push({
        id,
        ac,
        layer,
        passed: false,
        detail: `异常：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const phase = window.localStorage.getItem(PHASE_KEY);

  let resumed = phase === "restart";
  let expected: { order: string[]; heights: Record<string, number> } | null = null;
  if (resumed) {
    // ---- 第二轮：重启恢复 → 移除 MACD → 数据不足 ----
    await hooks.waitReady("重启首屏");
    try {
      expected = JSON.parse(window.localStorage.getItem(EXPECT_KEY) ?? "null");
    } catch {
      expected = null;
    }
    await waitFor(() =>
      expected && panels().length === expected.order.length ? true : null,
    );
    // 上一轮若被中途打断，持久化状态已偏离期望：清标记重跑第一轮，避免拿脏状态做断言
    const order = panelIds();
    const persistedOk =
      Boolean(expected) &&
      order.length === (expected?.order.length ?? 0) &&
      order.every((id, index) => id === expected?.order[index]) &&
      order.every((id) => panelHeight(id) === expected?.heights[id]);
    if (!persistedOk) {
      window.localStorage.removeItem(PHASE_KEY);
      window.localStorage.removeItem(EXPECT_KEY);
      resumed = false;
    }
  }

  if (resumed) {

    await attempt("R-06", "AC-02.03-03", "render", async () => {
      if (!expected) throw new Error("缺少上一轮期望值");
      const order = panelIds();
      const heights = order.map((id) => panelHeight(id));
      const expectedHeights = order.map((id) => expected?.heights[id] ?? Number.NaN);
      const domOk =
        order.length === expected.order.length &&
        order.every((id, index) => id === expected?.order[index]);
      const heightOk = heights.every((height, index) => height === expectedHeights[index]);
      return {
        passed: domOk && heightOk,
        detail: `重启后顺序 ${order.join(" / ")}（期望 ${expected.order.join(" / ")}）· 高度 ${heights.join(
          "/",
        )}（期望 ${expectedHeights.join("/")}）· localStorage ${storedKey()}`,
      };
    });

    await attempt("R-06b", "AC-02.03-03", "data", async () => {
      if (!expected) throw new Error("缺少上一轮期望值");
      const saved = stored();
      const savedOk =
        Boolean(saved) &&
        (saved ?? []).length === expected.order.length &&
        (saved ?? []).every(
          (item, index) =>
            item.id === expected?.order[index] && item.height === expected?.heights[item.id],
        );
      return {
        passed: savedOk,
        detail: `localStorage ${storedKey() || "空"}（期望 ${expected.order
          .map((id) => `${id}:${expected?.heights[id]}`)
          .join("|")}）`,
      };
    });

    await attempt("R-07", "AC-02.03-03 补1", "render", async () => {
      const beforePanels = panelIds();
      const beforeTop = num(q(`[data-panel-drag="${beforePanels[0]}"]`), "y");
      const remove = q('[data-panel-remove="M06"]');
      if (!remove) throw new Error("M06 的 × 不存在");
      remove.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await waitFor(() => (panelIds().length === beforePanels.length - 1 ? true : null));
      await sleep(160);
      const afterPanels = panelIds();
      const afterTop = num(q(`[data-panel-drag="${afterPanels[0]}"]`), "y");
      await openDrawer();
      await setSearch("MACD");
      const m06Add = q<HTMLButtonElement>('[data-drawer-add="M06:sub"]');
      const capacity = q("[data-drawer-capacity]")?.textContent ?? "";
      return {
        passed:
          beforePanels.length === 3 &&
          afterPanels.length === 2 &&
          !afterPanels.includes("M06") &&
          afterTop - beforeTop >= 100 &&
          m06Add?.dataset.drawerAdded === "0" &&
          capacity.includes("副图 2/3"),
        detail: `副图 3→${afterPanels.length}（${afterPanels.join("/")}）· 首格顶边 ${beforeTop}→${afterTop}（主图加高 ${
          afterTop - beforeTop
        }）· 抽屉 MACD 已添加=${m06Add?.dataset.drawerAdded}「${m06Add?.textContent?.trim() ?? ""}」· 容量「${capacity.trim()}」`,
      };
    });

    await attempt("R-08", "AC-02.03-03 补3", "render", async () => {
      // 补回 MACD（副图 2/3，可添加）
      const add = q<HTMLButtonElement>('[data-drawer-add="M06:sub"]');
      if (!add) throw new Error("抽屉 MACD 添加按钮不存在");
      add.click();
      await waitFor(() => (panelIds().includes("M06") ? true : null));
      await sleep(160);
      await closeDrawer();
      const full = hooks.bars()?.bars ?? [];
      if (full.length < 40) throw new Error(`当前标的不足 40 根（${full.length}）`);
      const from = full[full.length - 20].date;
      const to = full[full.length - 1].date;
      hooks.setDateRange(from, to);
      await hooks.waitReady("20 根 MACD");
      const panel = q('[data-sub-panel="M06"]');
      if (!panel) throw new Error("M06 副图未渲染");
      const warmup = num(panel, "data-warmup");
      const total = num(svg(), "data-bar-count");
      const empty = panel.getAttribute("data-sub-empty");
      const notice = q('[data-sub-panel="M06"] [data-sub-notice]')?.textContent ?? "";
      const paths = qa('[data-macd]').filter(
        (element) =>
          element.tagName === "path" && (element.getAttribute("d") ?? "").length > 0,
      );
      return {
        passed:
          total <= warmup + 1 &&
          empty === "1" &&
          notice.includes("需要") &&
          notice.includes(`当前 ${total} 根`) &&
          paths.length === 0,
        detail: `区间 ${from}~${to} · 总数 ${total} 根 · warmup ${warmup} · data-sub-empty=${empty} · 提示「${notice}」· 仍绘制的 MACD 线段 ${paths.length}`,
      };
    });

    await attempt("R-09", "AC-02.03-03 补3", "render", async () => {
      hooks.clearDateRange();
      await hooks.waitReady("清范围");
      const total = num(svg(), "data-bar-count");
      const empty = q('[data-sub-panel="M06"]')?.getAttribute("data-sub-empty");
      const paths = qa('[data-macd]').filter(
        (element) =>
          element.tagName === "path" && (element.getAttribute("d") ?? "").length > 0,
      );
      return {
        passed: total > 200 && empty == null && paths.length >= 2,
        detail: `清范围后 ${total} 根 · M06 data-sub-empty=${empty ?? "无"} · MACD 线段 ${paths.length}`,
      };
    });

    const report = {
      ok: checks.every((check) => check.passed),
      phase: "restart" as const,
      finishedAt: new Date().toISOString(),
      checks,
    };
    if (report.ok) {
      window.localStorage.removeItem(PHASE_KEY);
      window.localStorage.removeItem(EXPECT_KEY);
    }
    await ipc.diagWriteNamed("s203-evidence-restart.json", JSON.stringify(report, null, 2));
    return report;
  }

  // ---- 第一轮：默认三格 → 抽屉容量 → 换序 → 改高 → HIST 柱 ----
  hooks.setSubPlots(
    DEFAULT_SUB_PLOTS.map((item) => ({ id: item.id, height: SUB_HEIGHT_DEFAULT })),
  );
  await hooks.waitReady("默认三格");

  await attempt("R-01", "AC-02.03-01", "render", async () => {
    const order = panelIds();
    const titles = panelTitles();
    return {
      passed:
        order.length === 3 &&
        order[0] === VOLUME_PANEL_ID &&
        order[1] === "M06" &&
        order[2] === "M01" &&
        titles.includes("成交量") &&
        titles.includes("MACD(12,26,9)") &&
        titles.includes("RSI(14)"),
      detail: `副图 ${order.length} 格 ${order.join(" / ")} · 标题 ${titles.join(" | ")} · 高度 ${order
        .map((id) => panelHeight(id))
        .join("/")}`,
    };
  });

  await attempt("R-02", "AC-02.03-02", "render", async () => {
    await openDrawer();
    const capacity = q("[data-drawer-capacity]")?.textContent ?? "";
    await setSearch("ATR");
    const button = q<HTMLButtonElement>('[data-drawer-add="V01:sub"]');
    const before = panelIds();
    button?.click();
    await sleep(160);
    const after = panelIds();
    return {
      passed:
        before.length === MAX_SUBPLOTS &&
        Boolean(button?.disabled) &&
        button?.dataset.drawerFull === "1" &&
        (button?.title ?? "") === "副图最多 3 个" &&
        capacity.includes(`副图 ${MAX_SUBPLOTS}/${MAX_SUBPLOTS}`) &&
        after.join(",") === before.join(","),
      detail: `容量「${capacity.trim()}」· V01 禁用=${Boolean(button?.disabled)} full=${
        button?.dataset.drawerFull
      } · tooltip「${button?.title ?? ""}」· 点击后 ${after.join("/")}`,
    };
  });

  await attempt("R-03", "AC-02.03-03", "render", async () => {
    const before = panelIds();
    if (before.length !== 3 || !before.includes("M06")) throw new Error(`默认副图异常：${before.join("/")}`);
    let insertTarget = "未出现";
    // 拖第 2 格（M06）到第 1 位：目标 y 取价格区顶部附近，保证 target=0
    await dragTitleToY("M06", 20, () => {
      const inserted = q("[data-panel-insert]");
      insertTarget = inserted ? String(inserted.getAttribute("data-panel-insert")) : "未出现";
    });
    const order = panelIds();
    const indexes = panels().map((panel) => Number(panel.getAttribute("data-sub-index")));
    const domOk =
      order.length === 3 && order[0] === "M06" && order[1] === VOLUME_PANEL_ID && order[2] === "M01";
    const storedOrder = (stored() ?? []).map((item) => item.id).join("|");
    return {
      passed: domOk && indexes.join(",") === "0,1,2" && storedOrder === "M06|VOL|M01" && insertTarget === "0",
      detail: `换序前 ${before.join("/")} → 后 ${order.join("/")} · data-sub-index ${indexes.join(
        ",",
      )} · 拖动中插入线 target=${insertTarget} · localStorage ${storedOrder}`,
    };
  });

  await attempt("R-04", "AC-02.03-03", "render", async () => {
    // 高度 140 → 200：拖动 60 个 viewBox 单位
    await dragResizeBy("M06", 60, (preview) => {
      if (preview !== 200) throw new Error(`改高预览 ${preview}，期望 200`);
    });
    const dragged = panelHeight("M06");
    // 继续拖到 220 上限（再拖 300 应被夹取）
    await dragResizeBy("M06", 300);
    const clamped = panelHeight("M06");
    // 回到 200，供重启断言
    await dragResizeBy("M06", -20);
    const settled = panelHeight("M06");
    const saved = stored()?.find((item) => item.id === "M06")?.height;
    return {
      passed:
        dragged === 200 &&
        clamped === SUB_HEIGHT_MAX &&
        settled === 200 &&
        saved === 200,
      detail: `改高 140→${dragged} · 越界 340→${clamped}（上限 ${SUB_HEIGHT_MAX}，下限 ${SUB_HEIGHT_MIN}）· 回落 ${settled} · localStorage ${saved}`,
    };
  });

  await attempt("R-05", "AC-02.03-03 补2", "render", async () => {
    const result = hooks.calc()?.series.find((item) => item.indicatorId === "M06");
    if (!result) throw new Error("M06 序列缺失");
    const dif = result.outputs.find((output) => output.key === "dif")?.values;
    const dea = result.outputs.find((output) => output.key === "dea")?.values;
    const hist = result.outputs.find((output) => output.kind === "histogram")?.values;
    if (!dif || !dea || !hist) throw new Error("M06 输出键不完整");

    const start = viewStart();
    const count = viewCount();
    const visibleHist = hist.slice(start, start + count);
    const finiteValues = visibleHist.filter(
      (value): value is number => value !== null && Number.isFinite(value),
    );
    const rects = qa<SVGRectElement>('[data-macd="hist"] rect');
    const maxAbs = Math.max(...finiteValues.map((value) => Math.abs(value)), 0);
    const maxIndex = finiteValues.findIndex((value) => Math.abs(value) === maxAbs);
    const colorsOk = rects.every((rect, index) => {
      const value = finiteValues[index];
      const fill = rect.getAttribute("fill") ?? "";
      return value >= 0 ? fill === "var(--pos)" : fill === "var(--neg)";
    });
    const ratioOk = rects.every((rect, index) => {
      const value = finiteValues[index];
      if (!Number.isFinite(value) || maxAbs === 0 || maxIndex < 0) return false;
      const ratio = Math.abs(value) / maxAbs;
      if (ratio < 0.15) return true;
      return Math.abs(num(rect, "height") / num(rects[maxIndex], "height") - ratio) <= 0.02;
    });

    // 同帧 tooltip 数值：hover 到视窗中部，读 DIF/DEA/HIST
    await hoverIndex(Math.floor(count / 2), 150);
    const readouts = qa<HTMLElement>('[data-readout^="sub-M06-"]');
    const valueOf = (key: string) =>
      Number(readouts.find((el) => (el.dataset.readout ?? "").endsWith(`-${key}`))?.dataset.value ?? "NaN");
    const hoverIdx = Number(q('[data-readout="1"]')?.getAttribute("data-hover-index") ?? "NaN");
    const difValue = valueOf("dif");
    const deaValue = valueOf("dea");
    const histValue = valueOf("hist");
    const formulaOk = Number.isFinite(difValue) && Number.isFinite(deaValue) && Number.isFinite(histValue)
      ? Math.abs(histValue - 2 * (difValue - deaValue)) <= 1e-6
      : false;
    const sourceOk = Number.isFinite(hoverIdx)
      ? Math.abs((hist[start + hoverIdx] ?? Number.NaN) - histValue) <= 1e-6
      : false;

    return {
      passed:
        rects.length === finiteValues.length &&
        finiteValues.length > 0 &&
        colorsOk &&
        ratioOk &&
        formulaOk &&
        sourceOk,
      detail: `可视 ${count} 根 · HIST 柱 ${rects.length} 根 / 有效值 ${finiteValues.length} · 颜色对符号=${
        colorsOk ? "是" : "否"
      } · 柱高比例=${ratioOk ? "对" : "否"} · 第 ${hoverIdx} 根 DIF ${difValue} DEA ${deaValue} HIST ${histValue} → 2×(DIF−DEA)=${2 * (difValue - deaValue)}`,
    };
  });

  // 留重启断言：顺序 M06/VOL/M01，高度 200/140/140
  const finalOrder = panelIds();
  const expect = {
    order: finalOrder,
    heights: Object.fromEntries(finalOrder.map((id) => [id, panelHeight(id)])),
  };
  window.localStorage.setItem(EXPECT_KEY, JSON.stringify(expect));
  window.localStorage.setItem(PHASE_KEY, "restart");

  const report = {
    ok: checks.every((check) => check.passed),
    phase: "first" as const,
    finishedAt: new Date().toISOString(),
    expect,
    pending: ["重启后顺序/高度恢复（第二轮断言 AC-02.03-03）"],
    checks,
  };
  await ipc.diagWriteNamed("s203-evidence.json", JSON.stringify(report, null, 2));
  return report;
}
