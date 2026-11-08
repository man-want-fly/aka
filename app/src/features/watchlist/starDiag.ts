import { describeError, ipc } from "../../lib/ipc";

type Layer = "data" | "render";

interface Check {
  id: string;
  ac: string;
  layer: Layer;
  passed: boolean;
  detail: string;
}

export interface StarDiagReport {
  suite: "S-01.02-01 star";
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  writtenTo?: string;
  error?: string;
  code: string;
  name: string;
  checks: Check[];
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

const marketRows = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-market-row]"));

const rowName = (row: HTMLElement): string =>
  (row.querySelector<HTMLElement>('[data-cell="name"]')?.childNodes[0]?.textContent ?? "").trim();

const starIn = (root: HTMLElement): HTMLButtonElement | null =>
  root.querySelector<HTMLButtonElement>("[data-star]");

/** 只验证「加/移 + 幂等 + 同源」；500 上限与只读写失败由 watchlistDiag / 工单记录覆盖。 */
export async function runStarDiagnostics(): Promise<StarDiagReport> {
  const startedAt = new Date().toISOString();
  const checks: Check[] = [];
  const push = (id: string, ac: string, layer: Layer, passed: boolean, detail: string) =>
    checks.push({ id, ac, layer, passed, detail });

  let code = "";
  let name = "";

  try {
    const rows = await waitFor(() => (marketRows().length > 0 ? marketRows() : null));
    const row =
      rows.find((item) => {
        const star = starIn(item);
        return (
          star?.getAttribute("data-watched") === "0" &&
          item.getAttribute("data-suspended") !== "1" &&
          !rowName(item).match(/涨停|跌停|停牌|数据异常/)
        );
      }) ?? rows[0];
    const star = starIn(row);
    if (!star) throw new Error("行情行内没有星标");
    code = row.dataset.code ?? "";
    name = rowName(row);

    // 起始必须是空心，否则先移出再回读，保证用例可重复。
    if (star.getAttribute("data-watched") === "1") {
      star.click();
      await waitFor(() => {
        const next = starIn(row);
        return next && next.getAttribute("data-watched") === "0" ? next : null;
      });
    }

    const labelAdd = `加入自选：${code} ${name}`;
    push(
      "market-aria-empty",
      "AC-01.02-01",
      "render",
      star.getAttribute("aria-label") === labelAdd,
      `UI 无障碍：aria-label=${star.getAttribute("aria-label")}`,
    );

    // 第 1 次点击：乐观置实 + 落库 1 条未分组记录 + 无 toast。
    star.click();
    await waitFor(() => {
      const next = starIn(row);
      return next && next.getAttribute("data-watched") === "1" ? next : null;
    });
    const afterFirst = await ipc.watchlist();
    const firstItems = afterFirst.items.filter((item) => item.security === code);
    push(
      "market-star-add",
      "AC-01.02-01",
      "render",
      true,
      `点击后 data-watched=1，星标填充（${code} ${name}）`,
    );
    push(
      "market-star-db",
      "AC-01.02-01",
      "data",
      firstItems.length === 1 && firstItems[0].groupName === null,
      `watchlist_items 命中 ${firstItems.length} 条，groupName=${String(firstItems[0]?.groupName)}，total=${afterFirst.total}`,
    );
    push(
      "market-star-no-toast",
      "AC-01.02-01",
      "render",
      !document.querySelector(".market-toast"),
      "点击后无 toast",
    );

    // 再点 4 次（共 5 次）：最终实心、库内仍 1 条。
    for (let i = 0; i < 4; i += 1) {
      starIn(row)?.click();
      await sleep(300);
    }
    const finalStar = await waitFor(() => {
      const next = starIn(row);
      return next && next.getAttribute("data-watched") === "1" ? next : null;
    });
    const afterFive = await ipc.watchlist();
    const fiveItems = afterFive.items.filter((item) => item.security === code);
    push(
      "market-star-idempotent",
      "AC-01.02-01（补1）",
      "render",
      finalStar.getAttribute("data-watched") === "1" && !document.querySelector(".market-toast"),
      `连点 5 次后 data-watched=${finalStar.getAttribute("data-watched")}，toast=${Boolean(document.querySelector(".market-toast"))}`,
    );
    push(
      "market-star-idempotent-db",
      "AC-01.02-01（补1）",
      "data",
      fiveItems.length === 1,
      `连点 5 次后库内 ${fiveItems.length} 条`,
    );

    // 工作台报价头右上星标：实心、可整行移出。
    window.location.hash = `#/workbench/${encodeURIComponent(code)}`;
    const headerStar = await waitFor(() => {
      const header = document.querySelector<HTMLElement>(".sec-identity");
      const button = header?.querySelector<HTMLButtonElement>("[data-star]");
      return button &&
        button.getAttribute("data-watched") === "1" &&
        button.getAttribute("aria-label") === `移出自选：${code} ${name}`
        ? button
        : null;
    });
    push(
      "quote-aria-filled",
      "AC-01.02-01",
      "render",
      headerStar.getAttribute("aria-label") === `移出自选：${code} ${name}`,
      `UI 无障碍：aria-label=${headerStar.getAttribute("aria-label")}`,
    );

    headerStar.click();
    await waitFor(() => {
      const header = document.querySelector<HTMLElement>(".sec-identity");
      const button = header?.querySelector<HTMLButtonElement>("[data-star]");
      return button && button.getAttribute("data-watched") === "0" ? button : null;
    });
    const afterRemove = await ipc.watchlist();
    push(
      "quote-star-remove",
      "AC-01.02-01（补2）",
      "render",
      !document.querySelector("[data-wb-watch-error]"),
      "报价头取消后星标回到空心，且无「自选未保存」错误条",
    );
    push(
      "quote-star-remove-db",
      "AC-01.02-01（补2）",
      "data",
      afterRemove.items.every((item) => item.security !== code),
      `移出后库内该标的 ${afterRemove.items.filter((item) => item.security === code).length} 条，total=${afterRemove.total}`,
    );
  } catch (err) {
    const failure = describeError(err);
    push("RUN", "-", "render", false, `${failure.code}: ${failure.message}`);
  }

  const report: StarDiagReport = {
    suite: "S-01.02-01 star",
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: checks.every((check) => check.passed),
    code,
    name,
    checks,
  };

  try {
    report.writtenTo = await ipc.diagWriteNamed(
      "s010201-star-evidence.json",
      JSON.stringify(report, null, 2),
    );
  } catch (err) {
    report.error = describeError(err).message;
  }
  (window as unknown as Record<string, unknown>).__AKA_S010201_EVIDENCE__ = report;
  return report;
}
