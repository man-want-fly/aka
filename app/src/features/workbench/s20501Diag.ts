/**
 * S-02.05-01 指标参数设置面板实机取证。
 *
 * 全部通过真实 DOM 驱动：原生 value setter + input 事件模拟键入，步进器点真按钮，
 * 越界/空值断言真实 aria-invalid、错误文案与图上「参数无效」角标。
 * 运行时用 `__AKA_FORCE_PARAM_TIMEOUT__` 测试缝模拟 >300ms 慢计算，
 * 验证「提示超时 + 回退上一组有效参数」；该缝未置位时生产行为不变。
 */

import { ipc } from "../../lib/ipc";
import type { RegistryResponse } from "../../lib/types";
import type { WorkbenchParams } from "./model";

interface Check {
  id: string;
  ac: string;
  layer: "data" | "render" | "runtime";
  passed: boolean;
  detail: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
const q = <T extends Element>(selector: string) => document.querySelector<T>(selector);
const bodyHas = (text: string) => (document.body.textContent ?? "").includes(text);

const waitFor = async <T,>(probe: () => T | null, timeoutMs = 4_000, stepMs = 30) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("等待超时");
    await sleep(stepMs);
  }
};

const setText = (selector: string, value: string) => {
  const input = q<HTMLInputElement>(selector);
  if (!input) throw new Error(`找不到输入框 ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const setNumber = (selector: string, value: number) => setText(selector, String(value));
const readText = (selector: string) => q<HTMLInputElement>(selector)?.value ?? "";
const readNumber = (selector: string) => Number(readText(selector));

const blurInput = async (selector: string) => {
  const input = q<HTMLInputElement>(selector);
  input?.focus();
  input?.dispatchEvent(new Event("focusout", { bubbles: true }));
  input?.blur();
  await sleep(80);
};

const clickStep = (key: string, direction: "minus" | "plus") => {
  const row = q(`[data-param-key="${key}"]`);
  const button = row?.querySelector<HTMLButtonElement>(
    direction === "minus" ? "[data-param-minus]" : "[data-param-plus]",
  );
  if (!button) throw new Error(`找不到 ${key} 的 ${direction} 步进按钮`);
  button.click();
};

const clickRestore = () => {
  const button = q<HTMLButtonElement>("[data-param-restore]");
  if (!button) throw new Error("找不到恢复默认按钮");
  button.click();
};

const overlayPath = (id: string, key: string) =>
  q(`[data-overlay="${id}"][data-overlay-key="${key}"]`)?.getAttribute("d") ?? "";
const maPath = () => overlayPath("T01", "sma");
const bollUpper = () => overlayPath("T09", "upper");
const bollLower = () => overlayPath("T09", "lower");

const invalidText = (key: string) =>
  q(`[data-param-invalid="${key}"]`)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const invalidBadge = () => q("[data-param-invalid-badge]") !== null;

export async function runS20501Diagnostics(options: {
  registry: RegistryResponse;
  defaults: WorkbenchParams;
}) {
  const checks: Check[] = [];
  const push = (id: string, ac: string, layer: Check["layer"], passed: boolean, detail: string) => {
    checks.push({ id, ac, layer, passed, detail });
  };
  const spec = (id: string, key: string) =>
    options.registry.indicators
      .find((item) => item.id === id)
      ?.params.find((item) => item.key === key);

  // ---------------- 数据层 ----------------
  const maPeriodSpec = spec("T01", "period");
  const bollPeriodSpec = spec("T09", "period");
  const bollMultSpec = spec("T09", "mult");
  const pageDefaults = [
    readNumber("#ma-period"),
    readNumber("#macd-fast"),
    readNumber("#macd-slow"),
    readNumber("#macd-signal"),
    readNumber("#boll-period"),
    readNumber("#boll-mult"),
  ].join(",");
  const registryDefaults = [
    maPeriodSpec?.default,
    spec("M06", "fast")?.default,
    spec("M06", "slow")?.default,
    spec("M06", "signal")?.default,
    bollPeriodSpec?.default,
    bollMultSpec?.default,
  ].join(",");
  const maPeriodInt = maPeriodSpec?.kind === "int" ? maPeriodSpec : null;
  const bollMultFloat = bollMultSpec?.kind === "float" ? bollMultSpec : null;
  push(
    "D-01",
    "AC-02.05-01",
    "data",
    maPeriodInt?.min === 2 &&
      maPeriodInt.max === 500 &&
      bollMultFloat?.min === 0.5 &&
      bollMultFloat.max === 5.0 &&
      bollMultFloat.step === 0.1 &&
      pageDefaults === registryDefaults,
    `注册表 T01.period ${maPeriodInt?.min}–${maPeriodInt?.max} · T09.mult ${bollMultFloat?.min}–${bollMultFloat?.max} step ${bollMultFloat?.step} · 页面默认 ${pageDefaults} / 注册表 ${registryDefaults}`,
  );

  // ---------------- 渲染层 ----------------
  const baselineMa = maPath();

  setNumber("#ma-period", 1);
  await sleep(200);
  const lowInput = q<HTMLInputElement>("#ma-period");
  push(
    "R-01",
    "AC-02.05-01",
    "render",
    lowInput?.getAttribute("aria-invalid") === "true" &&
      invalidText("maPeriod").includes("2–500") &&
      invalidBadge() &&
      maPath() === baselineMa,
    `周期=1 aria-invalid=${lowInput?.getAttribute("aria-invalid")} 文案=${invalidText(
      "maPeriod",
    )} 角标=${invalidBadge()} 曲线未变=${maPath() === baselineMa}`,
  );

  setNumber("#ma-period", 999);
  await sleep(200);
  push(
    "R-02",
    "AC-02.05-01",
    "render",
    invalidText("maPeriod").includes("2–500") && invalidBadge() && maPath() === baselineMa,
    `周期=999 文案=${invalidText("maPeriod")} 角标=${invalidBadge()}`,
  );

  setNumber("#ma-period", 20);
  setNumber("#macd-fast", 30);
  await sleep(180);
  setNumber("#macd-slow", 26);
  await sleep(200);
  const fastInput = q<HTMLInputElement>("#macd-fast");
  const slowInput = q<HTMLInputElement>("#macd-slow");
  push(
    "R-03",
    "AC-02.05-01",
    "render",
    invalidText("fastSlow").includes("快线周期需小于慢线周期") &&
      fastInput?.getAttribute("aria-invalid") === "true" &&
      slowInput?.getAttribute("aria-invalid") === "true" &&
      fastInput?.className.includes("invalid") === true &&
      slowInput?.className.includes("invalid") === true &&
      invalidBadge() &&
      !bodyHas("MACD(30"),
    `文案=${invalidText("fastSlow")} 快线红框=${fastInput?.getAttribute(
      "aria-invalid",
    )} 慢线红框=${slowInput?.getAttribute("aria-invalid")} 角标=${invalidBadge()} 未重算=${!bodyHas(
      "MACD(30",
    )}`,
  );

  setNumber("#macd-fast", 12);
  setText("#macd-signal", "");
  await sleep(200);
  push(
    "R-04",
    "AC-02.05-01（补2）",
    "render",
    invalidText("signal").includes("请输入数字") &&
      q<HTMLInputElement>("#macd-signal")?.getAttribute("aria-invalid") === "true",
    `信号为空 文案=${invalidText("signal")}`,
  );

  setNumber("#macd-signal", 5);
  await sleep(40);
  setNumber("#macd-signal", 6);
  await sleep(40);
  setNumber("#macd-signal", 7);
  const rapid = await waitFor(() => (bodyHas("MACD(12,26,7)") ? true : null), 3_000).catch(
    () => false,
  );
  push(
    "R-05",
    "AC-02.05-01",
    "render",
    rapid === true && !bodyHas("MACD(12,26,5)") && !bodyHas("MACD(12,26,6)"),
    `连续键入 5/6/7 → 标题只出现 7=${rapid === true}，未出现 5/6=${!bodyHas("MACD(12,26,5)") && !bodyHas("MACD(12,26,6)")}`,
  );

  setNumber("#ma-period", 500);
  await sleep(160);
  clickStep("maPeriod", "plus");
  await sleep(120);
  const atMax = readNumber("#ma-period");
  setNumber("#ma-period", 2);
  await sleep(160);
  clickStep("maPeriod", "minus");
  await sleep(120);
  const atMin = readNumber("#ma-period");
  clickStep("maPeriod", "plus");
  await sleep(160);
  push(
    "R-06",
    "AC-02.05-01（补3）",
    "render",
    atMax === 500 && atMin === 2 && readNumber("#ma-period") === 3,
    `500 再 + = ${atMax} · 2 再 − = ${atMin} · 2 再 + = ${readNumber("#ma-period")}`,
  );

  const bollBefore = [bollUpper(), bollLower()].join("|");
  setText("#boll-mult", "2.55");
  await blurInput("#boll-mult");
  await sleep(400);
  const bollAfter = [bollUpper(), bollLower()].join("|");
  push(
    "R-07",
    "AC-02.05-01（补1）",
    "render",
    readText("#boll-mult") === "2.6" && bollAfter !== bollBefore,
    `2.55 失焦 → ${readText("#boll-mult")} · 上下轨重算=${bollAfter !== bollBefore} · 文案=${invalidText(
      "bollMult",
    )}`,
  );

  clickRestore();
  await sleep(600);
  push(
    "R-08",
    "AC-02.05-01（补5）",
    "render",
    [
      readNumber("#ma-period"),
      readNumber("#macd-fast"),
      readNumber("#macd-slow"),
      readNumber("#macd-signal"),
      readNumber("#boll-period"),
      readText("#boll-mult"),
    ].join(",") === "20,12,26,9,20,2.0" &&
      q<HTMLButtonElement>("[data-param-restore]")?.disabled === true &&
      bodyHas("MACD(12,26,9)"),
    `恢复后 ${[
      readNumber("#ma-period"),
      readNumber("#macd-fast"),
      readNumber("#macd-slow"),
      readNumber("#macd-signal"),
      readNumber("#boll-period"),
      readText("#boll-mult"),
    ].join("/")}`,
  );

  // ---------------- 运行时 ----------------
  // 超时分支：用仅取证可用的测试缝强制走 >300ms 路径，断言提示 + 回退上一组有效参数
  (window as unknown as Record<string, unknown>).__AKA_FORCE_PARAM_TIMEOUT__ = true;
  setNumber("#macd-signal", 8);
  const timedOut = await waitFor(() => (q("[data-param-timeout]") ? true : null), 3_000).catch(
    () => false,
  );
  await sleep(300);
  const afterTimeout = [readNumber("#macd-signal"), readNumber("#ma-period")].join(",");
  (window as unknown as Record<string, unknown>).__AKA_FORCE_PARAM_TIMEOUT__ = false;
  push(
    "RT-01",
    "AC-02.05-01（补4）",
    "runtime",
    timedOut === true && afterTimeout === "9,20",
    `强制慢计算 → 提示=${timedOut === true} · 回退=${afterTimeout}（应为 9,20）`,
  );

  const report = {
    ok: checks.every((check) => check.passed),
    finishedAt: new Date().toISOString(),
    summary: [
      `data ${checks.filter((c) => c.layer === "data" && c.passed).length}/${checks.filter((c) => c.layer === "data").length}`,
      `render ${checks.filter((c) => c.layer === "render" && c.passed).length}/${checks.filter((c) => c.layer === "render").length}`,
      `runtime ${checks.filter((c) => c.layer === "runtime" && c.passed).length}/${checks.filter((c) => c.layer === "runtime").length}`,
    ],
    checks,
  };
  await ipc.diagWriteNamed("s20501-evidence.json", JSON.stringify(report, null, 2));
  return report;
}
