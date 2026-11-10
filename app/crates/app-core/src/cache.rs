//! 指标计算缓存（S-02.06-02）：内存 LRU，不落盘。
//!
//! 冻结口径：
//! - 条目上限 200，内存上限 256MB，先到先淘汰最久未用条目；
//! - 条目记录 `last_bar_date`，读取时与当前数据集 `coverage_end` 比对，
//!   不一致视为 miss（世代未变但数据被外部改动的双保险）；
//! - 单条目超出内存预算时跳过缓存（只渲染），由调用方记 `cache.skip_oom`。

use std::collections::HashMap;
use std::sync::Arc;

/// 卡面冻结的条目上限。
pub(crate) const MAX_ENTRIES: usize = 200;
/// 卡面冻结的内存上限：256MB。
pub(crate) const MAX_BYTES: usize = 256 * 1024 * 1024;

struct Entry {
    values: Arc<Vec<Vec<f64>>>,
    /// 写入时的数据集末端日期（manifest `coverage_end`）。
    last_bar_date: String,
    bytes: usize,
    used_at: u64,
}

/// 一次查表的结果。
pub(crate) enum Lookup {
    Hit(Arc<Vec<Vec<f64>>>),
    /// 条目存在，但记录的数据集末端日期与当前 `coverage_end` 不一致，已移除。
    Stale,
    Miss,
}

/// 一次写入的副作用，供调用方补埋点。
pub(crate) struct Inserted {
    pub evicted: Vec<String>,
    pub skipped_oom: bool,
}

pub(crate) struct CalcCache {
    entries: HashMap<String, Entry>,
    total_bytes: usize,
    clock: u64,
    max_entries: usize,
    max_bytes: usize,
}

impl CalcCache {
    pub(crate) fn new() -> Self {
        Self::with_limits(MAX_ENTRIES, MAX_BYTES)
    }

    fn with_limits(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            total_bytes: 0,
            clock: 0,
            max_entries,
            max_bytes,
        }
    }

    /// `coverage_end` 为空表示数据源不提供 manifest 覆盖区间，此时不做日期双保险。
    pub(crate) fn lookup(&mut self, key: &str, coverage_end: &str) -> Lookup {
        self.clock += 1;
        let Some(entry) = self.entries.get_mut(key) else {
            return Lookup::Miss;
        };
        if !coverage_end.is_empty() && entry.last_bar_date != coverage_end {
            if let Some(removed) = self.entries.remove(key) {
                self.total_bytes -= removed.bytes;
            }
            return Lookup::Stale;
        }
        entry.used_at = self.clock;
        Lookup::Hit(entry.values.clone())
    }

    pub(crate) fn insert(
        &mut self,
        key: String,
        values: Arc<Vec<Vec<f64>>>,
        last_bar_date: String,
    ) -> Inserted {
        let bytes = entry_bytes(&key, &last_bar_date, &values);
        if bytes > self.max_bytes {
            return Inserted {
                evicted: Vec::new(),
                skipped_oom: true,
            };
        }

        let mut evicted = Vec::new();
        while !self.entries.is_empty()
            && (self.entries.len() + 1 > self.max_entries
                || self.total_bytes + bytes > self.max_bytes)
        {
            let Some(victim) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.used_at)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(removed) = self.entries.remove(&victim) {
                self.total_bytes -= removed.bytes;
                evicted.push(victim);
            }
        }

        self.clock += 1;
        if let Some(old) = self.entries.insert(
            key,
            Entry {
                values,
                last_bar_date,
                bytes,
                used_at: self.clock,
            },
        ) {
            self.total_bytes -= old.bytes;
        }
        self.total_bytes += bytes;

        Inserted {
            evicted,
            skipped_oom: false,
        }
    }

    /// 仅供基准用例读取条目，不更新 LRU 顺序、不做日期校验。
    #[cfg(test)]
    pub(crate) fn peek(&self, key: &str) -> Option<Arc<Vec<Vec<f64>>>> {
        self.entries.get(key).map(|entry| entry.values.clone())
    }

    #[cfg(test)]
    pub(crate) fn keys(&self) -> impl Iterator<Item = &String> {
        self.entries.keys()
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
}

fn entry_bytes(key: &str, last_bar_date: &str, values: &[Vec<f64>]) -> usize {
    let values_bytes: usize = values.iter().map(|column| column.len() * 8).sum();
    values_bytes + key.len() + last_bar_date.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(rows: usize) -> Arc<Vec<Vec<f64>>> {
        Arc::new(vec![vec![1.0; rows]])
    }

    #[test]
    fn evicts_least_recently_used_when_entry_cap_reached() {
        let mut cache = CalcCache::with_limits(2, MAX_BYTES);
        assert!(
            !cache
                .insert("a".into(), values(4), "2024-12-27".into())
                .skipped_oom
        );
        assert!(
            !cache
                .insert("b".into(), values(4), "2024-12-27".into())
                .skipped_oom
        );
        // 触碰 a，使 b 成为最久未用。
        assert!(matches!(cache.lookup("a", "2024-12-27"), Lookup::Hit(_)));

        let inserted = cache.insert("c".into(), values(4), "2024-12-27".into());
        assert_eq!(inserted.evicted, vec!["b".to_string()]);
        assert_eq!(cache.len(), 2);
        assert!(matches!(cache.lookup("b", "2024-12-27"), Lookup::Miss));
        assert!(matches!(cache.lookup("a", "2024-12-27"), Lookup::Hit(_)));
    }

    #[test]
    fn stale_last_bar_date_is_miss_and_entry_removed() {
        let mut cache = CalcCache::with_limits(MAX_ENTRIES, MAX_BYTES);
        cache.insert("k".into(), values(4), "2024-12-27".into());

        assert!(matches!(cache.lookup("k", "2024-12-30"), Lookup::Stale));
        assert_eq!(cache.len(), 0);
        assert!(matches!(cache.lookup("k", "2024-12-30"), Lookup::Miss));
    }

    #[test]
    fn empty_coverage_end_skips_date_check() {
        let mut cache = CalcCache::with_limits(MAX_ENTRIES, MAX_BYTES);
        cache.insert("k".into(), values(4), String::new());
        assert!(matches!(cache.lookup("k", ""), Lookup::Hit(_)));
    }

    #[test]
    fn oversized_entry_is_skipped_without_evicting_others() {
        let mut cache = CalcCache::with_limits(MAX_ENTRIES, 16);
        cache.insert("keep".into(), values(1), String::new());

        let inserted = cache.insert("huge".into(), values(4), String::new());
        assert!(inserted.skipped_oom);
        assert!(inserted.evicted.is_empty());
        assert_eq!(cache.len(), 1);
        assert!(matches!(cache.lookup("keep", ""), Lookup::Hit(_)));
    }
}
