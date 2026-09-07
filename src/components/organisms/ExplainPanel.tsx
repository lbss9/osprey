import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "@/components/atoms/Icon";
import Badge from "@/components/atoms/Badge";
import type { DriverKind, ExplainResult } from "@/types";

interface PlanNode {
  title: string;
  detail?: string;
  /** relative cost 0..1 for the bar */
  weight?: number;
  cost?: string;
  rows?: string;
  time?: string;
  warn?: boolean;
  children: PlanNode[];
}

/* ------------------------------ adapters ---------------------------------- */

function pgNode(p: Record<string, unknown>, total: number): PlanNode {
  const rel = p["Relation Name"] ?? p["Index Name"] ?? p["Alias"];
  const cost = typeof p["Total Cost"] === "number" ? (p["Total Cost"] as number) : 0;
  const actual = typeof p["Actual Total Time"] === "number" ? `${(p["Actual Total Time"] as number).toFixed(2)} ms` : undefined;
  const rows = p["Actual Rows"] ?? p["Plan Rows"];
  const kids = Array.isArray(p["Plans"]) ? (p["Plans"] as Record<string, unknown>[]) : [];
  const own = cost - kids.reduce((n, k) => n + (typeof k["Total Cost"] === "number" ? (k["Total Cost"] as number) : 0), 0);
  const type = String(p["Node Type"] ?? "?");
  return {
    title: rel ? `${type} · ${String(rel)}` : type,
    detail: [p["Filter"], p["Index Cond"], p["Hash Cond"], p["Join Type"] && `${String(p["Join Type"])} join`, p["Sort Key"] && `sort ${JSON.stringify(p["Sort Key"])}`].filter(Boolean).map(String).join(" · ") || undefined,
    weight: total > 0 ? Math.max(0, own) / total : 0,
    cost: cost ? cost.toFixed(1) : undefined,
    rows: rows !== undefined ? String(rows) : undefined,
    time: actual,
    warn: type === "Seq Scan" && Number(rows ?? 0) > 10_000,
    children: kids.map((k) => pgNode(k, total)),
  };
}

function mysqlNode(key: string, v: unknown, depth = 0): PlanNode[] {
  if (Array.isArray(v)) return v.flatMap((x) => mysqlNode(key, x, depth));
  if (typeof v !== "object" || v === null) return [];
  const o = v as Record<string, unknown>;
  if (key === "table" || "table_name" in o) {
    const cost = (o["cost_info"] as Record<string, unknown> | undefined)?.["read_cost"] ?? (o["cost_info"] as Record<string, unknown> | undefined)?.["query_cost"];
    return [
      {
        title: `${String(o["access_type"] ?? "table")} · ${String(o["table_name"] ?? "")}`,
        detail: [o["key"] && `key ${String(o["key"])}`, o["used_key_parts"] && JSON.stringify(o["used_key_parts"]), o["attached_condition"]].filter(Boolean).map(String).join(" · ") || undefined,
        cost: cost !== undefined ? String(cost) : undefined,
        rows: o["rows_examined_per_scan"] !== undefined ? String(o["rows_examined_per_scan"]) : undefined,
        warn: o["access_type"] === "ALL" && Number(o["rows_examined_per_scan"] ?? 0) > 10_000,
        children: Object.entries(o).filter(([k]) => !["table_name", "access_type", "key", "used_key_parts", "attached_condition", "cost_info", "rows_examined_per_scan", "rows_produced_per_join", "filtered", "used_columns", "possible_keys", "key_length", "ref"].includes(k)).flatMap(([k, val]) => mysqlNode(k, val, depth + 1)),
      },
    ];
  }
  const children = Object.entries(o).flatMap(([k, val]) => mysqlNode(k, val, depth + 1));
  if (key === "query_block" || key === "nested_loop" || key === "materialized_from_subquery" || key === "query_specification") return children;
  const cost = (o["cost_info"] as Record<string, unknown> | undefined)?.["query_cost"] ?? (o["cost_info"] as Record<string, unknown> | undefined)?.["sort_cost"];
  if (children.length === 0 && cost === undefined) return [];
  return [{ title: key.replace(/_/g, " "), cost: cost !== undefined ? String(cost) : undefined, children }];
}

function sqliteTree(nodes: { id: number; parent: number; detail: string }[]): PlanNode[] {
  const build = (parent: number): PlanNode[] =>
    nodes.filter((n) => n.parent === parent).map((n) => ({ title: n.detail, warn: /^SCAN /.test(n.detail), children: build(n.id) }));
  return build(0);
}

export function toTree(r: ExplainResult): PlanNode[] {
  const driver: DriverKind = r.driver;
  if (driver === "postgres" && Array.isArray(r.plan) && r.plan[0] && typeof r.plan[0] === "object") {
    const root = (r.plan[0] as Record<string, unknown>)["Plan"] as Record<string, unknown> | undefined;
    if (!root) return [];
    const total = typeof root["Total Cost"] === "number" ? (root["Total Cost"] as number) : 0;
    return [pgNode(root, total)];
  }
  if (driver === "mysql" && r.plan && typeof r.plan === "object") return mysqlNode("root", r.plan);
  if (driver === "sqlite" && r.plan && typeof r.plan === "object" && Array.isArray((r.plan as { nodes?: unknown }).nodes)) {
    return sqliteTree((r.plan as { nodes: { id: number; parent: number; detail: string }[] }).nodes);
  }
  return [];
}

/* -------------------------------- component ------------------------------- */

function Node({ n, depth }: { n: PlanNode; depth: number }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="plan-node">
      <div className={`plan-row ${n.warn ? "warn" : ""}`} style={{ paddingLeft: 10 + depth * 18 }} onClick={() => setOpen((o) => !o)}>
        <Icon name="chevronRight" size={12} className={`chev ${open ? "open" : ""} ${n.children.length ? "" : "hidden"}`} />
        <span className="plan-title">{n.title}</span>
        {n.detail && <span className="plan-detail">{n.detail}</span>}
        <span className="plan-meta">
          {n.rows !== undefined && <Badge>{n.rows} rows</Badge>}
          {n.time && <Badge tone="accent">{n.time}</Badge>}
          {n.cost && <Badge tone={n.warn ? "red" : "neutral"}>cost {n.cost}</Badge>}
        </span>
        {n.weight !== undefined && (
          <span className="plan-bar">
            <span style={{ width: `${Math.round(n.weight * 100)}%` }} />
          </span>
        )}
      </div>
      {open && n.children.map((c, i) => <Node key={i} n={c} depth={depth + 1} />)}
    </div>
  );
}

/** Query plan as a collapsible tree with relative-cost bars; raw JSON/text below. */
export default function ExplainPanel({ result }: { result: ExplainResult }) {
  const { t } = useTranslation();
  const [raw, setRaw] = useState(false);
  const tree = useMemo(() => toTree(result), [result]);
  return (
    <div className="explain">
      <div className="explain-head">
        <span>{t("explain.title")}</span>
        <span className="grow" />
        <label className="toggle-inline">
          <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> {t("explain.raw")}
        </label>
      </div>
      {result.text && <pre className="messages">{result.text}</pre>}
      {!result.text && !raw && (tree.length ? tree.map((n, i) => <Node key={i} n={n} depth={0} />) : <div className="results-empty">{t("explain.empty")}</div>)}
      {!result.text && raw && <pre className="messages">{JSON.stringify(result.plan, null, 2)}</pre>}
    </div>
  );
}
