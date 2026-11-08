import { ipc } from "../../lib/ipc";
import type { DatasetManifestDto } from "../../lib/types";
import { DATASET_SEGMENTS, datasetSegments } from "./datasetOverview";

interface Check {
  id: string;
  ac: string;
  layer: "data" | "render" | "runtime";
  passed: boolean;
  detail: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

const q = <T extends Element>(selector: string) => document.querySelector<T>(selector);

const segmentNodes = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-dataset-seg]"));

const readSegments = () => {
  const out: Record<string, { text: string; title: string; missing: string | undefined }> = {};
  for (const node of segmentNodes()) {
    const key = node.dataset.datasetSeg ?? "";
    out[key] = {
      text: node.textContent?.trim() ?? "",
      title: node.getAttribute("title") ?? "",
      missing: node.dataset.datasetMissing,
    };
  }
  return out;
};

const clickAttr = (selector: string) => {
  const button = q<HTMLButtonElement>(selector);
  if (!button) throw new Error(`找不到 ${selector}`);
  button.click();
};

/** S-02.08-01 数据集概览页脚：7 段、同源 manifest、口径切换只动对应段、sha 可复制。 */
export async function runS20801Diagnostics(options: { manifest: DatasetManifestDto }) {
  const checks: Check[] = [];
  const push = (id: string, ac: string, layer: Check["layer"], passed: boolean, detail: string) => {
    checks.push({ id, ac, layer, passed, detail });
  };
  const m = options.manifest;

  const shaOk = /^[0-9a-f]{64}$/.test(m.sha256);
  push(
    "D-01",
    "S-02.08-01 同源",
    "data",
    m.provider === "sim" &&
      m.rowCount === 62_400 &&
      m.coverageStart === "2023-01-02" &&
      m.coverageEnd === "2024-12-27" &&
      shaOk,
    `provider=${m.provider} · rowCount=${m.rowCount} · 区间=${m.coverageStart}~${m.coverageEnd} · sha256=${m.sha256.slice(0, 8)}…（64 位小写=${shaOk}）`,
  );

  await sleep(300);
  const first = readSegments();
  const keys = Object.keys(first);
  push(
    "R-01",
    "AC-02.08-01",
    "render",
    keys.length === 7 &&
      DATASET_SEGMENTS.every((key, index) => segmentNodes()[index]?.dataset.datasetSeg === key) &&
      first.provider?.text === "sim" &&
      first.version?.text === m.sha256.slice(0, 8) &&
      first.adj?.text === "前复权" &&
      first.timeframe?.text === "日线" &&
      first.range?.text === `${m.coverageStart} ~ ${m.coverageEnd}` &&
      first.rows?.text === "62,400 行" &&
      /^\d+\.\d+ms · (缓存命中|冷算)$/.test(first.calc?.text ?? "") &&
      first.version?.missing === "0",
    `段数=${keys.length} 顺序=${segmentNodes().map((n) => n.dataset.datasetSeg).join("/")} · ` +
      `${first.provider?.text} | ${first.version?.text} | ${first.adj?.text} | ${first.timeframe?.text} | ` +
      `${first.range?.text} | ${first.rows?.text} | ${first.calc?.text}`,
  );

  clickAttr('[data-adj-mode="none"]');
  await sleep(400);
  const afterAdj = readSegments();
  const adjRest = DATASET_SEGMENTS.filter((key) => key !== "adj" && key !== "calc").every(
    (key) => afterAdj[key]?.text === first[key]?.text,
  );
  push(
    "R-02",
    "AC-02.08-01（补2）",
    "render",
    afterAdj.adj?.text === "不复权" && adjRest,
    `复权段=${afterAdj.adj?.text} · 其余 5 段不变=${adjRest}（calc 除外，切换会重算）`,
  );

  clickAttr('[data-timeframe="W"]');
  await sleep(500);
  const afterTf = readSegments();
  const tfRest = DATASET_SEGMENTS.filter((key) => key !== "timeframe" && key !== "calc").every(
    (key) => afterTf[key]?.text === afterAdj[key]?.text,
  );
  push(
    "R-03",
    "AC-02.08-01（补2）",
    "render",
    afterTf.timeframe?.text === "周线" && tfRest,
    `周期段=${afterTf.timeframe?.text} · 其余 5 段不变=${tfRest}（calc 除外，切换会重算）`,
  );

  // sha 短码点击 → 复制完整 sha256；不依赖真实剪贴板，替换 writeText 捕获入参
  const originalClipboard = navigator.clipboard;
  let copied = "";
  const stub = {
    writeText: async (text: string) => {
      copied = text;
    },
  } as unknown as Clipboard;
  Object.defineProperty(navigator, "clipboard", { value: stub, configurable: true });
  try {
    segmentNodes().find((node) => node.dataset.datasetSeg === "version")?.click();
    await sleep(250);
    const toast = q("[data-sha-copied]");
    push(
      "R-04",
      "AC-02.08-01（补1）",
      "render",
      copied === m.sha256 && toast !== null,
      `剪贴板=${copied === m.sha256 ? "完整 64 位" : `不一致(${copied.length})`} · 提示=${toast?.textContent?.trim() ?? "无"}`,
    );
  } finally {
    Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });
  }

  // 字段缺失：同一渲染函数，四个 manifest 派生段统一 `—` + tooltip
  const missing = datasetSegments({
    manifest: {
      datasetId: "",
      dataVersion: "",
      rowCount: Number.NaN,
      coverageStart: "",
      coverageEnd: "",
      seed: 0,
      sha256: "",
      provider: "",
      generatedAt: 0,
    },
    adj: "qfq",
    timeframe: "D",
    computedMs: null,
    cacheHit: null,
    loading: false,
  });
  const missingOk = ["provider", "version", "range", "rows"].every((key) => {
    const segment = missing.find((item) => item.key === key);
    return segment?.text === "—" && segment.missing === true;
  });
  push(
    "R-05",
    "AC-02.08-01（补2）",
    "render",
    missingOk && missing.find((item) => item.key === "adj")?.text === "前复权",
    `缺失段=${missing.filter((item) => item.missing).map((item) => item.key).join("/")} · 缺失文案=${missing.find((item) => item.key === "rows")?.text}`,
  );

  const footer = q<HTMLElement>("[data-dataset-overview]");
  const firstSegment = segmentNodes()[0];
  const footerStyle = footer ? getComputedStyle(footer) : null;
  const segmentStyle = firstSegment ? getComputedStyle(firstSegment) : null;
  const height = footer ? Math.round(footer.getBoundingClientRect().height) : -1;
  push(
    "RT-01",
    "AC-02.08-01（补2）",
    "runtime",
    footerStyle?.flexWrap === "nowrap" &&
      footerStyle.overflowX === "auto" &&
      segmentStyle?.whiteSpace === "nowrap" &&
      height === 24,
    `窄屏单行横滚：flexWrap=${footerStyle?.flexWrap} overflowX=${footerStyle?.overflowX} 段whiteSpace=${segmentStyle?.whiteSpace} 高度=${height}px`,
  );

  // 还原默认口径，避免取证把页面留在不复权/周线
  clickAttr('[data-adj-mode="qfq"]');
  await sleep(300);
  clickAttr('[data-timeframe="D"]');
  await sleep(300);

  const report = {
    ok: checks.every((check) => check.passed),
    finishedAt: new Date().toISOString(),
    context: {
      manifest: m,
      note: "页脚数字全部来自 dataset_manifest；缺失字段不补默认值",
    },
    checks,
  };
  await ipc.diagWriteNamed("s20801-evidence.json", JSON.stringify(report, null, 2));
  return report;
}
