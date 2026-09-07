/**
 * In-browser stand-in for the Rust backend. Loaded only in dev builds when
 * the page is opened with `?mock=1` (see main.tsx); Playwright and manual UI
 * checks in a plain browser run on top of it. It implements every command
 * in `services/tauri.ts` against in-memory data and mimics the Rust error
 * protocol (`errors.<key>|detail`).
 */
import type {
  ApplyChangesRequest,
  ApplyChangesResult,
  Cell,
  ColumnInfo,
  ConnectionConfig,
  ConnectionInput,
  DdlOp,
  EditValue,
  HistoryEntry,
  RedisEntry,
  RedisMutation,
  RedisScanRequest,
  RedisValueRequest,
  ResultColumn,
  ResultSet,
  SavedQuery,
  ServerInfo,
  TableFilter,
  TableInfo,
  TablePageRequest,
  TableStructure,
} from "@/types";

type Args = Record<string, unknown>;
type Handler = (args: Args) => unknown;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

/* --------------------------------- people --------------------------------- */

interface Person {
  id: number;
  name: string;
  age: number | null;
  active: boolean;
  email: string;
  created_at: string;
}

let people: Person[] = Array.from({ length: 240 }, (_, i) => ({
  id: i + 1,
  name: `Person ${i + 1}`,
  age: i % 7 === 0 ? null : 18 + (i % 50),
  active: i % 2 === 0,
  email: `person${i + 1}@example.com`,
  created_at: `2024-01-${String(1 + (i % 28)).padStart(2, "0")} 10:00:00`,
}));
let nextId = 241;

const PEOPLE_COLUMNS: ResultColumn[] = [
  { name: "id", dataType: "integer", kind: "number" },
  { name: "name", dataType: "text", kind: "string" },
  { name: "age", dataType: "integer", kind: "number" },
  { name: "active", dataType: "boolean", kind: "bool" },
  { name: "email", dataType: "text", kind: "string" },
  { name: "created_at", dataType: "timestamp", kind: "date" },
];

const PEOPLE_META: ColumnInfo[] = PEOPLE_COLUMNS.map((c, i) => ({
  name: c.name,
  dataType: c.dataType,
  nullable: c.name !== "id" && c.name !== "name",
  primaryKey: c.name === "id",
  default: c.name === "id" ? "nextval('people_id_seq')" : c.name === "active" ? "true" : null,
  autoIncrement: c.name === "id",
  comment: c.name === "email" ? "Contact address" : null,
  position: i + 1,
}));

const ORDERS_META: ColumnInfo[] = [
  { name: "id", dataType: "bigint", nullable: false, primaryKey: true, default: null, autoIncrement: true, comment: null, position: 1 },
  { name: "person_id", dataType: "integer", nullable: true, primaryKey: false, default: null, autoIncrement: false, comment: null, position: 2 },
  { name: "total", dataType: "numeric(10,2)", nullable: true, primaryKey: false, default: null, autoIncrement: false, comment: null, position: 3 },
];

function personRow(p: Person): Cell[] {
  return [p.id, p.name, p.age, p.active, p.email, p.created_at];
}

function matches(p: Person, f: TableFilter): boolean {
  const v = (p as unknown as Record<string, Cell>)[f.column];
  const s = v === null || v === undefined ? "" : String(v);
  const val = f.value ?? "";
  switch (f.op) {
    case "eq":
      return s === val;
    case "neq":
      return s !== val;
    case "gt":
      return Number(s) > Number(val);
    case "gte":
      return Number(s) >= Number(val);
    case "lt":
      return Number(s) < Number(val);
    case "lte":
      return Number(s) <= Number(val);
    case "contains":
      return s.toLowerCase().includes(val.toLowerCase());
    case "starts":
      return s.toLowerCase().startsWith(val.toLowerCase());
    case "ends":
      return s.toLowerCase().endsWith(val.toLowerCase());
    case "isnull":
      return v === null || v === undefined;
    case "notnull":
      return v !== null && v !== undefined;
    case "in":
      return val.split(",").map((x) => x.trim()).includes(s);
    default:
      return true;
  }
}

function filtered(req: TablePageRequest): Person[] {
  let rows = people.filter((p) => req.filters.every((f) => matches(p, f)));
  if (req.rawWhere?.includes("age > 30")) rows = rows.filter((p) => (p.age ?? 0) > 30);
  if (req.sort) {
    const col = req.sort.column as keyof Person;
    rows = [...rows].sort((a, b) => {
      const x = a[col];
      const y = b[col];
      const r = x === null ? -1 : y === null ? 1 : x < y ? -1 : x > y ? 1 : 0;
      return req.sort!.desc ? -r : r;
    });
  }
  return rows;
}

function q(s: string): string {
  return `"${s}"`;
}
function lit(v: EditValue): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "object") return "DEFAULT";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return `'${v.replace(/'/g, "''")}'`;
}

function applyChanges(req: ApplyChangesRequest): ApplyChangesResult {
  const target = `${q(req.schema)}.${q(req.table)}`;
  const statements: string[] = [];
  for (const ch of req.changes) {
    if (ch.kind === "update") {
      const assigns = Object.entries(ch.set).map(([k, v]) => `${q(k)} = ${lit(v)}`).join(", ");
      const where = Object.entries(ch.key).map(([k, v]) => `${q(k)} = ${lit(v)}`).join(" AND ");
      statements.push(`UPDATE ${target} SET ${assigns} WHERE ${where}`);
    } else if (ch.kind === "insert") {
      const cols = Object.keys(ch.values).map(q).join(", ");
      const vals = Object.values(ch.values).map(lit).join(", ");
      statements.push(cols ? `INSERT INTO ${target} (${cols}) VALUES (${vals})` : `INSERT INTO ${target} DEFAULT VALUES`);
    } else {
      const where = Object.entries(ch.key).map(([k, v]) => `${q(k)} = ${lit(v)}`).join(" AND ");
      statements.push(`DELETE FROM ${target} WHERE ${where}`);
    }
  }
  if (req.preview) return { statements, affected: 0, executed: false };
  let affected = 0;
  for (const ch of req.changes) {
    if (ch.kind === "update") {
      const p = people.find((x) => x.id === ch.key.id);
      if (p) {
        for (const [k, v] of Object.entries(ch.set)) {
          (p as unknown as Record<string, unknown>)[k] = typeof v === "object" && v !== null ? null : v;
        }
        affected++;
      }
    } else if (ch.kind === "insert") {
      const v = ch.values as Record<string, EditValue>;
      const s = (x: EditValue) => (x === null || x === undefined || typeof x === "object" ? null : x);
      people.push({
        id: nextId++,
        name: String(s(v.name) ?? ""),
        age: s(v.age) === null ? null : Number(s(v.age)),
        active: s(v.active) === null ? true : Boolean(s(v.active)),
        email: String(s(v.email) ?? ""),
        created_at: String(s(v.created_at) ?? "2024-06-01 00:00:00"),
      });
      affected++;
    } else {
      const before = people.length;
      people = people.filter((x) => x.id !== ch.key.id);
      affected += before - people.length;
    }
  }
  return { statements, affected, executed: true };
}

function ddl(op: DdlOp): string[] {
  const tgt = (s: string, t: string) => `${q(s)}.${q(t)}`;
  const col = (c: { name: string; dataType: string; nullable: boolean; default?: string | null; primaryKey: boolean; autoIncrement: boolean }) =>
    `${q(c.name)} ${c.dataType}${c.autoIncrement ? " GENERATED BY DEFAULT AS IDENTITY" : ""}${c.primaryKey ? " PRIMARY KEY" : ""}${!c.nullable && !c.primaryKey ? " NOT NULL" : ""}${c.default ? ` DEFAULT ${c.default}` : ""}`;
  switch (op.kind) {
    case "createTable":
      return [`CREATE TABLE ${tgt(op.schema, op.table)} (\n  ${op.columns.map(col).join(",\n  ")}\n)`];
    case "addColumn":
      return [`ALTER TABLE ${tgt(op.schema, op.table)} ADD COLUMN ${col(op.column)}`];
    case "alterColumn": {
      const out: string[] = [];
      const t = tgt(op.schema, op.table);
      if (op.dataType) out.push(`ALTER TABLE ${t} ALTER COLUMN ${q(op.name)} TYPE ${op.dataType}`);
      if (op.nullable !== undefined) out.push(`ALTER TABLE ${t} ALTER COLUMN ${q(op.name)} ${op.nullable ? "DROP" : "SET"} NOT NULL`);
      if (op.setDefault) out.push(op.default ? `ALTER TABLE ${t} ALTER COLUMN ${q(op.name)} SET DEFAULT ${op.default}` : `ALTER TABLE ${t} ALTER COLUMN ${q(op.name)} DROP DEFAULT`);
      if (op.newName) out.push(`ALTER TABLE ${t} RENAME COLUMN ${q(op.name)} TO ${q(op.newName)}`);
      return out;
    }
    case "dropColumn":
      return [`ALTER TABLE ${tgt(op.schema, op.table)} DROP COLUMN ${q(op.name)}`];
    case "renameTable":
      return [`ALTER TABLE ${tgt(op.schema, op.table)} RENAME TO ${q(op.newName)}`];
    case "createIndex":
      return [`CREATE ${op.unique ? "UNIQUE " : ""}INDEX ${q(op.name)} ON ${tgt(op.schema, op.table)} (${op.columns.map(q).join(", ")})`];
    case "dropIndex":
      return [`DROP INDEX ${tgt(op.schema, op.name)}`];
    case "dropTable":
      return [`DROP TABLE ${tgt(op.schema, op.table)}`];
    case "truncateTable":
      return [`TRUNCATE TABLE ${tgt(op.schema, op.table)}`];
  }
}

/* ------------------------------- connections ------------------------------ */

let connections: ConnectionConfig[] = [
  {
    id: "c-pg",
    name: "Demo Postgres",
    driver: "postgres",
    host: "localhost",
    port: 5432,
    user: "postgres",
    database: "demo",
    sslMode: "prefer",
    color: "#5b93ee",
    group: null,
    readOnly: false,
    options: {},
    position: 0,
    createdAt: now() - 86_400_000,
    lastUsedAt: now() - 3_600_000,
    hasPassword: true,
    hasSshPassword: false,
  },
  {
    id: "c-redis",
    name: "Demo Redis",
    driver: "redis",
    host: "localhost",
    port: 6379,
    user: "",
    database: "0",
    sslMode: "disable",
    color: "#ec6060",
    group: null,
    readOnly: false,
    options: {},
    position: 1,
    createdAt: now() - 86_400_000,
    lastUsedAt: null,
    hasPassword: false,
    hasSshPassword: false,
  },
];
const sessions = new Map<string, string | undefined>();
const history: HistoryEntry[] = [];
const mockTimers: Record<string, number> = {};
const mockThemes: Record<string, unknown>[] = [
  {
    __file: "nord.json",
    id: "nord",
    name: "Nord",
    type: "dark",
    author: "community",
    colors: {
      bg: "#2e3440",
      panel: "#3b4252",
      "panel-2": "#434c5e",
      "panel-3": "#4c566a",
      line: "#4c566a",
      "line-2": "#5b6678",
      text: "#eceff4",
      "text-soft": "#d8dee9",
      "text-faint": "#8f9bb3",
      accent: "#88c0d0",
      "accent-2": "#8fbcbb",
      "accent-soft": "#3b4a56",
      "on-accent": "#2e3440",
      sel: "rgba(136,192,208,0.2)",
    },
  },
];
const savedQueries: SavedQuery[] = [{ id: "sq-0", connectionId: "c-pg", name: "Active people", sql: "SELECT * FROM people WHERE active", position: 0, updatedAt: now() - 60_000 }];

function serverInfo(c: ConnectionConfig, database?: string): ServerInfo {
  if (c.driver === "redis") return { driver: "redis", version: "7.4 (mock)", database: database ?? c.database ?? "0", user: null, extra: { keys: Object.keys(redisKeys).length } };
  if (c.driver === "mysql") return { driver: "mysql", version: "8.4 (mock)", database: database ?? c.database, user: c.user, extra: {} };
  return { driver: "postgres", version: "16.0 (mock)", database: database ?? c.database ?? "demo", user: c.user, extra: {} };
}

function conn(id: string): ConnectionConfig {
  const c = connections.find((x) => x.id === id);
  if (!c) throw "errors.storage|connection not found";
  return c;
}
function session(id: string): ConnectionConfig {
  if (!sessions.has(id)) throw "errors.notConnected";
  return conn(id);
}

/* ---------------------------------- redis --------------------------------- */

type RedisKey =
  | { kind: "string"; value: string }
  | { kind: "hash"; fields: Record<string, string> }
  | { kind: "list"; items: string[] }
  | { kind: "set"; members: string[] }
  | { kind: "zset"; members: Record<string, number> };

let redisKeys: Record<string, RedisKey> = {
  "user:1:profile": { kind: "hash", fields: { name: "Ana", age: "30", city: "Recife" } },
  "user:2:profile": { kind: "hash", fields: { name: "Bob", age: "41", city: "Porto" } },
  "session:abc123": { kind: "string", value: "token-xyz" },
  "queue:jobs": { kind: "list", items: ["job-1", "job-2", "job-3"] },
  tags: { kind: "set", members: ["red", "green", "blue"] },
  leaderboard: { kind: "zset", members: { ana: 10.5, bob: 7, cid: 3 } },
  "config:json": { kind: "string", value: '{"theme":"dark","limit":100}' },
};
const redisTtl: Record<string, number> = { "session:abc123": 3600 };

function glob(pattern: string): RegExp {
  return new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
}

function redisValue(req: RedisValueRequest) {
  const k = redisKeys[req.key];
  if (!k) throw `errors.query|key ${req.key} does not exist`;
  const ttl = redisTtl[req.key] ?? -1;
  let entries: RedisEntry[] = [];
  let total = 0;
  switch (k.kind) {
    case "string":
      entries = [{ field: null, value: k.value, score: null }];
      total = k.value.length;
      break;
    case "hash":
      entries = Object.entries(k.fields).map(([f, v]) => ({ field: f, value: v, score: null }));
      total = entries.length;
      break;
    case "list":
      entries = k.items.map((v, i) => ({ field: String(i), value: v, score: null }));
      total = entries.length;
      break;
    case "set":
      entries = k.members.map((v) => ({ field: null, value: v, score: null }));
      total = entries.length;
      break;
    case "zset":
      entries = Object.entries(k.members).map(([m, s]) => ({ field: null, value: m, score: s }));
      total = entries.length;
      break;
  }
  return { key: req.key, kind: k.kind, ttl, total, entries, cursor: 0, truncated: false };
}

function redisMutate(m: RedisMutation) {
  const get = (key: string) => {
    const k = redisKeys[key];
    if (!k) throw `errors.query|no such key ${key}`;
    return k;
  };
  switch (m.kind) {
    case "setString":
      redisKeys[m.key] = { kind: "string", value: m.value };
      break;
    case "hashSet": {
      const k = redisKeys[m.key] ?? (redisKeys[m.key] = { kind: "hash", fields: {} });
      if (k.kind === "hash") k.fields[m.field] = m.value;
      break;
    }
    case "hashDel": {
      const k = get(m.key);
      if (k.kind === "hash") delete k.fields[m.field];
      break;
    }
    case "listSet": {
      const k = get(m.key);
      if (k.kind === "list") k.items[m.index] = m.value;
      break;
    }
    case "listPush": {
      const k = redisKeys[m.key] ?? (redisKeys[m.key] = { kind: "list", items: [] });
      if (k.kind === "list") (m.head ? k.items.unshift(m.value) : k.items.push(m.value));
      break;
    }
    case "listRem": {
      const k = get(m.key);
      if (k.kind === "list") {
        const i = k.items.indexOf(m.value);
        if (i >= 0) k.items.splice(i, 1);
      }
      break;
    }
    case "setAdd": {
      const k = redisKeys[m.key] ?? (redisKeys[m.key] = { kind: "set", members: [] });
      if (k.kind === "set" && !k.members.includes(m.member)) k.members.push(m.member);
      break;
    }
    case "setRem": {
      const k = get(m.key);
      if (k.kind === "set") k.members = k.members.filter((x) => x !== m.member);
      break;
    }
    case "zAdd": {
      const k = redisKeys[m.key] ?? (redisKeys[m.key] = { kind: "zset", members: {} });
      if (k.kind === "zset") k.members[m.member] = m.score;
      break;
    }
    case "zRem": {
      const k = get(m.key);
      if (k.kind === "zset") delete k.members[m.member];
      break;
    }
    case "expire":
      get(m.key);
      redisTtl[m.key] = m.seconds;
      break;
    case "persist":
      delete redisTtl[m.key];
      break;
    case "rename":
      redisKeys[m.newKey] = get(m.key);
      delete redisKeys[m.key];
      break;
    case "delete":
      for (const k of m.keys) delete redisKeys[k];
      break;
  }
}

function redisCommand(line: string): unknown {
  const [cmd, ...args] = line.trim().split(/\s+/);
  switch ((cmd ?? "").toUpperCase()) {
    case "PING":
      return "PONG";
    case "GET": {
      const k = redisKeys[args[0]];
      return k?.kind === "string" ? k.value : null;
    }
    case "HGETALL": {
      const k = redisKeys[args[0]];
      return k?.kind === "hash" ? k.fields : {};
    }
    case "DBSIZE":
      return Object.keys(redisKeys).length;
    case "INFO":
      return "# Server\r\nredis_version:7.4\r\n";
    case "":
      return null;
    default:
      throw `errors.query|ERR unknown command '${cmd}'`;
  }
}

/* -------------------------------- handlers -------------------------------- */

const handlers: Record<string, Handler> = {
  app_info: () => ({ version: "0.0.0-mock", os: "browser", arch: "x64" }),
  secrets_available: () => true,

  connections_list: () => connections.map((c) => ({ ...c })),
  connection_save: ({ input }) => {
    const i = input as ConnectionInput;
    const existing = connections.find((c) => c.id === i.id);
    const { password, sshPassword, ...cfg } = i;
    const saved: ConnectionConfig = {
      ...cfg,
      id: cfg.id || `c-${Math.random().toString(36).slice(2, 8)}`,
      name: cfg.name.trim() || `${cfg.user}@${cfg.host}`,
      createdAt: existing?.createdAt ?? now(),
      hasPassword: password === undefined ? existing?.hasPassword ?? false : password !== "",
      hasSshPassword: sshPassword === undefined ? existing?.hasSshPassword ?? false : sshPassword !== "",
    };
    if (existing) connections = connections.map((c) => (c.id === saved.id ? saved : c));
    else connections.push(saved);
    return saved;
  },
  connection_delete: ({ id }) => {
    connections = connections.filter((c) => c.id !== id);
    sessions.delete(id as string);
  },
  connections_reorder: ({ ids }) => {
    (ids as string[]).forEach((id, i) => {
      const c = connections.find((x) => x.id === id);
      if (c) c.position = i;
    });
  },
  connection_test: ({ input }) => {
    const i = input as ConnectionInput;
    if (i.host === "bad.host") throw "errors.connect|connection refused";
    if (i.password === "wrong") throw "errors.auth|password authentication failed";
    return serverInfo(i);
  },

  session_open: ({ connectionId, database }) => {
    const c = conn(connectionId as string);
    if (c.host === "bad.host") throw "errors.connect|connection refused";
    sessions.set(c.id, (database as string | null) ?? undefined);
    c.lastUsedAt = now();
    return serverInfo(c, (database as string | null) ?? undefined);
  },
  session_close: ({ connectionId }) => {
    sessions.delete(connectionId as string);
  },
  session_list: () => [...sessions.keys()],
  session_info: ({ connectionId }) => serverInfo(session(connectionId as string)),

  schema_databases: ({ connectionId, includeSystem }) =>
    session(connectionId as string).driver === "redis" ? ["0", "1", "2"] : includeSystem ? ["demo", "postgres", "template0", "template1"] : ["demo", "postgres"],
  schema_list: ({ connectionId, includeSystem }) => {
    session(connectionId as string);
    return includeSystem ? ["public", "audit", "information_schema", "pg_catalog"] : ["public", "audit"];
  },
  schema_tables: ({ connectionId, schema }) => {
    session(connectionId as string);
    if (schema !== "public") return [] as TableInfo[];
    return [
      { schema: "public", name: "people", kind: "table", rowEstimate: people.length, comment: "Mock people" },
      { schema: "public", name: "orders", kind: "table", rowEstimate: 12, comment: null },
      { schema: "public", name: "adults", kind: "view", rowEstimate: null, comment: null },
    ] as TableInfo[];
  },
  schema_columns: ({ connectionId, schema }) => {
    session(connectionId as string);
    if (schema !== "public") return [];
    return [
      { table: "people", columns: PEOPLE_META },
      { table: "orders", columns: ORDERS_META },
      { table: "adults", columns: PEOPLE_META.map((c) => ({ ...c, primaryKey: false, autoIncrement: false })) },
    ];
  },
  table_columns: ({ connectionId, table }) => {
    session(connectionId as string);
    if (table === "orders") return ORDERS_META;
    // views have no primary key → the grid must go read-only
    if (table === "adults") return PEOPLE_META.map((c) => ({ ...c, primaryKey: false, autoIncrement: false, default: null }));
    return PEOPLE_META;
  },
  table_structure: ({ connectionId, table }): TableStructure => {
    session(connectionId as string);
    if (table === "orders") {
      return {
        columns: ORDERS_META,
        indexes: [
          { name: "orders_pkey", columns: ["id"], unique: true, primary: true, definition: "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)" },
          { name: "orders_person_idx", columns: ["person_id"], unique: false, primary: false, definition: null },
        ],
        foreignKeys: [{ name: "orders_person_fk", columns: ["person_id"], refSchema: "public", refTable: "people", refColumns: ["id"], onUpdate: "NO ACTION", onDelete: "CASCADE" }],
        ddl: null,
      };
    }
    if (table === "adults") return { columns: PEOPLE_META.map((c) => ({ ...c, primaryKey: false, autoIncrement: false, default: null })), indexes: [], foreignKeys: [], ddl: null };
    return {
      columns: PEOPLE_META,
      indexes: [{ name: "people_pkey", columns: ["id"], unique: true, primary: true, definition: null }],
      foreignKeys: [],
      ddl: null,
    };
  },

  ddl_preview: ({ connectionId, op }) => {
    session(connectionId as string);
    return ddl(op as DdlOp);
  },
  ddl_apply: ({ connectionId, op }) => {
    const c = session(connectionId as string);
    if (c.readOnly) throw "errors.readOnly";
    const o = op as DdlOp;
    const stmts = ddl(o);
    if (o.kind === "addColumn") PEOPLE_META.push({ name: o.column.name, dataType: o.column.dataType, nullable: o.column.nullable, primaryKey: o.column.primaryKey, default: o.column.default ?? null, autoIncrement: o.column.autoIncrement, comment: null, position: PEOPLE_META.length + 1 });
    if (o.kind === "dropColumn") {
      const i = PEOPLE_META.findIndex((c) => c.name === o.name);
      if (i >= 0) PEOPLE_META.splice(i, 1);
    }
    if (o.kind === "alterColumn" && o.newName) {
      const m = PEOPLE_META.find((c) => c.name === o.name);
      if (m) m.name = o.newName;
    }
    return stmts;
  },

  query_run: ({ connectionId, sql, maxRows }) => {
    const c = session(connectionId as string);
    const text = String(sql);
    const started = now();
    const finish = (ok: boolean, rows: number | null, error?: string) =>
      history.unshift({ id: `h${history.length + 1}`, connectionId: c.id, sql: text, at: started, durationMs: 12, ok, rows, error: error ?? null });
    if (/\bnope\b/i.test(text)) {
      finish(false, null, 'relation "nope" does not exist');
      throw 'errors.query|relation "nope" does not exist (position 15)';
    }
    const statements = text.split(";").map((s) => s.trim()).filter(Boolean);
    const sets: ResultSet[] = statements.map((st) => {
      if (/^select/i.test(st)) {
        const limit = Math.min(Number(maxRows ?? 1000), 1000);
        const rows = people.slice(0, limit).map(personRow);
        return { columns: PEOPLE_COLUMNS, rows, rowCount: rows.length, affected: null, truncated: people.length > limit, elapsedMs: 12, statement: st };
      }
      return { columns: [], rows: [], rowCount: 0, affected: 3, truncated: false, elapsedMs: 4, statement: st };
    });
    finish(true, sets.reduce((n, s) => n + (s.affected ?? s.rowCount), 0));
    return sets;
  },
  query_cancel: () => undefined,
  query_explain: ({ connectionId, sql, analyze }) => {
    session(connectionId as string);
    if (/\bnope\b/i.test(String(sql))) throw 'errors.query|relation "nope" does not exist';
    const plan = [
      {
        Plan: {
          "Node Type": "Sort",
          "Total Cost": 42.5,
          "Plan Rows": 240,
          "Sort Key": ["name"],
          ...(analyze ? { "Actual Total Time": 1.23, "Actual Rows": 240 } : {}),
          Plans: [{ "Node Type": "Seq Scan", "Relation Name": "people", "Total Cost": 12.4, "Plan Rows": 240, Filter: "(age > 30)", ...(analyze ? { "Actual Total Time": 0.4, "Actual Rows": 200 } : {}) }],
        },
      },
    ];
    return { driver: "postgres", plan, text: null };
  },
  history_list: ({ connectionId, limit }) => history.filter((h) => !connectionId || h.connectionId === connectionId).slice(0, Number(limit ?? 200)),
  history_clear: ({ connectionId }) => {
    for (let i = history.length - 1; i >= 0; i--) if (!connectionId || history[i].connectionId === connectionId) history.splice(i, 1);
  },
  saved_queries_list: () => savedQueries.map((q) => ({ ...q })),
  saved_query_save: ({ query }) => {
    const q = { ...(query as SavedQuery) };
    if (!q.id) q.id = `sq-${savedQueries.length + 1}`;
    q.updatedAt = now();
    const i = savedQueries.findIndex((x) => x.id === q.id);
    if (i >= 0) savedQueries[i] = q;
    else savedQueries.push(q);
    return q;
  },
  saved_query_delete: ({ id }) => {
    const i = savedQueries.findIndex((x) => x.id === id);
    if (i >= 0) savedQueries.splice(i, 1);
  },

  table_page: ({ connectionId, req }) => {
    session(connectionId as string);
    const r = req as TablePageRequest;
    if (r.table !== "people") return { columns: ORDERS_META.map((c) => ({ name: c.name, dataType: c.dataType, kind: c.name === "id" || c.name === "person_id" || c.name === "total" ? "number" : "string" })), rows: [], rowCount: 0, affected: null, truncated: false, elapsedMs: 2, statement: `SELECT * FROM "public"."${r.table}"` };
    const rows = filtered(r).slice(Number(r.offset), Number(r.offset) + r.limit).map(personRow);
    return { columns: PEOPLE_COLUMNS, rows, rowCount: rows.length, affected: null, truncated: false, elapsedMs: 3, statement: "SELECT * FROM \"public\".\"people\"" } as ResultSet;
  },
  table_count: ({ connectionId, req }) => {
    session(connectionId as string);
    const r = req as TablePageRequest;
    return r.table === "people" ? filtered(r).length : 0;
  },
  table_apply: ({ connectionId, req }) => {
    const c = session(connectionId as string);
    if (c.readOnly && !(req as ApplyChangesRequest).preview) throw "errors.readOnly";
    return applyChanges(req as ApplyChangesRequest);
  },

  redis_scan: ({ connectionId, req }) => {
    session(connectionId as string);
    const r = req as RedisScanRequest;
    const re = glob(r.pattern || "*");
    const keys = Object.entries(redisKeys)
      .filter(([k, v]) => re.test(k) && (!r.typeFilter || v.kind === r.typeFilter))
      .map(([key, v]) => ({ key, kind: v.kind, ttl: redisTtl[key] ?? -1, size: null }));
    return { cursor: 0, keys, done: true };
  },
  redis_value: ({ connectionId, req }) => {
    session(connectionId as string);
    return redisValue(req as RedisValueRequest);
  },
  redis_mutate: ({ connectionId, mutation }) => {
    const c = session(connectionId as string);
    if (c.readOnly) throw "errors.readOnly";
    redisMutate(mutation as RedisMutation);
  },
  redis_command: ({ connectionId, line }) => {
    session(connectionId as string);
    return { reply: redisCommand(String(line)), elapsedMs: 1 };
  },
  redis_slowlog: ({ connectionId }) => {
    session(connectionId as string);
    return [
      { id: 2, at: Math.floor(now() / 1000) - 30, durationUs: 15200, command: "KEYS *", client: "127.0.0.1:5000", name: "" },
      { id: 1, at: Math.floor(now() / 1000) - 300, durationUs: 3400, command: "HGETALL user:1:profile", client: "127.0.0.1:5001", name: "worker" },
    ];
  },
  redis_memory: ({ connectionId, pattern }) => {
    session(connectionId as string);
    const re = glob((pattern as string) || "*");
    const groups: Record<string, { prefix: string; keys: number; bytes: number }> = {};
    for (const [k, v] of Object.entries(redisKeys)) {
      if (!re.test(k)) continue;
      const prefix = k.includes(":") ? k.split(":")[0] : "(no prefix)";
      const bytes = 64 + JSON.stringify(v).length;
      const g = (groups[prefix] ??= { prefix, keys: 0, bytes: 0 });
      g.keys++;
      g.bytes += bytes;
    }
    const list = Object.values(groups).sort((a, b) => b.bytes - a.bytes);
    return { sampled: list.reduce((n, g) => n + g.keys, 0), totalBytes: list.reduce((n, g) => n + g.bytes, 0), done: true, groups: list };
  },
  redis_subscribe: ({ connectionId, channels, patterns }) => {
    session(connectionId as string);
    const subId = `sub-${Math.random().toString(36).slice(2, 8)}`;
    const chans = channels as string[];
    const pats = patterns as string[];
    const timer = window.setInterval(() => {
      const channel = chans[0] ?? (pats[0] ?? "events:*").replace(/[*?]/g, "1");
      window.dispatchEvent(new CustomEvent("redis-pubsub", { detail: { subId, connectionId, channel, pattern: chans[0] ? null : pats[0], payload: JSON.stringify({ tick: Date.now() }), at: now() } }));
    }, 400);
    mockTimers[subId] = timer;
    return subId;
  },
  redis_unsubscribe: ({ subId }) => {
    window.clearInterval(mockTimers[subId as string]);
    delete mockTimers[subId as string];
  },
  redis_publish: ({ connectionId, channel, message }) => {
    session(connectionId as string);
    for (const subId of Object.keys(mockTimers)) {
      window.dispatchEvent(new CustomEvent("redis-pubsub", { detail: { subId, connectionId, channel, pattern: null, payload: message, at: now() } }));
    }
    return Object.keys(mockTimers).length;
  },
  redis_info: ({ connectionId }) => {
    session(connectionId as string);
    return {
      server: { redis_version: "7.4.0", uptime_in_seconds: "86400" },
      clients: { connected_clients: "3" },
      memory: { used_memory_human: "1.2M", used_memory_peak_human: "2.0M" },
      stats: { instantaneous_ops_per_sec: "12", keyspace_hits: "900", keyspace_misses: "100" },
      replication: { role: "master" },
    };
  },

  export_rows: ({ req }) => ((req as { rows: unknown[] }).rows ?? []).length,
  csv_preview: ({ path, delimiter, hasHeader }) => {
    if (String(path).includes("missing")) throw `errors.io|${path}: not found`;
    return {
      columns: ["Name", "Age", "Email"],
      rows: [["Zed", "31", "zed@example.com"], ["Yara", "", "yara@example.com"]],
      delimiter: (delimiter as string) ?? ",",
      hasHeader: (hasHeader as boolean | null) ?? true,
      totalRows: 2,
      truncatedCount: false,
    };
  },
  csv_import: ({ connectionId, req }) => {
    const c = session(connectionId as string);
    if (c.readOnly) throw "errors.readOnly";
    const r = req as { mapping: { csvIndex: number; column: string }[]; createTable: boolean; table: string };
    const rows = [["Zed", "31", "zed@example.com"], ["Yara", "", "yara@example.com"]];
    if (!r.createTable) {
      for (const row of rows) {
        const rec: Record<string, unknown> = {};
        for (const m of r.mapping) rec[m.column] = row[m.csvIndex] === "" ? null : row[m.csvIndex];
        people.push({ id: nextId++, name: String(rec.name ?? ""), age: rec.age == null ? null : Number(rec.age), active: true, email: String(rec.email ?? ""), created_at: "2024-06-01 00:00:00" });
      }
    }
    return { inserted: rows.length, statements: 1, elapsedMs: 7 };
  },
  read_file_text: () => "",
  write_file_text: () => undefined,
  data_dir_path: () => "C:\\Users\\mock\\AppData\\Roaming\\com.lluan.osprey",
  open_data_dir: () => undefined,
  themes_list: () => mockThemes,
  themes_dir_path: () => "C:\\Users\\mock\\AppData\\Roaming\\com.lluan.osprey\\themes",
  theme_save: ({ filename, content }) => {
    const parsed = JSON.parse(content as string) as Record<string, unknown>;
    const file = String(filename).endsWith(".json") ? String(filename) : `${filename}.json`;
    const i = mockThemes.findIndex((t) => t.__file === file);
    const entry = { ...parsed, __file: file };
    if (i >= 0) mockThemes[i] = entry;
    else mockThemes.push(entry);
    window.dispatchEvent(new CustomEvent("themes-changed"));
    return `C:\\mock\\themes\\${file}`;
  },
  open_themes_dir: () => undefined,
};

/** Install the mock bridge on `window`. */
export function installTauriMock(): void {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown; __OSPREY_MOCK__?: unknown };
  w.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Args) => {
      await delay(15);
      const h = handlers[cmd];
      if (!h) throw `errors.unknown|no mock for ${cmd}`;
      // errors thrown synchronously become rejections, like the real bridge
      return h(args ?? {});
    },
    transformCallback: (cb: (v: unknown) => void) => {
      const id = Math.floor(Math.random() * 1e9);
      (window as unknown as Record<string, unknown>)[`_${id}`] = cb;
      return id;
    },
    metadata: undefined,
  };
  // test hooks: inspect or reset the fake data
  w.__OSPREY_MOCK__ = {
    reset: () => {
      sessions.clear();
      history.length = 0;
    },
    people: () => people,
    redis: () => redisKeys,
  };
}
