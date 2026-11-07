//! 数据质量扫描（S-07.05-01）。
//!
//! 纯函数：只读输入，只标记不改写。6 项检查逐项给出命中数、基数、占比、
//! 处理方式与状态；数据缺失（如无 adj_factor）记为「失败」而不是 0 命中。

use data_provider::{BarRow, Board, Date, Security};

/// 6 项检查：顺序即报表顺序。
pub const QUALITY_CHECK_COUNT: usize = 6;
/// 涨跌幅异常容差（百分点）：板块上限 + 1%。
pub const PRICE_LIMIT_TOLERANCE_PCT: f64 = 1.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckStatus {
    Pass,
    Info,
    Warning,
    Failed,
}

impl CheckStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            CheckStatus::Pass => "pass",
            CheckStatus::Info => "info",
            CheckStatus::Warning => "warning",
            CheckStatus::Failed => "failed",
        }
    }
}

/// 每项检查的示例（最多 3 条），供 P9「查看示例」跳到单根 K 线。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QualityExample {
    pub security: String,
    pub date: String,
}

#[derive(Debug, Clone)]
pub struct QualityCheckRow {
    /// `MISSING` / `EX_RIGHTS` / `SUSPENDED` / `ZERO_VOLUME` / `PRICE_ANOMALY` / `ADJ_COVERAGE`
    pub key: &'static str,
    pub label_zh: &'static str,
    pub hits: i64,
    /// 检查基数：占比 = 命中数 ÷ 基数 × 100（1 位小数）
    pub base: i64,
    pub ratio_pct: f64,
    pub treatment: &'static str,
    pub status: CheckStatus,
    /// 检查自身无法执行时的错误码（该行不显示 0）
    pub error_code: Option<&'static str>,
    pub examples: Vec<QualityExample>,
}

#[derive(Debug, Clone)]
pub struct QualityScanResult {
    pub rows: Vec<QualityCheckRow>,
    /// 「通过」计数：0 命中的检查 + 信息项
    pub passed_count: usize,
}

/// 单个标的的扫描输入。`has_adjust_factors = false` 表示该数据源没有复权因子表。
#[derive(Debug, Clone)]
pub struct SecurityQualityInput {
    pub security: Security,
    pub bars: Vec<BarRow>,
    pub has_adjust_factors: bool,
}

fn ratio(hits: i64, base: i64) -> f64 {
    if base <= 0 {
        0.0
    } else {
        (hits as f64 / base as f64 * 1000.0).round() / 10.0
    }
}

fn board_limit_pct(board: Board) -> Option<f64> {
    match board {
        Board::ShMain | Board::SzMain => Some(10.0),
        Board::ChiNext | Board::Star => Some(20.0),
        Board::Index => None,
    }
}

fn is_suspended(row: &BarRow) -> bool {
    row.quality
        .iter()
        .any(|flag| matches!(flag, data_provider::QualityFlag::Suspended))
}

fn push_example(examples: &mut Vec<QualityExample>, security: &str, date: Date) {
    if examples.len() < 3 {
        examples.push(QualityExample {
            security: security.to_string(),
            date: date.iso(),
        });
    }
}

fn row(
    key: &'static str,
    label_zh: &'static str,
    hits: i64,
    base: i64,
    treatment: &'static str,
    status: CheckStatus,
    examples: Vec<QualityExample>,
    error_code: Option<&'static str>,
) -> QualityCheckRow {
    QualityCheckRow {
        key,
        label_zh,
        hits,
        base,
        ratio_pct: ratio(hits, base),
        treatment,
        status,
        error_code,
        examples,
    }
}

/// 扫描全部标的；`calendar` 为数据集覆盖区间内的交易日（升序）。
pub fn scan(calendar: &[Date], securities: &[SecurityQualityInput]) -> QualityScanResult {
    let mut missing_hits = 0_i64;
    let mut missing_base = 0_i64;
    let mut missing_examples = Vec::new();

    let mut ex_hits = 0_i64;
    let mut ex_base = 0_i64;
    let mut ex_examples = Vec::new();

    let mut suspended_hits = 0_i64;
    let mut suspended_base = 0_i64;
    let mut suspended_examples = Vec::new();

    let mut zero_hits = 0_i64;
    let mut zero_base = 0_i64;
    let mut zero_examples = Vec::new();

    let mut anomaly_hits = 0_i64;
    let mut anomaly_base = 0_i64;
    let mut anomaly_examples = Vec::new();

    let mut coverage_hits = 0_i64;
    let mut coverage_base = 0_i64;
    let mut coverage_examples = Vec::new();
    let mut coverage_unavailable = 0_usize;

    for input in securities {
        let bars = &input.bars;
        if bars.is_empty() {
            continue;
        }

        // 1) 缺失交易日：只在 [首根, 末根] ∩ 日历 内比对；新股首日之前不算缺失。
        let first = bars[0].date;
        let last = bars[bars.len() - 1].date;
        let expected: i64 = calendar
            .iter()
            .filter(|day| **day >= first && **day <= last)
            .count() as i64;
        let actual = bars.len() as i64;
        missing_base += expected;
        let missing = (expected - actual).max(0);
        if missing > 0 {
            missing_hits += missing;
            push_example(&mut missing_examples, &input.security.code, first);
        }

        // 2) 除权事件：相邻日 adj_factor 变化（信息项，不算异常）。
        for pair in bars.windows(2) {
            ex_base += 1;
            if !(pair[0].adj_factor - pair[1].adj_factor).abs().le(&f64::EPSILON) {
                ex_hits += 1;
                push_example(&mut ex_examples, &input.security.code, pair[1].date);
            }
        }

        // 3) 停牌日（SUSPENDED 标记）与 4) 零成交量（volume = 0 且非停牌）。
        let mut prev_close: Option<f64> = None;
        let mut prev_factor: Option<f64> = None;
        let limit = board_limit_pct(input.security.board);

        for (index, bar) in bars.iter().enumerate() {
            suspended_base += 1;
            if is_suspended(bar) {
                suspended_hits += 1;
                push_example(&mut suspended_examples, &input.security.code, bar.date);
            } else {
                zero_base += 1;
                if bar.volume == 0.0 {
                    zero_hits += 1;
                    push_example(&mut zero_examples, &input.security.code, bar.date);
                }
            }

            // 5) 价格异常：close ≤ 0 或 |涨跌幅| > 板块上限 + 1%；除权日与首日跳过。
            if index == 0 {
                anomaly_base += 1;
                if bar.close <= 0.0 {
                    anomaly_hits += 1;
                    push_example(&mut anomaly_examples, &input.security.code, bar.date);
                }
            } else if let (Some(prev), Some(prev_adj)) = (prev_close, prev_factor) {
                let ex_rights_day = (prev_adj - bar.adj_factor).abs() > f64::EPSILON;
                if !ex_rights_day && prev > 0.0 {
                    anomaly_base += 1;
                    let abnormal = bar.close <= 0.0
                        || limit.map_or(false, |cap| {
                            let pct = (bar.close / prev - 1.0).abs() * 100.0;
                            pct > cap + PRICE_LIMIT_TOLERANCE_PCT
                        });
                    if abnormal {
                        anomaly_hits += 1;
                        push_example(&mut anomaly_examples, &input.security.code, bar.date);
                    }
                }
            }

            prev_close = Some(bar.close);
            prev_factor = Some(bar.adj_factor);
        }

        // 6) 复权覆盖：因子必须完整且为正；整表缺失记为检查失败。
        coverage_base += 1;
        if !input.has_adjust_factors {
            coverage_unavailable += 1;
        } else if bars
            .iter()
            .any(|bar| !bar.adj_factor.is_finite() || bar.adj_factor <= 0.0)
        {
            coverage_hits += 1;
            push_example(&mut coverage_examples, &input.security.code, first);
        }
    }

    let coverage_failed = coverage_base > 0 && coverage_unavailable as i64 == coverage_base;

    let rows = vec![
        row(
            "MISSING",
            "缺失交易日",
            missing_hits,
            missing_base,
            "标记 MISSING，不插值",
            if missing_hits > 0 {
                CheckStatus::Warning
            } else {
                CheckStatus::Pass
            },
            missing_examples,
            None,
        ),
        row(
            "EX_RIGHTS",
            "除权事件",
            ex_hits,
            ex_base,
            "标记 EX_RIGHTS，按因子复权",
            CheckStatus::Info,
            ex_examples,
            None,
        ),
        row(
            "SUSPENDED",
            "停牌日",
            suspended_hits,
            suspended_base,
            "标记 SUSPENDED，量类 NaN",
            CheckStatus::Info,
            suspended_examples,
            None,
        ),
        row(
            "ZERO_VOLUME",
            "零成交量",
            zero_hits,
            zero_base,
            "标记 ZERO_VOLUME",
            if zero_hits > 0 {
                CheckStatus::Warning
            } else {
                CheckStatus::Pass
            },
            zero_examples,
            None,
        ),
        row(
            "PRICE_ANOMALY",
            "价格异常",
            anomaly_hits,
            anomaly_base,
            "标记 PRICE_ANOMALY，不静默修正",
            if anomaly_hits > 0 {
                CheckStatus::Warning
            } else {
                CheckStatus::Pass
            },
            anomaly_examples,
            None,
        ),
        if coverage_failed {
            row(
                "ADJ_COVERAGE",
                "复权覆盖",
                0,
                0,
                "标记 ADJ_COVERAGE，区间列显示 —",
                CheckStatus::Failed,
                Vec::new(),
                Some("E_ADJ_FACTOR_MISSING"),
            )
        } else {
            row(
                "ADJ_COVERAGE",
                "复权覆盖",
                coverage_hits,
                coverage_base,
                "标记 ADJ_COVERAGE，区间列显示 —",
                if coverage_hits > 0 {
                    CheckStatus::Warning
                } else {
                    CheckStatus::Pass
                },
                coverage_examples,
                None,
            )
        },
    ];

    let passed_count = rows
        .iter()
        .filter(|row| matches!(row.status, CheckStatus::Pass | CheckStatus::Info))
        .count();

    QualityScanResult { rows, passed_count }
}

#[cfg(test)]
mod tests {
    use super::*;
    use data_provider::{Market, QualityFlag};

    fn security(board: Board) -> Security {
        Security {
            code: "600000.SH".into(),
            name: "测试股".into(),
            market: Market::Sh,
            board,
            is_index: matches!(board, Board::Index),
            base_price: 10.0,
        }
    }

    fn day(year: i32, month: u8, day: u8) -> Date {
        Date::new(year, month, day)
    }

    fn bar(date: Date, close: f64, volume: f64, adj_factor: f64) -> BarRow {
        BarRow {
            date,
            open: close,
            high: close,
            low: close,
            close,
            volume,
            amount: close * volume,
            adj_factor,
            quality: Vec::new(),
        }
    }

    fn trading_days() -> Vec<Date> {
        vec![
            day(2026, 1, 5),
            day(2026, 1, 6),
            day(2026, 1, 7),
            day(2026, 1, 8),
            day(2026, 1, 9),
        ]
    }

    fn input(board: Board, bars: Vec<BarRow>) -> SecurityQualityInput {
        SecurityQualityInput {
            security: security(board),
            bars,
            has_adjust_factors: true,
        }
    }

    fn row<'a>(result: &'a QualityScanResult, key: &str) -> &'a QualityCheckRow {
        result.rows.iter().find(|row| row.key == key).unwrap()
    }

    #[test]
    fn six_checks_are_always_present_in_order() {
        let days = trading_days();
        let bars = days
            .iter()
            .map(|date| bar(*date, 10.0, 1_000.0, 1.0))
            .collect();
        let result = scan(&days, &[input(Board::ShMain, bars)]);
        let keys: Vec<&str> = result.rows.iter().map(|row| row.key).collect();
        assert_eq!(
            keys,
            vec![
                "MISSING",
                "EX_RIGHTS",
                "SUSPENDED",
                "ZERO_VOLUME",
                "PRICE_ANOMALY",
                "ADJ_COVERAGE"
            ]
        );
        assert_eq!(result.passed_count, 6, "正常样本 6/6 通过");
        assert_eq!(row(&result, "EX_RIGHTS").status, CheckStatus::Info);
        assert_eq!(row(&result, "SUSPENDED").status, CheckStatus::Info);
    }

    /// AC-07.05-01（补1）：3 天停牌 → 停牌 3、零成交量 0、缺失交易日 0。
    #[test]
    fn three_suspended_days_are_not_missing_or_zero_volume() {
        let days = trading_days();
        let mut bars: Vec<BarRow> = days
            .iter()
            .map(|date| bar(*date, 10.0, 1_000.0, 1.0))
            .collect();
        for item in bars.iter_mut().take(4).skip(1) {
            item.volume = 0.0;
            item.amount = 0.0;
            item.quality.push(QualityFlag::Suspended);
        }
        let result = scan(&days, &[input(Board::ShMain, bars)]);
        assert_eq!(row(&result, "SUSPENDED").hits, 3);
        assert_eq!(row(&result, "ZERO_VOLUME").hits, 0);
        assert_eq!(row(&result, "MISSING").hits, 0);
    }

    /// AC-07.05-01（补2）：除权日 adj_factor 变化 → 除权 +1、价格异常 0。
    #[test]
    fn ex_rights_jump_is_not_price_anomaly() {
        let days = trading_days();
        let bars = vec![
            bar(days[0], 10.0, 1_000.0, 1.0),
            bar(days[1], 10.5, 1_000.0, 1.0),
            // 2:1 拆股：原始价腰斩，因子翻倍
            bar(days[2], 5.25, 1_000.0, 2.0),
            bar(days[3], 5.3, 1_000.0, 2.0),
            bar(days[4], 5.4, 1_000.0, 2.0),
        ];
        let result = scan(&days, &[input(Board::ShMain, bars)]);
        assert_eq!(row(&result, "EX_RIGHTS").hits, 1);
        assert_eq!(row(&result, "PRICE_ANOMALY").hits, 0);
        assert_eq!(row(&result, "EX_RIGHTS").examples[0].date, "2026-01-07");
    }

    /// AC-07.05-01（补3）：close = -1 → 价格异常 1，原值不被改写。
    #[test]
    fn negative_close_is_flagged_without_rewriting_input() {
        let days = trading_days();
        let mut bars: Vec<BarRow> = days
            .iter()
            .map(|date| bar(*date, 10.0, 1_000.0, 1.0))
            .collect();
        bars[2].close = -1.0;
        let snapshot: Vec<f64> = bars.iter().map(|bar| bar.close).collect();
        let result = scan(&days, &[input(Board::ShMain, bars.clone())]);
        assert_eq!(row(&result, "PRICE_ANOMALY").hits, 1);
        assert_eq!(
            bars.iter().map(|bar| bar.close).collect::<Vec<_>>(),
            snapshot,
            "扫描只读，不得改写输入"
        );
    }

    #[test]
    fn missing_trading_day_counts_only_inside_listing_range() {
        let days = trading_days();
        // 该股从第 2 天上市，且缺第 4 天：首日之前不算缺失
        let bars = vec![
            bar(days[1], 10.0, 1_000.0, 1.0),
            bar(days[2], 10.1, 1_000.0, 1.0),
            bar(days[4], 10.2, 1_000.0, 1.0),
        ];
        let result = scan(&days, &[input(Board::ShMain, bars)]);
        assert_eq!(row(&result, "MISSING").hits, 1);
        assert_eq!(row(&result, "MISSING").base, 4, "仅统计 [首根, 末根] 内的交易日");
    }

    #[test]
    fn zero_volume_outside_suspension_is_warning() {
        let days = trading_days();
        let mut bars: Vec<BarRow> = days
            .iter()
            .map(|date| bar(*date, 10.0, 1_000.0, 1.0))
            .collect();
        bars[2].volume = 0.0;
        let result = scan(&days, &[input(Board::ShMain, bars)]);
        assert_eq!(row(&result, "ZERO_VOLUME").hits, 1);
        assert_eq!(row(&result, "ZERO_VOLUME").status, CheckStatus::Warning);
    }

    #[test]
    fn price_limit_depends_on_board() {
        let days = trading_days();
        let main: Vec<BarRow> = vec![
            bar(days[0], 10.0, 1_000.0, 1.0),
            bar(days[1], 11.5, 1_000.0, 1.0), // +15% 主板异常
        ];
        let gem: Vec<BarRow> = vec![
            bar(days[0], 10.0, 1_000.0, 1.0),
            bar(days[1], 11.5, 1_000.0, 1.0), // +15% 创业板正常
        ];
        let main_result = scan(&days, &[input(Board::ShMain, main)]);
        let gem_result = scan(&days, &[input(Board::ChiNext, gem)]);
        assert_eq!(row(&main_result, "PRICE_ANOMALY").hits, 1);
        assert_eq!(row(&gem_result, "PRICE_ANOMALY").hits, 0);
    }

    #[test]
    fn missing_adjust_factor_table_marks_check_failed_not_zero() {
        let days = trading_days();
        let bars = days
            .iter()
            .map(|date| bar(*date, 10.0, 1_000.0, 1.0))
            .collect();
        let mut data = input(Board::ShMain, bars);
        data.has_adjust_factors = false;
        let result = scan(&days, &[data]);
        let coverage = row(&result, "ADJ_COVERAGE");
        assert_eq!(coverage.status, CheckStatus::Failed);
        assert_eq!(coverage.error_code, Some("E_ADJ_FACTOR_MISSING"));
        assert_eq!(coverage.hits, 0);
        assert_eq!(result.passed_count, 5, "失败项不计入通过");
    }

    #[test]
    fn index_has_no_price_limit_but_still_checked_for_suspension() {
        let days = trading_days();
        let mut bars: Vec<BarRow> = days
            .iter()
            .map(|date| bar(*date, 4_000.0, 0.0, 1.0))
            .collect();
        bars[1].quality.push(QualityFlag::Suspended);
        let result = scan(&days, &[input(Board::Index, bars)]);
        assert_eq!(row(&result, "PRICE_ANOMALY").hits, 0);
        assert_eq!(row(&result, "SUSPENDED").hits, 1);
        assert_eq!(row(&result, "ZERO_VOLUME").hits, 4, "停牌日不计零成交量");
    }
}
