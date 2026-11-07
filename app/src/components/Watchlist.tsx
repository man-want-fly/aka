import { useEffect, useMemo, useRef, useState } from "react";
import { diagExportFileName, readDiagExportMode } from "../lib/diagExport";
import { describeError, ipc } from "../lib/ipc";
import { StarButton } from "./StarButton";
import type { SecurityDto, WatchItemDto, WatchlistDto } from "../lib/types";

interface Props {
  securities: SecurityDto[];
  activeCode: string;
  onSelect: (code: string) => void;
  onGoMarket: () => void;
  /** 数据集已加载完成（用于区分「加载中」与真实的 0 只） */
  datasetReady: boolean;
  /** S-01.02-03 补2：空态页动作「重新生成模拟数据」 */
  onRegenerate: () => void | Promise<void>;
}

type WriteAction = () => Promise<unknown>;

const ALL = "全部";
const UNGROUPED = "未分组";
const LIMIT_MESSAGE = "自选上限 500 只，请先移出后再添加";
/** 卡面 S-01.02-03 补4 逐字文案 */
const REMOVE_FAILED = "移出失败，请重试";

/**
 * S-01.02-01/02/03：自选（星标、分组、上限、六层空态、写失败错误条）。
 * 口径：单一归属，groupName=null 为未分组；「全部」「未分组」为只读派生视图。
 */
export function Watchlist({
  securities,
  activeCode,
  onSelect,
  onGoMarket,
  datasetReady,
  onRegenerate,
}: Props) {
  const [watchlist, setWatchlist] = useState<WatchlistDto | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  /** state.db 坏库：展示不可恢复页（trace id + 「重新生成数据」/「导出诊断」） */
  const [traceId, setTraceId] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string>("");
  /** 导出诊断后的可见反馈：成功/半成功/失败都要有文案，否则用户无从判断拿没拿到。 */
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState<string>(ALL);
  const [query, setQuery] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [renaming, setRenaming] = useState<{ name: string; value: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [barCounts, setBarCounts] = useState<Record<string, number | null>>({});
  const [failedSecurity, setFailedSecurity] = useState<string | null>(null);
  const lastAction = useRef<WriteAction | null>(null);
  /** 与 lastAction 配对：重试时沿用同一条失败文案 */
  const lastFailureText = useRef<string | null>(null);
  const loadToken = useRef(0);
  const barCountsRef = useRef<Record<string, number | null>>({});

  const reload = async () => {
    try {
      const data = await ipc.watchlist();
      setWatchlist(data);
      setReadError(null);
      setTraceId(null);
      setErrorCode("");
      if (data.groups.some((group) => group.name === activeGroup)) return;
      setActiveGroup(ALL);
    } catch (err) {
      const failure = describeError(err);
      const details = failure.details as { traceId?: unknown } | undefined;
      setReadError(failure.message);
      setErrorCode(failure.code);
      setTraceId(typeof details?.traceId === "string" ? details.traceId : null);
    }
  };

  useEffect(() => {
    void reload();
    const refresh = () => void reload();
    window.addEventListener("aka:watchlist-refresh", refresh);
    return () => window.removeEventListener("aka:watchlist-refresh", refresh);
  }, []);

  const items = watchlist?.items ?? [];
  const groups = watchlist?.groups ?? [];

  // 可见标的的 K 线根数：用于「数据不足（<20）」判定，缺失按 null 处理
  useEffect(() => {
    const codes = (watchlist?.items ?? [])
      .map((item) => item.security)
      .filter((code) => !(code in barCountsRef.current));
    if (codes.length === 0) return;
    const token = ++loadToken.current;
    void Promise.all(
      codes.map(async (code) => {
        try {
          const response = await ipc.getBars({ security: code, timeframe: "D", adj: "qfq" });
          return [code, response.bars.length] as const;
        } catch {
          return [code, null] as const;
        }
      }),
    ).then((rows) => {
      if (token !== loadToken.current) return;
      const next = { ...barCountsRef.current };
      for (const [code, count] of rows) next[code] = count;
      barCountsRef.current = next;
      setBarCounts(next);
    });
  }, [watchlist]);

  const securityByCode = useMemo(
    () => new Map(securities.map((security) => [security.code, security])),
    [securities],
  );

  const runWrite = async (action: WriteAction, failureText: string | null = null) => {
    lastAction.current = action;
    lastFailureText.current = failureText;
    try {
      await action();
      setWriteError(null);
      setFailedSecurity(null);
      await reload();
      return true;
    } catch (err) {
      const message = describeError(err).message || LIMIT_MESSAGE;
      setWriteError(failureText ?? `自选未保存：${message}`);
      return false;
    }
  };

  const removeItem = (item: WatchItemDto) => {
    void runWrite(async () => {
      await ipc.toggleWatch(item.security);
    }, REMOVE_FAILED).then((ok) => {
      if (!ok) setFailedSecurity(item.security);
    });
  };

  const createGroup = () => {
    const name = newGroup.trim();
    if (!name) return;
    void runWrite(async () => {
      await ipc.createWatchGroup(name);
      setNewGroup("");
      setActiveGroup(name);
    });
  };

  const renameGroup = () => {
    if (!renaming) return;
    const next = renaming.value.trim();
    if (!next || next.length > 20) return;
    void runWrite(async () => {
      await ipc.renameWatchGroup(renaming.name, next);
      setRenaming(null);
      setActiveGroup(next);
    });
  };

  const renameTrimmed = renaming?.value.trim() ?? "";
  const renameError = renaming
    ? renameTrimmed === ""
      ? "分组名不能为空"
      : groups.some(
            (group) =>
              group.name !== renaming.name && group.name.trim().toLowerCase() === renameTrimmed.toLowerCase(),
          )
        ? "已有同名分组"
        : ""
    : "";

  const deleteGroup = (name: string) => {
    void runWrite(async () => {
      await ipc.deleteWatchGroup(name);
      setConfirmDelete(null);
      setActiveGroup(ALL);
    });
  };

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return items.filter((item) => {
      if (activeGroup === UNGROUPED) {
        if (item.groupName !== null) return false;
      } else if (activeGroup !== ALL && item.groupName !== activeGroup) {
        return false;
      }
      if (!keyword) return true;
      const security = securityByCode.get(item.security);
      return (
        item.security.toLowerCase().includes(keyword) ||
        (security?.name ?? "").toLowerCase().includes(keyword)
      );
    });
  }, [items, activeGroup, query, securityByCode]);

  const total = watchlist?.total ?? 0;
  const customGroupCount = groups.filter((group) => !group.isBuiltin).length;
  const activeGroupCount = groups.find((group) => group.name === activeGroup)?.count ?? 0;
  const groupLimitReached = customGroupCount >= 20;
  const trimmedName = newGroup.trim();
  const duplicateName =
    trimmedName !== "" &&
    groups.some((group) => group.name.trim().toLowerCase() === trimmedName.toLowerCase());
  const nameError =
    newGroup !== "" && trimmedName === ""
      ? "分组名不能为空"
      : duplicateName
        ? "已有同名分组"
        : "";
  const nameBlocked = trimmedName === "" || duplicateName;

  // 「全部」空态只在只读总数视图出现；具体分组为空时优先给组空态（即使总数为 0）。
  const emptyForAll = total === 0 && activeGroup === ALL && query.trim() === "";
  const emptyForGroup = query.trim() === "" && activeGroup !== ALL && activeGroupCount === 0;
  const emptyForSearch = query.trim() !== "" && visible.length === 0;
  const datasetEmpty = datasetReady && securities.length === 0;

  const rebuild = async () => {
    setRebuilding(true);
    try {
      await ipc.storageRebuild();
      await reload();
    } catch (err) {
      setReadError(describeError(err).message);
    } finally {
      setRebuilding(false);
    }
  };

  /** S-08.02-04 补1：损坏卡除「重建」外还要能导出诊断（无文件系统插件时以剪贴板 + 下载双通道）。 */
  const exportDiagnostics = async () => {
    const mode = readDiagExportMode();
    // dev 注入运行时文件名带支名，便于取证把落盘文件绑定到 C1/C2；release 不带。
    const fileName = diagExportFileName(traceId ?? "unknown", mode);
    const payload = JSON.stringify(
      {
        at: new Date().toISOString(),
        scope: "watchlist/state.db",
        code: errorCode || "E_UNKNOWN",
        traceId,
        message: readError,
      },
      null,
      2,
    );
    let copied = false;
    // dev 注入点（渲染层，非真实通道）：ok / no-download 直接置 true，短路 navigator.clipboard；
    // no-copy / both-fail 直接置 false，同样不调用剪贴板。release 时 mode=null，走下面的真实调用。
    if (mode === "ok" || mode === "no-download") {
      copied = true;
    } else if (mode === "no-copy" || mode === "both-fail") {
      copied = false;
    } else if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(payload);
        copied = true;
      } catch {
        copied = false;
      }
    }
    let downloaded = false;
    // dev 注入点：no-download / both-fail 直接置 false，短路 anchor.click；
    // ok / no-copy 走真实下载（anchor.click 真实调用，文件真实落盘）。
    if (mode === "no-download" || mode === "both-fail") {
      downloaded = false;
    } else {
      try {
        const blob = new Blob([payload], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = fileName;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
        downloaded = true;
      } catch {
        downloaded = false;
      }
    }
    setExportStatus(
      copied && downloaded
        ? `已复制到剪贴板，并下载 ${fileName}`
        : copied
          ? `已复制到剪贴板（下载被拦截）：${fileName}`
          : downloaded
            ? `已下载 ${fileName}（剪贴板不可用）`
            : "导出失败：剪贴板与下载均不可用，请手动复制错误码与追踪号",
    );
  };

  if (traceId) {
    return (
      <aside className="watchlist" data-wl-root>
        <div className="wl-error-page" data-wl-unrecoverable>
          <b>自选数据不可恢复</b>
          <span className="wl-error-page__message" data-wl-error-message>
            {readError}
          </span>
          <span className="wl-error-page__code mono" data-wl-error-code>
            {errorCode || "E_UNKNOWN"}
          </span>
          <span className="wl-error-page__trace" data-wl-trace-id>
            {traceId}
          </span>
          <div className="wl-error-page__actions">
            <button type="button" data-wl-rebuild disabled={rebuilding} onClick={() => void rebuild()}>
              重新生成数据
            </button>
            <button type="button" data-wl-export onClick={() => void exportDiagnostics()}>
              导出诊断
            </button>
          </div>
          {exportStatus && (
            <span className="wl-error-page__hint" data-wl-export-status role="status">
              {exportStatus}
            </span>
          )}
        </div>
      </aside>
    );
  }

  return (
    <aside className="watchlist" data-wl-root>
      <div className="wl-head">
        <b>自选</b>
        <span className="wl-count" data-wl-total={total}>
          {total}/{watchlist?.limit ?? 500}
        </span>
      </div>

      {readError && (
        <div className="wl-error" data-wl-read-error>
          自选读取失败：{readError}
          <button type="button" onClick={() => void reload()}>
            重试
          </button>
        </div>
      )}

      {writeError && (
        <div className="wl-error wl-error--write" data-wl-write-error>
          <span>{writeError}</span>
          <button
            type="button"
            data-wl-retry
            onClick={() => {
              const action = lastAction.current;
              if (action) void runWrite(action, lastFailureText.current);
            }}
          >
            重试
          </button>
        </div>
      )}

      {datasetEmpty && (
        <div className="wl-dataset-empty" data-wl-dataset-empty>
          <span>当前数据集为空</span>
          <button type="button" data-wl-regenerate onClick={() => void onRegenerate()}>
            重新生成模拟数据
          </button>
        </div>
      )}

      <input
        className="wl-search"
        placeholder="搜索自选 / 代码"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        data-wl-search
      />

      <div className="wl-tabs" role="group" aria-label="自选分组">
        {groups.map((group) => (
          <button
            key={group.name}
            type="button"
            data-wl-group={group.name}
            aria-pressed={activeGroup === group.name}
            onClick={() => {
              setActiveGroup(group.name);
              setQuery("");
            }}
          >
            {group.name} {group.count}
          </button>
        ))}
        {groups.length === 0 && <span className="wl-empty-inline">自选还是空的</span>}
      </div>

      {activeGroup !== ALL && activeGroup !== UNGROUPED && (
        <div className="wl-group-ops">
          {renaming?.name === activeGroup ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                renameGroup();
              }}
            >
              <input
                value={renaming.value}
                maxLength={20}
                onChange={(event) => setRenaming({ name: renaming.name, value: event.target.value })}
                aria-label="重命名分组"
                aria-invalid={renameError !== ""}
                autoFocus
              />
              <button type="submit" disabled={renameError !== ""}>
                保存
              </button>
              <button type="button" onClick={() => setRenaming(null)}>
                取消
              </button>
              {renameError && (
                <span className="wl-hint wl-hint--error" data-wl-rename-error>
                  {renameError}
                </span>
              )}
            </form>
          ) : (
            <button type="button" onClick={() => setRenaming({ name: activeGroup, value: activeGroup })}>
              重命名
            </button>
          )}
          <button type="button" onClick={() => setConfirmDelete(activeGroup)}>
            删除分组
          </button>
        </div>
      )}

      {activeGroup === ALL && (
        <div className="wl-group-ops" data-wl-builtin-ops>
          <button type="button" disabled title="内置分组不可删除">
            重命名
          </button>
          <button type="button" disabled title="内置分组不可删除">
            删除分组
          </button>
          <span className="wl-hint">内置分组不可删除</span>
        </div>
      )}

      {confirmDelete && (
        <div className="wl-confirm" data-wl-confirm>
          <span>
            删除分组「{confirmDelete}」？该组{" "}
            {groups.find((group) => group.name === confirmDelete)?.count ?? 0} 只标的将回到「未分组」，不会从自选删除
          </span>
          <button type="button" onClick={() => deleteGroup(confirmDelete)}>
            确认删除
          </button>
          <button type="button" onClick={() => setConfirmDelete(null)}>
            取消
          </button>
        </div>
      )}

      {groups.length > 0 && (
        <form
          className="wl-new-group"
          onSubmit={(event) => {
            event.preventDefault();
            if (groupLimitReached || nameBlocked) return;
            createGroup();
          }}
        >
          <input
            value={newGroup}
            maxLength={20}
            placeholder="新建分组（最多 20 个）"
            disabled={groupLimitReached}
            title={groupLimitReached ? "分组上限 20 个，请先删除不用的分组" : undefined}
            onChange={(event) => setNewGroup(event.target.value)}
            data-wl-new-group
          />
          <button type="submit" disabled={groupLimitReached || nameBlocked}>
            新建
          </button>
          {nameError && (
            <span className="wl-hint wl-hint--error" data-wl-name-error>
              {nameError}
            </span>
          )}
          {groupLimitReached && (
            <span className="wl-hint" data-wl-group-limit>
              分组上限 20 个，请先删除不用的分组
            </span>
          )}
        </form>
      )}

      <div className="wl-list">
        {visible.map((item) => {
          const security = securityByCode.get(item.security);
          const bars = barCounts[item.security];
          const missing = !security;
          // 「数据不足」= 在数据集内但拿不到可用行情：K 线 0~19 根，或读取失败（null）。
          // 与「不在数据集」同一数据源（securities 全量代码表 + 同一 provider 的 getBars），只是判据不同。
          const insufficient = !missing && (bars === null || (typeof bars === "number" && bars < 20));
          const unknown = !missing && bars === undefined;
          return (
            <div
              key={item.security}
              className={`wl-row ${item.security === activeCode ? "active" : ""} ${
                missing ? "wl-row--muted" : ""
              }`}
              data-wl-item={item.security}
              data-wl-state={missing ? "missing" : insufficient ? "insufficient" : "normal"}
            >
              <button type="button" className="wl-row-main" onClick={() => onSelect(item.security)}>
                <span className="wl-name">{security?.name ?? item.security}</span>
                <span className="wl-code">{item.security}</span>
                <span className="wl-board">{security?.board ?? "—"}</span>
                {missing && (
                  <span className="tag tag--warn" data-wl-badge="missing">
                    不在数据集
                  </span>
                )}
                {insufficient && (
                  <span
                    className="tag tag--info"
                    data-wl-badge="insufficient"
                    title={bars === null ? "行情读取失败，按数据不足处理" : `可用 K 线 ${bars} 根，不足 20 根`}
                  >
                    数据不足
                  </span>
                )}
                {insufficient && <span className="wl-quote">—</span>}
                {unknown && <span className="wl-quote">—</span>}
                {failedSecurity === item.security && (
                  <span className="tag tag--warn" data-wl-badge="unsaved">
                    未保存
                  </span>
                )}
              </button>
              {!insufficient &&
                (missing ? (
                  <button
                    type="button"
                    className="wl-remove"
                    data-wl-remove={item.security}
                    title="移出自选"
                    onClick={() => removeItem(item)}
                  >
                    ×
                  </button>
                ) : (
                  <StarButton
                    code={item.security}
                    name={security?.name ?? ""}
                    watched
                    onToggle={() => removeItem(item)}
                  />
                ))}
            </div>
          );
        })}

        {emptyForAll && (
          <div className="wl-empty" data-wl-empty="all">
            <b>自选还是空的</b>
            <span>在行情页点星标，把标的加进来</span>
            <button type="button" onClick={onGoMarket}>
              去行情页
            </button>
            <button type="button" disabled title="本期未开放" data-wl-csv-import>
              导入 CSV（本期未开放）
            </button>
          </div>
        )}

        {emptyForGroup && (
          <div className="wl-empty" data-wl-empty="group">
            <b>这个分组还没有标的</b>
            <span>从行情页加星，或切回「全部」查看已有自选</span>
            <button type="button" onClick={onGoMarket}>
              去行情页加星
            </button>
            <button type="button" onClick={() => setActiveGroup(ALL)}>
              切回全部
            </button>
          </div>
        )}

        {emptyForSearch && (
          <div className="wl-empty" data-wl-empty="search">
            <b>没有匹配「{query.trim()}」的自选</b>
            <button type="button" onClick={() => setQuery("")}>
              清除搜索
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
