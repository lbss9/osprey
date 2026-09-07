//! User themes on disk (`<app data dir>/themes/*.json`): listing, saving and a
//! watcher that emits `themes-changed` so edits show up in the UI instantly.
//! A theme is plain JSON: `{ id, name, type: "dark"|"light", colors: {token: value} }`
//! and every key under `colors` becomes a `--token` CSS variable.

use std::path::PathBuf;
use std::sync::mpsc;

use notify::{RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, CmdResult};

pub fn themes_dir(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().expect("no app data dir").join("themes");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Every parseable `*.json` in the themes folder, with the file name injected
/// as `__file`. Broken files are skipped rather than failing the whole list.
pub fn list(app: &AppHandle) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(themes_dir(app)) else { return out };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        if let Some(obj) = value.as_object_mut() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                obj.insert("__file".into(), name.into());
            }
            out.push(value);
        }
    }
    out
}

/// Write a theme file; the name is squashed to one path segment.
pub fn save(app: &AppHandle, filename: &str, content: &str) -> std::io::Result<PathBuf> {
    let mut safe: String = filename.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' }).collect();
    if !safe.to_lowercase().ends_with(".json") {
        safe.push_str(".json");
    }
    let path = themes_dir(app).join(safe);
    std::fs::write(&path, content)?;
    Ok(path)
}

/// Watch the folder for the lifetime of the app.
pub fn start_watcher(app: AppHandle) {
    let dir = themes_dir(&app);
    std::thread::spawn(move || {
        let (tx, rx) = mpsc::channel();
        let Ok(mut watcher) = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        }) else {
            return;
        };
        if watcher.watch(&dir, RecursiveMode::NonRecursive).is_err() {
            return;
        }
        for res in rx {
            if res.is_ok() {
                let _ = app.emit("themes-changed", ());
            }
        }
    });
}

#[tauri::command]
pub fn themes_list(app: AppHandle) -> Vec<serde_json::Value> {
    list(&app)
}

#[tauri::command]
pub fn themes_dir_path(app: AppHandle) -> String {
    themes_dir(&app).to_string_lossy().into_owned()
}

#[tauri::command]
pub fn theme_save(app: AppHandle, filename: String, content: String) -> CmdResult<String> {
    save(&app, &filename, &content)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| AppError::Io(e.to_string()).into())
}

#[tauri::command]
pub fn open_themes_dir(app: AppHandle) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(themes_dir(&app).to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| AppError::Io(e.to_string()).into())
}
