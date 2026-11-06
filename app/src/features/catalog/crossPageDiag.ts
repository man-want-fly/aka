import { ipc } from "../../lib/ipc";

interface Check {
  id: string;
  ac: string;
  layer: "data" | "render";
  passed: boolean;
  detail: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

const q = <T extends Element>(selector: string) => document.querySelector<T>(selector);
const qa = <T extends Element>(selector: string) => Array.from(document.querySelectorAll<T>(selector));

const waitFor = async <T,>(probe: () => T | null, timeoutMs = 5_000, stepMs = 50) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("等待超时");
    await sleep(stepMs);
  }
};

/**
 * AC-02.04-01 后半句：抽屉与指标目录各自渲染出来的分类计数必须完全一致。
 * 注意：这里比较的是两页 DOM 上的可见计数，而不是「两边读了同一份 manifest」。
 */
export async function runCrossPageCountDiagnostics() {
  const checks: Check[] = [];
  const push = (id: string, ac: string, layer: Check["layer"], passed: boolean, detail: string) => {
    checks.push({ id, ac, layer, passed, detail });
  };

  const trigger = await waitFor(() => q<HTMLButtonElement>("[data-drawer-trigger]"));
  trigger.click();
  await waitFor(() => q("[data-drawer-cat]"));
  await sleep(150);

  const drawerCategories = qa<HTMLElement>("[data-drawer-cat]").map((element) => ({
    key: element.dataset.drawerCat ?? "",
    count: Number(element.dataset.drawerCatCount ?? "-1"),
    text: (element.textContent ?? "").replace(/\s+/g, ""),
  }));
  const drawerTotal = Number(q<HTMLElement>("[data-drawer-total]")?.dataset.drawerTotal ?? "-1");

  trigger.click();
  await waitFor(() => (q("[data-drawer-cat]") ? null : true), 2_000);
  await sleep(100);

  q<HTMLButtonElement>('button[title="指标库"]')?.click();
  await waitFor(() => q("[data-catalog-category-group]"));
  await sleep(200);

  const catalogCategories = qa<HTMLElement>("[data-catalog-category-group]").map((element) => ({
    key: element.dataset.catalogCategoryGroup ?? "",
    count: Number(element.dataset.catalogCatCount ?? "-1"),
    text: (element.textContent ?? "").replace(/\s+/g, ""),
  }));
  const catalogTotal = Number(q<HTMLElement>("[data-catalog-total]")?.dataset.catalogTotal ?? "-1");

  const keys = ["trend", "momentum", "volatility", "volume", "stat", "breadth"];
  const mismatches = keys.filter((key) => {
    const left = drawerCategories.find((entry) => entry.key === key)?.count;
    const right = catalogCategories.find((entry) => entry.key === key)?.count;
    return left !== right;
  });

  push(
    "X-01",
    "AC-02.04-01",
    "render",
    drawerCategories.length === 6 &&
      catalogCategories.length === 6 &&
      mismatches.length === 0 &&
      drawerTotal === 105 &&
      catalogTotal === 105,
    `抽屉 ${drawerCategories.map((entry) => `${entry.key}:${entry.count}`).join(" ")} / 目录 ${catalogCategories
      .map((entry) => `${entry.key}:${entry.count}`)
      .join(" ")} / 不一致 ${mismatches.join(",") || "无"}`,
  );

  const textMismatches = keys.filter((key) => {
    const left = drawerCategories.find((entry) => entry.key === key);
    const right = catalogCategories.find((entry) => entry.key === key);
    return (
      left === undefined ||
      right === undefined ||
      !left.text.includes(String(left.count)) ||
      !right.text.includes(String(right.count))
    );
  });
  push(
    "X-02",
    "AC-02.04-01",
    "render",
    textMismatches.length === 0,
    `抽屉可见文本 ${drawerCategories.map((entry) => entry.text).join("|")} / 目录可见文本 ${catalogCategories
      .map((entry) => entry.text)
      .join("|")} / 不含计数 ${textMismatches.join(",") || "无"}`,
  );

  const report = {
    ok: checks.every((check) => check.passed),
    finishedAt: new Date().toISOString(),
    context: {
      drawerTotal,
      catalogTotal,
      drawerCategories,
      catalogCategories,
    },
    checks,
  };
  await ipc.diagWriteNamed("ac020401-cross-page-evidence.json", JSON.stringify(report, null, 2));
  return report;
}
