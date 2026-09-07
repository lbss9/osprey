//! Osprey — Tauri backend.
//!
//! Module map:
//! - `models`   — serde DTOs shared with the frontend
//! - `drivers`  — PostgreSQL / MySQL / Redis sessions behind one trait
//! - `store`    — local SQLite: connections, history, saved queries
//! - `secrets`  — passwords in the OS credential store
//! - `commands` — the `#[tauri::command]` adapters registered below
//! - `state`    — managed state handed to commands
//! - `error`    — the string-based error protocol the frontend translates

mod commands;
pub mod drivers;
pub mod error;
pub mod models;
mod secrets;
mod state;
pub mod store;

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::Manager;
use tokio::sync::RwLock;

use commands::*;
use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    drivers::init_crypto();

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("no app data dir");
            std::fs::create_dir_all(&dir).ok();
            let conn = store::open(&dir.join("osprey.db")).expect("failed to open database");
            let secrets_ok = secrets::available();
            if !secrets_ok {
                log::warn!("OS credential store unavailable; passwords fall back to the local database");
            }
            app.manage(AppState {
                db: Mutex::new(conn),
                sessions: RwLock::new(HashMap::new()),
                tunnels: RwLock::new(HashMap::new()),
                secrets_ok,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            connections_list,
            connection_save,
            connection_delete,
            connections_reorder,
            connection_test,
            secrets_available,
            session_open,
            session_close,
            session_list,
            session_info,
            schema_databases,
            schema_list,
            schema_tables,
            table_columns,
            table_structure,
            query_run,
            query_cancel,
            history_list,
            history_clear,
            saved_queries_list,
            saved_query_save,
            saved_query_delete,
            table_page,
            table_count,
            table_apply,
            redis_scan,
            redis_value,
            redis_mutate,
            redis_command,
            redis_info,
            export_rows,
            read_file_text,
            write_file_text,
            data_dir_path,
            open_data_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
