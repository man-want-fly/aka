import { useEffect, useMemo, useRef, useState } from "react";
import { describeError, ipc } from "../lib/ipc";
import type { SecurityDto, WatchItemDto, WatchlistDto } from "../lib/types";

interface Props {
  securities: SecurityDto[];
  activeCode: string;
  onSelect: (code: string) => void;
  onGoMarket: () => void;
}

type WriteAction = () => Promise<unknown>;

const ALL = "全部";
const UNGROUPED = "未分组";
const LIMIT_MESSAGE = "自选上限 500 只，请先移出后再添加";

/**
 * S-01.02-01/02/03：自选（星标、分组、上限、六层空态、写失败错误条）。
 * 口径：单一归属，groupName=null 为未分组；「全部」「未分组」为只读派生视图。
 */
export function Watchlist({ securities, activeCode, onSelect, onGoMarket }: Props) {
  const [watchlist, setWatchlist] = useState<WatchlistDto | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState<string>(ALL);
  const [query, setQuery] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [renaming, setRenaming] = useState<{ name: string; value: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [barCounts, setBarCounts] = useState<Record<string, number | null>>({});
  const [failedSecurity, setFailedSecurity] = useState<string | null>(null);
  const lastAction = useRef<WriteAction | null>(null);
  const loadToken = useRef(0);
  const barCountsRef = useRef<Record<string, number | null>>({});

  const reload = async () => {
    try {
      const data = await ipc.watchlist();
      setWatchlist(data);
      setReadError(null);
      if (data.groups.some((group) => group.name === activeGroup)) return;
      setActiveGroup(ALL);
    } catch (err) {
      setReadError(describeError(err).message);
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

  const runWrite = async (action: WriteAction) => {
    lastAction.current = action;
    try {
      await action();
      setWriteError(null);
      setFailedSecurity(null);
      await reload();
      return true;
    } catch (err) {
      const message = describeError(err).message || LIMIT_MESSAGE;
      setWriteError(`未保存：${message}`);
      return false;
    }
  };

  const removeItem = (item: WatchItemDto) => {
    void runWrite(async () => {
      await ipc.toggleWatch(item.security);
    }).then((ok) => {
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
    if (!next) return;
    void runWrite(async () => {
      await ipc.renameWatchGroup(renaming.name, next);
      setRenaming(null);
      setActiveGroup(next);
    });
  };

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

  const emptyForAll = total === 0 && query.trim() === "";
  const emptyForGroup =
    !emptyForAll && query.trim() === "" && activeGroup !== ALL && activeGroupCount === 0;
  const emptyForSearch = query.trim() !== "" && visible.length === 0;

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
              if (action) void runWrite(action);
            }}
          >
            重试
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
                onChange={(event) => setRenaming({ name: renaming.name, value: event.target.value })}
                aria-label="重命名分组"
                autoFocus
              />
              <button type="submit">保存</button>
              <button type="button" onClick={() => setRenaming(null)}>
                取消
              </button>
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
          <span>删除分组「{confirmDelete}」？组内标的将回到「（未分组）」</span>
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
              {!insufficient && (
                <button
                  type="button"
                  className="wl-remove"
                  data-wl-remove={item.security}
                  title="移出自选"
                  onClick={() => removeItem(item)}
                >
                  ×
                </button>
              )}
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
          </div>
        )}

        {emptyForGroup && (
          <div className="wl-empty" data-wl-empty="group">
            <b>本组还没有标的</b>
            <span>从行情页加星，或切回「全部」查看已有自选</span>
            <button type="button" onClick={onGoMarket}>
              去行情页加星
            </button>
            <button type="button" onClick={() => setActiveGroup(ALL)}>
              换组
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
