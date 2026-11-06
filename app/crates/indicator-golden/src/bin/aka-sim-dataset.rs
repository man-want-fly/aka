//! sim 数据集最小闭环生成器：`cargo run -p indicator-golden --bin aka-sim-dataset`。
//!
//! 产物（提交到仓库，QA 可直接复算）：
//! - `app/data/sim/seed-42/records.csv` + `manifest.json`（v1 生成后重建为 v2，演示代数 +1）
//! - `app/data/sim/seed-7/records.csv` + `manifest.json`（第二个 seed/标的，manifest ≥3 字段不同）
//! - `app/data/sim/generation-report.json`：两次生成 + 校验结果，机读
//!
//! `app/data/real/` 只读不写：生成器对路径含 `real` 的目录会直接拒绝（单测覆盖）。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use data_provider::mock::MockProvider;
use data_provider::sha256::sha256_hex;
use data_provider::sim_dataset::{dataset_dir, verify_sim_dataset, write_sim_dataset};
use data_provider::{Adjust, BarRequest, DataProvider, Timeframe};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// real 目录哨兵摘要：对「文件名 + 文件 sha256」按文件名列升序再取一次 sha256。
fn real_dir_digest(dir: &Path) -> io::Result<String> {
    if !dir.exists() {
        return Ok("(missing)".to_string());
    }
    let mut files: Vec<PathBuf> = fs::read_dir(dir)?
        .filter_map(|entry| entry.ok().map(|item| item.path()))
        .filter(|path| path.is_file())
        .collect();
    files.sort();
    let mut listing = String::new();
    for path in files {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        let bytes = fs::read(&path)?;
        listing.push_str(&format!("{name}:{}\n", sha256_hex(&bytes)));
    }
    Ok(sha256_hex(listing.as_bytes()))
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[tokio::main]
async fn main() -> io::Result<()> {
    let provider = MockProvider::new();
    let root = repo_root().join("data");
    let sim = root.join("sim");
    fs::create_dir_all(&sim)?;
    let real_dir = root.join("real");
    let real_before = real_dir_digest(&real_dir)?;

    // 两个 seed 用不同标的，保证 manifest 的 seed / datasetId / sha256 / coverage 至少 3 项不同。
    let jobs = [(42u64, "600519.SH"), (7u64, "300750.SZ")];
    let mut report = Vec::new();

    for (seed, security) in jobs {
        let batch = provider
            .daily_bars(BarRequest {
                security: security.to_string(),
                timeframe: Timeframe::Day,
                adj: Adjust::Qfq,
                from: None,
                to: None,
            })
            .await
            .map_err(|err| io::Error::new(io::ErrorKind::Other, format!("{err:?}")))?;

        let dir = dataset_dir(&root, seed);
        let mut generations = Vec::new();

        // v1 首次生成。
        let first = write_sim_dataset(&dir, seed, &batch.rows, "v1", now_secs())?;
        let verified_first = verify_sim_dataset(&dir)
            .ok()
            .and_then(|result| result.ok())
            .is_some();
        generations.push(serde_json::json!({
            "dataVersion": first.data_version,
            "generation": first.generation(),
            "datasetId": first.dataset_id,
            "sha256": first.sha256,
            "verified": verified_first,
        }));

        // v2 重建：同内容，data_version +1 → generation +1，sha256 不变（内容未变）。
        if seed == 42 {
            let rebuilt = write_sim_dataset(&dir, seed, &batch.rows, "v2", now_secs())?;
            let verified = verify_sim_dataset(&dir)
                .ok()
                .and_then(|result| result.ok())
                .is_some();
            generations.push(serde_json::json!({
                "dataVersion": rebuilt.data_version,
                "generation": rebuilt.generation(),
                "datasetId": rebuilt.dataset_id,
                "sha256": rebuilt.sha256,
                "verified": verified,
            }));
        }

        report.push(serde_json::json!({
            "seed": seed,
            "security": security,
            "rows": batch.rows.len(),
            "dir": dir.strip_prefix(&root).unwrap_or(&dir).display().to_string(),
            "generations": generations,
        }));
    }

    let real_dir = root.join("real");
    let real_untouched = !real_dir.join("records.csv").exists();
    let real_after = real_dir_digest(&real_dir)?;
    let payload = serde_json::json!({
        "formatVersion": 1,
        "provider": "sim",
        "csvFormat": "date,open,high,low,close,volume,amount（date 升序；价格 2 位、volume 0 位、amount 2 位）",
        "realDirUntouched": real_untouched,
        "realDir": {
            "path": real_dir.strip_prefix(&root).unwrap_or(&real_dir).display().to_string(),
            "beforeSha256": real_before,
            "afterSha256": real_after,
            "changed": real_after != real_before,
        },
        "datasets": report,
    });
    let report_path = sim.join("generation-report.json");
    fs::write(&report_path, format!("{}\n", serde_json::to_string_pretty(&payload)?))?;

    println!("sim 数据集生成完成：{}", sim.display());
    for entry in payload["datasets"].as_array().into_iter().flatten() {
        println!(
            "  seed={} {} rows={} generations={}",
            entry["seed"],
            entry["security"],
            entry["rows"],
            entry["generations"]
                .as_array()
                .map(|items| items.len())
                .unwrap_or(0)
        );
    }
    println!(
        "real 目录未被写入：{}（sha256 {} → {}，changed={}）；报告 {}",
        real_untouched,
        payload["realDir"]["beforeSha256"].as_str().unwrap_or(""),
        payload["realDir"]["afterSha256"].as_str().unwrap_or(""),
        payload["realDir"]["changed"].as_bool().unwrap_or(true),
        report_path.display()
    );
    Ok(())
}
