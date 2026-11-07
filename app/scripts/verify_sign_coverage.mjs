#!/usr/bin/env node
// 制度第 16 条：CI 绿 run 必须包含被签 commit。
// 用法：
//   node scripts/verify_sign_coverage.mjs          # 实算并写回台账 relation / ancestor_check
//   node scripts/verify_sign_coverage.mjs --check  # 只校验，台账与实算不一致即红（CI 用）
//
// 台账：docs/qa/aka-ci-sign-ledger-v0.1.csv
// 人手只填 run_id / head_sha / signed_sha / conclusion / cancelled_runs / note；
// relation 与 ancestor_check 由本脚本产出，手填视为伪造证据。

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LEDGER = join(ROOT, "docs", "qa", "aka-ci-sign-ledger-v0.1.csv");
const COLUMNS = [
  "run_id",
  "head_sha",
  "signed_sha",
  "relation",
  "ancestor_check",
  "conclusion",
  "cancelled_runs",
  "note",
];
const CHECK_MODE = process.argv.includes("--check");

function fail(lines) {
  for (const line of [].concat(lines)) console.error(`::error::${line}`);
  process.exit(1);
}

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
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function csvCell(value) {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function resolveCommit(sha, label) {
  if (!sha) fail(`台账缺 ${label}，不可判定（制度第 10 条，不得视为通过）`);
  try {
    return git(["rev-parse", "--verify", `${sha}^{commit}`]);
  } catch {
    fail(`${label}=${sha} 在仓库历史中不存在（浅克隆也会触发本项，请 fetch-depth: 0）`);
  }
}

function ancestry(signed, head) {
  if (signed === head) return { relation: "equal", check: "0" };
  let code = 0;
  try {
    git(["merge-base", "--is-ancestor", signed, head]);
  } catch (error) {
    code = typeof error.status === "number" ? error.status : 128;
  }
  if (code === 0) return { relation: "ancestor", check: "0" };
  if (code === 1) return { relation: "unrelated", check: "1" };
  fail(`git merge-base 无法判定 ${signed} 与 ${head} 的祖先关系（exit ${code}），不可判定不得视为通过`);
}

const rows = parseCsv(readFileSync(LEDGER, "utf8"));
const header = rows.shift();
if (header.join(",") !== COLUMNS.join(",")) {
  fail(`台账表头必须严格为：${COLUMNS.join(",")}；实际：${header.join(",")}`);
}

const errors = [];
const out = [header];
for (let index = 0; index < rows.length; index += 1) {
  const line = index + 2; // 含表头
  const row = Object.fromEntries(COLUMNS.map((key, i) => [key, (rows[index][i] ?? "").trim()]));
  if (rows[index].length !== COLUMNS.length) {
    errors.push(`第 ${line} 行列数=${rows[index].length}，应为 ${COLUMNS.length}`);
    out.push(rows[index]);
    continue;
  }
  if (row.conclusion !== "success") {
    errors.push(
      `第 ${line} 行 conclusion=${row.conclusion || "空"}：被取消/失败的 run 不得作为签字行，只登记在覆盖行的 cancelled_runs（制度第 16 条）`,
    );
  }
  const head = resolveCommit(row.head_sha, `第 ${line} 行 head_sha`);
  const signed = resolveCommit(row.signed_sha, `第 ${line} 行 signed_sha`);
  const actual = ancestry(signed, head);

  if (row.cancelled_runs) {
    for (const entry of row.cancelled_runs.split(";").map((s) => s.trim()).filter(Boolean)) {
      const [cancelledRun, cancelledSha] = entry.split("@");
      if (!cancelledRun || !cancelledSha) {
        errors.push(`第 ${line} 行 cancelled_runs 项「${entry}」不是 run_id@sha 格式`);
        continue;
      }
      resolveCommit(cancelledSha, `第 ${line} 行 cancelled_runs 的 sha`);
      if (!row.note.includes(cancelledRun)) {
        errors.push(`第 ${line} 行 note 未点名被取消 run ${cancelledRun}（不得留悬空记录）`);
      }
      if (!row.note.includes(row.run_id)) {
        errors.push(`第 ${line} 行 note 未点名覆盖它的 run ${row.run_id}`);
      }
      if (!/取消|覆盖|cancel-in-progress/i.test(row.note)) {
        errors.push(`第 ${line} 行 note 未写取消原因与覆盖关系`);
      }
    }
  }

  if (CHECK_MODE) {
    if (row.relation !== actual.relation) {
      errors.push(`第 ${line} 行 relation 台账=${row.relation || "空"}，实算=${actual.relation}`);
    }
    if (row.ancestor_check !== actual.check) {
      errors.push(`第 ${line} 行 ancestor_check 台账=${row.ancestor_check || "空"}，实算=${actual.check}`);
    }
  }
  if (actual.check !== "0") {
    errors.push(`第 ${line} 行 ${row.signed_sha} 不在 ${row.head_sha} 内（relation=${actual.relation}），不得签`);
  }
  out.push([
    row.run_id,
    row.head_sha,
    row.signed_sha,
    actual.relation,
    actual.check,
    row.conclusion,
    row.cancelled_runs,
    row.note,
  ]);
}

if (errors.length > 0) fail(errors);

if (!CHECK_MODE) {
  writeFileSync(
    LEDGER,
    `${out.map((r) => r.map((c) => csvCell(c ?? "")).join(",")).join("\n")}\n`,
    "utf8",
  );
  console.log(`verify:sign 写回 ${out.length - 1} 行：relation / ancestor_check 已由实算产出`);
} else {
  console.log(`verify:sign 校验通过：${out.length - 1} 行，祖先关系与台账一致`);
}
