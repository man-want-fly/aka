//! sim 数据集生成器最小闭环（TD-S0-02 / TD-S0-08 清偿）。
//!
//! 目录隔离契约：
//! - 生成器只会写 `<root>/sim/<数据集目录>/`；
//! - `<root>/real/` 由真实数据源写入，生成器**拒绝**在路径含 `real` 的目录下写入；
//! - `records.csv` + `manifest.json` 同目录，manifest 的 sha256 可由 CSV 独立复算。
//!
//! 规范 CSV（冻结，任何格式变更都必须升 `format_version`）：
//! - 表头 `date,open,high,low,close,volume,amount`
//! - 行按 `date` 升序；价格 2 位小数、volume 0 位、amount 2 位；
//! - 末尾保留 `\n`；sha256 对这一整段字节（含表头）计算。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::date::Date;
use crate::dataset_manifest::DatasetManifest;
use crate::sha256::sha256_hex;
use crate::types::BarRow;

pub const SIM_CSV_HEADER: &str = "date,open,high,low,close,volume,amount";
pub const SIM_FORMAT_VERSION: u32 = 1;

pub fn canonical_csv(rows: &[BarRow]) -> String {
    let mut sorted: Vec<&BarRow> = rows.iter().collect();
    sorted.sort_by_key(|row| row.date);
    let mut out = String::with_capacity(SIM_CSV_HEADER.len() + 1 + sorted.len() * 48);
    out.push_str(SIM_CSV_HEADER);
    out.push('\n');
    for row in sorted {
        out.push_str(&format!(
            "{},{:.2},{:.2},{:.2},{:.2},{:.0},{:.2}\n",
            row.date.iso(),
            row.open,
            row.high,
            row.low,
            row.close,
            row.volume,
            row.amount
        ));
    }
    out
}

pub fn dataset_sha256(rows: &[BarRow]) -> String {
    sha256_hex(canonical_csv(rows).as_bytes())
}

/// 由行内容派生 manifest；`generated_at` 显式传入，保证测试可复现。
pub fn build_manifest(
    seed: u64,
    rows: &[BarRow],
    data_version: &str,
    generated_at: i64,
) -> DatasetManifest {
    let mut sorted: Vec<&BarRow> = rows.iter().collect();
    sorted.sort_by_key(|row| row.date);
    let start = sorted
        .first()
        .map(|row| row.date.iso())
        .unwrap_or_else(|| "1970-01-01".to_string());
    let end = sorted
        .last()
        .map(|row| row.date.iso())
        .unwrap_or_else(|| "1970-01-01".to_string());
    DatasetManifest::build(
        "sim",
        seed,
        &start,
        &end,
        rows.len() as u64,
        data_version,
        &dataset_sha256(rows),
        generated_at,
    )
}

fn ensure_not_real(path: &Path) -> io::Result<()> {
    let in_real = path
        .components()
        .any(|component| component.as_os_str() == "real");
    if in_real {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "生成器禁止写入 real 目录：real 只能由真实数据源落盘",
        ));
    }
    Ok(())
}

/// 写入 `dir/records.csv` 与 `dir/manifest.json`，返回写出的 manifest。
pub fn write_sim_dataset(
    dir: &Path,
    seed: u64,
    rows: &[BarRow],
    data_version: &str,
    generated_at: i64,
) -> io::Result<DatasetManifest> {
    ensure_not_real(dir)?;
    if rows.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "数据集不能为空"));
    }
    let manifest = build_manifest(seed, rows, data_version, generated_at);
    fs::create_dir_all(dir)?;
    fs::write(dir.join("records.csv"), canonical_csv(rows))?;
    let json = serde_json::to_string_pretty(&manifest)
        .map_err(|err| io::Error::new(io::ErrorKind::Other, err))?;
    fs::write(dir.join("manifest.json"), format!("{json}\n"))?;
    Ok(manifest)
}

/// 只读校验：重新计算 CSV 的行数与摘要，与 manifest 逐项核对。
pub fn verify_sim_dataset(dir: &Path) -> io::Result<Result<DatasetManifest, Vec<String>>> {
    ensure_not_real(dir)?;
    let text = fs::read_to_string(dir.join("manifest.json"))?;
    let manifest = match DatasetManifest::from_json(&text) {
        Ok(manifest) => manifest,
        Err(issue) => return Ok(Err(vec![format!("{}: {}", issue.field, issue.message)])),
    };
    let csv = fs::read_to_string(dir.join("records.csv"))?;
    let sha = sha256_hex(csv.as_bytes());
    let row_count = csv
        .lines()
        .skip(1)
        .filter(|line| !line.trim().is_empty())
        .count() as u64;
    match manifest.validate(row_count, &sha) {
        Ok(()) => Ok(Ok(manifest)),
        Err(issues) => Ok(Err(issues
            .into_iter()
            .map(|issue| format!("{}: {}", issue.field, issue.message))
            .collect())),
    }
}

/// 数据集目录命名：`<root>/sim/seed-<seed>/`，同一 seed 重建覆盖同目录并升 data_version。
pub fn dataset_dir(root: &Path, seed: u64) -> PathBuf {
    root.join("sim").join(format!("seed-{seed}"))
}

pub fn coverage(rows: &[BarRow]) -> Option<(Date, Date)> {
    let mut sorted: Vec<&BarRow> = rows.iter().collect();
    sorted.sort_by_key(|row| row.date);
    Some((sorted.first()?.date, sorted.last()?.date))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::QualityFlag;

    fn rows() -> Vec<BarRow> {
        vec![
            BarRow {
                date: Date::new(2024, 1, 3),
                open: 10.0,
                high: 10.5,
                low: 9.9,
                close: 10.2,
                volume: 1234.0,
                amount: 12_567.89,
                adj_factor: 1.0,
                quality: vec![QualityFlag::Simulated],
            },
            BarRow {
                date: Date::new(2024, 1, 2),
                open: 9.8,
                high: 10.1,
                low: 9.7,
                close: 10.0,
                volume: 1000.0,
                amount: 10_000.0,
                adj_factor: 1.0,
                quality: vec![QualityFlag::Simulated],
            },
        ]
    }

    #[test]
    fn canonical_csv_is_sorted_and_format_is_frozen() {
        let csv = canonical_csv(&rows());
        let expected = "date,open,high,low,close,volume,amount\n\
2024-01-02,9.80,10.10,9.70,10.00,1000,10000.00\n\
2024-01-03,10.00,10.50,9.90,10.20,1234,12567.89\n";
        assert_eq!(csv, expected);
    }

    #[test]
    fn sha_is_recomputable_and_changes_on_any_tamper() {
        let sha = dataset_sha256(&rows());
        assert_eq!(sha, sha256_hex(canonical_csv(&rows()).as_bytes()));
        let mut tampered = rows();
        tampered[0].close += 0.01;
        assert_ne!(sha, dataset_sha256(&tampered));
    }

    #[test]
    fn manifest_covers_rows_and_verifies_after_write() {
        let dir = std::env::temp_dir().join("aka-sim-dataset-test");
        let manifest = write_sim_dataset(&dir, 42, &rows(), "v1", 1_700_000_000).unwrap();
        assert_eq!(manifest.provider, "sim");
        assert_eq!(manifest.row_count, 2);
        assert_eq!(manifest.coverage_start, "2024-01-02");
        assert_eq!(manifest.coverage_end, "2024-01-03");
        let verified = verify_sim_dataset(&dir).unwrap();
        assert!(verified.is_ok(), "{verified:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn generator_refuses_real_directories() {
        let dir = std::env::temp_dir().join("aka-data").join("real").join("seed-42");
        let err = write_sim_dataset(&dir, 42, &rows(), "v1", 1).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
        assert!(!dir.exists(), "被拒绝时不得落盘");
    }
}
