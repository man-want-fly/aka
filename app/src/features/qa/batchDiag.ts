import { ipc } from "../../lib/ipc";
import type { ManifestResponse } from "../../lib/types";
import { buildSearchIndex, matchSecurities } from "../search/searchIndex";
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

/** 取证环境是 debug 构建 + 冷启动，DOM 就绪普遍慢于 8s；统一放宽到 20s。 */
const DOM_WAIT_MS = 20_000;
/** 工作台要等 bars+calc 首次算完，单独放宽。 */
const CHART_WAIT_MS = 45_000;

/**
 * 等待 DOM/状态就绪。超时错误必须带步骤名：
 * 失败 dump 里只有「等待超时」四个字时，无法区分卡在哪一步（W-119 的教训）。
 */
const waitFor = async <T,>(
  probe: () => T | null,
  timeoutMs = DOM_WAIT_MS,
  stepMs = 50,
  label = "未命名步骤",
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）：${label}`);
    await sleep(stepMs);
  }
};

/** 可选等待：超时返回 null（用于「拿不到就判红」的观察量，不让整条套件崩掉）。 */
const tryWait = async <T,>(
  probe: () => T | null,
  timeoutMs = DOM_WAIT_MS,
  stepMs = 50,
): Promise<T | null> => {
  try {
    return await waitFor(probe, timeoutMs, stepMs);
  } catch {
    return null;
  }
};

const q = <T extends Element>(selector: string) => document.querySelector<T>(selector);
const qa = <T extends Element>(selector: string) => Array.from(document.querySelectorAll<T>(selector));

const CATEGORY_KEYS = ["trend", "momentum", "volatility", "volume", "stat", "breadth"] as const;

/**
 * 分类懒挂载：目录重挂载后 manifest 要重新拉，分类开关在 manifest 到位前不存在。
 * 旧实现直接点开关 → manifest 未到时点空 → 后续等 T06 行超时（W-119：套件跑不完）。
 * 现在先等 manifest 就绪（分类开关出现）再逐类展开。
 */
const expandAllCategories = async () => {
  await waitFor(
    () => q('[data-catalog-cat-toggle="trend"]'),
    DOM_WAIT_MS,
    50,
    "目录 manifest 就绪（分类开关出现）",
  );
  for (const key of CATEGORY_KEYS) {
    const toggle = q<HTMLElement>(`[data-catalog-cat-toggle="${key}"]`);
    if (!toggle) continue;
    if (toggle.getAttribute("aria-expanded") !== "true") {
      toggle.click();
      await sleep(80);
    }
  }
  await waitFor(() => q('[data-catalog-item="T06"]'), DOM_WAIT_MS, 50, "分类展开后 T06 行出现");
};

const gotoHash = async (hash: string, selector: string, label: string) => {
  window.location.hash = hash;
  await waitFor(() => q(selector), DOM_WAIT_MS, 50, label);
  await sleep(120);
};

/**
 * 目录页状态（last_code/收藏）来自挂载时读取，须先离开再回来才会重挂载。
 * 旧实现只等 `main`（行情页与目录页都有）→ React 把两次 hash 变更合批后
 * 目录页其实没卸载/重挂载，last_code 仍是旧值 → 后续点击 disabled → 等状态超时。
 * 现在等「目录根真的消失」再回来，等价于确认卸载 → 再等 manifest 就绪。
 */
const remountCatalog = async () => {
  window.location.hash = "#/market";
  await waitFor(
    () => (q("[data-catalog-root='p3']") === null ? "unmounted" : null),
    DOM_WAIT_MS,
    50,
    "目录页卸载（离开 #/catalog）",
  );
  await sleep(120);
  await gotoHash("#/catalog", "[data-catalog-root='p3']", "目录页重挂载");
  await waitFor(
    () => q('[data-catalog-cat-toggle="trend"]'),
    DOM_WAIT_MS,
    50,
    "目录 manifest 就绪（重挂载后）",
  );
  await sleep(120);
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

/**
 * W-118：取证套件异常中断时落一份可诊断的失败 dump，避免「零产物 + 240s 空等」。
 * 文件名与成功证据一致：diag-evidence.sh 的等待循环见到新文件即结束；
 * ok:false / error / blocked[] 由 verify:evidence 第 31 条判为失败记录（不计份数、不可签）。
 * 只在 runner 抛错的 catch 路径调用，正常证据仍由各 runner 自己 writeBatchReport 落盘。
 *
 * W-119：partialChecks 让失败 dump 保留「已跑完那几条 check」，否则失败记录里
 * checks[] 恒为空，无法判断套件是「一开始就卡住」还是「跑到一半卡住」。
 */
export async function writeDiagnosticFailure(
  name: string,
  suite: string,
  err: unknown,
  partialChecks: Check[] = [],
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const reason = `套件异常中断：${message}`;
  // 构建期 define（vite-env.d.ts 全局声明）；拿不到时留空，不因诊断路径再抛错。
  const commit = typeof __AKA_BUILD_COMMIT__ === "string" ? __AKA_BUILD_COMMIT__ : "";
  const dump = {
    suite,
    ok: false,
    error: reason,
    commit,
    finishedAt: new Date().toISOString(),
    checks: partialChecks,
    blocked: [{ ac: "suite-runner", blocker: `run-${suite}`, reason, skipped: false }],
  };
  await ipc.diagWriteNamed(name, JSON.stringify(dump, null, 2));
}

/**
 * W-119：套件兜底包装。
 * runner 中途抛错时由 runner 自己落失败 dump（带已完成的 checks），并**不再向上抛**：
 * 宿主层（CatalogPage / WorkbenchPage）的 catch 会再写一份同名空 dump 覆盖掉这份，
 * 造成「checks[] 为空、看不出卡点」。返回 false 表示套件未跑完，调用方不要再写成功证据。
 */
const runSuite = async (
  name: string,
  suite: string,
  report: { checks: Check[] },
  body: () => Promise<void>,
  onFailure?: (report: { checks: Check[] }) => void,
): Promise<boolean> => {
  try {
    await body();
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${suite}.diag] 套件异常中断：${message}`);
    // 失败前先把「已观测到的结论」写进 checks，失败 dump 才看得出跑到哪一步。
    try {
      onFailure?.(report);
    } catch {
      // 观测回调自身出错不掩盖原始异常
    }
    await writeDiagnosticFailure(name, suite, err, report.checks).catch(() => undefined);
    return false;
  }
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

  // W-119：runner 自己兜底落失败 dump（带已完成 checks），不再向上抛 ——
  // 宿主层 catch 会写同名空 dump 覆盖它，反而丢掉卡点线索。
  const completed = await runSuite("s030104-evidence.json", "s030104", report, async () => {
    // 阶段 1：无标的（App 已清 aka.last.code）
    await waitFor(() => q("[data-catalog-root='p3']"), DOM_WAIT_MS, 50, "目录页根出现（阶段 1）");
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

    // 补2 卡面口径是「点任意 sub 指标」→ 用 status=normal 的副图指标 M02（KDJ）。
    // 不能用 M03：M03 是 planned 指标，卡面「异常与边界」与补4 要求规划项一律给
    // 「该指标规划中，本期未开放」，规划项优先于容量提示（产品既有语义，不改产品）。
    // 上轮 runner 用 M03 判「副图已满」→ 断言口径与卡面/产品都不一致，判红属 runner 缺陷。
    const m02Add = q<HTMLButtonElement>('[data-catalog-add="M02"]');
    const subBeforeFull = readSubPlots().join(",");
    push(
      "P01-R2",
      "AC-03.01-05（补2）",
      "render",
      countState("M02") === "full" &&
        m02Add?.disabled === true &&
        m02Add?.title === "副图已满（3/3），请先移除一个" &&
        rowHint("M02") === "副图已满（3/3），请先移除一个" &&
        readSubPlots().length === 3 &&
        readSubPlots().join(",") === subBeforeFull,
      `M02 状态=${countState("M02")} disabled=${m02Add?.disabled} title=「${m02Add?.title ?? ""}」/ 提示「${rowHint("M02")}」/ 副图 ${readSubPlots().join(",")}`,
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

    // 阶段 3：留出副图空位后加入。
    // 卡面 AC-03.01-05 原文：last_code=600519.SH、副图已有 2 个、当前为 OBV（panel=sub）
    // → 点「加入图表」→ OBV 出现在工作台副图第 3 格、目录按钮变「已加入」。
    // 上轮用 M03（planned）做这一步 → 规划项本就不可加入，等「按钮转 added」必然超时。
    writeSubPlots(["VOL", "M06"]);
    await remountCatalog();
    await expandAllCategories();
    const obvBefore = readSubPlots().join(",");
    q<HTMLButtonElement>('[data-catalog-add="D01"]')?.click();
    await waitFor(
      () => (countState("D01") === "added" ? "1" : null),
      DOM_WAIT_MS,
      50,
      "加入 OBV（D01）后按钮状态转 added",
    );
    const obvAfter = readSubPlots().filter((id) => id === "D01").length;
    const obvButton = q<HTMLElement>('[data-catalog-add="D01"]');
    push(
      "P01-R5",
      "AC-03.01-05",
      "render",
      obvAfter === 1 &&
        !obvBefore.split(",").includes("D01") &&
        readSubPlots().length === 3 &&
        readSubPlots()[2] === "D01" &&
        obvButton?.textContent?.includes("已加入") === true &&
        q('[data-catalog-view-workbench="D01"]') !== null,
      `加入前副图 ${obvBefore} / 加入后副图 ${readSubPlots().join(",")} / OBV=${obvAfter} 次 / 按钮「${obvButton?.textContent?.trim() ?? ""}」/ 在工作台查看=${q('[data-catalog-view-workbench="D01"]') !== null} / manifest ${manifest.indicators.length} 条`,
    );

    // 补4 的副图侧：planned 指标（M03，panel=副）在副图满时仍只给规划中提示、无添加动作。
    // 与 T06（panel=主）一起把「规划项优先于容量提示」这条卡面规则钉住。
    const subBeforePlanned = readSubPlots().join(",");
    const m03Add = q<HTMLButtonElement>('[data-catalog-add="M03"]');
    m03Add?.click();
    await sleep(120);
    const m03Hint = q<HTMLElement>("[data-catalog-detail-hint], [data-fav-hint]")?.textContent?.trim() ?? "";
    push(
      "P01-R6",
      "AC-03.01-05（补4）",
      "render",
      countState("M03") === "planned" &&
        m03Add?.getAttribute("aria-disabled") === "true" &&
        m03Hint.includes("该指标规划中，本期未开放") &&
        readSubPlots().join(",") === subBeforePlanned,
      `M03 状态=${countState("M03")} aria-disabled=${m03Add?.getAttribute("aria-disabled")} 提示「${m03Hint}」/ 副图未变=${readSubPlots().join(",") === subBeforePlanned}`,
    );

    // 复原默认副图，避免影响后续套件
    writeSubPlots(["VOL", "M06", "M01"]);
  });
  if (!completed) return report;
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

  // W-119：runner 自己兜底落失败 dump（带已完成 checks），不再向上抛 ——
  // 宿主层 catch 会写同名空 dump 覆盖它，反而丢掉卡点线索。
  const completed = await runSuite("s030201-favorites-evidence.json", "s030201", report, async () => {
    await waitFor(() => q("[data-catalog-root='p3']"), DOM_WAIT_MS, 50, "目录页根出现（收藏区）");
    await waitFor(() => q("[data-fav-strip]"), DOM_WAIT_MS, 50, "收藏条出现");
    await waitFor(
      () => (qa("[data-fav-chip]").length === 8 ? "8" : null),
      DOM_WAIT_MS,
      50,
      "默认 8 项收藏 chip 就位",
    );

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

    // 星标添加：M03 不在默认集；添加后应排在最前，再取消恢复。
    // 前置补齐（根因）：目录按分类懒挂载行，默认只展开「趋势」，M03 属「动量」→
    // 未展开时 [data-fav-star="M03"] 根本不在 DOM 里，点了个空元素 → 收藏没写入 →
    // 等「chip 重排（首位）」必然 20s 超时，套件异常中断。
    await expandAllCategories();
    await waitFor(
      () => (q('[data-fav-star="M03"]') ? "star" : null),
      DOM_WAIT_MS,
      50,
      "M03 星标按钮就位（动量分类已展开）",
    );
    const m03StarBefore = q<HTMLElement>('[data-fav-star="M03"]')?.getAttribute("aria-pressed");
    q<HTMLElement>('[data-fav-star="M03"]')?.click();
    await waitFor(
      () => (chipIds()[0] === "M03" ? "1" : null),
      DOM_WAIT_MS,
      50,
      "星标 M03 后收藏 chip 重排（首位）",
    );
    const afterAdd = chipIds();
    const m03First = afterAdd[0] === "M03" && afterAdd.filter((id) => id === "M03").length === 1;
    const m03StarAfter = q<HTMLElement>('[data-fav-star="M03"]')?.getAttribute("aria-pressed");
    push(
      "P02-R2",
      "AC-03.02-02",
      "render",
      m03StarBefore === "false" && m03First && afterAdd.length === 9 && m03StarAfter === "true",
      `M03 星标前 aria-pressed=${m03StarBefore} / 添加后序列 ${afterAdd.join(",")} / M03 首项且唯一=${m03First} / 星标后 aria-pressed=${m03StarAfter}`,
    );
    push(
      "P02-R3",
      "AC-03.02-02（补1）",
      "render",
      afterAdd[0] === "M03",
      `新收藏排在最前：首项 ${afterAdd[0] ?? "—"}`,
    );
    q<HTMLElement>('[data-fav-star="M03"]')?.click();
    await waitFor(
      () => (chipIds().length === 8 ? "8" : null),
      DOM_WAIT_MS,
      50,
      "取消 M03 后收藏回到 8 项",
    );

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
    await waitFor(() => q('[data-fav-chip="T06"]'), DOM_WAIT_MS, 50, "规划项 T06 收藏 chip 出现");
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

  });
  if (!completed) return report;
  await writeBatchReport("s030201-favorites-evidence.json", "s030201", report);
  return report;
}

/** P03：图例「?」、抽屉来源、目录深链与返回态（目录来源部分）。 */
export async function runS030302CatalogDiagnostics() {
  const report = { ...baseReport("s030302-catalog"), card: "S-03.03-02" };
  const push = (id: string, ac: string, layer: Check["layer"], passed: boolean, detail: string) => {
    report.checks.push({ id, card: "S-03.03-02", ac, layer, passed, detail });
  };
  // W-119：runner 自己兜底落失败 dump（带已完成 checks），不再向上抛 ——
  // 宿主层 catch 会写同名空 dump 覆盖它，反而丢掉卡点线索。
  const completed = await runSuite("s030302-catalog-evidence.json", "s030302-catalog", report, async () => {
    await waitFor(() => q("[data-catalog-root='p3']"), DOM_WAIT_MS, 50, "目录页根出现（深链来源）");
    await expandAllCategories();

    const firstToggle = q<HTMLElement>('[data-catalog-cat-toggle="trend"]');
    if (firstToggle?.getAttribute("aria-expanded") === "true") {
      firstToggle.click();
      await sleep(80);
    }
    q<HTMLElement>('[data-catalog-open-detail="M06"]')?.click();
    await waitFor(
      () => q("[data-catalog-breadcrumb-current='M06']"),
      DOM_WAIT_MS,
      50,
      "目录深链面包屑当前项 M06",
    );
    const crumb = q<HTMLElement>("[data-catalog-breadcrumb]")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    push(
      "P03-R1",
      "AC-03.03-03",
      "render",
      crumb.includes("指标目录") && crumb.includes("MACD") && window.location.hash.includes("#/catalog/M06"),
      `目录来源面包屑「${crumb}」/ hash ${window.location.hash}`,
    );

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => q("[data-catalog-root='p3']"), DOM_WAIT_MS, 50, "Esc 返回目录列表");
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

  });
  if (!completed) return report;
  await writeBatchReport("s030302-catalog-evidence.json", "s030302-catalog", report);
  return report;
}

/** P03：工作台图例「?」→ P4 → 返回，副图/视口保持；抽屉来源面包屑与抽屉恢复。 */
export async function runS030302WorkbenchDiagnostics() {
  const report = { ...baseReport("s030302"), card: "S-03.03-02" };
  const push = (id: string, ac: string, layer: Check["layer"], passed: boolean, detail: string) => {
    report.checks.push({ id, card: "S-03.03-02", ac, layer, passed, detail });
  };

  // W-119：runner 自己兜底落失败 dump（带已完成 checks），不再向上抛 ——
  // 宿主层 catch 会写同名空 dump 覆盖它，反而丢掉卡点线索。
  const completed = await runSuite("s030302-evidence.json", "s030302", report, async () => {
    // W-119：取证前置准备（幂等 UI 动作，runner 内做，不改产品语义）：
    //  1) 副图组合写回本地设置 + 重挂载工作台 —— 图例「?」依赖 M06 在上图；
    //  2) 切标的到 600519.SH —— 卡面要求面包屑带 600519.SH，工作台默认标的是 300750.SZ。
    // 旧实现既没切标的、也没等图表就绪，8s 超时 → runner 抛错 → 宿主只 console.error
    // → 240 秒零 dump（不可判）。现在先把状态备齐，再等图例 DOM。
    writeSubPlots(["VOL", "M06", "M01"]);
    window.localStorage.setItem("aka.last.code", "600519.SH");
    window.location.hash = "#/market";
    await waitFor(
      () => (q("[data-workbench-root]") === null ? "unmounted" : null),
      DOM_WAIT_MS,
      50,
      "工作台卸载（离开 #/workbench）",
    );
    window.location.hash = "#/workbench/600519.SH";
    await waitFor(
      () => q<HTMLElement>('[data-quote-head="1"][data-quote-code="600519.SH"]'),
      CHART_WAIT_MS,
      50,
      "工作台报价头切到 600519.SH",
    );
    const help = await waitFor(
      () => q<SVGGElement>('[data-legend-help="M06"]'),
      CHART_WAIT_MS,
      50,
      "工作台 M06 图例「?」出现（副图已上图、图表已绘制）",
    );
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
    await waitFor(
      () => q("[data-catalog-breadcrumb-from='chart']"),
      DOM_WAIT_MS,
      50,
      "图例来源目录深链打开",
    );
    const crumb = q<HTMLElement>("[data-catalog-breadcrumb]")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    push(
      "P03-R4",
      "AC-03.03-03（补1）",
      "render",
      crumb.includes("工作台") && crumb.includes("600519.SH") && crumb.includes("MACD"),
      `图例来源面包屑「${crumb}」/ hash ${window.location.hash}`,
    );

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => q("[data-workbench-root]"), DOM_WAIT_MS, 50, "Esc 返回工作台");
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
    await waitFor(() => q("[data-drawer-body]"), DOM_WAIT_MS, 50, "指标抽屉打开");
    q<HTMLElement>('[data-fav-chip-detail="M06"]')?.click();
    await waitFor(
      () => q("[data-catalog-breadcrumb-from='drawer']"),
      DOM_WAIT_MS,
      50,
      "抽屉来源目录深链打开",
    );
    const drawerCrumb = q<HTMLElement>("[data-catalog-breadcrumb]")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    push(
      "P03-R6",
      "AC-03.03-03（补2）",
      "render",
      drawerCrumb.includes("工作台") && drawerCrumb.includes("600519.SH") && drawerCrumb.includes("MACD"),
      `抽屉来源面包屑「${drawerCrumb}」`,
    );

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => q("[data-workbench-root]"), DOM_WAIT_MS, 50, "Esc 返回工作台（抽屉来源）");
    const drawerRestored = await waitFor(() => q("[data-drawer-body]"), 8_000).catch(() => null);
    push(
      "P03-R7",
      "AC-03.03-03（补2）",
      "render",
      drawerRestored !== null,
      `Esc 返回工作台后抽屉恢复=${drawerRestored !== null}`,
    );
    q<HTMLElement>("[data-drawer-close]")?.click();

  });
  if (!completed) return report;
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
 * W-119：S-05.01-01 ⌘K 唤起 / 代码名称拼音匹配 / 排序 —— 卡面 6 条 AC 各挂一条可判 check。
 *
 * 卡面 6 条 AC：AC-05.01-01、AC-05.01-01（补1）/（补2）/（补3）/（补4）、AC-05.01-04。
 * 上轮只产出 2 条 check（基条 + AC-05.01-04），其余 4 条零覆盖 → QA G4 判「缺证不足签」。
 *
 * 判定口径（每条都能因产品回退而红，不做恒真/宽松匹配）：
 *  - 基条：真实 ⌘K keydown 唤起（不用内部事件，否则快捷键接线断了也判绿）+ 输入框自动聚焦
 *    + 三种输入（300750 / 宁德 / ndsd）都命中 300750.SZ 且为首位 + 结果行含代码/名称/板块/模拟标签
 *    （与数据层 securities 逐字段比对，不做「非空即通过」）+ 本地索引查询 P95 ≤100ms（V-07 口径）。
 *  - 补1：`300750.SZ` 与 `300750.sz` 结果集完全相同（大小写不敏感）。
 *  - 补2：命中 >20 的查询只渲染 20 条 + 列表底部显示「仅显示前 20 条」+ 首条 = 数据层成交额最大者。
 *  - 补3：停牌标的行可见 + 标「停牌」+ 涨跌幅「—」。
 *  - 补4：`/` 与三个空格 → 无运行期异常、无结果、无 toast、输入框保留内容。
 *  - AC-05.01-04：搜索期间 0 外部 http(s) 请求（增量与累计都为 0）。
 */
interface S050101Observed {
  overlayOpened: boolean;
  inputFocused: boolean;
  codeHit: boolean;
  nameHit: boolean;
  pinyinHit: boolean;
  rowHasCode: boolean;
  rowHasName: boolean;
  rowHasBoard: boolean;
  rowHasSimTag: boolean;
  queryP95Ok: boolean;
  externalZero: boolean;
  suffixSameResult: boolean;
  cappedAt20: boolean;
  truncatedNotice: boolean;
  firstIsMaxAmount: boolean;
  suspendedRowVisible: boolean;
  suspendedTagShown: boolean;
  suspendedChangeDash: boolean;
  slashNoResult: boolean;
  slashKeepsInput: boolean;
  blankNoResult: boolean;
  blankKeepsInput: boolean;
  noToast: boolean;
  noRuntimeError: boolean;
}

const emptyS050101Observed = (): S050101Observed => ({
  overlayOpened: false,
  inputFocused: false,
  codeHit: false,
  nameHit: false,
  pinyinHit: false,
  rowHasCode: false,
  rowHasName: false,
  rowHasBoard: false,
  rowHasSimTag: false,
  queryP95Ok: false,
  externalZero: false,
  suffixSameResult: false,
  cappedAt20: false,
  truncatedNotice: false,
  firstIsMaxAmount: false,
  suspendedRowVisible: false,
  suspendedTagShown: false,
  suspendedChangeDash: false,
  slashNoResult: false,
  slashKeepsInput: false,
  blankNoResult: false,
  blankKeepsInput: false,
  noToast: false,
  noRuntimeError: false,
});

export async function runS050101Diagnostics() {
  const report = { ...baseReport("s050101"), card: "S-05.01-01", blocked: [] as Array<{ ac: string; blocker: string; reason: string; skipped: boolean }> };
  const push = (id: string, ac: string, layer: Check["layer"], passed: boolean, detail: string) => {
    report.checks.push({ id, card: "S-05.01-01", ac, layer, passed, detail });
  };
  const obs = emptyS050101Observed();
  const notes: Record<string, string> = {};

  /** 6 条 check 只在观测完成后落一次；失败路径由 runSuite 的 onFailure 复用同一函数。 */
  const pushChecks = () => {
    if (report.checks.length > 0) return;
    push(
      "S050101-R1",
      "AC-05.01-01",
      "render",
      obs.overlayOpened &&
        obs.inputFocused &&
        obs.codeHit &&
        obs.nameHit &&
        obs.pinyinHit &&
        obs.rowHasCode &&
        obs.rowHasName &&
        obs.rowHasBoard &&
        obs.rowHasSimTag &&
        obs.queryP95Ok,
      `⌘K 唤起=${obs.overlayOpened} / 输入框聚焦=${obs.inputFocused} / 代码·名称·拼音命中=${obs.codeHit}·${obs.nameHit}·${obs.pinyinHit} / 行含代码·名称·板块·模拟=${obs.rowHasCode}·${obs.rowHasName}·${obs.rowHasBoard}·${obs.rowHasSimTag} / 查询 P95=${notes.p95 ?? "未测"}ms（V-07 口径：本地索引查询，预热 5 次后取 30 次 P95，${notes.buildKind ?? "取证构建"}）`,
    );
    push(
      "S050101-R2",
      "AC-05.01-04",
      "runtime",
      obs.externalZero,
      `搜索期间外部 http(s) 资源：增量 ${notes.externalDelta ?? "?"} 个 / 累计 ${notes.externalTotal ?? "?"} 个`,
    );
    push(
      "S050101-R3",
      "AC-05.01-01（补1）",
      "render",
      obs.suffixSameResult,
      `300750.SZ → ${notes.suffixUpper ?? "未观测"} / 300750.sz → ${notes.suffixLower ?? "未观测"}`,
    );
    push(
      "S050101-R4",
      "AC-05.01-01（补2）",
      "render",
      obs.cappedAt20 && obs.truncatedNotice && obs.firstIsMaxAmount,
      `查询「${notes.cappedQuery ?? "示例"}」命中 ${notes.cappedMatched ?? "?"} 只 / 渲染 ${notes.cappedRendered ?? "?"} 条 / 底部提示「${notes.truncatedText ?? "无"}」/ 首条 ${notes.cappedFirst ?? "无"}（数据层成交额最大者 ${notes.cappedMaxAmount ?? "?"}）`,
    );
    push(
      "S050101-R5",
      "AC-05.01-01（补3）",
      "render",
      obs.suspendedRowVisible && obs.suspendedTagShown && obs.suspendedChangeDash,
      notes.suspendedDetail ?? "未观测到停牌标的",
    );
    push(
      "S050101-R6",
      "AC-05.01-01（补4）",
      "render",
      obs.slashNoResult &&
        obs.slashKeepsInput &&
        obs.blankNoResult &&
        obs.blankKeepsInput &&
        obs.noToast &&
        obs.noRuntimeError,
      `「/」结果 ${notes.slashHits ?? "?"} 条 / 输入保留「${notes.slashInput ?? "?"}」/ 三空格结果 ${notes.blankHits ?? "?"} 条 / 输入保留「${notes.blankInput ?? "?"}」/ toast=${obs.noToast ? "无" : "有"} / 运行期异常 ${notes.runtimeErrors ?? "0"} 条`,
    );
  };

  const completed = await runSuite(
    "s050101-evidence.json",
    "s050101",
    report,
    async () => {
      // 补4 要求「无异常」：先挂运行期异常监听。
      const runtimeErrors: string[] = [];
      const onError = (event: ErrorEvent) => runtimeErrors.push(event.message || "error");
      const onReject = (event: PromiseRejectionEvent) => runtimeErrors.push(String(event.reason));
      window.addEventListener("error", onError);
      window.addEventListener("unhandledrejection", onReject);
      try {
        // 1) 真实 ⌘K 唤起（卡面「任意页面按 ⌘K」）：用内部事件唤起会让快捷键接线断了也判绿。
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
        const overlay = await waitFor(
          () => q("[data-search-overlay]"),
          DOM_WAIT_MS,
          50,
          "⌘K 唤起搜索浮层",
        );
        obs.overlayOpened = Boolean(overlay);
        // 索引构建 ≤300ms 契约：输入框可用即索引就绪。
        const input = await waitFor(
          () => {
            const el = q<HTMLInputElement>("[data-search-input]");
            return el && !el.disabled ? el : null;
          },
          DOM_WAIT_MS,
          50,
          "搜索索引就绪（输入框可用）",
        );
        obs.inputFocused =
          (await tryWait(() => (document.activeElement === input ? "focused" : null), 5_000, 50)) !== null;

        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        const inputOf = () => q<HTMLInputElement>("[data-search-input]");
        const query = async (text: string): Promise<string[]> => {
          const el = inputOf();
          if (!el || !setter) return [];
          setter.call(el, text);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          await sleep(160); // 60ms 防抖 + 渲染余量
          return qa<HTMLElement>("[data-search-result]").map((row) => row.dataset.searchResult ?? "");
        };
        const rowText = (code: string) =>
          q<HTMLElement>(`[data-search-result="${code}"]`)?.textContent?.replace(/\s+/g, " ").trim() ?? "";

        const externalBefore = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter((name) => /^https?:\/\//.test(name)).length;

        // 2) 基条：三种输入都命中同一标的，且为首位。
        const byCode = await query("300750");
        const byName = await query("宁德");
        const byPinyin = await query("ndsd");
        obs.codeHit = byCode[0] === "300750.SZ";
        obs.nameHit = byName[0] === "300750.SZ";
        obs.pinyinHit = byPinyin[0] === "300750.SZ";

        // 3) 结果行字段：与数据层 securities 逐字段比对（非空即通过 = 宽松断言）。
        const securities = await ipc.listSecurities();
        const snapshot = await ipc.marketSnapshot();
        const target = securities.find((item) => item.code === "300750.SZ");
        const targetRow = rowText("300750.SZ");
        obs.rowHasCode = targetRow.includes("300750.SZ");
        obs.rowHasName = target !== undefined && targetRow.includes(target.name);
        obs.rowHasBoard = target !== undefined && target.board !== "" && targetRow.includes(target.board);
        obs.rowHasSimTag = targetRow.includes("模拟");

        // 4) V-07 性能口径：预热后 30 次取 P95 ≤100ms（本套件测「本地索引查询」这一段，
        //    不含 60ms 输入防抖；Release 复测由 BA 在 release 产物上补，口径写进 detail）。
        const index = buildSearchIndex(securities, snapshot.rows);
        const runQuery = () => matchSecurities(index, "300750");
        for (let i = 0; i < 5; i += 1) runQuery();
        const samples: number[] = [];
        for (let i = 0; i < 30; i += 1) {
          const started = performance.now();
          runQuery();
          samples.push(performance.now() - started);
        }
        samples.sort((a, b) => a - b);
        const p95 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)];
        notes.p95 = p95.toFixed(3);
        notes.buildKind = import.meta.env.DEV ? "dev 构建（Release 复测待 BA 补）" : "release 构建";
        obs.queryP95Ok = p95 <= 100;

        // 5) AC-05.01-04：0 外部请求（增量 + 累计）。
        const externalAfter = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter((name) => /^https?:\/\//.test(name));
        notes.externalDelta = String(externalAfter.length - externalBefore);
        notes.externalTotal = String(externalAfter.length);
        obs.externalZero = externalAfter.length - externalBefore === 0 && externalAfter.length === 0;

        // 6) 补1：带后缀与全小写后缀结果集完全相同。
        const bySuffixUpper = await query("300750.SZ");
        const bySuffixLower = await query("300750.sz");
        notes.suffixUpper = bySuffixUpper.join(",") || "无结果";
        notes.suffixLower = bySuffixLower.join(",") || "无结果";
        obs.suffixSameResult =
          bySuffixUpper.join(",") === bySuffixLower.join(",") && bySuffixUpper.includes("300750.SZ");

        // 7) 补2：命中 >20 的查询只渲染 20 条 + 底部「仅显示前 20 条」+ 首条成交额最大。
        //    卡面举例「a（命中 25 只）」在当前样本不可复现（拼音首字母只预置 14 只已知标的，
        //    生成标的名为「示例标的 NNN」→ 「a」命中 0 只），改用同口径可复现查询「示例」。
        const cappedQuery = "示例";
        const cappedCodes = await query(cappedQuery);
        const matchedRows = snapshot.rows.filter((row) => row.name.startsWith(cappedQuery));
        notes.cappedQuery = cappedQuery;
        notes.cappedMatched = String(matchedRows.length);
        notes.cappedRendered = String(cappedCodes.length);
        notes.truncatedText = (q("[data-search-truncated]")?.textContent ?? "").trim() || "无";
        const maxAmount = matchedRows.reduce((max, row) => Math.max(max, row.amount ?? -1), -1);
        const maxAmountCodes = matchedRows
          .filter((row) => (row.amount ?? -1) === maxAmount)
          .map((row) => row.security);
        notes.cappedMaxAmount = `${maxAmount}（${maxAmountCodes.join("/")}）`;
        notes.cappedFirst = cappedCodes[0] ?? "无";
        obs.cappedAt20 = cappedCodes.length === 20 && matchedRows.length > 20;
        obs.truncatedNotice = notes.truncatedText === "仅显示前 20 条";
        obs.firstIsMaxAmount = maxAmountCodes.includes(cappedCodes[0] ?? "");

        // 8) 补3：停牌标的行可见 + 「停牌」+ 涨跌幅「—」（停牌样本由取证注入提供）。
        const suspendedRows = snapshot.rows.filter((row) => row.suspended);
        if (suspendedRows.length > 0) {
          const suspendedCode = suspendedRows[0].security;
          const suspendedHits = await query(suspendedCode);
          const suspendedRow = q<HTMLElement>(`[data-search-result="${suspendedCode}"]`);
          const suspendedPct = (suspendedRow?.querySelector(".search-row-pct")?.textContent ?? "").trim();
          obs.suspendedRowVisible = suspendedHits.includes(suspendedCode) && suspendedRow !== null;
          obs.suspendedTagShown = (suspendedRow?.textContent ?? "").includes("停牌");
          obs.suspendedChangeDash = suspendedPct === "—";
          notes.suspendedDetail = `停牌标的 ${suspendedCode}：命中=${obs.suspendedRowVisible} / 「停牌」标签=${obs.suspendedTagShown} / 涨跌幅=「${suspendedPct}」`;
        } else {
          notes.suspendedDetail = "样本内无停牌标的（取证注入未生效）";
          report.blocked.push({
            ac: "AC-05.01-01（补3）",
            blocker: "sample-no-suspended",
            reason: "当前样本 120 只无停牌标的，该 AC 需在注入停牌样本的取证环境下重判",
            skipped: true,
          });
        }

        // 9) 补4：`/` 与三个空格 → 无异常、无结果、无 toast、输入保留。
        const slashHits = await query("/");
        obs.slashNoResult = slashHits.length === 0;
        obs.slashKeepsInput = (inputOf()?.value ?? "") === "/";
        notes.slashHits = String(slashHits.length);
        notes.slashInput = inputOf()?.value ?? "";
        const blankHits = await query("   ");
        obs.blankNoResult = blankHits.length === 0;
        obs.blankKeepsInput = (inputOf()?.value ?? "") === "   ";
        notes.blankHits = String(blankHits.length);
        notes.blankInput = inputOf()?.value ?? "";
        obs.noToast = q(".market-toast, .toast") === null;
        obs.noRuntimeError = runtimeErrors.length === 0;
        notes.runtimeErrors = String(runtimeErrors.length);
      } finally {
        window.removeEventListener("error", onError);
        window.removeEventListener("unhandledrejection", onReject);
      }
    },
    pushChecks,
  );

  pushChecks();
  if (!completed) return report;
  await writeBatchReport("s050101-evidence.json", "s050101", report);
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

/**
 * P15：S-05.01-02 键盘操作 / 无结果 / 最近查看 取证套件。
 *
 * 与 P14 的 runS050101Diagnostics 同构：产品实现（SearchOverlay.tsx 的键盘、
 * 无结果、最近查看与指数快捷入口）已随 W-100 进入 main，本卡补齐 s050102
 * 套件入口与卡面 7 条 AC 的断言，为 BA 运行层取证清障（§5.8 L260）。
 * dev 只写入口与断言，不自出运行层证据。
 *
 * 每条判定表达式集中引用 obs（DOM 采集的只读观察量），由 verify_s050102.mjs
 * 从本函数派生后注入正例/反例/变异验证（制度第 29 条）：断言必须能判红。
 */
interface S050102Observed {
  downSelectedSecond: boolean;
  enterOpenedSecond: boolean;
  escClearedInput: boolean;
  upAtFirstStaysFirst: boolean;
  escClosedOverlay: boolean;
  reopenInputEmpty: boolean;
  reopenShowsRecent: boolean;
  shortcutCount: number;
  hasRecentPlaceholder: boolean;
  queryPreserved: boolean;
  notFoundShown: boolean;
  clearActionShown: boolean;
  marketActionShown: boolean;
  noSkeleton: boolean;
  noIrrelevantResults: boolean;
  emptyEnterOverlayOpen: boolean;
  emptyEnterInputUnchanged: boolean;
  emptyEnterNoOpen: boolean;
  clearInputEmpty: boolean;
  clearBackToIdleRecent: boolean;
  clearBackToIdleShortcut: boolean;
}

const emptyS050102Observed = (): S050102Observed => ({
  downSelectedSecond: false,
  enterOpenedSecond: false,
  escClearedInput: false,
  upAtFirstStaysFirst: false,
  escClosedOverlay: false,
  reopenInputEmpty: false,
  reopenShowsRecent: false,
  shortcutCount: 0,
  hasRecentPlaceholder: true,
  queryPreserved: false,
  notFoundShown: false,
  clearActionShown: false,
  marketActionShown: false,
  noSkeleton: false,
  noIrrelevantResults: false,
  emptyEnterOverlayOpen: false,
  emptyEnterInputUnchanged: false,
  emptyEnterNoOpen: false,
  clearInputEmpty: false,
  clearBackToIdleRecent: false,
  clearBackToIdleShortcut: false,
});

export async function runS050102Diagnostics() {
  const report = { ...baseReport("s050102"), card: "S-05.01-02" };
  const push = (id: string, ac: string, layer: Check["layer"], passed: boolean, detail: string) => {
    report.checks.push({ id, card: "S-05.01-02", ac, layer, passed, detail });
  };

  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  const inputOf = () => q<HTMLInputElement>("[data-search-input]");
  const overlayPresent = () => Boolean(q("[data-search-overlay]"));
  const resultRows = () => qa<HTMLElement>("[data-search-result]");
  const activeIndex = () => resultRows().findIndex((row) => row.getAttribute("aria-selected") === "true");
  const inputValue = () => inputOf()?.value ?? "";
  const typeInto = async (text: string) => {
    const input = inputOf();
    if (input && setter) {
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await sleep(160);
  };
  const pressKey = async (key: string) => {
    const input = inputOf();
    if (input) input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    await sleep(90);
  };
  const reopen = async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(60);
    window.dispatchEvent(new CustomEvent("aka:search-open"));
    await waitFor(() => q("[data-search-overlay]"));
    await sleep(160);
  };

  const obs = emptyS050102Observed();

  // 场景 A（AC-05.01-02 / 补1 / 补2）：唤起 → 输入出 ≥2 结果 → ↓/↑/Enter → Esc → 再唤起。
  window.dispatchEvent(new CustomEvent("aka:search-open"));
  await waitFor(() => q("[data-search-overlay]"));
  await sleep(220);
  await typeInto("300");
  const rows = resultRows();
  const secondCode = rows[1]?.dataset.searchResult ?? "";
  await pressKey("ArrowDown");
  obs.downSelectedSecond = rows.length >= 2 && activeIndex() === 1;
  await pressKey("ArrowUp");
  await pressKey("ArrowUp");
  obs.upAtFirstStaysFirst = activeIndex() === 0;
  await pressKey("ArrowDown");
  await pressKey("Enter");
  await sleep(120);
  obs.enterOpenedSecond = secondCode !== "" && window.localStorage.getItem("aka.last.code") === secondCode;
  await pressKey("Escape");
  await sleep(90);
  obs.escClosedOverlay = !overlayPresent();
  await reopen();
  obs.escClearedInput = inputValue() === "";
  obs.reopenInputEmpty = inputValue() === "";
  obs.reopenShowsRecent = Boolean(q("[data-search-recent]"));

  // 场景 B（AC-05.01-02 补3）：新装无最近查看，只显示指数快捷入口（≤4），不出现「暂无记录」。
  const shortcuts = qa<HTMLElement>("[data-search-shortcut-item]");
  obs.shortcutCount = shortcuts.length;
  obs.hasRecentPlaceholder = Boolean(q("[data-search-recent-empty]"));

  // 场景 C（AC-05.01-03 / 补1 / 补2）：无结果态保留查询词、两动作、Enter 无动作、清空回空闲态。
  await reopen();
  await typeInto("zzzz");
  obs.queryPreserved = inputValue() === "zzzz";
  obs.notFoundShown = (q("[data-search-empty]")?.textContent ?? "").includes("未找到");
  obs.clearActionShown = Boolean(q("[data-search-empty] .search-link"));
  obs.marketActionShown = Boolean(q("[data-search-empty-market]"));
  obs.noSkeleton = !Boolean(q("[data-search-preparing]"));
  obs.noIrrelevantResults = resultRows().length === 0;
  const beforeEnter = inputValue();
  // 场景 A 的 Enter 已把 hash 推进 #/workbench/<code> 且不回退，
  // 故不能用「hash 不以 workbench 开头」判「未打开标的」（该观察恒假）。
  // 改用 Enter 前后两个独立运行时快照的差分：路由与最近打开标的均未变化。
  const hashBeforeEnter = window.location.hash;
  const lastCodeBeforeEnter = window.localStorage.getItem("aka.last.code");
  await pressKey("Enter");
  obs.emptyEnterOverlayOpen = overlayPresent();
  obs.emptyEnterInputUnchanged = inputValue() === beforeEnter;
  obs.emptyEnterNoOpen =
    window.location.hash === hashBeforeEnter &&
    window.localStorage.getItem("aka.last.code") === lastCodeBeforeEnter;
  const clearButton = q<HTMLElement>("[data-search-empty] .search-link");
  clearButton?.click();
  await sleep(120);
  obs.clearInputEmpty = inputValue() === "";
  obs.clearBackToIdleRecent = Boolean(q("[data-search-recent]"));
  obs.clearBackToIdleShortcut = Boolean(q("[data-search-index-shortcut]"));

  push(
    "S050102-R1",
    "AC-05.01-02",
    "render",
    obs.downSelectedSecond && obs.enterOpenedSecond && obs.escClearedInput,
    `↓ 选第二条=${obs.downSelectedSecond} / Enter 打开第二条=${obs.enterOpenedSecond} / Esc 清空=${obs.escClearedInput}`,
  );
  push(
    "S050102-R2",
    "AC-05.01-02（补1）",
    "render",
    obs.upAtFirstStaysFirst,
    `↑ 在首条不循环：activeIndex 仍为 0 = ${obs.upAtFirstStaysFirst}`,
  );
  push(
    "S050102-R3",
    "AC-05.01-02（补2）",
    "render",
    obs.escClearedInput && obs.escClosedOverlay && obs.reopenInputEmpty && obs.reopenShowsRecent,
    `Esc 关闭=${obs.escClosedOverlay} / 再唤起输入为空=${obs.reopenInputEmpty} / 显示最近查看=${obs.reopenShowsRecent}`,
  );
  push(
    "S050102-R4",
    "AC-05.01-02（补3）",
    "render",
    obs.shortcutCount > 0 && obs.shortcutCount <= 4 && !obs.hasRecentPlaceholder,
    `指数快捷入口 ${obs.shortcutCount} 个（≤4）/ 无「暂无记录」占位=${!obs.hasRecentPlaceholder}`,
  );
  push(
    "S050102-R5",
    "AC-05.01-03",
    "render",
    obs.queryPreserved && obs.notFoundShown && obs.clearActionShown && obs.marketActionShown && obs.noSkeleton && obs.noIrrelevantResults,
    `保留 zzzz=${obs.queryPreserved} / 未找到=${obs.notFoundShown} / 两动作=${obs.clearActionShown && obs.marketActionShown} / 无骨架=${obs.noSkeleton} / 无无关结果=${obs.noIrrelevantResults}`,
  );
  push(
    "S050102-R6",
    "AC-05.01-03（补1）",
    "render",
    obs.emptyEnterOverlayOpen && obs.emptyEnterInputUnchanged && obs.emptyEnterNoOpen,
    `无结果 Enter：浮层仍开=${obs.emptyEnterOverlayOpen} / 输入不变=${obs.emptyEnterInputUnchanged} / 未开标的=${obs.emptyEnterNoOpen}`,
  );
  push(
    "S050102-R7",
    "AC-05.01-03（补2）",
    "render",
    obs.clearInputEmpty && obs.clearBackToIdleRecent && obs.clearBackToIdleShortcut,
    `点清空：输入空=${obs.clearInputEmpty} / 回空闲态最近查看=${obs.clearBackToIdleRecent} / 指数入口=${obs.clearBackToIdleShortcut}`,
  );

  await writeBatchReport("s050102-evidence.json", "s050102", report);
  return report;
}
