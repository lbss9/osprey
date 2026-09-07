import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Badge from "@/components/atoms/Badge";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";
import Spinner from "@/components/atoms/Spinner";
import ToolButton from "@/components/molecules/ToolButton";
import ConnChip from "@/components/molecules/ConnChip";
import { useWorkspace } from "@/store/workspace";
import * as api from "@/services/tauri";
import { translateError } from "@/i18n";
import { copyText } from "@/utils/clipboard";
import type { Tab, TableStructure } from "@/types";

/** Read-only view of columns, indexes, foreign keys and (MySQL) DDL. */
export default function StructureView({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const openTab = useWorkspace((s) => s.openTab);
  const [data, setData] = useState<TableStructure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const schema = tab.schema ?? "";
  const table = tab.table ?? "";

  const load = () => {
    setError(null);
    api.tableStructure(tab.connectionId, schema, table).then(setData).catch((e) => setError(translateError(e)));
  };
  useEffect(load, [tab.connectionId, schema, table]);

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
                  <tr key={c.name}>
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
                    <tr key={ix.name}>
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
