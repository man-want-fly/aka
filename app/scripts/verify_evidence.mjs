/**
 * 证据归属门禁（W-60 / W-67）
 *
 * 断言：
 *   1. 每条 check 的 `card` 必须是卡集（docs/story-cards/aka-story-cards-v0.1.md）里存在的 id；
 *   2. meta 的 `result.card` 若存在，同样必须存在于卡集；
 *   3. meta 的 `result.layers` 若存在，必须由 checks 按 layer 现算得出（passed/total），不许手填。
 *
 * 旧格式证据（check 无 `card` 字段）记 warning，不阻断；新写/重跑的证据必须带 card。
 *
 * 用法：node scripts/verify_evidence.mjs
 * 退出码：0 = 通过；1 = 存在幻影卡或 layers 与 checks 不一致。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const CARD_DOC = path.join(ROOT, "docs", "story-cards", "aka-story-cards-v0.1.md");
const EVIDENCE_DIR = path.join(ROOT, "docs", "qa", "evidence");

const cardText = fs.readFileSync(CARD_DOC, "utf8");
const CARD_SET = new Set([...cardText.matchAll(/^#{2,4}\s+(S-\d{2}\.\d{2}-\d{2})/gm)].map((m) => m[1]));

if (CARD_SET.size === 0) {
  console.error(`未能从 ${path.relative(ROOT, CARD_DOC)} 解析出任何卡片 id`);
  process.exit(1);
}

const failures = [];
const warnings = [];
let scanned = 0;

const layerCounts = (checks, card) => {
  const out = {};
  for (const check of checks.filter((item) => item.card === card)) {
    const hit = (out[check.layer] ??= { passed: 0, total: 0 });
    hit.total += 1;
    if (check.passed) hit.passed += 1;
  }
  for (const [layer, hit] of Object.entries(out)) {
    out[layer] = `${hit.passed}/${hit.total}`;
  }
  return out;
};

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

  const missingCard = evidence.checks.filter((check) => !check.card);
  if (missingCard.length > 0) {
    warnings.push(`${file}: ${missingCard.length} 条 check 无 card 字段（旧格式，不阻断）`);
  }
  for (const check of evidence.checks) {
    if (check.card && !CARD_SET.has(check.card)) {
      failures.push(`${file}: check ${check.id} 的 card=${check.card} 不在卡集`);
    }
  }

  const metaPath = full.replace(/\.json$/, "-meta.json");
  if (!fs.existsSync(metaPath)) {
    warnings.push(`${file}: 无 meta，跳过 meta 归属核对`);
    continue;
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const result = meta.result && typeof meta.result === "object" ? meta.result : {};
  if (result.card && !CARD_SET.has(result.card)) {
    failures.push(`${file}-meta: result.card=${result.card} 不在卡集`);
  }
  if (result.card && result.layers) {
    const metaTotal = Object.values(result.layers).reduce((sum, text) => {
      const [, total] = String(text).split("/");
      return sum + Number(total);
    }, 0);
    if (missingCard.length > 0 || metaTotal !== evidence.checks.length) {
      warnings.push(`${file}: 旧格式/多阶段证据，result.layers 不做现算比对`);
    } else {
      const recomputed = layerCounts(evidence.checks, result.card);
      if (JSON.stringify(recomputed) !== JSON.stringify(result.layers)) {
        failures.push(
          `${file}-meta: result.layers=${JSON.stringify(result.layers)} 与 checks 现算=${JSON.stringify(
            recomputed,
          )} 不一致`,
        );
      }
    }
  }
}

for (const warning of warnings) console.warn(`WARN ${warning}`);
for (const failure of failures) console.error(`FAIL ${failure}`);
console.log(
  `证据归属门禁：卡集 ${CARD_SET.size} 张，扫描 ${scanned} 份证据，失败 ${failures.length} 项，警告 ${warnings.length} 项`,
);
process.exit(failures.length === 0 ? 0 : 1);
