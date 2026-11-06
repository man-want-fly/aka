import { ipc } from "../../lib/ipc";
import type { RegistryResponse } from "../../lib/types";
import { DEFAULT_PARAMS, type WorkbenchParams } from "./model";

interface Check {
  id: string;
  ac: string;
  layer: "data" | "render" | "runtime";
  passed: boolean;
  detail: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

const q = <T extends Element>(selector: string) => document.querySelector<T>(selector);

const waitFor = async <T,>(probe: () => T | null, timeoutMs = 4_000, stepMs = 30) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("等待超时");
    await sleep(stepMs);
  }
};

const setNumber = (selector: string, value: number) => {
  const input = q<HTMLInputElement>(selector);
  if (!input) throw new Error(`找不到输入框 ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, String(value));
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const readNumber = (selector: string) => Number(q<HTMLInputElement>(selector)?.value ?? "NaN");

const clickApply = () => {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((entry) =>
    entry.textContent?.includes("应用参数"),
  );
  if (!button) throw new Error("找不到应用参数按钮");
  button.click();
};

const bodyHas = (text: string) => (document.body.textContent ?? "").includes(text);

/**
 * S-02.05-02 恢复默认与会话记忆取证。
 * 参数值只以 manifest 默认值（Rust ParamSpec）为基准，不在页面另存默认数字。
 */
export async function runS205Diagnostics(options: {
  registry: RegistryResponse;
  defaults: WorkbenchParams;
}) {
  const checks: Check[] = [];
  const push = (id: string, ac: string, layer: Check["layer"], passed: boolean, detail: string) => {
    checks.push({ id, ac, layer, passed, detail });
  };

  const regDefault = (id: string, key: string) => {
    const spec = options.registry.indicators
      .find((item) => item.id === id)
      ?.params.find((item) => item.key === key);
    if (!spec || spec.kind !== "int") throw new Error(`注册表缺 ${id}.${key}`);
    return spec.default;
  };
  const registryDefaults = {
    fast: regDefault("M06", "fast"),
    slow: regDefault("M06", "slow"),
    signal: regDefault("M06", "signal"),
  };
  push(
    "D-01",
    "S-03.01-03 / S-02.05-02",
    "data",
    registryDefaults.fast === options.defaults.fast &&
      registryDefaults.slow === options.defaults.slow &&
      registryDefaults.signal === options.defaults.signal &&
      registryDefaults.fast === DEFAULT_PARAMS.fast &&
      registryDefaults.slow === DEFAULT_PARAMS.slow &&
      registryDefaults.signal === DEFAULT_PARAMS.signal,
    `注册表 M06 ${registryDefaults.fast}/${registryDefaults.slow}/${registryDefaults.signal} · 页面默认 ${options.defaults.fast}/${options.defaults.slow}/${options.defaults.signal}`,
  );

  await waitFor(() => q("#macd-fast"));
  await sleep(200);
  const restore = q<HTMLButtonElement>("[data-param-restore]");
  const initial = [readNumber("#macd-fast"), readNumber("#macd-slow"), readNumber("#macd-signal")];
  push(
    "R-01",
    "AC-02.05-04",
    "render",
    initial.join(",") === "12,26,9" &&
      restore?.disabled === true &&
      restore?.getAttribute("title") === "当前即为默认参数",
    `初始 ${initial.join("/")} · 恢复按钮 disabled=${restore?.disabled} · title=${restore?.getAttribute(
      "title",
    )}`,
  );

  setNumber("#macd-fast", 10);
  setNumber("#macd-slow", 22);
  setNumber("#macd-signal", 8);
  await sleep(80);
  const restoreAfterEdit = q<HTMLButtonElement>("[data-param-restore]");
  push(
    "R-02",
    "AC-02.05-04",
    "render",
    restoreAfterEdit?.disabled === false,
    `改参数后恢复按钮 disabled=${restoreAfterEdit?.disabled}`,
  );

  clickApply();
  await waitFor(() => (bodyHas("MACD(10,22,8)") ? true : null), 3_000);
  push(
    "R-03",
    "AC-02.05-04",
    "render",
    bodyHas("MACD(10,22,8)"),
    `应用 10/22/8 后副图标题含 MACD(10,22,8)=${bodyHas("MACD(10,22,8)")}`,
  );

  // 会话记忆：切到行情再回工作台（组件卸载重挂），参数应保持在 10/22/8
  q<HTMLButtonElement>('button[title="行情"]')?.click();
  await waitFor(() => (q("#macd-fast") ? null : true), 3_000);
  await sleep(300);
  q<HTMLButtonElement>('button[title="工作台"]')?.click();
  await waitFor(() => q("#macd-fast"), 6_000);
  await sleep(600);
  const restored = [readNumber("#macd-fast"), readNumber("#macd-slow"), readNumber("#macd-signal")];
  const stored = JSON.parse(window.sessionStorage.getItem("aka.workbench.params.v1") ?? "null") as
    | WorkbenchParams
    | null;
  push(
    "R-04",
    "S-02.05-02 会话记忆",
    "render",
    restored.join(",") === "10,22,8" &&
      stored?.fast === 10 &&
      stored?.slow === 22 &&
      stored?.signal === 8,
    `切页回来 ${restored.join("/")} · sessionStorage ${stored ? `${stored.fast}/${stored.slow}/${stored.signal}` : "空"}`,
  );

  const restoreAfterRemount = q<HTMLButtonElement>("[data-param-restore]");
  restoreAfterRemount?.click();
  await waitFor(
    () =>
      readNumber("#macd-fast") === 12 &&
      readNumber("#macd-slow") === 26 &&
      readNumber("#macd-signal") === 9 &&
      bodyHas("MACD(12,26,9)")
        ? true
        : null,
    3_000,
  );
  const restoredAgain = [
    readNumber("#macd-fast"),
    readNumber("#macd-slow"),
    readNumber("#macd-signal"),
  ];
  const storedAfter = JSON.parse(
    window.sessionStorage.getItem("aka.workbench.params.v1") ?? "null",
  ) as WorkbenchParams | null;
  const restoreFinal = q<HTMLButtonElement>("[data-param-restore]");
  push(
    "R-05",
    "AC-02.05-04",
    "render",
    restoredAgain.join(",") === "12,26,9" &&
      bodyHas("MACD(12,26,9)") &&
      restoreFinal?.disabled === true &&
      storedAfter?.fast === 12 &&
      storedAfter?.slow === 26 &&
      storedAfter?.signal === 9 &&
      q("[data-param-restored]") !== null,
    `恢复后 ${restoredAgain.join("/")} · 标题含默认=${bodyHas(
      "MACD(12,26,9)",
    )} · 按钮 disabled=${restoreFinal?.disabled} · sessionStorage ${
      storedAfter ? `${storedAfter.fast}/${storedAfter.slow}/${storedAfter.signal}` : "空"
    } · 提示=${q("[data-param-restored]") !== null}`,
  );

  const report = {
    ok: checks.every((check) => check.passed),
    finishedAt: new Date().toISOString(),
    context: {
      defaults: options.defaults,
      registryDefaults,
      restartDefault: "sessionStorage 为会话级；应用重启后回到 manifest 默认（本轮未物理重启验证）",
    },
    checks,
  };
  await ipc.diagWriteNamed("s20502-evidence.json", JSON.stringify(report, null, 2));
  return report;
}
