//! MySQL / MariaDB over `mysql_async`. A small pool so the table view and the
//! query tab can run at the same time; text protocol for user SQL so every
//! value arrives as text/ints without per-type decoding.

use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use mysql_async::consts::ColumnFlags;
use mysql_async::prelude::*;
use mysql_async::{Opts, OptsBuilder, Pool, PoolConstraints, PoolOpts, SslOpts};
use tokio::sync::Mutex;

use super::sql::Dialect;
use super::value::{mysql_kind, mysql_kind_from_name, mysql_type_name, mysql_value_to_json};
use super::SqlDriver;
use crate::error::{AppError, AppResult};
use crate::models::*;

pub struct MysqlDriver {
    pool: Pool,
    database: String,
    /// connection id of the statement currently running in `query`, for KILL QUERY
    running: Arc<Mutex<Option<u32>>>,
}

impl MysqlDriver {
    pub async fn connect(
        cfg: &ConnectionConfig,
        password: Option<&str>,
        database: Option<&str>,
    ) -> AppResult<Self> {
        let db = database
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| cfg.database.clone());
        let mut b = OptsBuilder::default()
            .ip_or_hostname(cfg.host.clone())
            .tcp_port(cfg.port)
            .user(Some(cfg.user.clone()))
            .pass(password.filter(|p| !p.is_empty()).map(|p| p.to_string()))
            .prefer_socket(false)
            .pool_opts(PoolOpts::default().with_constraints(PoolConstraints::new(0, 4).unwrap()))
            .stmt_cache_size(0);
        if !db.is_empty() {
            b = b.db_name(Some(db.clone()));
        }
        match cfg.ssl_mode {
            SslMode::Disable => {}
            SslMode::Verify => {
                b = b.ssl_opts(Some(SslOpts::default()));
            }
            _ => {
                b = b.ssl_opts(Some(
                    SslOpts::default()
                        .with_danger_accept_invalid_certs(true)
                        .with_danger_skip_domain_validation(true),
                ));
            }
        }
        if cfg.read_only {
            // every pooled connection starts read-only, enforced by the server
            b = b.setup(vec!["SET SESSION transaction_read_only = 1".to_string()]);
        }
        let timeout = cfg.options.get("connectTimeout").and_then(|v| v.as_u64()).filter(|s| *s > 0).unwrap_or(15);
        let opts: Opts = b.into();
        let pool = Pool::new(opts);
        // fail fast: the pool is lazy, so open one connection now
        let mut conn = tokio::time::timeout(std::time::Duration::from_secs(timeout), pool.get_conn())
            .await
            .map_err(|_| AppError::Connect("timeout".into()))?
            .map_err(|e| {
                let err: AppError = e.into();
                match err {
                    AppError::Query(m) => AppError::Connect(m),
                    other => other,
                }
            })?;
        conn.ping().await?;
        drop(conn);
        Ok(MysqlDriver {
            pool,
            database: db,
            running: Arc::new(Mutex::new(None)),
        })
    }

    async fn text_rows(&self, sql: &str) -> AppResult<Vec<Vec<Option<String>>>> {
        let mut conn = self.pool.get_conn().await?;
        let mut result = conn.query_iter(sql).await?;
        let mut out = Vec::new();
        while let Some(row) = result.next().await? {
            let vals = row.unwrap();
            out.push(
                vals.into_iter()
                    .map(|v| match v {
                        mysql_async::Value::NULL => None,
                        mysql_async::Value::Bytes(b) => Some(String::from_utf8_lossy(&b).into_owned()),
                        other => Some(match mysql_value_to_json(other, ColumnKind::Other, false) {
                            serde_json::Value::String(s) => s,
                            v => v.to_string(),
                        }),
                    })
                    .collect(),
            );
        }
        result.drop_result().await?;
        Ok(out)
    }
}

fn s(v: &Option<String>) -> String {
    v.clone().unwrap_or_default()
}

const SYSTEM_DBS: [&str; 4] = ["information_schema", "performance_schema", "mysql", "sys"];

#[async_trait]
impl SqlDriver for MysqlDriver {
    fn kind(&self) -> DriverKind {
        DriverKind::Mysql
    }

    fn dialect(&self) -> Dialect {
        Dialect::Mysql
    }

    async fn server_info(&self) -> AppResult<ServerInfo> {
        let rows = self
            .text_rows("SELECT VERSION(), DATABASE(), CURRENT_USER(), @@port")
            .await?;
        let r = rows.first().cloned().unwrap_or_default();
        Ok(ServerInfo {
            driver: DriverKind::Mysql,
            version: r.first().map(s).unwrap_or_default(),
            database: r.get(1).cloned().flatten(),
            user: r.get(2).cloned().flatten(),
            extra: serde_json::json!({ "port": r.get(3).cloned().flatten() }),
        })
    }

    async fn list_databases(&self, include_system: bool) -> AppResult<Vec<String>> {
        let rows = self.text_rows("SHOW DATABASES").await?;
        let mut dbs: Vec<String> = rows
            .into_iter()
            .filter_map(|r| r.into_iter().next().flatten())
            .filter(|d| include_system || !SYSTEM_DBS.contains(&d.as_str()))
            .collect();
        // user databases first, system ones at the end
        dbs.sort_by_key(|d| (SYSTEM_DBS.contains(&d.as_str()), d.to_lowercase()));
        Ok(dbs)
    }

    async fn list_schemas(&self, include_system: bool) -> AppResult<Vec<String>> {
        // in MySQL a schema is a database; show the current one first
        let mut all = self.list_databases(include_system).await?;
        if !self.database.is_empty() {
            all.retain(|d| d != &self.database);
            all.insert(0, self.database.clone());
        }
        Ok(all)
    }

    async fn list_tables(&self, schema: &str) -> AppResult<Vec<TableInfo>> {
        let d = Dialect::Mysql;
        let rows = self
            .text_rows(&format!(
                "SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, TABLE_COMMENT FROM information_schema.TABLES
                 WHERE TABLE_SCHEMA = {} ORDER BY TABLE_NAME",
                d.quote_literal(schema)
            ))
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| TableInfo {
                schema: schema.to_string(),
                name: s(&r[0]),
                kind: if s(&r[1]).contains("VIEW") { "view" } else { "table" }.to_string(),
                row_estimate: r[2].as_deref().and_then(|v| v.parse().ok()),
                comment: r[3].clone().filter(|c| !c.is_empty()),
            })
            .collect())
    }

    async fn columns(&self, schema: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
        let d = Dialect::Mysql;
        let rows = self
            .text_rows(&format!(
                "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, ORDINAL_POSITION
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} ORDER BY ORDINAL_POSITION",
                d.quote_literal(schema),
                d.quote_literal(table)
            ))
            .await?;
        // MariaDB stores JSON as LONGTEXT plus a `json_valid(col)` check; surface it as json.
        let json_cols: Vec<String> = self
            .text_rows(&format!(
                "SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS
                 WHERE CONSTRAINT_SCHEMA = {} AND TABLE_NAME = {} AND CHECK_CLAUSE LIKE 'json_valid(%'",
                d.quote_literal(schema),
                d.quote_literal(table)
            ))
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|r| {
                let c = s(&r[0]);
                let inner = c.strip_prefix("json_valid(")?.trim_end_matches(')');
                Some(inner.trim_matches('`').to_string())
            })
            .collect();
        Ok(rows
            .into_iter()
            .map(|r| ColumnInfo {
                name: s(&r[0]),
                data_type: if json_cols.contains(&s(&r[0])) { "json".into() } else { s(&r[1]) },
                nullable: s(&r[2]).eq_ignore_ascii_case("YES"),
                primary_key: s(&r[3]) == "PRI",
                default: r[4].clone(),
                auto_increment: s(&r[5]).to_ascii_lowercase().contains("auto_increment"),
                comment: r[6].clone().filter(|c| !c.is_empty()),
                position: s(&r[7]).parse().unwrap_or(0),
            })
            .collect())
    }

    async fn schema_columns(&self, schema: &str) -> AppResult<Vec<TableColumns>> {
        let d = Dialect::Mysql;
        let rows = self
            .text_rows(&format!(
                "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, ORDINAL_POSITION
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = {} ORDER BY TABLE_NAME, ORDINAL_POSITION",
                d.quote_literal(schema)
            ))
            .await?;
        let mut out: Vec<TableColumns> = Vec::new();
        for r in rows {
            let table = s(&r[0]);
            let col = ColumnInfo {
                name: s(&r[1]),
                data_type: s(&r[2]),
                nullable: s(&r[3]).eq_ignore_ascii_case("YES"),
                primary_key: s(&r[4]) == "PRI",
                default: r[5].clone(),
                auto_increment: s(&r[6]).to_ascii_lowercase().contains("auto_increment"),
                comment: r[7].clone().filter(|c| !c.is_empty()),
                position: s(&r[8]).parse().unwrap_or(0),
            };
            match out.last_mut() {
                Some(t) if t.table == table => t.columns.push(col),
                _ => out.push(TableColumns { table, columns: vec![col] }),
            }
        }
        Ok(out)
    }

    async fn structure(&self, schema: &str, table: &str) -> AppResult<TableStructure> {
        let d = Dialect::Mysql;
        let columns = self.columns(schema, table).await?;
        let idx_rows = self
            .text_rows(&format!(
                "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX, INDEX_TYPE FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} ORDER BY INDEX_NAME, SEQ_IN_INDEX",
                d.quote_literal(schema),
                d.quote_literal(table)
            ))
            .await?;
        let mut indexes: Vec<IndexInfo> = Vec::new();
        for r in idx_rows {
            let name = s(&r[0]);
            if let Some(ix) = indexes.iter_mut().find(|i| i.name == name) {
                ix.columns.push(s(&r[2]));
            } else {
                indexes.push(IndexInfo {
                    primary: name == "PRIMARY",
                    unique: s(&r[1]) == "0",
                    columns: vec![s(&r[2])],
                    definition: r[4].clone(),
                    name,
                });
            }
        }
        let fk_rows = self
            .text_rows(&format!(
                "SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME,
                        k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE
                 FROM information_schema.KEY_COLUMN_USAGE k
                 JOIN information_schema.REFERENTIAL_CONSTRAINTS r
                   ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
                 WHERE k.TABLE_SCHEMA = {} AND k.TABLE_NAME = {} AND k.REFERENCED_TABLE_NAME IS NOT NULL
                 ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION",
                d.quote_literal(schema),
                d.quote_literal(table)
            ))
            .await?;
        let mut foreign_keys: Vec<ForeignKeyInfo> = Vec::new();
        for r in fk_rows {
            let name = s(&r[0]);
            if let Some(fk) = foreign_keys.iter_mut().find(|f| f.name == name) {
                fk.columns.push(s(&r[1]));
                fk.ref_columns.push(s(&r[4]));
            } else {
                foreign_keys.push(ForeignKeyInfo {
                    name,
                    columns: vec![s(&r[1])],
                    ref_schema: s(&r[2]),
                    ref_table: s(&r[3]),
                    ref_columns: vec![s(&r[4])],
                    on_update: r[5].clone(),
                    on_delete: r[6].clone(),
                });
            }
        }
        let ddl = self
            .text_rows(&format!("SHOW CREATE TABLE {}", d.qualified(schema, table)))
            .await
            .ok()
            .and_then(|rows| rows.into_iter().next())
            .and_then(|r| r.into_iter().nth(1).flatten());
        Ok(TableStructure {
            columns,
            indexes,
            foreign_keys,
            ddl,
        })
    }

    async fn query_with(&self, sql: &str, max_rows: usize, sink: Option<RowSink>) -> AppResult<Vec<ResultSet>> {
        let mut out = sink.map(StreamOut::new);
        let mut conn = self.pool.get_conn().await?;
        *self.running.lock().await = Some(conn.id());
        let started = Instant::now();
        let outcome: AppResult<Vec<ResultSet>> = async {
            let mut result = conn.query_iter(sql).await?;
            let mut sets = Vec::new();
            loop {
                let set_started = Instant::now();
                let cols = result.columns();
                let mut columns: Vec<ResultColumn> = Vec::new();
                let mut kinds: Vec<(ColumnKind, bool)> = Vec::new();
                if let Some(cols) = &cols {
                    for c in cols.iter() {
                        let binary = c.flags().contains(ColumnFlags::BINARY_FLAG)
                            && c.character_set() == 63;
                        let kind = mysql_kind(c.column_type(), binary, c.column_length());
                        let is_date_only = matches!(
                            c.column_type(),
                            mysql_async::consts::ColumnType::MYSQL_TYPE_DATE
                                | mysql_async::consts::ColumnType::MYSQL_TYPE_NEWDATE
                        );
                        columns.push(ResultColumn {
                            name: c.name_str().into_owned(),
                            data_type: mysql_type_name(c.column_type(), binary).to_string(),
                            kind,
                        });
                        kinds.push((kind, is_date_only));
                    }
                }
                let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
                let mut truncated = false;
                let mut total = 0usize;
                while let Some(row) = result.next().await? {
                    if total >= max_rows {
                        truncated = true;
                        continue;
                    }
                    let vals = row.unwrap();
                    rows.push(
                        vals.into_iter()
                            .enumerate()
                            .map(|(i, v)| {
                                let (k, d) = kinds.get(i).copied().unwrap_or((ColumnKind::Other, false));
                                mysql_value_to_json(v, k, d)
                            })
                            .collect(),
                    );
                    total += 1;
                    if let Some(o) = out.as_mut() {
                        if !columns.is_empty() {
                            o.emit(&columns, &mut rows, false);
                        }
                    }
                }
                let elapsed = set_started.elapsed().as_millis() as u64;
                if columns.is_empty() {
                    if let Some(o) = out.as_mut() {
                        o.next_set();
                    }
                    sets.push(ResultSet::command(result.affected_rows(), elapsed, None));
                } else {
                    if let Some(o) = out.as_mut() {
                        o.emit(&columns, &mut rows, true);
                        o.next_set();
                    }
                    sets.push(ResultSet {
                        columns,
                        rows,
                        row_count: total,
                        affected: None,
                        truncated,
                        elapsed_ms: elapsed,
                        statement: None,
                        streamed: out.is_some(),
                    });
                }
                if result.is_empty() {
                    break;
                }
            }
            Ok(sets)
        }
        .await;
        *self.running.lock().await = None;
        let mut sets = outcome?;
        if sets.is_empty() {
            sets.push(ResultSet::command(0, started.elapsed().as_millis() as u64, None));
        }
        Ok(sets)
    }

    async fn execute_transaction(&self, statements: &[String]) -> AppResult<u64> {
        let mut conn = self.pool.get_conn().await?;
        let mut tx = conn.start_transaction(mysql_async::TxOpts::default()).await?;
        let mut affected = 0u64;
        for st in statements {
            match tx.query_iter(st.as_str()).await {
                Ok(r) => {
                    affected += r.affected_rows();
                    r.drop_result().await?;
                }
                Err(e) => {
                    let _ = tx.rollback().await;
                    return Err(e.into());
                }
            }
        }
        tx.commit().await?;
        Ok(affected)
    }

    async fn cancel(&self) -> AppResult<()> {
        let id = *self.running.lock().await;
        if let Some(id) = id {
            let mut conn = self.pool.get_conn().await?;
            conn.query_drop(format!("KILL QUERY {id}")).await?;
        }
        Ok(())
    }

    async fn close(&self) {
        let _ = self.pool.clone().disconnect().await;
    }
}

#[allow(dead_code)]
fn _kind_from_name(t: &str) -> ColumnKind {
    mysql_kind_from_name(t)
}
