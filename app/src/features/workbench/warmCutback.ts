/**
 * W-111 / AC-02.06-02：缓存回切判据（单一真源）。
 *
 * 判据：maxTotalMs ≤ 120 且全部 cacheHit、逐点一致、indicator.compute 无新增。
 * 四条缺一即红；任一条只能拼进 notes 而不影响 passed 的写法，等于没有判据（W-111 根因）。
 */

import type { CalcResponse } from "../../lib/types";

export const WARM_CUTBACK_MAX_TOTAL_MS = 120;
export const WARM_CUTBACK_MIN_SAMPLES = 90;

/** FNV-1a 32 位常量：流式哈希与「先拼串再哈希」逐位等价。 */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const TOKEN_SEPARATOR = 44; // "," 的 charCode
const NULL_TOKEN_CODE = 110; // "n" 的 charCode

/** 逐点签名：占位 null 也参与哈希，只有数值完全一致才可能得到相同签名。
 * W-114：改为流式喂字符，不再为 4 万个 token 建数组与 join 大串；字符循环内联（不走闭包/回调），
 * 在 WKWebView 的 JSC 下 p50/p95/max 三项均优于旧实现。输出与旧实现逐位一致（verify-s20602 的等价夹具守住）。
 * 调用点必须在 `totalMs` 打点之后，否则哈希成本会混进回切时延。 */
export function seriesSignature(calc: CalcResponse): {
  hash: string;
  points: number;
} {
  let hash = FNV_OFFSET_BASIS;
  let firstToken = true;
  let points = 0;
  for (const series of calc.series) {
    if (!firstToken) {
      hash ^= TOKEN_SEPARATOR;
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
    firstToken = false;
    const head = `${series.instanceId}|${series.indicatorId}|w${series.warmup}`;
    for (let i = 0; i < head.length; i += 1) {
      hash ^= head.charCodeAt(i);
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
    for (const output of series.outputs) {
      if (!firstToken) {
        hash ^= TOKEN_SEPARATOR;
        hash = Math.imul(hash, FNV_PRIME) >>> 0;
      }
      firstToken = false;
      const key = output.key;
      for (let i = 0; i < key.length; i += 1) {
        hash ^= key.charCodeAt(i);
        hash = Math.imul(hash, FNV_PRIME) >>> 0;
      }
      for (const value of output.values) {
        if (!firstToken) {
          hash ^= TOKEN_SEPARATOR;
          hash = Math.imul(hash, FNV_PRIME) >>> 0;
        }
        firstToken = false;
        if (value === null) {
          hash ^= NULL_TOKEN_CODE;
          hash = Math.imul(hash, FNV_PRIME) >>> 0;
          continue;
        }
        points += 1;
        const text = value.toString();
        for (let i = 0; i < text.length; i += 1) {
          hash ^= text.charCodeAt(i);
          hash = Math.imul(hash, FNV_PRIME) >>> 0;
        }
      }
    }
  }
  return { hash: (hash >>> 0).toString(16).padStart(8, "0"), points };
}

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
