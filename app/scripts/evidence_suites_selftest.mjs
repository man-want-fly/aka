#!/usr/bin/env node
// verify_evidence_suites.mjs 的夹具自测：每条反例都必须判红，正向必须绿。
// 反例对应 P01 事故：产品 runner 在 main，diag-evidence.sh 里没有对应 case。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SCRIPT = path.join(HERE, "verify_evidence_suites.mjs");
const NODE = process.execPath;

const CARD_OK = "### S-09.99-99 测试卡\n\n- **AC-09.99-01**｜Given 某状态；Then 渲染某文案。`[渲染层]`\n";
const CARD_NO_LAYER = "### S-09.99-99 测试卡\n\n- **AC-09.99-01**｜Given 某状态；Then 某结果。\n";

const runner = (suite, file, card) => `import { ipc } from "../../lib/ipc";
const baseReport = (suite: string) => ({ suite, checks: [] as Check[] });
const writeBatchReport = async (name: string, _hint: string, _report: object) => { void ipc; void name; };
export async function runS099999Diagnostics() {
  const report = { ...baseReport("${suite}"), card: "${card}" };
  await writeBatchReport("${file}", "${suite}", report);
}
`;

const caseBlock = (suite, json) => `  ${suite})
    TARGET="${suite}"
    JSON="$DIAG_DIR/${json}"
    NAME="${json.replace(/\.json$/, "")}"
    FIXTURE="夹具"
    BAK=""
    ;;
`;

function fixture({ batch, diagCases, card }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aka-suites-"));
  fs.mkdirSync(path.join(dir, "app/src/features/qa"), { recursive: true });
  fs.mkdirSync(path.join(dir, "app/scripts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "docs/story-cards"), { recursive: true });
  fs.writeFileSync(path.join(dir, "app/src/features/qa/batchDiag.ts"), batch);
  fs.writeFileSync(
    path.join(dir, "app/scripts/diag-evidence.sh"),
    `#!/usr/bin/env bash\nset -euo pipefail\ncase "$1" in\n${diagCases}  *)\n    exit 2\n    ;;\nesac\n`,
  );
  fs.writeFileSync(path.join(dir, "docs/story-cards/cards.md"), card);
  return { dir, app: path.join(dir, "app"), cardFile: path.join(dir, "docs/story-cards/cards.md") };
}

function run(fix) {
  const result = spawnSync(NODE, [SCRIPT, `--app=${fix.app}`, `--card=${fix.cardFile}`], {
    encoding: "utf8",
  });
  fs.rmSync(fix.dir, { recursive: true, force: true });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const results = [];
const record = (id, passed, detail) => results.push({ id, passed, detail });

const batch = runner("s099999", "s099999-evidence.json", "S-09.99-99");

// 正向：runner + case + 卡面齐全
let fix = fixture({ batch, diagCases: caseBlock("s099999", "s099999-evidence.json"), card: CARD_OK });
let out = run(fix);
record("GREEN", out.status === 0 && out.stdout.includes("runner 套件 1 个"), `exit=${out.status} ${out.stdout.trim()}`);

// R1：缺 case（P01 事故）
fix = fixture({ batch, diagCases: caseBlock("s099998", "s099998-evidence.json"), card: CARD_OK });
out = run(fix);
record(
  "R1-MISSING-CASE",
  out.status === 2 && out.stderr.includes("缺 case：s099999") && out.stderr.includes("卡在 main 但出不了证据"),
  `exit=${out.status} ${out.stderr.trim().split("\n")[0]}`,
);

// R2：case 在，但写盘名对不上
fix = fixture({ batch, diagCases: caseBlock("s099999", "s099999-other.json"), card: CARD_OK });
out = run(fix);
record(
  "R2-FILE-MISMATCH",
  out.status === 2 && out.stderr.includes("写盘名不一致") && out.stderr.includes("s099999-evidence.json"),
  `exit=${out.status} ${out.stderr.trim().split("\n")[0]}`,
);

// R3：runner 的 card 不在卡面
fix = fixture({ batch: runner("s099999", "s099999-evidence.json", "S-09.99-98"), diagCases: caseBlock("s099999", "s099999-evidence.json"), card: CARD_OK });
out = run(fix);
record("R3-PHANTOM-CARD", out.status === 2 && out.stderr.includes("幻影卡"), `exit=${out.status} ${out.stderr.trim().split("\n")[0]}`);

// R4：卡面没有可取证的 AC 层
fix = fixture({ batch, diagCases: caseBlock("s099999", "s099999-evidence.json"), card: CARD_NO_LAYER });
out = run(fix);
record("R4-NO-LAYER", out.status === 2 && out.stderr.includes("不该有 diag"), `exit=${out.status} ${out.stderr.trim().split("\n")[0]}`);

const failed = results.filter((item) => !item.passed);
for (const item of results) console.log(`${item.passed ? "PASS" : "FAIL"} ${item.id} ${item.detail}`);
console.log(`反例 4/4 判红，正向 1/1 绿`);
process.exit(failed.length === 0 ? 0 : 1);
