#!/usr/bin/env node
/**
 * 常量单一源门禁（G1）
 *
 * 用法：
 *   node scripts/verify_constants.mjs           # 只校验 manifest / mock 生成器与常量是否一致
 *   node scripts/verify_constants.mjs --docs    # 追加扫描卡片/PRD 中的过期数字与口径
 *   node scripts/verify_constants.mjs --report  # 只打印，不因文档漂移失败
 *
 * 退出码：
 *   0 = 常量一致（允许存在已登记的 known 漂移）
 *   1 = 常量不一致，或出现未登记的文档漂移
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const ROOT = path.resolve(APP, "..");

const CONSTANTS_PATH = path.join(APP, "manifest", "constants.json");
const MANIFEST_PATH = path.join(APP, "manifest", "indicators.json");
const MOCK_PATH =
  process.env.AKA_MOCK_PATH || path.join(APP, "crates", "data-provider", "src", "mock.rs");
const BASELINE_PATH = path.join(ROOT, "docs", "qa", "constants-baseline-v0.1.json");

const argv = new Set(process.argv.slice(2));
const CHECK_DOCS = argv.has("--docs") || argv.has("--report");
const REPORT_ONLY = argv.has("--report");

const constants = JSON.parse(fs.readFileSync(CONSTANTS_PATH, "utf8"));
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const items = manifest.indicators ?? manifest;

const failures = [];
const warnings = [];
const passes = [];

function check(name, actual, expected) {
  if (actual === expected) {
    passes.push(`${name}: ${actual}`);
    return true;
  }
  failures.push(`${name}: 期望 ${expected}，实际 ${actual}`);
  return false;
}

function countBy(list, field) {
  const out = {};
  for (const item of list) {
    const key = String(item[field]);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

// ---------- 1. manifest 派生值 ----------
const status = countBy(items, "status");
const priority = countBy(items, "priority");
const specStatus = countBy(items, "specStatus");
const completeness = countBy(items, "completeness");
const planned = items.filter((x) => x.status === "planned");
const implemented = items.filter((x) => x.status === "normal" || x.status === "beta");

const c = constants.catalog;
check("目录总量", items.length, c.total);
check("P0 总数", priority.P0 ?? 0, c.p0);
check("P1 总数", priority.P1 ?? 0, c.p1);
check("规划中条数", status.planned ?? 0, c.planned);
check("可添加条数（normal+beta）", implemented.length, c.implemented);
check("completeness=完整", completeness["完整"] ?? 0, c.completeness.complete);
check("completeness=部分", completeness["部分"] ?? 0, c.completeness.partial);
check("completeness=beta", completeness["beta"] ?? 0, c.completeness.beta);
check(
  "规划中且口径待定（partial+productDefined）",
  planned.filter((x) => x.specStatus !== "manualComplete").length,
  c.pendingSpecPlanned,
);
check("补全口径条数", items.filter((x) => x.isCompletion).length, c.completionCount);

// ---------- 2. 样本集常量与生成器一致 ----------
const mockSrc = fs.readFileSync(MOCK_PATH, "utf8");
const securityCount = Number(mockSrc.match(/MOCK_SECURITY_COUNT\s*:\s*usize\s*=\s*(\d+)/)?.[1]);
const bars = Number(mockSrc.match(/MOCK_BARS_PER_SECURITY\s*:\s*usize\s*=\s*(\d+)/)?.[1]);
const firstDate = mockSrc.match(/MOCK_FIRST_DATE\s*:\s*Date\s*=\s*Date::new\((\d+),\s*(\d+),\s*(\d+)\)/);
const d = constants.dataset;
check("mock 标的数", securityCount, d.securities);
check("mock 每标的根数", bars, d.barsPerSecurity);
check("股票数（标的-指数）", d.securities - d.indices, d.stocks);
check("样本行数（标的×根数）", d.securities * d.barsPerSecurity, d.rows);

if (firstDate) {
  const padded = (n) => String(Number(n)).padStart(2, "0");
  const first = `${firstDate[1].padStart(4, "0")}-${padded(firstDate[2])}-${padded(firstDate[3])}`;
  check("mock 起始日", first, d.firstDate);
  const end = new Date(`${first}T00:00:00Z`);
  let counted = 1;
  while (counted < bars) {
    end.setUTCDate(end.getUTCDate() + 1);
    const weekday = end.getUTCDay();
    if (weekday !== 0 && weekday !== 6) counted += 1;
  }
  const last = end.toISOString().slice(0, 10);
  check("mock 覆盖末日（按工作日推算）", last, d.lastDate);
} else {
  failures.push("mock 起始日: 未能在 mock.rs 中解析 MOCK_FIRST_DATE");
}

// ---------- 2b. 派生计数（W-29）：六分类来自 manifest，分区来自 mock.rs ----------
const CATEGORY_ORDER = ["trend", "momentum", "volatility", "volume", "stat", "breadth"];
const CATEGORY_EXPECTED = {
  trend: 24,
  momentum: 26,
  volatility: 10,
  volume: 15,
  stat: 14,
  breadth: 16,
};
const categoryCounts = countBy(items, "category");
check(
  "六分类计数｜脚本自动｜indicators.json 的 category",
  CATEGORY_ORDER.map((key) => `${key}:${categoryCounts[key] ?? 0}`).join(" "),
  CATEGORY_ORDER.map((key) => `${key}:${CATEGORY_EXPECTED[key]}`).join(" "),
);

/**
 * 分区计数：按「指数按交易所归主板」的口径现算（不按 Board 枚举）。
 * .SH 且 688/689 开头 → 科，其余 .SH（含上证指数）→ 沪；
 * .SZ 且 300 开头 → 创，其余 .SZ（含深证成指/创业板指）→ 深。
 */
const mockBlock = (src, marker) => {
  const start = src.indexOf(marker);
  if (start < 0) return null;
  const end = src.indexOf("];", start);
  return end < 0 ? null : src.slice(start, end);
};
const classifyByExchange = (code) => {
  const [num, market] = code.split(".");
  if (market === "SH") return num.startsWith("688") || num.startsWith("689") ? "star" : "sh";
  return num.startsWith("300") ? "chinext" : "sz";
};
/** 从 mock.rs 文本现算分区计数；不可解析时返回 null（调用方拒绝空转）。 */
const computePartition = (src) => {
  const knownBlock = mockBlock(src, "let known:");
  const groupsBlock = mockBlock(src, "let groups:");
  const knownCodes = [...(knownBlock ?? "").matchAll(/\("(\d{6}\.(?:SH|SZ))"\s*,/g)].map((m) => m[1]);
  const indexCodes = [
    ...src.matchAll(/make_security\("(\d{6}\.(?:SH|SZ))",\s*"[^"]+",\s*Board::Index/g),
  ].map((m) => m[1]);
  const groupEntries = [...(groupsBlock ?? "").matchAll(/\("(\d{3})",\s*(\d+),\s*Board::/g)].map(
    (m) => ({ prefix: m[1], count: Number(m[2]) }),
  );
  if (knownCodes.length === 0 || indexCodes.length === 0 || groupEntries.length === 0) return null;
  const partition = { sh: 0, sz: 0, chinext: 0, star: 0 };
  for (const code of [...knownCodes, ...indexCodes]) partition[classifyByExchange(code)] += 1;
  for (const { prefix, count } of groupEntries) {
    partition[classifyByExchange(`${prefix}.${prefix === "601" || prefix === "688" ? "SH" : "SZ"}`)] +=
      count;
  }
  return partition;
};
const fmtPartition = (p) => `沪 ${p.sh} / 深 ${p.sz} / 创 ${p.chinext} / 科 ${p.star}`;
const partition = computePartition(mockSrc);
if (!partition) {
  console.error("mock_partition_unparsable: mock.rs 的 known / groups / 指数注册（拒绝空转）");
  process.exit(2);
}
check(
  "分区计数（指数按交易所归主板）｜脚本自动｜mock.rs known/groups/指数注册",
  fmtPartition(partition),
  "沪 48 / 深 46 / 创 17 / 科 9",
);
// 反向用例（W-29）：把生成组 40→41，派生结果必须随之变化；若不变说明校验器写死或按 Board 分组。
const mutatedMockSrc = mockSrc.replace(/\("601",\s*40,\s*Board::ShMain\)/, '("601", 41, Board::ShMain)');
const mutatedPartition = computePartition(mutatedMockSrc);
if (!mutatedPartition || fmtPartition(mutatedPartition) === "沪 48 / 深 46 / 创 17 / 科 9") {
  failures.push("分区计数反例: 生成组 40→41 后派生结果未变，校验器未真正派生");
} else {
  passes.push(`分区计数反例（601 组 40→41 后 ${fmtPartition(mutatedPartition)} ≠ 沪 48 / 深 46 / 创 17 / 科 9）: 校验有效`);
}

// ---------- 3. 裁定结果（W-24 正向断言，防止被悄悄改回去） ----------
const betaSet = items
  .filter((x) => x.status === "beta")
  .map((x) => x.id)
  .sort()
  .join(",");
check("beta 集合恰为", betaSet, "T16,T19");
check("normal 条数", status.normal ?? 0, constants.catalog.rulings.afterT03T21Promotion.normal);
check("T03 specStatus", items.find((x) => x.id === "T03")?.specStatus, "manualComplete");
check("T21 specStatus", items.find((x) => x.id === "T21")?.specStatus, "manualComplete");
// 「全域名口径待定」= 全部 105 条里 specStatus !== manualComplete 的条数；
// 与上面「规划中且口径待定」的 13 是两个口径（后者只统计 status=planned 的 60 条），不互相替代。
check("全域名口径待定（含已实现）", items.filter((x) => x.specStatus !== "manualComplete").length, 15);

// ---------- 3b. 模块数派生（W-37）：唯一权威在架构文档 §2 总览表 ----------
const MODULE_DOC = "docs/architecture/aka-story-cards-by-tech-module-v0.1.md";
const MODULE_ROW = /^\|\s*[^|\n]*\|\s*`([ABC][0-9]+)`/gm;
const MODULE_ROW_LINE = /^\|\s*[^|\n]*\|\s*`[ABC][0-9]+`/;
const countModuleCodes = (text) => {
  const section = text.split(/^## 2\./m)[1]?.split(/^## 3\./m)[0] ?? "";
  return [...section.matchAll(MODULE_ROW)].map((match) => match[1]);
};
const moduleDocPath = path.join(ROOT, MODULE_DOC);
if (!fs.existsSync(moduleDocPath)) {
  failures.push(`模块数: 未找到 ${MODULE_DOC}（§2 是模块编号唯一权威）`);
} else {
  const moduleDocText = fs.readFileSync(moduleDocPath, "utf8");
  const moduleCodes = countModuleCodes(moduleDocText);
  check(`模块数｜脚本自动｜${MODULE_DOC} §2`, moduleCodes.length, 19);
  // 反向用例：临时删掉一行模块，派生结果必须不再是 19，否则该行是手写死值而非派生
  const mutatedLines = moduleDocText.split("\n");
  const firstModuleRow = mutatedLines.findIndex((line) => MODULE_ROW_LINE.test(line));
  const mutated = mutatedLines.filter((_, index) => index !== firstModuleRow).join("\n");
  const mutatedCount = countModuleCodes(mutated).length;
  if (firstModuleRow < 0 || mutatedCount === 19) failures.push("模块数反例: 删一行后仍为 19，派生校验失效");
  else passes.push(`模块数反例（删一行后 ${mutatedCount} ≠ 19）: 校验有效`);
}

// ---------- 4. 文档漂移扫描 ----------
/**
 * patternId 是稳定标识；baseline 只登记「已知且已开单」的漂移。
 * 新增漂移若不在 baseline，直接失败。
 */
const CARDS = "docs/story-cards/aka-story-cards-v0.1.md";
const INDEX = "docs/story-cards/aka-story-index-v0.1.csv";
const PRD = "docs/prd/aka-prd-v0.1.md";

const PATTERNS = [
  { id: "ema-seed-wrong", re: /EMA\s*初值取首根收盘/g, files: [CARDS], workorder: "W-01", desc: "EMA 种子应为前 N 根 SMA" },
  { id: "tr-value-wrong", re: /TR\[1\]=1\.2|TR\[2\]=max\(0\.7,0\.2,0\.5\)/g, files: [CARDS], workorder: "W-02", desc: "TR 中间量算错" },
  { id: "row-count-60000", re: /60,000/g, files: [CARDS], workorder: "W-21", desc: "行数应为 62,400" },
  { id: "row-count-240000", re: /240,000/g, files: [CARDS], workorder: "W-21", desc: "行数应为 62,400" },
  { id: "implemented-84", re: /已实现[^\n]{0,12}84|84\s*个已实现|展示\s*84\s*个已实现/g, files: [CARDS], workorder: "W-13/W-18", desc: "已实现应为 45（normal 43 + beta 2）" },
  { id: "birth-79818", re: /79\s*完整\s*\/\s*18|79\/18/g, files: [CARDS], workorder: "W-07", desc: "完整/部分应为 78/19" },
  { id: "denom-120", re: /security_count\s*=\s*120[^\n]{0,24}含\s*8\s*个指数|分母仍为\s*N（120）/g, files: [CARDS], workorder: "W-08", desc: "广度分母应为 112" },
  { id: "param-2-200", re: /2~200/g, files: [CARDS, PRD], workorder: "W-20", desc: "周期上限应为 500" },
  { id: "pages-12", re: /12\s*个页面/g, files: [CARDS], workorder: "W-12/W-14", desc: "验收范围应为已交付路由全量" },
  { id: "empty-copy", re: /这组还没有标的/g, files: [CARDS], workorder: "W-19", desc: "空态文案应统一" },
  { id: "obv-assumed", re: /OBV（假设未实现）/g, files: [CARDS], workorder: "W-18", desc: "OBV 已实现，不能作为未实现样例" },
  { id: "badge-completeness", re: /beta[^\n]{0,20}徽标只由[^\n]{0,20}completeness=beta/g, files: [CARDS], workorder: "W-06", desc: "beta 徽标只看 status" },
  { id: "st-mvp", re: /ST\s*涨停|is_st/g, files: [CARDS], workorder: "W-08", desc: "ST 不进 MVP" },
  { id: "sector-12", re: /MVP[^\n]{0,10}(?:启用|保留|纳入|包含)[^\n]{0,10}12\s*个\s*行业板块/g, files: [CARDS], workorder: "W-09/W-31", desc: "MVP 只留指数；12 行业仅降级 V1" },
  { id: "m22-three-badges", re: /三徽标|三个徽标/g, files: [CARDS], workorder: "W-06/W-07", desc: "M22 只应有规划中+口径待定" },
];

const DOC_FILES = [
  "docs/story-cards/aka-story-cards-v0.1.md",
  "docs/story-cards/aka-story-index-v0.1.csv",
  "docs/prd/aka-prd-v0.1.md",
];

/**
 * 显式白名单：逐条列出「pattern + 文件 + 行号 + 该行必须含有的原文片段 + 放行理由」。
 * 匹配条件是 file + mustInclude 原文片段（≥20 字），不使用「行里含 V1 就跳过」这类规则豁免——
 * 那样任何文档随手加个 V1 就免疫了。line 仅作人工核对参考：卡片正被多方并发编辑，行号会整体平移；
 * 原文片段一旦被改写，条目立即失效并报 STALE 失败，迫使放行者重新逐条确认。
 *
 * W-31：sector-12 的两条豁免已删除——口径定死后正确表述只有一种，
 * 保留白名单等于给「改回 MVP 启用 12 行业」留后门；正则已收窄到只拦错误主张。
 */
const DRIFT_ALLOWLIST = [];

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return [];
  return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")).known ?? [];
}

const baseline = loadBaseline();
const knownSet = new Set(baseline.map((entry) => entry.pattern));
const matchedKnown = new Set();

const drift = [];
const matchedAllow = new Set();
if (CHECK_DOCS) {
  for (const pattern of PATTERNS) {
    for (const rel of pattern.files ?? DOC_FILES) {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) continue;
      const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        pattern.re.lastIndex = 0;
        const match = pattern.re.exec(line);
        if (!match) return;
        const allow = DRIFT_ALLOWLIST.find(
          (a) => a.pattern === pattern.id && a.file === rel && line.includes(a.mustInclude),
        );
        if (allow) {
          matchedAllow.add(`${allow.pattern}|${allow.file}|${allow.mustInclude}`);
          allow.actualLine = index + 1;
          return;
        }
        const snippet = match[0];
        const entry = { pattern: pattern.id, snippet, file: rel, line: index + 1, ...pattern };
        if (knownSet.has(pattern.id)) matchedKnown.add(pattern.id);
        else drift.push(entry);
      });
    }
  }
}

// 白名单条目一旦对不上（行号漂移、原文改写、pattern 改名），视为失效并失败，不允许静默免疫
if (CHECK_DOCS) {
  for (const a of DRIFT_ALLOWLIST) {
    if (!matchedAllow.has(`${a.pattern}|${a.file}|${a.mustInclude}`)) {
      failures.push(`显式白名单失效：${a.file}:${a.line} [${a.pattern}] 原文片段已变或不再命中，需重新逐条确认`);
    }
  }
}

// ---------- 输出 ----------
console.log("AKA 常量单一源检查");
console.log(`常量源：${path.relative(ROOT, CONSTANTS_PATH)}`);
console.log("");

console.log(`通过 ${passes.length} 项`);
for (const item of passes) console.log(`  PASS  ${item}`);

if (warnings.length > 0) {
  console.log("");
  console.log(`告警 ${warnings.length} 项（不阻断）`);
  for (const item of warnings) console.log(`  WARN  ${item}`);
}

if (failures.length > 0) {
  console.log("");
  console.log(`失败 ${failures.length} 项`);
  for (const item of failures) console.log(`  FAIL  ${item}`);
}

if (CHECK_DOCS) {
  console.log("");
  console.log(`文档已登记漂移 ${matchedKnown.size} 项（baseline，不阻断）`);
  console.log(`显式白名单命中 ${matchedAllow.size} 项（逐条 file:line + 原文）`);
  for (const a of DRIFT_ALLOWLIST) {
    if (matchedAllow.has(`${a.pattern}|${a.file}|${a.mustInclude}`)) {
      console.log(`  ALLOW  ${a.file}:${a.actualLine ?? a.line}  [${a.pattern}]  ${a.reason}`);
    }
  }
  console.log(`文档未登记漂移 ${drift.length} 项`);
  for (const item of drift) {
    console.log(`  DRIFT ${item.file}:${item.line}  [${item.id}]  ${item.snippet.trim()}  → ${item.desc}（${item.workorder}）`);
  }
  if (baseline.length > 0) {
    console.log("");
    console.log("baseline 未命中的条目（通常表示已修好，可从 baseline 删除）：");
    for (const entry of baseline) {
      if (!matchedKnown.has(entry.pattern)) console.log(`  STALE  ${entry.pattern}  ${entry.workorder}`);
    }
  }
}

const hardFail = failures.length > 0 || (!REPORT_ONLY && drift.length > 0);
console.log("");
console.log(hardFail ? "结论：FAIL" : "结论：PASS");
process.exit(hardFail ? 1 : 0);
