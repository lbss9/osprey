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
pub async fn redis_slowlog(state: State<'_, AppState>, connection_id: String, count: Option<u32>) -> CmdResult<Vec<crate::drivers::redis::SlowlogEntry>> {
    let r = state.session(&connection_id).await?.redis()?;
    Ok(r.slowlog(count.unwrap_or(128)).await?)
}

#[tauri::command]
pub async fn redis_memory(state: State<'_, AppState>, connection_id: String, pattern: Option<String>, sample: Option<u64>) -> CmdResult<crate::drivers::redis::MemoryReport> {
    let r = state.session(&connection_id).await?.redis()?;
    Ok(r.memory_report(pattern.as_deref().unwrap_or("*"), sample.unwrap_or(5000)).await?)
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PubSubMessage {
    pub sub_id: String,
    pub connection_id: String,
    pub channel: String,
    pub pattern: Option<String>,
    pub payload: String,
    pub at: i64,
}

/// Subscribe on a dedicated connection; messages arrive as `redis-pubsub`
/// events until `redis_unsubscribe` (or the session closes).
#[tauri::command]
pub async fn redis_subscribe(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    channels: Vec<String>,
    patterns: Vec<String>,
) -> CmdResult<String> {
    use futures_util::StreamExt;
    use tauri::Emitter;
    if channels.is_empty() && patterns.is_empty() {
        return Err(AppError::Unsupported("nothing to subscribe to".into()).into());
    }
    let r = state.session(&connection_id).await?.redis()?;
    let pubsub = r.pubsub(&channels, &patterns).await?;
    let sub_id = uuid::Uuid::new_v4().to_string();
    let key = format!("{connection_id}:{sub_id}");
    let (sid, cid) = (sub_id.clone(), connection_id.clone());
    let task = tokio::spawn(async move {
        let mut stream = pubsub.into_on_message();
        while let Some(msg) = stream.next().await {
            let payload: String = msg.get_payload().unwrap_or_default();
            let ev = PubSubMessage {
                sub_id: sid.clone(),
                connection_id: cid.clone(),
                channel: msg.get_channel_name().to_string(),
                pattern: msg.get_pattern::<String>().ok(),
                payload,
                at: now_ms(),
            };
            if app.emit("redis-pubsub", ev).is_err() {
                break;
            }
        }
    });
    state.pubsubs.write().await.insert(key, task);
    Ok(sub_id)
}

#[tauri::command]
pub async fn redis_unsubscribe(state: State<'_, AppState>, connection_id: String, sub_id: String) -> CmdResult<()> {
    if let Some(h) = state.pubsubs.write().await.remove(&format!("{connection_id}:{sub_id}")) {
        h.abort();
    }
    Ok(())
}

#[tauri::command]
pub async fn redis_publish(state: State<'_, AppState>, connection_id: String, channel: String, message: String) -> CmdResult<i64> {
    let r = state.session(&connection_id).await?.redis()?;
    Ok(r.publish(&channel, &message).await?)
}

#[tauri::command]
pub async fn redis_info(state: State<'_, AppState>, connection_id: String) -> CmdResult<serde_json::Value> {
    let r = state.session(&connection_id).await?.redis()?;
    Ok(r.info().await?)
}
