/**
 * 证据归属门禁（W-60 / W-67 / W-68 / W-69 / W-70 / W-71）
 *
 * W-71 追加断言：
 *   - 删除 EXCLUDED_DIRS：证据根只允许平铺，出现子目录即红（「跳过」本身可判红）。
 *     归档/诊断数据一律放 docs/qa/raw/。
 *   - 补号只认全角 `（补n）`；半角 `(补n)` 专门报「请改全角」，不做双兼容。
 *   - 基号 AC 的定义行全卡面只能 1 处（其余出现处写「依赖」）。
 *   - 补号定义行必须满足：基号有定义行，且补号与基号同卡（跨卡/基条缺失都红）。
 *
 * W-70 追加断言：
 *   - 同一文件内 check `id` 必须唯一（堵「复制一条已过 check 抬总数」）。
 *   - 扩展名大小写不敏感：`.JSON` 同样按证据解析；非 JSON 附件只允许
 *     EXPLICIT_AUX_EXTENSIONS 里显式声明的类型，其余文件一律失败。
 *   - 白名单只缩不扩：LEGACY_MAX_FILES=18，超出即红；每条必须有
 *     `expiresOn` 且 ≤ LEGACY_DEADLINE。
 *
 * 断言：
 *   1. 归属闭合：set(checks.card) 必须等于 {result.card} ∪ otherCards[].card；
 *      多一张未声明的卡、少一张已声明的卡，都失败。
 *   2. 逐卡现算：result.layers 与每条 otherCards[].layers（必填）都由 checks
 *      按 card+layer 现算比对；声明分母合计 != checks.length 直接失败。
 *   3. 旧格式冻结：文件集 + sha256 硬编码在脚本常量 LEGACY_WHITELIST_FILE_SHA256
 *      锁定的 JSON 里；JSON 被改动（摘要不符）则整份白名单失效。
 *      截止日 LEGACY_DEADLINE 是脚本常量，判定以 CI 运行时钟为准；
 *      本地改钟不算通过，也不得据此改判。截止后冻结条一律失败。
 *   4. 坏 JSON：证据目录下任何非 meta 的 *.json，`checks` 不是对象数组即失败，
 *      不许静默跳过。
 *   5. 字段受控：`id` / `card` 必须为非空字符串；`passed` 必须为布尔
 *      （"false" 不算通过）；`layer` 必须 ∈ data|render|runtime。
 *   6. ac 整 token：`AC-xx.xx-xx（补n）` 必须命中该卡卡段内的同名 token；
 *      `卡id·标题` 必须卡 id 等于 check.card，且命中 `卡面锚点：` 行的锚点
 *      （或标题行逐字等于 ac）；其余形态（前缀、随手写、正文提及）一律失败。
 *
 * 用法：node scripts/verify_evidence.mjs [--dir=证据目录]（--dir 仅供负例自测）
 * 退出码：0 = 通过；1 = 任一断言失败。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const CARD_DOC = path.join(ROOT, "docs", "story-cards", "aka-story-cards-v0.1.md");
const WHITELIST_PATH = path.join(HERE, "evidence-legacy-whitelist.json");

// —— W-69 / W-70 白名单三要素（脚本内硬编码，不许由被校验的数据自证）——
// 截止日：以 CI 运行时钟为准；本地改钟不算通过，也不得据此改判。
const LEGACY_DEADLINE = "2026-11-22";
// 只缩不扩的棘轮：前两轮教训是「靠有人会看」的约束都没被看住；
// 新增冻结项必须付出「减一份或改本常量」的显式代价。
const LEGACY_MAX_FILES = 18;
// 冻结白名单 JSON 的 sha256：改动该 JSON 必须同步改本常量并单独过审。
const LEGACY_WHITELIST_FILE_SHA256 =
  "d3152a90cd9757b3db806e1a8a89db45bcf9b28387a95d3940f331f158c77cfe";
// 层名受控，防自建层（缺字段 / "undefined" / "runtime2" 一律红）。
const ALLOWED_LAYERS = new Set(["data", "render", "runtime"]);
const AC_TOKEN_RE = /^AC-\d{2}\.\d{2}-\d{2}(（补\d+）)?$/;
// W-71：卡面 `（补n）` 是唯一标准，半角一律红；两种写法会让 grep、覆盖矩阵、证据核对各漏一次。
const HALF_WIDTH_SUPPLEMENT_RE = /^AC-\d{2}\.\d{2}-\d{2}\(补\d+\)$/;
const ANCHOR_RE = /^S-\d{2}\.\d{2}-\d{2}·.+$/;
// 基号 AC 的定义行（`- **AC-xx.xx-xx**｜...`）全卡面只能 1 处；其余出现处写「依赖」。
const AC_DEFINITION_RE = /^[-*]\s+\*\*(AC-\d{2}\.\d{2}-\d{2})\*\*｜/;
// 补号定义行（`- **AC-xx.xx-xx（补n）**｜...`）：基号必须有定义行，且补号与基号同卡。
const AC_SUPPLEMENT_DEFINITION_RE = /^[-*]\s+\*\*(AC-\d{2}\.\d{2}-\d{2}（补\d+）)\*\*｜/;

// 非 JSON 文件名按显式声明放行（仍然打印 WARN），未声明的类型一律红。
const EXPLICIT_AUX_EXTENSIONS = new Set([".txt", ".jsonl", ".log"]);

const argv = process.argv.slice(2);
const dirArg = argv.find((item) => item.startsWith("--dir="));
// 证据根由 scripts/evidence-layout.json 单一提供（制度第 27 条）：写入方与校验方不得各写一份。
const LAYOUT_PATH = path.join(HERE, "evidence-layout.json");
function layoutDir(key) {
  try {
    const layout = JSON.parse(fs.readFileSync(LAYOUT_PATH, "utf8"));
    if (typeof layout[key] === "string" && layout[key]) return path.resolve(ROOT, layout[key]);
  } catch {
    // fallthrough 到报错
  }
  console.error(`::error::${path.relative(ROOT, LAYOUT_PATH)} 缺失或无法解析（第 27 条路径常量真源）`);
  process.exit(2);
}
const EVIDENCE_DIR = dirArg
  ? path.resolve(dirArg.slice("--dir=".length))
  : layoutDir("evidenceRoot");
// 归档根同源读取：子目录报错文案与归档路径断言都不得再硬编码 docs/qa/raw。
const ARCHIVE_REL = path
  .relative(ROOT, layoutDir("archiveRoot"))
  .split(path.sep)
  .join("/");
// R-EV-02：s2 dump 的 schema 键（缺键说明是旧构建产物，不许静默通过）。
const S2_SCHEMA_KEYS = [
  "build",
  "dataset",
  "engine",
  "debounce",
  "cold",
  "warm",
  "batchCompute",
  "timeframes",
  "verification",
  "telemetry",
];

const failures = [];
const warnings = [];
const focusNotes = [];

const cardText = fs.readFileSync(CARD_DOC, "utf8");
const HEADING = /^#{2,4}\s+(S-\d{2}\.\d{2}-\d{2})/gm;
const heads = [...cardText.matchAll(HEADING)];
const CARD_SET = new Set();
const CARD_SECTION = new Map();
const CARD_AC_TOKENS = new Map();
heads.forEach((match, index) => {
  const start = match.index;
  const end = index + 1 < heads.length ? heads[index + 1].index : cardText.length;
  const section = cardText.slice(start, end);
  CARD_SET.add(match[1]);
  CARD_SECTION.set(match[1], section);
  CARD_AC_TOKENS.set(
    match[1],
    new Set((section.match(/AC-\d{2}\.\d{2}-\d{2}(（补\d+）)?/g) ?? []).map((item) => item)),
  );
});

if (CARD_SET.size === 0) {
  console.error(`未能从 ${path.relative(ROOT, CARD_DOC)} 解析出任何卡片 id`);
  process.exit(1);
}

// W-71：基号 AC 的定义行全卡面唯一（其余出现处只能写「依赖」）；
// 补号定义行必须满足「基号有定义行」且「补号与基号同卡」。
const definitionCards = new Map();
for (const [cardId, section] of CARD_SECTION) {
  for (const rawLine of section.split("\n")) {
    const matched = AC_DEFINITION_RE.exec(rawLine.trim());
    if (!matched) continue;
    const list = definitionCards.get(matched[1]) ?? [];
    list.push(cardId);
    definitionCards.set(matched[1], list);
  }
}
for (const [token, cards] of definitionCards) {
  if (cards.length > 1) {
    failures.push(
      `${token}: 定义行出现 ${cards.length} 处（每个基号只能 1 处定义，其余出现处写「依赖」）`,
    );
  }
}
for (const [cardId, section] of CARD_SECTION) {
  for (const rawLine of section.split("\n")) {
    const matched = AC_SUPPLEMENT_DEFINITION_RE.exec(rawLine.trim());
    if (!matched) continue;
    const token = matched[1];
    const base = token.replace(/（补\d+）$/, "");
    const definitionOwners = definitionCards.get(base) ?? [];
    if (definitionOwners.length === 0) {
      failures.push(`${token}: 基号 ${base} 在全卡面无定义行（补号必须先有基条定义）`);
    } else if (!definitionOwners.includes(cardId)) {
      failures.push(
        `${token}: 补号定义在 ${cardId}，但 ${base} 的定义行在 ${definitionOwners.join("/")}` +
          `（补号必须与基号同卡）`,
      );
    }
  }
}

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const stable = (layers) =>
  JSON.stringify(Object.keys(layers).sort().map((key) => [key, layers[key]]));

// 旧格式冻结：白名单 JSON 必须与脚本常量摘要一致才可信。
let freezeMap = {};
let whitelistUsable = false;
try {
  const raw = fs.readFileSync(WHITELIST_PATH);
  const digest = crypto.createHash("sha256").update(raw).digest("hex");
  if (digest !== LEGACY_WHITELIST_FILE_SHA256) {
    failures.push(
      `${path.relative(ROOT, WHITELIST_PATH)}: sha256=${digest} != 脚本常量 ` +
        `${LEGACY_WHITELIST_FILE_SHA256}（白名单被改动，全部冻结条目失效；` +
        `改白名单必须改脚本并单独过审）`,
    );
  } else {
    const parsed = JSON.parse(raw.toString("utf8"));
    const entries = Object.entries(parsed.files ?? {});
    let entriesValid = true;
    if (entries.length > LEGACY_MAX_FILES) {
      failures.push(
        `白名单条目 ${entries.length} > LEGACY_MAX_FILES=${LEGACY_MAX_FILES}（只缩不扩：新增冻结项必须减一份或改脚本常量）`,
      );
      entriesValid = false;
    }
    for (const [name, entry] of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        failures.push(`${name}: 白名单条目必须是 {sha256, expiresOn} 对象，旧版裸 hash 不再接受`);
        entriesValid = false;
        continue;
      }
      if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
        failures.push(`${name}: 白名单条目缺合法 sha256`);
        entriesValid = false;
      }
      if (typeof entry.expiresOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expiresOn)) {
        failures.push(`${name}: 白名单条目缺 expiresOn（必填，YYYY-MM-DD）`);
        entriesValid = false;
      } else if (entry.expiresOn > LEGACY_DEADLINE) {
        failures.push(
          `${name}: expiresOn=${entry.expiresOn} 超过 LEGACY_DEADLINE=${LEGACY_DEADLINE}（不许续期）`,
        );
        entriesValid = false;
      }
    }
    if (entriesValid) {
      freezeMap = parsed.files ?? {};
      whitelistUsable = true;
    }
  }
} catch (error) {
  failures.push(`冻结白名单读取失败（${error.message}），旧格式一律不放行`);
}

const today = new Date().toISOString().slice(0, 10);
const legacyAllowed = today <= LEGACY_DEADLINE;

const countLayers = (list) => {
  const counted = {};
  for (const check of list) {
    if (!ALLOWED_LAYERS.has(check.layer)) continue;
    const hit = (counted[check.layer] ??= { passed: 0, total: 0 });
    hit.total += 1;
    if (check.passed === true) hit.passed += 1;
  }
  const out = {};
  for (const [layer, hit] of Object.entries(counted)) {
    out[layer] = `${hit.passed}/${hit.total}`;
  }
  return out;
};

const sumTotals = (layers) =>
  Object.values(layers ?? {}).reduce((acc, value) => {
    const [, total] = String(value).split("/");
    return acc + (Number(total) || 0);
  }, 0);

// 卡面锚点只认 `卡面锚点：` 整行的锚点 token（或标题行逐字等于 ac）；
// 正文里顺带写一句同名文字不算锚点。
const anchorLineMatches = (section, ac) => {
  for (const rawLine of section.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      if (heading[1].replace(/`/g, "").trim() === ac) return true;
      continue;
    }
    const normalized = line.replace(/^[-*]\s+/, "").replace(/`/g, "").trim();
    const matched = /^卡面锚点[:：]\s*(.*)$/.exec(normalized);
    if (!matched) continue;
    const anchor = matched[1].split(/[。，；;|]/)[0].trim();
    if (anchor === ac) return true;
  }
  return false;
};

let scanned = 0;
let frozen = 0;
const evidenceFiles = [];

// W-71：删除 EXCLUDED_DIRS。证据根只允许平铺；出现子目录即红——
// 「跳过」本身必须能被判红，否则把合法证据塞进被声明的目录仍是 exit 0。
// 归档/诊断数据一律放 docs/qa/raw/，证据目录不再有二级目录。
const walk = (dir) => {
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(EVIDENCE_DIR, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      failures.push(
        `${rel}: 证据根下出现子目录（跳过机制已删除；证据必须平铺，归档请移 ${ARCHIVE_REL}/）`,
      );
      continue;
    }
    if (!entry.isFile()) continue;
    if (/\.json$/i.test(entry.name)) {
      // 只认小写 `-meta.json` 为 meta；大写 `-META.JSON` 会按证据解析（宁可红）。
      if (/-meta\.json$/.test(entry.name)) continue;
      evidenceFiles.push({ full, rel });
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!EXPLICIT_AUX_EXTENSIONS.has(ext)) {
      failures.push(
        `${rel}: 不可识别的文件类型（只认 *.json；非 JSON 附件须在 EXPLICIT_AUX_EXTENSIONS 显式声明）`,
      );
    } else {
      warnings.push(`${rel}: 非证据附件（显式声明 ${ext}，不参与门禁）`);
    }
  }
};
walk(EVIDENCE_DIR);

for (const { full, rel } of evidenceFiles) {
  const file = rel;
  let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (error) {
    failures.push(`${file}: JSON 解析失败（${error.message}）`);
    continue;
  }

  // 旧格式冻结：白名单命中则按 hash 锁死，截止日后一律红。
  const freezeEntry = whitelistUsable ? freezeMap[path.basename(file)] : undefined;
  if (freezeEntry) {
    if (!legacyAllowed) {
      failures.push(`${file}: 旧格式白名单已于 ${LEGACY_DEADLINE} 截止（以 CI 时钟为准），必须迁移结构化归属`);
      continue;
    }
    if (sha256(full) !== freezeEntry.sha256) {
      failures.push(`${file}: 冻结白名单 hash 不符（文件被改动），旧格式不许借壳续命`);
      continue;
    }
    frozen += 1;
    warnings.push(`${file}: 旧格式冻结（白名单命中，expiresOn ${freezeEntry.expiresOn}）`);
    continue;
  }

  // 非冻结文件：坏 JSON 直接红，不许静默跳过。
  if (!Array.isArray(evidence.checks)) {
    failures.push(`${file}: checks 不是对象数组（坏 JSON 不许静默跳过）`);
    continue;
  }
  scanned += 1;

  let schemaBroken = false;
  const ids = new Set();
  for (const [index, check] of evidence.checks.entries()) {
    if (!check || typeof check !== "object" || Array.isArray(check)) {
      failures.push(`${file}: checks[${index}] 不是对象`);
      schemaBroken = true;
      continue;
    }
    const label = `${file}: check ${typeof check.id === "string" ? check.id : `[${index}]`}`;
    if (typeof check.id !== "string" || check.id.trim() === "") {
      failures.push(`${label} 的 id 必须为非空字符串`);
      schemaBroken = true;
    } else if (ids.has(check.id)) {
      failures.push(`${label} 的 id 在同一文件重复（不许复制已过 check 抬总数）`);
      schemaBroken = true;
    } else {
      ids.add(check.id);
    }
    if (typeof check.card !== "string" || check.card.trim() === "") {
      failures.push(`${label} 的 card 必须为非空字符串`);
      schemaBroken = true;
    } else if (!CARD_SET.has(check.card)) {
      failures.push(`${label} 的 card=${check.card} 不在卡集`);
      schemaBroken = true;
    }
    if (typeof check.passed !== "boolean") {
      failures.push(`${label} 的 passed=${JSON.stringify(check.passed)} 不是布尔（"false" 不算通过）`);
      schemaBroken = true;
    }
    if (typeof check.layer !== "string" || !ALLOWED_LAYERS.has(check.layer)) {
      failures.push(
        `${label} 的 layer=${JSON.stringify(check.layer)} 不在 data|render|runtime`,
      );
      schemaBroken = true;
    }
  }
  if (schemaBroken) continue;

  const missingCard = evidence.checks.filter((check) => !check.card);
  if (missingCard.length > 0) {
    failures.push(`${file}: ${missingCard.length} 条 check 缺 card 且不在冻结白名单`);
    continue;
  }

  // ac 口径：整 token 精确命中，不做子串。
  for (const check of evidence.checks) {
    const ac = typeof check.ac === "string" ? check.ac.trim() : "";
    if (!ac) {
      failures.push(`${file}: ${check.id} 缺 ac`);
      continue;
    }
    if (HALF_WIDTH_SUPPLEMENT_RE.test(ac)) {
      failures.push(
        `${file}: ${check.id} 的 ac=${ac} 用了半角括号，请改全角（卡面只认 AC-xx.xx-xx（补n））`,
      );
      continue;
    }
    if (AC_TOKEN_RE.test(ac)) {
      const tokens = CARD_AC_TOKENS.get(check.card) ?? new Set();
      if (!tokens.has(ac)) {
        failures.push(`${file}: ${check.id} 的 ac=${ac} 不是卡 ${check.card} 卡面内的整 AC token`);
      }
      continue;
    }
    if (ANCHOR_RE.test(ac)) {
      const prefix = /^S-\d{2}\.\d{2}-\d{2}/.exec(ac)[0];
      if (prefix !== check.card) {
        failures.push(`${file}: ${check.id} 的卡面锚点 ac=${ac} 卡 id 与 check.card=${check.card} 不一致`);
        continue;
      }
      if (!anchorLineMatches(CARD_SECTION.get(check.card) ?? "", ac)) {
        failures.push(
          `${file}: ${check.id} 的 ac=${ac} 未命中卡 ${check.card} 的「卡面锚点：」整行（正文提及不算）`,
        );
      }
      continue;
    }
    failures.push(`${file}: ${check.id} 的 ac=${JSON.stringify(ac)} 既非整 AC token 也非卡面锚点`);
  }

  const metaPath = full.replace(/\.json$/i, "-meta.json");
  if (!fs.existsSync(metaPath)) {
    failures.push(`${file}: 无 meta，无法闭合归属`);
    continue;
  }
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch (error) {
    failures.push(`${file}-meta: JSON 解析失败（${error.message}）`);
    continue;
  }
  // R-EV-02 运行层五项 + dump 完整性 + 聚焦可判定性。
  // 只对新格式（evidence-run.sh 统一入口产物，meta.reproduce 非空）生效：
  // 旧证据没有被改写的义务，但新证据缺一项就必须 failed，不许「大概跑完了」。
  if (typeof meta.reproduce === "string" && meta.reproduce.trim() !== "") {
    const problems = [];
    const env = evidence.env;
    if (!env || typeof env !== "object" || Array.isArray(env)) {
      problems.push("缺 env 块（R-EV-02 五项：commit/runtime/build/command/dirty）");
    } else {
      // 1) commit：必须构建期 define 注入，且与 meta.commit 相等（手改任一侧都要红）。
      const envCommit = String(env.commit ?? "").trim();
      if (!envCommit) {
        problems.push("env.commit 为空（必须由构建期 define 注入）");
      } else if (envCommit !== meta.commit) {
        problems.push(
          `env.commit=${envCommit} 与 meta.commit=${meta.commit} 不一致（commit 不得手写）`,
        );
      }
      // 2) dirty：取证必须是干净树；且 meta.dirty 与 env.dirty 必须同源同值（W-89 第 1 项）。
      //    落盘后各自现算会得到两个答案（meta=false / env=true），必须在门禁处直接判红。
      if (env.dirty !== false) {
        problems.push(`env.dirty=${JSON.stringify(env.dirty)} 不是 false`);
      }
      if (typeof meta.dirty !== "boolean") {
        problems.push(
          `meta.dirty=${JSON.stringify(meta.dirty)} 不是布尔（必须是 PRE 快照的 false）`,
        );
      } else {
        if (meta.dirty !== false) {
          problems.push("meta.dirty=true（取证必须在干净树上跑）");
        }
        if (typeof env.dirty === "boolean" && env.dirty !== meta.dirty) {
          problems.push(
            `meta.dirty=${meta.dirty} 与 env.dirty=${env.dirty} 不一致（必须同源同值）`,
          );
        }
      }
      // 3) runtime：launchMode/node/os/arch/hostTarget 非空 + electron 键存在且非 null。
      // 本产品是 Tauri WebKit 宿主，electron 显式 "none" 记通过；缺失/undefined 仍 FAIL。
      const runtime = env.runtime;
      if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
        problems.push("env.runtime 缺失");
      } else {
        for (const key of ["launchMode", "node", "os", "arch", "hostTarget"]) {
          if (!String(runtime[key] ?? "").trim()) problems.push(`env.runtime.${key} 为空`);
        }
        if (!("electron" in runtime)) {
          problems.push("env.runtime 缺键 electron（非 Electron 宿主须显式写 \"none\"）");
        } else if (runtime.electron === null || runtime.electron === undefined) {
          problems.push("env.runtime.electron 为 null（须显式写 \"none\"）");
        } else if (!String(runtime.electron).trim()) {
          problems.push("env.runtime.electron 为空（须显式写 \"none\"）");
        } else if (String(runtime.electron).trim().toLowerCase() !== "none") {
          problems.push(
            `env.runtime.electron=${JSON.stringify(runtime.electron)} 不是 "none"（Electron 宿主证据无效）`,
          );
        }
      }
      // 4) build：入口/构建时刻/profile/features/二进制摘要。
      const build = env.build;
      if (!build || typeof build !== "object" || Array.isArray(build)) {
        problems.push("env.build 缺失");
      } else {
        for (const key of ["entry", "builtAt", "cargoProfile"]) {
          if (!String(build[key] ?? "").trim()) problems.push(`env.build.${key} 为空`);
        }
        if (!Array.isArray(build.features) || build.features.length === 0) {
          problems.push("env.build.features 必须是非空数组");
        }
        const bin = build.binary;
        if (!bin || typeof bin !== "object" || Array.isArray(bin)) {
          problems.push("env.build.binary 缺失");
        } else {
          if (!String(bin.path ?? "").trim()) problems.push("env.build.binary.path 为空");
          if (!/^[0-9a-f]{64}$/.test(String(bin.sha256 ?? ""))) {
            problems.push("env.build.binary.sha256 不是 64 位小写 hex");
          }
        }
      }
      // 5) command：可复现命令。
      if (!String(env.command ?? "").trim()) problems.push("env.command 为空");
    }

    // 3b/4b/5b) 同一事实只允许一处真源：meta.runtime / meta.build / meta.command 必须逐字段
    // 等于 dump.env 的副本（W-89 第 3 项）；不一致即红，不许一处写 null、一处写 "none"。
    if (env && typeof env === "object" && !Array.isArray(env)) {
      const same = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
      const metaRuntime = meta.runtime;
      if (!metaRuntime || typeof metaRuntime !== "object" || Array.isArray(metaRuntime)) {
        problems.push("meta.runtime 缺失（必须由 evidence-run 从 dump.env.runtime 回填）");
      } else {
        for (const key of ["launchMode", "node", "os", "arch", "hostTarget", "electron"]) {
          const actual = metaRuntime[key] ?? null;
          const expected = (env.runtime && env.runtime[key]) ?? null;
          if (!same(actual, expected)) {
            problems.push(
              `meta.runtime.${key}=${JSON.stringify(actual)} 与 env.runtime.${key}=${JSON.stringify(expected)} 不一致`,
            );
          }
        }
      }
      // 顶层 meta.electron 若被写出，必须与 runtime.electron 同值；null 是「两个答案」的一种。
      if ("electron" in meta) {
        const expected = (metaRuntime && metaRuntime.electron) ?? (env.runtime && env.runtime.electron) ?? null;
        if (meta.electron === null || meta.electron === undefined) {
          problems.push("meta.electron=null（同一事实两处不一致；electron 只保留 env.runtime 一处）");
        } else if (!same(meta.electron, expected)) {
          problems.push(
            `meta.electron=${JSON.stringify(meta.electron)} 与 runtime.electron=${JSON.stringify(expected)} 不一致`,
          );
        }
      }

      const metaBuild = meta.build;
      if (!metaBuild || typeof metaBuild !== "object" || Array.isArray(metaBuild)) {
        problems.push("meta.build 缺失（必须由 evidence-run 从 dump.env.build 回填）");
      } else {
        for (const key of ["entry", "builtAt", "cargoProfile", "features"]) {
          const actual = metaBuild[key] ?? null;
          const expected = (env.build && env.build[key]) ?? null;
          if (!same(actual, expected)) {
            problems.push(
              `meta.build.${key}=${JSON.stringify(actual)} 与 env.build.${key}=${JSON.stringify(expected)} 不一致`,
            );
          }
        }
        for (const key of ["path", "sha256"]) {
          const actual = (metaBuild.binary && metaBuild.binary[key]) ?? null;
          const expected = (env.build && env.build.binary && env.build.binary[key]) ?? null;
          if (!same(actual, expected)) {
            problems.push(
              `meta.build.binary.${key}=${JSON.stringify(actual)} 与 env.build.binary.${key}=${JSON.stringify(expected)} 不一致`,
            );
          }
        }
      }

      const metaCommand = String(meta.command ?? "").trim();
      if (!metaCommand) {
        problems.push("meta.command 为空（必须由 evidence-run 从 dump.env.command 回填）");
      } else if (metaCommand !== String(env.command ?? "").trim()) {
        problems.push(
          `meta.command=${JSON.stringify(metaCommand)} 与 env.command=${JSON.stringify(String(env.command ?? "").trim())} 不一致`,
        );
      }
    }

    // dump：归档落在归档根、摘要合法、finishedAt 与 dump 内值相等（禁止手写另一个时刻）。
    const dump = meta.dump;
    if (!dump || typeof dump !== "object" || Array.isArray(dump)) {
      problems.push("meta.dump 缺失");
    } else {
      const archived = String(dump.archived ?? "").replace(/\\/g, "/");
      if (!archived.startsWith(`${ARCHIVE_REL}/`)) {
        problems.push(`meta.dump.archived=${JSON.stringify(archived)} 不在归档根 ${ARCHIVE_REL}/`);
      }
      if (!/^[0-9a-f]{64}$/.test(String(dump.sha256 ?? ""))) {
        problems.push("meta.dump.sha256 不是 64 位小写 hex");
      }
      // 口径写死：finishedAt 的唯一来源是 dump 顶层 finishedAt；meta.dump.finishedAt 只是副本。
      // 缺失/不等即红，不允许回退 mtime，也不许一处读顶层、一处读子层。
      const dumpFinished = String(dump.finishedAt ?? "");
      const evidenceFinished = evidence.finishedAt;
      if (typeof evidenceFinished !== "string" || !evidenceFinished.trim()) {
        problems.push("dump 顶层缺 finishedAt（唯一来源，缺失即红）");
      }
      if (!dumpFinished.trim()) {
        problems.push("meta.dump.finishedAt 为空（必须从 dump 顶层 finishedAt 回填）");
      } else if (evidenceFinished !== dumpFinished) {
        problems.push(
          `meta.dump.finishedAt=${dumpFinished} 与 dump 顶层 finishedAt=${evidenceFinished} 不一致`,
        );
      }
    }

    // 聚焦：缺失/类型错 = 不可判定 = FAIL；false 是「实测未聚焦」的真实状态，
    // 不判证据失败，但该证据的运行时 check 记「不可判定」，按第 29 条复核判据（第 19 条）。
    let unfocused = false;
    for (const key of ["windowFocused", "appActive"]) {
      if (typeof evidence[key] !== "boolean") {
        problems.push(`dump 缺 ${key}（聚焦状态不可判定 = FAIL）`);
      } else if (evidence[key] !== true) {
        unfocused = true;
      }
    }
    if (unfocused) {
      focusNotes.push(`${file}: windowFocused/appActive=false → 运行时 check 记不可判定（非证据失败；按第 29 条判据复核）`);
    }

    // s2 schema：10 个键 + checks > 0（checks 数组已在上面统一断言）+ suite=s2。
    if (evidence.kind === "aka-s2-evidence") {
      const missingKeys = S2_SCHEMA_KEYS.filter((key) => !(key in evidence));
      if (missingKeys.length > 0) {
        problems.push(`s2 dump 缺 schema 键 [${missingKeys.join(", ")}]`);
      }
      if (evidence.suite !== "s2") {
        problems.push(`s2 dump suite=${JSON.stringify(evidence.suite)} 不是 "s2"`);
      }
    }

    for (const problem of problems) failures.push(`${file}: ${problem}`);
  }

  const result = meta.result && typeof meta.result === "object" ? meta.result : {};
  if (!result.card) {
    failures.push(`${file}-meta: 缺 result.card，无法闭合归属`);
    continue;
  }
  if (!CARD_SET.has(result.card)) {
    failures.push(`${file}-meta: result.card=${result.card} 不在卡集`);
    continue;
  }

  const otherCards = Array.isArray(result.otherCards) ? result.otherCards : [];
  const declaredCards = new Set([result.card]);
  for (const [index, other] of otherCards.entries()) {
    if (!other || typeof other !== "object" || !other.card) {
      failures.push(`${file}: otherCards[${index}] 缺 card`);
      continue;
    }
    if (!CARD_SET.has(other.card)) {
      failures.push(`${file}: otherCards[${index}].card=${other.card} 不在卡集`);
    }
    if (declaredCards.has(other.card)) {
      failures.push(`${file}: otherCards[${index}].card=${other.card} 重复声明`);
    }
    declaredCards.add(other.card);

    const list = evidence.checks.filter((check) => check.card === other.card);
    const declared = /^(\d+)\/(\d+)$/.exec(String(other.checks ?? "").trim());
    if (!declared) {
      failures.push(`${file}: otherCards ${other.card} 的 checks 缺失或不是 passed/total`);
    } else {
      const passed = list.filter((check) => check.passed === true).length;
      if (Number(declared[1]) !== passed || Number(declared[2]) !== list.length) {
        failures.push(
          `${file}: otherCards ${other.card} 声明 ${other.checks}，现算 ${passed}/${list.length}`,
        );
      }
    }
    if (!other.layers || typeof other.layers !== "object" || Array.isArray(other.layers)) {
      failures.push(`${file}: otherCards ${other.card} 缺 layers（必填，逐卡现算比对）`);
    } else if (stable(countLayers(list)) !== stable(other.layers)) {
      failures.push(
        `${file}: otherCards ${other.card} 的 layers=${JSON.stringify(other.layers)} 与现算=${JSON.stringify(
          countLayers(list),
        )} 不一致`,
      );
    }
  }

  const actualCards = new Set(evidence.checks.map((check) => check.card));
  for (const card of actualCards) {
    if (!declaredCards.has(card)) failures.push(`${file}: check 含未声明的卡 ${card}`);
  }
  for (const card of declaredCards) {
    if (!actualCards.has(card)) failures.push(`${file}: 声明了卡 ${card} 但没有任何 check`);
  }

  const primaryChecks = evidence.checks.filter((check) => check.card === result.card);
  const recomputed = countLayers(primaryChecks);
  if (!result.layers || typeof result.layers !== "object") {
    failures.push(`${file}-meta: 缺 result.layers`);
  } else if (stable(recomputed) !== stable(result.layers)) {
    failures.push(
      `${file}-meta: result.layers=${JSON.stringify(result.layers)} 与 checks 现算=${JSON.stringify(
        recomputed,
      )} 不一致`,
    );
  }

  const declaredTotal =
    sumTotals(result.layers) +
    otherCards.reduce(
      (acc, other) => acc + (Number(String(other?.checks ?? "").split("/")[1]) || 0),
      0,
    );
  if (declaredTotal !== evidence.checks.length) {
    failures.push(
      `${file}: 声明分母合计 ${declaredTotal} != checks.length ${evidence.checks.length}（不许跳过现算）`,
    );
  }
}

if (scanned === 0) {
  failures.push(`未在 ${EVIDENCE_DIR} 扫描到任何证据（拒绝空转）`);
}

for (const warning of warnings) console.warn(`WARN ${warning}`);
for (const note of focusNotes) console.warn(`WARN ${note}`);
for (const failure of failures) console.error(`FAIL ${failure}`);
console.log(
  `证据归属门禁：卡集 ${CARD_SET.size} 张，扫描 ${scanned} 份证据（全部平铺），` +
    `冻结 ${frozen} 份，未聚焦 ${focusNotes.length} 份，失败 ${failures.length} 项` +
    `（白名单上限 ${LEGACY_MAX_FILES}，截止 ${LEGACY_DEADLINE}，以 CI 时钟为准）`,
);
process.exit(failures.length === 0 ? 0 : 1);
