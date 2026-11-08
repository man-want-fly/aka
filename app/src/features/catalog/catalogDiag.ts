import { ipc } from "../../lib/ipc";
import { searchIndicators } from "../indicators/search";
import type { Category, ManifestResponse, RegistryResponse } from "../../lib/types";

interface Check {
  id: string;
  ac: string;
  layer: "data" | "render" | "runtime";
  passed: boolean;
  detail: string;
}

const CATEGORIES: Array<{ key: Category; label: string; expected: number }> = [
  { key: "trend", label: "趋势", expected: 24 },
  { key: "momentum", label: "动量", expected: 26 },
  { key: "volatility", label: "波动", expected: 10 },
  { key: "volume", label: "量能", expected: 15 },
  { key: "stat", label: "统计", expected: 14 },
  { key: "breadth", label: "广度", expected: 16 },
];

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

const input = () => q<HTMLInputElement>("[data-catalog-search-input]");

const typeQuery = async (text: string) => {
  const field = await waitFor(input);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(120);
};

const rowIds = () =>
  qa<HTMLElement>("[data-catalog-item]")
    .map((element) => element.dataset.catalogItem ?? "")
    .filter(Boolean);

const rowText = (id: string) => q<HTMLElement>(`[data-catalog-item="${id}"]`)?.textContent ?? "";

const expandAllCategories = async () => {
  for (const category of CATEGORIES) {
    const toggle = q<HTMLElement>(`[data-catalog-cat-toggle="${category.key}"]`);
    if (toggle && toggle.getAttribute("aria-expanded") !== "true") {
      toggle.click();
      await sleep(80);
    }
  }
  await sleep(120);
};

/**
 * S-03.01-01 / S-03.01-03 指标目录取证：
 * 数据层核 manifest（105 与六分类同源），渲染层核 DOM（计数、懒加载、徽标、搜索、四段摘要）。
 */
export async function runCatalogDiagnostics(manifest: ManifestResponse) {
  const checks: Check[] = [];
  const push = (id: string, ac: string, layer: Check["layer"], passed: boolean, detail: string) => {
    checks.push({ id, ac, layer, passed, detail });
  };

  const items = manifest.indicators;
  const total = items.length;
  const counts = Object.fromEntries(
    CATEGORIES.map((category) => [
      category.key,
      items.filter((item) => item.category === category.key).length,
    ]),
  ) as Record<Category, number>;
  const sum = Object.values(counts).reduce((acc, value) => acc + value, 0);
  const p0 = items.filter((item) => item.priority === "P0").length;
  const planned = items.filter((item) => item.status === "planned").length;

  // ---- 数据层 ----
  push(
    "D-01",
    "AC-03.01-01",
    "data",
    total === 105 &&
      manifest.catalogTotal === 105 &&
      sum === 105 &&
      CATEGORIES.every((category) => counts[category.key] === category.expected),
    `manifest ${total} / 声明 ${manifest.catalogTotal} / 趋势 ${counts.trend} 动量 ${counts.momentum} 波动 ${counts.volatility} 量能 ${counts.volume} 统计 ${counts.stat} 广度 ${counts.breadth} / 加总 ${sum} / P0 ${p0} P1 ${total - p0} / 规划中 ${planned}`,
  );

  const completion = items.filter((item) => item.isCompletion).map((item) => item.id);
  const beta = items.filter((item) => item.completeness === "beta").map((item) => item.id);
  push(
    "D-02",
    "AC-03.01-01(补1)",
    "data",
    completion.length === 6 &&
      beta.length === 8 &&
      ["T03", "T24", "F04", "F10", "F12", "F16"].every((id) => completion.includes(id)),
    `补全口径 ${completion.length}（${completion.join(",")}）/ beta ${beta.length}（${beta.join(",")}）`,
  );

  const missingSummary = items.filter(
    (item) =>
      !item.abbr?.trim() ||
      !item.pinyinInitials?.trim() ||
      !item.panel?.trim() ||
      !item.formulaSummary?.trim() ||
      (item.status === "planned" && item.params.length === 0 && !item.defaultParamsText?.trim()),
  );
  push(
    "D-03",
    "AC-03.01-04",
    "data",
    missingSummary.length === 0,
    `缺 abbr/pinyin/panel/formula/默认参数：${missingSummary.map((item) => item.id).join(",") || "无"}`,
  );

  const junxian = searchIndicators(items, "junxian");
  const md = searchIndicators(items, "md");
  const macd = searchIndicators(items, "MACD");
  push(
    "D-04",
    "AC-03.01-03",
    "data",
    junxian.length >= 3 &&
      junxian.every((item) => item.nameZh.includes("均线")) &&
      md.some((item) => item.id === "M06") &&
      macd[0]?.id === "M06",
    `junxian ${junxian.length}（${junxian.map((item) => item.id).join(",")}）/ md 命中 M06=${
      md.some((item) => item.id === "M06")
    } / MACD 首行 ${macd[0]?.id ?? "—"}`,
  );

  // S-03.01-03 单一事实源：manifest 默认值与 Rust 注册表 ParamSpec 默认值逐项一致
  let registry: RegistryResponse | null = null;
  try {
    registry = await ipc.indicatorRegistry();
  } catch {
    registry = null;
  }
  const mismatchedDefaults: string[] = [];
  for (const item of items) {
    const reg = registry?.indicators.find((entry) => entry.id === item.id);
    if (!reg) continue;
    for (const param of item.params) {
      const spec = reg.params.find((entry) => entry.key === param.key);
      if (!spec) {
        mismatchedDefaults.push(`${item.id}.${param.key}:missing`);
        continue;
      }
      if (spec.default !== param.default) {
        mismatchedDefaults.push(`${item.id}.${param.key}:${param.default}≠${spec.default}`);
      }
    }
  }
  push(
    "D-05",
    "S-03.01-03",
    "data",
    registry !== null && mismatchedDefaults.length === 0,
    `注册表 ${registry?.indicators.length ?? "—"} 条 / 默认值不一致：${
      mismatchedDefaults.join(",") || "无"
    }`,
  );

  // 手册覆盖度：60 条规划项不得残留占位公式；覆盖分层由 specStatus 承载
  // 计数从 manifest 现算（normal 43 + beta 2 = 45 已实现；planned 60；合计 105）
  const plannedItems = items.filter((item) => item.status === "planned");
  const placeholder = plannedItems.filter(
    (item) => item.formulaSummary.includes("待《技术指标全能手册》核定") || item.formulaSummary.includes("待手册核定"),
  );
  const bySpec = (key: string) => plannedItems.filter((item) => item.specStatus === key).length;
  push(
    "D-06",
    "S-03.01-01(手册)",
    "data",
    plannedItems.length === 60 &&
      placeholder.length === 0 &&
      bySpec("manualComplete") === 47 &&
      bySpec("partial") === 9 &&
      bySpec("productDefined") === 4 &&
      plannedItems.every((item) => item.notes.includes("手册")),
    `规划项 ${plannedItems.length} / 占位残留 ${placeholder.length} / 手册完整 ${bySpec(
      "manualComplete",
    )} 部分 ${bySpec("partial")} 未覆盖 ${bySpec("productDefined")}`,
  );

  // 徽标数量自证：口径待定 = planned 且 specStatus != manualComplete；
  // productDefined 是全量口径，M22 同时属于 planned 与 productDefined，不得重复计数。
  const pendingItems = plannedItems.filter((item) => item.specStatus !== "manualComplete");
  const pendingIds = pendingItems.map((item) => item.id).sort();
  const productDefinedIds = items
    .filter((item) => item.specStatus === "productDefined")
    .map((item) => item.id)
    .sort();
  const expectedPending = [
    "M18",
    "M22",
    "M23",
    "D07",
    "D09",
    "E02",
    "E03",
    "E04",
    "E05",
    "E14",
    "F14",
    "F15",
    "F16",
  ].sort();
  push(
    "D-07",
    "S-03.01-01(手册)",
    "data",
    pendingItems.length === 13 &&
      pendingIds.join(",") === expectedPending.join(",") &&
      productDefinedIds.length === 4 &&
      productDefinedIds.join(",") === ["E02", "F15", "F16", "M22"].sort().join(",") &&
      bySpec("partial") === 9,
    `口径待定 ${pendingItems.length}（${pendingIds.join(",")}）/ productDefined ${productDefinedIds.length}（${productDefinedIds.join(
      ",",
    )}）/ planned 内 partial ${bySpec("partial")}`,
  );

  const find = (id: string) => items.find((item) => item.id === id);
  const e02 = find("E02");
  const f16 = find("F16");
  const f15 = find("F15");
  const m22 = find("M22");
  const e02Period = e02?.params.find((param) => param.key === "period");
  const f16Period = f16?.params.find((param) => param.key === "period");
  const intParam = (param: typeof e02Period) =>
    param && (param.kind === "int" || param.kind === "float") ? param : undefined;
  const e02Spec = intParam(e02Period);
  const f16Spec = intParam(f16Period);
  push(
    "D-08",
    "S-03.01-01(手册)",
    "data",
    e02?.warmupBars === 61 &&
      e02Spec?.default === 60 &&
      e02Spec.min === 20 &&
      e02Spec.max === 250 &&
      f16?.warmupBars === 29 &&
      f16Spec?.default === 10 &&
      f16Spec.min === 5 &&
      f16Spec.max === 30 &&
      f15?.warmupBars === 2 &&
      Boolean(f15?.notes.includes("一字板结案")) &&
      m22?.specStatus === "productDefined" &&
      Boolean(m22?.notes.includes("本期不实现")),
    `E02 预热 ${e02?.warmupBars} period ${e02Spec?.default}[${e02Spec?.min},${e02Spec?.max}] / F16 预热 ${
      f16?.warmupBars
    } period ${f16Spec?.default}[${f16Spec?.min},${f16Spec?.max}] / F15 预热 ${
      f15?.warmupBars
    } notes 含一字板结案=${Boolean(f15?.notes.includes("一字板结案"))} / M22 ${m22?.specStatus} 不实现=${Boolean(
      m22?.notes.includes("本期不实现"),
    )}`,
  );

  // ---- 渲染层 ----
  await waitFor(() => q("[data-catalog-root='p3']"));
  const header = q<HTMLElement>("[data-catalog-total]");
  const groups = qa<HTMLElement>("[data-catalog-category-group]").map((element) => ({
    key: element.dataset.catalogCategoryGroup ?? "",
    count: Number(element.dataset.catalogCatCount ?? "-1"),
    expanded: q<HTMLElement>(`[data-catalog-cat-toggle="${element.dataset.catalogCategoryGroup}"]`)
      ?.getAttribute("aria-expanded"),
  }));
  const initialRows = rowIds();
  push(
    "R-01",
    "AC-03.01-01",
    "render",
    header?.dataset.catalogTotal === "105" &&
      header?.dataset.catalogDeclared === "105" &&
      header?.dataset.catalogMismatch === "0" &&
      groups.length === 6 &&
      CATEGORIES.every((category) => groups.find((g) => g.key === category.key)?.count === category.expected) &&
      groups.reduce((acc, g) => acc + g.count, 0) === 105,
    `首行「${header?.textContent?.trim() ?? ""}」/ DOM 计数 ${groups
      .map((g) => `${g.key}:${g.count}`)
      .join(" ")} / 加总 ${groups.reduce((acc, g) => acc + g.count, 0)}`,
  );

  push(
    "R-02",
    "AC-03.01-02",
    "render",
    initialRows.length === 24 &&
      groups.filter((g) => g.expanded === "true").length === 1 &&
      initialRows.every((id) => id.startsWith("T")),
    `首屏挂载 ${initialRows.length} 行（${initialRows[0] ?? "—"}…${
      initialRows[initialRows.length - 1] ?? "—"
    }）/ 展开分类 ${
      groups.filter((g) => g.expanded === "true").length
    } 个`,
  );

  await expandAllCategories();
  const allRows = rowIds();
  push(
    "R-03",
    "AC-03.01-01",
    "render",
    allRows.length === 105 &&
      groups.every(
        (group) =>
          q<HTMLElement>(`[data-catalog-cat-toggle="${group.key}"]`)?.getAttribute("aria-expanded") ===
          "true",
      ),
    `六分类全部展开后 DOM ${allRows.length} 行 / 唯一 id ${new Set(allRows).size}`,
  );

  const t03 = q<HTMLElement>('[data-catalog-item="T03"]');
  push(
    "R-04",
    "AC-03.01-01(补1)",
    "render",
    t03?.dataset.catalogCompletion === "1" &&
      t03?.dataset.catalogPriority === "P0" &&
      t03?.dataset.catalogStatus !== "planned" &&
      rowText("T03").includes("补全口径"),
    `T03 补全口径=${t03?.dataset.catalogCompletion} P0=${t03?.dataset.catalogPriority} 规划=${t03?.dataset.catalogStatus} / 文案「${rowText(
      "T03",
    )}」`,
  );

  const m13 = q<HTMLElement>('[data-catalog-item="M13"]');
  push(
    "R-05",
    "AC-03.01-01(补1)",
    "render",
    m13?.dataset.catalogCompleteness === "beta" &&
      m13?.dataset.catalogPriority === "P1" &&
      m13?.dataset.catalogStatus === "planned" &&
      rowText("M13").includes("beta") &&
      rowText("M13").includes("P1") &&
      rowText("M13").includes("规划中"),
    `M13 beta=${m13?.dataset.catalogCompleteness} P1=${m13?.dataset.catalogPriority} 规划=${m13?.dataset.catalogStatus} / 文案「${rowText(
      "M13",
    )}」`,
  );

  await typeQuery("MACD");
  const macdRows = rowIds();
  push(
    "R-06",
    "AC-03.01-03",
    "render",
    macdRows.length > 0 && macdRows[0] === "M06" && macdRows.includes("M06"),
    `搜索 MACD → ${macdRows.length} 行（${macdRows.join(",")}），首行 ${macdRows[0] ?? "—"}`,
  );

  await typeQuery("md");
  const mdRows = rowIds();
  push(
    "R-07",
    "AC-03.01-03",
    "render",
    mdRows.includes("M06"),
    `搜索 md → ${mdRows.length} 行（${mdRows.join(",")}）`,
  );

  await typeQuery("junxian");
  const junxianRows = rowIds();
  const junxianNames = junxianRows.map((id) =>
    q<HTMLElement>(`[data-catalog-item="${id}"]`)?.textContent ?? "",
  );
  push(
    "R-08",
    "AC-03.01-03",
    "render",
    junxianRows.length >= 3 && junxianNames.every((name) => name.includes("均线")),
    `搜索 junxian → ${junxianRows.length} 行（${junxianRows.join(",")}），均含“均线”=${junxianNames.every(
      (name) => name.includes("均线"),
    )}`,
  );

  await typeQuery("");
  await sleep(80);

  const openSummary = async (id: string) => {
    const toggle = q<HTMLElement>(`[data-catalog-summary-toggle="${id}"]`);
    toggle?.click();
    return waitFor(() => q<HTMLElement>(`[data-catalog-summary="${id}"]`), 2_000, 20);
  };

  const t01Summary = await openSummary("T01");
  const t01Text = t01Summary.textContent ?? "";
  push(
    "R-09",
    "AC-03.01-04",
    "render",
    t01Text.includes("默认参数") &&
      t01Text.includes("20") &&
      t01Text.includes("至少 20 根 K 线") &&
      t01Text.includes("口径来源"),
    `T01 摘要「${t01Text.replace(/\s+/g, " ").trim()}」`,
  );

  const m06Summary = await openSummary("M06");
  const m06Text = m06Summary.textContent ?? "";
  push(
    "R-10",
    "AC-03.01-04",
    "render",
    m06Text.includes("12 / 26 / 9") &&
      m06Text.includes("至少 34 根 K 线") &&
      m06Text.includes("首个有效值下标 33"),
    `M06 摘要「${m06Text.replace(/\s+/g, " ").trim()}」`,
  );

  const t03Summary = await openSummary("T03");
  const t03Text = t03Summary.textContent ?? "";
  push(
    "R-11",
    "AC-03.01-04",
    "render",
    t03Text.includes("默认参数") && t03Text.includes("本产品补全口径"),
    `T03 摘要「${t03Text.replace(/\s+/g, " ").trim()}」`,
  );

  const pendingBadge = q<HTMLElement>('[data-catalog-spec-pending="F16"]');
  const manualPendingBadge = q<HTMLElement>('[data-catalog-spec-pending="T06"]');
  push(
    "R-12",
    "S-03.01-01(手册)",
    "render",
    pendingBadge !== null &&
      manualPendingBadge === null &&
      rowText("F16").includes("口径待定"),
    `F16 口径待定徽标=${pendingBadge !== null} / T06 口径待定徽标=${manualPendingBadge !== null} / F16 文案「${rowText(
      "F16",
    )
      .replace(/\s+/g, " ")
      .trim()}」`,
  );

  const domPending = qa<HTMLElement>("[data-catalog-spec-pending]")
    .map((element) => element.dataset.catalogSpecPending ?? "")
    .filter(Boolean)
    .sort();
  push(
    "R-13",
    "S-03.01-01(手册)",
    "render",
    domPending.length === 13 && domPending.join(",") === expectedPending.join(","),
    `DOM 口径待定徽标 ${domPending.length}（${domPending.join(",")}）/ manifest 派生 ${pendingIds.length}`,
  );

  const report = {
    ok: checks.every((check) => check.passed),
    finishedAt: new Date().toISOString(),
    context: {
      manifestCount: total,
      declaredTotal: manifest.catalogTotal,
      planned,
      p0,
      categories: counts,
    },
    checks,
  };
  await ipc.diagWriteNamed("s03010-evidence.json", JSON.stringify(report, null, 2));
  return report;
}
