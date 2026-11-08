#!/usr/bin/env node
// W-111：S-02.06-02 缓存回切判据负例。
// 判据与取证套件共用 src/features/workbench/warmCutback.ts，不重写第二套。
// W-114：补充两块可执行守卫——①签名新实现与旧实现逐位等价（防止改哈希=改断言）；
// ②计时序静态守卫（签名哈希必须在 totalMs 打点之后，移回计时窗口即红）。
import { readFileSync } from "node:fs";
import {
  evaluateWarmCutback,
  seriesSignature,
  WARM_CUTBACK_MAX_TOTAL_MS,
  WARM_CUTBACK_MIN_SAMPLES,
} from "../src/features/workbench/warmCutback.ts";

const base = {
  sampleCount: 90,
  allCacheHit: true,
  allPointwiseMatch: true,
  maxTotalMs: 120,
  computeCountDelta: 0,
};

const cases = [
  // [说明, 覆盖字段, 期望是否红]
  ["对照：max=120ms 判据全满足（边界内）", {}, false],
  ["对照：max=40ms 判据全满足", { maxTotalMs: 40 }, false],
  ["必红：maxMs=121（超 1ms）", { maxTotalMs: 121 }, true],
  ["必红：maxMs=291（W-111 历史实测）", { maxTotalMs: 291 }, true],
  ["必红：maxMs 非数值（NaN）", { maxTotalMs: Number.NaN }, true],
  ["必红：存在 cache miss", { allCacheHit: false }, true],
  ["必红：存在逐点不一致", { allPointwiseMatch: false }, true],
  ["必红：indicator.compute 新增 1 条", { computeCountDelta: 1 }, true],
  ["必红：样本 89 < 90", { sampleCount: 89 }, true],
];

let bad = 0;
const constantsOk =
  WARM_CUTBACK_MAX_TOTAL_MS === 120 && WARM_CUTBACK_MIN_SAMPLES === 90;
if (!constantsOk) bad += 1;
console.log(
  `${constantsOk ? "PASS" : "FAIL"} 判据常量｜maxTotalMs=${WARM_CUTBACK_MAX_TOTAL_MS}（应 120）` +
    ` minSamples=${WARM_CUTBACK_MIN_SAMPLES}（应 90）`,
);

for (const [name, override, wantRed] of cases) {
  const verdict = evaluateWarmCutback({ ...base, ...override });
  const isRed = verdict.passed === false;
  const ok = isRed === wantRed;
  if (!ok) bad += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}｜判红=${isRed}` +
      `｜${verdict.reasons.length > 0 ? verdict.reasons.join("；") : "判据全部满足"}`,
  );
}

// ---- ① 签名等价：旧实现（拼 parts 数组再 join）逐字复刻，只用于比对 ----
function legacyFnv1a(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function legacySeriesSignature(calc) {
  const parts = [];
  let points = 0;
  for (const series of calc.series) {
    parts.push(`${series.instanceId}|${series.indicatorId}|w${series.warmup}`);
    for (const output of series.outputs) {
      parts.push(output.key);
      for (const value of output.values) {
        if (value === null) {
          parts.push("n");
          continue;
        }
        points += 1;
        parts.push(value.toString());
      }
    }
  }
  return { hash: legacyFnv1a(parts.join(",")), points };
}

function makeSeries(instanceId, indicatorId, warmup, outputs) {
  return { instanceId, indicatorId, warmup, outputs };
}

function makeCalc(series) {
  return { series };
}

const equivalenceFixtures = [
  {
    name: "空序列",
    calc: makeCalc([]),
  },
  {
    name: "单实例单输出（含 null / 负数 / 指数 / -0）",
    calc: makeCalc([
      makeSeries("i0", "T01", 20, [
        { key: "v0", values: [1.5, null, -0.0000001, 1e21, 0, -0, 123.456789] },
      ]),
    ]),
  },
  {
    name: "多实例多输出（302 点）",
    calc: makeCalc(
      Array.from({ length: 3 }, (_, i) =>
        makeSeries(`i${i}`, `T0${i + 1}`, i * 5, [
          { key: "a", values: Array.from({ length: 50 }, (_, j) => (j % 9 === 0 ? null : (((i * 37 + j * 11) % 1000) - 500) / 7)) },
          { key: "b", values: Array.from({ length: 51 }, (_, j) => (((i * 53 + j * 17) % 700) - 350) / 9) },
        ]),
      ),
    ),
  },
  {
    name: "取证同规模（50 实例 × 790 点）",
    calc: makeCalc(
      Array.from({ length: 50 }, (_, i) =>
        makeSeries(`i${i}`, `T${i}`, 20, [
          { key: "v0", values: Array.from({ length: 790 }, (_, j) => (j % 7 === 0 ? null : (((i * 41 + j * 13) % 900) - 450) / 11)) },
        ]),
      ),
    ),
  },
];

for (const { name, calc } of equivalenceFixtures) {
  const next = seriesSignature(calc);
  const legacy = legacySeriesSignature(calc);
  const ok = next.hash === legacy.hash && next.points === legacy.points;
  if (!ok) bad += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} 签名等价｜${name}｜新 ${next.hash}/${next.points} vs 旧 ${legacy.hash}/${legacy.points}`,
  );
}

// ---- ② 计时序静态守卫：哈希不得回到计时窗口 ----
const pageSrc = readFileSync(
  new URL("../src/pages/workbench/WorkbenchPage.tsx", import.meta.url),
  "utf8",
);
const hashSrc = readFileSync(
  new URL("../src/features/workbench/warmCutback.ts", import.meta.url),
  "utf8",
);
const stamp = "const totalMs = performance.now() - startedAt;";
const hashCall = "const signature = seriesSignature(calcResult.value);";
const stampCount = pageSrc.split(stamp).length - 1;
const stampIndex = pageSrc.indexOf(stamp);
const hashIndex = pageSrc.indexOf(hashCall);
const ordered = stampCount === 1 && stampIndex >= 0 && hashIndex >= 0 && stampIndex < hashIndex;
// 反例形态：任一样本路径把 totalMs 写成现算（哈希之后现取）即判红
const lateStamp = pageSrc.includes("totalMs: performance.now() - startedAt");
const allocationFree = !hashSrc.includes("const parts") && !hashSrc.includes("parts.join(");
const guardsOk = ordered && !lateStamp && allocationFree;
if (!guardsOk) bad += 1;
console.log(
  `${guardsOk ? "PASS" : "FAIL"} 计时序守卫｜打点 ${stampCount} 处且早于哈希调用=${ordered}` +
    `｜totalMs 现算残留=${lateStamp}｜签名免分配=${allocationFree}`,
);

const totalChecks = cases.length + 1 + equivalenceFixtures.length + 1;
console.log(
  `\nS-02.06-02 缓存回切判据：${totalChecks - bad}/${totalChecks} 符合期望` +
    `（判据负例 ${cases.length} + 常量 ${1} + 签名等价 ${equivalenceFixtures.length} + 计时序守卫 1）`,
);
process.exit(bad === 0 ? 0 : 1);
