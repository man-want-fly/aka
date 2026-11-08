/**
 * S-02.01-01 报价头取证（AC-02.01-01 补2 / 补3 / 补4）。
 *
 * 数据层：涨跌停推导为纯函数（`quote.ts`），校验 10.00→11.00/9.00、10.03→11.03/9.03，
 *   以及 `≈` 的四个前提（板块非空、未停牌、非上市前 5 日、价格可推导）。
 * 渲染层：全部通过真实 DOM 断言——驱动真实标的切换，读 `[data-limit-row]` 的文本与 `title`，
 *   覆盖主板 / 停牌 / 指数 / 无昨收四个场景（AC-02.01-01 补2/补3/补4）。
 * 运行时：本卡无时间阈值断言，运行层 0 项。
 */

import { ipc } from "../../lib/ipc";
import {
  LIMIT_APPROX_TITLE,
  deriveLimitPrices,
  showLimitApprox,
} from "./quote";

interface Check {
  id: string;
  ac: string;
  layer: "data" | "render";
  passed: boolean;
  detail: string;
}

export interface S20101Hooks {
  setCode: (code: string) => void;
  waitRendered: (code: string, timeoutMs?: number) => Promise<void>;
}

const LIMIT_CODE_1000 = "DIAGQ10.SZ";
const LIMIT_CODE_1003 = "DIAGQ1003.SZ";
const SUSPENDED_CODE = "DIAGQSUP.SZ";
const NEW_LISTING_CODE = "DIAGQNEW.SZ";
const INDEX_CODE = "000300.SH";

const q = <T extends Element>(selector: string) => document.querySelector<T>(selector);
const qa = <T extends Element>(selector: string) =>
  Array.from(document.querySelectorAll<T>(selector));

const textOf = (selector: string) => q(selector)?.textContent?.trim() ?? "";

const readLimitRow = () => {
  const up = q('[data-limit-price="up"]');
  const down = q('[data-limit-price="down"]');
  const row = q('[data-limit-row="1"]');
  return {
    up: up?.textContent?.trim() ?? "",
    down: down?.textContent?.trim() ?? "",
    upTitle: up?.getAttribute("title") ?? "",
    downTitle: down?.getAttribute("title") ?? "",
    rowText: row?.textContent ?? "",
    approxFlag: row?.getAttribute("data-limit-approx") ?? "",
    hasApprox: (row?.textContent ?? "").includes("≈"),
    prevClose: textOf('[data-quote-prev-close="1"]'),
  };
};

const describeRow = (row: ReturnType<typeof readLimitRow>) =>
  `涨停「${row.up}」/ 跌停「${row.down}」· title=${JSON.stringify(
    row.upTitle,
  )} · 整行 ≈=${row.hasApprox ? "有" : "无"} · 昨收「${row.prevClose}」`;

export async function runS20101Diagnostics(hooks: S20101Hooks) {
  const checks: Check[] = [];
  const push = (
    id: string,
    ac: string,
    layer: Check["layer"],
    passed: boolean,
    detail: string,
  ) => checks.push({ id, ac, layer, passed, detail });
  const attempt = async (
    id: string,
    ac: string,
    layer: Check["layer"],
    run: () => Promise<{ passed: boolean; detail: string }>,
  ) => {
    try {
      const result = await run();
      push(id, ac, layer, result.passed, result.detail);
    } catch (err) {
      push(
        id,
        ac,
        layer,
        false,
        `异常：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // ---------------- 数据层：纯函数口径 ----------------
  const ten = deriveLimitPrices(10.0, "深主板");
  push(
    "D-01",
    "AC-02.01-01（补2）",
    "data",
    ten !== null && ten.up === 11 && ten.down === 9,
    `主板 10% · 前收 10.00 → ${ten ? `${ten.up.toFixed(2)} / ${ten.down.toFixed(2)}` : "null"}`,
  );

  const tenThree = deriveLimitPrices(10.03, "深主板");
  push(
    "D-02",
    "AC-02.01-01（补3）",
    "data",
    tenThree !== null &&
      tenThree.up === 11.03 &&
      tenThree.down === 9.03 &&
      tenThree.up.toFixed(2) === "11.03" &&
      tenThree.down.toFixed(2) === "9.03",
    `主板 10% · 前收 10.03 → ${
      tenThree ? `${tenThree.up.toFixed(2)} / ${tenThree.down.toFixed(2)}` : "null"
    }（两位小数）`,
  );

  push(
    "D-03",
    "AC-02.01-01（补2）",
    "data",
    showLimitApprox({ board: "深主板", isIndex: false, suspended: false, prices: ten }) ===
      true &&
      showLimitApprox({ board: "", isIndex: false, suspended: false, prices: ten }) ===
        false &&
      showLimitApprox({ board: "深主板", isIndex: false, suspended: true, prices: ten }) ===
        false &&
      showLimitApprox({ board: "指数", isIndex: true, suspended: false, prices: ten }) ===
        false &&
      showLimitApprox({ board: "深主板", isIndex: false, suspended: false, prices: null }) ===
        false,
    "≈ 前置条件：板块空 / 停牌 / 指数 / 价格不可推导 → 均不得展示 ≈",
  );

  // ---------------- 渲染层：真实 DOM ----------------
  await attempt("R-01", "AC-02.01-01（补2）", "render", async () => {
    hooks.setCode(LIMIT_CODE_1000);
    await hooks.waitRendered(LIMIT_CODE_1000);
    const row = readLimitRow();
    const passed =
      row.up === "≈11.00" &&
      row.down === "≈9.00" &&
      row.upTitle === LIMIT_APPROX_TITLE &&
      row.downTitle === LIMIT_APPROX_TITLE &&
      row.hasApprox &&
      row.approxFlag === "1" &&
      row.prevClose === "昨收10.00";
    return { passed, detail: `${LIMIT_CODE_1000} · ${describeRow(row)}` };
  });

  await attempt("R-02", "AC-02.01-01（补3）", "render", async () => {
    hooks.setCode(LIMIT_CODE_1003);
    await hooks.waitRendered(LIMIT_CODE_1003);
    const row = readLimitRow();
    const twoDigits = /^≈\d+\.\d{2}$/;
    const passed =
      row.up === "≈11.03" &&
      row.down === "≈9.03" &&
      twoDigits.test(row.up) &&
      twoDigits.test(row.down) &&
      row.upTitle === LIMIT_APPROX_TITLE &&
      row.downTitle === LIMIT_APPROX_TITLE &&
      row.prevClose === "昨收10.03";
    return { passed, detail: `${LIMIT_CODE_1003} · ${describeRow(row)}` };
  });

  await attempt("R-03", "AC-02.01-01（补4）", "render", async () => {
    hooks.setCode(INDEX_CODE);
    await hooks.waitRendered(INDEX_CODE);
    const row = readLimitRow();
    const passed =
      row.up === "—" &&
      row.down === "—" &&
      !row.hasApprox &&
      row.upTitle === "" &&
      row.downTitle === "" &&
      row.approxFlag === "0";
    return { passed, detail: `指数 ${INDEX_CODE} · ${describeRow(row)}` };
  });

  await attempt("R-04", "AC-02.01-01（补4）", "render", async () => {
    hooks.setCode(SUSPENDED_CODE);
    await hooks.waitRendered(SUSPENDED_CODE);
    const row = readLimitRow();
    const badge = q('[data-quote-suspended="1"]');
    const passed =
      row.up === "—" &&
      row.down === "—" &&
      !row.hasApprox &&
      row.upTitle === "" &&
      row.downTitle === "" &&
      row.approxFlag === "0" &&
      badge !== null;
    return {
      passed,
      detail: `停牌 ${SUSPENDED_CODE} · ${describeRow(row)} · 停牌徽标=${
        badge ? "有" : "无"
      }`,
    };
  });

  await attempt("R-05", "AC-02.01-01（补4）", "render", async () => {
    hooks.setCode(NEW_LISTING_CODE);
    await hooks.waitRendered(NEW_LISTING_CODE);
    const row = readLimitRow();
    const passed =
      row.up === "—" &&
      row.down === "—" &&
      !row.hasApprox &&
      row.upTitle === "" &&
      row.downTitle === "" &&
      row.approxFlag === "0" &&
      row.prevClose === "昨收—";
    return { passed, detail: `无昨收 ${NEW_LISTING_CODE} · ${describeRow(row)}` };
  });

  // 残留检查：整行任何位置都不应出现 ≈ 的误用（指数/停牌/无昨收三个场景已逐一覆盖）
  const leftoverApprox = qa('[data-limit-row="1"]').filter((row) =>
    (row.textContent ?? "").includes("≈"),
  ).length;

  const summary = (["data", "render"] as const).map((layer) => {
    const list = checks.filter((check) => check.layer === layer);
    return `${layer} ${list.filter((check) => check.passed).length}/${list.length}`;
  });
  summary.push("runtime 0/0");

  const report = {
    ok: checks.every((check) => check.passed),
    finishedAt: new Date().toISOString(),
    summary,
    leftoverApproxRows: leftoverApprox,
    checks,
  };
  await ipc.diagWriteNamed("s20101-evidence.json", JSON.stringify(report, null, 2));
  return report;
}
