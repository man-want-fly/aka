import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { RouteKey } from "../app/AppShell";
import { formatPct, formatPrice, signClass } from "../lib/format";
import { ipc, isTauriRuntime } from "../lib/ipc";
import type { RecentViewDto } from "../lib/types";
import {
  buildSearchIndex,
  highlightParts,
  indexShortcuts,
  matchSecurities,
  SEARCH_RECENT_LIMIT,
  SEARCH_RESULT_LIMIT,
  type SearchIndex,
  type SearchItem,
} from "../features/search/searchIndex";

interface Props {
  onOpenSecurity: (code: string) => void;
  onNavigate: (key: RouteKey) => void;
}

type LoadState = "loading" | "ready" | "unavailable";
type SearchState = "preparing" | "unavailable" | "idle" | "empty" | "results";

function relativeTime(viewedAt: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - viewedAt));
  if (diff < 60) return "刚刚";
  if (diff < 3_600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86_400) return `${Math.floor(diff / 3_600)} 小时前`;
  if (diff < 7 * 86_400) return `${Math.floor(diff / 86_400)} 天前`;
  const date = new Date(viewedAt * 1_000);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 名称/代码只高亮连续命中片段；拼音命中不强行造高亮。 */
function Marked({ text, query }: { text: string; query: string }) {
  const parts = highlightParts(text, query);
  if (!parts) return <>{text}</>;
  return (
    <>
      {parts.before}
      <mark>{parts.hit}</mark>
      {parts.after}
    </>
  );
}

export function SearchOverlay({ onOpenSecurity, onNavigate }: Props) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState<SearchIndex | null>(null);
  const [loadState, setLoadState] = useState<LoadState>(isTauriRuntime() ? "loading" : "unavailable");
  const [simulated, setSimulated] = useState(false);
  const [recent, setRecent] = useState<RecentViewDto[]>([]);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);

  // 启动即建索引（≤300ms）；失败按「数据不可用」而不是空结果处理。
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    const started = performance.now();
    Promise.all([ipc.listSecurities(), ipc.marketSnapshot()])
      .then(([securities, snapshot]) => {
        if (cancelled) return;
        const buildStarted = performance.now();
        const built = buildSearchIndex(securities, snapshot.rows);
        const ms = Math.round(performance.now() - buildStarted);
        setIndex(built);
        setSimulated(snapshot.simulated);
        setLoadState("ready");
        void ipc
          .telemetryNote("search.index_ready", {
            ms,
            loadMs: Math.round(buildStarted - started),
            count: built.items.length,
            pinyinMissing: built.missingPinyin,
          })
          .catch(() => undefined);
        if (built.missingPinyin > 0) {
          void ipc
            .telemetryNote("SEARCH_PINYIN_MISSING", { count: built.missingPinyin })
            .catch(() => undefined);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadState("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // ⌘K / Ctrl+K 全局开合；Esc 只在浮层打开时关闭，避免抢占其它弹层。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      } else if (event.key === "Escape" && openRef.current) {
        setOpen(false);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("aka:search-open", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("aka:search-open", onOpen);
    };
  }, []);

  // 每次打开：清空输入、拉最近查看、焦点回输入框；关闭时焦点还给来源。
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setDebounced("");
    setActive(0);
    const previous = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    if (isTauriRuntime()) {
      void ipc
        .recentViews()
        .then(setRecent)
        .catch(() => setRecent([]));
    }
    return () => {
      window.clearTimeout(timer);
      previous?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), 60);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setActive(0);
  }, [debounced]);

  // 键盘移动到视口外时只滚到最近可见位置，不整页跳动。
  useEffect(() => {
    document.getElementById(`search-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const { hits, matched } = useMemo(
    () => (index ? matchSecurities(index, debounced) : { hits: [], matched: 0 }),
    [index, debounced],
  );
  const shortcuts = useMemo(() => (index ? indexShortcuts(index) : []), [index]);

  const state: SearchState =
    loadState === "loading"
      ? "preparing"
      : loadState === "unavailable"
        ? "unavailable"
        : debounced.trim() === ""
          ? "idle"
          : hits.length === 0
            ? "empty"
            : "results";

  const openItem = useCallback(
    (item: SearchItem) => {
      onOpenSecurity(item.code);
      setOpen(false);
    },
    [onOpenSecurity],
  );

  const trapFocus = (event: ReactKeyboardEvent) => {
    const panel = panelRef.current;
    if (!panel) return;
    const nodes = panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && hits.length > 0) {
      event.preventDefault();
      setActive((value) => Math.min(hits.length - 1, value + 1));
    } else if (event.key === "ArrowUp" && hits.length > 0) {
      event.preventDefault();
      setActive((value) => Math.max(0, value - 1));
    } else if (event.key === "Enter") {
      const hit = hits[active];
      if (hit) {
        event.preventDefault();
        openItem(hit.item);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "Tab") {
      trapFocus(event);
    }
  };

  if (!open) return null;

  const trimmed = debounced.trim();
  const selected = hits[active]?.item ?? null;

  return (
    <div
      className="search-backdrop"
      data-search-overlay
      data-search-state={state}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div
        className="search-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="搜索标的"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="search-input-row">
          <svg viewBox="0 0 20 20" aria-hidden="true" className="search-icon">
            <circle cx="9" cy="9" r="5" />
            <path d="M13 13l4 4" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            data-search-input
            className="search-input"
            type="text"
            value={query}
            placeholder="搜索代码 / 名称 / 拼音首字母"
            role="combobox"
            aria-expanded={state !== "preparing" && state !== "unavailable"}
            aria-controls="search-listbox"
            aria-autocomplete="list"
            aria-activedescendant={selected ? `search-opt-${active}` : undefined}
            disabled={state === "preparing" || state === "unavailable"}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKeyDown}
          />
          <span className="search-kbd">⌘K</span>
        </div>

        {state === "preparing" && (
          <div className="search-status" data-search-preparing role="status">
            索引准备中…
          </div>
        )}

        {state === "unavailable" && (
          <div className="search-status" data-search-unavailable role="status">
            <p>数据集不可用，暂不能搜索。</p>
            <button
              type="button"
              className="search-link"
              onClick={() => {
                onNavigate("datasource");
                setOpen(false);
              }}
            >
              去数据源状态
            </button>
          </div>
        )}

        {state === "idle" && (
          <div className="search-idle">
            <section className="search-section" data-search-index-shortcut>
              <h3>指数</h3>
              <div className="search-shortcuts">
                {shortcuts.map((item) => (
                  <button
                    key={item.code}
                    type="button"
                    className="search-shortcut"
                    data-search-shortcut-item={item.code}
                    onClick={() => openItem(item)}
                  >
                    <span className="search-shortcut-name">{item.name}</span>
                    <span className={`search-shortcut-pct ${signClass(item.changePct)}`}>
                      {item.changePct == null ? "—" : formatPct(item.changePct)}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <section className="search-section" data-search-recent>
              <h3>最近查看</h3>
              {recent.length === 0 ? (
                <p className="search-muted" data-search-recent-empty>
                  暂无最近查看，打开工作台后自动记录。
                </p>
              ) : (
                <ul className="search-recent-list">
                  {recent.slice(0, SEARCH_RECENT_LIMIT).map((item) => (
                    <li key={item.code}>
                      <button
                        type="button"
                        className="search-recent-item"
                        data-search-recent-item={item.code}
                        onClick={() => {
                          onOpenSecurity(item.code);
                          setOpen(false);
                        }}
                      >
                        <span className="search-recent-name">{item.name}</span>
                        <span className="search-recent-code">{item.code}</span>
                        <span className="search-recent-time">{relativeTime(item.viewedAt)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}

        {state === "empty" && (
          <div className="search-status" data-search-empty>
            <p>未找到 “{trimmed.length > 24 ? `${trimmed.slice(0, 24)}…` : trimmed}”</p>
            <div className="search-empty-actions">
              <button type="button" className="search-link" onClick={() => setQuery("")}>
                清空搜索
              </button>
              <button
                type="button"
                className="search-link"
                data-search-empty-market
                onClick={() => {
                  onNavigate("market");
                  setOpen(false);
                }}
              >
                去行情浏览
              </button>
            </div>
          </div>
        )}

        {state === "results" && (
          <div className="search-results">
            <p className="search-count" aria-live="polite" data-search-count>
              {matched} 个结果
              {matched > SEARCH_RESULT_LIMIT && (
                <span data-search-more> · 显示前 {Math.min(matched, SEARCH_RESULT_LIMIT)} 个</span>
              )}
            </p>
            <ul className="search-list" id="search-listbox" role="listbox">
              {hits.map(({ item }, position) => (
                <li
                  key={item.code}
                  id={`search-opt-${position}`}
                  role="option"
                  aria-selected={position === active}
                  className={`search-row ${position === active ? "active" : ""}`}
                  data-search-result={item.code}
                  onMouseEnter={() => setActive(position)}
                  onClick={() => openItem(item)}
                >
                  <span className="search-row-main">
                    <span className="search-row-name">
                      <Marked text={item.name} query={trimmed} />
                    </span>
                    <span className="search-row-code">
                      <Marked text={item.code} query={trimmed} />
                    </span>
                    <span className="search-row-board">{item.board}</span>
                    <span className={`search-tag ${item.isIndex ? "index" : ""}`}>
                      {item.isIndex ? "指数" : "股票"}
                    </span>
                    {simulated && <span className="search-tag sim">模拟</span>}
                    {item.suspended && <span className="search-tag warn">停牌</span>}
                  </span>
                  <span className="search-row-quote">
                    <span className="search-row-price">
                      {item.price == null ? "—" : formatPrice(item.price)}
                    </span>
                    <span className={`search-row-pct ${signClass(item.changePct)}`}>
                      {item.suspended || item.changePct == null
                        ? "—"
                        : formatPct(item.changePct)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <footer className="search-footer">
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span>Esc 关闭</span>
        </footer>
      </div>
    </div>
  );
}
