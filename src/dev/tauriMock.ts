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
  EditValue,
  HistoryEntry,
  RedisEntry,
  RedisMutation,
  RedisScanRequest,
  RedisValueRequest,
  ResultColumn,
  ResultSet,
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
  },
];
const sessions = new Map<string, string | undefined>();
const history: HistoryEntry[] = [];

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
    const { password, ...cfg } = i;
    const saved: ConnectionConfig = {
      ...cfg,
      id: cfg.id || `c-${Math.random().toString(36).slice(2, 8)}`,
      name: cfg.name.trim() || `${cfg.user}@${cfg.host}`,
      createdAt: existing?.createdAt ?? now(),
      hasPassword: password === undefined ? existing?.hasPassword ?? false : password !== "",
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

  schema_databases: ({ connectionId }) => (session(connectionId as string).driver === "redis" ? ["0", "1", "2"] : ["demo", "postgres"]),
  schema_list: ({ connectionId }) => {
    session(connectionId as string);
    return ["public", "audit"];
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
    return {
      columns: PEOPLE_META,
      indexes: [{ name: "people_pkey", columns: ["id"], unique: true, primary: true, definition: null }],
      foreignKeys: [],
      ddl: null,
    };
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
  history_list: ({ connectionId, limit }) => history.filter((h) => !connectionId || h.connectionId === connectionId).slice(0, Number(limit ?? 200)),
  history_clear: ({ connectionId }) => {
    for (let i = history.length - 1; i >= 0; i--) if (!connectionId || history[i].connectionId === connectionId) history.splice(i, 1);
  },
  saved_queries_list: () => [],
  saved_query_save: ({ query }) => query,
  saved_query_delete: () => undefined,

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
  read_file_text: () => "",
  write_file_text: () => undefined,
  data_dir_path: () => "C:\\Users\\mock\\AppData\\Roaming\\com.lluan.osprey",
  open_data_dir: () => undefined,
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
