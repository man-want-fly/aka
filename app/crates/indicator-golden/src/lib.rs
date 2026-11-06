//! 黄金用例骨架（dev-only）：只定义夹具格式与比对器，不接入正式应用。
//! TODO(sprint-indicator-1)：为 105 个指标生成夹具与容差表，并由 CI 全量执行。

use std::collections::BTreeMap;

use indicator_core::{lookup, merge_defaults, validate, OhlcvView, ParamValue, Params};
use serde::{Deserialize, Serialize};

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
    pub input: GoldenInput,
    /// 与 `meta.outputs` 顺序一致；null 表示该点缺失
    pub expected: Vec<Vec<Option<f64>>>,
    #[serde(default = "default_tolerance")]
    pub tolerance: f64,
}

fn default_tolerance() -> f64 {
    1e-6
}

#[derive(Debug, Clone, PartialEq)]
pub struct GoldenFailure {
    pub output_index: usize,
    pub bar_index: usize,
    pub expected: f64,
    pub got: f64,
}

impl std::fmt::Display for GoldenFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "输出[{}] 第 {} 根：期望 {}，实际 {}",
            self.output_index, self.bar_index, self.expected, self.got
        )
    }
}

impl std::error::Error for GoldenFailure {}

impl GoldenCase {
    pub fn from_json(text: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(text)
    }

    /// 用注册表里的指标跑一遍夹具并比对；缺失值按「双方都缺」判定。
    pub fn run(&self) -> Result<(), String> {
        let indicator = lookup(&self.indicator_id)
            .ok_or_else(|| format!("未注册指标：{}", self.indicator_id))?;
        let meta = indicator.meta();
        let params: Params = merge_defaults(meta.params, &self.params);
        validate(meta.params, &params).map_err(|err| err.to_string())?;

        let len = self.input.close.len();
        let view = OhlcvView::new(
            &self.input.open,
            &self.input.high,
            &self.input.low,
            &self.input.close,
            &self.input.volume,
            &self.input.amount,
        );
        if !view.columns_are_aligned() {
            return Err("夹具各列长度不一致".to_string());
        }

        let mut out = vec![vec![f64::NAN; len]; meta.outputs.len()];
        indicator
            .calc(&view, &params, &mut out)
            .map_err(|err| err.to_string())?;

        if self.expected.len() != out.len() {
            return Err(format!(
                "期望输出 {} 组，注册表声明 {} 组",
                self.expected.len(),
                out.len()
            ));
        }

        for (output_index, expected) in self.expected.iter().enumerate() {
            if expected.len() != len {
                return Err(format!("输出[{output_index}] 长度与输入不一致"));
            }
            for (bar_index, want) in expected.iter().enumerate() {
                let got = out[output_index][bar_index];
                match (want, got.is_finite()) {
                    (None, false) => {}
                    (Some(want), true) => {
                        if (want - got).abs() > self.tolerance {
                            return Err(GoldenFailure {
                                output_index,
                                bar_index,
                                expected: *want,
                                got,
                            }
                            .to_string());
                        }
                    }
                    _ => {
                        return Err(format!(
                            "输出[{output_index}] 第 {bar_index} 根缺失状态不一致"
                        ));
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_case_is_reported() {
        let case = GoldenCase {
            indicator_id: "not-exist".into(),
            params: BTreeMap::new(),
            input: GoldenInput {
                open: vec![1.0],
                high: vec![1.0],
                low: vec![1.0],
                close: vec![1.0],
                volume: vec![1.0],
                amount: vec![1.0],
            },
            expected: vec![],
            tolerance: 1e-6,
        };
        assert!(case.run().is_err());
    }
}
