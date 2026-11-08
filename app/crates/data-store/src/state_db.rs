//! state.db：SQLite 持久化（自选、设置、指标参数、图表布局、数据版本）。
//!
//! 位置：`~/Library/Application Support/aka/state.db`（由 aka-desktop 计算后注入，
//! 本 crate 不感知 Tauri）。schema 版本记录在 `schema_versions` 表，迁移脚本为
//! `migrations/00N_*.sql`，向前迁移与回滚脚本成对存在。
//!
//! 降级策略（已冻结）：
//! - 打开时 `PRAGMA quick_check` 失败 → 把坏库改名为 `state.db.corrupt-<ts>`，
//!   重建空库，`degraded = true`，应用继续启动；
//! - 目录/文件不可写 → 退回内存库 `open_with_fallback`，同样 `degraded = true`；
//! - 单条写入失败 → 事务回滚，返回 `DbError::Write`，内存状态不变，不静默丢数据。

use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};

pub const SCHEMA_VERSION: i64 = 5;

const MIGRATION_001: &str = include_str!("../migrations/001_init.sql");
const MIGRATION_002: &str = include_str!("../migrations/002_watchlist_positions.sql");
const MIGRATION_003: &str = include_str!("../migrations/003_watchlist_ungrouped.sql");
const MIGRATION_004: &str = include_str!("../migrations/004_indicator_favorites.sql");
const MIGRATION_005: &str = include_str!("../migrations/005_recent_views.sql");

/// 首装默认收藏写入标记：用户删光后不得自动补回。
pub const FAVORITES_INITIALIZED_KEY: &str = "favorites_initialized";

/// 自选写入结果：`LimitReached` 表示事务内预检发现已达上限，未写入。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddWatchOutcome {
    Added,
    LimitReached,
}

#[derive(Debug)]
pub enum DbError {
    Open(String),
    Corrupt(String),
    Write(String),
    Read(String),
}

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DbError::Open(msg) => write!(f, "state.db 打开失败：{msg}"),
            DbError::Corrupt(msg) => write!(f, "state.db 已损坏：{msg}"),
            DbError::Write(msg) => write!(f, "state.db 写入失败：{msg}"),
            DbError::Read(msg) => write!(f, "state.db 读取失败：{msg}"),
        }
    }
}

impl std::error::Error for DbError {}

impl DbError {
    pub fn retryable(&self) -> bool {
        matches!(self, DbError::Write(_))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchItem {
    pub security: String,
    /// `None` = 未分组；「全部」是只读派生，不落库
    pub group_name: Option<String>,
    pub sort_order: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchGroup {
    pub name: String,
    pub sort_order: i64,
    pub is_builtin: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PositionRow {
    pub security: String,
    pub cost_price: f64,
    pub shares: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatasetMeta {
    pub dataset_id: String,
    pub provider: String,
    pub data_version: String,
    pub simulated: bool,
    pub checksum: String,
    pub generated_at: i64,
}

/// 指标收藏行；`is_default` 仅用于首装识别与排序，不代表不可取消。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndicatorFavorite {
    pub indicator_id: String,
    pub added_at: i64,
    pub sort_order: i64,
    pub is_default: bool,
}

/// 最近查看行：同一标的只保留一条，`viewed_at` 为最近一次打开时间（epoch 秒）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentView {
    pub code: String,
    pub viewed_at: i64,
}

pub struct StateDb {
    conn: Connection,
    path: PathBuf,
    degraded: bool,
    degraded_reason: Option<String>,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl StateDb {
    /// 打开真实库；坏库/不可写时降级（不返回 Err），调用方通过 `degraded()` 判断。
    pub fn open_with_fallback(path: impl AsRef<Path>) -> Self {
        let path = path.as_ref().to_path_buf();
        match Self::open_strict(&path) {
            Ok(db) => db,
            Err(err) => {
                let reason = err.to_string();
                if let Err(corrupt) = Self::quarantine(&path) {
                    eprintln!("[state.db] 隔离坏库失败：{corrupt}");
                }
                match Connection::open_in_memory() {
                    Ok(conn) => {
                        let mut db = Self {
                            conn,
                            path,
                            degraded: true,
                            degraded_reason: Some(reason),
                        };
                        if let Err(err) = db.migrate() {
                            eprintln!("[state.db] 内存库迁移失败：{err}");
                        }
                        db
                    }
                    Err(err) => panic!("state.db 连内存兜底都失败：{err}"),
                }
            }
        }
    }

    fn open_strict(path: &Path) -> Result<Self, DbError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| DbError::Open(format!("创建目录 {} 失败：{err}", parent.display())))?;
        }
        let conn = Connection::open(path).map_err(|err| DbError::Open(err.to_string()))?;
        let check: String = conn
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(|err| DbError::Corrupt(err.to_string()))?;
        if check != "ok" {
            return Err(DbError::Corrupt(check));
        }
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(|err| DbError::Open(err.to_string()))?;

        let mut db = Self {
            conn,
            path: path.to_path_buf(),
            degraded: false,
            degraded_reason: None,
        };
        db.migrate()?;
        Ok(db)
    }

    pub fn open_in_memory() -> Result<Self, DbError> {
        let conn = Connection::open_in_memory().map_err(|err| DbError::Open(err.to_string()))?;
        let mut db = Self {
            conn,
            path: PathBuf::from(":memory:"),
            degraded: false,
            degraded_reason: None,
        };
        db.migrate()?;
        Ok(db)
    }

    fn quarantine(path: &Path) -> Result<(), String> {
        if !path.exists() {
            return Ok(());
        }
        let backup = path.with_extension(format!("corrupt-{}", now()));
        fs::rename(path, &backup).map_err(|err| err.to_string())
    }

    fn migrate(&mut self) -> Result<(), DbError> {
        let mut version: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|err| DbError::Read(err.to_string()))?;

        if version > SCHEMA_VERSION {
            return Err(DbError::Corrupt(format!(
                "库版本 {version} 高于代码支持版本 {SCHEMA_VERSION}，拒绝静默降级"
            )));
        }

        while version < SCHEMA_VERSION {
            version += 1;
            match version {
                1 => {
                    let tx = self.conn.transaction().map_err(|e| DbError::Write(e.to_string()))?;
                    tx.execute_batch(MIGRATION_001).map_err(|e| DbError::Write(e.to_string()))?;
                    tx.execute(
                        "INSERT OR REPLACE INTO schema_versions(version, applied_at, note) VALUES (?, ?, ?)",
                        params![1_i64, now(), "init: settings/watchlist/favorites/layout/params/dataset"],
                    )
                    .map_err(|e| DbError::Write(e.to_string()))?;
                    tx.commit().map_err(|e| DbError::Write(e.to_string()))?;
                }
                2 => {
                    let tx = self.conn.transaction().map_err(|e| DbError::Write(e.to_string()))?;
                    tx.execute_batch(MIGRATION_002).map_err(|e| DbError::Write(e.to_string()))?;
                    tx.execute(
                        "INSERT OR REPLACE INTO schema_versions(version, applied_at, note) VALUES (?, ?, ?)",
                        params![2_i64, now(), "e01: builtin group / positions"],
                    )
                    .map_err(|e| DbError::Write(e.to_string()))?;
                    tx.commit().map_err(|e| DbError::Write(e.to_string()))?;
                }
                3 => {
                    let tx = self.conn.transaction().map_err(|e| DbError::Write(e.to_string()))?;
                    tx.execute_batch(MIGRATION_003).map_err(|e| DbError::Write(e.to_string()))?;
                    tx.execute(
                        "INSERT OR REPLACE INTO schema_versions(version, applied_at, note) VALUES (?, ?, ?)",
                        params![3_i64, now(), "s0102: ungrouped watchlist / drop builtin 全部"],
                    )
                    .map_err(|e| DbError::Write(e.to_string()))?;
                    tx.commit().map_err(|e| DbError::Write(e.to_string()))?;
                }
                4 => {
                    let tx = self.conn.transaction().map_err(|e| DbError::Write(e.to_string()))?;
                    tx.execute_batch(MIGRATION_004).map_err(|e| DbError::Write(e.to_string()))?;
                    tx.execute(
                        "INSERT OR REPLACE INTO schema_versions(version, applied_at, note) VALUES (?, ?, ?)",
                        params![4_i64, now(), "s0302: indicator favorites"],
                    )
                    .map_err(|e| DbError::Write(e.to_string()))?;
                    tx.commit().map_err(|e| DbError::Write(e.to_string()))?;
                }
                5 => {
                    let tx = self.conn.transaction().map_err(|e| DbError::Write(e.to_string()))?;
                    tx.execute_batch(MIGRATION_005).map_err(|e| DbError::Write(e.to_string()))?;
                    tx.execute(
                        "INSERT OR REPLACE INTO schema_versions(version, applied_at, note) VALUES (?, ?, ?)",
                        params![5_i64, now(), "s0501: recent views"],
                    )
                    .map_err(|e| DbError::Write(e.to_string()))?;
                    tx.commit().map_err(|e| DbError::Write(e.to_string()))?;
                }
                other => {
                    return Err(DbError::Corrupt(format!("缺失迁移脚本：v{other}")));
                }
            }
            self.conn
                .execute_batch(&format!("PRAGMA user_version={version}"))
                .map_err(|e| DbError::Write(e.to_string()))?;
        }
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn degraded(&self) -> bool {
        self.degraded
    }

    pub fn degraded_reason(&self) -> Option<&str> {
        self.degraded_reason.as_deref()
    }

    /// QA 注入（`--readonly-db`）：让连接进入 SQLite 只读模式。
    /// 后续写操作由 SQLite 自己返回 `attempt to write a readonly database`，
    /// 走产品真实的只读错误映射，而不是另造一条假错误。
    /// 发布构建不编译该方法（注入入口整体收在 debug 断言内）。
    #[cfg(debug_assertions)]
    #[doc(hidden)]
    pub fn enable_query_only_for_diag(&self) -> Result<(), DbError> {
        self.conn
            .execute_batch("PRAGMA query_only=ON;")
            .map_err(|err| DbError::Write(err.to_string()))
    }

    pub fn schema_version(&self) -> i64 {
        self.conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap_or(0)
    }

    /// 迁移演练入口（回滚脚本仅本地使用，不自动执行）。
    #[doc(hidden)]
    pub fn apply_rollback_v1_for_tests(&self) -> Result<(), DbError> {
        self.conn
            .execute_batch(include_str!("../migrations/005_recent_views_rollback.sql"))
            .map_err(|e| DbError::Write(e.to_string()))?;
        self.conn
            .execute_batch(include_str!("../migrations/004_indicator_favorites_rollback.sql"))
            .map_err(|e| DbError::Write(e.to_string()))?;
        self.conn
            .execute_batch(include_str!("../migrations/002_watchlist_positions_rollback.sql"))
            .map_err(|e| DbError::Write(e.to_string()))?;
        self.conn
            .execute_batch(include_str!("../migrations/001_init_rollback.sql"))
            .map_err(|e| DbError::Write(e.to_string()))?;
        self.conn
            .execute_batch("PRAGMA user_version=0")
            .map_err(|e| DbError::Write(e.to_string()))?;
        Ok(())
    }

    // ---------- settings ----------

    pub fn setting(&self, key: &str) -> Result<Option<String>, DbError> {
        self.conn
            .query_row("SELECT value FROM settings WHERE key = ?", params![key], |row| row.get(0))
            .optional()
            .map_err(|err| DbError::Read(err.to_string()))
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), DbError> {
        self.conn
            .execute(
                "INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![key, value, now()],
            )
            .map(|_| ())
            .map_err(|err| DbError::Write(err.to_string()))
    }

    // ---------- indicator favorites（S-03.02-01） ----------

    /// 排序：用户后加的在前（added_at 倒序），默认 8 个随后按预置 sort_order。
    pub fn indicator_favorites(&self) -> Result<Vec<IndicatorFavorite>, DbError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT indicator_id, added_at, sort_order, is_default FROM indicator_favorites
                 ORDER BY is_default ASC,
                          (CASE WHEN is_default = 0 THEN -sort_order ELSE sort_order END) ASC,
                          indicator_id ASC",
            )
            .map_err(|err| DbError::Read(err.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(IndicatorFavorite {
                    indicator_id: row.get(0)?,
                    added_at: row.get(1)?,
                    sort_order: row.get(2)?,
                    is_default: row.get::<_, i64>(3)? != 0,
                })
            })
            .map_err(|err| DbError::Read(err.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| DbError::Read(err.to_string()))
    }

    pub fn indicator_favorite_count(&self) -> Result<i64, DbError> {
        self.conn
            .query_row("SELECT COUNT(*) FROM indicator_favorites", [], |row| row.get(0))
            .map_err(|err| DbError::Read(err.to_string()))
    }

    /// 首装写入默认 8 个：仅当「无初始化标记且表为空」时写入并置标记。
    /// 用户删光后重启不会补回（标记已存在）。
    pub fn ensure_default_indicator_favorites(&self, defaults: &[&str]) -> Result<usize, DbError> {
        let tx = self.conn.unchecked_transaction().map_err(|e| DbError::Write(e.to_string()))?;
        let initialized: Option<String> = tx
            .query_row(
                "SELECT value FROM settings WHERE key = ?",
                params![FAVORITES_INITIALIZED_KEY],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| DbError::Read(err.to_string()))?;
        if initialized.is_some() {
            return Ok(0);
        }

        let existing: i64 = tx
            .query_row("SELECT COUNT(*) FROM indicator_favorites", [], |row| row.get(0))
            .map_err(|err| DbError::Read(err.to_string()))?;

        let mut inserted = 0usize;
        if existing == 0 {
            for (index, id) in defaults.iter().enumerate() {
                inserted += tx
                    .execute(
                        "INSERT OR IGNORE INTO indicator_favorites(indicator_id, added_at, sort_order, is_default)
                         VALUES (?, ?, ?, 1)",
                        params![id, now(), index as i64],
                    )
                    .map_err(|err| DbError::Write(err.to_string()))?;
            }
        }
        tx.execute(
            "INSERT INTO settings(key, value, updated_at) VALUES (?, '1', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![FAVORITES_INITIALIZED_KEY, now()],
        )
        .map_err(|err| DbError::Write(err.to_string()))?;
        tx.commit().map_err(|e| DbError::Write(e.to_string()))?;
        Ok(inserted)
    }

    /// 收藏写入幂等：连点多次只保留一行，`added_at` 与排序不被后写覆盖。
    pub fn add_indicator_favorite(&self, indicator_id: &str) -> Result<bool, DbError> {
        let next: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM indicator_favorites WHERE is_default = 0",
                [],
                |row| row.get(0),
            )
            .map_err(|err| DbError::Read(err.to_string()))?;
        let changed = self
            .conn
            .execute(
                "INSERT INTO indicator_favorites(indicator_id, added_at, sort_order, is_default)
                 VALUES (?, ?, ?, 0)
                 ON CONFLICT(indicator_id) DO NOTHING",
                params![indicator_id, now(), next],
            )
            .map_err(|err| DbError::Write(err.to_string()))?;
        Ok(changed > 0)
    }

    pub fn remove_indicator_favorite(&self, indicator_id: &str) -> Result<bool, DbError> {
        let changed = self
            .conn
            .execute(
                "DELETE FROM indicator_favorites WHERE indicator_id = ?",
                params![indicator_id],
            )
            .map_err(|err| DbError::Write(err.to_string()))?;
        Ok(changed > 0)
    }

    // ---------- recent views ----------

    /// 按最近打开倒序读取，最多 `limit` 条；同一秒内按代码升序保证稳定。
    pub fn recent_views(&self, limit: usize) -> Result<Vec<RecentView>, DbError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT code, viewed_at FROM recent_views
                 ORDER BY viewed_at DESC, code ASC LIMIT ?1",
            )
            .map_err(|err| DbError::Read(err.to_string()))?;
        let rows = stmt
            .query_map(params![limit as i64], |row| {
                Ok(RecentView { code: row.get(0)?, viewed_at: row.get(1)? })
            })
            .map_err(|err| DbError::Read(err.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|err| DbError::Read(err.to_string()))
    }

    /// 打开标的：已存在则只刷新时间，不新增行。
    pub fn touch_recent_view(&self, code: &str) -> Result<(), DbError> {
        self.conn
            .execute(
                "INSERT INTO recent_views(code, viewed_at) VALUES (?1, ?2)
                 ON CONFLICT(code) DO UPDATE SET viewed_at = excluded.viewed_at",
                params![code, now()],
            )
            .map_err(|err| DbError::Write(err.to_string()))?;
        Ok(())
    }

    /// 只保留最近 `keep` 条；被清理的行由调用方决定时机。
    pub fn prune_recent_views(&self, keep: usize) -> Result<usize, DbError> {
        self.conn
            .execute(
                "DELETE FROM recent_views WHERE code NOT IN (
                   SELECT code FROM recent_views ORDER BY viewed_at DESC, code ASC LIMIT ?1
                 )",
                params![keep as i64],
            )
            .map_err(|err| DbError::Write(err.to_string()))
    }

    /// 数据集里已不存在的标的：下次读取时清掉，避免浮层显示幽灵记录。
    pub fn remove_recent_view(&self, code: &str) -> Result<bool, DbError> {
        let changed = self
            .conn
            .execute("DELETE FROM recent_views WHERE code = ?", params![code])
            .map_err(|err| DbError::Write(err.to_string()))?;
        Ok(changed > 0)
    }

    // ---------- watchlist ----------

    pub fn watchlist(&self) -> Result<Vec<WatchItem>, DbError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT security, group_name, sort_order FROM watchlist_items
                 ORDER BY (group_name IS NULL), group_name, sort_order, security",
            )
            .map_err(|err| DbError::Read(err.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(WatchItem {
                    security: row.get(0)?,
                    group_name: row.get(1)?,
                    sort_order: row.get(2)?,
                })
            })
            .map_err(|err| DbError::Read(err.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| DbError::Read(err.to_string()))
    }

    /// 事务内预检 + 写入：`count >= limit` 时拒第 limit+1 只（499 放行、落库 500）。
    pub fn add_watch_with_limit(
        &self,
        security: &str,
        group: Option<&str>,
        sort_order: i64,
        limit: i64,
    ) -> Result<AddWatchOutcome, DbError> {
        let tx = self.conn.unchecked_transaction().map_err(|e| DbError::Write(e.to_string()))?;
        let already: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM watchlist_items WHERE security = ?",
                params![security],
                |row| row.get(0),
            )
            .map_err(|err| DbError::Read(err.to_string()))?;
        if already == 0 {
            let count: i64 = tx
                .query_row("SELECT COUNT(DISTINCT security) FROM watchlist_items", [], |row| row.get(0))
                .map_err(|err| DbError::Read(err.to_string()))?;
            if count >= limit {
                // 未写入，事务随 drop 回滚
                return Ok(AddWatchOutcome::LimitReached);
            }
        }
        tx.execute(
            "INSERT INTO watchlist_items(security, group_name, sort_order, added_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(security) DO UPDATE SET group_name = excluded.group_name, sort_order = excluded.sort_order",
            params![security, group, sort_order, now()],
        )
        .map_err(|err| DbError::Write(err.to_string()))?;
        tx.commit().map_err(|e| DbError::Write(e.to_string()))?;
        Ok(AddWatchOutcome::Added)
    }

    pub fn remove_watch(&self, security: &str) -> Result<(), DbError> {
        self.conn
            .execute("DELETE FROM watchlist_items WHERE security = ?", params![security])
            .map(|_| ())
            .map_err(|err| DbError::Write(err.to_string()))
    }

    /// 去重后的自选标的总数（同一标的在多个分组只算一次），用于 500 上限判定。
    pub fn watch_distinct_count(&self) -> Result<i64, DbError> {
        self.conn
            .query_row("SELECT COUNT(DISTINCT security) FROM watchlist_items", [], |row| row.get(0))
            .map_err(|err| DbError::Read(err.to_string()))
    }

    // ---------- watchlist groups ----------

    pub fn watch_groups(&self) -> Result<Vec<WatchGroup>, DbError> {
        let mut stmt = self
            .conn
            .prepare("SELECT name, sort_order, is_builtin FROM watchlist_groups ORDER BY sort_order, name")
            .map_err(|err| DbError::Read(err.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(WatchGroup {
                    name: row.get(0)?,
                    sort_order: row.get(1)?,
                    is_builtin: row.get::<_, i64>(2)? != 0,
                })
            })
            .map_err(|err| DbError::Read(err.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|err| DbError::Read(err.to_string()))
    }

    pub fn watch_group_exists(&self, name: &str) -> Result<bool, DbError> {
        let count: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM watchlist_groups WHERE name = ? COLLATE NOCASE",
                params![name],
                |row| row.get(0),
            )
            .map_err(|err| DbError::Read(err.to_string()))?;
        Ok(count > 0)
    }

    pub fn create_watch_group(&self, name: &str) -> Result<(), DbError> {
        let next: i64 = self
            .conn
            .query_row("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM watchlist_groups", [], |row| row.get(0))
            .map_err(|err| DbError::Read(err.to_string()))?;
        self.conn
            .execute(
                "INSERT INTO watchlist_groups(name, sort_order, is_builtin, created_at) VALUES (?, ?, 0, ?)",
                params![name, next, now()],
            )
            .map(|_| ())
            .map_err(|err| DbError::Write(err.to_string()))
    }

    pub fn rename_watch_group(&self, old: &str, new: &str) -> Result<(), DbError> {
        let tx = self.conn.unchecked_transaction().map_err(|e| DbError::Write(e.to_string()))?;
        // 先建新组、再搬标的、最后删旧组，全程满足外键（直接 UPDATE 父表会立刻触发 FK 失败）
        tx.execute(
            "INSERT INTO watchlist_groups(name, sort_order, is_builtin, created_at)
             SELECT ?, sort_order, is_builtin, created_at FROM watchlist_groups WHERE name = ?",
            params![new, old],
        )
        .map_err(|err| DbError::Write(err.to_string()))?;
        tx.execute(
            "UPDATE watchlist_items SET group_name = ? WHERE group_name = ?",
            params![new, old],
        )
        .map_err(|err| DbError::Write(err.to_string()))?;
        tx.execute("DELETE FROM watchlist_groups WHERE name = ?", params![old])
            .map_err(|err| DbError::Write(err.to_string()))?;
        tx.commit().map_err(|e| DbError::Write(e.to_string()))
    }

    /// 删除自定义分组；组内标的回到「未分组」（group_name = NULL），不丢自选。
    pub fn delete_watch_group(&self, name: &str) -> Result<(), DbError> {
        let tx = self.conn.unchecked_transaction().map_err(|e| DbError::Write(e.to_string()))?;
        tx.execute(
            "UPDATE watchlist_items SET group_name = NULL WHERE group_name = ?",
            params![name],
        )
        .map_err(|err| DbError::Write(err.to_string()))?;
        tx.execute("DELETE FROM watchlist_groups WHERE name = ?", params![name])
            .map_err(|err| DbError::Write(err.to_string()))?;
        tx.commit().map_err(|e| DbError::Write(e.to_string()))
    }

    // ---------- view state ----------

    pub fn view_state(&self, scope: &str) -> Result<Option<serde_json::Value>, DbError> {
        let raw: Option<String> = self
            .conn
            .query_row(
                "SELECT state_json FROM view_state WHERE scope = ?",
                params![scope],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| DbError::Read(err.to_string()))?;
        match raw {
            None => Ok(None),
            Some(text) => serde_json::from_str(&text)
                .map(Some)
                .map_err(|err| DbError::Corrupt(format!("视图状态 JSON 非法：{err}"))),
        }
    }

    pub fn set_view_state(&self, scope: &str, value: &serde_json::Value) -> Result<(), DbError> {
        let text = serde_json::to_string(value)
            .map_err(|err| DbError::Write(format!("视图状态序列化失败：{err}")))?;
        self.conn
            .execute(
                "INSERT INTO view_state(scope, state_json, updated_at) VALUES (?, ?, ?)
                 ON CONFLICT(scope) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
                params![scope, text, now()],
            )
            .map(|_| ())
            .map_err(|err| DbError::Write(err.to_string()))
    }

    // ---------- positions ----------

    pub fn positions(&self) -> Result<Vec<PositionRow>, DbError> {
        let mut stmt = self
            .conn
            .prepare("SELECT security, cost_price, shares, updated_at FROM positions ORDER BY security")
            .map_err(|err| DbError::Read(err.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(PositionRow {
                    security: row.get(0)?,
                    cost_price: row.get(1)?,
                    shares: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })
            .map_err(|err| DbError::Read(err.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|err| DbError::Read(err.to_string()))
    }

    pub fn save_position(&self, security: &str, cost_price: f64, shares: i64) -> Result<(), DbError> {
        self.conn
            .execute(
                "INSERT INTO positions(security, cost_price, shares, updated_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT(security) DO UPDATE SET cost_price = excluded.cost_price,
                    shares = excluded.shares, updated_at = excluded.updated_at",
                params![security, cost_price, shares, now()],
            )
            .map(|_| ())
            .map_err(|err| DbError::Write(err.to_string()))
    }

    pub fn delete_position(&self, security: &str) -> Result<(), DbError> {
        self.conn
            .execute("DELETE FROM positions WHERE security = ?", params![security])
            .map(|_| ())
            .map_err(|err| DbError::Write(err.to_string()))
    }

    // ---------- indicator params ----------

    pub fn indicator_params(
        &self,
        indicator_id: &str,
        scope: &str,
    ) -> Result<Option<serde_json::Value>, DbError> {
        let raw: Option<String> = self
            .conn
            .query_row(
                "SELECT params_json FROM indicator_params WHERE indicator_id = ? AND scope = ?",
                params![indicator_id, scope],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| DbError::Read(err.to_string()))?;
        match raw {
            None => Ok(None),
            Some(text) => serde_json::from_str(&text)
                .map(Some)
                .map_err(|err| DbError::Corrupt(format!("参数 JSON 非法：{err}") )),
        }
    }

    pub fn set_indicator_params(
        &self,
        indicator_id: &str,
        scope: &str,
        value: &serde_json::Value,
    ) -> Result<(), DbError> {
        let text = serde_json::to_string(value)
            .map_err(|err| DbError::Write(format!("参数序列化失败：{err}")))?;
        self.conn
            .execute(
                "INSERT INTO indicator_params(indicator_id, scope, params_json, updated_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT(indicator_id, scope) DO UPDATE SET params_json = excluded.params_json, updated_at = excluded.updated_at",
                params![indicator_id, scope, text, now()],
            )
            .map(|_| ())
            .map_err(|err| DbError::Write(err.to_string()))
    }

    // ---------- dataset meta ----------

    pub fn dataset_meta(&self, dataset_id: &str) -> Result<Option<DatasetMeta>, DbError> {
        self.conn
            .query_row(
                "SELECT dataset_id, provider, data_version, simulated, checksum, generated_at
                 FROM dataset_meta WHERE dataset_id = ?",
                params![dataset_id],
                |row| {
                    Ok(DatasetMeta {
                        dataset_id: row.get(0)?,
                        provider: row.get(1)?,
                        data_version: row.get(2)?,
                        simulated: row.get::<_, i64>(3)? != 0,
                        checksum: row.get(4)?,
                        generated_at: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(|err| DbError::Read(err.to_string()))
    }

    pub fn upsert_dataset_meta(&self, meta: &DatasetMeta) -> Result<(), DbError> {
        self.conn
            .execute(
                "INSERT INTO dataset_meta(dataset_id, provider, data_version, simulated, checksum, generated_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(dataset_id) DO UPDATE SET provider=excluded.provider, data_version=excluded.data_version,
                 simulated=excluded.simulated, checksum=excluded.checksum, generated_at=excluded.generated_at",
                params![
                    meta.dataset_id,
                    meta.provider,
                    meta.data_version,
                    if meta.simulated { 1 } else { 0 },
                    meta.checksum,
                    meta.generated_at
                ],
            )
            .map(|_| ())
            .map_err(|err| DbError::Write(err.to_string()))
    }

    pub fn table_names(&self) -> Result<Vec<String>, DbError> {
        let mut stmt = self
            .conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .map_err(|err| DbError::Read(err.to_string()))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|err| DbError::Read(err.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| DbError::Read(err.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> StateDb {
        StateDb::open_in_memory().unwrap()
    }

    #[test]
    fn creates_expected_tables_and_version() {
        let db = memory();
        let tables = db.table_names().unwrap();
        for expected in [
            "settings",
            "watchlist_groups",
            "watchlist_items",
            "favorites",
            "chart_layout",
            "view_state",
            "indicator_params",
            "indicator_favorites",
            "recent_views",
            "dataset_meta",
            "positions",
            "schema_versions",
        ] {
            assert!(tables.iter().any(|t| t == expected), "缺少表 {expected}：{tables:?}");
        }
        assert_eq!(db.schema_version(), SCHEMA_VERSION);
        let logged: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM schema_versions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(logged, 5);
        // v3 起「全部」为只读派生，不再落库
        assert!(db.watch_groups().unwrap().is_empty());
    }

    #[test]
    fn settings_roundtrip_and_upsert() {
        let db = memory();
        assert_eq!(db.setting("theme").unwrap(), None);
        db.set_setting("theme", "dark").unwrap();
        db.set_setting("theme", "light").unwrap();
        assert_eq!(db.setting("theme").unwrap().as_deref(), Some("light"));
    }

    #[test]
    fn watchlist_roundtrip() {
        let db = memory();
        db.add_watch_with_limit("600519.SH", None, 0, 500).unwrap();
        db.add_watch_with_limit("000001.SZ", None, 1, 500).unwrap();
        db.add_watch_with_limit("600519.SH", None, 5, 500).unwrap();
        let items = db.watchlist().unwrap();
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|item| item.group_name.is_none()));
        db.remove_watch("600519.SH").unwrap();
        assert_eq!(db.watchlist().unwrap().len(), 1);
    }

    #[test]
    fn watchlist_limit_is_enforced_inside_transaction() {
        let db = memory();
        for index in 0..499 {
            db.add_watch_with_limit(&format!("S{index:04}"), None, index, 500)
                .unwrap();
        }
        assert_eq!(db.watch_distinct_count().unwrap(), 499);
        // 第 500 只放行并落库
        assert_eq!(
            db.add_watch_with_limit("S0499", None, 499, 500).unwrap(),
            AddWatchOutcome::Added
        );
        assert_eq!(db.watch_distinct_count().unwrap(), 500);
        // 第 501 只拒写
        assert_eq!(
            db.add_watch_with_limit("S0500", None, 500, 500).unwrap(),
            AddWatchOutcome::LimitReached
        );
        assert_eq!(db.watch_distinct_count().unwrap(), 500);
    }

    #[test]
    fn group_rename_and_delete_returns_items_to_ungrouped() {
        let db = memory();
        db.create_watch_group("短线").unwrap();
        db.add_watch_with_limit("600519.SH", Some("短线"), 0, 500).unwrap();
        db.rename_watch_group("短线", "波段").unwrap();
        assert_eq!(db.watchlist().unwrap()[0].group_name.as_deref(), Some("波段"));
        db.delete_watch_group("波段").unwrap();
        assert_eq!(db.watchlist().unwrap()[0].group_name, None);
        assert!(db.watch_groups().unwrap().iter().all(|g| g.name != "波段"));
        assert_eq!(db.watch_distinct_count().unwrap(), 1);
    }

    #[test]
    fn positions_and_view_state_roundtrip() {
        let db = memory();
        db.save_position("600519.SH", 1500.0, 100).unwrap();
        db.save_position("600519.SH", 1600.0, 200).unwrap();
        let rows = db.positions().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].shares, 200);
        db.delete_position("600519.SH").unwrap();
        assert!(db.positions().unwrap().is_empty());

        let state = serde_json::json!({"board": "sz", "sort": {"key": "changePct", "dir": "desc"}});
        db.set_view_state("market", &state).unwrap();
        assert_eq!(db.view_state("market").unwrap(), Some(state));
    }

    #[test]
    fn indicator_params_roundtrip() {
        let db = memory();
        assert!(db.indicator_params("ma", "global").unwrap().is_none());
        let value = serde_json::json!({"period": 30, "maType": "ema"});
        db.set_indicator_params("ma", "global", &value).unwrap();
        assert_eq!(db.indicator_params("ma", "global").unwrap(), Some(value));
    }

    #[test]
    fn dataset_meta_roundtrip() {
        let db = memory();
        let meta = DatasetMeta {
            dataset_id: "mock-1d-600519.SH".into(),
            provider: "mock".into(),
            data_version: "mock-0.1".into(),
            simulated: true,
            checksum: "sha256:abc".into(),
            generated_at: 1_700_000_000,
        };
        db.upsert_dataset_meta(&meta).unwrap();
        assert_eq!(db.dataset_meta("mock-1d-600519.SH").unwrap(), Some(meta));
    }

    #[test]
    fn recent_views_dedupe_prune_and_rollback() {
        let db = memory();
        db.touch_recent_view("600519.SH").unwrap();
        db.touch_recent_view("000001.SZ").unwrap();
        db.touch_recent_view("600519.SH").unwrap();
        let rows = db.recent_views(5).unwrap();
        assert_eq!(rows.len(), 2, "重复打开同一标的不新增行");
        assert!(rows.iter().any(|row| row.code == "600519.SH"));

        for code in ["300750.SZ", "000858.SZ", "601318.SH", "002594.SZ"] {
            db.touch_recent_view(code).unwrap();
        }
        db.prune_recent_views(5).unwrap();
        assert_eq!(db.recent_views(10).unwrap().len(), 5, "最多保留 5 条");

        db.remove_recent_view("600519.SH").unwrap();
        assert!(db
            .recent_views(10)
            .unwrap()
            .iter()
            .all(|row| row.code != "600519.SH"));

        db.apply_rollback_v1_for_tests().unwrap();
        assert!(db.table_names().unwrap().is_empty());
    }

    #[test]
    fn forward_then_rollback_migration() {
        let db = memory();
        db.apply_rollback_v1_for_tests().unwrap();
        assert_eq!(db.schema_version(), 0);
        assert!(db.table_names().unwrap().is_empty());
    }

    #[test]
    fn write_to_missing_column_fails_but_does_not_panic() {
        let db = memory();
        // 通过类型错误触发写失败，事务语义由 SQLite 保证：原值不变
        db.set_setting("a", "1").unwrap();
        let err = db
            .conn
            .execute("INSERT INTO settings(key, value, updated_at) VALUES (NULL, NULL, 0)", []);
        assert!(err.is_err());
        assert_eq!(db.setting("a").unwrap().as_deref(), Some("1"));
    }

    #[test]
    fn corrupt_db_is_quarantined_and_falls_back() {
        let dir = std::env::temp_dir().join(format!("aka-state-test-{}", now()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.db");
        fs::write(&path, b"not a sqlite database at all").unwrap();
        let db = StateDb::open_with_fallback(&path);
        assert!(db.degraded(), "坏库必须降级");
        let backups: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("corrupt"))
            .collect();
        assert_eq!(backups.len(), 1, "坏库应被改名保留");
        assert_eq!(db.schema_version(), SCHEMA_VERSION);
        fs::remove_dir_all(&dir).ok();
    }

    const DEFAULTS: [&str; 8] = ["T01", "T02", "T09", "M06", "M01", "M02", "V01", "M05"];

    #[test]
    fn first_install_seeds_eight_defaults_once() {
        let db = memory();
        assert_eq!(db.ensure_default_indicator_favorites(&DEFAULTS).unwrap(), 8);
        let rows = db.indicator_favorites().unwrap();
        assert_eq!(rows.len(), 8);
        assert_eq!(
            rows.iter().map(|r| r.indicator_id.as_str()).collect::<Vec<_>>(),
            DEFAULTS.to_vec(),
            "默认收藏按预置顺序"
        );
        assert!(rows.iter().all(|r| r.is_default));
        assert_eq!(db.setting(FAVORITES_INITIALIZED_KEY).unwrap().as_deref(), Some("1"));

        // 已有标记：不再写入
        assert_eq!(db.ensure_default_indicator_favorites(&DEFAULTS).unwrap(), 0);
        assert_eq!(db.indicator_favorite_count().unwrap(), 8);
    }

    #[test]
    fn deleting_all_defaults_is_not_reseeded_on_restart() {
        let db = memory();
        db.ensure_default_indicator_favorites(&DEFAULTS).unwrap();
        for id in DEFAULTS {
            assert!(db.remove_indicator_favorite(id).unwrap());
        }
        assert_eq!(db.indicator_favorite_count().unwrap(), 0);

        // 模拟重启：同一库再次调用初始化
        assert_eq!(db.ensure_default_indicator_favorites(&DEFAULTS).unwrap(), 0);
        assert_eq!(db.indicator_favorite_count().unwrap(), 0, "用户删光后不得自动补回");
    }

    #[test]
    fn add_and_remove_are_idempotent_under_rapid_clicks() {
        let db = memory();
        db.ensure_default_indicator_favorites(&DEFAULTS).unwrap();
        for _ in 0..5 {
            db.add_indicator_favorite("M03").unwrap();
        }
        assert_eq!(db.indicator_favorite_count().unwrap(), 9);
        assert_eq!(
            db.indicator_favorites()
                .unwrap()
                .iter()
                .filter(|r| r.indicator_id == "M03")
                .count(),
            1,
            "同一 id 最多一行"
        );

        for _ in 0..3 {
            db.remove_indicator_favorite("M03").unwrap();
        }
        assert_eq!(db.indicator_favorite_count().unwrap(), 8);
    }

    #[test]
    fn user_favorites_are_listed_before_defaults_and_newest_first() {
        let db = memory();
        db.ensure_default_indicator_favorites(&DEFAULTS).unwrap();
        db.add_indicator_favorite("M03").unwrap();
        db.add_indicator_favorite("M04").unwrap();
        let ids: Vec<String> = db
            .indicator_favorites()
            .unwrap()
            .into_iter()
            .map(|r| r.indicator_id)
            .collect();
        assert_eq!(&ids[..2], &["M04", "M03"], "用户后加的排在最前");
        assert_eq!(&ids[2..], &DEFAULTS[..]);
    }

    #[test]
    fn user_favorite_survives_initialize_after_existing_rows() {
        let db = memory();
        // 升级路径：表里已有用户收藏但没有初始化标记 → 置标记但不重复插默认
        db.add_indicator_favorite("M03").unwrap();
        assert_eq!(db.ensure_default_indicator_favorites(&DEFAULTS).unwrap(), 0);
        assert_eq!(db.indicator_favorite_count().unwrap(), 1);
        assert_eq!(db.setting(FAVORITES_INITIALIZED_KEY).unwrap().as_deref(), Some("1"));
    }
}
