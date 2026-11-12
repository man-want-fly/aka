//! S-04.01-01：指数概览快照（8 行指数表 + 4 张 KPI）。
//!
//! 只做纯计算：输入来自 data-store 的只读查询与 manifest，便于单测覆盖边界。

use std::cmp::Ordering;

use data_provider::DatasetManifest;
use data_store::dataset_db::{IndexMemberStatRow, IndexQuoteRow, IndexSecurityRow};

use crate::dto::{
    IndexKpiDto, IndexKpiItemDto, IndexRangeDaysDto, IndexRangePctDto, IndexRowDto,
    IndexSnapshotDto,
};
use crate::{AppError, ErrorCode};

/// 故事卡约定的指数样本数；数据集实际数量不足时前端显示「样本缺失（N/8）」。
pub const SAMPLE_INDEX_COUNT: usize = 8;

/// S-04.01-02：区间（交易日）：今日 / 5 日 / 20 日。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexRange {
    Today,
    D5,
    D20,
}

impl IndexRange {
    pub const ALL: [IndexRange; 3] = [IndexRange::Today, IndexRange::D5, IndexRange::D20];

    /// 区间回看的交易日数 k。
    pub fn days_before(self) -> usize {
        match self {
            IndexRange::Today => 0,
            IndexRange::D5 => 5,
            IndexRange::D20 => 20,
        }
    }

    pub fn value(self, row: &IndexRowDto) -> Option<f64> {
        match self {
            IndexRange::Today => row.range_pct.today,
            IndexRange::D5 => row.range_pct.d5,
            IndexRange::D20 => row.range_pct.d20,
        }
    }
}

/// 区间累计涨跌幅（百分数）：`(close[last] / close[last - k - 1] - 1) * 100`。
/// 根数不足 k+2（区间 k 日 + 区间前收盘）时返回 None，不缩短窗口。
pub fn range_pct(closes: &[f64], k: usize) -> Option<f64> {
    let last = closes.len().checked_sub(1)?;
    let base = closes.get(last.checked_sub(k + 1)?)?;
    let close = closes[last];
    if !close.is_finite() || !base.is_finite() || *base <= 0.0 {
        return None;
    }
    Some((close / base - 1.0) * 100.0)
}

pub fn build_index_snapshot(
    manifest: &DatasetManifest,
    data_date: Option<&str>,
    indices: &[IndexSecurityRow],
    quotes: &[IndexQuoteRow],
    member_stats: &[IndexMemberStatRow],
) -> Result<IndexSnapshotDto, AppError> {
    if indices.is_empty() {
        return Err(AppError::new(
            ErrorCode::DatasetCorrupt,
            "数据集内无指数清单，无法生成指数概览",
        ));
    }

    let mut rows: Vec<IndexRowDto> = Vec::with_capacity(indices.len());
    let mut missing_count = 0usize;
    let mut latest_date: Option<String> = None;

    for security in indices {
        let Some(quote) = quotes.iter().find(|quote| quote.code == security.code) else {
            // 有指数无日线：隐藏该行并计数，不伪造点位。
            missing_count += 1;
            continue;
        };
        if !quote.close.is_finite() {
            missing_count += 1;
            continue;
        }
        if latest_date
            .as_deref()
            .map_or(true, |date| quote.date.as_str() > date)
        {
            latest_date = Some(quote.date.clone());
        }

        let stat = member_stats
            .iter()
            .find(|stat| stat.index_code == security.code && stat.members > 0);
        let members = stat.map(|stat| stat.members as u32);
        // 无成分或成分当日无日线时保持 None，由前端显示 `—`。
        let amount = stat
            .and_then(|stat| stat.amount)
            .filter(|value| value.is_finite());

        let (change_abs, change_pct) = match quote.prev_close {
            Some(prev) if prev.is_finite() && prev > 0.0 => {
                let abs = quote.close - prev;
                (Some(abs), Some(abs / prev * 100.0))
            }
            _ => (None, None),
        };

        let days = quote.closes.len();
        rows.push(IndexRowDto {
            code: security.code.clone(),
            name: security.name.clone(),
            point: quote.close,
            change_abs,
            change_pct,
            amount,
            members,
            range_pct: IndexRangePctDto {
                today: range_pct(&quote.closes, 0),
                d5: range_pct(&quote.closes, 5),
                d20: range_pct(&quote.closes, 20),
            },
            range_days: IndexRangeDaysDto {
                today: days,
                d5: days,
                d20: days,
            },
        });
    }

    if rows.is_empty() {
        return Err(AppError::new(
            ErrorCode::DatasetCorrupt,
            "数据集内指数全部缺失日线，无法生成指数概览",
        ));
    }

    sort_rows_by_range(&mut rows, IndexRange::Today);

    let kpi = build_kpi(&rows);
    let index_count = rows.len();
    let data_date = latest_date
        .or_else(|| data_date.map(str::to_string))
        .unwrap_or_else(|| manifest.coverage_end.clone());

    Ok(IndexSnapshotDto {
        index_count,
        expected_count: SAMPLE_INDEX_COUNT,
        sample_missing: index_count < SAMPLE_INDEX_COUNT,
        missing_count,
        data_date,
        coverage_end: manifest.coverage_end.clone(),
        dataset_id: manifest.dataset_id.clone(),
        data_version: manifest.data_version.clone(),
        provider: manifest.provider.clone(),
        simulated: manifest.provider == "sim",
        generated_at: manifest.generated_at,
        rows,
        kpi,
    })
}

/// 区间涨跌幅降序；同值按 code 升序；该区间不可算的行排在最后（内部仍按 code 升序）。
pub fn sort_rows_by_range(rows: &mut [IndexRowDto], range: IndexRange) {
    rows.sort_by(|a, b| compare_rows(a, b, range));
}

fn compare_rows(a: &IndexRowDto, b: &IndexRowDto, range: IndexRange) -> Ordering {
    match (range.value(a), range.value(b)) {
        (Some(left), Some(right)) => right
            .partial_cmp(&left)
            .unwrap_or(Ordering::Equal)
            .then_with(|| a.code.cmp(&b.code)),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => a.code.cmp(&b.code),
    }
}

fn build_kpi(rows: &[IndexRowDto]) -> IndexKpiDto {
    let leader = rows
        .iter()
        .find(|row| row.change_pct.is_some())
        .map(kpi_item);
    let laggard = rows
        .iter()
        .rev()
        .find(|row| row.change_pct.is_some())
        .map(kpi_item);

    let advancers = rows
        .iter()
        .filter(|row| row.change_pct.is_some_and(|pct| pct > 0.0))
        .count();

    // 任一行成交额缺失时不合计，避免把半截样本当成全量。
    let amount_total = if !rows.is_empty() && rows.iter().all(|row| row.amount.is_some()) {
        Some(rows.iter().filter_map(|row| row.amount).sum())
    } else {
        None
    };

    IndexKpiDto {
        leader,
        laggard,
        advancers,
        amount_total,
    }
}

fn kpi_item(row: &IndexRowDto) -> IndexKpiItemDto {
    IndexKpiItemDto {
        code: row.code.clone(),
        name: row.name.clone(),
        change_pct: row.change_pct.unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> DatasetManifest {
        DatasetManifest {
            dataset_id: "ds-test-0001".into(),
            data_version: "v1".into(),
            row_count: 0,
            coverage_start: "2024-04-01".into(),
            coverage_end: "2024-04-30".into(),
            seed: 42,
            sha256: String::new(),
            provider: "sim".into(),
            generated_at: 1_714_000_000,
        }
    }

    /// 内存库全链路：8 个指数、每指数两根日线、成分数与成交额合计。
    #[test]
    fn builds_eight_rows_with_member_counts_and_kpi() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        data_store::dataset_db::init_schema(&conn).unwrap();

        let mut securities = Vec::new();
        let mut bars = Vec::new();
        let mut members = Vec::new();
        for index in 0..8usize {
            let index_code = format!("000{:03}.SH", index + 1);
            securities.push(data_store::dataset_db::SecurityRow {
                code: index_code.clone(),
                name: format!("样本指数{index}"),
                market: "SH".into(),
                board: "指数".into(),
                is_index: true,
                base_price: 1000.0,
            });
            let prev = 1000.0;
            let close = prev * (1.0 + (index as f64 - 3.0) / 100.0);
            for (date, price) in [("2024-04-29", prev), ("2024-04-30", close)] {
                bars.push(data_store::dataset_db::BarRecord {
                    code: index_code.clone(),
                    date: date.into(),
                    open: price,
                    high: price,
                    low: price,
                    close: price,
                    volume: 1.0,
                    amount: 0.0,
                    adj_factor: 1.0,
                    quality: String::new(),
                    batch_id: None,
                    ingested_at: None,
                });
            }
            for slot in 0..3usize {
                let stock_code = format!("600{:03}.SH", index * 10 + slot);
                securities.push(data_store::dataset_db::SecurityRow {
                    code: stock_code.clone(),
                    name: format!("成分{index}-{slot}"),
                    market: "SH".into(),
                    board: "沪主板".into(),
                    is_index: false,
                    base_price: 10.0,
                });
                members.push(data_store::dataset_db::MemberRow {
                    index_code: index_code.clone(),
                    security_code: stock_code.clone(),
                    as_of: "2024-04-30".into(),
                    ordinal: slot as u32 + 1,
                });
                bars.push(data_store::dataset_db::BarRecord {
                    code: stock_code,
                    date: "2024-04-30".into(),
                    open: 10.0,
                    high: 10.0,
                    low: 10.0,
                    close: 10.0,
                    volume: 1.0,
                    amount: 1.0e8,
                    adj_factor: 1.0,
                    quality: String::new(),
                    batch_id: None,
                    ingested_at: None,
                });
            }
        }
        data_store::dataset_db::write_securities(&mut conn, &securities).unwrap();
        data_store::dataset_db::write_bars(&mut conn, &bars).unwrap();
        data_store::dataset_db::write_index_members(&mut conn, &members).unwrap();

        let raw = data_store::dataset_db::read_index_snapshot(&conn).unwrap();
        let snapshot = build_index_snapshot(
            &manifest(),
            raw.data_date.as_deref(),
            &raw.indices,
            &raw.quotes,
            &raw.member_stats,
        )
        .unwrap();

        assert_eq!(snapshot.index_count, 8);
        assert_eq!(snapshot.rows.len(), 8);
        assert!(!snapshot.sample_missing);
        assert_eq!(snapshot.missing_count, 0);
        assert_eq!(snapshot.data_date, "2024-04-30");
        assert_eq!(snapshot.coverage_end, "2024-04-30");
        assert!(snapshot.simulated);

        for row in &snapshot.rows {
            assert_eq!(row.members, Some(3), "样本数必须等于 index_members 行数");
            assert_eq!(row.amount, Some(3.0e8));
            assert!(row.change_pct.is_some());
            // 每指数只有 2 根日线：今日可算，5 日/20 日数据不足。
            assert!(row.range_pct.today.is_some());
            assert_eq!(row.range_pct.d5, None);
            assert_eq!(row.range_pct.d20, None);
            assert_eq!(row.range_days.d20, 2);
        }
        assert_eq!(snapshot.kpi.advancers, 4, "8 个样本中 4 个上涨");
        assert_eq!(snapshot.kpi.amount_total, Some(2.4e9));
        assert!((snapshot.kpi.leader.as_ref().unwrap().change_pct - 4.0).abs() < 1e-9);
        assert!((snapshot.kpi.laggard.as_ref().unwrap().change_pct + 3.0).abs() < 1e-9);
    }

    /// AC：区间涨跌幅降序，同值按 code 升序；不可算的行排最后。
    #[test]
    fn sorts_by_range_pct_desc_then_code_asc() {
        let row = |code: &str, today: Option<f64>, d5: Option<f64>| IndexRowDto {
            code: code.into(),
            name: code.into(),
            point: 1000.0,
            change_abs: Some(0.0),
            change_pct: today,
            amount: Some(1.0),
            members: Some(1),
            range_pct: IndexRangePctDto {
                today,
                d5,
                d20: None,
            },
            range_days: IndexRangeDaysDto {
                today: 2,
                d5: 6,
                d20: 2,
            },
        };
        let mut rows = vec![
            row("000003.SH", Some(2.0), Some(-5.0)),
            row("000002.SH", Some(1.0), Some(5.0)),
            row("000001.SH", Some(1.0), Some(5.0)),
        ];
        sort_rows_by_range(&mut rows, IndexRange::Today);
        let codes = rows.iter().map(|row| row.code.as_str()).collect::<Vec<_>>();
        assert_eq!(codes, ["000003.SH", "000001.SH", "000002.SH"]);

        // 切到 5 日：排序随区间变化，同值仍按 code 升序。
        sort_rows_by_range(&mut rows, IndexRange::D5);
        let codes = rows.iter().map(|row| row.code.as_str()).collect::<Vec<_>>();
        assert_eq!(codes, ["000001.SH", "000002.SH", "000003.SH"]);

        rows.push(row("000004.SH", Some(9.0), None));
        sort_rows_by_range(&mut rows, IndexRange::D5);
        assert_eq!(rows.last().unwrap().code, "000004.SH", "不可算的行排最后");
    }

    /// AC：手算样本复核三个区间；不足 k+2 根时返回 None，不缩短窗口。
    #[test]
    fn range_pct_matches_hand_computed_windows() {
        let closes = [100.0, 101.0, 102.0, 103.0, 104.0, 105.0, 106.0];
        assert!((range_pct(&closes, 0).unwrap() - (106.0 / 105.0 - 1.0) * 100.0).abs() < 1e-12);
        assert!((range_pct(&closes, 1).unwrap() - (106.0 / 104.0 - 1.0) * 100.0).abs() < 1e-12);
        assert!((range_pct(&closes, 5).unwrap() - (106.0 / 100.0 - 1.0) * 100.0).abs() < 1e-12);
        assert_eq!(range_pct(&closes, 20), None);
        assert_eq!(range_pct(&[], 0), None);
        assert_eq!(range_pct(&[100.0], 0), None, "今日也需要前收盘");
        // 12 个交易日：5 日可算，20 日不足，绝不缩短成 11 日。
        let twelve = (100..112).map(f64::from).collect::<Vec<_>>();
        assert!((range_pct(&twelve, 5).unwrap() - (111.0 / 105.0 - 1.0) * 100.0).abs() < 1e-12);
        assert_eq!(range_pct(&twelve, 20), None);
    }

    /// AC：成交额/样本数固定取最新交易日，不随区间变化。
    #[test]
    fn amount_and_members_stay_on_latest_trading_day_across_ranges() {
        let dir = std::env::temp_dir().join(format!(
            "aka-index-range-{}-{}",
            std::process::id(),
            "amount"
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut conn = data_store::dataset_db::open(&dir.join("dataset.db")).unwrap();

        let index_code = "000001.SH".to_string();
        data_store::dataset_db::write_securities(
            &mut conn,
            &[
                data_store::dataset_db::SecurityRow {
                    code: index_code.clone(),
                    name: "上证指数".into(),
                    market: "SH".into(),
                    board: "指数".into(),
                    is_index: true,
                    base_price: 100.0,
                },
                data_store::dataset_db::SecurityRow {
                    code: "600519.SH".into(),
                    name: "贵州茅台".into(),
                    market: "SH".into(),
                    board: "沪主板".into(),
                    is_index: false,
                    base_price: 10.0,
                },
            ],
        )
        .unwrap();

        // 23 根日线：最新 121，前收 120，5 日前收 110，20 日前收 100。
        let mut closes = vec![105.0; 23];
        closes[1] = 100.0;
        closes[16] = 110.0;
        closes[21] = 120.0;
        closes[22] = 121.0;
        let date = |index: usize| format!("2024-{:02}-{:02}", 1 + index / 28, 1 + index % 28);
        let mut bars = Vec::new();
        for (index, close) in closes.iter().enumerate() {
            bars.push(data_store::dataset_db::BarRecord {
                code: index_code.clone(),
                date: date(index),
                open: *close,
                high: *close,
                low: *close,
                close: *close,
                volume: 1.0,
                amount: 0.0,
                adj_factor: 1.0,
                quality: String::new(),
                batch_id: None,
                ingested_at: None,
            });
        }
        bars.push(data_store::dataset_db::BarRecord {
            code: "600519.SH".into(),
            date: date(22),
            open: 10.0,
            high: 10.0,
            low: 10.0,
            close: 10.0,
            volume: 1.0,
            amount: 2.5e8,
            adj_factor: 1.0,
            quality: String::new(),
            batch_id: None,
            ingested_at: None,
        });
        data_store::dataset_db::write_bars(&mut conn, &bars).unwrap();
        data_store::dataset_db::write_index_members(
            &mut conn,
            &[data_store::dataset_db::MemberRow {
                index_code: index_code.clone(),
                security_code: "600519.SH".into(),
                as_of: date(22),
                ordinal: 1,
            }],
        )
        .unwrap();

        let raw = data_store::dataset_db::read_index_snapshot(&conn).unwrap();
        let snapshot = build_index_snapshot(
            &manifest(),
            raw.data_date.as_deref(),
            &raw.indices,
            &raw.quotes,
            &raw.member_stats,
        )
        .unwrap();
        let row = &snapshot.rows[0];
        assert!((row.range_pct.today.unwrap() - (121.0 / 120.0 - 1.0) * 100.0).abs() < 1e-12);
        assert!((row.range_pct.d5.unwrap() - (121.0 / 110.0 - 1.0) * 100.0).abs() < 1e-12);
        assert!((row.range_pct.d20.unwrap() - (121.0 / 100.0 - 1.0) * 100.0).abs() < 1e-12);
        assert_eq!(row.amount, Some(2.5e8), "成交额固定为最新交易日");
        assert_eq!(row.members, Some(1));
        // 可用交易日受只读窗口上限约束；仅在数据不足时会展示给用户。
        assert_eq!(row.range_days.d20, data_store::dataset_db::INDEX_RANGE_BARS);
        assert_eq!(snapshot.kpi.amount_total, Some(2.5e8));

        // 默认排序口径为今日，领涨即唯一指数。
        assert_eq!(snapshot.kpi.leader.as_ref().unwrap().code, index_code);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// AC：无成分时成交额与样本数为 None（前端显示 `—`），不补 0。
    #[test]
    fn index_without_members_keeps_amount_and_members_empty() {
        let indices = vec![IndexSecurityRow {
            code: "000001.SH".into(),
            name: "上证指数".into(),
        }];
        let quotes = vec![IndexQuoteRow {
            code: "000001.SH".into(),
            date: "2024-04-30".into(),
            close: 3087.24,
            prev_close: Some(3050.0),
            closes: vec![3050.0, 3087.24],
        }];
        let snapshot =
            build_index_snapshot(&manifest(), Some("2024-04-30"), &indices, &quotes, &[]).unwrap();
        assert_eq!(snapshot.rows[0].members, None);
        assert_eq!(snapshot.rows[0].amount, None);
        assert_eq!(snapshot.kpi.amount_total, None);
    }

    /// AC：N<8 时标样本缺失，不伪造空行。
    #[test]
    fn fewer_than_eight_indices_marks_sample_missing_without_fake_rows() {
        let indices = (0..6)
            .map(|index| IndexSecurityRow {
                code: format!("00000{index}.SH"),
                name: format!("指数{index}"),
            })
            .collect::<Vec<_>>();
        let quotes = indices
            .iter()
            .map(|security| IndexQuoteRow {
                code: security.code.clone(),
                date: "2024-04-30".into(),
                close: 1000.0,
                prev_close: Some(999.0),
                closes: vec![999.0, 1000.0],
            })
            .collect::<Vec<_>>();
        let snapshot =
            build_index_snapshot(&manifest(), Some("2024-04-30"), &indices, &quotes, &[]).unwrap();
        assert_eq!(snapshot.index_count, 6);
        assert_eq!(snapshot.rows.len(), 6);
        assert_eq!(snapshot.expected_count, 8);
        assert!(snapshot.sample_missing);
        assert_eq!(snapshot.missing_count, 0);
    }

    /// AC：指数全部缺失时返回 E_DATASET_CORRUPT，不得空表当成功。
    #[test]
    fn all_indices_missing_returns_dataset_corrupt() {
        let indices = vec![IndexSecurityRow {
            code: "000001.SH".into(),
            name: "上证指数".into(),
        }];
        let error = build_index_snapshot(&manifest(), None, &indices, &[], &[]).unwrap_err();
        assert_eq!(error.code, ErrorCode::DatasetCorrupt);
        assert_eq!(error.code.as_str(), "E_DATASET_CORRUPT");

        let error = build_index_snapshot(&manifest(), None, &[], &[], &[]).unwrap_err();
        assert_eq!(error.code, ErrorCode::DatasetCorrupt);
    }

    /// 部分指数缺日线：隐藏该行并计入 missingCount。
    #[test]
    fn index_without_bars_is_hidden_and_counted() {
        let indices = vec![
            IndexSecurityRow {
                code: "000001.SH".into(),
                name: "上证指数".into(),
            },
            IndexSecurityRow {
                code: "399001.SZ".into(),
                name: "深证成指".into(),
            },
        ];
        let quotes = vec![IndexQuoteRow {
            code: "000001.SH".into(),
            date: "2024-04-30".into(),
            close: 3087.24,
            prev_close: Some(3050.0),
            closes: vec![3050.0, 3087.24],
        }];
        let snapshot =
            build_index_snapshot(&manifest(), Some("2024-04-30"), &indices, &quotes, &[]).unwrap();
        assert_eq!(snapshot.index_count, 1);
        assert_eq!(snapshot.missing_count, 1);
        assert_eq!(snapshot.rows[0].code, "000001.SH");
    }

    #[test]
    fn change_amount_and_pct_follow_point_and_prev_close() {
        let indices = vec![IndexSecurityRow {
            code: "000001.SH".into(),
            name: "上证指数".into(),
        }];
        let quotes = vec![IndexQuoteRow {
            code: "000001.SH".into(),
            date: "2024-04-30".into(),
            close: 3087.24,
            prev_close: Some(3050.0),
            closes: vec![3050.0, 3087.24],
        }];
        let snapshot =
            build_index_snapshot(&manifest(), Some("2024-04-30"), &indices, &quotes, &[]).unwrap();
        let row = &snapshot.rows[0];
        assert!((row.change_abs.unwrap() - 37.24).abs() < 1e-9);
        assert!((row.change_pct.unwrap() - 1.220983_6).abs() < 1e-6);
        assert!((row.range_pct.today.unwrap() - row.change_pct.unwrap()).abs() < 1e-12);
        assert_eq!(snapshot.kpi.leader.as_ref().unwrap().name, "上证指数");
    }
}
