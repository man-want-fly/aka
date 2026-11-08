#!/usr/bin/env node
// 取证 case 与产品接线的自测（可重跑，不依赖 GUI）。
//
// 事故：S-03.01-04 / S-03.02-01 / S-03.03-02 / S-06.03-01 的产品与 diag 早在
// adef5b7 就在 main，但 diag-evidence.sh 的 case 在合并解冲突时被批量吞掉 →
// evidence-run.sh 直接「未知套件」，卡在 main、台账「未开始」、gate-log 无行。
//
// 每个套件三条反例，缺一条都不算证明：
//   R1 缺 case       → evidence-run.sh <suite> --check 必须 exit≠0 +「未知套件」；
//   R2 case 改名      → 同一入口对原 suite 必须仍判红（绑精确套件名）；
//   R3 接线断        → 页面不再调用 runner 时自测必须判红（否则进程起来也不跑 diag）。
// 正向：真实仓库 → --check 绿 + 接线齐 + case 写盘名与 batchDiag 一致。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const APP = path.resolve(HERE, "..");
const NODE = process.execPath;

const read = (rel) => fs.readFileSync(path.join(APP, rel), "utf8");
const diagSrc = read("scripts/diag-evidence.sh");
const runSrc = read("scripts/evidence-run.sh");
const layoutSrc = read("scripts/evidence-layout.json");
const appSrc = read("src/App.tsx");
const batchSrc = read("src/features/qa/batchDiag.ts");
const pageSrc = {
  catalog: read("src/pages/catalog/CatalogPage.tsx"),
  workbench: read("src/pages/workbench/WorkbenchPage.tsx"),
  settings: read("src/pages/settings/SettingsPage.tsx"),
};

const SUITES = [
  { suite: "s030104", runner: "runS030104Diagnostics", file: "s030104-evidence.json", page: "catalog" },
  { suite: "s030201", runner: "runS030201Diagnostics", file: "s030201-favorites-evidence.json", page: "catalog" },
  { suite: "s030302-catalog", runner: "runS030302CatalogDiagnostics", file: "s030302-catalog-evidence.json", page: "catalog" },
  { suite: "s030302", runner: "runS030302WorkbenchDiagnostics", file: "s030302-evidence.json", page: "workbench" },
  { suite: "s060301", runner: "runS060301Diagnostics", file: "s060301-about-evidence.json", page: "settings" },
];

/** 逐行扫到 `    ;;`（case 块里可能嵌 python heredoc，不能按「每行 4 空格」匹配）。 */
function caseBlock(text, suite) {
  const lines = text.split("\n");
  const head = `  ${suite})`;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] !== head) continue;
    let j = i + 1;
    while (j < lines.length && lines[j] !== "    ;;") j += 1;
    const block = lines.slice(i, j + 1).join("\n");
    return { block, json: block.match(/JSON="\$DIAG_DIR\/([^"]*)"/)?.[1] ?? null };
  }
  return null;
}

function withoutCase(text, suite) {
  const hit = caseBlock(text, suite);
  return hit ? text.replace(`${hit.block}\n`, "") : text;
}

function renameCase(text, suite) {
  return text.replace(`  ${suite})\n`, `  ${suite}x)\n`);
}

/** 在临时 git 仓库里跑 evidence-run.sh <suite> --check（与真入口同一条代码路径）。 */
function runCheck(diagText, suite) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "aka-case-"));
  try {
    fs.mkdirSync(path.join(repo, "app/scripts"), { recursive: true });
    fs.writeFileSync(path.join(repo, "app/scripts/diag-evidence.sh"), diagText);
    fs.writeFileSync(path.join(repo, "app/scripts/evidence-run.sh"), runSrc);
    fs.writeFileSync(path.join(repo, "app/scripts/evidence-layout.json"), layoutSrc);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "selftest", GIT_AUTHOR_EMAIL: "selftest@example.invalid",
      GIT_COMMITTER_NAME: "selftest", GIT_COMMITTER_EMAIL: "selftest@example.invalid",
    };
    const git = (args) => spawnSync("git", args, { cwd: repo, encoding: "utf8", env });
    git(["init", "-q"]);
    git(["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "fixture"]);
    const result = spawnSync("/bin/bash", [path.join(repo, "app/scripts/evidence-run.sh"), suite, "--check"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, EVIDENCE_NODE: NODE },
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

/** case ↔ 产品入口接线：任何一处断掉，进程起来也不会跑 batchDiag。 */
function wiring(item, override) {
  const batch = override?.batch ?? batchSrc;
  const app = override?.app ?? appSrc;
  const page = override?.page ?? pageSrc[item.page];
  const misses = [];
  if (!new RegExp(`export async function ${item.runner}`).test(batch)) misses.push(`${item.runner} 缺失`);
  if (!new RegExp(`writeBatchReport\\("${item.file}",\\s*"${item.suite}"`).test(batch)) {
    misses.push(`未写 ${item.file}`);
  }
  if (!new RegExp(`${item.runner}\\(`).test(page)) misses.push(`页面未调用 ${item.runner}`);
  if (!new RegExp(`target === "${item.suite}"`).test(app)) misses.push(`App 未放行 ${item.suite}`);
  return misses;
}

const results = [];
const record = (id, passed, detail) => results.push({ id, passed, detail });

for (const item of SUITES) {
  const real = runCheck(diagSrc, item.suite);
  record(
    `${item.suite}:GREEN`,
    real.status === 0 && real.stdout.includes("EVIDENCE_OK"),
    `exit=${real.status} ${real.stdout.trim().split("\n").pop() || "—"}`,
  );

  const missing = runCheck(withoutCase(diagSrc, item.suite), item.suite);
  record(
    `${item.suite}:R1-MISSING`,
    missing.status !== 0 && missing.stderr.includes(`未知套件 ${item.suite}`) && !missing.stdout.includes("EVIDENCE_OK"),
    `exit=${missing.status} ${missing.stderr.trim().split("\n").pop() || "—"}`,
  );

  const bumped = runCheck(renameCase(diagSrc, item.suite), item.suite);
  record(
    `${item.suite}:R2-RENAMED`,
    bumped.status !== 0 && bumped.stderr.includes(`未知套件 ${item.suite}`),
    `exit=${bumped.status} ${bumped.stderr.trim().split("\n").pop() || "—"}`,
  );

  const realMisses = wiring(item);
  record(
    `${item.suite}:WIRING`,
    realMisses.length === 0 && caseBlock(diagSrc, item.suite)?.json === item.file,
    realMisses.length
      ? `缺：${realMisses.join("；")}`
      : `接线齐，JSON=${caseBlock(diagSrc, item.suite)?.json}`,
  );

  const brokenPage = pageSrc[item.page].replace(new RegExp(`${item.runner}\\(`, "g"), `${item.runner}X(`);
  record(
    `${item.suite}:R3-UNWIRED`,
    wiring(item, { page: brokenPage }).length > 0,
    `变异后缺项数=${wiring(item, { page: brokenPage }).length}`,
  );
}

const failed = results.filter((item) => !item.passed);
for (const item of results) console.log(`${item.passed ? "PASS" : "FAIL"} ${item.id} ${item.detail}`);
console.log(`套件 ${SUITES.length} 个：反例 ${SUITES.length * 3}/${SUITES.length * 3} 判红，正向 ${SUITES.length}/${SUITES.length} 绿`);
process.exit(failed.length === 0 ? 0 : 1);
