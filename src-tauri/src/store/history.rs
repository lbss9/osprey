use rusqlite::{params, Connection};

use crate::error::AppResult;
use crate::models::{HistoryEntry, SavedQuery};

const KEEP: i64 = 2000;

pub fn add(conn: &Connection, e: &HistoryEntry) -> AppResult<()> {
    conn.execute(
        "INSERT INTO query_history (id, connection_id, sql, at, duration_ms, ok, rows, error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            e.id,
            e.connection_id,
            e.sql,
            e.at,
            e.duration_ms as i64,
            e.ok as i64,
            e.rows.map(|r| r as i64),
            e.error
        ],
    )?;
    // keep the table bounded
    conn.execute(
        "DELETE FROM query_history WHERE id IN (
            SELECT id FROM query_history ORDER BY at DESC LIMIT -1 OFFSET ?1)",
        params![KEEP],
    )?;
    Ok(())
}

pub fn list(conn: &Connection, connection_id: Option<&str>, limit: u32) -> AppResult<Vec<HistoryEntry>> {
    let mut out = Vec::new();
    let map = |r: &rusqlite::Row| -> rusqlite::Result<HistoryEntry> {
        Ok(HistoryEntry {
            id: r.get(0)?,
            connection_id: r.get(1)?,
            sql: r.get(2)?,
            at: r.get(3)?,
            duration_ms: r.get::<_, i64>(4)? as u64,
            ok: r.get::<_, i64>(5)? != 0,
            rows: r.get::<_, Option<i64>>(6)?.map(|v| v as u64),
            error: r.get(7)?,
        })
    };
    match connection_id {
        Some(cid) => {
            let mut st = conn.prepare(
                "SELECT id, connection_id, sql, at, duration_ms, ok, rows, error FROM query_history
                 WHERE connection_id = ?1 ORDER BY at DESC LIMIT ?2",
            )?;
            for r in st.query_map(params![cid, limit as i64], map)? {
                out.push(r?);
            }
        }
        None => {
            let mut st = conn.prepare(
                "SELECT id, connection_id, sql, at, duration_ms, ok, rows, error FROM query_history
                 ORDER BY at DESC LIMIT ?1",
            )?;
            for r in st.query_map(params![limit as i64], map)? {
                out.push(r?);
            }
        }
    }
    Ok(out)
}

pub fn clear(conn: &Connection, connection_id: Option<&str>) -> AppResult<()> {
    match connection_id {
        Some(cid) => conn.execute(
            "DELETE FROM query_history WHERE connection_id = ?1",
            params![cid],
        )?,
        None => conn.execute("DELETE FROM query_history", [])?,
    };
    Ok(())
}

/* ------------------------------ saved queries ----------------------------- */

pub fn saved_list(conn: &Connection) -> AppResult<Vec<SavedQuery>> {
    let mut st = conn.prepare(
        "SELECT id, connection_id, name, sql, position, updated_at FROM saved_queries
         ORDER BY position, name COLLATE NOCASE",
    )?;
    let rows = st.query_map([], |r| {
        Ok(SavedQuery {
            id: r.get(0)?,
            connection_id: r.get(1)?,
            name: r.get(2)?,
            sql: r.get(3)?,
            position: r.get(4)?,
            updated_at: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn saved_upsert(conn: &Connection, q: &SavedQuery) -> AppResult<()> {
    conn.execute(
        "INSERT INTO saved_queries (id, connection_id, name, sql, position, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET connection_id = excluded.connection_id, name = excluded.name,
            sql = excluded.sql, position = excluded.position, updated_at = excluded.updated_at",
        params![q.id, q.connection_id, q.name, q.sql, q.position, super::now_ms()],
    )?;
    Ok(())
}

pub fn saved_delete(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM saved_queries WHERE id = ?1", params![id])?;
    Ok(())
}
