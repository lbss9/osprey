import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "@/components/atoms/Icon";
import Input from "@/components/atoms/Input";
import Spinner from "@/components/atoms/Spinner";
import Dropdown from "@/components/molecules/Dropdown";
import ToolButton from "@/components/molecules/ToolButton";
import { useContextMenu, type ContextMenuItem } from "@/components/molecules/ContextMenu";
import { useUi } from "@/store/ui";
import { useWorkspace, type SessionState } from "@/store/workspace";
import * as api from "@/services/tauri";
import { translateError } from "@/i18n";
import { copyText } from "@/utils/clipboard";
import { confirmDialog } from "@/utils/dialog";
import { formatNumber, quoteIdent, modKey } from "@/utils/format";
import type { ConnectionConfig, TableInfo } from "@/types";

const DRIVER_COLOR: Record<string, string> = { postgres: "var(--pg)", mysql: "var(--mysql)", redis: "var(--redis)", sqlite: "var(--sqlite)" };

function connectionUrl(c: ConnectionConfig): string {
  if (c.driver === "sqlite") return `sqlite:///${c.database}`;
  const scheme = c.driver === "postgres" ? "postgresql" : c.driver;
  const auth = c.user ? `${encodeURIComponent(c.user)}@` : "";
  return `${scheme}://${auth}${c.host}:${c.port}${c.database ? `/${c.database}` : ""}`;
}

/** Connections tree: groups → connections → databases/schemas → tables. */
export default function Sidebar() {
  const { t } = useTranslation();
  const connections = useWorkspace((s) => s.connections);
  const sessions = useWorkspace((s) => s.sessions);
  const groupsCollapsed = useWorkspace((s) => s.groupsCollapsed);
  const toggleGroup = useWorkspace((s) => s.toggleGroup);
  const reloadAllSchemas = useWorkspace((s) => s.reloadAllSchemas);
  const openConnectionDialog = useUi((s) => s.openConnectionDialog);
  const showSystem = useUi((s) => s.showSystemObjects);
  const setUi = useUi((s) => s.set);
  const [filter, setFilter] = useState("");
  const { open } = useContextMenu();

  const groups = useMemo(() => {
    const map = new Map<string, ConnectionConfig[]>();
    for (const c of connections) {
      const g = c.group?.trim() || "";
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(c);
    }
    return [...map.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
  }, [connections]);

  const toggleSystem = () => {
    setUi({ showSystemObjects: !showSystem });
    void reloadAllSchemas();
  };

  const emptyMenu = (): ContextMenuItem[] => [
    { label: t("ctx.newConnection"), icon: "plus", shortcut: `${modKey}+N`, onSelect: () => openConnectionDialog(null) },
    { label: t("ctx.refreshAll"), icon: "refresh", onSelect: () => void reloadAllSchemas() },
    { separator: true },
    { label: t("ctx.showSystem"), checked: showSystem, onSelect: toggleSystem },
  ];

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <span className="title">{t("sidebar.connections")}</span>
        <ToolButton icon="plus" title={`${t("menu.newConnection")} (${modKey}+N)`} onClick={() => openConnectionDialog(null)} />
      </div>
      <div className="sidebar-search">
        <Icon name="search" size={14} />
        <Input placeholder={t("sidebar.filter")} value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="tree" onContextMenu={(e) => open(e, emptyMenu)}>
        {connections.length === 0 && (
          <div className="sidebar-empty">
            <strong>{t("sidebar.empty")}</strong>
            <span>{t("sidebar.emptyHint")}</span>
          </div>
        )}
        {groups.map(([name, list]) => (
          <div key={name || "__none"}>
            {name && (
              <div className="tree-group" onClick={() => toggleGroup(name)}>
                <Icon name="chevronRight" size={12} className={`chev ${groupsCollapsed[name] ? "" : "open"}`} />
                {name}
              </div>
            )}
            {(!name || !groupsCollapsed[name]) &&
              list.map((c) => <ConnectionNode key={c.id} conn={c} session={sessions[c.id]} filter={filter} onToggleSystem={toggleSystem} />)}
            {(!name || !groupsCollapsed[name]) && <DropTail group={name} />}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------- connection ------------------------------- */

const DRAG_MIME = "application/x-osprey-connection";

/** Drop zone after the last connection of a group (moves to the end). */
function DropTail({ group }: { group: string }) {
  const reorder = useWorkspace((s) => s.reorderConnections);
  const [over, setOver] = useState(false);
  return (
    <div
      className={`drop-tail ${over ? "over" : ""}`}
      data-group={group}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData(DRAG_MIME);
        if (id) void reorder(id, null);
      }}
    />
  );
}

function ConnectionNode({
  conn,
  session,
  filter,
  onToggleSystem,
}: {
  conn: ConnectionConfig;
  session?: SessionState;
  filter: string;
  onToggleSystem: () => void;
}) {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const openConnectionDialog = useUi((s) => s.openConnectionDialog);
  const showSystem = useUi((s) => s.showSystemObjects);
  const toast = useWorkspace((s) => s.toast);
  const { open } = useContextMenu();
  const [dragOver, setDragOver] = useState(false);
  const status = session?.status;
  const isOpen = status === "open";
  const expanded = isOpen && session?.expanded.root !== false;
  const activeTab = ws.tabs.find((x) => x.id === ws.activeTabId);
  const isRedis = conn.driver === "redis";

  const onClick = () => {
    if (!session || status === "error") void ws.connect(conn.id);
    else if (status === "open") ws.toggleExpanded(conn.id, "root");
  };

  const openQuery = (sql?: string) =>
    ws.openTab({ kind: "query", connectionId: conn.id, title: t("tabs.query"), sql: sql ?? "" }, { reuse: false });
  const openRedis = (kind: "redis" | "console" | "info" | "tools") =>
    ws.openTab({ kind, connectionId: conn.id, title: kind === "redis" ? t("tabs.keys") : kind === "console" ? t("tabs.console") : kind === "tools" ? t("redisTools.title") : t("tabs.info") });

  const remove = async () => {
    if (!(await confirmDialog(t("sidebar.deleteConfirm", { name: conn.name })))) return;
    try {
      await api.connectionDelete(conn.id);
      await ws.disconnect(conn.id);
      await ws.loadConnections();
    } catch (e) {
      toast(translateError(e), "error");
    }
  };

  const menu = (): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    if (isOpen) {
      items.push(
        { label: t("ctx.disconnect"), icon: "unplug", onSelect: () => void ws.disconnect(conn.id) },
        { label: t("ctx.reconnect"), icon: "plugZap", onSelect: () => void ws.reconnect(conn.id) },
        { label: t("ctx.refresh"), icon: "refresh", shortcut: `${modKey}+R`, onSelect: () => void ws.reconnect(conn.id) },
        { separator: true },
      );
      if (isRedis) {
        items.push(
          { label: t("ctx.openKeys"), icon: "keyRound", onSelect: () => openRedis("redis") },
          { label: t("ctx.openConsole"), icon: "terminal", onSelect: () => openRedis("console") },
          { label: t("ctx.openInfo"), icon: "info", onSelect: () => openRedis("info") },
          { label: t("redisTools.title"), icon: "zap", onSelect: () => openRedis("tools") },
        );
      } else {
        items.push(
          { label: t("ctx.newQuery"), icon: "fileCode", shortcut: `${modKey}+T`, onSelect: () => openQuery() },
          { label: t("ctx.openInfo"), icon: "info", onSelect: () => ws.openTab({ kind: "info", connectionId: conn.id, title: t("tabs.info") }) },
          { label: t("ctx.showSystem"), checked: showSystem, onSelect: onToggleSystem },
        );
      }
      items.push({ separator: true });
    } else {
      items.push({ label: t("ctx.connect"), icon: "plug", onSelect: () => void ws.connect(conn.id) }, { separator: true });
    }
    items.push(
      {
        label: t("ctx.copy"),
        icon: "copy",
        children: [
          { label: t("ctx.copyName"), onSelect: () => void copyText(conn.name) },
          { label: t("ctx.copyHost"), onSelect: () => void copyText(`${conn.host}:${conn.port}`) },
          { label: t("ctx.copyUrl"), onSelect: () => void copyText(connectionUrl(conn)) },
        ],
      },
      { separator: true },
      { label: t("ctx.properties"), icon: "settings", onSelect: () => openConnectionDialog(conn) },
      { label: t("ctx.duplicate"), icon: "copy", onSelect: () => openConnectionDialog(conn, true) },
      { separator: true },
      { label: t("ctx.delete"), icon: "trash", danger: true, onSelect: () => void remove() },
    );
    return items;
  };

  return (
    <div>
      <div
        className={`tree-row conn ${activeTab?.connectionId === conn.id ? "active" : ""} ${dragOver ? "drag-over" : ""}`}
        onClick={onClick}
        onDoubleClick={() => openConnectionDialog(conn)}
        onContextMenu={(e) => open(e, menu)}
        title={`${conn.user ? conn.user + "@" : ""}${conn.host}:${conn.port}`}
        draggable
        data-conn-id={conn.id}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_MIME, conn.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const id = e.dataTransfer.getData(DRAG_MIME);
          if (id && id !== conn.id) void ws.reorderConnections(id, conn.id);
        }}
      >
        <Icon name="chevronRight" size={14} className={`chev ${expanded ? "open" : ""} ${isOpen ? "" : "hidden"}`} />
        <span className="dot" style={{ background: conn.color || DRIVER_COLOR[conn.driver] }} />
        <span className="label">{conn.name}</span>
        {conn.readOnly && <Icon name="eye" size={12} className="meta" />}
        {status === "connecting" ? <Spinner /> : <span className={`status ${status ?? ""}`} />}
      </div>
      {expanded && session && (isRedis ? <RedisNodes conn={conn} session={session} onOpen={openRedis} /> : <SqlNodes conn={conn} session={session} filter={filter} onQuery={openQuery} />)}
      {status === "error" && session?.error && (
        <div className="tree-empty" style={{ color: "var(--red)" }}>
          {session.error}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------- redis --------------------------------- */

function RedisNodes({ conn, session, onOpen }: { conn: ConnectionConfig; session: SessionState; onOpen: (kind: "redis" | "console" | "info" | "tools") => void }) {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const dbs = session.databases ?? Array.from({ length: 16 }, (_, i) => String(i));
  return (
    <div>
      <div className="db-switch">
        <Icon name="database" size={13} style={{ color: "var(--text-faint)" }} />
        <Dropdown
          size="sm"
          value={session.database ?? "0"}
          options={dbs.map((d) => ({ value: d, label: t("redis.database", { n: d }) }))}
          onChange={(v) => void ws.connect(conn.id, v)}
          title={t("sidebar.switchDatabase")}
          className="db-dd"
        />
      </div>
      <div className="tree-row tree-indent-1" onClick={() => onOpen("redis")}>
        <Icon name="keyRound" size={14} style={{ color: "var(--redis)" }} />
        <span className="label">{t("sidebar.keys")}</span>
        {typeof session.info?.extra?.keys === "number" && <span className="meta">{formatNumber(session.info.extra.keys as number)}</span>}
      </div>
      <div className="tree-row tree-indent-1" onClick={() => onOpen("console")}>
        <Icon name="terminal" size={14} style={{ color: "var(--text-faint)" }} />
        <span className="label">{t("sidebar.console")}</span>
      </div>
      <div className="tree-row tree-indent-1" onClick={() => onOpen("info")}>
        <Icon name="info" size={14} style={{ color: "var(--text-faint)" }} />
        <span className="label">{t("sidebar.info")}</span>
      </div>
      <div className="tree-row tree-indent-1" onClick={() => onOpen("tools")}>
        <Icon name="zap" size={14} style={{ color: "var(--text-faint)" }} />
        <span className="label">{t("redisTools.title")}</span>
      </div>
    </div>
  );
}

/* ----------------------------------- sql ---------------------------------- */

const SYSTEM_SCHEMAS = new Set(["pg_catalog", "information_schema", "pg_toast", "mysql", "sys", "performance_schema"]);

function SqlNodes({ conn, session, filter, onQuery }: { conn: ConnectionConfig; session: SessionState; filter: string; onQuery: (sql?: string) => void }) {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const { open } = useContextMenu();
  const schemas = session.schemas ?? [];
  const q = filter.trim().toLowerCase();

  // while filtering, load every schema that was never expanded
  useEffect(() => {
    if (!q) return;
    for (const schema of schemas) {
      if (!session.tables[schema] && !session.loadingTables[schema]) void ws.loadTables(conn.id, schema);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, schemas.length]);

  const setUi = useUi((s) => s.set);
  const schemaMenu = (schema: string): ContextMenuItem[] => [
    ...(!conn.readOnly
      ? [
          { label: t("ddl.createTable"), icon: "plus" as const, onSelect: () => setUi({ ddlDialog: { connectionId: conn.id, schema, mode: "createTable" } }) },
          { label: t("import.newTable"), icon: "download" as const, onSelect: () => setUi({ importDialog: { connectionId: conn.id, schema } }) },
        ]
      : []),
    { label: t("ctx.refresh"), icon: "refresh", onSelect: () => void ws.loadTables(conn.id, schema) },
    { label: t("diagram.title"), icon: "tree", onSelect: () => ws.openTab({ kind: "diagram", connectionId: conn.id, schema, title: `${schema} · ${t("diagram.short")}` }) },
    { label: t("ctx.querySchema"), icon: "fileCode", onSelect: () => onQuery(conn.driver === "postgres" ? `SET search_path TO ${quoteIdent(schema, conn.driver)};\n` : `USE ${quoteIdent(schema, conn.driver)};\n`) },
    { separator: true },
    { label: t("ctx.copyName"), icon: "copy", onSelect: () => void copyText(schema) },
    { separator: true },
    { label: t("ctx.collapseAll"), onSelect: () => schemas.forEach((s) => ws.toggleExpanded(conn.id, `schema:${s}`, false)) },
    { label: t("ctx.expandAll"), onSelect: () => schemas.forEach((s) => { ws.toggleExpanded(conn.id, `schema:${s}`, true); if (!session.tables[s]) void ws.loadTables(conn.id, s); }) },
  ];

  return (
    <div>
      {conn.driver === "postgres" && session.databases && session.databases.length > 1 && (
        <div className="db-switch">
          <Icon name="database" size={13} style={{ color: "var(--text-faint)" }} />
          <Dropdown
            size="sm"
            value={session.database ?? ""}
            options={session.databases.map((d) => ({ value: d, label: d }))}
            onChange={(v) => void ws.connect(conn.id, v)}
            title={t("sidebar.switchDatabase")}
            className="db-dd"
          />
        </div>
      )}
      {!session.schemas && (
        <div className="tree-empty">
          <Spinner /> {t("common.loading")}
        </div>
      )}
      {schemas.map((schema) => {
        const key = `schema:${schema}`;
        const isOpen = !!session.expanded[key] || !!q;
        const tables = session.tables[schema];
        const loading = session.loadingTables[schema];
        const visible = (tables ?? []).filter((tb) => !q || tb.name.toLowerCase().includes(q));
        if (q && tables && visible.length === 0) return null;
        const system = SYSTEM_SCHEMAS.has(schema);
        return (
          <div key={schema}>
            <div
              className={`tree-row tree-indent-1 ${system ? "system" : ""}`}
              onClick={() => {
                ws.toggleExpanded(conn.id, key);
                if (!tables && !loading) void ws.loadTables(conn.id, schema);
              }}
              onContextMenu={(e) => open(e, () => schemaMenu(schema))}
            >
              <Icon name="chevronRight" size={14} className={`chev ${isOpen ? "open" : ""}`} />
              <Icon name="layers" size={14} style={{ color: "var(--text-faint)" }} />
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
                {tables && tables.length === 0 && <div className="tree-empty">{t("sidebar.noTables")}</div>}
                {visible.map((tb) => (
                  <TableNode key={tb.name} conn={conn} table={tb} onQuery={onQuery} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TableNode({ conn, table, onQuery }: { conn: ConnectionConfig; table: TableInfo; onQuery: (sql?: string) => void }) {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const toast = useWorkspace((s) => s.toast);
  const { open } = useContextMenu();
  const activeTab = ws.tabs.find((x) => x.id === ws.activeTabId);
  const isActive = activeTab?.connectionId === conn.id && activeTab.schema === table.schema && activeTab.table === table.name;
  const isView = table.kind !== "table" && table.kind !== "partitioned";
  const qualified = `${quoteIdent(table.schema, conn.driver)}.${quoteIdent(table.name, conn.driver)}`;

  const openData = () => ws.openTab({ kind: "table", connectionId: conn.id, title: table.name, schema: table.schema, table: table.name });
  const openStructure = () => ws.openTab({ kind: "structure", connectionId: conn.id, title: table.name, schema: table.schema, table: table.name });

  const countRows = async () => {
    try {
      const n = await api.tableCount(conn.id, { schema: table.schema, table: table.name, filters: [], limit: 1, offset: 0 });
      toast(t("ctx.rows", { name: table.name, count: formatNumber(n) }), "info");
    } catch (e) {
      toast(translateError(e), "error");
    }
  };
  const copyColumns = async () => {
    try {
      const cols = await api.tableColumns(conn.id, table.schema, table.name);
      await copyText(cols.map((c) => quoteIdent(c.name, conn.driver)).join(", "));
    } catch (e) {
      toast(translateError(e), "error");
    }
  };
  const destructive = async (kind: "truncate" | "drop") => {
    const msg = kind === "truncate" ? t("ctx.truncateConfirm", { name: qualified }) : t("ctx.dropConfirm", { name: qualified });
    if (!(await confirmDialog(msg))) return;
    try {
      await api.queryRun(conn.id, kind === "truncate" ? `TRUNCATE TABLE ${qualified}` : `DROP TABLE ${qualified}`, 1);
      toast(kind === "truncate" ? t("ctx.truncated") : t("ctx.dropped"), "success");
      if (kind === "drop") {
        ws.tabs.filter((x) => x.connectionId === conn.id && x.table === table.name && x.schema === table.schema).forEach((x) => ws.closeTab(x.id));
        void ws.loadTables(conn.id, table.schema);
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
    { label: t("ctx.refresh"), icon: "refresh", onSelect: () => void ws.loadTables(conn.id, table.schema) },
    ...(!isView && !conn.readOnly ? ([{ label: t("import.title"), icon: "download", onSelect: () => useUi.getState().set({ importDialog: { connectionId: conn.id, schema: table.schema, table: table.name } }) }] as ContextMenuItem[]) : []),
    ...(!isView && !conn.readOnly
      ? ([
          { separator: true },
          { label: t("ctx.truncate"), icon: "trash", danger: true, onSelect: () => void destructive("truncate") },
          { label: t("ctx.drop"), icon: "trash", danger: true, onSelect: () => void destructive("drop") },
        ] as ContextMenuItem[])
      : []),
  ];

  return (
    <div className={`tree-row tree-indent-2 ${isActive ? "active" : ""}`} onClick={openData} onContextMenu={(e) => open(e, menu)} title={table.comment ?? undefined}>
      <Icon name="chevronRight" size={14} className="chev hidden" />
      <Icon name={isView ? "eye" : "table"} size={14} style={{ color: isView ? "var(--purple)" : "var(--accent)" }} />
      <span className="label">{table.name}</span>
      {table.rowEstimate != null && table.rowEstimate > 0 && (
        <span className="meta" title={t("sidebar.rows", { count: table.rowEstimate })}>
          {compact(table.rowEstimate)}
        </span>
      )}
    </div>
  );
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
