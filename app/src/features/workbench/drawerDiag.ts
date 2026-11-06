import { ipc } from "../../lib/ipc";
import type { Category, ManifestResponse } from "../../lib/types";

interface Check {
  id: string;
  ac: string;
  layer: "data" | "render" | "runtime";
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

/** 副图多选当前选中项（= 副图实例列表，容量判定与参数归属的唯一 DOM 事实来源）。 */
const selectedSubs = () => {
  const select = q<HTMLSelectElement>("[data-b2-sub-select]");
  return select ? Array.from(select.selectedOptions).map((option) => option.value) : [];
};

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
    "AC-02.04-03(补3)",
    "data",
    planned.length === 61 && normalCount === 40 && betaCount === 4 && missingMeta.length === 0,
    `规划中 ${planned.length} / normal ${normalCount} / beta ${betaCount} / 缺四字段 ${
      missingMeta.map((item) => item.id).join(",") || "无"
    }（manifest.catalogTotal=${manifest.catalogTotal} 为目录规划总量，非 status=planned 的条数）`,
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
    "AC-02.04-03(补3)",
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
  const normalHits = macdRows.filter((row) => row.dataset.drawerStatus !== "planned").length;
  push(
    "R-03",
    "AC-02.04-02",
    "render",
    (firstMacd?.dataset.drawerRow ?? "") === "M06" &&
      normalHits === 1 &&
      (firstMacd?.dataset.drawerPanel ?? "") === "副" &&
      (firstMacd?.dataset.drawerParams ?? "") === "12,26,9" &&
      Boolean(firstMacd?.querySelector("mark")) &&
      macdExtras.every((row) => row.dataset.drawerStatus === "planned"),
    `搜索 MACD → ${macdRows
      .map((row) => `${row.dataset.drawerRow}:${row.dataset.drawerStatus}`)
      .join(",")} / normal 命中 ${normalHits} / 首行 ${
      firstMacd?.dataset.drawerRow ?? "—"
    } 面板 ${firstMacd?.dataset.drawerPanel ?? "—"} 参数 ${
      firstMacd?.dataset.drawerParams ?? "—"
    } / 命中高亮=${firstMacd?.querySelector("mark") ? "有" : "无"}`,
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

  // ---- S-02.04-02 添加逻辑（已添加 / 容量 / 面板归属） ----
  clickElement(trigger);
  await waitFor(() => q("[data-indicator-drawer]"));
  await sleep(120);

  // R-09 已添加态：M06 默认就在副图，行内必须显示「已添加」且重复点击不再新增
  await typeQuery("MACD");
  const m06Button = q<HTMLElement>('[data-drawer-add="M06:sub"]');
  const panelsBefore = qa("[data-sub-panel]").length;
  clickElement(m06Button);
  await sleep(120);
  const m06Hint = q("[data-drawer-hint]")?.textContent ?? "";
  push(
    "R-09",
    "AC-02.04-02(补1)",
    "render",
    m06Button?.dataset.drawerAdded === "1" &&
      Boolean(m06Button?.textContent?.includes("已添加")) &&
      qa("[data-sub-panel]").length === panelsBefore &&
      m06Hint.includes("已添加"),
    `M06 按钮已添加态=${m06Button?.dataset.drawerAdded} / 文案「${
      m06Button?.textContent?.trim() ?? ""
    }」/ 重击后副图 ${qa("[data-sub-panel]").length} 面板 / 提示「${m06Hint}」`,
  );

  // R-10 加入副图：M06 → +V01 → +M02，三个面板标题与数量都要对
  await typeQuery("ATR");
  clickElement(q('[data-drawer-add="V01:sub"]'));
  await sleep(200);
  await typeQuery("KDJ");
  const addStartedAt = performance.now();
  clickElement(q('[data-drawer-add="M02:sub"]'));
  const m02Path = await waitFor(() => q('[data-sub-panel="M02"] [data-sub-key]'), 3_000, 20).catch(() => null);
  const addWallMs = performance.now() - addStartedAt;
  await sleep(200);
  const subTitles = qa<HTMLElement>("[data-sub-panel]").map(
    (panel) => panel.querySelector("[data-sub-title]")?.getAttribute("data-sub-title") ?? "",
  );
  push(
    "R-10",
    "AC-02.04-03",
    "render",
    qa("[data-sub-panel]").length === 3 &&
      subTitles.some((title) => title.startsWith("MACD(")) &&
      subTitles.some((title) => title.startsWith("ATR")) &&
      subTitles.some((title) => title.startsWith("KDJ")),
    `副图 ${qa("[data-sub-panel]").length} 个 / 标题 ${subTitles.join(" | ") || "无"}`,
  );

  // R-11 副图满 3：第 4 个按钮为禁用态、显示 3/3、带「请先移除一个指标」tooltip，
  // 点击不改变副图数量，也不改动已有 3 个实例（无静默替换）
  await typeQuery("ATRP");
  const v02Button = q<HTMLButtonElement>('[data-drawer-add="V02:sub"]');
  const v02Disabled = Boolean(v02Button?.disabled);
  const subsBefore = selectedSubs();
  clickElement(v02Button);
  await sleep(200);
  const subsAfter = selectedSubs();
  const capacityText = q("[data-drawer-capacity]")?.textContent ?? "";
  push(
    "R-11",
    "AC-02.04-03(补1)",
    "render",
    v02Disabled &&
      qa("[data-sub-panel]").length === 3 &&
      Boolean(v02Button?.dataset.drawerFull === "1") &&
      capacityText.includes("副图 3/3") &&
      (v02Button?.title ?? "") === "请先移除一个指标" &&
      subsBefore.length === 3 &&
      subsBefore.join(",") === subsAfter.join(","),
    `第 4 个副图按钮 disabled=${v02Disabled} / full=${v02Button?.dataset.drawerFull} / 容量「${capacityText.trim()}」/ tooltip「${
      v02Button?.title ?? ""
    }」/ 副图 ${qa("[data-sub-panel]").length} 个 / 实例 ${subsBefore.join(
      "+",
    )} → ${subsAfter.join("+")}`,
  );

  // R-12 移除后恢复可添加：从副图多选里去掉 V01，V02 应重新可点且能加进第 3 个
  const subSelect = q<HTMLSelectElement>("[data-b2-sub-select]");
  if (subSelect) {
    Array.from(subSelect.options).forEach((option) => {
      if (option.value === "V01") option.selected = false;
    });
    subSelect.dispatchEvent(new Event("change", { bubbles: true }));
  }
  await sleep(200);
  await typeQuery("ATRP");
  const v02After = q<HTMLButtonElement>('[data-drawer-add="V02:sub"]');
  const reEnabled = !v02After?.disabled;
  clickElement(v02After);
  await sleep(200);
  push(
    "R-12",
    "AC-02.04-03(补2)",
    "render",
    reEnabled &&
      qa("[data-sub-panel]").length === 3 &&
      Boolean(q<HTMLElement>('[data-sub-panel="V02"]')),
    `移除 V01 后 V02 可添加=${reEnabled} / 副图 ${qa("[data-sub-panel]").length} 个 / V02 面板=${
      Boolean(q<HTMLElement>('[data-sub-panel="V02"]')) ? "在" : "无"
    }`,
  );

  // R-13 面板归属：主图条目只给「+ 主图」，副图条目只给「+ 副图」
  await typeQuery("Envelopes");
  const mainRow = q<HTMLElement>('[data-drawer-row="T08"]');
  const mainHasSubButton = Boolean(mainRow?.querySelector('[data-drawer-add$=":sub"]'));
  await typeQuery("KDJ");
  const subRow = q<HTMLElement>('[data-drawer-row="M02"]');
  const subHasMainButton = Boolean(subRow?.querySelector('[data-drawer-add$=":main"]'));
  push(
    "R-13",
    "AC-02.04-04(补1)",
    "render",
    Boolean(mainRow) && !mainHasSubButton && Boolean(subRow) && !subHasMainButton,
    `T08(主) 带副图按钮=${mainHasSubButton} / M02(副) 带主图按钮=${subHasMainButton}`,
  );

  // R-14 主图满 2：点第 3 个给明确提示，不静默替换掉已有叠加
  await typeQuery("Envelopes");
  const mainButton = q<HTMLElement>('[data-drawer-add="T08:main"]');
  const mainFull = mainButton?.dataset.drawerFull === "1";
  clickElement(mainButton);
  await sleep(120);
  const fullHint = q("[data-drawer-hint]")?.textContent ?? "";
  push(
    "R-14",
    "AC-02.04-04",
    "render",
    mainFull && fullHint.includes("主图最多 2 个") && Boolean(mainButton?.dataset.drawerAdded === "0"),
    `T08 full=${mainButton?.dataset.drawerFull} / 点击提示「${fullHint}」/ 未被静默加入=${mainButton?.dataset.drawerAdded}`,
  );

  // R-15 首次冷算 ≤300ms：M06 的冷算日志（页面挂载时首次计算）+ M02 抽屉点击到曲线出现
  const dump = await ipc.telemetryDump(200);
  const colds = dump.recent.filter((event) => event.name === "indicator.cold_ms");
  const lastCold = (id: string) =>
    [...colds].reverse().find((event) => String(event.fields.indicatorId ?? "") === id);
  const m06ColdMs = Number(lastCold("M06")?.fields.coldMs ?? Number.NaN);
  const m02ColdMs = Number(lastCold("M02")?.fields.coldMs ?? Number.NaN);
  push(
    "R-15",
    "AC-02.04-04(补2)",
    "runtime",
    Boolean(m02Path) &&
      m06ColdMs <= 300 &&
      m02ColdMs <= 300 &&
      addWallMs <= 300,
    `M06 冷算 ${m06ColdMs.toFixed(2)}ms / M02 冷算 ${m02ColdMs.toFixed(2)}ms / M02 点击→曲线 ${addWallMs.toFixed(
      0,
    )}ms / 冷样本 ${dump.coldSamples} P95 ${dump.coldP95Ms ?? "—"}ms`,
  );

  // R-16 面板 180ms 展开只做位移/透明度，不叠绝对定位层遮挡坐标轴
  const panelEl = q<HTMLElement>('[data-sub-panel="M02"]');
  const animMs = panelEl ? Number.parseFloat(getComputedStyle(panelEl).animationDuration) * 1000 : Number.NaN;
  const covering = panelEl
    ? Array.from(panelEl.querySelectorAll<HTMLElement>("*")).filter((element) => {
        const style = getComputedStyle(element);
        return style.position === "absolute" && Number.parseFloat(style.zIndex || "0") > 0;
      }).length
    : -1;
  push(
    "R-16",
    "AC-02.04-04(补2)",
    "render",
    Number.isFinite(animMs) && animMs >= 180 && animMs <= 200 && covering === 0,
    `面板动画 ${animMs.toFixed(0)}ms / 覆盖坐标轴的绝对定位层 ${covering} 个`,
  );

  // R-17 无标的：加入按钮禁用 + 「请先在行情页选择一只标的」引导 + 去行情页链接；
  // 行内点击只能出提示，不能静默把指标加进一个不存在的标的。
  // 经目录页中转，让工作台以「不存在的代码」重新挂载（同一路由内改 hash 不会重建组件）。
  window.location.hash = "#/catalog";
  await sleep(250);
  window.location.hash = "#/workbench/999999.XX";
  const noTargetName = await waitFor(
    () => {
      const name = q("[data-wb-name]")?.textContent ?? "";
      return name.includes("未选择标的") ? name : null;
    },
    5_000,
    100,
  ).catch(() => "");
  clickElement(await waitFor(() => q<HTMLElement>("[data-drawer-trigger]"), 5_000, 50).catch(() => null));
  await waitFor(() => q("[data-indicator-drawer]"), 5_000, 50).catch(() => null);
  await sleep(120);
  const guide = q<HTMLElement>("[data-drawer-no-target]");
  const guideText = (guide?.textContent ?? "").replace(/\s+/g, " ").trim();
  const goMarket = guide?.querySelector<HTMLAnchorElement>("[data-drawer-go-market]");
  await typeQuery("kdj");
  const m02Button = q<HTMLButtonElement>('[data-drawer-add="M02:sub"]');
  const blocked = m02Button?.dataset.drawerBlocked === "1" && Boolean(m02Button.disabled);
  const subsBeforeNoTarget = selectedSubs();
  clickElement(q<HTMLElement>('[data-drawer-row="M02"]'));
  await sleep(120);
  const subsAfterNoTarget = selectedSubs();
  const noTargetHint = q("[data-drawer-hint]")?.textContent ?? "";
  push(
    "R-17",
    "AC-03.01-05(补1)",
    "render",
    noTargetName.includes("未选择标的") &&
      Boolean(guide) &&
      guideText.includes("请先在行情页选择一只标的") &&
      (goMarket?.getAttribute("href") ?? "") === "#/market" &&
      blocked &&
      subsBeforeNoTarget.join(",") === subsAfterNoTarget.join(",") &&
      noTargetHint.includes("请先在行情页选择一只标的"),
    `标的=${noTargetName || "—"} / 引导「${guideText}」/ 去行情页 href=${goMarket?.getAttribute(
      "href",
    )} / M02 禁用=${blocked} / 副图实例=${subsBeforeNoTarget.join(
      "+",
    )} → ${subsAfterNoTarget.join("+")} / 行点击提示「${noTargetHint}」`,
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
