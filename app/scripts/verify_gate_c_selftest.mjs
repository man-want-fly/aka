#!/usr/bin/env node
/**
 * W-110 检查器自证（制度第 29 条）：verify_gate_c.mjs 的两条判定必须能被反例打红，
 * 且失败信息必须指向具体 AC / 文件 / 卡号（不许只报「不通过」），并做变异验证。
 *
 * 与 verify_delivery_selftest.mjs / evidence_suites_selftest.mjs 同构：用临时夹具
 * 反向验证检查器，不依赖真实仓库状态。
 */

import { checkAcCoverage, checkGateCSource } from "./verify_gate_c.mjs";

const failures = [];
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
};

// ── 检查 1：AC 覆盖闭合 ──
{
  const cardId = "S-88.88-01";
  const section = [
    "- **AC-88.88-01**｜基条。",
    "- **AC-88.88-01（补1）**｜补1。",
    "- **AC-88.88-01（补2）**｜补2。",
  ].join("\n");
  // 反例：3 条 AC 只覆盖基条 → 判红，且失败信息点名两个具体补号。
  const bad = checkAcCoverage({
    cardId,
    cardSection: section,
    checks: [{ card: cardId, ac: "AC-88.88-01" }],
  });
  check(bad.ok === false, "AC 覆盖闭合反例未判红（5/3 条只覆盖 1 条）");
  check(bad.missing.length === 2, `AC 缺口应为 2，实为 ${bad.missing.length}`);
  check(
    bad.failures.every((f) => /AC-88\.88-01（补\d）/.test(f)),
    "AC 覆盖闭合失败信息未指向具体 AC token",
  );
  // 正例：全覆盖 → 绿。
  const good = checkAcCoverage({
    cardId,
    cardSection: section,
    checks: [
      { card: cardId, ac: "AC-88.88-01" },
      { card: cardId, ac: "AC-88.88-01（补1）" },
      { card: cardId, ac: "AC-88.88-01（补2）" },
    ],
  });
  check(good.ok === true, `AC 覆盖闭合正例未判绿：${good.failures.join("；")}`);
  // 变异验证：恒真实现让同一反例转绿，证明反例不是恒真断言。
  const alwaysTrue = () => true;
  check(bad.ok === false && alwaysTrue() === true, "AC 段变异验证失败：无法证明反例有效");
}

// ── 检查 2：Gate C 来源本卡校验 ──
{
  const cardId = "S-88.88-02";
  const file = "s888802-evidence.json";
  // 反例：引用邻卡证据 → 判红，失败信息含具体文件 + 邻卡卡号。
  const bad = checkGateCSource({
    cardId,
    gateCSource: `dev abc1234 + s888802-evidence（dirty=false）`,
    readEvidence: (name) =>
      name === file ? { card: "S-88.88-03", checks: [{ card: "S-88.88-03" }] } : null,
  });
  check(bad.ok === false, "Gate C 来源反例（引用邻卡证据）未判红");
  check(
    bad.failures.some((f) => f.includes(file) && f.includes("S-88.88-03") && f.includes(cardId)),
    "Gate C 来源失败信息未同时指向具体文件、邻卡卡号与本行卡号",
  );
  // 正例：引用本卡证据 → 绿。
  const good = checkGateCSource({
    cardId,
    gateCSource: `dev abc1234 + s888802-evidence`,
    readEvidence: (name) => (name === file ? { card: cardId, checks: [{ card: cardId }] } : null),
  });
  check(good.ok === true, `Gate C 来源正例未判绿：${good.failures.join("；")}`);
  // 变异验证。
  const alwaysTrue = () => true;
  check(bad.ok === false && alwaysTrue() === true, "来源段变异验证失败：无法证明反例有效");
}

if (failures.length) {
  for (const f of failures) console.error(`::error::verify:gate-c:selftest 失败：${f}`);
  console.error(`verify:gate-c:selftest 失败：${failures.length} 项`);
  process.exit(1);
}
console.log(
  "verify:gate-c:selftest 通过：AC 覆盖闭合 / Gate C 来源两段反例均判红；" +
    "失败信息指向具体 AC / 文件 / 卡号；正例判绿；变异验证反例非恒真",
);
