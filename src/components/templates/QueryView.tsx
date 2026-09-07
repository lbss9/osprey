import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SQLNamespace } from "@codemirror/lang-sql";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";
import Resizer from "@/components/atoms/Resizer";
import Dropdown from "@/components/molecules/Dropdown";
import ToolButton from "@/components/molecules/ToolButton";
import Spinner from "@/components/atoms/Spinner";
import TabButton from "@/components/atoms/Tab";
import ConnChip from "@/components/molecules/ConnChip";
import ExportMenu from "@/components/molecules/ExportMenu";
import PromptDialog from "@/components/molecules/PromptDialog";
import StatusBar from "@/components/molecules/StatusBar";
import ValueDialog from "@/components/molecules/ValueDialog";
import DataGrid from "@/components/organisms/DataGrid";
import HistoryPanel from "@/components/organisms/HistoryPanel";
import SqlEditor, { type SqlEditorHandle } from "@/components/organisms/SqlEditor";
import { useUi } from "@/store/ui";
import { useWorkspace } from "@/store/workspace";
import * as api from "@/services/tauri";
import { translateError } from "@/i18n";
import { cellText, formatDuration, formatNumber } from "@/utils/format";
import type { ResultSet, Tab } from "@/types";

/** SQL editor on top, results below. Ctrl+Enter runs the selection or all. */
export default function QueryView({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const conn = useWorkspace((s) => s.connections.find((c) => c.id === tab.connectionId));
  const session = useWorkspace((s) => s.sessions[tab.connectionId]);
  const updateTab = useWorkspace((s) => s.updateTab);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const queryLimit = useUi((s) => s.queryLimit);
  const editor = useRef<SqlEditorHandle>(null);

  const [results, setResults] = useState<ResultSet[] | null>(null);
  const [active, setActive] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorH, setEditorH] = useState(220);
  const [showHistory, setShowHistory] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [limit, setLimit] = useState(queryLimit);
  const [viewer, setViewer] = useState<{ r: number; c: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const toast = useWorkspace((s) => s.toast);

  const driver = conn?.driver ?? "postgres";

  const schemaNs = useMemo<SQLNamespace>(() => {
    const ns: Record<string, Record<string, string[]>> = {};
    for (const [schema, tables] of Object.entries(session?.tables ?? {})) {
      if (!tables) continue;
      ns[schema] = {};
      for (const tb of tables) ns[schema][tb.name] = [];
    }
    return ns;
  }, [session?.tables]);
  const defaultSchema = session?.schemas?.[0];

  const run = useCallback(async () => {
    if (running) return;
    const text = editor.current?.getSelection() || editor.current?.getText() || "";
    if (!text.trim()) return;
    setRunning(true);
    setError(null);
    try {
      const sets = await api.queryRun(tab.connectionId, text, limit);
      setResults(sets);
      const firstGrid = sets.findIndex((s) => s.columns.length > 0);
      setActive(firstGrid >= 0 ? firstGrid : sets.length);
    } catch (e) {
      setError(translateError(e));
      setResults(null);
    } finally {
      setRunning(false);
      setHistoryVersion((v) => v + 1);
    }
  }, [running, tab.connectionId, limit]);

  const cancel = async () => {
    try {
      await api.queryCancel(tab.connectionId);
    } catch (e) {
      useWorkspace.getState().toast(translateError(e), "error");
    }
  };

  useEffect(() => {
    const onRefresh = () => activeTabId === tab.id && void run();
    const onSave = () => activeTabId === tab.id && (tab.sql ?? "").trim() && setSaving(true);
    window.addEventListener("osprey-refresh", onRefresh);
    window.addEventListener("osprey-save-query", onSave);
    return () => {
      window.removeEventListener("osprey-refresh", onRefresh);
      window.removeEventListener("osprey-save-query", onSave);
    };
  }, [activeTabId, tab.id, tab.sql, run]);

  const gridSets = results?.map((s, i) => ({ s, i })).filter((x) => x.s.columns.length > 0) ?? [];
  const messagesIdx = results?.length ?? 0;
  const current = results && active < messagesIdx ? results[active] : null;
  const showMessages = active === messagesIdx || !current;

  return (
    <div className="query-view">
      <div className="toolbar">
        <Button size="sm" variant="primary" onClick={() => void run()} disabled={running} title={`${t("query.run")} (Ctrl+Enter)`}>
          {running ? <Spinner /> : <Icon name="play" size={13} />} {t("query.run")}
        </Button>
        {running && (
          <Button size="sm" variant="danger" onClick={() => void cancel()}>
            <Icon name="square" size={12} /> {t("query.cancel")}
          </Button>
        )}
        <ConnChip connectionId={tab.connectionId} />
        <span className="grow" />
        <span style={{ color: "var(--text-faint)", fontSize: "0.88em" }}>{t("query.limit")}</span>
        <Dropdown
          size="sm"
          menuAlign="right"
          value={String(limit)}
          options={[100, 500, 1000, 5000, 10000, 50000].map((n) => ({ value: String(n), label: formatNumber(n) }))}
          onChange={(v) => setLimit(Number(v))}
          ariaLabel={t("query.limit")}
        />
        <ToolButton icon="save" title={`${t("query.saveQuery")} (Ctrl+Shift+S)`} onClick={() => setSaving(true)} disabled={!(tab.sql ?? "").trim()} />
        <ToolButton icon="history" title={t("query.history")} active={showHistory} onClick={() => setShowHistory((v) => !v)} />
      </div>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
          <div className="query-editor" style={{ height: editorH }}>
            <SqlEditor
              ref={editor}
              value={tab.sql ?? ""}
              onChange={(text) => updateTab(tab.id, { sql: text, dirty: text.trim().length > 0 })}
              onRun={() => void run()}
              driver={driver}
              schema={schemaNs}
              defaultSchema={defaultSchema}
              placeholder={t("query.placeholder")}
            />
          </div>
          <Resizer direction="horizontal" onDrag={(d) => setEditorH((h) => Math.max(80, h + d))} />
          <div className="query-results">
            {results && (
              <div className="result-tabs">
                {gridSets.map(({ s, i }) => (
                  <TabButton key={i} className="rt" active={active === i} onClick={() => setActive(i)}>
                    {gridSets.length > 1 ? t("query.result", { n: gridSets.findIndex((g) => g.i === i) + 1 }) : t("query.results")}
                    <span className="n">{formatNumber(s.rowCount)}</span>
                  </TabButton>
                ))}
                <TabButton className="rt" active={showMessages} onClick={() => setActive(messagesIdx)}>
                  {t("query.messages")}
                </TabButton>
              </div>
            )}
            {error && (
              <div className="messages">
                <span className="err">{error}</span>
              </div>
            )}
            {!error && !results && !running && <div className="results-empty">{t("query.noResults")}</div>}
            {!error && running && !results && (
              <div className="results-empty">
                <Spinner size="lg" />
              </div>
            )}
            {!error && results && showMessages && (
              <div className="messages">
                {results.map((s, i) => (
                  <div key={i}>
                    <span className="ok">{t("query.ok")}</span>{" "}
                    {s.columns.length ? t("grid.rows", { count: s.rowCount }) : t("query.affected", { count: s.affected ?? 0 })}
                    <span className="dim"> · {formatDuration(s.elapsedMs)}</span>
                    {s.truncated && <span className="dim"> · {t("grid.truncated", { count: s.rowCount })}</span>}
                  </div>
                ))}
              </div>
            )}
            {!error && results && !showMessages && current && (
              <>
                <DataGrid columns={current.columns} rows={current.rows} loading={running} onViewCell={(r, c) => setViewer({ r, c })} />
                <StatusBar
                  left={
                    <>
                      <span>{t("grid.rows", { count: current.rowCount })}</span>
                      <span style={{ color: "var(--text-faint)" }}>{formatDuration(current.elapsedMs)}</span>
                      {current.truncated && <span className="warn">{t("grid.truncated", { count: current.rowCount })}</span>}
                    </>
                  }
                  right={<ExportMenu columns={current.columns} rows={current.rows} baseName="query" />}
                />
              </>
            )}
          </div>
        </div>
        {showHistory && (
          <HistoryPanel
            connectionId={tab.connectionId}
            version={historyVersion}
            onPick={(sql) => {
              editor.current?.setText(sql);
              updateTab(tab.id, { sql, dirty: true });
              editor.current?.focus();
            }}
            onClose={() => setShowHistory(false)}
          />
        )}
      </div>
      {saving && (
        <PromptDialog
          title={t("query.saveQuery")}
          label={t("query.saveName")}
          confirmLabel={t("common.save")}
          onClose={() => setSaving(false)}
          onConfirm={async (name) => {
            try {
              await api.savedQuerySave({ id: "", connectionId: tab.connectionId, name, sql: editor.current?.getText() ?? tab.sql ?? "", position: 0, updatedAt: 0 });
              setSaving(false);
              updateTab(tab.id, { title: name, dirty: false });
              window.dispatchEvent(new CustomEvent("osprey-saved-queries"));
              toast(t("toast.saved"), "success");
            } catch (e) {
              toast(translateError(e), "error");
            }
          }}
        />
      )}
      {viewer && current && (
        <ValueDialog
          title={current.columns[viewer.c]?.name ?? ""}
          value={cellText(current.rows[viewer.r]?.[viewer.c] ?? null)}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}
