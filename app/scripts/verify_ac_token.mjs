#!/usr/bin/env node
/**
 * AC token 静态门禁（W-105 预置，挂载方式待 TL 定）。
 *
 * 规则：app/src/features 下所有 *Diag.ts 里的 AC 字面量必须匹配卡面口径：
 *   ^AC-\d{2}\.\d{2}-\d{2}(（补\d+）)?$
 * 半角括号、空格分隔、带描述标签的写法一律判红，避免等取证跑到了才暴露。
 *
 * 用法：
 *   node scripts/verify_ac_token.mjs              # 扫描 src/features
 *   node scripts/verify_ac_token.mjs --selftest   # 第 29 条反例自证
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../src/features");

const AC_TOKEN = /^AC-\d{2}\.\d{2}-\d{2}(（补\d+）)?$/;
const LITERAL_PATTERNS = [/"([^"\n]*)"/g, /'([^'\n]*)'/g, /`([^`\n]*)`/g];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith("Diag.ts")) out.push(path);
  }
  return out;
}

function acLiterals(source) {
  const found = [];
  for (const pattern of LITERAL_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      if (match[1].startsWith("AC-")) {
        found.push({ value: match[1], index: match.index ?? 0 });
      }
    }
  }
  return found;
}

function check(root) {
  const violations = [];
  for (const file of walk(root).sort()) {
    const source = readFileSync(file, "utf8");
    for (const literal of acLiterals(source)) {
      if (AC_TOKEN.test(literal.value)) continue;
      const line = source.slice(0, literal.index).split("\n").length;
      violations.push(`${file}:${line}  ${literal.value}`);
    }
  }
  return violations;
}

function selftest() {
  const dir = mkdtempSync(join(tmpdir(), "aka-ac-token-"));
  try {
    const goodDir = join(dir, "good");
    const badDir = join(dir, "bad");
    mkdirSync(goodDir);
    mkdirSync(badDir);
    writeFileSync(
      join(goodDir, "goodDiag.ts"),
      'push("R-01", "AC-07.01-02（补3）", "render", true, "ok");\n',
    );
    writeFileSync(
      join(badDir, "badDiag.ts"),
      'push("R-02", "AC-07.01-02(补3)", "render", true, "ok");\n',
    );
    const good = check(goodDir);
    const bad = check(badDir);
    const halfWidth = bad.some((item) => item.includes("AC-07.01-02(补3)"));
    if (good.length !== 0 || bad.length !== 1 || !halfWidth) {
      console.error(`::error::verify:ac-token selftest 失败：good=${good.length} bad=${bad.length}`);
      process.exitCode = 1;
      return;
    }
    console.log("verify:ac-token:selftest 通过：全角正例变绿，半角反例变红");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv.includes("--selftest")) {
  selftest();
} else {
  const violations = check(ROOT);
  if (violations.length > 0) {
    for (const item of violations) console.error(`::error::AC token 不合规：${item}`);
    console.error(`verify:ac-token 失败：${violations.length} 处（要求全角「（补N）」）`);
    process.exitCode = 1;
  } else {
    console.log("verify:ac-token 通过：所有 *Diag.ts 的 AC 字面量均为卡面口径");
  }
}
