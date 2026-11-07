// S-02.05-02 两段启动证据合并：A/B 两份 JSON 各自只覆盖 2/4 AC，
// 合并结果与卡级分母必须由脚本现算，不能靠人在 meta 里手写 4/4。
import { readFileSync, writeFileSync } from "node:fs";

const [phaseAPath, phaseBPath, outPath] = process.argv.slice(2);
if (!outPath) {
  console.error("用法：node merge-restart-evidence.mjs <phase-a.json> <phase-b.json> <merged.json>");
  process.exit(1);
}

const CARD = "S-02.05-02";
/** 卡面 AC 全集，顺序与重启套件一致。 */
const CARD_ACS = [
  "AC-02.05-04",
  "AC-02.05-04（补1）",
  "AC-02.05-04（补2）",
  "AC-02.05-04（补3）",
];

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const a = read(phaseAPath);
const b = read(phaseBPath);
const checks = [...(a.checks ?? []), ...(b.checks ?? [])];

const ids = new Set();
for (const check of checks) {
  if (ids.has(check.id)) {
    console.error(`重复检查项 ${check.id}：两段证据不能重叠`);
    process.exit(1);
  }
  ids.add(check.id);
}

const layers = {};
for (const check of checks) {
  const [passed, total] = (layers[check.layer] ?? "0/0").split("/").map(Number);
  layers[check.layer] = `${passed + (check.passed ? 1 : 0)}/${total + 1}`;
}

const covered = CARD_ACS.filter((ac) => checks.some((check) => check.ac === ac && check.passed));
const cardSummary = {
  card: CARD,
  checks: `${checks.filter((check) => check.passed).length}/${checks.length}`,
  layers,
  acCovered: `${covered.length}/${CARD_ACS.length}`,
  coveredAcs: covered,
  uncoveredAcs: CARD_ACS.filter((ac) => !covered.includes(ac)),
};

const merged = {
  ok: Boolean(a.ok && b.ok) && checks.every((check) => check.passed),
  phase: "merged",
  cardSummary,
  mergedFrom: {
    phaseA: { file: phaseAPath.split("/").pop(), phase: a.phase, finishedAt: a.phaseA?.finishedAt ?? a.finishedAt ?? null },
    phaseB: { file: phaseBPath.split("/").pop(), phase: b.phase, finishedAt: b.finishedAt ?? null },
  },
  phaseA: a.phaseA ?? null,
  phaseB: b.phaseB ?? null,
  checks,
};

writeFileSync(outPath, `${JSON.stringify(merged, null, 2)}\n`);
console.log(
  `合并 ${checks.length} 条：${cardSummary.checks}，AC ${cardSummary.acCovered}，层 ${JSON.stringify(
    cardSummary.layers,
  )}`,
);
