-- S-05.01-02：最近查看。工作台打开标的时写入，同一标的刷新 viewed_at，
-- 最多保留 5 条；标的已不在数据集时由读取侧清理。
CREATE TABLE IF NOT EXISTS recent_views (
  code      TEXT PRIMARY KEY,
  viewed_at INTEGER NOT NULL
);
