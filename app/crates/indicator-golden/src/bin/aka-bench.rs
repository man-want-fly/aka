//! 可重复的单指标基准程序（S0 建立，S1 扩到 B1 十个指标）。
//!
//! 运行：
//! ```text
//! cargo run --release -p indicator-golden --bin aka-bench
//! ```
//! 输出：`app/bench/baselines/macos-<arch>.json`（含机器、rustc、profile、阈值与判定）。
//!
//! 数据是固定种子的合成 OHLCV，不含随机源；同一机器同一版本应得到可对比的 p50/p95。
//! 阈值（S0 冻结，B1 沿用）：520 根 p95 ≤ 1.0ms，2500 根 p95 ≤ 8.0ms；
//! 只记录，不让 CI 因此变红（性能回归由人判读基线 diff）。

use std::hint::black_box;
use std::path::PathBuf;
use std::process::Command;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use indicator_core::{
    lookup, merge_defaults, OhlcvView, ParamValue, Params, ENGINE_VERSION, MACD_ID,
};
use serde::Serialize;

const THRESHOLD_P95_MS_520: f64 = 1.0;
const THRESHOLD_P95_MS_2500: f64 = 8.0;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Baseline {
    schema_version: u32,
    generated_at_unix: i64,
    machine: MachineInfo,
    iterations: usize,
    peak_rss_bytes: u64,
    thresholds: Thresholds,
    cases: Vec<CaseResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MachineInfo {
    os: &'static str,
    arch: &'static str,
    cpu: String,
    rustc: String,
    profile: &'static str,
    engine_version: &'static str,
    bench_version: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Thresholds {
    p95_ms_at_520_bars: f64,
    p95_ms_at_2500_bars: f64,
    note: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaseResult {
    indicator_id: &'static str,
    variant: &'static str,
    bars: usize,
    runs: usize,
    p50_ms: f64,
    p95_ms: f64,
    max_ms: f64,
    threshold_ms: f64,
    verdict: &'static str,
}

struct Synthetic {
    open: Vec<f64>,
    high: Vec<f64>,
    low: Vec<f64>,
    close: Vec<f64>,
    volume: Vec<f64>,
    amount: Vec<f64>,
}

/// 线性同余生成器：固定种子 → 完全可复现，不引入随机库。
fn lcg(state: &mut u64) -> f64 {
    *state = state
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1_442_695_040_888_963_407);
    ((*state >> 33) as f64) / ((1u64 << 31) as f64) - 1.0
}

fn synthetic(bars: usize, seed: u64) -> Synthetic {
    let mut state = seed;
    let mut close = Vec::with_capacity(bars);
    let mut price = 100.0_f64;
    for _ in 0..bars {
        price = (price + lcg(&mut state) * 1.5).max(1.0);
        close.push(price);
    }
    let open = close.clone();
    let high = close.iter().map(|c| c * 1.01).collect::<Vec<_>>();
    let low = close.iter().map(|c| c * 0.99).collect::<Vec<_>>();
    let volume = (0..bars).map(|_| 1_000_000.0 * (0.5 + lcg(&mut state).abs())).collect::<Vec<_>>();
    let amount = close
        .iter()
        .zip(volume.iter())
        .map(|(c, v)| c * v)
        .collect::<Vec<_>>();
    Synthetic {
        open,
        high,
        low,
        close,
        volume,
        amount,
    }
}

fn params(indicator: &'static dyn indicator_core::Indicator, extra: &[(&str, ParamValue)]) -> Params {
    let mut supplied = Params::new();
    for (key, value) in extra {
        supplied.insert((*key).to_string(), value.clone());
    }
    merge_defaults(indicator.meta().params, &supplied)
}

fn measure(
    indicator_id: &'static str,
    variant: &'static str,
    bars: usize,
    runs: usize,
    extra: &[(&str, ParamValue)],
    threshold_ms: f64,
) -> CaseResult {
    let data = synthetic(bars, 42);
    let view = OhlcvView::new(
        &data.open, &data.high, &data.low, &data.close, &data.volume, &data.amount,
    );
    let indicator = lookup(indicator_id).expect("指标必须已注册");
    let params = params(indicator, extra);
    let mut out = vec![vec![0.0_f64; bars]; indicator.meta().outputs.len()];

    // 预热：避免首次分配/分支预测干扰。
    for _ in 0..10 {
        indicator.calc(&view, &params, &mut out).expect("基准只测已实现指标");
    }

    let mut samples = Vec::with_capacity(runs);
    for _ in 0..runs {
        let started = Instant::now();
        indicator.calc(black_box(&view), &params, &mut out).expect("基准只测已实现指标");
        samples.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());

    let p50 = samples[samples.len() * 50 / 100];
    let p95 = samples[(samples.len() * 95 / 100).min(samples.len() - 1)];
    let max = *samples.last().unwrap();
    let verdict = if cfg!(debug_assertions) {
        "debug-unchecked"
    } else if p95 <= threshold_ms {
        "pass"
    } else {
        "fail"
    };

    CaseResult {
        indicator_id,
        variant,
        bars,
        runs,
        p50_ms: round3(p50),
        p95_ms: round3(p95),
        max_ms: round3(max),
        threshold_ms,
        verdict,
    }
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn machine_info() -> MachineInfo {
    MachineInfo {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        cpu: Command::new("sysctl")
            .args(["-n", "machdep.cpu.brand_string"])
            .output()
            .ok()
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| "unknown".to_string()),
        rustc: Command::new("rustc")
            .arg("-V")
            .output()
            .ok()
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .map(|text| text.trim().to_string())
            .unwrap_or_else(|| "unknown".to_string()),
        profile: if cfg!(debug_assertions) { "debug" } else { "release" },
        engine_version: ENGINE_VERSION,
        bench_version: env!("CARGO_PKG_VERSION"),
    }
}

#[cfg(target_os = "macos")]
fn peak_rss_bytes() -> u64 {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    usage.ru_maxrss as u64
}

#[cfg(not(target_os = "macos"))]
fn peak_rss_bytes() -> u64 {
    0
}

fn main() {
    let mut cases = Vec::new();
    let period20 = [("period", ParamValue::Int(20))];

    for (bars, runs, threshold) in [(520usize, 200usize, THRESHOLD_P95_MS_520), (2500, 100, THRESHOLD_P95_MS_2500)] {
        cases.push(measure("T01", "sma20", bars, runs, &period20, threshold));
        cases.push(measure("T02", "ema20", bars, runs, &period20, threshold));
        cases.push(measure("T03", "wma20", bars, runs, &period20, threshold));
        cases.push(measure("T04", "dema20", bars, runs, &period20, threshold));
        cases.push(measure("T05", "tema20", bars, runs, &period20, threshold));
        cases.push(measure("T19", "linregForecast20", bars, runs, &period20, threshold));
        cases.push(measure("T20", "linregIntercept20", bars, runs, &period20, threshold));
        cases.push(measure("T21", "linregR2_20", bars, runs, &period20, threshold));
        cases.push(measure("T22", "linregSlope20", bars, runs, &period20, threshold));
        cases.push(measure("E13", "bias6/12/24", bars, runs, &[], threshold));
        cases.push(measure(MACD_ID, "macd12/26/9", bars, runs, &[], threshold));
    }

    let mut bin_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    bin_dir.pop();
    bin_dir.pop();
    let out_dir = bin_dir.join("bench/baselines");
    let out_path = out_dir.join(format!("macos-{}.json", std::env::consts::ARCH));
    std::fs::create_dir_all(&out_dir).expect("创建 bench/baselines 失败");

    let baseline = Baseline {
        schema_version: 1,
        generated_at_unix: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
        machine: machine_info(),
        iterations: 200,
        peak_rss_bytes: peak_rss_bytes(),
        thresholds: Thresholds {
            p95_ms_at_520_bars: THRESHOLD_P95_MS_520,
            p95_ms_at_2500_bars: THRESHOLD_P95_MS_2500,
            note: "S0 判定阈值；只在 release 下判 pass/fail，debug 记为 debug-unchecked",
        },
        cases,
    };

    let text = serde_json::to_string_pretty(&baseline).expect("序列化基线失败");
    std::fs::write(&out_path, text).expect("写基线失败");

    println!("baseline -> {}", out_path.display());
    for case in &baseline.cases {
        println!(
            "{:<6} {:<12} {:>5} bars  p50 {:>7.3}ms  p95 {:>7.3}ms  {}",
            case.indicator_id, case.variant, case.bars, case.p50_ms, case.p95_ms, case.verdict
        );
    }
    println!("peakRSS {} bytes ({})", baseline.peak_rss_bytes, baseline.machine.cpu);
}
