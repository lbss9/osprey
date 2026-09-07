import type { Cell, ColumnKind, ResultColumn } from "@/types";

export function formatNumber(n: number): string {
  return new Intl.NumberFormat(undefined).format(n);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

export function formatTtl(seconds: number): string {
  if (seconds < 0) return "";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  return new Date(ts).toLocaleDateString();
}

/** Text shown in a grid cell. `null` renders separately. */
export function cellText(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** Value the editor starts with (what the user types back to the server). */
export function cellEditText(v: Cell): string {
  if (v === null || v === undefined) return "";
  return cellText(v);
}

/** Parse what the user typed into the value sent to the backend. */
export function parseEdited(text: string, kind: ColumnKind): Cell {
  if (kind === "number") {
    const t = text.trim();
    if (t === "") return null;
    // keep big integers / decimals as text so nothing is rounded
    if (/^-?\d{1,15}$/.test(t)) return Number(t);
    return t;
  }
  if (kind === "bool") {
    const t = text.trim().toLowerCase();
    if (["true", "t", "1", "yes", "y"].includes(t)) return true;
    if (["false", "f", "0", "no", "n"].includes(t)) return false;
    return text;
  }
  return text;
}

export function isRightAligned(kind: ColumnKind): boolean {
  return kind === "number";
}

export function looksLikeJson(s: string): boolean {
  const t = s.trim();
  return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
}

export function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

export function rowsToTsv(columns: ResultColumn[], rows: Cell[][], header = true): string {
  const lines: string[] = [];
  if (header) lines.push(columns.map((c) => c.name).join("\t"));
  for (const r of rows) {
    lines.push(r.map((v) => (v === null ? "" : cellText(v).replace(/\t/g, " ").replace(/\n/g, " "))).join("\t"));
  }
  return lines.join("\n");
}

export function rowToJson(columns: ResultColumn[], row: Cell[]): string {
  const o: Record<string, Cell> = {};
  columns.forEach((c, i) => (o[c.name] = row[i]));
  return JSON.stringify(o, null, 2);
}

export function csvEscape(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowToCsv(row: Cell[]): string {
  return row.map((v) => csvEscape(cellText(v))).join(",");
}

export function sqlLiteral(v: Cell, driver: "postgres" | "mysql" | "redis"): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  const s = driver === "mysql" ? v.replace(/\\/g, "\\\\").replace(/'/g, "''") : v.replace(/'/g, "''");
  return `'${s}'`;
}

export function quoteIdent(name: string, driver: "postgres" | "mysql" | "redis"): string {
  return driver === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`;
}

export function rowToInsert(
  columns: ResultColumn[],
  row: Cell[],
  table: string,
  driver: "postgres" | "mysql" | "redis",
): string {
  const cols = columns.map((c) => quoteIdent(c.name, driver)).join(", ");
  const vals = row.map((v) => sqlLiteral(v, driver)).join(", ");
  return `INSERT INTO ${table} (${cols}) VALUES (${vals});`;
}

export function driverLabel(driver: string): string {
  return driver === "postgres" ? "PostgreSQL" : driver === "mysql" ? "MySQL" : "Redis";
}

export const isMac = /Mac/i.test(navigator.userAgent);
export const modKey = isMac ? "⌘" : "Ctrl";
