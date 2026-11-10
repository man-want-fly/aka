//! S-06.03-02：诊断包导出与隐私排除。
//!
//! 口径（卡面「字段与口径」）：
//! - 命名 `aka-diagnostics-YYYYMMDD-HHMMSS.zip`（本地时区），固定落 `~/Downloads`；
//! - 必含 `meta.json` / `app.log` / `commands.json` / `config.json`，条件含 `crash/` 与 `manifest-check.json`；
//! - `app.log` 缺失时写 `README.txt` 如实说明，不伪造；
//! - 默认且强制排除自选、搜索历史、行情原始数据、持仓成本；`config.json` 只认白名单字段；
//! - 0 网络：只用本地文件与系统自带 `date` / `ditto` / `df`，不引入网络依赖；
//! - 时间戳一律纯 Rust 换算（只用 `date +%z` 取时区偏移）：不把 strftime 格式串直接喂给 `date`，
//!   否则 BSD/GNU `date` 会判为非法时间格式、命名退化成 epoch 毫秒（曾导致 `aka-diagnostics-1794257500404.zip`）；
//! - 失败清理临时目录与半成品 zip；启动时清上次崩溃残留的 `.tmp-diagnostics`。

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::{json, Map, Value};

use app_core::AppCore;

/// 最近 200 条 IPC 命令；字段与卡面一致：`command / duration_ms / result_code / ts`。
pub const COMMAND_RING_CAPACITY: usize = 200;
/// 配置快照白名单（顺序即写出顺序）。
pub const CONFIG_WHITELIST: [&str; 8] = [
    "theme_mode",
    "color_direction",
    "density",
    "crosshair",
    "candle_hollow",
    "subchart_height",
    "insufficient_hint",
    "dataset_id",
];
/// 默认排除项，随响应返回给前端用于说明，不参与文件内容。
pub const EXCLUDED_ITEMS: [&str; 4] = [
    "watchlist",
    "search_history",
    "raw_bars",
    "position_cost",
];

const TEMP_DIR_NAME: &str = ".tmp-diagnostics";
const LOG_TRUNCATE_BYTES: u64 = 200 * 1024 * 1024;
const DISK_MARGIN_BYTES: u64 = 5 * 1024 * 1024;

/// 落盘字段名按卡面写死为 snake_case（`duration_ms` / `result_code`），不走 camelCase。
#[derive(Debug, Clone, Serialize)]
pub struct CommandRecord {
    pub command: String,
    pub duration_ms: u64,
    pub result_code: String,
    pub ts: i64,
}

#[derive(Debug, Default)]
pub struct CommandLog {
    inner: Mutex<VecDeque<CommandRecord>>,
}

impl CommandLog {
    pub fn record(&self, command: &str, duration_ms: u64, result_code: String) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if inner.len() == COMMAND_RING_CAPACITY {
            inner.pop_front();
        }
        inner.push_back(CommandRecord {
            command: command.to_string(),
            duration_ms,
            result_code,
            ts: now_ms(),
        });
    }

    pub fn snapshot(&self, limit: usize) -> Vec<CommandRecord> {
        let Ok(inner) = self.inner.lock() else {
            return Vec::new();
        };
        inner.iter().skip(inner.len().saturating_sub(limit)).cloned().collect()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsExportDto {
    pub path: String,
    pub file_name: String,
    pub bytes: u64,
    pub included: Vec<String>,
    /// 无日志时包内为 `README.txt`，前端 toast 需注明「无日志」。
    pub no_log: bool,
    pub log_truncated: bool,
    pub crashed_logs_included: bool,
    pub excluded: Vec<String>,
}

/// 后端强制白名单：前端即便多传字段也不会落盘。
fn sanitize_config(input: Option<&Value>, dataset_id: Option<String>) -> Map<String, Value> {
    let source = input.and_then(Value::as_object);
    let mut out = Map::new();
    for key in CONFIG_WHITELIST {
        if key == "dataset_id" {
            out.insert(key.to_string(), dataset_id.clone().map(Value::String).unwrap_or(Value::Null));
            continue;
        }
        let value = source.and_then(|map| map.get(key)).cloned().unwrap_or(Value::Null);
        let normalized = match value {
            Value::String(_) | Value::Bool(_) | Value::Number(_) | Value::Null => value,
            _ => Value::Null,
        };
        out.insert(key.to_string(), normalized);
    }
    out
}

fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(PathBuf::from)
}

fn app_support_dir() -> Option<PathBuf> {
    home_dir().map(|home| home.join("Library/Application Support/aka"))
}

pub fn downloads_dir() -> Option<PathBuf> {
    home_dir().map(|home| home.join("Downloads"))
}

/// 启动时清理上次崩溃残留；只清固定子目录，不碰用户文件。
pub fn cleanup_stale_temp() {
    if let Some(base) = downloads_dir() {
        let _ = std::fs::remove_dir_all(base.join(TEMP_DIR_NAME));
    }
}

/// `app.log` 的真实路径（与埋点 JSONL 同目录）。
pub fn app_log_path() -> Option<PathBuf> {
    app_support_dir().map(|dir| dir.join("logs/app.log"))
}

/// 追加一行真实运行日志；失败静默（日志是旁路，不拖挂业务）。
pub fn append_app_log(line: &str) {
    let Some(path) = app_log_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let stamp = readable_stamp();
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{stamp} {line}");
    }
}

/// 本地时区偏移（分钟）。只依赖 `date +%z`（输出 `+0800`），取不到时按 UTC 处理。
///
/// 时区在进程生命周期内不变，缓存一次即可；`date` 每次调用都要 fork，app.log 每行都写时间戳。
fn local_offset_minutes() -> i64 {
    static OFFSET: OnceLock<i64> = OnceLock::new();
    *OFFSET.get_or_init(|| {
        let Ok(output) = Command::new("date").arg("+%z").output() else {
            return 0;
        };
        if !output.status.success() {
            return 0;
        }
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        parse_utc_offset(&text).unwrap_or(0)
    })
}

/// 解析 `+0800` / `-0530` → 分钟偏移。
fn parse_utc_offset(text: &str) -> Option<i64> {
    let sign = match text.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let digits: String = text[1..].chars().filter(char::is_ascii_digit).collect();
    if digits.len() < 4 {
        return None;
    }
    let hours: i64 = digits[0..2].parse().ok()?;
    let minutes: i64 = digits[2..4].parse().ok()?;
    Some(sign * (hours * 60 + minutes))
}

/// civil 日期 → 天序号（1970-01-01 为 0）。Howard Hinnant 算法。
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_position = (month + 9) % 12;
    let day_of_year = (153 * month_position + 2) / 5 + day - 1;
    let day_of_era =
        year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// 天序号 → civil 日期（`days_from_civil` 的逆运算）。
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year =
        day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_position = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_position + 2) / 5 + 1;
    let month = if month_position < 10 {
        month_position + 3
    } else {
        month_position - 9
    };
    let year = if month <= 2 { year + 1 } else { year };
    (year, month, day)
}

/// 纯 Rust 的时间戳格式化（不依赖 `date` 的 strftime 输出格式）。
///
/// `compact` 为真时输出 `YYYYMMDD-HHMMSS`（卡面命名口径），否则 `YYYY-MM-DD HH:MM:SS`。
fn format_epoch_ms(epoch_ms: i64, offset_minutes: i64, compact: bool) -> String {
    let total_seconds = epoch_ms.div_euclid(1000) + offset_minutes * 60;
    let days = total_seconds.div_euclid(86_400);
    let seconds = total_seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds / 3600;
    let minute = (seconds % 3600) / 60;
    let second = seconds % 60;
    if compact {
        format!("{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}")
    } else {
        format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}")
    }
}

/// 本地时区时间戳（`YYYYMMDD-HHMMSS`）：诊断包命名口径。
fn compact_stamp() -> String {
    format_epoch_ms(now_ms(), local_offset_minutes(), true)
}

/// 本地时区可读时间戳（`YYYY-MM-DD HH:MM:SS`）：app.log 行首前缀。
fn readable_stamp() -> String {
    format_epoch_ms(now_ms(), local_offset_minutes(), false)
}

/// 本地时区的 `YYYY-MM-DD`（`days_ago` 天前）：日志截断下界。
fn local_date(days_ago: i64) -> String {
    let now_seconds = now_ms().div_euclid(1000) + local_offset_minutes() * 60;
    let (year, month, day) = civil_from_days(now_seconds.div_euclid(86_400) - days_ago);
    format!("{year:04}-{month:02}-{day:02}")
}

/// 判断一行是否落在 7 天窗口内。
///
/// 只有行首是 `YYYY-MM-DD` 的行参与比较；其余行（堆栈续行、无日期前缀的历史行）原样保留，
/// 不因截断把上下文删坏。
fn within_log_window(head: Option<&str>, cutoff: &str) -> bool {
    let Some(head) = head else {
        return true;
    };
    let bytes = head.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return true;
    }
    if !bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
    {
        return true;
    }
    head >= cutoff
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(debug_assertions)]
fn diag_flag(name: &str) -> bool {
    std::env::var("AKA_DIAG").ok().as_deref() == Some("1")
        && std::env::var(name).ok().as_deref() == Some("1")
}

#[cfg(not(debug_assertions))]
fn diag_flag(_name: &str) -> bool {
    false
}

/// 可用空间（字节）。`AKA_DIAG_FREE_MB` 仅 debug + `AKA_DIAG=1` 时生效，用作「磁盘不足」夹具。
fn available_bytes(dir: &Path) -> Option<u64> {
    #[cfg(debug_assertions)]
    if let Some(mb) = debug_free_mb() {
        return Some(mb * 1024 * 1024);
    }
    available_bytes_real(dir)
}

#[cfg(debug_assertions)]
fn debug_free_mb() -> Option<u64> {
    if std::env::var("AKA_DIAG").ok().as_deref() != Some("1") {
        return None;
    }
    std::env::var("AKA_DIAG_FREE_MB").ok()?.parse::<u64>().ok()
}

fn available_bytes_real(dir: &Path) -> Option<u64> {
    let output = Command::new("df").arg("-k").arg(dir).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().nth(1)?;
    let available_kb = line.split_whitespace().nth(3)?.parse::<u64>().ok()?;
    Some(available_kb * 1024)
}

struct LogBundle {
    text: Option<String>,
    truncated: bool,
}

fn read_log(path: &Path) -> LogBundle {
    #[cfg(debug_assertions)]
    if diag_flag("AKA_DIAG_NO_LOG") {
        return LogBundle { text: None, truncated: false };
    }
    let Ok(meta) = std::fs::metadata(path) else {
        return LogBundle { text: None, truncated: false };
    };
    if meta.len() == 0 {
        return LogBundle { text: None, truncated: false };
    }
    if meta.len() <= LOG_TRUNCATE_BYTES {
        let text = std::fs::read_to_string(path).unwrap_or_default();
        if text.trim().is_empty() {
            return LogBundle { text: None, truncated: false };
        }
        return LogBundle { text: Some(text), truncated: false };
    }
    // 超大日志：只保留最近 7 天（按行首 `YYYY-MM-DD` 过滤），并标注已截断。
    let cutoff = local_date(7);
    let mut kept = String::new();
    if let Ok(file) = std::fs::File::open(path) {
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if within_log_window(line.get(0..10), &cutoff) {
                kept.push_str(&line);
                kept.push('\n');
            }
        }
    }
    if kept.trim().is_empty() {
        return LogBundle { text: None, truncated: true };
    }
    kept.push_str("\n[diagnostics] 原始日志超过 200MB，已截断为最近 7 天。\n");
    LogBundle { text: Some(kept), truncated: true }
}

fn copy_dir_if_exists(source: &Path, target: &Path) -> bool {
    if !source.is_dir() {
        return false;
    }
    let mut copied = false;
    let Ok(entries) = std::fs::read_dir(source) else {
        return false;
    };
    let _ = std::fs::create_dir_all(target);
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if let Some(name) = path.file_name() {
            if std::fs::copy(&path, target.join(name)).is_ok() {
                copied = true;
            }
        }
    }
    copied
}

fn write_json(path: &Path, value: &Value) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string());
    std::fs::write(path, text)
}

fn os_version() -> Option<String> {
    let output = Command::new("sw_vers").arg("-productVersion").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn memory_bytes() -> Option<u64> {
    let output = Command::new("sysctl").arg("-n").arg("hw.memsize").output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse::<u64>().ok()
}

fn zip_dir(source: &Path, target: &Path) -> std::io::Result<()> {
    // macOS 自带 ditto：保留目录结构、不加 `__MACOSX` 资源叉。
    let status = Command::new("ditto")
        .args(["-c", "-k", "--norsrc", "--keepParent"])
        .arg(source)
        .arg(target)
        .status()?;
    if !status.success() {
        return Err(std::io::Error::other("ditto 打包失败"));
    }
    Ok(())
}

/// 诊断包文件名（卡面口径：`aka-diagnostics-YYYYMMDD-HHMMSS.zip`）。
pub fn diagnostic_file_name(stamp: &str) -> String {
    format!("aka-diagnostics-{stamp}.zip")
}

/// 导出入口：失败时保证不留临时目录与半成品 zip。
pub fn export(
    core: &AppCore,
    command_log: &CommandLog,
    config: Option<Value>,
) -> Result<DiagnosticsExportDto, app_core::AppError> {
    let base = downloads_dir().ok_or_else(|| app_core::AppError::internal("无法解析 ~/Downloads"))?;
    std::fs::create_dir_all(&base)
        .map_err(|err| app_core::AppError::internal(format!("无法创建下载目录：{err}")))?;

    let stamp = compact_stamp();
    let file_name = diagnostic_file_name(&stamp);
    let zip_path = base.join(&file_name);

    let log_path = app_log_path();
    let log_size = log_path
        .as_deref()
        .and_then(|path| std::fs::metadata(path).ok())
        .map(|meta| meta.len())
        .unwrap_or(0);
    let estimated = (log_size as f64 * 1.2) as u64 + DISK_MARGIN_BYTES;
    let available = available_bytes(&base).unwrap_or(u64::MAX);
    if available < estimated {
        return Err(app_core::AppError::internal(format!(
            "磁盘空间不足：需要约 {}，可用 {}",
            human_bytes(estimated),
            human_bytes(available)
        ))
        .with_details(json!({
            "requiredBytes": estimated,
            "availableBytes": available,
        })));
    }

    let temp_root = base.join(TEMP_DIR_NAME);
    let work = temp_root.join(format!("aka-diagnostics-{stamp}"));
    let result = build_package(core, command_log, config, &work, &zip_path, &file_name, log_path.as_deref());
    let _ = std::fs::remove_dir_all(&temp_root);
    match result {
        Ok(dto) => {
            append_app_log(&format!("[diagnostics] export ok path={}", dto.path));
            Ok(dto)
        }
        Err(err) => {
            let _ = std::fs::remove_file(&zip_path);
            append_app_log(&format!("[diagnostics] export failed: {}", err.message));
            Err(err)
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn build_package(
    core: &AppCore,
    command_log: &CommandLog,
    config: Option<Value>,
    work: &Path,
    zip_path: &Path,
    file_name: &str,
    log_path: Option<&Path>,
) -> Result<DiagnosticsExportDto, app_core::AppError> {
    fn failed(err: std::io::Error) -> app_core::AppError {
        app_core::AppError::internal(format!("写入诊断包失败：{err}"))
    }
    std::fs::create_dir_all(work)
        .map_err(|err| app_core::AppError::internal(format!("无法创建临时目录：{err}")))?;

    let dataset = core.dataset_manifest();
    let dataset_id = dataset.as_ref().map(|item| item.dataset_id.clone());
    let mut included = vec!["meta.json".to_string()];

    let meta = json!({
        "appVersion": env!("CARGO_PKG_VERSION"),
        "build": std::env::var("AKA_BUILD_NO").unwrap_or_else(|_| "dev".to_string()),
        "engine": "aka-engine-0.1.0",
        "exportedAt": now_ms(),
        "os": std::env::consts::OS,
        "osVersion": os_version(),
        "arch": std::env::consts::ARCH,
        "memoryBytes": memory_bytes(),
        "dataset": dataset.as_ref().map(|item| json!({
            "id": item.dataset_id,
            "dataVersion": item.data_version,
            "rowCount": item.row_count,
            "coverageStart": item.coverage_start,
            "coverageEnd": item.coverage_end,
            "sha256Short": item.sha256.chars().take(12).collect::<String>(),
            "provider": item.provider,
        })),
    });
    write_json(&work.join("meta.json"), &meta).map_err(failed)?;

    // app.log / README.txt：日志缺失时如实说明，不假装成功。
    let log = log_path.map(read_log).unwrap_or(LogBundle { text: None, truncated: false });
    let no_log = log.text.is_none();
    if let Some(text) = log.text {
        std::fs::write(work.join("app.log"), text).map_err(failed)?;
        included.push("app.log".to_string());
    } else {
        let note = "本次导出没有可用的应用日志（logs/app.log 不存在或为空）。\n\
                    诊断包其余文件仍然有效：meta.json 记录版本与系统信息，commands.json 记录最近命令，\
                    config.json 为白名单配置快照，manifest-check.json 为数据校验摘要。\n";
        std::fs::write(work.join("README.txt"), note).map_err(failed)?;
        included.push("README.txt".to_string());
    }

    let commands = command_log.snapshot(COMMAND_RING_CAPACITY);
    write_json(&work.join("commands.json"), &serde_json::to_value(&commands).unwrap_or(Value::Array(Vec::new())))
        .map_err(failed)?;
    included.push("commands.json".to_string());

    let config_map = sanitize_config(config.as_ref(), dataset_id);
    write_json(&work.join("config.json"), &Value::Object(config_map)).map_err(failed)?;
    included.push("config.json".to_string());

    let quality = core.quality_report();
    // 只写摘要：`QualityReportDto.rows[].examples` 含具体证券代码，属行情原始数据，按卡面默认排除。
    let quality_summary = quality.as_ref().map(|report| {
        json!({
            "datasetId": report.dataset_id,
            "basedOnDatasetId": report.based_on_dataset_id,
            "currentDatasetId": report.current_dataset_id,
            "stale": report.stale,
            "scannedAt": report.scanned_at,
            "durationMs": report.duration_ms,
            "passedCount": report.passed_count,
            "totalCount": report.total_count,
            "rows": report.rows.iter().map(|row| json!({
                "key": row.key,
                "labelZh": row.label_zh,
                "status": row.status,
                "hits": row.hits,
                "base": row.base,
                "ratioPct": row.ratio_pct,
                "treatment": row.treatment,
                "errorCode": row.error_code,
            })).collect::<Vec<_>>(),
        })
    });
    let check = json!({
        "dataset": dataset.as_ref().map(|item| json!({
            "id": item.dataset_id,
            "dataVersion": item.data_version,
            "rowCount": item.row_count,
            "coverageStart": item.coverage_start,
            "coverageEnd": item.coverage_end,
            "sha256": item.sha256,
            "provider": item.provider,
            "generatedAt": item.generated_at,
        })),
        "quality": quality_summary,
    });
    write_json(&work.join("manifest-check.json"), &check).map_err(failed)?;
    included.push("manifest-check.json".to_string());

    let mut crashed_logs_included = false;
    if let Some(dir) = app_support_dir() {
        let crash_target = work.join("crash");
        crashed_logs_included |= copy_dir_if_exists(&dir.join("logs/crash"), &crash_target);
        crashed_logs_included |= copy_dir_if_exists(&dir.join("crash"), &crash_target);
        if crashed_logs_included {
            included.push("crash/".to_string());
        }
    }

    zip_dir(work, zip_path).map_err(failed)?;
    let bytes = std::fs::metadata(zip_path)
        .map_err(failed)?
        .len();
    if bytes == 0 {
        return Err(app_core::AppError::internal("诊断包为空"));
    }

    Ok(DiagnosticsExportDto {
        path: zip_path.display().to_string(),
        file_name: file_name.to_string(),
        bytes,
        included,
        no_log,
        log_truncated: log.truncated,
        crashed_logs_included,
        excluded: EXCLUDED_ITEMS.iter().map(|item| item.to_string()).collect(),
    })
}

/// 在 Finder 中定位诊断包：只接受 `~/Downloads` 下 `aka-diagnostics-` 前缀的文件。
pub fn reveal(path: &str) -> Result<(), app_core::AppError> {
    let base = downloads_dir().ok_or_else(|| app_core::AppError::internal("无法解析 ~/Downloads"))?;
    let candidate = PathBuf::from(path);
    let name = candidate
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !candidate.starts_with(&base) || !name.starts_with("aka-diagnostics-") || !candidate.is_file() {
        return Err(app_core::AppError::invalid_argument("不是可定位的诊断包路径"));
    }
    Command::new("open")
        .arg("-R")
        .arg(&candidate)
        .status()
        .map_err(|err| app_core::AppError::internal(format!("无法打开 Finder：{err}")))?;
    Ok(())
}

fn human_bytes(bytes: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    if bytes as f64 >= MB {
        format!("{:.1} MB", bytes as f64 / MB)
    } else {
        format!("{:.0} KB", bytes as f64 / 1024.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_whitelist_drops_private_fields() {
        let input = json!({
            "theme_mode": "dark",
            "density": "compact",
            "watchlist": ["600519.SH"],
            "search_history": ["ndsd"],
            "dataset_id": "forged",
        });
        let out = sanitize_config(Some(&input), Some("sim-20240430".to_string()));
        assert_eq!(out.get("theme_mode").and_then(Value::as_str), Some("dark"));
        assert_eq!(
            out.get("dataset_id").and_then(Value::as_str),
            Some("sim-20240430"),
            "dataset_id 必须以后端 manifest 为准"
        );
        assert!(!out.contains_key("watchlist"));
        assert!(!out.contains_key("search_history"));
        assert_eq!(out.len(), CONFIG_WHITELIST.len(), "只写白名单 8 个键");
    }

    #[test]
    fn command_log_keeps_last_200_records() {
        let log = CommandLog::default();
        for index in 0..205 {
            log.record(&format!("cmd{index}"), 3, "OK".to_string());
        }
        let snapshot = log.snapshot(COMMAND_RING_CAPACITY);
        assert_eq!(snapshot.len(), COMMAND_RING_CAPACITY);
        assert_eq!(snapshot.first().unwrap().command, "cmd5");
        assert_eq!(snapshot.last().unwrap().command, "cmd204");
    }

    #[test]
    fn reveal_rejects_paths_outside_downloads() {
        assert!(reveal("/tmp/aka-diagnostics-20260101-000000.zip").is_err());
        assert!(reveal("/Users/someone/Downloads/notes.txt").is_err());
    }

    /// 卡面命名口径：`aka-diagnostics-YYYYMMDD-HHMMSS.zip`（S-06.03-02 字段与口径表）。
    /// 这条断言是 P05-R2 的判据锚点：命名退化成 epoch 毫秒时必须判红。
    #[test]
    fn diagnostic_file_name_matches_card_naming() {
        let name = diagnostic_file_name("20261110-045145");
        assert_eq!(name, "aka-diagnostics-20261110-045145.zip");
        let stamp = name
            .trim_start_matches("aka-diagnostics-")
            .trim_end_matches(".zip");
        assert!(
            stamp.len() == 15
                && stamp.as_bytes()[8] == b'-'
                && stamp[..8].chars().all(|c| c.is_ascii_digit())
                && stamp[9..].chars().all(|c| c.is_ascii_digit()),
            "命名必须形如 YYYYMMDD-HHMMSS，实际 {stamp}"
        );
    }

    /// 时间戳必须始终是 `YYYYMMDD-HHMMSS` 形状：任何兜底路径都不能退回 epoch 毫秒。
    #[test]
    fn compact_stamp_is_always_card_shape() {
        let stamp = compact_stamp();
        assert_eq!(stamp.len(), 15, "实际 {stamp}");
        assert_eq!(&stamp[8..9], "-");
        assert!(
            stamp.chars().all(|c| c.is_ascii_digit() || c == '-'),
            "实际 {stamp}"
        );
    }

    #[test]
    fn readable_stamp_is_log_line_prefix() {
        let stamp = readable_stamp();
        assert_eq!(stamp.len(), 19, "实际 {stamp}");
        assert_eq!(&stamp[4..5], "-");
        assert_eq!(&stamp[10..11], " ");
    }

    /// app.log 的 7 天截断按行首 `YYYY-MM-DD` 比较，下界必须是同一形状。
    #[test]
    fn local_date_is_iso_shape() {
        let date = local_date(7);
        assert_eq!(date.len(), 10, "实际 {date}");
        assert_eq!(&date[4..5], "-");
        assert_eq!(&date[7..8], "-");
        assert!(date.chars().all(|c| c.is_ascii_digit() || c == '-'));
    }

    #[test]
    fn civil_day_conversion_round_trips() {
        for (year, month, day) in [
            (1970, 1, 1),
            (2023, 1, 2),
            (2024, 12, 27),
            (2026, 11, 10),
            (2100, 3, 1),
        ] {
            let days = days_from_civil(year, month, day);
            assert_eq!(civil_from_days(days), (year, month, day), "{year}-{month}-{day}");
        }
    }

    #[test]
    fn epoch_ms_formats_expected_civil_fields() {
        // 2023-01-02T00:00:00Z = 1672617600 秒
        assert_eq!(
            format_epoch_ms(1_672_617_600_000, 0, true),
            "20230102-000000"
        );
        assert_eq!(
            format_epoch_ms(1_672_617_600_000, 8 * 60, true),
            "20230102-080000"
        );
        assert_eq!(
            format_epoch_ms(1_672_617_600_000, 0, false),
            "2023-01-02 00:00:00"
        );
    }

    #[test]
    fn utc_offset_parsing_handles_signs_and_padding() {
        assert_eq!(parse_utc_offset("+0800"), Some(480));
        assert_eq!(parse_utc_offset("-0530"), Some(-330));
        assert_eq!(parse_utc_offset("+00:00"), Some(0));
        assert_eq!(parse_utc_offset("nonsense"), None);
        assert_eq!(parse_utc_offset(""), None);
    }

    /// 纯 Rust 的本地时间换算必须与系统本地时间一致（卡面「本地时区」口径）。
    /// 允许 2 秒取样间隔。
    #[test]
    fn compact_stamp_agrees_with_system_local_time() {
        let Ok(output) = Command::new("date").arg("+%Y%m%d-%H%M%S").output() else {
            return; // 系统没有 date：跳过，不把环境问题算成代码问题
        };
        if !output.status.success() {
            return;
        }
        let system = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let mine = compact_stamp();
        let diff = (compact_to_seconds(&mine) - compact_to_seconds(&system)).abs();
        assert!(diff <= 2, "本地时间换算与系统不一致：{mine} vs {system}");
    }

    /// 7 天截断只按带日期的行首判定；堆栈续行等无日期前缀的行必须原样保留。
    #[test]
    fn log_window_keeps_undated_lines() {
        // 调用点传的是行首 10 字符
        fn head(line: &str) -> Option<&str> {
            line.get(0..10)
        }
        let cutoff = "2026-11-03";
        assert!(within_log_window(head("2026-11-09 10:00:00"), cutoff));
        assert!(!within_log_window(head("2026-10-01 10:00:00"), cutoff));
        assert!(within_log_window(head("  at frame.rs:12"), cutoff));
        assert!(within_log_window(head("1794257500404 legacy"), cutoff));
        assert!(within_log_window(None, cutoff));
    }

    fn compact_to_seconds(text: &str) -> i64 {
        let year: i64 = text[0..4].parse().expect("year");
        let month: i64 = text[4..6].parse().expect("month");
        let day: i64 = text[6..8].parse().expect("day");
        let hour: i64 = text[9..11].parse().expect("hour");
        let minute: i64 = text[11..13].parse().expect("minute");
        let second: i64 = text[13..15].parse().expect("second");
        days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second
    }
}
