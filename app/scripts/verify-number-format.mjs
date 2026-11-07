#!/usr/bin/env node
// AC-06.02-02（补3）：组件目录内四类数值（价格/百分比/量/额）不得直接 toFixed。
// 白名单只有三类：几何坐标、诊断信息、无量纲指标读数（W-43 2026-11-07 定）。
// 百分比/价格/量/额一律走 format；白名单按「归一化后的整行」匹配，行内容变化即视为新命中。
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("../src/components", import.meta.url).pathname;
const norm = (line) => line.replace(/\s+/g, " ").trim();

const WHITELIST = {
  "IndicatorReadouts.tsx": [
    ["geometry", 'path += `${penDown ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)} `;'],
  ],
  "CandleChart.tsx": [
    ["geometry", 'path += `${penDown ? "L" : "M"}${xOf(index).toFixed(2)} ${yOf(value).toFixed(2)} `;'],
    ["geometry", "data-overdrag={overdrag.toFixed(2)}"],
    [
      "geometry",
      'd={`M${(x - 3.5).toFixed(2)} ${y.toFixed(2)} L${(x + 3.5).toFixed(2)} ${y.toFixed(2)} L${x.toFixed(2)} ${(y - 4).toFixed(2)} Z`}',
    ],
  ],
};

const files = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
  .map((entry) => entry.name);

const hits = [];
for (const file of files) {
  const lines = readFileSync(join(root, file), "utf8").split("\n");
  lines.forEach((line, index) => {
    if (line.includes("toFixed(")) hits.push({ file, line: index + 1, text: norm(line) });
  });
}

const categories = { geometry: 0, diagnostic: 0, readout: 0 };
const violations = [];
for (const hit of hits) {
  const entry = (WHITELIST[hit.file] ?? []).find(([, text]) => text === hit.text);
  if (entry) categories[entry[0]] += 1;
  else violations.push(`${relative(process.cwd(), root)}/${hit.file}:${hit.line} ${hit.text}`);
}

console.log(`扫描 src/components：${files.length} 个组件，toFixed 命中 ${hits.length}`);
console.log(
  `白名单：几何 ${categories.geometry} / 诊断 ${categories.diagnostic} / 指标读数 ${categories.readout}`,
);
if (violations.length > 0) {
  console.error(`白名单外命中 ${violations.length} 处：`);
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log("白名单外命中 0 处 → PASS");
