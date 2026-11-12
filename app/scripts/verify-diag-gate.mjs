// W-49 / W-58 / W-64 诊断入口门禁。
// 清单全部从源码派生，不再维护第二份名字表：
// 1) `#[tauri::command]` 得到命令全集，debug/release 的 invoke_handler 都必须 ⊆ 全集；
// 2) 按行为判定诊断命令（函数体 + 一层被调函数碰到 write_diag / aka/diag / AKA_DIAG / s2-evidence），
//    release 集合与诊断命令必须为空交集；
// 3) 写盘物质不变量：`fs::write` / `File::create` 只允许出现在诊断命令，或 cfg(debug) 覆盖的辅助函数里；
// 4) 诊断字面量逐个位置检查：每一处出现都必须在 cfg(debug_assertions) 覆盖的代码内；
// 5) `--emit-symbols` 输出派生的产物符号表（`symbol<TAB>需扣减的子串`），CI 产物层直接消费该输出。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const collectRust = (dirs) => {
  const out = [];
  for (const dir of dirs) {
    const walk = (full) => {
      for (const entry of readdirSync(full)) {
        const path = join(full, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".rs")) out.push(path);
      }
    };
    walk(join(rootPath, dir));
  }
  return out;
};

const desktopFiles = collectRust(["src-tauri/src"]);
const scanFiles = [...desktopFiles, ...collectRust(["crates/app-core/src"])];
const read = (path) => readFileSync(path, "utf8");
const rel = (path) => relative(rootPath, path);
const splitLines = (text) => text.split("\n");

/** 诊断标记串：从源码字符串字面量里抽出的标记片段（允许是更长路径/文件名的一部分）。
 *  `AKA_BUILD_*` 是发布构建元数据（W-28），不是调试开关，必须允许出现在 release。 */
const MARKER = /AKA[_-](?!BUILD_)[A-Z0-9_-]*|--(?:corrupt-db|readonly-db|empty-dataset|missing-dataset-manifest|missing-manifest-sha256)|s2-evidence|aka\/diag/g;
const STRING_LITERAL = /"((?:[^"\\]|\\.)*)"/g;

const markerNames = new Set();
for (const path of scanFiles) {
  for (const match of read(path).matchAll(STRING_LITERAL)) {
    for (const marker of match[1].matchAll(MARKER)) markerNames.add(marker[0]);
  }
}

const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const fnRegex = /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)\s*[<(]/;

/** 逐文件建函数表：同名函数（debug/release 双定义）按行区间区分。 */
const fileEntries = new Map();
for (const path of scanFiles) {
  const lines = splitLines(read(path));
  const entries = [];
  lines.forEach((line, at) => {
    const match = line.match(fnRegex);
    if (!match) return;
    const { body, end } = braceBlock(lines, at);
    entries.push({ name: match[1], file: rel(path), start: at, end, lines, body, ...cfgOf(lines, at) });
  });
  fileEntries.set(rel(path), entries);
}

function braceBlock(lines, fnLine) {
  let depth = 0;
  let started = false;
  const body = [];
  for (let i = fnLine; i < lines.length; i += 1) {
    const line = stripComments(lines[i]);
    for (const ch of line) {
      if (ch === "{") {
        depth += 1;
        started = true;
      } else if (ch === "}") {
        depth -= 1;
      }
    }
    if (started) body.push(lines[i]);
    if (started && depth === 0) return { body: body.join("\n"), end: i };
  }
  return { body: body.join("\n"), end: lines.length - 1 };
}

function cfgOf(lines, fnLine) {
  let debugOnly = false;
  let releaseOnly = false;
  for (let i = fnLine - 1; i >= Math.max(0, fnLine - 10); i -= 1) {
    const text = lines[i].trim();
    if (!text || text.startsWith("//")) continue;
    if (text.includes("#[cfg(debug_assertions)]")) debugOnly = true;
    if (text.includes("#[cfg(not(debug_assertions))]")) releaseOnly = true;
    if (text.startsWith("#[")) continue;
    break;
  }
  return { debugOnly, releaseOnly };
}

/** 去掉 `#[cfg(debug_assertions)]` 及其紧跟的一条语句/块，得到 release 可见的函数体。 */
function releaseLive(body) {
  const lines = splitLines(body);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim().startsWith("#[cfg(debug_assertions)]")) {
      out.push(lines[i]);
      continue;
    }
    i += 1;
    const next = (lines[i] ?? "").trim();
    if (next.startsWith("{")) {
      let depth = 0;
      for (; i < lines.length; i += 1) {
        for (const ch of stripComments(lines[i])) {
          if (ch === "{") depth += 1;
          if (ch === "}") depth -= 1;
        }
        if (depth === 0) break;
      }
    } else if (!next.endsWith(";")) {
      let depth = 0;
      for (; i < lines.length; i += 1) {
        for (const ch of stripComments(lines[i])) {
          if (ch === "{") depth += 1;
          if (ch === "}") depth -= 1;
        }
        if (depth === 0 && lines[i].trim().endsWith(";")) break;
      }
    }
  }
  return out.join("\n");
}

const enclosingEntry = (file, at) =>
  (fileEntries.get(file) ?? []).find((entry) => at >= entry.start && at <= entry.end) ?? null;

const entryByName = (file, name) => {
  const same = (fileEntries.get(file) ?? []).filter((entry) => entry.name === name);
  const live = same.find((entry) => !entry.debugOnly);
  return live ?? same[0] ?? null;
};

const calledNames = (text) =>
  Array.from(stripComments(text).matchAll(/([A-Za-z0-9_]+)\s*\(/g), (m) => m[1]);

/** 行为判定：release 可见的函数体或一层被调函数里有诊断标记，或本身只在 debug 编译。 */
function isDiagCommand(entry) {
  if (entry.debugOnly) return true;
  const live = stripComments(releaseLive(entry.body));
  const sources = [live];
  for (const name of calledNames(live)) {
    const callee = entryByName(entry.file, name);
    if (!callee || callee.debugOnly) continue;
    sources.push(stripComments(releaseLive(callee.body)));
  }
  return sources.some((text) => [...markerNames].some((marker) => text.includes(marker)));
}

const commandEntries = new Map();
for (const path of desktopFiles) {
  const lines = splitLines(read(path));
  lines.forEach((line, at) => {
    if (!line.includes("#[tauri::command]")) return;
    for (let i = at + 1; i < Math.min(lines.length, at + 10); i += 1) {
      const match = lines[i].match(fnRegex);
      if (match) {
        const entry = enclosingEntry(rel(path), i);
        if (entry) commandEntries.set(match[1], entry);
        return;
      }
      if (!lines[i].trim().startsWith("#[")) return;
    }
  });
}

const failures = [];
const lib = read(join(rootPath, "src-tauri/src/lib.rs"));
const handlerBlocks = [];
for (let at = lib.indexOf("let builder = builder.invoke_handler"); at >= 0; ) {
  const end = lib.indexOf("]);", at);
  if (end < 0) break;
  const before = lib.slice(Math.max(0, at - 220), at);
  const block = lib.slice(at, end);
  const registered = Array.from(block.matchAll(/commands::([A-Za-z0-9_]+)/g), (m) => m[1]);
  handlerBlocks.push({ before, registered });
  at = lib.indexOf("let builder = builder.invoke_handler", end);
}
if (handlerBlocks.length !== 2) {
  failures.push(`invoke_handler 块应恰好 2 个（debug/release），实际 ${handlerBlocks.length} 个`);
}
const debugHandler = handlerBlocks.find((block) => block.before.includes("#[cfg(debug_assertions)]"));
const releaseHandler = handlerBlocks.find((block) => block.before.includes("#[cfg(not(debug_assertions))]"));
if (!debugHandler || !releaseHandler) {
  failures.push("invoke_handler 的 debug/release 归属无法从 cfg 属性判定");
}
const debug = new Set(debugHandler?.registered ?? []);
const release = new Set(releaseHandler?.registered ?? []);

for (const [kind, set] of [["release", release], ["debug", debug]]) {
  for (const name of set) {
    if (!commandEntries.has(name)) {
      failures.push(`${kind} invoke_handler 注册了未知命令 commands::${name}（不在 #[tauri::command] 全集内）`);
    }
  }
}
for (const name of commandEntries.keys()) {
  if (!debug.has(name) && !release.has(name)) failures.push(`命令 commands::${name} 未注册进任何 invoke_handler`);
}

const diagCommands = [...commandEntries.keys()].filter((name) => isDiagCommand(commandEntries.get(name)));
for (const name of diagCommands) {
  if (release.has(name)) failures.push(`诊断命令 commands::${name} 出现在 release invoke_handler（release 不可带诊断入口）`);
  if (!debug.has(name)) failures.push(`诊断命令 commands::${name} 未注册进 debug invoke_handler（调试能力被误删）`);
}

/** AC-DF-05-05-1 / AC-DF-05-01-2：release 必须比 debug 少 5 条，且差额只能是诊断命令。 */
const debugOnly = [...debug].filter((name) => !release.has(name));
if (debug.size - release.size !== 5) {
  failures.push(
    `release 命令应比 debug 少 5 条诊断命令，实际 debug=${debug.size} / release=${release.size}（差 ${debug.size - release.size}）`,
  );
}
for (const name of debugOnly) {
  if (!diagCommands.includes(name)) {
    failures.push(`debug 专有的 commands::${name} 不是诊断命令（release 不得少非诊断命令）`);
  }
}

/** 物质不变量：写盘 API 只能在诊断命令，或 cfg(debug) 覆盖的辅助函数里。
 *  例外：S-06.03-02 的「导出诊断包」是 release 用户功能，写盘固定在 ~/Downloads 且内容经白名单过滤。 */
const USER_EXPORT_FNS = new Set([
  "src-tauri/src/diagnostics.rs:write_json",
  "src-tauri/src/diagnostics.rs:build_package",
]);
const writeApi = /(?:std::)?fs::write|File::create/;
for (const path of desktopFiles) {
  const file = rel(path);
  const lines = splitLines(read(path));
  lines.forEach((line, at) => {
    if (!writeApi.test(line) || line.trim().startsWith("//")) return;
    const entry = enclosingEntry(file, at);
    if (!entry) {
      failures.push(`${file}:${at + 1} 写盘调用不在任何函数内`);
      return;
    }
    if (commandEntries.has(entry.name)) {
      if (!diagCommands.includes(entry.name) || release.has(entry.name)) {
        failures.push(`${file}:${at + 1} 写盘调用位于非诊断或以 release 形态存在的命令 fn ${entry.name}`);
      }
      return;
    }
    if (!entry.debugOnly && !statementGated(lines, at) && !USER_EXPORT_FNS.has(`${file}:${entry.name}`)) {
      failures.push(`${file}:${at + 1} 写盘调用所在 fn ${entry.name} 未被 cfg(debug_assertions) 覆盖`);
    }
  });
}

/** 字面量逐个位置：每一处出现都必须在 cfg(debug_assertions) 覆盖的代码内。 */
const literals = [...markerNames];
for (const symbol of literals) {
  for (const path of scanFiles) {
    const file = rel(path);
    const lines = splitLines(read(path));
    lines.forEach((line, at) => {
      if (!line.includes(symbol) || line.trim().startsWith("//")) return;
      if (statementGated(lines, at)) return;
      const entry = enclosingEntry(file, at);
      if (!entry) {
        failures.push(`${file}:${at + 1} ${symbol} 不在任何函数内`);
        return;
      }
      if (!entry.debugOnly) {
        failures.push(`${file}:${at + 1} ${symbol} 所在 fn ${entry.name} 未覆盖 #[cfg(debug_assertions)]`);
      }
    });
  }
}

/** 语句级 cfg：命中行上方几条内出现 #[cfg(debug_assertions)]（中间只隔注释/属性/空行）。 */
function statementGated(lines, at) {
  for (let i = at - 1; i >= Math.max(0, at - 4); i -= 1) {
    const text = lines[i].trim();
    if (!text || text.startsWith("//")) continue;
    if (text.includes("#[cfg(debug_assertions)]")) return true;
    if (text.startsWith("#[")) continue;
    return false;
  }
  return false;
}

/** W-63：导出分支注入只允许出现在 `import.meta.env.DEV` 守卫内；键名集中在 src/lib/diagExport.ts。 */
const exportLib = read(join(rootPath, "src/lib/diagExport.ts"));
const EXPORT_KEY = "aka.diag.export";
const GUARD = "if (import.meta.env.DEV) {";
const guardPositions = [];
for (let at = exportLib.indexOf(GUARD); at >= 0; at = exportLib.indexOf(GUARD, at + 1)) guardPositions.push(at);
const keyPositions = [];
for (let at = exportLib.indexOf(EXPORT_KEY); at >= 0; at = exportLib.indexOf(EXPORT_KEY, at + 1)) keyPositions.push(at);
const guarded = (pos) => guardPositions.some((start) => pos > start && pos - start <= 300);
if (guardPositions.length < 1) failures.push("diagExport.ts 缺 import.meta.env.DEV 守卫（W-63）");
if (keyPositions.length !== guardPositions.length || !keyPositions.every(guarded)) {
  failures.push(`导出注入键 ${EXPORT_KEY} 存在不在 DEV 守卫内的出现（W-63）`);
}
for (const file of ["src/components/Watchlist.tsx", "src/features/watchlist/watchlistDiag.ts"]) {
  if (read(join(rootPath, file)).includes(EXPORT_KEY)) {
    failures.push(`${file} 直接使用了 ${EXPORT_KEY}，应走 src/lib/diagExport.ts（W-63）`);
  }
}

if (failures.length > 0) {
  for (const message of failures) console.error(`::error::诊断入口源码层门禁失败：${message}`);
  process.exit(1);
}

/** 产物符号：诊断命令名 + 诊断字面量；子串扣减也由脚本算好，CI 不再维护名字表。 */
const symbols = [...diagCommands, ...literals].sort().map((symbol) => {
  const longer = [...diagCommands, ...literals].filter((other) => other !== symbol && other.includes(symbol));
  return `${symbol}\t${longer.join(",")}`;
});

if (process.argv.includes("--emit-symbols")) {
  process.stdout.write(`${symbols.join("\n")}\n`);
  process.exit(0);
}

console.log(
  `诊断入口源码层门禁通过：命令全集 ${commandEntries.size} 个（debug ${debug.size} / release ${release.size}，差 ${debug.size - release.size}），` +
    `诊断命令 ${diagCommands.join(" / ")}；release ∩ 诊断 = ∅；` +
    `${literals.length} 个诊断字面量全部位于 cfg 覆盖代码内；写盘调用仅存于诊断/cfg(debug) 路径。`,
);
