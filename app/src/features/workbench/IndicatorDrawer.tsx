import { useMemo, useRef, useState, useEffect } from "react";
import { StateCard } from "../../components/StateCard";
import { Highlight, PANEL_LABEL, searchIndicators } from "../indicators/search";
import { MAX_MAIN_OVERLAYS, MAX_SUBPLOTS } from "./model";
import type { AppError, Category, ManifestIndicatorDto, ManifestResponse } from "../../lib/types";

const CATEGORY_LABELS: Array<{ key: Category; label: string }> = [
  { key: "trend", label: "趋势" },
  { key: "momentum", label: "动量" },
  { key: "volatility", label: "波动" },
  { key: "volume", label: "量能" },
  { key: "stat", label: "统计" },
  { key: "breadth", label: "广度" },
];

const panelKey = (item: ManifestIndicatorDto) => (item.panel === "主" ? "main" : "sub");

export interface IndicatorDrawerProps {
  manifest: ManifestResponse | null;
  loading: boolean;
  error: AppError | null;
  onRetry: () => void;
  overlayIds: string[];
  subIds: string[];
  /** 副图格总数（含成交量格，S-02.03-01 容量口径） */
  subCount: number;
  /** 当前工作台是否已有有效标的；无标的不允许把指标加进图表 */
  hasTarget: boolean;
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
  subIds,
  subCount,
  hasTarget,
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
    if (text) return searchIndicators(items, text);
    return items
      .filter((item) => item.category === category)
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [items, category, debounced]);

  const pick = (item: ManifestIndicatorDto) => {
    const panel = panelKey(item);
    // 无标的：指标无处可加，先给引导，不能静默失败
    if (!hasTarget) {
      setHint("请先在行情页选择一只标的");
      return;
    }
    const added = panel === "main" ? overlayIds.includes(item.id) : subIds.includes(item.id);
    // 已添加 / 规划中 / 容量满 都属于「点得动但加不进」，一律给明确说法
    if (added) {
      setHint("该指标已添加");
      return;
    }
    if (item.status === "planned") {
      setHint("该指标规划中，本期未开放");
      return;
    }
    if (panel === "main" && overlayIds.length >= MAX_MAIN_OVERLAYS) {
      setHint(`主图最多 ${MAX_MAIN_OVERLAYS} 个叠加，请先移除一个`);
      return;
    }
    if (panel === "sub" && subCount >= MAX_SUBPLOTS) {
      // 副图满 3 由禁用态拦截，不给 toast
      return;
    }
    if (panel === "main") onAddMain(item.id);
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
        <span className="caption mono" data-drawer-capacity="1">
          主图 {overlayIds.length}/{MAX_MAIN_OVERLAYS} · 副图 {subCount}/{MAX_SUBPLOTS}
        </span>
        {!hasTarget && (
          <span className="caption" data-drawer-no-target="1">
            请先在行情页选择一只标的{" "}
            <a className="link" href="#/market" data-drawer-go-market="1">
              去行情页
            </a>
          </span>
        )}
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
              const panel = panelKey(item);
              const added = panel === "main" ? overlayIds.includes(item.id) : subIds.includes(item.id);
              const full =
                panel === "main"
                  ? overlayIds.length >= MAX_MAIN_OVERLAYS
                  : subCount >= MAX_SUBPLOTS;
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
                        {item.completeness === "beta" && (
                          <span className="tag tag--beta">BETA</span>
                        )}
                        {params && (
                          <span className="mono ind-row__params" data-drawer-param-text="1">
                            {params}
                          </span>
                        )}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="add-btn"
                      data-drawer-add={`${item.id}:${panel}`}
                      data-drawer-added={added ? "1" : "0"}
                      data-drawer-planned={planned ? "1" : "0"}
                      data-drawer-full={full ? "1" : "0"}
                      disabled={!hasTarget || (!added && !planned && full && panel === "sub")}
                      aria-disabled={!hasTarget || added || planned || full}
                      title={!hasTarget ? "请先在行情页选择一只标的" : !added && !planned && full ? (panel === "main" ? `主图最多 ${MAX_MAIN_OVERLAYS} 个，请先移除一个` : `副图最多 ${MAX_SUBPLOTS} 个，请先移除一个指标`) : undefined}
                      data-drawer-blocked={!hasTarget ? "1" : "0"}
                      onClick={(event) => {
                        event.stopPropagation();
                        pick(item);
                      }}
                    >
                      {added ? "✓ 已添加" : panel === "main" ? "+ 主图" : "+ 副图"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="ind-drawer__foot caption" data-drawer-total={items.length}>
        目录 {items.length} 条 · 由 manifest 单一事实来源生成 · Esc 关闭
      </footer>
    </aside>
  );
}
