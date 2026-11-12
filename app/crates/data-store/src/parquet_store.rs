//! Parquet 分区存储（Sprint-5 AKA-70/73）。
//!
//! 每只股票一个 parquet 文件，存放在 `<root>/data/sim/{code}.parquet`。
//! 列 schema 与 `Candle` 一一对应，保证从 MockProvider 拿到的行情落盘后
//! 可以直接读回喂给 CandleStore 和 indicator-core 计算管线。
//!
//! 与 dataset_db（SQLite）的区别：
//! - dataset_db 是行存索引，负责 securities / index_members / meta 等元信息；
//! - parquet_store 是列式主数据，负责存 daily_bars 本体（压缩率更高、读更快）。
//! 两者共存：Parquet 存数据，SQLite 存目录和元数据。

use std::fs;
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::Arc;

use arrow_array::{
    Array, ArrayRef, Float64Array, Int64Array, RecordBatch, StringArray,
    builder::{Float64Builder, Int64Builder, StringBuilder},
};
use arrow_schema::{DataType, Field, Schema};
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use parquet::arrow::ArrowWriter;
use parquet::basic::Compression;
use parquet::file::properties::WriterProperties;
use thiserror::Error;

use crate::Candle;

#[derive(Debug, Error)]
pub enum ParquetStoreError {
    #[error("IO 错误：{0}")]
    Io(String),
    #[error("Arrow/Parquet 写入失败：{0}")]
    Write(String),
    #[error("Arrow/Parquet 读取失败：{0}")]
    Read(String),
    #[error("数据为空：{code} 没有 K 线可以写入")]
    Empty { code: String },
    #[error("文件不存在：{path}")]
    NotFound { path: String },
}

impl From<std::io::Error> for ParquetStoreError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

/// 列式 schema：与 Candle 字段对齐。
/// nullable 字段必须是 Utf8/Int64 的 Nullable 变体（StringArray / Int64Array）。
fn candle_schema() -> Schema {
    Schema::new(vec![
        Field::new("ts", DataType::Int64, false),
        Field::new("date", DataType::Utf8, false),
        Field::new("open", DataType::Float64, false),
        Field::new("high", DataType::Float64, false),
        Field::new("low", DataType::Float64, false),
        Field::new("close", DataType::Float64, false),
        Field::new("volume", DataType::Float64, false),
        Field::new("amount", DataType::Float64, false),
        Field::new("adj_factor", DataType::Float64, false),
        Field::new(
            "quality",
            DataType::Utf8,
            false, // "simulated,suspended" 逗号分隔
        ),
        Field::new(
            "source",
            DataType::Utf8,
            false, // "mock" / "tushare"
        ),
        Field::new(
            "batch_id",
            DataType::Utf8,
            true, // 可空
        ),
        Field::new(
            "ingested_at",
            DataType::Int64,
            true, // 可空
        ),
    ])
}

/// 单只股票 → Parquet 文件。
///
/// 默认命名规则：`<root>/data/sim/{code}.parquet`。
/// 也可以通过 [`ParquetStore::with_partition_dir`] 直接指定 parquet 文件的存放目录
/// （例如 sim_install 的 `<dataset_dir>/parquet/`）。
pub struct ParquetStore {
    partition_dir: PathBuf,
}

impl ParquetStore {
    /// 默认路径：`<root>/data/sim/`
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            partition_dir: root.into().join("data").join("sim"),
        }
    }

    /// 直接指定 parquet 文件的存放目录（不拼接 `data/sim/`）。
    pub fn with_partition_dir(dir: impl Into<PathBuf>) -> Self {
        Self { partition_dir: dir.into() }
    }

    /// parquet 文件存放目录
    pub fn partition_dir(&self) -> &PathBuf {
        &self.partition_dir
    }

    /// 兼容旧 API：等同 `partition_dir`
    pub fn sim_dir(&self) -> PathBuf {
        self.partition_dir.clone()
    }

    /// 指定 code 的 parquet 文件路径
    pub fn file_path(&self, code: &str) -> PathBuf {
        let safe = code.replace('/', "_");
        self.sim_dir().join(format!("{safe}.parquet"))
    }

    /// 是否存在数据目录（冷启动判定）
    pub fn has_data_dir(&self) -> bool {
        self.sim_dir().exists()
    }

    /// 目录下已有多少个 parquet 文件
    pub fn existing_files(&self) -> usize {
        if !self.sim_dir().exists() {
            return 0;
        }
        fs::read_dir(self.sim_dir())
            .map(|it| {
                it.filter_map(|e| e.ok())
                    .filter(|e| e.path().extension().map_or(false, |ext| ext == "parquet"))
                    .count()
            })
            .unwrap_or(0)
    }

    /// 按文件名升序返回所有分区文件（顺序稳定，摘要复算依赖它）。
    pub fn partition_files(&self) -> Result<Vec<PathBuf>, ParquetStoreError> {
        if !self.sim_dir().exists() {
            return Ok(Vec::new());
        }
        let mut files: Vec<PathBuf> = fs::read_dir(self.sim_dir())?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.extension().map_or(false, |ext| ext == "parquet"))
            .collect();
        files.sort();
        Ok(files)
    }

    /// 所有分区文件按文件名升序拼接后的字节流。
    ///
    /// 上层（`data_provider::sha256`）对这个字节串取 sha256 即为分区摘要；
    /// data-store 不引入 sha2，摘要口径由调用方决定。
    pub fn partition_bytes(&self) -> Result<Vec<u8>, ParquetStoreError> {
        let mut all = Vec::new();
        for path in self.partition_files()? {
            all.extend_from_slice(&fs::read(&path)?);
        }
        Ok(all)
    }

    /// 写入一只股票的 K 线。文件存在则覆盖（重建管线契约）。
    pub fn write_security(
        &self,
        code: &str,
        candles: &[Candle],
    ) -> Result<PathBuf, ParquetStoreError> {
        if candles.is_empty() {
            return Err(ParquetStoreError::Empty {
                code: code.to_string(),
            });
        }

        let out_dir = self.sim_dir();
        fs::create_dir_all(&out_dir)?;

        let out_path = self.file_path(code);
        let schema = candle_schema();
        let props = WriterProperties::builder()
            .set_compression(Compression::SNAPPY)
            .set_write_batch_size(4096)
            .build();

        let arrays = self.build_arrays(candles)?;

        let file = fs::File::create(&out_path)?;
        let mut buf = BufWriter::new(file);
        let mut writer = ArrowWriter::try_new(&mut buf, Arc::new(schema.clone()), Some(props))
            .map_err(|e| ParquetStoreError::Write(e.to_string()))?;

        let batch = RecordBatch::try_new(Arc::new(schema), arrays)
            .map_err(|e| ParquetStoreError::Write(e.to_string()))?;
        writer
            .write(&batch)
            .map_err(|e| ParquetStoreError::Write(e.to_string()))?;
        writer
            .close()
            .map_err(|e| ParquetStoreError::Write(e.to_string()))?;

        Ok(out_path)
    }

    /// 构建 13 个列数组。Arrow 的 Nullable 字段用 StringBuilder/Int64Builder
    /// 的 `.append_null()` / `.append_value()` 就能表达。
    fn build_arrays(&self, candles: &[Candle]) -> Result<Vec<ArrayRef>, ParquetStoreError> {
        let n = candles.len();
        let mut ts = Int64Builder::with_capacity(n);
        let mut date = StringBuilder::with_capacity(n, n * 10);
        let mut open = Float64Builder::with_capacity(n);
        let mut high = Float64Builder::with_capacity(n);
        let mut low = Float64Builder::with_capacity(n);
        let mut close = Float64Builder::with_capacity(n);
        let mut volume = Float64Builder::with_capacity(n);
        let mut amount = Float64Builder::with_capacity(n);
        let mut adj = Float64Builder::with_capacity(n);
        let mut quality = StringBuilder::with_capacity(n, n * 16);
        let mut source = StringBuilder::with_capacity(n, n * 6);
        let mut batch = StringBuilder::with_capacity(n, n * 16);
        let mut ingested = Int64Builder::with_capacity(n);

        for c in candles {
            ts.append_value(c.ts);
            date.append_value(&c.date);
            open.append_value(c.open);
            high.append_value(c.high);
            low.append_value(c.low);
            close.append_value(c.close);
            volume.append_value(c.volume);
            amount.append_value(c.amount);
            adj.append_value(c.adj_factor);
            quality.append_value(&c.quality.join(","));
            source.append_value(&c.source);
            match &c.batch_id {
                Some(s) => batch.append_value(s),
                None => batch.append_null(),
            }
            match c.ingested_at {
                Some(t) => ingested.append_value(t),
                None => ingested.append_null(),
            }
        }

        Ok(vec![
            Arc::new(ts.finish()),
            Arc::new(date.finish()),
            Arc::new(open.finish()),
            Arc::new(high.finish()),
            Arc::new(low.finish()),
            Arc::new(close.finish()),
            Arc::new(volume.finish()),
            Arc::new(amount.finish()),
            Arc::new(adj.finish()),
            Arc::new(quality.finish()),
            Arc::new(source.finish()),
            Arc::new(batch.finish()),
            Arc::new(ingested.finish()),
        ])
    }

    /// 从 parquet 文件读回一只股票的 K 线。
    pub fn read_security(&self, code: &str) -> Result<Vec<Candle>, ParquetStoreError> {
        let path = self.file_path(code);
        if !path.exists() {
            return Err(ParquetStoreError::NotFound {
                path: path.display().to_string(),
            });
        }
        let file = fs::File::open(&path)?;
        let reader = ParquetRecordBatchReaderBuilder::try_new(file)
            .map_err(|e| ParquetStoreError::Read(e.to_string()))?
            .with_batch_size(4096)
            .build()
            .map_err(|e| ParquetStoreError::Read(e.to_string()))?;

        let mut candles = Vec::new();
        for batch_result in reader {
            let batch = batch_result.map_err(|e| ParquetStoreError::Read(e.to_string()))?;
            self.decode_batch(&batch, &mut candles)?;
        }
        Ok(candles)
    }

    /// 加载目录下所有 parquet 文件 → `{code: candles}`。
    /// 用于冷启动时一次性把整个数据集装进内存 CandleStore。
    pub fn load_all(&self) -> Result<std::collections::HashMap<String, Vec<Candle>>, ParquetStoreError> {
        let mut map = std::collections::HashMap::new();
        if !self.sim_dir().exists() {
            return Ok(map);
        }
        for entry in fs::read_dir(self.sim_dir())? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().map_or(true, |ext| ext != "parquet") {
                continue;
            }
            let code = path
                .file_stem()
                .and_then(|s| s.to_str())
                .ok_or_else(|| ParquetStoreError::Read("文件名解码失败".into()))?;
            let candles = self.read_security(code)?;
            map.insert(code.to_string(), candles);
        }
        Ok(map)
    }

    /// 把一个 RecordBatch 的 13 列解构成 Candle 行。
    fn decode_batch(
        &self,
        batch: &RecordBatch,
        out: &mut Vec<Candle>,
    ) -> Result<(), ParquetStoreError> {
        if batch.num_rows() == 0 {
            return Ok(());
        }
        // 按 schema 顺序取列
        let cols: &[ArrayRef] = batch.columns();
        if cols.len() != 13 {
            return Err(ParquetStoreError::Read(format!(
                "列数不对：期望 13，实际 {}",
                cols.len()
            )));
        }

        let ts = cols[0]
            .as_any()
            .downcast_ref::<Int64Array>()
            .ok_or_else(|| ParquetStoreError::Read("ts 列类型错误".into()))?;
        let date = cols[1]
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| ParquetStoreError::Read("date 列类型错误".into()))?;
        let open = cols[2]
            .as_any()
            .downcast_ref::<Float64Array>()
            .ok_or_else(|| ParquetStoreError::Read("open 列类型错误".into()))?;
        let high = cols[3]
            .as_any()
            .downcast_ref::<Float64Array>()
            .ok_or_else(|| ParquetStoreError::Read("high 列类型错误".into()))?;
        let low = cols[4]
            .as_any()
            .downcast_ref::<Float64Array>()
            .ok_or_else(|| ParquetStoreError::Read("low 列类型错误".into()))?;
        let close = cols[5]
            .as_any()
            .downcast_ref::<Float64Array>()
            .ok_or_else(|| ParquetStoreError::Read("close 列类型错误".into()))?;
        let volume = cols[6]
            .as_any()
            .downcast_ref::<Float64Array>()
            .ok_or_else(|| ParquetStoreError::Read("volume 列类型错误".into()))?;
        let amount = cols[7]
            .as_any()
            .downcast_ref::<Float64Array>()
            .ok_or_else(|| ParquetStoreError::Read("amount 列类型错误".into()))?;
        let adj = cols[8]
            .as_any()
            .downcast_ref::<Float64Array>()
            .ok_or_else(|| ParquetStoreError::Read("adj_factor 列类型错误".into()))?;
        let quality = cols[9]
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| ParquetStoreError::Read("quality 列类型错误".into()))?;
        let source = cols[10]
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| ParquetStoreError::Read("source 列类型错误".into()))?;
        let batch_id = cols[11]
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| ParquetStoreError::Read("batch_id 列类型错误".into()))?;
        let ingested = cols[12]
            .as_any()
            .downcast_ref::<Int64Array>()
            .ok_or_else(|| ParquetStoreError::Read("ingested_at 列类型错误".into()))?;

        for i in 0..batch.num_rows() {
            out.push(Candle {
                ts: ts.value(i),
                date: date.value(i).to_string(),
                open: open.value(i),
                high: high.value(i),
                low: low.value(i),
                close: close.value(i),
                volume: volume.value(i),
                amount: amount.value(i),
                adj_factor: adj.value(i),
                quality: quality.value(i).split(',').map(|s| s.to_string()).collect(),
                source: source.value(i).to_string(),
                batch_id: if batch_id.is_null(i) {
                    None
                } else {
                    Some(batch_id.value(i).to_string())
                },
                ingested_at: if ingested.is_null(i) {
                    None
                } else {
                    Some(ingested.value(i))
                },
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn mk_candle(code: &str, day: u64, close: f64) -> Candle {
        let ts = UNIX_EPOCH.checked_add(std::time::Duration::from_secs(day * 86_400)).unwrap();
        let dt = ts.duration_since(UNIX_EPOCH).unwrap().as_secs();
        Candle {
            ts: dt as i64,
            date: format!("2026-01-{:02}", (day % 28) + 1),
            open: close * 0.995,
            high: close * 1.01,
            low: close * 0.99,
            close,
            volume: 1_000_000.0,
            amount: close * 1_000_000.0,
            adj_factor: 1.0,
            quality: vec!["simulated".to_string()],
            source: "mock".to_string(),
            batch_id: Some(format!("b-20260101-{code}")),
            ingested_at: Some(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_secs() as i64,
            ),
        }
    }

    fn mk_store() -> (ParquetStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        (ParquetStore::new(dir.path()), dir)
    }

    #[test]
    fn writes_single_file_and_directory() {
        let (store, _tmp) = mk_store();
        let candles: Vec<Candle> = (1..=60).map(|d| mk_candle("600519.SH", d, 1800.0 + d as f64)).collect();

        let out = store.write_security("600519.SH", &candles).unwrap();

        assert!(out.exists());
        assert!(store.sim_dir().exists());
        assert_eq!(store.existing_files(), 1);
    }

    #[test]
    fn empty_bars_rejected() {
        let (store, _tmp) = mk_store();
        let err = store.write_security("600519.SH", &[]).unwrap_err();
        matches!(err, ParquetStoreError::Empty { .. });
    }

    #[test]
    fn overwrites_existing_file() {
        let (store, _tmp) = mk_store();

        store
            .write_security("600519.SH", &[mk_candle("600519.SH", 1, 1800.0)])
            .unwrap();
        let first_size = store.file_path("600519.SH").metadata().unwrap().len();

        // 重建：更多数据
        let big: Vec<Candle> = (1..=240).map(|d| mk_candle("600519.SH", d, 1900.0 + d as f64)).collect();
        store.write_security("600519.SH", &big).unwrap();
        let second_size = store.file_path("600519.SH").metadata().unwrap().len();

        assert!(second_size > first_size, "重建应覆盖旧文件且更大");
    }

    #[test]
    fn roundtrip_write_then_read() {
        let (store, _tmp) = mk_store();
        let original: Vec<Candle> = (1..=120)
            .map(|d| mk_candle("600519.SH", d, 1800.0 + d as f64))
            .collect();

        store.write_security("600519.SH", &original).unwrap();
        let read = store.read_security("600519.SH").unwrap();

        assert_eq!(read.len(), original.len());
        for (i, (o, r)) in original.iter().zip(read.iter()).enumerate() {
            assert_eq!(r.ts, o.ts, "行 {i} ts 不匹配");
            assert_eq!(r.date, o.date, "行 {i} date 不匹配");
            assert!((r.close - o.close).abs() < 1e-9, "行 {i} close 不匹配");
            assert_eq!(r.batch_id, o.batch_id, "行 {i} batch_id 不匹配");
            assert_eq!(r.ingested_at, o.ingested_at, "行 {i} ingested_at 不匹配");
            assert_eq!(r.quality, o.quality, "行 {i} quality 不匹配");
        }
    }

    #[test]
    fn read_nonexistent_returns_notfound() {
        let (store, _tmp) = mk_store();
        let err = store.read_security("999999.SH").unwrap_err();
        matches!(err, ParquetStoreError::NotFound { .. });
    }

    #[test]
    fn load_all_reads_multiple_files() {
        let (store, _tmp) = mk_store();
        let a: Vec<Candle> = (1..=10)
            .map(|d| mk_candle("600519.SH", d, 1800.0 + d as f64))
            .collect();
        let b: Vec<Candle> = (1..=20)
            .map(|d| mk_candle("000001.SZ", d, 10.0 + d as f64))
            .collect();
        store.write_security("600519.SH", &a).unwrap();
        store.write_security("000001.SZ", &b).unwrap();

        let all = store.load_all().unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all.get("600519.SH").unwrap().len(), 10);
        assert_eq!(all.get("000001.SZ").unwrap().len(), 20);
    }
}
