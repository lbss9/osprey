use tauri::State;

use crate::error::{AppError, CmdResult};
use crate::models::{RedisMutation, RedisScanRequest, RedisScanResult, RedisValue, RedisValueRequest};
use crate::state::AppState;
use crate::store::{history, now_ms};

#[tauri::command]
pub async fn redis_scan(
    state: State<'_, AppState>,
    connection_id: String,
    req: RedisScanRequest,
) -> CmdResult<RedisScanResult> {
    let r = state.session(&connection_id).await?.redis()?;
    Ok(r.scan(&req).await?)
}

#[tauri::command]
pub async fn redis_value(
    state: State<'_, AppState>,
    connection_id: String,
    req: RedisValueRequest,
) -> CmdResult<RedisValue> {
    let r = state.session(&connection_id).await?.redis()?;
    Ok(r.value(&req).await?)
}

#[tauri::command]
pub async fn redis_mutate(
    state: State<'_, AppState>,
    connection_id: String,
    mutation: RedisMutation,
) -> CmdResult<()> {
    let read_only = {
        let db = state.lock_db()?;
        crate::store::connections::get(&db, &connection_id)?
            .map(|(c, _)| c.read_only)
            .unwrap_or(false)
    };
    if read_only {
        return Err(AppError::ReadOnly.into());
    }
    let r = state.session(&connection_id).await?.redis()?;
    Ok(r.mutate(&mutation).await?)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisCommandResult {
    pub reply: serde_json::Value,
    pub elapsed_ms: u64,
}

#[tauri::command]
pub async fn redis_command(
    state: State<'_, AppState>,
    connection_id: String,
    line: String,
) -> CmdResult<RedisCommandResult> {
    let r = state.session(&connection_id).await?.redis()?;
    let started = now_ms();
    let outcome = r.command(&line).await;
    let entry = crate::models::HistoryEntry {
        id: uuid::Uuid::new_v4().to_string(),
        connection_id: connection_id.clone(),
        sql: line.clone(),
        at: started,
        duration_ms: outcome.as_ref().map(|(_, ms)| *ms).unwrap_or(0),
        ok: outcome.is_ok(),
        rows: None,
        error: outcome.as_ref().err().map(|e| e.to_string()),
    };
    if let Ok(db) = state.lock_db() {
        let _ = history::add(&db, &entry);
    }
    let (reply, elapsed_ms) = outcome?;
    Ok(RedisCommandResult { reply, elapsed_ms })
}

#[tauri::command]
pub async fn redis_info(state: State<'_, AppState>, connection_id: String) -> CmdResult<serde_json::Value> {
    let r = state.session(&connection_id).await?.redis()?;
    Ok(r.info().await?)
}
