#!/usr/bin/env node
// 已签卡面改动拦截。
//   node scripts/verify_sign_impact.mjs --base <sha> --head <sha>
//
// 规则：
// 1. 已签卡（gate-log 中 sign_commit 非空）的卡面被 diff 击中 ⇒ 签字失效。
// 2. 保护集合 = gate-log 已签卡 ∪ BA 台账中已交付/条件交付/渲染层已具备/数值层已具备的卡。
//    后者即使没有 sign_commit 也受保护——「不在 gate-log 里」不等于「可以随便改」。
// 3. 失效集合由工具从「故事卡分节 + diff 行号」现算，不维护任何卡名单。
// 4. 提交信息必须用 trailer 精确申报：
//      Sign-Invalidates: S-02.05-01, S-03.06-04
//    没有失效卡时不要求 trailer；申报多了或少了都红。
// 5. sign_scope 里的文件路径也参与匹配；命中即视为该卡签字范围被改。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CARDS = "docs/story-cards/aka-story-cards-v0.1.md";
const GATE_LOG = join(ROOT, "docs", "qa", "aka-card-gate-log-v0.1.csv");
const LEDGER = join(ROOT, "docs", "qa", "aka-story-completion-ledger-v0.1.md");
const CARD_ID = /^S-\d{2}\.\d{2}-\d{2}$/;
const CLAIMED = new Set(["已交付", "条件交付", "渲染层已具备", "数值层已具备"]);

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const head = arg("head", "HEAD");
const PRINT = args.includes("--print-trailer");
const STAGED = args.includes("--staged");
const base = arg("base", STAGED ? "HEAD" : "");

function git(gitArgs) {
  return execFileSync("git", gitArgs, { cwd: ROOT, encoding: "utf8" }).trim();
}
function gitFile(rev) {
  try {
    return execFileSync("git", ["show", `${rev}:${CARDS}`], { cwd: ROOT, encoding: "utf8" });
  } catch {
    return "";
  }
}
function gitIndexFile() {
  return execFileSync("git", ["show", `:${CARDS}`], { cwd: ROOT, encoding: "utf8" });
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
function cardMap(text) {
  const lines = text.split("\n");
  const map = new Array(lines.length + 1).fill(null);
  let current = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^#{2,4}\s*(S-\d{2}\.\d{2}-\d{2})/);
    if (m) current = m[1];
    // 一级/二级标题（部分、10.x 估算边界等）不是卡面：重置归属，
    // 否则文末章节的改动会被错算到最后一张卡上。
    else if (/^#{1,2}\s/.test(lines[i])) current = null;
    map[i + 1] = current;
  }
  return map;
}

// 反例自检（制度第 29 条）：归属逻辑必须能证明「非卡小节归不到任何卡」。
// 归属/映射/分区类派生逻辑若没有会让它错的反例，就是等下一次同类 bug（G5 同病）。
function selfTestCardMap() {
  const fixture = [
    "# 第一部分 总览",
    "### S-01.01-01 甲卡",
    "卡内正文",
    "## 10.2 估算边界",
    "章节正文",
    "### S-01.01-02 乙卡",
    "卡内正文 2",
  ].join("\n");
  const m = cardMap(fixture);
  const bad = [];
  if (m[2] !== "S-01.01-01" || m[3] !== "S-01.01-01") bad.push("卡内行未归属本卡");
  if (m[4] !== null || m[5] !== null) bad.push(`非卡小节被归属到 ${m[4] ?? m[5]}`);
  if (m[6] !== "S-01.01-02") bad.push("后续卡未恢复归属");
  if (bad.length) {
    console.error(`::error::cardMap 反例未通过：${bad.join("；")}`);
    process.exit(2);
  }
}

function assertNonCardSectionsUnmapped(text) {
  const lines = text.split("\n");
  const map = cardMap(text);
  const leaks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const isHeading = /^#{1,2}\s/.test(lines[i]);
    const isCard = /^#{2,4}\s*S-\d{2}\.\d{2}-\d{2}/.test(lines[i]);
    if (isHeading && !isCard && map[i + 1] !== null) leaks.push(`${i + 1}: ${lines[i].trim()}`);
  }
  const anchor = lines.findIndex((l) => /^##\s+10\.2\s/.test(l));
  if (anchor >= 0 && map[anchor + 2] !== null) leaks.push(`${anchor + 2}: §10.2 正文被归属到 ${map[anchor + 2]}`);
  if (leaks.length) {
    console.error(`::error::非卡小节被归属到卡：${leaks.join("；")}`);
    process.exit(2);
  }
}

selfTestCardMap();
assertNonCardSectionsUnmapped(readFileSync(join(ROOT, CARDS), "utf8"));

if (!base || /^0+$/.test(base)) {
  console.log("verify:sign-impact 跳过：无可用 base（新分支/首推）");
  process.exit(0);
}

const rows = parseCsv(readFileSync(GATE_LOG, "utf8")).slice(1);
const signed = new Map(rows.filter((r) => (r[10] ?? "").trim()).map((r) => [r[0], r[10].trim()]));

// BA 台账里已交付/条件交付的卡同样受保护：gate-log 缺行是台账缺陷，不是改卡许可。
function claimedCards(text) {
  const set = new Set();
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((s) => s.trim());
    const card = cells[1] ?? "";
    if (!CARD_ID.test(card)) continue;
    if (CLAIMED.has(cells[4] ?? "")) set.add(card);
  }
  return set;
}
const protectedCards = new Set([...signed.keys(), ...claimedCards(readFileSync(LEDGER, "utf8"))]);
const label = (card) =>
  signed.has(card)
    ? `${card}（原签 ${signed.get(card).slice(0, 7)}）`
    : `${card}（台账已交付，未绑 commit）`;

const oldMap = cardMap(gitFile(base));
const newMap = cardMap(STAGED ? gitIndexFile() : gitFile(head));

const diff = execFileSync(
  "git",
  STAGED ? ["diff", "--cached", "-U0", base, "--", CARDS] : ["diff", "-U0", base, head, "--", CARDS],
  { cwd: ROOT, encoding: "utf8" },
);
const hit = new Set();
for (const line of diff.split("\n")) {
  const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!m) continue;
  const [oldStart, oldCount, newStart, newCount] = [Number(m[1]), Number(m[2] ?? 1), Number(m[3]), Number(m[4] ?? 1)];
  for (let n = oldStart; n < oldStart + oldCount; n += 1) if (oldMap[n]) hit.add(oldMap[n]);
  for (let n = newStart; n < newStart + newCount; n += 1) if (newMap[n]) hit.add(newMap[n]);
}

// sign_scope 中的文件路径也纳入命中范围。
const changedFiles = execFileSync(
  "git",
  STAGED ? ["diff", "--cached", "--name-only", base] : ["diff", "--name-only", base, head],
  { cwd: ROOT, encoding: "utf8" },
)
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);
const PATH_TOKEN = /[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:tsx?|rs|mjs|js|json|md|csv)/g;
for (const r of rows) {
  const card = r[0];
  const commit = (r[10] ?? "").trim();
  if (!commit || !signed.has(card)) continue;
  const tokens = new Set(((r[11] ?? "").match(PATH_TOKEN) ?? []).map((t) => t.replace(/^[.`'"]+|[.`'"]+$/g, "")));
  for (const file of changedFiles) {
    const basename = file.split("/").pop();
    if ([...tokens].some((t) => t === file || file.endsWith(`/${t}`) || t === basename)) {
      hit.add(card);
      break;
    }
  }
}

const invalidated = [...hit].filter((card) => protectedCards.has(card)).sort();

// --print-trailer：只打印，供人粘贴或 git commit -F。--staged 隐含此模式。
if (PRINT || STAGED) {
  console.log(`Sign-Invalidates: ${invalidated.length > 0 ? invalidated.join(", ") : "none"}`);
  if (invalidated.length > 0) {
    console.error(`已签卡命中：${invalidated.map((c) => label(c)).join("、")}`);
  }
  process.exit(0);
}

if (invalidated.length === 0) {
  console.log("verify:sign-impact 通过：本次 diff 未击中已签卡");
  process.exit(0);
}

const messages = execFileSync("git", ["log", "--format=%B", `${base}..${head}`], { cwd: ROOT, encoding: "utf8" });
const declared = new Set();
for (const m of messages.matchAll(/^Sign-Invalidates:\s*(.*)$/gim)) {
  for (const token of m[1].split(/[,;，；\s]+/).map((s) => s.trim()).filter(Boolean)) {
    if (/^none$/i.test(token)) continue;
    declared.add(token);
  }
}

const missing = invalidated.filter((c) => !declared.has(c));
const extra = [...declared].filter((c) => !invalidated.includes(c) && CARD_ID.test(c));
const bad = [...declared].filter((c) => !CARD_ID.test(c));

const lines = invalidated.map((c) => label(c));
if (missing.length || extra.length || bad.length) {
  console.error(`::error::本次 diff 击中 ${invalidated.length} 张已签卡：${lines.join("、")}`);
  if (missing.length) console.error(`::error::提交信息缺少 Sign-Invalidates：${missing.join(", ")}`);
  if (extra.length) console.error(`::error::Sign-Invalidates 多申报：${extra.join(", ")}`);
  if (bad.length) console.error(`::error::Sign-Invalidates 含非法卡号：${bad.join(", ")}`);
  console.error("::error::按制度第 18 条：已签卡面只允许 BA 改，提交必须申报失效卡，TL 在批次边界重签。");
  process.exit(1);
}
console.log(`verify:sign-impact 通过：申报与实算一致（${invalidated.join(", ")}）`);
