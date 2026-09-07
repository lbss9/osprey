use std::io::Write;

use serde::Deserialize;
use tauri::State;

use crate::error::{AppError, CmdResult};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub path: String,
    /// csv | json | sql
    pub format: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    /// for `sql`: target table name, already qualified/quoted by the caller
    #[serde(default)]
    pub table: Option<String>,
    #[serde(default)]
    pub delimiter: Option<String>,
}

fn cell_text(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn csv_escape(s: &str, delim: char) -> String {
    if s.contains(delim) || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Write a result set to disk. Rows arrive from the grid as displayed.
#[tauri::command]
pub fn export_rows(req: ExportRequest) -> CmdResult<u64> {
    let file = std::fs::File::create(&req.path).map_err(|e| AppError::Io(e.to_string()))?;
    let mut w = std::io::BufWriter::new(file);
    let io = |e: std::io::Error| AppError::Io(e.to_string());
    match req.format.as_str() {
        "csv" => {
            let delim = req.delimiter.as_deref().and_then(|d| d.chars().next()).unwrap_or(',');
            let head: Vec<String> = req.columns.iter().map(|c| csv_escape(c, delim)).collect();
            writeln!(w, "{}", head.join(&delim.to_string())).map_err(io)?;
            for row in &req.rows {
                let line: Vec<String> = row.iter().map(|v| csv_escape(&cell_text(v), delim)).collect();
                writeln!(w, "{}", line.join(&delim.to_string())).map_err(io)?;
            }
        }
        "json" => {
            let objects: Vec<serde_json::Value> = req
                .rows
                .iter()
                .map(|row| {
                    let mut m = serde_json::Map::new();
                    for (i, c) in req.columns.iter().enumerate() {
                        m.insert(c.clone(), row.get(i).cloned().unwrap_or(serde_json::Value::Null));
                    }
                    serde_json::Value::Object(m)
                })
                .collect();
            serde_json::to_writer_pretty(&mut w, &objects).map_err(|e| AppError::Io(e.to_string()))?;
            writeln!(w).map_err(io)?;
        }
        "sql" => {
            let table = req.table.clone().unwrap_or_else(|| "table_name".into());
            let cols = req
                .columns
                .iter()
                .map(|c| format!("\"{}\"", c.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(", ");
            for row in &req.rows {
                let vals = row
                    .iter()
                    .map(|v| match v {
                        serde_json::Value::Null => "NULL".to_string(),
                        serde_json::Value::Bool(b) => if *b { "TRUE".into() } else { "FALSE".into() },
                        serde_json::Value::Number(n) => n.to_string(),
                        other => format!("'{}'", cell_text(other).replace('\'', "''")),
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                writeln!(w, "INSERT INTO {table} ({cols}) VALUES ({vals});").map_err(io)?;
            }
        }
        other => return Err(AppError::Unsupported(format!("export format {other}")).into()),
    }
    w.flush().map_err(io)?;
    Ok(req.rows.len() as u64)
}

#[tauri::command]
pub fn read_file_text(path: String) -> CmdResult<String> {
    std::fs::read_to_string(&path).map_err(|e| AppError::Io(e.to_string()).into())
}

#[tauri::command]
pub fn write_file_text(path: String, content: String) -> CmdResult<()> {
    std::fs::write(&path, content).map_err(|e| AppError::Io(e.to_string()).into())
}

#[tauri::command]
pub fn data_dir_path(app: tauri::AppHandle, _state: State<'_, AppState>) -> CmdResult<String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| AppError::Io(e.to_string()))?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn open_data_dir(app: tauri::AppHandle) -> CmdResult<()> {
    use tauri::Manager;
    use tauri_plugin_opener::OpenerExt;
    let dir = app.path().app_data_dir().map_err(|e| AppError::Io(e.to_string()))?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| AppError::Io(e.to_string()).into())
}
