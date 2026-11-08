/**
 * W-111 / AC-02.06-02：缓存回切判据（单一真源）。
 *
 * 判据：maxTotalMs ≤ 120 且全部 cacheHit、逐点一致、indicator.compute 无新增。
 * 四条缺一即红；任一条只能拼进 notes 而不影响 passed 的写法，等于没有判据（W-111 根因）。
 */

export const WARM_CUTBACK_MAX_TOTAL_MS = 120;
export const WARM_CUTBACK_MIN_SAMPLES = 90;

export interface WarmCutbackInput {
  sampleCount: number;
  allCacheHit: boolean;
  allPointwiseMatch: boolean;
  maxTotalMs: number;
  /** 热切回窗口内 `indicator.compute` 的新增条数；命中路径应为 0。 */
  computeCountDelta: number;
}

export interface WarmCutbackVerdict {
  passed: boolean;
  reasons: string[];
}

export function evaluateWarmCutback(input: WarmCutbackInput): WarmCutbackVerdict {
  const reasons: string[] = [];
  if (!(input.sampleCount >= WARM_CUTBACK_MIN_SAMPLES)) {
    reasons.push(`样本 ${input.sampleCount} < ${WARM_CUTBACK_MIN_SAMPLES}`);
  }
  if (input.allCacheHit !== true) reasons.push("存在 cache miss（allCacheHit=false）");
  if (input.allPointwiseMatch !== true) reasons.push("存在逐点不一致（allPointwiseMatch=false）");
  if (!(input.maxTotalMs <= WARM_CUTBACK_MAX_TOTAL_MS)) {
    reasons.push(`max ${input.maxTotalMs}ms > ${WARM_CUTBACK_MAX_TOTAL_MS}ms`);
  }
  if (!(input.computeCountDelta === 0)) {
    reasons.push(`indicator.compute 新增 ${input.computeCountDelta} 条（应为 0）`);
  }
  return { passed: reasons.length === 0, reasons };
}
