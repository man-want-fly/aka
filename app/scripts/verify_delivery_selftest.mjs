#!/usr/bin/env node
// 制度第 29 条：verify:delivery 的每条机器判定都必须有「会让它错」的反例，
// 并把检查器退回「不检查」形态后，所有反例必须变绿，证明反例不是靠恒真断言过关。

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, "verify_delivery.mjs");
const TMP = mkdtempSync(join(tmpdir(), "delivery-"));

const RULES = Array.from({ length: 35 }, (_, i) => i + 1).join("、");
const standardText = () =>
  [
    "# AKA 代码交付规范（夹具）",
    "",
    ...Array.from({ length: 9 }, (_, i) => [`## ${i + 1}. 小节`, "", "占位。", ""]).flat(),
    "## 9. 存量制度收敛",
    "",
    "| 制度条 | 归属 | 处置 |",
    "| --- | --- | --- |",
    `| ${RULES} | §1 | 保留 |`,
    "",
    "## 10. 落实清单",
    "",
    "机器判定：`verify:delivery`。",
    "",
  ].join("\n");

const workorderText = () =>
  [
    "# 工单（夹具）",
    "",
    "## 0.0 开工单状态表（唯一共享态）",
    "",
    "| 编号 | 内容 | 执行人 | 状态 | 分支 / 提交 |",
    "| --- | --- | --- | --- | --- |",
    "| W-01 | 示例工单 | dev A | 已验收 | `abc1234` |",
    "",
    "## 0.1 其他",
    "",
    "### W-01 示例工单",
    "",
    "正文。",
    "",
  ].join("\n");

const gateLogText = () =>
  [
    "card_id,ledger_status,gate_a,gate_b,gate_c,gate_c_source,blocker,owner,workorder,note,sign_commit,sign_scope",
    `S-02.04-01,已交付,PASS,PASS,PASS,dev abc1234,,TL,W-01,夹具,${"a".repeat(40)},全卡`,
    "",
  ].join("\n");

const messageText = () =>
  ["docs(qa): 交付规范上线", "", "- 新增规范", "Sign-Invalidates: none", "连带修正：无", ""].join("\n");

const changedText = () => "docs/qa/aka-delivery-standard-v0.1.md\n";

function makeFixture(name, mutate) {
  const root = join(TMP, name);
  mkdirSync(join(root, "docs", "qa"), { recursive: true });
  mkdirSync(join(root, "app", "scripts"), { recursive: true });
  const fixture = {
    standard: standardText(),
    workorder: workorderText(),
    gateLog: gateLogText(),
    message: messageText(),
    changed: changedText(),
  };
  mutate(fixture);
  writeFileSync(join(root, "docs", "qa", "aka-delivery-standard-v0.1.md"), fixture.standard);
  writeFileSync(join(root, "docs", "qa", "aka-card-workorder-v0.1.md"), fixture.workorder);
  writeFileSync(join(root, "docs", "qa", "aka-card-gate-log-v0.1.csv"), fixture.gateLog);
  writeFileSync(
    join(root, "app", "package.json"),
    JSON.stringify({ scripts: { "verify:delivery": "node scripts/verify_delivery.mjs", "verify:delivery:selftest": "node x.mjs" } }),
  );
  writeFileSync(join(root, "app", "scripts", "verify_delivery_selftest.mjs"), "// fixture\n");
  writeFileSync(join(root, "message.txt"), fixture.message);
  writeFileSync(join(root, "changed.txt"), fixture.changed);
  return root;
}

function run(script, root) {
  try {
    return {
      code: 0,
      output: execFileSync(
        process.execPath,
        [script, "--root", root, "--message", join(root, "message.txt"), "--changed", join(root, "changed.txt"), "--today", "2026-11-08"],
        { encoding: "utf8" },
      ),
    };
  } catch (error) {
    return { code: error.status ?? 1, output: String(error.stderr ?? error.stdout ?? "") };
  }
}

const cases = [
  {
    name: "duplicate-workorder-id",
    label: "状态表编号重复",
    mutate: (draft) => {
      draft.workorder = draft.workorder.replace(
        "| W-01 | 示例工单 | dev A | 已验收 | `abc1234` |",
        "| W-01 | 示例工单 | dev A | 已验收 | `abc1234` |\n| W-01 | 重复派单 | dev B | 待开工 | — |",
      );
    },
    reason: "状态表编号重复：W-01",
  },
  {
    name: "illegal-status",
    label: "状态词表外（已完成）",
    mutate: (draft) => {
      draft.workorder = draft.workorder.replace("| 已验收 |", "| 已完成 |");
    },
    reason: "状态不在词表",
  },
  {
    name: "in-progress-without-branch",
    label: "进行中未写分支",
    mutate: (draft) => {
      draft.workorder = draft.workorder.replace("| 已验收 | `abc1234` |", "| 进行中 | — |");
    },
    reason: "未写分支/提交",
  },
  {
    name: "missing-section",
    label: "规范缺 §8",
    mutate: (draft) => {
      draft.standard = draft.standard.replace(/## 8\. 小节[\s\S]*?(?=## 9\.)/, "");
    },
    reason: "规范缺少 §8",
  },
  {
    name: "rule-gap",
    label: "制度第 34 条未收敛",
    mutate: (draft) => {
      draft.standard = draft.standard.replace("、34、", "、");
    },
    reason: "制度第 34 条未在规范 §9 收敛",
  },
  {
    name: "delivered-without-sign",
    label: "新卡已交付但无签字",
    mutate: (draft) => {
      draft.gateLog = draft.gateLog.replace(`,${"a".repeat(40)},全卡`, ",,全卡");
    },
    reason: "已交付 但 sign_commit 为空",
  },
  {
    name: "bad-subject",
    label: "提交信息不合规",
    mutate: (draft) => {
      draft.message = draft.message.replace("docs(qa): 交付规范上线", "update stuff");
    },
    reason: "HEAD 提交信息不符合",
  },
  {
    name: "missing-sign-invalidates",
    label: "改 gate-log 缺 Sign-Invalidates",
    mutate: (draft) => {
      draft.message = draft.message.replace("Sign-Invalidates: none\n", "");
      draft.changed = `${draft.changed}docs/qa/aka-card-gate-log-v0.1.csv\n`;
    },
    reason: "缺 Sign-Invalidates",
  },
  {
    name: "missing-companion-fix",
    label: "改 gate-log 缺连带修正",
    mutate: (draft) => {
      draft.message = draft.message.replace("连带修正：无\n", "");
      draft.changed = `${draft.changed}docs/qa/aka-card-gate-log-v0.1.csv\n`;
    },
    reason: "缺「连带修正",
  },
];

// 变异：把 ENABLED 整行替换为全 false（模拟「旧形态不检查」）。
const checkerSource = readFileSync(CHECKER, "utf8");
const anchor = /const ENABLED = \{ standard: true, rules: true, state: true, deliver: true, commit: true, self: true \};/;
if (!anchor.test(checkerSource)) {
  console.error("::error::变异锚点丢失：verify_delivery.mjs 的 ENABLED 行已变化，selftest 无法证明反例有效");
  process.exit(2);
}
const MUTANT = join(TMP, "verify_delivery_mutant.mjs");
writeFileSync(
  MUTANT,
  checkerSource.replace(anchor, "const ENABLED = { standard: false, rules: false, state: false, deliver: false, commit: false, self: false };"),
);

const failures = [];
const baseline = makeFixture("baseline", () => {});
const baselineRun = run(CHECKER, baseline);
if (baselineRun.code !== 0) failures.push(`基线应绿，实际 exit=${baselineRun.code}：${baselineRun.output.trim()}`);
const baselineMutant = run(MUTANT, baseline);
if (baselineMutant.code !== 0) failures.push(`变异基线应绿，实际 exit=${baselineMutant.code}：${baselineMutant.output.trim()}`);

for (const item of cases) {
  const root = makeFixture(item.name, () => {});
  const draft = {
    standard: readFileSync(join(root, "docs", "qa", "aka-delivery-standard-v0.1.md"), "utf8"),
    workorder: readFileSync(join(root, "docs", "qa", "aka-card-workorder-v0.1.md"), "utf8"),
    gateLog: readFileSync(join(root, "docs", "qa", "aka-card-gate-log-v0.1.csv"), "utf8"),
    message: readFileSync(join(root, "message.txt"), "utf8"),
    changed: readFileSync(join(root, "changed.txt"), "utf8"),
  };
  item.mutate(draft);
  writeFileSync(join(root, "docs", "qa", "aka-delivery-standard-v0.1.md"), draft.standard);
  writeFileSync(join(root, "docs", "qa", "aka-card-workorder-v0.1.md"), draft.workorder);
  writeFileSync(join(root, "docs", "qa", "aka-card-gate-log-v0.1.csv"), draft.gateLog);
  writeFileSync(join(root, "message.txt"), draft.message);
  writeFileSync(join(root, "changed.txt"), draft.changed);

  const normal = run(CHECKER, root);
  if (normal.code !== 1) {
    failures.push(`${item.label}：应判红（exit 1），实际 exit=${normal.code}`);
  } else if (!normal.output.includes(item.reason)) {
    failures.push(`${item.label}：判红了但理由不对，期望包含「${item.reason}」，实际：${normal.output.trim()}`);
  }
  const mutant = run(MUTANT, root);
  if (mutant.code !== 0) {
    failures.push(`${item.label}：变异（不检查）后应变绿，实际 exit=${mutant.code}：${mutant.output.trim()}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`::error::${failure}`);
  console.error(`verify:delivery:selftest 失败：${failures.length} 项`);
  process.exit(1);
}

console.log(
  `verify:delivery:selftest 通过：反例 ${cases.length}/${cases.length} 判红，变异后 ${cases.length}/${cases.length} 变绿`,
);
rmSync(TMP, { recursive: true, force: true });
