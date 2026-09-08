import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import DataGrid from "@/components/organisms/DataGrid";
import ExplainPanel from "@/components/organisms/ExplainPanel";
import HistoryPanel from "@/components/organisms/HistoryPanel";
import type { SqlEditorHandle } from "@/components/organisms/SqlEditor";

// CodeMirror is loaded on first use so the shell starts without it
const SqlEditor = lazy(() => import("@/components/organisms/SqlEditor"));
const ValueDialog = lazy(() => import("@/components/molecules/ValueDialog"));
import { useUi } from "@/store/ui";
import { connectionIdOf } from "@/utils/session";
import { useWorkspace } from "@/store/workspace";
import { onEvent } from "@/services/events";
import * as api from "@/services/tauri";
import { translateError } from "@/i18n";
import { cellText, formatDuration, formatNumber, modKey } from "@/utils/format";
import type { ExplainResult, QueryRowsEvent, ResultSet, Tab } from "@/types";

/** SQL editor on top, results below. Ctrl+Enter runs the selection or all. */
export default function QueryView({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const conn = useWorkspace((s) => s.connections.find((c) => c.id === connectionIdOf(tab.connectionId)));
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
  const [explain, setExplain] = useState<ExplainResult | null>(null);
  const [explaining, setExplaining] = useState(false);
  const toast = useWorkspace((s) => s.toast);

  const driver = conn?.driver ?? "postgres";

  const schemaNs = useMemo<SQLNamespace>(() => {
    const ns: Record<string, Record<string, string[]>> = {};
    for (const [schema, tables] of Object.entries(session?.tables ?? {})) {
      if (!tables) continue;
      ns[schema] = {};
      const cols = session?.columns?.[schema];
      for (const tb of tables) ns[schema][tb.name] = cols?.[tb.name] ?? [];
    }
    return ns;
  }, [session?.tables, session?.columns]);
  const defaultSchema = session?.schemas?.[0];
  const loadSchemaColumns = useWorkspace((s) => s.loadSchemaColumns);
  // column names for every schema whose tables are listed (one request per schema, cached)
  useEffect(() => {
    if (!session || session.status !== "open") return;
    for (const [schema, tables] of Object.entries(session.tables)) {
      if (tables && !session.columns?.[schema]) void loadSchemaColumns(tab.connectionId, schema);
    }
  }, [session, loadSchemaColumns, tab.connectionId]);

  const run = useCallback(async () => {
    if (running) return;
    const text = editor.current?.getSelection() || editor.current?.getText() || "";
    if (!text.trim()) return;
    setRunning(true);
    setError(null);
    setExplain(null);
    // Rows stream in through `query-rows` events while the statement runs, so
    // a big result shows its first page immediately and can be cancelled midway.
    const streamId = crypto.randomUUID();
    const partial: ResultSet[] = [];
    let raf = 0;
    const paint = () => {
      raf = 0;
      setResults(partial.map((s) => ({ ...s, rows: s.rows.slice() })));
      setActive((a) => (a === -1 ? partial.findIndex((s) => s.columns.length > 0) : a));
    };
    setActive(-1);
    const off = onEvent<QueryRowsEvent>("query-rows", (ev) => {
      if (ev.streamId !== streamId) return;
      while (partial.length <= ev.set) partial.push({ columns: [], rows: [], rowCount: 0, affected: null, truncated: false, elapsedMs: 0, streamed: true });
      const set = partial[ev.set];
      if (ev.columns) set.columns = ev.columns;
      for (const r of ev.rows) set.rows.push(r);
      set.rowCount = set.rows.length;
      if (!raf) raf = requestAnimationFrame(paint);
    });
    try {
      const sets = await api.queryRun(tab.connectionId, text, limit, streamId, useUi.getState().recordHistory);
      if (raf) cancelAnimationFrame(raf);
      const merged = sets.map((s, i) => (s.streamed ? { ...s, rows: partial[i]?.rows ?? [], columns: s.columns.length ? s.columns : partial[i]?.columns ?? [] } : s));
      setResults(merged);
      const firstGrid = merged.findIndex((s) => s.columns.length > 0);
      setActive(firstGrid >= 0 ? firstGrid : merged.length);
    } catch (e) {
      if (raf) cancelAnimationFrame(raf);
      setError(translateError(e));
      // keep what arrived before the error / cancel
      const got = partial.filter((s) => s.rows.length > 0);
      setResults(got.length ? got : null);
      setActive(got.length ? 0 : 0);
    } finally {
      off();
      setRunning(false);
      setHistoryVersion((v) => v + 1);
    }
  }, [running, tab.connectionId, limit]);

  const doExplain = async (analyze: boolean) => {
    const text = editor.current?.getSelection() || editor.current?.getText() || "";
    if (!text.trim() || explaining) return;
    setExplaining(true);
    setError(null);
    try {
      const r = await api.queryExplain(tab.connectionId, text, analyze);
      setExplain(r);
      setResults(null);
    } catch (e) {
      setError(translateError(e));
    } finally {
      setExplaining(false);
    }
  };

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
        <Button size="sm" variant="primary" onClick={() => void run()} disabled={running} title={`${t("query.run")} (${modKey}+Enter)`}>
          {running ? <Spinner /> : <Icon name="play" size={13} />} {t("query.run")}
        </Button>
        {running && (
          <Button size="sm" variant="danger" onClick={() => void cancel()}>
            <Icon name="square" size={12} /> {t("query.cancel")}
          </Button>
        )}
        {driver !== "redis" && (
          <Button size="sm" variant="ghost" onClick={() => void doExplain(false)} disabled={running || explaining} title={t("explain.hint")}>
            {explaining ? <Spinner /> : <Icon name="zap" size={13} />} {t("query.explain")}
          </Button>
        )}
        {driver !== "sqlite" && driver !== "redis" && (
          <Button size="sm" variant="ghost" onClick={() => void doExplain(true)} disabled={running || explaining} title={t("explain.analyzeHint")}>
            {t("explain.analyze")}
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
        <ToolButton icon="save" title={`${t("query.saveQuery")} (${modKey}+Shift+S)`} onClick={() => setSaving(true)} disabled={!(tab.sql ?? "").trim()} />
        <ToolButton icon="history" title={t("query.history")} active={showHistory} onClick={() => setShowHistory((v) => !v)} />
      </div>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
          <div className="query-editor" style={{ height: editorH }}>
            <Suspense fallback={<div className="editor-loading"><Spinner /></div>}>
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
            </Suspense>
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
            {!error && explain && <ExplainPanel result={explain} />}
            {!error && !results && !running && !explain && <div className="results-empty">{t("query.noResults")}</div>}
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
        <Suspense fallback={null}>
        <ValueDialog
          title={current.columns[viewer.c]?.name ?? ""}
          value={cellText(current.rows[viewer.r]?.[viewer.c] ?? null)}
          onClose={() => setViewer(null)}
        />
        </Suspense>
      )}
    </div>
  );
}
