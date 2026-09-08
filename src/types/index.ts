/**
 * TypeScript mirror of `src-tauri/src/models.rs`. Keep the two in sync: the
 * Rust side serializes everything as camelCase.
 */

export type DriverKind = "postgres" | "mysql" | "redis" | "sqlite" | "clickhouse" | "mssql";
export type SslMode = "disable" | "prefer" | "require" | "verify";

export interface ConnectionConfig {
  id: string;
  name: string;
  driver: DriverKind;
  host: string;
  port: number;
  user: string;
  database: string;
  sslMode: SslMode;
  color?: string | null;
  group?: string | null;
  readOnly: boolean;
  options: Record<string, unknown>;
  position: number;
  createdAt: number;
  lastUsedAt?: number | null;
  hasPassword: boolean;
  hasSshPassword: boolean;
}

/** `options.ssh` on a connection. */
export interface SshOptions {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  auth: "password" | "key";
  keyPath?: string;
}

export interface ConnectionInput extends ConnectionConfig {
  /** undefined keeps the stored password; "" clears it */
  password?: string;
  /** SSH password or key passphrase; same semantics */
  sshPassword?: string;
}

export interface ServerInfo {
  driver: DriverKind;
  version: string;
  database?: string | null;
  user?: string | null;
  extra: Record<string, unknown>;
}

export interface TableInfo {
  schema: string;
  name: string;
  kind: "table" | "view" | "materialized" | "foreign" | "partitioned";
  rowEstimate?: number | null;
  comment?: string | null;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  default?: string | null;
  autoIncrement: boolean;
  comment?: string | null;
  position: number;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  definition?: string | null;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onUpdate?: string | null;
  onDelete?: string | null;
}

export interface RoutineInfo {
  schema: string;
  name: string;
  kind: "function" | "procedure" | string;
  args: string;
  returns?: string | null;
  language?: string | null;
}

export interface TableColumns {
  table: string;
  columns: ColumnInfo[];
}

export interface TableStructure {
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  ddl?: string | null;
}

export type ColumnKind = "number" | "string" | "bool" | "date" | "json" | "bytes" | "other";

export interface ResultColumn {
  name: string;
  dataType: string;
  kind: ColumnKind;
}

export type Cell = null | string | number | boolean;

export interface ResultSet {
  columns: ResultColumn[];
  rows: Cell[][];
  rowCount: number;
  affected?: number | null;
  truncated: boolean;
  elapsedMs: number;
  statement?: string | null;
  /** rows arrived through `query-rows` events; `rows` is empty in the reply */
  streamed?: boolean;
}

export interface QueryRowsEvent {
  streamId: string;
  connectionId: string;
  set: number;
  columns?: ResultColumn[] | null;
  rows: Cell[][];
}

export type FilterOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "starts"
  | "ends"
  | "isnull"
  | "notnull"
  | "in";

export interface TableFilter {
  column: string;
  op: FilterOp;
  value?: string;
}

export interface SortSpec {
  column: string;
  desc: boolean;
}

export interface TablePageRequest {
  schema: string;
  table: string;
  filters: TableFilter[];
  rawWhere?: string;
  sort?: SortSpec;
  limit: number;
  offset: number;
}

/** `{ $default: true }` asks the server for the column default. */
export type EditValue = Cell | { $default: true };

export type RowChange =
  | { kind: "update"; key: Record<string, Cell>; set: Record<string, EditValue> }
  | { kind: "insert"; values: Record<string, EditValue> }
  | { kind: "delete"; key: Record<string, Cell> };

export interface ApplyChangesRequest {
  schema: string;
  table: string;
  changes: RowChange[];
  preview: boolean;
}

export interface ApplyChangesResult {
  statements: string[];
  affected: number;
  executed: boolean;
}

/* ---------------------------------- redis --------------------------------- */

export interface RedisKeyInfo {
  key: string;
  kind: string;
  ttl: number;
  size?: number | null;
}

export interface RedisScanRequest {
  cursor: number;
  pattern: string;
  count: number;
  typeFilter?: string;
}

export interface RedisScanResult {
  cursor: number;
  keys: RedisKeyInfo[];
  done: boolean;
}

export interface RedisEntry {
  field?: string | null;
  value: string;
  score?: number | null;
}

export interface RedisValue {
  key: string;
  kind: string;
  ttl: number;
  total: number;
  entries: RedisEntry[];
  cursor: number;
  truncated: boolean;
}

export interface RedisValueRequest {
  key: string;
  cursor?: number;
  pattern?: string;
  count?: number;
  start?: number;
}

export type RedisMutation =
  | { kind: "setString"; key: string; value: string }
  | { kind: "hashSet"; key: string; field: string; value: string }
  | { kind: "hashDel"; key: string; field: string }
  | { kind: "listSet"; key: string; index: number; value: string }
  | { kind: "listPush"; key: string; value: string; head: boolean }
  | { kind: "listRem"; key: string; value: string }
  | { kind: "setAdd"; key: string; member: string }
  | { kind: "setRem"; key: string; member: string }
  | { kind: "zAdd"; key: string; member: string; score: number }
  | { kind: "zRem"; key: string; member: string }
  | { kind: "expire"; key: string; seconds: number }
  | { kind: "persist"; key: string }
  | { kind: "rename"; key: string; newKey: string }
  | { kind: "delete"; keys: string[] };

export interface SlowlogEntry {
  id: number;
  at: number;
  durationUs: number;
  command: string;
  client: string;
  name: string;
}

export interface MemoryReport {
  sampled: number;
  totalBytes: number;
  done: boolean;
  groups: { prefix: string; keys: number; bytes: number }[];
}

export interface PubSubMessage {
  subId: string;
  connectionId: string;
  channel: string;
  pattern?: string | null;
  payload: string;
  at: number;
}

export interface RedisCommandResult {
  reply: unknown;
  elapsedMs: number;
}

/* --------------------------------- history -------------------------------- */

export interface HistoryEntry {
  id: string;
  connectionId: string;
  sql: string;
  at: number;
  durationMs: number;
  ok: boolean;
  rows?: number | null;
  error?: string | null;
}

export interface SavedQuery {
  id: string;
  connectionId?: string | null;
  name: string;
  sql: string;
  position: number;
  updatedAt: number;
}

/* ----------------------------------- ddl ----------------------------------- */

export interface DdlColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  default?: string | null;
  primaryKey: boolean;
  autoIncrement: boolean;
}

export type DdlOp =
  | { kind: "createTable"; schema: string; table: string; columns: DdlColumn[] }
  | { kind: "addColumn"; schema: string; table: string; column: DdlColumn }
  | { kind: "alterColumn"; schema: string; table: string; name: string; newName?: string; dataType?: string; nullable?: boolean; setDefault: boolean; default?: string | null }
  | { kind: "dropColumn"; schema: string; table: string; name: string }
  | { kind: "renameTable"; schema: string; table: string; newName: string }
  | { kind: "createIndex"; schema: string; table: string; name: string; columns: string[]; unique: boolean }
  | { kind: "dropIndex"; schema: string; table: string; name: string }
  | { kind: "dropTable"; schema: string; table: string }
  | { kind: "truncateTable"; schema: string; table: string };

export interface ExplainResult {
  driver: DriverKind;
  plan: unknown;
  text?: string | null;
}

export interface CsvPreview {
  columns: string[];
  rows: string[][];
  delimiter: string;
  hasHeader: boolean;
  totalRows: number;
  truncatedCount: boolean;
}

export interface CsvImportRequest {
  schema: string;
  table: string;
  path: string;
  delimiter: string;
  hasHeader: boolean;
  mapping: { csvIndex: number; column: string }[];
  emptyAsNull: boolean;
  batchSize: number;
  createTable: boolean;
}

export interface CsvImportResult {
  inserted: number;
  statements: number;
  elapsedMs: number;
}

export interface AppInfo {
  version: string;
  os: string;
  arch: string;
}

/* ------------------------------ UI-only types ----------------------------- */

export type TabKind = "table" | "query" | "structure" | "redis" | "console" | "info" | "tools" | "diagram";

export interface Tab {
  id: string;
  kind: TabKind;
  connectionId: string;
  title: string;
  schema?: string;
  table?: string;
  /** query tabs: editor text (kept here so it survives tab switches) */
  sql?: string;
  dirty?: boolean;
}
