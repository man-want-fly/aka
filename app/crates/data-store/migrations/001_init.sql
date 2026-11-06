-- state.db schema v1（Sprint 0）
-- 回滚脚本：001_init_rollback.sql

CREATE TABLE IF NOT EXISTS schema_versions (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  note       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS watchlist_groups (
  name       TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO watchlist_groups(name, sort_order) VALUES ('默认', 0);

CREATE TABLE IF NOT EXISTS watchlist_items (
  security   TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT '默认',
  sort_order INTEGER NOT NULL DEFAULT 0,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (security, group_name),
  FOREIGN KEY (group_name) REFERENCES watchlist_groups(name) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS favorites (
  security   TEXT PRIMARY KEY,
  note       TEXT NOT NULL DEFAULT '',
  added_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chart_layout (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 视口/周期/复权等工作台视图状态（T-04 的 view_state）
CREATE TABLE IF NOT EXISTS view_state (
  scope      TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS indicator_params (
  indicator_id TEXT NOT NULL,
  scope        TEXT NOT NULL DEFAULT 'global',
  params_json  TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (indicator_id, scope)
);

CREATE TABLE IF NOT EXISTS dataset_meta (
  dataset_id   TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  data_version TEXT NOT NULL,
  simulated    INTEGER NOT NULL,
  checksum     TEXT NOT NULL,
  generated_at INTEGER NOT NULL
);
