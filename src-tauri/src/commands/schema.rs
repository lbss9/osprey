use tauri::State;

use crate::drivers::Session;
use crate::error::CmdResult;
use crate::models::{ColumnInfo, TableInfo, TableStructure};
use crate::state::AppState;

#[tauri::command]
pub async fn schema_databases(state: State<'_, AppState>, connection_id: String) -> CmdResult<Vec<String>> {
    let s = state.session(&connection_id).await?;
    Ok(match &s {
        Session::Sql(d) => d.list_databases().await?,
        Session::Redis(r) => r.databases().await?,
    })
}

#[tauri::command]
pub async fn schema_list(state: State<'_, AppState>, connection_id: String) -> CmdResult<Vec<String>> {
    let s = state.session(&connection_id).await?.sql()?;
    Ok(s.list_schemas().await?)
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
pub async fn table_columns(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
) -> CmdResult<Vec<ColumnInfo>> {
    let s = state.session(&connection_id).await?.sql()?;
    Ok(s.columns(&schema, &table).await?)
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
