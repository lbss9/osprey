//! Application state managed by Tauri and injected into commands.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;
use tokio::sync::RwLock;

use crate::drivers::Session;
use crate::error::{AppError, AppResult};

pub struct AppState {
    /// local SQLite (connections, history, saved queries)
    pub db: Mutex<Connection>,
    /// live sessions keyed by connection id
    pub sessions: RwLock<HashMap<String, Session>>,
    /// whether the OS credential store answered at startup
    pub secrets_ok: bool,
}

impl AppState {
    pub fn lock_db(&self) -> AppResult<MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|e| AppError::Storage(format!("db lock poisoned: {e}")))
    }

    pub async fn session(&self, id: &str) -> AppResult<Session> {
        self.sessions
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or(AppError::NotConnected)
    }
}
