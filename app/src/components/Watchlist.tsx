import { useMemo, useState } from "react";
import type { SecurityDto } from "../lib/types";

interface Props {
  securities: SecurityDto[];
  activeCode: string;
  onSelect: (code: string) => void;
}

type Group = "all" | "SH" | "SZ" | "INDEX";

const GROUPS: Array<{ key: Group; label: string }> = [
  { key: "all", label: "全部" },
  { key: "SH", label: "沪市" },
  { key: "SZ", label: "深市" },
  { key: "INDEX", label: "指数" },
];

export function Watchlist({ securities, activeCode, onSelect }: Props) {
  const [group, setGroup] = useState<Group>("all");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return securities.filter((security) => {
      if (group === "INDEX" && !security.isIndex) return false;
      if (group !== "INDEX" && group !== "all" && security.market !== group) return false;
      if (group !== "all" && group !== "INDEX" && security.isIndex) return false;
      if (!keyword) return true;
      return (
        security.name.toLowerCase().includes(keyword) ||
        security.code.toLowerCase().includes(keyword)
      );
    });
  }, [securities, group, query]);

  return (
    <aside className="watchlist">
      <div className="wl-head">
        <b>自选与样本</b>
        <span className="wl-count">{securities.length} 样本</span>
      </div>
      <input
        className="wl-search"
        placeholder="搜索名称 / 代码"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="wl-tabs">
        {GROUPS.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-pressed={group === item.key}
            onClick={() => setGroup(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="wl-list">
        {filtered.map((security) => (
          <button
            key={security.code}
            type="button"
            className={`wl-item ${security.code === activeCode ? "active" : ""}`}
            onClick={() => onSelect(security.code)}
          >
            <span className="wl-name">{security.name}</span>
            <span className="wl-code">{security.code}</span>
            <span className="wl-board">{security.board}</span>
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="wl-empty">
            {securities.length === 0 ? "等待后端返回样本列表" : "没有匹配的标的"}
          </div>
        )}
      </div>
    </aside>
  );
}
