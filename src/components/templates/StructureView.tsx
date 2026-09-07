import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Badge from "@/components/atoms/Badge";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";
import Spinner from "@/components/atoms/Spinner";
import ToolButton from "@/components/molecules/ToolButton";
import ConnChip from "@/components/molecules/ConnChip";
import { useContextMenu } from "@/components/molecules/ContextMenu";
import { useUi } from "@/store/ui";
import { useWorkspace } from "@/store/workspace";
import { confirmDialog } from "@/utils/dialog";
import * as api from "@/services/tauri";
import { translateError } from "@/i18n";
import { copyText } from "@/utils/clipboard";
import type { ColumnInfo, DdlOp, Tab, TableStructure } from "@/types";

/** Read-only view of columns, indexes, foreign keys and (MySQL) DDL. */
export default function StructureView({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const openTab = useWorkspace((s) => s.openTab);
  const toast = useWorkspace((s) => s.toast);
  const updateTab = useWorkspace((s) => s.updateTab);
  const conn = useWorkspace((s) => s.connections.find((c) => c.id === tab.connectionId));
  const setUi = useUi((s) => s.set);
  const { open } = useContextMenu();
  const [data, setData] = useState<TableStructure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const schema = tab.schema ?? "";
  const table = tab.table ?? "";

  const load = () => {
    setError(null);
    api.tableStructure(tab.connectionId, schema, table).then(setData).catch((e) => setError(translateError(e)));
  };
  useEffect(load, [tab.connectionId, schema, table]);

  // reload after the structure editor ran something on this table
  useEffect(() => {
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent).detail as { connectionId: string; schema: string; table?: string };
      if (d.connectionId !== tab.connectionId || d.schema !== schema) return;
      if (d.table && d.table !== table) {
        // renamed
        updateTab(tab.id, { table: d.table, title: d.table });
        return;
      }
      load();
    };
    window.addEventListener("osprey-structure-changed", onChanged);
    return () => window.removeEventListener("osprey-structure-changed", onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.connectionId, tab.id, schema, table]);

  const editable = !conn?.readOnly;
  const openEditor = (mode: "addColumn" | "alterColumn" | "createIndex" | "renameTable", column?: ColumnInfo) =>
    setUi({ ddlDialog: { connectionId: tab.connectionId, schema, table, mode, column, columns: data?.columns } });
  const runDdl = async (op: DdlOp, confirmText: string) => {
    if (!(await confirmDialog(confirmText))) return;
    try {
      await api.ddlApply(tab.connectionId, op);
      toast(t("ddl.applied"), "success");
      load();
    } catch (e) {
      toast(translateError(e), "error");
    }
  };

  return (
    <div className="main-body">
      <div className="toolbar">
        <div className="crumb">
          <Icon name="list" size={14} style={{ color: "var(--accent)" }} />
          <span>{schema}</span>
          <span className="sep-dot">/</span>
          <b>{table}</b>
        </div>
        <ConnChip connectionId={tab.connectionId} />
        <span className="grow" />
        <ToolButton icon="refresh" title={t("common.refresh")} onClick={load} />
        <Button size="sm" onClick={() => openTab({ kind: "table", connectionId: tab.connectionId, title: table, schema, table })}>
          <Icon name="table" size={14} /> {t("sidebar.openTable")}
        </Button>
        {editable && (
          <>
            <span className="sep" />
            <Button size="sm" variant="secondary" onClick={() => openEditor("addColumn")}>
              <Icon name="plus" size={13} /> {t("ddl.addColumn")}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => openEditor("createIndex")}>
              <Icon name="plus" size={13} /> {t("ddl.createIndex")}
            </Button>
            <ToolButton icon="pencil" title={t("ddl.renameTable")} onClick={() => openEditor("renameTable")} />
          </>
        )}
      </div>
      {error && (
        <div className="messages">
          <span className="err">{error}</span>
        </div>
      )}
      {!error && !data && (
        <div className="results-empty">
          <Spinner size="lg" />
        </div>
      )}
      {data && (
        <div className="structure">
          <section>
            <h3>{t("structure.columns")}</h3>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 40 }} />
                  <th>{t("structure.column")}</th>
                  <th>{t("structure.type")}</th>
                  <th>{t("structure.nullable")}</th>
                  <th>{t("structure.default")}</th>
                  <th>{t("structure.comment")}</th>
                </tr>
              </thead>
              <tbody>
                {data.columns.map((c) => (
                  <tr
                    key={c.name}
                    className={editable ? "row-menu" : ""}
                    onDoubleClick={() => editable && openEditor("alterColumn", c)}
                    onContextMenu={(e) =>
                      editable &&
                      open(e, [
                        { label: t("ddl.alterColumn"), icon: "pencil", onSelect: () => openEditor("alterColumn", c) },
                        { label: t("ctx.copyName"), icon: "copy", onSelect: () => void copyText(c.name) },
                        { separator: true },
                        { label: t("ddl.dropColumn"), icon: "trash", danger: true, onSelect: () => void runDdl({ kind: "dropColumn", schema, table, name: c.name }, t("ddl.dropColumnConfirm", { name: c.name })) },
                      ])
                    }
                  >
                    <td>{c.primaryKey && <Icon name="key" size={12} style={{ color: "var(--amber)" }} />}</td>
                    <td className="mono">
                      {c.name}
                      {c.autoIncrement && (
                        <>
                          {" "}
                          <Badge tone="accent">auto</Badge>
                        </>
                      )}
                    </td>
                    <td className="mono" style={{ color: "var(--k-date)" }}>
                      {c.dataType}
                    </td>
                    <td>{c.nullable ? t("common.yes") : t("common.no")}</td>
                    <td className="mono faint">{c.default ?? ""}</td>
                    <td className="faint">{c.comment ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section>
            <h3>{t("structure.indexes")}</h3>
            {data.indexes.length === 0 ? (
              <div className="tree-empty">{t("structure.noIndexes")}</div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("common.name")}</th>
                    <th>{t("structure.columns")}</th>
                    <th>{t("common.type")}</th>
                    <th>{t("structure.ddl")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.indexes.map((ix) => (
                    <tr
                      key={ix.name}
                      className={editable && !ix.primary ? "row-menu" : ""}
                      onContextMenu={(e) =>
                        editable &&
                        !ix.primary &&
                        open(e, [
                          { label: t("ctx.copyName"), icon: "copy", onSelect: () => void copyText(ix.name) },
                          { separator: true },
                          { label: t("ddl.dropIndex"), icon: "trash", danger: true, onSelect: () => void runDdl({ kind: "dropIndex", schema, table, name: ix.name }, t("ddl.dropIndexConfirm", { name: ix.name })) },
                        ])
                      }
                    >
                      <td className="mono">{ix.name}</td>
                      <td className="mono">{ix.columns.join(", ")}</td>
                      <td>
                        {ix.primary ? <Badge tone="amber">{t("structure.primary")}</Badge> : ix.unique ? <Badge tone="accent">{t("structure.unique")}</Badge> : null}
                      </td>
                      <td className="mono faint">{ix.definition ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section>
            <h3>{t("structure.foreignKeys")}</h3>
            {data.foreignKeys.length === 0 ? (
              <div className="tree-empty">{t("structure.noFks")}</div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("common.name")}</th>
                    <th>{t("structure.columns")}</th>
                    <th>{t("structure.refs")}</th>
                    <th>{t("structure.onUpdate")}</th>
                    <th>{t("structure.onDelete")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.foreignKeys.map((fk) => (
                    <tr key={fk.name}>
                      <td className="mono">{fk.name}</td>
                      <td className="mono">{fk.columns.join(", ")}</td>
                      <td className="mono">
                        <Button
                          variant="bare"
                          style={{ color: "var(--accent)", cursor: "pointer" }}
                          onClick={() => openTab({ kind: "table", connectionId: tab.connectionId, title: fk.refTable, schema: fk.refSchema, table: fk.refTable })}
                        >
                          {fk.refSchema}.{fk.refTable}
                        </Button>{" "}
                        ({fk.refColumns.join(", ")})
                      </td>
                      <td className="faint">{fk.onUpdate ?? ""}</td>
                      <td className="faint">{fk.onDelete ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          {data.ddl && (
            <section>
              <h3>
                {t("structure.ddl")}{" "}
                <ToolButton icon="copy" title={t("common.copy")} onClick={() => void copyText(data.ddl ?? "")} />
              </h3>
              <pre className="sql-preview">{data.ddl}</pre>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
