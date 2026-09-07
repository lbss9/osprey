import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Badge from "@/components/atoms/Badge";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";
import Input from "@/components/atoms/Input";
import Spinner from "@/components/atoms/Spinner";
import Dropdown from "@/components/molecules/Dropdown";
import Field from "@/components/molecules/Field";
import ToggleRow from "@/components/molecules/ToggleRow";
import ToolButton from "@/components/molecules/ToolButton";
import DataGrid from "@/components/organisms/DataGrid";
import { useUi } from "@/store/ui";
import { useWorkspace } from "@/store/workspace";
import * as api from "@/services/tauri";
import { translateError } from "@/i18n";
import { openFileDialog } from "@/utils/dialog";
import { formatDuration, formatNumber } from "@/utils/format";
import type { ColumnInfo, CsvPreview } from "@/types";

const DELIMS = [
  { value: ",", label: "," },
  { value: ";", label: ";" },
  { value: "\t", label: "Tab" },
  { value: "|", label: "|" },
];

/**
 * CSV → table. Pick a file, check the preview, map CSV columns to table
 * columns (auto-matched by name), run. With no target table the dialog
 * creates one with every mapped column as text.
 */
export default function ImportDialog() {
  const { t } = useTranslation();
  const dlg = useUi((s) => s.importDialog);
  const close = () => useUi.getState().set({ importDialog: null });
  const toast = useWorkspace((s) => s.toast);
  const reloadTables = useWorkspace((s) => s.loadTables);
  const [path, setPath] = useState("");
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [delimiter, setDelimiter] = useState(",");
  const [hasHeader, setHasHeader] = useState(true);
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [tableName, setTableName] = useState("");
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const creating = !!dlg && !dlg.table;

  useEffect(() => {
    if (!dlg) return;
    setPath("");
    setPreview(null);
    setError(null);
    setBusy(null);
    setMapping({});
    setTableName("");
    if (dlg.table) {
      api.tableColumns(dlg.connectionId, dlg.schema, dlg.table).then(setColumns).catch(() => setColumns([]));
    } else {
      setColumns([]);
    }
  }, [dlg]);

  useEffect(() => {
    if (!dlg) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dlg, busy]);

  if (!dlg) return null;

  const autoMap = (p: CsvPreview, cols: ColumnInfo[]) => {
    const m: Record<number, string> = {};
    p.columns.forEach((c, i) => {
      if (creating) {
        m[i] = c.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || `column${i + 1}`;
      } else {
        const hit = cols.find((x) => x.name.toLowerCase() === c.toLowerCase()) ?? cols.find((x) => x.name.toLowerCase().replace(/_/g, "") === c.toLowerCase().replace(/[^a-z0-9]/gi, ""));
        if (hit) m[i] = hit.name;
      }
    });
    setMapping(m);
  };

  const load = async (p: string, d?: string, h?: boolean) => {
    setBusy("preview");
    setError(null);
    try {
      const res = await api.csvPreview(p, d, h);
      setPreview(res);
      setDelimiter(res.delimiter);
      setHasHeader(res.hasHeader);
      autoMap(res, columns);
      if (creating && !tableName) setTableName(p.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "").replace(/[^\w]+/g, "_").toLowerCase() ?? "import");
    } catch (e) {
      setError(translateError(e));
      setPreview(null);
    } finally {
      setBusy(null);
    }
  };

  const pick = async () => {
    const p = await openFileDialog(t("import.pickFile"));
    if (!p) return;
    setPath(p);
    await load(p);
  };

  const mapped = Object.entries(mapping).filter(([, col]) => col).map(([i, col]) => ({ csvIndex: Number(i), column: col }));
  const canRun = !!preview && mapped.length > 0 && (!creating || tableName.trim().length > 0) && !busy;

  const run = async () => {
    if (!canRun || !dlg) return;
    setBusy("import");
    setError(null);
    try {
      const table = dlg.table ?? tableName.trim();
      const res = await api.csvImport(dlg.connectionId, { schema: dlg.schema, table, path, delimiter, hasHeader, mapping: mapped, emptyAsNull, batchSize: 500, createTable: creating });
      toast(t("import.done", { count: formatNumber(res.inserted), time: formatDuration(res.elapsedMs) }), "success");
      close();
      void reloadTables(dlg.connectionId, dlg.schema);
      window.dispatchEvent(new CustomEvent("osprey-refresh"));
    } catch (e) {
      setError(translateError(e));
    } finally {
      setBusy(null);
    }
  };

  const gridColumns = (preview?.columns ?? []).map((c) => ({ name: c, dataType: "text", kind: "string" as const }));
  const targetOptions = [{ value: "", label: t("import.skip") }, ...columns.map((c) => ({ value: c.name, label: c.name, hint: c.dataType }))];

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && close()}>
      <div className="dialog wide" style={{ height: "min(720px, calc(100vh - 60px))" }}>
        <div className="dialog-head">
          <h2>
            {t("import.title")}
            <span style={{ color: "var(--text-faint)", fontWeight: 400 }}> · {dlg.schema}{dlg.table ? `.${dlg.table}` : ""}</span>
          </h2>
          <ToolButton icon="x" title={t("common.close")} onClick={close} disabled={!!busy} />
        </div>
        <div className="dialog-body" style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
          <div className="form-grid">
            <Field label={t("import.file")} span2>
              <div className="input-row">
                <Input mono value={path} placeholder="data.csv" onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && path && void load(path)} />
                <Button variant="secondary" size="md" onClick={() => void pick()} disabled={!!busy}>
                  {busy === "preview" ? <Spinner /> : <Icon name="folder" size={14} />} {t("connection.browse")}
                </Button>
              </div>
            </Field>
            {creating && (
              <Field label={t("ddl.tableName")}>
                <Input mono value={tableName} onChange={(e) => setTableName(e.target.value)} />
              </Field>
            )}
            <Field label={t("import.delimiter")}>
              <Dropdown value={delimiter} options={DELIMS} onChange={(v) => { setDelimiter(v); if (path) void load(path, v, hasHeader); }} />
            </Field>
            <div>
              <ToggleRow label={t("import.header")} checked={hasHeader} onChange={(v) => { setHasHeader(v); if (path) void load(path, delimiter, v); }} />
            </div>
            <div>
              <ToggleRow label={t("import.emptyNull")} checked={emptyAsNull} onChange={setEmptyAsNull} />
            </div>
          </div>
          {preview && (
            <>
              <div className="import-map">
                <div className="import-map-head">
                  <span>{t("import.csvColumn")}</span>
                  <span />
                  <span>{creating ? t("ddl.columnName") : t("import.tableColumn")}</span>
                </div>
                {preview.columns.map((c, i) => (
                  <div className="import-map-row" key={i}>
                    <span className="mono">{c}</span>
                    <Icon name="chevronRight" size={13} style={{ color: "var(--text-faint)" }} />
                    {creating ? (
                      <Input mono small value={mapping[i] ?? ""} placeholder={t("import.skip")} onChange={(e) => setMapping((m) => ({ ...m, [i]: e.target.value }))} />
                    ) : (
                      <Dropdown size="sm" value={mapping[i] ?? ""} options={targetOptions} onChange={(v) => setMapping((m) => ({ ...m, [i]: v }))} placeholder={t("import.skip")} />
                    )}
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <Badge tone="accent">{t("import.rows", { count: formatNumber(preview.totalRows) })}{preview.truncatedCount ? "+" : ""}</Badge>
                <Badge>{t("import.mapped", { count: mapped.length, total: preview.columns.length })}</Badge>
              </div>
              <div style={{ flex: 1, minHeight: 160, display: "flex", flexDirection: "column", border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
                <DataGrid columns={gridColumns} rows={preview.rows} emptyText={t("grid.empty")} />
              </div>
            </>
          )}
          {error && (
            <div className="callout danger">
              <Icon name="alert" size={15} />
              <span>{error}</span>
            </div>
          )}
        </div>
        <div className="dialog-foot">
          <span className="grow" />
          <Button variant="ghost" onClick={close} disabled={!!busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void run()} disabled={!canRun}>
            {busy === "import" ? <Spinner /> : <Icon name="download" size={14} />} {t("import.run")}
          </Button>
        </div>
      </div>
    </div>
  );
}
