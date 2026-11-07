import { ipc } from "../../lib/ipc";
import type { WorkbenchParams } from "./model";

/**
 * S-02.05-02 物理验证（两次进程启动，R-EV-01 分层取证）：
 * 第一次启动：真选一只标的 → 应用 10/22/8 → 点「恢复默认」走主路径 → 补1（tooltip + 无请求）
 *             → 再应用 10/22/8 留下会话态，写 localStorage 标记后退出。
 * 第二次启动：新进程、新 WebView → sessionStorage 必为空（数据层单列）→ 首屏回默认
 *             → 打开同一标的看到 MACD(12,26,9) → 补3（20 根日线时副图内联数据不足提示）。
 */
const MARK = "aka.diag.restart.v4";
const PARAMS_KEY = "aka.workbench.params.v1";
let currentStage = "init";
const markStage = (stage: string) => {
  currentStage = stage;
  (window as unknown as { __akaRestartStage?: string }).__akaRestartStage = stage;
};
export const restartDiagStage = () => currentStage;

interface Check {
  id: string;
  ac: string;
  layer: "data" | "render" | "runtime";
  passed: boolean;
  detail: string;
}

const q = <T extends Element>(selector: string) => document.querySelector<T>(selector);
const qa = <T extends Element>(selector: string) =>
  Array.from(document.querySelectorAll<T>(selector));
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

const readNumber = (selector: string) => Number(q<HTMLInputElement>(selector)?.value ?? NaN);
const triplet = () => [readNumber("#macd-fast"), readNumber("#macd-slow"), readNumber("#macd-signal")].join("/");

const setValue = (field: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
};

const setNumber = (selector: string, value: number) => {
  const field = q<HTMLInputElement>(selector);
  if (!field) throw new Error(`找不到输入框 ${selector}`);
  setValue(field, String(value));
};

const clickApply = () => {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (item) => item.textContent?.includes("应用参数"),
  );
  if (!button) throw new Error("找不到应用参数按钮");
  button.click();
};

const restoreButton = () => q<HTMLButtonElement>("[data-param-restore]");
const subTitle = (label: string) => q(`[data-sub-title="${label}"]`);
const computeCount = async () => {
  const summary = await ipc.telemetryDump(200);
  return summary.counts["indicator.compute"] ?? 0;
};

const storedParams = () => {
  const raw = window.sessionStorage.getItem(PARAMS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WorkbenchParams;
  } catch {
    return null;
  }
};

export async function runRestartDiagnostics(defaults: WorkbenchParams) {
  const checks: Check[] = [];
  const push = (id: string, layer: Check["layer"], passed: boolean, detail: string) => {
    checks.push({ id, ac: "AC-02.05-04", layer, passed, detail });
  };

  const marker = window.localStorage.getItem(MARK);
  markStage("wait workbench ready");
  await waitFor(() => q("#macd-fast"));
  await waitFor(() => restoreButton());

  if (!marker) {
    // ---- 第一次启动：真选一只标的（不是首屏默认），再改参数并应用 ----
    markStage("seed watchlist");
    const current = await ipc.watchlist();
    if (current.total === 0) {
      const securities = await ipc.listSecurities();
      const seed = securities[0];
      if (!seed) throw new Error("没有可加入自选的样本");
      await ipc.toggleWatch(seed.code);
    }
    markStage("wait watchlist item");
    await waitFor(() => (qa("[data-wl-item]").length > 0 ? true : null), 8_000);
    const items = qa<HTMLDivElement>("[data-wl-item]");
    const chosen = items[1] ?? items[0];
    if (!chosen) throw new Error("找不到自选行");
    const code = chosen.dataset.wlItem ?? "";
    markStage("select security");
    chosen.querySelector<HTMLButtonElement>(".wl-row-main")?.click();
    markStage("wait default sub title A");
    await waitFor(() => subTitle("MACD(12,26,9)"));
    push("PA-01", "render", Boolean(code) && Boolean(subTitle("MACD(12,26,9)")), `已选中 ${code}，副图标题 MACD(12,26,9)`);

    markStage("apply 10/22/8 A");
    setNumber("#macd-fast", 10);
    setNumber("#macd-slow", 22);
    setNumber("#macd-signal", 8);
    await sleep(80);
    clickApply();
    markStage("wait 10/22/8 A");
    await waitFor(() => subTitle("MACD(10,22,8)"), 5_000);

    const stored = storedParams();
    push("PA-02", "render", Boolean(subTitle("MACD(10,22,8)")), "应用后副图标题 MACD(10,22,8)");
    push(
      "PA-03",
      "data",
      stored?.fast === 10 && stored?.slow === 22 && stored?.signal === 8,
      `应用后 sessionStorage = ${stored ? `${stored.fast}/${stored.slow}/${stored.signal}` : "空"}`,
    );
    push("PA-04", "render", triplet() === "10/22/8", `应用后 ParamPanel 显示 ${triplet()}`);

    // ---- AC-02.05-04 主路径：点「恢复默认」→ 图例回 12,26,9 → 按钮 disabled ----
    markStage("restore click A");
    restoreButton()?.click();
    markStage("wait default after restore");
    await waitFor(() => subTitle("MACD(12,26,9)"));
    markStage("wait disabled after restore");
    await waitFor(() => (restoreButton()?.disabled ? true : null));
    const restore = restoreButton()!;
    push("PA-05", "render", triplet() === "12/26/9", `恢复后 ParamPanel 显示 ${triplet()}`);
    push("PA-06", "render", Boolean(subTitle("MACD(12,26,9)")), "恢复后副图标题 MACD(12,26,9)");
    push("PA-07", "render", restore.disabled === true, `恢复后按钮 disabled=${restore.disabled}`);

    // ---- 补1：tooltip + 点击禁用按钮无新请求（渲染层 + 运行层）----
    push("PA-08", "render", restore.title === "当前即为默认参数", `恢复按钮 tooltip=「${restore.title}」`);
    const before = await computeCount();
    restore.click(); // disabled 按钮的点击不触发处理函数
    await sleep(400);
    const after = await computeCount();
    push(
      "PA-09",
      "runtime",
      before === after,
      `点击禁用按钮前后 indicator.compute 计数 ${before} → ${after}`,
    );

    // ---- 留下「改了但未恢复」的会话态，供第二次启动验证不被旧设置覆盖 ----
    markStage("reapply A");
    setNumber("#macd-fast", 10);
    setNumber("#macd-slow", 22);
    setNumber("#macd-signal", 8);
    await sleep(80);
    clickApply();
    await waitFor(() => subTitle("MACD(10,22,8)"), 5_000);

    const phaseA = {
      finishedAt: new Date().toISOString(),
      code,
      appliedBeforeExit: triplet(),
      storedBeforeExit: (() => {
        const value = storedParams();
        return value ? `${value.fast}/${value.slow}/${value.signal}` : null;
      })(),
      exitMethod: "kill -TERM aka-desktop 进程（等同关闭应用窗口）",
    };
    window.localStorage.setItem(MARK, JSON.stringify(phaseA));
    const reportA = { ok: checks.every((check) => check.passed), phase: "before-exit", checks, phaseA };
    await ipc.diagWriteNamed("s20502-restart-evidence.json", JSON.stringify(reportA, null, 2));
    return reportA;
  }

  // ---- 第二次启动：新进程、新 WebView ----
  const phaseA = JSON.parse(marker) as {
    code: string;
    appliedBeforeExit: string;
    storedBeforeExit: string | null;
    finishedAt: string;
  };
  const storedNow = storedParams();
  const initial = triplet();
  const restore = restoreButton()!;

  push("PA-10", "data", storedNow === null, `重启后 sessionStorage = ${storedNow ? "非空" : "空"}`);
  push(
    "PA-11",
    "render",
    initial === `${defaults.fast}/${defaults.slow}/${defaults.signal}` &&
      defaults.fast === 12 &&
      defaults.slow === 26 &&
      defaults.signal === 9,
    `重启后首屏参数 ${initial}（manifest 默认 ${defaults.fast}/${defaults.slow}/${defaults.signal}）`,
  );
  push("PA-12", "render", restore.disabled === true, `重启后恢复按钮 disabled=${restore.disabled}`);
  push(
    "PA-13",
    "render",
    document.body.textContent?.includes("MACD(10,22,8)") !== true,
    "重启首屏无残留 MACD(10,22,8)",
  );

  // ---- 补2：打开同一标的，副图按默认 12,26,9 渲染 ----
  markStage("reopen same security");
  const target =
    q<HTMLDivElement>(`[data-wl-item="${phaseA.code}"]`) ?? qa<HTMLDivElement>("[data-wl-item]")[0];
  if (!target) throw new Error("找不到要重新打开的标的");
  target.querySelector<HTMLButtonElement>(".wl-row-main")?.click();
  await waitFor(() => subTitle("MACD(12,26,9)"));
  push("PA-14", "render", Boolean(subTitle("MACD(12,26,9)")), `打开 ${phaseA.code} 后副图标题 MACD(12,26,9)`);

  // ---- 补3：20 根日线 + 恢复默认 → 副图内联「MACD 需要 34 根，当前 20 根」，不报错 ----
  markStage("apply 10/22/8 B");
  setNumber("#macd-fast", 10);
  setNumber("#macd-slow", 22);
  setNumber("#macd-signal", 8);
  await sleep(80);
  clickApply();
  try {
    await waitFor(() => subTitle("MACD(10,22,8)"), 5_000);
  } catch {
    const labels = qa<SVGElement>("[data-sub-title]").map((node) => node.dataset.subTitle ?? "");
    throw new Error(`B 应用后未出现 MACD(10,22,8)：面板 ${triplet()} / 副图 ${labels.join("|") || "无"}`);
  }

  markStage("fetch bars B");
  const barsResponse = await ipc.getBars({ security: phaseA.code, timeframe: "D", adj: "qfq" });
  const bars = barsResponse.bars;
  if (bars.length < 20) throw new Error(`样本不足 20 根：${bars.length}`);

  // 补3 使用 AKA_DIAG=1 装配时注入的 20 根短序列样本（DIAG020.SZ）
  markStage("open short series B");
  const shortCode = "DIAG020.SZ";
  const list = await ipc.watchlist();
  if (!list.items.some((item) => item.security === shortCode)) {
    await ipc.toggleWatch(shortCode);
    window.dispatchEvent(new Event("aka:watchlist-refresh"));
  }
  await waitFor(() => q(`[data-wl-item="${shortCode}"]`), 8_000);
  q<HTMLDivElement>(`[data-wl-item="${shortCode}"]`)?.querySelector<HTMLButtonElement>(".wl-row-main")?.click();
  markStage("wait short sub title B");
  await waitFor(() => subTitle("MACD(10,22,8)"), 8_000);
  markStage("wait insufficient notice B");
  try {
    await waitFor(() => q("[data-sub-notice='M06']"), 8_000);
  } catch {
    const errorBox = q<HTMLElement>(".error-box")?.textContent ?? "无";
    const labels = qa<SVGElement>("[data-sub-title]").map((node) => node.dataset.subTitle ?? "");
    throw new Error(
      `短序列未出提示：参数 ${triplet()} / 副图 ${labels.join("|") || "无"} / 错误条 ${errorBox}`,
    );
  }

  restoreButton()?.click();
  const notice = await waitFor(() => {
    const node = q<SVGElement>("[data-sub-notice='M06']");
    const text = node?.textContent ?? "";
    return text.includes("MACD 需要 34 根，当前 20 根") ? text : null;
  }, 8_000);
  push("PA-15", "render", notice === "MACD 需要 34 根，当前 20 根", `副图提示「${notice}」`);
  push("PA-16", "render", !q(".error-box"), "20 根时无全局错误条");
  push("PA-17", "render", triplet() === "12/26/9", `20 根时恢复默认后 ParamPanel 显示 ${triplet()}`);

  window.localStorage.removeItem(MARK);
  const report = {
    ok: checks.every((check) => check.passed),
    phase: "after-restart",
    finishedAt: new Date().toISOString(),
    phaseA,
    phaseB: {
      finishedAt: new Date().toISOString(),
      firstScreen: initial,
      stored: storedNow ? `${storedNow.fast}/${storedNow.slow}/${storedNow.signal}` : null,
      restoreDisabled: restore.disabled === true,
      reopened: phaseA.code,
      subtitleDefault: Boolean(subTitle("MACD(12,26,9)")),
      insufficientNotice: notice,
    },
    checks,
  };
  await ipc.diagWriteNamed("s20502-restart-evidence.json", JSON.stringify(report, null, 2));
  return report;
}
