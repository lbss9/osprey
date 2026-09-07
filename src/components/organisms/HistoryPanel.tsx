import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";
import ToolButton from "@/components/molecules/ToolButton";
import * as api from "@/services/tauri";
import { formatDuration, relativeTime } from "@/utils/format";
import type { HistoryEntry } from "@/types";

/** Right-hand list of past queries for one connection. */
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
  const [items, setItems] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    api.historyList(connectionId, 150).then(setItems).catch(() => setItems([]));
  }, [connectionId, version]);

  return (
    <div className="side-panel">
      <div className="head">
        <Icon name="history" size={13} />
        <span>{t("query.history")}</span>
        <span className="grow" />
        <ToolButton
          icon="trash"
          title={t("query.clearHistory")}
          onClick={async () => {
            await api.historyClear(connectionId);
            setItems([]);
          }}
        />
        <ToolButton icon="x" title={t("common.close")} onClick={onClose} />
      </div>
      <div className="list">
        {items.length === 0 && <div className="tree-empty">{t("query.historyEmpty")}</div>}
        {items.map((h) => (
          <Button key={h.id} variant="bare" className="hist-item" onClick={() => onPick(h.sql)} title={h.sql}>
            <span className="sql">{h.sql.replace(/\s+/g, " ")}</span>
            <span className="meta">
              <span>{relativeTime(h.at)}</span>
              <span>{formatDuration(h.durationMs)}</span>
              {h.ok ? h.rows != null && <span>{h.rows} rows</span> : <span className="bad">{t("common.error")}</span>}
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}
