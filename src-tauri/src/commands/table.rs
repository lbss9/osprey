use tauri::State;

use crate::error::{AppError, CmdResult};
use crate::models::{ApplyChangesRequest, ApplyChangesResult, ResultSet, TablePageRequest};
use crate::state::AppState;
use crate::store::connections as repo;

/// The SELECT the table view runs for this request (filters, sort, paging),
/// so the user can see, copy or reuse it.
#[tauri::command]
pub async fn table_sql(state: State<'_, AppState>, connection_id: String, req: TablePageRequest) -> CmdResult<String> {
    let s = state.session(&connection_id).await?.sql()?;
    Ok(s.dialect().select_page(&req)?)
}

/// One page of a table, with the grid's filters and sort applied server-side.
/// Column types come from the catalog so the grid can render/edit properly.
#[tauri::command]
pub async fn table_page(
    state: State<'_, AppState>,
    connection_id: String,
    req: TablePageRequest,
) -> CmdResult<ResultSet> {
    let s = state.session(&connection_id).await?.sql()?;
    let sql = s.dialect().select_page(&req)?;
    let mut sets = s.query(&sql, req.limit as usize).await?;
    let mut set = sets.pop().ok_or(AppError::Query("no result".into()))?;
    // enrich with catalog types (the simple protocol only knows names)
    if let Ok(cols) = s.columns(&req.schema, &req.table).await {
        for c in &mut set.columns {
            if let Some(meta) = cols.iter().find(|m| m.name == c.name) {
                c.data_type = meta.data_type.clone();
                c.kind = match s.kind() {
                    crate::models::DriverKind::Postgres => crate::drivers::value::pg_kind(&meta.data_type),
                    crate::models::DriverKind::Sqlite => crate::drivers::value::sqlite_kind(&meta.data_type),
                    crate::models::DriverKind::Clickhouse => crate::drivers::value::clickhouse_kind(&meta.data_type),
                    crate::models::DriverKind::Mssql => crate::drivers::value::mssql_kind_from_name(&meta.data_type),
                    _ => crate::drivers::value::mysql_kind_from_name(&meta.data_type),
                };
            }
        }
        // re-type the cells now that kinds are known (numbers/bools as JSON scalars)
        let kinds: Vec<_> = set.columns.iter().map(|c| c.kind).collect();
        for row in &mut set.rows {
            for (i, cell) in row.iter_mut().enumerate() {
                if let serde_json::Value::String(text) = cell {
                    let k = kinds.get(i).copied().unwrap_or(crate::models::ColumnKind::Other);
                    let retyped = crate::drivers::value::pg_text_to_json(Some(text), k);
                    if !retyped.is_string() {
                        *cell = retyped;
                    }
                }
            }
        }
    }
    set.statement = Some(sql);
    Ok(set)
}

#[tauri::command]
pub async fn table_count(
    state: State<'_, AppState>,
    connection_id: String,
    req: TablePageRequest,
) -> CmdResult<i64> {
    let s = state.session(&connection_id).await?.sql()?;
    let sql = s.dialect().select_count(&req)?;
    let sets = s.query(&sql, 1).await?;
    let n = sets
        .last()
        .and_then(|r| r.rows.first())
        .and_then(|row| row.first())
        .map(|v| match v {
            serde_json::Value::Number(n) => n.as_i64().unwrap_or(0),
            serde_json::Value::String(s) => s.parse().unwrap_or(0),
            _ => 0,
        })
        .unwrap_or(0);
    Ok(n)
}

/// Turn pending grid edits into SQL. With `preview` the statements are
/// returned unexecuted; otherwise they run in one transaction.
#[tauri::command]
pub async fn table_apply(
    state: State<'_, AppState>,
    connection_id: String,
    req: ApplyChangesRequest,
) -> CmdResult<ApplyChangesResult> {
    let s = state.session(&connection_id).await?.sql()?;
    let statements = s.dialect().changes(&req)?;
    if req.preview {
        return Ok(ApplyChangesResult { statements, affected: 0, executed: false });
    }
    let read_only = {
        let db = state.lock_db()?;
        repo::get(&db, &connection_id)?.map(|(c, _)| c.read_only).unwrap_or(false)
    };
    if read_only {
        return Err(AppError::ReadOnly.into());
    }
    let affected = s.execute_transaction(&statements).await?;
    Ok(ApplyChangesResult { statements, affected, executed: true })
}
