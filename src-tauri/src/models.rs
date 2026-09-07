//! serde DTOs shared with the frontend. Everything crosses the IPC as
//! camelCase JSON; the TypeScript mirror lives in `src/types/index.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/* ------------------------------- connections ------------------------------ */

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum DriverKind {
    Postgres,
    Mysql,
    Redis,
    Sqlite,
}

impl DriverKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            DriverKind::Postgres => "postgres",
            DriverKind::Mysql => "mysql",
            DriverKind::Redis => "redis",
            DriverKind::Sqlite => "sqlite",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "postgres" => Some(DriverKind::Postgres),
            "mysql" => Some(DriverKind::Mysql),
            "redis" => Some(DriverKind::Redis),
            "sqlite" => Some(DriverKind::Sqlite),
            _ => None,
        }
    }
    pub fn default_port(&self) -> u16 {
        match self {
            DriverKind::Postgres => 5432,
            DriverKind::Mysql => 3306,
            DriverKind::Redis => 6379,
            DriverKind::Sqlite => 0,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SslMode {
    Disable,
    #[default]
    Prefer,
    Require,
    /// verify the server certificate against the OS trust store
    Verify,
}

/// A saved connection. The password never travels inside this struct: it is
/// kept in the OS keychain (see `secrets.rs`) keyed by `id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub driver: DriverKind,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub ssl_mode: SslMode,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub read_only: bool,
    /// driver-specific extras: `{ "redisDb": 0, "username": "...", "tls": true }`
    #[serde(default)]
    pub options: Value,
    #[serde(default)]
    pub position: i64,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub last_used_at: Option<i64>,
    /// whether a password is stored for this connection (keychain or fallback)
    #[serde(default)]
    pub has_password: bool,
    /// whether an SSH password / passphrase is stored
    #[serde(default)]
    pub has_ssh_password: bool,
}

/// What the connection dialog sends when saving or testing.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    #[serde(flatten)]
    pub config: ConnectionConfig,
    /// `None` keeps whatever is stored; `Some("")` clears it
    pub password: Option<String>,
    /// SSH password or key passphrase; same semantics as `password`
    #[serde(default)]
    pub ssh_password: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub driver: DriverKind,
    pub version: String,
    pub database: Option<String>,
    pub user: Option<String>,
    pub extra: Value,
}

/* --------------------------------- schema --------------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub schema: String,
    pub name: String,
    /// `table`, `view`, `materialized`, `foreign`
    pub kind: String,
    pub row_estimate: Option<i64>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    pub default: Option<String>,
    pub auto_increment: bool,
    pub comment: Option<String>,
    pub position: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
    pub definition: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_schema: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_update: Option<String>,
    pub on_delete: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
/// Every column of every table in a schema (autocompletion, ER diagram).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableColumns {
    pub table: String,
    pub columns: Vec<ColumnInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStructure {
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
    pub ddl: Option<String>,
}

/* --------------------------------- results -------------------------------- */

/// Coarse type used by the grid for alignment, colouring and editors.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ColumnKind {
    Number,
    String,
    Bool,
    Date,
    Json,
    Bytes,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultColumn {
    pub name: String,
    pub data_type: String,
    pub kind: ColumnKind,
}

/// One result set. Rows are arrays (not objects) to keep the IPC payload
/// small; every cell is `null`, a string, a number or a bool.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSet {
    pub columns: Vec<ResultColumn>,
    pub rows: Vec<Vec<Value>>,
    pub row_count: usize,
    pub affected: Option<u64>,
    pub truncated: bool,
    pub elapsed_ms: u64,
    pub statement: Option<String>,
}

impl ResultSet {
    pub fn command(affected: u64, elapsed_ms: u64, statement: Option<String>) -> Self {
        ResultSet {
            columns: vec![],
            rows: vec![],
            row_count: 0,
            affected: Some(affected),
            truncated: false,
            elapsed_ms,
            statement,
        }
    }
}

/* ------------------------------- table view ------------------------------- */

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableFilter {
    pub column: String,
    /// eq, neq, gt, gte, lt, lte, contains, starts, ends, isnull, notnull, in
    pub op: String,
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortSpec {
    pub column: String,
    pub desc: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablePageRequest {
    pub schema: String,
    pub table: String,
    #[serde(default)]
    pub filters: Vec<TableFilter>,
    #[serde(default)]
    pub raw_where: Option<String>,
    #[serde(default)]
    pub sort: Option<SortSpec>,
    pub limit: u32,
    pub offset: u64,
}

/// A pending edit from the grid. `key` holds primary-key values, `set` /
/// `values` hold column → new value (`null` for SQL NULL, or the special
/// `{ "$default": true }` object to use the column default).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RowChange {
    Update {
        key: serde_json::Map<String, Value>,
        set: serde_json::Map<String, Value>,
    },
    Insert {
        values: serde_json::Map<String, Value>,
    },
    Delete {
        key: serde_json::Map<String, Value>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyChangesRequest {
    pub schema: String,
    pub table: String,
    pub changes: Vec<RowChange>,
    /// true → return the SQL without running it
    #[serde(default)]
    pub preview: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyChangesResult {
    pub statements: Vec<String>,
    pub affected: u64,
    pub executed: bool,
}

/* ----------------------------------- ddl ----------------------------------- */

/// Column definition used by CREATE TABLE / ADD COLUMN. `default` is a raw
/// SQL expression (the user writes `'x'`, `0` or `now()`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DdlColumn {
    pub name: String,
    pub data_type: String,
    #[serde(default = "default_true")]
    pub nullable: bool,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub primary_key: bool,
    #[serde(default)]
    pub auto_increment: bool,
}

fn default_true() -> bool {
    true
}

/// Structure edits the UI asks for. Every op names its table; the dialect
/// turns it into one or more statements (see `sql.rs`).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DdlOp {
    CreateTable { schema: String, table: String, columns: Vec<DdlColumn> },
    AddColumn { schema: String, table: String, column: DdlColumn },
    /// Every field is optional; `set_default` distinguishes "leave the
    /// default alone" from "set it to NULL / drop it".
    AlterColumn {
        schema: String,
        table: String,
        name: String,
        #[serde(default)]
        new_name: Option<String>,
        #[serde(default)]
        data_type: Option<String>,
        #[serde(default)]
        nullable: Option<bool>,
        #[serde(default)]
        set_default: bool,
        #[serde(default)]
        default: Option<String>,
    },
    DropColumn { schema: String, table: String, name: String },
    RenameTable { schema: String, table: String, new_name: String },
    CreateIndex { schema: String, table: String, name: String, columns: Vec<String>, #[serde(default)] unique: bool },
    DropIndex { schema: String, table: String, name: String },
    DropTable { schema: String, table: String },
    TruncateTable { schema: String, table: String },
}

/* ---------------------------------- redis --------------------------------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyInfo {
    pub key: String,
    pub kind: String,
    /// seconds; -1 no expiry; -2 missing
    pub ttl: i64,
    pub size: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisScanRequest {
    #[serde(default)]
    pub cursor: u64,
    #[serde(default)]
    pub pattern: String,
    #[serde(default)]
    pub count: u32,
    #[serde(default)]
    pub type_filter: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisScanResult {
    pub cursor: u64,
    pub keys: Vec<RedisKeyInfo>,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisEntry {
    /// hash field, zset member, stream id, list index
    pub field: Option<String>,
    pub value: String,
    pub score: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisValue {
    pub key: String,
    pub kind: String,
    pub ttl: i64,
    pub total: i64,
    pub entries: Vec<RedisEntry>,
    /// scan cursor for big hashes/sets/zsets; 0 when finished
    pub cursor: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisValueRequest {
    pub key: String,
    #[serde(default)]
    pub cursor: u64,
    #[serde(default)]
    pub pattern: String,
    #[serde(default)]
    pub count: u32,
    /// list/stream window start
    #[serde(default)]
    pub start: i64,
}

/// Mutations on a Redis key from the value panel.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RedisMutation {
    SetString { key: String, value: String },
    HashSet { key: String, field: String, value: String },
    HashDel { key: String, field: String },
    ListSet { key: String, index: i64, value: String },
    ListPush { key: String, value: String, head: bool },
    ListRem { key: String, value: String },
    SetAdd { key: String, member: String },
    SetRem { key: String, member: String },
    ZAdd { key: String, member: String, score: f64 },
    ZRem { key: String, member: String },
    Expire { key: String, seconds: i64 },
    Persist { key: String },
    Rename { key: String, new_key: String },
    Delete { keys: Vec<String> },
}

/* --------------------------------- history -------------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub connection_id: String,
    pub sql: String,
    pub at: i64,
    pub duration_ms: u64,
    pub ok: bool,
    pub rows: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    pub id: String,
    pub connection_id: Option<String>,
    pub name: String,
    pub sql: String,
    pub position: i64,
    pub updated_at: i64,
}
