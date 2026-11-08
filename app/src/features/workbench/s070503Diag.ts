/**
 * S-07.05-03 溯源浮层实机取证（AC-07.05-04）。
 *
 * 全部通过真实 DOM 驱动：用 PointerEvent 点主图 bar，读浮层六字段；
 * ESC / 点外 / 切标的关闭；点击窗口内包住 Tauri invoke，断言只复用 bar_provenance。
 * 缺失字段样本来自 debug 注入（DIAGPROV.SZ 最后一根清空 batch_id/ingested_at），
 * 停牌标记沿用 DIAGSUSP.SZ。release 不注入，本套件只在 debug + AKA_DIAG 下运行。
 */

import { ipc, setInvokeAudit } from "../../lib/ipc";
import type { BarsResponse } from "../../lib/types";
import { collectEvidenceEnv, collectFocus } from "./diag";

interface Check {
  id: string;
  card: "S-07.05-03";
  ac: "AC-07.05-04";
  layer: "data" | "render" | "runtime";
  passed: boolean;
  detail: string;
}

const CARD = "S-07.05-03" as const;
const AC = "AC-07.05-04" as const;

const ALLOWED_FLAGS = new Set(["EX_RIGHTS", "SUSPENDED", "ZERO_VOLUME", "PRICE_ANOMALY"]);
const SIX_FIELDS = ["provider", "batchId", "ingestedAt", "datasetId", "adjMode", "qualityFlags"] as const;

const LEFT = 6;
const RIGHT = 938;

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
const q = <T extends Element>(selector: string) => document.querySelector<T>(selector);

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
  };
};

/** 与 CandleChart 的 pointer 换算一致：viewBox meet 居中 */
const geometry = () => {
  const node = svg();
  const rect = node.getBoundingClientRect();
  const viewBox = node.getAttribute("viewBox") ?? "";
  const height = Number(viewBox.split(/\s+/)[3] ?? "NaN") || 560;
  const scale = Math.min(rect.width / 1000, rect.height / height);
  return {
    rect,
    scale,
    offsetX: (rect.width - 1000 * scale) / 2,
    offsetY: (rect.height - height * scale) / 2,
  };
};

const clientPoint = (absoluteIndex: number, yUser: number) => {
  const { rect, scale, offsetX, offsetY } = geometry();
  const { start, end } = viewInfo();
  const count = end - start + 1;
  const relative = absoluteIndex - start;
  if (relative < 0 || relative >= count) {
    throw new Error(`下标 ${absoluteIndex} 不在视口 ${start}~${end}`);
  }
  const step = (RIGHT - LEFT) / count;
  const xUser = LEFT + relative * step + step / 2;
  return {
    clientX: rect.left + offsetX + xUser * scale,
    clientY: rect.top + offsetY + yUser * scale,
  };
};

/** 双击复位视口（默认 120 根），确保待点 bar 在可视区内 */
const resetView = async (total: number) => {
  svg().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  const deadline = Date.now() + 2_000;
  for (;;) {
    if (num(svg(), "data-view-end") === total - 1) return;
    if (Date.now() > deadline) return;
    await sleep(30);
  }
};

const firePointer = (
  node: SVGSVGElement,
  type: "pointerdown" | "pointerup",
  point: { clientX: number; clientY: number },
) => {
  node.dispatchEvent(
    new PointerEvent(type, {
      clientX: point.clientX,
      clientY: point.clientY,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      pointerId: 1,
      pointerType: "mouse",
      bubbles: true,
      cancelable: true,
    }),
  );
};

/**
 * 点击期间旁路记录 Tauri 命令名（用于「无新增 IPC」）。
 *
 * 不得改写 `window.__TAURI_INTERNALS__.invoke`：Tauri 用 Object.defineProperty 注入，
 * 该属性不可写且不可配置，严格模式下赋值直接抛「Attempted to assign to readonly property」。
 * 改为在唯一 IPC 出口（lib/ipc.ts）挂只读监听，不碰注入对象也不影响调用行为。
 */
const clickBar = async (absoluteIndex: number, total: number, audit?: string[]) => {
  await resetView(total);
  const node = svg();
  const point = clientPoint(absoluteIndex, 150);
  if (audit) setInvokeAudit((command) => audit.push(command));
  try {
    firePointer(node, "pointerdown", point);
    await sleep(20);
    firePointer(node, "pointerup", point);
    await sleep(60);
  } finally {
    if (audit) setInvokeAudit(null);
  }
};

const overlay = () => q<HTMLElement>("[data-provenance='1']");
const overlayDate = () => overlay()?.getAttribute("data-provenance-date") ?? "";
const fieldText = (name: string) =>
  overlay()?.querySelector(`[data-prov-field="${name}"]`)?.textContent?.trim() ?? "";
const sixFields = () => SIX_FIELDS.map((name) => `${name}=${fieldText(name)}`).join(" | ");
const missingBadge = () =>
  overlay()?.querySelector("[data-provenance-missing='1']")?.textContent?.trim() ?? "";

const waitOverlay = async (timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const node = overlay();
    if (node) return node;
    if (Date.now() > deadline) throw new Error("浮层未出现");
    await sleep(30);
  }
};

const waitOverlayGone = async (timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (overlay() === null) return true;
    if (Date.now() > deadline) return false;
    await sleep(30);
  }
};

const flagsOk = (text: string) =>
  text === "无" || text.split("、").every((flag) => ALLOWED_FLAGS.has(flag));

export async function runS070503Diagnostics(hooks: {
  getBars: () => BarsResponse | null;
  getActiveCode: () => string;
  getTimeframe: () => string;
  setCode: (code: string) => void;
  setTimeframe: (timeframe: "D") => void;
}) {
  const checks: Check[] = [];
  const push = (id: string, layer: Check["layer"], passed: boolean, detail: string) => {
    checks.push({ id, card: CARD, ac: AC, layer, passed, detail });
  };

  const waitReady = async (code: string, label: string, timeoutMs = 6_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const bars = hooks.getBars();
      if (
        bars &&
        bars.security === code &&
        bars.security === hooks.getActiveCode() &&
        bars.timeframe === hooks.getTimeframe() &&
        bars.bars.length > 0
      ) {
        return bars;
      }
      if (Date.now() > deadline) throw new Error(`等待行情超时：${label}`);
      await sleep(40);
    }
  };

  hooks.setTimeframe("D");

  // 1) 正常根：600519.SH 最后一根，有完整批次元数据
  hooks.setCode("600519.SH");
  const normalBars = await waitReady("600519.SH", "正常样本");
  const normalIndex = normalBars.bars.length - 1;
  await clickBar(normalIndex, normalBars.bars.length);
  await waitOverlay();
  const normalDate = normalBars.bars[normalIndex].date;
  const normalFields = SIX_FIELDS.map((name) => fieldText(name));
  const normalFlags = fieldText("qualityFlags");
  push(
    "OV-01",
    "render",
    overlayDate() === normalDate &&
      normalFields.every((text) => text !== "" && !text.includes("缺失")) &&
      flagsOk(normalFlags),
    `bar=${normalDate} · ${sixFields()}`,
  );

  // 2) 无新增 IPC：一次点击只允许一条 bar_provenance（复用 S-07.05-02）
  const commands: string[] = [];
  await clickBar(normalIndex - 1, normalBars.bars.length, commands);
  await waitOverlay();
  push(
    "OV-02",
    "runtime",
    commands.length === 1 && commands[0] === "bar_provenance",
    `点击窗口内 invoke=${commands.length} 次：[${commands.join(", ")}]（期望仅 bar_provenance）`,
  );

  // 3) ESC 关闭
  const escOpen = overlay() !== null;
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const escGone = await waitOverlayGone();
  push("OV-03", "render", escOpen && escGone, `打开=${escOpen} · ESC 后关闭=${escGone}`);

  // 4) 点外关闭
  await clickBar(normalIndex, normalBars.bars.length);
  await waitOverlay();
  document.body.dispatchEvent(
    new PointerEvent("pointerdown", {
      clientX: 12,
      clientY: 12,
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
    }),
  );
  const outsideGone = await waitOverlayGone();
  push("OV-04", "render", outsideGone, `浮层打开后点图表外 → 关闭=${outsideGone}`);

  // 5) 切标的清空（叠加下一段停牌样本，顺带准备 flags 取证）
  await clickBar(normalIndex, normalBars.bars.length);
  await waitOverlay();
  hooks.setCode("DIAGSUSP.SZ");
  const cleared = await waitOverlayGone(3_000);
  push("OV-05", "render", cleared, `600519.SH 浮层打开 → 切 DIAGSUSP.SZ 后关闭=${cleared}`);

  // 6) 含 quality_flags 的根：DIAGSUSP.SZ 第 90 根（停牌合成行）
  const suspBars = await waitReady("DIAGSUSP.SZ", "停牌样本");
  const suspIndex = 90;
  await clickBar(suspIndex, suspBars.bars.length);
  await waitOverlay();
  const suspFlags = fieldText("qualityFlags");
  push(
    "OV-06",
    "render",
    overlayDate() === suspBars.bars[suspIndex].date &&
      suspFlags.includes("SUSPENDED") &&
      flagsOk(suspFlags) &&
      ["provider", "batchId", "ingestedAt", "datasetId", "adjMode"].every(
        (name) => fieldText(name) !== "" && !fieldText(name).includes("缺失"),
      ),
    `bar=${suspBars.bars[suspIndex].date} · ${sixFields()}`,
  );

  // 7) 缺失字段根：DIAGPROV.SZ 最后一根（debug 注入清空 batch_id/ingested_at）
  hooks.setCode("DIAGPROV.SZ");
  const missingBars = await waitReady("DIAGPROV.SZ", "缺失样本");
  const missingIndex = missingBars.bars.length - 1;
  await clickBar(missingIndex, missingBars.bars.length);
  await waitOverlay();
  const missingFieldsOk =
    fieldText("batchId") === "缺失" && fieldText("ingestedAt") === "缺失";
  const othersOk = ["provider", "datasetId", "adjMode"].every(
    (name) => fieldText(name) !== "" && !fieldText(name).includes("缺失"),
  );
  push(
    "OV-07",
    "render",
    missingFieldsOk &&
      othersOk &&
      missingBadge().includes("E_PROVENANCE_MISSING") &&
      flagsOk(fieldText("qualityFlags")),
    `bar=${overlayDate()} · ${sixFields()} · 缺失码=${missingBadge()}`,
  );

  // 8) P9 入口不得伪造
  const fabricated =
    q("[data-p9-example]") !== null ||
    q("[data-quality-section='1']") !== null ||
    (document.body.textContent ?? "").includes("查看示例");
  push("OV-08", "render", !fabricated, `工作台内 P9 入口/「查看示例」= ${fabricated ? "存在（伪造）" : "不存在"}`);

  // R-EV-02：env 与聚焦状态由 diag.ts 统一产出；env 采集失败也照常落 dump（由 verify 判 failed）。
  const env = await collectEvidenceEnv("s070503").catch(() => null);
  const focus = collectFocus();

  const report = {
    suite: "S-07.05-03 provenance overlay",
    card: CARD,
    ok: checks.every((check) => check.passed),
    env,
    windowFocused: focus.windowFocused,
    appActive: focus.appActive,
    finishedAt: new Date().toISOString(),
    acVerdict: {
      "AC-07.05-04": checks.every((check) => check.passed) ? "PASS" : "FAIL",
      "AC-07.05-04（补1）": "BLOCKED",
    },
    blocked: [
      {
        ac: "AC-07.05-04（补1）",
        blocker: "S-07.05-01",
        reason: "P9 页面/路由与质量报告「查看示例」入口未合入 main；不判 PASS、不记跳过",
        skipped: false,
      },
    ],
    checks,
  };
  const written = await ipc.diagWriteNamed(
    "s070503-evidence.json",
    JSON.stringify(report, null, 2),
  );
  return { ...report, writtenTo: written };
}
