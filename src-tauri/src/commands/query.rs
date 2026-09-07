use tauri::State;

use crate::drivers::HARD_MAX_ROWS;
use crate::error::CmdResult;
use crate::models::{HistoryEntry, ResultSet, SavedQuery};
use crate::state::AppState;
use crate::store::{history as repo, now_ms};

/// Run user SQL on a session and record it in the history.
#[tauri::command]
pub async fn query_run(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
    max_rows: Option<usize>,
) -> CmdResult<Vec<ResultSet>> {
    let s = state.session(&connection_id).await?.sql()?;
    let max = max_rows.unwrap_or(1000).clamp(1, HARD_MAX_ROWS);
    let started = std::time::Instant::now();
    let outcome = s.query(&sql, max).await;
    let duration_ms = started.elapsed().as_millis() as u64;
    let entry = HistoryEntry {
        id: uuid::Uuid::new_v4().to_string(),
        connection_id: connection_id.clone(),
        sql: sql.clone(),
        at: now_ms(),
        duration_ms,
        ok: outcome.is_ok(),
        rows: outcome.as_ref().ok().map(|sets| {
            sets.iter()
                .map(|r| r.affected.unwrap_or(r.row_count as u64))
                .sum()
        }),
        error: outcome.as_ref().err().map(|e| e.to_string()),
    };
    if let Ok(db) = state.lock_db() {
        let _ = repo::add(&db, &entry);
    }
    Ok(outcome?)
}

#[tauri::command]
pub async fn query_cancel(state: State<'_, AppState>, connection_id: String) -> CmdResult<()> {
    let s = state.session(&connection_id).await?.sql()?;
    Ok(s.cancel().await?)
}

#[tauri::command]
pub fn history_list(
    state: State<'_, AppState>,
    connection_id: Option<String>,
    limit: Option<u32>,
) -> CmdResult<Vec<HistoryEntry>> {
    let db = state.lock_db()?;
    Ok(repo::list(&db, connection_id.as_deref(), limit.unwrap_or(200))?)
}

#[tauri::command]
pub fn history_clear(state: State<'_, AppState>, connection_id: Option<String>) -> CmdResult<()> {
    let db = state.lock_db()?;
    Ok(repo::clear(&db, connection_id.as_deref())?)
}

#[tauri::command]
pub fn saved_queries_list(state: State<'_, AppState>) -> CmdResult<Vec<SavedQuery>> {
    let db = state.lock_db()?;
    Ok(repo::saved_list(&db)?)
}

#[tauri::command]
pub fn saved_query_save(state: State<'_, AppState>, mut query: SavedQuery) -> CmdResult<SavedQuery> {
    if query.id.is_empty() {
        query.id = uuid::Uuid::new_v4().to_string();
    }
    query.updated_at = now_ms();
    let db = state.lock_db()?;
    repo::saved_upsert(&db, &query)?;
    Ok(query)
}

#[tauri::command]
pub fn saved_query_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let db = state.lock_db()?;
    Ok(repo::saved_delete(&db, &id)?)
}
