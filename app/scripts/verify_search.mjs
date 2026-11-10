#!/usr/bin/env node
/**
 * W-119c：S-05.01-01 搜索卡产品侧门禁（取数链路 + 排序口径 + 浮层聚焦契约）。
 *
 * 事故（本轮 BA 取证 s050101 判红，2 条 check false）：
 *   ① AC-05.01-01（补2）detail：「首条 002100.SZ（数据层成交额最大者
 *      10371482219.04（601029.SH））」——根因在产品取数，不在断言口径：
 *      searchIndex.buildSearchIndex 用行情行的 `code`（裸代码，如 `601029`）建索引，
 *      却用证券表的 `code`（带后缀，如 `601029.SH`）去查 → 每条行情都 miss →
 *      成交额/最新价/涨跌幅/停牌全为 null → 同分排序退化成「代码升序」。
 *      连带后果：搜索结果行最新价/涨跌幅恒为「—」（卡面主流程 5 要求真实值），
 *      停牌标签永不出现（补3 的「停牌」曾靠标的名称含「停牌」二字侥幸判绿）。
 *   ② AC-05.01-01 detail：「⌘K 唤起=true / 输入框聚焦=false」——根因在产品时序：
 *      索引未就绪时输入框是 disabled 的（disabled 元素 focus() 无效），而浮层只在
 *      打开瞬间聚焦一次，「唤起早于索引就绪」这条路径永远拿不到焦点。
 *
 * 本门禁分两段：
 *   A. 行为段（跑产品源码，Node 类型剥离导入 .ts）：取数链路 4 项 join、同分组首条
 *      = 成交额最大者（卡面补2）、停牌涨跌幅 null（卡面补3）、代码/名称匹配优先级
 *      （卡面主流程 3）。
 *   B. 静态契约段（浮层聚焦）：聚焦必须「输入框解禁后补一次」，即依赖 loadState
 *      且聚焦前判断 disabled。运行层是否真的聚焦由 BA 取证复测，本段只守源码形态。
 * 反例（第 29 条）：变异源码必须判红 —— 索引键改回 row.code、聚焦依赖去掉 loadState，
 * 两处各自都能打红，说明本门禁不是恒真断言。
 *
 * 用法：node --experimental-strip-types scripts/verify_search.mjs
 * 退出码：0 = 通过；1 = 判据失败（产品回归或反例未判红）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");
const SOURCE = join(APP, "src", "features", "search", "searchIndex.ts");
const OVERLAY = join(APP, "src", "components", "SearchOverlay.tsx");

const read = (path) => readFileSync(path, "utf8");

/**
 * 合成样本：字段形状与后端 DTO 一致 —— MarketRowDto.code 是裸代码、security 是
 * 带交易所后缀的唯一键；SecurityDto.code 带后缀。金额沿用事故 dump 里的真实数值
 * （601029.SH = 10371482219.04 为生成组成交额最大者）。
 */
const securities = [
  { code: "601029.SH", name: "示例标的 030", market: "SH", board: "沪市主板", isIndex: false, basePrice: 120 },
  { code: "002100.SZ", name: "示例标的 041", market: "SZ", board: "深市主板", isIndex: false, basePrice: 50 },
  { code: "300750.SZ", name: "宁德时代", market: "SZ", board: "创业板", isIndex: false, basePrice: 218 },
  { code: "DIAGQSUP.SZ", name: "诊断停牌末日", market: "SZ", board: "深市主板", isIndex: false, basePrice: 12 },
];

const rows = [
  {
    security: "601029.SH", code: "601029", name: "示例标的 030", market: "SH", board: "沪市主板",
    isIndex: false, suspended: false, lastPrice: 120.5, prevClose: 118, changeAbs: 2.5, changePct: 2.11,
    volume: 1000, amount: 10371482219.04, turnoverPct: 1.2, volumeRatio: 1.1, amplitudePct: 3,
    flags: [], dataIssue: false,
  },
  {
    security: "002100.SZ", code: "002100", name: "示例标的 041", market: "SZ", board: "深市主板",
    isIndex: false, suspended: false, lastPrice: 50.2, prevClose: 50, changeAbs: 0.2, changePct: 0.4,
    volume: 900, amount: 900000000, turnoverPct: 0.9, volumeRatio: 0.9, amplitudePct: 2,
    flags: [], dataIssue: false,
  },
  {
    security: "300750.SZ", code: "300750", name: "宁德时代", market: "SZ", board: "创业板",
    isIndex: false, suspended: false, lastPrice: 218.6, prevClose: 214, changeAbs: 4.6, changePct: 2.15,
    volume: 5000, amount: 5000000000, turnoverPct: 0.8, volumeRatio: 1.2, amplitudePct: 4,
    flags: [], dataIssue: false,
  },
  {
    security: "DIAGQSUP.SZ", code: "DIAGQSUP", name: "诊断停牌末日", market: "SZ", board: "深市主板",
    isIndex: false, suspended: true, lastPrice: 12, prevClose: 12, changeAbs: null, changePct: null,
    volume: 0, amount: 0, turnoverPct: 0, volumeRatio: null, amplitudePct: 0,
    flags: [], dataIssue: false,
  },
];

/** 行为判据（纯函数）：输入模块，返回失败项列表。 */
export function judge(mod) {
  const failures = [];
  const index = mod.buildSearchIndex(securities, rows);
  const byCode = new Map(index.items.map((item) => [item.code, item]));

  // 1) 取数链路：每条证券都 join 到行情行（事故形态下 amount/price/pct 全为 null）
  for (const security of securities) {
    const item = byCode.get(security.code);
    if (!item) {
      failures.push(`索引缺证券 ${security.code}`);
      continue;
    }
    const row = rows.find((candidate) => candidate.security === security.code);
    if (!row) continue;
    if (item.amount !== row.amount) {
      failures.push(`${security.code} 成交额=${item.amount}，行情行=${row.amount}（索引没 join 上）`);
    }
    if (item.price !== row.lastPrice) {
      failures.push(`${security.code} 最新价=${item.price}，行情行=${row.lastPrice}`);
    }
    if (item.changePct !== row.changePct) {
      failures.push(`${security.code} 涨跌幅=${item.changePct}，行情行=${row.changePct}`);
    }
    if (item.suspended !== row.suspended) {
      failures.push(`${security.code} 停牌=${item.suspended}，行情行=${row.suspended}`);
    }
  }

  // 2) 排序口径（卡面 AC-05.01-01 补2）：同分组内首条 = 成交额最大者
  const named = mod.matchSecurities(index, "示例");
  const matched = named.hits.map((hit) => hit.item);
  const maxAmount = Math.max(...matched.map((item) => item.amount ?? -1));
  if (named.hits.length !== 2) {
    failures.push(`名称前缀命中 ${named.hits.length} 条，应为 2 条`);
  }
  if (named.hits[0]?.item.amount !== maxAmount) {
    failures.push(
      `同分组首条成交额=${named.hits[0]?.item.amount}，组内最大=${maxAmount}（卡面：首条为成交额最大者）`,
    );
  }
  if (named.hits[0]?.item.code !== "601029.SH") {
    failures.push(`同分组首条=${named.hits[0]?.item.code}，应为 601029.SH`);
  }

  // 3) 停牌口径（卡面补3）：停牌行涨跌幅为 null → 渲染层出「—」
  const suspended = byCode.get("DIAGQSUP.SZ");
  if (!suspended?.suspended) failures.push("停牌标的 DIAGQSUP.SZ 未标停牌");
  if (suspended?.changePct !== null) failures.push(`停牌标的涨跌幅=${suspended?.changePct}，应为 null`);

  // 4) 匹配优先级（卡面主流程 3）：代码精确 > 代码前缀 > 名称前缀 > 名称子串
  const byCodeExact = mod.matchSecurities(index, "300750").hits[0]?.item.code;
  const byCodeSuffix = mod.matchSecurities(index, "300750.SZ").hits[0]?.item.code;
  const byNamePrefix = mod.matchSecurities(index, "宁德").hits[0]?.item.code;
  const byNameInside = mod.matchSecurities(index, "德时").hits[0]?.item.code;
  if (byCodeExact !== "300750.SZ") failures.push(`代码精确命中=${byCodeExact}，应为 300750.SZ`);
  if (byCodeSuffix !== "300750.SZ") failures.push(`带后缀命中=${byCodeSuffix}，应为 300750.SZ`);
  if (byNamePrefix !== "300750.SZ") failures.push(`名称前缀命中=${byNamePrefix}，应为 300750.SZ`);
  if (byNameInside !== "300750.SZ") failures.push(`名称子串命中=${byNameInside}，应为 300750.SZ`);

  return failures;
}

/** 浮层聚焦静态契约（纯函数）：输入源码，返回失败项列表。 */
export function judgeFocus(source) {
  const failures = [];
  // 聚焦副作用必须跟着「索引就绪」重跑：输入框在 preparing/unavailable 时是 disabled 的，
  // disabled 元素 focus() 无效，只在打开瞬间聚焦一次会漏焦点。
  if (!/\}, \[open, loadState\]\);/.test(source)) {
    failures.push("SearchOverlay 聚焦副作用未依赖 loadState（索引就绪后不补聚焦）");
  }
  if (!/if \(!element \|\| element\.disabled\) return;/.test(source)) {
    failures.push("SearchOverlay 聚焦前未判断输入框 disabled");
  }
  if (!/disabled=\{state === "preparing" \|\| state === "unavailable"\}/.test(source)) {
    failures.push("SearchOverlay 输入框未在 preparing/unavailable 时禁用（聚焦契约前提变更）");
  }
  return failures;
}

async function importSource(path) {
  return import(pathToFileURL(path).href);
}

const source = read(SOURCE);
const overlay = read(OVERLAY);
const failures = judge(await importSource(SOURCE));
for (const message of failures) console.error(`FAIL ${message}`);
const focusFailures = judgeFocus(overlay);
for (const message of focusFailures) console.error(`FAIL ${message}`);

// —— 反例（第 29 条）：变异源码必须判红 ——
// 变异 1 = 事故原始形态（索引键用裸代码）；变异 2 = 聚焦只依赖 open（不补聚焦）。
const dir = mkdtempSync(join(tmpdir(), "aka-search-"));
try {
  const keyNeedle = "quotes.set(row.security, row)";
  if (!source.includes(keyNeedle)) {
    console.error(`FAIL 反例未落到源码上：找不到「${keyNeedle}」`);
    process.exit(1);
  }
  const mutantPath = join(dir, "mutant-searchIndex.ts");
  writeFileSync(mutantPath, source.replace(keyNeedle, "quotes.set(row.code, row)"), "utf8");
  const mutantFailures = judge(await importSource(mutantPath));
  if (mutantFailures.length === 0) {
    console.error("FAIL 反例未判红：变异索引键 row.security → row.code 仍然全绿 = 恒真断言");
    process.exit(1);
  }
  console.log(`反例①：变异索引键 row.security → row.code → 判红 ${mutantFailures.length} 项`);

  const focusNeedle = "}, [open, loadState]);";
  if (!overlay.includes(focusNeedle)) {
    console.error(`FAIL 反例未落到源码上：找不到「${focusNeedle}」`);
    process.exit(1);
  }
  const focusMutantFailures = judgeFocus(overlay.replace(focusNeedle, "}, [open]);"));
  if (focusMutantFailures.length === 0) {
    console.error("FAIL 反例未判红：变异聚焦依赖去掉 loadState 仍然全绿 = 恒真断言");
    process.exit(1);
  }
  console.log(`反例②：变异聚焦依赖 [open, loadState] → [open] → 判红 ${focusMutantFailures.length} 项`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0 || focusFailures.length > 0) {
  console.error(
    `verify:search 失败：行为判据 ${failures.length} 项 + 聚焦契约 ${focusFailures.length} 项`,
  );
  process.exit(1);
}
console.log(
  "verify:search 通过：取数链路 join 4 项 / 同分组首条=成交额最大者 / 停牌涨跌幅 null / " +
    "匹配优先级 4 项 + 聚焦静态契约 3 项 + 反例①②判红",
);
