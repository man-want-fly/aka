import { describeError, ipc } from "../../lib/ipc";
import type { MarketSnapshotDto } from "../../lib/types";

type Layer = "data" | "render";

interface Check {
  id: string;
  ac: string;
  layer: Layer;
  passed: boolean;
  detail: string;
}

export interface MarketDiagReport {
  suite: "E-01 market";
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  writtenTo?: string;
  error?: string;
  checks: Check[];
  context: {
    snapshotRows: number;
    sampleCount: number;
    dataDate: string;
    boardCounts: Record<string, number>;
  };
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

async function waitFor<T>(probe: () => T | null | false, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await sleep(50);
  }
  throw new Error("等待界面状态超时");
}

const rowEls = (): HTMLElement[] => {
  const table = document.querySelector<HTMLElement>("[data-market-table]");
  return Array.from(table?.querySelectorAll<HTMLElement>("[data-market-row]") ?? []);
};

const cellText = (row: HTMLElement, cell: string): string =>
  row.querySelector<HTMLElement>(`[data-cell="${cell}"]`)?.textContent?.trim() ?? "";

const click = (el: HTMLElement | null, label: string) => {
  if (!el) throw new Error(`找不到可点击元素：${label}`);
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
};

const press = (el: HTMLElement | Window, key: string) => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
};

/** 与 MarketPage.sameBoard 同口径（写死在这里，避免诊断依赖被测代码本身） */
function inBoard(row: MarketSnapshotDto["rows"][number], board: string): boolean {
  switch (board) {
    case "all":
      return true;
    case "sh":
      return row.market === "SH" && (row.board === "主板" || row.board === "指数");
    case "sz":
      return row.market === "SZ" && (row.board === "主板" || row.board === "指数");
    case "chinext":
      return row.board === "创业板";
    case "star":
      return row.board === "科创板";
    default:
      return false;
  }
}

/**
 * E-01 行情列表渲染层自证（S-01.01-01/02/03）。
 * 只在 AKA_DIAG=1 时由 MarketPage 触发；所有断言直接打在真实 DOM 与 state.db 上。
 */
export async function runMarketDiagnostics(): Promise<MarketDiagReport> {
  const checks: Check[] = [];
  const push = (id: string, ac: string, layer: Layer, passed: boolean, detail: string) => {
    checks.push({ id, ac, layer, passed, detail });
  };

  const startedAt = new Date().toISOString();
  let snapshot: MarketSnapshotDto | null = null;
  const boardCounts: Record<string, number> = {};

  try {
    snapshot = await ipc.marketSnapshot();
    const rows = snapshot.rows;

    // ---- 数据层：样本与分区口径 ----
    push(
      "D-01",
      "AC-01.01-01",
      "data",
      rows.length === 120 && snapshot.sampleCount === 120,
      `rows=${rows.length} sampleCount=${snapshot.sampleCount} dataDate=${snapshot.dataDate}`,
    );

    for (const board of ["all", "sh", "sz", "chinext", "star"]) {
      boardCounts[board] = rows.filter((row) => inBoard(row, board)).length;
    }
    push(
      "D-02",
      "AC-01.01-02",
      "data",
      boardCounts.all === 120 &&
        boardCounts.sh + boardCounts.sz + boardCounts.chinext + boardCounts.star === 120,
      `全部=${boardCounts.all} 沪=${boardCounts.sh} 深=${boardCounts.sz} 创=${boardCounts.chinext} 科=${boardCounts.star}`,
    );

    const byAmount = [...rows]
      .filter((row) => row.amount != null)
      .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));
    push(
      "D-03",
      "AC-01.01-01(补2)",
      "data",
      byAmount.length >= 4 &&
        [0, 1, 2].every((i) => (byAmount[i].amount ?? 0) > (byAmount[i + 1].amount ?? 0)),
      `前 4 行成交额：${byAmount.slice(0, 4).map((row) => `${row.code}=${row.amount}`).join(" / ")}`,
    );

    // ---- 渲染层：页头 / 行数 / 徽标 ----
    await waitFor(() => rowEls().length > 0);
    const summary = document.querySelector<HTMLElement>("[data-market-summary]")?.textContent ?? "";
    const sim = document.querySelector<HTMLElement>(".pill.sim")?.textContent ?? "";
    push(
      "R-01",
      "AC-01.01-01",
      "render",
      summary.includes("样本 120 只") && summary.includes(snapshot.dataDate) && sim.includes("模拟"),
      `页头="${summary.trim()}" 徽标="${sim.trim()}"`,
    );

    // 归一化到卡上的默认视图（全部分区 / 成交额降序 / 9 列全显），
    // 否则上一轮持久化在 state.db 里的视图会污染本轮断言。
    click(await waitFor(() => document.querySelector<HTMLElement>('[data-market-board="all"]')), "全部分区");
    click(
      await waitFor(() => document.querySelector<HTMLElement>("[data-market-columns-toggle]")),
      "列设置",
    );
    await waitFor(() => document.querySelector<HTMLElement>("[data-market-columns]"));
    for (const column of ["changeAbs", "turnoverPct", "volumeRatio", "amplitudePct"]) {
      const input = document.querySelector<HTMLInputElement>(`[data-market-column="${column}"]`);
      if (input && !input.checked) {
        input.click();
        await sleep(40);
      }
    }
    const amountHeaderInit = await waitFor(() =>
      document.querySelector<HTMLElement>('[data-market-sort="amount"]'),
    );
    if (amountHeaderInit.dataset.sortDir !== "desc") {
      click(amountHeaderInit, "成交额列头");
      await sleep(100);
    }
    await sleep(100);

    const domRows = rowEls();
    const footerCount = document.querySelector<HTMLElement>("[data-market-count]")?.textContent?.trim();
    const codes = domRows.map((row) => row.dataset.code ?? "");
    const duplicates = codes.filter((code, index) => codes.indexOf(code) !== index);
    const head = domRows.slice(0, 3).map((row) => `${row.dataset.code}[${cellText(row, "amount")}]`);
    const tableEl = document.querySelector<HTMLElement>("[data-market-table]");
    const childInfo = Array.from(tableEl?.children ?? [])
      .slice(0, 4)
      .map(
        (el) =>
          `${el.className.includes("head") ? "HEAD" : "ROW"}:${(el as HTMLElement).dataset.code ?? "-"}:${
            (el as HTMLElement).hasAttribute("data-market-row") ? "attr" : "no-attr"
          }`,
      );
    push(
      "R-02",
      "AC-01.01-01",
      "render",
      domRows.length === 120 && new Set(codes).size === 120,
      `DOM 行数=${domRows.length} 全文档=${document.querySelectorAll("[data-market-row]").length} 去重=${
        new Set(codes).size
      } 页脚="${footerCount}" 重复=${duplicates.join(",")} 前3=${head.join(" / ")} 子节点=${childInfo.join(
        " | ",
      )} 序列=${codes.slice(0, 12).join(",")} 数据重复=${
        rows.length - new Set(rows.map((row) => row.security)).size
      }`,
    );

    // ---- 渲染层：涨跌幅符号 / 停牌 / 空值 ----
    const pctProblems: string[] = [];
    const suspendedProblems: string[] = [];
    for (const row of domRows) {
      const suspended = row.dataset.suspended === "1";
      const pct = cellText(row, "changePct");
      if (suspended) {
        if (pct !== "—") suspendedProblems.push(`${row.dataset.code} 停牌却显示 ${pct}`);
        const name = row.querySelector<HTMLElement>('[data-cell="name"]');
        if (!name?.textContent?.includes("停牌")) suspendedProblems.push(`${row.dataset.code} 缺停牌徽标`);
      } else if (!/^[+-]\d+\.\d{2}%$/.test(pct)) {
        pctProblems.push(`${row.dataset.code}=${pct}`);
      }
    }
    push(
      "R-03",
      "AC-01.01-01(补1)",
      "render",
      pctProblems.length === 0 && suspendedProblems.length === 0,
      `符号异常=${pctProblems.length} 停牌异常=${suspendedProblems.length} ${
        pctProblems.slice(0, 3).join(",") || ""
      }`,
    );

    // ---- 渲染层：默认排序成交额降序 ----
    const firstAmounts = rowEls()
      .map((row) => Number(row.querySelector<HTMLElement>('[data-cell="amount"]')?.dataset.value ?? "NaN"))
      .filter((value) => Number.isFinite(value))
      .slice(0, 4);
    push(
      "R-04",
      "AC-01.01-01(补2)",
      "render",
      firstAmounts.every((value, index) => index === 0 || value <= firstAmounts[index - 1]),
      `DOM 前 4 行成交额=${firstAmounts.join(" / ")}`,
    );

    // ---- 渲染层：分区计数与数据层一致 ----
    const chipCounts: Record<string, number> = {};
    for (const chip of Array.from(
      document.querySelectorAll<HTMLElement>("[data-market-board]"),
    )) {
      chipCounts[chip.dataset.marketBoard ?? ""] = Number(chip.dataset.count ?? "-1");
    }
    push(
      "R-05",
      "AC-01.01-02",
      "render",
      ["all", "sh", "sz", "chinext", "star"].every(
        (board) => chipCounts[board] === boardCounts[board],
      ),
      `DOM=${JSON.stringify(chipCounts)} data=${JSON.stringify(boardCounts)}`,
    );

    // ---- 渲染层：列头三态排序 ----
    const firstBefore = rowEls()[0]?.dataset.code ?? "";
    click(
      document.querySelector<HTMLElement>('[data-market-sort="amount"]'),
      "成交额列头",
    );
    await sleep(80);
    const amountHeader = document.querySelector<HTMLElement>('[data-market-sort="amount"]');
    const afterAsc = rowEls()[0]?.dataset.code ?? "";
    push(
      "R-06",
      "AC-01.01-03",
      "render",
      amountHeader?.dataset.sortDir === "asc" &&
        amountHeader.textContent?.includes("↑") === true &&
        afterAsc !== firstBefore,
      `方向=${amountHeader?.dataset.sortDir} 首行 ${firstBefore}→${afterAsc}`,
    );

    // ---- 渲染层：空值恒末尾 ----
    click(document.querySelector<HTMLElement>('[data-market-sort="turnoverPct"]'), "换手率列头");
    await sleep(120);
    const turnoverRows = rowEls();
    const nullIndexes = turnoverRows
      .map((row, index) => (cellText(row, "turnoverPct") === "—" ? index : -1))
      .filter((index) => index >= 0);
    const tailStart = turnoverRows.length - nullIndexes.length;
    const tailCodes = turnoverRows.slice(tailStart).map((row) => row.dataset.code ?? "");
    push(
      "R-07",
      "AC-01.01-03(补2)",
      "render",
      nullIndexes.length > 0 &&
        nullIndexes[nullIndexes.length - 1] === turnoverRows.length - 1 &&
        JSON.stringify(tailCodes) === JSON.stringify([...tailCodes].sort()),
      `空值 ${nullIndexes.length} 行；尾部代码=${tailCodes.slice(0, 5).join(",")}`,
    );

    // ---- 渲染层：分区 / 排序 / 列显隐落库 ----
    click(document.querySelector<HTMLElement>('[data-market-board="chinext"]'), "创业板分区");
    await sleep(80);
    const chinextRows = rowEls().length;
    if (!document.querySelector<HTMLElement>("[data-market-columns]")) {
      click(document.querySelector<HTMLElement>("[data-market-columns-toggle]"), "列设置");
      await waitFor(() => document.querySelector<HTMLElement>("[data-market-columns]"));
    }
    for (const column of ["volumeRatio", "amplitudePct"]) {
      const input = document.querySelector<HTMLInputElement>(`[data-market-column="${column}"]`);
      if (!input) throw new Error(`列设置缺少 ${column}`);
      if (input.checked) {
        input.click();
        await sleep(60);
      }
    }
    await sleep(200);
    const stored = (await ipc.viewStateGet("view.market")) as {
      board?: string;
      sortKey?: string;
      sortDir?: string;
      columns?: string[];
    } | null;
    push(
      "R-08",
      "AC-01.01-03(补1)",
      "render",
      stored?.board === "chinext" &&
        stored?.sortKey === "turnoverPct" &&
        stored?.sortDir === "desc" &&
        stored?.columns?.includes("volumeRatio") === false &&
        stored?.columns?.includes("amplitudePct") === false,
      `state.db=${JSON.stringify(stored)} 当前分区行数=${chinextRows}`,
    );

    // ---- 渲染层：行跳转 / 工作台报价头 / Esc 返回态 ----
    const table = await waitFor(() => document.querySelector<HTMLElement>("[data-market-table]"));
    const target = await waitFor(
      () => document.querySelector<HTMLElement>('[data-market-row][data-code="300750.SZ"]'),
    );
    const targetIndex = rowEls().findIndex((row) => row.dataset.code === "300750.SZ");
    const rowHeight = table.querySelector<HTMLElement>("[data-market-row]")?.offsetHeight ?? 34;
    const expectedScroll = Math.max(0, (targetIndex - 6) * rowHeight);
    table.scrollTop = expectedScroll;
    target.dataset.selected = "1";
    click(target, "300750.SZ 行");

    const wb = await waitFor(() => {
      const name = document.querySelector<HTMLElement>("[data-wb-name]");
      return name && name.textContent?.trim() !== "未选择标的" ? name : null;
    });
    const wbCode = document.querySelector<HTMLElement>(".sec-code")?.textContent?.trim() ?? "";
    push(
      "R-09",
      "AC-02.01-01",
      "render",
      wb.textContent?.trim() === "宁德时代" && wbCode === "300750.SZ",
      `报价头=${wb.textContent?.trim()} / ${wbCode} hash=${window.location.hash}`,
    );

    press(window, "Escape");
    await waitFor(() => document.querySelector<HTMLElement>("[data-market-root]"));
    await waitFor(() => rowEls().length > 0);
    const backTable = await waitFor(() => document.querySelector<HTMLElement>("[data-market-table]"));
    const activeBoard = document.querySelector<HTMLElement>("[data-market-board].selected");
    const turnover = document.querySelector<HTMLElement>('[data-market-sort="turnoverPct"]');
    const restoredSelected = document.querySelector<HTMLElement>(
      '[data-market-row][data-selected="1"]',
    );
    const scrollDelta = Math.abs(backTable.scrollTop - expectedScroll);
    push(
      "R-10",
      "AC-01.01-04",
      "render",
      activeBoard?.dataset.marketBoard === "chinext" &&
        turnover?.dataset.sortDir === "desc" &&
        document.querySelector('[data-market-sort="volumeRatio"]') === null &&
        document.querySelector('[data-market-sort="amplitudePct"]') === null &&
        restoredSelected?.dataset.code === "300750.SZ" &&
        scrollDelta <= rowHeight,
      `分区=${activeBoard?.dataset.marketBoard} 排序=${turnover?.dataset.sortDir} 隐藏列=${
        document.querySelector('[data-market-sort="volumeRatio"]') ? "未隐藏" : "已隐藏"
      } 选中=${restoredSelected?.dataset.code} 滚动差=${scrollDelta}px`,
    );

    // ---- 渲染层：键盘 ↑↓ 选中 + Enter 进入 ----
    click(document.querySelector<HTMLElement>('[data-market-table]'), "表格");
    await sleep(60);
    const beforeKey = document.querySelector<HTMLElement>('[data-market-row][data-selected="1"]')
      ?.dataset.code;
    press(document.querySelector<HTMLElement>("[data-market-table]")!, "ArrowDown");
    await sleep(80);
    const afterKey = document.querySelector<HTMLElement>('[data-market-row][data-selected="1"]')
      ?.dataset.code;
    if (!afterKey) throw new Error("↑↓ 后没有选中行");
    press(document.querySelector<HTMLElement>("[data-market-table]")!, "Enter");
    let wbCode2 = "";
    const enterDeadline = Date.now() + 3_000;
    while (Date.now() < enterDeadline) {
      const code = document.querySelector<HTMLElement>(".sec-code")?.textContent?.trim() ?? "";
      if (code === afterKey) {
        wbCode2 = code;
        break;
      }
      await sleep(60);
    }
    if (!wbCode2) {
      throw new Error(
        `Enter 未进入 ${afterKey}；hash=${window.location.hash} 报价头=${document
          .querySelector<HTMLElement>(".sec-code")
          ?.textContent?.trim()}`,
      );
    }
    const wb2 = await waitFor(() => {
      const name = document.querySelector<HTMLElement>("[data-wb-name]");
      return name && name.textContent?.trim() !== "未选择标的" ? name : null;
    });
    push(
      "R-11",
      "AC-01.01-03",
      "render",
      beforeKey !== afterKey && afterKey === wbCode2 && wb2.textContent?.trim() !== "",
      `↑↓ ${beforeKey}→${afterKey} Enter 进入=${wbCode2}`,
    );
    press(window, "Escape");
    await waitFor(() => document.querySelector<HTMLElement>("[data-market-root]"));
  } catch (err) {
    const failure = describeError(err);
    push("RUN", "-", "render", false, `${failure.code}: ${failure.message}`);
  }

  const report: MarketDiagReport = {
    suite: "E-01 market",
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: checks.every((check) => check.passed),
    checks,
    context: {
      snapshotRows: snapshot?.rows.length ?? 0,
      sampleCount: snapshot?.sampleCount ?? 0,
      dataDate: snapshot?.dataDate ?? "",
      boardCounts,
    },
  };

  try {
    report.writtenTo = await ipc.diagWriteNamed(
      "e01-market-evidence.json",
      JSON.stringify(report, null, 2),
    );
  } catch (err) {
    report.error = describeError(err).message;
  }
  (window as unknown as Record<string, unknown>).__AKA_E01_EVIDENCE__ = report;
  return report;
}
