//! S-07.03-01 首装生成器的**确定性种子计划**（纯数据、无 IO）。
//!
//! 口径来源：`manifest/constants.json` 的 `securities=120`、`stocks=112`、
//! `indices=8`、`barsPerSecurity=520`、`rows=62400`。本模块只负责「生成什么」，
//! 落盘与 SQL 计数在 `data-store::dataset_db`，编排在 `app-core::sim_install`。
//!
//! 256 条 `index_members` 的可复算定义（P11/P12/P13 共用这一份）：
//! - 股票池 = 14 只已知标的 + 4 个生成组（601×38、002×38、300×14、688×8），
//!   共 112 只，按代码升序排列，序号 `0..112`。
//! - 指数 = `INDEX_DEFS` 固定 8 只，按数组顺序，序号 `0..8`。
//! - 第 `i` 个指数的第 `j` 条成分（`j = 0..32`）= 股票池第
//!   `(i * 14 + j * 3) mod 112` 只；`gcd(3, 112) = 1`，保证同一指数内不重复。
//! - `ordinal = j + 1`，`as_of` = 数据集覆盖末日。
//!
//! 校验函数 [`verify_index_members`] 只做「重算 + 集合比较」，不读 UI、不读 fixture。

use crate::date::Date;
use crate::mock::{build_calendar, generate_bars, make_security, MOCK_BARS_PER_SECURITY, MOCK_FIRST_DATE};
use crate::types::{BarRow, Board, Security};

/// 生成器契约版本；写入 dataset.db 的 meta 表，重建时可判断是否需要清库。
pub const INSTALL_SCHEMA_VERSION: &str = "sim-install/v1";

pub const STOCK_COUNT: usize = 112;
pub const INDEX_COUNT: usize = 8;
pub const SECURITY_COUNT: usize = STOCK_COUNT + INDEX_COUNT;
pub const BARS_PER_SECURITY: usize = MOCK_BARS_PER_SECURITY;
pub const TOTAL_BARS: usize = SECURITY_COUNT * BARS_PER_SECURITY;
pub const MEMBERS_PER_INDEX: usize = 32;
pub const INDEX_MEMBER_TOTAL: usize = INDEX_COUNT * MEMBERS_PER_INDEX;
pub const ESTIMATED_BYTES: u64 = 180 * 1024 * 1024;
/// sha256 复算口径：按 [`build_install_securities`] 的稳定顺序（112 股票代码升序 →
/// 8 指数），逐只取 `date,open,high,low,close,volume,amount` 规范行，共用 1 行表头。
pub const SHA_SCOPE: &str = "securities-code-order/v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InstallStepDef {
    pub index: u8,
    pub key: &'static str,
    pub name: &'static str,
}

/// 5 步固定；步骤名不可改（卡面「步骤名不可改」）。
pub const INSTALL_STEPS: [InstallStepDef; 5] = [
    InstallStepDef { index: 1, key: "env", name: "校验环境" },
    InstallStepDef { index: 2, key: "securities", name: "生成证券主数据" },
    InstallStepDef { index: 3, key: "daily", name: "生成日线与复权因子" },
    InstallStepDef { index: 4, key: "indices", name: "生成指数与行业" },
    InstallStepDef { index: 5, key: "verify", name: "校验入库" },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IndexDef {
    pub code: &'static str,
    pub name: &'static str,
    pub base_price_milli: u32,
}

/// 8 只指数：代码、名称与基准价全部固定，顺序即 `index_members` 的指数序号。
pub const INDEX_DEFS: [IndexDef; INDEX_COUNT] = [
    IndexDef { code: "000001.SH", name: "上证指数", base_price_milli: 3_200_000 },
    IndexDef { code: "399001.SZ", name: "深证成指", base_price_milli: 10_800_000 },
    IndexDef { code: "399006.SZ", name: "创业板指", base_price_milli: 2_150_000 },
    IndexDef { code: "000300.SH", name: "沪深300", base_price_milli: 3_800_000 },
    IndexDef { code: "000016.SH", name: "上证50", base_price_milli: 2_600_000 },
    IndexDef { code: "000905.SH", name: "中证500", base_price_milli: 5_600_000 },
    IndexDef { code: "000852.SH", name: "中证1000", base_price_milli: 6_100_000 },
    IndexDef { code: "000688.SH", name: "科创50", base_price_milli: 1_050_000 },
];

#[derive(Debug, Clone, PartialEq)]
pub struct IndexMemberRow {
    pub index_code: String,
    pub security_code: String,
    pub as_of: String,
    pub ordinal: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberIssue {
    pub code: String,
    pub message: String,
}

fn fnv1a(text: &str) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in text.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// 112 只股票：14 只已知标的 + 98 只按固定前缀生成，按代码升序返回。
pub fn build_stock_universe() -> Vec<Security> {
    let known: [(&str, &str, Board, f64); 14] = [
        ("300750.SZ", "宁德时代", Board::ChiNext, 218.60),
        ("600519.SH", "贵州茅台", Board::ShMain, 1628.33),
        ("002594.SZ", "比亚迪", Board::SzMain, 268.40),
        ("601318.SH", "中国平安", Board::ShMain, 51.28),
        ("600036.SH", "招商银行", Board::ShMain, 37.15),
        ("000858.SZ", "五粮液", Board::SzMain, 138.42),
        ("688981.SH", "中芯国际", Board::Star, 92.68),
        ("300059.SZ", "东方财富", Board::ChiNext, 15.72),
        ("601899.SH", "紫金矿业", Board::ShMain, 17.45),
        ("002415.SZ", "海康威视", Board::SzMain, 31.06),
        ("600030.SH", "中信证券", Board::ShMain, 28.34),
        ("601012.SH", "隆基绿能", Board::ShMain, 18.92),
        ("000651.SZ", "格力电器", Board::SzMain, 42.75),
        ("600900.SH", "长江电力", Board::ShMain, 28.16),
    ];

    let mut stocks = Vec::with_capacity(STOCK_COUNT);
    for (code, name, board, price) in known {
        stocks.push(make_security(code, name, board, false, price));
    }

    let mut used: std::collections::HashSet<String> =
        stocks.iter().map(|security| security.code.clone()).collect();
    let groups: [(&str, usize, Board); 4] = [
        ("601", 38, Board::ShMain),
        ("002", 38, Board::SzMain),
        ("300", 14, Board::ChiNext),
        ("688", 8, Board::Star),
    ];

    let mut serial = 1;
    for (prefix, count, board) in groups {
        let mut offset = 0;
        let mut added = 0;
        while added < count {
            let code = match prefix {
                "601" => format!("{:06}.SH", 601_000 + offset),
                "688" => format!("688{:03}.SH", 100 + offset),
                _ => format!("{}{:03}.SZ", prefix, 100 + offset),
            };
            offset += 1;
            if used.contains(&code) {
                continue;
            }
            used.insert(code.clone());
            let name = format!("示例标的 {serial:03}");
            let price = 5.0 + (fnv1a(&code) % 2000) as f64 / 10.0;
            stocks.push(make_security(&code, &name, board, false, price));
            serial += 1;
            added += 1;
        }
    }

    debug_assert_eq!(stocks.len(), STOCK_COUNT);
    stocks.sort_by(|left, right| left.code.cmp(&right.code));
    stocks
}

pub fn build_index_universe() -> Vec<Security> {
    INDEX_DEFS
        .iter()
        .map(|index| {
            make_security(
                index.code,
                index.name,
                Board::Index,
                true,
                index.base_price_milli as f64 / 1000.0,
            )
        })
        .collect()
}

/// 120 只证券的稳定顺序：先 112 只股票（代码升序），再 8 只指数（`INDEX_DEFS` 顺序）。
pub fn build_install_securities() -> Vec<Security> {
    let mut list = build_stock_universe();
    list.extend(build_index_universe());
    list
}

/// 覆盖区间与 mock 一致：2023-01-02 起 520 个工作日。
pub fn install_calendar() -> Vec<Date> {
    build_calendar(MOCK_FIRST_DATE, BARS_PER_SECURITY)
}

pub fn coverage() -> (Date, Date) {
    let calendar = install_calendar();
    let first = *calendar.first().expect("交易日历不能为空");
    let last = *calendar.last().expect("交易日历不能为空");
    (first, last)
}

/// 单只证券的日线：复用 mock 的确定性生成器，保证同 seed 同内容。
pub fn generate_security_bars(security: &Security, calendar: &[Date]) -> Vec<BarRow> {
    generate_bars(security, calendar)
}

/// 256 条成分：实现上述公式，输入必须已经是 `build_stock_universe()` 的顺序。
pub fn build_index_members(stocks: &[Security], as_of: Date) -> Vec<IndexMemberRow> {
    assert_eq!(stocks.len(), STOCK_COUNT, "股票池必须是 112 只");
    let as_of = as_of.iso();
    let mut rows = Vec::with_capacity(INDEX_MEMBER_TOTAL);
    for (index_pos, index) in INDEX_DEFS.iter().enumerate() {
        for slot in 0..MEMBERS_PER_INDEX {
            let stock_pos = (index_pos * 14 + slot * 3) % STOCK_COUNT;
            rows.push(IndexMemberRow {
                index_code: index.code.to_string(),
                security_code: stocks[stock_pos].code.clone(),
                as_of: as_of.clone(),
                ordinal: (slot + 1) as u32,
            });
        }
    }
    rows
}

/// 完整性校验：只做集合与计数比较，不复用生成过程的中间状态。
pub fn verify_index_members(
    members: &[IndexMemberRow],
    stocks: &[Security],
    indices: &[Security],
    coverage_end: Date,
) -> Vec<MemberIssue> {
    let mut issues = Vec::new();
    let stock_codes: std::collections::HashSet<&str> =
        stocks.iter().map(|security| security.code.as_str()).collect();
    let index_codes: std::collections::HashSet<&str> =
        indices.iter().map(|security| security.code.as_str()).collect();

    if stocks.len() != STOCK_COUNT {
        issues.push(MemberIssue {
            code: "STOCK_COUNT".into(),
            message: format!("股票池应为 {STOCK_COUNT} 只，实际 {}", stocks.len()),
        });
    }
    if indices.len() != INDEX_COUNT {
        issues.push(MemberIssue {
            code: "INDEX_COUNT".into(),
            message: format!("指数应为 {INDEX_COUNT} 只，实际 {}", indices.len()),
        });
    }
    if members.len() != INDEX_MEMBER_TOTAL {
        issues.push(MemberIssue {
            code: "MEMBER_TOTAL".into(),
            message: format!(
                "index_members 应为 {INDEX_MEMBER_TOTAL} 条，实际 {}",
                members.len()
            ),
        });
    }

    let expected_as_of = coverage_end.iso();
    let mut seen = std::collections::HashSet::new();
    let mut per_index: std::collections::BTreeMap<&str, Vec<u32>> = std::collections::BTreeMap::new();

    for row in members {
        if !index_codes.contains(row.index_code.as_str()) {
            issues.push(MemberIssue {
                code: "UNKNOWN_INDEX".into(),
                message: format!("未知指数 {}", row.index_code),
            });
        }
        if !stock_codes.contains(row.security_code.as_str()) {
            issues.push(MemberIssue {
                code: "UNKNOWN_SECURITY".into(),
                message: format!("成分不在股票池：{}", row.security_code),
            });
        }
        if row.as_of != expected_as_of {
            issues.push(MemberIssue {
                code: "AS_OF".into(),
                message: format!(
                    "{} 的 as_of={}，应为 {}",
                    row.security_code, row.as_of, expected_as_of
                ),
            });
        }
        if !seen.insert((row.index_code.clone(), row.security_code.clone())) {
            issues.push(MemberIssue {
                code: "DUPLICATE_MEMBER".into(),
                message: format!("{} 重复包含 {}", row.index_code, row.security_code),
            });
        }
        per_index
            .entry(row.index_code.as_str())
            .or_default()
            .push(row.ordinal);
    }

    for index in INDEX_DEFS {
        let ordinals = per_index.get(index.code).cloned().unwrap_or_default();
        if ordinals.len() != MEMBERS_PER_INDEX {
            issues.push(MemberIssue {
                code: "PER_INDEX_COUNT".into(),
                message: format!(
                    "{} 应有 {MEMBERS_PER_INDEX} 条成分，实际 {}",
                    index.code,
                    ordinals.len()
                ),
            });
        }
        let mut sorted = ordinals;
        sorted.sort_unstable();
        let expected: Vec<u32> = (1..=MEMBERS_PER_INDEX as u32).collect();
        if sorted != expected {
            issues.push(MemberIssue {
                code: "ORDINAL".into(),
                message: format!("{} 的 ordinal 不是 1..={MEMBERS_PER_INDEX}", index.code),
            });
        }
    }

    issues
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn universe_matches_frozen_constants() {
        let stocks = build_stock_universe();
        let indices = build_index_universe();
        let securities = build_install_securities();
        assert_eq!(stocks.len(), 112);
        assert_eq!(indices.len(), 8);
        assert_eq!(securities.len(), 120);

        let mut codes: Vec<&str> = securities.iter().map(|s| s.code.as_str()).collect();
        codes.sort_unstable();
        let before = codes.len();
        codes.dedup();
        assert_eq!(before, codes.len(), "证券代码必须唯一");
    }

    #[test]
    fn index_members_are_recomputable_and_complete() {
        let stocks = build_stock_universe();
        let indices = build_index_universe();
        let (_, last) = coverage();
        let members = build_index_members(&stocks, last);
        assert_eq!(members.len(), 256);
        assert!(verify_index_members(&members, &stocks, &indices, last).is_empty());

        // 重算一遍必须逐条相等：下游用同一公式复算，不依赖本次生成的中间状态。
        let again = build_index_members(&stocks, last);
        assert_eq!(members, again);
    }

    #[test]
    fn cross_index_overlap_is_allowed_but_within_index_is_not() {
        let stocks = build_stock_universe();
        let (_, last) = coverage();
        let members = build_index_members(&stocks, last);
        for index in INDEX_DEFS {
            let mut codes: Vec<&str> = members
                .iter()
                .filter(|row| row.index_code == index.code)
                .map(|row| row.security_code.as_str())
                .collect();
            let before = codes.len();
            codes.sort_unstable();
            codes.dedup();
            assert_eq!(before, 32);
            assert_eq!(codes.len(), 32);
        }
    }

    #[test]
    fn verify_detects_missing_member() {
        let stocks = build_stock_universe();
        let indices = build_index_universe();
        let (_, last) = coverage();
        let mut members = build_index_members(&stocks, last);
        members.pop();
        let issues = verify_index_members(&members, &stocks, &indices, last);
        assert!(issues.iter().any(|issue| issue.code == "MEMBER_TOTAL"));
        assert!(issues.iter().any(|issue| issue.code == "PER_INDEX_COUNT"));
    }

    #[test]
    fn bars_are_stable_and_match_frozen_shape() {
        let calendar = install_calendar();
        assert_eq!(calendar.len(), 520);
        assert_eq!(calendar.first().unwrap().iso(), "2023-01-02");
        assert_eq!(calendar.last().unwrap().iso(), "2024-12-27");
        let stocks = build_stock_universe();
        let rows = generate_security_bars(&stocks[0], &calendar);
        assert_eq!(rows.len(), 520);
        assert!(rows.windows(2).all(|pair| pair[0].date < pair[1].date));
    }
}
