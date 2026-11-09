#!/usr/bin/env node
// 已知红裁定：main 上允许存在的红只能来自 docs/qa/aka-main-known-reds.csv。
// 规则：清单内的红可通过；清单外的红一律阻断；清单内条目转绿后必须删行（否则阻断）。
// 范围：当前裁定证据门禁 verify:evidence；其它门禁仍硬红（不在清单口径内）。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const listPath = path.join(repoRoot, "docs", "qa", "aka-main-known-reds.csv");

function parseCsv(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .map((line) => line.split(",").map((c) => c.trim()));
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function loadEntries() {
  const rows = parseCsv(readFileSync(listPath, "utf8"));
  const header = rows.shift() || [];
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  return rows.map((r) => ({
    id: r[idx.id] ?? "",
    gate: r[idx.gate] ?? "",
    scope: r[idx.scope] ?? "",
    detail: r[idx.detail] ?? "",
    expiry: r[idx.expiry] ?? "",
    removeWhen: r[idx.remove_when] ?? "",
  }));
}

function isActive(e) {
  if (e.gate === "history") return false;
  return e.expiry >= today();
}

const entries = loadEntries();
const active = entries.filter((e) => isActive(e));
const history = entries.filter((e) => e.gate === "history");

console.log(`已知红清单：${path.relative(repoRoot, listPath)}`);
for (const e of entries) {
  console.log(`  ${e.id} [${e.gate}] ${e.scope} 到期=${e.expiry}${isActive(e) ? "" : " （非活动）"}`);
}
if (history.length) {
  console.log(`  历史记录 ${history.length} 条（仅记录，不参与裁定）`);
}

const probe = spawnSync(process.execPath, ["scripts/verify_evidence.mjs"], {
  cwd: path.join(repoRoot, "app"),
  encoding: "utf8",
});
const out = `${probe.stdout || ""}${probe.stderr || ""}`;
const failed = out
  .split(/\r?\n/)
  .filter((l) => l.startsWith("FAIL "))
  .map((l) => l.slice(5).trim());

const gateEntries = active.filter((e) => e.gate === "verify:evidence");

if (probe.status === 0 && failed.length === 0) {
  if (gateEntries.length) {
    console.error(
      `\n✗ 清单过期：verify:evidence 已转绿，但清单仍有 ${gateEntries.length} 条活动条目（${gateEntries
        .map((e) => e.id)
        .join("、")}）。请按「红转绿就删行」删除后重跑。`,
    );
    process.exit(1);
  }
  console.log("\n✓ 证据门禁全绿，且清单无活动条目。");
  process.exit(0);
}

const unmatched = [];
for (const line of failed) {
  const hit = gateEntries.find((e) => line.includes(e.scope));
  if (!hit) unmatched.push(line);
}

if (unmatched.length) {
  console.error("\n✗ 存在清单外的红（阻断）：");
  for (const line of unmatched) console.error(`  - ${line}`);
  process.exit(1);
}

console.log(`\n✓ 证据门禁的 ${failed.length} 条红均在清单内，允许通过。`);
process.exit(0);
