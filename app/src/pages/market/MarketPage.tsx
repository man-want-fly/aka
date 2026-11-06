import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { AppShell } from "../../app/AppShell";
import { SimBadge } from "../../components/SimBadge";
import { StateCard } from "../../components/StateCard";
import {
  formatAmount,
  formatPct,
  formatPrice,
  formatSigned,
  signClass,
} from "../../lib/format";
import { describeError, ipc, isTauriRuntime } from "../../lib/ipc";
import { runMarketDiagnostics } from "../../features/market/diag";
import type {
  AppError,
  MarketRowDto,
  MarketSnapshotDto,
  WatchlistDto,
} from "../../lib/types";

export type MarketBoard = "all" | "sh" | "sz" | "chinext" | "star";

export type SortKey =
  | "code"
  | "name"
  | "lastPrice"
  | "changePct"
  | "changeAbs"
  | "amount"
  | "turnoverPct"
  | "volumeRatio"
  | "amplitudePct";

type SortDir = "asc" | "desc";

/** 同一页面会话内只跑一次；整页重载（HMR/重启）会重置，便于重新取证。 */
let marketDiagHasRun = false;

const MARKET_BOARDS: Array<{ key: MarketBoard; label: string }> = [
  { key: "all", label: "全部" },
  { key: "sh", label: "沪市" },
  { key: "sz", label: "深市" },
  { key: "chinext", label: "创业板" },
  { key: "star", label: "科创板" },
];

export const MARKET_COLUMNS: Array<{ key: MarketColumn; label: string; numeric: boolean; locked?: boolean }> = [
  { key: "code", label: "代码", numeric: false, locked: true },
  { key: "name", label: "名称", numeric: false, locked: true },
  { key: "lastPrice", label: "最新价", numeric: true, locked: true },
  { key: "changePct", label: "涨跌幅", numeric: true, locked: true },
  { key: "changeAbs", label: "涨跌额", numeric: true },
  { key: "amount", label: "成交额", numeric: true },
  { key: "turnoverPct", label: "换手率", numeric: true },
  { key: "volumeRatio", label: "量比", numeric: true },
  { key: "amplitudePct", label: "振幅", numeric: true },
];

export type MarketColumn = Exclude<SortKey, "code" | "name"> | "code" | "name";

const LOCKED_COLUMNS: MarketColumn[] = ["code", "name", "lastPrice", "changePct"];
const DEFAULT_SORT: SortKey = "amount";

export interface MarketViewState {
  board: MarketBoard;
  sortKey: SortKey;
  sortDir: SortDir;
  columns: MarketColumn[];
}

const DEFAULT_VIEW: MarketViewState = {
  board: "all",
  sortKey: DEFAULT_SORT,
  sortDir: "desc",
  columns: MARKET_COLUMNS.map((column) => column.key),
};

export function sameBoard(row: MarketRowDto, board: MarketBoard): boolean {
  switch (board) {
    case "all":
      return true;
    case "sh":
      return row.market === "SH" && (row.board === "主板" || row.board === "指数");
    case "sz":
      return row.market === "SZ" && (row.board === "主板" || row.board === "指数");
    case "chinext":
      return row.board === "创业板";
    case "star":
      return row.board === "科创板";
  }
}

function sortValue(row: MarketRowDto, key: SortKey): string | number | null {
  switch (key) {
    case "code":
      return row.code;
    case "name":
      return row.name;
    default: {
      const value = row[key];
      return value != null && Number.isFinite(value) ? value : null;
    }
  }
}

/** 排序：空值恒排末尾；同值按证券代码升序做稳定次级排序。 */
export function sortRows(rows: MarketRowDto[], key: SortKey, dir: SortDir): MarketRowDto[] {
  const factor = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va == null && vb == null) return a.security.localeCompare(b.security);
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "number" && typeof vb === "number") {
      if (va === vb) return a.security.localeCompare(b.security);
      return (va - vb) * factor;
    }
    const result = String(va).localeCompare(String(vb));
    return result === 0 ? a.security.localeCompare(b.security) : result * factor;
  });
}

/** 点击列头三态：降序 → 升序 → 回到默认（成交额降序）。 */
export function nextSort(
  current: { key: SortKey; dir: SortDir },
  clicked: SortKey,
): { key: SortKey; dir: SortDir } {
  if (current.key !== clicked) return { key: clicked, dir: "desc" };
  if (current.dir === "desc") return { key: clicked, dir: "asc" };
  return { key: DEFAULT_SORT, dir: "desc" };
}

function sanitizeView(value: unknown): MarketViewState {
  if (!value || typeof value !== "object") return DEFAULT_VIEW;
  const raw = value as Partial<MarketViewState>;
  const board = MARKET_BOARDS.some((item) => item.key === raw.board) ? raw.board! : DEFAULT_VIEW.board;
  const sortKey = MARKET_COLUMNS.some((item) => item.key === raw.sortKey) ? raw.sortKey! : DEFAULT_SORT;
  const sortDir = raw.sortDir === "asc" ? "asc" : "desc";
  const columns = Array.isArray(raw.columns)
    ? MARKET_COLUMNS.map((item) => item.key).filter((key) => raw.columns!.includes(key))
    : DEFAULT_VIEW.columns;
  return {
    board,
    sortKey,
    sortDir,
    columns: LOCKED_COLUMNS.every((key) => columns.includes(key))
      ? columns
      : [...LOCKED_COLUMNS, ...columns.filter((key) => !LOCKED_COLUMNS.includes(key))],
  };
}

const VIEW_SCOPE = "view.market";
const SCROLL_KEY = "aka.market.scroll";
const SELECTED_KEY = "aka.market.selected";

interface Props {
  onNavigate: (key: "workbench" | "catalog" | "market") => void;
  onOpenSecurity: (security: string) => void;
}

export function MarketPage({ onNavigate, onOpenSecurity }: Props) {
  const [snapshot, setSnapshot] = useState<MarketSnapshotDto | null>(null);
  const [watchlist, setWatchlist] = useState<WatchlistDto | null>(null);
  const [view, setView] = useState<MarketViewState>(DEFAULT_VIEW);
  const [viewLoaded, setViewLoaded] = useState(false);
  const [selected, setSelected] = useState(() => sessionStorage.getItem(SELECTED_KEY) ?? "");
  const [error, setError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(true);
  const [slow, setSlow] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [columnPanel, setColumnPanel] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [diagStatus, setDiagStatus] = useState<string | null>(null);
  const diagStarted = useRef(false);
  const tableRef = useRef<HTMLDivElement | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    const started = performance.now();
    try {
      const [nextSnapshot, nextWatchlist, stored] = await Promise.all([
        ipc.marketSnapshot(),
        ipc.watchlist(),
        ipc.viewStateGet(VIEW_SCOPE),
      ]);
      setSnapshot(nextSnapshot);
      setWatchlist(nextWatchlist);
      setView(sanitizeView(stored));
      setViewLoaded(true);
      console.info(`render.list.rows=${nextSnapshot.rows.length}`);
      console.info(`render.list.cost_ms=${Math.round(performance.now() - started)}`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setTimeout(() => setSlow(true), 120);
    const narrowQuery = window.matchMedia("(max-width: 960px)");
    const onNarrow = () => setNarrow(narrowQuery.matches);
    onNarrow();
    narrowQuery.addEventListener("change", onNarrow);
    return () => {
      window.clearTimeout(timer);
      narrowQuery.removeEventListener("change", onNarrow);
    };
  }, []);

  useEffect(() => {
    if (!viewLoaded) return;
    void ipc.viewStateSet(VIEW_SCOPE, view).catch((err) => {
      setToast(`设置未保存：${describeError(err).message}`);
    });
  }, [view, viewLoaded]);

  useEffect(() => {
    if (!snapshot || loading) return;
    let frames = 0;
    // 首帧可能还没量出完整滚动高度，scrollTop 会被 clamp 到 0；补两帧重试。
    const apply = () => {
      const el = tableRef.current;
      if (!el) return;
      const scroll = Number(sessionStorage.getItem(SCROLL_KEY) ?? "0");
      if (Number.isFinite(scroll) && el.scrollTop !== scroll) {
        el.scrollTop = scroll;
        if (el.scrollTop !== scroll && frames < 3) {
          frames += 1;
          requestAnimationFrame(apply);
          return;
        }
      }
      const row = el.querySelector<HTMLElement>(`[data-code="${selected}"]`);
      if (row) row.dataset.selected = "1";
    };
    apply();
  }, [snapshot, loading, view.board, view.sortKey, view.sortDir]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3_000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  /** E-01 渲染层自证：仅 AKA_DIAG=1 时在真实界面跑一次，结果落盘为 JSON。 */
  useEffect(() => {
    if (!isTauriRuntime() || diagStarted.current || marketDiagHasRun) return;
    if (!snapshot || !viewLoaded || loading) return;
    diagStarted.current = true;
    (async () => {
      const enabled = await ipc.diagEnabled();
      if (!enabled) return;
      marketDiagHasRun = true;
      // 工作台 S2 套件会在 diagnostics 中切换标的，会干扰本流程的报价头断言
      sessionStorage.setItem("aka.s2.diag.once", "1");
      setDiagStatus("E-01 取证：运行中");
      try {
        const report = await runMarketDiagnostics();
        setDiagStatus(
          `E-01 取证：${report.ok ? "通过" : "失败"} → ${(report.writtenTo ?? "").split("/").pop()}`,
        );
      } catch (err) {
        setDiagStatus(`E-01 取证：失败 ${describeError(err).message}`);
      }
    })();
  }, [snapshot, viewLoaded, loading]);

  const watched = useMemo(
    () => new Set((watchlist?.items ?? []).map((item) => item.security)),
    [watchlist],
  );

  const rows = useMemo(() => {
    if (!snapshot) return [];
    const filtered = snapshot.rows.filter((row) => sameBoard(row, view.board));
    return sortRows(filtered, view.sortKey, view.sortDir);
  }, [snapshot, view.board, view.sortKey, view.sortDir]);

  const boardCounts = useMemo(() => {
    const counts: Record<MarketBoard, number> = { all: 0, sh: 0, sz: 0, chinext: 0, star: 0 };
    for (const row of snapshot?.rows ?? []) {
      for (const board of MARKET_BOARDS) {
        if (sameBoard(row, board.key)) counts[board.key] += 1;
      }
    }
    return counts;
  }, [snapshot]);

  const visible = useMemo(() => {
    if (narrow) return new Set<MarketColumn>(["code", "name", "lastPrice", "changePct"]);
    return new Set(view.columns);
  }, [narrow, view.columns]);

  const openRow = (security: string) => {
    sessionStorage.setItem(SELECTED_KEY, security);
    if (tableRef.current) sessionStorage.setItem(SCROLL_KEY, String(tableRef.current.scrollTop));
    onOpenSecurity(security);
  };

  const toggleStar = async (security: string) => {
    const wasWatched = watched.has(security);
    setWatchlist((current) =>
      current
        ? {
            ...current,
            total: Math.max(0, current.total + (wasWatched ? -1 : 1)),
            items: wasWatched
              ? current.items.filter((item) => item.security !== security)
              : [...current.items, { security, groupName: "全部", sortOrder: current.items.length }],
          }
        : current,
    );
    try {
      const result = await ipc.toggleWatch(security);
      setWatchlist((current) => (current ? { ...current, total: result.total } : current));
    } catch (err) {
      setWatchlist((current) =>
        current
          ? {
              ...current,
              total: Math.max(0, current.total + (wasWatched ? 1 : -1)),
              items: wasWatched
                ? [...current.items, { security, groupName: "全部", sortOrder: current.items.length }]
                : current.items.filter((item) => item.security !== security),
            }
          : current,
      );
      setToast(describeError(err).message);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const index = Math.max(0, rows.findIndex((row) => row.security === selected));
      const next = Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
      const code = rows[next].security;
      setSelected(code);
      sessionStorage.setItem(SELECTED_KEY, code);
      tableRef.current?.querySelector<HTMLElement>(`[data-code="${code}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && selected) {
      event.preventDefault();
      openRow(selected);
    }
  };

  const toggleColumn = (key: MarketColumn) => {
    if (LOCKED_COLUMNS.includes(key)) return;
    setView((current) => ({
      ...current,
      columns: current.columns.includes(key)
        ? current.columns.filter((item) => item !== key)
        : [...current.columns, key],
    }));
  };

  return (
    <AppShell active="market" onNavigate={onNavigate}>
      <main className="market" data-market-root="p1">
        <header className="market-head">
          <div>
            <h1>行情</h1>
            <p className="market-sub" data-market-summary>
              样本 {snapshot?.sampleCount ?? 0} 只
              {snapshot && ` · ${snapshot.dataDate} 收盘`}
            </p>
          </div>
          <div className="market-head-right">
            <SimBadge />
            {snapshot && (
              <span className="market-version mono" title={snapshot.datasetId}>
                {snapshot.dataVersion || snapshot.datasetId.slice(0, 8)}
              </span>
            )}
            <div className="seg" role="group" aria-label="板块分区">
              {MARKET_BOARDS.map((board) => (
                <button
                  key={board.key}
                  type="button"
                  className={view.board === board.key ? "selected" : ""}
                  data-market-board={board.key}
                  data-count={boardCounts[board.key]}
                  onClick={() => setView((current) => ({ ...current, board: board.key }))}
                >
                  {board.label} <b>{boardCounts[board.key]}</b>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="ghost"
              data-market-columns-toggle
              onClick={() => setColumnPanel((open) => !open)}
            >
              列设置
            </button>
          </div>
        </header>

        {columnPanel && (
          <div className="market-columns" data-market-columns>
            {MARKET_COLUMNS.map((column) => (
              <label key={column.key} className={column.locked ? "locked" : ""}>
                <input
                  type="checkbox"
                  checked={column.locked || view.columns.includes(column.key)}
                  disabled={column.locked}
                  data-market-column={column.key}
                  onChange={() => toggleColumn(column.key)}
                />
                {column.label}
                {column.locked && <span aria-hidden> 🔒</span>}
              </label>
            ))}
            <button type="button" className="ghost" onClick={() => setView((current) => ({ ...current, columns: DEFAULT_VIEW.columns }))}>
              恢复默认
            </button>
          </div>
        )}

        {toast && <div className="market-toast" role="status">{toast}</div>}

        {error && (
          <StateCard
            tone="error"
            title="行情数据加载失败"
            description="本地数据读取未完成，列表未渲染，避免展示半截数据。"
            error={error}
            actionLabel="重试"
            onAction={() => void load()}
            anchor="market-error"
          />
        )}

        {!error && loading && !slow && <div className="market-skeleton-placeholder" aria-hidden />}
        {!error && loading && slow && (
          <div className="market-skeleton" data-market-skeleton>
            {Array.from({ length: 10 }).map((_, index) => (
              <div key={index} className="skeleton-row" />
            ))}
          </div>
        )}

        {!error && !loading && (rows.length === 0 ? (
          <StateCard
            tone="empty"
            title="该分区暂无样本"
            description="当前板块分区内没有可展示的证券。"
            actionLabel="切回全部"
            onAction={() => setView((current) => ({ ...current, board: "all" }))}
            anchor="market-empty"
          />
        ) : (
          <div className="market-table-wrap">
            <div
              className="market-table"
              role="grid"
              tabIndex={0}
              ref={tableRef}
              onKeyDown={onKeyDown}
              onScroll={(event) => sessionStorage.setItem(SCROLL_KEY, String(event.currentTarget.scrollTop))}
              data-market-table
            >
              <div className="market-row market-row--head" role="row">
                <span className="market-cell market-cell--star" aria-label="自选" />
                {MARKET_COLUMNS.filter((column) => visible.has(column.key)).map((column) => (
                  <button
                    key={column.key}
                    type="button"
                    role="columnheader"
                    className={`market-cell market-cell--head ${column.numeric ? "num" : ""}`}
                    data-market-sort={column.key}
                    data-sort-dir={view.sortKey === column.key ? view.sortDir : ""}
                    onClick={() => {
                      const next = nextSort({ key: view.sortKey, dir: view.sortDir }, column.key);
                      setView((current) => ({ ...current, sortKey: next.key, sortDir: next.dir }));
                    }}
                  >
                    {column.label}
                    {view.sortKey === column.key && <i className="sort-mark">{view.sortDir === "desc" ? "↓" : "↑"}</i>}
                  </button>
                ))}
                <span className="market-cell market-cell--flags num">状态</span>
              </div>

              {rows.map((row) => (
                <div
                  key={row.security}
                  className={`market-row ${selected === row.security ? "selected" : ""}`}
                  role="row"
                  tabIndex={-1}
                  data-market-row
                  data-code={row.security}
                  data-selected={selected === row.security ? "1" : "0"}
                  data-suspended={row.suspended ? "1" : "0"}
                  onClick={() => {
                    setSelected(row.security);
                    openRow(row.security);
                  }}
                >
                  <span className="market-cell market-cell--star">
                    <button
                      type="button"
                      className={`star ${watched.has(row.security) ? "watched" : ""}`}
                      aria-label={watched.has(row.security) ? "移出自选" : "加入自选"}
                      data-star={row.security}
                      data-watched={watched.has(row.security) ? "1" : "0"}
                      onClick={(event) => {
                        event.stopPropagation();
                        void toggleStar(row.security);
                      }}
                    />
                  </span>
                  {visible.has("code") && (
                    <span className="market-cell mono" data-cell="code">{row.code}</span>
                  )}
                  {visible.has("name") && (
                    <span className="market-cell" data-cell="name">
                      {row.name}
                      {row.flags.includes("LIMIT_UP") && <em className="flag flag--up">涨停</em>}
                      {row.flags.includes("LIMIT_DOWN") && <em className="flag flag--down">跌停</em>}
                      {row.suspended && <em className="flag">停牌</em>}
                      {row.dataIssue && <em className="flag flag--warn">数据异常</em>}
                    </span>
                  )}
                  {visible.has("lastPrice") && (
                    <span className="market-cell num mono" data-cell="lastPrice">
                      {row.lastPrice == null ? "—" : formatPrice(row.lastPrice)}
                    </span>
                  )}
                  {visible.has("changePct") && (
                    <span
                      className={`market-cell num mono ${signClass(row.changePct)}`}
                      data-cell="changePct"
                      data-pct={row.changePct == null ? "" : formatPct(row.changePct)}
                    >
                      {row.changePct == null ? "—" : formatPct(row.changePct)}
                    </span>
                  )}
                  {visible.has("changeAbs") && (
                    <span className={`market-cell num mono ${signClass(row.changeAbs)}`} data-cell="changeAbs">
                      {row.changeAbs == null ? "—" : formatSigned(row.changeAbs)}
                    </span>
                  )}
                  {visible.has("amount") && (
                    <span className="market-cell num mono" data-cell="amount" data-value={row.amount ?? ""}>
                      {row.amount == null ? "—" : formatAmount(row.amount)}
                    </span>
                  )}
                  {visible.has("turnoverPct") && (
                    <span
                      className="market-cell num mono"
                      data-cell="turnoverPct"
                      data-value={row.turnoverPct ?? ""}
                    >
                      {row.turnoverPct == null ? "—" : formatPct(row.turnoverPct)}
                    </span>
                  )}
                  {visible.has("volumeRatio") && (
                    <span
                      className="market-cell num mono"
                      data-cell="volumeRatio"
                      data-value={row.volumeRatio ?? ""}
                    >
                      {row.volumeRatio == null ? "—" : row.volumeRatio.toFixed(2)}
                    </span>
                  )}
                  {visible.has("amplitudePct") && (
                    <span
                      className="market-cell num mono"
                      data-cell="amplitudePct"
                      data-value={row.amplitudePct ?? ""}
                    >
                      {row.amplitudePct == null ? "—" : formatPct(row.amplitudePct)}
                    </span>
                  )}
                  <span className="market-cell market-cell--flags num">
                    {row.isIndex && <em className="flag">指数</em>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}

        <footer className="market-foot">
          <span>视图设置保存在本地 state.db（分区 / 排序 / 列显隐）</span>
          {diagStatus && <span data-market-diag>{diagStatus}</span>}
          <span data-market-count>当前 {rows.length} 行</span>
        </footer>
      </main>
    </AppShell>
  );
}
