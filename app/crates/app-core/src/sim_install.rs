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
use data_store::{Candle, parquet_store::ParquetStore};

const SENTINEL: &str = ".installing";
const REPORT: &str = "install-report.json";
const MANIFEST: &str = "manifest.json";
/// AKA-71：Parquet 分区的完整性清单（与 9 字段 dataset manifest 分离，保持后者冻结）。
const PARQUET_MANIFEST: &str = "parquet-manifest.json";
const PARQUET_DIR: &str = "parquet";
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

/// AKA-71：Parquet 分区完整性清单（`<dataset_dir>/parquet-manifest.json`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParquetManifest {
    pub dataset_id: String,
    pub data_version: String,
    /// 所有分区文件按文件名升序拼接后的 sha256（hex）
    pub parquet_sha256: String,
    pub partition_count: u64,
    pub row_count: u64,
}

struct ParquetPartitionSummary {
    sha256: String,
    partition_count: u64,
    row_count: u64,
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

/// ST-DF-03-01：先在同级 staging 目录完整构建，成功后再原子替换正式目录。
fn staging_dir(data_dir: &Path, seed: u64) -> PathBuf {
    sim_root(data_dir).join(format!(".staging-seed-{seed}"))
}

fn backup_dir(data_dir: &Path, seed: u64) -> PathBuf {
    sim_root(data_dir).join(format!(".backup-seed-{seed}"))
}

/// 失败报告落在 sim 根目录，保留最后一次失败尝试的阶段与错误，正式目录不受影响。
fn failed_report_path(data_dir: &Path) -> PathBuf {
    sim_root(data_dir).join(REPORT)
}

/// 原子发布：旧目录先改名备份，staging 改名正式目录；任一步失败都回滚到旧目录。
fn publish_dataset(data_dir: &Path, seed: u64) -> Result<PathBuf, SimErrorInfo> {
    let staging = staging_dir(data_dir, seed);
    let final_dir = dataset_dir(data_dir, seed);
    let backup = backup_dir(data_dir, seed);
    if backup.exists() {
        let _ = fs::remove_dir_all(&backup);
    }
    if final_dir.exists() {
        fs::rename(&final_dir, &backup).map_err(|err| {
            io_error(
                "E_PUBLISH_FAILED",
                format!("无法暂存旧数据集 {}：{err}", final_dir.display()),
            )
        })?;
    }
    if let Err(err) = fs::rename(&staging, &final_dir) {
        if backup.exists() {
            let _ = fs::rename(&backup, &final_dir);
        }
        return Err(io_error(
            "E_PUBLISH_FAILED",
            format!("无法替换数据集目录 {}：{err}", final_dir.display()),
        ));
    }
    if backup.exists() {
        let _ = fs::remove_dir_all(&backup);
    }
    Ok(final_dir)
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

/// 首次安装 / 断点续装：全程在 staging 构建，成功后原子替换正式目录。
pub fn install(data_dir: &Path, seed: u64) -> Result<SimInstallReport, SimErrorInfo> {
    finish_install(data_dir, seed, install_inner(data_dir, seed, None))
}

/// 预检阶段（建目录/磁盘/探针）失败时也要留下 failed 状态与失败报告，
/// 让「旧版本仍可读」与「报告记 failed」同时成立。
fn finish_install(
    data_dir: &Path,
    seed: u64,
    result: Result<SimInstallReport, SimErrorInfo>,
) -> Result<SimInstallReport, SimErrorInfo> {
    if let Err(error) = &result {
        let already_failed = read_sentinel(data_dir)
            .map(|sentinel| sentinel.seed == seed && sentinel.status == "failed")
            .unwrap_or(false);
        if !already_failed {
            let mut steps = initial_steps();
            steps[0].status = "failed".to_string();
            let _ = write_sentinel(
                data_dir,
                seed,
                now_epoch(),
                1,
                "failed",
                &steps,
                Some(error.clone()),
            );
            write_failed_report(data_dir, seed, now_epoch(), &steps, error);
        }
    }
    result
}

fn install_inner(
    data_dir: &Path,
    seed: u64,
    version_override: Option<String>,
) -> Result<SimInstallReport, SimErrorInfo> {
    let build_dir = staging_dir(data_dir, seed);
    fs::create_dir_all(&build_dir).map_err(|err| {
        io_error(
            "E_DIR_NOT_WRITABLE",
            format!("无法创建数据目录 {}：{err}", build_dir.display()),
        )
    })?;

    // 步骤①前置：磁盘空间 / 目录可写。不足时直接阻断，不写 `.installing`。
    let required = ESTIMATED_BYTES * 3 / 2;
    if let Some(free) = disk_free_bytes(&build_dir) {
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
    let probe = build_dir.join(".write-probe");
    fs::write(&probe, b"ok").map_err(|err| {
        io_error(
            "E_DIR_NOT_WRITABLE",
            format!("数据目录不可写 {}：{err}", build_dir.display()),
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
    let db_path = build_dir.join(DATASET_DB);
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
        &build_dir,
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

    match result {
        Ok(mut report) => {
            // 先完整构建再发布：失败时正式目录与旧 dataset_id 原样保留。
            let final_dir = publish_dataset(data_dir, seed)?;
            report.dataset_dir = final_dir.display().to_string();
            let json = serde_json::to_string_pretty(&report)
                .map_err(|err| io_error("E_REPORT_WRITE", err.to_string()))?;
            fs::write(final_dir.join(REPORT), format!("{json}\n"))
                .map_err(|err| io_error("E_REPORT_WRITE", err.to_string()))?;
            let _ = fs::remove_file(failed_report_path(data_dir));
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
            write_failed_report(data_dir, seed, started_at, &steps, &error);
            let _ = wall;
            Err(error)
        }
    }
}

fn write_failed_report(
    data_dir: &Path,
    seed: u64,
    started_at: i64,
    steps: &[SimStepState],
    error: &SimErrorInfo,
) {
    let payload = serde_json::json!({
        "seed": seed,
        "status": "failed",
        "startedAt": started_at,
        "failedAt": now_epoch(),
        "error": error,
        "steps": steps,
    });
    if let Ok(text) = serde_json::to_string_pretty(&payload) {
        let _ = fs::write(failed_report_path(data_dir), format!("{text}\n"));
    }
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
    build_dir: &Path,
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
        let _free = disk_free_bytes(build_dir).unwrap_or(0);
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
        let data_version = version_override.unwrap_or_else(|| next_data_version(build_dir));
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
        fs::write(build_dir.join(MANIFEST), format!("{json}\n"))
            .map_err(|err| io_error("E_MANIFEST_WRITE", err.to_string()))?;

        // Parquet 分区写入（AKA-75）：同一批 Bars 按 code 分组落盘成列式文件。
        // 写在 manifest 之后、finish_step 之前——parquet 写失败则整次 install 失败，
        // staging 目录不发布，旧数据集不受影响。
        let partition = write_parquet_partition(conn, build_dir)?;
        // AKA-71：分区摘要与 dataset manifest 同源写入，供启动时校验篡改。
        write_parquet_manifest(
            build_dir,
            &manifest.dataset_id,
            &manifest.data_version,
            &partition,
        )?;

        total_ms += finish_step(steps, 5, 1, timer.elapsed().as_millis() as u64);

        let report = SimInstallReport {
            seed,
            dataset_id: manifest.dataset_id,
            dataset_dir: build_dir.display().to_string(),
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
                .filter_map(|name| fs::metadata(build_dir.join(name)).ok())
                .map(|meta| meta.len())
                .sum(),
            total_ms,
            wall_ms: total_ms,
            slow: total_ms > 60_000,
            steps: steps.to_vec(),
        };
        let json = serde_json::to_string_pretty(&report)
            .map_err(|err| io_error("E_REPORT_WRITE", err.to_string()))?;
        fs::write(build_dir.join(REPORT), format!("{json}\n"))
            .map_err(|err| io_error("E_REPORT_WRITE", err.to_string()))?;
        Ok(report)
    }
}

/// AKA-75：把 dataset.db 里的 daily_bars 按 code 分组写成 parquet 分区文件。
/// 目录结构：`<build_dir>/parquet/{code}.parquet`。
/// 调用者保证 conn 已写入完整、build_dir 可写。
fn write_parquet_partition(
    conn: &rusqlite::Connection,
    build_dir: &Path,
) -> Result<ParquetPartitionSummary, SimErrorInfo> {
    let all_bars = dataset_db::read_bars(conn)
        .map_err(|err| io_error("E_PARQUET_READ", err.to_string()))?;

    // 按 code 分组（BTreeMap 保持稳定排序）
    let mut by_code: BTreeMap<String, Vec<Candle>> = BTreeMap::new();
    let mut row_count = 0u64;
    for record in all_bars {
        row_count += 1;
        let code = record.code.clone();
        let candle = bar_record_to_candle(record);
        by_code.entry(code).or_default().push(candle);
    }

    let store = ParquetStore::with_partition_dir(build_dir.join(PARQUET_DIR));
    let mut partition_count = 0u64;
    for (code, candles) in by_code {
        store
            .write_security(&code, &candles)
            .map_err(|err| io_error("E_PARQUET_WRITE", format!("{code}：{err}")))?;
        partition_count += 1;
    }

    // AKA-71：所有分区字节按文件名升序拼接后取 sha256，作为分区摘要口径。
    let bytes = store
        .partition_bytes()
        .map_err(|err| io_error("E_PARQUET_READ", err.to_string()))?;

    Ok(ParquetPartitionSummary {
        sha256: sha256_hex(&bytes),
        partition_count,
        row_count,
    })
}

/// AKA-71：写 `<dataset_dir>/parquet-manifest.json`。
///
/// 不并入 9 字段 dataset manifest —— 后者是冻结口径，扩字段会破坏既有校验契约。
fn write_parquet_manifest(
    build_dir: &Path,
    dataset_id: &str,
    data_version: &str,
    summary: &ParquetPartitionSummary,
) -> Result<(), SimErrorInfo> {
    let manifest = ParquetManifest {
        dataset_id: dataset_id.to_string(),
        data_version: data_version.to_string(),
        parquet_sha256: summary.sha256.clone(),
        partition_count: summary.partition_count,
        row_count: summary.row_count,
    };
    let json = serde_json::to_string_pretty(&manifest)
        .map_err(|err| io_error("E_PARQUET_MANIFEST", err.to_string()))?;
    fs::write(build_dir.join(PARQUET_MANIFEST), format!("{json}\n"))
        .map_err(|err| io_error("E_PARQUET_MANIFEST", err.to_string()))
}

/// AKA-71：启动时校验 Parquet 分区摘要。
///
/// 返回 `Some(detail)` 表示摘要不匹配或分区不可读，调用方据此阻断加载；
/// 返回 `None` 表示校验通过，或清单不存在（AKA-75 之前安装的旧数据集，跳过校验）。
fn verify_parquet_partition(dir: &Path) -> Option<String> {
    let manifest_path = dir.join(PARQUET_MANIFEST);
    if !manifest_path.is_file() {
        return None;
    }
    let expected = fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|text| serde_json::from_str::<ParquetManifest>(&text).ok())?;

    let store = ParquetStore::with_partition_dir(dir.join(PARQUET_DIR));
    let bytes = match store.partition_bytes() {
        Ok(bytes) => bytes,
        Err(err) => return Some(format!("Parquet 分区不可读：{err}")),
    };
    let actual = sha256_hex(&bytes);
    if actual != expected.parquet_sha256 {
        return Some(format!(
            "Parquet 分区摘要不匹配：期望 {}…，实际 {}…（声明 {} 个分区），请重建数据集",
            short_sha(&expected.parquet_sha256),
            short_sha(&actual),
            expected.partition_count
        ));
    }
    None
}

fn short_sha(sha: &str) -> &str {
    let end = sha.len().min(12);
    &sha[..end]
}

/// BarRecord → Candle：补齐 epoch 秒时间戳、解析 quality 逗号串、固定 source="sim"。
fn bar_record_to_candle(record: BarRecord) -> Candle {
    let ts = data_provider::Date::parse(&record.date)
        .map(|date| date.epoch_secs())
        .unwrap_or(0);
    Candle {
        ts,
        date: record.date,
        open: record.open,
        high: record.high,
        low: record.low,
        close: record.close,
        volume: record.volume,
        amount: record.amount,
        adj_factor: record.adj_factor,
        quality: record
            .quality
            .split(',')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect(),
        source: "sim".to_string(),
        batch_id: record.batch_id,
        ingested_at: record.ingested_at,
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

fn next_data_version(build_dir: &Path) -> String {
    let Ok(text) = fs::read_to_string(build_dir.join(MANIFEST)) else {
        return "v1".to_string();
    };
    let Ok(manifest) = DatasetManifest::from_json(&text) else {
        return "v1".to_string();
    };
    format!("v{}", manifest.generation() + 1)
}

/// manifest 九个冻结字段（camelCase，与 `DatasetManifest` 的 serde 名一致）。
const MANIFEST_FIELDS: [&str; 9] = [
    "datasetId",
    "dataVersion",
    "rowCount",
    "coverageStart",
    "coverageEnd",
    "seed",
    "sha256",
    "provider",
    "generatedAt",
];

/// ST-DF-03-02：落盘事实（只读采集；manifest 的自述与库内实际分开返回）。
#[derive(Debug, Clone, Default)]
pub struct DiskFacts {
    /// 安装目录（`sim/seed-<seed>`）是否存在。
    pub dir_present: bool,
    pub manifest_present: bool,
    /// manifest.json 不是合法 JSON 对象（或读不出来）。
    pub manifest_json_invalid: bool,
    /// manifest 缺失的字段名（camelCase）；空 = 字段齐全。
    pub missing_fields: Vec<String>,
    /// 九个字段齐全且能反序列化时给出；否则 None。
    pub manifest: Option<DatasetManifest>,
    pub db_present: bool,
    /// 只读打开或读取摘要失败时的原因；None = 可读。
    pub db_error: Option<String>,
    /// 落盘 daily_bars 实际行数（不信任 manifest 自述）。
    pub row_count: Option<u64>,
    pub coverage_start: Option<String>,
    pub coverage_end: Option<String>,
    /// 从落盘数据重算的 sha256；manifest/DB 不可用时为 None。
    pub actual_sha256: Option<String>,
}

/// 采集安装目录的落盘事实；全程只读，不创建/改写任何文件。
pub fn disk_facts(data_dir: &Path, seed: u64) -> DiskFacts {
    let dir = dataset_dir(data_dir, seed);
    let mut facts = DiskFacts::default();
    facts.dir_present = dir.is_dir();
    if !facts.dir_present {
        return facts;
    }

    let manifest_path = dir.join(MANIFEST);
    if manifest_path.is_file() {
        facts.manifest_present = true;
        match fs::read_to_string(&manifest_path) {
            Ok(text) => {
                match serde_json::from_str::<serde_json::Value>(&text) {
                    Ok(serde_json::Value::Object(map)) => {
                        for field in MANIFEST_FIELDS {
                            if !map.contains_key(field) {
                                facts.missing_fields.push(field.to_string());
                            }
                        }
                    }
                    _ => facts.manifest_json_invalid = true,
                }
                facts.manifest = DatasetManifest::from_json(&text).ok();
            }
            Err(_) => facts.manifest_json_invalid = true,
        }
    }

    let db_path = dir.join(DATASET_DB);
    if db_path.is_file() {
        facts.db_present = true;
        match dataset_db::open_read_only(&db_path) {
            Ok(conn) => match dataset_db::summary(&conn) {
                Ok(summary) => {
                    facts.row_count = Some(summary.bars as u64);
                    facts.coverage_start = summary.coverage_start.clone();
                    facts.coverage_end = summary.coverage_end.clone();
                    // 只有 manifest 可解析时才复算摘要（否则无对照对象，也省掉全库扫描）。
                    if facts.manifest.is_some() {
                        facts.actual_sha256 =
                            digest(&conn, &sim_seed::build_install_securities()).ok();
                    }
                }
                Err(err) => facts.db_error = Some(err.to_string()),
            },
            Err(err) => facts.db_error = Some(err.to_string()),
        }
    }

    facts
}

/// ST-DF-03-03：启动时对落盘数据集的轻量身份判定。
///
/// 只读 manifest 与目录/库的存在性，不做全库摘要复算（深度校验由
/// `AppCore::dataset_integrity_at` 按需执行）。
#[derive(Debug, Clone)]
pub enum StartupDataset {
    /// 落盘完整且与缓存身份一致：接管 manifest 的 dataset_id / data_version。
    Installed(DatasetManifest),
    /// 安装目录、manifest 或 dataset.db 缺失：按「未安装」呈现并给安装入口（方案 B）。
    NotInstalled { code: &'static str, detail: String },
    /// 已安装但不可用：阻断加载，不回退、不静默升级。
    Blocked { code: &'static str, detail: String },
}

/// 判定启动时应使用的数据集身份。
///
/// - `cached` 为 `state.db.dataset_meta` 中最近一次记录；为空表示首次接管。
/// - 缓存与落盘 manifest 身份不一致时返回 `Blocked`（`E_DATASET_VERSION_MISMATCH`），
///   只有重建成功后显式写入新 `dataset_meta` 才会放行。
pub fn startup_dataset(
    data_dir: &Path,
    seed: u64,
    cached: Option<&data_store::state_db::DatasetMeta>,
) -> StartupDataset {
    let dir = dataset_dir(data_dir, seed);
    if !dir.is_dir() {
        return StartupDataset::NotInstalled {
            code: "E_DATASET_MISSING",
            detail: format!("尚未安装样本包：{} 不存在", dir.display()),
        };
    }
    let manifest_path = dir.join(MANIFEST);
    if !manifest_path.is_file() {
        return StartupDataset::NotInstalled {
            code: "E_DATASET_MISSING",
            detail: format!("数据集描述文件缺失：{}", manifest_path.display()),
        };
    }
    let manifest = match fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|text| DatasetManifest::from_json(&text).ok())
    {
        Some(manifest) => manifest,
        None => {
            return StartupDataset::Blocked {
                code: "E_DATASET_CORRUPT",
                detail: format!("数据集描述文件损坏：{}", manifest_path.display()),
            }
        }
    };
    // AC-DF-03-03-3：dataset.db 被删除按「未安装」呈现，而不是静默使用内存数据。
    if !dir.join(DATASET_DB).is_file() {
        return StartupDataset::NotInstalled {
            code: "E_DATASET_MISSING",
            detail: format!("数据集文件缺失：{}", dir.join(DATASET_DB).display()),
        };
    }
    // AKA-71：Parquet 分区被篡改或缺失 → 标记 CORRUPTED 并阻断加载，提示重建。
    if let Some(detail) = verify_parquet_partition(&dir) {
        return StartupDataset::Blocked {
            code: "E_DATASET_CORRUPT",
            detail,
        };
    }
    // AC-DF-03-03-4：缓存身份与落盘 manifest 不一致即阻断，版本不回退也不静默升级。
    if let Some(cached) = cached {
        if cached.dataset_id != manifest.dataset_id || cached.data_version != manifest.data_version {
            return StartupDataset::Blocked {
                code: "E_DATASET_VERSION_MISMATCH",
                detail: format!(
                    "缓存版本 {}（{}）与落盘版本 {}（{}）不一致，已阻断加载；请重建数据集",
                    cached.data_version, cached.dataset_id, manifest.data_version, manifest.dataset_id
                ),
            };
        }
    }
    StartupDataset::Installed(manifest)
}

/// 重建：旧目录保持可读，构建在 staging 完成后原子替换，失败则保留旧 dataset_id。
pub fn rebuild(data_dir: &Path, seed: u64) -> Result<SimInstallReport, SimErrorInfo> {
    let dir = dataset_dir(data_dir, seed);
    // 先记住旧代数：发布前旧 manifest 仍在，失败也不会丢版本。
    let next_version = fs::read_to_string(dir.join(MANIFEST))
        .ok()
        .and_then(|text| DatasetManifest::from_json(&text).ok())
        .map(|manifest| format!("v{}", manifest.generation() + 1));
    let sentinel = sentinel_path(data_dir);
    if sentinel.exists() {
        let _ = fs::remove_file(sentinel);
    }
    finish_install(data_dir, seed, install_inner(data_dir, seed, next_version))
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

    /// AC-DF-03-01-3：构建中途失败时正式目录不被破坏，旧 dataset_id 仍可读，
    /// 且 install-report 明确记 failed（不得静默回到「未安装」）。
    #[test]
    fn failed_rebuild_keeps_previous_dataset_and_marks_report_failed() {
        let data_dir = temp_data_dir("atomic-fail");
        let first = install(&data_dir, 42).expect("install");
        let dir = dataset_dir(&data_dir, 42);

        // 用普通文件占住 staging 路径，模拟构建阶段失败；正式目录此时仍完好。
        fs::create_dir_all(sim_root(&data_dir)).expect("sim root");
        let staging = staging_dir(&data_dir, 42);
        fs::write(&staging, b"blocked").expect("occupy staging");

        let error = rebuild(&data_dir, 42).expect_err("rebuild must fail");
        assert_eq!(error.code, "E_DIR_NOT_WRITABLE");

        let status = status(&data_dir, 42);
        assert_eq!(status.state, "failed");

        let text = fs::read_to_string(failed_report_path(&data_dir)).expect("failed report");
        let report: serde_json::Value = serde_json::from_str(&text).expect("json");
        assert_eq!(report["status"], "failed");
        assert_eq!(report["error"]["code"], "E_DIR_NOT_WRITABLE");

        // 旧 manifest 与旧库都未被替换，dataset_id 仍可读。
        let manifest =
            DatasetManifest::from_json(&fs::read_to_string(dir.join(MANIFEST)).unwrap())
                .expect("manifest");
        assert_eq!(manifest.dataset_id, first.dataset_id);
        let conn = dataset_db::open(&dir.join(DATASET_DB)).expect("open old db");
        assert_eq!(dataset_db::summary(&conn).unwrap().bars, 62_400);

        let _ = fs::remove_file(&staging);
        let _ = fs::remove_dir_all(&data_dir);
    }

    /// AC-DF-03-01-6：安装状态必须返回 5 个阶段 + 行数 / 耗时 / dataset_id。
    #[test]
    fn status_reports_steps_row_count_duration_and_dataset_id() {
        let data_dir = temp_data_dir("status");
        let report = install(&data_dir, 42).expect("install");

        let status = status(&data_dir, 42);
        assert_eq!(status.state, "installed");
        assert_eq!(status.steps.len(), 5);
        assert_eq!(status.resume_from, None);

        let installed = status.installed.expect("installed report");
        assert_eq!(installed.row_count, report.row_count);
        assert_eq!(installed.dataset_id, report.dataset_id);
        assert_eq!(installed.total_ms, report.total_ms);
        assert_eq!(installed.steps.len(), 5);

        let _ = fs::remove_dir_all(&data_dir);
    }

    /// AC-DF-01-03-2：同一 seed 在两个独立目录各装一次，dataset_id 与 sha256
    /// 必须完全一致（生成时间不参与身份计算）。
    #[test]
    fn same_seed_installs_are_identical() {
        let first_dir = temp_data_dir("seed-a");
        let second_dir = temp_data_dir("seed-b");
        let first = install(&first_dir, 42).expect("first install");
        let second = install(&second_dir, 42).expect("second install");

        assert_eq!(first.dataset_id, second.dataset_id);
        assert_eq!(first.sha256, second.sha256);
        assert_eq!(first.row_count, second.row_count);
        assert_eq!(first.seed, 42);
        assert_eq!(second.seed, 42);

        let _ = fs::remove_dir_all(&first_dir);
        let _ = fs::remove_dir_all(&second_dir);
    }

    /// AC-DF-01-03-5：generated_at 只记录生成时刻，不得影响 dataset_id/sha256。
    #[test]
    fn generated_at_does_not_change_identity() {
        let sha = "0123456789abcdef0123456789abcdef";
        let early = DatasetManifest::build(
            "sim",
            42,
            "2023-01-02",
            "2024-12-27",
            62_400,
            "v1",
            sha,
            1,
        );
        let late = DatasetManifest::build(
            "sim",
            42,
            "2023-01-02",
            "2024-12-27",
            62_400,
            "v1",
            sha,
            1_900_000_000,
        );
        assert_eq!(early.dataset_id, late.dataset_id);
        assert_eq!(early.sha256, late.sha256);
        assert_ne!(early.generated_at, late.generated_at);
    }

    /// AC-DF-01-03-3：manifest 九个字段必须全部非空，且能被解析回同一身份。
    #[test]
    fn manifest_declares_all_nine_fields() {
        let data_dir = temp_data_dir("manifest");
        let report = install(&data_dir, 42).expect("install");
        let dir = dataset_dir(&data_dir, 42);
        let text = fs::read_to_string(dir.join(MANIFEST)).expect("manifest");
        let manifest = DatasetManifest::from_json(&text).expect("parse");

        assert!(!manifest.dataset_id.is_empty());
        assert!(!manifest.data_version.is_empty());
        assert!(!manifest.sha256.is_empty());
        assert!(!manifest.coverage_start.is_empty());
        assert!(!manifest.coverage_end.is_empty());
        assert_eq!(manifest.seed, 42);
        assert_eq!(manifest.row_count, 62_400);
        assert!(!manifest.provider.is_empty());
        assert!(manifest.generated_at > 0);
        assert_eq!(manifest.dataset_id, report.dataset_id);

        let _ = fs::remove_dir_all(&data_dir);
    }

    /// AKA-75：install 完成后 parquet 分区文件必须存在、数量正确、可读回。
    #[test]
    fn install_writes_parquet_partition() {
        let data_dir = temp_data_dir("parquet");
        install(&data_dir, 42).expect("install");
        let dir = dataset_dir(&data_dir, 42);
        let parquet_dir = dir.join("parquet");

        // 120 只标的 = 120 个 parquet 文件
        let entries: Vec<_> = fs::read_dir(&parquet_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map_or(false, |ext| ext == "parquet"))
            .collect();
        assert_eq!(
            entries.len(),
            SECURITY_COUNT,
            "parquet 分区应为 {SECURITY_COUNT} 个，实际 {}",
            entries.len()
        );

        // 随机读一只（600519.SH），验证行数 = BARS_PER_SECURITY
        let store = data_store::parquet_store::ParquetStore::with_partition_dir(&parquet_dir);
        let candles = store.read_security("600519.SH").expect("read");
        assert_eq!(candles.len(), BARS_PER_SECURITY);
        assert!(candles.iter().all(|c| c.source == "sim"));
        assert!(candles.iter().all(|c| !c.date.is_empty()));

        // load_all 读回所有
        let all = store.load_all().expect("load_all");
        assert_eq!(all.len(), SECURITY_COUNT);
        let total: usize = all.values().map(|v| v.len()).sum();
        assert_eq!(total, TOTAL_BARS);

        // rebuild 后 parquet 仍然正确（版本 +1）
        let again = rebuild(&data_dir, 42).expect("rebuild");
        assert_eq!(again.data_version, "v2");
        let all_after = store.load_all().expect("load_all after rebuild");
        assert_eq!(all_after.len(), SECURITY_COUNT);

        let _ = fs::remove_dir_all(&data_dir);
    }

    /// AKA-71：install 必须写出 parquet-manifest.json，摘要与分区字节一致。
    #[test]
    fn parquet_manifest_records_partition_sha256() {
        let data_dir = temp_data_dir("parquet-manifest");
        install(&data_dir, 42).expect("install");
        let dir = dataset_dir(&data_dir, 42);

        let raw = fs::read_to_string(dir.join(PARQUET_MANIFEST)).expect("parquet-manifest.json");
        let manifest: ParquetManifest = serde_json::from_str(&raw).expect("parse");
        assert_eq!(manifest.partition_count, SECURITY_COUNT as u64);
        assert_eq!(manifest.row_count, TOTAL_BARS as u64);
        assert_eq!(manifest.data_version, "v1");
        assert!(!manifest.dataset_id.is_empty());

        // 独立复算：分区字节拼接后的 sha256 必须与清单一致
        let store = ParquetStore::with_partition_dir(dir.join(PARQUET_DIR));
        let bytes = store.partition_bytes().expect("partition_bytes");
        assert_eq!(manifest.parquet_sha256, sha256_hex(&bytes));

        // 未篡改时启动校验通过
        assert!(verify_parquet_partition(&dir).is_none());
        assert!(matches!(
            startup_dataset(&data_dir, 42, None),
            StartupDataset::Installed(_)
        ));

        let _ = fs::remove_dir_all(&data_dir);
    }

    /// AKA-71：分区文件被改动 → 启动标记 CORRUPTED 并阻断加载。
    #[test]
    fn tampered_parquet_blocks_startup() {
        let data_dir = temp_data_dir("parquet-tamper");
        install(&data_dir, 42).expect("install");
        let dir = dataset_dir(&data_dir, 42);

        // 追加一个字节，模拟文件被外部改写
        let target = dir.join(PARQUET_DIR).join("600519.SH.parquet");
        let mut bytes = fs::read(&target).expect("read partition");
        bytes.push(0);
        fs::write(&target, &bytes).expect("tamper");

        let detail = verify_parquet_partition(&dir).expect("篡改后必须校验失败");
        assert!(detail.contains("摘要不匹配"), "实际 detail：{detail}");

        match startup_dataset(&data_dir, 42, None) {
            StartupDataset::Blocked { code, .. } => assert_eq!(code, "E_DATASET_CORRUPT"),
            other => panic!("应阻断加载，实际 {other:?}"),
        }

        let _ = fs::remove_dir_all(&data_dir);
    }

    /// AKA-71：AKA-75 之前安装的旧数据集没有 parquet 清单 → 跳过校验，不阻断。
    #[test]
    fn legacy_dataset_without_parquet_manifest_still_starts() {
        let data_dir = temp_data_dir("parquet-legacy");
        install(&data_dir, 42).expect("install");
        let dir = dataset_dir(&data_dir, 42);
        fs::remove_file(dir.join(PARQUET_MANIFEST)).expect("remove manifest");

        assert!(verify_parquet_partition(&dir).is_none());
        assert!(matches!(
            startup_dataset(&data_dir, 42, None),
            StartupDataset::Installed(_)
        ));

        let _ = fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn tampered_dataset_fails_sha_validation() {
        let data_dir = temp_data_dir("tamper");
        let report = install(&data_dir, 42).expect("install");
        let dir = dataset_dir(&data_dir, 42);
        let securities = sim_seed::build_install_securities();
        let conn = dataset_db::open(&dir.join(DATASET_DB)).expect("open");

        let original = digest(&conn, &securities).expect("digest");
        assert_eq!(original, report.sha256, "安装时应与 manifest 一致");
        let manifest =
            DatasetManifest::from_json(&fs::read_to_string(dir.join(MANIFEST)).unwrap())
                .expect("manifest");
        assert!(manifest.validate(report.row_count, &original).is_ok());

        conn.execute("UPDATE daily_bars SET close = close + 0.01 WHERE rowid = 1", [])
            .expect("tamper");
        let tampered = digest(&conn, &securities).expect("digest after tamper");
        assert_ne!(tampered, original, "篡改后摘要必须变化");
        let issues = manifest
            .validate(report.row_count, &tampered)
            .expect_err("篡改后必须校验失败");
        assert!(
            issues.iter().any(|issue| issue.field == "sha256"),
            "失败必须定位到 sha256，实际 {issues:?}"
        );

        let _ = fs::remove_dir_all(&data_dir);
    }

    /// AC-DF-01-03-6：seed 为 0（缺省兜底）必须拒绝，不得静默按 42 处理。
    #[test]
    fn seed_zero_is_rejected_instead_of_defaulting() {
        let manifest = DatasetManifest::build(
            "sim",
            0,
            "2023-01-02",
            "2024-12-27",
            62_400,
            "v1",
            "0123456789abcdef0123456789abcdef",
            1,
        );
        let issues = manifest
            .validate(62_400, "0123456789abcdef0123456789abcdef")
            .expect_err("seed=0 必须判失败");
        assert!(issues.iter().any(|issue| issue.field == "seed"));

        let json = r#"{
          "dataset_id": "sim-42-62400-2023-01-02-2024-12-27-01234567",
          "data_version": "v1",
          "provider": "sim",
          "coverage_start": "2023-01-02",
          "coverage_end": "2024-12-27",
          "row_count": 62400,
          "sha256": "0123456789abcdef0123456789abcdef",
          "generated_at": 1
        }"#;
        assert!(
            DatasetManifest::from_json(json).is_err(),
            "缺 seed 必须解析失败，不得按默认值兜底"
        );
    }
}
