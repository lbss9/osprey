//! PostgreSQL over `tokio-postgres`.
//!
//! User SQL runs through the *simple* protocol: it accepts several
//! statements in one string and returns every value as text, which is
//! exactly what a grid wants (no per-type decoding, no surprises with
//! custom types). Column types come from a best-effort `prepare` of the same
//! text — it fails for multi-statement input, in which case the grid falls
//! back to plain strings. Catalog queries use the extended protocol with
//! known types.

use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use futures_util::{pin_mut, StreamExt};
use tokio_postgres::{config::SslMode as PgSslMode, Client, Config, NoTls, SimpleQueryMessage};

use super::sql::Dialect;
use super::value::{pg_kind, pg_text_to_json};
use super::SqlDriver;
use crate::error::{AppError, AppResult};
use crate::models::*;

pub struct PgDriver {
    client: Client,
    tls: Option<Arc<rustls::ClientConfig>>,
    database: String,
    user: String,
    task: tokio::task::JoinHandle<()>,
}

impl PgDriver {
    pub async fn connect(
        cfg: &ConnectionConfig,
        password: Option<&str>,
        database: Option<&str>,
    ) -> AppResult<Self> {
        let db = database
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                if cfg.database.is_empty() {
                    cfg.user.clone()
                } else {
                    cfg.database.clone()
                }
            });
        let timeout = cfg.options.get("connectTimeout").and_then(|v| v.as_u64()).filter(|s| *s > 0).unwrap_or(15);
        let app_name = cfg
            .options
            .get("applicationName")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .unwrap_or("Osprey")
            .to_string();
        let mut c = Config::new();
        c.host(&cfg.host)
            .port(cfg.port)
            .user(&cfg.user)
            .dbname(&db)
            .application_name(&app_name)
            .connect_timeout(std::time::Duration::from_secs(timeout));
        if let Some(p) = password {
            if !p.is_empty() {
                c.password(p);
            }
        }
        let (client, tls, task) = match cfg.ssl_mode {
            SslMode::Disable => {
                c.ssl_mode(PgSslMode::Disable);
                let (client, conn) = c.connect(NoTls).await?;
                let task = tokio::spawn(async move {
                    if let Err(e) = conn.await {
                        log::warn!("postgres connection ended: {e}");
                    }
                });
                (client, None, task)
            }
            mode => {
                c.ssl_mode(match mode {
                    SslMode::Prefer => PgSslMode::Prefer,
                    _ => PgSslMode::Require,
                });
                let tls_cfg = Arc::new(super::tls_config(mode == SslMode::Verify)?);
                let connector = tokio_postgres_rustls::MakeRustlsConnect::new((*tls_cfg).clone());
                let (client, conn) = c.connect(connector).await?;
                let task = tokio::spawn(async move {
                    if let Err(e) = conn.await {
                        log::warn!("postgres connection ended: {e}");
                    }
                });
                (client, Some(tls_cfg), task)
            }
        };
        if cfg.read_only {
            // enforced by the server, not only by the UI
            client.simple_query("SET default_transaction_read_only = on").await?;
        }
        Ok(PgDriver {
            client,
            tls,
            database: db,
            user: cfg.user.clone(),
            task,
        })
    }

    /// Run one statement through the extended protocol and read every
    /// column as an owned string (all catalog queries cast to text).
    async fn rows_text(&self, sql: &str, params: &[&(dyn tokio_postgres::types::ToSql + Sync)]) -> AppResult<Vec<Vec<Option<String>>>> {
        let rows = self.client.query(sql, params).await?;
        Ok(rows
            .iter()
            .map(|r| (0..r.len()).map(|i| r.get::<_, Option<String>>(i)).collect())
            .collect())
    }
}

fn s(v: &Option<String>) -> String {
    v.clone().unwrap_or_default()
}

#[async_trait]
impl SqlDriver for PgDriver {
    fn kind(&self) -> DriverKind {
        DriverKind::Postgres
    }

    fn dialect(&self) -> Dialect {
        Dialect::Postgres
    }

    async fn server_info(&self) -> AppResult<ServerInfo> {
        let rows = self
            .rows_text(
                "SELECT version()::text, current_database()::text, current_user::text, inet_server_port()::text",
                &[],
            )
            .await?;
        let r = rows.first().cloned().unwrap_or_default();
        let version_full = r.first().map(s).unwrap_or_default();
        let version = version_full
            .split_whitespace()
            .nth(1)
            .map(|v| v.to_string())
            .unwrap_or(version_full.clone());
        Ok(ServerInfo {
            driver: DriverKind::Postgres,
            version,
            database: r.get(1).map(s),
            user: r.get(2).map(s),
            extra: serde_json::json!({ "versionFull": version_full, "port": r.get(3).map(s) }),
        })
    }

    async fn list_databases(&self, include_system: bool) -> AppResult<Vec<String>> {
        let sql = if include_system {
            "SELECT datname::text FROM pg_database ORDER BY datistemplate, datname"
        } else {
            "SELECT datname::text FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname"
        };
        let rows = self.rows_text(sql, &[]).await?;
        Ok(rows.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect())
    }

    async fn list_schemas(&self, include_system: bool) -> AppResult<Vec<String>> {
        let sql = if include_system {
            "SELECT nspname::text FROM pg_namespace
             WHERE nspname NOT LIKE 'pg_temp%' AND nspname NOT LIKE 'pg_toast_temp%'
             ORDER BY (nspname <> 'public'), (nspname IN ('pg_catalog', 'information_schema', 'pg_toast')), nspname"
        } else {
            "SELECT nspname::text FROM pg_namespace
             WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
               AND nspname NOT LIKE 'pg_temp%' AND nspname NOT LIKE 'pg_toast_temp%'
             ORDER BY (nspname <> 'public'), nspname"
        };
        let rows = self.rows_text(sql, &[]).await?;
        Ok(rows.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect())
    }

    async fn list_tables(&self, schema: &str) -> AppResult<Vec<TableInfo>> {
        let rows = self
            .rows_text(
                "SELECT c.relname::text, c.relkind::text, c.reltuples::bigint::text,
                        obj_description(c.oid, 'pg_class')::text
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = $1 AND c.relkind IN ('r', 'v', 'm', 'f', 'p')
                 ORDER BY c.relname",
                &[&schema],
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| TableInfo {
                schema: schema.to_string(),
                name: s(&r[0]),
                kind: match s(&r[1]).as_str() {
                    "v" => "view",
                    "m" => "materialized",
                    "f" => "foreign",
                    "p" => "partitioned",
                    _ => "table",
                }
                .to_string(),
                row_estimate: r[2].as_deref().and_then(|v| v.parse::<i64>().ok()).filter(|v| *v >= 0),
                comment: r[3].clone(),
            })
            .collect())
    }

    async fn columns(&self, schema: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
        let rows = self
            .rows_text(
                "SELECT a.attname::text,
                        format_type(a.atttypid, a.atttypmod)::text,
                        (NOT a.attnotnull)::text,
                        pg_get_expr(d.adbin, d.adrelid)::text,
                        a.attnum::text,
                        EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))::text,
                        ((a.attidentity <> '') OR COALESCE(pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%', false))::text,
                        col_description(a.attrelid, a.attnum)::text
                 FROM pg_attribute a
                 JOIN pg_class c ON c.oid = a.attrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                 WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
                 ORDER BY a.attnum",
                &[&schema, &table],
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| ColumnInfo {
                name: s(&r[0]),
                data_type: s(&r[1]),
                nullable: s(&r[2]) == "true",
                default: r[3].clone(),
                position: s(&r[4]).parse().unwrap_or(0),
                primary_key: s(&r[5]) == "true",
                auto_increment: s(&r[6]) == "true",
                comment: r[7].clone(),
            })
            .collect())
    }

    async fn structure(&self, schema: &str, table: &str) -> AppResult<TableStructure> {
        let columns = self.columns(schema, table).await?;
        let idx = self
            .rows_text(
                "SELECT i.relname::text, ix.indisunique::text, ix.indisprimary::text,
                        pg_get_indexdef(ix.indexrelid)::text,
                        (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                           FROM unnest(ix.indkey) WITH ORDINALITY k(attnum, ord)
                           JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum)::text
                 FROM pg_index ix
                 JOIN pg_class c ON c.oid = ix.indrelid
                 JOIN pg_class i ON i.oid = ix.indexrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = $1 AND c.relname = $2
                 ORDER BY ix.indisprimary DESC, i.relname",
                &[&schema, &table],
            )
            .await?;
        let indexes = idx
            .into_iter()
            .map(|r| IndexInfo {
                name: s(&r[0]),
                unique: s(&r[1]) == "true",
                primary: s(&r[2]) == "true",
                definition: r[3].clone(),
                columns: s(&r[4]).split(',').filter(|c| !c.is_empty()).map(String::from).collect(),
            })
            .collect();
        let fks = self
            .rows_text(
                "SELECT con.conname::text,
                        (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum)::text,
                        rn.nspname::text, rc.relname::text,
                        (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                           JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum)::text,
                        con.confupdtype::text, con.confdeltype::text
                 FROM pg_constraint con
                 JOIN pg_class c ON c.oid = con.conrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 JOIN pg_class rc ON rc.oid = con.confrelid
                 JOIN pg_namespace rn ON rn.oid = rc.relnamespace
                 WHERE con.contype = 'f' AND n.nspname = $1 AND c.relname = $2
                 ORDER BY con.conname",
                &[&schema, &table],
            )
            .await?;
        let action = |c: &str| match c {
            "a" => "NO ACTION",
            "r" => "RESTRICT",
            "c" => "CASCADE",
            "n" => "SET NULL",
            "d" => "SET DEFAULT",
            _ => "",
        };
        let foreign_keys = fks
            .into_iter()
            .map(|r| ForeignKeyInfo {
                name: s(&r[0]),
                columns: s(&r[1]).split(',').filter(|c| !c.is_empty()).map(String::from).collect(),
                ref_schema: s(&r[2]),
                ref_table: s(&r[3]),
                ref_columns: s(&r[4]).split(',').filter(|c| !c.is_empty()).map(String::from).collect(),
                on_update: Some(action(&s(&r[5])).to_string()),
                on_delete: Some(action(&s(&r[6])).to_string()),
            })
            .collect();
        Ok(TableStructure {
            columns,
            indexes,
            foreign_keys,
            ddl: None,
        })
    }

    async fn query(&self, sql: &str, max_rows: usize) -> AppResult<Vec<ResultSet>> {
        // best-effort column types (fails for multi-statement text, params, etc.)
        let types: Option<Vec<String>> = match self.client.prepare(sql).await {
            Ok(st) => Some(st.columns().iter().map(|c| c.type_().name().to_string()).collect()),
            Err(_) => None,
        };

        let started = Instant::now();
        let stream = self.client.simple_query_raw(sql).await?;
        pin_mut!(stream);

        let mut sets: Vec<ResultSet> = Vec::new();
        let mut columns: Vec<ResultColumn> = Vec::new();
        let mut kinds: Vec<ColumnKind> = Vec::new();
        let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
        let mut truncated = false;
        let mut have_desc = false;
        let mut set_started = Instant::now();

        while let Some(msg) = stream.next().await {
            match msg? {
                SimpleQueryMessage::RowDescription(cols) => {
                    have_desc = true;
                    set_started = Instant::now();
                    let typed = types.as_ref().filter(|t| t.len() == cols.len());
                    columns = cols
                        .iter()
                        .enumerate()
                        .map(|(i, c)| {
                            let data_type = typed.map(|t| t[i].clone()).unwrap_or_else(|| "text".into());
                            let kind = if typed.is_some() { pg_kind(&data_type) } else { ColumnKind::Other };
                            ResultColumn { name: c.name().to_string(), data_type, kind }
                        })
                        .collect();
                    kinds = columns.iter().map(|c| c.kind).collect();
                    rows = Vec::new();
                    truncated = false;
                }
                SimpleQueryMessage::Row(r) => {
                    if rows.len() >= max_rows {
                        truncated = true;
                        continue;
                    }
                    let row = (0..r.len())
                        .map(|i| pg_text_to_json(r.get(i), kinds.get(i).copied().unwrap_or(ColumnKind::Other)))
                        .collect();
                    rows.push(row);
                }
                SimpleQueryMessage::CommandComplete(n) => {
                    let elapsed = if have_desc { set_started.elapsed() } else { started.elapsed() };
                    if have_desc {
                        let count = rows.len();
                        sets.push(ResultSet {
                            columns: std::mem::take(&mut columns),
                            rows: std::mem::take(&mut rows),
                            row_count: count,
                            affected: None,
                            truncated,
                            elapsed_ms: elapsed.as_millis() as u64,
                            statement: None,
                        });
                    } else {
                        sets.push(ResultSet::command(n, elapsed.as_millis() as u64, None));
                    }
                    have_desc = false;
                    kinds.clear();
                }
                _ => {}
            }
        }
        if sets.is_empty() {
            sets.push(ResultSet::command(0, started.elapsed().as_millis() as u64, None));
        }
        Ok(sets)
    }

    async fn execute_transaction(&self, statements: &[String]) -> AppResult<u64> {
        self.client.simple_query("BEGIN").await?;
        let mut affected = 0u64;
        for st in statements {
            match self.client.simple_query(st).await {
                Ok(msgs) => {
                    for m in msgs {
                        if let SimpleQueryMessage::CommandComplete(n) = m {
                            affected += n;
                        }
                    }
                }
                Err(e) => {
                    let _ = self.client.simple_query("ROLLBACK").await;
                    return Err(e.into());
                }
            }
        }
        self.client.simple_query("COMMIT").await?;
        Ok(affected)
    }

    async fn cancel(&self) -> AppResult<()> {
        let token = self.client.cancel_token();
        match &self.tls {
            Some(cfg) => {
                let connector = tokio_postgres_rustls::MakeRustlsConnect::new((**cfg).clone());
                token.cancel_query(connector).await?;
            }
            None => token.cancel_query(NoTls).await?,
        }
        Ok(())
    }

    async fn close(&self) {
        self.task.abort();
    }
}

impl Drop for PgDriver {
    fn drop(&mut self) {
        self.task.abort();
        let _ = (&self.database, &self.user);
    }
}

#[allow(dead_code)]
fn _unused(e: AppError) -> AppError {
    e
}
