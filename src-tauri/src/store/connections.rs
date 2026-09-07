use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::error::{AppError, AppResult};
use crate::models::{ConnectionConfig, DriverKind, SslMode};

fn ssl_str(m: SslMode) -> &'static str {
    match m {
        SslMode::Disable => "disable",
        SslMode::Prefer => "prefer",
        SslMode::Require => "require",
        SslMode::Verify => "verify",
    }
}

fn ssl_parse(s: &str) -> SslMode {
    match s {
        "disable" => SslMode::Disable,
        "require" => SslMode::Require,
        "verify" => SslMode::Verify,
        _ => SslMode::Prefer,
    }
}

fn from_row(r: &Row) -> rusqlite::Result<(ConnectionConfig, Option<String>)> {
    let driver: String = r.get("driver")?;
    let options: String = r.get("options")?;
    let fallback: Option<String> = r.get("fallback_pw")?;
    Ok((
        ConnectionConfig {
            id: r.get("id")?,
            name: r.get("name")?,
            driver: DriverKind::parse(&driver).unwrap_or(DriverKind::Postgres),
            host: r.get("host")?,
            port: r.get::<_, i64>("port")? as u16,
            user: r.get("user")?,
            database: r.get("database")?,
            ssl_mode: ssl_parse(&r.get::<_, String>("ssl_mode")?),
            color: r.get("color")?,
            group: r.get("group_name")?,
            read_only: r.get::<_, i64>("read_only")? != 0,
            options: serde_json::from_str(&options).unwrap_or(serde_json::json!({})),
            position: r.get("position")?,
            created_at: r.get("created_at")?,
            last_used_at: r.get("last_used_at")?,
            has_password: fallback.is_some(),
            has_ssh_password: false,
        },
        fallback,
    ))
}

const COLS: &str = "id, name, driver, host, port, user, database, ssl_mode, color, group_name, read_only, options, position, created_at, last_used_at, fallback_pw";

pub fn list(conn: &Connection) -> AppResult<Vec<ConnectionConfig>> {
    let mut st = conn.prepare(&format!(
        "SELECT {COLS} FROM connections ORDER BY position, name COLLATE NOCASE"
    ))?;
    let rows = st.query_map([], |r| from_row(r).map(|(c, _)| c))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Option<(ConnectionConfig, Option<String>)>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLS} FROM connections WHERE id = ?1"),
            params![id],
            from_row,
        )
        .optional()?)
}

pub fn upsert(conn: &Connection, c: &ConnectionConfig) -> AppResult<()> {
    let options = serde_json::to_string(&c.options).unwrap_or_else(|_| "{}".into());
    let created = if c.created_at > 0 { c.created_at } else { super::now_ms() };
    conn.execute(
        "INSERT INTO connections (id, name, driver, host, port, user, database, ssl_mode, color, group_name, read_only, options, position, created_at, last_used_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name, driver = excluded.driver, host = excluded.host, port = excluded.port,
            user = excluded.user, database = excluded.database, ssl_mode = excluded.ssl_mode,
            color = excluded.color, group_name = excluded.group_name, read_only = excluded.read_only,
            options = excluded.options, position = excluded.position",
        params![
            c.id,
            c.name,
            c.driver.as_str(),
            c.host,
            c.port as i64,
            c.user,
            c.database,
            ssl_str(c.ssl_mode),
            c.color,
            c.group,
            c.read_only as i64,
            options,
            c.position,
            created,
            c.last_used_at,
        ],
    )?;
    Ok(())
}

pub fn set_fallback_password(conn: &Connection, id: &str, pw: Option<&str>) -> AppResult<()> {
    conn.execute(
        "UPDATE connections SET fallback_pw = ?2 WHERE id = ?1",
        params![id, pw],
    )?;
    Ok(())
}

pub fn touch(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE connections SET last_used_at = ?2 WHERE id = ?1",
        params![id, super::now_ms()],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    let n = conn.execute("DELETE FROM connections WHERE id = ?1", params![id])?;
    if n == 0 {
        return Err(AppError::Storage(format!("connection {id} not found")));
    }
    conn.execute(
        "DELETE FROM query_history WHERE connection_id = ?1",
        params![id],
    )?;
    Ok(())
}

pub fn reorder(conn: &Connection, ids: &[String]) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    for (i, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE connections SET position = ?2 WHERE id = ?1",
            params![id, i as i64],
        )?;
    }
    tx.commit()?;
    Ok(())
}
