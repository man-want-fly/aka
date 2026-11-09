//! S-01.03-01 持仓透视：市值/浮盈亏/盈亏比例的单一派生口径。
//! 市值 = 最新价（当前复权口径）× 数量；浮盈亏 = (最新价 − 成本价) × 数量；
//! 盈亏比例 = (最新价 / 成本价 − 1) × 100。最新价缺失时三值为 null（界面显示「—」）。

import { formatPct, formatPrice, formatSigned } from "../../lib/format";
import type { PositionDto } from "../../lib/types";

export type AdjMode = "none" | "qfq" | "hfq";

export const ADJ_STORAGE_KEY = "aka.chart.adj";
export const ADJ_CHANGE_EVENT = "aka:adj-change";

export function readAdjMode(): AdjMode {
  try {
    const stored = window.localStorage.getItem(ADJ_STORAGE_KEY);
    if (stored === "none" || stored === "qfq" || stored === "hfq") return stored;
  } catch {
    /* 存储不可用时用默认值 */
  }
  return "qfq";
}

export interface DerivedPosition {
  marketValue: number | null;
  pnl: number | null;
  pnlPct: number | null;
}

export function derivePosition(
  costPrice: number,
  shares: number,
  lastPrice: number | null,
): DerivedPosition {
  if (lastPrice == null || !Number.isFinite(lastPrice)) {
    return { marketValue: null, pnl: null, pnlPct: null };
  }
  return {
    marketValue: lastPrice * shares,
    pnl: (lastPrice - costPrice) * shares,
    pnlPct: costPrice > 0 ? (lastPrice / costPrice - 1) * 100 : null,
  };
}

export type PositionSign = "pos" | "neg" | "flat";

export interface PositionTexts {
  costPrice: string;
  shares: string;
  marketValue: string;
  pnl: string;
  pnlPct: string;
  sign: PositionSign;
}

/** 界面文本统一走 format.ts：成本价 2 位、数量整数千分位、金额 2 位带符号、比例 2 位带符号。 */
export function positionTexts(position: PositionDto, lastPrice: number | null): PositionTexts {
  const derived = derivePosition(position.costPrice, position.shares, lastPrice);
  const pnl = derived.pnl;
  return {
    costPrice: formatPrice(position.costPrice),
    shares: formatPrice(position.shares, 0),
    marketValue: derived.marketValue == null ? "—" : formatPrice(derived.marketValue),
    pnl: pnl == null ? "—" : formatSigned(pnl),
    pnlPct: derived.pnlPct == null ? "—" : formatPct(derived.pnlPct),
    sign: pnl == null || pnl === 0 ? "flat" : pnl > 0 ? "pos" : "neg",
  };
}
