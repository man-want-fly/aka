//! 数据集 manifest 契约（Sprint 0 / QA T-05）。
//!
//! 9 个字段冻结：`dataset_id`、`data_version`、`row_count`、`coverage_start`、
//! `coverage_end`、`seed`、`sha256`、`provider`、`generated_at`。
//!
//! 生成规则：
//! - `dataset_id = "{provider}-{seed}-{coverage_start}_{coverage_end}-{row_count}-{data_version}-{sha256[..8]}"`
//!   不包含墙钟时间，保证「同 seed 同内容 → 同 id」幂等；`data_version` 承载重建代数。
//! - `sha256` = 对按 `date` 升序、字段顺序
//!   `date,open,high,low,close,volume,amount` 的规范 CSV 行计算的小写十六进制摘要。
//! - `provider` ∈ {`sim`, `real`}；重建 sim 数据集时 `data_version` +1，real 不变。
//!
//! 校验器只读：返回问题列表，绝不回写 manifest。

use serde::{Deserialize, Serialize};

use crate::date::Date;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatasetManifest {
    pub dataset_id: String,
    pub data_version: String,
    pub row_count: u64,
    pub coverage_start: String,
    pub coverage_end: String,
    pub seed: u64,
    pub sha256: String,
    pub provider: String,
    pub generated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestIssue {
    pub field: &'static str,
    pub message: String,
}

impl ManifestIssue {
    fn new(field: &'static str, message: impl Into<String>) -> Self {
        Self {
            field,
            message: message.into(),
        }
    }
}

impl DatasetManifest {
    /// 由内容事实派生 manifest（生成器与校验器共用同一规则）。
    pub fn build(
        provider: &str,
        seed: u64,
        coverage_start: &str,
        coverage_end: &str,
        row_count: u64,
        data_version: &str,
        sha256: &str,
        generated_at: i64,
    ) -> Self {
        let short = sha256.get(..8).unwrap_or(sha256);
        let dataset_id = format!(
            "{provider}-{seed}-{coverage_start}_{coverage_end}-{row_count}-{data_version}-{short}"
        );
        Self {
            dataset_id,
            data_version: data_version.to_string(),
            row_count,
            coverage_start: coverage_start.to_string(),
            coverage_end: coverage_end.to_string(),
            seed,
            sha256: sha256.to_string(),
            provider: provider.to_string(),
            generated_at,
        }
    }

    /// 重建代数：从 `data_version = v<N>...` 解析；`v1` → 1，`v2.1` → 2。
    /// 用于 DTO 的 `dataset_generation`，避免把代数塞进 manifest 第 10 个字段。
    pub fn generation(&self) -> u64 {
        self.data_version
            .strip_prefix('v')
            .and_then(|tail| tail.split('.').next())
            .and_then(|head| head.parse::<u64>().ok())
            .unwrap_or(1)
    }

    /// 从 JSON 文本解析；缺字段/多字段/类型错都返回明确错误，不 panic。
    pub fn from_json(text: &str) -> Result<Self, ManifestIssue> {
        serde_json::from_str::<Self>(text)
            .map_err(|err| ManifestIssue::new("(root)", format!("manifest 解析失败：{err}")))
    }

    /// 语义校验 + 与实际数据集交叉核对（行数、sha256）。
    pub fn validate(&self, actual_row_count: u64, actual_sha256: &str) -> Result<(), Vec<ManifestIssue>> {
        let mut issues = Vec::new();

        if !matches!(self.provider.as_str(), "sim" | "real") {
            issues.push(ManifestIssue::new("provider", "必须是 sim 或 real"));
        }
        if self.row_count == 0 {
            issues.push(ManifestIssue::new("row_count", "不能为 0"));
        }
        if self.seed == 0 {
            issues.push(ManifestIssue::new("seed", "必须显式给出非 0 seed"));
        }
        if !(self.sha256.len() == 64
            && self
                .sha256
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()))
        {
            issues.push(ManifestIssue::new("sha256", "必须是 64 位小写十六进制"));
        }
        if !matches!(
            Date::parse(&self.coverage_start),
            Some(_)
        ) || !matches!(Date::parse(&self.coverage_end), Some(_))
        {
            issues.push(ManifestIssue::new("coverage", "起止日必须是严格 ISO 日期 YYYY-MM-DD"));
        } else if self.coverage_start > self.coverage_end {
            issues.push(ManifestIssue::new("coverage", "coverageStart 不能晚于 coverageEnd"));
        }
        if self.data_version.is_empty() || !self.data_version.starts_with('v') {
            issues.push(ManifestIssue::new("dataVersion", "建议使用 v<N> 形式"));
        }
        if self.generated_at <= 0 {
            issues.push(ManifestIssue::new("generatedAt", "必须为正的 unix 秒"));
        }

        let expected_id = Self::build(
            &self.provider,
            self.seed,
            &self.coverage_start,
            &self.coverage_end,
            self.row_count,
            &self.data_version,
            &self.sha256,
            self.generated_at,
        )
        .dataset_id;
        if self.dataset_id != expected_id {
            issues.push(ManifestIssue::new(
                "datasetId",
                format!("与生成规则不一致：期望 {expected_id}，实际 {}", self.dataset_id),
            ));
        }

        if self.row_count != actual_row_count {
            issues.push(ManifestIssue::new(
                "rowCount",
                format!("manifest {} / 实际 {actual_row_count}", self.row_count),
            ));
        }
        if self.sha256 != actual_sha256 {
            issues.push(ManifestIssue::new(
                "sha256",
                "manifest 与实际数据集摘要不一致（不自动改写，请重建）",
            ));
        }

        if issues.is_empty() {
            Ok(())
        } else {
            Err(issues)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA_A: &str = "0000000000000000000000000000000000000000000000000000000000000001";
    const SHA_B: &str = "0000000000000000000000000000000000000000000000000000000000000002";

    fn manifest(seed: u64, sha: &str) -> DatasetManifest {
        DatasetManifest::build("sim", seed, "2015-01-05", "2024-12-31", 240_000, "v1", sha, 1_730_000_000)
    }

    #[test]
    fn two_seeds_differ_in_at_least_three_fields() {
        let a = manifest(42, SHA_A);
        let b = manifest(7, SHA_B);
        let diffs = [
            a.dataset_id != b.dataset_id,
            a.seed != b.seed,
            a.sha256 != b.sha256,
        ];
        assert_eq!(diffs.iter().filter(|d| **d).count(), 3);
    }

    #[test]
    fn generation_comes_from_data_version() {
        assert_eq!(manifest(42, SHA_A).generation(), 1);
        let rebuilt = DatasetManifest::build("sim", 42, "2015-01-05", "2024-12-31", 240_000, "v2", SHA_A, 1_730_000_001);
        assert_eq!(rebuilt.generation(), 2);
    }

    #[test]
    fn same_seed_and_content_is_idempotent() {
        let a = manifest(42, SHA_A);
        let b = manifest(42, SHA_A);
        assert_eq!(a.dataset_id, b.dataset_id);
    }

    #[test]
    fn tampered_row_count_is_reported_not_rewritten() {
        let mut m = manifest(42, SHA_A);
        let original = m.clone();
        m.row_count = 999;
        let issues = m.validate(240_000, SHA_A).unwrap_err();
        assert!(issues.iter().any(|i| i.field == "rowCount"));
        assert_eq!(m.row_count, 999, "校验器不得回写 manifest");
        assert_ne!(m, original);
    }

    #[test]
    fn missing_unknown_and_type_errors_are_explicit() {
        let missing = DatasetManifest::from_json(r#"{"datasetId":"x"}"#).unwrap_err();
        assert_eq!(missing.field, "(root)");
        assert!(missing.message.contains("missing field"), "{}", missing.message);

        let extra = DatasetManifest::from_json(
            r#"{"datasetId":"x","dataVersion":"v1","rowCount":1,"coverageStart":"2024-01-01",
               "coverageEnd":"2024-01-01","seed":1,"sha256":"aa","provider":"sim",
               "generatedAt":1,"unknownField":true}"#,
        )
        .unwrap_err();
        assert!(extra.message.contains("unknown field"), "{}", extra.message);

        let wrong_type = DatasetManifest::from_json(
            r#"{"datasetId":"x","dataVersion":"v1","rowCount":"1","coverageStart":"2024-01-01",
               "coverageEnd":"2024-01-01","seed":1,"sha256":"aa","provider":"sim",
               "generatedAt":1}"#,
        )
        .unwrap_err();
        assert!(wrong_type.message.contains("invalid type"), "{}", wrong_type.message);
    }
}
