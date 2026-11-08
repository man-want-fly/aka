import type { IndicatorFavoriteDto, ManifestIndicatorDto } from "../../lib/types";

interface Props {
  favorites: IndicatorFavoriteDto[] | null;
  manifestById: Map<string, ManifestIndicatorDto>;
  busyId: string | null;
  onToggleFavorite: (indicatorId: string, favorited: boolean) => void;
  onAdd: (item: ManifestIndicatorDto) => void;
  onOpenDetail: (indicatorId: string) => void;
  hint?: string | null;
}

/**
 * S-03.02-01：收藏区。
 * 目录页与指标浮层共用；chip 一律来自后端 DTO，前端不维护第二份收藏副本。
 */
export function FavoritesStrip({
  favorites,
  manifestById,
  busyId,
  onToggleFavorite,
  onAdd,
  onOpenDetail,
  hint,
}: Props) {
  const list = favorites ?? [];
  const overLimit = list.length > 30;

  return (
    <section
      className="fav-strip"
      data-fav-strip="1"
      data-fav-count={favorites === null ? "" : list.length}
      data-fav-over={overLimit ? "1" : "0"}
      style={{ marginBottom: 12 }}
    >
      <div className="fav-strip__head">
        <span className="caption">收藏</span>
        <span className="mono caption" data-fav-count-text="1">
          {favorites === null ? "…" : list.length}
        </span>
        {overLimit && (
          <span className="tag tag--warn" data-fav-many="1">
            收藏过多，建议精简
          </span>
        )}
      </div>

      {favorites === null && <div className="caption" data-fav-loading="1">收藏加载中…</div>}

      {favorites !== null && list.length === 0 && (
        <div className="catalog-empty" data-fav-empty="1" role="status">
          <div className="catalog-empty__title">还没有收藏</div>
          <div className="caption">从目录点星标即可加入收藏。</div>
        </div>
      )}

      {list.length > 0 && (
        <ul className="fav-chips">
          {list.map((favorite) => {
            const item = manifestById.get(favorite.indicatorId);
            const offline = favorite.status === "offline";
            const planned = favorite.status === "planned";
            const p1 = item?.priority === "P1";
            return (
              <li
                key={favorite.indicatorId}
                className={`fav-chip${offline ? " fav-chip--off" : ""}`}
                data-fav-chip={favorite.indicatorId}
                data-fav-status={favorite.status}
                data-fav-default={favorite.isDefault ? "1" : "0"}
                data-fav-panel={favorite.panel}
              >
                <button
                  type="button"
                  className="fav-chip__main"
                  data-fav-chip-add={favorite.indicatorId}
                  data-fav-chip-open={favorite.indicatorId}
                  aria-disabled={planned || offline || !item || undefined}
                  disabled={offline || !item}
                  title={favorite.paramSummary || favorite.nameZh}
                  onClick={() => {
                    if (!item || offline) return;
                    onAdd(item);
                  }}
                >
                  <span className="mono fav-chip__abbr">{favorite.abbr || favorite.indicatorId}</span>
                  <span className="caption fav-chip__param">{favorite.paramSummary}</span>
                  {p1 && <span className="tag tag--warn">P1</span>}
                  {favorite.isDefault && <span className="tag tag--muted">默认</span>}
                  {planned && <span className="tag tag--muted">规划中</span>}
                  {offline && <span className="tag tag--muted">已下线</span>}
                </button>
                {item && (
                  <button
                    type="button"
                    className="fav-chip__detail caption"
                    data-fav-chip-detail={favorite.indicatorId}
                    onClick={() => onOpenDetail(favorite.indicatorId)}
                  >
                    口径
                  </button>
                )}
                <button
                  type="button"
                  className="fav-chip__remove"
                  data-fav-remove={favorite.indicatorId}
                  aria-label={`取消收藏 ${favorite.nameZh}`}
                  disabled={busyId === favorite.indicatorId}
                  onClick={() => onToggleFavorite(favorite.indicatorId, false)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {hint && (
        <div className="caption" data-fav-hint="1" role="status" style={{ marginTop: 6 }}>
          {hint}
        </div>
      )}
    </section>
  );
}
