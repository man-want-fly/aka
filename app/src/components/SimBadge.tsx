interface Props {
  compact?: boolean;
}

export function SimBadge({ compact = false }: Props) {
  return (
    <span className="pill sim" title="行情由 mock provider 生成，非真实市场数据">
      SIM · {compact ? "模拟" : "模拟数据"}
    </span>
  );
}
