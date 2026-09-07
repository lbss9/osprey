import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";
import Tab from "@/components/atoms/Tab";
import { useContextMenu } from "@/components/molecules/ContextMenu";
import PromptDialog from "@/components/molecules/PromptDialog";
import ToolButton from "@/components/molecules/ToolButton";
import { useWorkspace } from "@/store/workspace";
import * as api from "@/services/tauri";
import { translateError } from "@/i18n";
import { copyText } from "@/utils/clipboard";
import { confirmDialog } from "@/utils/dialog";
import { formatDuration, relativeTime } from "@/utils/format";
import type { HistoryEntry, SavedQuery } from "@/types";

/**
 * Right-hand panel of the query tab: History (per connection) and Saved
 * queries (all connections; the ones bound to this connection first).
 */
export default function HistoryPanel({
  connectionId,
  version,
  onPick,
  onClose,
}: {
  connectionId: string;
  /** bump to reload */
  version: number;
  onPick: (sql: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useWorkspace((s) => s.toast);
  const connections = useWorkspace((s) => s.connections);
  const { open } = useContextMenu();
  const [tab, setTab] = useState<"history" | "saved">("history");
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [renaming, setRenaming] = useState<SavedQuery | null>(null);

  const loadSaved = () => api.savedQueriesList().then(setSaved).catch(() => setSaved([]));
  useEffect(() => {
    api.historyList(connectionId, 150).then(setItems).catch(() => setItems([]));
    void loadSaved();
  }, [connectionId, version]);

  useEffect(() => {
    const onSaved = () => void loadSaved();
    window.addEventListener("osprey-saved-queries", onSaved);
    return () => window.removeEventListener("osprey-saved-queries", onSaved);
  }, []);

  const sortedSaved = [...saved].sort((a, b) => Number(b.connectionId === connectionId) - Number(a.connectionId === connectionId) || a.name.localeCompare(b.name));

  const savedMenu = (q: SavedQuery) => [
    { label: t("query.load"), icon: "fileCode" as const, onSelect: () => onPick(q.sql) },
    { label: t("common.rename"), icon: "pencil" as const, onSelect: () => setRenaming(q) },
    { label: t("common.copy"), icon: "copy" as const, onSelect: () => void copyText(q.sql) },
    { separator: true as const },
    {
      label: t("common.delete"),
      icon: "trash" as const,
      danger: true,
      onSelect: async () => {
        if (!(await confirmDialog(t("query.deleteSavedConfirm", { name: q.name })))) return;
        try {
          await api.savedQueryDelete(q.id);
          await loadSaved();
        } catch (e) {
          toast(translateError(e), "error");
        }
      },
    },
  ];

  return (
    <div className="side-panel">
      <div className="head">
        <div className="pill-tabs">
          <Tab active={tab === "history"} onClick={() => setTab("history")}>
            <Icon name="history" size={12} /> {t("query.history")}
          </Tab>
          <Tab active={tab === "saved"} onClick={() => setTab("saved")}>
            <Icon name="save" size={12} /> {t("query.saved")}
          </Tab>
        </div>
        <span className="grow" />
        {tab === "history" && (
          <ToolButton
            icon="trash"
            title={t("query.clearHistory")}
            onClick={async () => {
              await api.historyClear(connectionId);
              setItems([]);
            }}
          />
        )}
        <ToolButton icon="x" title={t("common.close")} onClick={onClose} />
      </div>
      <div className="list">
        {tab === "history" && items.length === 0 && <div className="tree-empty">{t("query.historyEmpty")}</div>}
        {tab === "history" &&
          items.map((h) => (
            <Button key={h.id} variant="bare" className="hist-item" onClick={() => onPick(h.sql)} title={h.sql} onContextMenu={(e) => open(e, [{ label: t("common.copy"), icon: "copy", onSelect: () => void copyText(h.sql) }])}>
              <span className="sql">{h.sql.replace(/\s+/g, " ")}</span>
              <span className="meta">
                <span>{relativeTime(h.at)}</span>
                <span>{formatDuration(h.durationMs)}</span>
                {h.ok ? h.rows != null && <span>{h.rows} rows</span> : <span className="bad">{t("common.error")}</span>}
              </span>
            </Button>
          ))}
        {tab === "saved" && sortedSaved.length === 0 && <div className="tree-empty">{t("query.savedEmpty")}</div>}
        {tab === "saved" &&
          sortedSaved.map((q) => {
            const conn = connections.find((c) => c.id === q.connectionId);
            return (
              <Button key={q.id} variant="bare" className="hist-item" onClick={() => onPick(q.sql)} title={q.sql} onContextMenu={(e) => open(e, savedMenu(q))}>
                <span className="sql" style={{ fontFamily: "var(--sans)", fontWeight: 600 }}>
                  {q.name}
                </span>
                <span className="sql">{q.sql.replace(/\s+/g, " ")}</span>
                <span className="meta">
                  <span>{conn?.name ?? t("query.anyConnection")}</span>
                  <span>{relativeTime(q.updatedAt)}</span>
                </span>
              </Button>
            );
          })}
      </div>
      {renaming && (
        <PromptDialog
          title={t("common.rename")}
          label={t("query.saveName")}
          initial={renaming.name}
          confirmLabel={t("common.save")}
          onClose={() => setRenaming(null)}
          onConfirm={async (name) => {
            try {
              await api.savedQuerySave({ ...renaming, name });
              setRenaming(null);
              await loadSaved();
            } catch (e) {
              toast(translateError(e), "error");
            }
          }}
        />
      )}
    </div>
  );
}
