import type { ManifestIndicatorDto } from "../../lib/types";

export const PANEL_LABEL: Record<string, string> = { 主: "主图", 副: "副图" };

/** 有序子序列匹配：`md` → `MACD`（M…D），用于缩写/英文/拼音首字母的模糊命中。 */
export const isSubsequence = (needle: string, hay: string) => {
  let index = 0;
  for (const char of hay) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return needle.length === 0;
};

/**
 * 返回命中强度：0 未命中，1 子序列，2 子串，3 前缀，4 完全相等。
 * 名称（中文/英文）只做子串与前缀；缩写/拼音首字母额外允许子序列，
 * 但子序列只在「无空格且不超过 6 个字符」的短代号上生效——
 * 否则 `MACD` 会通过 m→a→c→d 误命中长英文名（如 Performance Spread）。
 *
 * 指标目录（S-03.01-02）与抽屉（S-02.04-01）共用本函数，禁止各写一套。
 */
export const matchRank = (item: ManifestIndicatorDto, rawQuery: string) => {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return 0;
  const loose = [
    item.abbr,
    item.nameEn,
    item.pinyinInitials,
    item.pinyinFull,
    ...(item.aliases ?? []),
  ];
  const tight = [item.nameZh, item.nameEn, ...(item.aliases ?? [])];
  let best = 0;
  for (const field of loose) {
    const text = (field ?? "").toLowerCase();
    if (!text) continue;
    if (text === query) best = Math.max(best, 4);
    else if (text.startsWith(query)) best = Math.max(best, 3);
    else if (text.includes(query)) best = Math.max(best, 2);
    else if (!text.includes(" ") && text.length <= 6 && isSubsequence(query, text)) {
      best = Math.max(best, 1);
    }
  }
  for (const field of tight) {
    const text = field.toLowerCase();
    if (!text) continue;
    if (text.startsWith(query)) best = Math.max(best, 3);
    else if (text.includes(query)) best = Math.max(best, 2);
  }
  return best;
};

/** 统一排序：命中强度降序，同强度按 id 升序（与抽屉口径一致）。 */
export function searchIndicators(items: ManifestIndicatorDto[], rawQuery: string) {
  return items
    .map((item) => ({ item, rank: matchRank(item, rawQuery) }))
    .filter((entry) => entry.rank > 0)
    .sort((a, b) => b.rank - a.rank || a.item.id.localeCompare(b.item.id))
    .map((entry) => entry.item);
}

/** 命中片段高亮（只对子串/前缀命中生效，子序列命中不强标）。 */
export function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return <>{text}</>;
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}
