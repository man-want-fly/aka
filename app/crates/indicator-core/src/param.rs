use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

/// 参数的单一事实来源：范围、默认值、步长只在这里定义。
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ParamSpec {
    Int {
        key: &'static str,
        label: &'static str,
        min: i64,
        max: i64,
        default: i64,
        step: i64,
    },
    Float {
        key: &'static str,
        label: &'static str,
        min: f64,
        max: f64,
        default: f64,
        step: f64,
        unit: Option<&'static str>,
    },
    Enum {
        key: &'static str,
        label: &'static str,
        variants: &'static [&'static str],
        default: &'static str,
    },
    Bool {
        key: &'static str,
        label: &'static str,
        default: bool,
    },
}

impl ParamSpec {
    pub fn key(&self) -> &'static str {
        match self {
            ParamSpec::Int { key, .. }
            | ParamSpec::Float { key, .. }
            | ParamSpec::Enum { key, .. }
            | ParamSpec::Bool { key, .. } => key,
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            ParamSpec::Int { label, .. }
            | ParamSpec::Float { label, .. }
            | ParamSpec::Enum { label, .. }
            | ParamSpec::Bool { label, .. } => label,
        }
    }

    pub fn default_value(&self) -> ParamValue {
        match self {
            ParamSpec::Int { default, .. } => ParamValue::Int(*default),
            ParamSpec::Float { default, .. } => ParamValue::Float(*default),
            ParamSpec::Enum { default, .. } => ParamValue::Text((*default).to_string()),
            ParamSpec::Bool { default, .. } => ParamValue::Bool(*default),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ParamValue {
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
}

impl ParamValue {
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            ParamValue::Int(v) => Some(*v as f64),
            ParamValue::Float(v) => Some(*v),
            _ => None,
        }
    }
}

pub type Params = BTreeMap<String, ParamValue>;

#[derive(Debug, Clone, PartialEq)]
pub struct ParamError {
    pub field: String,
    pub message: String,
}

impl fmt::Display for ParamError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "参数 {} 不合法：{}", self.field, self.message)
    }
}

impl std::error::Error for ParamError {}

pub fn merge_defaults(specs: &[ParamSpec], supplied: &Params) -> Params {
    let mut out = Params::new();
    for spec in specs {
        let key = spec.key();
        let value = supplied
            .get(key)
            .cloned()
            .unwrap_or_else(|| spec.default_value());
        out.insert(key.to_string(), value);
    }
    out
}

/// 校验已补齐默认值的参数。未知 key 直接拒绝，避免前端拼写错误静默生效。
pub fn validate(specs: &[ParamSpec], params: &Params) -> Result<(), ParamError> {
    for key in params.keys() {
        if !specs.iter().any(|s| s.key() == key) {
            return Err(ParamError {
                field: key.clone(),
                message: "未知参数".to_string(),
            });
        }
    }

    for spec in specs {
        let key = spec.key();
        let Some(value) = params.get(key) else {
            return Err(ParamError {
                field: key.to_string(),
                message: "缺少参数".to_string(),
            });
        };

        match spec {
            ParamSpec::Int { min, max, .. } => {
                let Some(v) = value_to_int(value) else {
                    return Err(ParamError {
                        field: key.to_string(),
                        message: "需要整数".to_string(),
                    });
                };
                if v < *min || v > *max {
                    return Err(ParamError {
                        field: key.to_string(),
                        message: format!("需在 {min}~{max} 之间，当前 {v}"),
                    });
                }
            }
            ParamSpec::Float { min, max, .. } => {
                let Some(v) = value.as_f64() else {
                    return Err(ParamError {
                        field: key.to_string(),
                        message: "需要数值".to_string(),
                    });
                };
                if !v.is_finite() || v < *min || v > *max {
                    return Err(ParamError {
                        field: key.to_string(),
                        message: format!("需在 {min}~{max} 之间，当前 {v}"),
                    });
                }
            }
            ParamSpec::Enum { variants, .. } => {
                let ParamValue::Text(v) = value else {
                    return Err(ParamError {
                        field: key.to_string(),
                        message: "需要枚举文本".to_string(),
                    });
                };
                if !variants.iter().any(|item| item == v) {
                    return Err(ParamError {
                        field: key.to_string(),
                        message: format!("需为 {:?} 之一，当前 {v}", variants),
                    });
                }
            }
            ParamSpec::Bool { .. } => {
                if !matches!(value, ParamValue::Bool(_)) {
                    return Err(ParamError {
                        field: key.to_string(),
                        message: "需要布尔值".to_string(),
                    });
                }
            }
        }
    }
    Ok(())
}

fn value_to_int(value: &ParamValue) -> Option<i64> {
    match value {
        ParamValue::Int(v) => Some(*v),
        ParamValue::Float(v) if v.fract() == 0.0 => Some(*v as i64),
        _ => None,
    }
}

pub fn param_int(params: &Params, key: &str) -> Option<i64> {
    params.get(key).and_then(value_to_int)
}

pub fn param_text<'a>(params: &'a Params, key: &str) -> Option<&'a str> {
    match params.get(key) {
        Some(ParamValue::Text(v)) => Some(v.as_str()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPECS: &[ParamSpec] = &[ParamSpec::Int {
        key: "period",
        label: "周期",
        min: 2,
        max: 200,
        default: 20,
        step: 1,
    }];

    #[test]
    fn defaults_and_validation() {
        let merged = merge_defaults(SPECS, &Params::new());
        assert_eq!(param_int(&merged, "period"), Some(20));
        assert!(validate(SPECS, &merged).is_ok());

        let mut bad = Params::new();
        bad.insert("period".into(), ParamValue::Int(1));
        assert!(validate(SPECS, &bad).is_err());
    }

    #[test]
    fn unknown_key_is_rejected() {
        let mut params = Params::new();
        params.insert("period".into(), ParamValue::Int(20));
        params.insert("typo".into(), ParamValue::Int(3));
        assert!(validate(SPECS, &params).is_err());
    }
}
