/**
 * 证据归属门禁（W-60 / W-67 / W-68）
 *
 * 断言：
 *   1. 归属闭合：set(checks.card) 必须等于 {result.card} ∪ otherCards[].card；
 *      多一张未声明的卡、少一张已声明的卡，都失败。
 *   2. 逐卡现算：result.layers 与每条 otherCards[].layers 都由 checks 按 card+layer
 *      现算比对；声明分母合计 != checks.length 直接失败，不再降级为 warning。
 *   3. 旧格式冻结：白名单（文件名 + sha256）之外任何 check 缺 `card` 即失败；
 *      白名单文件内容改动（hash 不符）即失败；deadline 之后一律失败。
 *   4. ac 口径：以 `AC-` 开头必须命中该 check 所属卡的卡面 AC 段；
 *      含 `·` 的卡面锚点必须命中卡面全文。
 *
 * 用法：node scripts/verify_evidence.mjs [--dir=证据目录]（--dir 仅供负例自测）
 * 退出码：0 = 通过；1 = 任一断言失败。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const CARD_DOC = path.join(ROOT, "docs", "story-cards", "aka-story-cards-v0.1.md");
const WHITELIST_PATH = path.join(HERE, "evidence-legacy-whitelist.json");

const argv = process.argv.slice(2);
const dirArg = argv.find((item) => item.startsWith("--dir="));
const EVIDENCE_DIR = dirArg
  ? path.resolve(dirArg.slice("--dir=".length))
  : path.join(ROOT, "docs", "qa", "evidence");

const cardText = fs.readFileSync(CARD_DOC, "utf8");
const HEADING = /^#{2,4}\s+(S-\d{2}\.\d{2}-\d{2})/gm;
const heads = [...cardText.matchAll(HEADING)];
const CARD_SET = new Set();
const CARD_SECTION = new Map();
heads.forEach((match, index) => {
  const start = match.index;
  const end = index + 1 < heads.length ? heads[index + 1].index : cardText.length;
  CARD_SET.add(match[1]);
  CARD_SECTION.set(match[1], cardText.slice(start, end));
});

if (CARD_SET.size === 0) {
  console.error(`未能从 ${path.relative(ROOT, CARD_DOC)} 解析出任何卡片 id`);
  process.exit(1);
}

const whitelist = JSON.parse(fs.readFileSync(WHITELIST_PATH, "utf8"));
const deadline = String(whitelist.deadline ?? "");
const today = new Date().toISOString().slice(0, 10);
const legacyAllowed = Boolean(deadline) && today <= deadline;

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const stable = (layers) =>
  JSON.stringify(Object.keys(layers).sort().map((key) => [key, layers[key]]));

const countLayers = (list) => {
  const counted = {};
  for (const check of list) {
    const hit = (counted[check.layer] ??= { passed: 0, total: 0 });
    hit.total += 1;
    if (check.passed) hit.passed += 1;
  }
  const out = {};
  for (const [layer, hit] of Object.entries(counted)) {
    out[layer] = `${hit.passed}/${hit.total}`;
  }
  return out;
};

const sumTotals = (layers) =>
  Object.values(layers ?? {}).reduce((acc, value) => {
    const [, total] = String(value).split("/");
    return acc + (Number(total) || 0);
  }, 0);

const failures = [];
const warnings = [];
let scanned = 0;
let frozen = 0;

for (const file of fs.readdirSync(EVIDENCE_DIR).sort()) {
  if (!file.endsWith(".json") || file.endsWith("-meta.json")) continue;
  const full = path.join(EVIDENCE_DIR, file);
  let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (error) {
    failures.push(`${file}: JSON 解析失败（${error.message}）`);
    continue;
  }
  if (!Array.isArray(evidence.checks) || evidence.checks.some((item) => typeof item !== "object")) {
    continue;
  }
  scanned += 1;

  // 旧格式冻结：白名单命中则按 hash 锁死，截止日后一律红。
  const freezeHash = whitelist.files?.[file];
  if (freezeHash) {
    if (!legacyAllowed) {
      failures.push(`${file}: 旧格式白名单已于 ${deadline} 截止，必须迁移结构化归属`);
      continue;
    }
    const actual = sha256(full);
    if (actual !== freezeHash) {
      failures.push(`${file}: 冻结白名单 hash 不符（文件被改动），旧格式不许借壳续命`);
      continue;
    }
    frozen += 1;
    warnings.push(`${file}: 旧格式冻结（白名单命中，截止 ${deadline}）`);
    continue;
  }

  const missingCard = evidence.checks.filter((check) => !check.card);
  if (missingCard.length > 0) {
    failures.push(`${file}: ${missingCard.length} 条 check 缺 card 且不在冻结白名单`);
    continue;
  }
  for (const check of evidence.checks) {
    if (!CARD_SET.has(check.card)) {
      failures.push(`${file}: check ${check.id} 的 card=${check.card} 不在卡集`);
    }
  }

  const metaPath = full.replace(/\.json$/, "-meta.json");
  if (!fs.existsSync(metaPath)) {
    failures.push(`${file}: 无 meta，无法闭合归属`);
    continue;
  }
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch (error) {
    failures.push(`${file}-meta: JSON 解析失败（${error.message}）`);
    continue;
  }
  const result = meta.result && typeof meta.result === "object" ? meta.result : {};
  if (!result.card) {
    failures.push(`${file}-meta: 缺 result.card，无法闭合归属`);
    continue;
  }
  if (!CARD_SET.has(result.card)) {
    failures.push(`${file}-meta: result.card=${result.card} 不在卡集`);
    continue;
  }

  const otherCards = Array.isArray(result.otherCards) ? result.otherCards : [];
  const declaredCards = new Set([result.card]);
  for (const [index, other] of otherCards.entries()) {
    if (!other || typeof other !== "object" || !other.card) {
      failures.push(`${file}: otherCards[${index}] 缺 card`);
      continue;
    }
    if (!CARD_SET.has(other.card)) {
      failures.push(`${file}: otherCards[${index}].card=${other.card} 不在卡集`);
    }
    if (declaredCards.has(other.card)) {
      failures.push(`${file}: otherCards[${index}].card=${other.card} 重复声明`);
    }
    declaredCards.add(other.card);

    const list = evidence.checks.filter((check) => check.card === other.card);
    const declared = /^(\d+)\/(\d+)$/.exec(String(other.checks ?? "").trim());
    if (!declared) {
      failures.push(`${file}: otherCards ${other.card} 的 checks 缺失或不是 passed/total`);
    } else {
      const passed = list.filter((check) => check.passed).length;
      if (Number(declared[1]) !== passed || Number(declared[2]) !== list.length) {
        failures.push(
          `${file}: otherCards ${other.card} 声明 ${other.checks}，现算 ${passed}/${list.length}`,
        );
      }
    }
    if (other.layers && stable(countLayers(list)) !== stable(other.layers)) {
      failures.push(
        `${file}: otherCards ${other.card} 的 layers=${JSON.stringify(other.layers)} 与现算=${JSON.stringify(
          countLayers(list),
        )} 不一致`,
      );
    }
  }

  const actualCards = new Set(evidence.checks.map((check) => check.card));
  for (const card of actualCards) {
    if (!declaredCards.has(card)) failures.push(`${file}: check 含未声明的卡 ${card}`);
  }
  for (const card of declaredCards) {
    if (!actualCards.has(card)) failures.push(`${file}: 声明了卡 ${card} 但没有任何 check`);
  }

  const primaryChecks = evidence.checks.filter((check) => check.card === result.card);
  const recomputed = countLayers(primaryChecks);
  if (!result.layers || typeof result.layers !== "object") {
    failures.push(`${file}-meta: 缺 result.layers`);
  } else if (stable(recomputed) !== stable(result.layers)) {
    failures.push(
      `${file}-meta: result.layers=${JSON.stringify(result.layers)} 与 checks 现算=${JSON.stringify(
        recomputed,
      )} 不一致`,
    );
  }

  const declaredTotal =
    sumTotals(result.layers) +
    otherCards.reduce(
      (acc, other) => acc + (Number(String(other?.checks ?? "").split("/")[1]) || 0),
      0,
    );
  if (declaredTotal !== evidence.checks.length) {
    failures.push(
      `${file}: 声明分母合计 ${declaredTotal} != checks.length ${evidence.checks.length}（不许跳过现算）`,
    );
  }

  for (const check of evidence.checks) {
    const ac = String(check.ac ?? "").trim();
    if (ac.startsWith("AC-")) {
      if (!(CARD_SECTION.get(check.card) ?? "").includes(ac)) {
        failures.push(`${file}: ${check.id} 的 ac=${ac} 不在卡 ${check.card} 的卡面`);
      }
    } else if (ac.includes("·")) {
      if (!cardText.includes(ac)) {
        failures.push(`${file}: ${check.id} 的卡面锚点 ac=${ac} 在卡面全文不存在`);
      }
    }
  }
}

if (scanned === 0) {
  failures.push(`未在 ${EVIDENCE_DIR} 扫描到任何证据（拒绝空转）`);
}

for (const warning of warnings) console.warn(`WARN ${warning}`);
for (const failure of failures) console.error(`FAIL ${failure}`);
console.log(
  `证据归属门禁：卡集 ${CARD_SET.size} 张，扫描 ${scanned} 份证据，失败 ${failures.length} 项，` +
    `警告 ${warnings.length} 项（旧格式冻结 ${frozen} 份，截止 ${deadline}）`,
);
process.exit(failures.length === 0 ? 0 : 1);
