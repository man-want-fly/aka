import { ipc } from "../../lib/ipc";
import type { ManifestResponse } from "../../lib/types";
import { collectEvidenceEnv, collectFocus } from "../workbench/diag";
import { healthSummaryMismatch } from "./healthSummary";

/**
 * P01–P04 本批取证：
 * S-03.01-04（加入图表/容量/规划）、S-03.02-01（收藏）、
 * S-03.03-02（深链返回）、S-06.03-01（关于页）。
 * 只读/可回滚：收藏数据由 diag-evidence.sh 备份 state.db 后还原。
 */

interface Check {
  id: string;
  card: string;
  ac: string;
  layer: "data" | "render" | "runtime";
  passed: boolean;
  detail: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

const waitFor = async <T,>(probe: () => T | null, timeoutMs = 8_000, stepMs = 50): Promise<T> => {
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

const CATEGORY_KEYS = ["trend", "momentum", "volatility", "volume", "stat", "breadth"] as const;

const expandAllCategories = async () => {
  for (const key of CATEGORY_KEYS) {
    const toggle = q<HTMLElement>(`[data-catalog-cat-toggle="${key}"]`);
    if (toggle && toggle.getAttribute("aria-expanded") !== "true") {
      toggle.click();
      await sleep(60);
    }
  }
  await waitFor(() => q('[data-catalog-item="T06"]'));
};

const gotoHash = async (hash: string, selector: string) => {
  window.location.hash = hash;
  await waitFor(() => q(selector));
  await sleep(120);
};

/** 目录页状态（last_code/收藏）来自挂载时读取，须先离开再回来才会重挂载。 */
const remountCatalog = async () => {
  window.location.hash = "#/market";
  await waitFor(() => q("[data-market-root], main"));
  await sleep(150);
  await gotoHash("#/catalog", "[data-catalog-root='p3']");
};

const readSubPlots = (): string[] => {
  try {
    const raw = window.localStorage.getItem("aka.workbench.subplots.v1");
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<{ id?: string }>;
    return parsed.map((item) => item.id ?? "").filter(Boolean);
  } catch {
    return [];
  }
};

const writeSubPlots = (ids: string[]) => {
  window.localStorage.setItem(
    "aka.workbench.subplots.v1",
    JSON.stringify(ids.map((id) => ({ id, height: 132 }))),
  );
};

const baseReport = (suite: string) => ({
  suite,
  ok: false,
  finishedAt: "",
  checks: [] as Check[],
});

/**
 * R-EV-02：env 与聚焦状态由 diag.ts 统一产出；env 采集失败也照常落 dump（由 verify 判 failed）。
 * meta.dump / meta.reproduce 由 evidence-run.sh 写入，套件出口只负责顶层 env / windowFocused / appActive。
 */
const writeBatchReport = async (
  name: string,
  hint: string,
  report: ReturnType<typeof baseReport> & Record<string, unknown>,
) => {
  const env = await collectEvidenceEnv(hint).catch(() => null);
  const focus = collectFocus();
  report.ok = report.checks.every((check) => check.passed);
  report.finishedAt = new Date().toISOString();
  await ipc.diagWriteNamed(
    name,
    JSON.stringify(
      { ...report, env, windowFocused: focus.windowFocused, appActive: focus.appActive },
      null,
      2,
    ),
  );
};

/** P01：目录行「加入图表」容量、去重、规划项与无标的引导。 */
export async function runS030104Diagnostics(manifest: ManifestResponse) {
  const report = { ...baseReport("s030104"), card: "S-03.01-04" };
  const push = (id: string, ac: string, layer: Check["layer"], passed: boolean, detail: string) => {
    report.checks.push({ id, card: "S-03.01-04", ac, layer, passed, detail });
  };
  const countState = (id: string) =>
    q<HTMLElement>(`[data-catalog-add="${id}"]`)?.dataset.catalogAddState ?? "";
  const rowHint = (id: string) => q<HTMLElement>(`[data-catalog-add-hint="${id}"]`)?.textContent?.trim() ?? "";

  // 阶段 1：无标的（App 已清 aka.last.code）
  await waitFor(() => q("[data-catalog-root='p3']"));
  const banner = q<HTMLElement>("[data-catalog-no-target]");
  const noSymbolButton = q<HTMLButtonElement>('[data-catalog-add="T03"]');
  push(
    "P01-R1",
    "AC-03.01-05（补1）",
    "render",
    Boolean(banner?.textContent?.includes("请先在行情页选择一只标的")) &&
      q("[data-catalog-go-market]") !== null &&
      noSymbolButton?.disabled === true &&
      noSymbolButton?.title === "请先在行情页选择一只标的",
    `无标的横幅「${banner?.textContent?.trim() ?? "—"}」/ 去行情页=${q("[data-catalog-go-market]") !== null} / 按钮 disabled=${noSymbolButton?.disabled} title=「${noSymbolButton?.title ?? ""}」`,
  );

  // 阶段 2：有标的 + 默认副图满仓（VOL/M06/M01）
  window.localStorage.setItem("aka.last.code", "600519.SH");
  writeSubPlots(["VOL", "M06", "M01"]);
  await remountCatalog();
  await expandAllCategories();

  const m03Add = q<HTMLButtonElement>('[data-catalog-add="M03"]');
  push(
    "P01-R2",
    "AC-03.01-05（补2）",
    "render",
    countState("M03") === "full" &&
      m03Add?.disabled === true &&
      m03Add?.title === "副图已满（3/3），请先移除一个" &&
      rowHint("M03") === "副图已满（3/3），请先移除一个",
    `M03 状态=${countState("M03")} disabled=${m03Add?.disabled} title=「${m03Add?.title ?? ""}」/ 提示「${rowHint("M03")}」`,
  );

  const m06Add = q<HTMLButtonElement>('[data-catalog-add="M06"]');
  const m06Count = readSubPlots().filter((id) => id === "M06").length;
  push(
    "P01-R3",
    "AC-03.01-05（补3）",
    "render",
    countState("M06") === "added" && m06Add?.disabled === true && m06Count === 1,
    `M06 状态=${countState("M06")} disabled=${m06Add?.disabled} 副图 M06=${m06Count} 次`,
  );

  const beforePlanned = readSubPlots().join(",");
  const t06Add = q<HTMLButtonElement>('[data-catalog-add="T06"]');
  t06Add?.click();
  await sleep(120);
  const plannedHint = q<HTMLElement>("[data-catalog-detail-hint], [data-fav-hint]")?.textContent?.trim() ?? "";
  push(
    "P01-R4",
    "AC-03.01-05（补4）",
    "render",
    countState("T06") === "planned" &&
      t06Add?.getAttribute("aria-disabled") === "true" &&
      plannedHint.includes("该指标规划中，本期未开放") &&
      readSubPlots().join(",") === beforePlanned,
    `T06 状态=${countState("T06")} aria-disabled=${t06Add?.getAttribute("aria-disabled")} 提示「${plannedHint}」/ 副图未变=${readSubPlots().join(",") === beforePlanned}`,
  );

  // 阶段 3：留出副图空位后加入
  writeSubPlots(["VOL"]);
  await remountCatalog();
  await expandAllCategories();
  const m03Before = readSubPlots().join(",");
  q<HTMLButtonElement>('[data-catalog-add="M03"]')?.click();
  await waitFor(() => (countState("M03") === "added" ? "1" : null));
  const m03After = readSubPlots().filter((id) => id === "M03").length;
  push(
    "P01-R5",
    "AC-03.01-05",
    "render",
    m03After === 1 && !m03Before.split(",").includes("M03") && q<HTMLElement>('[data-catalog-add="M03"]')?.textContent?.includes("已加入") === true,
    `加入前副图 ${m03Before} / 加入后 M03=${m03After} 次 / 按钮「${q<HTMLElement>('[data-catalog-add="M03"]')?.textContent?.trim() ?? ""}」/ manifest ${manifest.indicators.length} 条`,
  );

  // 复原默认副图，避免影响后续套件
  writeSubPlots(["VOL", "M06", "M01"]);
  await writeBatchReport("s030104-evidence.json", "s030104", report);
  return report;
}

/** P02：首装 8 项默认收藏、星标增删、顺序、幂等；含数据层 IPC 校验。 */
export async function runS030201Diagnostics() {
  const report = { ...baseReport("s030201"), card: "S-03.02-01" };
  const push = (id: string, ac: string, layer: Check["layer"], passed: boolean, detail: string) => {
    report.checks.push({ id, card: "S-03.02-01", ac, layer, passed, detail });
  };
  const expected = ["T01", "T02", "T09", "M06", "M01", "M02", "V01", "D01"];
  const chipIds = () =>
    qa<HTMLElement>("[data-fav-chip]").map((element) => element.dataset.favChip ?? "").filter(Boolean);

  await waitFor(() => q("[data-catalog-root='p3']"));
  await waitFor(() => q("[data-fav-strip]"));
  await waitFor(() => (qa("[data-fav-chip]").length === 8 ? "8" : null));

  const chips = chipIds();
  const statuses = qa<HTMLElement>("[data-fav-chip]").map((element) => element.dataset.favStatus ?? "");
  const countText = q<HTMLElement>("[data-fav-count-text]")?.textContent?.trim() ?? "";
  push(
    "P02-R1",
    "AC-03.02-01",
    "render",
    chips.join(",") === expected.join(",") &&
      statuses.every((status) => status === "normal") &&
      countText === "8",
    `收藏 chips ${chips.join(",")} / 状态 ${statuses.join(",")} / 计数「${countText}」`,
  );

  // 星标添加：M03 不在默认集；添加后应排在最前，再取消恢复
  const m03StarBefore = q<HTMLElement>('[data-fav-star="M03"]')?.getAttribute("aria-pressed");
  q<HTMLElement>('[data-fav-star="M03"]')?.click();
  await waitFor(() => (chipIds()[0] === "M03" ? "1" : null));
  const afterAdd = chipIds();
  const m03First = afterAdd[0] === "M03" && afterAdd.filter((id) => id === "M03").length === 1;
  push(
    "P02-R2",
    "AC-03.02-02",
    "render",
    m03StarBefore === "false" && m03First && afterAdd.length === 9,
    `M03 星标前 aria-pressed=${m03StarBefore} / 添加后序列 ${afterAdd.join(",")} / M03 首项且唯一=${m03First}`,
  );
  push(
    "P02-R3",
    "AC-03.02-02（补1）",
    "render",
    afterAdd[0] === "M03",
    `新收藏排在最前：首项 ${afterAdd[0] ?? "—"}`,
  );
  q<HTMLElement>('[data-fav-star="M03"]')?.click();
  await waitFor(() => (chipIds().length === 8 ? "8" : null));

  // 8 项在一屏内可见（不横向溢出）
  const list = q<HTMLElement>(".fav-chips");
  const overflows = list ? list.scrollWidth > list.clientWidth + 1 : true;
  push(
    "P02-R4",
    "AC-03.02-01（补3）",
    "render",
    !overflows && chipIds().length === 8,
    `收藏区 ${chipIds().length} 项 / 横向溢出=${overflows}（scrollWidth ${list?.scrollWidth ?? 0} / clientWidth ${list?.clientWidth ?? 0}）`,
  );

  // 规划项 chip：点击「加入图表」应被拒并保留 chip
  await ipc.setIndicatorFavorite("T06", true);
  await remountCatalog();
  await waitFor(() => q('[data-fav-chip="T06"]'));
  const t06Chip = q<HTMLElement>('[data-fav-chip="T06"]');
  q<HTMLElement>('[data-fav-chip-add="T06"]')?.click();
  await sleep(150);
  const plannedHint = q<HTMLElement>("[data-fav-hint]")?.textContent?.trim() ?? "";
  push(
    "P02-R5",
    "AC-03.02-01（补2）",
    "render",
    t06Chip?.dataset.favStatus === "planned" &&
      plannedHint.includes("该指标规划中，本期未开放") &&
      chipIds().includes("T06"),
    `T06 chip 状态=${t06Chip?.dataset.favStatus ?? "—"} 提示「${plannedHint}」/ chip 保留=${chipIds().includes("T06")}`,
  );
  await ipc.setIndicatorFavorite("T06", false);

  // ---- 数据层：与目录/抽屉同源的 IPC 真值 ----
  const seeded = await ipc.indicatorFavorites();
  const seededIds = seeded.favorites.map((item) => item.indicatorId);
  push(
    "P02-D1",
    "AC-03.02-01",
    "data",
    seededIds.join(",") === expected.join(",") &&
      seeded.favorites.every((item) => item.isDefault && item.status === "normal"),
    `IPC 默认收藏 ${seededIds.join(",")} / 全部 normal+default=${seeded.favorites.every((item) => item.isDefault && item.status === "normal")}`,
  );

  for (let i = 0; i < 5; i += 1) await ipc.setIndicatorFavorite("M03", true);
  const afterFive = await ipc.indicatorFavorites();
  const m03Rows = afterFive.favorites.filter((item) => item.indicatorId === "M03").length;
  push(
    "P02-D2",
    "AC-03.02-01（补1）",
    "data",
    m03Rows === 1 && afterFive.favorites.length === 9,
    `连续 5 次收藏 M03 → 行数 ${afterFive.favorites.length}，M03 唯一行 ${m03Rows}`,
  );
  await ipc.setIndicatorFavorite("M03", false);

  const all = (await ipc.indicatorFavorites()).favorites;
  for (const item of all) await ipc.setIndicatorFavorite(item.indicatorId, false);
  const emptied = await ipc.indicatorFavorites();
  const again = await ipc.indicatorFavorites();
  push(
    "P02-D3",
    "AC-03.02-01（补2）",
    "data",
    emptied.favorites.length === 0 && again.favorites.length === 0,
    `全部移除后 ${emptied.favorites.length} 项；再次读取 ${again.favorites.length} 项（未重新播种）`,
  );

  await writeBatchReport("s030201-favorites-evidence.json", "s030201", report);
  return report;
}

/** P03：图例「?」、抽屉来源、目录深链与返回态（目录来源部分）。 */
export async function runS030302CatalogDiagnostics() {
  const report = { ...baseReport("s030302-catalog"), card: "S-03.03-02" };
  const push = (id: string, ac: string, layer: Check["layer"], passed: boolean, detail: string) => {
    report.checks.push({ id, card: "S-03.03-02", ac, layer, passed, detail });
  };
  await waitFor(() => q("[data-catalog-root='p3']"));
  await expandAllCategories();

  const firstToggle = q<HTMLElement>('[data-catalog-cat-toggle="trend"]');
  if (firstToggle?.getAttribute("aria-expanded") === "true") {
    firstToggle.click();
    await sleep(80);
  }
  q<HTMLElement>('[data-catalog-open-detail="M06"]')?.click();
  await waitFor(() => q("[data-catalog-breadcrumb-current='M06']"));
  const crumb = q<HTMLElement>("[data-catalog-breadcrumb]")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  push(
    "P03-R1",
    "AC-03.03-03",
    "render",
    crumb.includes("指标目录") && crumb.includes("MACD") && window.location.hash.includes("#/catalog/M06"),
    `目录来源面包屑「${crumb}」/ hash ${window.location.hash}`,
  );

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitFor(() => q("[data-catalog-root='p3']"));
  const trendToggle = q<HTMLElement>('[data-catalog-cat-toggle="trend"]');
  const rows = qa<HTMLElement>("[data-catalog-item]").length;
  push(
    "P03-R2",
    "AC-03.03-03",
    "render",
    !window.location.hash.startsWith("#/catalog/") &&
      trendToggle?.getAttribute("aria-expanded") === "true" &&
      rows >= 24,
    `Esc 返回后 hash ${window.location.hash || "(空)"} / trend 展开=${trendToggle?.getAttribute("aria-expanded")} / DOM ${rows} 行`,
  );

  await writeBatchReport("s030302-catalog-evidence.json", "s030302-catalog", report);
  return report;
}

/** P03：工作台图例「?」→ P4 → 返回，副图/视口保持；抽屉来源面包屑与抽屉恢复。 */
export async function runS030302WorkbenchDiagnostics() {
  const report = { ...baseReport("s030302"), card: "S-03.03-02" };
  const push = (id: string, ac: string, layer: Check["layer"], passed: boolean, detail: string) => {
    report.checks.push({ id, card: "S-03.03-02", ac, layer, passed, detail });
  };

  const help = await waitFor(() => q<SVGGElement>('[data-legend-help="M06"]'));
  push(
    "P03-R3",
    "AC-03.03-03（补1）",
    "render",
    Boolean(help) && q('[data-legend-help="M06"]')?.getAttribute("role") === "button",
    `工作台 MACD 图例「?」存在=${Boolean(help)} role=${help?.getAttribute("role") ?? "—"}`,
  );

  const subBefore = readSubPlots().join(",");
  const viewportBefore = window.sessionStorage.getItem("aka.chart.viewport");
  help.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await waitFor(() => q("[data-catalog-breadcrumb-from='chart']"));
  const crumb = q<HTMLElement>("[data-catalog-breadcrumb]")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  push(
    "P03-R4",
    "AC-03.03-03（补1）",
    "render",
    crumb.includes("工作台") && crumb.includes("600519.SH") && crumb.includes("MACD"),
    `图例来源面包屑「${crumb}」/ hash ${window.location.hash}`,
  );

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitFor(() => q("[data-workbench-root]"));
  await sleep(300);
  const subAfter = readSubPlots().join(",");
  const viewportAfter = window.sessionStorage.getItem("aka.chart.viewport");
  push(
    "P03-R5",
    "AC-03.03-03（补1）",
    "render",
    subAfter === subBefore && subAfter.includes("M06") && viewportAfter === viewportBefore,
    `返回后副图 ${subBefore} → ${subAfter} / 视口记忆未变=${viewportAfter === viewportBefore}`,
  );

  // 抽屉来源：打开抽屉 → 收藏区「查看口径」→ 面包屑 → Esc 回来抽屉仍开
  const drawerTrigger = q<HTMLButtonElement>("[data-drawer-trigger]");
  drawerTrigger?.click();
  await waitFor(() => q("[data-drawer-body]"));
  q<HTMLElement>('[data-fav-chip-detail="M06"]')?.click();
  await waitFor(() => q("[data-catalog-breadcrumb-from='drawer']"));
  const drawerCrumb = q<HTMLElement>("[data-catalog-breadcrumb]")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  push(
    "P03-R6",
    "AC-03.03-03（补2）",
    "render",
    drawerCrumb.includes("工作台") && drawerCrumb.includes("600519.SH") && drawerCrumb.includes("MACD"),
    `抽屉来源面包屑「${drawerCrumb}」`,
  );

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitFor(() => q("[data-workbench-root]"));
  const drawerRestored = await waitFor(() => q("[data-drawer-body]"), 4_000).catch(() => null);
  push(
    "P03-R7",
    "AC-03.03-03（补2）",
    "render",
    drawerRestored !== null,
    `Esc 返回工作台后抽屉恢复=${drawerRestored !== null}`,
  );
  q<HTMLElement>("[data-drawer-close]")?.click();

  await writeBatchReport("s030302-evidence.json", "s030302", report);
  return report;
}

/** P04：关于页版本/构建/引擎/计数/数据目录/通道/许可，运行层零外部请求。 */
export async function runS060301Diagnostics() {
  const report = { ...baseReport("s060301"), card: "S-06.03-01" };
  const push = (id: string, ac: string, layer: Check["layer"], passed: boolean, detail: string) => {
    report.checks.push({ id, card: "S-06.03-01", ac, layer, passed, detail });
  };
  await waitFor(() => q("[data-about-page]"));
  await waitFor(() => (q<HTMLElement>("[data-about-indicators]")?.dataset.aboutIndicators ? "1" : null));

  const version = q<HTMLElement>("[data-about-version]")?.dataset.aboutVersion ?? "";
  const build = q<HTMLElement>("[data-about-build]")?.dataset.aboutBuild ?? "";
  const engine = q<HTMLElement>("[data-about-engine]")?.dataset.aboutEngine ?? "";
  const indicators = q<HTMLElement>("[data-about-indicators]")?.dataset.aboutIndicators ?? "";
  const datadir = q<HTMLElement>("[data-about-datadir]")?.dataset.aboutDatadir ?? "";
  const channel = q<HTMLElement>("[data-about-channel]")?.dataset.aboutChannel ?? "";
  const channelButtons = qa<HTMLButtonElement>("[data-about-channel] button, [data-about-channel-buttons] button").length;
  const license = q<HTMLElement>("[data-about-license]")?.dataset.aboutLicense ?? "";
  push(
    "P04-R1",
    "AC-06.03-01",
    "render",
    version !== "" &&
      build !== "" &&
      engine !== "" &&
      /^\d+\/\d+$/.test(indicators) &&
      datadir.includes("data/sim") &&
      channel === "stable" &&
      channelButtons === 0 &&
      license !== "",
    `版本 ${version} / 构建 ${build} / 引擎 ${engine} / 指标 ${indicators} / 目录 ${datadir} / 通道 ${channel}（按钮 ${channelButtons}）/ 许可 ${license}`,
  );

  const manifest = await ipc.indicatorManifest();
  const implemented = manifest.indicators.filter((item) => item.status !== "planned").length;
  const total = manifest.indicators.length;
  push(
    "P04-R2",
    "AC-06.03-01（补1）",
    "render",
    indicators === `${implemented}/${total}` && total === manifest.catalogTotal,
    `关于页 ${indicators} = manifest ${implemented}/${total}（declared ${manifest.catalogTotal}）`,
  );

  const state = q<HTMLElement>("[data-about-datadir-state]")?.dataset.aboutDatadirState ?? "";
  const rebuild = q("[data-about-datadir-rebuild]") !== null;
  push(
    "P04-R3",
    "AC-06.03-01（补3）",
    "render",
    datadir.includes("data/sim") && state === "missing" && rebuild,
    `数据目录行「${datadir}」状态=${state} / 重建样本包入口=${rebuild}`,
  );

  const external = performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name) => /^https?:\/\//.test(name));
  push(
    "P04-R4",
    "AC-06.03-01（补2）",
    "runtime",
    external.length === 0,
    `关于页渲染期外部 http(s) 资源 ${external.length} 个${external.length ? `：${external.join(",")}` : ""}`,
  );

  await writeBatchReport("s060301-about-evidence.json", "s060301", report);
  return report;
}

/** 外部 http(s) 资源数量；用于「0 网络」取证（补4）。 */
const externalResourceCount = () =>
  performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name) => /^https?:\/\//.test(name)).length;

/** P05：S-06.03-02 一键导出诊断包；只读，会新增 ~/Downloads/aka-diagnostics-*.zip。 */
export async function runS060302Diagnostics() {
  const report = { ...baseReport("s060302"), card: "S-06.03-02" };
  const push = (id: string, ac: string, layer: Check["layer"], passed: boolean, detail: string) => {
    report.checks.push({ id, card: "S-06.03-02", ac, layer, passed, detail });
  };
  await waitFor(() => q("[data-about-page]"));

  const button = q<HTMLButtonElement>("[data-about-export]");
  const hint = q<HTMLElement>("[data-about-diagnostics-hint]")?.textContent?.trim() ?? "";
  push(
    "P05-R1",
    "AC-06.03-02",
    "render",
    button !== null && !button.disabled && hint.includes("不含自选") && hint.includes("不上传"),
    `按钮可用=${Boolean(button && !button.disabled)} / 说明「${hint}」`,
  );

  const before = externalResourceCount();
  button?.click();
  await waitFor(
    () => q("[data-about-diagnostics-path], [data-about-diagnostics-error]"),
    25_000,
    100,
  );
  const path = q<HTMLElement>("[data-about-diagnostics-path]")?.dataset.aboutDiagnosticsPath ?? "";
  const pathText = q<HTMLElement>("[data-about-diagnostics-path]")?.textContent ?? "";
  const error = q<HTMLElement>("[data-about-diagnostics-error]")?.dataset.aboutDiagnosticsError ?? "";
  const state = q<HTMLElement>("[data-about-export]")?.dataset.aboutExportState ?? "";
  const after = externalResourceCount();

  if (error !== "") {
    push(
      "P05-R2",
      "AC-06.03-02（补2）",
      "runtime",
      /磁盘空间不足/.test(error) && /可用/.test(error),
      `导出失败提示「${error}」`,
    );
  } else {
    push(
      "P05-R2",
      "AC-06.03-02",
      "runtime",
      /\/Downloads\/aka-diagnostics-\d{8}-\d{6}\.zip$/.test(path) &&
        (state === "success" || state === "no-log"),
      `路径=${path} / 状态=${state}`,
    );
    push(
      "P05-R3",
      "AC-06.03-02（补3）",
      "render",
      state !== "no-log" || pathText.includes("无日志"),
      state === "no-log" ? "路径行已注明「本次无日志」" : "本次有日志，形态见包内 app.log",
    );
  }

  push(
    "P05-R4",
    "AC-06.03-02（补4）",
    "runtime",
    after - before === 0,
    `导出期间外部 http(s) 资源 ${after - before} 个`,
  );

  await writeBatchReport("s060302-evidence.json", "s060302", report);
  return report;
}

/** P07：S-07.01-02 健康检查 6 项 + tushare 禁用卡；只读、0 网络、不轮询。 */
export async function runS070102Diagnostics() {
  const report = { ...baseReport("s070102"), card: "S-07.01-02" };
  const push = (id: string, ac: string, layer: Check["layer"], passed: boolean, detail: string) => {
    report.checks.push({ id, card: "S-07.01-02", ac, layer, passed, detail });
  };
  await waitFor(() => q("[data-health-section]"));

  const button = q<HTMLButtonElement>("[data-health-check]");
  push(
    "P07-R1",
    "AC-07.01-02",
    "render",
    button !== null && !button.disabled,
    `健康检查按钮可用=${Boolean(button && !button.disabled)}`,
  );

  const countBefore = (await ipc.telemetryDump(200)).counts["health.check"] ?? 0;
  const externalBefore = externalResourceCount();
  const started = performance.now();
  // 防重入：结果回来前连点 3 次，只能记 1 条 health.check。
  button?.click();
  button?.click();
  button?.click();
  await waitFor(() => q("[data-health-table], [data-health-error]"), 8_000, 50);
  const elapsed = Math.round(performance.now() - started);
  const countAfter = (await ipc.telemetryDump(200)).counts["health.check"] ?? 0;
  const externalAfter = externalResourceCount();

  const error = q<HTMLElement>("[data-health-error]")?.textContent?.trim() ?? "";
  const rows = qa<HTMLElement>("[data-health-row]");
  const statuses = rows.map((row) => row.dataset.healthStatus ?? "");
  const summary = (q<HTMLElement>("[data-health-summary]")?.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim();

  push(
    "P07-R2",
    "AC-07.01-02",
    "render",
    rows.length === 6 && statuses.every((status) => ["PASS", "FAIL", "SKIP"].includes(status)),
    `${rows.length} 行 / ${statuses.join(",")}`,
  );
  // W-103：分子按注入场景断言——默认数据集 6/6，corrupt 场景 1/6；只校验分母会把 6/6 误判为通过。
  const manifestCorrupt = (await ipc.diagFaults().catch(() => null))?.manifestCorrupt ?? false;
  const summaryMismatch = healthSummaryMismatch(manifestCorrupt, summary);
  push(
    "P07-R3",
    "AC-07.01-02",
    "render",
    summaryMismatch === null,
    `manifestCorrupt=${manifestCorrupt} · 汇总「${summary}」${summaryMismatch ? ` · ${summaryMismatch}` : ""}`,
  );
  push(
    "P07-R4",
    "AC-07.01-02",
    "runtime",
    error === "" && elapsed <= 1_500 && countAfter - countBefore === 1,
    `耗时 ${elapsed} ms / 错误「${error}」/ health.check 新增 ${countAfter - countBefore} 条（期望 1）`,
  );

  // AC-07.01-02（补3）：--corrupt-manifest 注入时 ②FAIL → ③~⑥SKIP、汇总 1/6。
  const rebuild = q<HTMLElement>("[data-health-rebuild]");
  const chainPassed = rebuild
    ? statuses[0] === "PASS" &&
      statuses[1] === "FAIL" &&
      statuses.slice(2).every((status) => status === "SKIP") &&
      summary.startsWith("1/6")
    : statuses.every((status) => status === "PASS");
  push(
    "P07-R5",
    "AC-07.01-02（补3）",
    "render",
    chainPassed,
    rebuild ? `②FAIL、③~⑥SKIP、汇总「${summary}」` : "默认数据集全部 PASS（注入链由 --corrupt-manifest 覆盖）",
  );

  const caps = qa<HTMLElement>("[data-tushare-cap]");
  const actions = qa<HTMLButtonElement>("[data-tushare-action]");
  const tushareSummary = q<HTMLElement>("[data-tushare-summary]")?.textContent?.trim() ?? "";
  const pageText = document.querySelector("main")?.textContent ?? document.body.textContent ?? "";
  const forbidden = ["已连接", "同步中", "即将上线", "敬请期待", "倒计时"].filter((word) =>
    pageText.includes(word),
  );
  push(
    "P07-R6",
    "AC-07.01-03",
    "render",
    caps.length === 4 &&
      caps.every((cap) => cap.dataset.tushareAvailable === "0") &&
      /^0\/4/.test(tushareSummary) &&
      actions.length === 4 &&
      actions.every(
        (action) => action.disabled && (action.title ?? "").includes("本期仅支持模拟数据"),
      ) &&
      forbidden.length === 0,
    `能力 ${caps.length} 项 0/4 / 按钮 ${actions.length} 个全禁用 / 禁用词「${forbidden.join(
      "、",
    ) || "无"}」`,
  );

  push(
    "P07-R7",
    "AC-07.01-03",
    "runtime",
    externalAfter - externalBefore === 0,
    `检查期间外部 http(s) 资源 ${externalAfter - externalBefore} 个`,
  );

  await writeBatchReport("s070102-evidence.json", "s070102", report);
  return report;
}

/**
 * W-116：S-02.08-01 / AC-02.08-01（补2）「只缺 sha256、其余 6 段正常」页脚取证。
 * 由 AKA_DIAG_TARGET=s020801 + --missing-manifest-sha256 触发；只读，不改产品语义。
 * 判定表达式由 verify_w116_injection.mjs 从此处派生，注入未生效时必须判红。
 */
export async function runS020801Diagnostics() {
  const report = { ...baseReport("s020801"), card: "S-02.08-01" };
  const push = (id: string, ac: string, layer: Check["layer"], passed: boolean, detail: string) => {
    report.checks.push({ id, card: "S-02.08-01", ac, layer, passed, detail });
  };
  await waitFor(() => q("[data-dataset-overview='1']"));
  const segments = qa<HTMLElement>("[data-dataset-seg]").map((el) => ({
    key: el.dataset.datasetSeg ?? "",
    missing: el.dataset.datasetMissing === "1",
    text: el.textContent?.trim() ?? "",
  }));
  push(
    "S0208-P2R",
    "AC-02.08-01（补2）",
    "render",
    segments.filter((s) => s.missing).length === 1 && segments.find((s) => s.missing)?.key === "version" && segments.filter((s) => !s.missing).length === 6,
    `页脚 ${segments.length} 段 / 缺失段「${segments.filter((s) => s.missing).map((s) => s.key).join(",") || "无"}」`,
  );
  await writeBatchReport("s020801-evidence.json", "s020801", report);
  return report;
}
