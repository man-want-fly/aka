#!/usr/bin/env node
/**
 * P15：S-05.01-02 取证套件门禁（制度第 29 条，W-116 同构）。
 *
 * 全部从源码派生，不维护第二份期望值：
 *   1) batchDiag.ts 里 runS050102Diagnostics 的 7 条 push 判定表达式逐条求值；
 *      正例 obs 全绿、每条断言单独构造反例 obs 必须判红（能判红 ≠ 恒真）；
 *   2) runner ↔ diag-evidence.sh case ↔ 写盘名 ↔ 卡面整 AC token 逐项闭合；
 *   3) SearchOverlay.tsx 的取证接线（AKA_DIAG_TARGET=s050102 触发）不得断。
 *
 * W-119（修 P2「同源 oracle 恒真锚点」）：
 *   旧形态的「变异锚点」是 `new Function("obs", "return true;")` —— 与被测源码无关的
 *   硬编码常量，恒等于 true，只能自证「true === true」（QA 明确不豁免）。
 *   新形态：整套判据抽成**纯函数** `runChecks(sources)`，对同一套判据跑两次：
 *     · 原样源码   → 必须判绿（failures 为空）；
 *     · 被变异源码 → 必须判红（failures 非空，且命中本变异对应的具体判据）。
 *   本门禁的变异对象是**下游判定表达式**（batchDiag.ts 的 S050102-R1 判定由 && 弱化为 ||），
 *   与 verify_p04r3_injection.mjs 的「上游注入链」不同源、不同被测常量，两处互不自证。
 *
 * 用法：node scripts/verify_s050102.mjs [--selftest]
 * 退出码：0 = 通过；1 = 任一断言失败。
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), "utf8") : "");

const ACS = [
  "AC-05.01-02",
  "AC-05.01-02（补1）",
  "AC-05.01-02（补2）",
  "AC-05.01-02（补3）",
  "AC-05.01-03",
  "AC-05.01-03（补1）",
  "AC-05.01-03（补2）",
];

// 每条断言翻转一个专属字段，制造能判红的反例 obs；R4 额外覆盖「>4 个快捷入口」。
const BAD_MUTATIONS = [
  { downSelectedSecond: false },
  { upAtFirstStaysFirst: false },
  { reopenShowsRecent: false },
  { hasRecentPlaceholder: true, shortcutCount: 5 },
  { noSkeleton: false },
  { emptyEnterNoOpen: false },
  { clearInputEmpty: false },
];

const GOOD = {
  downSelectedSecond: true,
  enterOpenedSecond: true,
  escClearedInput: true,
  upAtFirstStaysFirst: true,
  escClosedOverlay: true,
  reopenInputEmpty: true,
  reopenShowsRecent: true,
  shortcutCount: 3,
  hasRecentPlaceholder: false,
  queryPreserved: true,
  notFoundShown: true,
  clearActionShown: true,
  marketActionShown: true,
  noSkeleton: true,
  noIrrelevantResults: true,
  emptyEnterOverlayOpen: true,
  emptyEnterInputUnchanged: true,
  emptyEnterNoOpen: true,
  clearInputEmpty: true,
  clearBackToIdleRecent: true,
  clearBackToIdleShortcut: true,
};

/** 从 runner 的 push("<id>", ..., "render", <expr>, ...) 取出真实判定表达式。 */
function judgementExpr(text, id) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.includes(`"${id}"`));
  if (start < 0) return null;
  let i = start;
  while (i < lines.length && !lines[i].includes('"render",')) i += 1;
  if (i + 1 >= lines.length) return null;
  return lines[i + 1].trim().replace(/,$/, "");
}

/**
 * 门禁判据（纯函数）：输入 4 份源码，输出失败项列表。
 * 抽成纯函数 → 同一套判据既能判原样、也能判被变异的源码（变异 → 判红、原样 → 判绿）。
 */
function runChecks({ batch, diag, overlay, cards }) {
  const failures = [];
  const check = (ok, msg) => {
    if (!ok) failures.push(msg);
  };

  // ── 套件与卡面闭合 ──
  check(/export async function runS050102Diagnostics/.test(batch), "batchDiag.ts 缺 runS050102Diagnostics");
  check(/baseReport\("s050102"\)/.test(batch), "runner 未用 baseReport(\"s050102\")");
  check(/card: "S-05.01-02"/.test(batch), "runner 未声明 card: S-05.01-02");
  check(
    /writeBatchReport\("s050102-evidence\.json", "s050102"/.test(batch),
    "runner 写盘名与 suite 不一致",
  );
  check(/^  s050102\)$/m.test(diag), "diag-evidence.sh 缺 s050102 case");
  check(
    /JSON="\$DIAG_DIR\/s050102-evidence\.json"/.test(diag),
    "diag-evidence.sh 的 JSON 写盘名与 runner 不一致",
  );
  // 7 条 AC 都是卡面内整 token（全角补号），逐条核对。
  for (const ac of ACS) {
    check(cards.includes(`**${ac}**`), `卡面缺整 AC token ${ac}`);
    check(batch.includes(`"${ac}"`), `runner 未挂 ${ac}`);
  }
  // 接线：s050102 取证入口在 SearchOverlay（AKA_DIAG_TARGET=s050102 触发）不得断。
  check(
    /runS050102Diagnostics/.test(overlay) && /s050102/.test(overlay),
    "SearchOverlay.tsx 未接线 s050102 取证触发（进程起来也不会跑 diag）",
  );

  // ── 从 runner 派生 7 条判定表达式并逐条求值（W-116 judgementExpr 范式）──
  for (let n = 1; n <= 7; n += 1) {
    const id = `S050102-R${n}`;
    const expr = judgementExpr(batch, id);
    check(expr !== null, `取不到 ${id} 判定表达式`);
    if (expr === null) continue;
    let judge;
    try {
      judge = new Function("obs", `return (${expr});`);
    } catch (error) {
      check(false, `${id} 判定表达式不可求值：${error.message}`);
      continue;
    }
    check(judge(GOOD) === true, `${id} 正例 obs 未判绿（判定与 AC 口径不匹配）`);
    const bad = { ...GOOD, ...BAD_MUTATIONS[n - 1] };
    check(judge(bad) === false, `${id} 反例 obs 未判红（断言恒绿，等于没有验收）`);
  }

  return failures;
}

/**
 * 变异：把 S050102-R1 的判定表达式由「全满足」弱化为「任一满足」（&& → ||）。
 * 变异后反例 obs 会被判绿 → 门禁必须判红。
 */
function weakenR1Judgement(batch) {
  const lines = batch.split("\n");
  const start = lines.findIndex((line) => line.includes('"S050102-R1"'));
  if (start < 0) return null;
  let i = start;
  while (i < lines.length && !lines[i].includes('"render",')) i += 1;
  if (i + 1 >= lines.length) return null;
  const exprLine = lines[i + 1];
  if (!exprLine.includes("&&")) return null;
  const mutatedLine = exprLine.replace("&&", "||");
  const mutated = [...lines];
  mutated[i + 1] = mutatedLine;
  return mutated.join("\n");
}

const sources = {
  batch: read("app/src/features/qa/batchDiag.ts"),
  diag: read("app/scripts/diag-evidence.sh"),
  overlay: read("app/src/components/SearchOverlay.tsx"),
  cards: read("docs/story-cards/aka-story-cards-v0.1.md"),
};

// —— 原样：必须判绿 ——
const realFailures = runChecks(sources);

// —— 变异：必须判红，且红点落在本变异对应的判据上 ——
const mutationId = "判定弱化:batchDiag.ts/S050102-R1(&& → ||)";
const mutatedBatch = weakenR1Judgement(sources.batch);
const mutationFailures = mutatedBatch ? runChecks({ ...sources, batch: mutatedBatch }) : null;
const mutationRed =
  mutationFailures !== null &&
  mutationFailures.some((message) => message.startsWith("S050102-R1 反例 obs 未判红"));

const failures = [...realFailures];
for (const message of realFailures) console.error(`::error::P15 套件门禁失败：${message}`);
if (mutationFailures === null) {
  failures.push(`变异未落到源码上：${mutationId}`);
  console.error(`::error::P15 套件门禁失败：变异未落到源码上：${mutationId}`);
} else if (!mutationRed) {
  failures.push(`变异未判红：${mutationId}`);
  console.error(
    `::error::P15 套件门禁失败：变异未判红：${mutationId} —— ` +
      `实际失败项：${mutationFailures.join("；") || "无"}`,
  );
}

if (process.argv.includes("--selftest")) {
  if (failures.length > 0) {
    console.error("::error::P15 套件门禁 selftest 失败");
    process.exit(1);
  }
  console.log("verify:s050102 selftest 通过：原样判绿 + 1/1 变异判红（双向成立）");
} else if (failures.length > 0) {
  console.error(`verify:s050102 失败：${failures.length} 项`);
  process.exit(1);
} else {
  console.log(
    "P15 套件门禁通过：s050102 runner / case / 写盘名 / 7 条整 AC token / SearchOverlay 接线闭合；" +
      "7 条判定正例绿、逐条反例红；原样判绿 + 1/1 变异判红（变异对象＝下游判定表达式，" +
      "与 verify:p04r3 的上游注入链不同源）。",
  );
}
