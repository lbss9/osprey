import { useTranslation } from "react-i18next";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";
import Input from "@/components/atoms/Input";
import Dropdown from "@/components/molecules/Dropdown";
import ToolButton from "@/components/molecules/ToolButton";
import type { FilterOp, ResultColumn, TableFilter } from "@/types";

const OPS: FilterOp[] = ["eq", "neq", "contains", "starts", "ends", "gt", "gte", "lt", "lte", "in", "isnull", "notnull"];

/** No-code filters for the table view plus an optional raw WHERE line. */
export default function FilterBar({
  columns,
  filters,
  rawWhere,
  onChange,
  onRawChange,
  onApply,
  sqlShown,
  onToggleSql,
}: {
  columns: ResultColumn[];
  filters: TableFilter[];
  rawWhere: string | null;
  onChange: (filters: TableFilter[]) => void;
  onRawChange: (raw: string | null) => void;
  onApply: () => void;
  /** the "show SQL" toggle: what the grid is running right now */
  sqlShown?: boolean;
  onToggleSql?: () => void;
}) {
  const { t } = useTranslation();
  const update = (i: number, patch: Partial<TableFilter>) => onChange(filters.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const remove = (i: number) => onChange(filters.filter((_, j) => j !== i));
  const needsValue = (op: FilterOp) => op !== "isnull" && op !== "notnull";
  const onKey = (e: React.KeyboardEvent) => e.key === "Enter" && onApply();
  const colOptions = columns.map((c) => ({ value: c.name, label: c.name, hint: c.dataType }));
  const opOptions = OPS.map((op) => ({ value: op, label: t(`filters.ops.${op}`) }));

  return (
    <div className="filterbar">
      {filters.map((f, i) => (
        <div className="filter-row" key={i}>
          <span className="f-where">{i === 0 ? t("filters.where") : "AND"}</span>
          <Dropdown size="sm" className="f-col" value={f.column} options={colOptions} onChange={(v) => update(i, { column: v })} ariaLabel={t("filters.column")} />
          <Dropdown size="sm" className="f-op" value={f.op} options={opOptions} onChange={(v) => update(i, { op: v as FilterOp })} ariaLabel={t("filters.op")} />
          {needsValue(f.op) ? (
            <Input small mono className="f-val" value={f.value ?? ""} placeholder={t("filters.value")} onChange={(e) => update(i, { value: e.target.value })} onKeyDown={onKey} autoFocus={i === filters.length - 1 && !f.value} />
          ) : (
            <span className="f-val" />
          )}
          <ToolButton icon="x" title={t("common.delete")} onClick={() => remove(i)} />
        </div>
      ))}
      {rawWhere !== null && (
        <div className="filter-row">
          <span className="f-where">{filters.length ? "AND" : t("filters.where")}</span>
          <Input small mono className="f-val" value={rawWhere} placeholder={t("filters.rawWhere")} onChange={(e) => onRawChange(e.target.value)} onKeyDown={onKey} autoFocus />
          <ToolButton icon="x" title={t("common.delete")} onClick={() => onRawChange(null)} />
        </div>
      )}
      <div className="filter-row">
        <span className="f-where" />
        <Button size="sm" variant="secondary" onClick={() => onChange([...filters, { column: columns[0]?.name ?? "", op: "eq", value: "" }])}>
          <Icon name="plus" size={13} /> {t("filters.add")}
        </Button>
        {rawWhere === null && (
          <Button size="sm" variant="ghost" onClick={() => onRawChange("")}>
            <Icon name="fileCode" size={13} /> {t("filters.rawWhere")}
          </Button>
        )}
        <span className="grow" style={{ flex: 1 }} />
        {onToggleSql && (
          <Button size="sm" variant={sqlShown ? "secondary" : "ghost"} active={sqlShown} onClick={onToggleSql} title={t("filters.showSqlHint")}>
            <Icon name="terminal" size={13} /> {sqlShown ? t("filters.hideSql") : t("filters.showSql")}
          </Button>
        )}
        {(filters.length > 0 || rawWhere) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onChange([]);
              onRawChange(null);
            }}
          >
            {t("filters.clear")}
          </Button>
        )}
        <Button size="sm" variant="primary" onClick={onApply}>
          <Icon name="play" size={12} /> {t("common.apply")}
        </Button>
      </div>
    </div>
  );
}
