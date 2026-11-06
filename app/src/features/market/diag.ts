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
  // 取证套件中途卡住时没有最终 JSON，进度文件能指出停在哪一条（成功后会被最终报告覆盖）。
  const progress = (stage: string) => {
    void ipc
      .diagWriteNamed("e01-market-progress.json", JSON.stringify({ stage, at: new Date().toISOString() }, null, 2))
      .catch(() => undefined);
  };
  const push = (id: string, ac: string, layer: Layer, passed: boolean, detail: string) => {
    checks.push({ id, ac, layer, passed, detail });
    progress(`done:${id}`);
  };
  progress("start");

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

    push(
      "D-04",
      "AC-01.01-01",
      "data",
      snapshot.coverageStart !== "" &&
        snapshot.coverageEnd !== "" &&
        snapshot.coverageEnd === snapshot.dataDate,
      `coverage ${snapshot.coverageStart}~${snapshot.coverageEnd} dataDate=${snapshot.dataDate}`,
    );

    // ---- 渲染层：页头 / 行数 / 徽标 ----
    await waitFor(() => rowEls().length > 0);
    const summary = document.querySelector<HTMLElement>("[data-market-summary]")?.textContent ?? "";
    const sim = document.querySelector<HTMLElement>(".pill.sim")?.textContent ?? "";
    push(
      "R-01",
      "AC-01.01-01",
      "render",
      summary.includes("样本 120 只") &&
        summary.includes(snapshot.dataDate) &&
        summary.includes(snapshot.coverageEnd) &&
        sim.includes("模拟"),
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

    // ---- 渲染层：列头排序完整三态（S-01.01-01 / S-01.01-02 同一组件，一次证完）----
    const sortDirOf = (key: string) =>
      document.querySelector<HTMLElement>(`[data-market-sort="${key}"]`)?.dataset.sortDir ?? "";
    const sortHeadText = (key: string) =>
      document.querySelector<HTMLElement>(`[data-market-sort="${key}"]`)?.textContent?.trim() ?? "";
    const cellValues = (key: string) =>
      rowEls()
        .map((row) =>
          Number(row.querySelector<HTMLElement>(`[data-cell="${key}"]`)?.dataset.value ?? "NaN"),
        )
        .filter((value) => Number.isFinite(value));
    const firstCode = () => rowEls()[0]?.dataset.code ?? "";

    await sleep(80);
    const amountFirst = firstCode();

    // 第一次点击「换手率」（新列）→ 降序
    click(document.querySelector<HTMLElement>('[data-market-sort="turnoverPct"]'), "换手率列头");
    await sleep(120);
    const descValues = cellValues("turnoverPct").slice(0, 5);
    const descFirst = firstCode();
    push(
      "R-06",
      "AC-01.01-03",
      "render",
      sortDirOf("turnoverPct") === "desc" &&
        sortHeadText("turnoverPct").includes("↓") &&
        descValues.every((value, index) => index === 0 || value <= descValues[index - 1]),
      `首次点击：方向=${sortDirOf("turnoverPct")} 标记=${sortHeadText("turnoverPct")} 前5=${descValues.join(
        "/",
      )} 首行 ${amountFirst}→${descFirst}`,
    );

    // 第二次点击 → 升序
    click(document.querySelector<HTMLElement>('[data-market-sort="turnoverPct"]'), "换手率列头");
    await sleep(120);
    const ascValues = cellValues("turnoverPct").slice(0, 5);
    const ascFirst = firstCode();
    const ascDir = sortDirOf("turnoverPct");
    const ascMark = sortHeadText("turnoverPct");

    // 第三次点击 → 回到默认（成交额降序）
    click(document.querySelector<HTMLElement>('[data-market-sort="turnoverPct"]'), "换手率列头");
    await sleep(120);
    const backFirst = firstCode();
    push(
      "R-06B",
      "AC-01.01-02",
      "render",
      ascDir === "asc" &&
        ascMark.includes("↑") &&
        ascValues.every((value, index) => index === 0 || value >= ascValues[index - 1]) &&
        ascFirst !== descFirst &&
        sortDirOf("amount") === "desc" &&
        sortHeadText("amount").includes("↓") &&
        sortDirOf("turnoverPct") === "" &&
        backFirst === amountFirst,
      `二次点击：方向=${ascDir} 标记=${ascMark} 首行=${ascFirst}；三次点击：默认列=${sortDirOf(
        "amount",
      )} 首行=${backFirst}（原=${amountFirst}）`,
    );

    // ---- 渲染层：量比降序 + 空值恒末尾（AC-01.01-03（补2））----
    click(document.querySelector<HTMLElement>('[data-market-sort="volumeRatio"]'), "量比列头");
    await sleep(120);
    const ratioRows = rowEls();
    const ratioNulls = ratioRows
      .map((row, index) => (cellText(row, "volumeRatio") === "—" ? index : -1))
      .filter((index) => index >= 0);
    const tailStart = ratioRows.length - ratioNulls.length;
    const tailCodes = ratioRows.slice(tailStart).map((row) => row.dataset.code ?? "");
    const ratioValues = cellValues("volumeRatio").slice(0, 5);
    push(
      "R-07",
      "AC-01.01-03(补2)",
      "render",
      sortDirOf("volumeRatio") === "desc" &&
        ratioNulls.length > 0 &&
        ratioNulls[ratioNulls.length - 1] === ratioRows.length - 1 &&
        JSON.stringify(tailCodes) === JSON.stringify([...tailCodes].sort()) &&
        ratioValues.every((value, index) => index === 0 || value <= ratioValues[index - 1]),
      `方向=${sortDirOf("volumeRatio")} 空值 ${ratioNulls.length} 行；尾部代码=${tailCodes
        .slice(0, 5)
        .join(",")}；前5=${ratioValues.join("/")}`,
    );

    // ---- 渲染层：分区 / 排序 / 列显隐落库 ----
    click(document.querySelector<HTMLElement>('[data-market-board="chinext"]'), "创业板分区");
    await sleep(80);
    // R-07 把排序切到了量比；卡上 R-08 要的是「换手率降序」，重新点成降序。
    click(document.querySelector<HTMLElement>('[data-market-sort="turnoverPct"]'), "换手率列头");
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
    // 真实滚动到目标行（不是按行索引手算 scrollTop）；记录滚动后真实位置。
    target.scrollIntoView({ block: "start" });
    await sleep(100);
    const rowHeight = table.querySelector<HTMLElement>("[data-market-row]")?.offsetHeight ?? 34;
    const scrollBeforeOpen = table.scrollTop;
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
    const scrollDelta = Math.abs(backTable.scrollTop - scrollBeforeOpen);
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
      } 选中=${restoredSelected?.dataset.code} 滚动差=${scrollDelta}px（记录=${scrollBeforeOpen}px）`,
    );

    // ---- 渲染层：字面「第 40 行」——真实滚动后点击，返回仍停在该行 ----
    // 创业板只有 17 行，滚不动；按字面 40 行只能在「全部」分区执行（120 行）。
    progress("R-12:board");
    click(document.querySelector<HTMLElement>('[data-market-board="all"]'), "全部分区");
    await sleep(100);
    progress("R-12:sort");
    if (sortDirOf("amount") !== "desc") {
      click(document.querySelector<HTMLElement>('[data-market-sort="amount"]'), "成交额列头");
      await sleep(100);
    }
    progress("R-12:table");
    const allTable = await waitFor(() => document.querySelector<HTMLElement>("[data-market-table]"));
    allTable.scrollTop = 0;
    const allRows = rowEls();
    const row40 = allRows[allRows.length > 39 ? 39 : allRows.length - 1];
    if (!row40?.dataset.code) throw new Error("列表不足 40 行，无法按字面执行第 40 行场景");
    const row40Code = row40.dataset.code;
    row40.scrollIntoView({ block: "start" });
    await sleep(100);
    progress(`R-12:scrolled:${row40Code}`);
    const row40Scroll = allTable.scrollTop;
    const storedBefore = sessionStorage.getItem("aka.market.scroll");
    const tableView = allTable.getBoundingClientRect();
    const rowView = row40.getBoundingClientRect();
    const row40Visible = rowView.top >= tableView.top - 1 && rowView.bottom <= tableView.bottom + 1;
    click(row40, `第 40 行 ${row40Code}`);

    let wbCode3 = "";
    const row40Deadline = Date.now() + 3_000;
    while (Date.now() < row40Deadline) {
      const code = document.querySelector<HTMLElement>(".sec-code")?.textContent?.trim() ?? "";
      if (code === row40Code) {
        wbCode3 = code;
        break;
      }
      await sleep(60);
    }
    progress(`R-12:clicked:${wbCode3}`);
    press(window, "Escape");
    progress("R-12:escape");
    await waitFor(() => document.querySelector<HTMLElement>("[data-market-root]"));
    progress("R-12:marketRoot");
    await waitFor(() => rowEls().length > 0);
    progress("R-12:rows");
    const backAll = await waitFor(() => document.querySelector<HTMLElement>("[data-market-table]"));
    progress("R-12:backTable");
    await sleep(120);
    const storedAfter = sessionStorage.getItem("aka.market.scroll");
    const backRow40 = document.querySelector<HTMLElement>('[data-market-row][data-selected="1"]');
    push(
      "R-12",
      "AC-01.01-04",
      "render",
      row40Scroll > 0 &&
        row40Visible &&
        wbCode3 === row40Code &&
        backRow40?.dataset.code === row40Code &&
        Math.abs(backAll.scrollTop - row40Scroll) <= rowHeight * 1.5,
      `第40行=${row40Code} 真实 scrollTop=${row40Scroll}px 可见=${row40Visible} 返回选中=${
        backRow40?.dataset.code
      } 返回 scrollTop=${backAll.scrollTop}px 存档 ${storedBefore}→${storedAfter}`,
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

    // ---- 渲染层：50ms 内连点 3 行，只打开最后一只、报价头不闪不重（AC-01.01-04（补1）----
    await waitFor(() => rowEls().length > 0);
    const picks = rowEls()
      .slice(0, 3)
      .map((row) => ({ el: row, code: row.dataset.code ?? "" }));
    if (picks.length < 3 || picks.some((pick) => !pick.code)) {
      throw new Error("列表不足 3 行，无法执行 50ms 连点场景");
    }
    // 直接证伪信号：每次跳转都会改 hash 并触发 hashchange。合并窗口生效时整串只应有 1 次。
    const hashEvents: string[] = [];
    const onHash = () => hashEvents.push(window.location.hash);
    window.addEventListener("hashchange", onHash);
    const clickTimes: number[] = [];
    for (const pick of picks) {
      clickTimes.push(performance.now());
      click(pick.el, `连点 ${pick.code}`);
      // 三次点击间隔 ~35ms，总跨度 ~70ms：每一下都落在 50ms 合并窗口内，
      // 若没有合并窗口，第一下就会立刻跳转（观测到中间标的即判红）。
      if (pick !== picks[picks.length - 1]) await sleep(35);
    }
    const gaps = clickTimes.slice(1).map((time, index) => time - clickTimes[index]);
    if (!gaps.every((gap) => gap <= 50)) {
      throw new Error(`连点间隔超过 50ms：${gaps.join(",")}`);
    }
    const expectedCode = picks[2].code;
    // 观察窗口：落地前/落地后逐帧采样报价头，确认没出现中间标的、没有空闪、没有双份。
    const observedCodes: string[] = [];
    let maxHeaderCount = 0;
    let emptyFrames = 0;
    const deadline = Date.now() + 1_200;
    while (Date.now() < deadline) {
      const headers = document.querySelectorAll<HTMLElement>(".sec-code");
      maxHeaderCount = Math.max(maxHeaderCount, headers.length);
      const code = headers[0]?.textContent?.trim() ?? "";
      if (code) {
        if (observedCodes[observedCodes.length - 1] !== code) observedCodes.push(code);
        if (code === expectedCode) break;
      } else if (document.querySelector("[data-wb-name]")) {
        emptyFrames += 1;
      }
      await sleep(8);
    }
    window.removeEventListener("hashchange", onHash);
    const distinctObserved = [...new Set(observedCodes)];
    push(
      "R-13",
      "AC-01.01-04(补1)",
      "render",
      gaps.every((gap) => gap <= 50) &&
        hashEvents.length === 1 &&
        hashEvents[0].includes(expectedCode) &&
        distinctObserved.length === 1 &&
        distinctObserved[0] === expectedCode &&
        maxHeaderCount === 1 &&
        emptyFrames === 0,
      `连点间隔=${gaps.map((gap) => gap.toFixed(1)).join("/")}ms 目标=${picks
        .map((pick) => pick.code)
        .join("→")} 展示=${distinctObserved.join(",")} hashchange=${hashEvents.join(
        "→",
      )} 报价头元素=${maxHeaderCount} 空闪帧=${emptyFrames}`,
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
