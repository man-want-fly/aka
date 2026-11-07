-- state.db schema v3（S-01.02：自选单一归属 + 「全部」只读派生 + 未分组）
-- 回滚脚本：003_watchlist_ungrouped_rollback.sql
--
-- 口径（BA 2026-11-07 定）：
-- 1. 「全部」不再承载 items，只是 COUNT(*) 的派生视图；
-- 2. 标的单一归属：group_name = NULL 表示「未分组」；
-- 3. 删组不搬进「全部」，执行 UPDATE ... SET group_name = NULL。

CREATE TABLE watchlist_items_v3 (
  security   TEXT PRIMARY KEY,
  group_name TEXT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  added_at   INTEGER NOT NULL,
  FOREIGN KEY (group_name) REFERENCES watchlist_groups(name) ON DELETE SET NULL
);

INSERT INTO watchlist_items_v3(security, group_name, sort_order, added_at)
SELECT security,
       CASE
         WHEN group_name IN (SELECT name FROM watchlist_groups WHERE is_builtin = 1) THEN NULL
         ELSE group_name
       END,
       sort_order,
       added_at
FROM watchlist_items
WHERE rowid IN (SELECT MIN(rowid) FROM watchlist_items GROUP BY security);

DROP TABLE watchlist_items;
ALTER TABLE watchlist_items_v3 RENAME TO watchlist_items;

-- 内置组「全部」退役：不再作为可写入的分组行
DELETE FROM watchlist_groups WHERE is_builtin = 1;
