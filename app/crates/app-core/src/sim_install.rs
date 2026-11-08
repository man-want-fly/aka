//! S-07.03-01：首装 5 步生成器（Rust 内置、0 网络、`.installing` 断点恢复）。
//!
//! 落点：`<data>/sim/seed-<seed>/dataset.db` + `manifest.json` + `install-report.json`；
//! 哨兵固定为 `<data>/sim/.installing`（JSON：step / startedAt / seed / steps）。
//!
//! - 步骤②写 `securities`(120) + `index_members`(8×32=256)，不写 `sector_members`。
//! - 步骤③/④按批提交（10 只标的 = 5,200 行/批），重入时先清空本步表再写，行数不会翻倍。
//! - 步骤⑤从库内读回行数/区间/摘要，与 `sim_seed` 的冻结口径逐项核对后才写 manifest。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use data_provider::sha256::sha256_hex;
use data_provider::sim_dataset::{canonical_csv, SIM_CSV_HEADER};
use data_provider::sim_seed::{
    self, BARS_PER_SECURITY, ESTIMATED_BYTES, INDEX_COUNT, INDEX_MEMBER_TOTAL, INSTALL_SCHEMA_VERSION,
    INSTALL_STEPS, SECURITY_COUNT, SHA_SCOPE, STOCK_COUNT, TOTAL_BARS,
};
use data_provider::types::{BarRow, Security};
use data_provider::DatasetManifest;
use data_store::dataset_db::{self, BarRecord, FactorRecord, MemberRow, SecurityRow};

const SENTINEL: &str = ".installing";
const REPORT: &str = "install-report.json";
const MANIFEST: &str = "manifest.json";
const DATASET_DB: &str = "dataset.db";
const BATCH_SECURITIES: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SimStepState {
    pub index: u8,
    pub key: String,
    pub name: String,
    /// pending | running | done | failed
    pub status: String,
    pub items: u64,
    pub total: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SimErrorInfo {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallingSentinel {
    seed: u64,
    /// running | failed
    status: String,
    step: u8,
    started_at: i64,
    updated_at: i64,
    steps: Vec<SimStepState>,
    error: Option<SimErrorInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimInstallReport {
    pub seed: u64,
    pub dataset_id: String,
    pub dataset_dir: String,
    pub data_version: String,
    pub generated_at: i64,
    pub row_count: u64,
    pub coverage_start: String,
    pub coverage_end: String,
    pub sha256: String,
    pub sha_scope: String,
    pub schema_version: String,
    pub securities: u64,
    pub stocks: u64,
    pub indices: u64,
    pub index_members: u64,
    /// dataset.db + manifest.json 的字节数（已安装摘要展示用）。
    pub bytes: u64,
    pub total_ms: u64,
    pub wall_ms: u64,
    /// 超过 60s 时置 true 并记 `E_SLOW_INSTALL`，但不判失败。
    pub slow: bool,
    pub steps: Vec<SimStepState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimInstallStatus {
    /// not_installed | installing | failed | installed
    pub state: String,
    pub resume_from: Option<u8>,
    pub steps: Vec<SimStepState>,
    pub installed: Option<SimInstallReport>,
    pub error: Option<SimErrorInfo>,
    pub dir: String,
}

pub fn sim_root(data_dir: &Path) -> PathBuf {
    data_dir.join("sim")
}

pub fn dataset_dir(data_dir: &Path, seed: u64) -> PathBuf {
    sim_root(data_dir).join(format!("seed-{seed}"))
}

fn sentinel_path(data_dir: &Path) -> PathBuf {
    sim_root(data_dir).join(SENTINEL)
}

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn disk_free_bytes(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    let c_path = CString::new(path.to_string_lossy().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };
    if rc == 0 {
        Some(stat.f_bavail as u64 * stat.f_frsize as u64)
    } else {
        None
    }
}

fn initial_steps() -> Vec<SimStepState> {
    let totals = [
        1,
        SECURITY_COUNT as u64,
        (STOCK_COUNT * BARS_PER_SECURITY) as u64,
        (INDEX_COUNT * BARS_PER_SECURITY) as u64,
        1,
    ];
    INSTALL_STEPS
        .iter()
        .map(|step| SimStepState {
            index: step.index,
            key: step.key.to_string(),
            name: step.name.to_string(),
            status: "pending".to_string(),
            items: 0,
            total: totals[(step.index - 1) as usize],
            duration_ms: 0,
        })
        .collect()
}

fn read_sentinel(data_dir: &Path) -> Option<InstallingSentinel> {
    let text = fs::read_to_string(sentinel_path(data_dir)).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_sentinel(
    data_dir: &Path,
    seed: u64,
    started_at: i64,
    step: u8,
    status: &str,
    steps: &[SimStepState],
    error: Option<SimErrorInfo>,
) -> Result<(), SimErrorInfo> {
    let sentinel = InstallingSentinel {
        seed,
        status: status.to_string(),
        step,
        started_at,
        updated_at: now_epoch(),
        steps: steps.to_vec(),
        error,
    };
    let json = serde_json::to_string_pretty(&sentinel)
        .map_err(|err| io_error("E_SENTINEL_WRITE", err.to_string()))?;
    fs::create_dir_all(sim_root(data_dir))
        .map_err(|err| io_error("E_DIR_NOT_WRITABLE", err.to_string()))?;
    fs::write(sentinel_path(data_dir), format!("{json}\n"))
        .map_err(|err| io_error("E_SENTINEL_WRITE", err.to_string()))
}

fn io_error(code: &str, message: impl Into<String>) -> SimErrorInfo {
    SimErrorInfo { code: code.to_string(), message: message.into() }
}

fn read_report(data_dir: &Path, seed: u64) -> Option<SimInstallReport> {
    let text = fs::read_to_string(dataset_dir(data_dir, seed).join(REPORT)).ok()?;
    serde_json::from_str(&text).ok()
}

/// P10 状态：优先看哨兵（进行中/失败），其次看上次成功报告与 manifest。
pub fn status(data_dir: &Path, seed: u64) -> SimInstallStatus {
    let dir = dataset_dir(data_dir, seed);
    if let Some(sentinel) = read_sentinel(data_dir) {
        if sentinel.seed == seed {
            let resume_from = sentinel
                .steps
                .iter()
                .find(|step| step.status != "done")
                .map(|step| step.index);
            return SimInstallStatus {
                state: if sentinel.status == "failed" { "failed" } else { "installing" }
                    .to_string(),
                resume_from,
                steps: sentinel.steps,
                installed: None,
                error: sentinel.error,
                dir: dir.display().to_string(),
            };
        }
    }
    if let Some(report) = read_report(data_dir, seed) {
        return SimInstallStatus {
            state: "installed".to_string(),
            resume_from: None,
            steps: report.steps.clone(),
            installed: Some(report),
            error: None,
            dir: dir.display().to_string(),
        };
    }
    SimInstallStatus {
        state: "not_installed".to_string(),
        resume_from: None,
        steps: initial_steps(),
        installed: None,
        error: None,
        dir: dir.display().to_string(),
    }
}

/// 首次安装 / 断点续装。`rebuild` 由 [`rebuild`] 在删除旧目录后调用。
pub fn install(data_dir: &Path, seed: u64) -> Result<SimInstallReport, SimErrorInfo> {
    install_inner(data_dir, seed, None)
}

fn install_inner(
    data_dir: &Path,
    seed: u64,
    version_override: Option<String>,
) -> Result<SimInstallReport, SimErrorInfo> {
    let dir = dataset_dir(data_dir, seed);
    fs::create_dir_all(&dir).map_err(|err| {
        io_error(
            "E_DIR_NOT_WRITABLE",
            format!("无法创建数据目录 {}：{err}", dir.display()),
        )
    })?;

    // 步骤①前置：磁盘空间 / 目录可写。不足时直接阻断，不写 `.installing`。
    let required = ESTIMATED_BYTES * 3 / 2;
    if let Some(free) = disk_free_bytes(&dir) {
        if free < required {
            return Err(io_error(
                "E_DISK_INSUFFICIENT",
                format!(
                    "磁盘可用 {} MB，低于所需的 {} MB（120 只 × 520 根，预估 180MB×1.5）",
                    free / 1024 / 1024,
                    required / 1024 / 1024
                ),
            ));
        }
    }
    let probe = dir.join(".write-probe");
    fs::write(&probe, b"ok").map_err(|err| {
        io_error(
            "E_DIR_NOT_WRITABLE",
            format!("数据目录不可写 {}：{err}", dir.display()),
        )
    })?;
    let _ = fs::remove_file(&probe);

    let wall = Instant::now();
    let started_at = read_sentinel(data_dir)
        .filter(|sentinel| sentinel.seed == seed)
        .map(|sentinel| sentinel.started_at)
        .unwrap_or_else(now_epoch);
    let mut steps = initial_steps();

    // 断点恢复：只有哨兵里已 done 且库内事实仍成立的分片才跳过。
    let previous = read_sentinel(data_dir).filter(|sentinel| sentinel.seed == seed);
    let db_path = dir.join(DATASET_DB);
    let mut conn =
        dataset_db::open(&db_path).map_err(|err| io_error("E_DB_OPEN", err.to_string()))?;
    let before = dataset_db::summary(&conn)
        .map_err(|err| io_error("E_DB_OPEN", err.to_string()))?;
    let mut completed: Vec<u8> = previous
        .as_ref()
        .map(|sentinel| {
            sentinel
                .steps
                .iter()
                .filter(|step| step.status == "done")
                .map(|step| step.index)
                .collect()
        })
        .unwrap_or_default();
    if !(completed.contains(&2)
        && before.securities == SECURITY_COUNT as i64
        && before.index_members == INDEX_MEMBER_TOTAL as i64)
    {
        completed.retain(|step| *step != 2);
    }
    if !(completed.contains(&3) && before.bars >= (STOCK_COUNT * BARS_PER_SECURITY) as i64) {
        completed.retain(|step| *step != 3);
    }
    if !(completed.contains(&4) && before.bars == TOTAL_BARS as i64) {
        completed.retain(|step| *step != 4);
    }
    for step in &mut steps {
        if completed.contains(&step.index) {
            step.status = "done".to_string();
        }
    }

    write_sentinel(data_dir, seed, started_at, 1, "running", &steps, None)?;

    let calendar = sim_seed::install_calendar();
    let (coverage_start, coverage_end) = sim_seed::coverage();
    let securities = sim_seed::build_install_securities();
    let stocks = sim_seed::build_stock_universe();
    let indices = sim_seed::build_index_universe();

    let result = run_steps(
        &mut conn,
        data_dir,
        seed,
        started_at,
        &mut steps,
        &completed,
        &securities,
        &stocks,
        &indices,
        &calendar,
        coverage_start,
        coverage_end,
        version_override,
    );

    let report = match result {
        Ok(report) => {
            let _ = fs::remove_file(sentinel_path(data_dir));
            let _ = wall;
            Ok(report)
        }
        Err(error) => {
            let failed_step = steps
                .iter()
                .find(|step| step.status == "running")
                .map(|step| step.index)
                .unwrap_or(1);
            for step in &mut steps {
                if step.status == "running" {
                    step.status = "failed".to_string();
                }
            }
            let _ = write_sentinel(
                data_dir,
                seed,
                started_at,
                failed_step,
                "failed",
                &steps,
                Some(error.clone()),
            );
            Err(error)
        }
    };
    let _ = wall;
    report
}

fn begin_step(steps: &mut [SimStepState], index: u8, total: u64) {
    let step = &mut steps[(index - 1) as usize];
    step.status = "running".to_string();
    step.total = total;
    step.items = 0;
}

fn finish_step(steps: &mut [SimStepState], index: u8, items: u64, duration_ms: u64) -> u64 {
    let step = &mut steps[(index - 1) as usize];
    step.items = items;
    step.duration_ms = duration_ms;
    step.status = "done".to_string();
    duration_ms
}

#[allow(clippy::too_many_arguments)]
fn run_steps(
    conn: &mut rusqlite::Connection,
    data_dir: &Path,
    seed: u64,
    started_at: i64,
    steps: &mut [SimStepState],
    completed: &[u8],
    securities: &[Security],
    stocks: &[Security],
    indices: &[Security],
    calendar: &[data_provider::Date],
    coverage_start: data_provider::Date,
    coverage_end: data_provider::Date,
    version_override: Option<String>,
) -> Result<SimInstallReport, SimErrorInfo> {
    let mut total_ms: u64 = 0;

    // ① 校验环境：目录可写与磁盘检查已在前面完成，这里只记录条目数。
    {
        let timer = Instant::now();
        begin_step(steps, 1, 1);
        write_sentinel(data_dir, seed, started_at, 1, "running", steps, None)?;
        let _free = disk_free_bytes(data_dir).unwrap_or(0);
        total_ms += finish_step(steps, 1, 1, timer.elapsed().as_millis() as u64);
        write_sentinel(data_dir, seed, started_at, 1, "running", steps, None)?;
    }

    // ② 证券主数据 + index_members（256）。
    {
        let timer = Instant::now();
        begin_step(steps, 2, SECURITY_COUNT as u64);
        write_sentinel(data_dir, seed, started_at, 2, "running", steps, None)?;

        if !completed.contains(&2) {
            dataset_db::clear_securities(conn)
                .map_err(|err| io_error("E_DB_WRITE", err.to_string()))?;
            let rows: Vec<SecurityRow> = securities.iter().map(security_row).collect();
            dataset_db::write_securities(conn, &rows)
                .map_err(|err| io_error("E_DB_WRITE", err.to_string()))?;
            steps[1].items = SECURITY_COUNT as u64;
            let members: Vec<MemberRow> = sim_seed::build_index_members(stocks, coverage_end)
                .into_iter()
                .map(|row| MemberRow {
                    index_code: row.index_code,
                    security_code: row.security_code,
                    as_of: row.as_of,
                    ordinal: row.ordinal,
                })
                .collect();
            dataset_db::write_index_members(conn, &members)
                .map_err(|err| io_error("E_DB_WRITE", err.to_string()))?;
        }
        dataset_db::set_meta(conn, "schema_version", INSTALL_SCHEMA_VERSION)
            .map_err(|err| io_error("E_DB_WRITE", err.to_string()))?;
        dataset_db::set_meta(conn, "sha_scope", SHA_SCOPE)
            .map_err(|err| io_error("E_DB_WRITE", err.to_string()))?;
        total_ms += finish_step(
            steps,
            2,
            SECURITY_COUNT as u64,
            timer.elapsed().as_millis() as u64,
        );
        write_sentinel(data_dir, seed, started_at, 2, "running", steps, None)?;
    }

    // ③ 日线与复权因子：112 只股票，按 10 只 / 批提交。
    {
        let timer = Instant::now();
        let stock_bars = (STOCK_COUNT * BARS_PER_SECURITY) as u64;
        begin_step(steps, 3, stock_bars);
        write_sentinel(data_dir, seed, started_at, 3, "running", steps, None)?;

        if !completed.contains(&3) {
            dataset_db::clear_bars(conn)
                .map_err(|err| io_error("E_DB_WRITE", err.to_string()))?;
            for chunk in stocks.chunks(BATCH_SECURITIES) {
                let (bars, factors) = generate_chunk(chunk, calendar);
                dataset_db::write_bars(conn, &bars)
                    .map_err(|err| io_error("E_DB_WRITE", err.to_string()))?;
                dataset_db::write_factors(conn, &factors)
                    .map_err(|err| io_error("E_DB_WRITE", err.to_string()))?;
                steps[2].items += (chunk.len() * BARS_PER_SECURITY) as u64;
                steps[2].duration_ms = timer.elapsed().as_millis() as u64;
                write_sentinel(data_dir, seed, started_at, 3, "running", steps, None)?;
            }
        }
        total_ms += finish_step(steps, 3, stock_bars, timer.elapsed().as_millis() as u64);
        write_sentinel(data_dir, seed, started_at, 3, "running", steps, None)?;
    }

    // ④ 指数与行业：指数日线 + index_meta；不写 sector_members（V1 降级）。
    {
        let timer = Instant::now();
        let index_bars = (INDEX_COUNT * BARS_PER_SECURITY) as u64;
        begin_step(steps, 4, index_bars);
        write_sentinel(data_dir, seed, started_at, 4, "running", steps, None)?;

        if !completed.contains(&4) {
            let (bars, factors) = generate_chunk(indices, calendar);
            dataset_db::write_bars(conn, &bars)
                .map_err(|err| io_error("E_DB_WRITE", err.to_string()))?;
            dataset_db::write_factors(conn, &factors)
                .map_err(|err| io_error("E_DB_WRITE", err.to_string()))?;
        }
        total_ms += finish_step(steps, 4, index_bars, timer.elapsed().as_millis() as u64);
        write_sentinel(data_dir, seed, started_at, 4, "running", steps, None)?;
    }

    // ⑤ 校验入库：行数、覆盖区间、index_members 完整性、sha256 → manifest。
    {
        let timer = Instant::now();
        begin_step(steps, 5, 1);
        write_sentinel(data_dir, seed, started_at, 5, "running", steps, None)?;

        let summary = dataset_db::summary(conn)
            .map_err(|err| io_error("E_DB_VERIFY", err.to_string()))?;
        let mut issues = summary.index_member_issues();
        issues.extend(summary.row_issues());
        if summary.securities != SECURITY_COUNT as i64 {
            issues.push(format!("securities 应为 {SECURITY_COUNT} 行，实际 {}", summary.securities));
        }
        if summary.coverage_start.as_deref() != Some(coverage_start.iso().as_str()) {
            issues.push(format!(
                "coverage_start 应为 {}，实际 {:?}",
                coverage_start.iso(),
                summary.coverage_start
            ));
        }
        if summary.coverage_end.as_deref() != Some(coverage_end.iso().as_str()) {
            issues.push(format!(
                "coverage_end 应为 {}，实际 {:?}",
                coverage_end.iso(),
                summary.coverage_end
            ));
        }
        if !issues.is_empty() {
            return Err(io_error("E_GATE_C_FAILED", issues.join("；")));
        }

        let sha256 = digest(conn, securities)?;
        let data_version =
            version_override.unwrap_or_else(|| next_data_version(data_dir, seed));
        let manifest = DatasetManifest::build(
            "sim",
            seed,
            &coverage_start.iso(),
            &coverage_end.iso(),
            summary.bars as u64,
            &data_version,
            &sha256,
            now_epoch(),
        );
        let json = serde_json::to_string_pretty(&manifest)
            .map_err(|err| io_error("E_MANIFEST_WRITE", err.to_string()))?;
        fs::write(
            dataset_dir(data_dir, seed).join(MANIFEST),
            format!("{json}\n"),
        )
        .map_err(|err| io_error("E_MANIFEST_WRITE", err.to_string()))?;

        total_ms += finish_step(steps, 5, 1, timer.elapsed().as_millis() as u64);

        let report = SimInstallReport {
            seed,
            dataset_id: manifest.dataset_id,
            dataset_dir: dataset_dir(data_dir, seed).display().to_string(),
            data_version: manifest.data_version,
            generated_at: manifest.generated_at,
            row_count: manifest.row_count,
            coverage_start: manifest.coverage_start,
            coverage_end: manifest.coverage_end,
            sha256: manifest.sha256,
            sha_scope: SHA_SCOPE.to_string(),
            schema_version: INSTALL_SCHEMA_VERSION.to_string(),
            securities: summary.securities as u64,
            stocks: summary.stocks as u64,
            indices: summary.indices as u64,
            index_members: summary.index_members as u64,
            bytes: [DATASET_DB, MANIFEST]
                .iter()
                .filter_map(|name| fs::metadata(dataset_dir(data_dir, seed).join(name)).ok())
                .map(|meta| meta.len())
                .sum(),
            total_ms,
            wall_ms: total_ms,
            slow: total_ms > 60_000,
            steps: steps.to_vec(),
        };
        let json = serde_json::to_string_pretty(&report)
            .map_err(|err| io_error("E_REPORT_WRITE", err.to_string()))?;
        fs::write(
            dataset_dir(data_dir, seed).join(REPORT),
            format!("{json}\n"),
        )
        .map_err(|err| io_error("E_REPORT_WRITE", err.to_string()))?;
        Ok(report)
    }
}

fn security_row(security: &Security) -> SecurityRow {
    SecurityRow {
        code: security.code.clone(),
        name: security.name.clone(),
        market: security.market.as_str().to_string(),
        board: security.board.label_zh().to_string(),
        is_index: security.is_index,
        base_price: security.base_price,
    }
}

fn generate_chunk(
    chunk: &[Security],
    calendar: &[data_provider::Date],
) -> (Vec<BarRecord>, Vec<FactorRecord>) {
    let batch_id = format!("install-{}", now_epoch());
    let ingested_at = now_epoch();
    let mut bars = Vec::with_capacity(chunk.len() * BARS_PER_SECURITY);
    let mut factors = Vec::with_capacity(chunk.len() * BARS_PER_SECURITY);
    for security in chunk {
        for row in sim_seed::generate_security_bars(security, calendar) {
            factors.push(FactorRecord {
                code: security.code.clone(),
                date: row.date.iso(),
                factor: row.adj_factor,
            });
            bars.push(BarRecord {
                code: security.code.clone(),
                date: row.date.iso(),
                open: row.open,
                high: row.high,
                low: row.low,
                close: row.close,
                volume: row.volume,
                amount: row.amount,
                adj_factor: row.adj_factor,
                quality: row
                    .quality
                    .iter()
                    .map(|flag| flag.as_str())
                    .collect::<Vec<_>>()
                    .join(","),
                batch_id: Some(batch_id.clone()),
                ingested_at: Some(ingested_at),
            });
        }
    }
    (bars, factors)
}

/// 从库内读回日线重算摘要；不信任写入过程携带的字符串。
fn digest(conn: &rusqlite::Connection, securities: &[Security]) -> Result<String, SimErrorInfo> {
    let rows = dataset_db::read_bars(conn)
        .map_err(|err| io_error("E_DB_VERIFY", err.to_string()))?;
    let mut by_code: BTreeMap<&str, Vec<BarRow>> = BTreeMap::new();
    for row in &rows {
        by_code.entry(row.code.as_str()).or_default().push(BarRow {
            date: data_provider::Date::parse(&row.date).ok_or_else(|| {
                io_error("E_DB_VERIFY", format!("非法日期 {}（{}）", row.date, row.code))
            })?,
            open: row.open,
            high: row.high,
            low: row.low,
            close: row.close,
            volume: row.volume,
            amount: row.amount,
            adj_factor: row.adj_factor,
            quality: Vec::new(),
            batch_id: None,
            ingested_at: None,
        });
    }
    let mut text = String::from(SIM_CSV_HEADER);
    text.push('\n');
    for security in securities {
        let Some(series) = by_code.get(security.code.as_str()) else {
            return Err(io_error(
                "E_DB_VERIFY",
                format!("{} 在 daily_bars 中不存在", security.code),
            ));
        };
        let csv = canonical_csv(series);
        for line in csv.lines().skip(1) {
            text.push_str(line);
            text.push('\n');
        }
    }
    Ok(sha256_hex(text.as_bytes()))
}

fn next_data_version(data_dir: &Path, seed: u64) -> String {
    let path = dataset_dir(data_dir, seed).join(MANIFEST);
    let Ok(text) = fs::read_to_string(path) else {
        return "v1".to_string();
    };
    let Ok(manifest) = DatasetManifest::from_json(&text) else {
        return "v1".to_string();
    };
    format!("v{}", manifest.generation() + 1)
}

/// 重建：删掉整个 seed 目录与旧哨兵，再从步骤①开始。会删除现有 sim 数据。
pub fn rebuild(data_dir: &Path, seed: u64) -> Result<SimInstallReport, SimErrorInfo> {
    let dir = dataset_dir(data_dir, seed);
    // 先记住旧代数：目录会被整个删掉，manifest 必须从内存带过去。
    let next_version = fs::read_to_string(dir.join(MANIFEST))
        .ok()
        .and_then(|text| DatasetManifest::from_json(&text).ok())
        .map(|manifest| format!("v{}", manifest.generation() + 1));
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|err| {
            io_error("E_REBUILD_DELETE", format!("无法删除 {}：{err}", dir.display()))
        })?;
    }
    let sentinel = sentinel_path(data_dir);
    if sentinel.exists() {
        let _ = fs::remove_file(sentinel);
    }
    install_inner(data_dir, seed, next_version)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_data_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "aka-sim-install-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn full_install_writes_gate_c_facts() {
        let data_dir = temp_data_dir("full");
        let report = install(&data_dir, 42).expect("install");

        assert_eq!(report.securities, 120);
        assert_eq!(report.stocks, 112);
        assert_eq!(report.indices, 8);
        assert_eq!(report.index_members, 256);
        assert_eq!(report.row_count, 62_400);
        assert_eq!(report.coverage_start, "2023-01-02");
        assert_eq!(report.coverage_end, "2024-12-27");
        assert_eq!(report.steps.len(), 5);
        assert!(report.steps.iter().all(|step| step.status == "done"));
        assert!(!sentinel_path(&data_dir).exists());

        let dir = dataset_dir(&data_dir, 42);
        assert!(dir.join(MANIFEST).exists());
        assert!(dir.join(REPORT).exists());

        let conn = dataset_db::open(&dir.join(DATASET_DB)).unwrap();
        let summary = dataset_db::summary(&conn).unwrap();
        assert!(summary.index_member_issues().is_empty());
        assert!(summary.row_issues().is_empty());
        assert_eq!(summary.per_index.len(), 8);

        // 256 条按公开公式复算，与库内逐条相等。
        let stocks = sim_seed::build_stock_universe();
        let (_, last) = sim_seed::coverage();
        let mut expected = sim_seed::build_index_members(&stocks, last);
        let mut actual = dataset_db::read_index_members(&conn).unwrap();
        expected.sort_by(|a, b| (&a.index_code, a.ordinal).cmp(&(&b.index_code, b.ordinal)));
        actual.sort_by(|a, b| (&a.index_code, a.ordinal).cmp(&(&b.index_code, b.ordinal)));
        assert_eq!(actual.len(), expected.len());
        for (left, right) in actual.iter().zip(expected.iter()) {
            assert_eq!(
                (&left.index_code, &left.security_code, left.ordinal, &left.as_of),
                (
                    &right.index_code,
                    &right.security_code,
                    right.ordinal,
                    &right.as_of
                )
            );
        }

        // 摘要可从库内复算，重复安装（重建）行数不翻倍。
        let again = rebuild(&data_dir, 42).expect("rebuild");
        assert_eq!(again.row_count, 62_400);
        assert_eq!(again.data_version, "v2");
        let conn = dataset_db::open(&dir.join(DATASET_DB)).unwrap();
        let summary = dataset_db::summary(&conn).unwrap();
        assert_eq!(summary.bars, 62_400);

        let _ = fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn interrupted_step3_resumes_without_doubling_rows() {
        let data_dir = temp_data_dir("resume");
        // 先跑完一遍，再伪造「步骤③中断」的哨兵，验证续装不会把行数翻倍。
        let _ = install(&data_dir, 7).expect("install");
        let dir = dataset_dir(&data_dir, 7);
        let mut steps = initial_steps();
        steps[0].status = "done".into();
        steps[1].status = "done".into();
        steps[2].status = "failed".into();
        write_sentinel(&data_dir, 7, now_epoch(), 3, "failed", &steps, None).unwrap();

        let report = install(&data_dir, 7).expect("resume");
        assert_eq!(report.row_count, 62_400);
        let conn = dataset_db::open(&dir.join(DATASET_DB)).unwrap();
        let summary = dataset_db::summary(&conn).unwrap();
        assert_eq!(summary.bars, 62_400);

        let _ = fs::remove_dir_all(&data_dir);
    }
}
