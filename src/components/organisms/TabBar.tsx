import { useState } from "react";
import { useTranslation } from "react-i18next";
import { modKey } from "@/utils/format";
import Button from "@/components/atoms/Button";
import Icon, { type IconName } from "@/components/atoms/Icon";
import { useContextMenu } from "@/components/molecules/ContextMenu";
import ToolButton from "@/components/molecules/ToolButton";
import { useUi } from "@/store/ui";
import { useWorkspace } from "@/store/workspace";
import { confirmDialog } from "@/utils/dialog";
import type { Tab } from "@/types";

const ICON: Record<Tab["kind"], IconName> = {
  table: "table",
  query: "fileCode",
  structure: "list",
  redis: "keyRound",
  console: "terminal",
  info: "info",
  tools: "zap",
  diagram: "tree",
};

export default function TabBar({ onNewQuery }: { onNewQuery: () => void }) {
  const { t } = useTranslation();
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const setActive = useWorkspace((s) => s.setActiveTab);
  const closeTab = useWorkspace((s) => s.closeTab);
  const closeOthers = useWorkspace((s) => s.closeOtherTabs);
  const closeAll = useWorkspace((s) => s.closeAllTabs);
  const connections = useWorkspace((s) => s.connections);
  const confirmClose = useUi((s) => s.confirmClose);
  const moveTab = useWorkspace((s) => s.moveTab);
  const { open } = useContextMenu();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const tryClose = async (tab: Tab) => {
    if (tab.dirty && confirmClose && !(await confirmDialog(t("tabs.closeConfirm")))) return;
    closeTab(tab.id);
  };
  const closeRight = (tab: Tab) => {
    const i = tabs.findIndex((x) => x.id === tab.id);
    tabs.slice(i + 1).forEach((x) => closeTab(x.id));
  };

  return (
    <div className="tabbar">
      <div className="tabs">
        {tabs.map((tab, i) => {
          const conn = connections.find((c) => c.id === tab.connectionId);
          return (
            <div
              key={tab.id}
              className={`tab ${tab.id === activeTabId ? "active" : ""} ${tab.dirty ? "dirty" : ""} ${overId === tab.id && dragId !== tab.id ? "drag-over" : ""}`}
              draggable
              data-tab-id={tab.id}
              onDragStart={(e) => {
                setDragId(tab.id);
                e.dataTransfer.setData("application/x-osprey-tab", tab.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes("application/x-osprey-tab")) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setOverId(tab.id);
              }}
              onDragLeave={() => setOverId((cur) => (cur === tab.id ? null : cur))}
              onDrop={(e) => {
                e.preventDefault();
                const from = tabs.findIndex((x) => x.id === e.dataTransfer.getData("application/x-osprey-tab"));
                if (from >= 0 && from !== i) moveTab(from, i);
                setDragId(null);
                setOverId(null);
              }}
              onClick={() => setActive(tab.id)}
              onAuxClick={(e) => e.button === 1 && void tryClose(tab)}
              onContextMenu={(e) =>
                open(e, [
                  { label: t("ctx.closeTab"), icon: "x", shortcut: `${modKey}+W`, onSelect: () => void tryClose(tab) },
                  { label: t("ctx.closeOthers"), onSelect: () => closeOthers(tab.id), disabled: tabs.length < 2 },
                  { label: t("ctx.closeRight"), onSelect: () => closeRight(tab), disabled: i === tabs.length - 1 },
                  { label: t("ctx.closeAll"), onSelect: closeAll },
                ])
              }
              title={conn ? `${conn.name}${tab.schema ? ` · ${tab.schema}` : ""}` : undefined}
            >
              <span className="t-icon" style={conn?.color ? { color: conn.color } : undefined}>
                <Icon name={ICON[tab.kind]} size={14} />
              </span>
              <span className="t-label">{tab.title}</span>
              {tabs.filter((x) => x.title === tab.title).length > 1 && conn && <span className="t-sub">{conn.name}</span>}
              <Button
                variant="bare"
                className="t-close"
                onClick={(e) => {
                  e.stopPropagation();
                  void tryClose(tab);
                }}
                aria-label={t("common.close")}
              >
                <span className="dot" />
                <Icon name="x" size={12} className="x" />
              </Button>
            </div>
          );
        })}
      </div>
      <div className="tab-actions">
        <ToolButton icon="plus" title={`${t("menu.newQuery")} (${modKey}+T)`} onClick={onNewQuery} />
      </div>
    </div>
  );
}
