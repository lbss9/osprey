//! Microsoft SQL Server over `tiberius` (TDS 7.3+, rustls). One connection
//! per session behind a mutex; `KILL <spid>` from a second, short-lived
//! connection cancels a running statement. Scripts may use `GO` separators.

use std::time::Instant;

use async_trait::async_trait;
use futures_util::StreamExt;
use tiberius::{AuthMethod, Client, ColumnData, ColumnType, Config, EncryptionLevel, QueryItem};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use super::sql::Dialect;
use super::sqlite::split_statements;
use crate::error::{AppError, AppResult};
use crate::models::*;

type Conn = Client<Compat<TcpStream>>;

pub struct MssqlDriver {
    client: Mutex<Conn>,
    config: Config,
    /// session id of `client`; `KILL` from a second connection ends the session,
    /// so after a cancel the next call reconnects
    spid: std::sync::atomic::AtomicI32,
    dead: std::sync::atomic::AtomicBool,
    database: String,
}

fn s(v: &Option<String>) -> String {
    v.clone().unwrap_or_default()
}

fn map_err(e: tiberius::error::Error) -> AppError {
    use tiberius::error::Error as E;
    match e {
        E::Server(ref t) if t.code() == 18456 || t.code() == 18452 => AppError::Auth(t.message().to_string()),
        E::Server(ref t) if t.code() == 4060 => AppError::Connect(t.message().to_string()),
        E::Server(t) => AppError::Query(format!("{} (code {})", t.message(), t.code())),
        E::Io { .. } | E::Routing { .. } => AppError::Connect(e.to_string()),
        E::Tls(m) => AppError::Tls(m),
        other => AppError::Query(other.to_string()),
    }
}

/// Wire type → display name and kind.
fn type_info(ct: ColumnType) -> (&'static str, ColumnKind) {
    use ColumnKind as K;
    match ct {
        ColumnType::Bit | ColumnType::Bitn => ("bit", K::Bool),
        ColumnType::Int1 => ("tinyint", K::Number),
        ColumnType::Int2 => ("smallint", K::Number),
        ColumnType::Int4 | ColumnType::Intn => ("int", K::Number),
        ColumnType::Int8 => ("bigint", K::Number),
        ColumnType::Float4 => ("real", K::Number),
        ColumnType::Float8 | ColumnType::Floatn => ("float", K::Number),
        ColumnType::Money | ColumnType::Money4 => ("money", K::Number),
        ColumnType::Decimaln | ColumnType::Numericn => ("decimal", K::Number),
        ColumnType::Datetime | ColumnType::Datetime4 | ColumnType::Datetimen => ("datetime", K::Date),
        ColumnType::Daten => ("date", K::Date),
        ColumnType::Timen => ("time", K::Date),
        ColumnType::Datetime2 => ("datetime2", K::Date),
        ColumnType::DatetimeOffsetn => ("datetimeoffset", K::Date),
        ColumnType::Guid => ("uniqueidentifier", K::String),
        ColumnType::BigVarBin | ColumnType::BigBinary | ColumnType::Image => ("varbinary", K::Bytes),
        ColumnType::BigVarChar | ColumnType::BigChar | ColumnType::Text => ("varchar", K::String),
        ColumnType::NVarchar | ColumnType::NChar | ColumnType::NText => ("nvarchar", K::String),
        ColumnType::Xml => ("xml", K::String),
        ColumnType::Null => ("null", K::Other),
        _ => ("sql_variant", K::Other),
    }
}

fn numeric_to_json(n: tiberius::numeric::Numeric) -> serde_json::Value {
    let scale = n.scale() as usize;
    let raw = n.value();
    let neg = raw < 0;
    let mut digits = raw.unsigned_abs().to_string();
    if scale > 0 {
        while digits.len() <= scale {
            digits.insert(0, '0');
        }
        digits.insert(digits.len() - scale, '.');
    }
    let significant = digits.trim_start_matches('0').len();
    let text = if neg { format!("-{digits}") } else { digits };
    // small values with a short scale fit a JSON number exactly; keep big ones as text
    match text.parse::<f64>() {
        Ok(f) if significant <= 15 => serde_json::Number::from_f64(f).map(serde_json::Value::Number).unwrap_or(serde_json::Value::String(text)),
        _ => serde_json::Value::String(text),
    }
}

fn cell_to_json(d: ColumnData<'_>) -> serde_json::Value {
    use serde_json::Value as J;
    match d {
        ColumnData::U8(v) => v.map(J::from).unwrap_or(J::Null),
        ColumnData::I16(v) => v.map(J::from).unwrap_or(J::Null),
        ColumnData::I32(v) => v.map(J::from).unwrap_or(J::Null),
        ColumnData::I64(v) => v.map(J::from).unwrap_or(J::Null),
        ColumnData::F32(v) => v.and_then(|f| serde_json::Number::from_f64(f as f64)).map(J::Number).unwrap_or(J::Null),
        ColumnData::F64(v) => v.and_then(serde_json::Number::from_f64).map(J::Number).unwrap_or(J::Null),
        ColumnData::Bit(v) => v.map(J::Bool).unwrap_or(J::Null),
        ColumnData::String(v) => v.map(|s| J::String(s.into_owned())).unwrap_or(J::Null),
        ColumnData::Guid(v) => v.map(|g| J::String(g.to_string())).unwrap_or(J::Null),
        ColumnData::Binary(v) => v.map(|b| J::String(format!("0x{}", hex::encode(b)))).unwrap_or(J::Null),
        ColumnData::Numeric(v) => v.map(numeric_to_json).unwrap_or(J::Null),
        ColumnData::Xml(v) => v.map(|x| J::String(x.to_string())).unwrap_or(J::Null),
        ColumnData::DateTime(v) => v.map(|t| J::String(fmt_dt(dt_from_1900(t.days() as i64, t.seconds_fragments() as i64 * 1_000_000_000 / 300)))).unwrap_or(J::Null),
        ColumnData::SmallDateTime(v) => v.map(|t| J::String(fmt_dt(dt_from_1900(t.days() as i64, t.seconds_fragments() as i64 * 60 * 1_000_000_000)))).unwrap_or(J::Null),
        ColumnData::Date(v) => v.map(|t| J::String(date_from_days(t.days() as i64).format("%Y-%m-%d").to_string())).unwrap_or(J::Null),
        ColumnData::Time(v) => v.map(|t| J::String(fmt_time(time_nanos(t.increments(), t.scale())))).unwrap_or(J::Null),
        ColumnData::DateTime2(v) => v
            .map(|t| J::String(fmt_dt(date_from_days(t.date().days() as i64).and_hms_opt(0, 0, 0).unwrap() + chrono::Duration::nanoseconds(time_nanos(t.time().increments(), t.time().scale())))))
            .unwrap_or(J::Null),
        ColumnData::DateTimeOffset(v) => v
            .map(|t| {
                let d2 = t.datetime2();
                let utc = date_from_days(d2.date().days() as i64).and_hms_opt(0, 0, 0).unwrap() + chrono::Duration::nanoseconds(time_nanos(d2.time().increments(), d2.time().scale()));
                let off = chrono::FixedOffset::east_opt(t.offset() as i32 * 60).unwrap_or(chrono::FixedOffset::east_opt(0).unwrap());
                J::String(chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(utc, chrono::Utc).with_timezone(&off).to_rfc3339())
            })
            .unwrap_or(J::Null),
    }
}

fn date_from_days(days_since_0001: i64) -> chrono::NaiveDate {
    chrono::NaiveDate::from_ymd_opt(1, 1, 1).unwrap() + chrono::Duration::days(days_since_0001)
}
fn dt_from_1900(days: i64, nanos: i64) -> chrono::NaiveDateTime {
    chrono::NaiveDate::from_ymd_opt(1900, 1, 1).unwrap().and_hms_opt(0, 0, 0).unwrap() + chrono::Duration::days(days) + chrono::Duration::nanoseconds(nanos)
}
fn time_nanos(increments: u64, scale: u8) -> i64 {
    (increments as i64) * 10i64.pow(9u32.saturating_sub(scale as u32))
}
fn fmt_dt(t: chrono::NaiveDateTime) -> String {
    let s = t.format("%Y-%m-%d %H:%M:%S%.9f").to_string();
    trim_fraction(&s)
}
fn fmt_time(nanos: i64) -> String {
    let t = chrono::NaiveTime::from_hms_opt(0, 0, 0).unwrap() + chrono::Duration::nanoseconds(nanos);
    trim_fraction(&t.format("%H:%M:%S%.9f").to_string())
}
fn trim_fraction(s: &str) -> String {
    match s.find('.') {
        Some(i) => {
            let t = s.trim_end_matches('0');
            if t.len() == i + 1 { t[..i].to_string() } else { t.to_string() }
        }
        None => s.to_string(),
    }
}

/// Statements that produce rows go through `simple_query`; everything else
/// through `execute` so the affected count comes back.
fn returns_rows(st: &str) -> bool {
    let trimmed = st.trim_start_matches(|c: char| c.is_whitespace() || c == ';');
    let first = trimmed.split(|c: char| !c.is_alphanumeric() && c != '_').next().unwrap_or("").to_ascii_lowercase();
    if first == "with" {
        // a CTE can feed INSERT/UPDATE/DELETE/MERGE: those need the affected count
        let lower = trimmed.to_ascii_lowercase();
        let bytes = lower.as_bytes();
        let mut depth = 0i32;
        for (i, &b) in bytes.iter().enumerate() {
            match b {
                b'(' => depth += 1,
                b')' => depth -= 1,
                _ if depth == 0 => {
                    let rest = &lower[i..];
                    for kw in ["insert", "update", "delete", "merge"] {
                        if rest.starts_with(kw) && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric()) {
                            return false;
                        }
                    }
                }
                _ => {}
            }
        }
        return true;
    }
    matches!(first.as_str(), "select" | "exec" | "execute" | "values" | "declare" | "set" | "dbcc" | "sp_help" | "show")
}

/// Split on `GO` batch separators (a line by itself) and then on `;`.
fn split_batches(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for line in sql.lines() {
        if line.trim().eq_ignore_ascii_case("go") {
            out.extend(split_statements(&cur));
            cur.clear();
        } else {
            cur.push_str(line);
            cur.push('\n');
        }
    }
    out.extend(split_statements(&cur));
    out
}

impl MssqlDriver {
    fn build_config(cfg: &ConnectionConfig, password: Option<&str>, database: Option<&str>) -> Config {
        let mut c = Config::new();
        c.host(&cfg.host);
        c.port(cfg.port);
        c.authentication(AuthMethod::sql_server(&cfg.user, password.unwrap_or("")));
        let db = database.map(str::to_string).filter(|d| !d.is_empty()).unwrap_or_else(|| cfg.database.clone());
        if !db.is_empty() {
            c.database(&db);
        }
        if let Some(app) = cfg.options.get("applicationName").and_then(|v| v.as_str()).filter(|a| !a.is_empty()) {
            c.application_name(app);
        }
        match cfg.ssl_mode {
            SslMode::Disable => c.encryption(EncryptionLevel::NotSupported),
            SslMode::Prefer | SslMode::Require => {
                c.encryption(EncryptionLevel::Required);
                c.trust_cert();
            }
            SslMode::Verify => c.encryption(EncryptionLevel::Required),
        }
        c
    }

    async fn open(config: &Config, timeout_secs: u64) -> AppResult<Conn> {
        let tcp = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), TcpStream::connect(config.get_addr()))
            .await
            .map_err(|_| AppError::Connect("timeout".into()))?
            .map_err(|e| AppError::Connect(e.to_string()))?;
        tcp.set_nodelay(true).ok();
        Client::connect(config.clone(), tcp.compat_write()).await.map_err(map_err)
    }

    async fn spid_of(client: &mut Conn) -> i32 {
        let Ok(stream) = client.simple_query("SELECT @@SPID").await else { return 0 };
        stream
            .into_row()
            .await
            .ok()
            .flatten()
            .and_then(|r| r.get::<i16, _>(0).map(|v| v as i32).or_else(|| r.get::<i32, _>(0)))
            .unwrap_or(0)
    }

    pub async fn connect(cfg: &ConnectionConfig, password: Option<&str>, database: Option<&str>) -> AppResult<Self> {
        let config = Self::build_config(cfg, password, database);
        let timeout = cfg.options.get("connectTimeout").and_then(|v| v.as_u64()).unwrap_or(15);
        let mut client = Self::open(&config, timeout).await?;
        let spid = Self::spid_of(&mut client).await;
        let database = database.map(str::to_string).filter(|d| !d.is_empty()).unwrap_or_else(|| cfg.database.clone());
        Ok(MssqlDriver {
            client: Mutex::new(client),
            config,
            spid: std::sync::atomic::AtomicI32::new(spid),
            dead: std::sync::atomic::AtomicBool::new(false),
            database,
        })
    }

    /// The session connection, reopened if a cancel killed it.
    async fn conn(&self) -> AppResult<tokio::sync::MutexGuard<'_, Conn>> {
        use std::sync::atomic::Ordering;
        let mut guard = self.client.lock().await;
        if self.dead.load(Ordering::SeqCst) {
            let mut fresh = Self::open(&self.config, 15).await?;
            let spid = Self::spid_of(&mut fresh).await;
            *guard = fresh;
            self.spid.store(spid, Ordering::SeqCst);
            self.dead.store(false, Ordering::SeqCst);
        }
        Ok(guard)
    }

    /// Run one statement; rows when it yields any, else the affected count.
    async fn run_one(client: &mut Conn, st: &str, max_rows: usize, out: &mut Option<StreamOut>) -> AppResult<Vec<ResultSet>> {
        let started = Instant::now();
        if !returns_rows(st) {
            let r = client.execute(st, &[]).await.map_err(map_err)?;
            if let Some(o) = out.as_mut() {
                o.next_set();
            }
            return Ok(vec![ResultSet::command(r.total(), started.elapsed().as_millis() as u64, Some(st.to_string()))]);
        }
        let mut stream = client.simple_query(st).await.map_err(map_err)?;
        let mut sets: Vec<ResultSet> = Vec::new();
        let mut columns: Vec<ResultColumn> = Vec::new();
        let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
        let mut total = 0usize;
        let mut truncated = false;
        let mut open = false;
        let mut set_started = Instant::now();
        let finish = |columns: &mut Vec<ResultColumn>, rows: &mut Vec<Vec<serde_json::Value>>, total: usize, truncated: bool, elapsed: u64, out: &mut Option<StreamOut>, sets: &mut Vec<ResultSet>| {
            if let Some(o) = out.as_mut() {
                o.emit(columns, rows, true);
                o.next_set();
            }
            sets.push(ResultSet {
                columns: std::mem::take(columns),
                rows: std::mem::take(rows),
                row_count: total,
                affected: None,
                truncated,
                elapsed_ms: elapsed,
                statement: Some(st.to_string()),
                streamed: out.is_some(),
            });
        };
        while let Some(item) = stream.next().await {
            match item.map_err(map_err)? {
                QueryItem::Metadata(meta) => {
                    if open {
                        finish(&mut columns, &mut rows, total, truncated, set_started.elapsed().as_millis() as u64, out, &mut sets);
                    }
                    open = true;
                    set_started = Instant::now();
                    total = 0;
                    truncated = false;
                    columns = meta
                        .columns()
                        .iter()
                        .map(|c| {
                            let (name, kind) = type_info(c.column_type());
                            ResultColumn { name: c.name().to_string(), data_type: name.to_string(), kind }
                        })
                        .collect();
                }
                QueryItem::Row(row) => {
                    if total >= max_rows {
                        truncated = true;
                        continue;
                    }
                    rows.push(row.into_iter().map(cell_to_json).collect());
                    total += 1;
                    if let Some(o) = out.as_mut() {
                        o.emit(&columns, &mut rows, false);
                    }
                }
            }
        }
        if open {
            finish(&mut columns, &mut rows, total, truncated, set_started.elapsed().as_millis() as u64, out, &mut sets);
        }
        if sets.is_empty() {
            sets.push(ResultSet::command(0, started.elapsed().as_millis() as u64, Some(st.to_string())));
        }
        Ok(sets)
    }

    async fn rows_text(&self, sql: &str) -> AppResult<Vec<Vec<Option<String>>>> {
        let mut client = self.conn().await?;
        let sets = Self::run_one(&mut client, sql, super::HARD_MAX_ROWS, &mut None).await?;
        Ok(sets
            .into_iter()
            .flat_map(|s| s.rows)
            .map(|r| {
                r.into_iter()
                    .map(|v| match v {
                        serde_json::Value::Null => None,
                        serde_json::Value::String(t) => Some(t),
                        serde_json::Value::Bool(b) => Some(if b { "1".into() } else { "0".into() }),
                        other => Some(other.to_string()),
                    })
                    .collect()
            })
            .collect())
    }
}

/// `nvarchar(50)`, `decimal(10,2)`, `datetime2(3)`… from sys.columns fields.
fn type_name(base: &str, max_length: i32, precision: i32, scale: i32) -> String {
    let b = base.to_ascii_lowercase();
    match b.as_str() {
        "nvarchar" | "nchar" => format!("{b}({})", if max_length == -1 { "max".to_string() } else { (max_length / 2).to_string() }),
        "varchar" | "char" | "varbinary" | "binary" => format!("{b}({})", if max_length == -1 { "max".to_string() } else { max_length.to_string() }),
        "decimal" | "numeric" => format!("{b}({precision},{scale})"),
        "datetime2" | "time" | "datetimeoffset" => format!("{b}({scale})"),
        _ => b,
    }
}

#[async_trait]
impl super::SqlDriver for MssqlDriver {
    fn kind(&self) -> DriverKind {
        DriverKind::Mssql
    }
    fn dialect(&self) -> Dialect {
        Dialect::Mssql
    }

    async fn server_info(&self) -> AppResult<ServerInfo> {
        let rows = self
            .rows_text("SELECT CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(50)), DB_NAME(), SUSER_SNAME(), CAST(SERVERPROPERTY('Edition') AS NVARCHAR(100))")
            .await?;
        let r = rows.first().cloned().unwrap_or_default();
        Ok(ServerInfo {
            driver: DriverKind::Mssql,
            version: r.first().map(s).unwrap_or_default(),
            database: r.get(1).cloned().flatten(),
            user: r.get(2).cloned().flatten(),
            extra: serde_json::json!({ "edition": r.get(3).cloned().flatten() }),
        })
    }

    async fn list_databases(&self, include_system: bool) -> AppResult<Vec<String>> {
        let filter = if include_system { "" } else { "WHERE name NOT IN ('master', 'tempdb', 'model', 'msdb')" };
        let rows = self.rows_text(&format!("SELECT name FROM sys.databases {filter} ORDER BY name")).await?;
        Ok(rows.into_iter().map(|r| s(&r[0])).collect())
    }

    async fn list_schemas(&self, include_system: bool) -> AppResult<Vec<String>> {
        let filter = if include_system {
            ""
        } else {
            "WHERE name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest') AND name NOT LIKE 'db[_]%'"
        };
        let rows = self
            .rows_text(&format!("SELECT name FROM sys.schemas {filter} ORDER BY CASE WHEN name = 'dbo' THEN 0 ELSE 1 END, name"))
            .await?;
        let _ = &self.database;
        Ok(rows.into_iter().map(|r| s(&r[0])).collect())
    }

    async fn list_tables(&self, schema: &str) -> AppResult<Vec<TableInfo>> {
        let d = Dialect::Mssql;
        let rows = self
            .rows_text(&format!(
                "SELECT o.name, o.type, SUM(p.rows), CAST(ep.value AS NVARCHAR(MAX))
                 FROM sys.objects o
                 JOIN sys.schemas s ON s.schema_id = o.schema_id
                 LEFT JOIN sys.partitions p ON p.object_id = o.object_id AND p.index_id IN (0, 1)
                 LEFT JOIN sys.extended_properties ep ON ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
                 WHERE s.name = {} AND o.type IN ('U', 'V')
                 GROUP BY o.name, o.type, CAST(ep.value AS NVARCHAR(MAX))
                 ORDER BY o.name",
                d.quote_literal(schema)
            ))
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| TableInfo {
                schema: schema.to_string(),
                name: s(&r[0]),
                kind: if s(&r[1]).trim() == "V" { "view" } else { "table" }.to_string(),
                row_estimate: r[2].as_deref().and_then(|v| v.parse::<f64>().ok()).map(|v| v as i64),
                comment: r[3].clone().filter(|c| !c.is_empty()),
            })
            .collect())
    }

    async fn columns(&self, schema: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
        let d = Dialect::Mssql;
        let rows = self
            .rows_text(&format!(
                "SELECT c.name, TYPE_NAME(c.user_type_id), c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity,
                        dc.definition, c.column_id,
                        CASE WHEN ic.column_id IS NOT NULL THEN 1 ELSE 0 END,
                        CAST(ep.value AS NVARCHAR(MAX))
                 FROM sys.columns c
                 JOIN sys.objects o ON o.object_id = c.object_id
                 JOIN sys.schemas s ON s.schema_id = o.schema_id
                 LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
                 LEFT JOIN sys.indexes i ON i.object_id = o.object_id AND i.is_primary_key = 1
                 LEFT JOIN sys.index_columns ic ON ic.object_id = o.object_id AND ic.index_id = i.index_id AND ic.column_id = c.column_id
                 LEFT JOIN sys.extended_properties ep ON ep.major_id = o.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
                 WHERE s.name = {} AND o.name = {}
                 ORDER BY c.column_id",
                d.quote_literal(schema),
                d.quote_literal(table)
            ))
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| ColumnInfo {
                name: s(&r[0]),
                data_type: type_name(&s(&r[1]), s(&r[2]).parse().unwrap_or(0), s(&r[3]).parse().unwrap_or(0), s(&r[4]).parse().unwrap_or(0)),
                nullable: s(&r[5]) == "1",
                auto_increment: s(&r[6]) == "1",
                default: r[7].clone().map(|v| v.trim_start_matches('(').trim_end_matches(')').to_string()),
                position: s(&r[8]).parse().unwrap_or(0),
                primary_key: s(&r[9]) == "1",
                comment: r[10].clone().filter(|c| !c.is_empty()),
            })
            .collect())
    }

    async fn list_routines(&self, schema: &str) -> AppResult<Vec<RoutineInfo>> {
        let d = Dialect::Mssql;
        let rows = self
            .rows_text(&format!(
                "SELECT o.name, o.type,
                        (SELECT STRING_AGG(CONCAT(p.name, ' ', TYPE_NAME(p.user_type_id)), ', ') WITHIN GROUP (ORDER BY p.parameter_id)
                         FROM sys.parameters p WHERE p.object_id = o.object_id AND p.parameter_id > 0),
                        (SELECT TYPE_NAME(p.user_type_id) FROM sys.parameters p WHERE p.object_id = o.object_id AND p.parameter_id = 0)
                 FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
                 WHERE s.name = {} AND o.type IN ('P', 'PC', 'FN', 'IF', 'TF', 'FS', 'FT')
                 ORDER BY o.name",
                d.quote_literal(schema)
            ))
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| RoutineInfo {
                schema: schema.to_string(),
                name: s(&r[0]),
                kind: if s(&r[1]).trim().starts_with('P') { "procedure" } else { "function" }.to_string(),
                args: s(&r[2]),
                returns: r[3].clone().filter(|v| !v.is_empty()),
                language: Some("tsql".into()),
            })
            .collect())
    }

    async fn routine_definition(&self, schema: &str, name: &str, _args: &str) -> AppResult<String> {
        let d = Dialect::Mssql;
        let rows = self.rows_text(&format!("SELECT OBJECT_DEFINITION(OBJECT_ID({}))", d.quote_literal(&format!("{schema}.{name}")))).await?;
        rows.into_iter().next().and_then(|r| r.into_iter().next().flatten()).ok_or_else(|| AppError::Query(format!("routine {schema}.{name} not found")))
    }

    async fn structure(&self, schema: &str, table: &str) -> AppResult<TableStructure> {
        let d = Dialect::Mssql;
        let columns = self.columns(schema, table).await?;
        let obj = d.quote_literal(&format!("{schema}.{table}"));
        let idx_rows = self
            .rows_text(&format!(
                "SELECT i.name, i.is_unique, i.is_primary_key, i.type_desc, c.name
                 FROM sys.indexes i
                 JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                 JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                 WHERE i.object_id = OBJECT_ID({obj}) AND i.name IS NOT NULL AND ic.is_included_column = 0
                 ORDER BY i.name, ic.key_ordinal"
            ))
            .await?;
        let mut indexes: Vec<IndexInfo> = Vec::new();
        for r in idx_rows {
            let name = s(&r[0]);
            if let Some(ix) = indexes.iter_mut().find(|i| i.name == name) {
                ix.columns.push(s(&r[4]));
            } else {
                indexes.push(IndexInfo { primary: s(&r[2]) == "1", unique: s(&r[1]) == "1", columns: vec![s(&r[4])], definition: Some(s(&r[3])), name });
            }
        }
        let fk_rows = self
            .rows_text(&format!(
                "SELECT fk.name, pc.name, rs.name, rt.name, rc.name, fk.update_referential_action_desc, fk.delete_referential_action_desc
                 FROM sys.foreign_keys fk
                 JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
                 JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
                 JOIN sys.objects rt ON rt.object_id = fk.referenced_object_id
                 JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
                 JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
                 WHERE fk.parent_object_id = OBJECT_ID({obj})
                 ORDER BY fk.name, fkc.constraint_column_id"
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
                    on_update: r[5].clone().map(|v| v.replace('_', " ")),
                    on_delete: r[6].clone().map(|v| v.replace('_', " ")),
                });
            }
        }
        let ddl = self
            .rows_text(&format!("SELECT OBJECT_DEFINITION(OBJECT_ID({obj}))"))
            .await
            .ok()
            .and_then(|r| r.into_iter().next())
            .and_then(|r| r.into_iter().next().flatten());
        Ok(TableStructure { columns, indexes, foreign_keys, ddl })
    }

    async fn query_with(&self, sql: &str, max_rows: usize, sink: Option<RowSink>) -> AppResult<Vec<ResultSet>> {
        let mut out = sink.map(StreamOut::new);
        let mut client = self.conn().await?;
        let mut sets = Vec::new();
        for st in split_batches(sql) {
            sets.extend(Self::run_one(&mut client, &st, max_rows, &mut out).await?);
        }
        if sets.is_empty() {
            sets.push(ResultSet::command(0, 0, None));
        }
        Ok(sets)
    }

    async fn execute_transaction(&self, statements: &[String]) -> AppResult<u64> {
        let mut client = self.conn().await?;
        client.simple_query("BEGIN TRANSACTION").await.map_err(map_err)?;
        let mut affected = 0u64;
        for st in statements {
            match client.execute(st.as_str(), &[]).await {
                Ok(r) => affected += r.total(),
                Err(e) => {
                    let _ = client.simple_query("IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION").await;
                    return Err(map_err(e));
                }
            }
        }
        client.simple_query("COMMIT TRANSACTION").await.map_err(map_err)?;
        Ok(affected)
    }

    /// `KILL` ends the whole session (TDS has no cancel we can reach from
    /// here), so the connection is marked dead and reopened on the next call.
    async fn cancel(&self) -> AppResult<()> {
        use std::sync::atomic::Ordering;
        let spid = self.spid.load(Ordering::SeqCst);
        if spid == 0 {
            return Ok(());
        }
        let mut killer = Self::open(&self.config, 10).await?;
        killer.execute(format!("KILL {spid}").as_str(), &[]).await.map_err(map_err)?;
        self.dead.store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn close(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_go_batches() {
        let v = split_batches("CREATE TABLE t (a int)\nGO\nINSERT INTO t VALUES (1); SELECT * FROM t\ngo\n");
        assert_eq!(v.len(), 3);
        assert!(v[0].starts_with("CREATE TABLE"));
        assert!(returns_rows("  SELECT 1") && !returns_rows("INSERT INTO t VALUES (1)"));
        assert!(returns_rows(";WITH n AS (SELECT 1 AS x) SELECT * FROM n"));
        assert!(!returns_rows("WITH n AS (SELECT 1 AS x) INSERT INTO t SELECT x FROM n"));
        assert!(!returns_rows("with n as (select 1 as x) update t set a = 1"));
    }

    #[test]
    fn type_names_from_catalog() {
        assert_eq!(type_name("nvarchar", -1, 0, 0), "nvarchar(max)");
        assert_eq!(type_name("nvarchar", 100, 0, 0), "nvarchar(50)");
        assert_eq!(type_name("decimal", 9, 10, 2), "decimal(10,2)");
        assert_eq!(type_name("int", 4, 10, 0), "int");
    }
}
