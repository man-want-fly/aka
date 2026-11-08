//! S-08.02-02 取证：计算错误态（超时 / 引擎异常 / 数据不可用）、
//! 连续 3 次失败导出入口，以及切标的后旧错误不残留。
//! 只通过 UI 与 `diag_set_inject` 驱动，不伪造 DOM 结果。

import { ipc } from "../../lib/ipc";

export interface S080202Options {
  /** 设置下一次计算的故障注入；生效一次即回落 none。 */
  setInject: (kind: "timeout" | "panic" | "data" | "none") => Promise<void>;
  /** 触发一次真实重算（等价点击「重试」）。 */
  trigger: () => void;
  /** 切标的（用于验证旧错误不残留）。 */
  setCode: (code: string) => void;
  codes: string[];
}

export interface S080202Check {
  id: string;
  ac: string;
  passed: boolean;
  detail: string;
}

export interface S080202Report {
  target: string;
  card: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  checks: S080202Check[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

async function waitFor<T>(probe: () => T | null | undefined, timeoutMs: number, stepMs = 60): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = probe();
    if (value) return value;
    await sleep(stepMs);
  }
  throw new Error(`等待超时（${timeoutMs}ms）`);
}

function errorNode(code: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-calc-error="${code}"]`);
}

function traceOf(node: HTMLElement): string {
  return node.querySelector("[data-calc-error-trace]")?.textContent?.trim() ?? "";
}

function textOf(node: HTMLElement | null): string {
  return node?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

export async function runS080202Diagnostics(options: S080202Options): Promise<S080202Report> {
  const report: S080202Report = {
    target: "s080202",
    card: "S-08.02-02",
    startedAt: new Date().toISOString(),
    finishedAt: "",
    ok: false,
    checks: [],
  };
  const push = (id: string, ac: string, passed: boolean, detail: string) => {
    report.checks.push({ id, ac, passed, detail });
  };
  const fail = async (
    code: "E_ENGINE_PANIC" | "E_DATA_UNAVAILABLE" | "E_TIMEOUT",
    inject: "panic" | "data" | "timeout",
    previous = "",
  ) => {
    // commands.rs 的 take_inject() 每个请求消费一次即回落 none：连续重试必须在每次
    // 触发前重新注入，否则第 2 次重试变成正常计算、错误卡消失，套件会卡在 waitFor 超时。
    await options.setInject(inject);
    options.trigger();
    const node = await waitFor(() => {
      const current = errorNode(code);
      if (!current) return null;
      return previous && traceOf(current) === previous ? null : current;
    }, code === "E_TIMEOUT" ? 12_000 : 5_000);
    return node;
  };

  // ① 引擎异常：标题/错误码/trace id/动作，且不出现「查看数据源状态」。
  const panic = await fail("E_ENGINE_PANIC", "panic");
  const panicActions = Array.from(panic.querySelectorAll("[data-calc-error] button"));
  const panicText = textOf(panic);
  push(
    "P06-R1",
    "AC-08.02-02",
    textOf(panic.querySelector("[data-calc-error-title]")) === "引擎异常" &&
      textOf(panic.querySelector("[data-calc-error-code]")) === "E_ENGINE_PANIC" &&
      traceOf(panic).length > 0 &&
      panicText.includes("重试") &&
      panicText.includes("降低参数") &&
      !panicText.includes("查看数据源状态") &&
      !panicActions.some((node) => node.textContent?.includes("导出诊断包")),
    `标题/码/trace=${traceOf(panic)}，动作=${panicActions.map((node) => node.textContent?.trim()).join("/")}`,
  );

  // ② 切标的后旧错误立即消失（不等下一次计算）。
  const codes = options.codes.filter((code) => code !== "测试");
  if (codes.length >= 2) {
    const before = document.querySelector("[data-calc-error]") !== null;
    options.setCode(codes[1]);
    const gone = await waitFor(
      () => (document.querySelector("[data-calc-error]") === null ? true : null),
      1_500,
    ).catch(() => false);
    push(
      "P06-R2",
      "AC-08.02-02(补2)",
      before && gone === true,
      `切到 ${codes[1]} 后错误卡消失=${gone === true}`,
    );
  } else {
    push("P06-R2", "AC-08.02-02(补2)", false, "标的不足 2 个，无法验证切标的清理");
  }

  // ③ 连续 3 次失败才出现「导出诊断包」，且每次 panic 都落 calc.panic。
  const panicBefore = (await ipc.telemetryDump(200)).counts["calc.panic"] ?? 0;
  let node = await fail("E_ENGINE_PANIC", "panic");
  node = await fail("E_ENGINE_PANIC", "panic", traceOf(node));
  node = await fail("E_ENGINE_PANIC", "panic", traceOf(node));
  const panicAfter = (await ipc.telemetryDump(200)).counts["calc.panic"] ?? 0;
  const exportButton = node.querySelector("[data-calc-export]");
  push(
    "P06-R3",
    "AC-08.02-02",
    exportButton !== null && panicAfter - panicBefore === 3,
    `第 3 次连续失败后导出按钮=${exportButton !== null}，calc.panic 新增 ${panicAfter - panicBefore} 条`,
  );

  // ④ 数据不可用：标题与「查看数据源状态」入口。
  const data = await fail("E_DATA_UNAVAILABLE", "data", traceOf(node));
  push(
    "P06-R4",
    "AC-08.02-02",
    textOf(data.querySelector("[data-calc-error-title]")) === "数据不可用" &&
      data.querySelector("[data-calc-goto-ds]") !== null,
    `标题=${textOf(data.querySelector("[data-calc-error-title]"))}，数据源入口=${data.querySelector("[data-calc-goto-ds]") !== null}`,
  );

  // ⑤ 超时：真实等待 8s，页面显示 E_TIMEOUT 与耗时，并落 calc.timeout。
  const timeoutBefore = (await ipc.telemetryDump(200)).counts["calc.timeout"] ?? 0;
  const started = performance.now();
  const timeout = await fail("E_TIMEOUT", "timeout", traceOf(data));
  const wallMs = Math.round(performance.now() - started);
  const timeoutAfter = (await ipc.telemetryDump(200)).counts["calc.timeout"] ?? 0;
  const elapsed = Number(timeout.querySelector("[data-calc-error-elapsed]")?.textContent?.match(/\d+/)?.[0] ?? 0);
  push(
    "P06-R5",
    "AC-08.02-02",
    textOf(timeout.querySelector("[data-calc-error-title]")) === "计算超时" &&
      elapsed >= 7_000 &&
      elapsed <= 9_500 &&
      wallMs >= 7_000 &&
      wallMs <= 12_000 &&
      timeoutAfter - timeoutBefore === 1,
    `标题=计算超时，elapsed=${elapsed}ms，wall=${wallMs}ms，calc.timeout 新增 ${timeoutAfter - timeoutBefore} 条`,
  );

  // ⑥ 注入关闭后恢复正常：错误卡消失。
  await options.setInject("none");
  options.trigger();
  const recovered = await waitFor(
    () => (document.querySelector("[data-calc-error]") === null ? true : null),
    5_000,
  ).catch(() => false);
  push("P06-R6", "AC-08.02-02", recovered === true, `注入关闭后错误卡消失=${recovered === true}`);

  report.ok = report.checks.every((check) => check.passed);
  report.finishedAt = new Date().toISOString();
  await ipc.diagWriteNamed("s080202-evidence.json", JSON.stringify(report, null, 2));
  return report;
}
