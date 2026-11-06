-- state.db v2 回滚（仅用于本地开发/迁移演练；生产不自动执行）
DROP TABLE IF EXISTS positions;
UPDATE watchlist_groups SET name = '默认', is_builtin = 0 WHERE name = '全部';
UPDATE watchlist_items SET group_name = '默认' WHERE group_name = '全部';
