import { ipc } from "../../lib/ipc";
import type { Category, ManifestResponse } from "../../lib/types";

interface Check {
  id: string;
  ac: string;
  layer: "data" | "render";
  passed: boolean;
  detail: string;
}

const CATEGORIES: Category[] = ["trend", "momentum", "volatility", "volume", "stat", "breadth"];

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

const waitFor = async <T,>(probe: () => T | null, timeoutMs = 5_000, stepMs = 50) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("等待超时");
    await sleep(stepMs);
  }
};

const q = <T extends Element>(selector: string) => document.querySelector<T>(selector);
const qa = <T extends Element>(selector: string) => Array.from(document.querySelectorAll<T>(selector));

const rowIds = (selector: string) =>
  qa<HTMLElement>(selector).map((element) => element.dataset.drawerRow ?? "").filter(Boolean);

const input = () => q<HTMLInputElement>("[data-drawer-search]");

/** 输入并等过 200ms 防抖 + 一帧渲染 */
const typeQuery = async (text: string) => {
  const field = await waitFor(input);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(260);
};

const clickElement = (element: Element | null) => {
  if (!element) throw new Error("目标元素不存在");
  (element as HTMLElement).click();
};

/**
 * S-02.04-01 指标抽屉取证：
 * 数据层看 manifest（105 / 44 / 61 / 四字段齐全），渲染层看抽屉 DOM
 * （分类计数、搜索命中、规划中提示、无结果空态、Esc 关闭与焦点回归）。
 */
export async function runDrawerDiagnostics(manifest: ManifestResponse) {
  const checks: Check[] = [];
  const push = (id: string, ac: string, layer: Check["layer"], passed: boolean, detail: string) => {
    checks.push({ id, ac, layer, passed, detail });
  };

  const items = manifest.indicators;
  const planned = items.filter((item) => item.status === "planned");
  const implemented = items.length - planned.length;

  // ---- 数据层 ----
  const counts = Object.fromEntries(
    CATEGORIES.map((category) => [
      category,
      items.filter((item) => item.category === category).length,
    ]),
  ) as Record<Category, number>;
  push(
    "D-01",
    "AC-02.04-01",
    "data",
    items.length === 105 &&
      counts.trend === 24 &&
      counts.momentum === 26 &&
      counts.volatility === 10 &&
      counts.volume === 15 &&
      counts.stat === 14 &&
      counts.breadth === 16 &&
      Object.values(counts).reduce((sum, value) => sum + value, 0) === 105,
    `总 ${items.length} / 趋势 ${counts.trend} 动量 ${counts.momentum} 波动 ${counts.volatility} 量能 ${counts.volume} 统计 ${counts.stat} 广度 ${counts.breadth}`,
  );

  const missingMeta = planned.filter(
    (item) =>
      !item.abbr?.trim() ||
      !item.pinyinInitials?.trim() ||
      !item.panel?.trim() ||
      !item.formulaSummary?.trim(),
  );
  const normalCount = items.filter((item) => item.status === "normal").length;
  const betaCount = items.filter((item) => item.status === "beta").length;
  push(
    "D-02",
    "AC-02.04-03(补1)",
    "data",
    planned.length === 61 && normalCount === 40 && betaCount === 4 && missingMeta.length === 0,
    `规划中 ${planned.length} / normal ${normalCount} / beta ${betaCount} / 缺四字段 ${
      missingMeta.map((item) => item.id).join(",") || "无"
    }（manifest.plannedCount=${manifest.plannedCount} 为目录规划总量，非 status=planned 的条数）`,
  );

  // ---- 渲染层 ----
  const trigger = await waitFor(() => q<HTMLElement>("[data-drawer-trigger]"));
  clickElement(trigger);
  await waitFor(() => q("[data-indicator-drawer]"));

  const domCounts = qa<HTMLElement>("[data-drawer-cat]").map((element) => ({
    key: element.dataset.drawerCat ?? "",
    count: Number(element.dataset.drawerCatCount ?? "-1"),
  }));
  push(
    "R-01",
    "AC-02.04-01",
    "render",
    domCounts.length === 6 &&
      CATEGORIES.every((category) =>
        domCounts.some((entry) => entry.key === category && entry.count === counts[category]),
      ),
    `抽屉分类=${domCounts.map((entry) => `${entry.key}:${entry.count}`).join(" ")}`,
  );

  // 规划中条目在列表里逐条带 abbr/panel（四字段的另两项在数据层核过）
  const plannedInDom: Array<{ id: string; hasAbbr: boolean; panel: string }> = [];
  for (const category of CATEGORIES) {
    clickElement(q(`[data-drawer-cat="${category}"]`));
    await sleep(80);
    for (const row of qa<HTMLElement>('[data-drawer-status="planned"]')) {
      plannedInDom.push({
        id: row.dataset.drawerRow ?? "",
        hasAbbr: Boolean(row.querySelector("[data-drawer-abbr]")?.textContent?.trim()),
        panel: row.dataset.drawerPanel ?? "",
      });
    }
  }
  push(
    "R-02",
    "AC-02.04-03",
    "render",
    plannedInDom.length === 61 &&
      plannedInDom.every((row) => row.hasAbbr && (row.panel === "主" || row.panel === "副")),
    `置灰条目 ${plannedInDom.length} / 缺缩写 ${plannedInDom.filter((row) => !row.hasAbbr).length} / 面板异常 ${plannedInDom.filter((row) => row.panel !== "主" && row.panel !== "副").length}`,
  );

  await typeQuery("MACD");
  const macdRows = qa<HTMLElement>("[data-drawer-row]");
  const firstMacd = macdRows[0];
  // 名称含 MACD 的其他条目只能是规划中变体（M07 归一化 MACD），必须置灰；
  // 无关长英文名不得因 m→a→c→d 子序列误命中。
  const macdExtras = macdRows.filter((row) => row.dataset.drawerRow !== "M06");
  push(
    "R-03",
    "AC-02.04-02",
    "render",
    (firstMacd?.dataset.drawerRow ?? "") === "M06" &&
      (firstMacd?.dataset.drawerPanel ?? "") === "副" &&
      (firstMacd?.dataset.drawerParams ?? "") === "12,26,9" &&
      Boolean(firstMacd?.querySelector("mark")) &&
      macdExtras.every((row) => row.dataset.drawerStatus === "planned"),
    `搜索 MACD → ${macdRows
      .map((row) => `${row.dataset.drawerRow}:${row.dataset.drawerStatus}`)
      .join(",")} / 首行 ${firstMacd?.dataset.drawerRow ?? "—"} 面板 ${
      firstMacd?.dataset.drawerPanel ?? "—"
    } 参数 ${firstMacd?.dataset.drawerParams ?? "—"} / 命中高亮=${
      firstMacd?.querySelector("mark") ? "有" : "无"
    }（AC 原文「只返回一行」与「规划中条目可搜到并置灰」冲突，见汇报）`,
  );

  await typeQuery("kdj");
  const lower = rowIds("[data-drawer-row]");
  await typeQuery("KDJ");
  const upper = rowIds("[data-drawer-row]");
  push(
    "R-04",
    "AC-02.04-02",
    "render",
    lower.length === 1 &&
      upper.length === 1 &&
      lower[0] === "M02" &&
      upper[0] === "M02",
    `kdj → ${lower.join(",") || "无"} / KDJ → ${upper.join(",") || "无"}`,
  );

  await typeQuery("md");
  push(
    "R-05",
    "AC-02.04-02",
    "render",
    rowIds("[data-drawer-row]").includes("M06"),
    `搜索 md → ${rowIds("[data-drawer-row]").join(",") || "无"}`,
  );

  await typeQuery("xyz");
  const empty = await waitFor(() => q("[data-drawer-empty]")).catch(() => null);
  const clear = q<HTMLElement>("[data-drawer-clear], .state-card__action");
  clickElement(clear);
  await sleep(120);
  push(
    "R-06",
    "S-08.01-02",
    "render",
    Boolean(empty) && qa("[data-drawer-row]").length > 0,
    `无结果空态=${empty ? "出现" : "缺失"} / 清除后行数=${qa("[data-drawer-row]").length}`,
  );

  // 点置灰条目必须给出「规划中」提示
  await typeQuery("HMA");
  const plannedRow = qa<HTMLElement>('[data-drawer-status="planned"]')[0];
  clickElement(plannedRow ?? null);
  await sleep(80);
  const hintText = q("[data-drawer-hint]")?.textContent ?? "";
  push(
    "R-07",
    "AC-02.04-03",
    "render",
    Boolean(plannedRow) && hintText.includes("规划中"),
    `点击置灰条目「${plannedRow?.textContent?.trim().slice(0, 12) ?? "无"}」→ 提示「${hintText}」`,
  );

  // Esc 关闭并把焦点还给触发按钮
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(120);
  const closed = !q("[data-indicator-drawer]");
  const focused = document.activeElement === q("[data-drawer-trigger]");
  push(
    "R-08",
    "AC-02.04-01",
    "render",
    closed && focused,
    `关闭=${closed ? "是" : "否"} / 焦点回归触发按钮=${focused ? "是" : "否"}`,
  );

  const report = {
    ok: checks.every((check) => check.passed),
    finishedAt: new Date().toISOString(),
    context: { manifestCount: items.length, plannedCount: planned.length, implementedCount: implemented },
    checks,
  };
  await ipc.diagWriteNamed("s20401-evidence.json", JSON.stringify(report, null, 2));
  return report;
}
