import { useTranslation } from "react-i18next";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";
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
}: {
  columns: ResultColumn[];
  filters: TableFilter[];
  rawWhere: string | null;
  onChange: (filters: TableFilter[]) => void;
  onRawChange: (raw: string | null) => void;
  onApply: () => void;
}) {
  const { t } = useTranslation();
  const update = (i: number, patch: Partial<TableFilter>) =>
    onChange(filters.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const remove = (i: number) => onChange(filters.filter((_, j) => j !== i));
  const needsValue = (op: FilterOp) => op !== "isnull" && op !== "notnull";
  const onKey = (e: React.KeyboardEvent) => e.key === "Enter" && onApply();

  return (
    <div className="filterbar">
      {filters.map((f, i) => (
        <div className="filter-row" key={i}>
          <span className="f-where">{i === 0 ? t("filters.where") : "AND"}</span>
          <select className="select f-col" value={f.column} onChange={(e) => update(i, { column: e.target.value })}>
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          <select className="select f-op" value={f.op} onChange={(e) => update(i, { op: e.target.value as FilterOp })}>
            {OPS.map((op) => (
              <option key={op} value={op}>
                {t(`filters.ops.${op}`)}
              </option>
            ))}
          </select>
          {needsValue(f.op) ? (
            <input
              className="input f-val mono"
              value={f.value ?? ""}
              placeholder={t("filters.value")}
              onChange={(e) => update(i, { value: e.target.value })}
              onKeyDown={onKey}
              autoFocus={i === filters.length - 1 && !f.value}
            />
          ) : (
            <span className="f-val" />
          )}
          <Button size="sm" icon onClick={() => remove(i)} title={t("common.delete")}>
            <Icon name="x" size={13} />
          </Button>
        </div>
      ))}
      {rawWhere !== null && (
        <div className="filter-row">
          <span className="f-where">{filters.length ? "AND" : t("filters.where")}</span>
          <input
            className="input f-val mono"
            value={rawWhere}
            placeholder={t("filters.rawWhere")}
            onChange={(e) => onRawChange(e.target.value)}
            onKeyDown={onKey}
            autoFocus
          />
          <Button size="sm" icon onClick={() => onRawChange(null)} title={t("common.delete")}>
            <Icon name="x" size={13} />
          </Button>
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
        {(filters.length > 0 || rawWhere) && (
          <Button size="sm" variant="ghost" onClick={() => { onChange([]); onRawChange(null); }}>
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
