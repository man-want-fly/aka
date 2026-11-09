import { useEffect, useMemo, useRef, useState } from "react";
import { AppShell, type RouteKey } from "../../app/AppShell";
import { FavoritesStrip } from "../../features/catalog/FavoritesStrip";
import { addIndicatorToChart, chartStateOf, readLastCode } from "../../features/catalog/chartLink";
import { useFavorites } from "../../features/catalog/useFavorites";
import { runCatalogDiagnostics } from "../../features/catalog/catalogDiag";
import {
  runS030104Diagnostics,
  runS030201Diagnostics,
  runS030302CatalogDiagnostics,
  writeDiagnosticFailure,
} from "../../features/qa/batchDiag";
import { Highlight, PANEL_LABEL, searchIndicators } from "../../features/indicators/search";
import { describeError, ipc, isTauriRuntime } from "../../lib/ipc";
import type { AppError, Category, ManifestIndicatorDto, ManifestResponse } from "../../lib/types";

interface Props {
  onNavigate: (key: RouteKey) => void;
  /** S-03.01-04：目录「在工作台查看」复用既有路由，把最近标的带过去。 */
  onOpenWorkbench?: (code: string) => void;
}

const DETAIL_HASH_PREFIX = "#/catalog/";
const RETURN_STATE_KEY = "aka.catalog.return";

type DetailFrom = "catalog" | "drawer" | "chart";

interface DetailOrigin {
  from: DetailFrom;
  code: string | null;
}

interface CatalogReturnState {
  activeId: string | null;
  expanded: Category[];
  scrollTop: number;
  query: string;
  showAll: boolean;
}

const readDetailHash = (): string | null => {
  const hash = window.location.hash;
  if (!hash.startsWith(DETAIL_HASH_PREFIX)) return null;
  const id = hash.slice(DETAIL_HASH_PREFIX.length).split("?")[0]?.trim();
  return id || null;
};

/** S-03.03-02：记录来源（目录 / 抽屉 / 图例），决定面包屑与返回目标。 */
const readDetailOrigin = (): DetailOrigin => {
  const hash = window.location.hash;
  const index = hash.indexOf("?");
  if (index < 0) return { from: "catalog", code: null };
  const params = new URLSearchParams(hash.slice(index + 1));
  const raw = params.get("from");
  const from: DetailFrom = raw === "drawer" || raw === "chart" ? raw : "catalog";
  return { from, code: params.get("code") };
};

const detailHashOf = (id: string, origin: DetailOrigin): string =>
  `${DETAIL_HASH_PREFIX}${encodeURIComponent(id)}?from=${origin.from}${
    origin.code ? `&code=${encodeURIComponent(origin.code)}` : ""
  }`;

const CATEGORIES: Array<{ key: Category; label: string }> = [
  { key: "trend", label: "趋势" },
  { key: "momentum", label: "动量" },
  { key: "volatility", label: "波动" },
  { key: "volume", label: "量能" },
  { key: "stat", label: "统计" },
  { key: "breadth", label: "广度" },
];

const categoryLabel = (key: Category) =>
  CATEGORIES.find((entry) => entry.key === key)?.label ?? key;

const sourceLabel = (item: ManifestIndicatorDto) => {
  if (item.status === "planned") {
    if (item.specStatus === "manualComplete") return "《技术指标全能手册》· 完整覆盖";
    if (item.specStatus === "partial") return "《技术指标全能手册》· 部分覆盖，口径由 BA 定";
    return "手册未覆盖 · 本产品定义，待 BA 拍板";
  }
  if (item.isCompletion) return "本产品补全口径 · PRD 附录 A";
  if (item.completeness === "beta") return "PRD beta 口径 · 待裁定";
  return `PRD 附录 A · 引擎 v${item.version}`;
};

/** 默认参数只有两个来源：已实现项从 manifest `params.default` 派生，规划项用 PRD 文本兜底。 */
const defaultParamsText = (item: ManifestIndicatorDto) => {
  if (item.params.length > 0) {
    return item.params.map((param) => String(param.default)).join(" / ");
  }
  return item.defaultParamsText || "—";
};

const dataRequirement = (item: ManifestIndicatorDto) => {
  if (!item.warmupBars) return "—";
  return `至少 ${item.warmupBars} 根 K 线（首个有效值下标 ${item.warmupBars - 1}，0 基）`;
};

/**
 * P3 指标目录（S-03.01-01 / S-03.01-03）。
 *
 * 所有条目、四个元信息字段、计数全部来自 manifest，页面不保存任何指标副本。
 * 全量条目按分类分组；分类首次展开时才挂载行（首屏只渲染已展开分类的行），
 * 计数则由 manifest 同源计算、一次性渲染。
 */
export function CatalogPage({ onNavigate, onOpenWorkbench }: Props) {
  const [manifest, setManifest] = useState<ManifestResponse | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [summaryId, setSummaryId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<Set<Category>>(() => new Set(["trend"]));
  const [missingId, setMissingId] = useState<string | null>(null);
  const [origin, setOrigin] = useState<DetailOrigin>(() => readDetailOrigin());
  const [lastCode, setLastCode] = useState<string | null>(() => readLastCode());
  const [chartHint, setChartHint] = useState<string | null>(null);
  const [chartNonce, setChartNonce] = useState(0);
  const listRef = useRef<HTMLElement | null>(null);

  const favoritesState = useFavorites(manifest !== null);

  useEffect(() => {
    if (!isTauriRuntime()) {
      setError({ code: "NO_TAURI", message: "指标目录需要桌面应用运行时", retryable: false });
      return;
    }
    ipc
      .indicatorManifest()
      .then((man) => {
        setManifest(man);
        const requested = readDetailHash();
        if (requested) {
          if (man.indicators.some((item) => item.id === requested)) {
            setActiveId(requested);
          } else {
            setMissingId(requested);
          }
          return;
        }
        const first = man.indicators
          .filter((item) => item.category === "trend")
          .sort((a, b) => a.id.localeCompare(b.id))[0];
        setActiveId(first?.id ?? null);
      })
      .catch((err) => setError(describeError(err)));
  }, []);

  // S-03.03-02：深链 `#/catalog/<id>`；浏览器前进/后退与目录内跳转共用同一入口。
  useEffect(() => {
    if (!manifest) return;
    const onHash = () => {
      const requested = readDetailHash();
      setOrigin(readDetailOrigin());
      if (!requested) {
        setActiveId(null);
        setMissingId(null);
        return;
      }
      if (manifest.indicators.some((item) => item.id === requested)) {
        setActiveId(requested);
        setMissingId(null);
      } else {
        setMissingId(requested);
        setActiveId(null);
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [manifest]);

  // S-03.03-02：Esc 返回目录，恢复展开分类与滚动位置（偏差 ≤1 行）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!readDetailHash()) return;
      event.preventDefault();
      returnToSource();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const items = manifest?.indicators ?? [];
  const manifestById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);

  // S-03.01-01 取证：AKA_DIAG_TARGET=catalog 时在 manifest 就绪后自跑一次
  useEffect(() => {
    if (!isTauriRuntime() || !manifest) return;
    let alive = true;
    (async () => {
      const target = await ipc.diagTarget();
      const enabled =
        target === "catalog" ||
        target === "s030104" ||
        target === "s030201" ||
        target === "s030302-catalog"
          ? await ipc.diagEnabled()
          : false;
      if (!enabled || !alive) return;
      const guardKey = `aka.batch.${target}.done`;
      if (window.sessionStorage.getItem(guardKey) === "1") return;
      window.sessionStorage.setItem(guardKey, "1");
      if (target === "catalog") {
        window.sessionStorage.setItem("aka.catalog.diag.done", "1");
      }
      try {
        if (target === "catalog") {
          const report = await runCatalogDiagnostics(manifest);
          if (!alive) return;
          (window as unknown as Record<string, unknown>).__AKA_CATALOG_EVIDENCE__ = report;
        } else if (target === "s030104") {
          await runS030104Diagnostics(manifest);
        } else if (target === "s030201") {
          await runS030201Diagnostics();
        } else if (target === "s030302-catalog") {
          await runS030302CatalogDiagnostics();
        }
      } catch (err) {
        const message = describeError(err).message;
        console.error("[catalog.diag]", message);
        // W-118：套件异常中断也必须落 dump，否则 240s 只能看到「一个文件都没有」，
        // 无法区分「没跑完」和「等待路径错」。文件名与成功证据一致，等待循环见到
        // 新文件即结束；ok:false / error / blocked[] 由第 31 条判失败记录，不计份数、不可签。
        const failureFileByTarget: Record<string, string> = {
          catalog: "s03010-evidence.json",
          s030104: "s030104-evidence.json",
          s030201: "s030201-favorites-evidence.json",
          "s030302-catalog": "s030302-catalog-evidence.json",
        };
        const failureFile = failureFileByTarget[target];
        if (failureFile) {
          await writeDiagnosticFailure(failureFile, target, err).catch(() => undefined);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [manifest]);

  const declaredTotal = manifest?.catalogTotal ?? 0;
  const total = items.length;
  const mismatch = manifest !== null && declaredTotal !== total;

  useEffect(() => {
    if (!mismatch) return;
    console.warn("[registry.count_mismatch]", { declared: declaredTotal, actual: total });
  }, [mismatch, declaredTotal, total]);

  const groups = useMemo(
    () =>
      CATEGORIES.map((entry) => {
        const list = items
          .filter((item) => item.category === entry.key)
          .sort((a, b) => a.id.localeCompare(b.id));
        return { ...entry, items: list, count: list.length };
      }),
    [items],
  );

  const plannedCount = useMemo(
    () => items.filter((item) => item.status === "planned").length,
    [items],
  );
  const p0Count = useMemo(() => items.filter((item) => item.priority === "P0").length, [items]);
  const p1Count = total - p0Count;

  const results = useMemo(
    () => (query.trim() ? searchIndicators(items, query) : null),
    [items, query],
  );

  /** S-08.01-02：可添加 = status ∈ {normal, beta}，与注册表运行时同源，不写死。 */
  const addableCount = useMemo(
    () => items.filter((item) => item.status === "normal" || item.status === "beta").length,
    [items],
  );
  const searchEmpty = results !== null && results.length === 0;
  const lastEmptyLog = useRef("");

  useEffect(() => {
    if (!searchEmpty) return;
    const key = query.trim();
    if (lastEmptyLog.current === key) return;
    lastEmptyLog.current = key;
    console.info("[empty.search]", {
      scope: "indicator",
      query: key.slice(0, 30),
      total,
      addable: addableCount,
    });
  }, [searchEmpty, query, total, addableCount]);

  const clearSearch = () => {
    setQuery("");
    setShowAll(false);
  };

  const browseAll = () => {
    setQuery("");
    setShowAll(true);
  };

  const changeQuery = (value: string) => {
    setQuery(value);
    setShowAll(false);
  };

  function rememberReturnState() {
    const state: CatalogReturnState = {
      activeId,
      expanded: [...expanded],
      scrollTop: listRef.current?.scrollTop ?? 0,
      query,
      showAll,
    };
    try {
      window.sessionStorage.setItem(RETURN_STATE_KEY, JSON.stringify(state));
    } catch {
      // 返回态只影响体验，存储不可用时退回默认分类
    }
  }

  /** S-03.03-02：Esc 返回目录；用 replaceState 避免路由重挂载。 */
  function returnToCatalog() {
    rememberReturnState();
    let state: CatalogReturnState | null = null;
    try {
      const raw = window.sessionStorage.getItem(RETURN_STATE_KEY);
      if (raw) state = JSON.parse(raw) as CatalogReturnState;
    } catch {
      state = null;
    }
    history.replaceState(null, "", "#/catalog");
    setMissingId(null);
    setSummaryId(null);
    setChartHint(null);
    if (state) {
      setExpanded(new Set(state.expanded));
      setQuery(state.query);
      setShowAll(state.showAll);
      setActiveId(state.activeId);
      const top = state.scrollTop;
      window.requestAnimationFrame(() => {
        if (listRef.current) listRef.current.scrollTop = top;
      });
    }
  }

  /** S-03.03-02：Esc/上级面包屑返回来源；图例与抽屉来源回工作台，目录来源回目录并还原状态。 */
  function returnToSource() {
    if (origin.from === "catalog" || !origin.code) {
      returnToCatalog();
      return;
    }
    if (origin.from === "drawer") {
      try {
        window.sessionStorage.setItem("aka.workbench.drawer.return", "1");
      } catch {
        // 返回态只影响体验，存储不可用时不阻断返回
      }
    }
    window.location.hash = `#/workbench/${encodeURIComponent(origin.code)}`;
  }

  /** S-03.03-02：目录行「查看口径」写入深链，供返回/刷新/外部入口复用。 */
  function openDetail(item: ManifestIndicatorDto) {
    if (!manifestById.has(item.id)) return;
    rememberReturnState();
    const next: DetailOrigin = origin.from === "catalog" ? { from: "catalog", code: null } : origin;
    setOrigin(next);
    if (next.from === "catalog") {
      history.replaceState(null, "", detailHashOf(item.id, next));
    } else {
      window.location.hash = detailHashOf(item.id, next);
    }
    setActiveId(item.id);
    setMissingId(null);
    setSummaryId(null);
    setChartHint(null);
  }

  /** S-03.01-04：目录加入图表；容量/去重/规划项规则与抽屉一致。 */
  function handleAddToChart(item: ManifestIndicatorDto) {
    if (item.status === "planned") {
      setChartHint("该指标规划中，本期未开放");
      return;
    }
    if (item.priority === "P1") {
      setChartHint("该项为 P1，加入图表前需先确认口径");
      return;
    }
    const code = readLastCode();
    setLastCode(code);
    if (!code) {
      setChartHint("请先在行情页选择一只标的");
      return;
    }
    const result = addIndicatorToChart(item);
    if (result.status === "duplicate") {
      setChartHint("该指标已在图表中");
    } else if (result.status === "full") {
      setChartHint(
        result.capacity > 2
          ? `副图已满（${result.count}/${result.capacity}），请先移除一个`
          : `主图叠加已满（${result.count}/${result.capacity}），请先移除一个`,
      );
    } else {
      setChartHint("已加入工作台");
    }
    setChartNonce((value) => value + 1);
  }

  const toggleFavorite = (item: ManifestIndicatorDto, favorited: boolean) => {
    void favoritesState.toggle(item.id, favorited);
  };

  const active = activeId ? items.find((item) => item.id === activeId) : undefined;

  const toggleCategory = (key: Category) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderRow = (item: ManifestIndicatorDto) => {
    const planned = item.status === "planned";
    const favorite = favoritesState.favorites?.some((entry) => entry.indicatorId === item.id) ?? false;
    const chart = chartStateOf(item);
    const addState = planned
      ? "planned"
      : chart.inChart
        ? "added"
        : !lastCode
          ? "no-symbol"
          : chart.count >= chart.capacity
            ? "full"
            : "addable";
    const addLabel = planned
      ? "规划中"
      : chart.inChart
        ? "已加入"
        : addState === "full"
          ? chart.capacity > 2
            ? "副图已满"
            : "叠加已满"
          : "加入图表";
    const addTitle = planned
      ? "该指标规划中，本期未开放"
      : chart.inChart
        ? "已加入图表"
        : addState === "full"
          ? chart.capacity > 2
            ? `副图已满（${chart.count}/${chart.capacity}），请先移除一个`
            : `主图叠加已满（${chart.count}/${chart.capacity}），请先移除一个`
          : addState === "no-symbol"
            ? "请先在行情页选择一只标的"
            : `加入图表（${chart.count}/${chart.capacity}）`;
    return (
      <li
        key={item.id}
        data-catalog-item={item.id}
        data-catalog-status={item.status}
        data-catalog-category={item.category}
        data-catalog-priority={item.priority}
        data-catalog-completeness={item.completeness}
        data-catalog-panel={item.panel}
        data-catalog-completion={item.isCompletion ? "1" : "0"}
        className={`catalog-row${planned ? " catalog-row--planned" : ""}`}
      >
        <div className="catalog-row__head">
          <button
            type="button"
            className="catalog-row__select"
            aria-pressed={activeId === item.id}
            onClick={() => setActiveId(item.id)}
          >
            <span className="mono catalog-row__id">{item.id}</span>
            <span className="catalog-row__name">
              <Highlight text={item.nameZh} query={query} />
            </span>
            <span className="mono catalog-row__abbr">{item.abbr || item.nameEn}</span>
          </button>
          <div className="catalog-row__tags">
            <span className="tag">{PANEL_LABEL[item.panel] ?? item.panel}</span>
            {item.priority === "P1" && <span className="tag tag--warn">P1</span>}
            {item.isCompletion && <span className="tag tag--beta">补全口径</span>}
            {item.completeness === "beta" && <span className="tag tag--accent">beta</span>}
            {planned && <span className="tag tag--muted">规划中</span>}
            {planned && (
              <span className="tag tag--muted" data-catalog-not-addable={item.id}>
                暂不可添加
              </span>
            )}
            {planned && item.specStatus !== "manualComplete" && (
              <span className="tag tag--accent" data-catalog-spec-pending={item.id}>
                口径待定
              </span>
            )}
          </div>
          <div className="catalog-row__actions">
            <button
              type="button"
              className="catalog-row__fav"
              data-fav-star={item.id}
              aria-pressed={favorite}
              aria-label={`${favorite ? "取消收藏" : "收藏"} ${item.nameZh}`}
              disabled={favoritesState.busyId === item.id}
              onClick={() => toggleFavorite(item, !favorite)}
            >
              {favorite ? "★" : "☆"}
            </button>
            <button
              type="button"
              className="catalog-row__add"
              data-catalog-add={item.id}
              data-catalog-add-state={addState}
              title={addTitle}
              aria-disabled={planned || undefined}
              disabled={chart.inChart || addState === "full" || addState === "no-symbol"}
              onClick={() => handleAddToChart(item)}
            >
              {addLabel}
            </button>
            {addState === "full" && (
              <span className="catalog-row__hint caption" data-catalog-add-hint={item.id}>
                {addTitle}
              </span>
            )}
            {chart.inChart && lastCode && onOpenWorkbench && (
              <button
                type="button"
                className="catalog-row__open caption"
                data-catalog-view-workbench={item.id}
                onClick={() => onOpenWorkbench(lastCode)}
              >
                在工作台查看
              </button>
            )}
            <button
              type="button"
              className="catalog-row__open caption"
              data-catalog-open-detail={item.id}
              onClick={() => openDetail(item)}
            >
              查看口径
            </button>
            <button
              type="button"
              className="catalog-row__toggle caption"
              data-catalog-summary-toggle={item.id}
              aria-expanded={summaryId === item.id}
              onClick={() => setSummaryId((prev) => (prev === item.id ? null : item.id))}
            >
              {summaryId === item.id ? "收起" : "摘要"}
            </button>
          </div>
        </div>
        {summaryId === item.id && (
          <dl className="catalog-summary" data-catalog-summary={item.id}>
            <div>
              <dt>默认参数</dt>
              <dd className="mono">{defaultParamsText(item)}</dd>
            </div>
            <div>
              <dt>数据要求</dt>
              <dd>{dataRequirement(item)}</dd>
            </div>
            <div>
              <dt>适用周期</dt>
              <dd>日线 · 周线 · 月线</dd>
            </div>
            <div>
              <dt>口径来源</dt>
              <dd>{sourceLabel(item)}</dd>
            </div>
          </dl>
        )}
      </li>
    );
  };

  return (
    <AppShell active="catalog" onNavigate={onNavigate}>
      <div className="catalog-page">
        <aside className="catalog-list" data-catalog-root="p3" data-catalog-chart-nonce={chartNonce} ref={listRef}>
          <h1 style={{ fontSize: 18, margin: "0 0 4px" }}>指标目录</h1>
          <div
            className="caption"
            data-catalog-total={total}
            data-catalog-declared={declaredTotal}
            data-catalog-mismatch={mismatch ? "1" : "0"}
            style={{ marginBottom: 12 }}
          >
            {total} 条 · P0 {p0Count} / P1 {p1Count} · 规划中 {plannedCount}
          </div>
          {mismatch && (
            <div className="error-box" data-catalog-warn="count-mismatch" style={{ marginBottom: 12 }}>
              注册表与 PRD 不一致：声明 {declaredTotal} 条，实际 {total} 条。已写诊断日志。
            </div>
          )}
          <FavoritesStrip
            favorites={favoritesState.favorites}
            manifestById={manifestById}
            busyId={favoritesState.busyId}
            onToggleFavorite={(id, favorited) => void favoritesState.toggle(id, favorited)}
            onAdd={handleAddToChart}
            onOpenDetail={(id) => {
              const item = manifestById.get(id);
              if (item) openDetail(item);
            }}
            hint={chartHint}
          />
          {favoritesState.error && (
            <div className="error-box" data-fav-error="1" style={{ marginBottom: 12 }}>
              {favoritesState.error}
            </div>
          )}
          <div
            className="catalog-target"
            data-catalog-no-target={lastCode ? "0" : "1"}
            data-catalog-last-code={lastCode ?? ""}
            style={{ marginBottom: 10 }}
          >
            {lastCode ? (
              <span className="caption">
                最近标的 <span className="mono">{lastCode}</span> · 加入后可在工作台查看
              </span>
            ) : (
              <span className="caption">
                请先在行情页选择一只标的 ·{" "}
                <button
                  type="button"
                  className="btn"
                  data-catalog-go-market="1"
                  onClick={() => onNavigate("market")}
                >
                  去行情页
                </button>
              </span>
            )}
          </div>
          <input
            type="search"
            aria-label="搜索指标"
            data-catalog-search-input="1"
            placeholder="搜代码 / 名称 / 拼音，如 MACD / md / junxian"
            value={query}
            disabled={!manifest}
            onChange={(event) => changeQuery(event.target.value)}
            style={{ width: "100%", marginBottom: 12 }}
          />

          {results ? (
            results.length === 0 ? (
              <section className="catalog-empty" data-catalog-empty="indicator" role="status">
                <div className="catalog-empty__title" data-catalog-empty-title="1">
                  未找到指标 “{query.trim().slice(0, 30)}”
                </div>
                <p className="catalog-empty__desc" data-catalog-empty-desc="1">
                  仅搜索目录内{" "}
                  <span className="mono" data-catalog-empty-total={total}>
                    {total}
                  </span>{" "}
                  个指标（其中{" "}
                  <span className="mono" data-catalog-empty-addable={addableCount}>
                    {addableCount}
                  </span>{" "}
                  个可添加）
                </p>
                <div className="catalog-empty__actions">
                  <button type="button" className="btn" onClick={clearSearch}>
                    清空
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    data-catalog-browse-all="1"
                    onClick={browseAll}
                  >
                    浏览全部指标
                  </button>
                </div>
              </section>
            ) : (
              <section data-catalog-search="">
                <div className="caption" data-catalog-search-scope="1">
                  仅搜索目录内 {total} 个指标（其中 {addableCount} 个可添加）
                </div>
                <div className="caption" style={{ marginBottom: 6 }}>
                  找到 {results.length} / {total} 条
                </div>
                <ul className="catalog-rows">{results.map(renderRow)}</ul>
              </section>
            )
          ) : showAll ? (
            <section data-catalog-all="1">
              <div className="caption" style={{ marginBottom: 6 }}>
                全部 {total} 条 · 可添加 {addableCount} · 规划中 {plannedCount}
              </div>
              <ul className="catalog-rows">
                {[...items].sort((a, b) => a.id.localeCompare(b.id)).map(renderRow)}
              </ul>
            </section>
          ) : (
            groups.map((group) => (
              <section
                key={group.key}
                data-catalog-category-group={group.key}
                data-catalog-cat-count={group.count}
                style={{ marginBottom: 10 }}
              >
                <button
                  type="button"
                  className="catalog-cat"
                  data-catalog-cat-toggle={group.key}
                  aria-expanded={expanded.has(group.key)}
                  onClick={() => toggleCategory(group.key)}
                >
                  <span>{group.label}</span>
                  <span className="mono catalog-cat__count" data-catalog-cat-count-text="1">
                    {group.count}
                  </span>
                </button>
                {expanded.has(group.key) && (
                  <ul className="catalog-rows">{group.items.map(renderRow)}</ul>
                )}
              </section>
            ))
          )}
        </aside>

        <main
          className="catalog-detail"
          data-catalog-detail="1"
          data-catalog-active={active?.id ?? ""}
          style={{ padding: "20px 24px", overflow: "auto" }}
        >
          {error && <div className="error-box">{error.message}</div>}
          {!manifest && !error && <div className="caption" data-catalog-loading="1">目录加载中…</div>}
          {missingId && (
            <section className="catalog-empty" data-catalog-missing={missingId} role="alert">
              <div className="catalog-empty__title" data-catalog-missing-title="1">
                指标不存在
              </div>
              <p className="catalog-empty__desc">
                找不到指标 <span className="mono">{missingId}</span>，可能已下线或链接有误。
              </p>
              <div className="catalog-empty__actions">
                <button
                  type="button"
                  className="btn primary"
                  data-catalog-missing-back="1"
                  onClick={returnToCatalog}
                >
                  回指标目录
                </button>
              </div>
            </section>
          )}
          {manifest && !active && !missingId && <div className="caption">从左侧列表选择一个指标查看口径。</div>}
          {active && (
            <>
              <nav
                className="caption"
                data-catalog-breadcrumb="1"
                data-catalog-breadcrumb-from={origin.from}
                style={{ marginBottom: 8 }}
              >
                <button
                  type="button"
                  className="catalog-crumb"
                  data-catalog-breadcrumb-up="1"
                  onClick={returnToSource}
                >
                  {origin.from === "catalog" ? "指标目录" : "工作台"}
                </button>
                {origin.from !== "catalog" && origin.code && (
                  <>
                    <span> / </span>
                    <span className="mono" data-catalog-breadcrumb-code={origin.code}>
                      {origin.code}
                    </span>
                  </>
                )}
                <span> {origin.from === "catalog" ? "›" : "/"} </span>
                <span data-catalog-breadcrumb-current={active.id}>{active.abbr || active.nameZh}</span>
                {readDetailHash() && (
                  <span className="mono" data-catalog-deep-link={readDetailHash() ?? ""} style={{ marginLeft: 8 }}>
                    {readDetailHash()}
                  </span>
                )}
              </nav>
              <header style={{ marginBottom: 16 }}>
                <div className="caption mono">
                  {active.id} · {categoryLabel(active.category)} · {active.status}
                </div>
                <h2 style={{ margin: "4px 0" }}>{active.nameZh}</h2>
                <div className="caption">
                  {active.nameEn} · 单位 {active.unit} · 引擎 v{active.version} ·{" "}
                  {active.specStatus === "manualComplete" ? "已人工校对" : "口径待裁定"}
                </div>
                <button
                  type="button"
                  className="btn"
                  data-catalog-detail-add={active.id}
                  style={{ marginTop: 8 }}
                  aria-disabled={
                    active.status === "planned" ||
                    chartStateOf(active).count >= chartStateOf(active).capacity ||
                    undefined
                  }
                  disabled={chartStateOf(active).inChart}
                  onClick={() => handleAddToChart(active)}
                >
                  {chartStateOf(active).inChart ? "已加入图表" : "在图表中查看"}
                </button>
                {chartHint && (
                  <div className="caption" data-catalog-detail-hint="1" role="status" style={{ marginTop: 6 }}>
                    {chartHint}
                  </div>
                )}
              </header>

              <section data-catalog-section="formula" style={{ marginBottom: 18 }}>
                <h3 style={{ fontSize: 14, marginBottom: 6 }}>一、公式</h3>
                <p style={{ margin: 0 }}>{active.formulaSummary}</p>
                <div className="caption" style={{ marginTop: 4 }}>
                  公式引用：{active.formulaRef || "—"}
                </div>
              </section>

              <section data-catalog-section="params" style={{ marginBottom: 18 }}>
                <h3 style={{ fontSize: 14, marginBottom: 6 }}>二、参数</h3>
                {active.params.length === 0 ? (
                  <div className="caption">
                    {active.status === "planned"
                      ? `默认参数 ${defaultParamsText(active)}；参数定义待《技术指标全能手册》核定。`
                      : "无参数。"}
                  </div>
                ) : (
                  <table style={{ borderCollapse: "collapse", minWidth: 520 }}>
                    <thead>
                      <tr>
                        {["参数", "类型", "默认", "范围"].map((head) => (
                          <th
                            key={head}
                            style={{ textAlign: "left", padding: "6px 10px", borderBottom: "1px solid var(--line)" }}
                          >
                            {head}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {active.params.map((param) => (
                        <tr key={param.key}>
                          <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--line)" }}>
                            {param.label} <span className="mono caption">{param.key}</span>
                          </td>
                          <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--line)" }}>
                            {param.kind}
                          </td>
                          <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--line)" }} className="mono">
                            {"default" in param ? String(param.default) : "—"}
                          </td>
                          <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--line)" }} className="mono">
                            {"min" in param ? `${param.min} ~ ${param.max}` : "variants" in param ? param.variants.join(" | ") : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              <section data-catalog-section="warmup" style={{ marginBottom: 18 }}>
                <h3 style={{ fontSize: 14, marginBottom: 6 }}>三、预热</h3>
                <p style={{ margin: 0 }}>{dataRequirement(active)}</p>
                {active.outputs.length > 0 && (
                  <div className="caption" style={{ marginTop: 4 }}>
                    输出：{active.outputs.map((output) => `${output.labelZh}(${output.key})`).join("、")}
                  </div>
                )}
              </section>

              <section data-catalog-section="boundary">
                <h3 style={{ fontSize: 14, marginBottom: 6 }}>四、边界</h3>
                <p style={{ margin: 0 }}>{active.notes}</p>
                <div className="caption" style={{ marginTop: 4 }}>
                  口径来源：{sourceLabel(active)}
                </div>
              </section>
            </>
          )}
        </main>
      </div>
    </AppShell>
  );
}
