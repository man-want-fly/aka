-- state.db v1 回滚（仅用于本地开发/迁移演练；生产不自动执行）
DROP TABLE IF EXISTS dataset_meta;
DROP TABLE IF EXISTS indicator_params;
DROP TABLE IF EXISTS view_state;
DROP TABLE IF EXISTS chart_layout;
DROP TABLE IF EXISTS favorites;
DROP TABLE IF EXISTS watchlist_items;
DROP TABLE IF EXISTS watchlist_groups;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS schema_versions;
