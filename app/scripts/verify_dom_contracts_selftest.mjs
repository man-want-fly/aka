#!/usr/bin/env node
// W-91 / 制度第 29 条：四条反例必须判红，并做变异验证——
// 把检查器实现退回到「不检查」的旧形态后，四条反例必须全部变绿，
// 证明这些反例真的能抓住缺陷，而不是靠一行永远为真的断言。

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, "verify_dom_contracts.mjs");
const TMP = mkdtempSync(join(tmpdir(), "w91-dom-"));

const evidenceSource = [
  'const chart = document.querySelector("[data-chart=\'1\']");',
  'const readout = document.querySelector(\'[data-readout="1"]\');',
  "const item = document.querySelector(`[data-item='${id}']`);",
  'const extra = document.querySelector("[data-extra]");',
  "",
].join("\n");

const componentSource = [
  "export function Foo() {",
  '  return <div data-chart="1" data-readout="1" data-item="x" data-extra="y" />;',
  "}",
  "",
].join("\n");

const baseManifest = () => ({
  version: 1,
  evidenceFiles: ["src/features/workbench/diag.ts"],
  contracts: [
    {
      key: "chart.root",
      selector: "[data-chart='1']",
      source: "src/components/Foo.tsx",
      markers: ['data-chart="1"'],
      note: "反例夹具：产品改名而清单不动必须红",
    },
    {
      key: "chart.readout",
      selector: "[data-readout='1']",
      source: "src/components/Foo.tsx",
      markers: ['data-readout="1"'],
      note: "反例夹具",
    },
    {
      key: "chart.item",
      selector: "[data-item='<id>']",
      source: "src/components/Foo.tsx",
      markers: ["data-item"],
      note: "反例夹具：未登记的选择器必须红",
    },
    {
      key: "chart.extra",
      selector: "[data-extra]",
      source: "src/components/Foo.tsx",
      markers: ["data-extra"],
      note: "反例夹具：已登记但模板未登记必须红",
    },
  ],
  templates: [{ pattern: "`[data-item='${}']`", source: "src/features/workbench/diag.ts" }],
});

function makeFixture(name, mutate) {
  const root = join(TMP, name);
  mkdirSync(join(root, "app", "scripts"), { recursive: true });
  mkdirSync(join(root, "app", "src", "components"), { recursive: true });
  mkdirSync(join(root, "app", "src", "features", "workbench"), { recursive: true });
  const manifest = baseManifest();
  const component = { text: componentSource };
  const evidence = { text: evidenceSource };
  mutate({ manifest, component, evidence });
  writeFileSync(join(root, "app", "scripts", "dom-contracts.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(root, "app", "src", "components", "Foo.tsx"), component.text);
  writeFileSync(join(root, "app", "src", "features", "workbench", "diag.ts"), evidence.text);
  return root;
}

function run(script, root) {
  try {
    return { code: 0, output: execFileSync(process.execPath, [script, "--root", root], { encoding: "utf8" }) };
  } catch (error) {
    return { code: error.status ?? 1, output: String(error.stderr ?? error.stdout ?? "") };
  }
}

const cases = [
  {
    name: "rename-product-without-contract",
    label: "改产品属性名不改清单",
    mutate: ({ component }) => {
      component.text = component.text.replace('data-chart="1"', 'data-chart="2"');
    },
    reason: "未在 src/components/Foo.tsx 字面出现",
  },
  {
    name: "delete-registration",
    label: "清单删一条登记",
    mutate: ({ manifest }) => {
      manifest.contracts = manifest.contracts.filter((entry) => entry.key !== "chart.root");
    },
    reason: "data-* 未登记「data-chart」",
  },
  {
    name: "add-unregistered-selector",
    label: "取证代码新增未登记选择器",
    mutate: ({ evidence }) => {
      evidence.text += 'const probe = document.querySelector("[data-new-probe]");\n';
    },
    reason: "data-* 未登记「data-new-probe」",
  },
  {
    name: "concat-outside-manifest",
    label: "清单外拼接选择器",
    mutate: ({ evidence }) => {
      evidence.text += "const templated = `[data-extra='${value}']`;\n";
    },
    reason: "选择器模板未登记",
  },
];

// 变异：把 ENABLED 整行替换为全 false（模拟「旧形态不检查」）。
const checkerSource = readFileSync(CHECKER, "utf8");
const anchor = /const ENABLED = \{ contract: true, registry: true, template: true \};/;
if (!anchor.test(checkerSource)) {
  console.error("::error::变异锚点丢失：verify_dom_contracts.mjs 的 ENABLED 行已变化，selftest 无法证明反例有效");
  process.exit(2);
}
const MUTANT = join(TMP, "verify_dom_contracts_mutant.mjs");
writeFileSync(MUTANT, checkerSource.replace(anchor, "const ENABLED = { contract: false, registry: false, template: false };"));

const failures = [];

// 基线：正常形态绿；变异形态也绿（证明变异只关检查，不破坏夹具）。
const baseline = makeFixture("baseline", () => {});
const baselineRun = run(CHECKER, baseline);
if (baselineRun.code !== 0) failures.push(`基线应绿，实际 exit=${baselineRun.code}：${baselineRun.output.trim()}`);
const baselineMutant = run(MUTANT, baseline);
if (baselineMutant.code !== 0) failures.push(`变异基线应绿，实际 exit=${baselineMutant.code}`);

for (const item of cases) {
  const root = makeFixture(item.name, item.mutate);
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
  console.error(`verify:dom-contracts:selftest 失败：${failures.length} 项`);
  process.exit(1);
}

console.log(
  `verify:dom-contracts:selftest 通过：反例 ${cases.length}/${cases.length} 判红，变异后 ${cases.length}/${cases.length} 变绿`,
);
rmSync(TMP, { recursive: true, force: true });
