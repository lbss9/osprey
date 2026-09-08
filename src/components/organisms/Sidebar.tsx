import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "@/components/atoms/Icon";
import Input from "@/components/atoms/Input";
import Spinner from "@/components/atoms/Spinner";
import Dropdown from "@/components/molecules/Dropdown";
import ToolButton from "@/components/molecules/ToolButton";
import SqlTree from "@/components/organisms/SidebarTree";
import { useContextMenu, type ContextMenuItem } from "@/components/molecules/ContextMenu";
import { useUi } from "@/store/ui";
import { useWorkspace, type SessionState } from "@/store/workspace";
import * as api from "@/services/tauri";
import { translateError } from "@/i18n";
import { copyText } from "@/utils/clipboard";
import { confirmDialog } from "@/utils/dialog";
import { formatNumber, modKey } from "@/utils/format";
import { connectionIdOf } from "@/utils/session";
import type { ConnectionConfig } from "@/types";

const DRIVER_COLOR: Record<string, string> = { postgres: "var(--pg)", mysql: "var(--mysql)", redis: "var(--redis)", sqlite: "var(--sqlite)", clickhouse: "var(--clickhouse)", mssql: "var(--mssql)" };

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
  const activeConnId = activeTab ? connectionIdOf(activeTab.connectionId) : undefined;
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
        className={`tree-row conn ${activeConnId === conn.id ? "active" : ""} ${dragOver ? "drag-over" : ""}`}
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
      {expanded && session && (isRedis ? <RedisNodes conn={conn} session={session} onOpen={openRedis} /> : <SqlTree conn={conn} session={session} filter={filter} onQuery={openQuery} />)}
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
