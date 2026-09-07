//! Local SQLite persistence: saved connections, query history, saved queries.
//! `open` creates/migrates the schema; the submodules are repositories —
//! plain functions over a `Connection`, one per table.

pub mod connections;
pub mod history;

use rusqlite::Connection;

pub fn open(path: &std::path::Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS connections (
            id           TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            driver       TEXT NOT NULL,
            host         TEXT NOT NULL,
            port         INTEGER NOT NULL,
            user         TEXT NOT NULL DEFAULT '',
            database     TEXT NOT NULL DEFAULT '',
            ssl_mode     TEXT NOT NULL DEFAULT 'prefer',
            color        TEXT,
            group_name   TEXT,
            read_only    INTEGER NOT NULL DEFAULT 0,
            options      TEXT NOT NULL DEFAULT '{}',
            position     INTEGER NOT NULL DEFAULT 0,
            created_at   INTEGER NOT NULL,
            last_used_at INTEGER,
            fallback_pw  TEXT
        );

        CREATE TABLE IF NOT EXISTS query_history (
            id            TEXT PRIMARY KEY,
            connection_id TEXT NOT NULL,
            sql           TEXT NOT NULL,
            at            INTEGER NOT NULL,
            duration_ms   INTEGER NOT NULL,
            ok            INTEGER NOT NULL,
            rows          INTEGER,
            error         TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_history_at ON query_history(at DESC);

        CREATE TABLE IF NOT EXISTS saved_queries (
            id            TEXT PRIMARY KEY,
            connection_id TEXT,
            name          TEXT NOT NULL,
            sql           TEXT NOT NULL,
            position      INTEGER NOT NULL DEFAULT 0,
            updated_at    INTEGER NOT NULL
        );",
    )?;
    Ok(conn)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
