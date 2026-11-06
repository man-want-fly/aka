//! 黄金夹具（dev-only）：格式冻结 + MA/MACD 基线 + 边界用例。
//!
//! 夹具是**固定文件**，期望值由 `fixtures/gen_reference.py` 按公开公式手算写入，
//! 不从 Rust 引擎回填，避免「用实现验证实现」。
//!
//! 运行：`cargo test -p indicator-golden -- --nocapture`
//! 重新生成基线（只在确认公式变更后才允许）：
//! `python3 crates/indicator-golden/fixtures/gen_reference.py`

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use indicator_core::{lookup, merge_defaults, validate, OhlcvView, ParamValue, Params};
use serde::{Deserialize, Serialize};

/// 夹具格式版本；字段或语义变化时必须加 1，并同步更新 README。
pub const FORMAT_VERSION: u32 = 1;
/// 价格/金额：相对容差；振荡/比率：绝对容差；计数：必须完全相等。
pub const PRICE_TOLERANCE: f64 = 1e-6;
pub const OSCILLATOR_TOLERANCE: f64 = 1e-4;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoldenInput {
    pub open: Vec<f64>,
    pub high: Vec<f64>,
    pub low: Vec<f64>,
    pub close: Vec<f64>,
    pub volume: Vec<f64>,
    pub amount: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoldenCase {
    pub indicator_id: String,
    #[serde(default)]
    pub params: BTreeMap<String, ParamValue>,
    /// 与 `meta.outputs` 的 key 顺序一致
    pub outputs: Vec<String>,
    /// `relative:1e-6` / `absolute:1e-4` / `count`
    pub tolerance: String,
    /// key = 输出 key，value 长度 = 输入根数；null 表示该点缺失
    pub expected: BTreeMap<String, Vec<Option<f64>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoldenSuite {
    pub format_version: u32,
    pub name: String,
    pub seed: u64,
    pub bars: usize,
    /// 容差适用条件说明；生成器写入，测试断言非空且覆盖全部容差类别
    #[serde(default)]
    pub tolerance_rules: String,
    pub input: GoldenInput,
    pub cases: Vec<GoldenCase>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GoldenFailure {
    pub case: String,
    pub output: String,
    pub bar_index: usize,
    pub expected: f64,
    pub got: f64,
}

impl std::fmt::Display for GoldenFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} / {} 第 {} 根：期望 {}，实际 {}",
            self.case, self.output, self.bar_index, self.expected, self.got
        )
    }
}

impl std::error::Error for GoldenFailure {}

#[derive(Debug, Default)]
pub struct GoldenReport {
    pub total: usize,
    pub failures: Vec<String>,
}

impl GoldenReport {
    pub fn passed(&self) -> usize {
        self.total - self.failures.len()
    }

    /// 机器可读的一行结论，供 CI 直接 grep。
    pub fn summary(&self) -> String {
        format!(
            "golden: {}/{} passed{}",
            self.passed(),
            self.total,
            if self.failures.is_empty() {
                String::new()
            } else {
                format!("，首个失败：{}", self.failures[0])
            }
        )
    }
}

#[derive(Debug, Clone, Copy)]
pub enum Tolerance {
    Relative(f64),
    Absolute(f64),
    Count,
}

impl Tolerance {
    pub fn parse(text: &str) -> Result<Self, String> {
        if text == "count" {
            return Ok(Self::Count);
        }
        let (kind, value) = text
            .split_once(':')
            .ok_or_else(|| format!("容差写法非法：{text}（应为 relative:1e-6 / absolute:1e-4 / count）"))?;
        let value = value
            .parse::<f64>()
            .map_err(|_| format!("容差数值非法：{text}"))?;
        match kind {
            "relative" => Ok(Self::Relative(value)),
            "absolute" => Ok(Self::Absolute(value)),
            _ => Err(format!("未知容差类型：{kind}")),
        }
    }

    fn accepts(self, expected: f64, got: f64) -> bool {
        match self {
            Self::Relative(tol) => (expected - got).abs() <= tol * expected.abs().max(1.0),
            Self::Absolute(tol) => (expected - got).abs() <= tol,
            Self::Count => expected == got,
        }
    }
}

impl GoldenSuite {
    /// 删除基线后必须显式失败，并指向生成命令，绝不静默通过。
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = fs::read_to_string(path)
            .map_err(|err| format!("读取夹具失败 {}：{err}；请先运行 python3 crates/indicator-golden/fixtures/gen_reference.py", path.display()))?;
        let suite: Self = serde_json::from_str(&text)
            .map_err(|err| format!("夹具 JSON 非法 {}：{err}", path.display()))?;
        if suite.format_version != FORMAT_VERSION {
            return Err(format!(
                "夹具格式版本 {} 与冻结版本 {} 不一致：{}",
                suite.format_version, FORMAT_VERSION, path.display()
            ));
        }
        Ok(suite)
    }

    pub fn run(&self) -> GoldenReport {
        let mut report = GoldenReport::default();
        for case in &self.cases {
            report.total += 1;
            if let Err(err) = case.run(&self.input) {
                report.failures.push(err);
            }
        }
        report
    }
}

impl GoldenCase {
    pub fn run(&self, input: &GoldenInput) -> Result<(), String> {
        let indicator = lookup(&self.indicator_id)
            .ok_or_else(|| format!("{}：未注册指标 {}", self.indicator_id, self.indicator_id))?;
        let meta = indicator.meta();
        let params: Params = merge_defaults(meta.params, &self.params);
        validate(meta.params, &params).map_err(|err| err.to_string())?;
        let tolerance = Tolerance::parse(&self.tolerance)?;

        let len = input.close.len();
        let view = OhlcvView::new(
            &input.open, &input.high, &input.low, &input.close, &input.volume, &input.amount,
        );
        if !view.columns_are_aligned() {
            return Err(format!("{}：夹具各列长度不一致", self.indicator_id));
        }

        let mut out = vec![vec![f64::NAN; len]; meta.outputs.len()];
        indicator
            .calc(&view, &params, &mut out)
            .map_err(|err| err.to_string())?;

        if self.outputs.len() != meta.outputs.len() {
            return Err(format!(
                "{}：fixture 声明 {} 个输出，注册表声明 {} 个",
                self.indicator_id,
                self.outputs.len(),
                meta.outputs.len()
            ));
        }

        for (output_index, spec) in meta.outputs.iter().enumerate() {
            let key = &self.outputs[output_index];
            if key != &spec.key {
                return Err(format!(
                    "{}：输出顺序不一致，第 {output_index} 个应为 {}，fixture 写的是 {key}",
                    self.indicator_id, spec.key
                ));
            }
            let expected = self
                .expected
                .get(key)
                .ok_or_else(|| format!("{}：缺少输出 {key} 的期望值", self.indicator_id))?;
            if expected.len() != len {
                return Err(format!("{}：输出 {key} 长度与输入不一致", self.indicator_id));
            }
            for (bar_index, want) in expected.iter().enumerate() {
                let got = out[output_index][bar_index];
                match (want, got.is_finite()) {
                    (None, false) => {}
                    (Some(want), true) if tolerance.accepts(*want, got) => {}
                    (Some(want), true) => {
                        return Err(GoldenFailure {
                            case: self.indicator_id.clone(),
                            output: key.clone(),
                            bar_index,
                            expected: *want,
                            got,
                        }
                        .to_string())
                    }
                    _ => {
                        return Err(format!(
                            "{} / {key} 第 {bar_index} 根：缺失状态不一致（期望 {}，实际 {}）",
                            self.indicator_id,
                            if want.is_some() { "有值" } else { "null" },
                            if got.is_finite() { "有值" } else { "null" },
                        ))
                    }
                }
            }
        }
        Ok(())
    }
}

pub fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

/// 装载 `fixtures/*.json`（按文件名排序，报告顺序稳定）。
pub fn load_all() -> Result<Vec<GoldenSuite>, String> {
    let dir = fixture_dir();
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .map_err(|err| {
            format!(
                "夹具目录不存在 {}：{err}；请运行 python3 crates/indicator-golden/fixtures/gen_reference.py",
                dir.display()
            )
        })?
        .filter_map(|entry| entry.ok().map(|item| item.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    if files.is_empty() {
        return Err(format!(
            "没有找到夹具文件 {}/*.json；请运行 python3 crates/indicator-golden/fixtures/gen_reference.py",
            dir.display()
        ));
    }
    files.iter().map(|path| GoldenSuite::load(path)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_committed_fixtures_pass() {
        let suites = load_all().expect("夹具应可装载");
        let mut report = GoldenReport::default();
        for suite in &suites {
            let mut current = suite.run();
            report.total += current.total;
            report.failures.append(&mut current.failures);
        }
        println!("{}", report.summary());
        assert!(
            report.failures.is_empty(),
            "{}",
            report.summary()
        );
    }

    #[test]
    fn tolerance_rules_are_frozen() {
        // 与 docs/indicators/b1-trend-kernels.md「容差口径」逐条一致；文档改了这里必须同步。
        // 允许手算类夹具把单个 case 收紧到 absolute:1e-9（比任何类别默认都更严），但不允许放宽。
        let suites = load_all().expect("夹具应可装载");
        let mut checked = 0;
        let mut tightened = 0;
        for suite in &suites {
            assert!(
                suite.tolerance_rules.contains("relative:1e-6")
                    && suite.tolerance_rules.contains("absolute:1e-6")
                    && suite.tolerance_rules.contains("absolute:1e-4")
                    && suite.tolerance_rules.contains("absolute:1e-9")
                    && suite.tolerance_rules.contains("count"),
                "{} 缺少容差适用条件说明（应覆盖 relative:1e-6 / absolute:1e-6 / absolute:1e-4 / absolute:1e-9 / count）",
                suite.name
            );
            for case in &suite.cases {
                let expected = match case.indicator_id.as_str() {
                    "T21" => "absolute:1e-6",
                    "E13" | "M06" => "absolute:1e-4",
                    _ => "relative:1e-6",
                };
                if case.tolerance == "absolute:1e-9" {
                    assert!(
                        suite.name.starts_with("edge_manual") || suite.name.starts_with("edge_arithmetic"),
                        "{} 出现收紧容差 absolute:1e-9：收紧只允许用于手算夹具",
                        suite.name
                    );
                    tightened += 1;
                } else {
                    assert_eq!(
                        case.tolerance, expected,
                        "{} 的容差必须为 {expected}（夹具写的是 {}）",
                        case.indicator_id, case.tolerance
                    );
                }
                Tolerance::parse(&case.tolerance).expect("容差必须可解析");
                checked += 1;
            }
        }
        assert!(checked >= 40, "夹具覆盖过少：{checked}");
        assert!(tightened >= 4, "手算收紧容差覆盖过少：{tightened}");
    }

    #[test]
    fn missing_fixture_dir_fails_loudly() {
        let err = GoldenSuite::load(Path::new("/nonexistent/aka-golden.json")).unwrap_err();
        assert!(err.contains("gen_reference.py"));
    }

    #[test]
    fn tiny_deviation_is_reported_with_index() {
        let mut suite = load_all().unwrap().remove(0);
        let case = &mut suite.cases[0];
        let key = case.outputs[0].clone();
        let values = case.expected.get_mut(&key).unwrap();
        let index = values.iter().position(|value| value.is_some()).unwrap();
        let original = *values[index].as_ref().unwrap();
        values[index] = Some(original + 1e-3);
        let err = case.run(&suite.input).unwrap_err();
        assert!(err.contains(&index.to_string()), "错误应给出首个偏差下标：{err}");
    }

    #[test]
    fn tolerance_parsing_semantics() {
        assert!(Tolerance::parse("relative:1e-6").unwrap().accepts(100.0, 100.00009));
        assert!(!Tolerance::parse("relative:1e-6").unwrap().accepts(100.0, 100.001));
        assert!(Tolerance::parse("absolute:1e-4").unwrap().accepts(0.00005, 0.00014));
        assert!(!Tolerance::parse("count").unwrap().accepts(3.0, 3.000001));
        assert!(Tolerance::parse("median:1").is_err());
    }
}
