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
  "aka/diag",
];

/** 写命令：release 的 invoke_handler 不得出现，debug 必须出现，且命令函数必须有 cfg。 */
const WRITE_COMMANDS = ["diag_faults", "diag_write", "diag_write_named"].filter((name) =>
  SYMBOLS.includes(name),
);

/** 其余符号是字面量（启动参数 / 环境变量 / 诊断文件名 / 落盘路径）：只能出现在 cfg 覆盖的函数里。 */
const LITERALS = SYMBOLS.filter((name) => !WRITE_COMMANDS.includes(name));

const root = new URL("../", import.meta.url);
const lib = readFileSync(new URL("src-tauri/src/lib.rs", root), "utf8");
const commands = readFileSync(new URL("src-tauri/src/commands.rs", root), "utf8");
const core = readFileSync(new URL("crates/app-core/src/core.rs", root), "utf8");
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
const coveredByCfg = (name, lines) => {
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

const files = {
  "src-tauri/src/lib.rs": lib.split("\n"),
  "src-tauri/src/commands.rs": commands.split("\n"),
  "crates/app-core/src/core.rs": core.split("\n"),
};

/** 从命中行向上找最近的函数定义（跳过注释行）。 */
const enclosingFn = (lines, at) => {
  for (let i = at; i >= 0; i -= 1) {
    const match = lines[i].match(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/);
    if (match) return match[1];
  }
  return null;
};

/** 语句级 cfg：命中行上方几条内出现 #[cfg(debug_assertions)]（中间只隔注释/属性/空行）。 */
const statementGated = (lines, at) => {
  for (let i = at - 1; i >= Math.max(0, at - 4); i -= 1) {
    const text = lines[i].trim();
    if (!text || text.startsWith("//")) continue;
    if (text.includes("#[cfg(debug_assertions)]")) return true;
    if (text.startsWith("#[")) continue;
    return false;
  }
  return false;
};

for (const name of WRITE_COMMANDS) {
  const result = coveredByCfg(name, files["src-tauri/src/commands.rs"]);
  if (!result.ok) failures.push(`fn ${name}：${result.reason}`);
}
if (!coveredByCfg("write_diag", files["src-tauri/src/commands.rs"]).ok) {
  failures.push("fn write_diag：函数上方未见 #[cfg(debug_assertions)]");
}

/** 字面量逐个归属：每一处出现都必须在 cfg(debug_assertions) 覆盖的函数内。 */
for (const symbol of LITERALS) {
  let hits = 0;
  for (const [file, lines] of Object.entries(files)) {
    lines.forEach((line, at) => {
      if (!line.includes(symbol)) return;
      if (line.trim().startsWith("//")) return;
      hits += 1;
      if (statementGated(lines, at)) return;
      const fn = enclosingFn(lines, at);
      if (!fn) {
        failures.push(`${file}:${at + 1} ${symbol} 不在任何函数内`);
        return;
      }
      if (!coveredByCfg(fn, lines).ok) {
        failures.push(`${file}:${at + 1} ${symbol} 所在 fn ${fn} 未覆盖 #[cfg(debug_assertions)]`);
      }
    });
  }
  if (hits === 0) console.log(`字面量 ${symbol}：源码 0 处（只由产物层断言）`);
}

/** W-63：导出分支注入只允许出现在 `import.meta.env.DEV` 守卫内；键名集中在 src/lib/diagExport.ts。 */
const exportLib = readFileSync(new URL("src/lib/diagExport.ts", root), "utf8");
const EXPORT_KEY = "aka.diag.export";
const GUARD = "if (import.meta.env.DEV) {";
const guardPositions = [];
for (let at = exportLib.indexOf(GUARD); at >= 0; at = exportLib.indexOf(GUARD, at + 1)) {
  guardPositions.push(at);
}
const keyPositions = [];
for (let at = exportLib.indexOf(EXPORT_KEY); at >= 0; at = exportLib.indexOf(EXPORT_KEY, at + 1)) {
  keyPositions.push(at);
}
const guarded = (pos) => guardPositions.some((start) => pos > start && pos - start <= 300);
if (guardPositions.length < 1) {
  failures.push("diagExport.ts 缺 import.meta.env.DEV 守卫（W-63）");
}
if (keyPositions.length !== guardPositions.length || !keyPositions.every(guarded)) {
  failures.push(
    `导出注入键 ${EXPORT_KEY} 出现 ${keyPositions.length} 次 / DEV 守卫 ${guardPositions.length} 个，存在键名不在守卫内（W-63）`,
  );
}
// 键名只许集中在 diagExport.ts；调用方直接写键名等于绕开守卫。
for (const rel of ["src/components/Watchlist.tsx", "src/features/watchlist/watchlistDiag.ts"]) {
  if (readFileSync(new URL(rel, root), "utf8").includes(EXPORT_KEY)) {
    failures.push(`${rel} 直接使用了 ${EXPORT_KEY}，应走 src/lib/diagExport.ts（W-63）`);
  }
}

if (failures.length > 0) {
  for (const message of failures) console.error(`::error::诊断入口源码层门禁失败：${message}`);
  process.exit(1);
}
console.log(
  `诊断入口源码层门禁通过：release 无写命令注册；${WRITE_COMMANDS.join(" / ")} 与 write_diag 均有 cfg(debug_assertions)；` +
    `${LITERALS.length} 个字面量仅出现在 cfg 覆盖的函数内。`,
);
