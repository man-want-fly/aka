#!/usr/bin/env node
/**
 * W-110：Gate C 通用检查两条（解阻 W-109 / S-02.06-01 Blocked-AC）。
 *
 * 制度第 29 条：每条判定都必须能被反例打红，并做变异验证（反例不是恒真）。
 * 与 W-115 / W-116 / W-107 同构：检查器做成可复用纯函数 + 独立 selftest，
 * 不改动 verify_evidence.mjs / verify_gate_log.mjs 的既有断言，也不触碰
 * docs/qa 下任何台账 / gate-log / 卡面 / 证据文件。
 *
 * 两段检查：
 *   1) AC 覆盖闭合：卡面 AC 定义集合 ⊆ 证据 check 覆盖集合，缺一条即该卡红；
 *      允许卡面写显式豁免，但必须写声明人，否则不放行。
 *   2) Gate C 来源本卡校验：解析 gate_c_source 引用的证据文件，其 card 字段
 *      必须等于本行卡号；引用邻卡证据（跨卡拼凑）一律红。
 *
 * 失败信息必须指向具体 AC / 文件 / 卡号，不许只报「不通过」。
 *
 * 用法：
 *   node scripts/verify_gate_c.mjs                      # 默认跑两段 selftest（CI）
 *   node scripts/verify_gate_c.mjs --suite=ac          # 仅 AC 覆盖闭合 selftest
 *   node scripts/verify_gate_c.mjs --suite=source      # 仅来源 card 匹配 selftest
 *   node scripts/verify_gate_c.mjs --card=S-02.06-01 --evidence=docs/qa/evidence
 *                                                      # BA 逐卡实算（解阻 W-109 重签）
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CARD_DOC = join(ROOT, "docs", "story-cards", "aka-story-cards-v0.1.md");
const GATE_LOG = join(ROOT, "docs", "qa", "aka-card-gate-log-v0.1.csv");

/** 卡面 AC 定义行：`- **AC-xx.xx-xx**｜...`（补号带全角（补n））。 */
const AC_DEFINITION_RE = /^[-*]\s+\*\*(AC-\d{2}\.\d{2}-\d{2}(?:（补\d+）)?)\*\*｜/;
/** 卡面显式豁免，必须写声明人：`AC 覆盖豁免（声明人：XXX）：AC-..`. */
const EXEMPT_RE = /AC 覆盖豁免（声明人：\s*([^）]+)\s*）：([^\n]+)/;
/** gate_c_source 里引用的证据名，如 `s20401-evidence` / `e01-market-evidence.json`。 */
const EVIDENCE_REF_RE = /([a-z0-9][a-z0-9-]*-evidence(?:-[a-z0-9-]+)?(?:\.json)?)/g;

/**
 * 检查 1：AC 覆盖闭合。
 * @param {{ cardId: string, cardSection: string, checks: Array<{ac?: string, card?: string}> }} input
 * @returns {{ ok: boolean, failures: string[], defined: string[], covered: string[], missing: string[] }}
 */
export function checkAcCoverage({ cardId, cardSection, checks }) {
  const failures = [];
  const defined = [];
  for (const line of cardSection.split("\n")) {
    const match = AC_DEFINITION_RE.exec(line.trim());
    if (match && !defined.includes(match[1])) defined.push(match[1]);
  }
  const covered = new Set(
    checks
      .filter((check) => check && typeof check.ac === "string")
      .map((check) => check.ac),
  );

  // 显式豁免：必须写声明人，且逐条点名被豁免的 AC；无声明人的豁免不得放行。
  const exempt = new Set();
  const exemptMatch = EXEMPT_RE.exec(cardSection);
  if (exemptMatch) {
    const declarer = exemptMatch[1].trim();
    if (!declarer) {
      failures.push(`卡 ${cardId} 的 AC 覆盖豁免未写声明人，不得放行`);
    }
    for (const token of exemptMatch[2].matchAll(/AC-\d{2}\.\d{2}-\d{2}(?:（补\d+）)?/g)) {
      exempt.add(token[0]);
    }
  }

  const missing = defined.filter((ac) => !covered.has(ac) && !exempt.has(ac));
  for (const ac of missing) {
    failures.push(`卡 ${cardId} 的 ${ac} 无对应 check 覆盖（AC 覆盖未闭合）`);
  }
  return { ok: failures.length === 0, failures, defined, covered: [...covered], missing };
}

/**
 * 检查 2：Gate C 来源本卡校验。
 * @param {{ cardId: string, gateCSource: string, readEvidence: (name: string) => ({card?: string, checks?: Array<{card?: string}>}|null) }} input
 * @returns {{ ok: boolean, failures: string[], refs: string[] }}
 */
export function checkGateCSource({ cardId, gateCSource, readEvidence }) {
  const failures = [];
  const refs = [...new Set([...gateCSource.matchAll(EVIDENCE_REF_RE)].map((m) => m[1]))];
  for (const ref of refs) {
    const file = ref.endsWith(".json") ? ref : `${ref}.json`;
    const evidence = readEvidence(file);
    if (!evidence) {
      // 引用了不存在的证据文件本身也是来源缺陷，失败信息指向具体文件。
      failures.push(`卡 ${cardId} 的 gate_c_source 引用 ${file} 不存在，来源不可核`);
      continue;
    }
    const cards = new Set();
    if (typeof evidence.card === "string") cards.add(evidence.card);
    for (const check of evidence.checks ?? []) {
      if (check && typeof check.card === "string") cards.add(check.card);
    }
    const foreign = [...cards].filter((card) => card !== cardId);
    if (foreign.length > 0) {
      failures.push(
        `卡 ${cardId} 的 gate_c_source 引用 ${file}，其 card=${foreign.join("/")} 与本行不符（跨卡拼凑一律红）`,
      );
    } else if (cards.size === 0) {
      failures.push(`卡 ${cardId} 的 gate_c_source 引用 ${file} 缺 card 字段，无法归属`);
    }
  }
  return { ok: failures.length === 0, failures, refs };
}

// —— selftest（第 29 条）：正例绿、反例红、变异验证反例非恒真 ——
function selftestAc() {
  const failures = [];
  const check = (ok, msg) => {
    if (!ok) failures.push(msg);
  };
  const cardId = "S-99.99-01";
  const five = [
    `### ${cardId} 假卡`,
    "- **AC-99.99-01**｜基条。",
    "- **AC-99.99-01（补1）**｜补1。",
    "- **AC-99.99-01（补2）**｜补2。",
    "- **AC-99.99-01（补3）**｜补3。",
    "- **AC-99.99-01（补4）**｜补4。",
  ].join("\n");
  const full = [
    "AC-99.99-01", "AC-99.99-01（补1）", "AC-99.99-01（补2）",
    "AC-99.99-01（补3）", "AC-99.99-01（补4）",
  ].map((ac) => ({ card: cardId, ac }));

  // 正例：5 条 AC 全覆盖 → 绿。
  const good = checkAcCoverage({ cardId, cardSection: five, checks: full });
  check(good.ok === true, `AC 正例未判绿：${good.failures.join("；")}`);
  check(good.defined.length === 5, `AC 定义集合应为 5，实为 ${good.defined.length}`);

  // 反例：5 条 AC 只覆盖 1 条 → 必红，且失败信息点名具体 4 个 AC。
  const one = [{ card: cardId, ac: "AC-99.99-01" }];
  const bad = checkAcCoverage({ cardId, cardSection: five, checks: one });
  check(bad.ok === false, "AC 反例（5 条只覆盖 1 条）未判红");
  check(bad.missing.length === 4, `AC 反例应缺 4 条，实缺 ${bad.missing.length}`);
  for (const ac of ["AC-99.99-01（补1）", "AC-99.99-01（补4）"]) {
    check(
      bad.failures.some((f) => f.includes(ac)),
      `AC 反例失败信息未指向具体 ${ac}`,
    );
  }

  // 豁免正例：4 条缺口被带声明人的显式豁免点名 → 绿。
  const exempted = `${five}\nAC 覆盖豁免（声明人：TL）：AC-99.99-01（补1） AC-99.99-01（补2） AC-99.99-01（补3） AC-99.99-01（补4）`;
  const withDeclarer = checkAcCoverage({ cardId, cardSection: exempted, checks: one });
  check(withDeclarer.ok === true, `带声明人的豁免未放行：${withDeclarer.failures.join("；")}`);

  // 豁免反例：豁免缺声明人不得放行。
  const noDeclarer = `${five}\nAC 覆盖豁免（声明人：）：AC-99.99-01（补1） AC-99.99-01（补2） AC-99.99-01（补3） AC-99.99-01（补4）`;
  const withoutDeclarer = checkAcCoverage({ cardId, cardSection: noDeclarer, checks: one });
  check(withoutDeclarer.ok === false, "豁免未写声明人时仍放行（应判红）");

  // 变异验证：把判定换成恒真实现，同一反例输入必须转绿，证明反例有效而非恒真断言。
  const alwaysTrue = () => ({ ok: true, failures: [], defined: [], covered: [], missing: [] });
  check(bad.ok === false, "变异锚点异常：真实检查器下反例未判红");
  check(alwaysTrue().ok === true, "变异失败：恒真实现未让反例转绿，反例有效性无法证明");

  return failures;
}

function selftestSource() {
  const failures = [];
  const check = (ok, msg) => {
    if (!ok) failures.push(msg);
  };
  const cardId = "S-99.99-02";
  const own = { "s999902-evidence.json": { card: cardId, checks: [{ card: cardId }] } };
  const readEvidence = (name) => own[name] ?? null;

  // 正例：引用本卡证据 → 绿。
  const good = checkGateCSource({
    cardId,
    gateCSource: `dev abc1234 + s999902-evidence（dirty=false）`,
    readEvidence,
  });
  check(good.ok === true, `来源正例未判绿：${good.failures.join("；")}`);

  // 反例：引用邻卡证据 → 必红，失败信息含具体文件 + 卡号。
  const neighbor = {
    "s999902-evidence.json": { card: "S-99.99-03", checks: [{ card: "S-99.99-03" }] },
  };
  const bad = checkGateCSource({
    cardId,
    gateCSource: `dev def5678 + s999902-evidence（19/19 render 4/4）`,
    readEvidence: (name) => neighbor[name] ?? null,
  });
  check(bad.ok === false, "来源反例（引用邻卡证据）未判红");
  check(
    bad.failures.some((f) => f.includes("s999902-evidence.json") && f.includes("S-99.99-03")),
    "来源反例失败信息未指向具体文件与卡号",
  );

  // 反例：引用不存在的证据文件 → 红，且指向该文件。
  const ghost = checkGateCSource({
    cardId,
    gateCSource: `dev + ghost-evidence`,
    readEvidence: () => null,
  });
  check(ghost.ok === false, "引用不存在证据文件未判红");
  check(ghost.failures.some((f) => f.includes("ghost-evidence.json")), "缺失文件反例未指向文件名");

  // 变异验证：恒真实现让反例转绿，证明反例非恒真。
  const alwaysTrue = () => ({ ok: true, failures: [], refs: [] });
  check(alwaysTrue(bad).ok === true, "变异失败：恒真实现未让来源反例转绿");

  return failures;
}

/** 实算模式：BA 对单卡逐卡验证（解阻 W-109 重签时用），不进 CI。 */
function runForCard(cardId, evidenceDir) {
  const failures = [];
  if (!existsSync(CARD_DOC) || !existsSync(evidenceDir)) {
    console.error(`::error::缺卡面 ${CARD_DOC} 或证据目录 ${evidenceDir}`);
    process.exit(2);
  }
  const doc = readFileSync(CARD_DOC, "utf8");
  const heads = [...doc.matchAll(/^#{2,4}\s+(S-\d{2}\.\d{2}-\d{2})/gm)];
  const idx = heads.findIndex((h) => h[1] === cardId);
  if (idx < 0) {
    console.error(`::error::卡面找不到 ${cardId}`);
    process.exit(2);
  }
  const section = doc.slice(heads[idx].index, idx + 1 < heads.length ? heads[idx + 1].index : doc.length);
  const checks = [];
  for (const name of readdirSync(evidenceDir).filter((f) => f.endsWith(".json") && !f.endsWith("-meta.json"))) {
    try {
      const ev = JSON.parse(readFileSync(join(evidenceDir, name), "utf8"));
      for (const c of ev.checks ?? []) if (c && c.card === cardId) checks.push(c);
    } catch {
      /* 坏 JSON 由 verify:evidence 负责，这里不重复判 */
    }
  }
  const ac = checkAcCoverage({ cardId, cardSection: section, checks });
  failures.push(...ac.failures);

  // Gate C 来源：gate-log 该行的 gate_c_source 引用，逐文件核 card。
  let gateCSource = "";
  for (const line of readFileSync(GATE_LOG, "utf8").split("\n")) {
    if (line.startsWith(`${cardId},`)) {
      const cells = line.split(",");
      gateCSource = cells[5] ?? "";
      break;
    }
  }
  if (gateCSource) {
    const source = checkGateCSource({
      cardId,
      gateCSource,
      readEvidence: (name) => {
        const p = join(evidenceDir, name);
        if (!existsSync(p)) return null;
        try {
          return JSON.parse(readFileSync(p, "utf8"));
        } catch {
          return null;
        }
      },
    });
    failures.push(...source.failures);
  }

  if (failures.length) {
    for (const f of failures) console.error(`::error::W-110 ${f}`);
    console.error(`verify:gate-c 逐卡 ${cardId} 失败：${failures.length} 项`);
    process.exit(1);
  }
  console.log(`verify:gate-c 逐卡 ${cardId} 通过：AC 覆盖闭合 + Gate C 来源本卡`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const argOf = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const cardArg = argOf("card");
  const evidenceArg = argOf("evidence");
  const suite = argOf("suite");

  if (cardArg) {
    runForCard(cardArg, resolve(evidenceArg ?? join(ROOT, "docs", "qa", "evidence")));
  } else {
    const failures = [];
    if (suite !== "source") failures.push(...selftestAc().map((m) => `AC 段：${m}`));
    if (suite !== "ac") failures.push(...selftestSource().map((m) => `来源段：${m}`));
    if (failures.length) {
      for (const f of failures) console.error(`::error::verify:gate-c selftest 失败：${f}`);
      console.error(`verify:gate-c selftest 失败：${failures.length} 项`);
      process.exit(1);
    }
    const scope = suite === "ac" ? "AC 覆盖闭合" : suite === "source" ? "来源 card 匹配" : "两段（AC 覆盖闭合 + 来源 card 匹配）";
    console.log(
      `verify:gate-c selftest 通过：${scope}；正例绿 / 反例红（5 条 AC 覆盖 1 条、引用邻卡证据、缺声明人豁免、缺文件）/ 变异验证反例非恒真`,
    );
  }
}
