import { ipc } from "../../lib/ipc";
import type { MarketSnapshotDto } from "../../lib/types";

type Layer = "data" | "render" | "runtime";

interface Check {
  id: string;
  ac: string;
  layer: Layer;
  passed: boolean;
  detail: string;
}

export interface IndefiniteDiagReport {
  suite: "S-08.02-04 indefinite";
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  writtenTo?: string;
  error?: string;
  layers: Record<string, string>;
  checks: Check[];
  context: { rows: number; dataDate: string };
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

async function waitFor<T>(probe: () => T | null | false, timeoutMs = 6_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await sleep(50);
  }
  throw new Error("等待界面状态超时");
}

const rowEls = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-market-row]"));

const cellText = (row: HTMLElement, cell: string): string =>
  row.querySelector<HTMLElement>(`[data-cell="${cell}"]`)?.textContent?.trim() ?? "";

const finiteOrNull = (value: number | null): boolean => value == null || Number.isFinite(value);

function scanText(scope: string): { passed: boolean; hits: string[] } {
  // 只扫「值」节点（data-value / data-cell / 读数），不扫公式与口径说明里的 NaN 术语
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>("[data-value], [data-cell], [data-readout]"),
  );
  const text = nodes
    .map((node) => `${node.dataset.value ?? ""} ${node.textContent ?? ""}`)
    .join(" ");
  const hits = ["NaN", "Infinity", "null"].filter((token) => text.includes(token));
  return { passed: hits.length === 0, hits: hits.map((hit) => `${scope}:${hit}`) };
}

/**
 * S-08.02-04 零成交量/无定义与统一错误卡：未定义值不落字面、停牌四字段口径。
 * 只在 AKA_DIAG=1 时由 MarketPage 触发。
 */
export async function runIndefiniteDiagnostics(): Promise<IndefiniteDiagReport> {
  const startedAt = new Date().toISOString();
  const checks: Check[] = [];
  const push = (id: string, ac: string, layer: Layer, passed: boolean, detail: string) =>
    checks.push({ id, ac, layer, passed, detail });

  let snapshot: MarketSnapshotDto | null = null;
  try {
    snapshot = await ipc.marketSnapshot();
    const rows = snapshot.rows;

    const suspendedRows = rows.filter((row) => row.suspended);
    const suspended = rows.find((row) => row.security === "DIAGQSUP.SZ");
    push(
      "D-01",
      "AC-08.02-04(补1)",
      "data",
      Boolean(suspended) &&
        suspended!.volume === 0 &&
        suspended!.changePct === null &&
        suspended!.changeAbs === null &&
        suspended!.amplitudePct === 0 &&
        suspended!.volumeRatio === null &&
        suspendedRows.length > 0,
      suspended
        ? `停牌 ${suspended.code}: 量=${suspended.volume} 涨跌幅=${suspended.changePct} 涨跌额=${suspended.changeAbs} 振幅=${suspended.amplitudePct} 量比=${suspended.volumeRatio}`
        : "快照中没有停牌样本",
    );

    const nonFinite = rows.flatMap((row) =>
      [
        ["lastPrice", row.lastPrice],
        ["prevClose", row.prevClose],
        ["changeAbs", row.changeAbs],
        ["changePct", row.changePct],
        ["volume", row.volume],
        ["amount", row.amount],
        ["turnoverPct", row.turnoverPct],
        ["volumeRatio", row.volumeRatio],
        ["amplitudePct", row.amplitudePct],
      ]
        .filter(([, value]) => !finiteOrNull(value as number | null))
        .map(([name]) => `${row.code}.${name}`),
    );
    push(
      "D-02",
      "AC-08.02-04(补3)",
      "data",
      nonFinite.length === 0,
      `非有限值 ${nonFinite.length} 个${nonFinite.length ? `：${nonFinite.slice(0, 6).join(",")}` : ""}`,
    );

    // 表头列可能被上一套件隐藏，先恢复量比/振幅/涨跌幅三列
    const toggle = document.querySelector<HTMLElement>("[data-market-columns-toggle]");
    if (!document.querySelector<HTMLElement>('[data-market-sort="volumeRatio"]')) {
      toggle?.click();
      await waitFor(() => document.querySelector<HTMLElement>("[data-market-columns]"));
      for (const column of ["volumeRatio", "amplitudePct", "changePct"]) {
        const input = document.querySelector<HTMLInputElement>(`[data-market-column="${column}"]`);
        if (input && !input.checked) {
          input.click();
          await sleep(60);
        }
      }
      toggle?.click();
      await sleep(200);
    }
    document.querySelector<HTMLElement>('[data-market-board="all"]')?.click();
    await sleep(150);

    const row = await waitFor<HTMLElement>(() => rowEls().find((candidate) => candidate.dataset.code === "DIAGQSUP.SZ") ?? false);
    const ratioCell = row.querySelector<HTMLElement>('[data-cell="volumeRatio"]');
    const ratioText = cellText(row, "volumeRatio");
    const changeText = cellText(row, "changePct");
    const amplitudeText = cellText(row, "amplitudePct");
    const ratioTitle = ratioCell?.title ?? "";
    push(
      "R-01",
      "AC-08.02-04(补1)",
      "render",
      ratioText === "—" && changeText === "—" && amplitudeText === "0.00%" && row.dataset.suspended === "1",
      `停牌行 ${row.dataset.code}: 量比「${ratioText}」涨跌幅「${changeText}」振幅「${amplitudeText}」suspended=${row.dataset.suspended}`,
    );
    push(
      "R-02",
      "AC-08.02-04",
      "render",
      ratioCell?.dataset.indefinite === "1" && ratioTitle === "停牌日无成交，量比无定义",
      `量比 data-indefinite=${ratioCell?.dataset.indefinite} tooltip「${ratioTitle}」`,
    );
  } catch (err) {
    push("D-00", "AC-08.02-04", "data", false, `快照读取失败：${String(err)}`);
  }

  // ---- 渲染层：全站字面扫描（行情 / 指标目录 / 工作台）----
  const marketScan = scanText("market");
  push("R-03", "AC-08.02-04(补2)", "render", marketScan.passed, `行情页命中 ${marketScan.hits.join(",") || "无"}`);

  window.location.hash = "#/catalog";
  try {
    await waitFor(() => document.querySelector<HTMLElement>("[data-catalog-item]"));
    await sleep(150);
  } catch {
    /* 页面未就绪时由扫描失败兜底 */
  }
  const catalogScan = scanText("catalog");
  push("R-04", "AC-08.02-04(补2)", "render", catalogScan.passed, `目录页命中 ${catalogScan.hits.join(",") || "无"}`);

  window.location.hash = "#/workbench/600519.SH";
  try {
    await waitFor(() => {
      const name = document.querySelector<HTMLElement>("[data-wb-name]");
      return name && name.textContent?.trim() !== "未选择标的" ? name : null;
    });
    await sleep(300);
  } catch {
    /* 同上 */
  }
  const workbenchScan = scanText("workbench");
  push("R-05", "AC-08.02-04(补2)", "render", workbenchScan.passed, `工作台命中 ${workbenchScan.hits.join(",") || "无"}`);

  // ---- 补3：AKA_DIAG_INF=1 把首实例末值注入 +∞，界面该点显示「—」，日志记 E_INDEFINITE ----
  const candles = Array.from(
    document.querySelectorAll<SVGElement>("[data-candle][data-index]"),
  );
  let injectedDash = false;
  let injectedDetail = "数据集中没有 K 线（注入点未渲染）";
  if (candles.length > 0) {
    const last = candles.reduce((best, element) =>
      Number(element.getAttribute("data-index")) > Number(best.getAttribute("data-index"))
        ? element
        : best,
    );
    const box = last.getBoundingClientRect();
    last.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
      }),
    );
    await sleep(150);
    const readouts = Array.from(
      document.querySelectorAll<HTMLElement>('[data-readout="ma-T01"]'),
    );
    injectedDash = readouts.some(
      (element) =>
        element.getAttribute("data-value") === "" && (element.textContent ?? "").includes("—"),
    );
    injectedDetail = readouts
      .map((element) => `value=${element.getAttribute("data-value")},text=${(element.textContent ?? "").trim()}`)
      .join(" | ");
  }
  push(
    "R-06",
    "AC-08.02-04(补3)",
    "render",
    injectedDash,
    `末根 T01 读数 ${injectedDetail || "无读数节点"}`,
  );

  const telemetry = await ipc.telemetryDump(300).catch(() => null);
  const indefiniteEvent = telemetry?.recent.find(
    (event) => event.name === "value.indefinite" && event.fields.code === "E_INDEFINITE",
  );
  push(
    "T-01",
    "AC-08.02-04(补3)",
    "runtime",
    Boolean(indefiniteEvent),
    indefiniteEvent
      ? `telemetry value.indefinite code=E_INDEFINITE instanceId=${indefiniteEvent.fields.instanceId} indicatorId=${indefiniteEvent.fields.indicatorId} key=${indefiniteEvent.fields.key}`
      : "telemetry.jsonl 未命中 value.indefinite",
  );

  const layers: Record<string, string> = {};
  for (const check of checks) {
    const [passed, total] = layers[check.layer]?.split("/").map(Number) ?? [0, 0];
    layers[check.layer] = `${passed + (check.passed ? 1 : 0)}/${total + 1}`;
  }

  const report: IndefiniteDiagReport = {
    suite: "S-08.02-04 indefinite",
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: checks.every((check) => check.passed),
    layers,
    checks,
    context: { rows: snapshot?.rows.length ?? 0, dataDate: snapshot?.dataDate ?? "" },
  };
  try {
    report.writtenTo = await ipc.diagWriteNamed(
      "s080204-evidence.json",
      JSON.stringify(report, null, 2),
    );
  } catch (err) {
    report.error = String(err);
  }
  (window as unknown as Record<string, unknown>).__AKA_S080204_EVIDENCE__ = report;
  return report;
}
