import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SQLNamespace } from "@codemirror/lang-sql";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";
import Resizer from "@/components/atoms/Resizer";
import Select from "@/components/atoms/Select";
import Spinner from "@/components/atoms/Spinner";
import ConnChip from "@/components/molecules/ConnChip";
import ExportMenu from "@/components/molecules/ExportMenu";
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
    window.addEventListener("osprey-refresh", onRefresh);
    return () => window.removeEventListener("osprey-refresh", onRefresh);
  }, [activeTabId, tab.id, run]);

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
        <Select
          small
          value={limit}
          options={[100, 500, 1000, 5000, 10000, 50000].map((n) => ({ value: n, label: formatNumber(n) }))}
          onChange={(v) => setLimit(Number(v))}
          style={{ width: 90 }}
        />
        <Button size="sm" active={showHistory} onClick={() => setShowHistory((v) => !v)} title={t("query.history")}>
          <Icon name="history" size={14} />
        </Button>
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
                  <Button key={i} variant="bare" className={`rt ${active === i ? "active" : ""}`} onClick={() => setActive(i)}>
                    {gridSets.length > 1 ? t("query.result", { n: gridSets.findIndex((g) => g.i === i) + 1 }) : t("query.results")}
                    <span className="n">{formatNumber(s.rowCount)}</span>
                  </Button>
                ))}
                <Button variant="bare" className={`rt ${showMessages ? "active" : ""}`} onClick={() => setActive(messagesIdx)}>
                  {t("query.messages")}
                </Button>
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
