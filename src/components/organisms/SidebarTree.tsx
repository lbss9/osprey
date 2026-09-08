import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import Icon, { type IconName } from "@/components/atoms/Icon";
import Spinner from "@/components/atoms/Spinner";
import { useContextMenu, type ContextMenuItem } from "@/components/molecules/ContextMenu";
import { useUi } from "@/store/ui";
import { useWorkspace, type SessionState } from "@/store/workspace";
import * as api from "@/services/tauri";
import { translateError } from "@/i18n";
import { copyText } from "@/utils/clipboard";
import { confirmDialog } from "@/utils/dialog";
import { formatNumber, quoteIdent } from "@/utils/format";
import { sessionKey } from "@/utils/session";
import type { ConnectionConfig, RoutineInfo, TableInfo } from "@/types";

const SYSTEM_SCHEMAS = new Set(["pg_catalog", "information_schema", "pg_toast", "mysql", "sys", "performance_schema", "INFORMATION_SCHEMA", "system"]);
const SYSTEM_DATABASES = new Set(["postgres", "template0", "template1", "master", "tempdb", "model", "msdb", "system", "INFORMATION_SCHEMA", "information_schema"]);
/** engines whose catalog has functions / procedures */
const HAS_ROUTINES = new Set(["postgres", "mysql", "mssql"]);
/** engines where a connection sees several databases, each with its own schemas */
const HAS_DATABASE_LEVEL = new Set(["postgres", "mssql"]);

const isView = (t: TableInfo) => t.kind !== "table" && t.kind !== "partitioned" && t.kind !== "foreign";

/**
 * The object tree under a SQL connection: database › schema › folders
 * (tables, views, routines) › objects. Engines without a database level
 * (MySQL, SQLite, ClickHouse) start at the schema. Every database beyond the
 * one the connection opened gets its own session when expanded.
 */
export default function SqlTree({ conn, session, filter, onQuery }: { conn: ConnectionConfig; session: SessionState; filter: string; onQuery: (sql?: string) => void }) {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const q = filter.trim().toLowerCase();
  const rootKey = conn.id;

  if (!session.schemas) {
    return (
      <div className="tree-empty">
        <Spinner /> {t("common.loading")}
      </div>
    );
  }

  if (HAS_DATABASE_LEVEL.has(conn.driver) && session.databases && session.databases.length > 0) {
    const list = [...session.databases];
    // the root session's database heads the list; an unknown/empty name maps to the first entry
    const current = session.database && list.includes(session.database) ? session.database : list[0];
    // the connected database first, then the rest alphabetically
    list.sort((a, b) => (a === current ? -1 : b === current ? 1 : a.localeCompare(b)));
    return (
      <div>
        {list.map((db) => {
          const key = db === current ? rootKey : sessionKey(conn.id, db);
          const dbSession = ws.sessions[key];
          const expKey = `db:${db}`;
          const isOpen = !!session.expanded[expKey] || (db === current && session.expanded[expKey] === undefined) || (!!q && !!dbSession?.schemas);
          return (
            <div key={db}>
              <div
                className={`tree-row tree-indent-1 ${SYSTEM_DATABASES.has(db) ? "system" : ""}`}
                onClick={() => {
                  const next = !isOpen;
                  ws.toggleExpanded(rootKey, expKey, next);
                  if (next && !dbSession) void ws.openDatabase(conn.id, db);
                }}
                title={db === current ? t("sidebar.connectedDatabase") : t("sidebar.databaseHint")}
              >
                <Icon name="chevronRight" size={14} className={`chev ${isOpen ? "open" : ""}`} />
                <Icon name="database" size={14} style={{ color: db === current ? "var(--accent)" : "var(--text-faint)" }} />
                <span className="label">{db}</span>
                {dbSession?.status === "connecting" && <Spinner />}
                {dbSession?.schemas && <span className="meta">{dbSession.schemas.filter((s) => !SYSTEM_SCHEMAS.has(s)).length}</span>}
              </div>
              {isOpen && dbSession && dbSession.status === "error" && (
                <div className="tree-empty" style={{ color: "var(--red)" }}>
                  {dbSession.error}
                </div>
              )}
              {isOpen && dbSession && dbSession.status !== "error" && (
                <SchemaNodes conn={conn} sessKey={key} session={dbSession} filter={q} depth={2} onQuery={onQuery} />
              )}
            </div>
          );
        })}
      </div>
    );
  }
  return <SchemaNodes conn={conn} sessKey={rootKey} session={session} filter={q} depth={1} onQuery={onQuery} />;
}

/* --------------------------------- schemas -------------------------------- */

function SchemaNodes({ conn, sessKey, session, filter: q, depth, onQuery }: { conn: ConnectionConfig; sessKey: string; session: SessionState; filter: string; depth: number; onQuery: (sql?: string) => void }) {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const { open } = useContextMenu();
  const setUi = useUi((s) => s.set);
  const schemas = session.schemas ?? [];
  const schemaIcon: IconName = conn.driver === "mysql" || conn.driver === "clickhouse" ? "database" : "layers";

  // while filtering, load every schema that was never expanded
  useEffect(() => {
    if (!q) return;
    for (const schema of schemas) {
      if (!session.tables[schema] && !session.loadingTables[schema]) void ws.loadTables(sessKey, schema);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, schemas.length]);

  if (!session.schemas) {
    return (
      <div className="tree-empty">
        <Spinner /> {t("common.loading")}
      </div>
    );
  }

  const schemaMenu = (schema: string): ContextMenuItem[] => [
    ...(!conn.readOnly
      ? [
          { label: t("ddl.createTable"), icon: "plus" as const, onSelect: () => setUi({ ddlDialog: { connectionId: sessKey, schema, mode: "createTable" } }) },
          { label: t("import.newTable"), icon: "download" as const, onSelect: () => setUi({ importDialog: { connectionId: sessKey, schema } }) },
        ]
      : []),
    { label: t("ctx.refresh"), icon: "refresh", onSelect: () => void ws.loadTables(sessKey, schema) },
    { label: t("diagram.title"), icon: "tree", onSelect: () => ws.openTab({ kind: "diagram", connectionId: sessKey, schema, title: `${schema} · ${t("diagram.short")}` }) },
    { label: t("ctx.querySchema"), icon: "fileCode", onSelect: () => onQuery(conn.driver === "postgres" ? `SET search_path TO ${quoteIdent(schema, conn.driver)};\n` : `USE ${quoteIdent(schema, conn.driver)};\n`) },
    { separator: true },
    { label: t("ctx.copyName"), icon: "copy", onSelect: () => void copyText(schema) },
    { separator: true },
    { label: t("ctx.collapseAll"), onSelect: () => schemas.forEach((s) => ws.toggleExpanded(sessKey, `schema:${s}`, false)) },
    {
      label: t("ctx.expandAll"),
      onSelect: () =>
        schemas.forEach((s) => {
          ws.toggleExpanded(sessKey, `schema:${s}`, true);
          if (!session.tables[s]) void ws.loadTables(sessKey, s);
        }),
    },
  ];

  return (
    <div>
      {schemas.map((schema) => {
        const key = `schema:${schema}`;
        const tables = session.tables[schema];
        const loading = session.loadingTables[schema];
        const routines = session.routines?.[schema];
        const isOpen = !!session.expanded[key] || !!q;
        const matchT = (tables ?? []).filter((tb) => !q || tb.name.toLowerCase().includes(q));
        const matchR = (routines ?? []).filter((r) => !q || r.name.toLowerCase().includes(q));
        if (q && tables && matchT.length === 0 && matchR.length === 0) return null;
        const system = SYSTEM_SCHEMAS.has(schema);
        const onlyTables = matchT.filter((x) => !isView(x));
        const onlyViews = matchT.filter(isView);
        return (
          <div key={schema}>
            <div
              className={`tree-row tree-indent-${depth} ${system ? "system" : ""}`}
              onClick={() => {
                const next = !session.expanded[key];
                ws.toggleExpanded(sessKey, key, next);
                if (next && session.expanded[`${key}:tables`] === undefined) ws.toggleExpanded(sessKey, `${key}:tables`, true);
                if (!tables && !loading) void ws.loadTables(sessKey, schema);
              }}
              onContextMenu={(e) => open(e, () => schemaMenu(schema))}
            >
              <Icon name="chevronRight" size={14} className={`chev ${isOpen ? "open" : ""}`} />
              <Icon name={schemaIcon} size={14} style={{ color: "var(--text-faint)" }} />
              <span className="label">{schema}</span>
              {tables && <span className="meta">{tables.length}</span>}
            </div>
            {isOpen && (
              <div>
                {loading && !tables && (
                  <div className="tree-empty">
                    <Spinner /> {t("common.loading")}
                  </div>
                )}
                {tables && (
                  <>
                    <Folder
                      sessKey={sessKey}
                      expKey={`${key}:tables`}
                      label={t("sidebar.tables")}
                      count={onlyTables.length}
                      depth={depth + 1}
                      forceOpen={!!q}
                      defaultOpen
                      empty={t("sidebar.noTables")}
                    >
                      {onlyTables.map((tb) => (
                        <TableNode key={tb.name} conn={conn} sessKey={sessKey} table={tb} depth={depth + 2} onQuery={onQuery} />
                      ))}
                    </Folder>
                    <Folder sessKey={sessKey} expKey={`${key}:views`} label={t("sidebar.views")} count={onlyViews.length} depth={depth + 1} forceOpen={!!q} defaultOpen empty={t("sidebar.noViews")}>
                      {onlyViews.map((tb) => (
                        <TableNode key={tb.name} conn={conn} sessKey={sessKey} table={tb} depth={depth + 2} onQuery={onQuery} />
                      ))}
                    </Folder>
                    {HAS_ROUTINES.has(conn.driver) && (
                      <Folder
                        sessKey={sessKey}
                        expKey={`${key}:routines`}
                        label={t("sidebar.routines")}
                        count={routines ? matchR.length : undefined}
                        depth={depth + 1}
                        forceOpen={!!q && matchR.length > 0}
                        empty={t("sidebar.noRoutines")}
                        loading={session.expanded[`${key}:routines`] && !routines}
                        onOpen={() => {
                          if (!routines) void ws.loadRoutines(sessKey, schema);
                        }}
                      >
                        {matchR.map((r) => (
                          <RoutineNode key={`${r.name}(${r.args})`} conn={conn} sessKey={sessKey} routine={r} depth={depth + 2} />
                        ))}
                      </Folder>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* --------------------------------- folder --------------------------------- */

function Folder({
  sessKey,
  expKey,
  label,
  count,
  depth,
  forceOpen,
  defaultOpen,
  empty,
  loading,
  onOpen,
  children,
}: {
  sessKey: string;
  expKey: string;
  label: string;
  count?: number;
  depth: number;
  forceOpen?: boolean;
  /** open until the user closes it (the tables folder of an expanded schema) */
  defaultOpen?: boolean;
  empty: string;
  loading?: boolean;
  onOpen?: () => void;
  children: React.ReactNode[];
}) {
  const ws = useWorkspace();
  const expanded = ws.sessions[sessKey]?.expanded[expKey];
  const isOpen = forceOpen || (expanded ?? !!defaultOpen);
  useEffect(() => {
    if (isOpen) onOpen?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
  return (
    <div>
      <div
        className={`tree-row tree-indent-${depth} folder`}
        onClick={() => {
          ws.toggleExpanded(sessKey, expKey, !isOpen);
        }}
      >
        <Icon name="chevronRight" size={14} className={`chev ${isOpen ? "open" : ""}`} />
        <Icon name="folder" size={14} className="folder-icon" />
        <span className="label">{label}</span>
        {loading ? <Spinner /> : count !== undefined && <span className="meta">{formatNumber(count)}</span>}
      </div>
      {isOpen && !loading && (children.length ? children : <div className={`tree-empty tree-indent-${depth + 1}`}>{empty}</div>)}
    </div>
  );
}

/* ---------------------------------- table --------------------------------- */

function TableNode({ conn, sessKey, table, depth, onQuery }: { conn: ConnectionConfig; sessKey: string; table: TableInfo; depth: number; onQuery: (sql?: string) => void }) {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const toast = useWorkspace((s) => s.toast);
  const { open } = useContextMenu();
  const activeTab = ws.tabs.find((x) => x.id === ws.activeTabId);
  const isActive = activeTab?.connectionId === sessKey && activeTab.schema === table.schema && activeTab.table === table.name;
  const view = isView(table);
  const qualified = `${quoteIdent(table.schema, conn.driver)}.${quoteIdent(table.name, conn.driver)}`;

  const openData = () => ws.openTab({ kind: "table", connectionId: sessKey, title: table.name, schema: table.schema, table: table.name });
  const openStructure = () => ws.openTab({ kind: "structure", connectionId: sessKey, title: table.name, schema: table.schema, table: table.name });

  const countRows = async () => {
    try {
      const n = await api.tableCount(sessKey, { schema: table.schema, table: table.name, filters: [], limit: 1, offset: 0 });
      toast(t("ctx.rows", { name: table.name, count: formatNumber(n) }), "info");
    } catch (e) {
      toast(translateError(e), "error");
    }
  };
  const copyColumns = async () => {
    try {
      const cols = await api.tableColumns(sessKey, table.schema, table.name);
      await copyText(cols.map((c) => quoteIdent(c.name, conn.driver)).join(", "));
    } catch (e) {
      toast(translateError(e), "error");
    }
  };
  const destructive = async (kind: "truncate" | "drop") => {
    const msg = kind === "truncate" ? t("ctx.truncateConfirm", { name: qualified }) : t("ctx.dropConfirm", { name: qualified });
    if (!(await confirmDialog(msg))) return;
    try {
      await api.queryRun(sessKey, kind === "truncate" ? `TRUNCATE TABLE ${qualified}` : `DROP TABLE ${qualified}`, 1);
      toast(kind === "truncate" ? t("ctx.truncated") : t("ctx.dropped"), "success");
      if (kind === "drop") {
        ws.tabs.filter((x) => x.connectionId === sessKey && x.table === table.name && x.schema === table.schema).forEach((x) => ws.closeTab(x.id));
        void ws.loadTables(sessKey, table.schema);
      } else {
        window.dispatchEvent(new CustomEvent("osprey-refresh"));
      }
    } catch (e) {
      toast(translateError(e), "error");
    }
  };

  const menu = (): ContextMenuItem[] => [
    { label: t("ctx.openData"), icon: "table", onSelect: openData },
    { label: t("ctx.structure"), icon: "list", onSelect: openStructure },
    { label: t("ctx.newQuery"), icon: "fileCode", onSelect: () => onQuery(`SELECT *\nFROM ${qualified}\nLIMIT 100;`) },
    { label: t("ctx.countRows"), icon: "zap", onSelect: () => void countRows() },
    { separator: true },
    {
      label: t("ctx.copy"),
      icon: "copy",
      children: [
        { label: t("ctx.copyName"), onSelect: () => void copyText(table.name) },
        { label: t("ctx.copyQualified"), onSelect: () => void copyText(qualified) },
        { label: t("ctx.copySelect"), onSelect: () => void copyText(`SELECT * FROM ${qualified} LIMIT 100;`) },
        { label: t("ctx.copyColumns"), onSelect: () => void copyColumns() },
      ],
    },
    { separator: true },
    { label: t("ctx.refresh"), icon: "refresh", onSelect: () => void ws.loadTables(sessKey, table.schema) },
    ...(!view && !conn.readOnly ? ([{ label: t("import.title"), icon: "download", onSelect: () => useUi.getState().set({ importDialog: { connectionId: sessKey, schema: table.schema, table: table.name } }) }] as ContextMenuItem[]) : []),
    ...(!view && !conn.readOnly
      ? ([
          { separator: true },
          { label: t("ctx.truncate"), icon: "trash", danger: true, onSelect: () => void destructive("truncate") },
          { label: t("ctx.drop"), icon: "trash", danger: true, onSelect: () => void destructive("drop") },
        ] as ContextMenuItem[])
      : []),
  ];

  return (
    <div className={`tree-row tree-indent-${depth} ${isActive ? "active" : ""}`} onClick={openData} onContextMenu={(e) => open(e, menu)} title={table.comment ?? undefined}>
      <Icon name="chevronRight" size={14} className="chev hidden" />
      <Icon name={view ? "eye" : "table"} size={14} style={{ color: view ? "var(--purple)" : "var(--accent)" }} />
      <span className="label">{table.name}</span>
      {table.rowEstimate != null && table.rowEstimate > 0 && (
        <span className="meta" title={t("sidebar.rows", { count: table.rowEstimate })}>
          {compact(table.rowEstimate)}
        </span>
      )}
    </div>
  );
}

/* --------------------------------- routine -------------------------------- */

function RoutineNode({ conn, sessKey, routine, depth }: { conn: ConnectionConfig; sessKey: string; routine: RoutineInfo; depth: number }) {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const toast = useWorkspace((s) => s.toast);
  const { open } = useContextMenu();
  const call = routine.kind === "procedure"
    ? `CALL ${quoteIdent(routine.schema, conn.driver)}.${quoteIdent(routine.name, conn.driver)}();`
    : `SELECT ${quoteIdent(routine.schema, conn.driver)}.${quoteIdent(routine.name, conn.driver)}();`;

  const openSource = async () => {
    try {
      const sql = await api.routineDefinition(sessKey, routine.schema, routine.name, routine.args);
      ws.openTab({ kind: "query", connectionId: sessKey, title: routine.name, sql: `${sql.trimEnd()}\n` }, { reuse: false });
    } catch (e) {
      toast(translateError(e), "error");
    }
  };
  const menu = (): ContextMenuItem[] => [
    { label: t("sidebar.openRoutine"), icon: "fileCode", onSelect: () => void openSource() },
    { label: t("sidebar.callRoutine"), icon: "play", onSelect: () => ws.openTab({ kind: "query", connectionId: sessKey, title: routine.name, sql: `${call}\n` }, { reuse: false }) },
    { separator: true },
    { label: t("ctx.copyName"), icon: "copy", onSelect: () => void copyText(routine.name) },
    { label: t("ctx.refresh"), icon: "refresh", onSelect: () => void ws.loadRoutines(sessKey, routine.schema) },
  ];
  return (
    <div className={`tree-row tree-indent-${depth}`} onClick={() => void openSource()} onContextMenu={(e) => open(e, menu)} title={[routine.kind, routine.returns ? `→ ${routine.returns}` : "", routine.language ?? ""].filter(Boolean).join(" ")}>
      <Icon name="chevronRight" size={14} className="chev hidden" />
      <span className={`routine-badge ${routine.kind === "procedure" ? "proc" : ""}`}>{routine.kind === "procedure" ? "P" : "f"}</span>
      <span className="label">
        {routine.name}
        <span className="routine-args">({routine.args})</span>
      </span>
      {routine.returns && <span className="meta">{routine.returns}</span>}
    </div>
  );
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
