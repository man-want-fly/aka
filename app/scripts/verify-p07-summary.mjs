#!/usr/bin/env node
// W-103：P07-R3 汇总分子判据负例。判据与取证套件共用 src/features/qa/healthSummary.ts，不重写第二套。
import { healthSummaryMismatch } from "../src/features/qa/healthSummary.ts";

const STAMP = "2026-11-08 15:30:00";
const summary = (passed, total = 6, ms = 42) => `${passed}/${total} 通过 · 总耗时 ${ms} ms · ${STAMP}`;

const cases = [
  // [说明, manifestCorrupt, 汇总文本, 期望是否红]
  ["对照：默认数据集 6/6", false, summary(6), false],
  ["对照：corrupt 场景 1/6", true, summary(1), false],
  ["必红：corrupt 场景写成 6/6", true, summary(6), true],
  ["必红：默认数据集只有 1/6", false, summary(1), true],
  ["必红：默认数据集 5/6", false, summary(5), true],
  ["必红：corrupt 场景 0/6", true, summary(0), true],
  ["必红：分母不是 6", true, summary(1, 5), true],
  ["必红：缺总耗时", false, `6/6 通过 · ${STAMP}`, true],
  ["必红：时间缺秒", false, `6/6 通过 · 总耗时 42 ms · ${STAMP.slice(0, 16)}`, true],
];

let bad = 0;
for (const [name, manifestCorrupt, text, wantRed] of cases) {
  const mismatch = healthSummaryMismatch(manifestCorrupt, text);
  const isRed = mismatch !== null;
  const ok = isRed === wantRed;
  if (!ok) bad += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}｜manifestCorrupt=${manifestCorrupt} 汇总="${text}" ` +
      `判红=${isRed}｜${mismatch ?? "符合期望"}`,
  );
}

console.log(`\nP07 汇总分子判据：${cases.length - bad}/${cases.length} 符合期望`);
process.exit(bad === 0 ? 0 : 1);
