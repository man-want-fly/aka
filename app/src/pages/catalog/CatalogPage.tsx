import { useEffect, useMemo, useState } from "react";
import { AppShell } from "../../app/AppShell";
import { runCatalogDiagnostics } from "../../features/catalog/catalogDiag";
import { Highlight, PANEL_LABEL, searchIndicators } from "../../features/indicators/search";
import { describeError, ipc, isTauriRuntime } from "../../lib/ipc";
import type { AppError, Category, ManifestIndicatorDto, ManifestResponse } from "../../lib/types";

interface Props {
  onNavigate: (key: "workbench" | "market" | "catalog" | "settings" | "datasource") => void;
}

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
 * 105 条按分类分组；分类首次展开时才挂载行（首屏只渲染趋势 24 行），
 * 计数则由 manifest 同源计算、一次性渲染。
 */
export function CatalogPage({ onNavigate }: Props) {
  const [manifest, setManifest] = useState<ManifestResponse | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [summaryId, setSummaryId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<Category>>(() => new Set(["trend"]));

  useEffect(() => {
    if (!isTauriRuntime()) {
      setError({ code: "NO_TAURI", message: "指标目录需要桌面应用运行时", retryable: false });
      return;
    }
    ipc
      .indicatorManifest()
      .then((man) => {
        setManifest(man);
        const first = man.indicators
          .filter((item) => item.category === "trend")
          .sort((a, b) => a.id.localeCompare(b.id))[0];
        setActiveId(first?.id ?? null);
      })
      .catch((err) => setError(describeError(err)));
  }, []);

  // S-03.01-01 取证：AKA_DIAG_TARGET=catalog 时在 manifest 就绪后自跑一次
  useEffect(() => {
    if (!isTauriRuntime() || !manifest) return;
    if (window.sessionStorage.getItem("aka.catalog.diag.done") === "1") return;
    let alive = true;
    (async () => {
      const target = await ipc.diagTarget();
      const enabled = target === "catalog" ? await ipc.diagEnabled() : false;
      if (!enabled || !alive) return;
      window.sessionStorage.setItem("aka.catalog.diag.done", "1");
      try {
        const report = await runCatalogDiagnostics(manifest);
        if (!alive) return;
        (window as unknown as Record<string, unknown>).__AKA_CATALOG_EVIDENCE__ = report;
      } catch (err) {
        console.error("[catalog.diag]", describeError(err).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [manifest]);

  const items = manifest?.indicators ?? [];
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
            {planned && item.specStatus !== "manualComplete" && (
              <span className="tag tag--accent" data-catalog-spec-pending={item.id}>
                口径待定
              </span>
            )}
          </div>
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
        <aside className="catalog-list" data-catalog-root="p3">
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
          <input
            type="search"
            aria-label="搜索指标"
            data-catalog-search-input="1"
            placeholder="搜代码 / 名称 / 拼音，如 MACD / md / junxian"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            style={{ width: "100%", marginBottom: 12 }}
          />

          {results ? (
            <section data-catalog-search="">
              <div className="caption" style={{ marginBottom: 6 }}>
                找到 {results.length} / {total} 条
              </div>
              <ul className="catalog-rows">{results.map(renderRow)}</ul>
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

        <main className="catalog-detail" style={{ padding: "20px 24px", overflow: "auto" }}>
          {error && <div className="error-box">{error.message}</div>}
          {!manifest && !error && <div className="caption">正在载入指标注册表…</div>}
          {manifest && !active && <div className="caption">从左侧列表选择一个指标查看口径。</div>}
          {active && (
            <>
              <header style={{ marginBottom: 16 }}>
                <div className="caption mono">
                  {active.id} · {categoryLabel(active.category)} · {active.status}
                </div>
                <h2 style={{ margin: "4px 0" }}>{active.nameZh}</h2>
                <div className="caption">
                  {active.nameEn} · 单位 {active.unit} · 引擎 v{active.version} ·{" "}
                  {active.specStatus === "manualComplete" ? "已人工校对" : "口径待裁定"}
                </div>
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
