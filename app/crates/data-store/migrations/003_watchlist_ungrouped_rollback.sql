-- state.db schema v3 回滚（仅本地演练，不自动执行）
-- 恢复「全部」内置组并在组内承载所有未分组标的。

INSERT OR IGNORE INTO watchlist_groups(name, sort_order, is_builtin, created_at)
VALUES ('全部', 0, 1, 0);

UPDATE watchlist_items SET group_name = '全部' WHERE group_name IS NULL OR group_name = '';

CREATE TABLE watchlist_items_old (
  security   TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT '全部',
  sort_order INTEGER NOT NULL DEFAULT 0,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (security, group_name),
  FOREIGN KEY (group_name) REFERENCES watchlist_groups(name) ON DELETE CASCADE
);

INSERT INTO watchlist_items_old(security, group_name, sort_order, added_at)
SELECT security, group_name, sort_order, added_at FROM watchlist_items;

DROP TABLE watchlist_items;
ALTER TABLE watchlist_items_old RENAME TO watchlist_items;
