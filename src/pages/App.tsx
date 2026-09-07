import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import Toasts from "@/components/molecules/Toasts";
import ConnectionDialog from "@/components/organisms/ConnectionDialog";
import SettingsDialog from "@/components/organisms/SettingsDialog";
import TitleBar from "@/components/organisms/TitleBar";
import WorkspaceLayout from "@/components/templates/WorkspaceLayout";
import { useTheme } from "@/hooks/useTheme";
import { checkForUpdates } from "@/services/updater";
import { useUi } from "@/store/ui";
import { useWorkspace } from "@/store/workspace";
import { confirmDialog } from "@/utils/dialog";

export default function App() {
  const { t } = useTranslation();
  useTheme();
  const ui = useUi();
  const ws = useWorkspace();

  useEffect(() => {
    void ws.loadConnections();
    const timer = window.setTimeout(() => void checkForUpdates({ silent: true }), 4000);
    return () => window.clearTimeout(timer);
    // startup only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Connection for a new query tab: the active tab's, else the first open session. */
  const pickConnection = useCallback((): string | null => {
    const active = ws.tabs.find((x) => x.id === ws.activeTabId);
    const openIds = Object.entries(ws.sessions)
      .filter(([, s]) => s.status === "open")
      .map(([id]) => id);
    const sqlOpen = (id: string) => ws.connections.find((c) => c.id === id)?.driver !== "redis";
    if (active && openIds.includes(active.connectionId) && sqlOpen(active.connectionId)) return active.connectionId;
    return openIds.find(sqlOpen) ?? null;
  }, [ws.tabs, ws.activeTabId, ws.sessions, ws.connections]);

  const newQuery = useCallback(() => {
    const id = pickConnection();
    if (!id) {
      ws.toast(t("errors.notConnected"), "error");
      return;
    }
    ws.openTab({ kind: "query", connectionId: id, title: t("tabs.query"), sql: "" }, { reuse: false });
  }, [pickConnection, ws, t]);

  const zoom = useCallback(
    (dir: "in" | "out" | "reset") => {
      const z = dir === "reset" ? 1 : Math.min(1.6, Math.max(0.7, ui.zoom + (dir === "in" ? 0.1 : -0.1)));
      ui.set({ zoom: Math.round(z * 100) / 100 });
    },
    [ui],
  );

  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "n" && !e.shiftKey) {
        e.preventDefault();
        ui.openConnectionDialog(null);
      } else if (k === "t") {
        e.preventDefault();
        newQuery();
      } else if (k === "w") {
        e.preventDefault();
        const tab = ws.tabs.find((x) => x.id === ws.activeTabId);
        if (!tab) return;
        if (tab.dirty && ui.confirmClose && !(await confirmDialog(t("tabs.closeConfirm")))) return;
        ws.closeTab(tab.id);
      } else if (k === "b") {
        e.preventDefault();
        ui.set({ showSidebar: !ui.showSidebar });
      } else if (k === ",") {
        e.preventDefault();
        ui.openSettings("general");
      } else if (k === "r" && !e.shiftKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("osprey-refresh"));
      } else if (k === "s" && !e.shiftKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("osprey-apply"));
      } else if (k === "=" || k === "+") {
        e.preventDefault();
        zoom("in");
      } else if (k === "-") {
        e.preventDefault();
        zoom("out");
      } else if (k === "0") {
        e.preventDefault();
        zoom("reset");
      } else if (e.key === "Tab" && ws.tabs.length > 1) {
        e.preventDefault();
        const i = ws.tabs.findIndex((x) => x.id === ws.activeTabId);
        const next = ws.tabs[(i + (e.shiftKey ? -1 : 1) + ws.tabs.length) % ws.tabs.length];
        ws.setActiveTab(next.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ui, ws, newQuery, zoom, t]);

  return (
    <div className="root">
      <TitleBar
        onNewConnection={() => ui.openConnectionDialog(null)}
        onNewQuery={newQuery}
        onOpenSettings={ui.openSettings}
        onToggleSidebar={() => ui.set({ showSidebar: !ui.showSidebar })}
        onZoom={zoom}
        onCheckUpdates={() => {
          ui.openSettings("about");
          void checkForUpdates();
        }}
      />
      <WorkspaceLayout onNewQuery={newQuery} />
      <ConnectionDialog />
      <SettingsDialog />
      <Toasts />
    </div>
  );
}
