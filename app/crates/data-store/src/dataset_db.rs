//! S-07.03-01：首装数据集 SQLite（`dataset.db`）。
//!
//! 与 `state.db` 分离：state.db 存用户状态，dataset.db 是**可整目录重建**的数据集。
//! 本模块只认行结构，不认识 provider / Tauri；依赖边界与 `state_db` 一致。
//!
//! 表：
//! - `securities`：120 行（112 股票 + 8 指数）
//! - `index_members`：256 行（8 × 32），主键 `(index_code, security_code)`
//! - `daily_bars`：120 × 520 = 62,400 行，主键 `(code, date)`
//! - `adj_factors`：62,400 行，主键 `(code, date)`
//! - `index_meta`：8 行，记录每个指数的成分数
//! - `meta`：生成器契约版本

use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub struct SecurityRow {
    pub code: String,
    pub name: String,
    pub market: String,
    pub board: String,
    pub is_index: bool,
    pub base_price: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MemberRow {
    pub index_code: String,
    pub security_code: String,
    pub as_of: String,
    pub ordinal: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BarRecord {
    pub code: String,
    pub date: String,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
    pub amount: f64,
    pub adj_factor: f64,
    pub quality: String,
    pub batch_id: Option<String>,
    pub ingested_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FactorRecord {
    pub code: String,
    pub date: String,
    pub factor: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DatasetSummary {
    pub securities: i64,
    pub stocks: i64,
    pub indices: i64,
    pub index_members: i64,
    pub bars: i64,
    pub adj_factors: i64,
    pub per_index: Vec<(String, i64)>,
    pub per_security_bars: Vec<(String, i64)>,
    pub coverage_start: Option<String>,
    pub coverage_end: Option<String>,
    pub schema_version: Option<String>,
}

impl DatasetSummary {
    /// 256 条完整性校验：8 个指数各 32 条。返回问题列表，空 = 通过。
    pub fn index_member_issues(&self) -> Vec<String> {
        let mut issues = Vec::new();
        if self.index_members != 256 {
            issues.push(format!("index_members 应为 256 条，实际 {}", self.index_members));
        }
        if self.indices != 8 {
            issues.push(format!("指数应为 8 只，实际 {}", self.indices));
        }
        if self.stocks != 112 {
            issues.push(format!("股票应为 112 只，实际 {}", self.stocks));
        }
        if self.per_index.len() != 8 {
            issues.push(format!("index_meta 应有 8 行，实际 {}", self.per_index.len()));
        }
        for (code, count) in &self.per_index {
            if *count != 32 {
                issues.push(format!("{code} 成分应为 32 条，实际 {count}"));
            }
        }
        issues
    }

    pub fn row_issues(&self) -> Vec<String> {
        let mut issues = Vec::new();
        if self.bars != 62_400 {
            issues.push(format!("daily_bars 应为 62,400 行，实际 {}", self.bars));
        }
        if self.adj_factors != 62_400 {
            issues.push(format!("adj_factors 应为 62,400 行，实际 {}", self.adj_factors));
        }
        for (code, count) in &self.per_security_bars {
            if *count != 520 {
                issues.push(format!("{code} 日线应为 520 根，实际 {count}"));
            }
        }
        issues
    }
}

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA synchronous = NORMAL;",
    )?;
    init_schema(&conn)?;
    Ok(conn)
}

pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (
             key   TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS securities (
             code       TEXT PRIMARY KEY,
             name       TEXT NOT NULL,
             market     TEXT NOT NULL,
             board      TEXT NOT NULL,
             is_index   INTEGER NOT NULL CHECK (is_index IN (0, 1)),
             base_price REAL NOT NULL
         );
         CREATE TABLE IF NOT EXISTS index_members (
             index_code    TEXT NOT NULL,
             security_code TEXT NOT NULL,
             as_of         TEXT NOT NULL,
             ordinal       INTEGER NOT NULL,
             PRIMARY KEY (index_code, security_code),
             FOREIGN KEY (index_code) REFERENCES securities(code),
             FOREIGN KEY (security_code) REFERENCES securities(code)
         );
         CREATE INDEX IF NOT EXISTS idx_index_members_index
             ON index_members(index_code, ordinal);
         CREATE TABLE IF NOT EXISTS daily_bars (
             code        TEXT NOT NULL,
             date        TEXT NOT NULL,
             open        REAL NOT NULL,
             high        REAL NOT NULL,
             low         REAL NOT NULL,
             close       REAL NOT NULL,
             volume      REAL NOT NULL,
             amount      REAL NOT NULL,
             adj_factor  REAL NOT NULL,
             quality     TEXT NOT NULL DEFAULT '',
             batch_id    TEXT,
             ingested_at INTEGER,
             PRIMARY KEY (code, date),
             FOREIGN KEY (code) REFERENCES securities(code)
         );
         CREATE TABLE IF NOT EXISTS adj_factors (
             code   TEXT NOT NULL,
             date   TEXT NOT NULL,
             factor REAL NOT NULL,
             PRIMARY KEY (code, date),
             FOREIGN KEY (code) REFERENCES securities(code)
         );
         CREATE TABLE IF NOT EXISTS index_meta (
             index_code TEXT PRIMARY KEY,
             members    INTEGER NOT NULL,
             as_of      TEXT NOT NULL,
             FOREIGN KEY (index_code) REFERENCES securities(code)
         );",
    )
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO meta(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn meta(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", params![key], |row| {
        row.get(0)
    })
    .optional()
}

pub fn clear_securities(conn: &mut Connection) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM adj_factors", [])?;
    tx.execute("DELETE FROM daily_bars", [])?;
    tx.execute("DELETE FROM index_meta", [])?;
    tx.execute("DELETE FROM index_members", [])?;
    tx.execute("DELETE FROM securities", [])?;
    tx.commit()
}

pub fn write_securities(conn: &mut Connection, rows: &[SecurityRow]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO securities(code, name, market, board, is_index, base_price)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for row in rows {
            stmt.execute(params![
                row.code,
                row.name,
                row.market,
                row.board,
                row.is_index as i64,
                row.base_price,
            ])?;
        }
    }
    tx.commit()
}

pub fn write_index_members(conn: &mut Connection, rows: &[MemberRow]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO index_members(index_code, security_code, as_of, ordinal)
             VALUES (?1, ?2, ?3, ?4)",
        )?;
        for row in rows {
            stmt.execute(params![
                row.index_code,
                row.security_code,
                row.as_of,
                row.ordinal as i64,
            ])?;
        }
        let mut meta = tx.prepare(
            "INSERT INTO index_meta(index_code, members, as_of) VALUES (?1, ?2, ?3)
             ON CONFLICT(index_code) DO UPDATE SET members = excluded.members, as_of = excluded.as_of",
        )?;
        for index_code in rows.iter().map(|row| row.index_code.as_str()).collect::<std::collections::BTreeSet<_>>() {
            let count = rows.iter().filter(|row| row.index_code == index_code).count() as i64;
            let as_of = rows
                .iter()
                .find(|row| row.index_code == index_code)
                .map(|row| row.as_of.as_str())
                .unwrap_or_default();
            meta.execute(params![index_code, count, as_of])?;
        }
    }
    tx.commit()
}

/// 步骤③/④按批提交：一批 ≤ 5,200 行（单只标的 520 根 × 10 只）。
pub fn write_bars(conn: &mut Connection, rows: &[BarRecord]) -> rusqlite::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO daily_bars
                 (code, date, open, high, low, close, volume, amount, adj_factor, quality, batch_id, ingested_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        )?;
        for row in rows {
            stmt.execute(params![
                row.code,
                row.date,
                row.open,
                row.high,
                row.low,
                row.close,
                row.volume,
                row.amount,
                row.adj_factor,
                row.quality,
                row.batch_id,
                row.ingested_at,
            ])?;
        }
    }
    tx.commit()
}

pub fn write_factors(conn: &mut Connection, rows: &[FactorRecord]) -> rusqlite::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO adj_factors(code, date, factor) VALUES (?1, ?2, ?3)",
        )?;
        for row in rows {
            stmt.execute(params![row.code, row.date, row.factor])?;
        }
    }
    tx.commit()
}

pub fn clear_bars(conn: &mut Connection) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM daily_bars", [])?;
    tx.execute("DELETE FROM adj_factors", [])?;
    tx.commit()
}

pub fn summary(conn: &Connection) -> rusqlite::Result<DatasetSummary> {
    let scalar = |sql: &str| -> rusqlite::Result<i64> {
        conn.query_row(sql, [], |row| row.get::<_, i64>(0))
    };

    let securities = scalar("SELECT COUNT(*) FROM securities")?;
    let stocks = scalar("SELECT COUNT(*) FROM securities WHERE is_index = 0")?;
    let indices = scalar("SELECT COUNT(*) FROM securities WHERE is_index = 1")?;
    let index_members = scalar("SELECT COUNT(*) FROM index_members")?;
    let bars = scalar("SELECT COUNT(*) FROM daily_bars")?;
    let adj_factors = scalar("SELECT COUNT(*) FROM adj_factors")?;

    let mut per_index = Vec::new();
    {
        let mut stmt =
            conn.prepare("SELECT index_code, members FROM index_meta ORDER BY index_code")?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
        for row in rows {
            per_index.push(row?);
        }
    }

    let mut per_security_bars = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT code, COUNT(*) FROM daily_bars GROUP BY code ORDER BY code",
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
        for row in rows {
            per_security_bars.push(row?);
        }
    }

    let coverage_start = conn
        .query_row("SELECT MIN(date) FROM daily_bars", [], |row| row.get::<_, Option<String>>(0))?;
    let coverage_end = conn
        .query_row("SELECT MAX(date) FROM daily_bars", [], |row| row.get::<_, Option<String>>(0))?;
    let schema_version = meta(conn, "schema_version")?;

    Ok(DatasetSummary {
        securities,
        stocks,
        indices,
        index_members,
        bars,
        adj_factors,
        per_index,
        per_security_bars,
        coverage_start,
        coverage_end,
        schema_version,
    })
}

/// 读回全部日线，供步骤⑤重算 sha256（不信任写入过程的返回值）。
pub fn read_bars(conn: &Connection) -> rusqlite::Result<Vec<BarRecord>> {
    let mut stmt = conn.prepare(
        "SELECT code, date, open, high, low, close, volume, amount, adj_factor, quality, batch_id, ingested_at
         FROM daily_bars ORDER BY code, date",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(BarRecord {
            code: row.get(0)?,
            date: row.get(1)?,
            open: row.get(2)?,
            high: row.get(3)?,
            low: row.get(4)?,
            close: row.get(5)?,
            volume: row.get(6)?,
            amount: row.get(7)?,
            adj_factor: row.get(8)?,
            quality: row.get(9)?,
            batch_id: row.get(10)?,
            ingested_at: row.get(11)?,
        })
    })?;
    rows.collect()
}

pub fn read_index_members(conn: &Connection) -> rusqlite::Result<Vec<MemberRow>> {
    let mut stmt = conn.prepare(
        "SELECT index_code, security_code, as_of, ordinal FROM index_members ORDER BY index_code, ordinal",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(MemberRow {
            index_code: row.get(0)?,
            security_code: row.get(1)?,
            as_of: row.get(2)?,
            ordinal: row.get::<_, i64>(3)? as u32,
        })
    })?;
    rows.collect()
}

pub fn read_securities(conn: &Connection) -> rusqlite::Result<Vec<SecurityRow>> {
    let mut stmt = conn.prepare(
        "SELECT code, name, market, board, is_index, base_price FROM securities ORDER BY code",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(SecurityRow {
            code: row.get(0)?,
            name: row.get(1)?,
            market: row.get(2)?,
            board: row.get(3)?,
            is_index: row.get::<_, i64>(4)? != 0,
            base_price: row.get(5)?,
        })
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("aka-dataset-db-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("dataset.db")
    }

    #[test]
    fn schema_round_trip_and_counts() {
        let path = temp_path("roundtrip");
        let mut conn = open(&path).unwrap();
        set_meta(&conn, "schema_version", "sim-install/v1").unwrap();

        let securities = vec![
            SecurityRow {
                code: "000001.SH".into(),
                name: "上证指数".into(),
                market: "SH".into(),
                board: "指数".into(),
                is_index: true,
                base_price: 3200.0,
            },
            SecurityRow {
                code: "600519.SH".into(),
                name: "贵州茅台".into(),
                market: "SH".into(),
                board: "沪主板".into(),
                is_index: false,
                base_price: 1628.0,
            },
        ];
        write_securities(&mut conn, &securities).unwrap();
        write_index_members(
            &mut conn,
            &[MemberRow {
                index_code: "000001.SH".into(),
                security_code: "600519.SH".into(),
                as_of: "2024-12-27".into(),
                ordinal: 1,
            }],
        )
        .unwrap();

        let summary = summary(&conn).unwrap();
        assert_eq!(summary.securities, 2);
        assert_eq!(summary.stocks, 1);
        assert_eq!(summary.indices, 1);
        assert_eq!(summary.index_members, 1);
        assert_eq!(summary.per_index, vec![("000001.SH".to_string(), 1)]);
        assert_eq!(summary.schema_version.as_deref(), Some("sim-install/v1"));

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn foreign_key_rejects_orphan_member() {
        let path = temp_path("fk");
        let mut conn = open(&path).unwrap();
        let result = write_index_members(
            &mut conn,
            &[MemberRow {
                index_code: "000001.SH".into(),
                security_code: "600519.SH".into(),
                as_of: "2024-12-27".into(),
                ordinal: 1,
            }],
        );
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
