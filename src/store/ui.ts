/**
 * UI preferences persisted in localStorage (theme, sizes, sidebar) plus
 * ephemeral dialog state. Workspace data lives in `store/workspace.ts`.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ConnectionConfig } from "@/types";

export type ThemeChoice = "auto" | "dark" | "light";

interface UiState {
  theme: ThemeChoice;
  fontSize: number;
  editorFontSize: number;
  zoom: number;
  sidebarWidth: number;
  showSidebar: boolean;
  pageSize: number;
  queryLimit: number;
  safeMode: boolean;
  confirmClose: boolean;
  redisTree: boolean;
  /** list pg_catalog / information_schema / templates / mysql / sys */
  showSystemObjects: boolean;
  settingsOpen: boolean;
  settingsTab: string;
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
      fontSize: 13,
      editorFontSize: 13,
      zoom: 1,
      sidebarWidth: 260,
      showSidebar: true,
      pageSize: 200,
      queryLimit: 1000,
      safeMode: true,
      confirmClose: true,
      redisTree: true,
      showSystemObjects: false,
      settingsOpen: false,
      settingsTab: "general",
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
        fontSize: s.fontSize,
        editorFontSize: s.editorFontSize,
        zoom: s.zoom,
        sidebarWidth: s.sidebarWidth,
        showSidebar: s.showSidebar,
        pageSize: s.pageSize,
        queryLimit: s.queryLimit,
        safeMode: s.safeMode,
        confirmClose: s.confirmClose,
        redisTree: s.redisTree,
        showSystemObjects: s.showSystemObjects,
      }),
    },
  ),
);
