#!/usr/bin/env node
/**
 * W-119c：S-03.01-04 / S-03.02-01 取证 runner 口径门禁。
 *
 * 事故（本轮 BA 取证 2 套件不可判，根因同一类：runner 挑错了指标 / 挑不到 DOM 节点）：
 *   ① s030104 套件在「副图 3/3 已满」与「点加入图表 → 按钮转 added」两处都用
 *      **M03（status=planned）**。卡面 S-03.01-04 异常与边界 + 补4 要求规划项一律
 *      给「该指标规划中，本期未开放」，规划项永远不可能进入 added/full 态 →
 *      断言口径与卡面/产品都不一致 → 等待 20s 超时 → 套件异常中断 → AC 不可判。
 *   ② s030201 套件点 `[data-fav-star="M03"]` 期望收藏 chip 重排到首位，但目录
 *      **按分类懒挂载行**（默认只展开「趋势」，M03 属「动量」）→ 星标按钮根本不在
 *      DOM 里，点了个空元素 → 收藏没写入 → 等「chip 重排」20s 超时。
 *
 * 本门禁把两条口径变成可判红检查（数据源是注册表真值 app/manifest/indicators.json，
 * 不维护第二份期望值）：
 *   A. s030104：断言「full / added」的指标必须是 status=normal 且 panel=副
 *      （planned 指标到不了这两种态）；断言「planned」的指标必须是 status=planned
 *      （规划项覆盖不能被顺手删掉）。
 *   B. s030201：被星标的指标若不在默认展开的分类里，runner 必须先展开全部分类，
 *      否则星标按钮不在 DOM 里（点了等于没点）。
 * 反例（第 29 条）：把 full/added 的断言目标改回 M03、删掉 expandAllCategories()，
 * 两处变异都必须判红 —— 证明本门禁不是恒真断言。
 *
 * 用法：node scripts/verify_catalog_runner.mjs
 * 退出码：0 = 通过；1 = 判据失败（runner 口径回退或反例未判红）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");
const BATCH = join(APP, "src", "features", "qa", "batchDiag.ts");
const MANIFEST = join(APP, "manifest", "indicators.json");

const read = (path) => readFileSync(path, "utf8");
const manifest = JSON.parse(read(MANIFEST));
const registry = new Map(manifest.indicators.map((item) => [item.id, item]));

/** 取某个 runner 的源码块（按 export 切块）。 */
export function runnerBlock(source, name) {
  const chunks = source.split(/\nexport async function /);
  const chunk = chunks.find((item) => item.startsWith(`${name}(`));
  return chunk ?? "";
}

/** 收集 block 里 `countState("X") === "状态"` 的 (id, 状态) 对。 */
export function assertedStates(block) {
  const out = [];
  for (const match of block.matchAll(/countState\("([A-Z]\d+)"\)\s*===\s*"(\w+)"/g)) {
    out.push({ id: match[1], state: match[2] });
  }
  return out;
}

/** 去整行注释：注释里出现的选择器/说明不能当成代码位置。 */
export function stripComments(block) {
  return block
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

/** 只改某个 runner 代码块，其余源码原样拼回（变异要精确落在目标块里）。 */
export function mutateBlock(source, name, mutate) {
  const chunks = source.split(/\nexport async function /);
  const index = chunks.findIndex((chunk) => chunk.startsWith(`${name}(`));
  if (index < 0) return source;
  const changed = mutate(chunks[index]);
  if (changed === chunks[index]) return source;
  return [
    ...chunks.slice(0, index),
    changed,
    ...chunks.slice(index + 1),
  ].join("\nexport async function ");
}

/** 判据（纯函数）：输入 batchDiag.ts 源码，返回失败项列表。 */
export function judge(source) {
  const failures = [];
  const s030104 = runnerBlock(source, "runS030104Diagnostics");
  const s030201 = runnerBlock(source, "runS030201Diagnostics");
  if (!s030104) failures.push("batchDiag.ts 缺 runS030104Diagnostics");
  if (!s030201) failures.push("batchDiag.ts 缺 runS030201Diagnostics");
  if (failures.length > 0) return failures;

  // A. s030104：full/added 只能落在可操作指标上；planned 断言必须真的是规划项
  for (const { id, state } of assertedStates(s030104)) {
    const item = registry.get(id);
    if (!item) {
      failures.push(`s030104 断言的指标 ${id} 不在注册表里`);
      continue;
    }
    if (state === "added" || state === "full") {
      if (item.status !== "normal") {
        failures.push(
          `s030104 断言 ${id} 处于「${state}」态，但注册表 status=${item.status}` +
            "（planned 指标永远到不了 added/full → 等待必然超时）",
        );
      }
      if (item.panel !== "副") {
        failures.push(
          `s030104 断言 ${id} 处于「${state}」态，但注册表 panel=${item.panel}（卡面口径为副图指标）`,
        );
      }
    }
    if (state === "planned" && item.status !== "planned") {
      failures.push(`s030104 断言 ${id} 处于「planned」态，但注册表 status=${item.status}（规划项覆盖失真）`);
    }
  }

  // 副图已满的断言目标必须有对应的「加入图表」按钮选择器（断言对象 = 点按对象）
  const fullTarget = assertedStates(s030104).find((entry) => entry.state === "full");
  if (!fullTarget) failures.push("s030104 没有断言「副图已满（full）」的 check");
  else if (!s030104.includes(`[data-catalog-add="${fullTarget.id}"]`)) {
    failures.push(`s030104 的 full 断言目标 ${fullTarget.id} 没有对应的「加入图表」按钮选择器`);
  }

  // 「加入图表 → 按钮转 added」的点按目标必须与断言目标一致（不能点 A 断言 B）。
  // 「added」有两个来源：已在图表内（补3 的 M06，无点按）与点按后转入（P01-R5 的 OBV），
  // 因此要求：每个 added 断言目标都有对应按钮选择器，且至少有一个 added 目标被点按。
  const addedTargets = assertedStates(s030104).filter((entry) => entry.state === "added");
  if (addedTargets.length === 0) {
    failures.push("s030104 没有断言「已加入（added）」的 check");
  } else {
    for (const target of addedTargets) {
      if (!s030104.includes(`[data-catalog-add="${target.id}"]`)) {
        failures.push(`s030104 的 added 断言目标 ${target.id} 没有对应的按钮选择器`);
      }
    }
    const clicked = addedTargets.filter((target) =>
      new RegExp(`\\[data-catalog-add="${target.id}"\\][^;]*\\.click\\(\\)`).test(stripComments(s030104)),
    );
    if (clicked.length === 0) {
      failures.push("s030104 没有点按任一「已加入」断言目标的「加入图表」按钮（点按目标与断言目标不一致）");
    }
  }

  // B. s030201：星标目标的行必须可点（非默认展开分类 → 必须先展开全部分类）
  const starMatch = s030201.match(/\[data-fav-star="([A-Z]\d+)"\]/);
  if (!starMatch) failures.push("s030201 找不到星标选择器 [data-fav-star]");
  else {
    const id = starMatch[1];
    const item = registry.get(id);
    if (!item) failures.push(`s030201 星标目标 ${id} 不在注册表里`);
    else {
      const code = stripComments(s030201);
      const expandAt = code.indexOf("expandAllCategories()");
      const starAt = code.indexOf('[data-fav-star="');
      if (expandAt < 0) {
        failures.push(
          `s030201 星标 ${id}（分类=${item.category}）未先展开全部分类：` +
            "目录按分类懒挂载行，分类未展开时星标按钮不在 DOM 里",
        );
      } else if (expandAt > starAt) {
        failures.push(`s030201 在展开全部分类之前就点了 ${id} 的星标`);
      }
    }
  }

  return failures;
}

const source = read(BATCH);
const failures = judge(source);
for (const message of failures) console.error(`FAIL ${message}`);

// —— 反例（第 29 条）：变异 runner 必须判红 ——
// 变异①：把「副图已满」的断言目标改回 M03（planned）→ 卡面/产品口径不成立，必须红。
const mutantA = source.replace(/countState\("(?!M03)([A-Z]\d+)"\) === "full"/, 'countState("M03") === "full"');
if (mutantA === source) {
  console.error('FAIL 反例①未落到源码上：找不到 countState(...) === "full" 断言');
  process.exit(1);
}
const aFailures = judge(mutantA);
if (aFailures.length === 0) {
  console.error("FAIL 反例①未判红：把 full 断言目标换成 planned 指标 M03 仍然全绿 = 恒真断言");
  process.exit(1);
}
console.log(`反例①：变异 full 断言目标 → M03（planned）→ 判红 ${aFailures.length} 项`);

// 变异②：删掉 s030201 的 expandAllCategories() → 星标目标行不在 DOM，必须红。
const mutantB = mutateBlock(source, "runS030201Diagnostics", (block) =>
  block.replace(/\n\s*await expandAllCategories\(\);/, ""),
);
if (mutantB === source) {
  console.error("FAIL 反例②未落到源码上：找不到 await expandAllCategories()");
  process.exit(1);
}
const bFailures = judge(mutantB);
if (bFailures.length === 0) {
  console.error("FAIL 反例②未判红：删掉 expandAllCategories() 仍然全绿 = 恒真断言");
  process.exit(1);
}
console.log(`反例②：变异删除 s030201 的 expandAllCategories() → 判红 ${bFailures.length} 项`);

// 变异③：把「加入图表 → 按钮转 added」的点按目标改回 M03（planned）→ 必须红。
const mutantC = mutateBlock(source, "runS030104Diagnostics", (block) =>
  block.replace(/\[data-catalog-add="D01"\]/, '[data-catalog-add="M03"]'),
);
if (mutantC === source) {
  console.error('FAIL 反例③未落到源码上：找不到 [data-catalog-add="D01"]');
  process.exit(1);
}
const cFailures = judge(mutantC);
if (cFailures.length === 0) {
  console.error("FAIL 反例③未判红：把 added 点按目标换成 planned 指标 M03 仍然全绿 = 恒真断言");
  process.exit(1);
}
console.log(`反例③：变异 added 点按目标 → M03（planned）→ 判红 ${cFailures.length} 项`);

if (failures.length > 0) {
  console.error(`verify:catalog-runner 失败：${failures.length} 项`);
  process.exit(1);
}
console.log(
  "verify:catalog-runner 通过：s030104 的 full/added 只落 normal+副图指标、planned 覆盖保留、" +
    "点按目标与断言目标一致；s030201 星标前已展开全部分类 + 反例①②判红",
);
