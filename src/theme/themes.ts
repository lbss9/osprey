/**
 * Theme engine. A theme is plain JSON; every key under `colors` maps to a CSS
 * custom property (`"panel-2": "#1a222a"` → `--panel-2`). Built-in dark/light
 * live in `styles/app.css`; JSON themes pick a base (`type`) and override any
 * token on top of it, so a user can restyle the app without touching code.
 */

export interface Theme {
  id: string;
  name: string;
  /** base appearance: drives the CSS defaults and native color-scheme */
  type: "dark" | "light";
  author?: string;
  colors: Record<string, string>;
  fonts?: { system?: string; editor?: string };
  ui?: { radius?: string };
  /** injected at load time, never written to disk */
  __file?: string;
}

/** Tokens a theme may override, in the order they are exported. */
export const TOKENS = [
  "bg", "panel", "panel-2", "panel-3", "line", "line-2",
  "text", "text-soft", "text-faint",
  "accent", "accent-2", "accent-soft", "on-accent",
  "amber", "amber-soft", "green", "green-soft", "red", "red-soft", "purple",
  "pg", "mysql", "redis", "sqlite",
  "k-num", "k-str", "k-bool", "k-null", "k-date", "k-json", "k-bytes",
  "sel", "sel-line",
] as const;

export const AUTO_ID = "auto";
export const BUILTIN: Theme[] = [
  { id: "dark", name: "Osprey Dark", type: "dark", author: "Osprey", colors: {} },
  { id: "light", name: "Osprey Light", type: "light", author: "Osprey", colors: {} },
];

const TOKEN_RE = /^[a-z0-9-]+$/;
const VALUE_RE = /^[#a-zA-Z0-9(),.%\s-]+$/;

/** Validate a JSON object from disk; returns null when it is not a theme. */
export function coerceTheme(raw: unknown, file: string): Theme | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const type = r.type === "light" ? "light" : "dark";
  const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : file.replace(/\.json$/i, "");
  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : id;
  const colors: Record<string, string> = {};
  if (r.colors && typeof r.colors === "object") {
    for (const [k, v] of Object.entries(r.colors as Record<string, unknown>)) {
      if (typeof v === "string" && TOKEN_RE.test(k) && VALUE_RE.test(v)) colors[k] = v;
    }
  }
  const fonts = r.fonts && typeof r.fonts === "object" ? (r.fonts as Theme["fonts"]) : undefined;
  const ui = r.ui && typeof r.ui === "object" ? (r.ui as Theme["ui"]) : undefined;
  return { id, name, type, author: typeof r.author === "string" ? r.author : undefined, colors, fonts, ui, __file: file };
}

let applied: string[] = [];

/** Push a theme onto `<html>`: base via `data-theme`, overrides as inline vars. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme.type);
  root.style.colorScheme = theme.type;
  for (const k of applied) root.style.removeProperty(`--${k}`);
  applied = [];
  for (const [k, v] of Object.entries(theme.colors)) {
    root.style.setProperty(`--${k}`, v);
    applied.push(k);
  }
  if (theme.fonts?.system) {
    root.style.setProperty("--sans", theme.fonts.system);
    applied.push("sans");
  }
  if (theme.fonts?.editor) {
    root.style.setProperty("--mono", theme.fonts.editor);
    applied.push("mono");
  }
  if (theme.ui?.radius) {
    root.style.setProperty("--radius", theme.ui.radius);
    applied.push("radius");
  }
  root.dataset.themeId = theme.id;
}

/** The colours currently in effect, read from CSS, as a full theme object. */
export function snapshotTheme(id: string, name: string, type: Theme["type"]): Theme {
  const cs = getComputedStyle(document.documentElement);
  const colors: Record<string, string> = {};
  for (const k of TOKENS) {
    const v = cs.getPropertyValue(`--${k}`).trim();
    if (v) colors[k] = v;
  }
  return { id, name, type, author: "", colors };
}

export function themeToJson(t: Theme): string {
  const { id, name, type, author, colors, fonts, ui } = t;
  return JSON.stringify({ id, name, type, author, colors, fonts, ui }, null, 2) + "\n";
}

/** Colours for a preview swatch, falling back to the base palette. */
export function previewColors(t: Theme): { bg: string; panel: string; accent: string; text: string } {
  const base =
    t.type === "light"
      ? { bg: "#f2f5f8", panel: "#ffffff", accent: "#1a93c2", text: "#17222b" }
      : { bg: "#0e1216", panel: "#141a20", accent: "#37b7e6", text: "#e8eef3" };
  return { bg: t.colors.bg ?? base.bg, panel: t.colors.panel ?? base.panel, accent: t.colors.accent ?? base.accent, text: t.colors.text ?? base.text };
}
