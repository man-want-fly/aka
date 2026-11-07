import { formatComputedMs } from "../../lib/format";
import type { DatasetManifestDto } from "../../lib/types";

/** S-02.08-01 页脚共 7 段，顺序即卡面验收顺序；页面不另写任何一个数字。 */
export const DATASET_SEGMENTS = [
  "provider",
  "version",
  "adj",
  "timeframe",
  "range",
  "rows",
  "calc",
] as const;

export type DatasetSegmentKey = (typeof DATASET_SEGMENTS)[number];

export interface DatasetSegment {
  key: DatasetSegmentKey;
  /** 字段中文名，用于 title/ARIA（视觉上不重复出现） */
  label: string;
  text: string;
  /** 缺失字段统一为 `—`，tooltip 说明原因 */
  missing?: boolean;
}

const MISSING = "—";

const ADJ_TEXT = { none: "不复权", qfq: "前复权", hfq: "后复权" } as const;
const TF_TEXT = { D: "日线", W: "周线", M: "月线" } as const;

export function shortSha(sha256: string | undefined): string | undefined {
  if (!sha256 || sha256.length < 8) return undefined;
  return sha256.slice(0, 8);
}

/** 千分位；不依赖 locale，避免一次系统换语言就换分隔符 */
export function formatRowCount(value: number | undefined): string | undefined {
  if (!Number.isFinite(value)) return undefined;
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function datasetSegments(input: {
  manifest: DatasetManifestDto | null;
  adj: "none" | "qfq" | "hfq";
  timeframe: "D" | "W" | "M";
  computedMs: number | null;
  cacheHit: boolean | null;
  loading: boolean;
}): DatasetSegment[] {
  const m = input.manifest;
  const calc =
    input.computedMs === null
      ? input.loading
        ? "计算中"
        : undefined
      : `${formatComputedMs(input.computedMs)}ms · ${input.cacheHit ? "缓存命中" : "冷算"}`;
  return [
    { key: "provider", label: "数据来源", text: m?.provider || MISSING, missing: !m?.provider },
    {
      key: "version",
      label: "数据集版本（sha256 前 8 位）",
      text: shortSha(m?.sha256) ?? MISSING,
      missing: !shortSha(m?.sha256),
    },
    { key: "adj", label: "复权口径", text: ADJ_TEXT[input.adj] },
    { key: "timeframe", label: "周期", text: TF_TEXT[input.timeframe] },
    {
      key: "range",
      label: "数据区间",
      text: m?.coverageStart && m.coverageEnd ? `${m.coverageStart} ~ ${m.coverageEnd}` : MISSING,
      missing: !m?.coverageStart || !m.coverageEnd,
    },
    {
      key: "rows",
      label: "数据规模（行）",
      text: (formatRowCount(m?.rowCount) ?? MISSING) + (formatRowCount(m?.rowCount) ? " 行" : ""),
      missing: !formatRowCount(m?.rowCount),
    },
    { key: "calc", label: "计算耗时", text: calc ?? MISSING, missing: !calc },
  ];
}
