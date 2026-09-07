use tauri::State;

use super::connections::resolve_password;
use crate::drivers::{self, Session};
use crate::error::{AppError, CmdResult};
use crate::models::ServerInfo;
use crate::state::AppState;
use crate::store::connections as repo;

/// Open (or replace) the session for a saved connection. `database`
/// switches to another database on the same server.
#[tauri::command]
pub async fn session_open(
    state: State<'_, AppState>,
    connection_id: String,
    database: Option<String>,
) -> CmdResult<ServerInfo> {
    let cfg = {
        let db = state.lock_db()?;
        repo::get(&db, &connection_id)?
            .map(|(c, _)| c)
            .ok_or(AppError::Storage("connection not found".into()))?
    };
    let password = resolve_password(&state, &connection_id)?;
    let session = drivers::connect(&cfg, password.as_deref(), database.as_deref()).await?;
    let info = match &session {
        Session::Sql(d) => d.server_info().await?,
        Session::Redis(r) => r.server_info().await?,
    };
    if let Some(old) = state.sessions.write().await.insert(connection_id.clone(), session) {
        old.close().await;
    }
    {
        let db = state.lock_db()?;
        let _ = repo::touch(&db, &connection_id);
    }
    Ok(info)
}

#[tauri::command]
pub async fn session_close(state: State<'_, AppState>, connection_id: String) -> CmdResult<()> {
    if let Some(s) = state.sessions.write().await.remove(&connection_id) {
        s.close().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn session_list(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    Ok(state.sessions.read().await.keys().cloned().collect())
}

#[tauri::command]
pub async fn session_info(state: State<'_, AppState>, connection_id: String) -> CmdResult<ServerInfo> {
    let s = state.session(&connection_id).await?;
    Ok(match &s {
        Session::Sql(d) => d.server_info().await?,
        Session::Redis(r) => r.server_info().await?,
    })
}
