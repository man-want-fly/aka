/**
 * verify_evidence.mjs 负例自测（制度第 29 条：派生/校验逻辑必须配「会让它错」的反例）。
 *
 * 覆盖 W-89 新增判据：
 *   - 合法基线 → exit 0（electron="none" 记通过）；
 *   - 手改 meta.commit → exit 1；
 *   - 缺 env.runtime → exit 1；
 *   - 缺 meta.dump.finishedAt / 与 dump 顶层不等 → exit 1；
 *   - 缺 windowFocused / appActive=false → exit 1 / 0；
 *   - binary.sha256 非法 → exit 1；
 *   - electron=null / 缺键 / 非 none → exit 1；
 *   - dump.archived 不在归档根 → exit 1；
 *   - s2 dump 缺 schema 键 → exit 1；
 *   - meta.dirty 与 env.dirty 不一致 / 非布尔 / true → exit 1；
 *   - meta.runtime / meta.build / meta.command 与 dump.env 不一致 → exit 1。
 *
 * 用法：node scripts/verify_evidence_selftest.mjs
 * 退出码：0 = 所有用例符合预期；1 = 有用例不符合。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERIFY = path.join(HERE, "verify_evidence.mjs");
const ZERO64 = "0".repeat(64);
const FINISHED = "2026-11-08T03:20:00.000Z";

const checks = [
  {
    id: "s20601-event-count-burst120",
    card: "S-02.06-01",
    ac: "AC-02.06-01",
    layer: "runtime",
    passed: true,
    detail: "连键 1→12→120：请求 1 次",
  },
  {
    id: "s20601-event-count-burst60",
    card: "S-02.06-01",
    ac: "AC-02.06-01",
    layer: "runtime",
    passed: true,
    detail: "连键 1→12→60：请求 1 次",
  },
  {
    id: "s20601-batch-cold",
    card: "S-02.06-01",
    ac: "AC-02.06-01",
    layer: "runtime",
    passed: true,
    detail: "冷缓存批次",
  },
  {
    id: "s20601-batch-warm",
    card: "S-02.06-01",
    ac: "AC-02.06-01",
    layer: "runtime",
    passed: true,
    detail: "热缓存批次",
  },
];

const baseEvidence = () => ({
  schemaVersion: 1,
  kind: "aka-s2-evidence",
  suite: "s2",
  ok: true,
  checksOk: true,
  catalogOk: true,
  checks: checks.map((check) => ({ ...check })),
  env: {
    commit: "a".repeat(40),
    dirty: false,
    runtime: {
      launchMode: "cargo+custom-protocol",
      node: "v22.11.0",
      os: "macOS",
      arch: "x86_64",
      hostTarget: "tauri-webkit(x86_64-apple-darwin)",
      electron: "none",
    },
    build: {
      entry: "dist/index.html",
      builtAt: FINISHED,
      cargoProfile: "dev",
      features: ["tauri/custom-protocol"],
      binary: { path: "/tmp/aka-desktop", sha256: ZERO64 },
    },
    command: "AKA_DIAG=1 AKA_DIAG_TARGET=\"s2\" /tmp/aka-desktop",
  },
  windowFocused: true,
  appActive: true,
  generatedAt: FINISHED,
  finishedAt: FINISHED,
  build: { buildProfile: "dev" },
  dataset: {},
  engine: {},
  debounce: {},
  cold: {},
  warm: {},
  batchCompute: {},
  timeframes: {},
  // 判定分层（第 10 条）：ok=产品断言，signable=断言∧聚焦。
  // 第 30 条：顶层汇总覆盖全部 verification 子块。
  verification: {
    renderLayer: { ok: true },
    b2Render: { assertionsOk: true, focusOk: true, signable: true, ok: true },
    b3Render: { ok: true },
    catalog: { ok: true },
  },
  verificationOk: true,
  telemetry: {},
});

const clone = (value) => JSON.parse(JSON.stringify(value));

// meta 的 runtime/build/command 必须是 dump.env 的副本（W-89 第 3 项），基线按同一对象生成。
const baseMeta = () => {
  const evidence = baseEvidence();
  return {
    commit: evidence.env.commit,
    dirty: evidence.env.dirty,
    runtime: clone(evidence.env.runtime),
    build: clone(evidence.env.build),
    command: evidence.env.command,
    reproduce: "app/scripts/evidence-run.sh s2",
    result: { card: "S-02.06-01", layers: { runtime: "4/4" }, otherCards: [] },
    dump: { archived: "docs/qa/raw/s2-evidence.json", sha256: ZERO64, finishedAt: FINISHED },
  };
};

const writeCase = (dir, evidence, meta) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "s2-selftest.json"), JSON.stringify(evidence, null, 2));
  fs.writeFileSync(path.join(dir, "s2-selftest-meta.json"), JSON.stringify(meta, null, 2));
};

const runCase = (name, mutate, expectedExit) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aka-evidence-selftest-"));
  const evidence = baseEvidence();
  const meta = baseMeta();
  mutate(evidence, meta);
  writeCase(dir, evidence, meta);
  const proc = spawnSync(process.execPath, [VERIFY, `--dir=${dir}`], { encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
  const actual = proc.status;
  if (actual !== expectedExit) {
    console.error(
      `✗ ${name}: 期望 exit ${expectedExit}，实际 exit ${actual}\n` +
        `${(proc.stderr || proc.stdout || "").trim()}`,
    );
    return false;
  }
  console.log(`✓ ${name}: exit ${actual}`);
  return true;
};

const cases = [
  ["合法基线（electron=none 记通过）", () => {}, 0],
  ["手改 meta.commit", (evidence, meta) => { meta.commit = "b".repeat(40); }, 1],
  ["缺 env.runtime", (evidence) => { delete evidence.env.runtime; }, 1],
  ["缺 meta.dump.finishedAt", (evidence, meta) => { delete meta.dump.finishedAt; }, 1],
  ["meta.dump.finishedAt 与 dump 不等", (evidence, meta) => { meta.dump.finishedAt = "2026-11-08T04:00:00.000Z"; }, 1],
  ["缺 windowFocused", (evidence) => { delete evidence.windowFocused; }, 1],
  ["appActive=false（记不可判定，不判证据失败）", (evidence) => {
    evidence.appActive = false;
    evidence.verification.b2Render.focusOk = false;
    evidence.verification.b2Render.signable = false;
  }, 0],
  ["binary.sha256 非法", (evidence) => { evidence.env.build.binary.sha256 = "xyz"; }, 1],
  ["electron=null", (evidence) => { evidence.env.runtime.electron = null; }, 1],
  ["electron 缺键", (evidence) => { delete evidence.env.runtime.electron; }, 1],
  ["electron 非 none（如 v33，Electron 宿主证据无效）", (evidence) => { evidence.env.runtime.electron = "v33.0.0"; }, 1],
  ["dump.archived 不在归档根", (evidence, meta) => { meta.dump.archived = "docs/qa/evidence/s2.json"; }, 1],
  ["s2 dump 缺 schema 键", (evidence) => { delete evidence.batchCompute; }, 1],
  ["env.dirty=true", (evidence) => { evidence.env.dirty = true; }, 1],
  ["env.commit 为空", (evidence) => { evidence.env.commit = ""; }, 1],
  ["command 为空", (evidence) => { evidence.env.command = ""; }, 1],
  ["hostTarget 为空", (evidence) => { evidence.env.runtime.hostTarget = ""; }, 1],
  // W-89 第 1 项：meta.dirty 与 env.dirty 必须同源同值且为 false。
  ["meta.dirty=true（自污染）", (evidence, meta) => { meta.dirty = true; }, 1],
  ["meta.dirty 非布尔", (evidence, meta) => { meta.dirty = "false"; }, 1],
  // W-89 第 3 项：meta.runtime / meta.build / meta.command 必须是 dump.env 的副本。
  ["缺 meta.runtime", (evidence, meta) => { delete meta.runtime; }, 1],
  ["meta.runtime.electron=null（env=none）", (evidence, meta) => { meta.runtime.electron = null; }, 1],
  ["meta.runtime.node 漂移", (evidence, meta) => { meta.runtime.node = "v20.0.0"; }, 1],
  ["顶层 meta.electron=null", (evidence, meta) => { meta.electron = null; }, 1],
  ["顶层 meta.electron 与 runtime 冲突", (evidence, meta) => { meta.electron = "v33.0.0"; }, 1],
  ["缺 meta.build", (evidence, meta) => { delete meta.build; }, 1],
  ["meta.build.binary.sha256 漂移", (evidence, meta) => { meta.build.binary.sha256 = "1".repeat(64); }, 1],
  ["meta.command 为空", (evidence, meta) => { meta.command = ""; }, 1],
  ["meta.command 与 env.command 不等", (evidence, meta) => { meta.command = "AKA_DIAG=1 something-else"; }, 1],
  // R-EV-02 不再由「写不写 reproduce」自免：缺 reproduce 一律红（兼容只能靠冻结白名单）。
  ["缺 meta.reproduce（不得自免 R-EV-02）", (evidence, meta) => { delete meta.reproduce; }, 1],
  ["meta.reproduce 为空", (evidence, meta) => { meta.reproduce = "   "; }, 1],
  ["缺 env 块（名单外文件不得自免 R-EV-02）", (evidence) => { delete evidence.env; }, 1],
  // b2Render 判定分层：ok 只等于 assertionsOk；signable 是唯一可签判据。
  ["缺 verification.b2Render", (evidence) => { delete evidence.verification.b2Render; }, 1],
  ["b2Render.ok 混入聚焦（assertionsOk=true 却 ok=false）", (evidence) => { evidence.verification.b2Render.ok = false; }, 1],
  ["b2Render.signable 派生不一致", (evidence) => { evidence.verification.b2Render.signable = false; }, 1],
  ["b2Render.focusOk 与顶层聚焦不一致", (evidence) => { evidence.verification.b2Render.focusOk = false; }, 1],
  ["未聚焦：断言通过但 signable=false（记不可判定，不判证据失败）", (evidence) => {
    evidence.windowFocused = false;
    evidence.verification.b2Render.focusOk = false;
    evidence.verification.b2Render.signable = false;
  }, 0],
  // 第 30 条：顶层汇总必须覆盖全部 verification 子块（catalog 曾整块漏聚合）。
  ["缺 verification.catalog（汇总漏维度）", (evidence) => { delete evidence.verification.catalog; }, 1],
  ["catalog.ok=false 但顶层 ok/verificationOk 仍 true", (evidence) => { evidence.verification.catalog.ok = false; }, 1],
  ["verificationOk 与现算不一致", (evidence) => { evidence.verificationOk = false; }, 1],
  ["顶层 ok=true 但 checks 有失败", (evidence) => { evidence.checks[0].passed = false; }, 1],
  ["顶层 ok=false 但全部通过", (evidence) => { evidence.ok = false; }, 1],
  ["未知 verification 子块缺布尔 ok", (evidence) => { evidence.verification.extra = {}; }, 1],
  // 第 30 条单列字段：catalogOk / checksOk 必须存在且与现算一致（门禁可直接判读）。
  ["缺 catalogOk（目录维度未单列）", (evidence) => { delete evidence.catalogOk; }, 1],
  ["catalogOk 与 catalog.ok 不一致", (evidence) => { evidence.catalogOk = false; }, 1],
  ["缺 checksOk（checks 聚合未单列）", (evidence) => { delete evidence.checksOk; }, 1],
  ["checksOk 与现算不一致", (evidence) => { evidence.checksOk = false; }, 1],
  // 第 31 条：失败记录（error 非空 / blocked:true）不得充作证据根里的可签证据。
  ["证据根出现失败记录（error 非空）", (evidence) => { evidence.error = "Attempted to assign to readonly property."; }, 1],
  ["正常证据带 blocked[]（被阻塞 AC）不判红", (evidence) => {
    evidence.blocked = [{ ac: "AC-08.01-02", reason: "依赖 P7 全局搜索浮层，未实现" }];
  }, 0],
];

// 失败记录（raw/）：可查、不可签、不判红、不计证据份数。
const rawCases = [
  ["失败记录合规（raw，不判红）", () => {}, 0],
  ["失败记录缺失败原因", (dump) => { dump.blocked = true; delete dump.error; }, 1],
  ["失败记录缺 finishedAt", (dump) => { delete dump.finishedAt; }, 1],
  ["失败记录缺 suite", (dump) => { delete dump.suite; }, 1],
  ["失败记录 meta.dirty=true", (dump, meta) => { meta.dirty = true; }, 1],
];

const runRawCase = (name, mutate, expectedExit) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aka-evidence-selftest-"));
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), "aka-raw-selftest-"));
  writeCase(dir, baseEvidence(), baseMeta());
  const dump = {
    suite: "s070503",
    ok: false,
    finishedAt: FINISHED,
    blocked: [{ ac: "AC-07.05-04", blocker: "crash", reason: "Attempted to assign to readonly property." }],
    error: "Attempted to assign to readonly property.",
  };
  const meta = { suite: "s070503", commit: "a".repeat(40), dirty: false };
  mutate(dump, meta);
  fs.writeFileSync(path.join(raw, "s070503-evidence.json"), JSON.stringify(dump, null, 2));
  fs.writeFileSync(path.join(raw, "s070503-evidence-meta.json"), JSON.stringify(meta, null, 2));
  const proc = spawnSync(process.execPath, [VERIFY, `--dir=${dir}`, `--raw-dir=${raw}`], {
    encoding: "utf8",
  });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(raw, { recursive: true, force: true });
  const actual = proc.status;
  if (actual !== expectedExit) {
    console.error(
      `✗ ${name}: 期望 exit ${expectedExit}，实际 exit ${actual}\n` +
        `${(proc.stderr || proc.stdout || "").trim()}`,
    );
    return false;
  }
  if (!(proc.stdout || "").includes("失败记录")) {
    console.error(`✗ ${name}: 汇总行未单列「失败记录」（不可与证据份数混计）`);
    return false;
  }
  console.log(`✓ ${name}: exit ${actual}`);
  return true;
};

let failed = 0;
for (const [name, mutate, expected] of cases) {
  if (!runCase(name, mutate, expected)) failed += 1;
}
for (const [name, mutate, expected] of rawCases) {
  if (!runRawCase(name, mutate, expected)) failed += 1;
}

if (failed > 0) {
  console.error(`\n${failed} 个用例不符合预期`);
  process.exit(1);
}
console.log(`\n全部 ${cases.length + rawCases.length} 个用例符合预期`);
