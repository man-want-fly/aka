#!/usr/bin/env node
/**
 * AC token 静态门禁（W-107，独立 CI job，失败阻断合并）。
 *
 * 规则 1（W-107 原有）：app/src/features 下所有 *Diag.ts 里的 AC 字面量必须匹配卡面口径：
 *   ^AC-\d{2}\.\d{2}-\d{2}(（补\d+）)?$
 * 半角括号、空格分隔、带描述标签的写法一律判红，避免等取证跑到了才暴露。
 * 规则 2（W-119e 新增）：s030201 的 ac 字面量必须是「卡 S-03.02-01 卡面内的整 AC token」
 *   ——与 verify_evidence.mjs 的 CARD_AC_TOKENS 同口径，合法集从卡面按段动态解析，不硬编码白名单。
 *   只堵「格式合法但卡面不存在」（如 AC-03.02-01（补1））这类等到取证才判红的问题。
 *
 * 用法：
 *   node scripts/verify_ac_token.mjs              # 扫描 src/features + s030201 整 token 命中
 *   node scripts/verify_ac_token.mjs --selftest   # 第 29 条反例自证（含新增整 token 反例）
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../src/features");

const AC_TOKEN = /^AC-\d{2}\.\d{2}-\d{2}(（补\d+）)?$/;
const LITERAL_PATTERNS = [/"([^"\n]*)"/g, /'([^'\n]*)'/g, /`([^`\n]*)`/g];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith("Diag.ts")) out.push(path);
  }
  return out;
}

function acLiterals(source) {
  const found = [];
  for (const pattern of LITERAL_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      if (match[1].startsWith("AC-")) {
        found.push({ value: match[1], index: match.index ?? 0 });
      }
    }
  }
  return found;
}

// —— W-119e：s030201 单卡「ac 必须命中本卡卡面整 token」映射表校验 ——
// 为什么不通用化到全部 *Diag.ts（否则会误伤历史卡，且不得靠加白名单修绿）：
//   (1) 合法邻卡 AC 引用：s030104 的 check.card=S-03.01-04 却用 AC-03.01-05* 前缀，
//       这些 AC 定义行物理落在 S-03.01-04 卡段内（卡面 L1940-1944），按前缀硬绑卡会误判；
//   (2) 另有 10 处历史 runner 字面量（s20101Diag.ts / s20501Diag.ts 的补号）在卡面任一段
//       都查不到对应整 token，属既有遗留，改判据或加白名单都越界。
// 故只对 s030201 建「runner 文件 ↔ 卡段」映射，合法集从卡面动态解析，绝不硬编码白名单。
const CARD_DOC = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../docs/story-cards/aka-story-cards-v0.1.md",
);
const S030201 = { file: "batchDiag.ts", card: "S-03.02-01", func: "runS030201Diagnostics" };
const CARD_HEADING = /^#{2,4}\s+(S-\d{2}\.\d{2}-\d{2})/gm;

/** 按 verify_evidence.mjs 的 CARD_AC_TOKENS 口径，取某卡卡段内的整 AC token 集。 */
function cardSectionTokens(cardText, cardId) {
  const heads = [...cardText.matchAll(CARD_HEADING)];
  const idx = heads.findIndex((m) => m[1] === cardId);
  if (idx < 0) return null;
  const start = heads[idx].index;
  const end = idx + 1 < heads.length ? heads[idx + 1].index : cardText.length;
  return new Set(cardText.slice(start, end).match(/AC-\d{2}\.\d{2}-\d{2}(（补\d+）)?/g) ?? []);
}

/** s030201 suite 内每条 ac 字面量必须命中卡段整 token 集；返回违规描述数组。 */
function cardHitViolations(source, cardText, label) {
  const tokens = cardSectionTokens(cardText, S030201.card);
  if (!tokens || tokens.size === 0) {
    return [`${label}: 无法解析卡 ${S030201.card} 卡段的整 AC token（拒绝放行）`];
  }
  const start = source.indexOf(`export async function ${S030201.func}(`);
  if (start < 0) return [`${label}: 未找到 ${S030201.func}（s030201 suite 缺失，拒绝放行）`];
  const rest = source.slice(start);
  const next = rest.indexOf("\nexport async function ", 1);
  const body = next < 0 ? rest : rest.slice(0, next);
  const violations = [];
  let count = 0;
  for (const lit of acLiterals(body)) {
    count += 1;
    if (!tokens.has(lit.value)) {
      const line = source.slice(0, start + (lit.index ?? 0)).split("\n").length;
      violations.push(`${label}:${line}  ac=${lit.value} 不是卡 ${S030201.card} 卡面内的整 AC token`);
    }
  }
  if (count === 0) violations.push(`${label}: ${S030201.func} 内未见任何 AC 字面量（拒绝空转）`);
  return violations;
}

/** 定向校验：只对 s030201 的 runner 文件执行整 token 命中判定。找不到文件即红（防删文件绕过）。 */
function checkCardHit(root, cardText) {
  const files = walk(root).filter((f) => basename(f) === S030201.file);
  if (files.length === 0) {
    return [`${S030201.file}: 未找到 s030201 runner（拒绝空转，防删文件绕过整 token 校验）`];
  }
  const violations = [];
  for (const file of files) {
    violations.push(...cardHitViolations(readFileSync(file, "utf8"), cardText, basename(file)));
  }
  return violations;
}

function check(root) {
  const violations = [];
  for (const file of walk(root).sort()) {
    const source = readFileSync(file, "utf8");
    for (const literal of acLiterals(source)) {
      if (AC_TOKEN.test(literal.value)) continue;
      const line = source.slice(0, literal.index).split("\n").length;
      violations.push(`${file}:${line}  ${literal.value}`);
    }
  }
  return violations;
}

function selftest() {
  const dir = mkdtempSync(join(tmpdir(), "aka-ac-token-"));
  try {
    const goodDir = join(dir, "good");
    const badDir = join(dir, "bad");
    mkdirSync(goodDir);
    mkdirSync(badDir);
    writeFileSync(
      join(goodDir, "goodDiag.ts"),
      'push("R-01", "AC-07.01-02（补3）", "render", true, "ok");\n',
    );
    writeFileSync(
      join(badDir, "badDiag.ts"),
      'push("R-02", "AC-07.01-02(补3)", "render", true, "ok");\n',
    );
    const good = check(goodDir);
    const bad = check(badDir);
    const halfWidth = bad.some((item) => item.includes("AC-07.01-02(补3)"));
    if (good.length !== 0 || bad.length !== 1 || !halfWidth) {
      console.error(`::error::verify:ac-token selftest 失败：good=${good.length} bad=${bad.length}`);
      process.exitCode = 1;
      return;
    }

    // W-119e 新增反例：格式合法但卡面不存在的整 token（如 AC-03.02-01（补1））必须判红。
    // 复用真实卡面文本做卡段解析，suite 内放 6 个合法 + 1 个非法；再加全合法正例做双向。
    const cardText = readFileSync(CARD_DOC, "utf8");
    const legalTokens = [...cardSectionTokens(cardText, S030201.card)];
    if (legalTokens.length === 0) {
      console.error("::error::verify:ac-token selftest 失败：卡段整 token 解析为空");
      process.exitCode = 1;
      return;
    }
    const mkSuite = (tokens) =>
      [
        `export async function ${S030201.func}() {`,
        ...tokens.map((t, i) => `  push("R-${i}", "${t}", "render", true, "ok");`),
        "}",
      ].join("\n");
    const cardGoodDir = join(dir, "card-good");
    const cardBadDir = join(dir, "card-bad");
    mkdirSync(cardGoodDir);
    mkdirSync(cardBadDir);
    writeFileSync(join(cardGoodDir, S030201.file), mkSuite(legalTokens));
    // 反例：把其中一个合法 token 换成「格式合法但卡面不存在」的补号 token。
    writeFileSync(
      join(cardBadDir, S030201.file),
      mkSuite([...legalTokens.slice(0, 1), "AC-03.02-01（补1）", ...legalTokens.slice(1)]),
    );
    const cardGood = checkCardHit(cardGoodDir, cardText);
    const cardBad = checkCardHit(cardBadDir, cardText);
    const notInCard = cardBad.some((item) => item.includes("AC-03.02-01（补1）") && item.includes("不是卡"));
    const formatLegal = AC_TOKEN.test("AC-03.02-01（补1）"); // 证明该 token 格式合法、旧格式检查本会放行
    if (cardGood.length !== 0 || cardBad.length !== 1 || !notInCard || !formatLegal) {
      console.error(
        `::error::verify:ac-token selftest 失败（整 token 命中）：cardGood=${cardGood.length} cardBad=${cardBad.length} notInCard=${notInCard} formatLegal=${formatLegal}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      "verify:ac-token:selftest 通过：全角正例变绿，半角反例变红；" +
        "s030201 全合法正例变绿，格式合法但卡面不存在的 token（AC-03.02-01（补1））反例变红",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv.includes("--selftest")) {
  selftest();
} else {
  const violations = check(ROOT);
  let cardText;
  try {
    cardText = readFileSync(CARD_DOC, "utf8");
    violations.push(...checkCardHit(ROOT, cardText));
  } catch (error) {
    violations.push(`s030201 整 token 校验读取卡面失败（拒绝放行）：${error.message}`);
  }
  if (violations.length > 0) {
    for (const item of violations) console.error(`::error::AC token 不合规：${item}`);
    console.error(`verify:ac-token 失败：${violations.length} 处（格式口径 + s030201 卡面整 token 命中）`);
    process.exitCode = 1;
  } else {
    console.log(
      "verify:ac-token 通过：所有 *Diag.ts 的 AC 字面量均为卡面口径；" +
        `s030201 的 ${cardSectionTokens(cardText, S030201.card).size} 个合法整 token 与 runner ac 全部命中`,
    );
    console.log(
      "  范围说明：整 token 命中判定只对 s030201 建映射表，未通用化到全部 *Diag.ts —— " +
        "存在合法邻卡 AC 引用（s030104 用 AC-03.01-05* 前缀，定义行在 S-03.01-04 卡段内）" +
        "及 10 处卡面无对应补号的历史 runner 字面量（s20101Diag/s20501Diag）；" +
        "通用化会误伤历史卡，且不得靠改判据/加白名单修绿。",
    );
  }
}
