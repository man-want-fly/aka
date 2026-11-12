import type { ManifestIndicatorDto } from "../../lib/types";

/** 四段式口径的唯一渲染实现：目录页与后续入口共用，页面不得再写第二套。 */
export function sourceLabel(item: ManifestIndicatorDto) {
  if (item.status === "planned") {
    if (item.specStatus === "manualComplete") return "《技术指标全能手册》· 完整覆盖";
    if (item.specStatus === "partial") return "《技术指标全能手册》· 部分覆盖，口径由 BA 定";
    return "手册未覆盖 · 本产品定义，待 BA 拍板";
  }
  if (item.isCompletion) return "本产品补全口径 · PRD 附录 A";
  if (item.completeness === "beta") return "PRD beta 口径 · 待裁定";
  return `PRD 附录 A · 引擎 v${item.version}`;
}

/** 默认参数只有两个来源：已实现项从 manifest `params.default` 派生，规划项用 PRD 文本兜底。 */
export function defaultParamsText(item: ManifestIndicatorDto) {
  if (item.params.length > 0) {
    return item.params.map((param) => String(param.default)).join(" / ");
  }
  return item.defaultParamsText || "—";
}

export function dataRequirement(item: ManifestIndicatorDto) {
  if (!item.warmupBars) return "—";
  return `至少 ${item.warmupBars} 根 K 线（首个有效值下标 ${item.warmupBars - 1}，0 基）`;
}

interface Props {
  item: ManifestIndicatorDto;
  /** 与后端 calc_key 同源的引擎版本；由 manifest 响应下发，前端不拼接 */
  engineVersion: string;
}

export function IndicatorSpecSections({ item, engineVersion }: Props) {
  return (
    <>
      <section data-catalog-section="formula" style={{ marginBottom: 18 }}>
        <h3 style={{ fontSize: 14, marginBottom: 6 }}>一、公式</h3>
        <p style={{ margin: 0 }}>{item.formulaSummary}</p>
        <div className="caption" style={{ marginTop: 4 }}>
          公式引用：{item.formulaRef || "—"}
        </div>
      </section>

      <section data-catalog-section="params" style={{ marginBottom: 18 }}>
        <h3 style={{ fontSize: 14, marginBottom: 6 }}>二、参数</h3>
        {item.params.length === 0 ? (
          <div className="caption">
            {item.status === "planned"
              ? `默认参数 ${defaultParamsText(item)}；参数定义待《技术指标全能手册》核定。`
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
              {item.params.map((param) => (
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
        <p style={{ margin: 0 }}>{dataRequirement(item)}</p>
        {item.outputs.length > 0 && (
          <div className="caption" style={{ marginTop: 4 }}>
            输出：{item.outputs.map((output) => `${output.labelZh}(${output.key})`).join("、")}
          </div>
        )}
      </section>

      <section data-catalog-section="boundary">
        <h3 style={{ fontSize: 14, marginBottom: 6 }}>四、边界</h3>
        <p style={{ margin: 0 }}>{item.notes}</p>
        <div className="caption" style={{ marginTop: 4 }}>
          口径来源：{sourceLabel(item)}
        </div>
        <div className="caption" style={{ marginTop: 4 }} data-catalog-engine-version={engineVersion}>
          引擎版本：{engineVersion}（与计算缓存键同源）
        </div>
      </section>
    </>
  );
}
