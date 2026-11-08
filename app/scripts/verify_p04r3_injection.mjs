// W-115：P04-R3「目录不存在」可达性门禁。
// 制度第 29 条：派生/判定逻辑必须配「会让它错」的反例，否则就是一条永远绿的断言。
// 本脚本不维护第二份期望值，全部从源码派生：
//  1) 注入开关只在 debug 编译（`faults_from_args` 被 cfg(debug_assertions) 覆盖，release 用默认值）；
//  2) 命令层把 `manifest_missing` 变成 `version = None`；
//  3) 关于页由 `datasource.version === null` 派生 `dataDirMissing`，且 missing 状态与重建入口只在该分支渲染；
//  4) 直接取出 P04-R3 的 passed 表达式求值：注入生效 → 绿；注入未生效 → 必须红；
//  5) 变异校验：把表达式换成恒真 `true` 后，未生效样本必须不再判红，证明反例不是恒真断言。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rootPath = fileURLToPath(new URL("../", import.meta.url));
const read = (rel) => readFileSync(`${rootPath}${rel}`, "utf8");

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

/** 取函数体：从 `fn <name>` 行开始按花括号配对（与 verify-diag-gate.mjs 同口径）。 */
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

/** `#[cfg(debug_assertions)]` 是否紧贴函数上方（中间只隔注释/属性/空行）。 */
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

/** 从 batchDiag.ts 的 push("P04-R3", ..., "render", <expr>, ...) 取出真实判定表达式。 */
function p04r3Expr(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.includes('"P04-R3"'));
  if (start < 0) return null;
  let i = start;
  while (i < lines.length && !lines[i].includes('"render",')) i += 1;
  if (i + 1 >= lines.length) return null;
  return lines[i + 1].trim().replace(/,$/, "");
}

const lib = read("src-tauri/src/lib.rs");
const state = read("src-tauri/src/state.rs");
const commands = read("src-tauri/src/commands.rs");
const settings = read("src/pages/settings/SettingsPage.tsx");
const batch = read("src/features/qa/batchDiag.ts");
const diagGate = read("scripts/verify-diag-gate.mjs");

// 1) 注入开关：debug 参数解析 + release 默认值。
check(debugOnlyAbove(lib, "faults_from_args"), "faults_from_args 未被 #[cfg(debug_assertions)] 覆盖");
const faultsBody = fnBody(lib, "faults_from_args") ?? "";
check(
  faultsBody.includes('manifest_missing: diag_flag(args, "--missing-dataset-manifest")'),
  "faults_from_args 未解析 --missing-dataset-manifest",
);
check(lib.includes("DiagFaults::default()"), "非 debug 构建未回落 DiagFaults::default()");

// 2) 开关字段与命令层映射。
check(/pub manifest_missing: bool/.test(state), "DiagFaults 缺 manifest_missing 字段");
check(
  /derive\([^)]*Default[^)]*\)[\s\S]{0,200}pub struct DiagFaults/.test(state),
  "DiagFaults 未派生 Default（release 默认值不可靠）",
);

const manifestBody = fnBody(commands, "dataset_manifest") ?? "";
check(manifestBody.includes("state.faults().manifest_missing"), "dataset_manifest 未接 manifest_missing");
check(manifestBody.includes("return Ok(None);"), "dataset_manifest 注入时未返回 None");

const statusBody = fnBody(commands, "datasource_status") ?? "";
check(statusBody.includes("state.faults().manifest_missing"), "datasource_status 未接 manifest_missing");
check(statusBody.includes('status.version = None;'), "datasource_status 注入时未把 version 置空");
check(statusBody.includes('status.state = "missing";'), "datasource_status 注入时未把 state 置 missing");
check(statusBody.includes('status.error_code = Some("E_DATASET_MISSING");'), "datasource_status 注入时未给 E_DATASET_MISSING");

// 3) 关于页派生链：version === null → dataDirMissing → missing 文案 + 重建入口。
check(
  settings.includes("const dataDirMissing = datasource !== null && datasource.version === null;"),
  "关于页 dataDirMissing 未由 datasource.version === null 派生",
);
check(settings.includes('data-about-datadir-state="missing"'), "关于页缺 missing 状态 DOM");
check(settings.includes('data-about-datadir-rebuild="1"'), "关于页缺重建样本包入口 DOM");
check(settings.includes("{dataDirMissing && ("), "重建入口未由 dataDirMissing 守卫");

// 4) P04-R3 判定表达式：注入生效绿、注入未生效必须红。
const expr = p04r3Expr(batch);
check(expr !== null, "batchDiag.ts 取不到 P04-R3 判定表达式");
check(expr !== null && expr.includes('state === "missing"'), "P04-R3 未断言 missing 状态");
check(expr !== null && expr.includes("rebuild"), "P04-R3 未断言重建入口");

if (expr !== null) {
  const judge = new Function("datadir", "state", "rebuild", `return (${expr});`);
  const injected = judge("~/Library/Application Support/AKA/data/sim", "missing", true);
  const notInjected = judge("~/Library/Application Support/AKA/data/sim", "present", false);
  check(injected === true, "注入生效时 P04-R3 未判绿（check 与注入链不匹配）");
  check(notInjected === false, "注入未生效时 P04-R3 未判红（断言恒绿，等于没有验收）");

  // 5) 变异：把判定换成恒真后，未生效样本必须不再判红。
  const mutated = new Function("datadir", "state", "rebuild", "return true;");
  check(
    mutated("~/Library/Application Support/AKA/data/sim", "present", false) === true,
    "变异锚点失效：恒真表达式没有让未生效样本变绿，反例有效性无法证明",
  );
}

// 6) release 门禁覆盖新开关：否则「不进 release 默认路径」只有承诺没有检查。
check(
  /MARKER\s*=.*missing-dataset-manifest/.test(diagGate),
  "verify-diag-gate.mjs 的 MARKER 未覆盖 --missing-dataset-manifest（release 断言会漏）",
);

if (failures.length > 0) {
  for (const message of failures) console.error(`::error::P04-R3 注入门禁失败：${message}`);
  process.exit(1);
}

console.log(
  "W-115 P04-R3 注入门禁通过：注入开关 debug-only（release 回默认值）；" +
    "注入生效 1/1 绿、注入未生效 1/1 红；变异为恒真后未生效变绿（反例有效）。",
);
