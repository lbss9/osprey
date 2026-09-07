import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Badge from "@/components/atoms/Badge";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";
import Spinner from "@/components/atoms/Spinner";
import ConnChip from "@/components/molecules/ConnChip";
import ToolButton from "@/components/molecules/ToolButton";
import { useWorkspace } from "@/store/workspace";
import * as api from "@/services/tauri";
import { translateError } from "@/i18n";
import { saveDialog } from "@/utils/dialog";
import type { ColumnInfo, ForeignKeyInfo, Tab } from "@/types";

interface Node {
  table: string;
  columns: ColumnInfo[];
  fks: ForeignKeyInfo[];
  x: number;
  y: number;
}

const W = 230;
const HEAD = 30;
const ROW = 22;
const PAD = 8;
const GAP_X = 90;
const GAP_Y = 50;
const MAX_ROWS = 14;

const height = (n: Node) => HEAD + Math.min(n.columns.length, MAX_ROWS + 1) * ROW + PAD;

/** Rough dependency-aware grid: referenced tables land in earlier columns. */
function layout(nodes: Node[]): Node[] {
  const byName = new Map(nodes.map((n) => [n.table, n]));
  const level = new Map<string, number>();
  const rank = (name: string, seen: Set<string>): number => {
    if (level.has(name)) return level.get(name)!;
    if (seen.has(name)) return 0;
    seen.add(name);
    const n = byName.get(name);
    let l = 0;
    for (const fk of n?.fks ?? []) {
      if (fk.refTable !== name && byName.has(fk.refTable)) l = Math.max(l, rank(fk.refTable, seen) + 1);
    }
    level.set(name, l);
    return l;
  };
  for (const n of nodes) rank(n.table, new Set());
  const cols = new Map<number, Node[]>();
  for (const n of nodes) {
    const l = level.get(n.table) ?? 0;
    cols.set(l, [...(cols.get(l) ?? []), n]);
  }
  const maxPerCol = Math.max(3, Math.ceil(Math.sqrt(nodes.length)));
  let x = 40;
  for (const l of [...cols.keys()].sort((a, b) => a - b)) {
    const list = cols.get(l)!.sort((a, b) => b.fks.length - a.fks.length || a.table.localeCompare(b.table));
    let y = 40;
    let colX = x;
    let maxH = 0;
    list.forEach((n, i) => {
      if (i > 0 && i % maxPerCol === 0) {
        colX += W + GAP_X / 2;
        y = 40;
      }
      n.x = colX;
      n.y = y;
      y += height(n) + GAP_Y;
      maxH = Math.max(maxH, y);
    });
    x = colX + W + GAP_X;
  }
  return nodes;
}

/** Entity-relationship diagram for one schema: tables as cards, foreign keys as links. */
export default function DiagramView({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const toast = useWorkspace((s) => s.toast);
  const openTab = useWorkspace((s) => s.openTab);
  const session = useWorkspace((s) => s.sessions[tab.connectionId]);
  const loadTables = useWorkspace((s) => s.loadTables);
  const schema = tab.schema ?? "";
  const [nodes, setNodes] = useState<Node[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ kind: "node" | "pan"; name?: string; sx: number; sy: number; ox: number; oy: number } | null>(null);

  const tables = session?.tables?.[schema];

  const load = useCallback(async () => {
    setError(null);
    setNodes(null);
    try {
      const list = tables ?? (await api.schemaTables(tab.connectionId, schema));
      const out: Node[] = [];
      // a few at a time so a big schema does not open 200 catalog queries at once
      for (let i = 0; i < list.length; i += 6) {
        const chunk = list.slice(i, i + 6);
        const structs = await Promise.all(chunk.map((tb) => api.tableStructure(tab.connectionId, schema, tb.name)));
        chunk.forEach((tb, j) => out.push({ table: tb.name, columns: structs[j].columns, fks: structs[j].foreignKeys, x: 0, y: 0 }));
      }
      setNodes(layout(out));
    } catch (e) {
      setError(translateError(e));
    }
  }, [tab.connectionId, schema, tables]);

  useEffect(() => {
    if (!tables && session?.status === "open") void loadTables(tab.connectionId, schema);
  }, [tables, session?.status, loadTables, tab.connectionId, schema]);
  useEffect(() => {
    if (tables) void load();
  }, [tables, load]);

  const links = useMemo(() => {
    if (!nodes) return [];
    const byName = new Map(nodes.map((n) => [n.table, n]));
    const out: { from: Node; to: Node; fromRow: number; toRow: number; name: string }[] = [];
    for (const n of nodes) {
      for (const fk of n.fks) {
        const to = byName.get(fk.refTable);
        if (!to) continue;
        const fromRow = Math.min(n.columns.findIndex((c) => c.name === fk.columns[0]), MAX_ROWS);
        const toRow = Math.min(to.columns.findIndex((c) => c.name === fk.refColumns[0]), MAX_ROWS);
        out.push({ from: n, to, fromRow: fromRow < 0 ? 0 : fromRow, toRow: toRow < 0 ? 0 : toRow, name: fk.name });
      }
    }
    return out;
  }, [nodes]);

  const bounds = useMemo(() => {
    if (!nodes?.length) return { w: 800, h: 600 };
    return {
      w: Math.max(...nodes.map((n) => n.x + W)) + 40,
      h: Math.max(...nodes.map((n) => n.y + height(n))) + 40,
    };
  }, [nodes]);

  const onMouseDown = (e: React.MouseEvent, name?: string) => {
    const n = name ? nodes?.find((x) => x.table === name) : undefined;
    drag.current = { kind: name ? "node" : "pan", name, sx: e.clientX, sy: e.clientY, ox: n ? n.x : pan.x, oy: n ? n.y : pan.y };
    if (name) setSelected(name);
    else setSelected(null);
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / zoom;
    const dy = (e.clientY - d.sy) / zoom;
    if (d.kind === "pan") setPan({ x: d.ox + dx * zoom, y: d.oy + dy * zoom });
    else setNodes((list) => list && list.map((n) => (n.table === d.name ? { ...n, x: Math.max(0, d.ox + dx), y: Math.max(0, d.oy + dy) } : n)));
  };
  const onMouseUp = () => (drag.current = null);
  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom((z) => Math.min(2.5, Math.max(0.3, z * (e.deltaY < 0 ? 1.1 : 0.9))));
  };

  const exportSvg = async () => {
    const svg = svgRef.current;
    if (!svg) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(bounds.w));
    clone.setAttribute("height", String(bounds.h));
    clone.setAttribute("viewBox", `0 0 ${bounds.w} ${bounds.h}`);
    clone.querySelector("g")?.setAttribute("transform", "");
    const cs = getComputedStyle(document.documentElement);
    const v = (k: string) => cs.getPropertyValue(k).trim();
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = `text{font-family:${v("--sans")};font-size:12px}.erd-card{fill:${v("--panel")};stroke:${v("--line-2")}}.erd-head{fill:${v("--panel-3")}}.erd-title{fill:${v("--text")};font-weight:600}.erd-col{fill:${v("--text-soft")}}.erd-type{fill:${v("--text-faint")};font-size:10px}.erd-pk{fill:${v("--amber")}}.erd-link{stroke:${v("--accent")};fill:none;stroke-width:1.5}.erd-bg{fill:${v("--bg")}}`;
    clone.insertBefore(style, clone.firstChild);
    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("width", "100%");
    bg.setAttribute("height", "100%");
    bg.setAttribute("class", "erd-bg");
    clone.insertBefore(bg, style.nextSibling);
    try {
      const path = await saveDialog(`${schema}-diagram.svg`, "svg", "SVG");
      if (!path) return;
      await api.writeFileText(path, clone.outerHTML);
      toast(t("diagram.exported"), "success");
    } catch (e) {
      toast(translateError(e), "error");
    }
  };

  return (
    <div className="main-body">
      <div className="toolbar">
        <div className="crumb">
          <Icon name="tree" size={14} style={{ color: "var(--accent)" }} />
          <b>{t("diagram.title")}</b>
          <span className="sep">/</span>
          <span className="mono">{schema}</span>
        </div>
        <ConnChip connectionId={tab.connectionId} />
        {nodes && (
          <>
            <Badge>{t("diagram.tables", { count: nodes.length })}</Badge>
            <Badge tone="accent">{t("diagram.links", { count: links.length })}</Badge>
          </>
        )}
        <span className="grow" />
        <ToolButton icon="minus" title={t("diagram.zoomOut")} onClick={() => setZoom((z) => Math.max(0.3, z * 0.9))} />
        <span className="mono" style={{ minWidth: 42, textAlign: "center", fontSize: "0.85em" }}>{Math.round(zoom * 100)}%</span>
        <ToolButton icon="plus" title={t("diagram.zoomIn")} onClick={() => setZoom((z) => Math.min(2.5, z * 1.1))} />
        <ToolButton icon="layers" title={t("diagram.relayout")} onClick={() => setNodes((n) => n && layout(n.map((x) => ({ ...x }))))} />
        <ToolButton icon="refresh" title={t("common.refresh")} onClick={() => void load()} />
        <Button size="sm" variant="secondary" onClick={() => void exportSvg()} disabled={!nodes}>
          <Icon name="download" size={13} /> {t("diagram.export")}
        </Button>
      </div>
      <div className="erd" onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp} onWheel={onWheel}>
        {error && <div className="results-empty" style={{ color: "var(--red)" }}>{error}</div>}
        {!nodes && !error && (
          <div className="results-empty">
            <Spinner /> {t("diagram.loading")}
          </div>
        )}
        {nodes && nodes.length === 0 && <div className="results-empty">{t("diagram.empty")}</div>}
        {nodes && nodes.length > 0 && (
          <svg ref={svgRef} className="erd-svg" width="100%" height="100%" onMouseDown={(e) => onMouseDown(e)}>
            <defs>
              <marker id="erd-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
              </marker>
            </defs>
            <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
              {links.map((l, i) => {
                const y1 = l.from.y + HEAD + l.fromRow * ROW + ROW / 2;
                const y2 = l.to.y + HEAD + l.toRow * ROW + ROW / 2;
                const leftToRight = l.from.x + W / 2 <= l.to.x + W / 2;
                const x1 = leftToRight ? l.from.x + W : l.from.x;
                const x2 = leftToRight ? l.to.x : l.to.x + W;
                const c = Math.max(40, Math.abs(x2 - x1) / 2);
                const d = `M ${x1} ${y1} C ${x1 + (leftToRight ? c : -c)} ${y1}, ${x2 + (leftToRight ? -c : c)} ${y2}, ${x2} ${y2}`;
                const dim = selected && selected !== l.from.table && selected !== l.to.table;
                return <path key={i} d={d} className="erd-link" markerEnd="url(#erd-arrow)" opacity={dim ? 0.25 : 1} data-link={l.name} />;
              })}
              {nodes.map((n) => {
                const shown = n.columns.slice(0, MAX_ROWS);
                const more = n.columns.length - shown.length;
                const h = height(n);
                return (
                  <g
                    key={n.table}
                    transform={`translate(${n.x} ${n.y})`}
                    className={`erd-node ${selected === n.table ? "selected" : ""}`}
                    data-table={n.table}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      onMouseDown(e, n.table);
                    }}
                    onDoubleClick={() => openTab({ kind: "table", connectionId: tab.connectionId, schema, table: n.table, title: n.table })}
                  >
                    <rect className="erd-card" width={W} height={h} rx={8} />
                    <rect className="erd-head" width={W} height={HEAD} rx={8} />
                    <rect className="erd-head" y={HEAD - 8} width={W} height={8} />
                    <text className="erd-title" x={10} y={19}>{n.table}</text>
                    {shown.map((c, i) => {
                      const y = HEAD + i * ROW + 15;
                      const isFk = n.fks.some((f) => f.columns.includes(c.name));
                      return (
                        <g key={c.name}>
                          {c.primaryKey && <text className="erd-pk" x={10} y={y} fontSize={10}>PK</text>}
                          {!c.primaryKey && isFk && <text className="erd-fk" x={10} y={y} fontSize={10}>FK</text>}
                          <text className="erd-col" x={34} y={y}>{c.name}</text>
                          <text className="erd-type" x={W - 10} y={y} textAnchor="end">{c.dataType.length > 14 ? c.dataType.slice(0, 13) + "…" : c.dataType}</text>
                        </g>
                      );
                    })}
                    {more > 0 && <text className="erd-type" x={10} y={HEAD + MAX_ROWS * ROW + 15}>{t("diagram.more", { count: more })}</text>}
                  </g>
                );
              })}
            </g>
          </svg>
        )}
      </div>
    </div>
  );
}
