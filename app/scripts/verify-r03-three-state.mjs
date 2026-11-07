#!/usr/bin/env node
// W-74：涨跌幅三态判据负例。判据与页面共用 src/lib/changePct.ts，不重写第二套。
import { changePctMismatch, expectedChangePctText } from "../src/lib/changePct.ts";

const cases = [
  // [说明, 数据层 change_pct, DOM 文本, 期望是否红]
  ["对照：缺前收（null）渲成 —", null, "—", false],
  ["对照：平盘（0）渲成 0.00%", 0, "0.00%", false],
  ["对照：上涨 1.23%", 1.23, "+1.23%", false],
  ["对照：下跌 −1.23%", -1.23, "\u22121.23%", false],
  ["必红：平盘渲成 —", 0, "—", true],
  ["必红：缺前收渲成 0.00%", null, "0.00%", true],
  ["必红：平盘渲成 +0.00%", 0, "+0.00%", true],
  ["必红：涨跌不带符号", 1.23, "1.23%", true],
  ["必红：两位小数写错", -1.23, "\u22121.2%", true],
];

let bad = 0;
for (const [name, value, dom, wantRed] of cases) {
  const mismatch = changePctMismatch(value, dom);
  const isRed = mismatch !== null;
  const ok = isRed === wantRed;
  if (!ok) bad += 1;
  const expectedText = expectedChangePctText(value);
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}｜数据=${value === null ? "null" : value} 期望文本="${expectedText}" ` +
      `DOM="${dom}" 判红=${isRed}｜${mismatch ?? "一致"}`,
  );
}

console.log(`\n涨跌幅三态判据：${cases.length - bad}/${cases.length} 符合期望`);
process.exit(bad === 0 ? 0 : 1);
