#!/usr/bin/env node
// W-111：S-02.06-02 缓存回切判据负例。
// 判据与取证套件共用 src/features/workbench/warmCutback.ts，不重写第二套。
import {
  evaluateWarmCutback,
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

console.log(`\nS-02.06-02 缓存回切判据：${cases.length + 1 - bad}/${cases.length + 1} 符合期望`);
process.exit(bad === 0 ? 0 : 1);
