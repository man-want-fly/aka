#!/usr/bin/env node
/**
 * 指标口径页门禁（W-03 / AC-03.03-03 补5）
 *
 * 用法：
 *   node scripts/verify_indicator_docs.mjs              # 校验内容库
 *   node scripts/verify_indicator_docs.mjs --self-test  # 脚本自身四用例
 *
 * 退出码：
 *   0 = 覆盖、四段、版本、公式锚点全部通过
 *   1 = 内容不合格（缺页 / 多页 / 段落不足 / 版本不符 / 公式缺锚点）
 *   2 = 输入缺失（manifest 不可解析，或 content 库不存在/为空）—— 绝不空跑 PASS
 *
 * 口径说明（TL 判据中的一处表述冲突，已在报告中列出，未自行取舍）：
 *   - 判据 2 要求「84 个 P0 每个都有页」；manifest 的 84 个 P0 里有 40 条 status=planned。
 *   - 判据 3 写「61 个 P1/planned 不得有内容页」，但 manifest 里 61 个 planned = 40 个 P0 + 21 个 P1。
 *   - 为同时满足两条可执行判据，这里按「P0 全覆盖（含 planned P0）」+「P1 不得有页」执行，
 *     即 planned_with_content 只统计 priority=P1 的计划中指标。此取舍待 TL/BA 确认后改。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const MANIFEST_PATH = path.join(APP, "manifest", "indicators.json");
const CONSTANTS_PATH = path.join(APP, "manifest", "constants.json");
const DEFAULT_CONTENT_DIR = path.join(APP, "content", "indicators");
const CONTENT_DIR = process.env.AKA_CONTENT_DIR || DEFAULT_CONTENT_DIR;
const REPORT_DIR = process.env.AKA_REPORT_DIR || path.join(APP, "dist");
const REPORT_PATH = path.join(REPORT_DIR, "content-coverage-report.json");
const SECTIONS = ["definition", "formula", "params", "usage"];
const MIN_SECTION_CHARS = 80;
const MIN_COMPLETION_NOTE_CHARS = 60;

const argv = new Set(process.argv.slice(2));
const len = (s) => (typeof s === "string" ? [...s.trim()].length : 0);

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

/** 从 formulaSummary 提取核心符号；提不出锚点时返回 []（该指标跳过公式锚点检查，但四段长度仍校验） */
function anchorSymbols(summary) {
  if (!summary) return [];
  const found = new Set();
  const re = /([A-Za-z_][A-Za-z0-9_]*\s*\()|Σ|√|σ|×|÷|²|[A-Z]{2,}[A-Za-z0-9]*/g;
  for (const match of summary.matchAll(re)) {
    const token = match[0].trim();
    if (token) found.add(token);
  }
  return [...found];
}

function listContentFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

function buildReport({ items, p0, constants, files, parseErrors }) {
  const catalogIds = new Set(items.map((item) => item.id));
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

  const missing = p0.filter((item) => !pages.has(item.id)).map((item) => item.id);
  const extra = files
    .filter((name) => !catalogIds.has(name.replace(/\.json$/i, "")))
    .map((name) => name);
  const plannedWithContent = items
    .filter((item) => item.status === "planned" && item.priority === "P1" && pages.has(item.id))
    .map((item) => item.id);
  const failed = [...parseErrors];

  for (const item of p0) {
    const page = pages.get(item.id);
    if (!page) continue;
    for (const section of SECTIONS) {
      if (len(page[section]) < MIN_SECTION_CHARS) failed.push(`${item.id}:${section}`);
    }
    const expectedVersion = item.version ?? 1;
    if (page.version !== expectedVersion) failed.push(`${item.id}:version`);
    if (item.isCompletion && len(page.completion_note) < MIN_COMPLETION_NOTE_CHARS) {
      failed.push(`${item.id}:completion_note`);
    }
    const anchors = anchorSymbols(item.formulaSummary);
    if (anchors.length > 0) {
      const formula = typeof page.formula === "string" ? page.formula : "";
      if (!anchors.some((token) => formula.includes(token)) && !anchors.some((token) => formula.includes(token.replace(/\s+/g, "")))) {
        failed.push(`${item.id}:formula(${anchors.join("/")})`);
      }
    }
  }

  return {
    version: constants.version,
    total: items.length,
    p0: p0.length,
    covered: p0.filter((item) => pages.has(item.id)).length,
    missing,
    extra,
    planned_with_content: plannedWithContent.sort(),
    failed: failed.sort(),
  };
}

function stableJson(report) {
    const { generatedAt, ...rest } = report;
  return JSON.stringify({ ...rest, generatedAt: "<ignored>" });
}

function main() {
  const manifest = parseManifest();
  const items = manifest.indicators ?? manifest;
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

  const p0 = items.filter((item) => item.priority === "P0");
  const report = buildReport({ items, p0, constants, files, parseErrors: [] });
  report.generatedAt = new Date().toISOString();

  // 判据 7：同一输入连续两次构建，除 generatedAt 外字节一致
  const second = buildReport({ items, p0, constants, files, parseErrors: [] });
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

  console.log("指标口径页覆盖检查");
  console.log(`内容库：${path.relative(APP, CONTENT_DIR)}`);
  console.log(`覆盖：${report.covered}/${constants.catalog.p0}`);
  if (report.missing.length) console.log(`  缺页：${report.missing.join(", ")}`);
  if (report.extra.length) console.log(`  多出：${report.extra.join(", ")}`);
  if (report.planned_with_content.length) console.log(`  P1 计划中却有内容页：${report.planned_with_content.join(", ")}`);
  if (report.failed.length) console.log(`  不合格：${report.failed.join(", ")}`);
  console.log(`报告：${path.relative(APP, REPORT_PATH)}`);

  const ok =
    report.missing.length === 0 &&
    report.extra.length === 0 &&
    report.planned_with_content.length === 0 &&
    report.failed.length === 0;
  console.log(ok ? "结论：PASS" : "结论：FAIL");
  process.exit(ok ? 0 : 1);
}

// ---------- 脚本自测（判据 8 之外的自身验收，四用例） ----------
function writeFixturePages(dir, items, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const filler = "口径说明用于占位，确保段落长度达标。".repeat(6);
  const seed = opts.seed ?? items;
  for (const item of seed) {
    const anchors = anchorSymbols(item.formulaSummary);
    const formula = `公式：${anchors[0] ?? item.id} ${item.formulaSummary ?? ""}。${filler}`;
    const page = {
      version: item.version ?? 1,
      definition: `${item.nameZh ?? item.id} 的定义。${filler}`,
      formula,
      params: `参数说明。${filler}`,
      usage: `使用场景。${filler}`,
      completion_note: item.isCompletion ? `补全说明。${filler}` : undefined,
    };
    if (opts.dropUsageOf === item.id) delete page.usage;
    fs.writeFileSync(path.join(dir, `${item.id}.json`), JSON.stringify(page, null, 2));
  }
}

function runSelfTest() {
  const manifest = parseManifest();
  const items = manifest.indicators ?? manifest;
  const p0 = items.filter((item) => item.priority === "P0");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aka-docs-"));
  const self = fileURLToPath(import.meta.url);
  const run = (dir, reportDir) =>
    spawnSync(process.execPath, [self], {
      encoding: "utf8",
      env: { ...process.env, AKA_CONTENT_DIR: dir, AKA_REPORT_DIR: reportDir },
    });

  const results = [];
  const record = (name, ok, detail) => results.push({ name, ok, detail });

  const missingDir = path.join(root, "missing");
  const r1 = run(missingDir, path.join(root, "report1"));
  record("用例1 库缺失 → exit 2", r1.status === 2 && /content_library_missing/.test(r1.stderr + r1.stdout), `exit=${r1.status}`);

  const oneDir = path.join(root, "one");
  writeFixturePages(oneDir, p0.slice(0, 1));
  const report2Dir = path.join(root, "report2");
  const r2 = run(oneDir, report2Dir);
  const missing2 = JSON.parse(fs.readFileSync(path.join(report2Dir, "content-coverage-report.json"), "utf8")).missing;
  record("用例2 缺 83 页 → exit 1", r2.status === 1 && missing2.length === 83, `exit=${r2.status} missing=${missing2.length}`);

  const dropDir = path.join(root, "drop");
  writeFixturePages(dropDir, p0, { dropUsageOf: p0[0].id });
  const r3 = run(dropDir, path.join(root, "report3"));
  record(
    "用例3 删 usage → exit 1 且指到 id+usage",
    r3.status === 1 && r3.stdout.includes(`${p0[0].id}:usage`),
    `exit=${r3.status}`,
  );

  const fullDir = path.join(root, "full");
  writeFixturePages(fullDir, p0);
  const r4 = run(fullDir, path.join(root, "report4"));
  const report4 = JSON.parse(fs.readFileSync(path.join(root, "report4", "content-coverage-report.json"), "utf8"));
  record(
    "用例4 全绿 → exit 0 且 covered=84 / p0=84",
    r4.status === 0 && report4.covered === report4.p0 && report4.p0 === constantsP0(),
    `exit=${r4.status} covered=${report4.covered}/${report4.p0}`,
  );

  console.log("指标口径页门禁自测");
  for (const item of results) console.log(`  ${item.ok ? "PASS" : "FAIL"}  ${item.name}  ${item.detail}`);
  const ok = results.every((item) => item.ok);
  console.log(ok ? "结论：PASS" : "结论：FAIL");
  process.exit(ok ? 0 : 1);
}

function constantsP0() {
  try {
    return JSON.parse(fs.readFileSync(CONSTANTS_PATH, "utf8")).catalog.p0;
  } catch {
    return 84;
  }
}

if (argv.has("--self-test")) runSelfTest();
else main();
