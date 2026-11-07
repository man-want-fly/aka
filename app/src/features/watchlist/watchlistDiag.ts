import { describeError, ipc } from "../../lib/ipc";

/**
 * S-01.02-01/02/03 自选取证（R-EV-01 分层）。
 * 数据层：ipc.watchlist / watch_toggle / 分组 CRUD 的落库语义、单一归属、上限分支。
 * 渲染层：DOM 文案、aria-pressed、disabled、徽标、错误条、空态。
 *
 * 前置（由取证脚本负责，不在应用内）：
 * - 直接向 state.db 插入合成标的至 498 条，用于触达 500 上限与「不在数据集」行；
 * - 取证结束后脚本用备份还原 state.db（本轮所有删除/新增都会回滚）。
 * 无前置时 WL-10 / WL-13 / WL-14 / WL-17 记 blocked，不计入 ok。
 */

const PREFIX = "诊断";
const GROUP_A = `${PREFIX}组A`;
const GROUP_EMPTY = `${PREFIX}空组`;
const GROUP_LIMIT = `${PREFIX}上限`;
const TINY_CODE = "DIAG012.SZ"; // AKA_DIAG=1 注入的 12 根序列，< 20 判「数据不足」
const SEED_CODE = "SEED0000.SZ"; // 前置脚本直插 state.db 的合成标的（不在数据集）

let currentStage = "init";
const markStage = (stage: string) => {
  currentStage = stage;
  (window as unknown as { __akaWatchlistStage?: string }).__akaWatchlistStage = stage;
};
export const watchlistDiagStage = () => currentStage;

interface Check {
  id: string;
  ac: string;
  layer: "data" | "render";
  passed: boolean;
  blocked?: boolean;
  detail: string;
}

const q = <T extends Element>(selector: string) => document.querySelector<T>(selector);
const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

const waitFor = async <T,>(probe: () => T | null, timeoutMs = 6_000, stepMs = 50) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("等待超时");
    await sleep(stepMs);
  }
};

const setValue = (field: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
};

const buttonByText = (text: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
    (item) => item.textContent?.trim() === text,
  );

const groupTab = (name: string) => q<HTMLButtonElement>(`[data-wl-group="${name}"]`);
const refresh = () => window.dispatchEvent(new Event("aka:watchlist-refresh"));

const errorMessage = (err: unknown) => describeError(err).message;

async function ensureGroup(name: string) {
  const list = await ipc.watchlist();
  if (!list.groups.some((group) => group.name === name)) {
    await ipc.createWatchGroup(name);
  }
  refresh();
  await sleep(400);
  const data = await ipc.watchlist();
  const inDto = data.groups.some((group) => group.name === name);
  const tabs = Array.from(document.querySelectorAll("[data-wl-group]")).map((element) =>
    element.getAttribute("data-wl-group"),
  );
  try {
    await waitFor(() => groupTab(name), 6_000);
  } catch {
    throw new Error(
      `分组「${name}」在 DTO=${inDto}，DOM tabs=${tabs.join("|")}，readError=${q("[data-wl-read-error]")?.textContent ?? "无"}`,
    );
  }
}

async function ensureWatched(code: string, group?: string) {
  const list = await ipc.watchlist();
  const item = list.items.find((entry) => entry.security === code);
  if (!item) {
    await ipc.toggleWatch(code, group);
  } else if (group && item.groupName !== group) {
    await ipc.toggleWatch(code);
    await ipc.toggleWatch(code, group);
  }
  refresh();
  await sleep(300);
}

export async function runWatchlistDiagnostics() {
  const checks: Check[] = [];
  const push = (
    id: string,
    layer: Check["layer"],
    ac: string,
    passed: boolean,
    detail: string,
    blocked = false,
  ) => checks.push({ id, ac, layer, passed, detail, blocked });
  const block = (id: string, layer: Check["layer"], ac: string, detail: string) =>
    push(id, layer, ac, false, detail, true);

  markStage("settle");
  // Vite 启动时会对刚改动的文件触发一次 fast refresh，等 DOM 稳定再取证
  await waitFor(() => q("[data-wl-root]"), 10_000);
  await sleep(1_500);

  // ---- [数据层] 基线：内置「全部」为只读派生 ----
  markStage("baseline");
  const before = await ipc.watchlist();
  const allGroup = before.groups.find((group) => group.name === "全部");
  push(
    "WL-01",
    "data",
    "S-01.02-02",
    Boolean(allGroup?.isBuiltin) && allGroup?.count === before.total,
    `基线 total=${before.total}，全部=${allGroup?.count}（builtin=${allGroup?.isBuiltin}），分组 ${before.groups
      .map((group) => `${group.name}:${group.count}`)
      .join(" ")}`,
  );

  // ---- [渲染层] 某组为空态 ----
  markStage("create empty group");
  if (!groupTab(GROUP_EMPTY)) await ensureGroup(GROUP_EMPTY);
  groupTab(GROUP_EMPTY)?.click();
  await sleep(300);
  const tabSnapshot = () =>
    Array.from(document.querySelectorAll("[data-wl-group]"))
      .map((element) => `${element.getAttribute("data-wl-group")}:${element.getAttribute("aria-pressed")}`)
      .join("|");
  const emptySnapshot = () =>
    Array.from(document.querySelectorAll("[data-wl-empty]"))
      .map((element) => element.getAttribute("data-wl-empty"))
      .join("|");
  const emptyGroup = await waitFor(() => q<HTMLElement>("[data-wl-empty='group']"), 6_000).catch(() => {
    throw new Error(
      `空组态未出现：root=${Boolean(q("[data-wl-root]"))}，tabs=${tabSnapshot()}，empty=${emptySnapshot()}，body=${(document.body.textContent ?? "").replace(/\s+/g, " ").slice(0, 240)}`,
    );
  });
  const emptyGroupText = emptyGroup.textContent ?? "";
  push(
    "WL-02",
    "render",
    "S-01.02-03",
    emptyGroupText.includes("本组还没有标的") &&
      emptyGroupText.includes("去行情页加星") &&
      emptyGroupText.includes("换组"),
    `某组空态「${emptyGroupText.replace(/\s+/g, " ").trim()}」`,
  );

  // ---- [数据层] 建组 + [渲染层] 出现 tab ----
  markStage("create group A");
  if (!groupTab(GROUP_A)) await ensureGroup(GROUP_A);
  const afterCreate = await ipc.watchlist();
  push(
    "WL-03",
    "data",
    "S-01.02-02",
    afterCreate.groups.some((group) => group.name === GROUP_A) && Boolean(groupTab(GROUP_A)),
    `分组 ${GROUP_A} 落库且渲染 tab（自定义 ${afterCreate.groups.filter((group) => !group.isBuiltin).length} 个）`,
  );

  const nameInput = q<HTMLInputElement>("[data-wl-new-group]");
  if (!nameInput) throw new Error("找不到新建分组输入框");
  setValue(nameInput, "   ");
  await sleep(60);
  const blankError = q<HTMLElement>("[data-wl-name-error]")?.textContent ?? "";
  const blankSubmit = buttonByText("新建", nameInput.closest("form") ?? document);
  push(
    "WL-04",
    "render",
    "S-01.02-02",
    blankError.includes("分组名不能为空") && blankSubmit?.disabled === true,
    `空白名提示「${blankError}」，新建按钮 disabled=${blankSubmit?.disabled}`,
  );

  setValue(nameInput, GROUP_A);
  await sleep(60);
  const dupError = q<HTMLElement>("[data-wl-name-error]")?.textContent ?? "";
  const dupSubmit = buttonByText("新建", nameInput.closest("form") ?? document);
  const dupCount = (await ipc.watchlist()).groups.filter((group) => !group.isBuiltin).length;
  push(
    "WL-05",
    "render",
    "S-01.02-02",
    dupError.includes("已有同名分组") && dupSubmit?.disabled === true,
    `同名提示「${dupError}」，新建按钮 disabled=${dupSubmit?.disabled}，自定义组仍 ${dupCount} 个`,
  );
  setValue(nameInput, "");

  // ---- [渲染层] 内置组只读 ----
  markStage("builtin ops");
  groupTab("全部")?.click();
  await sleep(120);
  const builtinOps = q<HTMLElement>("[data-wl-builtin-ops]");
  const builtinButtons = builtinOps
    ? Array.from(builtinOps.querySelectorAll<HTMLButtonElement>("button"))
    : [];
  push(
    "WL-06",
    "render",
    "S-01.02-02",
    Boolean(builtinOps) &&
      builtinButtons.length === 2 &&
      builtinButtons.every((button) => button.disabled) &&
      (builtinOps?.textContent ?? "").includes("内置分组不可删除"),
    `内置组两项 disabled=${builtinButtons.map((button) => button.disabled).join("/")}`,
  );

  // ---- [数据层] 单一归属 + 删组回未分组 ----
  markStage("assign then delete group");
  await ensureWatched(TINY_CODE, GROUP_A);
  groupTab(GROUP_A)?.click();
  await waitFor(() => q(`[data-wl-item="${TINY_CODE}"]`), 6_000);
  const beforeDelete = await ipc.watchlist();
  const groupACount = beforeDelete.groups.find((group) => group.name === GROUP_A)?.count ?? 0;
  const assignedGroup = beforeDelete.items.find((item) => item.security === TINY_CODE)?.groupName ?? null;

  buttonByText("删除分组")?.click();
  const confirm = await waitFor(() => q<HTMLElement>("[data-wl-confirm]"), 4_000);
  const confirmText = confirm.textContent ?? "";
  push(
    "WL-07",
    "render",
    "S-01.02-02",
    confirmText.includes("（未分组）"),
    `二次确认文案「${confirmText.replace(/\s+/g, " ").trim()}」`,
  );
  buttonByText("确认删除", confirm)?.click();
  await sleep(400);
  const afterDelete = await ipc.watchlist();
  const deleted = !afterDelete.groups.some((group) => group.name === GROUP_A);
  const sameTotal = afterDelete.total === beforeDelete.total;
  const itemUngrouped = afterDelete.items
    .filter((item) => item.security === TINY_CODE)
    .every((item) => item.groupName === null);
  const ungroupedTab = groupTab("未分组");
  push(
    "WL-08",
    "data",
    "S-01.02-02",
    deleted && sameTotal && itemUngrouped && groupACount > 0 && assignedGroup === GROUP_A && Boolean(ungroupedTab),
    `归属=${assignedGroup}→null，组已删除=${deleted}，total ${beforeDelete.total}→${afterDelete.total}，${TINY_CODE} groupName=null=${itemUngrouped}，未分组 tab=${Boolean(ungroupedTab)}`,
  );
  push(
    "WL-09",
    "render",
    "S-01.02-02",
    groupTab("全部")?.getAttribute("aria-pressed") === "true",
    `删除后选中「${q<HTMLButtonElement>("[data-wl-group][aria-pressed='true']")?.textContent?.trim() ?? "?"}」`,
  );

  // ---- [数据层] 500 上限：499 放行 / 500 落库 / 501 拒 + 统一文案 ----
  markStage("limit 500");
  const seedCount = (await ipc.watchlist()).items.filter((item) => item.security.startsWith("SEED")).length;
  if (seedCount === 0) {
    block(
      "WL-10",
      "data",
      "S-01.02-02",
      "缺 498 条合成标的 fixture（前置脚本未直插 state.db）；上限分支由 data-store 单测 add_watch_with_limit 与 app-core watchlist_cap_is_500_distinct_securities 覆盖",
    );
  } else {
    const current = await ipc.watchlist();
    const codes = (await ipc.listSecurities()).map((security) => security.code);
    const fresh = codes.filter((code) => !current.items.some((item) => item.security === code));
    let detail = `前置 ${seedCount} 条合成标的，total=${current.total}`;
    let passed = false;
    const added: string[] = [];
    try {
      let total = current.total;
      // 用数据集内真实标的补足到 498（走正常 IPC，不打洞）
      while (total < 498 && fresh.length > 0) {
        const code = fresh.shift() as string;
        await ipc.toggleWatch(code);
        added.push(code);
        total = (await ipc.watchlist()).total;
      }
      if (total !== 498 || fresh.length < 3) {
        detail = `补足后 total=${total}（需 498），剩余可加真实标的 ${fresh.length}（需 3）`;
      } else {
        const [a, b, c] = fresh;
        await ipc.toggleWatch(a);
        added.push(a);
        const at499 = (await ipc.watchlist()).total;
        await ipc.toggleWatch(b);
        added.push(b);
        const at500 = (await ipc.watchlist()).total;
        let rejected = "";
        let reason = "";
        try {
          await ipc.toggleWatch(c);
          added.push(c);
        } catch (err) {
          rejected = errorMessage(err);
          reason = (describeError(err).details as { reason?: string } | undefined)?.reason ?? "";
        }
        passed =
          at499 === 499 &&
          at500 === 500 &&
          rejected === "自选上限 500 只，请先移出后再添加" &&
          reason === "WATCHLIST_LIMIT";
        detail = `499→${at499}，500→${at500}，501 ${rejected ? `拒「${rejected}」reason=${reason}` : "被接受（错）"}`;
      }
    } finally {
      for (const code of added) {
        try {
          await ipc.toggleWatch(code);
        } catch {
          /* 清理失败不阻塞 */
        }
      }
    }
    push("WL-10", "data", "S-01.02-02", passed, detail);
  }

  // ---- [渲染层] 数据不足行（在数据集但 K 线 < 20） ----
  markStage("insufficient row");
  await ensureWatched(TINY_CODE);
  groupTab("全部")?.click();
  await sleep(300);
  const shortRow = await waitFor(() => q<HTMLElement>(`[data-wl-item="${TINY_CODE}"]`), 6_000).catch(() => null);
  // 行内 K 线根数是异步拉取的，等「数据不足」徽标出现再取证
  const shortBadge = await waitFor(
    () => q<HTMLElement>(`[data-wl-item="${TINY_CODE}"] [data-wl-badge="insufficient"]`),
    6_000,
  ).catch(() => null);
  push(
    "WL-11",
    "render",
    "S-01.02-03",
    shortRow?.dataset.wlState === "insufficient" &&
      Boolean(shortBadge) &&
      (shortBadge?.getAttribute("title") ?? "").includes("不足 20 根") &&
      !q(`[data-wl-remove="${TINY_CODE}"]`) &&
      !shortRow?.classList.contains("wl-row--muted"),
    `state=${shortRow?.dataset.wlState}，提示「${shortBadge?.getAttribute("title") ?? ""}」，灰显=${shortRow?.classList.contains("wl-row--muted")}，移出按钮=${Boolean(q(`[data-wl-remove="${TINY_CODE}"]`))}`,
  );
  const canEnter = Boolean(shortRow?.querySelector(".wl-row-main:not([disabled])"));
  push(
    "WL-12",
    "render",
    "S-01.02-03",
    canEnter,
    `数据不足行可进工作台=${canEnter}（.wl-row-main 未 disabled）`,
  );

  // ---- [渲染层] 不在数据集行 ----
  markStage("missing row");
  const seedRow = await waitFor(() => q<HTMLElement>(`[data-wl-item="${SEED_CODE}"]`), 4_000).catch(() => null);
  if (!seedRow) {
    block(
      "WL-13",
      "render",
      "S-01.02-03",
      "缺「不在数据集」fixture（前置脚本未直插 state.db）",
    );
    block("WL-14", "data", "S-01.02-01", "同上，无样本可点「移出」");
  } else {
    push(
      "WL-13",
      "render",
      "S-01.02-03",
      seedRow.dataset.wlState === "missing" &&
        seedRow.classList.contains("wl-row--muted") &&
        Boolean(q(`[data-wl-item="${SEED_CODE}"] [data-wl-badge="missing"]`)) &&
        Boolean(q(`[data-wl-remove="${SEED_CODE}"]`)),
      `state=${seedRow.dataset.wlState}，灰显=${seedRow.classList.contains("wl-row--muted")}，warn 徽标=${Boolean(q(`[data-wl-item="${SEED_CODE}"] [data-wl-badge="missing"]`))}，移出=${Boolean(q(`[data-wl-remove="${SEED_CODE}"]`))}`,
    );
    q<HTMLButtonElement>(`[data-wl-remove="${SEED_CODE}"]`)?.click();
    await sleep(500);
    const removed = !(await ipc.watchlist()).items.some((item) => item.security === SEED_CODE);
    push(
      "WL-14",
      "data",
      "S-01.02-01",
      removed,
      `不在数据集行点「×」后已从自选删除=${removed}（toggle_watch 先判已收藏再校验数据集）`,
    );
  }

  // ---- [渲染层] 写失败：重命名为已有分组 → 顶部错误条 + 「未保存」+「重试」 ----
  markStage("write failure");
  if (!groupTab(GROUP_A)) await ensureGroup(GROUP_A);
  groupTab(GROUP_A)?.click();
  await sleep(200);
  buttonByText("重命名")?.click();
  const renameInput = await waitFor(() => q<HTMLInputElement>("[aria-label='重命名分组']"), 4_000).catch(
    () => null,
  );
  let failureDetail = "找不到重命名输入框";
  let failurePassed = false;
  let retryFailed = false;
  if (renameInput) {
    setValue(renameInput, GROUP_EMPTY);
    await sleep(120);
    buttonByText("保存", renameInput.closest("form") ?? document)?.click();
    const bar = await waitFor(() => q<HTMLElement>("[data-wl-write-error]"), 4_000).catch(() => null);
    const barText = (bar?.textContent ?? "").replace(/\s+/g, " ").trim();
    const retry = q<HTMLButtonElement>("[data-wl-retry]");
    const groupsAfter = await ipc.watchlist();
    const groupAKept = groupsAfter.groups.some((group) => group.name === GROUP_A);
    const emptyKept = groupsAfter.groups.some((group) => group.name === GROUP_EMPTY);
    retry?.click();
    await sleep(600);
    retryFailed = Boolean(q<HTMLElement>("[data-wl-write-error]"));
    failurePassed =
      barText.includes("未保存") &&
      barText.includes("分组已存在") &&
      Boolean(retry) &&
      groupAKept &&
      emptyKept &&
      retryFailed;
    failureDetail = `错误条「${barText}」，重试按钮=${Boolean(retry)}，原组仍在=${groupAKept}，目标组未被覆盖=${emptyKept}，重试后仍报错=${retryFailed}`;
    buttonByText("取消")?.click();
    await sleep(200);
  }
  push("WL-15", "render", "S-01.02-03", failurePassed, failureDetail);

  // ---- [渲染层] 搜索无结果 ----
  markStage("search empty");
  groupTab("全部")?.click();
  const search = q<HTMLInputElement>("[data-wl-search]");
  if (!search) throw new Error("找不到搜索框");
  setValue(search, "zqzzzz");
  const searchEmpty = await waitFor(() => q<HTMLElement>("[data-wl-empty='search']"), 4_000);
  const searchText = searchEmpty.textContent ?? "";
  push(
    "WL-16",
    "render",
    "S-01.02-03",
    searchText.includes("没有匹配「zqzzzz」的自选") && searchText.includes("清除搜索"),
    `搜索空态「${searchText.replace(/\s+/g, " ").trim()}」`,
  );
  buttonByText("清除搜索", searchEmpty)?.click();
  await sleep(120);

  // ---- [数据层] 分组上限 20 个 ----
  markStage("group limit 20");
  let created = 0;
  let limitRejected = "";
  let limitReason = "";
  try {
    let custom = (await ipc.watchlist()).groups.filter((group) => !group.isBuiltin).length;
    while (custom < 20) {
      await ipc.createWatchGroup(`${GROUP_LIMIT}${custom + 1}`);
      created += 1;
      custom += 1;
    }
    const after = (await ipc.watchlist()).groups.filter((group) => !group.isBuiltin).length;
    try {
      await ipc.createWatchGroup(`${GROUP_LIMIT}21`);
      created += 1;
    } catch (err) {
      limitRejected = errorMessage(err);
      limitReason = (describeError(err).details as { reason?: string } | undefined)?.reason ?? "";
    }
    push(
      "WL-17",
      "data",
      "S-01.02-02",
      after === 20 &&
        limitRejected === "分组上限 20 个，请先删除不用的分组" &&
        limitReason === "GROUP_LIMIT",
      `建至 ${after} 个后，第 21 个 ${limitRejected ? `拒「${limitRejected}」reason=${limitReason}` : "被接受（错）"}`,
    );
  } catch (err) {
    push("WL-17", "data", "S-01.02-02", false, `分组上限取证异常：${errorMessage(err)}`);
  }

  // ---- [渲染层] 20 组时新建入口置灰 + 上限提示 ----
  markStage("group limit ui");
  refresh();
  await sleep(400);
  const limitHint = q<HTMLElement>("[data-wl-group-limit]");
  const limitInput = q<HTMLInputElement>("[data-wl-new-group]");
  const limitSubmit = limitInput ? buttonByText("新建", limitInput.closest("form") ?? document) : undefined;
  push(
    "WL-19",
    "render",
    "S-01.02-02",
    (limitHint?.textContent ?? "").includes("分组上限 20 个，请先删除不用的分组") &&
      limitInput?.disabled === true &&
      limitSubmit?.disabled === true,
    `20 组时提示「${limitHint?.textContent?.trim() ?? "缺失"}」，输入框 disabled=${limitInput?.disabled}，新建按钮 disabled=${limitSubmit?.disabled}`,
  );

  // ---- [渲染层] 全部为空态：清空自选后验证 ----
  markStage("all empty");
  try {
    const all = await ipc.watchlist();
    const codes = all.items.map((item) => item.security);
    if (codes.length > 0) {
      for (let start = 0; start < codes.length; start += 40) {
        await Promise.all(
          codes.slice(start, start + 40).map((code) =>
            ipc.toggleWatch(code).catch(() => {
              /* 单只失败不影响判定，最终以 total 为准 */
            }),
          ),
        );
      }
    }
    refresh();
    await sleep(500);
    const emptied = await ipc.watchlist();
    if (emptied.total === 0) {
      const allEmpty = await waitFor(() => q<HTMLElement>("[data-wl-empty='all']"), 4_000).catch(() => null);
      const text = (allEmpty?.textContent ?? "").replace(/\s+/g, " ").trim();
      push(
        "WL-18",
        "render",
        "S-01.02-03",
        text.includes("自选还是空的") && text.includes("去行情页"),
        `全部空态「${text}」`,
      );
    } else {
      block("WL-18", "render", "S-01.02-03", `清空失败：total=${emptied.total}，全部空态未取证`);
    }
  } catch (err) {
    block("WL-18", "render", "S-01.02-03", `清空异常：${errorMessage(err)}`);
  }

  markStage("cleanup");
  for (const group of (await ipc.watchlist()).groups.filter((item) => !item.isBuiltin)) {
    try {
      await ipc.deleteWatchGroup(group.name);
    } catch {
      /* 清理失败不阻塞 */
    }
  }
  refresh();

  const blockedChecks = checks.filter((check) => check.blocked);
  const report = {
    ok: checks.filter((check) => !check.blocked).every((check) => check.passed),
    suite: "S-01.02 watchlist",
    finishedAt: new Date().toISOString(),
    layers: {
      data: checks.filter((check) => check.layer === "data" && !check.blocked).length,
      render: checks.filter((check) => check.layer === "render" && !check.blocked).length,
    },
    blocked: blockedChecks.map((check) => `${check.id}: ${check.detail}`),
    note:
      "500 上限/不在数据集行的样本由前置脚本直插 state.db 构造，取证后用备份还原；写失败为真实路径（重命名到已有分组被后端拒绝）。",
    checks,
  };
  await ipc.diagWriteNamed("s0102-watchlist-evidence.json", JSON.stringify(report, null, 2));
  return report;
}
