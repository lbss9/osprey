import Resizer from "@/components/atoms/Resizer";
import Sidebar from "@/components/organisms/Sidebar";
import TabBar from "@/components/organisms/TabBar";
import ConsoleView from "@/components/templates/ConsoleView";
import InfoView from "@/components/templates/InfoView";
import QueryView from "@/components/templates/QueryView";
import RedisToolsView from "@/components/templates/RedisToolsView";
import RedisView from "@/components/templates/RedisView";
import StructureView from "@/components/templates/StructureView";
import TableView from "@/components/templates/TableView";
import WelcomeView from "@/components/templates/WelcomeView";
import { useUi } from "@/store/ui";
import { useWorkspace } from "@/store/workspace";
import type { Tab } from "@/types";

function View({ tab }: { tab: Tab }) {
  switch (tab.kind) {
    case "table":
      return <TableView tab={tab} />;
    case "query":
      return <QueryView tab={tab} />;
    case "structure":
      return <StructureView tab={tab} />;
    case "redis":
      return <RedisView tab={tab} />;
    case "console":
      return <ConsoleView tab={tab} />;
    case "info":
      return <InfoView tab={tab} />;
    case "tools":
      return <RedisToolsView tab={tab} />;
  }
}

/**
 * Sidebar + tab strip + the active view. Every open tab stays mounted (hidden
 * with `display:none`) so grids, editors and results survive tab switches.
 */
export default function WorkspaceLayout({ onNewQuery }: { onNewQuery: () => void }) {
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const showSidebar = useUi((s) => s.showSidebar);
  const sidebarWidth = useUi((s) => s.sidebarWidth);
  const set = useUi((s) => s.set);

  return (
    <div className="app">
      {showSidebar && (
        <>
          <div style={{ width: sidebarWidth, display: "flex", flex: "none" }}>
            <Sidebar />
          </div>
          <Resizer direction="vertical" onDrag={(d) => set({ sidebarWidth: Math.min(520, Math.max(180, sidebarWidth + d)) })} />
        </>
      )}
      <div className="main">
        <TabBar onNewQuery={onNewQuery} />
        {tabs.length === 0 && <WelcomeView />}
        {tabs.map((tab) => (
          <div key={tab.id} className="main-body" style={{ display: tab.id === activeTabId ? "flex" : "none" }}>
            <View tab={tab} />
          </div>
        ))}
      </div>
    </div>
  );
}
