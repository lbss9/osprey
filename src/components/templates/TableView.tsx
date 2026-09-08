import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

const ValueDialog = lazy(() => import("@/components/molecules/ValueDialog"));
import { useTranslation } from "react-i18next";
import Badge from "@/components/atoms/Badge";
import Button from "@/components/atoms/Button";
import Resizer from "@/components/atoms/Resizer";
import Icon from "@/components/atoms/Icon";
import Dropdown from "@/components/molecules/Dropdown";
import ToolButton from "@/components/molecules/ToolButton";
import ApplyDialog from "@/components/molecules/ApplyDialog";
import ConnChip from "@/components/molecules/ConnChip";
import ExportMenu from "@/components/molecules/ExportMenu";
import StatusBar from "@/components/molecules/StatusBar";
import DataGrid, { type GridEdits } from "@/components/organisms/DataGrid";
import FilterBar from "@/components/organisms/FilterBar";
import { useUi } from "@/store/ui";
import { connectionIdOf } from "@/utils/session";
import { useWorkspace } from "@/store/workspace";
import * as api from "@/services/tauri";
import { copyText } from "@/utils/clipboard";
import { translateError } from "@/i18n";
import { cellText, formatDuration, formatNumber, quoteIdent, rowToInsert, modKey } from "@/utils/format";
import type { Cell, ColumnInfo, EditValue, ResultSet, RowChange, SortSpec, Tab, TableFilter, TablePageRequest } from "@/types";

interface Edits {
  cells: Record<string, EditValue>;
  deleted: Set<number>;
  inserted: Record<string, EditValue>[];
}

const EMPTY_EDITS: Edits = { cells: {}, deleted: new Set(), inserted: [] };

/** Browse and edit one table: server-side filters, sort, pagination; batched edits. */
export default function TableView({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const conn = useWorkspace((s) => s.connections.find((c) => c.id === connectionIdOf(tab.connectionId)));
  const toast = useWorkspace((s) => s.toast);
  const updateTab = useWorkspace((s) => s.updateTab);
  const openTab = useWorkspace((s) => s.openTab);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const pageSize = useUi((s) => s.pageSize);
  const safeMode = useUi((s) => s.safeMode);

  const schema = tab.schema ?? "";
  const table = tab.table ?? "";
  const driver = conn?.driver ?? "postgres";

  const [filters, setFilters] = useState<TableFilter[]>([]);
  const [rawWhere, setRawWhere] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [sort, setSort] = useState<SortSpec | undefined>();
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<ResultSet | null>(null);
  const [total, setTotal] = useState<number | "counting" | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<ColumnInfo[]>([]);
  const [edits, setEdits] = useState<Edits>(EMPTY_EDITS);
  const [preview, setPreview] = useState<{ statements: string[]; previewOnly: boolean } | null>(null);
  const [applying, setApplying] = useState(false);
  const [viewer, setViewer] = useState<{ r: number; c: number } | null>(null);
  const reqSeq = useRef(0);
  const appliedFilters = useRef<{ filters: TableFilter[]; raw: string | null }>({ filters: [], raw: null });
  const [showSql, setShowSql] = useState(false);
  const sqlDrawerWidth = useUi((s) => s.sqlDrawerWidth);
  const setUi = useUi((s) => s.set);
  const [currentSql, setCurrentSql] = useState<string>("");

  const buildReq = useCallback(
    (limit = pageSize, off = offset): TablePageRequest => ({
      schema,
      table,
      filters: appliedFilters.current.filters.filter((f) => f.column),
      rawWhere: appliedFilters.current.raw ?? undefined,
      sort,
      limit,
      offset: off,
    }),
    [schema, table, sort, pageSize, offset],
  );

  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    try {
      const req = buildReq();
      // the statement the grid runs, kept in sync with every reload
      api.tableSql(tab.connectionId, req).then((sql) => seq === reqSeq.current && setCurrentSql(sql)).catch(() => {});
      const res = await api.tablePage(tab.connectionId, req);
      if (seq !== reqSeq.current) return;
      setResult(res);
      setEdits(EMPTY_EDITS);
      updateTab(tab.id, { dirty: false });
      setTotal("counting");
      api
        .tableCount(tab.connectionId, req)
        .then((n) => seq === reqSeq.current && setTotal(n))
        .catch(() => seq === reqSeq.current && setTotal(null));
    } catch (e) {
      if (seq !== reqSeq.current) return;
      setError(translateError(e));
      setResult(null);
      setTotal(null);
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [buildReq, tab.connectionId, tab.id, updateTab]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api.tableColumns(tab.connectionId, schema, table).then(setMeta).catch(() => setMeta([]));
  }, [tab.connectionId, schema, table]);

  // Ctrl+R / Ctrl+S from the app shell. The apply handler is read through a
  // ref so the listener always sees the current pending edits.
  const applyRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onRefresh = () => activeTabId === tab.id && void load();
    const onApply = () => activeTabId === tab.id && applyRef.current();
    window.addEventListener("osprey-refresh", onRefresh);
    window.addEventListener("osprey-apply", onApply);
    return () => {
      window.removeEventListener("osprey-refresh", onRefresh);
      window.removeEventListener("osprey-apply", onApply);
    };
  }, [activeTabId, tab.id, load]);

  const columns = result?.columns ?? [];
  const pk = useMemo(() => meta.filter((c) => c.primaryKey).map((c) => c.name), [meta]);
  const editable = pk.length > 0 && !conn?.readOnly;

  /* ------------------------------ derived rows ------------------------------ */
  const baseRows = result?.rows ?? [];
  const rows: Cell[][] = useMemo(() => {
    if (!edits.inserted.length) return baseRows;
    const extra = edits.inserted.map((rec) =>
      columns.map((c) => {
        const v = rec[c.name];
        return v === undefined ? null : typeof v === "object" && v !== null ? null : v;
      }),
    );
    return [...baseRows, ...extra];
  }, [baseRows, edits.inserted, columns]);

  const gridEdits: GridEdits = useMemo(
    () => ({ cells: edits.cells, deleted: edits.deleted, insertedFrom: baseRows.length }),
    [edits, baseRows.length],
  );
  const changeCount = Object.keys(edits.cells).length + edits.deleted.size + edits.inserted.length;

  const markDirty = (next: Edits) => {
    setEdits(next);
    updateTab(tab.id, { dirty: Object.keys(next.cells).length + next.deleted.size + next.inserted.length > 0 });
  };

  const onEdit = (r: number, c: number, value: EditValue) => {
    const col = columns[c];
    if (!col) return;
    if (r >= baseRows.length) {
      const inserted = edits.inserted.map((rec, i) => (i === r - baseRows.length ? { ...rec, [col.name]: value } : rec));
      markDirty({ ...edits, inserted });
      return;
    }
    const key = `${r}:${c}`;
    const original = baseRows[r][c];
    const cells = { ...edits.cells };
    const same = typeof value !== "object" && value === original;
    if (same) delete cells[key];
    else cells[key] = value;
    markDirty({ ...edits, cells });
  };

  const onDeleteRows = (list: number[]) => {
    const deleted = new Set(edits.deleted);
    let inserted = edits.inserted;
    const dropInserted = list.filter((r) => r >= baseRows.length).map((r) => r - baseRows.length);
    if (dropInserted.length) inserted = inserted.filter((_, i) => !dropInserted.includes(i));
    list.filter((r) => r < baseRows.length).forEach((r) => deleted.add(r));
    markDirty({ ...edits, deleted, inserted });
  };
  const onUndeleteRows = (list: number[]) => {
    const deleted = new Set(edits.deleted);
    list.forEach((r) => deleted.delete(r));
    markDirty({ ...edits, deleted });
  };
  const addRow = () => markDirty({ ...edits, inserted: [...edits.inserted, {}] });

  const buildChanges = (): RowChange[] => {
    const out: RowChange[] = [];
    const keyOf = (r: number) => {
      const key: Record<string, Cell> = {};
      pk.forEach((name) => {
        const i = columns.findIndex((c) => c.name === name);
        key[name] = i >= 0 ? baseRows[r][i] : null;
      });
      return key;
    };
    const byRow = new Map<number, Record<string, EditValue>>();
    for (const [k, v] of Object.entries(edits.cells)) {
      const [r, c] = k.split(":").map(Number);
      if (edits.deleted.has(r)) continue;
      if (!byRow.has(r)) byRow.set(r, {});
      byRow.get(r)![columns[c].name] = v;
    }
    for (const [r, set] of byRow) out.push({ kind: "update", key: keyOf(r), set });
    for (const r of edits.deleted) out.push({ kind: "delete", key: keyOf(r) });
    for (const rec of edits.inserted) {
      const values: Record<string, EditValue> = {};
      for (const [k, v] of Object.entries(rec)) if (v !== undefined) values[k] = v;
      out.push({ kind: "insert", values });
    }
    return out;
  };

  const openPreview = async (previewOnly: boolean) => {
    try {
      const res = await api.tableApply(tab.connectionId, { schema, table, changes: buildChanges(), preview: true });
      if (!previewOnly && !safeMode) {
        await runApply();
        return;
      }
      setPreview({ statements: res.statements, previewOnly });
    } catch (e) {
      toast(translateError(e), "error");
    }
  };

  const runApply = async () => {
    setApplying(true);
    try {
      const res = await api.tableApply(tab.connectionId, { schema, table, changes: buildChanges(), preview: false });
      toast(t("changes.applied", { count: res.affected }), "success");
      setPreview(null);
      await load();
    } catch (e) {
      toast(translateError(e), "error");
    } finally {
      setApplying(false);
    }
  };

  const discard = () => markDirty(EMPTY_EDITS);
  applyRef.current = () => {
    if (changeCount > 0 && !preview && !applying) void openPreview(false);
  };

  /* --------------------------------- filters -------------------------------- */
  const applyFilters = () => {
    appliedFilters.current = { filters, raw: rawWhere };
    setOffset(0);
    void load();
  };
  const filterByValue = (column: string, value: Cell) => {
    const f: TableFilter = value === null ? { column, op: "isnull" } : { column, op: "eq", value: cellText(value) };
    const next = [...filters, f];
    setFilters(next);
    setShowFilters(true);
    appliedFilters.current = { filters: next, raw: rawWhere };
    setOffset(0);
    void load();
  };
  const onSort = (column: string) => {
    setOffset(0);
    setSort((s) => (s?.column !== column ? { column, desc: false } : s.desc ? undefined : { column, desc: true }));
  };

  const activeFilterCount = appliedFilters.current.filters.length + (appliedFilters.current.raw ? 1 : 0);
  const qualified = `${quoteIdent(schema, driver)}.${quoteIdent(table, driver)}`;
  const from = offset + 1;
  const to = offset + baseRows.length;
  const canNext = typeof total === "number" ? to < total : baseRows.length === pageSize;

  return (
    <div className="main-body">
      <div className="toolbar">
        <div className="crumb">
          <Icon name="table" size={14} style={{ color: "var(--accent)" }} />
          <span>{schema}</span>
          <span className="sep-dot">/</span>
          <b>{table}</b>
        </div>
        <ConnChip connectionId={tab.connectionId} />
        <span className="grow" />
        <Button size="sm" variant={showFilters ? "secondary" : "ghost"} active={showFilters} onClick={() => setShowFilters((v) => !v)}>
          <Icon name="filter" size={14} /> {t("filters.add")}
          {activeFilterCount > 0 && <Badge tone="accent">{activeFilterCount}</Badge>}
        </Button>
        <ToolButton icon="refresh" title={`${t("common.refresh")} (${modKey}+R)`} onClick={() => void load()} busy={loading} />
        <ExportMenu columns={columns} rows={baseRows} baseName={table} table={qualified} />
        <span className="sep" />
        <Button size="sm" onClick={() => openTab({ kind: "structure", connectionId: tab.connectionId, title: table, schema, table })}>
          <Icon name="list" size={14} /> {t("tabs.structure")}
        </Button>
        {editable && (
          <Button size="sm" variant="secondary" onClick={addRow}>
            <Icon name="plus" size={14} /> {t("grid.addRow")}
          </Button>
        )}
      </div>
      {showFilters && columns.length > 0 && (
        <FilterBar
          columns={columns}
          filters={filters}
          rawWhere={rawWhere}
          onChange={setFilters}
          onRawChange={setRawWhere}
          onApply={applyFilters}
          sqlShown={showSql}
          onToggleSql={() => setShowSql((v) => !v)}
        />
      )}
      <div className="table-main">
      {error ? (
        <div className="messages">
          <span className="err">{error}</span>
        </div>
      ) : (
        <DataGrid
          columns={columns}
          rows={rows}
          loading={loading}
          pkColumns={pk}
          sort={sort}
          onSort={onSort}
          editable={editable}
          edits={gridEdits}
          onEdit={onEdit}
          onDeleteRows={onDeleteRows}
          onUndeleteRows={onUndeleteRows}
          onFilterByValue={filterByValue}
          onViewCell={(r, c) => setViewer({ r, c })}
          rowOffset={offset}
          onCopyAsInsert={(row) => rowToInsert(columns, row, qualified, driver)}
        />
      )}
      {showSql && (
        <>
          <Resizer direction="vertical" onDrag={(d) => setUi({ sqlDrawerWidth: Math.min(900, Math.max(240, sqlDrawerWidth - d)) })} />
          <aside className="sql-drawer" style={{ width: sqlDrawerWidth }}>
            <div className="sql-drawer-head">
              <Icon name="terminal" size={13} />
              <span>{t("filters.currentSql")}</span>
              <span className="grow" />
              <ToolButton
                icon="copy"
                title={t("common.copy")}
                onClick={() => {
                  void copyText(`${currentSql};`);
                  toast(t("grid.copied"), "success");
                }}
              />
              <ToolButton
                icon="fileCode"
                title={t("filters.openInQuery")}
                onClick={() => openTab({ kind: "query", connectionId: tab.connectionId, title: t("tabs.query"), sql: `${currentSql};\n` }, { reuse: false })}
              />
              <ToolButton icon="x" title={t("common.close")} onClick={() => setShowSql(false)} />
            </div>
            <pre className="table-sql-body">{currentSql}</pre>
            <div className="sql-drawer-foot">{t("filters.currentSqlHint")}</div>
          </aside>
        </>
      )}
      </div>
      {changeCount > 0 && (
        <div className="changes-bar">
          <Icon name="pencil" size={15} />
          <span>{t("changes.pending", { count: changeCount })}</span>
          <span className="grow" />
          <Button size="sm" variant="ghost" onClick={() => void openPreview(true)}>
            <Icon name="eye" size={14} /> {t("changes.preview")}
          </Button>
          <Button size="sm" variant="ghost" onClick={discard}>
            {t("changes.discard")}
          </Button>
          <Button size="sm" variant="success" onClick={() => void openPreview(false)} title={`${modKey}+S`}>
            <Icon name="check" size={14} /> {t("changes.apply")}
          </Button>
        </div>
      )}
      <StatusBar
        left={
          <>
            {result && (
              <span>
                {baseRows.length === 0
                  ? t("grid.rows", { count: 0 })
                  : total === "counting"
                    ? `${from}–${to} · ${t("grid.counting")}`
                    : typeof total === "number"
                      ? t("grid.rowsOf", { from: formatNumber(from), to: formatNumber(to), total: formatNumber(total) })
                      : `${from}–${to}`}
              </span>
            )}
            {result && <span style={{ color: "var(--text-faint)" }}>{formatDuration(result.elapsedMs)}</span>}
            {!editable && conn?.readOnly && <span className="warn">{t("grid.connectionReadOnly")}</span>}
            {!editable && !conn?.readOnly && meta.length > 0 && <span className="warn">{t("grid.readOnly")}</span>}
          </>
        }
        right={
          <div className="pager">
            <Dropdown
              size="sm"
              menuAlign="right"
              value={String(pageSize)}
              options={[50, 100, 200, 500, 1000].map((n) => ({ value: String(n), label: `${n}` }))}
              onChange={(v) => {
                useUi.getState().set({ pageSize: Number(v) });
                setOffset(0);
              }}
              title={t("grid.page")}
            />
            <ToolButton icon="chevronLeft" title={t("grid.prev")} disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - pageSize))} />
            <ToolButton icon="chevronRight" title={t("grid.next")} disabled={!canNext || loading} onClick={() => setOffset(offset + pageSize)} />
          </div>
        }
      />
      {preview && (
        <ApplyDialog
          statements={preview.statements}
          connectionName={conn?.name ?? ""}
          busy={applying}
          previewOnly={preview.previewOnly}
          onConfirm={() => void runApply()}
          onClose={() => setPreview(null)}
        />
      )}
      {viewer && columns[viewer.c] && (
        <Suspense fallback={null}>
        <ValueDialog
          title={`${table}.${columns[viewer.c].name}`}
          value={cellText(rows[viewer.r]?.[viewer.c] ?? null)}
          editable={editable}
          onSave={(text) => {
            onEdit(viewer.r, viewer.c, text);
            setViewer(null);
          }}
          onClose={() => setViewer(null)}
        />
        </Suspense>
      )}
    </div>
  );
}
