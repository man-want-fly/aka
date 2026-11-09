import { useState } from "react";
import type { KeyboardEvent } from "react";
import { AppShell, type RouteKey } from "../../app/AppShell";
import { SimBadge } from "../../components/SimBadge";
import { StateCard } from "../../components/StateCard";

/** S-04.01-02：区间口径（交易日），今日 / 5 日 / 20 日。 */
export type IndexRange = "today" | "d5" | "d20";

const RANGES: Array<{ key: IndexRange; label: string }> = [
  { key: "today", label: "今日" },
  { key: "d5", label: "5日" },
  { key: "d20", label: "20日" },
];

/** S-04.01-01：4 张 KPI。 */
const KPIS: Array<{ key: string; label: string; hint: string }> = [
  { key: "leader", label: "领涨指数", hint: "表内涨跌幅最大" },
  { key: "laggard", label: "领跌指数", hint: "表内涨跌幅最小" },
  { key: "advancers", label: "上涨指数数", hint: "x / 样本指数数" },
  { key: "amount", label: "样本成交额合计", hint: "当日" },
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

interface Props {
  onNavigate: (key: NavKey) => void;
}

/**
 * PAGE-P6（W-99）指数与板块页骨架。
 *
 * 只提供页面、路由与 DOM 契约锚点；指数快照、区间计算、六桶分布与板块
 * 数值分别由 S-04.01-01/02、S-04.02-01/02 承接，本页不签它们的 AC，
 * 也不内置 fixture 数据。
 */
export function IndexPage({ onNavigate }: Props) {
  const [range, setRange] = useState<IndexRange>("today");

  const shiftRange = (step: number) => {
    setRange((current) => {
      const index = RANGES.findIndex((item) => item.key === current);
      const next = (index + step + RANGES.length) % RANGES.length;
      return RANGES[next].key;
    });
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

  return (
    <AppShell active="indices" onNavigate={onNavigate}>
      <main className="indices" data-indices-root="p6">
        <header className="indices-head">
          <div>
            <h1>指数与板块</h1>
            <p className="indices-sub" data-indices-scope>
              样本口径 · 待接入
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
                  onClick={() => setRange(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </header>

        <section className="indices-kpis" aria-label="指数概览">
          {KPIS.map((kpi) => (
            <article className="indices-kpi" key={kpi.key} data-indices-kpi={kpi.key}>
              <span className="indices-kpi__label">{kpi.label}</span>
              <strong className="indices-kpi__value mono" data-indices-kpi-value>
                —
              </strong>
              <span className="indices-kpi__hint">{kpi.hint}</span>
            </article>
          ))}
        </section>

        <section className="indices-table-wrap" aria-label="指数表">
          <div className="indices-table" role="table" data-indices-table>
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
            <StateCard
              tone="empty"
              title="指数快照待接入"
              description="页面骨架已就位；指数点位、成交额与样本数接入后在此渲染。"
              anchor="indices-empty"
            />
          </div>
        </section>

        <section className="indices-breadth" aria-label="涨跌分布">
          <header className="indices-section-head">
            <h2>涨跌分布</h2>
            <span className="indices-note" data-breadth-scope>
              样本口径 · 待接入（不含指数）
            </span>
          </header>
          <div className="breadth-bar" data-breadth-bar role="img" aria-label="涨跌分布待接入">
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
      </main>
    </AppShell>
  );
}
