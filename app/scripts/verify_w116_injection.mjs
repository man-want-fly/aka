#!/usr/bin/env node
// W-116：S-02.08-01 / AC-02.08-01（补2）「只缺 sha256、其余 6 段正常」可达性门禁。
// 与 W-115 同构（制度第 29 条）：全部从源码派生，不维护第二份期望值。
//  1) 注入开关 debug-only，release 回落 DiagFaults::default()；
//  2) 命令层把 manifest 的 sha256 置空但返回 Some（其余 8 字段原样），区别于 W-115 的整体 None；
//  3) 页脚 version 段由 shortSha(m?.sha256) 派生，空 → `—`；其余段不依赖 sha256；
//  4) 取出 batchDiag.ts 里 S0208-P2R 的判定表达式求值：注入生效绿、未生效必须红；
//  5) 变异为恒真后，未生效样本必须不再判红，证明反例不是恒真断言；
//  6) release 符号门禁 MARKER 覆盖新开关。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rootPath = fileURLToPath(new URL("../", import.meta.url));
const read = (rel) => readFileSync(`${rootPath}${rel}`, "utf8");
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

/** 取函数体：从 `fn <name>` 行开始按花括号配对（与 verify_p04r3_injection.mjs 同口径）。 */
function fnBody(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => new RegExp(`fn\\s+${name}\\s*[<(]`).test(line));
  if (start < 0) return null;
  let depth = 0;
  let started = false;
  const body = [];
  for (let i = start; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth += 1;
        started = true;
      } else if (ch === "}") {
        depth -= 1;
      }
    }
    if (started) body.push(lines[i]);
    if (started && depth === 0) break;
  }
  return body.join("\n");
}

/** `#[cfg(debug_assertions)]` 是否紧贴函数上方。 */
function debugOnlyAbove(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => new RegExp(`fn\\s+${name}\\s*[<(]`).test(line));
  if (start < 0) return false;
  for (let i = start - 1; i >= Math.max(0, start - 10); i -= 1) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    if (trimmed.includes("#[cfg(debug_assertions)]")) return true;
    if (trimmed.startsWith("#[")) continue;
    return false;
  }
  return false;
}

/** 从 batchDiag.ts 的 push("<id>", ..., "render", <expr>, ...) 取判定表达式。 */
function judgementExpr(text, id) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.includes(`"${id}"`));
  if (start < 0) return null;
  let i = start;
  while (i < lines.length && !lines[i].includes('"render",')) i += 1;
  if (i + 1 >= lines.length) return null;
  return lines[i + 1].trim().replace(/,$/, "");
}

const lib = read("src-tauri/src/lib.rs");
const state = read("src-tauri/src/state.rs");
const commands = read("src-tauri/src/commands.rs");
const overview = read("src/features/workbench/datasetOverview.ts");
const batch = read("src/features/qa/batchDiag.ts");
const diagGate = read("scripts/verify-diag-gate.mjs");

// 1) 注入开关：debug 参数解析 + release 默认值。
check(debugOnlyAbove(lib, "faults_from_args"), "faults_from_args 未被 #[cfg(debug_assertions)] 覆盖");
const faultsBody = fnBody(lib, "faults_from_args") ?? "";
check(
  faultsBody.includes('manifest_sha256_missing: diag_flag(args, "--missing-manifest-sha256")'),
  "faults_from_args 未解析 --missing-manifest-sha256",
);
check(lib.includes("DiagFaults::default()"), "非 debug 构建未回落 DiagFaults::default()");

// 2) 开关字段与命令层映射：只缺一段，不整份消失。
check(/pub manifest_sha256_missing: bool/.test(state), "DiagFaults 缺 manifest_sha256_missing 字段");
check(
  /derive\([^)]*Default[^)]*\)[\s\S]{0,300}pub struct DiagFaults/.test(state),
  "DiagFaults 未派生 Default（release 默认值不可靠）",
);
const manifestBody = fnBody(commands, "dataset_manifest") ?? "";
check(manifestBody.includes("state.faults().manifest_sha256_missing"), "dataset_manifest 未接新开关");
check(manifestBody.includes("m.sha256.clear()"), "dataset_manifest 注入时未把 sha256 置空");
check(
  manifestBody.indexOf("manifest_sha256_missing") > manifestBody.indexOf("manifest_missing"),
  "新注入分支必须排在 W-115 整体缺失分支之后（整体缺失优先返回 None）",
);
const statusBody = fnBody(commands, "datasource_status") ?? "";
check(!statusBody.includes("manifest_sha256_missing"), "注入不得顺手改数据源状态页语义");

// 3) 页脚派生链：version 段由 shortSha(m?.sha256) 决定，缺则 `—`。
check(overview.includes("shortSha(m?.sha256)"), "页脚 version 段未由 sha256 派生");
check(overview.includes("missing: !shortSha(m?.sha256)"), "页脚 version 段缺 missing 派生");
const decl = overview.match(/export const DATASET_SEGMENTS = \[([\s\S]*?)\] as const;/);
const keys = decl ? [...decl[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]) : [];
check(keys.length === 7 && keys[1] === "version", "页脚 7 段口径或 version 段位置不符");

// 4) 判定表达式：注入生效绿、未生效必须红。
const expr = judgementExpr(batch, "S0208-P2R");
check(expr !== null, "batchDiag.ts 取不到 S0208-P2R 判定表达式");
if (expr !== null && keys.length === 7) {
  const judge = new Function("segments", `return (${expr});`);
  const injected = keys.map((key) => ({ key, missing: key === "version" }));
  const notInjected = keys.map((key) => ({ key, missing: false }));
  check(judge(injected) === true, "注入生效时 S0208-P2R 未判绿（判定与注入链不匹配）");
  check(judge(notInjected) === false, "注入未生效时 S0208-P2R 未判红（断言恒绿，等于没有验收）");

  // 5) 变异：把判定换成恒真后，未生效样本必须不再判红。
  const mutated = new Function("segments", "return true;");
  check(
    mutated(notInjected) === true,
    "变异锚点失效：恒真表达式没有让未生效样本变绿，反例有效性无法证明",
  );
}

// 6) release 符号门禁覆盖新开关。
check(
  /MARKER\s*=.*missing-manifest-sha256/.test(diagGate),
  "verify-diag-gate.mjs 的 MARKER 未覆盖 --missing-manifest-sha256（release 断言会漏）",
);

if (failures.length > 0) {
  for (const message of failures) console.error(`::error::W-116 注入门禁失败：${message}`);
  process.exit(1);
}
console.log(
  "W-116 单字段注入门禁通过：注入开关 debug-only（release 回默认值）；" +
    "命令层只清 sha256 且保留 Some（其余 8 字段原样）；页脚 7 段由 DATASET_SEGMENTS 派生；" +
    "注入生效 1/1 绿、注入未生效 1/1 红；变异为恒真后未生效变绿（反例有效）。",
);
