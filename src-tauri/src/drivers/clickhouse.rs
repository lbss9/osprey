//! ClickHouse over its HTTP interface (port 8123 / 8443). Every statement is
//! one POST with `FORMAT JSONCompact`; the catalog comes from `system.*`.
//! ClickHouse has no transactions and only one statement per request, so
//! multi-statement text is split here and run in order.

use std::time::Instant;

use async_trait::async_trait;
use tokio::sync::Mutex;

use super::sql::Dialect;
use super::sqlite::split_statements;
use super::value::clickhouse_kind;
use crate::error::{AppError, AppResult};
use crate::models::*;

pub struct ClickhouseDriver {
    http: reqwest::Client,
    base: String,
    user: String,
    password: String,
    database: String,
    /// query_id of the statement in flight (for KILL QUERY)
    running: Mutex<Option<String>>,
}

fn s(v: &Option<String>) -> String {
    v.clone().unwrap_or_default()
}

impl ClickhouseDriver {
    pub async fn connect(cfg: &ConnectionConfig, password: Option<&str>, database: Option<&str>) -> AppResult<Self> {
        let tls = matches!(cfg.ssl_mode, SslMode::Require | SslMode::Verify);
        let scheme = if tls { "https" } else { "http" };
        let timeout = cfg.options.get("connectTimeout").and_then(|v| v.as_u64()).unwrap_or(15);
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(timeout))
            .danger_accept_invalid_certs(cfg.ssl_mode != SslMode::Verify)
            .build()
            .map_err(|e| AppError::Connect(e.to_string()))?;
        let d = ClickhouseDriver {
            http,
            base: format!("{scheme}://{}:{}/", cfg.host, cfg.port),
            user: if cfg.user.is_empty() { "default".into() } else { cfg.user.clone() },
            password: password.unwrap_or("").to_string(),
            database: database
                .map(str::to_string)
                .filter(|d| !d.is_empty())
                .unwrap_or_else(|| if cfg.database.is_empty() { "default".into() } else { cfg.database.clone() }),
            running: Mutex::new(None),
        };
        // fail early with a clear auth / connect error
        d.exec("SELECT 1", 1, None).await?;
        Ok(d)
    }

    /// One statement → one result set (or a command summary).
    async fn exec(&self, sql: &str, max_rows: usize, query_id: Option<&str>) -> AppResult<ResultSet> {
        let started = Instant::now();
        let mut params: Vec<(&str, String)> = vec![
            ("database", self.database.clone()),
            ("default_format", "JSONCompact".into()),
            ("output_format_json_quote_64bit_integers", "0".into()),
            ("max_result_rows", (max_rows + 1).to_string()),
            ("result_overflow_mode", "break".into()),
        ];
        if let Some(id) = query_id {
            params.push(("query_id", id.to_string()));
        }
        let resp = self
            .http
            .post(&self.base)
            .query(&params)
            .header("X-ClickHouse-User", &self.user)
            .header("X-ClickHouse-Key", &self.password)
            .body(sql.to_string())
            .send()
            .await
            .map_err(|e| if e.is_connect() || e.is_timeout() { AppError::Connect(e.to_string()) } else { AppError::Query(e.to_string()) })?;
        let status = resp.status();
        let summary = resp.headers().get("x-clickhouse-summary").and_then(|v| v.to_str().ok()).map(str::to_string);
        let body = resp.text().await.map_err(|e| AppError::Query(e.to_string()))?;
        if !status.is_success() {
            let msg = body.trim().to_string();
            let lower = msg.to_ascii_lowercase();
            return Err(if lower.contains("authentication failed") || lower.contains("code: 516") {
                AppError::Auth(msg)
            } else if lower.contains("query was cancelled") || lower.contains("code: 394") {
                AppError::Cancelled
            } else {
                AppError::Query(msg)
            });
        }
        let elapsed_ms = started.elapsed().as_millis() as u64;
        if body.trim().is_empty() {
            let written = summary
                .and_then(|j| serde_json::from_str::<serde_json::Value>(j.as_str()).ok())
                .and_then(|v| v.get("written_rows").and_then(|w| w.as_str().and_then(|x| x.parse::<u64>().ok())))
                .unwrap_or(0);
            return Ok(ResultSet::command(written, elapsed_ms, Some(sql.to_string())));
        }
        let doc: serde_json::Value = serde_json::from_str(&body).map_err(|e| AppError::Query(format!("unexpected reply: {e}")))?;
        let columns: Vec<ResultColumn> = doc["meta"]
            .as_array()
            .map(|m| {
                m.iter()
                    .map(|c| {
                        let data_type = c["type"].as_str().unwrap_or("String").to_string();
                        ResultColumn { name: c["name"].as_str().unwrap_or("").to_string(), kind: clickhouse_kind(&data_type), data_type }
                    })
                    .collect()
            })
            .unwrap_or_default();
        let mut rows: Vec<Vec<serde_json::Value>> = doc["data"]
            .as_array()
            .map(|d| {
                d.iter()
                    .map(|r| {
                        r.as_array()
                            .map(|cells| {
                                cells
                                    .iter()
                                    .map(|v| match v {
                                        serde_json::Value::Array(_) | serde_json::Value::Object(_) => serde_json::Value::String(v.to_string()),
                                        other => other.clone(),
                                    })
                                    .collect()
                            })
                            .unwrap_or_default()
                    })
                    .collect()
            })
            .unwrap_or_default();
        let truncated = rows.len() > max_rows;
        rows.truncate(max_rows);
        let count = rows.len();
        Ok(ResultSet { columns, rows, row_count: count, affected: None, truncated, elapsed_ms, statement: Some(sql.to_string()), streamed: false })
    }

    async fn rows_text(&self, sql: &str) -> AppResult<Vec<Vec<Option<String>>>> {
        let set = self.exec(sql, super::HARD_MAX_ROWS, None).await?;
        Ok(set
            .rows
            .into_iter()
            .map(|r| {
                r.into_iter()
                    .map(|v| match v {
                        serde_json::Value::Null => None,
                        serde_json::Value::String(t) => Some(t),
                        other => Some(other.to_string()),
                    })
                    .collect()
            })
            .collect())
    }
}

#[async_trait]
impl super::SqlDriver for ClickhouseDriver {
    fn kind(&self) -> DriverKind {
        DriverKind::Clickhouse
    }
    fn dialect(&self) -> Dialect {
        Dialect::Clickhouse
    }

    async fn server_info(&self) -> AppResult<ServerInfo> {
        let rows = self.rows_text("SELECT version(), currentDatabase(), currentUser()").await?;
        let r = rows.first().cloned().unwrap_or_default();
        Ok(ServerInfo {
            driver: DriverKind::Clickhouse,
            version: r.first().map(s).unwrap_or_default(),
            database: r.get(1).cloned().flatten(),
            user: r.get(2).cloned().flatten(),
            extra: serde_json::json!({}),
        })
    }

    async fn list_databases(&self, include_system: bool) -> AppResult<Vec<String>> {
        let filter = if include_system { "" } else { "WHERE name NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')" };
        let rows = self.rows_text(&format!("SELECT name FROM system.databases {filter} ORDER BY name")).await?;
        Ok(rows.into_iter().map(|r| s(&r[0])).collect())
    }

    /// ClickHouse databases play the schema role (like MySQL).
    async fn list_schemas(&self, include_system: bool) -> AppResult<Vec<String>> {
        let mut all = self.list_databases(include_system).await?;
        // current database first so the tree opens on it
        if let Some(i) = all.iter().position(|d| *d == self.database) {
            let cur = all.remove(i);
            all.insert(0, cur);
        }
        Ok(all)
    }

    async fn list_tables(&self, schema: &str) -> AppResult<Vec<TableInfo>> {
        let d = Dialect::Clickhouse;
        let rows = self
            .rows_text(&format!(
                "SELECT name, engine, total_rows, comment FROM system.tables WHERE database = {} ORDER BY name",
                d.quote_literal(schema)
            ))
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let engine = s(&r[1]);
                TableInfo {
                    schema: schema.to_string(),
                    name: s(&r[0]),
                    kind: if engine.contains("View") { "view" } else { "table" }.to_string(),
                    row_estimate: r[2].as_deref().and_then(|v| v.parse::<i64>().ok()),
                    comment: r[3].clone().filter(|c| !c.is_empty()),
                }
            })
            .collect())
    }

    async fn columns(&self, schema: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
        let d = Dialect::Clickhouse;
        let rows = self
            .rows_text(&format!(
                "SELECT name, type, default_expression, is_in_primary_key, comment, position
                 FROM system.columns WHERE database = {} AND table = {} ORDER BY position",
                d.quote_literal(schema),
                d.quote_literal(table)
            ))
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let ty = s(&r[1]);
                ColumnInfo {
                    name: s(&r[0]),
                    nullable: ty.starts_with("Nullable("),
                    default: r[2].clone().filter(|v| !v.is_empty()),
                    primary_key: s(&r[3]) == "1",
                    comment: r[4].clone().filter(|c| !c.is_empty()),
                    position: s(&r[5]).parse().unwrap_or(0),
                    auto_increment: false,
                    data_type: ty,
                }
            })
            .collect())
    }

    async fn schema_columns(&self, schema: &str) -> AppResult<Vec<TableColumns>> {
        let d = Dialect::Clickhouse;
        let rows = self
            .rows_text(&format!(
                "SELECT table, name, type, default_expression, is_in_primary_key, comment, position
                 FROM system.columns WHERE database = {} ORDER BY table, position",
                d.quote_literal(schema)
            ))
            .await?;
        let mut out: Vec<TableColumns> = Vec::new();
        for r in rows {
            let table = s(&r[0]);
            let ty = s(&r[2]);
            let col = ColumnInfo {
                name: s(&r[1]),
                nullable: ty.starts_with("Nullable("),
                default: r[3].clone().filter(|v| !v.is_empty()),
                primary_key: s(&r[4]) == "1",
                comment: r[5].clone().filter(|c| !c.is_empty()),
                position: s(&r[6]).parse().unwrap_or(0),
                auto_increment: false,
                data_type: ty,
            };
            match out.last_mut() {
                Some(t) if t.table == table => t.columns.push(col),
                _ => out.push(TableColumns { table, columns: vec![col] }),
            }
        }
        Ok(out)
    }

    async fn structure(&self, schema: &str, table: &str) -> AppResult<TableStructure> {
        let d = Dialect::Clickhouse;
        let columns = self.columns(schema, table).await?;
        let mut indexes = Vec::new();
        let pk = self
            .rows_text(&format!(
                "SELECT primary_key, sorting_key FROM system.tables WHERE database = {} AND name = {}",
                d.quote_literal(schema),
                d.quote_literal(table)
            ))
            .await?;
        if let Some(r) = pk.first() {
            let key = s(&r[0]);
            if !key.is_empty() {
                indexes.push(IndexInfo {
                    name: "PRIMARY KEY".into(),
                    columns: key.split(',').map(|c| c.trim().to_string()).collect(),
                    unique: false,
                    primary: true,
                    definition: Some(format!("ORDER BY ({})", s(&r[1]))),
                });
            }
        }
        let skipping = self
            .rows_text(&format!(
                "SELECT name, expr, type, granularity FROM system.data_skipping_indices WHERE database = {} AND table = {}",
                d.quote_literal(schema),
                d.quote_literal(table)
            ))
            .await
            .unwrap_or_default();
        for r in skipping {
            indexes.push(IndexInfo {
                name: s(&r[0]),
                columns: s(&r[1]).split(',').map(|c| c.trim().to_string()).collect(),
                unique: false,
                primary: false,
                definition: Some(format!("TYPE {} GRANULARITY {}", s(&r[2]), s(&r[3]))),
            });
        }
        let ddl = self
            .rows_text(&format!("SHOW CREATE TABLE {}", d.qualified(schema, table)))
            .await
            .ok()
            .and_then(|r| r.into_iter().next())
            .and_then(|r| r.into_iter().next().flatten());
        Ok(TableStructure { columns, indexes, foreign_keys: vec![], ddl })
    }

    async fn query_with(&self, sql: &str, max_rows: usize, sink: Option<RowSink>) -> AppResult<Vec<ResultSet>> {
        let mut out = sink.map(StreamOut::new);
        let mut sets = Vec::new();
        for st in split_statements(sql) {
            let id = uuid::Uuid::new_v4().to_string();
            *self.running.lock().await = Some(id.clone());
            let res = self.exec(&st, max_rows, Some(&id)).await;
            *self.running.lock().await = None;
            let mut set = res?;
            if let Some(o) = out.as_mut() {
                if !set.columns.is_empty() {
                    let mut rows = std::mem::take(&mut set.rows);
                    o.emit(&set.columns, &mut rows, true);
                    set.streamed = true;
                }
                o.next_set();
            }
            sets.push(set);
        }
        if sets.is_empty() {
            sets.push(ResultSet::command(0, 0, None));
        }
        Ok(sets)
    }

    /// No transactions in ClickHouse: statements run one by one and stop at
    /// the first error (earlier ones stay applied).
    async fn execute_transaction(&self, statements: &[String]) -> AppResult<u64> {
        let mut affected = 0u64;
        for st in statements {
            let set = self.exec(st, 1, None).await?;
            affected += set.affected.unwrap_or(0);
        }
        Ok(affected)
    }

    async fn cancel(&self) -> AppResult<()> {
        let id = self.running.lock().await.clone();
        if let Some(id) = id {
            self.exec(&format!("KILL QUERY WHERE query_id = {} SYNC", Dialect::Clickhouse.quote_literal(&id)), 10, None).await?;
        }
        Ok(())
    }

    async fn close(&self) {}
}
