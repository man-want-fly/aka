#!/usr/bin/env node
// gate-log 结构门禁。
//   node scripts/verify_gate_log.mjs          # 校验（CI 用）
//   node scripts/verify_gate_log.mjs --fix    # 规整：短 SHA 补全、统一 LF、规范引号
//
// 规则：
// 1. 严格 12 列；按 RFC4180 解析后必须能原样重序列化（未加引号的逗号会在这里现形）。
// 2. 列数、枚举、必填、sign_commit 40 位且可解析。
// 3. sign_commit 非空 ⇒ Gate C=PASS + gate_c_source 非空 + sign_scope 非空。
// 4. 台账引入后的签字必须与 verify:sign 台账对齐（relation/ancestor_check/conclusion）。

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE_LOG = join(ROOT, "docs", "qa", "aka-card-gate-log-v0.1.csv");
const SIGN_LEDGER = join(ROOT, "docs", "qa", "aka-ci-sign-ledger-v0.1.csv");
const COLUMNS = [
  "card_id",
  "ledger_status",
  "gate_a",
  "gate_b",
  "gate_c",
  "gate_c_source",
  "blocker",
  "owner",
  "workorder",
  "note",
  "sign_commit",
  "sign_scope",
];
const STATUS = new Set(["已交付", "条件交付", "渲染层已具备", "数值层已具备", "未开始", "待签", "Blocked", "Blocked-AC"]);
const GATE = { gate_a: new Set(["PASS", "FAIL", "N/A"]), gate_b: new Set(["PASS", "FAIL", ""]), gate_c: new Set(["PASS", "FAIL", ""]) };
const SOURCE_PREFIX = new Set(["BA", "dev", "TL", "CI", "自动化", "合并"]);
const OWNER = /^(TL|BA|dev A|开发)(;(TL|BA|dev A|开发))*$/;
const CARD_ID = /^S-\d{2}\.\d{2}-\d{2}$/;
const FIX = process.argv.includes("--fix");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ""));
}

function csvCell(value) {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
const serialize = (rows) => `${rows.map((r) => r.map(csvCell).join(",")).join("\n")}\n`;

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

const raw = readFileSync(GATE_LOG, "utf8");
const rows = parseCsv(raw);
const header = rows.shift();
const failures = [];

if (header.join(",") !== COLUMNS.join(",")) {
  failures.push(`表头必须严格为 ${COLUMNS.join(",")}；实际 ${header.join(",")}`);
}

// 规范形式校验：解析后重序列化必须与原文一致（忽略行尾差异）。
if (serialize([header, ...rows]) !== raw.replaceAll("\r\n", "\n")) {
  failures.push("CSV 不是规范形式：存在未加引号的逗号/引号或多余空白；运行 --fix 后人工复核 diff");
}

const ledgerRows = parseCsv(readFileSync(SIGN_LEDGER, "utf8")).slice(1);
const ledgerSigned = new Set(ledgerRows.map((r) => (r[2] ?? "").trim()).filter(Boolean));
const ledgerStatus = new Map(
  ledgerRows.map((r) => [(r[2] ?? "").trim(), { relation: (r[3] ?? "").trim(), ancestor: (r[4] ?? "").trim(), conclusion: (r[5] ?? "").trim() }]),
);
const isAncestorOrEqual = (base, target) => {
  if (!base || !target) return false;
  if (base === target) return true;
  try {
    git(["merge-base", "--is-ancestor", base, target]);
    return true;
  } catch {
    return false;
  }
};

const seen = new Set();
const out = [header];
for (let i = 0; i < rows.length; i += 1) {
  const line = i + 2;
  const row = rows[i];
  if (row.length !== COLUMNS.length) {
    failures.push(`第 ${line} 行 ${row.length} 列，应为 ${COLUMNS.length}（${row[0] || "无 card_id"}）`);
    out.push(row);
    continue;
  }
  const r = Object.fromEntries(COLUMNS.map((k, n) => [k, row[n]]));
  const fail = (m) => failures.push(`第 ${line} 行 ${r.card_id || "?"}：${m}`);

  if (!CARD_ID.test(r.card_id)) fail(`card_id 不合规：${r.card_id || "空"}`);
  if (seen.has(r.card_id)) fail(`card_id 重复：${r.card_id}`);
  seen.add(r.card_id);
  if (!STATUS.has(r.ledger_status)) fail(`ledger_status 不在枚举内：${r.ledger_status || "空"}`);
  for (const [key, allowed] of Object.entries(GATE)) {
    if (!allowed.has(r[key])) fail(`${key} 不在枚举内：${r[key] || "空"}`);
  }
  if (!OWNER.test(r.owner)) fail(`owner 不合规：${r.owner || "空"}`);
  if (!r.note.trim()) fail("note 为空");

  if (r.gate_c === "PASS" && !r.gate_c_source.trim()) fail("Gate C=PASS 但 gate_c_source 为空");
  if (r.gate_c_source.trim() && !SOURCE_PREFIX.has(r.gate_c_source.trim().split(/\s+/)[0])) {
    fail(`gate_c_source 前缀必须是 ${[...SOURCE_PREFIX].join("/")}：${r.gate_c_source}`);
  }

  if (!r.sign_commit) {
    if (r.sign_scope.trim()) fail("sign_scope 非空但 sign_commit 为空");
  } else {
    let signFull = r.sign_commit;
    if (FIX && /^[0-9a-f]{7,39}$/.test(signFull)) {
      try {
        signFull = git(["rev-parse", "--verify", `${signFull}^{commit}`]);
      } catch {
        fail(`短 SHA 无法解析：${r.sign_commit}`);
      }
    }
    if (!/^[0-9a-f]{40}$/.test(signFull)) fail(`sign_commit 必须是 40 位小写 hex：${r.sign_commit}`);
    try {
      git(["cat-file", "-e", `${signFull}^{commit}`]);
    } catch {
      fail(`sign_commit 在仓库历史中不存在：${signFull}`);
    }
    if (r.gate_c !== "PASS") fail(`sign_commit 非空但 Gate C=${r.gate_c || "空"}；本列只记卡级签字`);
    if (!r.gate_c_source.trim()) fail("sign_commit 非空但 gate_c_source 为空");
    if (!r.sign_scope.trim()) fail("sign_commit 非空但 sign_scope 为空");
    // 与 verify:sign 对齐：若该签字位于台账时代之后（是任一 ledger signed_sha 的后代），必须入台账。
    if ([...ledgerSigned].some((base) => isAncestorOrEqual(base, signFull)) && !ledgerSigned.has(signFull)) {
      fail(`sign_commit ${signFull} 在台账时代之后但未登记 signed_sha`);
    }
    if (ledgerStatus.has(signFull)) {
      const s = ledgerStatus.get(signFull);
      if (!["equal", "ancestor"].includes(s.relation)) fail(`台账 relation=${s.relation}，应为 equal/ancestor`);
      if (s.ancestor !== "0") fail(`台账 ancestor_check=${s.ancestor}，应为 0`);
      if (s.conclusion !== "success") fail(`台账 conclusion=${s.conclusion}，应为 success`);
    }
    r.sign_commit = signFull;
  }
  out.push(COLUMNS.map((k) => r[k]));
}

if (FIX) {
  writeFileSync(GATE_LOG, serialize(out), "utf8");
  console.log(`verify:gate-log --fix 写回 ${out.length - 1} 行`);
}

if (failures.length > 0) {
  for (const f of failures) console.error(`::error::${f}`);
  process.exit(1);
}
console.log(`verify:gate-log 通过：${out.length - 1} 行，${seen.size} 张卡`);
