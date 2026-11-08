/**
 * S-07.01-02 / W-103：健康检查汇总行的场景期望。
 *
 * 默认数据集六项全过 → `6/6`；`--corrupt-manifest` 注入时②FAIL、③~⑥SKIP → `1/6`。
 * 分子与分母都必须与场景一致：只校验分母会把 corrupt 场景里的 `6/6` 误判为通过。
 * 场景取自注入开关（`diag_faults`），不取自被测页面自身的渲染结果。
 */
const SUMMARY_PATTERN = /^(\d+)\/(\d+) 通过 · 总耗时 \d+ ms · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** 返回 null 表示符合期望；否则返回可直接写入 detail 的差异说明。 */
export function healthSummaryMismatch(manifestCorrupt: boolean, summary: string): string | null {
  const match = SUMMARY_PATTERN.exec(summary);
  if (!match) return `汇总格式不符：「${summary}」`;
  const passed = Number(match[1]);
  const total = Number(match[2]);
  if (total !== 6) return `分母 ${total} ≠ 6`;
  const expected = manifestCorrupt ? 1 : 6;
  if (passed !== expected) {
    return `分子 ${passed} ≠ ${expected}（manifestCorrupt=${manifestCorrupt}）`;
  }
  return null;
}
