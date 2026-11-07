#!/usr/bin/env node
/**
 * 指标口径页门禁（W-03 / W-28 / AC-03.03-03 补5）
 *
 * 用法：
 *   node scripts/verify_indicator_docs.mjs              # 校验内容库
 *   node scripts/verify_indicator_docs.mjs --self-test  # 脚本自身十用例（用例 9 含五条断言）
 *
 * 退出码：
 *   0 = 覆盖、四段、版本、判据 v3 全部通过，且 skipped=0（SKIP 不算通过）
 *   1 = 内容不合格（缺页 / 多页 / 段落不足 / 版本不符 / 锚点缺失 / v3 判据 FAIL / 有 SKIP）
 *   2 = 输入缺失（manifest / 常量 / 空话词表不可解析，或 content 库不存在/为空）—— 绝不空跑 PASS
 *
 * 覆盖口径（2026-11-07 TL 裁定，原「P0 全覆盖（含 planned P0）」口径作废）：
 *   内容页覆盖集合 = 已实现 ∩ P0；planned 无论 P0/P1 一律不得有页；
 *   coverage / implemented / planned_with_content / out_of_scope 全部由
 *   app/manifest/indicators.json 派生，脚本内不出现任何写死的条数。
 *
 * 判据 v3（W-28 / W-30，六条）：
 *   V3-01 锚点只取结构化字段 abbr/abbrAliases（/、|、空格拆词）+ params(key∪aliases) +
 *         outputs(key∪aliases)，禁止从 formulaSummary 正则刮符号；三者全空 → SKIP 并点名。
 *   V3-02 每个 params 的 key∪aliases 必须与其 default 在同一分句出现（分句边界 =
 *         。；！？与换行，逗号不作边界）；每个 output 的 key∪aliases 都必须出现在 formula 段。
 *   V3-03 长度按有效字符计（剔除 Unicode 标点 P 类与空白 Z 类），80 字门槛。
 *   V3-04 params 段结构：调大/调小各至少一次且所在分句有效字数 ≥10，每个 params key 段内出现。
 *   V3-05 空话词命中即 FAIL；无来源数字命中即 FAIL；词表单一源 app/manifest/doc-lint-words.json。
 *   V3-06 报告增 skipped[]/skipped_count，PASS = failed=0 且 skipped=0。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const MANIFEST_PATH = process.env.AKA_MANIFEST_PATH || path.join(APP, "manifest", "indicators.json");
const CONSTANTS_PATH = path.join(APP, "manifest", "constants.json");
const WORDLIST_PATH = path.join(APP, "manifest", "doc-lint-words.json");
const DEFAULT_CONTENT_DIR = path.join(APP, "content", "indicators");
const CONTENT_DIR = process.env.AKA_CONTENT_DIR || DEFAULT_CONTENT_DIR;
const REPORT_DIR = process.env.AKA_REPORT_DIR || path.join(APP, "dist");
const REPORT_PATH = path.join(REPORT_DIR, "content-coverage-report.json");
const SECTIONS = ["definition", "formula", "params", "usage"];
const MIN_SECTION_CHARS = 80;
const MIN_COMPLETION_NOTE_CHARS = 60;

const argv = new Set(process.argv.slice(2));
const SPLIT_SENTENCE = /[。；！？\r\n]+/;
const effectiveChars = (s) =>
  typeof s === "string" ? [...s.replace(/[\p{P}\p{Z}\s]/gu, "")].length : 0;
const splitClauses = (s) =>
  (typeof s === "string" ? s : "")
    .split(SPLIT_SENTENCE)
    .map((clause) => clause.trim())
    .filter(Boolean);
const containsToken = (haystack, needle) =>
  String(haystack ?? "").toLowerCase().includes(String(needle ?? "").toLowerCase());

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const isWordChar = (ch) => ch !== undefined && /[A-Za-z0-9]/.test(ch);

/**
 * 别名归一化：NFKC → 三种减号统一为 "-"。
 * 一律大小写敏感：不做 casefold / lowercase——那会把参数 `k` 与输出 `K` 合并成假通过；
 * 大小写变体只能靠 manifest 显式登记别名区分。
 */
function normalizeTerm(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u2212\u2013\u2014]/g, "-");
}

/**
 * 别名匹配：拉丁按词边界、中文按子串。
 * 词边界是钉死用例「单字母 N 不得命中 NaN」的实现，不要退回 containsToken。
 */
function matchesAnchor(haystack, term) {
  const needle = normalizeTerm(term).trim();
  if (!needle) return false;
  const text = normalizeTerm(haystack);
  if (CJK.test(needle)) return text.replace(/\s+/g, "").includes(needle.replace(/\s+/g, ""));
  let from = 0;
  while (from < text.length) {
    const index = text.indexOf(needle, from);
    if (index < 0) return false;
    const before = index > 0 ? text[index - 1] : "";
    const after = text[index + needle.length];
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = index + 1;
  }
  return false;
}

const RULES = [
  ["V3-01", "脚本自动", "content formula 段 + manifest abbr/abbrAliases/params/outputs（key∪aliases）", "三者全空 → SKIP 并点名"],
  ["V3-02", "脚本自动", "content formula/params 段 + manifest params/outputs（key∪aliases）", "无 SKIP；key 缺失或不同现 → FAIL"],
  ["V3-03", "脚本自动", "definition/formula/params/usage/completion_note", "无 SKIP（纯字符处理）"],
  ["V3-04", "脚本自动", "content params 段 + manifest params[].key", "无 SKIP；条款缺失 → FAIL"],
  ["V3-05", "脚本自动", "四段 + completion_note，词表 app/manifest/doc-lint-words.json", "词表缺失 → exit 2"],
  ["V3-06", "脚本自动", "脚本自身 stdout 与报告 JSON", "缺 skipped 字段 → FAIL"],
];

function failHard(message) {
  console.error(message);
  process.exit(2);
}

function parseManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch (error) {
    failHard(`manifest_unparsable: app/manifest/indicators.json（${error.message}）`);
  }
}

function parseWordlist() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(WORDLIST_PATH, "utf8"));
  } catch (error) {
    failHard(`wordlist_unparsable: app/manifest/doc-lint-words.json（${error.message}）`);
  }
  const phrases = Array.isArray(data) ? data : data?.phrases;
  if (!Array.isArray(phrases) || !phrases.length) {
    failHard("wordlist_unparsable: app/manifest/doc-lint-words.json（phrases 为空）");
  }
  return phrases.filter((phrase) => typeof phrase === "string" && phrase.trim());
}

/** 覆盖集合 = 已实现 ∩ P0（planned 一律无页，不进入集合） */
function coverageSet(items) {
  return items.filter((item) => item.status !== "planned" && item.priority === "P0");
}

/** V3-01：锚点只取结构化字段（含 W-30 别名），禁止从 formulaSummary 刮符号 */
function structuredAnchors(item) {
  const anchors = [];
  const push = (term, source) => {
    if (typeof term === "string" && term.trim()) anchors.push({ term, source });
  };
  for (const token of String(item.abbr ?? "")
    .split(/[\/|\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    push(token, "abbr");
  }
  for (const alias of item.abbrAliases ?? []) push(alias, `abbrAlias:${alias}`);
  for (const param of item.params ?? []) {
    const key = param?.key;
    if (typeof key !== "string" || !key.trim()) continue;
    push(key, `param.${key}.key`);
    for (const alias of param.aliases ?? []) push(alias, `param.${key}.alias:${alias}`);
  }
  for (const output of item.outputs ?? []) {
    const key = output?.key;
    if (typeof key !== "string" || !key.trim()) continue;
    push(key, `output.${key}.key`);
    for (const alias of output.aliases ?? []) push(alias, `output.${key}.alias:${alias}`);
  }
  return anchors;
}

/** params/outputs 的 key ∪ aliases；aliases 缺失按空数组处理（W-30 第 10 条） */
function termsOf(entry) {
  const list = [];
  if (typeof entry?.key === "string" && entry.key.trim()) list.push(entry.key);
  for (const alias of entry?.aliases ?? []) {
    if (typeof alias === "string" && alias.trim()) list.push(alias);
  }
  return list;
}

const isScalar = (value) =>
  typeof value === "number" || typeof value === "string" || typeof value === "boolean";

/** 数字默认值按词边界匹配，避免 default=2 命中「2–200」里的 2 */
function clauseHasDefault(clause, value) {
  const text = String(value);
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    return new RegExp(`(^|[^0-9.])${text.replace(".", "\\.")}([^0-9.]|$)`).test(clause);
  }
  return clause.includes(text);
}

function listContentFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

/** 单页 v3 判据（V3-01～V3-05），返回 { failed, skipped, anchorHits } */
function checkPageV3(item, page, words) {
  const failed = [];
  const skipped = [];
  const id = item.id;
  const anchors = structuredAnchors(item);
  const paramKeys = (item.params ?? [])
    .map((param) => param?.key)
    .filter((key) => typeof key === "string" && key.trim());
  const formulaText = typeof page.formula === "string" ? page.formula : "";
  const paramsText = typeof page.params === "string" ? page.params : "";

  // V3-01 锚点含别名；三者全空 → SKIP 并点名，不得静默 PASS
  const anchorHits = anchors.map((anchor) => ({
    term: anchor.term,
    source: anchor.source,
    hit: matchesAnchor(formulaText, anchor.term),
  }));
  if (anchorHits.length === 0) {
    skipped.push(`${id}:V3-01`);
  } else if (!anchorHits.some((entry) => entry.hit)) {
    failed.push(`${id}:formula(${anchors.map((anchor) => anchor.term).join("/")})`);
  }

  // V3-02 params 的 key∪aliases 与 default 同分句；每个 output 的 key∪aliases 都必须出现在 formula 段
  const paramClauses = [...splitClauses(paramsText), ...splitClauses(formulaText)];
  for (const param of item.params ?? []) {
    const key = param?.key;
    if (typeof key !== "string" || !key.trim()) continue;
    if (!isScalar(param.default)) {
      failed.push(`${id}:V3-02(manifest:${key})`);
      continue;
    }
    const terms = termsOf(param);
    const sameClause = paramClauses.some(
      (clause) =>
        terms.some((term) => matchesAnchor(clause, term)) &&
        clauseHasDefault(clause, param.default),
    );
    if (!sameClause) failed.push(`${id}:V3-02(${key})`);
  }
  // W-32：逐项命中，不允许「一个输出命中即掩盖其余输出未定义」
  const missingOutputKeys = (item.outputs ?? [])
    .filter((output) => {
      const terms = termsOf(output);
      return terms.length > 0 && !terms.some((term) => matchesAnchor(formulaText, term));
    })
    .map((output) => output.key)
    .filter((key) => typeof key === "string" && key.trim());
  if (missingOutputKeys.length > 0) {
    failed.push(`${id}:V3-02(outputs:${missingOutputKeys.join("/")})`);
  }

  // V3-03 长度按有效字符（M02 等长段落已在覆盖检查里按 80 计）
  // 该条由调用方统一计算，这里只处理 v3 语义检查

  // V3-04 params 段结构：调大/调小各一次且分句有效字数 ≥10；每个 key 段内出现
  for (const direction of ["调大", "调小"]) {
    if (!paramsText.includes(direction)) {
      failed.push(`${id}:V3-04(${direction}缺失)`);
      continue;
    }
    const clause = splitClauses(paramsText).find((entry) => entry.includes(direction));
    if (!clause || effectiveChars(clause) < 10) {
      failed.push(`${id}:V3-04(${direction}分句过短)`);
    }
  }
  for (const key of paramKeys) {
    if (!containsToken(paramsText, key)) failed.push(`${id}:V3-04(${key})`);
  }

  // V3-05 空话词与无来源数字
  const texts = [...SECTIONS, "completion_note"].map((section) =>
    typeof page[section] === "string" ? page[section] : "",
  );
  for (const text of texts) {
    for (const phrase of words) {
      if (text.includes(phrase)) failed.push(`${id}:V3-05(空话:${phrase})`);
    }
    const metricRe = /(胜率|年化|成功率|准确率)/g;
    for (const match of text.matchAll(metricRe)) {
      const window = text.slice(match.index, match.index + match[0].length + 20);
      if (/\d/.test(window) && !/来源|[S\d]|https?:\/\/|www\./.test(window)) {
        failed.push(`${id}:V3-05(无来源数字:${match[0]})`);
      }
    }
  }

  return { failed, skipped, anchorHits };
}

function buildReport({ items, coverage, constants, files, words, parseErrors }) {
  const catalogIds = new Set(items.map((item) => item.id));
  const coverageIds = new Set(coverage.map((item) => item.id));
  const plannedIds = new Set(items.filter((item) => item.status === "planned").map((item) => item.id));
  const pages = new Map();
  parseErrors.sort((a, b) => a.localeCompare(b));

  for (const name of files) {
    const id = name.replace(/\.json$/i, "");
    if (!name.toLowerCase().endsWith(".json")) {
      continue;
    }
    if (!catalogIds.has(id)) continue;
    try {
      pages.set(id, JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, name), "utf8")));
    } catch (error) {
      parseErrors.push(`${id}:json（${error.message}）`);
    }
  }

  const missing = coverage.filter((item) => !pages.has(item.id)).map((item) => item.id);
  const extra = files
    .filter((name) => !catalogIds.has(name.replace(/\.json$/i, "")))
    .map((name) => name);
  const plannedWithContent = items
    .filter((item) => plannedIds.has(item.id) && pages.has(item.id))
    .map((item) => item.id);
  // 已实现但非 P0 的页（当前为 0）也属越界；规则由「覆盖集合 = 已实现 ∩ P0」派生
  const outOfScope = [...pages.keys()]
    .filter((id) => !coverageIds.has(id) && !plannedIds.has(id))
    .sort();
  const failed = [...parseErrors];
  const skipped = [];
  const anchorHits = {};

  for (const item of coverage) {
    const page = pages.get(item.id);
    if (!page) continue;
    for (const section of SECTIONS) {
      if (effectiveChars(page[section]) < MIN_SECTION_CHARS) failed.push(`${item.id}:${section}`);
    }
    const expectedVersion = item.version ?? 1;
    if (page.version !== expectedVersion) failed.push(`${item.id}:version`);
    if (item.isCompletion && effectiveChars(page.completion_note) < MIN_COMPLETION_NOTE_CHARS) {
      failed.push(`${item.id}:completion_note`);
    }
    const result = checkPageV3(item, page, words);
    failed.push(...result.failed);
    skipped.push(...result.skipped);
    anchorHits[item.id] = result.anchorHits;
  }

  return {
    version: constants.version,
    total: items.length,
    implemented: items.filter((item) => item.status !== "planned").length,
    coverage: coverage.length,
    covered: coverage.filter((item) => pages.has(item.id)).length,
    missing,
    extra,
    planned_with_content: plannedWithContent.sort(),
    out_of_scope: outOfScope,
    failed: failed.sort(),
    skipped: skipped.sort(),
    skipped_count: skipped.length,
    anchor_hits: anchorHits,
  };
}

function stableJson(report) {
  const { generatedAt, ...rest } = report;
  return JSON.stringify({ ...rest, generatedAt: "<ignored>" });
}

function printRules() {
  console.log("判据｜执行者｜覆盖范围｜不可判定处置");
  for (const [id, executor, scope, fallback] of RULES) {
    console.log(`${id}｜${executor}｜${scope}｜${fallback}`);
  }
}

function main() {
  const manifest = parseManifest();
  const items = manifest.indicators ?? manifest;
  const coverage = coverageSet(items);
  const words = parseWordlist();
  let constants;
  try {
    constants = JSON.parse(fs.readFileSync(CONSTANTS_PATH, "utf8"));
  } catch (error) {
    failHard(`constants_unparsable: app/manifest/constants.json（${error.message}）`);
  }

  if (!fs.existsSync(CONTENT_DIR) || !fs.statSync(CONTENT_DIR).isDirectory()) {
    failHard(`content_library_missing: app/content/indicators`);
  }
  const files = listContentFiles(CONTENT_DIR);
  if (files.length === 0) failHard(`content_library_missing: app/content/indicators`);

  const report = buildReport({ items, coverage, constants, files, words, parseErrors: [] });
  report.generatedAt = new Date().toISOString();

  // 同一输入连续两次构建，除 generatedAt 外字节一致
  const second = buildReport({ items, coverage, constants, files, words, parseErrors: [] });
  second.generatedAt = report.generatedAt;
  if (stableJson(report) !== stableJson(second)) {
    const a = stableJson(report).split("\n");
    const b = stableJson(second).split("\n");
    const first = a.find((line, i) => line !== b[i]) ?? "(未知)";
    console.error(`determinism_failed：两次报告不一致，首个差异行 ${first}`);
    process.exit(1);
  }

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  printRules();
  console.log("指标口径页覆盖检查");
  console.log(`内容库：${path.relative(APP, CONTENT_DIR)}`);
  console.log(
    `覆盖：${report.covered}/${report.coverage}（已实现 ∩ P0 = ${report.coverage}；manifest ${report.total} / 已实现 ${report.implemented}）`,
  );
  if (report.missing.length) console.log(`  缺页：${report.missing.join(", ")}`);
  if (report.extra.length) console.log(`  多出：${report.extra.join(", ")}`);
  if (report.planned_with_content.length) console.log(`  planned 却有内容页：${report.planned_with_content.join(", ")}`);
  if (report.out_of_scope.length) console.log(`  越界内容页：${report.out_of_scope.join(", ")}`);
  if (report.skipped.length) console.log(`  SKIP（不给 PASS，需归类）：${report.skipped.join(", ")}`);
  if (report.failed.length) console.log(`  不合格：${report.failed.join(", ")}`);
  // W-30：逐个锚点打印命中来源（是 key 命中还是哪个别名命中），便于区分内容变化与别名变化
  const anchorIds = Object.keys(report.anchor_hits ?? {});
  if (anchorIds.length) {
    console.log("锚点命中来源（V3-01）：");
    for (const id of anchorIds) {
      const hits = report.anchor_hits[id];
      console.log(
        `  ${id}: ${hits
          .map((entry) => `${entry.source}=${entry.hit ? "命中" : "未命中"}[${entry.term}]`)
          .join(" ")}`,
      );
    }
  }
  console.log(`报告：${path.relative(APP, REPORT_PATH)}`);

  const ok =
    report.missing.length === 0 &&
    report.extra.length === 0 &&
    report.planned_with_content.length === 0 &&
    report.out_of_scope.length === 0 &&
    report.failed.length === 0 &&
    report.skipped_count === 0;
  console.log(`结论：${ok ? "PASS" : "FAIL"}（failed=${report.failed.length} skipped=${report.skipped_count}）`);
  process.exit(ok ? 0 : 1);
}

// ---------- 脚本自测（九用例，用例 9 含五条断言） ----------
function buildFixturePage(item) {
  const anchors = structuredAnchors(item);
  const paramKeys = (item.params ?? [])
    .map((param) => param?.key)
    .filter((key) => typeof key === "string" && key.trim());
  const outputTerms = (item.outputs ?? []).flatMap((output) => termsOf(output));
  // W-32 逐项命中：夹具页必须把每个输出的 key/别名都写进 formula，不能只写第一个
  const formulaTerms = [outputTerms.join("、"), paramKeys[0], anchors[0]?.term].filter(Boolean);
  const anchor = formulaTerms.length ? formulaTerms.join("、") : item.id;
  const filler = "口径说明用于占位，确保段落长度达标。".repeat(6);
  const paramLines = paramKeys.map((key) => {
    const param = (item.params ?? []).find((entry) => entry.key === key);
    return `${key} 默认取 ${param?.default ?? 0}，调整后窗口与灵敏度随之改变。`;
  });
  const paramsBody = `${paramLines.length ? `${paramLines.join("；")}；` : ""}参数调大时曲线更平滑、反应更慢，适合长周期观察；调小时曲线更灵敏、假信号更多，适合短周期观察。${filler}`;
  return {
    version: item.version ?? 1,
    definition: `${item.nameZh ?? item.id} 的定义。${filler}`,
    formula: `公式：${anchor} 由输入序列逐根计算得到。${filler}`,
    params: paramsBody,
    usage: `使用场景。${filler}`,
    completion_note: item.isCompletion ? `补全说明。${filler}` : undefined,
  };
}

function writeFixturePages(dir, items, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const seed = opts.seed ?? items;
  for (const item of seed) {
    const page = buildFixturePage(item);
    if (opts.dropUsageOf === item.id) delete page.usage;
    if (opts.mutate) opts.mutate(item, page);
    fs.writeFileSync(path.join(dir, `${item.id}.json`), JSON.stringify(page, null, 2));
  }
}

function runSelfTest() {
  const manifest = parseManifest();
  const items = manifest.indicators ?? manifest;
  const coverage = coverageSet(items);
  const words = parseWordlist();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aka-docs-"));
  const self = fileURLToPath(import.meta.url);
  const run = (dir, reportDir, env = {}) =>
    spawnSync(process.execPath, [self], {
      encoding: "utf8",
      env: { ...process.env, AKA_CONTENT_DIR: dir, AKA_REPORT_DIR: reportDir, ...env },
    });
  const readReport = (dir) =>
    JSON.parse(fs.readFileSync(path.join(dir, "content-coverage-report.json"), "utf8"));

  const results = [];
  const record = (name, ok, detail) => results.push({ name, ok, detail });

  const missingDir = path.join(root, "missing");
  const r1 = run(missingDir, path.join(root, "report1"));
  record("用例1 库缺失 → exit 2", r1.status === 2 && /content_library_missing/.test(r1.stderr + r1.stdout), `exit=${r1.status}`);

  const oneDir = path.join(root, "one");
  writeFixturePages(oneDir, coverage.slice(0, 1));
  const report2Dir = path.join(root, "report2");
  const r2 = run(oneDir, report2Dir);
  const report2 = readReport(report2Dir);
  record(
    `用例2 缺 ${coverage.length - 1} 页 → exit 1`,
    r2.status === 1 && report2.missing.length === coverage.length - 1,
    `exit=${r2.status} missing=${report2.missing.length} coverage=${report2.coverage}`,
  );

  const dropDir = path.join(root, "drop");
  writeFixturePages(dropDir, coverage, { dropUsageOf: coverage[0].id });
  const r3 = run(dropDir, path.join(root, "report3"));
  record(
    "用例3 删 usage → exit 1 且指到 id+usage",
    r3.status === 1 && r3.stdout.includes(`${coverage[0].id}:usage`),
    `exit=${r3.status}`,
  );

  const fullDir = path.join(root, "full");
  writeFixturePages(fullDir, coverage);
  const report4Dir = path.join(root, "report4");
  const r4 = run(fullDir, report4Dir);
  const report4 = readReport(report4Dir);
  record(
    `用例4 全绿 → exit 0 且 covered=coverage=${coverage.length}`,
    r4.status === 0 &&
      report4.covered === report4.coverage &&
      report4.coverage === coverage.length &&
      report4.failed.length === 0 &&
      report4.skipped_count === 0,
    `exit=${r4.status} covered=${report4.covered}/${report4.coverage} failed=${report4.failed.length} skipped=${report4.skipped_count}`,
  );

  // 判据 v2：planned（含 planned P0）有页即越界，必须 exit 1
  const plannedP0 = items.find((item) => item.status === "planned" && item.priority === "P0");
  if (!plannedP0) throw new Error("manifest 中找不到 planned 的 P0 指标，无法构造越界用例");
  const plannedDir = path.join(root, "planned");
  writeFixturePages(plannedDir, coverage);
  writeFixturePages(plannedDir, [plannedP0]);
  const report5Dir = path.join(root, "report5");
  const r5 = run(plannedDir, report5Dir);
  const report5 = readReport(report5Dir);
  record(
    "用例5 给 planned 的 P0 写页 → exit 1",
    r5.status === 1 &&
      report5.planned_with_content.includes(plannedP0.id) &&
      report5.out_of_scope.length === 0,
    `exit=${r5.status} planned_with_content=${report5.planned_with_content.length}(${plannedP0.id})`,
  );

  // 用例6（V3-01）：结构化锚点三者全空 → SKIP 且点名，不得静默 PASS
  const stripped = JSON.parse(JSON.stringify(manifest));
  const strippedItems = stripped.indicators ?? stripped;
  const strippedTarget = coverage[0];
  const targetEntry = strippedItems.find((item) => item.id === strippedTarget.id);
  delete targetEntry.abbr;
  delete targetEntry.params;
  delete targetEntry.outputs;
  const strippedManifestPath = path.join(root, "manifest-stripped.json");
  fs.writeFileSync(strippedManifestPath, JSON.stringify(stripped, null, 2));
  const skipDir = path.join(root, "skip");
  writeFixturePages(skipDir, coverage);
  const report6Dir = path.join(root, "report6");
  const r6 = run(skipDir, report6Dir, { AKA_MANIFEST_PATH: strippedManifestPath });
  const report6 = readReport(report6Dir);
  record(
    "用例6 无锚点 → SKIP 且点名（exit 1）",
    r6.status === 1 &&
      report6.skipped_count > 0 &&
      report6.skipped.includes(`${strippedTarget.id}:V3-01`) &&
      r6.stdout.includes(`${strippedTarget.id}:V3-01`),
    `exit=${r6.status} skipped=${report6.skipped.join(",")}`,
  );

  // 用例7（V3-02）：参数 key 与默认值不在同一分句 → FAIL
  const splitTarget = coverage.find((item) => (item.params ?? []).length === 1);
  if (!splitTarget) throw new Error("manifest 中找不到单参数指标，无法构造分句用例");
  const splitDir = path.join(root, "split");
  writeFixturePages(splitDir, coverage, {
    mutate: (item, page) => {
      if (item.id !== splitTarget.id) return;
      const param = item.params[0];
      page.params = `参数 ${param.key} 的口径如下。默认取 ${param.default}。参数调大时曲线更平滑、反应更慢，适合长周期观察；调小时曲线更灵敏、假信号更多，适合短周期观察。口径说明用于占位，确保段落长度达标。`;
    },
  });
  const report7Dir = path.join(root, "report7");
  const r7 = run(splitDir, report7Dir);
  const report7 = readReport(report7Dir);
  record(
    "用例7 参数 key 与默认值不同现 → FAIL",
    r7.status === 1 && report7.failed.includes(`${splitTarget.id}:V3-02(${splitTarget.params[0].key})`),
    `exit=${r7.status} failed=${report7.failed.filter((entry) => entry.includes("V3-02")).join(",")}`,
  );

  // 用例8（V3-05）：空话词命中 → FAIL
  const wordsDir = path.join(root, "words");
  writeFixturePages(wordsDir, coverage, {
    mutate: (item, page) => {
      if (item.id !== coverage[0].id) return;
      page.usage = `${page.usage}本指标仅供参考。`;
    },
  });
  const report8Dir = path.join(root, "report8");
  const r8 = run(wordsDir, report8Dir);
  const report8 = readReport(report8Dir);
  record(
    "用例8 空话词命中 → FAIL",
    r8.status === 1 && report8.failed.some((entry) => entry.startsWith(`${coverage[0].id}:V3-05`)),
    `exit=${r8.status} failed=${report8.failed.filter((entry) => entry.includes("V3-05")).join(",")}`,
  );

  // 用例9（W-30）：别名命中 → PASS；删掉别名 → 必须 FAIL（证明别名是必要条件）；
  // 三条不误命中：N/NaN、k/K、senkou/senkouA（大小写敏感 + 双侧词边界，不做前缀放宽）
  const aliasTargetId = "M20";
  const aliasTarget = items.find((item) => item.id === aliasTargetId);
  if (!aliasTarget) throw new Error("manifest 中找不到 M20，无法构造别名用例");
  const aliasWord = ((aliasTarget.outputs ?? []).find((output) => (output.aliases ?? []).length)
    ?.aliases ?? [])[0];
  if (!aliasWord) throw new Error("manifest 的 M20 未登记 output 别名，W-30 用例无法成立");
  // W-32 逐项命中：被测输出只写别名，其余输出写各自 key，保证别名是唯一命中路径
  const otherOutputKeys = (aliasTarget.outputs ?? [])
    .filter((output) => !(output.aliases ?? []).includes(aliasWord))
    .map((output) => output.key);
  const filler = "口径说明用于占位，确保段落长度达标。".repeat(6);
  const aliasDir = path.join(root, "alias");
  writeFixturePages(aliasDir, coverage, {
    mutate: (item, page) => {
      if (item.id !== aliasTargetId) return;
      page.formula = `公式：${[aliasWord, ...otherOutputKeys].join("、")} 与另一条曲线由同一窗口的波幅比值得到，窗口长度取 14，不做额外平滑。${filler}`;
    },
  });
  const aliasReportDir = path.join(root, "report9a");
  const rAlias = run(aliasDir, aliasReportDir);
  const aliasReport = readReport(aliasReportDir);
  const aliasPass =
    rAlias.status === 0 &&
    !aliasReport.failed.some((entry) => entry.startsWith(`${aliasTargetId}:`));

  // 同一条目改成「只有单字母别名 N」，页面公式里只出现 NaN → 词边界必须判未命中
  const nanManifest = JSON.parse(JSON.stringify(manifest));
  const nanItem = nanManifest.indicators.find((item) => item.id === aliasTargetId);
  nanItem.abbr = "";
  nanItem.abbrAliases = [];
  nanItem.params = [
    { kind: "int", key: "zzz", label: "窗口", min: 2, max: 200, default: 1, step: 1, aliases: ["N"] },
  ];
  nanItem.outputs = [];
  const nanManifestPath = path.join(root, "manifest-nan.json");
  fs.writeFileSync(nanManifestPath, JSON.stringify(nanManifest, null, 2));
  const nanDir = path.join(root, "nan");
  const nanFormula = `公式：窗口比值为 0 时输出 NaN，不给 0 也不给 1；序列不足时同样留空，不做补零处理。${filler}`;
  writeFixturePages(nanDir, coverage, {
    mutate: (item, page) => {
      if (item.id !== aliasTargetId) return;
      page.formula = nanFormula;
      page.params = `zzz 默认取 1，是窗口长度。参数调大时窗口更长、曲线更平滑；调小时窗口更短、曲线更灵敏。${"口径说明用于占位，确保段落长度达标。".repeat(3)}`;
    },
  });
  const nanReportDir = path.join(root, "report9b");
  const nanRun = run(nanDir, nanReportDir, { AKA_MANIFEST_PATH: nanManifestPath });
  const nanReport = readReport(nanReportDir);
  const nanFail =
    nanRun.status === 1 &&
    nanReport.failed.some((entry) => entry.startsWith(`${aliasTargetId}:formula`)) &&
    nanFormula.includes("NaN") &&
    !matchesAnchor(nanFormula, "N");

  // 9d 大小写敏感：参数 k 不得命中输出 K（同词大写仍须命中）
  const kText = "公式：输出摆动值 K 由同一窗口计算得到。";
  const kFail = !matchesAnchor(kText, "k") && matchesAnchor(kText, "K");
  // 9e 不做前缀放宽：senkou 不得命中 senkouA / senkouB
  const senkouText = "公式：senkouA 与 senkouB 分别取不同前移周期。";
  const senkouFail =
    !matchesAnchor(senkouText, "senkou") && matchesAnchor(senkouText, "senkouA");

  // 9b 反向用例：删掉 M24 的 massIndex 别名后，同一页必须回到 FAIL（证明别名是必要条件）
  const massTargetId = "M24";
  const massTarget = items.find((item) => item.id === massTargetId);
  if (!massTarget) throw new Error("manifest 中找不到 M24，无法构造 massIndex 反向用例");
  const massWord = ((massTarget.outputs ?? []).find(
    (output) => output.key === "massIndex" && (output.aliases ?? []).length,
  )?.aliases ?? [])[0];
  if (!massWord) throw new Error("manifest 的 M24 未登记 massIndex 别名，W-30 反向用例无法成立");
  const massDir = path.join(root, "mass");
  writeFixturePages(massDir, coverage, {
    mutate: (item, page) => {
      if (item.id !== massTargetId) return;
      page.formula = `公式：${massWord} 由最高价与最低价的区间比值累加得到，窗口取 9，不做额外平滑。${filler}`;
    },
  });
  const massPassReportDir = path.join(root, "report9c1");
  const massPassRun = run(massDir, massPassReportDir, { AKA_MANIFEST_PATH: MANIFEST_PATH });
  const massPassReport = readReport(massPassReportDir);
  const massPass =
    massPassRun.status === 0 &&
    !massPassReport.failed.some((entry) => entry.startsWith(`${massTargetId}:`));

  const noMassAliasManifest = JSON.parse(JSON.stringify(manifest));
  const noMassAliasItems = noMassAliasManifest.indicators ?? noMassAliasManifest;
  const noMassAliasItem = noMassAliasItems.find((item) => item.id === massTargetId);
  for (const output of noMassAliasItem.outputs ?? []) delete output.aliases;
  const noMassAliasManifestPath = path.join(root, "manifest-no-mass-alias.json");
  fs.writeFileSync(noMassAliasManifestPath, JSON.stringify(noMassAliasManifest, null, 2));
  const noMassAliasReportDir = path.join(root, "report9c2");
  const noMassAliasRun = run(massDir, noMassAliasReportDir, {
    AKA_MANIFEST_PATH: noMassAliasManifestPath,
  });
  const noMassAliasReport = readReport(noMassAliasReportDir);
  const noMassAliasFail =
    noMassAliasRun.status === 1 &&
    noMassAliasReport.failed.some((entry) =>
      entry.startsWith(`${massTargetId}:V3-02(outputs:`),
    );

  record(
    "用例9 别名命中 → PASS；删 massIndex 别名 → FAIL；N/NaN、k/K、senkou/senkouA 均不命中",
    aliasPass && massPass && noMassAliasFail && nanFail && kFail && senkouFail,
    `别名 exit=${rAlias.status} ${aliasReport.failed.join(",") || "-"} 词=${aliasWord}；massIndex 别名=${massWord}（exit=${massPassRun.status} ${massPassReport.failed.join(",") || "-"} / 删后 ${noMassAliasRun.status} ${noMassAliasReport.failed.join(",") || "-"}）` +
      `N/NaN=${matchesAnchor(nanFormula, "N")}；k/K=${matchesAnchor(kText, "k")}/${matchesAnchor(kText, "K")}；` +
      `senkou/senkouA=${matchesAnchor(senkouText, "senkou")}/${matchesAnchor(senkouText, "senkouA")}；` +
      `判定=${aliasPass}/${massPass}/${noMassAliasFail}/${nanFail}/${kFail}/${senkouFail}`,
  );

  // 用例10（W-32）：只命中一个输出、另一个未定义 → 必须 FAIL（逐项命中，不允许「任一」蒙过）
  const multiTarget = coverage.find((item) => (item.outputs ?? []).length >= 2);
  if (!multiTarget) throw new Error("manifest 中找不到多输出指标，无法构造 W-32 反例");
  const firstOutputTerms = termsOf(multiTarget.outputs[0]);
  if (!firstOutputTerms.length) throw new Error(`${multiTarget.id} 首个输出无 key/别名，W-32 反例无法成立`);
  const missingKeys = multiTarget.outputs
    .slice(1)
    .map((output) => output.key)
    .filter((key) => typeof key === "string" && key.trim());
  const oneOutputDir = path.join(root, "one-output");
  writeFixturePages(oneOutputDir, coverage, {
    mutate: (item, page) => {
      if (item.id !== multiTarget.id) return;
      page.formula = `公式：${firstOutputTerms[0]} 是本指标的主输出，其余输出在本页刻意不写。${filler}`;
    },
  });
  const oneOutputReportDir = path.join(root, "report10");
  const r10 = run(oneOutputDir, oneOutputReportDir);
  const report10 = readReport(oneOutputReportDir);
  const w32Fail =
    r10.status === 1 &&
    report10.failed.includes(`${multiTarget.id}:V3-02(outputs:${missingKeys.join("/")})`);
  record(
    "用例10 只命中一个输出 → FAIL（W-32 逐项命中）",
    w32Fail,
    `exit=${r10.status} 未命中=${missingKeys.join("/")} failed=${report10.failed.filter((entry) => entry.includes("V3-02")).join(",")}`,
  );

  console.log("指标口径页门禁自测");
  for (const item of results) console.log(`  ${item.ok ? "PASS" : "FAIL"}  ${item.name}  ${item.detail}`);
  const ok = results.every((item) => item.ok);
  console.log(`结论：${ok ? "PASS" : "FAIL"}（${results.filter((item) => item.ok).length}/${results.length}）`);
  process.exit(ok ? 0 : 1);
}

if (argv.has("--self-test")) runSelfTest();
else main();
