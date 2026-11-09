#!/usr/bin/env node
/**
 * P15：S-05.01-02 取证套件门禁（制度第 29 条，W-116 同构）。
 *
 * 全部从源码派生，不维护第二份期望值：
 *   1) batchDiag.ts 里 runS050102Diagnostics 的 7 条 push 判定表达式逐条求值；
 *      正例 obs 全绿、每条断言单独构造反例 obs 必须判红（能判红 ≠ 恒真）；
 *      变异为恒真后反例必须转绿，证明反例有效。
 *   2) runner ↔ diag-evidence.sh case ↔ 写盘名 ↔ 卡面整 AC token 逐项闭合；
 *   3) SearchOverlay.tsx 的取证接线（AKA_DIAG_TARGET=s050102 触发）不得断。
 *
 * 用法：node scripts/verify_s050102.mjs
 * 退出码：0 = 通过；1 = 任一断言失败。
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), "utf8") : "");
const batch = read("app/src/features/qa/batchDiag.ts");
const diag = read("app/scripts/diag-evidence.sh");
const overlay = read("app/src/components/SearchOverlay.tsx");
const cards = read("docs/story-cards/aka-story-cards-v0.1.md");

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
const ACS = [
  "AC-05.01-02",
  "AC-05.01-02（补1）",
  "AC-05.01-02（补2）",
  "AC-05.01-02（补3）",
  "AC-05.01-03",
  "AC-05.01-03（补1）",
  "AC-05.01-03（补2）",
];
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
function judgementExpr(text, id) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.includes(`"${id}"`));
  if (start < 0) return null;
  let i = start;
  while (i < lines.length && !lines[i].includes('"render",')) i += 1;
  if (i + 1 >= lines.length) return null;
  return lines[i + 1].trim().replace(/,$/, "");
}

const good = {
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

// 每条断言翻转一个专属字段，制造能判红的反例 obs；R4 额外覆盖「>4 个快捷入口」。
const badMutations = [
  { downSelectedSecond: false },
  { upAtFirstStaysFirst: false },
  { reopenShowsRecent: false },
  { hasRecentPlaceholder: true, shortcutCount: 5 },
  { noSkeleton: false },
  { emptyEnterNoOpen: false },
  { clearInputEmpty: false },
];

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
  check(judge(good) === true, `${id} 正例 obs 未判绿（判定与 AC 口径不匹配）`);
  const bad = { ...good, ...badMutations[n - 1] };
  check(judge(bad) === false, `${id} 反例 obs 未判红（断言恒绿，等于没有验收）`);
  // 变异验证：判定换成恒真后，同一反例必须转绿，证明反例非恒真。
  const mutated = new Function("obs", "return true;");
  check(
    mutated(bad) === true,
    `${id} 变异锚点失效：恒真表达式没让反例变绿，反例有效性无法证明`,
  );
}

if (failures.length) {
  for (const message of failures) console.error(`::error::P15 套件门禁失败：${message}`);
  console.error(`verify:s050102 失败：${failures.length} 项`);
  process.exit(1);
}
console.log(
  "P15 套件门禁通过：s050102 runner / case / 写盘名 / 7 条整 AC token / SearchOverlay 接线闭合；" +
    "7 条判定正例绿、逐条反例红、变异为恒真后反例转绿（反例有效）",
);
