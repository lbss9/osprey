//! CSV import: preview a file, then stream it into a table as batched
//! multi-row INSERTs inside the driver's transaction.

use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, CmdResult};
use crate::models::DdlColumn;
use crate::state::AppState;
use crate::store::connections as repo;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPreview {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub delimiter: String,
    pub has_header: bool,
    /// data rows in the file (header excluded), counted up to a cap
    pub total_rows: u64,
    pub truncated_count: bool,
}

fn detect_delimiter(line: &str) -> u8 {
    let candidates = [b',', b';', b'\t', b'|'];
    candidates
        .iter()
        .copied()
        .max_by_key(|d| line.as_bytes().iter().filter(|b| *b == d).count())
        .filter(|d| line.as_bytes().contains(d))
        .unwrap_or(b',')
}

fn reader(path: &str, delimiter: u8, has_header: bool) -> Result<csv::Reader<std::fs::File>, AppError> {
    let file = std::fs::File::open(path).map_err(|e| AppError::Io(format!("{path}: {e}")))?;
    Ok(csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(has_header)
        .flexible(true)
        .trim(csv::Trim::None)
        .from_reader(file))
}

/// First rows of a CSV with delimiter/header detection.
#[tauri::command]
pub async fn csv_preview(path: String, delimiter: Option<String>, has_header: Option<bool>) -> CmdResult<CsvPreview> {
    tokio::task::spawn_blocking(move || -> Result<CsvPreview, AppError> {
        let head = {
            use std::io::{BufRead, BufReader};
            let f = std::fs::File::open(&path).map_err(|e| AppError::Io(format!("{path}: {e}")))?;
            let mut first = String::new();
            BufReader::new(f).read_line(&mut first).map_err(|e| AppError::Io(e.to_string()))?;
            first
        };
        let delim = delimiter.as_deref().and_then(|d| d.bytes().next()).unwrap_or_else(|| detect_delimiter(&head));
        // header heuristic: no cell of the first line parses as a number
        let has_header = has_header.unwrap_or_else(|| {
            let mut r = csv::ReaderBuilder::new().delimiter(delim).has_headers(false).from_reader(head.as_bytes());
            r.records()
                .next()
                .and_then(|x| x.ok())
                .map(|rec| rec.iter().all(|c| c.trim().parse::<f64>().is_err()))
                .unwrap_or(true)
        });
        let mut rdr = reader(&path, delim, has_header)?;
        let columns: Vec<String> = if has_header {
            rdr.headers().map_err(|e| AppError::Io(e.to_string()))?.iter().map(|h| h.trim().to_string()).collect()
        } else {
            vec![]
        };
        let mut rows = Vec::new();
        let mut total = 0u64;
        let mut truncated = false;
        let mut width = columns.len();
        for rec in rdr.records() {
            let rec = rec.map_err(|e| AppError::Io(e.to_string()))?;
            total += 1;
            if rows.len() < 50 {
                width = width.max(rec.len());
                rows.push(rec.iter().map(|c| c.to_string()).collect());
            }
            if total >= 2_000_000 {
                truncated = true;
                break;
            }
        }
        let columns = if columns.is_empty() { (1..=width).map(|i| format!("column{i}")).collect() } else { columns };
        Ok(CsvPreview { columns, rows, delimiter: (delim as char).to_string(), has_header, total_rows: total, truncated_count: truncated })
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
    .map_err(Into::into)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvMapping {
    pub csv_index: usize,
    pub column: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvImportRequest {
    pub schema: String,
    pub table: String,
    pub path: String,
    pub delimiter: String,
    pub has_header: bool,
    pub mapping: Vec<CsvMapping>,
    #[serde(default)]
    pub empty_as_null: bool,
    #[serde(default)]
    pub batch_size: usize,
    /// create the table first, every mapped column as text
    #[serde(default)]
    pub create_table: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvImportResult {
    pub inserted: u64,
    pub statements: usize,
    pub elapsed_ms: u64,
}

/// Import a CSV into a table. Rows are grouped into multi-row INSERTs and
/// everything runs in one transaction, so a bad row aborts the whole import.
#[tauri::command]
pub async fn csv_import(state: State<'_, AppState>, connection_id: String, req: CsvImportRequest) -> CmdResult<CsvImportResult> {
    let read_only = {
        let db = state.lock_db()?;
        repo::get(&db, &connection_id)?.map(|(c, _)| c.read_only).unwrap_or(false)
    };
    if read_only {
        return Err(AppError::ReadOnly.into());
    }
    if req.mapping.is_empty() {
        return Err(AppError::Unsupported("no columns mapped".into()).into());
    }
    let s = state.session(&connection_id).await?.sql()?;
    let dialect = s.dialect();
    let started = Instant::now();
    let batch = if req.batch_size == 0 { 500 } else { req.batch_size.clamp(1, 5000) };
    let target = dialect.qualified(&req.schema, &req.table);
    let cols = req.mapping.iter().map(|m| dialect.quote_ident(&m.column)).collect::<Vec<_>>().join(", ");
    let delim = req.delimiter.bytes().next().unwrap_or(b',');

    let mut statements: Vec<String> = Vec::new();
    if req.create_table {
        let columns: Vec<DdlColumn> = req
            .mapping
            .iter()
            .map(|m| DdlColumn { name: m.column.clone(), data_type: if dialect == crate::drivers::sql::Dialect::Postgres { "text".into() } else { "TEXT".into() }, nullable: true, default: None, primary_key: false, auto_increment: false })
            .collect();
        statements.extend(dialect.ddl(&crate::models::DdlOp::CreateTable { schema: req.schema.clone(), table: req.table.clone(), columns })?);
    }
    let mapping = req.mapping.iter().map(|m| m.csv_index).collect::<Vec<_>>();
    let empty_as_null = req.empty_as_null;
    let path = req.path.clone();
    let has_header = req.has_header;
    let (rows_total, mut inserts) = tokio::task::spawn_blocking(move || -> Result<(u64, Vec<String>), AppError> {
        let mut rdr = reader(&path, delim, has_header)?;
        let mut out = Vec::new();
        let mut values: Vec<String> = Vec::with_capacity(batch);
        let mut total = 0u64;
        for rec in rdr.records() {
            let rec = rec.map_err(|e| AppError::Io(e.to_string()))?;
            let tuple = mapping
                .iter()
                .map(|i| {
                    let cell = rec.get(*i).unwrap_or("");
                    if empty_as_null && cell.is_empty() {
                        "NULL".to_string()
                    } else {
                        dialect.quote_literal(cell)
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            values.push(format!("({tuple})"));
            total += 1;
            if values.len() >= batch {
                out.push(format!("INSERT INTO {target} ({cols}) VALUES {}", values.join(", ")));
                values.clear();
            }
        }
        if !values.is_empty() {
            out.push(format!("INSERT INTO {target} ({cols}) VALUES {}", values.join(", ")));
        }
        Ok((total, out))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    statements.append(&mut inserts);
    let count = statements.len();
    s.execute_transaction(&statements).await?;
    Ok(CsvImportResult { inserted: rows_total, statements: count, elapsed_ms: started.elapsed().as_millis() as u64 })
}

#[cfg(test)]
mod tests {
    use super::detect_delimiter;

    #[test]
    fn detects_the_most_frequent_delimiter() {
        assert_eq!(detect_delimiter("a,b,c"), b',');
        assert_eq!(detect_delimiter("a;b;c,d"), b';');
        assert_eq!(detect_delimiter("a\tb\tc"), b'\t');
        assert_eq!(detect_delimiter("a|b"), b'|');
        assert_eq!(detect_delimiter("single"), b',');
    }
}
