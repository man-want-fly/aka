import type { MarketRowDto, SecurityDto } from "../../lib/types";

/** 单次查询最多返回条数（S-05.01-01 AC）。 */
export const SEARCH_RESULT_LIMIT = 20;
/** 最近查看最多展示条数（S-05.01-02 AC）。 */
export const SEARCH_RECENT_LIMIT = 5;
/** 指数快捷入口固定 4 条，按样本序取前 4。 */
export const SEARCH_INDEX_SHORTCUTS = 4;

/**
 * 14 只已知标的的拼音首字母。生成标的没有真实拼音，按卡面口径
 * 「缺失跳过该条拼音匹配」处理，并统计缺失数供 SEARCH_PINYIN_MISSING 落日志。
 */
const PINYIN_INITIALS: Record<string, string> = {
  "300750.SZ": "ndsd",
  "600519.SH": "gzmt",
  "002594.SZ": "byd",
  "601318.SH": "zgpa",
  "600036.SH": "zsyh",
  "000858.SZ": "wly",
  "688981.SH": "zxgj",
  "300059.SZ": "dfcf",
  "601899.SH": "zjky",
  "002415.SZ": "hkws",
  "600030.SH": "zxzq",
  "601012.SH": "ljln",
  "000651.SZ": "gldq",
  "600900.SH": "cjdl",
};

export interface SearchItem {
  code: string;
  bareCode: string;
  name: string;
  board: string;
  isIndex: boolean;
  price: number | null;
  changePct: number | null;
  amount: number | null;
  suspended: boolean;
  pinyin: string | null;
}

export interface SearchIndex {
  items: SearchItem[];
  /** 无拼音首字母的股票数量（生成标的），用于 SEARCH_PINYIN_MISSING。 */
  missingPinyin: number;
}

export interface SearchHit {
  item: SearchItem;
  score: number;
}

/**
 * 行情按代码索引；缺行情的标的仍可搜索，只是价格/涨跌幅为空。
 *
 * 索引键必须是 `MarketRowDto.security`（带交易所后缀的唯一键，如 `601029.SH`），
 * 不能用 `MarketRowDto.code`（裸代码，如 `601029`）：证券表用的是带后缀的 code，
 * 按裸代码建表会让每一条行情都查不到 → 成交额/最新价/涨跌幅/停牌全落 null，
 * 同分排序退化成代码升序（卡面 AC-05.01-01 补2「首条为成交额最大者」不成立）。
 */
export function buildSearchIndex(
  securities: SecurityDto[],
  rows: MarketRowDto[],
): SearchIndex {
  const quotes = new Map<string, MarketRowDto>();
  for (const row of rows) quotes.set(row.security, row);

  let missingPinyin = 0;
  const items = securities.map((security) => {
    const quote = quotes.get(security.code);
    const pinyin = PINYIN_INITIALS[security.code] ?? null;
    if (!security.isIndex && pinyin === null) missingPinyin += 1;
    return {
      code: security.code,
      bareCode: security.code.split(".")[0],
      name: security.name,
      board: security.board,
      isIndex: security.isIndex,
      price: quote?.lastPrice ?? null,
      changePct: quote?.changePct ?? null,
      amount: quote?.amount ?? null,
      suspended: quote?.suspended ?? false,
      pinyin,
    };
  });
  return { items, missingPinyin };
}

/**
 * 排序口径：代码精确 > 代码前缀 > 名称前缀 > 名称包含 > 拼音首字母前缀；
 * 同分按成交额降序、代码升序，保证同一查询结果稳定。
 */
export function scoreOf(item: SearchItem, query: string): number {
  const q = query.toLowerCase();
  if (!q) return 0;
  const code = item.code.toLowerCase();
  if (code === q || item.bareCode === q) return 100;
  if (code.startsWith(q) || item.bareCode.startsWith(q)) return 80;
  if (item.name.startsWith(query)) return 60;
  if (item.name.includes(query)) return 40;
  if (item.pinyin !== null && item.pinyin.startsWith(q)) return 20;
  return 0;
}

export function matchSecurities(
  index: SearchIndex,
  query: string,
  limit = SEARCH_RESULT_LIMIT,
): { hits: SearchHit[]; matched: number } {
  const trimmed = query.trim();
  if (!trimmed) return { hits: [], matched: 0 };
  const scored: SearchHit[] = [];
  for (const item of index.items) {
    const score = scoreOf(item, trimmed);
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const amountA = a.item.amount ?? -1;
    const amountB = b.item.amount ?? -1;
    if (amountB !== amountA) return amountB - amountA;
    return a.item.code.localeCompare(b.item.code);
  });
  return { hits: scored.slice(0, limit), matched: scored.length };
}

/** 指数快捷入口：按 listSecurities 样本序过滤 INDEX 取前 4。 */
export function indexShortcuts(index: SearchIndex): SearchItem[] {
  return index.items.filter((item) => item.isIndex).slice(0, SEARCH_INDEX_SHORTCUTS);
}

/** 名称/代码高亮片段：只返回命中的连续片段，交给页面决定强调样式。 */
export function highlightParts(
  text: string,
  query: string,
): { before: string; hit: string; after: string } | null {
  const q = query.trim();
  if (!q) return null;
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return null;
  return {
    before: text.slice(0, at),
    hit: text.slice(at, at + q.length),
    after: text.slice(at + q.length),
  };
}
