import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";
import ContextMenu from "@/components/molecules/ContextMenu";
import { useContextMenu } from "@/hooks/useContextMenu";
import { useUi } from "@/store/ui";
import { useWorkspace, type SessionState } from "@/store/workspace";
import * as api from "@/services/tauri";
import { translateError } from "@/i18n";
import { copyText } from "@/utils/clipboard";
import { confirmDialog } from "@/utils/dialog";
import { formatNumber, quoteIdent } from "@/utils/format";
import type { ConnectionConfig, TableInfo } from "@/types";

const DRIVER_COLOR: Record<string, string> = { postgres: "var(--pg)", mysql: "var(--mysql)", redis: "var(--redis)" };

/** Connections tree: groups → connections → databases/schemas → tables. */
export default function Sidebar() {
  const { t } = useTranslation();
  const connections = useWorkspace((s) => s.connections);
  const sessions = useWorkspace((s) => s.sessions);
  const groupsCollapsed = useWorkspace((s) => s.groupsCollapsed);
  const toggleGroup = useWorkspace((s) => s.toggleGroup);
  const openConnectionDialog = useUi((s) => s.openConnectionDialog);
  const [filter, setFilter] = useState("");
  const ctx = useContextMenu();

  const groups = useMemo(() => {
    const map = new Map<string, ConnectionConfig[]>();
    for (const c of connections) {
      const g = c.group?.trim() || "";
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(c);
    }
    return [...map.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
  }, [connections]);

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <span className="title">{t("sidebar.connections")}</span>
        <Button size="sm" icon title={t("menu.newConnection")} onClick={() => openConnectionDialog(null)}>
          <Icon name="plus" size={15} />
        </Button>
      </div>
      <div className="sidebar-search">
        <Icon name="search" size={14} />
        <input
          className="input"
          placeholder={t("sidebar.filter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="tree">
        {connections.length === 0 && (
          <div className="sidebar-empty">
            <strong>{t("sidebar.empty")}</strong>
            <span>{t("sidebar.emptyHint")}</span>
            <Button variant="primary" size="sm" onClick={() => openConnectionDialog(null)}>
              <Icon name="plus" size={14} /> {t("menu.newConnection")}
            </Button>
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
              list.map((c) => (
                <ConnectionNode key={c.id} conn={c} session={sessions[c.id]} filter={filter} ctx={ctx} />
              ))}
          </div>
        ))}
      </div>
      <ContextMenu menu={ctx.menu} onClose={ctx.close} />
    </div>
  );
}

function ConnectionNode({
  conn,
  session,
  filter,
  ctx,
}: {
  conn: ConnectionConfig;
  session?: SessionState;
  filter: string;
  ctx: ReturnType<typeof useContextMenu>;
}) {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const openConnectionDialog = useUi((s) => s.openConnectionDialog);
  const status = session?.status;
  const open = status === "open";
  const expanded = open && session?.expanded.root !== false;
  const activeTab = ws.tabs.find((x) => x.id === ws.activeTabId);

  const onClick = () => {
    if (!session) {
      void ws.connect(conn.id);
    } else if (status === "open") {
      ws.toggleExpanded(conn.id, "root");
    } else if (status === "error") {
      void ws.connect(conn.id);
    }
  };

  const onContext = (e: React.MouseEvent) => {
    ctx.open(e, [
      open
        ? { label: t("sidebar.disconnect"), icon: "unplug", action: () => void ws.disconnect(conn.id) }
        : { label: t("sidebar.connect"), icon: "plug", action: () => void ws.connect(conn.id) },
      ...(open && conn.driver !== "redis"
        ? [{ label: t("menu.newQuery"), icon: "fileCode" as const, action: () => openQuery(conn) }]
        : []),
      ...(open && conn.driver === "redis"
        ? [
            { label: t("sidebar.console"), icon: "terminal" as const, action: () => openRedis(conn, "console") },
            { label: t("sidebar.info"), icon: "info" as const, action: () => openRedis(conn, "info") },
          ]
        : []),
      { sep: true },
      { label: t("sidebar.editConnection"), icon: "pencil", action: () => openConnectionDialog(conn) },
      { label: t("sidebar.duplicate"), icon: "copy", action: () => openConnectionDialog(conn, true) },
      { sep: true },
      {
        label: t("sidebar.deleteConnection"),
        icon: "trash",
        danger: true,
        action: async () => {
          if (await confirmDialog(t("sidebar.deleteConfirm", { name: conn.name }))) {
            try {
              await api.connectionDelete(conn.id);
              await ws.disconnect(conn.id);
              await ws.loadConnections();
            } catch (e) {
              ws.toast(translateError(e), "error");
            }
          }
        },
      },
    ]);
  };

  const openQuery = (c: ConnectionConfig, sql?: string) => {
    ws.openTab({ kind: "query", connectionId: c.id, title: t("tabs.query"), sql: sql ?? "" }, { reuse: false });
  };
  const openRedis = (c: ConnectionConfig, kind: "redis" | "console" | "info") => {
    ws.openTab({
      kind,
      connectionId: c.id,
      title: kind === "redis" ? t("tabs.keys") : kind === "console" ? t("tabs.console") : t("tabs.info"),
    });
  };

  return (
    <div>
      <div
        className={`tree-row conn ${activeTab?.connectionId === conn.id ? "active" : ""}`}
        onClick={onClick}
        onContextMenu={onContext}
        title={`${conn.user ? conn.user + "@" : ""}${conn.host}:${conn.port}`}
      >
        <Icon name="chevronRight" size={14} className={`chev ${expanded ? "open" : ""} ${open ? "" : "hidden"}`} />
        <span className="dot" style={{ background: conn.color || DRIVER_COLOR[conn.driver] }} />
        <span className="label">{conn.name}</span>
        {conn.readOnly && <Icon name="eye" size={12} className="meta" />}
        {status === "connecting" ? <span className="spinner" /> : <span className={`status ${status ?? ""}`} />}
      </div>
      {expanded && session && (conn.driver === "redis" ? (
        <RedisNodes conn={conn} session={session} onOpen={openRedis} />
      ) : (
        <SqlNodes conn={conn} session={session} filter={filter} ctx={ctx} onQuery={openQuery} />
      ))}
      {status === "error" && session?.error && (
        <div className="tree-empty" style={{ color: "var(--red)" }}>
          {session.error}
        </div>
      )}
    </div>
  );
}

function RedisNodes({
  conn,
  session,
  onOpen,
}: {
  conn: ConnectionConfig;
  session: SessionState;
  onOpen: (c: ConnectionConfig, kind: "redis" | "console" | "info") => void;
}) {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const dbs = session.databases ?? Array.from({ length: 16 }, (_, i) => String(i));
  return (
    <div>
      <div className="db-switch">
        <Icon name="database" size={13} style={{ color: "var(--text-faint)" }} />
        <select
          className="select"
          value={session.database ?? "0"}
          onChange={(e) => void ws.connect(conn.id, e.target.value)}
          title={t("sidebar.switchDatabase")}
        >
          {dbs.map((d) => (
            <option key={d} value={d}>
              {t("redis.database", { n: d })}
            </option>
          ))}
        </select>
      </div>
      <div className="tree-row tree-indent-1" onClick={() => onOpen(conn, "redis")}>
        <Icon name="keyRound" size={14} style={{ color: "var(--redis)" }} />
        <span className="label">{t("sidebar.keys")}</span>
        {typeof session.info?.extra?.keys === "number" && (
          <span className="meta">{formatNumber(session.info.extra.keys as number)}</span>
        )}
      </div>
      <div className="tree-row tree-indent-1" onClick={() => onOpen(conn, "console")}>
        <Icon name="terminal" size={14} style={{ color: "var(--text-faint)" }} />
        <span className="label">{t("sidebar.console")}</span>
      </div>
      <div className="tree-row tree-indent-1" onClick={() => onOpen(conn, "info")}>
        <Icon name="info" size={14} style={{ color: "var(--text-faint)" }} />
        <span className="label">{t("sidebar.info")}</span>
      </div>
    </div>
  );
}

function SqlNodes({
  conn,
  session,
  filter,
  ctx,
  onQuery,
}: {
  conn: ConnectionConfig;
  session: SessionState;
  filter: string;
  ctx: ReturnType<typeof useContextMenu>;
  onQuery: (c: ConnectionConfig, sql?: string) => void;
}) {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const schemas = session.schemas ?? [];
  const q = filter.trim().toLowerCase();

  return (
    <div>
      {conn.driver === "postgres" && session.databases && session.databases.length > 1 && (
        <div className="db-switch">
          <Icon name="database" size={13} style={{ color: "var(--text-faint)" }} />
          <select
            className="select"
            value={session.database ?? ""}
            onChange={(e) => void ws.connect(conn.id, e.target.value)}
            title={t("sidebar.switchDatabase")}
          >
            {session.databases.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
      )}
      {!session.schemas && (
        <div className="tree-empty">
          <span className="spinner" style={{ display: "inline-block", verticalAlign: "middle", marginRight: 6 }} />
          {t("common.loading")}
        </div>
      )}
      {schemas.map((schema) => {
        const key = `schema:${schema}`;
        const isOpen = !!session.expanded[key] || !!q;
        const tables = session.tables[schema];
        const loading = session.loadingTables[schema];
        const visible = (tables ?? []).filter((tb) => !q || tb.name.toLowerCase().includes(q));
        if (q && tables && visible.length === 0) return null;
        return (
          <div key={schema}>
            <div
              className="tree-row tree-indent-1"
              onClick={() => {
                ws.toggleExpanded(conn.id, key);
                if (!tables && !loading) void ws.loadTables(conn.id, schema);
              }}
              onContextMenu={(e) =>
                ctx.open(e, [
                  { label: t("common.refresh"), icon: "refresh", action: () => void ws.loadTables(conn.id, schema) },
                  { label: t("sidebar.copyName"), icon: "copy", action: () => void copyText(schema) },
                ])
              }
            >
              <Icon name="chevronRight" size={14} className={`chev ${isOpen ? "open" : ""}`} />
              <Icon name="layers" size={14} style={{ color: "var(--text-faint)" }} />
              <span className="label">{schema}</span>
              {tables && <span className="meta">{tables.length}</span>}
            </div>
            {isOpen && (
              <div>
                {loading && !tables && <div className="tree-empty">{t("common.loading")}</div>}
                {tables && tables.length === 0 && <div className="tree-empty">{t("sidebar.noTables")}</div>}
                {q && !tables && !loading && (
                  <LoadOnFilter onLoad={() => void ws.loadTables(conn.id, schema)} />
                )}
                {visible.map((tb) => (
                  <TableNode key={tb.name} conn={conn} table={tb} ctx={ctx} onQuery={onQuery} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function LoadOnFilter({ onLoad }: { onLoad: () => void }) {
  // when the user filters, load schemas that were never expanded
  useMemo(() => {
    onLoad();
    return null;
  }, [onLoad]);
  return null;
}

function TableNode({
  conn,
  table,
  ctx,
  onQuery,
}: {
  conn: ConnectionConfig;
  table: TableInfo;
  ctx: ReturnType<typeof useContextMenu>;
  onQuery: (c: ConnectionConfig, sql?: string) => void;
}) {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const activeTab = ws.tabs.find((x) => x.id === ws.activeTabId);
  const isActive =
    activeTab?.connectionId === conn.id && activeTab.schema === table.schema && activeTab.table === table.name;
  const openData = () =>
    ws.openTab({ kind: "table", connectionId: conn.id, title: table.name, schema: table.schema, table: table.name });
  const openStructure = () =>
    ws.openTab({
      kind: "structure",
      connectionId: conn.id,
      title: table.name,
      schema: table.schema,
      table: table.name,
    });
  const qualified = `${quoteIdent(table.schema, conn.driver)}.${quoteIdent(table.name, conn.driver)}`;
  const isView = table.kind !== "table" && table.kind !== "partitioned";
  return (
    <div
      className={`tree-row tree-indent-2 ${isActive ? "active" : ""}`}
      onClick={openData}
      onContextMenu={(e) =>
        ctx.open(e, [
          { label: t("sidebar.openTable"), icon: "table", action: openData },
          { label: t("sidebar.openStructure"), icon: "list", action: openStructure },
          { label: t("sidebar.queryTable"), icon: "fileCode", action: () => onQuery(conn, `SELECT *\nFROM ${qualified}\nLIMIT 100;`) },
          { sep: true },
          { label: t("sidebar.copyName"), icon: "copy", action: () => void copyText(qualified) },
        ])
      }
      title={table.comment ?? undefined}
    >
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
