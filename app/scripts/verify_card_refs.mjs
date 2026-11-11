#!/usr/bin/env node
/**
 * 卡面引用校验（发卡前门禁）。
 *
 * 从 Story 卡 Markdown 的反引号片段里提取三类引用，全部按仓库实际状态核对，
 * 不维护任何名字白名单：
 *   1. 文件路径：按仓库根解析；支持 `path#L12-L34`、`path:12-34`；
 *      解析顺序为 仓库根 → 卡面目录 → 路径段后缀 → 仓库内同名文件。
 *   2. 符号：在 app/ 源码中查定义（fn/struct/enum/trait/type/const/static/class/interface/...）；
 *      未定义但被源码或 TypeScript 自带 lib.d.ts 引用过的，视为外部依赖/平台符号放行。
 *   3. npm 脚本：`npm run <name>` 必须在 app/package.json 的 scripts 中存在。
 *
 * 两类引用（卡面用显式标记区分，不做名单豁免）：
 *   现存引用（不带标记）：文件/符号/脚本必须真实存在，否则判红。
 *   待新增交付物（`[新增] path` 或 `[新增]` 紧邻反引号）：脚本放行，
 *     但要求同一张卡的「Task 拆解（Dev）」里有对应创建项；对不上仍判红。
 *
 * 判定分类（脚本自动计数，不靠人工分组）：
 *   真错       仓库内不存在，且没有 [新增] 标记
 *   计划新增   [新增] 标记的交付物（Task 拆解配对则放行，未配对判红）
 *   跨分支     当前 --root 不存在，但在任一 --ref-root（其他 worktree/分支）存在
 *   命名不一致 名字写法不同但可解析到同一目标（-/_、:/- 等）
 *
 * 用法：
 *   node scripts/verify_card_refs.mjs                       # 扫 <repo>/docs/story-cards/*-v1.0.md
 *   node scripts/verify_card_refs.mjs --root <repo>         # 指定待校验仓库
 *   node scripts/verify_card_refs.mjs --root <repo> --ref-root <other-repo>
 *                                                          # 跨分支复核（可重复）
 *   node scripts/verify_card_refs.mjs --cards <dir>         # 指定卡面目录（扫 *-v1.0.md）
 *   node scripts/verify_card_refs.mjs <card.md> [...]       # 指定卡面文件
 *
 * 退出码：0 无致命项；1 有致命项；2 运行前提缺失（卡面目录 / package.json）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, "../..");
const DEFAULT_CARD_DIR = "docs/story-cards";
const DEFAULT_CARD_GLOB = "-v1.0.md";

const CATEGORIES = ["真错", "计划新增", "跨分支", "命名不一致"];
const CREATION_RE = /(新建|新增|创建|补建|添加|追加|加)/;

const SOURCE_EXTS = new Set([".rs", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const PATH_EXTS = new Set([
  ".rs", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".md", ".csv", ".yml", ".yaml", ".toml",
  ".css", ".scss", ".html", ".sh", ".sql", ".txt",
]);
const SKIP_DIRS = new Set([
  ".git", "node_modules", "target", "dist", "build", "coverage",
  ".next", ".turbo", ".cache", "bench",
]);

function parseArgs(argv) {
  const opts = { root: DEFAULT_ROOT, cardDir: null, files: [], refRoots: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      opts.root = resolve(argv[(i += 1)]);
    } else if (arg === "--ref-root") {
      opts.refRoots.push(resolve(argv[(i += 1)]));
    } else if (arg === "--cards") {
      opts.cardDir = resolve(argv[(i += 1)]);
    } else if (arg.startsWith("--")) {
      console.error(`::error::verify:card-refs 未知参数：${arg}`);
      process.exit(2);
    } else {
      opts.files.push(resolve(arg));
    }
  }
  return opts;
}

function listCards(opts) {
  if (opts.files.length > 0) return opts.files;
  const dir = opts.cardDir ?? join(opts.root, DEFAULT_CARD_DIR);
  if (!existsSync(dir)) return { dir, cards: [] };
  const cards = readdirSync(dir)
    .filter((name) => name.endsWith(DEFAULT_CARD_GLOB))
    .sort()
    .map((name) => join(dir, name));
  return { dir, cards };
}

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walkFiles(path, out);
    else if (SOURCE_EXTS.has(extname(name).toLowerCase())) out.push(path);
  }
  return out;
}

function walkAllFiles(dir, out = [], dirs = []) {
  if (!existsSync(dir)) return { files: out, dirs };
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      dirs.push(path);
      walkAllFiles(path, out, dirs);
    } else {
      out.push(path);
    }
  }
  return { files: out, dirs };
}

/**
 * 源码索引：定义集合 + 出现过的标识符集合。
 * 「定义」用于正面命中；「出现过」用于放行外部依赖符号，二者都从仓库实际代码派生。
 * 平台符号（Intl / NumberFormat / MediaQueryListEvent 等）来自 TypeScript 自带的 lib.d.ts，
 * 优先取待校验仓库的 node_modules，其次取脚本所在仓库，仍然不是名字白名单。
 */
function buildSourceIndex(root) {
  const files = walkFiles(join(root, "app"));
  const identifiers = new Set();
  const defined = new Set();
  const declRe =
    /\b(?:fn|struct|enum|trait|type|const|static|class|interface|function|def|macro_rules!)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) identifiers.add(match[0]);
    for (const match of source.matchAll(declRe)) defined.add(match[1]);
  }

  let platformLibs = 0;
  const libDirs = [];
  for (const base of [root, DEFAULT_ROOT]) {
    const dir = join(base, "app/node_modules/typescript/lib");
    if (existsSync(dir) && !libDirs.includes(dir)) libDirs.push(dir);
  }
  for (const dir of libDirs) {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("lib.") || !name.endsWith(".d.ts")) continue;
      const source = readFileSync(join(dir, name), "utf8");
      for (const match of source.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) identifiers.add(match[0]);
      platformLibs += 1;
    }
  }

  return { fileCount: files.length, identifiers, defined, platformLibs };
}

function readScripts(root) {
  const file = join(root, "app/package.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")).scripts ?? {};
}

/** 一个仓库的事实来源：源码索引、npm scripts、文件树。 */
function makeFacts(root, { requirePackage = false } = {}) {
  const scripts = readScripts(root);
  if (requirePackage && scripts === null) {
    console.error(`::error::verify:card-refs 缺少 ${join(root, "app/package.json")}`);
    process.exit(2);
  }
  let treeCache = null;
  return {
    root,
    scripts: scripts ?? {},
    index: buildSourceIndex(root),
    tree: () => {
      if (treeCache === null) treeCache = walkAllFiles(root);
      return treeCache;
    },
  };
}

/** 解析 `path#L12-L34` / `path:12-34` / 裸路径；不是路径返回 null。 */
function parsePathRef(span) {
  if (span.includes("://")) return null;
  if (/[\s*<>{}()[\]"',;|+=?!@$~]/.test(span)) return null;
  if (span.includes("::")) return null;

  let base = span;
  let lineStart = null;
  let lineEnd = null;
  let match = span.match(/^(.*?)#L(\d+)(?:-L?(\d+))?$/);
  if (!match) match = span.match(/^(.*?):(\d+)(?:-(\d+))?$/);
  if (match) {
    base = match[1];
    lineStart = Number(match[2]);
    lineEnd = match[3] ? Number(match[3]) : lineStart;
  }

  if (!/^[A-Za-z0-9_./-]+$/.test(base)) return null;
  const isDir = base.endsWith("/");
  const ext = isDir ? "" : extname(base).toLowerCase();
  if (isDir) {
    if (!base.includes("/")) return null;
  } else if (!PATH_EXTS.has(ext)) {
    return null;
  }
  return {
    raw: span,
    base: isDir ? base.replace(/\/+$/, "") : base,
    isDir,
    lineStart,
    lineEnd,
  };
}

function resolvePathRef(ref, cardFile, facts, { allowCardDir = false } = {}) {
  const roots = allowCardDir ? [facts.root, dirname(cardFile)] : [facts.root];
  for (const rootDir of roots) {
    const candidate = resolve(rootDir, ref.base);
    if (existsSync(candidate)) return { path: candidate, exact: true };
  }
  const pool = ref.isDir ? facts.tree().dirs : facts.tree().files;
  if (ref.base.includes("/")) {
    // 卡面常用 app/src/ 之类前缀省略写法；按路径段边界做后缀匹配。
    const suffix = `/${ref.base}`;
    const hits = pool.filter((entry) => entry.endsWith(suffix));
    if (hits.length > 0) return { path: hits[0], exact: hits.length === 1 };
  } else {
    const hits = pool.filter((entry) => basename(entry) === ref.base);
    if (hits.length > 0) return { path: hits[0], exact: hits.length === 1 };
  }
  return null;
}

/** 从代码片段提取符号候选：声明名、限定路径末段、PascalCase 类型、小写函数调用。 */
function symbolCandidates(span) {
  const code = span
    .replace(/"[^"]*"|'[^']*'/g, " ")
    .replace(/\{[^{}]*\}/g, " ")
    .replace(/`/g, " ");
  const names = new Set();
  for (const match of code.matchAll(
    /\b(?:fn|struct|enum|trait|type|const|static|class|interface|function|def)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  )) {
    names.add(match[1]);
  }
  for (const match of code.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)+\b/g)) {
    const segments = match[0].split("::");
    names.add(segments[segments.length - 1]);
  }
  for (const match of code.matchAll(/\b[A-Z][A-Za-z0-9_]{2,}\b/g)) {
    if (/^[A-Z0-9_]+$/.test(match[0])) continue; // E_XXX / T01 / MACD 这类全大写标识与 wire 串，不作符号
    names.add(match[0]);
  }
  for (const match of code.matchAll(/\b([a-z_][A-Za-z0-9_]*)\(/g)) {
    names.add(match[1]);
  }
  return [...names];
}

/** 名字归一：忽略大小写与 -/_ 差异，用于识别「同一目标、不同写法」。 */
function normalizeName(name) {
  return name.toLowerCase().replace(/[-_]/g, "");
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function symbolExists(name, facts) {
  return facts.index.defined.has(name) || facts.index.identifiers.has(name);
}

function findPathVariant(ref, facts) {
  const want = normalizeName(basename(ref.base));
  if (!want) return null;
  const pool = ref.isDir ? facts.tree().dirs : facts.tree().files;
  const hits = pool.filter((entry) => normalizeName(basename(entry)) === want);
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.length - b.length);
  return relative(facts.root, hits[0]);
}

function findSymbolVariant(name, facts) {
  const want = normalizeName(name);
  for (const defined of facts.index.defined) {
    if (normalizeName(defined) === want) return defined;
  }
  return null;
}

function findScriptVariant(name, facts) {
  const stems = [name.replace(/:/g, "-"), name.replace(/:/g, "_")];
  for (const stem of stems) {
    for (const ext of [".mjs", ".js"]) {
      const rel = `app/scripts/${stem}${ext}`;
      if (!existsSync(join(facts.root, rel))) continue;
      const actualKey = Object.keys(facts.scripts).find((key) => facts.scripts[key].includes(`${stem}${ext}`));
      return { file: rel, actualKey };
    }
  }
  const want = normalizeName(name);
  for (const key of Object.keys(facts.scripts)) {
    if (normalizeName(key) === want) return { key };
  }
  return null;
}

/** 解析每张卡「Task 拆解（Dev）」里的条目，按卡号归档。 */
function parseTaskItems(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const taskItems = new Map();
  let cardId = "(Epic 级)";
  let inTask = false;
  for (const line of lines) {
    const heading = line.match(/^#{2,4}\s+(S-[A-Z0-9]+(?:-\d+)+)/);
    if (heading) cardId = heading[1];
    if (/^\*\*Task 拆解/.test(line.trim())) {
      inTask = true;
      continue;
    }
    if (inTask && (/^\*\*/.test(line.trim()) || /^---+$/.test(line.trim()) || /^#{2,4}\s/.test(line))) {
      inTask = false;
    }
    if (inTask && /^\s*(?:\d+\.|[-*])\s+/.test(line)) {
      if (!taskItems.has(cardId)) taskItems.set(cardId, []);
      taskItems.get(cardId).push(line.trim());
    }
  }
  return taskItems;
}

function hasCreationTask(taskItems, cardId, kind, needle) {
  const items = taskItems.get(cardId) ?? [];
  return items.some((item) => {
    if (!CREATION_RE.test(item)) return false;
    if (kind === "path") return item.includes(needle);
    if (kind === "script") {
      return (
        item.includes(`"${needle}"`) ||
        item.includes(`\`${needle}\``) ||
        item.includes(`npm run ${needle}`)
      );
    }
    return new RegExp(`\\b${escapeRegExp(needle)}\\b`).test(item);
  });
}

/**
 * 对主仓不存在的引用做归类。
 * 优先级：计划新增（显式标记）→ 跨分支（ref-root 命中）→ 命名不一致 → 真错。
 */
function classifyMissing({ kind, raw, ref, cardId, planned, taskItems, facts, refFacts }) {
  if (planned) {
    // Epic 级概述不是可分派的卡，没有「同卡 Task 拆解」；配对校验只在 S-* 卡内生效。
    if (cardId === "(Epic 级)") {
      return {
        category: "计划新增",
        fatal: false,
        detail: "[新增] 标记在 Epic 级概述，不适用同卡 Task 拆解配对",
      };
    }
    const needle = kind === "path" ? basename(ref.base) : raw;
    const paired = hasCreationTask(taskItems, cardId, kind, needle);
    return {
      category: "计划新增",
      fatal: !paired,
      detail: paired
        ? "[新增] 已标记，Task 拆解（Dev）有对应创建项，放行"
        : "[新增] 已标记，但 Task 拆解（Dev）无对应创建项",
    };
  }

  for (const other of refFacts) {
    if (kind === "path") {
      const hit = resolvePathRef(ref, null, other);
      if (hit) return { category: "跨分支", fatal: false, detail: `在 --ref-root ${other.root} 中存在：${relative(other.root, hit.path)}` };
    } else if (kind === "symbol" && symbolExists(raw, other)) {
      return { category: "跨分支", fatal: false, detail: `在 --ref-root ${other.root} 源码中存在` };
    } else if (kind === "script" && raw in other.scripts) {
      return { category: "跨分支", fatal: false, detail: `在 --ref-root ${other.root} 的 scripts 中存在` };
    }
  }

  if (kind === "path") {
    const variant = findPathVariant(ref, facts);
    if (variant) return { category: "命名不一致", fatal: true, detail: `仓库内存在同形异名文件：${variant}` };
  } else if (kind === "symbol") {
    const variant = findSymbolVariant(raw, facts);
    if (variant) return { category: "命名不一致", fatal: true, detail: `仓库内有同形异名定义：${variant}` };
  } else if (kind === "script") {
    const variant = findScriptVariant(raw, facts);
    if (variant?.actualKey) {
      return { category: "命名不一致", fatal: true, detail: `${variant.file} 存在，实际 npm key 为 ${variant.actualKey}` };
    }
    if (variant?.file) {
      return { category: "命名不一致", fatal: true, detail: `脚本文件存在但未注册 npm key：${variant.file}` };
    }
    if (variant?.key) {
      return { category: "命名不一致", fatal: true, detail: `实际 npm key 为 ${variant.key}` };
    }
  }

  const needle = kind === "path" ? basename(ref.base) : raw;
  const paired = hasCreationTask(taskItems, cardId, kind, needle);
  const reason =
    kind === "path"
      ? "文件不存在（仓库根 / 卡面目录 / 路径后缀均未命中）"
      : kind === "symbol"
        ? "源码内既无定义也无引用"
        : "app/package.json 无该 scripts 键";
  const hint = paired
    ? "未标 [新增]，但 Task 拆解（Dev）已有对应创建项（补标记即可）"
    : "未标 [新增]，且 Task 拆解（Dev）无对应创建项";
  return { category: "真错", fatal: true, detail: `${reason}；${hint}` };
}

function scanCard(file, ctx) {
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");
  const reds = [];
  const checked = { path: 0, symbol: 0, script: 0 };
  const seen = new Set();
  const taskItems = parseTaskItems(file);
  let cardId = "(Epic 级)";
  let inFence = false;

  const record = (kind, raw, lineNo, ref = null, planned = false) => {
    const key = `${cardId}|${kind}|${raw}`;
    if (seen.has(key)) return;
    seen.add(key);
    const verdict = classifyMissing({
      kind,
      raw,
      ref,
      cardId,
      planned,
      taskItems,
      facts: ctx.facts,
      refFacts: ctx.refFacts,
    });
    reds.push({ cardId, line: lineNo, kind, raw, ...verdict });
  };

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (!inFence) {
      const heading = line.match(/^#{2,4}\s+(S-[A-Z0-9]+(?:-\d+)+)/);
      if (heading) cardId = heading[1];
    }

    // npm 脚本：正文与代码块里都可能出现，整行扫。
    for (const match of line.matchAll(/npm run\s+([A-Za-z0-9][A-Za-z0-9:_-]*)/g)) {
      const name = match[1];
      // `grep -c 'npm run verify:'` 这类复算命令里的前缀不是脚本名。
      if (name.endsWith(":")) continue;
      checked.script += 1;
      if (name in ctx.facts.scripts) continue;
      const planned = /\[新增\]/.test(line.slice(0, match.index));
      record("script", name, lineNo, null, planned);
    }

    if (inFence) return;

    // 整行否定语义：「全仓零定义」「不存在」「无子目录」等是在排除引用，不是预言存在。
    const lineNegated = /(零定义|不存在|无此|无子目录|不得引用|不得出现|不含|不引入|被否|否决)/.test(line);

    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      const rawSpan = match[1].trim();
      if (!rawSpan) continue;

      const before = line.slice(0, match.index);
      const prefix = before.replace(/[*_\s]+$/g, "");
      const negated = lineNegated || /(不存在|没有|不引入|不做|无)$/.test(prefix);
      if (negated) continue;

      // 显式标记：`[新增] path` 或 [新增] 紧邻反引号。
      let planned = /\[新增\][\s*]*$/.test(before);
      let span = rawSpan;
      if (span.startsWith("[新增]")) {
        planned = true;
        span = span.slice("[新增]".length).trim();
      }
      if (!span) continue;

      const pathRef = parsePathRef(span);
      if (pathRef) {
        checked.path += 1;
        const resolved = resolvePathRef(pathRef, file, ctx.facts, { allowCardDir: true });
        if (!resolved) {
          record("path", pathRef.raw, lineNo, pathRef, planned);
          continue;
        }
        // 同名兜底命中时无法确定引用的是哪一个文件，行号无从核对，跳过。
        if (pathRef.lineStart != null && resolved.exact) {
          const total = readFileSync(resolved.path, "utf8").split("\n").length;
          if (pathRef.lineEnd > total) {
            const key = `${cardId}|line|${pathRef.raw}`;
            if (!seen.has(key)) {
              seen.add(key);
              reds.push({
                cardId,
                line: lineNo,
                kind: "行号",
                raw: pathRef.raw,
                category: "真错",
                fatal: true,
                detail: `行号越界：文件共 ${total} 行（引用 ${pathRef.lineStart}-${pathRef.lineEnd}）`,
              });
            }
          }
        }
        continue;
      }

      // [新增] 的裸标识符（如 `[新增] normalize_params`）直接当符号候选。
      const names = new Set(symbolCandidates(span));
      if (planned && /^[A-Za-z_][A-Za-z0-9_]*$/.test(span)) names.add(span);
      for (const name of names) {
        if (name.length < 3) continue;
        checked.symbol += 1;
        if (symbolExists(name, ctx.facts)) continue;
        record("symbol", name, lineNo, null, planned);
      }
    }
  });

  return { reds, checked };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const listed = listCards(opts);
  const cards = Array.isArray(listed) ? listed : listed.cards;

  if (cards.length === 0) {
    console.log(
      `verify:card-refs 跳过：${opts.cardDir ?? join(opts.root, DEFAULT_CARD_DIR)} 下没有 *${DEFAULT_CARD_GLOB} 卡面`,
    );
    return;
  }

  const facts = makeFacts(opts.root, { requirePackage: true });
  const refFacts = [];
  for (const refRoot of opts.refRoots) {
    if (refRoot === opts.root) continue;
    if (!existsSync(refRoot)) {
      console.error(`::warning::verify:card-refs --ref-root 不存在，已忽略：${refRoot}`);
      continue;
    }
    refFacts.push(makeFacts(refRoot));
  }

  const ctx = { facts, refFacts };
  const checked = { path: 0, symbol: 0, script: 0 };
  const findings = [];
  for (const card of cards) {
    const result = scanCard(card, ctx);
    checked.path += result.checked.path;
    checked.symbol += result.checked.symbol;
    checked.script += result.checked.script;
    findings.push(...result.reds.map((item) => ({ ...item, file: card })));
  }

  console.log(`verify:card-refs root=${opts.root}`);
  for (const ref of refFacts) console.log(`verify:card-refs ref-root=${ref.root}`);
  console.log(
    `扫描 ${cards.length} 张卡（app/ 源码 ${facts.index.fileCount} 个文件，平台 lib ${facts.index.platformLibs} 个）`,
  );
  console.log(
    `引用总数：路径 ${checked.path} / 符号 ${checked.symbol} / 脚本 ${checked.script}`,
  );

  if (findings.length === 0) {
    console.log("verify:card-refs 通过：所有路径、符号与 npm 脚本均可在仓库内解析");
    return;
  }

  const byFile = new Map();
  for (const item of findings) {
    if (!byFile.has(item.file)) byFile.set(item.file, []);
    byFile.get(item.file).push(item);
  }
  for (const [file, items] of byFile) {
    console.error(`\n${file}`);
    for (const item of items) {
      const mark = item.fatal ? "判红" : "放行";
      console.error(
        `  ${item.cardId} · L${item.line} · ${item.kind} \`${item.raw}\` → [${item.category}·${mark}] ${item.detail}`,
      );
      if (item.fatal) {
        console.error(
          `::error file=${file},line=${item.line}::${item.cardId} ${item.kind} \`${item.raw}\` [${item.category}] ${item.detail}`,
        );
      }
    }
  }

  const total = findings.length;
  const counts = Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
  let fatal = 0;
  for (const item of findings) {
    counts[item.category] += 1;
    if (item.fatal) fatal += 1;
  }
  console.error(
    `\n判定分类（共 ${total} 项）：${CATEGORIES.map((category) => `${category} ${counts[category]}/${total}`).join(" · ")}`,
  );
  const unmatchedPlanned = findings.filter((item) => item.category === "计划新增" && item.fatal).length;
  console.error(
    `致命项：${fatal}/${total}（真错 ${counts["真错"]} + 命名不一致 ${counts["命名不一致"]} + 计划新增未配对 ${unmatchedPlanned}）`,
  );

  if (fatal === 0) {
    console.log("verify:card-refs 通过：无致命项（跨分支与已配对 [新增] 不计红）");
    return;
  }
  console.error(`\nverify:card-refs 失败：致命 ${fatal} 项 / 判定 ${total} 项`);
  process.exitCode = 1;
}

main();
