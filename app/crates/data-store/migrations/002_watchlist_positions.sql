-- state.db schema v2（E-01 自选分组 / 持仓 / 视图状态）
-- 回滚脚本：002_watchlist_positions_rollback.sql

-- 分组补充内置标记与创建时间；内置组统一命名为「全部」
ALTER TABLE watchlist_groups ADD COLUMN is_builtin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE watchlist_groups ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;

UPDATE watchlist_items SET group_name = '全部' WHERE group_name = '默认';
UPDATE watchlist_groups SET name = '全部', is_builtin = 1 WHERE name = '默认';

CREATE TABLE IF NOT EXISTS positions (
  security    TEXT PRIMARY KEY,
  cost_price  REAL NOT NULL,
  shares      INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
