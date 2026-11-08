import type { ReactNode } from "react";

export type RouteKey =
  | "workbench"
  | "market"
  | "indices"
  | "catalog"
  | "settings"
  | "datasource"
  | "install";

interface Props {
  children: ReactNode;
  active: RouteKey;
  onNavigate: (key: RouteKey) => void;
}

const NAV: Array<{ key: string; label: string; enabled: boolean; route?: RouteKey; icon: string }> = [
  {
    key: "workbench",
    label: "工作台",
    enabled: true,
    route: "workbench",
    icon: "M2 12h7l2-8 3 16 2-8h6",
  },
  {
    key: "market",
    label: "行情",
    enabled: true,
    route: "market",
    icon: "M2 17V5m0 12h16M6 14l4-5 3 3 4-6",
  },
  {
    key: "indices",
    label: "指数",
    enabled: true,
    route: "indices",
    icon: "M2 15l4-4 3 3 5-6 4 2",
  },
  {
    key: "catalog",
    label: "指标库",
    enabled: true,
    route: "catalog",
    icon: "M4 4h12v12H4zM4 9h12M9 4v12",
  },
  {
    key: "datasource",
    label: "数据源",
    enabled: true,
    route: "datasource",
    icon: "M4 5c0-1.1 2.7-2 6-2s6 .9 6 2v10c0 1.1-2.7 2-6 2s-6-.9-6-2V5zM4 5c0 1.1 2.7 2 6 2s6-.9 6-2M4 10c0 1.1 2.7 2 6 2s6-.9 6-2",
  },
  {
    key: "install",
    label: "环境",
    enabled: true,
    route: "install",
    icon: "M4 4h12v12H4zM7 10l2 2 4-4M4 20h12",
  },
  {
    key: "settings",
    label: "设置",
    enabled: true,
    route: "settings",
    icon: "M10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM10 2v2m0 12v2M2 10h2m12 0h2",
  },
];

export function AppShell({ children, active, onNavigate }: Props) {
  return (
    <div className="app">
      <nav className="rail" aria-label="主导航">
        <div className="brand-mark">AK</div>
        <button
          type="button"
          className="rail-btn rail-search"
          title="搜索标的（⌘K）"
          data-search-trigger
          onClick={() => window.dispatchEvent(new CustomEvent("aka:search-open"))}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="9" cy="9" r="5" />
            <path d="M13 13l4 4" strokeLinecap="round" />
          </svg>
          搜索
        </button>
        {NAV.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`rail-btn ${item.enabled && item.route === active ? "active" : ""}`}
            disabled={!item.enabled}
            title={item.enabled ? item.label : `${item.label}（骨架期未实现）`}
            onClick={() => item.route && onNavigate(item.route)}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d={item.icon} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {item.label}
          </button>
        ))}
        <div className="rail-spacer" />
        <span className="rail-hint">MVP · OFFLINE</span>
      </nav>
      {children}
    </div>
  );
}
