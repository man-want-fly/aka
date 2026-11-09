#!/usr/bin/env node
// 卡 ↔ 套件 case 集合比对（P01 事故的根因检查）。
//
// 事故：S-03.01-04 的产品与 diag 早在 adef5b7 就在 main，但 diag-evidence.sh 的
// `s030104)` case 在合并解冲突时被吞掉 → evidence-run.sh 直接「未知套件」，
// 卡在 main、台账「未开始」、gate-log 无行。没有任何检查把「卡」和「套件 case」对上。
//
// 事实源（两处都不许由被校验的数据自证）：
//   1) 产品里的取证入口：batchDiag 每个 `export async function run*Diagnostics` 都有
//      `baseReport("<suite>")` + `card: "S-.."`。这是「卡已在 main」的可执行证据。
//   2) diag-evidence.sh 的 `  <suite>)` case 分支。这是「出得了证据」的唯一入口。
//
// 红判据：
//   R1 有 runner 没 case            → 卡在 main 但出不了证据（本次事故）；
//   R2 case 的 JSON 写盘名与 runner 不一致 → 跑完也找不到 dump；
//   R3 runner 的 card 不在卡面      → 幻影卡，证据无法归属；
//   R4 runner 的 card 卡面没有渲染/运行/数据层 AC → 该卡不该有 diag。
//
// 用法：node scripts/verify_evidence_suites.mjs [--app=<app 目录>] [--card=<卡面 md>]
// 单测：scripts/evidence_suites_selftest.mjs（临时夹具，不依赖真实仓库状态）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const argValue = (name) => {
  const hit = process.argv.slice(2).find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const APP = argValue("app") ? path.resolve(argValue("app")) : path.resolve(HERE, "..");
const CARD_DOC = argValue("card")
  ? path.resolve(argValue("card"))
  : path.join(ROOT, "docs", "story-cards", "aka-story-cards-v0.1.md");

const BATCH = path.join(APP, "src", "features", "qa", "batchDiag.ts");
const DIAG = path.join(APP, "scripts", "diag-evidence.sh");

const fail = (message) => {
  console.error(`EVIDENCE_FAIL: ${message}`);
  process.exit(2);
};

for (const [label, file] of [["batchDiag.ts", BATCH], ["diag-evidence.sh", DIAG], ["卡面", CARD_DOC]]) {
  if (!fs.existsSync(file)) fail(`缺 ${label}：${file}`);
}

// —— 卡面：卡 id + 该卡是否有可取证的 AC 层 ——
const cardText = fs.readFileSync(CARD_DOC, "utf8");
const headings = [...cardText.matchAll(/^#{2,4}\s+(S-\d{2}\.\d{2}-\d{2})/gm)];
const cardSet = new Set();
const cardLayers = new Map();
headings.forEach((match, index) => {
  const section = cardText.slice(
    match.index,
    index + 1 < headings.length ? headings[index + 1].index : cardText.length,
  );
  cardSet.add(match[1]);
  cardLayers.set(match[1], /\[(渲染层|运行层|数据层)\]/.test(section));
});
if (cardSet.size === 0) fail(`卡面解析不出卡 id：${CARD_DOC}`);

// —— 产品：每个 run*Diagnostics 写的 suite / 文件 / card ——
const batchText = fs.readFileSync(BATCH, "utf8");
const writers = new Map();
for (const chunk of batchText.split(/\nexport async function /)) {
  const suite = chunk.match(/baseReport\("([^"]+)"\)/)?.[1];
  if (!suite) continue;
  const card = chunk.match(/card: "(S-\d{2}\.\d{2}-\d{2})"/)?.[1] ?? null;
  const file = chunk.match(/writeBatchReport\("([^"]+)"/)?.[1] ?? null;
  writers.set(suite, { card, file });
}
if (writers.size === 0) fail("batchDiag.ts 里没有 baseReport(\"<suite>\") 的取证 runner");

// —— 脚本：case 分支及其 JSON 写盘名 ——
const diagText = fs.readFileSync(DIAG, "utf8");
const caseBlocks = new Map();
// case 块里可能嵌 python heredoc（行首无缩进），不能按「每行 4 空格」正则匹配；
// 逐行扫到 `    ;;` 为止，才是与 bash 解析一致的边界。
const diagLines = diagText.split("\n");
for (let i = 0; i < diagLines.length; i += 1) {
  const head = diagLines[i].match(/^  ([a-z0-9-]+)\)$/);
  if (!head) continue;
  const body = [];
  let j = i + 1;
  while (j < diagLines.length && diagLines[j] !== "    ;;") {
    body.push(diagLines[j]);
    j += 1;
  }
  caseBlocks.set(head[1], {
    json: body.join("\n").match(/JSON="\$DIAG_DIR\/([^"]*)"/)?.[1] ?? null,
  });
  i = j;
}

const failures = [];
for (const suite of [...writers.keys()].sort()) {
  const { card, file } = writers.get(suite);
  const block = caseBlocks.get(suite);
  if (!block) {
    failures.push(
      `缺 case：${suite}（card ${card ?? "未声明"}）→ 卡在 main 但出不了证据` +
        `（evidence-run.sh ${suite} 会报「未知套件」）`,
    );
    continue;
  }
  if (card && !cardSet.has(card)) {
    failures.push(`幻影卡：${suite} 声明 card=${card}，卡面没有这张卡`);
  } else if (card && !cardLayers.get(card)) {
    failures.push(`不该有 diag：${suite} 的 card=${card} 卡面没有 [渲染层]/[运行层]/[数据层] AC`);
  }
  if (file && block.json !== file) {
    failures.push(
      `写盘名不一致：${suite} case 的 JSON=${block.json ?? "（缺）"}，` +
        `batchDiag 实际写 ${file}（跑完也找不到 dump）`,
    );
  }
}

if (failures.length) {
  for (const message of failures) console.error(`FAILED ${message}`);
  console.error(`取证套件门禁：runner 套件 ${writers.size} 个，缺失/不一致 ${failures.length} 项`);
  process.exit(2);
}

console.log(
  `取证套件门禁：runner 套件 ${writers.size} 个，全部有 case；` +
    `卡 ${cardSet.size} 张，写盘名与 runner 一致`,
);
