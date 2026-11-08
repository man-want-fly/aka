#!/usr/bin/env node
// 制度第 32 条：取证选择器与产品 DOM 契约绑定。
//   node scripts/verify_dom_contracts.mjs [--root <dir>]
//
// 三件检查：
// 1. 清单里每条契约的 markers 必须在 source（组件源码）中字面出现；expect=absent 的负向探针则相反。
// 2. manifest.evidenceFiles 里的取证代码出现的每个 data-* 属性名都必须已登记（新增选择器 = 静默耦合）。
// 3. 取证代码不得在清单外拼接选择器：模板选择器必须在 templates 登记，禁止字符串拼接选择器。

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const ROOT = arg("root", join(HERE, "..", ".."));
const APP = join(ROOT, "app");
const MANIFEST = arg("contracts", join(APP, "scripts", "dom-contracts.json"));

// 变异锚点：selftest 会把这一行整体替换为全 false，模拟「退回不检查」的旧形态；
// 四条反例必须在旧形态下变绿，否则说明检查本身是假的。
const ENABLED = { contract: true, registry: true, template: true };

const rel = (path) => relative(ROOT, path).split(sep).join("/");
const toAppPath = (path) => relative(APP, path).split(sep).join("/");

/** 去掉注释（保留字符串/模板内容），避免把注释里的旧选择器当成活契约。 */
function stripComments(text) {
  let out = "";
  let i = 0;
  let state = null;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === "line") {
      if (ch === "\n") {
        state = null;
        out += ch;
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        state = null;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === "quote") {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === quoteChar) state = null;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      state = "line";
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      state = "block";
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      state = "quote";
      quoteChar = ch;
    }
    out += ch;
    i += 1;
  }
  return out;
}
let quoteChar = "";

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, acc);
    else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(path);
  }
  return acc;
}

function read(file) {
  return stripComments(readFileSync(file, "utf8"));
}

function productFiles(sources, evidenceAbs) {
  const files = new Set();
  for (const source of sources) {
    const path = join(APP, source);
    if (!existsSync(path)) continue;
    if (statSync(path).isDirectory()) {
      for (const file of walk(path)) files.add(file);
    } else {
      files.add(path);
    }
  }
  return [...files].filter((file) => !evidenceAbs.has(file));
}

const normalizeTemplate = (literal) => literal.replace(/\$\{[^}]*\}/g, "${}");
const templateLiterals = (text) =>
  [...text.matchAll(/`[^`]*`/g)]
    .map((match) => match[0])
    .filter((literal) => literal.includes("data-"))
    .map(normalizeTemplate);
const dataTokens = (text) => [...new Set([...text.matchAll(/data-[a-z0-9-]+/g)].map((m) => m[0]))];
const markerToken = (marker) => (marker.match(/data-[a-z0-9-]+/) ?? [null])[0];

if (!existsSync(MANIFEST)) {
  console.error(`::error::缺少 DOM 契约清单：${rel(MANIFEST)}`);
  process.exit(2);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
} catch (error) {
  console.error(`::error::契约清单不是合法 JSON：${error.message}`);
  process.exit(2);
}
if (!Array.isArray(manifest.contracts) || !Array.isArray(manifest.templates)) {
  console.error("::error::契约清单缺 contracts / templates 数组");
  process.exit(2);
}

const problems = [];
const keys = new Set();
const evidenceAbs = new Set((manifest.evidenceFiles ?? []).map((file) => join(APP, file)));

// —— 1. 契约标记与源码字面一致 ——
if (ENABLED.contract) {
  for (const contract of manifest.contracts) {
    if (!contract.key || keys.has(contract.key)) problems.push(`契约 key 缺失或重复：${contract.key}`);
    keys.add(contract.key);
    if (!Array.isArray(contract.markers) || contract.markers.length === 0) {
      problems.push(`${contract.key}：markers 为空`);
      continue;
    }
    if (!contract.source) {
      problems.push(`${contract.key}：缺 source`);
      continue;
    }
    const files = productFiles([contract.source], evidenceAbs);
    if (files.length === 0) {
      problems.push(`${contract.key}：source 不存在（${contract.source}）`);
      continue;
    }
    for (const marker of contract.markers) {
      const hit = files.some((file) => read(file).includes(marker));
      const expectedAbsent = contract.expect === "absent";
      const ok = expectedAbsent ? !hit : hit;
      if (!ok) {
        problems.push(
          expectedAbsent
            ? `${contract.key}：负向探针 ${marker} 仍出现在产品源码（${contract.source}）`
            : `${contract.key}：标记「${marker}」未在 ${contract.source} 字面出现（产品契约变了，清单没跟上）`,
        );
      }
    }
  }
}

// —— 2. 取证代码里的 data-* 必须全部登记 ——
const registered = new Map();
for (const contract of manifest.contracts) {
  for (const marker of contract.markers ?? []) {
    const token = markerToken(String(marker));
    if (token && !registered.has(token)) registered.set(token, contract.key);
  }
}
if (ENABLED.registry) {
  for (const file of manifest.evidenceFiles ?? []) {
    const abs = join(APP, file);
    if (!existsSync(abs)) {
      problems.push(`取证文件不存在：${file}`);
      continue;
    }
    for (const token of dataTokens(read(abs))) {
      if (!registered.has(token)) {
        problems.push(`${file}：data-* 未登记「${token}」（新增选择器必须先写进 dom-contracts.json）`);
      }
    }
  }
}

// —— 3. 清单外拼接选择器 ——
if (ENABLED.template) {
  const declared = new Set(manifest.templates.map((entry) => normalizeTemplate(entry.pattern)));
  const CONCAT = /(["'][^"']*data-[^"']*["'])\s*\+|\+\s*(["'][^"']*data-[^"']*["'])/;
  for (const file of manifest.evidenceFiles ?? []) {
    const abs = join(APP, file);
    if (!existsSync(abs)) continue;
    const text = read(abs);
    for (const literal of templateLiterals(text)) {
      if (!declared.has(literal)) {
        problems.push(`${file}：选择器模板未登记「${literal}」（清单外拼接选择器 = 静默耦合）`);
      }
    }
    const concat = text.match(CONCAT);
    if (concat) {
      problems.push(`${file}：出现字符串拼接选择器「${concat[0].trim()}」（必须改为登记过的模板或字面量）`);
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`);
  console.error(`verify:dom-contracts 失败：${problems.length} 项（契约 ${manifest.contracts.length} 条 / 模板 ${manifest.templates.length} 条）`);
  process.exit(1);
}
console.log(
  `verify:dom-contracts 通过：契约 ${manifest.contracts.length} 条、模板 ${manifest.templates.length} 条、取证文件 ${(manifest.evidenceFiles ?? []).length} 个`,
);
