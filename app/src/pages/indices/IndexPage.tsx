import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, UIEvent } from "react";
import { AppShell, type RouteKey } from "../../app/AppShell";
import { SimBadge } from "../../components/SimBadge";
import { StateCard } from "../../components/StateCard";
import { formatDateTime } from "../../lib/datetime";
import { formatAmount, formatPct, formatPrice, formatSigned, signClass } from "../../lib/format";
import { describeError, ipc } from "../../lib/ipc";
import type { AppError, IndexRowDto, IndexSnapshotDto } from "../../lib/types";

/** S-04.01-02：区间口径（交易日），今日 / 5 日 / 20 日。 */
export type IndexRange = "today" | "d5" | "d20";

const RANGES: Array<{ key: IndexRange; label: string }> = [
  { key: "today", label: "今日" },
  { key: "d5", label: "5日" },
  { key: "d20", label: "20日" },
];

/** 各区间回看的交易日数 k；数据不足提示按故事卡用「需要 k+1 个交易日」。 */
const RANGE_DAYS: Record<IndexRange, number> = { today: 0, d5: 5, d20: 20 };

/** 离开指数页再返回时保留区间与滚动位置（模块级缓存，随窗口会话存活）。 */
const viewState: { range: IndexRange; scrollTop: number } = { range: "today", scrollTop: 0 };

/** S-04.01-01：4 张 KPI。 */
const KPIS: Array<{ key: string; label: string; hint: string }> = [
  { key: "leader", label: "领涨指数", hint: "表内涨跌幅最大" },
  { key: "laggard", label: "领跌指数", hint: "表内涨跌幅最小" },
  { key: "advancers", label: "上涨指数数", hint: "x / 样本指数数" },
  { key: "amount", label: "样本成交额合计", hint: "成分样本当日合计" },
];

const TABLE_COLUMNS: Array<{ key: string; label: string; numeric: boolean }> = [
  { key: "name", label: "名称", numeric: false },
  { key: "code", label: "代码", numeric: false },
  { key: "point", label: "点位", numeric: true },
  { key: "changeAbs", label: "涨跌额", numeric: true },
  { key: "changePct", label: "涨跌幅", numeric: true },
  { key: "amount", label: "成交额", numeric: true },
  { key: "members", label: "样本数", numeric: true },
  { key: "rangePct", label: "区间涨跌幅", numeric: true },
];

/** S-04.02-01：六桶互斥，判定优先级 停牌 > 涨停 > 跌停 > 上涨 > 下跌 > 平盘。 */
const BREADTH_BUCKETS: Array<{ key: string; label: string }> = [
  { key: "suspended", label: "停牌" },
  { key: "limitUp", label: "涨停" },
  { key: "limitDown", label: "跌停" },
  { key: "up", label: "上涨" },
  { key: "down", label: "下跌" },
  { key: "flat", label: "平盘" },
];

const LIMIT_CARDS: Array<{ key: string; label: string }> = [
  { key: "limitUp", label: "涨停家数" },
  { key: "limitDown", label: "跌停家数" },
  { key: "oneWord", label: "一字涨停家数" },
];

type NavKey = RouteKey;

/** 当前区间下的一行取值：null 表示该区间数据不足。 */
function rangeValue(row: IndexRowDto, key: IndexRange): number | null {
  return row.rangePct[key];
}

/** 区间降序、同值 code 升序、不可算排最后。 */
function compareByRange(a: IndexRowDto, b: IndexRowDto, key: IndexRange): number {
  const left = rangeValue(a, key);
  const right = rangeValue(b, key);
  if (left != null && right != null) {
    if (right !== left) return right - left;
    return a.code.localeCompare(b.code);
  }
  if (left != null) return -1;
  if (right != null) return 1;
  return a.code.localeCompare(b.code);
}

/** 当前区间的 KPI；全部不可算时三项均为 null，不回退今日值。 */
interface RangeKpi {
  leader: { name: string; value: number } | null;
  laggard: { name: string; value: number } | null;
  advancers: number | null;
}

function buildRangeKpi(rows: IndexRowDto[], key: IndexRange): RangeKpi {
  const scored = rows
    .map((row) => ({ row, value: rangeValue(row, key) }))
    .filter((item): item is { row: IndexRowDto; value: number } => item.value != null);
  if (scored.length === 0) return { leader: null, laggard: null, advancers: null };
  const desc = [...scored].sort((a, b) => b.value - a.value || a.row.code.localeCompare(b.row.code));
  const asc = [...scored].sort((a, b) => a.value - b.value || a.row.code.localeCompare(b.row.code));
  return {
    leader: { name: desc[0].row.name, value: desc[0].value },
    laggard: { name: asc[0].row.name, value: asc[0].value },
    advancers: scored.filter((item) => item.value > 0).length,
  };
}

function kpiValue(key: string, snapshot: IndexSnapshotDto, kpi: RangeKpi): string {
  switch (key) {
    case "leader":
      return kpi.leader ? `${kpi.leader.name} ${formatPct(kpi.leader.value)}` : "—";
    case "laggard":
      return kpi.laggard ? `${kpi.laggard.name} ${formatPct(kpi.laggard.value)}` : "—";
    case "advancers":
      return kpi.advancers == null ? "—" : `${kpi.advancers}/${snapshot.expectedCount}`;
    case "amount":
      return formatIndexAmount(snapshot.kpi.amountTotal);
    default:
      return "—";
  }
}

/** 故事卡口径：≥1 亿 `x.xx亿`、≥1 万 `x.xx万`，否则不展示。 */
function formatIndexAmount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || Math.abs(value) < 1e4) return "—";
  return formatAmount(value);
}

function kpiTone(key: string, kpi: RangeKpi | null): string {
  if (!kpi) return "flat";
  if (key === "leader") return signClass(kpi.leader?.value);
  if (key === "laggard") return signClass(kpi.laggard?.value);
  return "";
}

function insufficientHint(row: IndexRowDto, key: IndexRange): string {
  return `需要 ${RANGE_DAYS[key] + 1} 个交易日，当前 ${row.rangeDays[key]} 个`;
}

function cellText(row: IndexRowDto, key: string, range: IndexRange): string {
  switch (key) {
    case "name":
      return row.name;
    case "code":
      return row.code;
    case "point":
      return formatPrice(row.point);
    case "changeAbs":
      return row.changeAbs == null ? "—" : formatSigned(row.changeAbs);
    case "changePct":
      return row.changePct == null ? "—" : formatPct(row.changePct);
    case "amount":
      return formatIndexAmount(row.amount);
    case "members":
      return row.members == null ? "—" : String(row.members);
    case "rangePct": {
      const value = rangeValue(row, range);
      return value == null ? "—" : formatPct(value);
    }
    default:
      return "—";
  }
}

interface Props {
  onNavigate: (key: NavKey) => void;
  /** 第二个参数标记来源页，工作台返回时回到指数页（S-04.01-02）。 */
  onOpenSecurity: (security: string, from?: NavKey) => void;
}

/**
 * S-04.01-01：指数概览。
 *
 * 数据只来自 `index_snapshot` 的独立只读快照；点位/涨跌/成交额全部按
 * S-06.02-01 的统一格式输出，不在页面里写第二套口径。
 */
export function IndexPage({ onNavigate, onOpenSecurity }: Props) {
  const [range, setRange] = useState<IndexRange>(viewState.range);
  const [snapshot, setSnapshot] = useState<IndexSnapshotDto | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(true);
  const [slow, setSlow] = useState(false);
  const mainRef = useRef<HTMLElement | null>(null);
  const tableRef = useRef<HTMLDivElement | null>(null);
  const rowTops = useRef(new Map<string, number>());
  const restored = useRef(false);

  /** 切换区间只在前端重算/重排，不发新 IPC。 */
  const rows = useMemo(
    () => (snapshot ? [...snapshot.rows].sort((a, b) => compareByRange(a, b, range)) : []),
    [snapshot, range],
  );
  const rangeKpi = useMemo(
    () => (snapshot ? buildRangeKpi(snapshot.rows, range) : null),
    [snapshot, range],
  );

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await ipc.indexSnapshot());
    } catch (err) {
      setError(describeError(err));
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setTimeout(() => setSlow(true), 120);
    return () => window.clearTimeout(timer);
  }, []);

  // 返回指数页时恢复原滚动位置（等快照渲染完成后再设）。
  useEffect(() => {
    if (restored.current || !snapshot) return;
    restored.current = true;
    if (mainRef.current) mainRef.current.scrollTop = viewState.scrollTop;
  }, [snapshot]);

  /** 行序变化用 transform 位移（≤120ms），不逐个重挂载、不引入动画库。 */
  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    const next = new Map<string, number>();
    table.querySelectorAll<HTMLElement>("[data-indices-row]").forEach((node) => {
      const code = node.dataset.indexCode;
      if (!code) return;
      const top = node.offsetTop;
      next.set(code, top);
      const prev = rowTops.current.get(code);
      if (prev == null || prev === top) return;
      node.style.transition = "none";
      node.style.transform = `translateY(${prev - top}px)`;
      // 先落一次布局，保证随后的 transition 从位移态开始而不是直接跳变。
      void node.offsetHeight;
      node.style.transition = "transform 120ms ease";
      node.style.transform = "";
    });
    rowTops.current = next;
  }, [rows]);

  const selectRange = (next: IndexRange) => {
    viewState.range = next;
    setRange(next);
  };

  const shiftRange = (step: number) => {
    const index = RANGES.findIndex((item) => item.key === range);
    const next = (index + step + RANGES.length) % RANGES.length;
    selectRange(RANGES[next].key);
  };

  const onRangeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      shiftRange(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      shiftRange(-1);
    }
  };

  const onScroll = (event: UIEvent<HTMLElement>) => {
    viewState.scrollTop = event.currentTarget.scrollTop;
  };

  const openRow = (code: string) => {
    viewState.scrollTop = mainRef.current?.scrollTop ?? viewState.scrollTop;
    onOpenSecurity(code, "indices");
  };

  const onRowKeyDown = (event: KeyboardEvent<HTMLDivElement>, code: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openRow(code);
    }
  };

  const errorTarget = error?.code === "E_DATASET_MISSING" ? "install" : "settings";
  const dataDate = snapshot ? snapshot.coverageEnd || snapshot.dataDate : "";

  return (
    <AppShell active="indices" onNavigate={onNavigate}>
      <main className="indices" data-indices-root="p6" ref={mainRef} onScroll={onScroll}>
        <header className="indices-head">
          <div>
            <h1>指数与板块</h1>
            <p className="indices-sub" data-indices-scope>
              {snapshot
                ? `样本口径 · ${snapshot.indexCount} 个指数`
                : error
                  ? "样本口径 · 加载失败"
                  : "样本口径 · 加载中"}
              {snapshot && dataDate ? (
                <span data-indices-date> · 数据日期 {dataDate} 收盘</span>
              ) : null}
            </p>
          </div>
          <div className="indices-head-right">
            <SimBadge />
            <div
              className="seg"
              role="group"
              aria-label="区间"
              data-indices-range-group
              onKeyDown={onRangeKeyDown}
            >
              {RANGES.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  data-indices-range={item.key}
                  aria-pressed={range === item.key}
                  onClick={() => selectRange(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </header>

        {error ? (
          <section className="indices-table-wrap" aria-label="指数概览错误">
            <StateCard
              tone="error"
              title="指数数据加载失败"
              error={error}
              actionLabel={error.code === "E_DATASET_MISSING" ? "去安装数据" : "去设置"}
              onAction={() => onNavigate(errorTarget)}
              anchor="indices-error"
            />
          </section>
        ) : (
          <>
            <section className="indices-kpis" aria-label="指数概览">
              {KPIS.map((kpi) => (
                <article className="indices-kpi" key={kpi.key} data-indices-kpi={kpi.key}>
                  <span className="indices-kpi__label">{kpi.label}</span>
                  <strong
                    className={`indices-kpi__value mono ${kpiTone(kpi.key, rangeKpi)}`}
                    data-indices-kpi-value
                  >
                    {snapshot && rangeKpi ? kpiValue(kpi.key, snapshot, rangeKpi) : "—"}
                  </strong>
                  <span className="indices-kpi__hint">{kpi.hint}</span>
                </article>
              ))}
            </section>

            <section className="indices-table-wrap" aria-label="指数表">
              {loading && slow && !snapshot ? (
                <div className="market-skeleton" data-indices-skeleton>
                  {Array.from({ length: 8 }, (_, index) => (
                    <div className="skeleton-row" key={index} />
                  ))}
                </div>
              ) : (
                <>
                  {snapshot && (snapshot.sampleMissing || snapshot.missingCount > 0) ? (
                    <div className="indices-section-head" data-indices-sample-missing>
                      {snapshot.sampleMissing ? (
                        <span className="indices-note">
                          样本缺失（{snapshot.indexCount}/{snapshot.expectedCount}）
                        </span>
                      ) : null}
                      {snapshot.missingCount > 0 ? (
                        <span className="indices-note" data-indices-missing>
                          {snapshot.missingCount} 个指数缺失
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="indices-table" role="table" data-indices-table ref={tableRef}>
                    <div className="indices-row indices-row--head" role="row">
                      {TABLE_COLUMNS.map((column) => (
                        <span
                          key={column.key}
                          role="columnheader"
                          className={`indices-cell ${column.numeric ? "num" : ""}`}
                        >
                          {column.label}
                        </span>
                      ))}
                    </div>
                    {snapshot
                      ? rows.map((row) => (
                          <div
                            className="indices-row indices-row--clickable"
                            role="row"
                            tabIndex={0}
                            key={row.code}
                            data-indices-row
                            data-index-code={row.code}
                            onClick={() => openRow(row.code)}
                            onKeyDown={(event) => onRowKeyDown(event, row.code)}
                          >
                            {TABLE_COLUMNS.map((column) => {
                              const value =
                                column.key === "rangePct" ? rangeValue(row, range) : null;
                              const missing = column.key === "rangePct" && value == null;
                              return (
                                <span
                                  key={column.key}
                                  role="cell"
                                  data-cell={column.key}
                                  data-indices-range-pct={
                                    column.key === "rangePct" ? range : undefined
                                  }
                                  title={missing ? insufficientHint(row, range) : undefined}
                                  className={`indices-cell ${column.numeric ? "num mono" : ""} ${
                                    column.key === "changeAbs" ||
                                    column.key === "changePct" ||
                                    column.key === "rangePct"
                                      ? signClass(
                                          column.key === "changeAbs"
                                            ? row.changeAbs
                                            : column.key === "changePct"
                                              ? row.changePct
                                              : value,
                                        )
                                      : ""
                                  }`}
                                >
                                  {cellText(row, column.key, range)}
                                </span>
                              );
                            })}
                          </div>
                        ))
                      : null}
                    {!loading && snapshot?.rows.length === 0 ? (
                      <StateCard
                        tone="empty"
                        title="指数快照为空"
                        description="数据集内没有可展示的指数。"
                        anchor="indices-empty"
                      />
                    ) : null}
                  </div>
                </>
              )}
            </section>

            <section className="indices-breadth" aria-label="涨跌分布">
              <header className="indices-section-head">
                <h2>涨跌分布</h2>
                <span className="indices-note" data-breadth-scope>
                  样本口径 · 待接入（不含指数）
                </span>
              </header>
              <div
                className="breadth-bar"
                data-breadth-bar
                role="img"
                aria-label="涨跌分布待接入"
              >
                <span className="breadth-bar__empty">待接入</span>
              </div>
              <ul className="breadth-legend" data-breadth-legend>
                {BREADTH_BUCKETS.map((bucket) => (
                  <li key={bucket.key} data-breadth-bucket={bucket.key}>
                    <i className={`breadth-dot breadth-dot--${bucket.key}`} aria-hidden />
                    <span>{bucket.label}</span>
                    <b className="mono">—</b>
                  </li>
                ))}
              </ul>
              <div className="limit-cards">
                {LIMIT_CARDS.map((card) => (
                  <article className="limit-card" key={card.key} data-limit-card={card.key}>
                    <span className="limit-card__label">{card.label}</span>
                    <b className="limit-card__value mono">—</b>
                    <span
                      className="limit-card__approx"
                      data-limit-approx
                      title="按板块规则推导，四舍五入到 0.01"
                    >
                      ≈
                    </span>
                  </article>
                ))}
              </div>
            </section>

            <section className="indices-sectors" aria-label="行业板块" data-sector-section>
              <header className="indices-section-head">
                <h2>行业板块</h2>
                <span className="indices-note">V1 · 本期不排期</span>
              </header>
              <p className="indices-sector-empty" data-sector-empty>
                行业映射缺失：MVP 只展示指数，板块数值待真实成分数据源补入后再启用。
              </p>
            </section>
          </>
        )}

        <footer className="market-foot" data-indices-foot>
          <span>
            {snapshot
              ? `数据集 ${snapshot.datasetId.slice(0, 8)} · 生成 ${formatDateTime(snapshot.generatedAt)}`
              : "数据集 — · 生成 —"}
          </span>
          <span data-indices-count>当前 {snapshot?.indexCount ?? 0} 个指数</span>
        </footer>
      </main>
    </AppShell>
  );
}
