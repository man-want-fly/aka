//! 极简公历日期：只做交易日偏移与 ISO 文本，不引入 chrono。
//! 骨架期不处理法定节假日，周末即非交易日（真实日历由 provider 提供）。

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Date {
    year: i32,
    month: u8,
    day: u8,
}

impl Date {
    pub const fn new(year: i32, month: u8, day: u8) -> Self {
        Self { year, month, day }
    }

    pub const fn year(self) -> i32 {
        self.year
    }

    pub const fn month(self) -> u8 {
        self.month
    }

    pub const fn day(self) -> u8 {
        self.day
    }

    /// 1970-01-01 起的天数（Howard Hinnant 算法）。
    pub fn to_days(self) -> i64 {
        let y = self.year as i64 - if self.month <= 2 { 1 } else { 0 };
        let era = (if y >= 0 { y } else { y - 399 }) / 400;
        let yoe = y - era * 400;
        let mp = ((self.month as i64 + 9) % 12) as i64;
        let doy = (153 * mp + 2) / 5 + self.day as i64 - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146097 + doe - 719468
    }

    pub fn from_days(days: i64) -> Self {
        let z = days + 719468;
        let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
        let doe = z - era * 146097;
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = mp + if mp < 10 { 3 } else { -9 };
        let y = y + if m <= 2 { 1 } else { 0 };
        Self {
            year: y as i32,
            month: m as u8,
            day: d as u8,
        }
    }

    /// 0 = 周日，6 = 周六。
    pub fn weekday(self) -> u8 {
        let w = (self.to_days() + 4).rem_euclid(7);
        w as u8
    }

    pub fn is_weekend(self) -> bool {
        matches!(self.weekday(), 0 | 6)
    }

    pub fn next_day(self) -> Self {
        Self::from_days(self.to_days() + 1)
    }

    pub fn next_weekday(self) -> Self {
        let mut d = self.next_day();
        while d.is_weekend() {
            d = d.next_day();
        }
        d
    }

    /// epoch 秒（UTC 零点）。前端按本地日期格式化时仍落在同一天。
    pub fn epoch_secs(self) -> i64 {
        self.to_days() * 86_400
    }

    pub fn iso(self) -> String {
        format!("{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }
}

impl std::fmt::Display for Date {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.iso())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_weekday() {
        let d = Date::new(2024, 12, 31);
        assert_eq!(Date::from_days(d.to_days()), d);
        assert_eq!(d.weekday(), 2); // 周二
        assert_eq!(Date::new(1970, 1, 1).to_days(), 0);
        assert_eq!(Date::new(1970, 1, 1).weekday(), 4); // 周四
    }

    #[test]
    fn skips_weekend() {
        // 2024-12-28 是周六，下一个工作日是 12-30 周一
        let d = Date::new(2024, 12, 28);
        assert!(d.is_weekend());
        assert_eq!(d.next_weekday(), Date::new(2024, 12, 30));
    }
}
