//! 周/月 K 线聚合（TD-S0-01 清偿）。
//!
//! 口径（冻结）：
//! - 分组：ISO-8601 周（周一起）/ 公历自然月；分组只看交易日期，不看停牌；
//! - open = 组内首根日线 open，close = 组内末根日线 close；
//! - high = 组内最高，low = 组内最低，volume / amount 求和；
//! - adj_factor 取组内末根（前复权价由上游 provider 负责逐日折算）；
//! - date = 组内末根交易日；**停牌整周不生成周线**（不做前值填充）；
//! - quality = 组内质量标记并集（保序去重）。

use crate::calendar::{iso_week, month_key};
use crate::date::Date;
use crate::types::BarRow;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AggregatePeriod {
    Week,
    Month,
}

impl AggregatePeriod {
    pub const fn as_str(self) -> &'static str {
        match self {
            AggregatePeriod::Week => "W",
            AggregatePeriod::Month => "M",
        }
    }

    fn group_key(self, date: Date) -> String {
        match self {
            AggregatePeriod::Week => iso_week(date).key(),
            AggregatePeriod::Month => month_key(date),
        }
    }
}

/// 按 `period` 聚合；输入按日期升序排序后再分组，乱序输入不会改变结果。
pub fn aggregate_bars(rows: &[BarRow], period: AggregatePeriod) -> Vec<BarRow> {
    if rows.is_empty() {
        return Vec::new();
    }
    let mut sorted: Vec<&BarRow> = rows.iter().collect();
    sorted.sort_by_key(|row| row.date);

    let mut out: Vec<BarRow> = Vec::new();
    let mut current_key: Option<String> = None;

    for row in sorted {
        let key = period.group_key(row.date);
        if current_key.as_deref() != Some(key.as_str()) {
            current_key = Some(key);
            out.push(BarRow {
                date: row.date,
                open: row.open,
                high: row.high,
                low: row.low,
                close: row.close,
                volume: row.volume,
                amount: row.amount,
                adj_factor: row.adj_factor,
                quality: row.quality.clone(),
                batch_id: row.batch_id.clone(),
                ingested_at: row.ingested_at,
            });
            continue;
        }

        let bar = out.last_mut().expect("aggregate: group must exist");
        bar.date = row.date;
        bar.high = bar.high.max(row.high);
        bar.low = bar.low.min(row.low);
        bar.close = row.close;
        bar.volume += row.volume;
        bar.amount += row.amount;
        bar.adj_factor = row.adj_factor;
        // 聚合 K 线的溯源取「最后成交日」所在批次（收盘价来源）。
        bar.batch_id = row.batch_id.clone();
        bar.ingested_at = row.ingested_at;
        for flag in &row.quality {
            if !bar.quality.contains(flag) {
                bar.quality.push(*flag);
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::QualityFlag;

    fn bar(day: u8, open: f64, high: f64, low: f64, close: f64, volume: f64) -> BarRow {
        BarRow {
            date: Date::new(2024, 1, day),
            open,
            high,
            low,
            close,
            volume,
            amount: volume * close,
            adj_factor: 1.0,
            quality: Vec::new(),
            batch_id: None,
            ingested_at: None,
        }
    }

    #[test]
    fn weekly_ohlcv_matches_hand_calculation() {
        // 2024-01-01 周一 ~ 2024-01-05 周五，同一 ISO 周（2024-W01）。
        let rows = vec![
            bar(1, 10.0, 11.0, 9.5, 10.5, 100.0),
            bar(2, 10.5, 12.0, 10.0, 11.5, 200.0),
            bar(3, 11.5, 11.8, 8.0, 9.0, 300.0),
            bar(4, 9.0, 10.0, 8.5, 9.8, 400.0),
            bar(5, 9.8, 10.2, 9.0, 10.0, 500.0),
        ];
        let weekly = aggregate_bars(&rows, AggregatePeriod::Week);
        assert_eq!(weekly.len(), 1);
        let week = &weekly[0];
        assert_eq!(week.date, Date::new(2024, 1, 5));
        assert_eq!(week.open, 10.0);
        assert_eq!(week.high, 12.0);
        assert_eq!(week.low, 8.0);
        assert_eq!(week.close, 10.0);
        assert_eq!(week.volume, 1500.0);
        assert!((week.amount - (1050.0 + 2300.0 + 2700.0 + 3920.0 + 5000.0)).abs() < 1e-9);
    }

    #[test]
    fn month_grouping_splits_on_calendar_month() {
        let rows = vec![
            bar(29, 10.0, 10.0, 10.0, 10.0, 1.0), // 明确放在 1 月内，见下
            bar(31, 10.0, 11.0, 9.0, 11.0, 2.0),
            BarRow {
                date: Date::new(2024, 2, 1),
                open: 11.0,
                high: 12.0,
                low: 11.0,
                close: 12.0,
                volume: 3.0,
                amount: 36.0,
                adj_factor: 1.0,
                quality: vec![QualityFlag::SplitDay],
                batch_id: None,
                ingested_at: None,
            },
        ];
        let monthly = aggregate_bars(&rows, AggregatePeriod::Month);
        assert_eq!(monthly.len(), 2);
        assert_eq!(monthly[0].date, Date::new(2024, 1, 31));
        assert_eq!(monthly[0].open, 10.0);
        assert_eq!(monthly[0].high, 11.0);
        assert_eq!(monthly[0].low, 9.0);
        assert_eq!(monthly[0].close, 11.0);
        assert_eq!(monthly[0].volume, 3.0);
        assert_eq!(monthly[1].date, Date::new(2024, 2, 1));
        assert_eq!(monthly[1].quality, vec![QualityFlag::SplitDay]);
    }

    #[test]
    fn suspended_whole_week_produces_no_bar() {
        // 前一周有 3 根，整周停牌（1/8~1/12 全缺），后一周恢复 2 根。
        let rows = vec![
            bar(2, 10.0, 10.0, 10.0, 10.0, 1.0),
            bar(3, 10.0, 10.0, 10.0, 10.0, 1.0),
            bar(4, 10.0, 10.0, 10.0, 10.0, 1.0),
            bar(15, 12.0, 12.0, 12.0, 12.0, 2.0),
            bar(16, 12.0, 13.0, 11.0, 13.0, 2.0),
        ];
        let weekly = aggregate_bars(&rows, AggregatePeriod::Week);
        assert_eq!(weekly.len(), 2, "停牌整周不生成周线");
        assert_eq!(weekly[0].date, Date::new(2024, 1, 4));
        assert_eq!(weekly[1].date, Date::new(2024, 1, 16));
        assert_eq!(weekly[1].close, 13.0);
    }

    #[test]
    fn single_suspended_day_keeps_the_week() {
        // 1/2 停牌（缺一根），1/3、1/4 仍在同周，周线照常生成。
        let rows = vec![bar(3, 10.0, 11.0, 9.0, 10.0, 1.0), bar(4, 10.0, 12.0, 10.0, 11.0, 1.0)];
        let weekly = aggregate_bars(&rows, AggregatePeriod::Week);
        assert_eq!(weekly.len(), 1);
        assert_eq!(weekly[0].date, Date::new(2024, 1, 4));
        assert_eq!(weekly[0].high, 12.0);
    }

    #[test]
    fn empty_and_single_row_inputs() {
        assert!(aggregate_bars(&[], AggregatePeriod::Week).is_empty());
        let rows = vec![bar(5, 1.0, 2.0, 0.5, 1.5, 10.0)];
        assert_eq!(aggregate_bars(&rows, AggregatePeriod::Week).len(), 1);
    }
}
