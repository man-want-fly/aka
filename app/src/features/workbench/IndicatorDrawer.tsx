import { useMemo, useRef, useState, useEffect } from "react";
import { StateCard } from "../../components/StateCard";
import type { AppError, Category, ManifestIndicatorDto, ManifestResponse } from "../../lib/types";

const CATEGORY_LABELS: Array<{ key: Category; label: string }> = [
  { key: "trend", label: "趋势" },
  { key: "momentum", label: "动量" },
  { key: "volatility", label: "波动" },
  { key: "volume", label: "量能" },
  { key: "stat", label: "统计" },
  { key: "breadth", label: "广度" },
];

const PANEL_LABEL: Record<string, string> = { 主: "主图", 副: "副图" };

const panelKey = (item: ManifestIndicatorDto) => (item.panel === "主" ? "main" : "sub");

/** 有序子序列匹配：`md` → `MACD`（M…D），用于缩写/英文/拼音首字母的模糊命中。 */
const isSubsequence = (needle: string, hay: string) => {
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
 */
const matchRank = (item: ManifestIndicatorDto, rawQuery: string) => {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return 0;
  const loose = [item.abbr, item.nameEn, item.pinyinInitials, ...(item.aliases ?? [])];
  const tight = [item.nameZh, item.nameEn, ...(item.aliases ?? [])];
  let best = 0;
  for (const field of loose) {
    const text = field.toLowerCase();
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

/** 命中片段高亮（只对子串/前缀命中生效，子序列命中不强标）。 */
function Highlight({ text, query }: { text: string; query: string }) {
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

export interface IndicatorDrawerProps {
  manifest: ManifestResponse | null;
  loading: boolean;
  error: AppError | null;
  onRetry: () => void;
  overlayIds: string[];
  subId: string;
  onAddMain: (id: string) => void;
  onAddSub: (id: string) => void;
  onClose: () => void;
}

/**
 * S-02.04-01 指标抽屉：105 条目录（44 可选 + 61 规划中置灰），
 * 分类计数由 manifest 现算，搜索命中规划中条目时给「该指标规划中」提示。
 * 搜索无结果空态并入 S-08.01-02，不再单独实现。
 */
export function IndicatorDrawer({
  manifest,
  loading,
  error,
  onRetry,
  overlayIds,
  subId,
  onAddMain,
  onAddSub,
  onClose,
}: IndicatorDrawerProps) {
  const [category, setCategory] = useState<Category>("trend");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    searchRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    // 200ms 防抖：连续输入只按最后一次过滤
    const timer = window.setTimeout(() => setDebounced(query), 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  const items = manifest?.indicators ?? [];

  const counts = useMemo(() => {
    const map = new Map<Category, number>();
    for (const item of items) map.set(item.category, (map.get(item.category) ?? 0) + 1);
    return map;
  }, [items]);

  const plannedCount = useMemo(() => items.filter((item) => item.status === "planned").length, [items]);
  const implementedCount = items.length - plannedCount;

  const list = useMemo(() => {
    const text = debounced.trim();
    if (text) {
      return items
        .map((item) => ({ item, rank: matchRank(item, text) }))
        .filter((entry) => entry.rank > 0)
        .sort((a, b) => b.rank - a.rank || a.item.nameZh.localeCompare(b.item.nameZh, "zh-Hans-CN"))
        .map((entry) => entry.item);
    }
    return items
      .filter((item) => item.category === category)
      .sort((a, b) => a.nameZh.localeCompare(b.nameZh, "zh-Hans-CN"));
  }, [items, category, debounced]);

  const pick = (item: ManifestIndicatorDto) => {
    if (item.status === "planned") {
      // 规划中与 P1「本期未开放」是同一件事的两种说法，两条提示一起给，避免用户只看到一半
      setHint(`「${item.nameZh}」该指标规划中（本期未开放）`);
      return;
    }
    if (item.priority === "P1") {
      setHint(`「${item.nameZh}」该指标本期未开放`);
      return;
    }
    if (item.panel === "主") onAddMain(item.id);
    else onAddSub(item.id);
    setHint(`已加入「${item.nameZh}」`);
  };

  const searching = debounced.trim().length > 0;

  return (
    <aside className="ind-drawer" data-indicator-drawer="1" aria-label="指标抽屉">
      <header className="ind-drawer__head">
        <span className="ind-drawer__title">指标</span>
        <span className="caption mono" data-drawer-summary="1">
          {implementedCount} 可选 / {plannedCount} 规划中
        </span>
        <button
          type="button"
          className="icon-btn"
          data-drawer-close="1"
          aria-label="关闭指标抽屉"
          onClick={onClose}
        >
          ×
        </button>
      </header>

      <div className="ind-drawer__search">
        <input
          ref={searchRef}
          type="search"
          className="input"
          data-drawer-search="1"
          placeholder="代码 / 名称 / 拼音首字母，如 md、kdj、均线"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {!searching && (
        <nav className="seg ind-drawer__cats" aria-label="指标分类">
          {CATEGORY_LABELS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              data-drawer-cat={entry.key}
              data-drawer-cat-count={counts.get(entry.key) ?? 0}
              aria-pressed={category === entry.key}
              onClick={() => {
                setCategory(entry.key);
                setHint(null);
              }}
            >
              {entry.label}
              <span className="mono ind-drawer__count">{counts.get(entry.key) ?? 0}</span>
            </button>
          ))}
        </nav>
      )}

      {hint && (
        <p className="ind-drawer__hint" data-drawer-hint="1" role="status">
          {hint}
        </p>
      )}

      <div className="ind-drawer__body" data-drawer-body="1">
        {error ? (
          <StateCard
            tone="error"
            title="指标库未加载"
            description="目录由 manifest 提供，加载失败时不展示任何条目。"
            error={error}
            actionLabel="重试"
            onAction={onRetry}
            anchor="drawer-error"
          />
        ) : loading || !manifest ? (
          <StateCard
            tone="loading"
            title="正在加载指标库"
            description="读取 manifest（105 条目录与元数据）。"
            anchor="drawer-loading"
          />
        ) : list.length === 0 ? (
          <div data-drawer-empty="1">
            <StateCard
              tone="empty"
              title="没有匹配的指标"
              description="可试代码（MACD）、名称（均线）或拼音首字母；也可清空搜索查看分类。"
              actionLabel="清除搜索"
              onAction={() => {
                setQuery("");
                setDebounced("");
                searchRef.current?.focus();
              }}
              anchor="drawer-search-empty"
            />
          </div>
        ) : (
          <ul className="ind-drawer__list" data-drawer-list="1">
            {list.map((item) => {
              const planned = item.status === "planned";
              const added = item.panel === "主" ? overlayIds.includes(item.id) : subId === item.id;
              const params = item.params.map((param) => String(param.default)).join(",");
              return (
                <li key={item.id}>
                  <div
                    className={`ind-row${planned ? " ind-row--planned" : ""}`}
                    data-drawer-row={item.id}
                    data-drawer-status={item.status}
                    data-drawer-category={item.category}
                    data-drawer-panel={item.panel}
                    data-drawer-params={params}
                    role="button"
                    tabIndex={0}
                    aria-disabled={planned || item.priority === "P1"}
                    onClick={() => pick(item)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") pick(item);
                    }}
                  >
                    <div className="ind-row__main">
                      <span className="ind-row__name">
                        <Highlight text={item.nameZh} query={debounced} />
                      </span>
                      <span className="ind-row__meta caption">
                        <span className="mono" data-drawer-abbr="1">
                          <Highlight text={item.abbr} query={debounced} />
                        </span>
                        <span>{PANEL_LABEL[item.panel] ?? item.panel}</span>
                        {item.priority === "P1" && <span className="tag tag--warn">P1</span>}
                        {planned && <span className="tag tag--muted">规划中</span>}
                        {item.status === "beta" && <span className="tag tag--beta">BETA</span>}
                        {params && (
                          <span className="mono ind-row__params" data-drawer-param-text="1">
                            {params}
                          </span>
                        )}
                      </span>
                    </div>
                    {(planned || item.priority === "P1") && item.priority === "P1" ? null : (
                      <button
                        type="button"
                        className="add-btn"
                        data-drawer-add={`${item.id}:${panelKey(item)}`}
                        data-drawer-added={added ? "1" : "0"}
                        aria-disabled={added || planned}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (added) return;
                          pick(item);
                        }}
                      >
                        {added ? "已添加" : item.panel === "主" ? "+ 主图" : "+ 副图"}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="ind-drawer__foot caption">
        目录 105 条 · 由 manifest 单一事实来源生成 · Esc 关闭
      </footer>
    </aside>
  );
}
