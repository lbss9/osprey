import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Icon, { type IconName } from "@/components/atoms/Icon";
import Input from "@/components/atoms/Input";
import { useUi } from "@/store/ui";
import { useWorkspace } from "@/store/workspace";
import * as api from "@/services/tauri";
import type { SavedQuery } from "@/types";

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon: IconName;
  shortcut?: string;
  run: () => void;
}

/** Subsequence match with a small score: lower is better, null = no match. */
function fuzzy(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const s = text.toLowerCase();
  if (!q) return 0;
  const idx = s.indexOf(q);
  if (idx >= 0) return idx === 0 ? 0 : 1 + idx / 100;
  let qi = 0;
  let score = 10;
  let last = -1;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) {
      score += last >= 0 ? i - last - 1 : i;
      last = i;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}

/**
 * Ctrl+K / Ctrl+P: jump to any table of an open connection, switch tabs,
 * connect, or run an app action. Everything is one list ranked by a fuzzy
 * match on the label.
 */
export default function CommandPalette({
  actions,
}: {
  actions: PaletteItem[];
}) {
  const { t } = useTranslation();
  const open = useUi((s) => s.paletteOpen);
  const setUi = useUi((s) => s.set);
  const ws = useWorkspace();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      api.savedQueriesList().then(setSavedQueries).catch(() => setSavedQueries([]));
    }
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    if (!open) return [];
    const out: PaletteItem[] = [];
    for (const tab of ws.tabs) {
      const conn = ws.connections.find((c) => c.id === tab.connectionId);
      out.push({
        id: `tab:${tab.id}`,
        label: tab.title,
        hint: `${t(`tabs.${tab.kind === "table" ? "query" : tab.kind}` as never, { defaultValue: tab.kind })} · ${conn?.name ?? ""}`,
        group: t("palette.tabs"),
        icon: tab.kind === "table" ? "table" : tab.kind === "query" ? "fileCode" : tab.kind === "redis" ? "keyRound" : "list",
        run: () => ws.setActiveTab(tab.id),
      });
    }
    for (const conn of ws.connections) {
      const sess = ws.sessions[conn.id];
      if (sess?.status === "open") {
        for (const [schema, tables] of Object.entries(sess.tables)) {
          for (const tb of tables ?? []) {
            out.push({
              id: `table:${conn.id}:${schema}:${tb.name}`,
              label: tb.name,
              hint: `${schema} · ${conn.name}`,
              group: t("palette.tables"),
              icon: tb.kind === "table" || tb.kind === "partitioned" ? "table" : "eye",
              run: () => ws.openTab({ kind: "table", connectionId: conn.id, title: tb.name, schema, table: tb.name }),
            });
          }
        }
        if (conn.driver !== "redis") {
          out.push({
            id: `query:${conn.id}`,
            label: `${t("menu.newQuery")} — ${conn.name}`,
            group: t("palette.actions"),
            icon: "fileCode",
            run: () => ws.openTab({ kind: "query", connectionId: conn.id, title: t("tabs.query"), sql: "" }, { reuse: false }),
          });
        }
        out.push({
          id: `disconnect:${conn.id}`,
          label: `${t("ctx.disconnect")} — ${conn.name}`,
          group: t("palette.connections"),
          icon: "unplug",
          run: () => void ws.disconnect(conn.id),
        });
      } else {
        out.push({
          id: `connect:${conn.id}`,
          label: `${t("ctx.connect")} — ${conn.name}`,
          hint: `${conn.host}:${conn.port}`,
          group: t("palette.connections"),
          icon: "plug",
          run: () => void ws.connect(conn.id),
        });
      }
    }
    for (const q of savedQueries) {
      const conn = ws.connections.find((c) => c.id === q.connectionId);
      const target = conn && ws.sessions[conn.id]?.status === "open" ? conn.id : Object.keys(ws.sessions).find((id) => ws.sessions[id].status === "open" && ws.connections.find((c) => c.id === id)?.driver !== "redis");
      if (!target) continue;
      out.push({
        id: `saved:${q.id}`,
        label: q.name,
        hint: q.sql.replace(/\s+/g, " ").slice(0, 60),
        group: t("query.saved"),
        icon: "save",
        run: () => ws.openTab({ kind: "query", connectionId: target, title: q.name, sql: q.sql }, { reuse: false }),
      });
    }
    out.push(...actions);
    return out;
  }, [open, ws, actions, t, savedQueries]);

  const results = useMemo(() => {
    const scored = items
      .map((it) => ({ it, score: fuzzy(query, it.label) ?? (it.hint ? fuzzy(query, it.hint) : null) }))
      .filter((x): x is { it: PaletteItem; score: number } => x.score !== null)
      .sort((a, b) => a.score - b.score);
    return scored.slice(0, 60).map((x) => x.it);
  }, [items, query]);

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;
  const close = () => setUi({ paletteOpen: false });
  const pick = (it: PaletteItem) => {
    close();
    it.run();
  };

  return (
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label={t("palette.title")}>
        <div className="palette-input">
          <Icon name="search" size={16} />
          <Input
            autoFocus
            value={query}
            placeholder={t("palette.placeholder")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(results.length - 1, c + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(0, c - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (results[cursor]) pick(results[cursor]);
              } else if (e.key === "Escape") {
                e.stopPropagation();
                close();
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {results.length === 0 && <div className="palette-empty">{t("palette.empty")}</div>}
          {results.map((it, i) => {
            const showGroup = i === 0 || results[i - 1].group !== it.group;
            return (
              <div key={it.id}>
                {showGroup && <div className="palette-group">{it.group}</div>}
                <div
                  className={`palette-item ${i === cursor ? "active" : ""}`}
                  data-index={i}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => pick(it)}
                >
                  <Icon name={it.icon} size={14} className="pi" />
                  <span className="pl">{it.label}</span>
                  {it.hint && <span className="ph">{it.hint}</span>}
                  {it.shortcut && <kbd>{it.shortcut}</kbd>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
