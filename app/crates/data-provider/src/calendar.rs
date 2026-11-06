//! 交易日历服务（TD-S0-01 / TD-S0-03 清偿）。
//!
//! 职责：
//! - 日期是唯一权威：周/月聚合与区间查询都以这里的分组键为准；
//! - ISO-8601 周（周一为一周首日、跨年周归入含周四的那一年）；
//! - 只描述「市场交易日」，个股停牌表现为「该日没有 K 线」，由聚合层自然缺席。
//!
//! 骨架期日历 = 工作日（不含法定节假日），与 `MockProvider` 的生成口径一致；
//! 真实 provider 接入后通过 `TradingCalendar::from_dates(provider.trading_calendar())` 替换。

use crate::date::Date;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct IsoWeek {
    /// ISO 周年（可能与该日期所在的公历年不同，例如 2021-01-01 → 2020-W53）
    pub year: i32,
    pub week: u32,
}

impl IsoWeek {
    pub fn key(self) -> String {
        format!("{}-W{:02}", self.year, self.week)
    }
}

/// ISO-8601 周：周四决定归属年。
pub fn iso_week(date: Date) -> IsoWeek {
    let iso_weekday = match date.weekday() {
        0 => 7,
        day => day,
    } as i64;
    let thursday = Date::from_days(date.to_days() + 4 - iso_weekday);
    let year = thursday.year();
    let jan4 = Date::new(year, 1, 4);
    let jan4_weekday = match jan4.weekday() {
        0 => 7,
        day => day,
    } as i64;
    let week1_monday = Date::from_days(jan4.to_days() - (jan4_weekday - 1));
    let week = ((date.to_days() - week1_monday.to_days()) / 7 + 1) as u32;
    IsoWeek { year, week }
}

/// 该日期所在 ISO 周的周一。
pub fn week_start(date: Date) -> Date {
    let iso_weekday = match date.weekday() {
        0 => 7,
        day => day,
    } as i64;
    Date::from_days(date.to_days() - (iso_weekday - 1))
}

/// `YYYY-MM`，月份聚合键。
pub fn month_key(date: Date) -> String {
    format!("{:04}-{:02}", date.year(), date.month())
}

#[derive(Debug, Clone, Default)]
pub struct TradingCalendar {
    dates: Vec<Date>,
}

impl TradingCalendar {
    /// 入参允许乱序/重复；内部按日期升序去重。
    pub fn from_dates(mut dates: Vec<Date>) -> Self {
        dates.sort_unstable();
        dates.dedup();
        Self { dates }
    }

    pub fn dates(&self) -> &[Date] {
        &self.dates
    }

    pub fn len(&self) -> usize {
        self.dates.len()
    }

    pub fn is_empty(&self) -> bool {
        self.dates.is_empty()
    }

    pub fn contains(&self, date: Date) -> bool {
        self.dates.binary_search(&date).is_ok()
    }

    /// 该日期在市场上的交易日属性；周末一律 false，工作日按日历判断。
    pub fn is_trading_day(&self, date: Date) -> bool {
        !date.is_weekend() && self.contains(date)
    }

    pub fn between(&self, from: Date, to: Date) -> Vec<Date> {
        self.dates
            .iter()
            .copied()
            .filter(|date| *date >= from && *date <= to)
            .collect()
    }

    /// 首个 ≥ `date` 的交易日；不存在返回 None。
    pub fn first_on_or_after(&self, date: Date) -> Option<Date> {
        let index = self.dates.partition_point(|item| *item < date);
        self.dates.get(index).copied()
    }

    /// 末个 ≤ `date` 的交易日；不存在返回 None。
    pub fn last_on_or_before(&self, date: Date) -> Option<Date> {
        let index = self.dates.partition_point(|item| *item <= date);
        index.checked_sub(1).map(|idx| self.dates[idx])
    }

    /// 闭区间内自然周数（按 ISO 周去重，含首尾周）。
    /// 停牌整周不在此扣除：那由「个股实际 K 线」的聚合层决定。
    pub fn natural_week_count(&self, from: Date, to: Date) -> usize {
        let mut keys = Vec::new();
        for date in self.between(from, to) {
            let key = iso_week(date);
            if keys.last() != Some(&key) {
                keys.push(key);
            }
        }
        keys.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_week_year_boundary_is_hand_checked() {
        // 2021-01-01 周五属于 2020-W53；2021-01-04 周一才进入 2021-W01。
        assert_eq!(iso_week(Date::new(2021, 1, 1)), IsoWeek { year: 2020, week: 53 });
        assert_eq!(iso_week(Date::new(2021, 1, 4)), IsoWeek { year: 2021, week: 1 });
        // 2024-12-30 周一属于 2025-W01。
        assert_eq!(iso_week(Date::new(2024, 12, 30)), IsoWeek { year: 2025, week: 1 });
        assert_eq!(iso_week(Date::new(2024, 12, 29)).key(), "2024-W52");
        // 2023-01-02 周一 → 2023-W01。
        assert_eq!(iso_week(Date::new(2023, 1, 2)).key(), "2023-W01");
    }

    #[test]
    fn week_starts_on_monday() {
        assert_eq!(week_start(Date::new(2024, 1, 5)), Date::new(2024, 1, 1));
        assert_eq!(week_start(Date::new(2024, 1, 7)), Date::new(2024, 1, 1));
        assert_eq!(week_start(Date::new(2024, 1, 8)), Date::new(2024, 1, 8));
    }

    #[test]
    fn monthly_key_is_calendar_month() {
        assert_eq!(month_key(Date::new(2024, 12, 31)), "2024-12");
        assert_eq!(month_key(Date::new(2024, 1, 1)), "2024-01");
    }

    #[test]
    fn calendar_snaps_and_counts_natural_weeks() {
        // 2024-01-01 ~ 2024-01-14 的 10 个工作日横跨 2 个 ISO 周。
        let mut dates = Vec::new();
        let mut cursor = Date::new(2024, 1, 1);
        while cursor <= Date::new(2024, 1, 14) {
            if !cursor.is_weekend() {
                dates.push(cursor);
            }
            cursor = cursor.next_day();
        }
        let calendar = TradingCalendar::from_dates(dates);
        assert_eq!(calendar.len(), 10);
        assert_eq!(calendar.first_on_or_after(Date::new(2023, 12, 31)), Some(Date::new(2024, 1, 1)));
        assert_eq!(calendar.last_on_or_before(Date::new(2024, 1, 6)), Some(Date::new(2024, 1, 5)));
        assert_eq!(calendar.natural_week_count(Date::new(2024, 1, 1), Date::new(2024, 1, 14)), 2);
        assert!(calendar.is_trading_day(Date::new(2024, 1, 2)));
        assert!(!calendar.is_trading_day(Date::new(2024, 1, 6)));
    }

    #[test]
    fn empty_and_unsorted_inputs_are_safe() {
        let calendar = TradingCalendar::from_dates(vec![
            Date::new(2024, 1, 3),
            Date::new(2024, 1, 2),
            Date::new(2024, 1, 3),
        ]);
        assert_eq!(calendar.dates(), &[Date::new(2024, 1, 2), Date::new(2024, 1, 3)]);
        assert_eq!(TradingCalendar::default().first_on_or_after(Date::new(2024, 1, 1)), None);
        assert_eq!(TradingCalendar::default().natural_week_count(Date::new(2024, 1, 1), Date::new(2024, 1, 31)), 0);
    }
}
