// W-49 / W-58 源码层门禁：release 构建的诊断入口必须被 cfg 覆盖，且不注册写命令。
// 产物层由 CI 的 strings 断言兜底；本脚本只静态检查源码，防止「产物恰好为 0」假绿。
// 符号表与产物门禁保持同一份（改这里必须同步改 ci.yml 的 symbol 列表）。

import { readFileSync } from "node:fs";

const SYMBOLS = [
  "AKA-DIAG-CORRUPT",
  "--corrupt-db",
  "--readonly-db",
  "--empty-dataset",
  "AKA_DIAG",
  "AKA_DIAG_TARGET",
  "AKA_DIAG_INF",
  "diag_write_named",
  "diag_write",
  "diag_faults",
  "s2-evidence",
];

/** 写命令：release 的 invoke_handler 不得出现，debug 必须出现，且命令函数必须有 cfg。 */
const WRITE_COMMANDS = ["diag_faults", "diag_write", "diag_write_named"].filter((name) =>
  SYMBOLS.includes(name),
);

const root = new URL("../src-tauri/src/", import.meta.url);
const lib = readFileSync(new URL("lib.rs", root), "utf8");
const commands = readFileSync(new URL("commands.rs", root), "utf8");
const failures = [];

const handlerBlocks = [];
for (let at = lib.indexOf("let builder = builder.invoke_handler"); at >= 0; ) {
  const end = lib.indexOf("]);", at);
  if (end < 0) break;
  handlerBlocks.push(lib.slice(at, end));
  at = lib.indexOf("let builder = builder.invoke_handler", end);
}
if (handlerBlocks.length !== 2) {
  failures.push(`invoke_handler 块应恰好 2 个（debug/release），实际 ${handlerBlocks.length} 个`);
}
const [debugHandler = "", releaseHandler = ""] = handlerBlocks;

/** 用非标识符边界匹配，避免 diag_write 命中 diag_write_named。 */
const mentions = (text, command) => new RegExp(`commands::${command}(?![A-Za-z0-9_])`).test(text);

for (const command of WRITE_COMMANDS) {
  if (mentions(releaseHandler, command)) {
    failures.push(`release invoke_handler 仍注册 commands::${command}`);
  }
  if (!mentions(debugHandler, command)) {
    failures.push(`debug invoke_handler 缺 commands::${command}（调试能力被误删同样要拦）`);
  }
}

/** fn 定义之前（跨过注释与其他属性）必须出现 #[cfg(debug_assertions)]。 */
const coveredByCfg = (name) => {
  const lines = commands.split("\n");
  const at = lines.findIndex((line) => line.includes(`fn ${name}(`));
  if (at < 0) return { ok: false, reason: "未找到函数定义" };
  for (let i = at - 1; i >= Math.max(0, at - 8); i -= 1) {
    const text = lines[i].trim();
    if (!text || text.startsWith("//")) continue;
    if (text.includes("#[cfg(debug_assertions)]")) return { ok: true };
    if (text.startsWith("#[")) continue;
    break;
  }
  return { ok: false, reason: "函数上方未见 #[cfg(debug_assertions)]" };
};

for (const name of [...WRITE_COMMANDS, "write_diag"]) {
  const result = coveredByCfg(name);
  if (!result.ok) failures.push(`fn ${name}：${result.reason}`);
}

if (failures.length > 0) {
  for (const message of failures) console.error(`::error::诊断入口源码层门禁失败：${message}`);
  process.exit(1);
}
console.log(`诊断入口源码层门禁通过：release 无写命令注册；${WRITE_COMMANDS.join(" / ")} 与 write_diag 均有 cfg(debug_assertions)。`);
