import { formatAmount, formatPct, formatPrice, formatVolume } from "../../lib/format";
import { describeError } from "../../lib/ipc";
import { ipc } from "../../lib/ipc";
import { DISPLAY_SCOPE, ROW_HEIGHT } from "../../lib/settings";

type Layer = "data" | "render";

interface Check {
  id: string;
  ac: string;
  layer: Layer;
  passed: boolean;
  detail: string;
}

export interface SettingsDiagReport {
  suite: "S-06.02-01 display";
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  writtenTo?: string;
  error?: string;
  checks: Check[];
  context: {
    density: string;
    marketRowHeight: number;
    watchlistRowHeight: number;
  };
}

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

const click = (el: HTMLElement | null, label: string) => {
  if (!el) throw new Error(`找不到可点击元素：${label}`);
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
};

const rowsOf = (): HTMLElement[] => {
  const table = document.querySelector<HTMLElement>("[data-market-table]");
  return Array.from(table?.querySelectorAll<HTMLElement>("[data-market-row]") ?? []);
};

const cellText = (row: HTMLElement, cell: string): string =>
  row.querySelector<HTMLElement>(`[data-cell="${cell}"]`)?.textContent?.trim() ?? "";

const topRowIndex = (): number => {
  const table = document.querySelector<HTMLElement>("[data-market-table]");
  if (!table) return -1;
  const top = table.getBoundingClientRect().top;
  return rowsOf().findIndex((row) => row.getBoundingClientRect().bottom > top + 1);
};

const MINUS = "\u2212";

export async function runSettingsDiagnostics(): Promise<SettingsDiagReport> {
  const startedAt = new Date().toISOString();
  const checks: Check[] = [];
  const push = (id: string, ac: string, layer: Layer, passed: boolean, detail: string) =>
    checks.push({ id, ac, layer, passed, detail });

  let marketRowHeight = 0;
  let watchlistRowHeight = 0;
  let density = "";

  try {
    await waitFor(() => document.querySelector<HTMLElement>("[data-settings-root]"));
    await sleep(120);
    density = document.documentElement.dataset.density ?? "";
    push("set-default-compact", "AC-06.02-01（补2）", "data", density === "compact", `默认密度=${density}`);

    // AC-06.02-02（补2）：四类数字只有一份口径，直接对函数输出打表。
    const formatCases = [
      ["price", formatPrice(1684.2), "1,684.20"],
      ["price-negative", formatPrice(-1234.5), `${MINUS}1,234.50`],
      ["percent-plus", formatPct(1.24), "+1.24%"],
      ["percent-minus", formatPct(-0.86), `${MINUS}0.86%`],
      ["volume", formatVolume(123_400), "1,234.0手"],
      ["amount-yi", formatAmount(124_000_000), "1.24亿"],
      ["amount-wan", formatAmount(35_000_000), "3,500.00万"],
    ] as const;
    const badFormat = formatCases.filter(([, actual, expected]) => actual !== expected);
    push(
      "format-function",
      "AC-06.02-02（补2）",
      "data",
      badFormat.length === 0,
      badFormat.length === 0
        ? formatCases.map(([name, actual]) => `${name}=${actual}`).join(" ")
        : badFormat.map(([name, actual, expected]) => `${name}:${actual}≠${expected}`).join(" "),
    );

    // 渲染层：设置页把同一口径直接展示给用户。
    const sample = (name: string) =>
      document.querySelector<HTMLElement>(`[data-format-sample="${name}"]`)?.textContent?.trim() ?? "";
    const renderedFormats =
      sample("price") === "1,684.20" &&
      sample("percent") === `+1.24% / ${MINUS}0.86%` &&
      sample("volume") === "1,234.0手" &&
      sample("amount") === "1.24亿 / 3,500.00万";
    push(
      "format-rendered",
      "AC-06.02-02（补1）",
      "render",
      renderedFormats,
      `price=${sample("price")} percent=${sample("percent")} volume=${sample("volume")} amount=${sample("amount")}`,
    );

    // 切到舒适 → 行情行高 34px，并从 state.db 读回。
    click(document.querySelector<HTMLElement>('[data-density-option="comfy"]'), "舒适");
    await waitFor(() => document.documentElement.dataset.density === "comfy");
    const persisted = await ipc.viewStateGet(DISPLAY_SCOPE);
    push(
      "persist-comfy",
      "AC-06.02-01（补2）",
      "data",
      Boolean(persisted && (persisted as { density?: string }).density === "comfy"),
      `view_state(${DISPLAY_SCOPE})=${JSON.stringify(persisted)}`,
    );

    window.location.hash = "#/market";
    await waitFor(() => rowsOf().length > 0);
    await sleep(120);
    const comfyRows = rowsOf();
    marketRowHeight = Math.round(comfyRows[1].getBoundingClientRect().height);
    push(
      "row-height-comfy",
      "AC-06.02-01",
      "render",
      marketRowHeight === ROW_HEIGHT.comfy,
      `行情行高=${marketRowHeight}px（期望 ${ROW_HEIGHT.comfy}px，样本 ${comfyRows.length} 行）`,
    );

    // 千分位：至少一只 ≥1000 的价格显示逗号；百分比正负号符合口径。
    const prices = comfyRows.map((row) => cellText(row, "lastPrice")).filter((text) => text !== "—");
    const pcts = comfyRows.map((row) => cellText(row, "changePct")).filter((text) => text !== "—");
    const amounts = comfyRows.map((row) => cellText(row, "amount")).filter((text) => text !== "—");
    const priceOk = prices.some((text) => /^\d{1,3}(,\d{3})*\.\d{2}$/.test(text));
    const pctOk =
      pcts.some((text) => text.startsWith("+")) &&
      pcts.some((text) => text.startsWith(MINUS)) &&
      pcts.every((text) => /^[+\-\u2212]\d+\.\d{2}%$/.test(text));
    const amountOk = amounts.every((text) => /^\d{1,3}(,\d{3})*\.\d{2}(亿|万)?$/.test(text));
    push(
      "format-price-1000",
      "AC-06.02-02（补1）",
      "render",
      priceOk,
      priceOk ? prices.find((text) => text.includes(",")) ?? "" : `未见千分位：${prices.slice(0, 5).join("/")}`,
    );
    push(
      "format-pct-sign",
      "AC-06.02-02（补1）",
      "render",
      pctOk,
      `正=${pcts.find((text) => text.startsWith("+")) ?? "无"} 负=${pcts.find((text) => text.startsWith(MINUS)) ?? "无"}`,
    );
    push(
      "format-amount-unit",
      "AC-06.02-02（补1）",
      "render",
      amountOk,
      amounts.slice(0, 5).join(" / "),
    );

    // AC-06.02-01（补1）：滚到第 50 行后切紧凑，顶部可见行不跳。
    const table = document.querySelector<HTMLElement>("[data-market-table]");
    const targetRow = comfyRows[Math.min(50, comfyRows.length - 1)];
    if (table && targetRow) table.scrollTop = targetRow.offsetTop - comfyRows[0].offsetTop;
    await sleep(80);
    const before = topRowIndex();
    click(document.querySelector<HTMLElement>('[data-market-density="compact"]'), "紧凑");
    await waitFor(() => document.documentElement.dataset.density === "compact");
    await sleep(120);
    const compactRows = rowsOf();
    marketRowHeight = Math.round(compactRows[1].getBoundingClientRect().height);
    const after = topRowIndex();
    push(
      "row-height-compact",
      "AC-06.02-01",
      "render",
      marketRowHeight === ROW_HEIGHT.compact,
      `行情行高=${marketRowHeight}px（期望 ${ROW_HEIGHT.compact}px）`,
    );
    push(
      "scroll-anchor",
      "AC-06.02-01（补1）",
      "render",
      before >= 45 && Math.abs(after - before) <= 1,
      `切换前顶部行=${before} 切换后顶部行=${after}`,
    );

    // 自选行高同口径：进工作台读取左栏行高与报价头格式。
    window.location.hash = "#/workbench/600519.SH";
    await waitFor(() => document.querySelector<HTMLElement>('[data-quote-head="1"]'));
    await sleep(180);
    const wlRow = document.querySelector<HTMLElement>("[data-wl-item]");
    watchlistRowHeight = wlRow ? Math.round(wlRow.getBoundingClientRect().height) : 0;
    push(
      "watchlist-row-height",
      "AC-06.02-01",
      "render",
      watchlistRowHeight === ROW_HEIGHT.compact,
      `自选行高=${watchlistRowHeight}px（期望 ${ROW_HEIGHT.compact}px）`,
    );

    const stats = Array.from(
      document.querySelectorAll<HTMLElement>('[data-quote-head="1"] > span'),
    ).map((span) => span.textContent?.trim() ?? "");
    const volumeText = stats.find((text) => text.startsWith("量"))?.replace(/^量/, "") ?? "";
    const amountText = stats.find((text) => text.startsWith("额"))?.replace(/^额/, "") ?? "";
    const quoteOk =
      /^[\d,]+\.\d手$|^[\d,]+\.\d[万亿]手$/.test(volumeText) &&
      /^[\d,]+\.\d{2}(亿|万)?$/.test(amountText);
    push(
      "quote-format",
      "AC-06.02-02（补1）",
      "render",
      quoteOk,
      `量=${volumeText} 额=${amountText}`,
    );

    const afterReload = await ipc.viewStateGet(DISPLAY_SCOPE);
    push(
      "persist-compact",
      "AC-06.02-01（补2）",
      "data",
      Boolean(afterReload && (afterReload as { density?: string }).density === "compact"),
      `view_state=${JSON.stringify(afterReload)}`,
    );
  } catch (err) {
    const failure = describeError(err);
    push("RUN", "-", "render", false, `${failure.code}: ${failure.message}`);
  }

  const report: SettingsDiagReport = {
    suite: "S-06.02-01 display",
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: checks.every((check) => check.passed),
    checks,
    context: {
      density: document.documentElement.dataset.density ?? "",
      marketRowHeight,
      watchlistRowHeight,
    },
  };

  try {
    report.writtenTo = await ipc.diagWriteNamed(
      "s0602-display-evidence.json",
      JSON.stringify(report, null, 2),
    );
  } catch (err) {
    report.error = describeError(err).message;
  }
  (window as unknown as Record<string, unknown>).__AKA_S0602_EVIDENCE__ = report;
  return report;
}
