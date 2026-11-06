import type { ReactNode } from "react";

interface Props {
  children: ReactNode;
}

const NAV = [
  {
    key: "workbench",
    label: "工作台",
    enabled: true,
    icon: "M2 12h7l2-8 3 16 2-8h6",
  },
  {
    key: "market",
    label: "行情",
    enabled: false,
    icon: "M2 17V5m0 12h16M6 14l4-5 3 3 4-6",
  },
  {
    key: "catalog",
    label: "指标库",
    enabled: false,
    icon: "M4 4h12v12H4zM4 9h12M9 4v12",
  },
  {
    key: "settings",
    label: "设置",
    enabled: false,
    icon: "M10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM10 2v2m0 12v2M2 10h2m12 0h2",
  },
];

export function AppShell({ children }: Props) {
  return (
    <div className="app">
      <nav className="rail" aria-label="主导航">
        <div className="brand-mark">AK</div>
        {NAV.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`rail-btn ${item.enabled ? "active" : ""}`}
            disabled={!item.enabled}
            title={item.enabled ? item.label : `${item.label}（骨架期未实现）`}
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
