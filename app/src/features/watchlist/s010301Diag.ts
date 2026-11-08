//! S-01.03-01 持仓透视取证套件。仅在 `AKA_DIAG_TARGET=s010301` 时触发。
//! 数值口径统一走 positions.ts（与页面同一份实现），渲染层只核对 DOM 文本与正红样式类。

import { describeError, ipc } from "../../lib/ipc";
import {
  positionTexts,
  readAdjMode,
  type AdjMode,
} from "./positions";
import type { PositionDto } from "../../lib/types";

type Layer = "data" | "render";

interface Check {
  id: string;
  ac: string;
  layer: Layer;
  passed: boolean;
  detail: string;
}

export interface S010301DiagReport {
  suite: "S-01.03-01 positions";
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  writtenTo?: string;
  error?: string;
  checks: Check[];
}

const WATCH_CODES = ["600519.SH", "300750.SZ", "002594.SZ", "601318.SH", "600036.SH"];
const SUSPENDED_CODE = "DIAGQSUP.SZ";

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

async function waitFor<T>(probe: () => T | null | false, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await sleep(50);
  }
  throw new Error("等待界面状态超时");
}

const rowFor = (code: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-wl-item="${code}"]`);

const posCell = (code: string, name: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-pos="${code}"] [data-pos-cell="${name}"]`);

const cellText = (code: string, name: string): string => posCell(code, name)?.textContent?.trim() ?? "";

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function position(costPrice: number, shares: number): PositionDto {
  return { security: "600519.SH", costPrice, shares, updatedAt: 0 };
}

async function lastClose(security: string, adj: AdjMode): Promise<number> {
  const response = await ipc.getBars({ security, timeframe: "D", adj });
  const last = response.bars[response.bars.length - 1];
  if (!last) throw new Error(`${security} 在 ${adj} 口径下没有日线`);
  return last.close;
}

async function ensureWatched(codes: string[]): Promise<void> {
  const current = await ipc.watchlist();
  const existing = new Set(current.items.map((item) => item.security));
  let changed = false;
  for (const code of codes) {
    if (existing.has(code)) continue;
    await ipc.toggleWatch(code);
    changed = true;
  }
  if (changed) window.dispatchEvent(new Event("aka:watchlist-refresh"));
}

async function openEditor(code: string): Promise<void> {
  rowFor(code)?.querySelector<HTMLButtonElement>(`[data-pos-menu="${code}"]`)?.click();
  const edit = await waitFor(
    () => document.querySelector<HTMLButtonElement>(`[data-pos-edit="${code}"]`),
    4_000,
  );
  edit.click();
  await waitFor(() => document.querySelector(`[data-pos-drawer="${code}"]`), 4_000);
}

async function fillPosition(code: string, cost: string, shares: string): Promise<void> {
  await openEditor(code);
  const costInput = await waitFor(
    () => document.querySelector<HTMLInputElement>(`[data-pos-drawer="${code}"] [data-pos-input="cost"]`),
    4_000,
  );
  const sharesInput = await waitFor(
    () =>
      document.querySelector<HTMLInputElement>(`[data-pos-drawer="${code}"] [data-pos-input="shares"]`),
    4_000,
  );
  setInput(costInput, cost);
  setInput(sharesInput, shares);
  document.querySelector<HTMLButtonElement>("[data-pos-save]")?.click();
}

export async function runS010301Diagnostics(): Promise<S010301DiagReport> {
  const startedAt = new Date().toISOString();
  const checks: Check[] = [];
  const push = (id: string, ac: string, layer: Layer, passed: boolean, detail: string) =>
    checks.push({ id, ac, layer, passed, detail });

  let adj: AdjMode = readAdjMode();

  try {
    // 清空持仓，构造「5 只自选均未填持仓」的初始场景。
    for (const item of await ipc.positions()) {
      await ipc.deletePosition(item.security);
    }
    await ensureWatched(WATCH_CODES);
    window.dispatchEvent(new Event("aka:watchlist-refresh"));
    await waitFor(() => WATCH_CODES.every((code) => rowFor(code)), 10_000);
    await sleep(800);
    const baseline = await ipc.positions();
    const listText = document.querySelector(".wl-list")?.textContent ?? "";
    push(
      "P10-R1",
      "AC-01.03-02",
      "render",
      baseline.length === 0 &&
        document.querySelectorAll("[data-pos-cell]").length === 0 &&
        !/0\.00|0%/.test(listText),
      `库内持仓 ${baseline.length} 条；持仓单元 ${document.querySelectorAll("[data-pos-cell]").length} 个；列表无 0.00/0%`,
    );

    // 卡面 Given 值走同一派生函数，锁定口径与格式化结果（1682.40 为卡面假设价，Mock 末日收盘另测）。
    const given = positionTexts(position(1500, 100), 1682.4);
    push(
      "P10-R2",
      "AC-01.03-01",
      "data",
      given.marketValue === "168,240.00" &&
        given.pnl === "+18,240.00" &&
        given.pnlPct === "+12.16%" &&
        given.sign === "pos",
      `最新价 1682.40 / 成本 1500 / 100 股 → ${given.marketValue} / ${given.pnl} / ${given.pnlPct} / ${given.sign}`,
    );
    const changed = positionTexts(position(1600, 100), 1682.4);
    push(
      "P10-R3",
      "AC-01.03-01(补1)",
      "data",
      changed.marketValue === "168,240.00" &&
        changed.pnl === "+8,240.00" &&
        changed.pnlPct === "+5.15%",
      `成本改 1600 → ${changed.marketValue} / ${changed.pnl} / ${changed.pnlPct}`,
    );
    const noQuote = positionTexts(position(1500, 100), null);
    push(
      "P10-R4",
      "AC-01.03-03",
      "data",
      noQuote.costPrice === "1,500.00" &&
        noQuote.shares === "100" &&
        noQuote.marketValue === "—" &&
        noQuote.pnl === "—" &&
        noQuote.pnlPct === "—",
      `标的不在数据集 → 成本 ${noQuote.costPrice} / 数量 ${noQuote.shares} / 其余 ${noQuote.marketValue}`,
    );

    // 渲染层：走「⋯ → 填写持仓 → 保存」真实路径。Mock 末日收盘低于 1500，正红用成本 1000 展示。
    const close = await lastClose("600519.SH", adj);
    const expected = positionTexts(position(1000, 100), close);
    await fillPosition("600519.SH", "1000", "100");
    const marketValue = await waitFor(() => {
      const value = cellText("600519.SH", "marketValue");
      return value && value !== "—" ? value : null;
    }, 10_000);
    const pnlCell = posCell("600519.SH", "pnl");
    push(
      "P10-R5",
      "AC-01.03-01",
      "render",
      cellText("600519.SH", "costPrice") === "1,000.00" &&
        cellText("600519.SH", "shares") === "100" &&
        marketValue === expected.marketValue &&
        cellText("600519.SH", "pnl") === expected.pnl &&
        cellText("600519.SH", "pnlPct") === expected.pnlPct &&
        pnlCell?.dataset.posSign === "pos" &&
        pnlCell.classList.contains("pos"),
      `末日收盘 ${close} → ${marketValue} / ${cellText("600519.SH", "pnl")} / ${cellText("600519.SH", "pnlPct")}，正红=${pnlCell?.dataset.posSign}`,
    );

    // 补1：改成本后三值同帧刷新。
    await fillPosition("600519.SH", "1100", "100");
    await waitFor(() => cellText("600519.SH", "costPrice") === "1,100.00", 8_000);
    const expectedSecond = positionTexts(position(1100, 100), close);
    const sameFrame = ["marketValue", "pnl", "pnlPct"].map((name) => cellText("600519.SH", name));
    push(
      "P10-R6",
      "AC-01.03-01(补1)",
      "render",
      sameFrame[0] === expectedSecond.marketValue &&
        sameFrame[1] === expectedSecond.pnl &&
        sameFrame[2] === expectedSecond.pnlPct,
      `改成本 1100 后同一帧读取：${sameFrame.join(" / ")}`,
    );

    // 补4：切不复权 → 提示 + 按新口径重算。
    const noneButton = await waitFor(
      () => document.querySelector<HTMLButtonElement>('[data-adj-mode="none"]'),
      4_000,
    );
    noneButton.click();
    const notice = await waitFor(() => {
      const node = document.querySelector<HTMLElement>("[data-pos-adj-notice]");
      return node && node.textContent?.includes("复权口径已变更，盈亏仅供参考") ? node : null;
    }, 4_000);
    adj = "none";
    const noneClose = await lastClose("600519.SH", adj);
    const expectedNone = positionTexts(position(1100, 100), noneClose);
    await sleep(300);
    push(
      "P10-R7",
      "AC-01.03-01(补4)",
      "render",
      notice.textContent?.trim() === "复权口径已变更，盈亏仅供参考" &&
        cellText("600519.SH", "marketValue") === expectedNone.marketValue &&
        cellText("600519.SH", "pnl") === expectedNone.pnl &&
        cellText("600519.SH", "pnlPct") === expectedNone.pnlPct,
      `提示「${notice.textContent?.trim()}」；不复权收盘 ${noneClose} → ${cellText("600519.SH", "marketValue")} / ${cellText("600519.SH", "pnl")} / ${cellText("600519.SH", "pnlPct")}`,
    );

    // 补2：停牌标本（AKA_DIAG=1 注入）按停牌前收盘计市值并带徽标。
    let suspendedReady = false;
    try {
      await ensureWatched([SUSPENDED_CODE]);
      window.dispatchEvent(new Event("aka:watchlist-refresh"));
      suspendedReady = Boolean(await waitFor(() => rowFor(SUSPENDED_CODE), 8_000));
      await ipc.savePosition(SUSPENDED_CODE, 100, 100);
      window.dispatchEvent(new Event("aka:watchlist-refresh"));
    } catch {
      suspendedReady = false;
    }
    const suspendedBars = suspendedReady ? await lastClose(SUSPENDED_CODE, adj) : null;
    const suspendedExpected =
      suspendedBars == null ? null : positionTexts({ ...position(100, 100), security: SUSPENDED_CODE }, suspendedBars);
    const badge =
      suspendedReady
        ? await waitFor(
            () => document.querySelector<HTMLElement>(`[data-wl-item="${SUSPENDED_CODE}"] [data-pos-suspended]`),
            8_000,
          ).catch(() => null)
        : null;
    push(
      "P10-R8",
      "AC-01.03-01(补2)",
      "render",
      suspendedReady &&
        badge !== null &&
        badge.textContent?.trim() === "停牌" &&
        suspendedExpected !== null &&
        cellText(SUSPENDED_CODE, "marketValue") === suspendedExpected.marketValue &&
        cellText(SUSPENDED_CODE, "pnl") === suspendedExpected.pnl &&
        cellText(SUSPENDED_CODE, "pnl") !== "—",
      suspendedExpected === null
        ? "停牌样本不可用（需 AKA_DIAG=1）"
        : `徽标「${badge?.textContent?.trim() ?? "缺失"}」；停牌前收盘 ${suspendedBars} → ${cellText(SUSPENDED_CODE, "marketValue")} / ${cellText(SUSPENDED_CODE, "pnl")}`,
    );

    // 补3：成本价 0 → 字段标红提示且不写库。
    await openEditor("600519.SH");
    const costInput = await waitFor(
      () =>
        document.querySelector<HTMLInputElement>(
          '[data-pos-drawer="600519.SH"] [data-pos-input="cost"]',
        ),
      4_000,
    );
    setInput(costInput, "0");
    document.querySelector<HTMLButtonElement>("[data-pos-save]")?.click();
    const error = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('[data-pos-error="cost"]');
      return node && node.textContent?.includes("成本价需大于 0") ? node : null;
    }, 4_000).catch(() => null);
    const afterZero = (await ipc.positions()).find((item) => item.security === "600519.SH");
    push(
      "P10-R9",
      "AC-01.03-01(补3)",
      "render",
      error !== null &&
        costInput.getAttribute("aria-invalid") === "true" &&
        afterZero?.costPrice === 1100,
      `提示「${error?.textContent?.trim() ?? "缺失"}」，aria-invalid=${costInput.getAttribute("aria-invalid")}，库内成本价 ${String(afterZero?.costPrice)}`,
    );
    document.querySelector<HTMLButtonElement>("[data-pos-cancel]")?.click();
  } catch (err) {
    const failure = describeError(err);
    push("RUN", "-", "render", false, `${failure.code}: ${failure.message}`);
  }

  const report: S010301DiagReport = {
    suite: "S-01.03-01 positions",
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: checks.every((check) => check.passed),
    checks,
  };

  try {
    report.writtenTo = await ipc.diagWriteNamed(
      "s010301-positions-evidence.json",
      JSON.stringify(report, null, 2),
    );
  } catch (err) {
    report.error = describeError(err).message;
  }
  (window as unknown as Record<string, unknown>).__AKA_S010301_EVIDENCE__ = report;
  return report;
}

/** 仅 `AKA_DIAG_TARGET=s010301` 时触发；异常只影响取证，不影响页面。 */
export async function maybeRunS010301(): Promise<void> {
  try {
    const enabled = await ipc.diagEnabled();
    const target = await ipc.diagTarget();
    if (!enabled || target !== "s010301") return;
    if (window.sessionStorage.getItem("aka.s010301.diag.done") === "1") return;
    window.sessionStorage.setItem("aka.s010301.diag.done", "1");
    await runS010301Diagnostics();
  } catch (error) {
    console.error("[s010301.diag]", describeError(error).message);
  }
}
