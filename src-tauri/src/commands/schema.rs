use tauri::State;

use crate::drivers::Session;
use crate::error::CmdResult;
use crate::models::{ColumnInfo, DdlOp, RoutineInfo, TableColumns, TableInfo, TableStructure};
use crate::store::connections as repo;
use crate::error::AppError;
use crate::state::AppState;

/// `include_system` lists template databases / catalog schemas too (a user
/// preference; off by default).
#[tauri::command]
pub async fn schema_databases(
    state: State<'_, AppState>,
    connection_id: String,
    include_system: Option<bool>,
) -> CmdResult<Vec<String>> {
    let s = state.session(&connection_id).await?;
    Ok(match &s {
        Session::Sql(d) => d.list_databases(include_system.unwrap_or(false)).await?,
        Session::Redis(r) => r.databases().await?,
    })
}

#[tauri::command]
pub async fn schema_list(
    state: State<'_, AppState>,
    connection_id: String,
    include_system: Option<bool>,
) -> CmdResult<Vec<String>> {
    let s = state.session(&connection_id).await?.sql()?;
    Ok(s.list_schemas(include_system.unwrap_or(false)).await?)
}

#[tauri::command]
pub async fn schema_tables(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
) -> CmdResult<Vec<TableInfo>> {
    let s = state.session(&connection_id).await?.sql()?;
    Ok(s.list_tables(&schema).await?)
}

#[tauri::command]
pub async fn schema_routines(state: State<'_, AppState>, connection_id: String, schema: String) -> CmdResult<Vec<RoutineInfo>> {
    let s = state.session(&connection_id).await?.sql()?;
    Ok(s.list_routines(&schema).await?)
}

#[tauri::command]
pub async fn routine_definition(state: State<'_, AppState>, connection_id: String, schema: String, name: String, args: String) -> CmdResult<String> {
    let s = state.session(&connection_id).await?.sql()?;
    Ok(s.routine_definition(&schema, &name, &args).await?)
}

#[tauri::command]
pub async fn schema_columns(state: State<'_, AppState>, connection_id: String, schema: String) -> CmdResult<Vec<TableColumns>> {
    let s = state.session(&connection_id).await?.sql()?;
    Ok(s.schema_columns(&schema).await?)
}

#[tauri::command]
pub async fn table_columns(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
) -> CmdResult<Vec<ColumnInfo>> {
    let s = state.session(&connection_id).await?.sql()?;
    Ok(s.columns(&schema, &table).await?)
}

/// Statements a structure edit would run, without running them.
#[tauri::command]
pub async fn ddl_preview(state: State<'_, AppState>, connection_id: String, op: DdlOp) -> CmdResult<Vec<String>> {
    let s = state.session(&connection_id).await?.sql()?;
    Ok(s.dialect().ddl(&op)?)
}

/// Run a structure edit (one transaction where the engine supports it).
#[tauri::command]
pub async fn ddl_apply(state: State<'_, AppState>, connection_id: String, op: DdlOp) -> CmdResult<Vec<String>> {
    let read_only = {
        let db = state.lock_db()?;
        repo::get(&db, &connection_id)?.map(|(c, _)| c.read_only).unwrap_or(false)
    };
    if read_only {
        return Err(AppError::ReadOnly.into());
    }
    let s = state.session(&connection_id).await?.sql()?;
    let statements = s.dialect().ddl(&op)?;
    s.execute_transaction(&statements).await?;
    Ok(statements)
}

#[tauri::command]
pub async fn table_structure(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
) -> CmdResult<TableStructure> {
    let s = state.session(&connection_id).await?.sql()?;
    Ok(s.structure(&schema, &table).await?)
}
