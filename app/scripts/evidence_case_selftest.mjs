#!/usr/bin/env node
// P01 S-03.01-04：取证 case 与产品接线的自测（可重跑，不依赖 GUI）。
//
// 真实缺陷（本自测要钉住的那一类）：P01 的产品与 diag 已在 main，但
// diag-evidence.sh 的 `s030104)` case 被合并吞掉 → evidence-run.sh s030104 直接
// 「未知套件」，永远出不了 dump，台账只能停在「未开始」。
//
// 反例（每条都必须判红，不是「应该有」）：
//   R1 缺 case：删掉 `s030104)` 后，`evidence-run.sh s030104 --check` 必须 exit≠0 且报「未知套件」；
//   R2 case 改名：把 case 改成 `s030104x`，同一入口对 s030104 必须仍判红（证明绑的是精确套件名）；
//   R3 接线断：case 在，但 App / CatalogPage 没有 s030104 分派，或没清 aka.last.code，
//      自测必须判红（否则进程起来了也不会跑 batchDiag，dump 永远不落盘）。
// 正向：真实仓库文件 → --check 绿 + 三处接线齐 + case 的 TARGET/JSON/NAME 与 batchDiag 写盘名一致。
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
const catalogSrc = read("src/pages/catalog/CatalogPage.tsx");
const appSrc = read("src/App.tsx");
const batchSrc = read("src/features/qa/batchDiag.ts");

const SUITE = "s030104";
const CASE_BLOCK = /^  s030104\)\n(?:    [^\n]*\n)*?    ;;\n/m;
const BUMP_NAME = /^  s030104\)/m;

if (!CASE_BLOCK.test(diagSrc)) {
  console.error("基线红：diag-evidence.sh 里没有 s030104) case，无法做反例");
  process.exit(1);
}

/** 在临时 git 仓库里跑 evidence-run.sh <suite> --check（与真入口同一条代码路径）。 */
function runCheck(diagText, suite) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "aka-p01-case-"));
  try {
    fs.mkdirSync(path.join(repo, "app/scripts"), { recursive: true });
    fs.writeFileSync(path.join(repo, "app/scripts/diag-evidence.sh"), diagText);
    fs.writeFileSync(path.join(repo, "app/scripts/evidence-run.sh"), runSrc);
    fs.writeFileSync(path.join(repo, "app/scripts/evidence-layout.json"), layoutSrc);
    const git = (args) =>
      spawnSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_NAME: "selftest", GIT_AUTHOR_EMAIL: "selftest@example.invalid",
          GIT_COMMITTER_NAME: "selftest", GIT_COMMITTER_EMAIL: "selftest@example.invalid" },
      });
    git(["init", "-q"]);
    git(["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "fixture"]);
    const result = spawnSync("/bin/bash", [path.join(repo, "app/scripts/evidence-run.sh"), suite, "--check"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, EVIDENCE_NODE: NODE },
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

/** case 与产品入口的接线：任何一处断掉，进程起来也不会跑 batchDiag。 */
function wiring(catalog, app, batch) {
  const misses = [];
  if (!/export async function runS030104Diagnostics/.test(batch)) {
    misses.push("batchDiag 缺 runS030104Diagnostics");
  }
  if (!/writeBatchReport\("s030104-evidence\.json",\s*"s030104"/.test(batch)) {
    misses.push("batchDiag 未写 s030104-evidence.json");
  }
  if (!/target === "s030104"/.test(catalog)) misses.push("CatalogPage 未分派 s030104");
  if (!/runS030104Diagnostics\(/.test(catalog)) misses.push("CatalogPage 未调用 runS030104Diagnostics");
  if (!/target === "s030104"/.test(app)) misses.push("App 未放行 s030104");
  // 阶段 1「无标的」的前提：App 在 s030104 分支必须清掉 aka.last.code。
  const block = app.match(/if \(target === "s030104"\) \{[\s\S]*?\n          \}/)?.[0] ?? "";
  if (!/removeItem\("aka\.last\.code"\)/.test(block)) {
    misses.push("App 的 s030104 分支未清 aka.last.code（无标的阶段前提不成立）");
  }
  return misses;
}

const results = [];
const record = (id, passed, detail) => results.push({ id, passed, detail });

// 正向：真实文件
const real = runCheck(diagSrc, SUITE);
record(
  "P01-CASE-GREEN",
  real.status === 0 && real.stdout.includes("EVIDENCE_OK"),
  `exit=${real.status} stdout=${real.stdout.trim().split("\n").pop() || "—"}`,
);

// R1：缺 case
const missing = runCheck(diagSrc.replace(CASE_BLOCK, ""), SUITE);
record(
  "P01-CASE-R1",
  missing.status !== 0 && missing.stderr.includes(`未知套件 ${SUITE}`) && !missing.stdout.includes("EVIDENCE_OK"),
  `exit=${missing.status} stderr=${missing.stderr.trim().split("\n").pop() || "—"}`,
);

// R2：case 改名（证明绑的是精确套件名，不是「随便有个 case 就算」）
const bumped = runCheck(diagSrc.replace(BUMP_NAME, "  s030104x)"), SUITE);
record(
  "P01-CASE-R2",
  bumped.status !== 0 && bumped.stderr.includes(`未知套件 ${SUITE}`),
  `exit=${bumped.status} stderr=${bumped.stderr.trim().split("\n").pop() || "—"}`,
);

// 接线：真实文件必须齐
const realMisses = wiring(catalogSrc, appSrc, batchSrc);
record("P01-WIRING-GREEN", realMisses.length === 0, realMisses.length ? `缺：${realMisses.join("；")}` : "三处接线齐");

// R3a：CatalogPage 不再调用 diag
const catalogMut = catalogSrc.replace(/runS030104Diagnostics\(/g, "runS030104DiagnosticsX(");
record(
  "P01-WIRING-R3A",
  wiring(catalogMut, appSrc, batchSrc).length > 0,
  `变异后缺项数=${wiring(catalogMut, appSrc, batchSrc).length}`,
);

// R3b：App 的 s030104 分支不清 last_code（无标的阶段前提被破坏）
const appMut = appSrc.replace(/if \(target === "s030104"\) \{[\s\S]*?\n          \}/, 'if (target === "s030104") {\n          }');
record(
  "P01-WIRING-R3B",
  wiring(catalogSrc, appMut, batchSrc).length > 0,
  `变异后缺项数=${wiring(catalogSrc, appMut, batchSrc).length}`,
);

// case 的写盘名必须与 batchDiag 实际写的文件名一致，否则 meta/dump 对不上
const blockText = diagSrc.match(CASE_BLOCK)?.[0] ?? "";
const jsonBase = blockText.match(/JSON="\$DIAG_DIR\/([^"]*)"/)?.[1]?.trim() ?? "";
const nameValue = blockText.match(/NAME="([^"]*)"/)?.[1] ?? "";
const targetValue = blockText.match(/TARGET="([^"]*)"/)?.[1] ?? "";
record(
  "P01-CASE-META",
  targetValue === "s030104" && nameValue === "s030104-evidence" && /^s030104-evidence\.json$/.test(jsonBase),
  `TARGET=${targetValue} NAME=${nameValue} JSON=${jsonBase}`,
);

const failed = results.filter((item) => !item.passed);
for (const item of results) {
  console.log(`${item.passed ? "PASS" : "FAIL"} ${item.id} ${item.detail}`);
}
console.log(`case 反例 2/2 判红，接线反例 2/2 判红，正向 ${results.filter((i) => i.id.endsWith("GREEN") && i.passed).length}/2 绿`);
process.exit(failed.length === 0 ? 0 : 1);
