//! SQLite files over `rusqlite`. The connection is synchronous, so every
//! call runs on the blocking pool behind a mutex; `interrupt` implements
//! cancel. Values map straight from SQLite's five storage classes.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use async_trait::async_trait;
use rusqlite::{types::ValueRef, Connection, InterruptHandle};

use super::sql::Dialect;
use super::value::sqlite_kind;
use super::SqlDriver;
use crate::error::{AppError, AppResult};
use crate::models::*;

pub struct SqliteDriver {
    conn: Arc<Mutex<Connection>>,
    interrupt: InterruptHandle,
    path: String,
}

impl SqliteDriver {
    pub async fn connect(cfg: &ConnectionConfig) -> AppResult<Self> {
        let path = if cfg.database.trim().is_empty() { cfg.host.clone() } else { cfg.database.clone() };
        if path.trim().is_empty() {
            return Err(AppError::Connect("no database file".into()));
        }
        if path != ":memory:" && !Path::new(&path).exists() && !cfg.options.get("create").and_then(|v| v.as_bool()).unwrap_or(false) {
            return Err(AppError::Connect(format!("file not found: {path}")));
        }
        let read_only = cfg.read_only;
        let p = path.clone();
        let conn = tokio::task::spawn_blocking(move || -> AppResult<Connection> {
            let flags = if read_only {
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
            } else {
                rusqlite::OpenFlags::default()
            };
            let c = Connection::open_with_flags(&p, flags).map_err(|e| AppError::Connect(e.to_string()))?;
            c.busy_timeout(std::time::Duration::from_secs(5)).ok();
            c.pragma_update(None, "foreign_keys", "ON").ok();
            Ok(c)
        })
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
        let interrupt = conn.get_interrupt_handle();
        Ok(SqliteDriver { conn: Arc::new(Mutex::new(conn)), interrupt, path })
    }

    async fn with_conn<T: Send + 'static>(&self, f: impl FnOnce(&Connection) -> AppResult<T> + Send + 'static) -> AppResult<T> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let guard = conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
            f(&guard)
        })
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
        .map_err(|e| match e {
            // rusqlite errors arrive as the store's `Storage` variant; here they are query errors
            AppError::Storage(m) if m.contains("interrupted") => AppError::Cancelled,
            AppError::Storage(m) => AppError::Query(m),
            other => other,
        })
    }

    fn rows_text(conn: &Connection, sql: &str) -> AppResult<Vec<Vec<Option<String>>>> {
        let mut st = conn.prepare(sql)?;
        let n = st.column_count();
        let rows = st.query_map([], |r| {
            (0..n)
                .map(|i| match r.get_ref(i)? {
                    ValueRef::Null => Ok(None),
                    ValueRef::Integer(v) => Ok(Some(v.to_string())),
                    ValueRef::Real(v) => Ok(Some(v.to_string())),
                    ValueRef::Text(t) => Ok(Some(String::from_utf8_lossy(t).into_owned())),
                    ValueRef::Blob(b) => Ok(Some(format!("x'{}'", hex::encode(b)))),
                })
                .collect::<rusqlite::Result<Vec<_>>>()
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

fn s(v: &Option<String>) -> String {
    v.clone().unwrap_or_default()
}

/// Split a script into statements on `;` outside quotes/comments so each one
/// can be prepared on its own (SQLite has no multi-statement query API).
pub fn split_statements(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut chars = sql.chars().peekable();
    let mut quote: Option<char> = None;
    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            cur.push(c);
            if c == q {
                if chars.peek() == Some(&q) {
                    cur.push(chars.next().unwrap());
                } else {
                    quote = None;
                }
            }
            continue;
        }
        match c {
            '\'' | '"' | '`' | '[' => {
                quote = Some(if c == '[' { ']' } else { c });
                cur.push(c);
            }
            '-' if chars.peek() == Some(&'-') => {
                while let Some(&n) = chars.peek() {
                    if n == '\n' {
                        break;
                    }
                    chars.next();
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                while let Some(n) = chars.next() {
                    if n == '*' && chars.peek() == Some(&'/') {
                        chars.next();
                        break;
                    }
                }
            }
            ';' => {
                if !cur.trim().is_empty() {
                    out.push(cur.trim().to_string());
                }
                cur.clear();
            }
            _ => cur.push(c),
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

#[async_trait]
impl SqlDriver for SqliteDriver {
    fn kind(&self) -> DriverKind {
        DriverKind::Sqlite
    }

    fn dialect(&self) -> Dialect {
        Dialect::Sqlite
    }

    async fn server_info(&self) -> AppResult<ServerInfo> {
        let path = self.path.clone();
        self.with_conn(move |c| {
            let version: String = c.query_row("SELECT sqlite_version()", [], |r| r.get(0))?;
            let size: i64 = c
                .query_row("SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()", [], |r| r.get(0))
                .unwrap_or(0);
            Ok(ServerInfo {
                driver: DriverKind::Sqlite,
                version,
                database: Some(path.clone()),
                user: None,
                extra: serde_json::json!({ "path": path, "sizeBytes": size }),
            })
        })
        .await
    }

    async fn list_databases(&self, _include_system: bool) -> AppResult<Vec<String>> {
        Ok(vec!["main".into()])
    }

    async fn list_schemas(&self, _include_system: bool) -> AppResult<Vec<String>> {
        self.with_conn(|c| {
            let rows = Self::rows_text(c, "PRAGMA database_list")?;
            Ok(rows.into_iter().filter_map(|r| r.get(1).cloned().flatten()).collect())
        })
        .await
    }

    async fn list_tables(&self, schema: &str) -> AppResult<Vec<TableInfo>> {
        let schema = schema.to_string();
        self.with_conn(move |c| {
            let sql = format!(
                "SELECT name, type FROM {}.sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
                Dialect::Sqlite.quote_ident(&schema)
            );
            let rows = Self::rows_text(c, &sql)?;
            Ok(rows
                .into_iter()
                .map(|r| TableInfo {
                    schema: schema.clone(),
                    name: s(&r[0]),
                    kind: if s(&r[1]) == "view" { "view" } else { "table" }.to_string(),
                    row_estimate: None,
                    comment: None,
                })
                .collect())
        })
        .await
    }

    async fn columns(&self, schema: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
        let q = format!("PRAGMA {}.table_info({})", Dialect::Sqlite.quote_ident(schema), Dialect::Sqlite.quote_ident(table));
        let ddl_q = format!(
            "SELECT sql FROM {}.sqlite_master WHERE name = {}",
            Dialect::Sqlite.quote_ident(schema),
            Dialect::Sqlite.quote_literal(table)
        );
        self.with_conn(move |c| {
            let rows = Self::rows_text(c, &q)?;
            let ddl = Self::rows_text(c, &ddl_q).ok().and_then(|r| r.into_iter().next()).and_then(|r| r.into_iter().next().flatten()).unwrap_or_default();
            let autoinc = ddl.to_ascii_uppercase().contains("AUTOINCREMENT");
            // cid, name, type, notnull, dflt_value, pk
            Ok(rows
                .into_iter()
                .map(|r| {
                    let pk = s(&r[5]) != "0";
                    let ty = s(&r[2]);
                    ColumnInfo {
                        name: s(&r[1]),
                        nullable: s(&r[3]) == "0" && !pk,
                        primary_key: pk,
                        default: r[4].clone(),
                        auto_increment: pk && (autoinc || ty.eq_ignore_ascii_case("INTEGER")),
                        comment: None,
                        position: s(&r[0]).parse::<i32>().unwrap_or(0) + 1,
                        data_type: if ty.is_empty() { "ANY".into() } else { ty },
                    }
                })
                .collect())
        })
        .await
    }

    async fn structure(&self, schema: &str, table: &str) -> AppResult<TableStructure> {
        let columns = self.columns(schema, table).await?;
        let d = Dialect::Sqlite;
        let qs = d.quote_ident(schema);
        let qt = d.quote_ident(table);
        let lit = d.quote_literal(table);
        self.with_conn(move |c| {
            let mut indexes = Vec::new();
            for r in Self::rows_text(c, &format!("PRAGMA {qs}.index_list({qt})"))? {
                // seq, name, unique, origin, partial
                let name = s(&r[1]);
                let cols = Self::rows_text(c, &format!("PRAGMA {qs}.index_info({})", d.quote_ident(&name)))?
                    .into_iter()
                    .filter_map(|x| x.get(2).cloned().flatten())
                    .collect();
                let definition = Self::rows_text(c, &format!("SELECT sql FROM {qs}.sqlite_master WHERE name = {}", d.quote_literal(&name)))
                    .ok()
                    .and_then(|x| x.into_iter().next())
                    .and_then(|x| x.into_iter().next().flatten());
                indexes.push(IndexInfo { primary: s(&r[3]) == "pk", unique: s(&r[2]) == "1", columns: cols, definition, name });
            }
            let mut foreign_keys: Vec<ForeignKeyInfo> = Vec::new();
            for r in Self::rows_text(c, &format!("PRAGMA {qs}.foreign_key_list({qt})"))? {
                // id, seq, table, from, to, on_update, on_delete, match
                let id = s(&r[0]);
                let name = format!("fk_{id}");
                if let Some(fk) = foreign_keys.iter_mut().find(|f| f.name == name) {
                    fk.columns.push(s(&r[3]));
                    fk.ref_columns.push(s(&r[4]));
                } else {
                    foreign_keys.push(ForeignKeyInfo {
                        name,
                        columns: vec![s(&r[3])],
                        ref_schema: "main".into(),
                        ref_table: s(&r[2]),
                        ref_columns: vec![s(&r[4])],
                        on_update: r[5].clone(),
                        on_delete: r[6].clone(),
                    });
                }
            }
            let ddl = Self::rows_text(c, &format!("SELECT sql FROM {qs}.sqlite_master WHERE name = {lit}"))
                .ok()
                .and_then(|x| x.into_iter().next())
                .and_then(|x| x.into_iter().next().flatten());
            Ok(TableStructure { columns, indexes, foreign_keys, ddl })
        })
        .await
    }

    async fn query_with(&self, sql: &str, max_rows: usize, sink: Option<RowSink>) -> AppResult<Vec<ResultSet>> {
        let statements = split_statements(sql);
        self.with_conn(move |c| {
            let mut out = sink.map(StreamOut::new);
            let mut sets = Vec::new();
            for st in statements {
                let started = Instant::now();
                let mut stmt = c.prepare(&st)?;
                let n = stmt.column_count();
                if n == 0 {
                    let affected = stmt.execute([])?;
                    if let Some(o) = out.as_mut() {
                        o.next_set();
                    }
                    sets.push(ResultSet::command(affected as u64, started.elapsed().as_millis() as u64, Some(st)));
                    continue;
                }
                let columns: Vec<ResultColumn> = stmt
                    .columns()
                    .iter()
                    .map(|c| {
                        let decl = c.decl_type().unwrap_or("").to_string();
                        ResultColumn { name: c.name().to_string(), kind: sqlite_kind(&decl), data_type: if decl.is_empty() { "ANY".into() } else { decl } }
                    })
                    .collect();
                let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
                let mut truncated = false;
                let mut total = 0usize;
                let mut q = stmt.query([])?;
                while let Some(r) = q.next()? {
                    if total >= max_rows {
                        truncated = true;
                        break;
                    }
                    let row = (0..n)
                        .map(|i| match r.get_ref(i) {
                            Ok(ValueRef::Null) | Err(_) => serde_json::Value::Null,
                            Ok(ValueRef::Integer(v)) => {
                                if columns[i].kind == ColumnKind::Bool && (v == 0 || v == 1) {
                                    serde_json::Value::Bool(v == 1)
                                } else {
                                    serde_json::Value::from(v)
                                }
                            }
                            Ok(ValueRef::Real(v)) => serde_json::Number::from_f64(v).map(serde_json::Value::Number).unwrap_or(serde_json::Value::String(v.to_string())),
                            Ok(ValueRef::Text(t)) => serde_json::Value::String(String::from_utf8_lossy(t).into_owned()),
                            Ok(ValueRef::Blob(b)) => serde_json::Value::String(format!("x'{}'", hex::encode(b))),
                        })
                        .collect();
                    rows.push(row);
                    total += 1;
                    if let Some(o) = out.as_mut() {
                        o.emit(&columns, &mut rows, false);
                    }
                }
                if let Some(o) = out.as_mut() {
                    o.emit(&columns, &mut rows, true);
                    o.next_set();
                }
                sets.push(ResultSet { columns, rows, row_count: total, affected: None, truncated, elapsed_ms: started.elapsed().as_millis() as u64, statement: Some(st), streamed: out.is_some() });
            }
            if sets.is_empty() {
                sets.push(ResultSet::command(0, 0, None));
            }
            Ok(sets)
        })
        .await
    }

    async fn execute_transaction(&self, statements: &[String]) -> AppResult<u64> {
        let statements = statements.to_vec();
        self.with_conn(move |c| {
            c.execute_batch("BEGIN")?;
            let mut affected = 0u64;
            for st in &statements {
                match c.execute(st, []) {
                    Ok(n) => affected += n as u64,
                    Err(e) => {
                        let _ = c.execute_batch("ROLLBACK");
                        return Err(AppError::Query(e.to_string()));
                    }
                }
            }
            c.execute_batch("COMMIT")?;
            Ok(affected)
        })
        .await
    }

    async fn cancel(&self) -> AppResult<()> {
        self.interrupt.interrupt();
        Ok(())
    }

    async fn close(&self) {}
}

#[cfg(test)]
mod tests {
    use super::split_statements;

    #[test]
    fn splits_on_semicolons_outside_quotes_and_comments() {
        let parts = split_statements("SELECT 'a;b'; -- c;\nINSERT INTO t VALUES (\"x;y\"); /* z; */ SELECT 1");
        assert_eq!(parts, vec!["SELECT 'a;b'", "INSERT INTO t VALUES (\"x;y\")", "SELECT 1"]);
    }
}
