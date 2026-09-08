//! Application state managed by Tauri and injected into commands.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;
use tokio::sync::RwLock;

use std::sync::Arc;

use crate::drivers::ssh::SshTunnel;
use crate::drivers::Session;
use crate::error::{AppError, AppResult};

pub struct AppState {
    /// local SQLite (connections, history, saved queries)
    pub db: Mutex<Connection>,
    /// live sessions keyed by connection id
    pub sessions: RwLock<HashMap<String, Session>>,
    /// SSH tunnels backing sessions, keyed the same way
    pub tunnels: RwLock<HashMap<String, Arc<SshTunnel>>>,
    /// live pub/sub listeners keyed `<connection_id>:<sub_id>`
    pub pubsubs: RwLock<HashMap<String, tokio::task::JoinHandle<()>>>,
    /// whether the OS credential store answered at startup
    pub secrets_ok: bool,
}

impl AppState {
    pub fn lock_db(&self) -> AppResult<MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|e| AppError::Storage(format!("db lock poisoned: {e}")))
    }

    /// Drop a session and its tunnel (if any).
    pub async fn remove_session(&self, id: &str) {
        // the session itself plus every per-database session opened under it
        let db_prefix = format!("{id}@");
        let keys: Vec<String> = {
            let sessions = self.sessions.read().await;
            sessions.keys().filter(|k| *k == id || k.starts_with(&db_prefix)).cloned().collect()
        };
        for k in keys {
            if let Some(s) = self.sessions.write().await.remove(&k) {
                s.close().await;
            }
            if let Some(t) = self.tunnels.write().await.remove(&k) {
                t.close().await;
            }
        }
        let prefix = format!("{id}:");
        let mut subs = self.pubsubs.write().await;
        let keys: Vec<String> = subs.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
        for k in keys {
            if let Some(h) = subs.remove(&k) {
                h.abort();
            }
        }
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
