import type { MouseEvent } from "react";

interface Props {
  code: string;
  name: string;
  watched: boolean;
  busy?: boolean;
  /** 行情行内点击不改变行选中、不触发行跳转 */
  onToggle: () => void;
}

/** S-01.02-01：星标只有一个组件，行情末列 / 报价头右上 / 自选行同位置复用。 */
export function StarButton({ code, name, watched, busy = false, onToggle }: Props) {
  const label = `${watched ? "移出" : "加入"}自选：${code}${name ? ` ${name}` : ""}`;
  return (
    <button
      type="button"
      className={`star ${watched ? "watched" : ""} ${busy ? "star--busy" : ""}`}
      aria-label={label}
      aria-pressed={watched}
      title={label}
      data-star={code}
      data-watched={watched ? "1" : "0"}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        if (!busy) onToggle();
      }}
    />
  );
}
