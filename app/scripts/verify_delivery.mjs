#!/usr/bin/env node
// 代码交付规范门禁（`docs/qa/aka-delivery-standard-v0.2.md`，制度第 36/37/38 条）。
//   node scripts/verify_delivery.mjs
//   node scripts/verify_delivery.mjs --root <fixture> --message <file> --changed <file> --today 2026-11-08
//
// 机器能卡的七件事：
// 1. 规范 §1–§10 结构齐备，且 §9 收敛表覆盖制度第 1–39 条（不跳号、不引用不存在的条）。
// 2. 工单 §0.0 状态表：编号唯一、状态词表内、进行中/待验收必须写分支或提交、表内工单有正文、
//    每行 `更新日` 格式合法且不晚于今天、有 commit 时不早于该 commit 的提交日。
// 3. gate-log：`已交付/条件交付/已结项` 必须有 40 位 sign_commit（存量白名单只减不增，2026-11-22 到期）。
// 4. §1.3 存量豁免逐张交代：恰 10 行、卡号与门禁名单一致、理由/批准人/处置齐备、处置在枚举内。
// 5. HEAD 提交信息：`type(scope): 摘要`；合并提交正文列出被合并 commit。
// 6. 触碰 gate-log / 签字台账 / 证据时，提交信息必须有 `Sign-Invalidates:` 与 `连带修正：`。
// 7. 检查器自证：selftest 存在、package.json 有入口、规范 §10 挂载了 verify:delivery。
//
// 第 29 条：每条判定都必须能被 verify_delivery_selftest.mjs 的反例打红并做变异验证。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const argOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const ROOT = argOf("--root") ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TODAY = argOf("--today") ?? new Date().toISOString().slice(0, 10);
const STANDARD = join(ROOT, "docs", "qa", "aka-delivery-standard-v0.2.md");
const WORKORDER = join(ROOT, "docs", "qa", "aka-card-workorder-v0.1.md");
const GATE_LOG = join(ROOT, "docs", "qa", "aka-card-gate-log-v0.1.csv");
const PKG = join(ROOT, "app", "package.json");
const SELFTEST = join(ROOT, "app", "scripts", "verify_delivery_selftest.mjs");

// 变异锚点：selftest 把它们全部置 false，所有反例必须变绿。
const ENABLED = { standard: true, rules: true, state: true, deliver: true, commit: true, self: true };

const RULE_COUNT = 39;
const STATUS_ENUM = ["未开始", "待开工", "进行中", "待验收", "已验收", "停线", "阻塞"];
const DELIVERED = new Set(["已交付", "条件交付", "已结项"]);
const LEGACY_DEADLINE = "2026-11-22";
// §1.3 存量豁免：只许删、不许加；到期后整份名单失效。
const LEGACY_NO_SIGN = new Set([
  "S-01.01-01",
  "S-01.01-02",
  "S-01.01-03",
  "S-02.02-01",
  "S-02.02-02",
  "S-02.06-02",
  "S-02.07-01",
  "S-02.07-02",
  "S-03.04-01",
  "S-06.01-02",
]);
const TYPE = new Set(["feat", "fix", "docs", "sign", "evidence", "merge", "refactor", "test", "chore"]);
const DISPOSAL = ["补签", "降级为文档卡", "降级为不可放行", "逐张裁定"];

const failures = [];
const fail = (message) => failures.push(message);
const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const git = (gitArgs) =>
  execFileSync("git", gitArgs, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commitDate = (sha) => {
  try {
    return git(["show", "-s", "--format=%cs", sha]) || null;
  } catch {
    return null;
  }
};

// 本地 HEAD 严格落后 origin/main 时，工作区里的状态表可能不是最新真源（W-92 同机理）。
const behindOrigin = () => {
  try {
    const head = git(["rev-parse", "HEAD"]);
    const remote = git(["rev-parse", "--verify", "origin/main"]);
    if (!remote || head === remote) return false;
    git(["merge-base", "--is-ancestor", head, remote]);
    return true;
  } catch {
    return false;
  }
};

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

// 1. 规范结构
if (ENABLED.standard) {
  const standard = read(STANDARD);
  if (!standard) {
    fail("缺少规范 docs/qa/aka-delivery-standard-v0.1.md");
  } else {
    const sections = new Set([...standard.matchAll(/^## (\d+)\. /gm)].map((m) => Number(m[1])));
    for (let n = 1; n <= 10; n += 1) {
      if (!sections.has(n)) fail(`规范缺少 §${n}（§1–§10 必须齐备）`);
    }
  }
}

// 2. §9 制度收敛覆盖第 1–38 条
if (ENABLED.rules) {
  const standard = read(STANDARD);
  const start = standard.indexOf("## 9.");
  const end = standard.indexOf("## 10.");
  if (start < 0 || end < 0) {
    fail("规范缺少 §9 存量收敛表（或 §10 定位失败），无法判定制度覆盖");
  } else {
    const covered = new Set();
    for (const line of standard.slice(start, end).split("\n")) {
      if (!line.startsWith("|")) continue;
      const first = (line.split("|")[1] ?? "").trim();
      if (!/^[\d、\s]+$/.test(first)) continue;
      for (const part of first.split("、").map((s) => s.trim()).filter(Boolean)) {
        covered.add(Number(part));
      }
    }
    for (let n = 1; n <= RULE_COUNT; n += 1) {
      if (!covered.has(n)) fail(`制度第 ${n} 条未在规范 §9 收敛（漏条即视为存量没交代）`);
    }
    for (const n of covered) {
      if (!Number.isInteger(n) || n < 1 || n > RULE_COUNT) fail(`规范 §9 引用了不存在的制度第 ${n} 条`);
    }
  }
}

// 3. 工单 §0.0 状态表
if (ENABLED.state) {
  if (behindOrigin()) {
    fail("本地 HEAD 落后 origin/main：查表/派单前先 git fetch，并读 origin/main 上的 §0.0（工作区副本不是唯一真源）");
  }
  const workorder = read(WORKORDER);
  const start = workorder.indexOf("## 0.0");
  const end = workorder.indexOf("## 0.1");
  if (start < 0) {
    fail("工单缺少 §0.0 开工单状态表");
  } else {
    const table = workorder.slice(start, end > start ? end : undefined);
    const body = end > start ? workorder.slice(end) : "";
    const ids = new Set();
    for (const line of table.split("\n")) {
      if (!line.startsWith("| W-")) continue;
      const cells = line.split("|").map((s) => s.trim());
      const id = cells[1] ?? "";
      const status = cells[4] ?? "";
      const branch = cells[5] ?? "";
      const updated = cells[6] ?? "";
      if (!/^W-\d+$/.test(id)) {
        fail(`状态表编号不合规：${id || "空"}`);
        continue;
      }
      if (ids.has(id)) fail(`状态表编号重复：${id}`);
      ids.add(id);
      if (!STATUS_ENUM.some((word) => status.startsWith(word))) {
        fail(`${id} 状态不在词表（${STATUS_ENUM.join("/")}）：${status || "空"}`);
      }
      if (/^(进行中|待验收)/.test(status) && (!branch || branch === "—" || branch === "-")) {
        fail(`${id}=${status} 但未写分支/提交；别人无法判断是否已有人在做`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(updated)) {
        fail(`${id} 的更新日缺失或格式非 YYYY-MM-DD：${updated || "空"}`);
      } else if (updated > TODAY) {
        fail(`${id} 的更新日 ${updated} 晚于今天 ${TODAY}`);
      } else {
        const sha = (branch.match(/[0-9a-f]{7,40}/) ?? [])[0];
        const date = sha ? commitDate(sha) : null;
        if (date && updated < date) {
          fail(`${id} 的更新日 ${updated} 早于 commit ${sha} 的提交日 ${date}（倒填）`);
        }
      }
      if (!new RegExp(`(###\\s*${id}\\b|\\*\\*${id}\\b)`).test(body)) {
        fail(`${id} 在状态表但没有工单正文（标题或加粗锚点）`);
      }
    }
    if (ids.size === 0) fail("状态表没有任何 W-xx 行");
  }
}

// 3.5 §1.3 存量豁免逐张交代
if (ENABLED.deliver) {
  const standard = read(STANDARD);
  const start = standard.indexOf("### 1.3");
  const end = standard.indexOf("## 2.");
  if (start < 0 || end < 0) {
    fail("规范缺少 §1.3 存量豁免表，无法逐张交代");
  } else {
    const rows = standard
      .slice(start, end)
      .split("\n")
      .filter((line) => /^\|\s*`S-/.test(line))
      .map((line) => line.split("|").map((s) => s.trim()));
    if (rows.length !== LEGACY_NO_SIGN.size) {
      fail(`§1.3 存量豁免应恰为 ${LEGACY_NO_SIGN.size} 行，实际 ${rows.length} 行（只减不增）`);
    }
    const listed = new Set();
    for (const cells of rows) {
      const card = (cells[1] ?? "").replace(/`/g, "").trim();
      const reason = cells[3] ?? "";
      const approver = cells[4] ?? "";
      const disposal = cells[5] ?? "";
      if (!/^S-\d{2}\.\d{2}-\d{2}$/.test(card)) {
        fail(`§1.3 卡号不合规：${card || "空"}`);
        continue;
      }
      if (listed.has(card)) fail(`§1.3 卡号重复：${card}`);
      listed.add(card);
      if (!LEGACY_NO_SIGN.has(card)) fail(`§1.3 出现门禁名单外的卡：${card}（白名单只减不增）`);
      if (!reason || reason === "—" || reason === "-") fail(`${card} 未写豁免理由`);
      if (!approver.includes("TL")) fail(`${card} 批准人不是 TL：${approver || "空"}`);
      if (!DISPOSAL.some((word) => disposal.includes(word))) {
        fail(`${card} 到期处置不在枚举（${DISPOSAL.join("/")}）：${disposal || "空"}`);
      }
    }
    for (const card of LEGACY_NO_SIGN) {
      if (!listed.has(card)) fail(`§1.3 漏列门禁名单中的卡：${card}`);
    }
  }
}

// 4. gate-log：已交付必须有签字
if (ENABLED.deliver) {
  const rows = parseCsv(read(GATE_LOG));
  if (rows.length === 0) {
    fail("缺少 gate-log 或为空");
  } else {
    const header = rows.shift();
    const index = (name) => header.indexOf(name);
    const cardAt = index("card_id");
    const statusAt = index("ledger_status");
    const signAt = index("sign_commit");
    if (cardAt < 0 || statusAt < 0 || signAt < 0) {
      fail("gate-log 表头缺 card_id / ledger_status / sign_commit");
    } else {
      const legacyActive = TODAY <= LEGACY_DEADLINE;
      for (const row of rows) {
        const card = (row[cardAt] ?? "").trim();
        const status = (row[statusAt] ?? "").trim();
        const sign = (row[signAt] ?? "").trim();
        if (!DELIVERED.has(status)) continue;
        if (/^[0-9a-f]{40}$/.test(sign)) continue;
        if (legacyActive && LEGACY_NO_SIGN.has(card)) continue;
        fail(`${card} 台账=${status} 但 sign_commit 为空或非 40 位（存量白名单${legacyActive ? "不含此卡" : "已于 " + LEGACY_DEADLINE + " 到期"}）`);
      }
    }
  }
}

// 5. HEAD 提交信息
if (ENABLED.commit) {
  const messageFile = argOf("--message");
  const changedFile = argOf("--changed");
  let message = "";
  let changed = [];
  try {
    message = messageFile ? read(messageFile) : git(["log", "-1", "--pretty=%B"]);
    changed = changedFile
      ? read(changedFile).split("\n").map((s) => s.trim()).filter(Boolean)
      : git(["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean);
  } catch {
    fail("无法读取 HEAD 提交信息（非 git 仓库或尚无提交）");
  }
  if (message) {
    const lines = message.split("\n");
    const subject = (lines[0] ?? "").trim();
    const isMerge = /^(merge\(|Merge )/.test(subject);
    const match = subject.match(/^([a-z]+)\(([a-z0-9-]+)\): \S/);
    if (!isMerge) {
      if (!match) fail(`HEAD 提交信息不符合「type(scope): 摘要」：${subject}`);
      else if (!TYPE.has(match[1])) fail(`HEAD 提交 type 不在枚举：${match[1]}`);
    } else if (!/[0-9a-f]{7,40}/.test(lines.slice(1).join("\n"))) {
      fail("合并提交正文必须列出被合并的 commit");
    }
    const touchesSign = changed.some(
      (file) =>
        file === "docs/qa/aka-card-gate-log-v0.1.csv" ||
        file === "docs/qa/aka-ci-sign-ledger-v0.1.csv" ||
        file.startsWith("docs/qa/evidence/"),
    );
    if (!isMerge && touchesSign) {
      if (!/^Sign-Invalidates:\s*\S+/m.test(message)) {
        fail("触碰 gate-log / 签字台账 / 证据，但提交信息缺 Sign-Invalidates:");
      }
      if (!/^连带修正：\s*\S+/m.test(message)) {
        fail("触碰签字产物，但提交信息缺「连带修正：文件 L行 原值→新值」（无连带修正也要写「无」）");
      }
    }
  }
}

// 6. 检查器自证（第 29 条）
if (ENABLED.self) {
  if (!existsSync(SELFTEST)) fail("缺少 verify_delivery_selftest.mjs：检查器无反射例，按第 29 条视为未交付");
  let pkg = {};
  try {
    pkg = JSON.parse(read(PKG) || "{}");
  } catch {
    fail("app/package.json 不是合法 JSON");
  }
  if (!pkg.scripts?.["verify:delivery"]) fail("package.json 缺 verify:delivery 入口");
  if (!pkg.scripts?.["verify:delivery:selftest"]) fail("package.json 缺 verify:delivery:selftest 入口");
  if (!/verify:delivery/.test(read(STANDARD))) fail("规范 §10 未挂载 verify:delivery");
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`::error::${failure}`);
  console.error(`verify:delivery 失败：${failures.length} 项`);
  process.exit(1);
}
console.log("verify:delivery 通过：规范结构 / 制度收敛 / 状态表 / 已交付签字 / HEAD 提交信息 / 自证");
