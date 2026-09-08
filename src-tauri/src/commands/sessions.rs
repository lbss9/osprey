use tauri::State;

use super::connections::{resolve_password, resolve_ssh_secret};
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
    let ssh_secret = resolve_ssh_secret(&state, &connection_id);
    let (session, tunnel) = drivers::connect(&cfg, password.as_deref(), ssh_secret.as_deref(), database.as_deref()).await?;
    let info = match &session {
        Session::Sql(d) => d.server_info().await?,
        Session::Redis(r) => r.server_info().await?,
    };
    state.remove_session(&connection_id).await;
    state.sessions.write().await.insert(connection_id.clone(), session);
    if let Some(t) = tunnel {
        state.tunnels.write().await.insert(connection_id.clone(), t);
    }
    {
        let db = state.lock_db()?;
        let _ = repo::touch(&db, &connection_id);
    }
    Ok(info)
}

/// A second session on the same connection for another database, kept under
/// the key `<connection_id>@<database>` so every command can address it. The
/// tree uses this to expand several databases at once (PostgreSQL, SQL Server).
#[tauri::command]
pub async fn session_open_database(state: State<'_, AppState>, connection_id: String, database: String) -> CmdResult<ServerInfo> {
    let cfg = {
        let db = state.lock_db()?;
        repo::get(&db, &connection_id)?
            .map(|(c, _)| c)
            .ok_or(AppError::Storage("connection not found".into()))?
    };
    let password = resolve_password(&state, &connection_id)?;
    let ssh_secret = resolve_ssh_secret(&state, &connection_id);
    let (session, tunnel) = drivers::connect(&cfg, password.as_deref(), ssh_secret.as_deref(), Some(&database)).await?;
    let info = match &session {
        Session::Sql(d) => d.server_info().await?,
        Session::Redis(r) => r.server_info().await?,
    };
    let key = format!("{connection_id}@{database}");
    state.remove_session(&key).await;
    state.sessions.write().await.insert(key.clone(), session);
    if let Some(t) = tunnel {
        state.tunnels.write().await.insert(key, t);
    }
    Ok(info)
}

#[tauri::command]
pub async fn session_close(state: State<'_, AppState>, connection_id: String) -> CmdResult<()> {
    state.remove_session(&connection_id).await;
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
