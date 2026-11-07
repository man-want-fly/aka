//! 结构化埋点（TD-S0-04 / 05 / 06 / 07 清偿）。
//!
//! 七类事件（名称冻结，QA 按名字过滤）：
//! - `indicator.compute`：一次真实计算，含 `computeMs` / `cacheHit=false` / 上下文键；
//! - `compute.count`：一次请求实际执行的计算条数（去重后）；
//! - `compute.skip`：一次请求内因「同键去重」被跳过、复用已有结果的实例数；
//! - `cache.hit` / `cache.miss`：按指标缓存键判定的单指标命中情况；
//! - `indicator.cold_ms`：冷计算耗时样本（P95 由 `Telemetry::cold_p95_ms` 计算）；
//! - `param.debounce`：前端防抖参数（`inputGapMs=40`、`quietMs=120`）与触发结果；
//! - `value.indefinite`：指标输出为 ±Infinity（`code=E_INDEFINITE`），返回前已转 `None`。
//!
//! 事件同时写入内存环形队列（供 IPC 导出）与可选 JSONL 文件（`logs/telemetry.jsonl`）。
//! 文件写失败不阻断业务：埋点是旁路，不能把计算请求拖挂。

use std::collections::{BTreeMap, VecDeque};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{Map, Value};

pub const EVENT_INDICATOR_COMPUTE: &str = "indicator.compute";
pub const EVENT_COMPUTE_COUNT: &str = "compute.count";
pub const EVENT_COMPUTE_SKIP: &str = "compute.skip";
pub const EVENT_CACHE_HIT: &str = "cache.hit";
pub const EVENT_CACHE_MISS: &str = "cache.miss";
pub const EVENT_COLD_MS: &str = "indicator.cold_ms";
pub const EVENT_PARAM_DEBOUNCE: &str = "param.debounce";
/// 指标输出出现 ±Infinity（无法定义）时记一次；值在返回前统一转 `None`，不落盘、不画线。
pub const EVENT_INDEFINITE: &str = "value.indefinite";

const RING_CAPACITY: usize = 4_096;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryEvent {
    pub ts_ms: i64,
    pub name: String,
    pub fields: Map<String, Value>,
}

#[derive(Debug, Default)]
struct Inner {
    total: u64,
    counts: BTreeMap<String, u64>,
    cold_ms: Vec<f64>,
    events: VecDeque<TelemetryEvent>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySummary {
    pub path: Option<String>,
    pub total: u64,
    pub counts: BTreeMap<String, u64>,
    pub cold_samples: usize,
    pub cold_p95_ms: Option<f64>,
    pub recent: Vec<TelemetryEvent>,
}

pub struct Telemetry {
    inner: Mutex<Inner>,
    log_path: Option<PathBuf>,
    /// 复用同一个追加句柄：`emit` 是热路径（一次请求 40+ 条事件），逐条 `open/close` 在
    /// dev 构建下实测占 6ms（TD-S0-07 微基准 ⑦b）。句柄延迟打开，写失败时保持为空、下条重试。
    log_file: Mutex<Option<std::fs::File>>,
}

impl Default for Telemetry {
    fn default() -> Self {
        Self::in_memory()
    }
}

impl Telemetry {
    pub fn in_memory() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            log_path: None,
            log_file: Mutex::new(None),
        }
    }

    /// 追加写 JSONL；目录不存在时自动创建。
    pub fn with_log_path(path: PathBuf) -> Self {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        Self {
            inner: Mutex::new(Inner::default()),
            log_path: Some(path),
            log_file: Mutex::new(None),
        }
    }

    pub fn log_path(&self) -> Option<&std::path::Path> {
        self.log_path.as_deref()
    }

    pub fn emit(&self, name: &'static str, fields: Vec<(&'static str, Value)>) {
        let fields = fields
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect();
        self.emit_dynamic(name, fields);
    }

    /// 前端指定事件名的埋点（如 `switch.period_ms`）；字段键值同 JSON Map。
    pub fn emit_dynamic(&self, name: &str, fields: Map<String, Value>) {
        let event = TelemetryEvent {
            ts_ms: now_ms(),
            name: name.to_string(),
            fields,
        };

        if let Some(path) = &self.log_path {
            let line = serde_json::to_string(&event)
                .map(|json| format!("{json}\n"))
                .unwrap_or_default();
            if let Ok(mut sink) = self.log_file.lock() {
                if sink.is_none() {
                    *sink = OpenOptions::new().create(true).append(true).open(path).ok();
                }
                if let Some(file) = sink.as_mut() {
                    let _ = file.write_all(line.as_bytes());
                }
            }
        }

        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        inner.total += 1;
        *inner.counts.entry(event.name.clone()).or_insert(0) += 1;
        if inner.events.len() == RING_CAPACITY {
            inner.events.pop_front();
        }
        inner.events.push_back(event);
    }

    /// 记录一次冷计算耗时；样本上限 5_000，避免长跑进程无界增长。
    pub fn record_cold_ms(&self, ms: f64, fields: Vec<(&'static str, Value)>) {
        self.emit(
            EVENT_COLD_MS,
            fields.into_iter().chain([("coldMs", Value::from(round2(ms)))]).collect(),
        );
        if let Ok(mut inner) = self.inner.lock() {
            if inner.cold_ms.len() >= 5_000 {
                inner.cold_ms.remove(0);
            }
            inner.cold_ms.push(ms);
        }
    }

    /// 最近邻 P95（升序第 `ceil(0.95n)-1` 个样本）。
    pub fn cold_p95_ms(&self) -> Option<f64> {
        let Ok(inner) = self.inner.lock() else {
            return None;
        };
        p95(&inner.cold_ms)
    }

    pub fn summary(&self, recent: usize) -> TelemetrySummary {
        let inner = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        let start = inner.events.len().saturating_sub(recent);
        TelemetrySummary {
            path: self.log_path.as_ref().map(|path| path.display().to_string()),
            total: inner.total,
            counts: inner.counts.clone(),
            cold_samples: inner.cold_ms.len(),
            cold_p95_ms: p95(&inner.cold_ms),
            recent: inner.events.iter().skip(start).cloned().collect(),
        }
    }

    pub fn events(&self) -> Vec<TelemetryEvent> {
        let inner = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        inner.events.iter().cloned().collect()
    }

    pub fn clear(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        inner.total = 0;
        inner.counts.clear();
        inner.cold_ms.clear();
        inner.events.clear();
    }
}

fn p95(samples: &[f64]) -> Option<f64> {
    if samples.is_empty() {
        return None;
    }
    let mut sorted = samples.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let rank = ((sorted.len() as f64) * 0.95).ceil() as usize;
    let index = rank.saturating_sub(1).min(sorted.len() - 1);
    Some(round2(sorted[index]))
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 参数防抖策略（前端 120ms + 上游键盘 40ms 场景的可测版本）。
///
/// 语义：每次 `note_input` 刷新静默计时；静默 ≥ `quiet_ms` 后 `should_fire` 恰好返回一次 true。
/// 时间戳由调用方传入，单测可用虚拟时钟，不依赖真实 sleep。
#[derive(Debug, Clone)]
pub struct ParamDebouncer {
    quiet_ms: i64,
    last_input_ms: Option<i64>,
    inputs: u64,
    fired: bool,
}

pub const DEFAULT_DEBOUNCE_QUIET_MS: i64 = 120;
pub const TYPICAL_INPUT_GAP_MS: i64 = 40;

impl Default for ParamDebouncer {
    fn default() -> Self {
        Self::new(DEFAULT_DEBOUNCE_QUIET_MS)
    }
}

impl ParamDebouncer {
    pub fn new(quiet_ms: i64) -> Self {
        Self {
            quiet_ms: quiet_ms.max(1),
            last_input_ms: None,
            inputs: 0,
            fired: true,
        }
    }

    pub fn quiet_ms(&self) -> i64 {
        self.quiet_ms
    }

    pub fn input_count(&self) -> u64 {
        self.inputs
    }

    pub fn note_input(&mut self, now_ms: i64) {
        self.last_input_ms = Some(now_ms);
        self.inputs += 1;
        self.fired = false;
    }

    pub fn should_fire(&mut self, now_ms: i64) -> bool {
        match self.last_input_ms {
            Some(last) if !self.fired && now_ms - last >= self.quiet_ms => {
                self.fired = true;
                true
            }
            _ => false,
        }
    }

    pub fn reset(&mut self) {
        self.last_input_ms = None;
        self.inputs = 0;
        self.fired = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thirty_cold_samples_produce_p95() {
        let telemetry = Telemetry::in_memory();
        for index in 0..30 {
            telemetry.record_cold_ms(index as f64, vec![("indicatorId", Value::from("T01"))]);
        }
        // 30 个样本升序后第 ceil(28.5)=29 个 = 28.0
        assert_eq!(telemetry.cold_p95_ms(), Some(28.0));
        let summary = telemetry.summary(0);
        assert_eq!(summary.cold_samples, 30);
        assert_eq!(summary.counts.get(EVENT_COLD_MS), Some(&30));
    }

    #[test]
    fn debounce_fires_once_after_120ms_quiet_with_40ms_inputs() {
        let mut debouncer = ParamDebouncer::default();
        debouncer.note_input(1_000);
        debouncer.note_input(1_040);
        debouncer.note_input(1_080);
        // 静默未满 120ms：不得触发。
        assert!(!debouncer.should_fire(1_100));
        assert!(!debouncer.should_fire(1_199));
        // 1_080 + 120 = 1_200 起触发，且仅一次。
        assert!(debouncer.should_fire(1_200));
        assert!(!debouncer.should_fire(1_300));
        assert_eq!(debouncer.input_count(), 3);
    }

    #[test]
    fn separate_bursts_fire_separately() {
        let mut debouncer = ParamDebouncer::default();
        debouncer.note_input(0);
        assert!(debouncer.should_fire(200));
        debouncer.note_input(400);
        assert!(!debouncer.should_fire(500));
        assert!(debouncer.should_fire(520));
    }

    #[test]
    fn jsonl_sink_appends_machine_readable_events() {
        let dir = std::env::temp_dir().join("aka-telemetry-test");
        let path = dir.join("telemetry.jsonl");
        let _ = std::fs::remove_file(&path);
        let telemetry = Telemetry::with_log_path(path.clone());
        telemetry.emit(EVENT_CACHE_HIT, vec![("cacheKey", Value::from("k1"))]);
        telemetry.emit(EVENT_COMPUTE_COUNT, vec![("count", Value::from(1))]);
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        let first: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["name"], EVENT_CACHE_HIT);
        assert_eq!(first["fields"]["cacheKey"], "k1");
        std::fs::remove_dir_all(&dir).ok();
    }
}
