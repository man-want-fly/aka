#!/usr/bin/env node
/**
 * 卡 ↔ 页面 存在性校验。
 *
 * 目标：卡面「页面 / 状态」与 AC 行里引用的页面编号（P1..P10），必须在
 * `docs/qa/aka-page-registry-v0.1.csv` 登记为 exists，且锚点能在源码中命中。
 * 交付类卡（已交付/条件交付/渲染层已具备/数值层已具备）引用不存在的页面即红；
 * Blocked / Blocked-AC 卡必须写 blocker。
 *
 * 退出码：0 通过；1 违规；2 输入缺失/不可解析。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const CARD_PATH = process.env.AKA_CARD_FILE || path.join(ROOT, "docs", "story-cards", "aka-story-cards-v0.1.md");
const GATE_PATH = process.env.AKA_GATE_LOG || path.join(ROOT, "docs", "qa", "aka-card-gate-log-v0.1.csv");
const REG_PATH = process.env.AKA_PAGE_REGISTRY || path.join(ROOT, "docs", "qa", "aka-page-registry-v0.1.csv");

const CLAIMED = new Set(["已交付", "条件交付", "渲染层已具备", "数值层已具备"]);
const BLOCKED = new Set(["Blocked", "Blocked-AC"]);
const PAGE_RE = /\bP(10|[1-9])\b/g;

function failHard(msg) {
  console.error(`verify:cards-pages 输入错误: ${msg}`);
  process.exit(2);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
  }
  return rows;
}

function loadRegistry() {
  if (!fs.existsSync(REG_PATH)) failHard(`页面索引不存在: ${REG_PATH}`);
  const rows = parseCsv(fs.readFileSync(REG_PATH, "utf8"));
  const head = rows.shift();
  const need = ["page_id", "page_name", "status", "anchor_file", "anchor_text", "owner_story"];
  const idx = Object.fromEntries(need.map((k) => [k, head.indexOf(k)]));
  for (const k of need) if (idx[k] < 0) failHard(`页面索引缺列: ${k}`);
  const map = new Map();
  for (const r of rows) {
    const page = r[idx.page_id]?.trim();
    if (!page) continue;
    if (map.has(page)) failHard(`页面编号重复: ${page}`);
    const status = r[idx.status]?.trim();
    if (!["exists", "absent"].includes(status)) failHard(`${page} status 非法: ${status}`);
    map.set(page, {
      page,
      name: r[idx.page_name]?.trim() || "",
      status,
      anchorFile: r[idx.anchor_file]?.trim() || "",
      anchorText: r[idx.anchor_text]?.trim() || "",
      ownerStory: r[idx.owner_story]?.trim() || "",
    });
  }
  if (map.size === 0) failHard("页面索引为空");
  return map;
}

function verifyAnchors(reg) {
  const errors = [];
  for (const p of reg.values()) {
    if (p.status !== "exists") continue;
    if (!p.anchorFile || !p.anchorText) {
      errors.push(`${p.page} 标记 exists 但缺 anchor_file/anchor_text`);
      continue;
    }
    const abs = path.join(ROOT, p.anchorFile);
    if (!fs.existsSync(abs)) {
      errors.push(`${p.page} 锚点文件不存在: ${p.anchorFile}`);
      continue;
    }
    if (!fs.readFileSync(abs, "utf8").includes(p.anchorText)) {
      errors.push(`${p.page} 锚点未命中: ${p.anchorFile} 不含 ${p.anchorText}`);
    }
  }
  return errors;
}

function loadCards() {
  if (!fs.existsSync(CARD_PATH)) failHard(`卡文件不存在: ${CARD_PATH}`);
  const lines = fs.readFileSync(CARD_PATH, "utf8").split("\n");
  const cards = new Map();
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^### (S-\d\d\.\d\d-\d\d)\b/);
    if (m) {
      cur = m[1];
      cards.set(cur, []);
      continue;
    }
    if (!cur) continue;
    if (/^\| 页面 \/ 状态 \|/.test(line) || /^- \*\*AC-/.test(line)) cards.get(cur).push(line);
  }
  return cards;
}

function loadGate() {
  if (!fs.existsSync(GATE_PATH)) failHard(`门禁台账不存在: ${GATE_PATH}`);
  const rows = parseCsv(fs.readFileSync(GATE_PATH, "utf8"));
  const head = rows.shift();
  const iCard = head.indexOf("card_id");
  const iStatus = head.indexOf("ledger_status");
  const iBlocker = head.indexOf("blocker");
  if (iCard < 0 || iStatus < 0 || iBlocker < 0) failHard("门禁台账缺列: card_id/ledger_status/blocker");
  const map = new Map();
  for (const r of rows) {
    const card = r[iCard]?.trim();
    if (!card) continue;
    map.set(card, { status: r[iStatus]?.trim() || "", blocker: r[iBlocker]?.trim() || "" });
  }
  return map;
}

function main() {
  const registry = loadRegistry();
  const cards = loadCards();
  const gate = loadGate();
  const errors = verifyAnchors(registry);

  let checked = 0;
  for (const [card, lines] of cards) {
    const refs = new Set();
    for (const line of lines) {
      for (const m of line.matchAll(PAGE_RE)) refs.add(`P${m[1]}`);
    }
    if (refs.size === 0) continue;
    checked += 1;
    for (const ref of refs) {
      if (!registry.has(ref)) errors.push(`${card} 引用未登记页面 ${ref}`);
    }
    const row = gate.get(card);
    if (!row) continue;
    const missing = [...refs].filter((ref) => registry.get(ref)?.status !== "exists");
    if (CLAIMED.has(row.status) && missing.length > 0) {
      errors.push(`${card} 状态=${row.status} 但引用不存在的页面 ${missing.join(",")}；须标 Blocked 并写 blocker`);
    }
    if (BLOCKED.has(row.status) && missing.length > 0 && !row.blocker) {
      errors.push(`${card} 状态=${row.status} 引用不存在的页面 ${missing.join(",")}，但 blocker 为空`);
    }
  }

  if (errors.length > 0) {
    for (const e of errors) console.error(`✗ ${e}`);
    console.error(`verify:cards-pages 失败：${errors.length} 项`);
    process.exit(1);
  }
  console.log(`verify:cards-pages 通过：${cards.size} 张卡、${checked} 张含页面引用、${registry.size} 个页面登记`);
}

main();
