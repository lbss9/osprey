import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import Icon from "@/components/atoms/Icon";
import { useContextMenu, type ContextMenuItem } from "@/components/molecules/ContextMenu";
import { copyText } from "@/utils/clipboard";
import { cellEditText, cellText, parseEdited, rowToCsv, rowToJson, rowsToTsv } from "@/utils/format";
import type { Cell, EditValue, ResultColumn, SortSpec } from "@/types";

const ROW_H = 28;
const HEAD_H = 30;
const ROWNUM_W = 48;

export interface GridEdits {
  /** `${row}:${col}` → new value */
  cells: Record<string, EditValue>;
  deleted: Set<number>;
  /** rows with index >= insertedFrom were added in the grid */
  insertedFrom: number;
}

export interface DataGridProps {
  columns: ResultColumn[];
  rows: Cell[][];
  loading?: boolean;
  pkColumns?: string[];
  sort?: SortSpec;
  onSort?: (column: string) => void;
  editable?: boolean;
  edits?: GridEdits;
  onEdit?: (row: number, col: number, value: EditValue) => void;
  onDeleteRows?: (rows: number[]) => void;
  onUndeleteRows?: (rows: number[]) => void;
  onFilterByValue?: (column: string, value: Cell) => void;
  onViewCell?: (row: number, col: number) => void;
  /** first row number shown in the gutter (pagination offset) */
  rowOffset?: number;
  onCopyAsInsert?: (row: Cell[]) => string;
  emptyText?: string;
}

interface Pos {
  r: number;
  c: number;
}

function isDefault(v: EditValue): v is { $default: true } {
  return typeof v === "object" && v !== null && "$default" in v;
}

/**
 * Virtualized grid (rows and columns) with keyboard navigation, range
 * selection, inline editing and a context menu. It never mutates `rows`;
 * edits flow through `onEdit` and are painted from `edits`.
 */
export default function DataGrid(p: DataGridProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<Pos | null>(null);
  const [anchor, setAnchor] = useState<Pos | null>(null);
  const [editing, setEditing] = useState<(Pos & { text: string; selectAll: boolean }) | null>(null);
  const [widths, setWidths] = useState<number[]>([]);
  const { open: openMenu } = useContextMenu();
  const editRef = useRef<HTMLInputElement>(null);

  /* ------------------------------ column widths ----------------------------- */
  useEffect(() => {
    const sample = p.rows.slice(0, 60);
    setWidths(
      p.columns.map((col, ci) => {
        let chars = col.name.length + 4;
        for (const r of sample) {
          const txt = cellText(r[ci]);
          if (txt.length > chars) chars = txt.length;
          if (chars > 60) break;
        }
        return Math.min(420, Math.max(70, chars * 7.6 + 18));
      }),
    );
    // widths only need recomputing when the column set changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.columns]);

  const rowVirtualizer = useVirtualizer({
    count: p.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: p.columns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => widths[i] ?? 120,
    overscan: 4,
  });
  useEffect(() => {
    colVirtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widths]);

  /* -------------------------------- selection ------------------------------- */
  const selRange = useMemo(() => {
    if (!focus) return null;
    const a = anchor ?? focus;
    return {
      r1: Math.min(a.r, focus.r),
      r2: Math.max(a.r, focus.r),
      c1: Math.min(a.c, focus.c),
      c2: Math.max(a.c, focus.c),
    };
  }, [focus, anchor]);

  const inSel = (r: number, c: number) =>
    !!selRange && r >= selRange.r1 && r <= selRange.r2 && c >= selRange.c1 && c <= selRange.c2;

  const displayValue = useCallback(
    (r: number, c: number): EditValue => {
      const k = `${r}:${c}`;
      if (p.edits && k in p.edits.cells) return p.edits.cells[k];
      return p.rows[r]?.[c] ?? null;
    },
    [p.edits, p.rows],
  );

  const scrollToCell = useCallback(
    (pos: Pos) => {
      rowVirtualizer.scrollToIndex(pos.r, { align: "auto" });
      colVirtualizer.scrollToIndex(pos.c, { align: "auto" });
    },
    [rowVirtualizer, colVirtualizer],
  );

  const moveFocus = (dr: number, dc: number, extend = false) => {
    if (!focus) return;
    const next = {
      r: Math.max(0, Math.min(p.rows.length - 1, focus.r + dr)),
      c: Math.max(0, Math.min(p.columns.length - 1, focus.c + dc)),
    };
    if (!extend) setAnchor(next);
    setFocus(next);
    scrollToCell(next);
  };

  const startEdit = (pos: Pos, initial?: string) => {
    if (!p.editable || p.edits?.deleted.has(pos.r)) return;
    const v = displayValue(pos.r, pos.c);
    const text = initial ?? (isDefault(v) ? "" : cellEditText(v));
    // Enter/double-click: the whole value is selected so typing replaces it;
    // typing a character straight into the cell keeps the caret after it
    setEditing({ ...pos, text, selectAll: initial === undefined });
  };

  const commitEdit = (move?: "down" | "right") => {
    if (!editing) return;
    const col = p.columns[editing.c];
    const original = displayValue(editing.r, editing.c);
    const parsed = parseEdited(editing.text, col.kind);
    const unchanged =
      !isDefault(original) && cellEditText(original) === editing.text && original !== null;
    if (!unchanged || (original === null && editing.text !== "")) {
      p.onEdit?.(editing.r, editing.c, parsed);
    }
    setEditing(null);
    scrollRef.current?.focus();
    if (move === "down") moveFocus(1, 0);
    if (move === "right") moveFocus(0, 1);
  };

  useEffect(() => {
    if (!editing) return;
    const el = editRef.current;
    if (!el) return;
    el.focus();
    if (editing.selectAll) el.select();
    // run only when an edit starts, not on every keystroke
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.r, editing?.c]);

  /* --------------------------------- copying -------------------------------- */
  const copySelection = async () => {
    if (!selRange) return;
    const cols = p.columns.slice(selRange.c1, selRange.c2 + 1);
    const rows: Cell[][] = [];
    for (let r = selRange.r1; r <= selRange.r2; r++) {
      const row: Cell[] = [];
      for (let c = selRange.c1; c <= selRange.c2; c++) {
        const v = displayValue(r, c);
        row.push(isDefault(v) ? "DEFAULT" : v);
      }
      rows.push(row);
    }
    const single = rows.length === 1 && rows[0].length === 1;
    await copyText(single ? cellText(rows[0][0]) : rowsToTsv(cols, rows, rows.length > 1));
  };

  /* -------------------------------- keyboard -------------------------------- */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return;
    if (!focus) {
      if (p.rows.length && (e.key === "ArrowDown" || e.key === "Enter")) {
        setFocus({ r: 0, c: 0 });
        setAnchor({ r: 0, c: 0 });
        e.preventDefault();
      }
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    switch (e.key) {
      case "ArrowDown":
        moveFocus(mod ? p.rows.length : 1, 0, e.shiftKey);
        break;
      case "ArrowUp":
        moveFocus(mod ? -p.rows.length : -1, 0, e.shiftKey);
        break;
      case "ArrowRight":
        moveFocus(0, mod ? p.columns.length : 1, e.shiftKey);
        break;
      case "ArrowLeft":
        moveFocus(0, mod ? -p.columns.length : -1, e.shiftKey);
        break;
      case "PageDown":
        moveFocus(20, 0, e.shiftKey);
        break;
      case "PageUp":
        moveFocus(-20, 0, e.shiftKey);
        break;
      case "Home":
        moveFocus(mod ? -p.rows.length : 0, -p.columns.length, e.shiftKey);
        break;
      case "End":
        moveFocus(mod ? p.rows.length : 0, p.columns.length, e.shiftKey);
        break;
      case "Enter":
      case "F2":
        startEdit(focus);
        break;
      case "Delete":
      case "Backspace":
        if (p.editable && selRange) {
          for (let r = selRange.r1; r <= selRange.r2; r++)
            for (let c = selRange.c1; c <= selRange.c2; c++) p.onEdit?.(r, c, null);
        }
        break;
      case "Escape":
        setAnchor(focus);
        break;
      case "a":
        if (mod) {
          setAnchor({ r: 0, c: 0 });
          setFocus({ r: p.rows.length - 1, c: p.columns.length - 1 });
          break;
        }
        return;
      case "c":
        if (mod) {
          void copySelection();
          break;
        }
        return;
      default:
        if (e.key.length === 1 && !mod && !e.altKey && p.editable) {
          startEdit(focus, e.key);
          break;
        }
        return;
    }
    e.preventDefault();
  };

  /* ------------------------------ context menu ------------------------------ */
  const onCellContext = (e: React.MouseEvent, r: number, c: number) => {
    if (!inSel(r, c)) {
      setFocus({ r, c });
      setAnchor({ r, c });
    }
    const col = p.columns[c];
    const value = p.rows[r][c];
    const rowsInSel = selRange && inSel(r, c) ? range(selRange.r1, selRange.r2) : [r];
    const deleted = !!p.edits?.deleted.has(r);
    const items: ContextMenuItem[] = [
      { label: t("grid.copyCell"), icon: "copy", shortcut: "Ctrl+C", onSelect: () => void copyText(cellText(value)) },
      {
        label: t("grid.copyRow"),
        icon: "copy",
        children: [
          { label: "JSON", onSelect: () => void copyText(rowToJson(p.columns, p.rows[r])) },
          { label: "CSV", onSelect: () => void copyText(rowToCsv(p.rows[r])) },
          ...(p.onCopyAsInsert ? [{ label: "INSERT", onSelect: () => void copyText(p.onCopyAsInsert!(p.rows[r])) }] : []),
        ],
      },
      { separator: true },
      { label: t("grid.viewCell"), icon: "eye", onSelect: () => p.onViewCell?.(r, c), disabled: !p.onViewCell },
      ...(p.onFilterByValue ? [{ label: t("grid.filterByValue"), icon: "filter" as const, onSelect: () => p.onFilterByValue!(col.name, value) }] : []),
    ];
    if (p.editable) {
      items.push(
        { separator: true },
        { label: t("grid.editCell"), icon: "pencil", shortcut: "Enter", onSelect: () => startEdit({ r, c }) },
        { label: t("grid.setNull"), shortcut: "Del", onSelect: () => p.onEdit?.(r, c, null) },
        { label: t("grid.setDefault"), onSelect: () => p.onEdit?.(r, c, { $default: true }) },
        { separator: true },
        deleted
          ? { label: t("grid.undeleteRow"), icon: "refresh", onSelect: () => p.onUndeleteRows?.(rowsInSel) }
          : { label: t("grid.deleteRow"), icon: "trash", danger: true, onSelect: () => p.onDeleteRows?.(rowsInSel) },
      );
    }
    openMenu(e, items);
  };

  /* -------------------------------- resizing -------------------------------- */
  const startResize = (e: React.PointerEvent, ci: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[ci] ?? 120;
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(50, startW + ev.clientX - startX);
      setWidths((ws) => ws.map((x, i) => (i === ci ? w : x)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const totalW = colVirtualizer.getTotalSize() + ROWNUM_W;
  const totalH = rowVirtualizer.getTotalSize() + HEAD_H;
  const virtualCols = colVirtualizer.getVirtualItems();
  const pk = new Set(p.pkColumns ?? []);

  return (
    <div className="grid-wrap">
      {p.loading && <div className="grid-loading" />}
      <div className="grid" ref={scrollRef} tabIndex={0} onKeyDown={onKeyDown}>
        <div className="grid-inner" style={{ width: totalW, height: totalH }}>
          <div className="grid-head" style={{ width: totalW }}>
            <div className="g-rownum">#</div>
            {virtualCols.map((vc) => {
              const col = p.columns[vc.index];
              const sorted = p.sort?.column === col.name;
              return (
                <div
                  key={vc.key}
                  className="g-cell"
                  style={{ position: "absolute", left: vc.start + ROWNUM_W, width: vc.size, height: HEAD_H }}
                  onClick={() => p.onSort?.(col.name)}
                  title={`${col.name} · ${col.dataType}`}
                >
                  {pk.has(col.name) && <Icon name="key" size={11} className="pk" />}
                  <span className="name">{col.name}</span>
                  {sorted && <Icon name={p.sort?.desc ? "arrowDown" : "arrowUp"} size={12} className="sort" />}
                  {!sorted && <span className="type">{col.dataType}</span>}
                  <div className="col-resize" onPointerDown={(e) => startResize(e, vc.index)} onClick={(e) => e.stopPropagation()} />
                </div>
              );
            })}
          </div>
          {rowVirtualizer.getVirtualItems().map((vr) => {
            const r = vr.index;
            const row = p.rows[r];
            const deleted = p.edits?.deleted.has(r);
            const inserted = p.edits ? r >= p.edits.insertedFrom : false;
            const rowSelected = !!selRange && r >= selRange.r1 && r <= selRange.r2;
            return (
              <div
                key={vr.key}
                className={`g-row ${deleted ? "deleted" : ""} ${inserted ? "inserted" : ""} ${rowSelected ? "selected" : ""}`}
                style={{ transform: `translateY(${vr.start + HEAD_H}px)`, width: totalW }}
              >
                <div
                  className="g-rownum"
                  onClick={(e) => {
                    const pos = { r, c: 0 };
                    setFocus({ r, c: p.columns.length - 1 });
                    setAnchor(e.shiftKey && anchor ? anchor : pos);
                  }}
                >
                  {(p.rowOffset ?? 0) + r + 1}
                </div>
                {virtualCols.map((vc) => {
                  const c = vc.index;
                  const col = p.columns[c];
                  const key = `${r}:${c}`;
                  const modified = !!p.edits && key in p.edits.cells;
                  const v = modified ? p.edits!.cells[key] : row[c];
                  const isFocus = focus?.r === r && focus?.c === c;
                  const isEditing = editing?.r === r && editing?.c === c;
                  const cls = ["g-cell", kindClass(col.kind)];
                  if (modified) cls.push("modified");
                  if (isFocus) cls.push("focused");
                  else if (inSel(r, c)) cls.push("in-sel");
                  if (isEditing) cls.push("editing");
                  return (
                    <div
                      key={vc.key}
                      className={cls.join(" ")}
                      style={{ position: "absolute", left: vc.start + ROWNUM_W, width: vc.size, height: ROW_H }}
                      onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        if (isEditing) return;
                        const pos = { r, c };
                        setFocus(pos);
                        setAnchor(e.shiftKey && anchor ? anchor : pos);
                        scrollRef.current?.focus();
                      }}
                      onDoubleClick={() => (p.editable ? startEdit({ r, c }) : p.onViewCell?.(r, c))}
                      onContextMenu={(e) => onCellContext(e, r, c)}
                    >
                      {isEditing ? (
                        <input
                          ref={editRef}
                          className="cell-editor"
                          value={editing.text}
                          onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitEdit("down");
                            } else if (e.key === "Tab") {
                              e.preventDefault();
                              commitEdit("right");
                            } else if (e.key === "Escape") {
                              setEditing(null);
                              scrollRef.current?.focus();
                            }
                            e.stopPropagation();
                          }}
                          onBlur={() => commitEdit()}
                        />
                      ) : (
                        <CellContent value={v} kind={col.kind} nullText={t("grid.null")} />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        {p.rows.length === 0 && !p.loading && <div className="grid-empty">{p.emptyText ?? t("grid.empty")}</div>}
      </div>
    </div>
  );
}

function CellContent({ value, kind, nullText }: { value: EditValue; kind: ResultColumn["kind"]; nullText: string }) {
  if (value === null || value === undefined) return <span className="null">{nullText}</span>;
  if (isDefault(value)) return <span className="null">DEFAULT</span>;
  if (kind === "bool" && typeof value === "boolean") return <span className="cell-text">{value ? "true" : "false"}</span>;
  const text = cellText(value);
  return <span className="cell-text">{text.length > 500 ? text.slice(0, 500) + "…" : text}</span>;
}

function kindClass(kind: ResultColumn["kind"]): string {
  switch (kind) {
    case "number":
      return "num";
    case "string":
      return "str";
    case "bool":
      return "bool";
    case "date":
      return "date";
    case "json":
      return "json";
    case "bytes":
      return "bytes";
    default:
      return "str";
  }
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}
