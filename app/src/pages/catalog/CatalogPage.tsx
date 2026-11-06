import { useEffect, useMemo, useState } from "react";
import { AppShell } from "../../app/AppShell";
import { B1_FORMULAS, B2_FORMULAS, B3_FORMULAS } from "../../features/catalog/content";
import { describeError, ipc, isTauriRuntime } from "../../lib/ipc";
import type { AppError, ManifestResponse, RegistryResponse } from "../../lib/types";

interface Props {
  onNavigate: (key: "workbench" | "market" | "catalog") => void;
}

const FORMULAS = { ...B1_FORMULAS, ...B2_FORMULAS, ...B3_FORMULAS };

/** P4 指标口径页：B1 11 个 + B2 20 个 + B3 13 个（M06 计入 B1），四段结构可查可用。 */
export function CatalogPage({ onNavigate }: Props) {
  const [registry, setRegistry] = useState<RegistryResponse | null>(null);
  const [manifest, setManifest] = useState<ManifestResponse | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [activeId, setActiveId] = useState("T01");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!isTauriRuntime()) {
      setError({ code: "NO_TAURI", message: "指标口径页需要桌面应用运行时", retryable: false });
      return;
    }
    Promise.all([ipc.indicatorRegistry(), ipc.indicatorManifest()])
      .then(([reg, man]) => {
        setRegistry(reg);
        setManifest(man);
      })
      .catch((err) => setError(describeError(err)));
  }, []);

  const implemented = useMemo(() => {
    const implementedIds = Object.keys(FORMULAS);
    const list =
      registry?.indicators.filter(
        (item) => item.implemented && implementedIds.includes(item.id),
      ) ?? [];
    const keyword = query.trim().toUpperCase();
    if (!keyword) return list;
    return list.filter(
      (item) =>
        item.id.toUpperCase().includes(keyword) ||
        item.nameZh.includes(query.trim()) ||
        item.nameEn.toUpperCase().includes(keyword),
    );
  }, [registry, query]);

  const active = implemented.find((item) => item.id === activeId) ?? implemented[0];
  const manifestItem = manifest?.indicators.find((item) => item.id === active?.id);
  const formula = active ? FORMULAS[active.id] : undefined;

  return (
    <AppShell active="catalog" onNavigate={onNavigate}>
      <div className="workbench" style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 0 }}>
        <aside
          data-catalog-root="p4"
          style={{ borderRight: "1px solid var(--line)", padding: "16px 12px", overflow: "auto" }}
        >
          <h1 style={{ fontSize: 18, margin: "0 0 4px" }}>指标口径</h1>
          <div className="caption" style={{ marginBottom: 12 }}>
            B1 11 个 + B2 20 个 + B3 13 个 · 当前匹配 {implemented.length} / 共 {Object.keys(FORMULAS).length} 条
          </div>
          <input
            type="search"
            aria-label="搜索指标"
            placeholder="搜代码或名称，如 T21 / BIAS"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            style={{ width: "100%", marginBottom: 12 }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {implemented.map((item) => (
              <button
                key={item.id}
                type="button"
                data-catalog-item={item.id}
                data-catalog-beta={item.specStatus === "partial" ? "1" : "0"}
                aria-pressed={active?.id === item.id}
                onClick={() => setActiveId(item.id)}
                style={{
                  textAlign: "left",
                  padding: "8px 10px",
                  border: "1px solid transparent",
                  borderRadius: 6,
                  background: active?.id === item.id ? "var(--accent-weak, rgba(79,163,199,.18))" : "transparent",
                  color: "inherit",
                }}
              >
                <span className="mono">{item.id}</span> · {item.nameZh}
                {item.specStatus === "partial" && (
                  <span className="mono" style={{ color: "var(--warn)", marginLeft: 6 }}>
                    beta
                  </span>
                )}
              </button>
            ))}
            {implemented.length === 0 && <div className="caption">没有匹配的指标</div>}
          </div>
        </aside>

        <main style={{ padding: "20px 24px", overflow: "auto" }}>
          {error && <div className="error-box">{error.message}</div>}
          {active && (
            <>
              <header style={{ marginBottom: 16 }}>
                <div className="caption mono">{active.id} · {active.category}</div>
                <h2 style={{ margin: "4px 0" }}>{active.nameZh}</h2>
                <div className="caption">
                  {active.nameEn} · 单位 {active.unit} · {active.engineVersion} ·{" "}
                  {active.specStatus === "manualComplete" ? "已人工校对" : "beta（口径待裁定）"}
                </div>
              </header>

              <section data-catalog-section="formula" style={{ marginBottom: 18 }}>
                <h3 style={{ fontSize: 14, marginBottom: 6 }}>一、公式</h3>
                <p style={{ margin: 0 }}>{formula?.formula ?? "公式引用待补。"}</p>
                <div className="caption" style={{ marginTop: 4 }}>
                  容差：{formula?.tolerance ?? manifestItem?.notes}
                </div>
              </section>

              <section data-catalog-section="params" style={{ marginBottom: 18 }}>
                <h3 style={{ fontSize: 14, marginBottom: 6 }}>二、参数</h3>
                {active.params.length === 0 ? (
                  <div className="caption">无参数。</div>
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
                <p style={{ margin: 0 }}>
                  首个有效值下标 <span className="mono">{active.warmup}</span>（0 基），即至少需要{" "}
                  <span className="mono">{active.warmup + 1}</span> 根 K 线。
                </p>
                <div className="caption" style={{ marginTop: 4 }}>
                  输出：{active.outputs.map((output) => `${output.labelZh}(${output.key})`).join("、")}
                </div>
              </section>

              <section data-catalog-section="boundary">
                <h3 style={{ fontSize: 14, marginBottom: 6 }}>四、边界</h3>
                <p style={{ margin: 0 }}>{manifestItem?.notes ?? active.notes}</p>
                <div className="caption" style={{ marginTop: 4 }}>
                  公式引用：{manifestItem?.formulaRef ?? "—"}
                </div>
              </section>
            </>
          )}
        </main>
      </div>
    </AppShell>
  );
}
