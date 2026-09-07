/**
 * Workspace state: saved connections, live sessions with their schema
 * cache, open tabs and toasts. Every server call goes through
 * `services/tauri.ts`; this store only orchestrates.
 */
import { create } from "zustand";
import * as api from "@/services/tauri";
import { translateError } from "@/i18n";
import { useUi } from "@/store/ui";
import type { ConnectionConfig, ServerInfo, Tab, TabKind, TableInfo } from "@/types";

export type SessionStatus = "connecting" | "open" | "error";

export interface SessionState {
  status: SessionStatus;
  info?: ServerInfo;
  error?: string;
  /** current database (PG database / MySQL default schema / Redis db index) */
  database?: string;
  databases?: string[];
  schemas?: string[];
  tables: Record<string, TableInfo[] | undefined>;
  /** schema → table → column names (autocompletion); loaded on demand */
  columns: Record<string, Record<string, string[]> | undefined>;
  loadingTables: Record<string, boolean>;
  expanded: Record<string, boolean>;
}

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
}

interface WorkspaceState {
  connections: ConnectionConfig[];
  sessions: Record<string, SessionState>;
  tabs: Tab[];
  activeTabId: string | null;
  toasts: Toast[];
  /** name → expanded flag for connection groups in the sidebar */
  groupsCollapsed: Record<string, boolean>;

  loadConnections: () => Promise<void>;
  /** move connection `id` before `beforeId` (or to the end) and persist the order */
  reorderConnections: (id: string, beforeId: string | null) => Promise<void>;
  connect: (id: string, database?: string) => Promise<boolean>;
  disconnect: (id: string) => Promise<void>;
  loadSchemas: (id: string) => Promise<void>;
  /** re-read databases/schemas/tables of every open session (after a preference change) */
  reloadAllSchemas: () => Promise<void>;
  reconnect: (id: string) => Promise<boolean>;
  loadTables: (id: string, schema: string) => Promise<void>;
  /** column names of every table in a schema, cached until the schema is refreshed */
  loadSchemaColumns: (id: string, schema: string) => Promise<void>;
  toggleExpanded: (id: string, key: string, value?: boolean) => void;
  toggleGroup: (name: string) => void;

  openTab: (tab: Omit<Tab, "id"> & { id?: string }, opts?: { reuse?: boolean }) => string;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  closeAllTabs: () => void;
  closeTabsFor: (connectionId: string) => void;
  setActiveTab: (id: string) => void;
  updateTab: (id: string, patch: Partial<Tab>) => void;
  moveTab: (from: number, to: number) => void;

  toast: (text: string, kind?: Toast["kind"]) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 1;
let tabSeq = 1;

export const useWorkspace = create<WorkspaceState>()((set, get) => ({
  connections: [],
  sessions: {},
  tabs: [],
  activeTabId: null,
  toasts: [],
  groupsCollapsed: {},

  loadConnections: async () => {
    try {
      const connections = await api.connectionsList();
      set({ connections });
    } catch (e) {
      get().toast(translateError(e), "error");
    }
  },

  loadSchemaColumns: async (id, schema) => {
    if (get().sessions[id]?.columns?.[schema]) return;
    try {
      const list = await api.schemaColumns(id, schema);
      const map: Record<string, string[]> = {};
      for (const t of list) map[t.table] = t.columns.map((c) => c.name);
      set((s) => ({
        sessions: { ...s.sessions, [id]: { ...s.sessions[id], columns: { ...s.sessions[id].columns, [schema]: map } } },
      }));
    } catch {
      // autocompletion only; the editor keeps table names
    }
  },

  reorderConnections: async (id, beforeId) => {
    const list = get().connections.filter((c) => c.id !== id);
    const moving = get().connections.find((c) => c.id === id);
    if (!moving || id === beforeId) return;
    const at = beforeId ? list.findIndex((c) => c.id === beforeId) : list.length;
    list.splice(at < 0 ? list.length : at, 0, moving);
    const connections = list.map((c, position) => ({ ...c, position }));
    set({ connections });
    try {
      await api.connectionsReorder(connections.map((c) => c.id));
    } catch (e) {
      get().toast(translateError(e), "error");
    }
  },

  connect: async (id, database) => {
    set((s) => ({
      sessions: {
        ...s.sessions,
        [id]: {
          status: "connecting",
          tables: {},
          columns: {},
          loadingTables: {},
          expanded: s.sessions[id]?.expanded ?? {},
        },
      },
    }));
    try {
      const info = await api.sessionOpen(id, database);
      set((s) => ({
        sessions: {
          ...s.sessions,
          [id]: {
            ...s.sessions[id],
            status: "open",
            info,
            error: undefined,
            database: info.database ?? database ?? undefined,
            schemas: undefined,
            tables: {},
          columns: {},
            expanded: { root: true, ...(database ? {} : s.sessions[id]?.expanded ?? {}) },
          },
        },
      }));
      // fetch the tree lazily but right away so the sidebar fills in
      const conn = get().connections.find((c) => c.id === id);
      if (conn?.driver !== "redis") {
        void get().loadSchemas(id);
      } else {
        try {
          const databases = await api.schemaDatabases(id, useUi.getState().showSystemObjects);
          set((s) => ({ sessions: { ...s.sessions, [id]: { ...s.sessions[id], databases } } }));
        } catch {
          /* CONFIG may be disabled; keep the default list */
        }
      }
      return true;
    } catch (e) {
      const error = translateError(e);
      set((s) => ({
        sessions: { ...s.sessions, [id]: { ...s.sessions[id], status: "error", error } },
      }));
      get().toast(error, "error");
      return false;
    }
  },

  disconnect: async (id) => {
    try {
      await api.sessionClose(id);
    } catch {
      /* already gone */
    }
    get().closeTabsFor(id);
    set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[id];
      return { sessions };
    });
  },

  loadSchemas: async (id) => {
    try {
      const includeSystem = useUi.getState().showSystemObjects;
      const [schemas, databases] = await Promise.all([
        api.schemaList(id, includeSystem),
        api.schemaDatabases(id, includeSystem).catch(() => [] as string[]),
      ]);
      set((s) => {
        const prev = s.sessions[id];
        if (!prev) return {};
        const expanded = { ...prev.expanded };
        // auto-expand the first schema so a fresh connection shows tables
        if (schemas.length && !Object.keys(expanded).some((k) => k.startsWith("schema:"))) {
          expanded[`schema:${schemas[0]}`] = true;
        }
        return { sessions: { ...s.sessions, [id]: { ...prev, schemas, databases, expanded } } };
      });
      const first = schemas[0];
      if (first && get().sessions[id]?.expanded[`schema:${first}`]) {
        void get().loadTables(id, first);
      }
    } catch (e) {
      get().toast(translateError(e), "error");
    }
  },

  reloadAllSchemas: async () => {
    const { sessions, connections } = get();
    for (const [id, sess] of Object.entries(sessions)) {
      if (sess.status !== "open") continue;
      const conn = connections.find((c) => c.id === id);
      set((s) => ({ sessions: { ...s.sessions, [id]: { ...s.sessions[id], tables: {},
          columns: {}, schemas: conn?.driver === "redis" ? undefined : s.sessions[id].schemas } } }));
      if (conn?.driver === "redis") continue;
      await get().loadSchemas(id);
      // re-open the schemas the user had expanded
      const expanded = get().sessions[id]?.expanded ?? {};
      for (const key of Object.keys(expanded)) {
        if (key.startsWith("schema:") && expanded[key]) void get().loadTables(id, key.slice(7));
      }
    }
  },

  reconnect: async (id) => {
    const database = get().sessions[id]?.database;
    try {
      await api.sessionClose(id);
    } catch {
      /* not open */
    }
    return get().connect(id, database);
  },

  loadTables: async (id, schema) => {
    set((s) => ({
      sessions: {
        ...s.sessions,
        [id]: { ...s.sessions[id], loadingTables: { ...s.sessions[id].loadingTables, [schema]: true } },
      },
    }));
    try {
      const tables = await api.schemaTables(id, schema);
      set((s) => ({
        sessions: {
          ...s.sessions,
          [id]: {
            ...s.sessions[id],
            tables: { ...s.sessions[id].tables, [schema]: tables },
            columns: { ...s.sessions[id].columns, [schema]: undefined },
            loadingTables: { ...s.sessions[id].loadingTables, [schema]: false },
          },
        },
      }));
    } catch (e) {
      set((s) => ({
        sessions: {
          ...s.sessions,
          [id]: { ...s.sessions[id], loadingTables: { ...s.sessions[id].loadingTables, [schema]: false } },
        },
      }));
      get().toast(translateError(e), "error");
    }
  },

  toggleExpanded: (id, key, value) =>
    set((s) => {
      const sess = s.sessions[id];
      if (!sess) return {};
      const next = value ?? !sess.expanded[key];
      return { sessions: { ...s.sessions, [id]: { ...sess, expanded: { ...sess.expanded, [key]: next } } } };
    }),

  toggleGroup: (name) =>
    set((s) => ({ groupsCollapsed: { ...s.groupsCollapsed, [name]: !s.groupsCollapsed[name] } })),

  openTab: (tab, opts) => {
    const { tabs } = get();
    if (opts?.reuse !== false && tab.kind !== "query") {
      const existing = tabs.find(
        (t) =>
          t.kind === tab.kind &&
          t.connectionId === tab.connectionId &&
          t.schema === tab.schema &&
          t.table === tab.table,
      );
      if (existing) {
        set({ activeTabId: existing.id });
        return existing.id;
      }
    }
    const id = tab.id ?? `tab-${tabSeq++}`;
    const active = get().activeTabId;
    const idx = tabs.findIndex((t) => t.id === active);
    const next = [...tabs];
    next.splice(idx >= 0 ? idx + 1 : tabs.length, 0, { ...tab, id });
    set({ tabs: next, activeTabId: id });
    return id;
  },

  closeTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return {};
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeTabId = s.activeTabId;
      if (activeTabId === id) {
        activeTabId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
      }
      return { tabs, activeTabId };
    }),

  closeOtherTabs: (id) => set((s) => ({ tabs: s.tabs.filter((t) => t.id === id), activeTabId: id })),
  closeAllTabs: () => set({ tabs: [], activeTabId: null }),
  closeTabsFor: (connectionId) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.connectionId !== connectionId);
      const activeTabId = tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : tabs[0]?.id ?? null;
      return { tabs, activeTabId };
    }),
  setActiveTab: (id) => set({ activeTabId: id }),
  updateTab: (id, patch) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
  moveTab: (from, to) =>
    set((s) => {
      const tabs = [...s.tabs];
      const [item] = tabs.splice(from, 1);
      tabs.splice(to, 0, item);
      return { tabs };
    }),

  toast: (text, kind = "info") => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, text }] }));
    window.setTimeout(() => get().dismissToast(id), kind === "error" ? 7000 : 3500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export function tabTitle(kind: TabKind, name: string): string {
  return name || kind;
}
