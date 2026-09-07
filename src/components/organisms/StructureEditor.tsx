import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";
import Input from "@/components/atoms/Input";
import Spinner from "@/components/atoms/Spinner";
import Toggle from "@/components/atoms/Toggle";
import Field from "@/components/molecules/Field";
import SqlPreview from "@/components/molecules/SqlPreview";
import ToggleRow from "@/components/molecules/ToggleRow";
import ToolButton from "@/components/molecules/ToolButton";
import { useUi, type DdlDialogState } from "@/store/ui";
import { useWorkspace } from "@/store/workspace";
import * as api from "@/services/tauri";
import { translateError } from "@/i18n";
import type { DdlColumn, DdlOp } from "@/types";

const TYPE_HINTS: Record<string, string[]> = {
  postgres: ["integer", "bigint", "serial", "text", "varchar(255)", "boolean", "numeric(12,2)", "timestamptz", "date", "jsonb", "uuid"],
  mysql: ["INT", "BIGINT", "VARCHAR(255)", "TEXT", "TINYINT(1)", "DECIMAL(12,2)", "DATETIME", "DATE", "JSON"],
  sqlite: ["INTEGER", "TEXT", "REAL", "BLOB", "NUMERIC"],
  redis: [],
};

function blankColumn(): DdlColumn {
  return { name: "", dataType: "", nullable: true, default: null, primaryKey: false, autoIncrement: false };
}

/**
 * Guided structure edits: create table, add/alter column, create index,
 * rename table. Every path shows the exact DDL before running it.
 */
export default function StructureEditor() {
  const { t } = useTranslation();
  const dlg = useUi((s) => s.ddlDialog);
  const closeDlg = () => useUi.getState().set({ ddlDialog: null });
  const toast = useWorkspace((s) => s.toast);
  const connections = useWorkspace((s) => s.connections);
  const reloadTables = useWorkspace((s) => s.loadTables);
  const [columns, setColumns] = useState<DdlColumn[]>([blankColumn()]);
  const [tableName, setTableName] = useState("");
  const [indexName, setIndexName] = useState("");
  const [unique, setUnique] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [setDefault, setSetDefault] = useState(false);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!dlg) return;
    setPreview(null);
    setError(null);
    setBusy(false);
    setSetDefault(false);
    setUnique(false);
    setPicked([]);
    setIndexName("");
    setTableName(dlg.mode === "renameTable" ? dlg.table ?? "" : "");
    if (dlg.mode === "alterColumn" && dlg.column) {
      setColumns([{ name: dlg.column.name, dataType: dlg.column.dataType, nullable: dlg.column.nullable, default: dlg.column.default ?? null, primaryKey: dlg.column.primaryKey, autoIncrement: dlg.column.autoIncrement }]);
    } else {
      setColumns([blankColumn()]);
    }
  }, [dlg]);

  useEffect(() => {
    if (!dlg) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        closeDlg();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dlg, busy]);

  if (!dlg) return null;
  const conn = connections.find((c) => c.id === dlg.connectionId);
  const driver = conn?.driver ?? "postgres";
  const isSqlite = driver === "sqlite";

  const buildOp = (): DdlOp | null => {
    const schema = dlg.schema;
    const table = dlg.table ?? tableName.trim();
    switch (dlg.mode) {
      case "createTable":
        if (!tableName.trim() || columns.some((c) => !c.name.trim() || !c.dataType.trim())) return null;
        return { kind: "createTable", schema, table: tableName.trim(), columns };
      case "addColumn":
        if (!columns[0].name.trim() || !columns[0].dataType.trim()) return null;
        return { kind: "addColumn", schema, table, column: columns[0] };
      case "alterColumn": {
        const c = columns[0];
        const orig = dlg.column!;
        return {
          kind: "alterColumn",
          schema,
          table,
          name: orig.name,
          newName: c.name.trim() !== orig.name ? c.name.trim() : undefined,
          dataType: c.dataType.trim() !== orig.dataType || (driver === "mysql" && (c.nullable !== orig.nullable || setDefault)) ? c.dataType.trim() : undefined,
          nullable: c.nullable !== orig.nullable ? c.nullable : undefined,
          setDefault,
          default: setDefault ? c.default : undefined,
        };
      }
      case "createIndex":
        if (!indexName.trim() || picked.length === 0) return null;
        return { kind: "createIndex", schema, table, name: indexName.trim(), columns: picked, unique };
      case "renameTable":
        if (!tableName.trim() || tableName.trim() === dlg.table) return null;
        return { kind: "renameTable", schema, table, newName: tableName.trim() };
    }
  };

  const doPreview = async () => {
    const op = buildOp();
    if (!op) return;
    setError(null);
    try {
      setPreview(await api.ddlPreview(dlg.connectionId, op));
    } catch (e) {
      setError(translateError(e));
    }
  };

  const doApply = async () => {
    const op = buildOp();
    if (!op) return;
    setBusy(true);
    setError(null);
    try {
      await api.ddlApply(dlg.connectionId, op);
      toast(t("ddl.applied"), "success");
      closeDlg();
      void reloadTables(dlg.connectionId, dlg.schema);
      window.dispatchEvent(new CustomEvent("osprey-structure-changed", { detail: { connectionId: dlg.connectionId, schema: dlg.schema, table: op.kind === "renameTable" ? op.newName : op.kind === "createTable" ? op.table : dlg.table } }));
    } catch (e) {
      setError(translateError(e));
    } finally {
      setBusy(false);
    }
  };

  const updateCol = (i: number, patch: Partial<DdlColumn>) => setColumns((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const valid = buildOp() !== null;

  const columnRow = (c: DdlColumn, i: number, removable: boolean) => (
    <div className="ddl-col" key={i}>
      <Input mono placeholder={t("ddl.columnName")} value={c.name} onChange={(e) => updateCol(i, { name: e.target.value })} autoFocus={i === 0} />
      <Input mono placeholder={t("ddl.type")} value={c.dataType} list={`ddl-types-${driver}`} onChange={(e) => updateCol(i, { dataType: e.target.value })} disabled={isSqlite && dlg.mode === "alterColumn"} />
      <Input mono placeholder={t("ddl.default")} value={c.default ?? ""} onChange={(e) => updateCol(i, { default: e.target.value || null })} disabled={dlg.mode === "alterColumn" && (!setDefault || isSqlite)} />
      <label className="ddl-flag" title={t("structure.nullable")}>
        <Toggle checked={c.nullable} onChange={(v) => updateCol(i, { nullable: v })} disabled={c.primaryKey || (isSqlite && dlg.mode === "alterColumn")} />
        <span>NULL</span>
      </label>
      {dlg.mode !== "alterColumn" && (
        <>
          <label className="ddl-flag" title={t("structure.primary")}>
            <Toggle checked={c.primaryKey} onChange={(v) => updateCol(i, { primaryKey: v, nullable: v ? false : c.nullable })} />
            <span>PK</span>
          </label>
          <label className="ddl-flag" title={t("ddl.autoIncrement")}>
            <Toggle checked={c.autoIncrement} onChange={(v) => updateCol(i, { autoIncrement: v })} />
            <span>auto</span>
          </label>
        </>
      )}
      {removable && <ToolButton icon="x" title={t("common.delete")} onClick={() => setColumns((cs) => cs.filter((_, j) => j !== i))} />}
    </div>
  );

  const titles: Record<DdlDialogState["mode"], string> = {
    createTable: t("ddl.createTable"),
    addColumn: t("ddl.addColumn"),
    alterColumn: t("ddl.alterColumn"),
    createIndex: t("ddl.createIndex"),
    renameTable: t("ddl.renameTable"),
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && closeDlg()}>
      <div className="dialog wide">
        <div className="dialog-head">
          <h2>
            {titles[dlg.mode]}
            <span style={{ color: "var(--text-faint)", fontWeight: 400 }}> · {dlg.schema}{dlg.table ? `.${dlg.table}` : ""}</span>
          </h2>
          <ToolButton icon="x" title={t("common.close")} onClick={closeDlg} disabled={busy} />
        </div>
        <div className="dialog-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <datalist id={`ddl-types-${driver}`}>
            {(TYPE_HINTS[driver] ?? []).map((ty) => (
              <option key={ty} value={ty} />
            ))}
          </datalist>
          {(dlg.mode === "createTable" || dlg.mode === "renameTable") && (
            <Field label={dlg.mode === "renameTable" ? t("ddl.newName") : t("ddl.tableName")}>
              <Input mono value={tableName} onChange={(e) => setTableName(e.target.value)} autoFocus />
            </Field>
          )}
          {(dlg.mode === "createTable" || dlg.mode === "addColumn" || dlg.mode === "alterColumn") && (
            <div className="ddl-cols">
              <div className="ddl-col ddl-head">
                <span>{t("structure.column")}</span>
                <span>{t("structure.type")}</span>
                <span>{t("structure.default")}</span>
                <span />
              </div>
              {columns.map((c, i) => columnRow(c, i, dlg.mode === "createTable" && columns.length > 1))}
              {dlg.mode === "createTable" && (
                <Button size="sm" variant="secondary" onClick={() => setColumns((cs) => [...cs, blankColumn()])} style={{ alignSelf: "flex-start" }}>
                  <Icon name="plus" size={13} /> {t("ddl.addColumn")}
                </Button>
              )}
              {dlg.mode === "alterColumn" && !isSqlite && <ToggleRow label={t("ddl.changeDefault")} desc={t("ddl.changeDefaultHint")} checked={setDefault} onChange={setSetDefault} />}
              {dlg.mode === "alterColumn" && isSqlite && (
                <div className="callout">
                  <Icon name="info" size={15} />
                  <span>{t("ddl.sqliteAlter")}</span>
                </div>
              )}
            </div>
          )}
          {dlg.mode === "createIndex" && (
            <>
              <div className="form-grid">
                <Field label={t("ddl.indexName")}>
                  <Input mono value={indexName} onChange={(e) => setIndexName(e.target.value)} autoFocus placeholder={`${dlg.table}_${picked.join("_") || "col"}_idx`} />
                </Field>
                <div>
                  <ToggleRow label={t("structure.unique")} checked={unique} onChange={setUnique} />
                </div>
              </div>
              <div className="ddl-pick">
                {(dlg.columns ?? []).map((c) => {
                  const on = picked.includes(c.name);
                  return (
                    <Button key={c.name} variant={on ? "secondary" : "ghost"} size="sm" active={on} onClick={() => setPicked((p) => (on ? p.filter((x) => x !== c.name) : [...p, c.name]))}>
                      {on && <span className="ddl-order">{picked.indexOf(c.name) + 1}</span>}
                      {c.name}
                      <span style={{ color: "var(--text-faint)", fontSize: "0.85em" }}>{c.dataType}</span>
                    </Button>
                  );
                })}
              </div>
            </>
          )}
          {preview && <SqlPreview statements={preview} />}
          {error && (
            <div className="callout danger">
              <Icon name="alert" size={15} />
              <span>{error}</span>
            </div>
          )}
        </div>
        <div className="dialog-foot">
          <Button variant="ghost" onClick={() => void doPreview()} disabled={!valid || busy}>
            <Icon name="eye" size={14} /> {t("changes.preview")}
          </Button>
          <span className="grow" />
          <Button variant="ghost" onClick={closeDlg} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void doApply()} disabled={!valid || busy}>
            {busy ? <Spinner /> : <Icon name="check" size={14} />} {t("ddl.run")}
          </Button>
        </div>
      </div>
    </div>
  );
}
