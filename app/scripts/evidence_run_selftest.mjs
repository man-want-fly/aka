#!/usr/bin/env node
/**
 * W-112 / W-94 自测：取证入口的分支判定与失败现场落盘。
 *
 * W-112：macOS 自带 bash 3.2 + set -u 下，`$branch` 后紧跟全角「）」会被吞进变量名，
 *   分支≠main 时报 `branch: unbound variable` 而不是 EVIDENCE_FAIL。本用例证明：
 *   - 分支≠main → exit 2 且输出 EVIDENCE_FAIL，**不得出现 unbound variable**；
 *   - 分支=main 的 --check 路径不被这次改动波及（仍输出 EVIDENCE_OK / exit 0）。
 *
 * W-94：失败/崩溃现场自动落归档根（docs/qa/raw 形状），字段可追因、meta 干净基线；
 *   产物是失败记录（ok=false / blocked=true），不计证据份数、不可签（第 31 条）。
 *
 * 用法：node scripts/evidence_run_selftest.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.join(HERE, "evidence-run.sh");
const RECORD = path.join(HERE, "record-evidence-failure.sh");
const LAYOUT = path.join(HERE, "evidence-layout.json");
// W-112 只在 macOS 自带 bash 3.2 上复现：必须钉住系统 bash，避免 PATH 上的新 bash 掩盖缺陷。
const BASH = fs.existsSync("/bin/bash") ? "/bin/bash" : "bash";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `：${detail}` : ""}`);
};

const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const git = (cwd, args) =>
  spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

const makeRunCase = (branchName, extraScripts = {}) => {
  const root = tmpDir("aka-evidence-run-");
  const app = path.join(root, "app");
  const scripts = path.join(app, "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(RUN, path.join(scripts, "evidence-run.sh"));
  fs.copyFileSync(LAYOUT, path.join(scripts, "evidence-layout.json"));
  for (const [name, body] of Object.entries(extraScripts)) {
    fs.writeFileSync(path.join(scripts, name), body, "utf8");
  }
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.email=qa@aka.local", "-c", "user.name=QA", "commit", "-qm", "selftest"]);
  if (branchName) git(root, ["checkout", "-q", "-b", branchName]);
  return root;
};

// —— W-112：分支≠main 必须走 EVIDENCE_FAIL ——
{
  const root = makeRunCase("feature-x");
  const proc = spawnSync(BASH, [path.join(root, "app/scripts/evidence-run.sh"), "s2", "--check"], {
    encoding: "utf8",
    env: { ...process.env, EVIDENCE_NODE: process.execPath },
  });
  const output = `${proc.stdout || ""}${proc.stderr || ""}`;
  check("W-112 分支≠main 退出码为 2", proc.status === 2, `实际 ${proc.status}`);
  check("W-112 分支≠main 输出 EVIDENCE_FAIL", output.includes("EVIDENCE_FAIL"), output.trim().split("\n")[0] ?? "");
  check("W-112 分支≠main 不得出现 unbound variable", !output.includes("unbound variable"));
  check("W-112 分支≠main 报出真实分支名", output.includes("feature-x"));
  fs.rmSync(root, { recursive: true, force: true });
}

// —— W-112 回归：main 分支的 --check 仍走正常路径 ——
{
  const root = makeRunCase(null, {
    "diag-evidence.sh": "#!/usr/bin/env bash\ncase \"${1:-}\" in\n  s2) exit 0;;\nesac\n",
  });
  const current = (git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout || "").trim();
  if (current !== "main") git(root, ["branch", "-m", "main"]);
  const proc = spawnSync(BASH, [path.join(root, "app/scripts/evidence-run.sh"), "s2", "--check"], {
    encoding: "utf8",
    env: { ...process.env, EVIDENCE_NODE: process.execPath },
  });
  const output = `${proc.stdout || ""}${proc.stderr || ""}`;
  check("W-112 main 分支 --check 退出码为 0", proc.status === 0, `${output.trim().split("\n")[0] ?? ""}（exit ${proc.status}）`);
  check("W-112 main 分支 --check 输出 EVIDENCE_OK", output.includes("EVIDENCE_OK"));
  fs.rmSync(root, { recursive: true, force: true });
}

// —— W-94：失败现场自动落 raw，字段可追因 ——
{
  const raw = tmpDir("aka-raw-failure-");
  const log = path.join(tmpDir("aka-log-"), "diag.log");
  fs.writeFileSync(log, "line1\nline2\nboom: tsc exited with code 7\n", "utf8");
  const commit = "b".repeat(40);
  const proc = spawnSync(
    BASH,
    [RECORD, raw, "s2", commit, "build:tsc", "7", "app/scripts/evidence-run.sh s2", "tsc --noEmit", log],
    { encoding: "utf8" },
  );
  check("W-94 落盘退出码为 0", proc.status === 0, (proc.stderr || "").trim());
  const files = fs.readdirSync(raw).sort();
  check("W-94 只落 dump + meta 两份", files.length === 2, files.join(", "));
  const jsonName = files.find((name) => /\.json$/.test(name) && !/-meta\.json$/.test(name)) ?? "";
  const metaName = files.find((name) => /-meta\.json$/.test(name)) ?? "";
  check("W-94 产物命名含 suite 与 commit 前缀", jsonName.startsWith("s2-failure-bbbbbbbbbbbb-"), jsonName);
  let dump = {};
  let meta = {};
  try {
    dump = JSON.parse(fs.readFileSync(path.join(raw, jsonName), "utf8"));
    meta = JSON.parse(fs.readFileSync(path.join(raw, metaName), "utf8"));
  } catch (error) {
    check("W-94 产物可解析", false, error.message);
  }
  check("W-94 记录为失败记录（ok=false / blocked=true）", dump.ok === false && dump.blocked === true);
  check("W-94 记录含失败步骤", dump.step === "build:tsc" && String(dump.error ?? "").includes("build:tsc"));
  check("W-94 记录含退出码", dump.exitCode === 7);
  check("W-94 记录含命令", dump.command === "app/scripts/evidence-run.sh s2" && dump.stepCommand === "tsc --noEmit");
  check("W-94 记录含失败时间", typeof dump.finishedAt === "string" && dump.finishedAt.length > 0);
  check("W-94 记录含日志尾部（崩溃现场可追）", String(dump.logTail ?? "").includes("boom: tsc exited with code 7"));
  check("W-94 meta 有干净基线与可追 commit", meta.dirty === false && /^[0-9a-f]{40}$/.test(String(meta.commit ?? "")));

  const bad = spawnSync(BASH, [RECORD, raw, "s2", "bad-commit", "build:tsc", "7", "cmd", "", ""], {
    encoding: "utf8",
  });
  check("W-94 非法 commit 被拒绝（不得写出不可追的记录）", bad.status === 2);
  fs.rmSync(raw, { recursive: true, force: true });
  fs.rmSync(path.dirname(log), { recursive: true, force: true });
}

const failed = results.filter((item) => !item.ok).length;
if (failed > 0) {
  console.error(`\n${failed} 个用例不符合预期`);
  process.exit(1);
}
console.log(`\n全部 ${results.length} 个用例符合预期`);
