#!/usr/bin/env node
/**
 * 索引 `estimate_pd` 与卡文件 §1「卡片总览表」合计的一致性校验器。
 *
 * 背景：`docs/story-cards/aka-story-index-v0.1.csv` 的 `estimate_pd` 是卡 §1 的
 * 唯一允许保留的机器副本；副本可以留的条件就是有脚本盯住它。
 *
 * 退出码：
 *   0 = 两处合计一致
 *   1 = 合计不一致
 *   2 = 输入缺失/不可解析（CSV 列缺失、人日值非数字、卡 §1 合计行找不到）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const CSV_PATH =
  process.env.AKA_INDEX_CSV || path.join(ROOT, "docs", "story-cards", "aka-story-index-v0.1.csv");
const CARD_PATH =
  process.env.AKA_CARD_FILE || path.join(ROOT, "docs", "story-cards", "aka-story-cards-v0.1.md");

function failHard(message) {
  console.error(message);
  process.exit(2);
}

/** 逐行解析 CSV（字段一律双引号包裹，内含逗号不影响切列） */
function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

/** 以「角」为单位累加，避免 0.1+0.2 类浮点误差（人日最大 1 位小数） */
function toTenths(value, where) {
  const text = String(value ?? "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) failHard(`estimate_pd_not_numeric: ${where} = ${JSON.stringify(text)}`);
  return Math.round(Number(text) * 10);
}

function formatTenths(tenths) {
  const sign = tenths < 0 ? "-" : "";
  const abs = Math.abs(tenths);
  return `${sign}${Math.floor(abs / 10)}.${abs % 10}`;
}

function readIndexTotal() {
  if (!fs.existsSync(CSV_PATH)) failHard(`index_csv_missing: ${CSV_PATH}`);
  const lines = fs.readFileSync(CSV_PATH, "utf8").split(/\r?\n/).filter((line) => line.trim());
  const header = parseCsvLine(lines[0]).map((cell) => cell.trim());
  const column = header.indexOf("estimate_pd");
  if (column < 0) failHard("index_csv_unparsable: 缺 estimate_pd 列");
  let total = 0;
  let rows = 0;
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    if (cells.length !== header.length) failHard(`index_csv_unparsable: 列数不符（${cells.length} ≠ ${header.length}）`);
    total += toTenths(cells[column], cells[0]);
    rows += 1;
  }
  return { total, rows };
}

function readCardTotal() {
  if (!fs.existsSync(CARD_PATH)) failHard(`card_file_missing: ${CARD_PATH}`);
  const line = fs
    .readFileSync(CARD_PATH, "utf8")
    .split(/\r?\n/)
    .find((entry) => /^\|\s*\*\*合计\*\*/u.test(entry));
  if (!line) failHard("card_sum_unparsable: 卡 §1 找不到「| **合计** |」行");
  const bold = line.match(/\*\*(-?\d+(?:\.\d+)?)\*\*/g);
  if (!bold || !bold.length) failHard(`card_sum_unparsable: 合计行无粗体数字（${line.trim()}）`);
  return toTenths(bold[bold.length - 1].replace(/\*/g, ""), "卡 §1 合计");
}

const index = readIndexTotal();
const card = readCardTotal();
const ok = index.total === card;

console.log("索引 estimate_pd 合计一致性");
console.log(`索引：${CSV_PATH.replace(`${ROOT}${path.sep}`, "")}（${index.rows} 行）合计 ${formatTenths(index.total)}`);
console.log(`卡 §1：${CARD_PATH.replace(`${ROOT}${path.sep}`, "")} 合计 ${formatTenths(card)}`);
console.log(`结论：${ok ? "PASS" : "FAIL"}（索引 ${formatTenths(index.total)} vs 卡 §1 ${formatTenths(card)}）`);
process.exit(ok ? 0 : 1);
