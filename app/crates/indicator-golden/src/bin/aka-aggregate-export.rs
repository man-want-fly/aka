//! 周/月聚合与 IPC 报文快照导出：`cargo run -p indicator-golden --bin aka-aggregate-export`。
//!
//! 产物（提交仓库，QA 对照）：
//! - `app/bench/aggregates/{daily,weekly,monthly}-<code>.csv`：3 只标的的日/周/月 OHLCV
//! - `app/bench/aggregates/report.json`：根数、成交量守恒、首末价格一致性
//! - `app/bench/ipc-snapshots/*.json`：10 条真实请求/响应报文（含 1 条错误样例）
//!
//! 独立对拍：`python3 app/tools/verify_aggregates.py` 用 Python 的 isocalendar 重算并逐行比对。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use app_core::{AppCore, CalcRequest, GetBarsRequest, InstanceRequest, ListSecuritiesRequest};
use serde_json::json;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn bars_req(security: &str, timeframe: &str, from: Option<&str>, to: Option<&str>) -> GetBarsRequest {
    GetBarsRequest {
        security: security.to_string(),
        timeframe: timeframe.to_string(),
        adj: "qfq".to_string(),
        from: from.map(str::to_string),
        to: to.map(str::to_string),
    }
}

fn csv(resp: &app_core::BarsResponse) -> String {
    let mut out = String::from("date,open,high,low,close,volume,amount\n");
    for bar in &resp.bars {
        out.push_str(&format!(
            "{},{:.2},{:.2},{:.2},{:.2},{:.0},{:.2}\n",
            bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.amount
        ));
    }
    out
}

fn bars_request_json(
    security: &str,
    timeframe: &str,
    from: Option<&str>,
    to: Option<&str>,
) -> serde_json::Value {
    json!({
        "security": security,
        "timeframe": timeframe,
        "adj": "qfq",
        "from": from,
        "to": to,
    })
}

#[tokio::main]
async fn main() -> io::Result<()> {
    let root = repo_root();
    let bench = root.join("bench/aggregates");
    let snapshots = root.join("bench/ipc-snapshots");
    fs::create_dir_all(&bench)?;
    fs::create_dir_all(&snapshots)?;

    let core = AppCore::new_mock()
        .await
        .map_err(|err| io::Error::new(io::ErrorKind::Other, format!("{err:?}")))?;

    let securities = core.list_securities(&ListSecuritiesRequest {
        market: None,
        limit: None,
    });
    let codes: Vec<String> = securities
        .iter()
        .filter(|item| !item.is_index)
        .take(3)
        .map(|item| item.code.clone())
        .collect();
    if codes.len() < 3 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "mock 标的不满 3 只"));
    }

    let mut report = Vec::new();
    for code in &codes {
        let daily = core
            .get_bars(&bars_req(code, "D", None, None))
            .await
            .map_err(|err| io::Error::new(io::ErrorKind::Other, format!("{err:?}")))?;
        let weekly = core
            .get_bars(&bars_req(code, "W", None, None))
            .await
            .map_err(|err| io::Error::new(io::ErrorKind::Other, format!("{err:?}")))?;
        let monthly = core
            .get_bars(&bars_req(code, "M", None, None))
            .await
            .map_err(|err| io::Error::new(io::ErrorKind::Other, format!("{err:?}")))?;

        fs::write(bench.join(format!("daily-{code}.csv")), csv(&daily))?;
        fs::write(bench.join(format!("weekly-{code}.csv")), csv(&weekly))?;
        fs::write(bench.join(format!("monthly-{code}.csv")), csv(&monthly))?;

        let daily_volume: f64 = daily.bars.iter().map(|bar| bar.volume).sum();
        let weekly_volume: f64 = weekly.bars.iter().map(|bar| bar.volume).sum();
        let monthly_volume: f64 = monthly.bars.iter().map(|bar| bar.volume).sum();

        report.push(json!({
            "security": code,
            "dailyBars": daily.bars.len(),
            "weeklyBars": weekly.bars.len(),
            "monthlyBars": monthly.bars.len(),
            "volumeConservedWeekly": (weekly_volume - daily_volume).abs() < 1e-6,
            "volumeConservedMonthly": (monthly_volume - daily_volume).abs() < 1e-6,
            "firstOpenMatchesWeekly": weekly.bars.first().map(|bar| bar.open) == daily.bars.first().map(|bar| bar.open),
            "lastCloseMatchesWeekly": weekly.bars.last().map(|bar| bar.close) == daily.bars.last().map(|bar| bar.close),
            "firstOpenMatchesMonthly": monthly.bars.first().map(|bar| bar.open) == daily.bars.first().map(|bar| bar.open),
            "lastCloseMatchesMonthly": monthly.bars.last().map(|bar| bar.close) == daily.bars.last().map(|bar| bar.close),
        }));
    }

    let report_payload = json!({
        "formatVersion": 1,
        "provider": "mock(seed=42)",
        "aggregation": "ISO-8601 周（周一起）/ 公历自然月；停牌整周不生成周线",
        "securities": report,
    });
    fs::write(
        bench.join("report.json"),
        format!("{}\n", serde_json::to_string_pretty(&report_payload)?),
    )?;

    // ---- 10 条 IPC 报文快照（请求 + 响应/错误原样）----
    let code = &codes[0];
    let mut snapshots_out: Vec<(String, serde_json::Value)> = Vec::new();

    for (index, timeframe) in ["D", "W", "M"].iter().enumerate() {
        let request = bars_req(code, timeframe, None, None);
        let response = core
            .get_bars(&request)
            .await
            .map_err(|err| io::Error::new(io::ErrorKind::Other, format!("{err:?}")))?;
        snapshots_out.push((
            format!("0{}-get-bars-{}", index + 1, timeframe.to_lowercase()),
            json!({
                "command": "get_bars",
                "request": bars_request_json(code, timeframe, None, None),
                "response": response,
            }),
        ));
    }

    for (index, timeframe) in ["D", "W"].iter().enumerate() {
        let request = bars_req(code, timeframe, Some("2023-06-01"), Some("2023-12-29"));
        let response = core
            .get_bars(&request)
            .await
            .map_err(|err| io::Error::new(io::ErrorKind::Other, format!("{err:?}")))?;
        snapshots_out.push((
            format!("0{}-get-bars-{}-range", index + 4, timeframe.to_lowercase()),
            json!({
                "command": "get_bars",
                "request": bars_request_json(code, timeframe, Some("2023-06-01"), Some("2023-12-29")),
                "response": response,
            }),
        ));
    }

    let calc = CalcRequest {
        security: code.clone(),
        timeframe: "D".into(),
        adj: "qfq".into(),
        from: None,
        to: None,
        generation: 1,
        instances: vec![
            InstanceRequest {
                instance_id: "main-ma".into(),
                indicator_id: "T01".into(),
                params: std::collections::BTreeMap::from([(
                    "period".to_string(),
                    indicator_core::ParamValue::Int(20),
                )]),
            },
            InstanceRequest {
                instance_id: "sub-macd".into(),
                indicator_id: "M06".into(),
                params: std::collections::BTreeMap::from([
                    ("fast".to_string(), indicator_core::ParamValue::Int(12)),
                    ("slow".to_string(), indicator_core::ParamValue::Int(26)),
                    ("signal".to_string(), indicator_core::ParamValue::Int(9)),
                ]),
            },
        ],
    };
    let calc_response = core
        .calc_indicators(&calc)
        .await
        .map_err(|err| io::Error::new(io::ErrorKind::Other, format!("{err:?}")))?;
    snapshots_out.push((
        "06-calc-t01-m06".into(),
        json!({
            "command": "calc_indicators",
            "request": {
                "security": code,
                "timeframe": "D",
                "adj": "qfq",
                "from": null,
                "to": null,
                "generation": 1,
                "instances": [
                    { "instanceId": "main-ma", "indicatorId": "T01", "params": { "period": 20 } },
                    { "instanceId": "sub-macd", "indicatorId": "M06", "params": { "fast": 12, "slow": 26, "signal": 9 } },
                ],
            },
            "response": calc_response,
        }),
    ));

    let alias = CalcRequest {
        security: code.clone(),
        timeframe: "D".into(),
        adj: "qfq".into(),
        from: Some("2023-12-01".into()),
        to: Some("2023-12-29".into()),
        generation: 2,
        instances: vec![InstanceRequest {
            instance_id: "alias-ma".into(),
            indicator_id: "ma".into(),
            params: std::collections::BTreeMap::from([(
                "period".to_string(),
                indicator_core::ParamValue::Int(10),
            )]),
        }],
    };
    let alias_response = core
        .calc_indicators(&alias)
        .await
        .map_err(|err| io::Error::new(io::ErrorKind::Other, format!("{err:?}")))?;
    snapshots_out.push((
        "07-calc-alias-ma".into(),
        json!({
            "command": "calc_indicators",
            "request": {
                "security": code,
                "timeframe": "D",
                "adj": "qfq",
                "from": "2023-12-01",
                "to": "2023-12-29",
                "generation": 2,
                "instances": [
                    { "instanceId": "alias-ma", "indicatorId": "ma", "params": { "period": 10 } },
                ],
            },
            "response": alias_response,
        }),
    ));

    let registry = core.indicator_registry(None);
    snapshots_out.push((
        "08-indicator-registry".into(),
        json!({ "command": "indicator_registry", "request": {"category": null}, "response": registry }),
    ));

    snapshots_out.push((
        "09-list-securities".into(),
        json!({
            "command": "list_securities",
            "request": { "market": null, "limit": null },
            "response": securities,
        }),
    ));

    let bad = core
        .get_bars(&bars_req("999999.XX", "D", None, None))
        .await
        .err()
        .map(|err| serde_json::to_value(&err).unwrap_or_else(|_| json!({ "code": "INTERNAL" })))
        .unwrap_or_else(|| json!({ "unexpected": "应返回错误" }));
    snapshots_out.push((
        "10-error-unknown-security".into(),
        json!({
            "command": "get_bars",
            "request": bars_request_json("999999.XX", "D", None, None),
            "error": bad,
        }),
    ));

    let mut index = Vec::new();
    for (name, payload) in &snapshots_out {
        let path = snapshots.join(format!("{name}.json"));
        fs::write(&path, format!("{}\n", serde_json::to_string_pretty(payload)?))?;
        index.push(json!({
            "file": format!("{name}.json"),
            "command": payload["command"],
            "hasError": payload.get("error").is_some(),
        }));
    }
    fs::write(
        snapshots.join("index.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({
                "formatVersion": 1,
                "provider": "mock(seed=42)",
                "count": index.len(),
                "messages": index,
            }))?
        ),
    )?;

    println!("aggregates: {} 只标的，报告 {}", codes.len(), bench.join("report.json").display());
    println!("ipc snapshots: {} 条，目录 {}", snapshots_out.len(), snapshots.display());
    for item in report {
        println!(
            "  {} D={} W={} M={} 量守恒={}/{}",
            item["security"], item["dailyBars"], item["weeklyBars"], item["monthlyBars"],
            item["volumeConservedWeekly"], item["volumeConservedMonthly"]
        );
    }
    Ok(())
}
