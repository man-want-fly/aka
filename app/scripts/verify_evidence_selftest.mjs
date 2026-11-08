/**
 * verify_evidence.mjs 负例自测（制度第 29 条：派生/校验逻辑必须配「会让它错」的反例）。
 *
 * 覆盖 W-89 新增判据：
 *   - 合法基线 → exit 0（electron="none" 记通过）；
 *   - 手改 meta.commit → exit 1；
 *   - 缺 env.runtime → exit 1；
 *   - 缺 meta.dump.finishedAt → exit 1；
 *   - 缺 windowFocused / appActive=false → exit 1；
 *   - binary.sha256 非法 → exit 1；
 *   - electron=null / 缺键 → exit 1；
 *   - dump.archived 不在归档根 → exit 1；
 *   - s2 dump 缺 schema 键 → exit 1。
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
  checks,
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
  verification: {},
  telemetry: {},
});

const baseMeta = () => ({
  commit: "a".repeat(40),
  dirty: false,
  reproduce: "app/scripts/evidence-run.sh s2",
  result: { card: "S-02.06-01", layers: { runtime: "4/4" }, otherCards: [] },
  dump: { archived: "docs/qa/raw/s2-evidence.json", sha256: ZERO64, finishedAt: FINISHED },
});

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
  ["appActive=false", (evidence) => { evidence.appActive = false; }, 1],
  ["binary.sha256 非法", (evidence) => { evidence.env.build.binary.sha256 = "xyz"; }, 1],
  ["electron=null", (evidence) => { evidence.env.runtime.electron = null; }, 1],
  ["electron 缺键", (evidence) => { delete evidence.env.runtime.electron; }, 1],
  ["electron 非空字符串（非 none 也通过）", (evidence) => { evidence.env.runtime.electron = "v33.0.0"; }, 0],
  ["dump.archived 不在归档根", (evidence, meta) => { meta.dump.archived = "docs/qa/evidence/s2.json"; }, 1],
  ["s2 dump 缺 schema 键", (evidence) => { delete evidence.batchCompute; }, 1],
  ["env.dirty=true", (evidence) => { evidence.env.dirty = true; }, 1],
  ["env.commit 为空", (evidence) => { evidence.env.commit = ""; }, 1],
  ["command 为空", (evidence) => { evidence.env.command = ""; }, 1],
  ["hostTarget 为空", (evidence) => { evidence.env.runtime.hostTarget = ""; }, 1],
];

let failed = 0;
for (const [name, mutate, expected] of cases) {
  if (!runCase(name, mutate, expected)) failed += 1;
}

if (failed > 0) {
  console.error(`\n${failed} 个用例不符合预期`);
  process.exit(1);
}
console.log(`\n全部 ${cases.length} 个用例符合预期`);
