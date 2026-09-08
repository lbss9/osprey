/**
 * UI preferences persisted in localStorage (theme, sizes, sidebar) plus
 * ephemeral dialog state. Workspace data lives in `store/workspace.ts`.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ColumnInfo, ConnectionConfig } from "@/types";

export interface DdlDialogState {
  connectionId: string;
  schema: string;
  table?: string;
  mode: "createTable" | "addColumn" | "alterColumn" | "createIndex" | "renameTable";
  column?: ColumnInfo;
  columns?: ColumnInfo[];
}

/** "auto", a built-in id ("dark" / "light") or the id of a JSON theme */
export type ThemeChoice = string;

interface UiState {
  theme: ThemeChoice;
  /** BCP-47 tag for numbers/dates, or "auto" for the OS locale */
  locale: string;
  /** format numbers and dates in grids (raw values are always used for copy/edit) */
  formatValues: boolean;
  fontSize: number;
  editorFontSize: number;
  zoom: number;
  sidebarWidth: number;
  /** width of the "current SQL" drawer on the right of a table grid */
  sqlDrawerWidth: number;
  showSidebar: boolean;
  pageSize: number;
  queryLimit: number;
  safeMode: boolean;
  confirmClose: boolean;
  /** keep query history in the local database (off: nothing is written) */
  recordHistory: boolean;
  redisTree: boolean;
  /** list pg_catalog / information_schema / templates / mysql / sys */
  showSystemObjects: boolean;
  settingsOpen: boolean;
  settingsTab: string;
  paletteOpen: boolean;
  ddlDialog: DdlDialogState | null;
  importDialog: { connectionId: string; schema: string; table?: string } | null;
  connectionDialog: { open: boolean; editing?: ConnectionConfig | null; clone?: boolean };

  set: (patch: Partial<UiState>) => void;
  openSettings: (tab?: string) => void;
  closeSettings: () => void;
  openConnectionDialog: (editing?: ConnectionConfig | null, clone?: boolean) => void;
  closeConnectionDialog: () => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      theme: "auto",
      locale: "auto",
      formatValues: true,
      fontSize: 13,
      editorFontSize: 13,
      zoom: 1,
      sidebarWidth: 260,
      sqlDrawerWidth: 380,
      showSidebar: true,
      pageSize: 200,
      queryLimit: 1000,
      safeMode: true,
      confirmClose: true,
      recordHistory: true,
      redisTree: true,
      showSystemObjects: false,
      settingsOpen: false,
      settingsTab: "general",
      paletteOpen: false,
      ddlDialog: null,
      importDialog: null,
      connectionDialog: { open: false, editing: null },

      set: (patch) => set(patch),
      openSettings: (tab) => set({ settingsOpen: true, settingsTab: tab ?? "general" }),
      closeSettings: () => set({ settingsOpen: false }),
      openConnectionDialog: (editing, clone) =>
        set({ connectionDialog: { open: true, editing: editing ?? null, clone: !!clone } }),
      closeConnectionDialog: () => set({ connectionDialog: { open: false, editing: null } }),
    }),
    {
      name: "osprey-ui",
      partialize: (s) => ({
        theme: s.theme,
        locale: s.locale,
        formatValues: s.formatValues,
        fontSize: s.fontSize,
        editorFontSize: s.editorFontSize,
        zoom: s.zoom,
        sidebarWidth: s.sidebarWidth,
        sqlDrawerWidth: s.sqlDrawerWidth,
        showSidebar: s.showSidebar,
        pageSize: s.pageSize,
        queryLimit: s.queryLimit,
        safeMode: s.safeMode,
        confirmClose: s.confirmClose,
        recordHistory: s.recordHistory,
        redisTree: s.redisTree,
        showSystemObjects: s.showSystemObjects,
      }),
    },
  ),
);
