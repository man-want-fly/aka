#!/usr/bin/env node
// W-119：S-02.08-01 / AC-02.08-01（补2）「只缺 sha256、其余 6 段正常」的产品侧单元测试。
//
// 与 verify_w116_injection.mjs 的分工：
// - verify_w116_injection.mjs 校验「注入链路 + 断言表达式自洽」（静态派生，判据在 batchDiag.ts）；
// - 本脚本校验「产品实现真的能产出满足该断言的页脚」（真值跑 datasetOverview.ts）。
//
// 关键点：判定表达式从 batchDiag.ts 现场派生（不维护第二份期望值），
// 求值对象是 datasetOverview.ts 的真实输出；注入样本 = manifest 只清 sha256、其余 8 字段原样。
//
// 运行：node scripts/selftest_dataset_overview.mjs

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build as esbuildBuild } from "esbuild";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const APP = join(HERE, "..");
const read = (rel) => readFileSync(join(APP, rel), "utf8");

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

// ---------- 载入产品实现（真值，不复制逻辑） ----------
const workdir = mkdtempSync(join(tmpdir(), "aka-dataset-overview-"));
const bundle = join(workdir, "datasetOverview.mjs");
await esbuildBuild({
  entryPoints: [join(APP, "src/features/workbench/datasetOverview.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundle,
  logLevel: "silent",
});
const { datasetSegments, DATASET_SEGMENTS } = await import(pathToFileURL(bundle).href);

/** 从 batchDiag.ts 现场取判定表达式（与 verify_w116_injection.mjs 同口径）。 */
function judgementExpr(text, id) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.includes(`"${id}"`));
  if (start < 0) return null;
  let i = start;
  while (i < lines.length && !lines[i].includes('"render",')) i += 1;
  if (i + 1 >= lines.length) return null;
  return lines[i + 1].trim().replace(/,$/, "");
}

const expr = judgementExpr(read("src/features/qa/batchDiag.ts"), "S0208-P2R");
check(expr !== null, "batchDiag.ts 取不到 S0208-P2R 判定表达式");
const judge = expr === null ? null : new Function("segments", `return (${expr});`);

/** W-116 注入样本：manifest 只清 sha256，其余 8 字段原样。 */
const INJECTED_MANIFEST = {
  datasetId: "sim-20241227-7f3a",
  dataVersion: "1.0.0",
  rowCount: 62400,
  coverageStart: "2023-01-02",
  coverageEnd: "2024-12-27",
  seed: 42,
  sha256: "",
  provider: "sim",
  generatedAt: 0,
};
const FULL_MANIFEST = { ...INJECTED_MANIFEST, sha256: "7f3a9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" };

const segmentsOf = (manifest, extra = {}) =>
  datasetSegments({
    manifest,
    adj: "qfq",
    timeframe: "D",
    computedMs: 12,
    cacheHit: true,
    loading: false,
    manifestPending: false,
    calcPending: false,
    ...extra,
  });

/** runner 的观察形状（batchDiag.ts 的 qa("[data-dataset-seg]") 映射）。 */
const observe = (segments) =>
  segments.map((segment) => ({
    key: segment.key,
    missing: segment.missing === true,
    text: segment.text,
  }));

// ---------- 1) 段序与段数：卡面 7 段 ----------
const injected = segmentsOf(INJECTED_MANIFEST);
check(injected.length === 7, `页脚必须是 7 段，实际 ${injected.length}`);
check(
  injected.every((segment, index) => segment.key === DATASET_SEGMENTS[index]),
  `段序必须与 DATASET_SEGMENTS 一致，实际 ${injected.map((s) => s.key).join("/")}`,
);

// ---------- 2) 注入样本：只缺 version 一段，其余 6 段正常 ----------
const injectedObserved = observe(injected);
const missingKeys = injectedObserved.filter((s) => s.missing).map((s) => s.key);
check(
  missingKeys.length === 1 && missingKeys[0] === "version",
  `注入样本必须只缺 version 一段，实际缺「${missingKeys.join(",") || "无"}」`,
);
check(
  injectedObserved.filter((s) => !s.missing).length === 6,
  `注入样本其余 6 段必须正常，实际正常 ${injectedObserved.filter((s) => !s.missing).length} 段`,
);
check(
  injectedObserved.find((s) => s.key === "version")?.text === "—",
  "version 段缺 sha256 时必须显示 —",
);
const expectTexts = {
  provider: "sim",
  adj: "前复权",
  timeframe: "日线",
  range: "2023-01-02 ~ 2024-12-27",
  rows: "62,400 行",
};
for (const [key, text] of Object.entries(expectTexts)) {
  check(
    injectedObserved.find((s) => s.key === key)?.text === text,
    `${key} 段应为「${text}」，实际「${injectedObserved.find((s) => s.key === key)?.text}」`,
  );
}
check(
  /^\d+\.\d+ms · 缓存命中$/.test(injectedObserved.find((s) => s.key === "calc")?.text ?? ""),
  `calc 段应为「{ms}ms · 缓存命中」，实际「${injectedObserved.find((s) => s.key === "calc")?.text}」`,
);

// ---------- 3) 用 batchDiag.ts 的真实判定表达式求值 ----------
if (judge !== null) {
  check(judge(injectedObserved) === true, "注入样本下 S0208-P2R 未判绿：产品实现仍不满足断言");
  check(
    judge(observe(segmentsOf(FULL_MANIFEST))) === false,
    "未注入样本下 S0208-P2R 必须判红：断言被写成恒真，等于没有验收",
  );
  check(
    judge(observe(segmentsOf(null, { manifestPending: true }))) === false,
    "页脚未就绪时 S0208-P2R 必须判红：不能把「还没拿到」当成「只缺一段」",
  );
}

// ---------- 4) 未就绪 ≠ 字段缺失 ----------
const pending = segmentsOf(null, { manifestPending: true });
const pendingObserved = observe(pending);
check(
  pendingObserved.filter((s) => s.missing).length === 0,
  `manifest 未到时不得标记字段缺失，实际缺「${pendingObserved.filter((s) => s.missing).map((s) => s.key).join(",") || "无"}」`,
);
check(
  pending.every((segment) => segment.pending === true || segment.key === "adj" || segment.key === "timeframe" || segment.key === "calc"),
  "manifest 未到时，manifest 派生段必须标记 pending",
);
check(
  pendingObserved.find((s) => s.key === "provider")?.text === "加载中",
  "manifest 未到时 provider 段应显示「加载中」而不是「—」",
);

// ---------- 5) 正常样本：0 缺失、7 段齐全 ----------
const full = observe(segmentsOf(FULL_MANIFEST));
check(full.filter((s) => s.missing).length === 0, "正常样本不应有缺失段");
check(full.find((s) => s.key === "version")?.text === "7f3a9c1d", "version 段应显示 sha256 前 8 位");

// ---------- 6) 计算未完成：显示「计算中」，不算字段缺失 ----------
const calcPending = observe(segmentsOf(FULL_MANIFEST, { computedMs: null, calcPending: true }));
check(
  calcPending.find((s) => s.key === "calc")?.text === "计算中",
  "计算未完成时计算段应显示「计算中」",
);
check(
  calcPending.find((s) => s.key === "calc")?.missing === false,
  "计算未完成不算 manifest 字段缺失",
);

rmSync(workdir, { recursive: true, force: true });

if (failures.length > 0) {
  for (const message of failures) console.error(`::error::页脚单元测试失败：${message}`);
  process.exit(1);
}
console.log(
  "页脚单元测试通过：7 段段序与卡面一致；注入样本（manifest 只清 sha256）只缺 version 一段、其余 6 段正常；" +
    "batchDiag.ts 的 S0208-P2R 判定表达式对注入样本判绿、对未注入样本与未就绪样本判红（断言非恒真）；" +
    "「未就绪」与「字段缺失」已区分。",
);
