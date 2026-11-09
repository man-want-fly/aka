#!/usr/bin/env node
// W-118：取证套件 runner 调用点门禁（制度第 29 条：每条判定都要有反例、能判红）。
//
// 事故：s050101 / s020801 的 runner 只在 batchDiag.ts 有定义，宿主层没有任何
// import/调用 → 死代码，AKA_DIAG_TARGET 命中也零 dump、240s 超时。
// 本门禁把「每个取证 case 都有接线 + 套件 runner 有宿主调用点」变成可判红检查。
//
// 真源（不新增第二事实源）：
//   1) app/scripts/diag-evidence.sh 的 `<suite>)` case + JSON="$DIAG_DIR/<file>"
//   2) app/src/features/qa/batchDiag.ts 的 `export async function run*Diagnostics`
//      + `baseReport("<suite>")` + `writeBatchReport("<file>")`
//   3) app/src/pages/**、app/src/components/** 的 `run*Diagnostics(` 宿主调用点
//   4) app/src 全量 .ts/.tsx 文本（case 接线锚点字面量）
//
// 判据（任一不满足 exit 2）：
//   J1 套件闭环：每个 batchDiag runner 的 suite 有 case、case.JSON===runner.file、
//      且 runner.name 在宿主层有调用点（缺即「死 runner」）。
//   J2 case 锚点：diag-evidence.sh 每个 case 在 app/src 里至少有一个确定性接线锚点
//      （"<suite>" / "<file>" / aka.batch.<suite>.done / aka.<suite>.diag.done /
//       baseReport("<suite>") / 动态 target 前缀 startsWith("<base>")）；无命中即判红。
//   J3 反例自证：逐一变异，验证 J1/J2 能判红（不为绿放宽）。
//
// 用法：node scripts/verify_diag_runner_wiring.mjs
// 退出码：0=通过；2=任一判据或反例失败。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const SRC = path.join(APP, "src");

const read = (rel) => fs.readFileSync(path.join(APP, rel), "utf8");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** diag-evidence.sh：逐行扫到 `    ;;`，与 bash 解析及 verify_evidence_suites.mjs 一致。 */
function parseCases(diag) {
  const lines = diag.split("\n");
  const cases = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const head = lines[i].match(/^  ([a-z0-9-]+)\)$/);
    if (!head) continue;
    const body = [];
    let j = i + 1;
    while (j < lines.length && lines[j] !== "    ;;") {
      body.push(lines[j]);
      j += 1;
    }
    cases.set(head[1], {
      json: body.join("\n").match(/JSON="\$DIAG_DIR\/([^"]*)"/)?.[1] ?? null,
    });
    i = j;
  }
  return cases;
}

/** batchDiag.ts：按 export 切块，只取带 baseReport("<suite>") 的套件 runner。 */
function parseRunners(batch) {
  const out = [];
  for (const chunk of batch.split(/\nexport async function /)) {
    const name = chunk.match(/^(run[A-Za-z0-9]+Diagnostics)/)?.[1];
    if (!name) continue;
    const suite = chunk.match(/baseReport\("([^"]+)"\)/)?.[1];
    if (!suite) continue; // 跳过 writeDiagnosticFailure 等非套件 export
    const file = chunk.match(/writeBatchReport\("([^"]+)"/)?.[1] ?? null;
    out.push({ name, suite, file });
  }
  return out;
}

/**
 * 核心判定（纯函数，便于反例变异复用）。
 * hosts：宿主层（pages/components）文件文本数组；allTexts：app/src 全量源码文本数组。
 */
function analyze({ diag, batch, hosts, allTexts }) {
  const cases = parseCases(diag);
  const runners = parseRunners(batch);
  const hostCalls = new Set();
  for (const text of hosts) {
    for (const m of text.matchAll(/\b(run[A-Za-z0-9]+Diagnostics)\s*\(/g)) hostCalls.add(m[1]);
  }
  const all = allTexts.join("\n");

  const failures = [];
  const anchors = [];
  let j1 = 0;
  let j2 = 0;

  // J1 套件闭环：case 绑定 + 写盘名一致 + 宿主调用点（缺即死 runner）
  for (const r of runners) {
    const c = cases.get(r.suite);
    if (!c) {
      failures.push(`J1 ${r.name}: suite ${r.suite} 无 case`);
      continue;
    }
    if (c.json !== r.file) {
      failures.push(`J1 ${r.name}: 写盘名不一致 case=${c.json} runner=${r.file}`);
      continue;
    }
    if (!hostCalls.has(r.name)) {
      failures.push(`J1 ${r.name}: 宿主层无调用点（死 runner）`);
      continue;
    }
    j1 += 1;
  }

  // J2 每个 case 在 app/src 至少有一个确定性接线锚点（固定锚点集合，无白名单）
  for (const [suite, c] of cases) {
    const forms = [
      `"${suite}"`,
      c.json ? `"${c.json}"` : null,
      `aka.batch.${suite}.done`,
      `aka.${suite}.diag.done`,
      `baseReport("${suite}")`,
    ].filter(Boolean);
    let hit = forms.find((f) => all.includes(f)) ?? null;
    // 动态拼接 target：suite 形如 <base>-<suffix>（watchlist-* / s070102-corrupt），
    // 放行靠 startsWith("<base>")；这是通用规则，不是针对某张卡的白名单。
    if (!hit && suite.includes("-")) {
      const base = suite.split("-")[0];
      if (all.includes(`startsWith("${base}")`) && all.includes(`"${base}"`)) {
        hit = `startsWith("${base}")`;
      }
    }
    if (!hit) failures.push(`J2 ${suite}: app/src 无接线锚点`);
    else {
      j2 += 1;
      anchors.push(`  ${suite} → ${hit}`);
    }
  }

  return { cases, runners, hostCalls, failures, anchors, j1, j2 };
}

const diag = read("scripts/diag-evidence.sh");
const batch = read("src/features/qa/batchDiag.ts");
const allFiles = walk(SRC);
const isHost = (f) =>
  f.includes(`${path.sep}pages${path.sep}`) || f.includes(`${path.sep}components${path.sep}`);
const hosts = allFiles.filter(isHost).map((f) => fs.readFileSync(f, "utf8"));
const allTexts = allFiles.map((f) => fs.readFileSync(f, "utf8"));

const real = analyze({ diag, batch, hosts, allTexts });
for (const line of real.anchors) console.log(line);
for (const f of real.failures) console.error(`FAIL ${f}`);
console.log(
  `取证套件 runner 门禁：case ${real.cases.size} 个 / 套件 runner ${real.runners.length} 个 / ` +
    `J1 闭环 ${real.j1}/${real.runners.length} / J2 case 锚点 ${real.j2}/${real.cases.size}`,
);

// —— J3 反例自证：每条判定都要能被变异打红（制度第 29 条）——
const mutations = [];
// (a) 逐一移除每个 runner 的宿主调用点 → J1 必须判「死 runner」
for (const r of real.runners) {
  const brokenHosts = hosts.map((h) => h.split(`${r.name}(`).join(`${r.name}_UNWIRED(`));
  const out = analyze({ diag, batch, hosts: brokenHosts, allTexts });
  mutations.push({
    id: `死runner:${r.name}`,
    red: out.failures.some((f) => f.includes(r.name) && f.includes("宿主层无调用点")),
  });
}
// (b) 删掉 s020801 的 case → J1 必须判「无 case」
{
  const lines = diag.split("\n");
  const kept = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === "  s020801)") {
      while (i < lines.length && lines[i] !== "    ;;") i += 1;
      continue;
    }
    kept.push(lines[i]);
  }
  const out = analyze({ diag: kept.join("\n"), batch, hosts, allTexts });
  mutations.push({
    id: "删case:s020801",
    red: out.failures.some((f) => f.includes("runS020801Diagnostics") && f.includes("无 case")),
  });
}
// (c) 追加一个 app/src 完全没有接线的假 case → J2 必须判红
{
  const fake = `${diag}\n  w118-fake)\n    TARGET="w118-fake"\n    JSON="$DIAG_DIR/w118-fake-evidence.json"\n    ;;\n`;
  const out = analyze({ diag: fake, batch, hosts, allTexts });
  mutations.push({
    id: "无接线case:w118-fake",
    red: out.failures.some((f) => f.startsWith("J2 w118-fake")),
  });
}

for (const m of mutations) {
  if (!m.red) console.error(`FAIL 反例未判红：${m.id}`);
}
const red = mutations.filter((m) => m.red).length;
console.log(
  `反例 ${red}/${mutations.length} 判红（死 runner ${real.runners.length} + 删 case 1 + 无接线 case 1）`,
);

if (
  real.failures.length > 0 ||
  real.j1 !== real.runners.length ||
  real.j2 !== real.cases.size ||
  red !== mutations.length
) {
  process.exit(2);
}
