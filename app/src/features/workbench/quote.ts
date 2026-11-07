/**
 * D-18 涨跌停价推导：按板块规则计算，四舍五入到 0.01。
 * 只做展示层推导，交易所公布值以真实接口为准，故界面上以 `≈` 标注（AC-02.01-01 补2）。
 */

/** 近似标注的 tooltip 文案：逐字固定，DOM 断言按此校验 */
export const LIMIT_APPROX_TITLE = "按板块规则推导，可能与交易所公布值存在 1 分钱差异";

export interface LimitPrices {
  up: number;
  down: number;
}

/** 板块涨跌幅限制：主板 10%，创业板/科创板 20%；指数与未知板块不推导。 */
export function boardLimitRate(board: string): number | null {
  if (board === "沪主板" || board === "深主板") return 0.1;
  if (board === "创业板" || board === "科创板") return 0.2;
  return null;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function deriveLimitPrices(
  prevClose: number | null | undefined,
  board: string,
): LimitPrices | null {
  if (prevClose == null || !Number.isFinite(prevClose) || prevClose <= 0) return null;
  const rate = boardLimitRate(board);
  if (rate === null) return null;
  return { up: round2(prevClose * (1 + rate)), down: round2(prevClose * (1 - rate)) };
}

/**
 * 是否展示 `≈`：板块非空、未停牌、非上市前 5 日、涨跌停价可推导。
 * MVP 数据集无上市日字段，「上市前 5 日」分支按未命中处理（不阻断推导）。
 */
export function showLimitApprox(input: {
  board: string;
  isIndex: boolean;
  suspended: boolean;
  prices: LimitPrices | null;
}): boolean {
  return (
    !input.isIndex &&
    input.board.trim() !== "" &&
    !input.suspended &&
    input.prices !== null
  );
}
