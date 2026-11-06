import { ipc } from "../../lib/ipc";
import type { WorkbenchParams } from "./model";

/**
 * S-02.05-02「重启回默认」物理验证（两次进程启动）：
 * 第一次启动：通过 ParamPanel 真改参数并应用 → 10/22/8 进入 sessionStorage，写标记后退出。
 * 第二次启动：新进程、新 WebView → sessionStorage 必为空，首屏参数回 manifest 默认 20/12/26/9。
 *
 * 两阶段用 localStorage 标记区分（localStorage 跨进程存活，sessionStorage 不跨进程）。
 */
const MARK = "aka.diag.restart.v1";
const PARAMS_KEY = "aka.workbench.params.v1";

interface Check {
  id: string;
  ac: string;
  layer: "data" | "render" | "runtime";
  passed: boolean;
  detail: string;
}

const q = <T extends Element>(selector: string) => document.querySelector<T>(selector);
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

const readNumber = (selector: string) => Number(q<HTMLInputElement>(selector)?.value ?? NaN);
const triplet = () => [readNumber("#macd-fast"), readNumber("#macd-slow"), readNumber("#macd-signal")].join("/");

const setNumber = (selector: string, value: number) => {
  const field = q<HTMLInputElement>(selector);
  if (!field) throw new Error(`找不到输入框 ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(field, String(value));
  field.dispatchEvent(new Event("input", { bubbles: true }));
};

const clickApply = () => {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (item) => item.textContent?.includes("应用参数"),
  );
  if (!button) throw new Error("找不到应用参数按钮");
  button.click();
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
  await waitFor(() => q("#macd-fast"));

  if (!marker) {
    // ---- 第一次启动：改参数并应用，模拟用户会话内最后一刻的状态 ----
    setNumber("#macd-fast", 10);
    setNumber("#macd-slow", 22);
    setNumber("#macd-signal", 8);
    await sleep(80);
    clickApply();
    await waitFor(() => (document.body.textContent?.includes("MACD(10,22,8)") ? true : null), 4_000);

    const stored = storedParams();
    push(
      "PA-01",
      "render",
      document.body.textContent?.includes("MACD(10,22,8)") === true,
      `应用后副图标题含 MACD(10,22,8)=${document.body.textContent?.includes("MACD(10,22,8)")}`,
    );
    push(
      "PA-02",
      "data",
      stored?.fast === 10 && stored?.slow === 22 && stored?.signal === 8,
      `应用后 sessionStorage = ${stored ? `${stored.fast}/${stored.slow}/${stored.signal}` : "空"}`,
    );
    push(
      "PA-03",
      "render",
      triplet() === "10/22/8",
      `应用后 ParamPanel 显示 ${triplet()}`,
    );

    const phaseA = {
      finishedAt: new Date().toISOString(),
      applied: triplet(),
      stored: stored ? `${stored.fast}/${stored.slow}/${stored.signal}` : null,
      exitMethod: "kill -TERM aka-desktop 进程（等同关闭应用窗口）",
    };
    window.localStorage.setItem(MARK, JSON.stringify(phaseA));
    const reportA = { ok: checks.every((check) => check.passed), phase: "before-exit", checks, phaseA };
    await ipc.diagWriteNamed("s20502-restart-evidence.json", JSON.stringify(reportA, null, 2));
    return reportA;
  }

  // ---- 第二次启动：新进程、新 WebView，sessionStorage 应为空，首屏回默认 ----
  const phaseA = JSON.parse(marker) as { applied: string; stored: string | null; finishedAt: string };
  const storedNow = storedParams();
  const initial = triplet();
  const restore = q<HTMLButtonElement>("[data-param-restore]");
  const titleDefault = document.body.textContent?.includes("MACD(12,26,9)") === true;
  const staleChanged = document.body.textContent?.includes("MACD(10,22,8)") === true;

  push("PA-04", "runtime", storedNow === null, `重启后 sessionStorage = ${storedNow ? "非空" : "空"}`);
  push(
    "PA-05",
    "render",
    initial === `${defaults.fast}/${defaults.slow}/${defaults.signal}` &&
      defaults.fast === 12 &&
      defaults.slow === 26 &&
      defaults.signal === 9,
    `重启后首屏参数 ${initial}（manifest 默认 ${defaults.fast}/${defaults.slow}/${defaults.signal}）`,
  );
  push("PA-06", "render", restore?.disabled === true, `重启后恢复按钮 disabled=${restore?.disabled}`);
  push(
    "PA-07",
    "render",
    !staleChanged,
    `重启后无残留 MACD(10,22,8)=${!staleChanged} · 副图标题含 MACD(12,26,9)=${titleDefault}（首屏未选标的时副图不渲染，仅以无残留为准）`,
  );

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
      restoreDisabled: restore?.disabled === true,
      subtitleDefault: titleDefault,
    },
    checks,
  };
  await ipc.diagWriteNamed("s20502-restart-evidence.json", JSON.stringify(report, null, 2));
  return report;
}
