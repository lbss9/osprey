/**
 * Typed wrappers around every Tauri command. The Rust side speaks camelCase
 * JSON; argument names here must match the command signatures.
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  AppInfo,
  ApplyChangesRequest,
  ApplyChangesResult,
  ColumnInfo,
  ConnectionConfig,
  ConnectionInput,
  CsvImportRequest,
  CsvImportResult,
  CsvPreview,
  DdlOp,
  ExplainResult,
  HistoryEntry,
  MemoryReport,
  RedisCommandResult,
  RedisMutation,
  RedisScanRequest,
  RedisScanResult,
  RedisValue,
  RedisValueRequest,
  ResultSet,
  SavedQuery,
  ServerInfo,
  SlowlogEntry,
  TableInfo,
  TablePageRequest,
  TableStructure,
} from "@/types";

export const appInfo = () => invoke<AppInfo>("app_info");

/* ------------------------------- connections ------------------------------ */

export const connectionsList = () => invoke<ConnectionConfig[]>("connections_list");
export const connectionSave = (input: ConnectionInput) =>
  invoke<ConnectionConfig>("connection_save", { input });
export const connectionDelete = (id: string) => invoke<void>("connection_delete", { id });
export const connectionsReorder = (ids: string[]) => invoke<void>("connections_reorder", { ids });
export const connectionTest = (input: ConnectionInput) =>
  invoke<ServerInfo>("connection_test", { input });
export const secretsAvailable = () => invoke<boolean>("secrets_available");

/* --------------------------------- sessions ------------------------------- */

export const sessionOpen = (connectionId: string, database?: string) =>
  invoke<ServerInfo>("session_open", { connectionId, database: database ?? null });
export const sessionClose = (connectionId: string) =>
  invoke<void>("session_close", { connectionId });
export const sessionList = () => invoke<string[]>("session_list");
export const sessionInfo = (connectionId: string) =>
  invoke<ServerInfo>("session_info", { connectionId });

/* ---------------------------------- schema -------------------------------- */

export const schemaDatabases = (connectionId: string, includeSystem = false) =>
  invoke<string[]>("schema_databases", { connectionId, includeSystem });
export const schemaList = (connectionId: string, includeSystem = false) =>
  invoke<string[]>("schema_list", { connectionId, includeSystem });
export const schemaTables = (connectionId: string, schema: string) =>
  invoke<TableInfo[]>("schema_tables", { connectionId, schema });
export const tableColumns = (connectionId: string, schema: string, table: string) =>
  invoke<ColumnInfo[]>("table_columns", { connectionId, schema, table });
export const tableStructure = (connectionId: string, schema: string, table: string) =>
  invoke<TableStructure>("table_structure", { connectionId, schema, table });
export const ddlPreview = (connectionId: string, op: DdlOp) => invoke<string[]>("ddl_preview", { connectionId, op });
export const ddlApply = (connectionId: string, op: DdlOp) => invoke<string[]>("ddl_apply", { connectionId, op });

/* ---------------------------------- query --------------------------------- */

export const queryRun = (connectionId: string, sql: string, maxRows?: number) =>
  invoke<ResultSet[]>("query_run", { connectionId, sql, maxRows: maxRows ?? null });
export const queryCancel = (connectionId: string) => invoke<void>("query_cancel", { connectionId });
export const queryExplain = (connectionId: string, sql: string, analyze = false) =>
  invoke<ExplainResult>("query_explain", { connectionId, sql, analyze });
export const historyList = (connectionId?: string, limit?: number) =>
  invoke<HistoryEntry[]>("history_list", { connectionId: connectionId ?? null, limit: limit ?? null });
export const historyClear = (connectionId?: string) =>
  invoke<void>("history_clear", { connectionId: connectionId ?? null });
export const savedQueriesList = () => invoke<SavedQuery[]>("saved_queries_list");
export const savedQuerySave = (query: SavedQuery) => invoke<SavedQuery>("saved_query_save", { query });
export const savedQueryDelete = (id: string) => invoke<void>("saved_query_delete", { id });

/* ---------------------------------- table --------------------------------- */

export const tablePage = (connectionId: string, req: TablePageRequest) =>
  invoke<ResultSet>("table_page", { connectionId, req });
export const tableCount = (connectionId: string, req: TablePageRequest) =>
  invoke<number>("table_count", { connectionId, req });
export const tableApply = (connectionId: string, req: ApplyChangesRequest) =>
  invoke<ApplyChangesResult>("table_apply", { connectionId, req });

/* ---------------------------------- redis --------------------------------- */

export const redisScan = (connectionId: string, req: RedisScanRequest) =>
  invoke<RedisScanResult>("redis_scan", { connectionId, req });
export const redisValue = (connectionId: string, req: RedisValueRequest) =>
  invoke<RedisValue>("redis_value", { connectionId, req });
export const redisMutate = (connectionId: string, mutation: RedisMutation) =>
  invoke<void>("redis_mutate", { connectionId, mutation });
export const redisCommand = (connectionId: string, line: string) =>
  invoke<RedisCommandResult>("redis_command", { connectionId, line });
export const redisInfo = (connectionId: string) =>
  invoke<Record<string, Record<string, string>>>("redis_info", { connectionId });
export const redisSlowlog = (connectionId: string, count = 128) => invoke<SlowlogEntry[]>("redis_slowlog", { connectionId, count });
export const redisMemory = (connectionId: string, pattern = "*", sample = 5000) =>
  invoke<MemoryReport>("redis_memory", { connectionId, pattern, sample });
export const redisSubscribe = (connectionId: string, channels: string[], patterns: string[]) =>
  invoke<string>("redis_subscribe", { connectionId, channels, patterns });
export const redisUnsubscribe = (connectionId: string, subId: string) => invoke<void>("redis_unsubscribe", { connectionId, subId });
export const redisPublish = (connectionId: string, channel: string, message: string) =>
  invoke<number>("redis_publish", { connectionId, channel, message });

/* ---------------------------------- files --------------------------------- */

export interface ExportRequest {
  path: string;
  format: "csv" | "json" | "sql";
  columns: string[];
  rows: unknown[][];
  table?: string;
  delimiter?: string;
}
export const exportRows = (req: ExportRequest) => invoke<number>("export_rows", { req });
export const csvPreview = (path: string, delimiter?: string, hasHeader?: boolean) =>
  invoke<CsvPreview>("csv_preview", { path, delimiter: delimiter ?? null, hasHeader: hasHeader ?? null });
export const csvImport = (connectionId: string, req: CsvImportRequest) => invoke<CsvImportResult>("csv_import", { connectionId, req });
export const readFileText = (path: string) => invoke<string>("read_file_text", { path });
export const writeFileText = (path: string, content: string) =>
  invoke<void>("write_file_text", { path, content });
export const dataDirPath = () => invoke<string>("data_dir_path");
export const openDataDir = () => invoke<void>("open_data_dir");
export const themesList = () => invoke<unknown[]>("themes_list");
export const themesDirPath = () => invoke<string>("themes_dir_path");
export const themeSave = (filename: string, content: string) => invoke<string>("theme_save", { filename, content });
export const openThemesDir = () => invoke<void>("open_themes_dir");
