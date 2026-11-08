//! S-08.02-03 取证：启动校验错误卡、三路恢复、只读浏览与写操作拒绝。
//! 只点击页面上的真实按钮，不伪造 DOM 结果；运行层取证由 BA 执行。

import { describeError, ipc } from "../../lib/ipc";
import type { DatasetIntegrityDto } from "../../lib/types";
import { collectEvidenceEnv, collectFocus, type EvidenceEnv } from "../workbench/diag";

export interface S080203Check {
  id: string;
  card: string;
  ac: string;
  passed: boolean;
  detail: string;
}

export interface S080203Report {
  target: string;
  card: string;
  errorCode: string;
  /** 脚本 `--expect-code=` 给出的期望码；与 DTO 独立。 */
  expectedCode: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  env: EvidenceEnv | null;
  windowFocused: boolean;
  appActive: boolean;
  checks: S080203Check[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

async function waitFor<T>(
  probe: () => T | null | undefined,
  timeoutMs: number,
  stepMs = 60,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = probe();
    if (value) return value;
    await sleep(stepMs);
  }
  throw new Error(`等待超时（${timeoutMs}ms）`);
}

const textOf = (node: Element | null) => node?.textContent?.replace(/\s+/g, " ").trim() ?? "";

function errorText(): string {
  return document.querySelector("[data-dataset-error]")?.textContent ?? "";
}

/** 错误卡不得泄露堆栈：不出现 `Error:` 或缩进的 `at xxx` 行。 */
function looksLikeStack(text: string): boolean {
  return /Error:|(\n|\s{2,})at\s+\S+\s+\(/.test(text);
}

/** 0 网络：只统计外部主机请求（本地 tauri/asset 不计）。 */
function externalRequests(): string[] {
  return performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name) => /^https?:/i.test(name) && !name.startsWith("http://localhost"));
}

function click(selector: string): void {
  const node = document.querySelector<HTMLButtonElement>(selector);
  if (!node) throw new Error(`找不到按钮：${selector}`);
  node.click();
}

export async function runS080203Diagnostics(integrity: DatasetIntegrityDto): Promise<S080203Report> {
  const faults = await ipc.diagFaults();
  const expectedCode = (faults.expectCode ?? "").trim();
  const code = integrity.errorCode ?? "UNKNOWN";
  // 分类是否正确由脚本期望码锚定，而不是拿 DTO 自己比自己。
  const codeMatches = expectedCode.length > 0 && code === expectedCode;
  const report: S080203Report = {
    target: "s080203",
    card: "S-08.02-03",
    errorCode: code,
    expectedCode,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    ok: false,
    env: null,
    windowFocused: false,
    appActive: false,
    checks: [],
  };
  const push = (id: string, ac: string, passed: boolean, detail: string) => {
    report.checks.push({ id, card: "S-08.02-03", ac, passed, detail });
  };

  // ① 错误卡字段：枚举值 + trace id + 数据集路径（AC-08.02-03）。
  const card = document.querySelector("[data-dataset-error]");
  const domCode = textOf(document.querySelector("[data-dataset-error-code]"));
  const trace = textOf(document.querySelector("[data-dataset-error-trace]"));
  const path = textOf(document.querySelector("[data-dataset-error-path]"));
  push(
    "P09-R1",
    "AC-08.02-03",
    card !== null &&
      codeMatches &&
      domCode === expectedCode &&
      path === integrity.datasetPath &&
      trace.length > 0 &&
      document.querySelector("[data-dataset-copy-trace]") !== null &&
      document.querySelector("[data-dataset-rebuild]") !== null &&
      document.querySelector("[data-dataset-export]") !== null,
    `独立来源：脚本 --expect-code=${expectedCode || "(未传)"}；DTO=${code}，DOM=${domCode}，path=${path}`,
  );

  // ② 不展示堆栈（补3）。
  push("P09-R2", "AC-08.02-03（补3）", !looksLikeStack(errorText()), "错误卡未出现堆栈字样");

  if (codeMatches && expectedCode === "MISSING_DIR") {
    // ③ 不可读数据集不给「只读浏览」。
    push(
      "P09-R3",
      "AC-08.02-03",
      document.querySelector("[data-dataset-readonly]") === null,
      "MISSING_DIR 未提供只读浏览入口",
    );

    // ④ 重建成功 → 离开错误卡、进入行情页、无只读红条（补4）。
    click("[data-dataset-rebuild]");
    const recovered = await waitFor(
      () => (document.querySelector("[data-dataset-error]") === null ? true : null),
      15_000,
      120,
    ).catch(() => false);
    await waitFor(() => (document.querySelector("[data-market-row]") ? true : null), 8_000).catch(
      () => undefined,
    );
    push(
      "P09-R4",
      "AC-08.02-03（补4）",
      recovered === true &&
        window.location.hash.startsWith("#/market") &&
        document.querySelector("[data-readonly-banner]") === null &&
        document.querySelector("[data-market-row]") !== null,
      `错误卡消失=${recovered === true}，hash=${window.location.hash || "#/market"}`,
    );

    // ⑤ 全程不发起外部网络请求。
    push("P09-R5", "AC-08.02-03", externalRequests().length === 0, "外部请求 0 条");
  }

  if (codeMatches && expectedCode === "SHA256_MISMATCH") {
    // ⑥ 只读浏览：红条常驻且不可关闭（补1）。
    click("[data-dataset-readonly]");
    const banner = await waitFor(
      () => document.querySelector<HTMLElement>("[data-readonly-banner]"),
      5_000,
    ).catch(() => null);
    push(
      "P09-R6",
      "AC-08.02-03（补1）",
      banner !== null &&
        textOf(banner).includes("仅只读浏览") &&
        banner.querySelector("button") === null &&
        document.querySelector("[data-dataset-error]") === null,
      `红条=${textOf(banner)}，可关闭按钮=${banner?.querySelector("button") !== null}`,
    );

    // ⑦ 行情表可看（补1）；先在行情页验证自选写入被拒（补2）。
    const row = await waitFor(
      () => document.querySelector<HTMLElement>("[data-market-row]"),
      8_000,
    ).catch(() => null);
    const before = (await ipc.watchlist()).items.length;
    const star = document.querySelector<HTMLButtonElement>("[data-star]");
    star?.click();
    const toast = await waitFor(
      () => {
        const node = document.querySelector(".market-toast");
        return node && textOf(node).includes("数据集不可写") ? node : null;
      },
      4_000,
    ).catch(() => null);
    const after = (await ipc.watchlist()).items.length;
    push(
      "P09-R8",
      "AC-08.02-03（补2）",
      row !== null && star !== null && toast !== null && before === after,
      `提示=${textOf(toast)}，自选 ${before} → ${after}`,
    );

    // ⑧ 进入工作台：K 线可看、计算被禁用（补1）。
    row?.click();
    const notice = await waitFor(
      () => document.querySelector<HTMLElement>("[data-calc-readonly]"),
      10_000,
    ).catch(() => null);
    const chart = await waitFor(
      () => document.querySelector('[data-chart="candle"]'),
      10_000,
    ).catch(() => null);
    push(
      "P09-R7",
      "AC-08.02-03（补1）",
      row !== null &&
        notice !== null &&
        textOf(notice).includes("已禁用计算") &&
        chart !== null &&
        document.querySelector("[data-calc-error]") === null,
      `提示=${textOf(notice)}，K线=${chart !== null}，无计算错误卡=${document.querySelector("[data-calc-error]") === null}`,
    );

    // ⑨ 主题写入被拒并提示原因（补2）：三路都要保持不变。
    const themeButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".theme-controls .seg button"),
    ).find((node) => node.getAttribute("aria-pressed") !== "true");
    const themeSnapshot = () => ({
      attr: document.documentElement.dataset.theme ?? "",
      stored: window.localStorage.getItem("aka.theme") ?? "",
      pressed: themeButton?.getAttribute("aria-pressed") ?? "",
    });
    const themeBefore = themeSnapshot();
    themeButton?.click();
    const hint = await waitFor(
      () => {
        const node = document.querySelector("[data-readonly-hint]");
        return node && textOf(node).includes("数据集不可写") ? node : null;
      },
      4_000,
    ).catch(() => null);
    const themeAfter = themeSnapshot();
    push(
      "P09-R9",
      "AC-08.02-03（补2）",
      themeButton !== undefined &&
        hint !== null &&
        themeBefore.attr === themeAfter.attr &&
        themeBefore.stored === themeAfter.stored &&
        themeBefore.pressed === themeAfter.pressed,
      `独立来源：三路不变（data-theme=${themeAfter.attr}、localStorage=${themeAfter.stored}、aria-pressed=${themeAfter.pressed}）；提示=${textOf(hint)}`,
    );

    // ⑩ 全程不发起外部网络请求。
    push("P09-R10", "AC-08.02-03", externalRequests().length === 0, "外部请求 0 条");
  }

  // R-EV-02：env 与聚焦状态由 diag.ts 统一产出；env 采集失败也照常落 dump（由 verify 判 failed）。
  // meta.dump / meta.reproduce 由 evidence-run.sh 写入，套件出口只负责顶层 env / windowFocused / appActive。
  const env = await collectEvidenceEnv("s080203").catch(() => null);
  const focus = collectFocus();
  report.env = env;
  report.windowFocused = focus.windowFocused;
  report.appActive = focus.appActive;
  report.ok = report.checks.every((check) => check.passed);
  report.finishedAt = new Date().toISOString();
  await ipc.diagWriteNamed("s080203-evidence.json", JSON.stringify(report, null, 2));
  return report;
}

/** 仅 `AKA_DIAG_TARGET=s080203` 时触发；异常只影响取证，不影响页面。 */
export async function maybeRunS080203(integrity: DatasetIntegrityDto): Promise<void> {
  try {
    const enabled = await ipc.diagEnabled();
    const target = await ipc.diagTarget();
    if (!enabled || target !== "s080203") return;
    if (window.sessionStorage.getItem("aka.s080203.diag.done") === "1") return;
    window.sessionStorage.setItem("aka.s080203.diag.done", "1");
    await runS080203Diagnostics(integrity);
  } catch (error) {
    console.error("[s080203.diag]", describeError(error).message);
  }
}
