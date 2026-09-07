use tauri::State;

use crate::drivers;
use crate::error::{AppError, AppResult, CmdResult};
use crate::models::{ConnectionConfig, ConnectionInput, ServerInfo};
use crate::secrets;
use crate::state::AppState;
use crate::store::connections as repo;

/// Keychain entry for the SSH password / passphrase of a connection.
pub fn ssh_key(id: &str) -> String {
    format!("{id}:ssh")
}

/// SSH secret for a saved connection (keychain only).
pub fn resolve_ssh_secret(state: &AppState, id: &str) -> Option<String> {
    if !state.secrets_ok {
        return None;
    }
    secrets::get_password(&ssh_key(id)).ok().flatten()
}

/// Password for a saved connection: keychain first, SQLite fallback second.
pub fn resolve_password(state: &AppState, id: &str) -> AppResult<Option<String>> {
    if state.secrets_ok {
        if let Ok(Some(p)) = secrets::get_password(id) {
            return Ok(Some(p));
        }
    }
    let db = state.lock_db()?;
    Ok(repo::get(&db, id)?.and_then(|(_, fallback)| fallback))
}

fn with_password_flag(state: &AppState, mut c: ConnectionConfig) -> ConnectionConfig {
    if state.secrets_ok {
        if !c.has_password {
            c.has_password = matches!(secrets::get_password(&c.id), Ok(Some(_)));
        }
        c.has_ssh_password = matches!(secrets::get_password(&ssh_key(&c.id)), Ok(Some(_)));
    }
    c
}

#[tauri::command]
pub fn connections_list(state: State<'_, AppState>) -> CmdResult<Vec<ConnectionConfig>> {
    let list = {
        let db = state.lock_db()?;
        repo::list(&db)?
    };
    Ok(list.into_iter().map(|c| with_password_flag(&state, c)).collect())
}

#[tauri::command]
pub fn connection_save(state: State<'_, AppState>, input: ConnectionInput) -> CmdResult<ConnectionConfig> {
    let mut cfg = input.config;
    if cfg.id.is_empty() {
        cfg.id = uuid::Uuid::new_v4().to_string();
    }
    if cfg.name.trim().is_empty() {
        cfg.name = format!("{}@{}", cfg.user, cfg.host);
    }
    if cfg.port == 0 {
        cfg.port = cfg.driver.default_port();
    }
    {
        let db = state.lock_db()?;
        repo::upsert(&db, &cfg)?;
    }
    if let Some(pw) = input.password {
        if pw.is_empty() {
            if state.secrets_ok {
                let _ = secrets::delete_password(&cfg.id);
            }
            let db = state.lock_db()?;
            repo::set_fallback_password(&db, &cfg.id, None)?;
        } else if state.secrets_ok && secrets::set_password(&cfg.id, &pw).is_ok() {
            // stored in the keychain; make sure no stale fallback remains
            let db = state.lock_db()?;
            repo::set_fallback_password(&db, &cfg.id, None)?;
        } else {
            let db = state.lock_db()?;
            repo::set_fallback_password(&db, &cfg.id, Some(&pw))?;
        }
    }
    if let Some(pw) = input.ssh_password {
        if state.secrets_ok {
            if pw.is_empty() {
                let _ = secrets::delete_password(&ssh_key(&cfg.id));
            } else {
                secrets::set_password(&ssh_key(&cfg.id), &pw)?;
            }
        }
    }
    let saved = {
        let db = state.lock_db()?;
        repo::get(&db, &cfg.id)?.map(|(c, _)| c).ok_or(AppError::Storage("not saved".into()))?
    };
    Ok(with_password_flag(&state, saved))
}

#[tauri::command]
pub async fn connection_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.remove_session(&id).await;
    if state.secrets_ok {
        let _ = secrets::delete_password(&id);
        let _ = secrets::delete_password(&ssh_key(&id));
    }
    let db = state.lock_db()?;
    repo::delete(&db, &id)?;
    Ok(())
}

#[tauri::command]
pub fn connections_reorder(state: State<'_, AppState>, ids: Vec<String>) -> CmdResult<()> {
    let db = state.lock_db()?;
    repo::reorder(&db, &ids)?;
    Ok(())
}

/// Connect once with the dialog's values (without saving) and report the
/// server version. Falls back to the stored password when the dialog left
/// the field untouched.
#[tauri::command]
pub async fn connection_test(state: State<'_, AppState>, input: ConnectionInput) -> CmdResult<ServerInfo> {
    let cfg = input.config;
    let password = match input.password {
        Some(p) => Some(p),
        None if !cfg.id.is_empty() => resolve_password(&state, &cfg.id)?,
        None => None,
    };
    let ssh_secret = match input.ssh_password {
        Some(p) => Some(p),
        None if !cfg.id.is_empty() => resolve_ssh_secret(&state, &cfg.id),
        None => None,
    };
    let (session, tunnel) = drivers::connect(&cfg, password.as_deref(), ssh_secret.as_deref(), None).await?;
    let info = match &session {
        drivers::Session::Sql(d) => d.server_info().await,
        drivers::Session::Redis(r) => r.server_info().await,
    };
    session.close().await;
    if let Some(t) = tunnel {
        t.close().await;
    }
    Ok(info?)
}

#[tauri::command]
pub fn secrets_available(state: State<'_, AppState>) -> bool {
    state.secrets_ok
}
