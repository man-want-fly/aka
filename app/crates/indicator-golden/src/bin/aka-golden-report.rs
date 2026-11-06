//! 可机读黄金报告：`cargo run -p indicator-golden --bin aka-golden-report`。
//!
//! 产物（随仓库提交，QA 直接读文件）：
//! - `app/bench/reports/golden-report.json`：逐套件/逐指标通过数 + 失败明细
//! - `app/bench/reports/golden-report.md`：一屏可读摘要
//!
//! 任何失败都以退出码 1 结束，CI 可直接作为门禁。

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use indicator_golden::{load_all, GoldenSuite};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn main() -> io::Result<()> {
    let suites = load_all().map_err(|err| io::Error::new(io::ErrorKind::Other, err))?;
    let mut total = 0usize;
    let mut failures: Vec<String> = Vec::new();
    let mut by_indicator: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut suite_reports = Vec::new();

    for suite in &suites {
        let report = suite.run();
        total += report.total;
        let failed = report.failures.len();
        for failure in &report.failures {
            failures.push(failure.clone());
        }
        for case in &suite.cases {
            let entry = by_indicator.entry(case.indicator_id.clone()).or_insert((0, 0));
            entry.0 += 1;
        }
        // 失败归属到指标：从失败字符串前缀取指标 id（格式「T01 / sma 第 n 根…」）。
        for failure in &report.failures {
            if let Some(prefix) = failure.split_whitespace().next() {
                if let Some(entry) = by_indicator.get_mut(prefix) {
                    entry.1 += 1;
                }
            }
        }
        suite_reports.push(json_suite(suite, report.total, failed));
    }

    let passed = total - failures.len();
    let generated_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let report = serde_json::json!({
        "formatVersion": 1,
        "generatedAtUnix": generated_at,
        "total": total,
        "passed": passed,
        "failed": failures.len(),
        "result": if failures.is_empty() { "passed" } else { "failed" },
        "indicators": by_indicator.iter().map(|(id, (cases, failed))| {
            serde_json::json!({ "indicatorId": id, "cases": cases, "failed": failed })
        }).collect::<Vec<_>>(),
        "suites": suite_reports,
        "failures": failures,
    });

    let dir = repo_root().join("bench/reports");
    fs::create_dir_all(&dir)?;
    let json_path = dir.join("golden-report.json");
    fs::write(&json_path, format!("{}\n", serde_json::to_string_pretty(&report)?))?;

    let md_path = dir.join("golden-report.md");
    let mut md = String::new();
    md.push_str("# 黄金夹具报告\n\n");
    md.push_str(&format!(
        "- 结论：**{passed}/{total} passed**（失败 {}）\n- 机读：`bench/reports/golden-report.json`\n- 生成：`cargo run -p indicator-golden --bin aka-golden-report`\n\n",
        failures.len()
    ));
    md.push_str("| 指标 | 用例数 | 失败 |\n| --- | ---: | ---: |\n");
    for (id, (cases, failed)) in &by_indicator {
        md.push_str(&format!("| {id} | {cases} | {failed} |\n"));
    }
    if !failures.is_empty() {
        md.push_str("\n## 失败明细\n\n");
        for failure in &failures {
            md.push_str(&format!("- {failure}\n"));
        }
    }
    fs::write(&md_path, md)?;

    println!(
        "golden-report: {passed}/{total} passed，失败 {}；写入 {}",
        failures.len(),
        json_path.display()
    );
    if !failures.is_empty() {
        std::process::exit(1);
    }
    Ok(())
}

fn json_suite(suite: &GoldenSuite, total: usize, failed: usize) -> serde_json::Value {
    serde_json::json!({
        "name": suite.name,
        "bars": suite.bars,
        "cases": total,
        "failed": failed,
    })
}
