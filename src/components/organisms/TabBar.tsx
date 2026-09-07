import { useTranslation } from "react-i18next";
import Button from "@/components/atoms/Button";
import Icon, { type IconName } from "@/components/atoms/Icon";
import ContextMenu from "@/components/molecules/ContextMenu";
import { useContextMenu } from "@/hooks/useContextMenu";
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
  const ctx = useContextMenu();

  const tryClose = async (tab: Tab) => {
    if (tab.dirty && confirmClose && !(await confirmDialog(t("tabs.closeConfirm")))) return;
    closeTab(tab.id);
  };

  return (
    <div className="tabbar">
      <div className="tabs">
        {tabs.map((tab) => {
          const conn = connections.find((c) => c.id === tab.connectionId);
          return (
            <div
              key={tab.id}
              className={`tab ${tab.id === activeTabId ? "active" : ""} ${tab.dirty ? "dirty" : ""}`}
              onClick={() => setActive(tab.id)}
              onAuxClick={(e) => e.button === 1 && void tryClose(tab)}
              onContextMenu={(e) =>
                ctx.open(e, [
                  { label: t("common.close"), action: () => void tryClose(tab) },
                  { label: t("tabs.closeOthers"), action: () => closeOthers(tab.id) },
                  { label: t("tabs.closeAll"), action: closeAll },
                ])
              }
              title={conn ? `${conn.name}${tab.schema ? ` · ${tab.schema}` : ""}` : undefined}
            >
              <span className="t-icon" style={conn?.color ? { color: conn.color } : undefined}>
                <Icon name={ICON[tab.kind]} size={14} />
              </span>
              <span className="t-label">{tab.title}</span>
              {tabs.filter((x) => x.title === tab.title).length > 1 && conn && (
                <span className="t-sub">{conn.name}</span>
              )}
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
        <Button size="sm" icon title={`${t("menu.newQuery")} (Ctrl+T)`} onClick={onNewQuery}>
          <Icon name="plus" size={15} />
        </Button>
      </div>
      <ContextMenu menu={ctx.menu} onClose={ctx.close} />
    </div>
  );
}
