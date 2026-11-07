-- state.db schema v4（S-03.02-01 指标收藏）
-- 回滚脚本：004_indicator_favorites_rollback.sql
--
-- 收藏是「指标」的收藏，与自选股（favorites / watchlist_items）无关。
-- indicator_id 以注册表 id 为准（T01/M06/...）；注册表移除后行保留，由前端显示「已下线」。

CREATE TABLE IF NOT EXISTS indicator_favorites (
  indicator_id TEXT PRIMARY KEY,
  added_at     INTEGER NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_default   INTEGER NOT NULL DEFAULT 0
);
