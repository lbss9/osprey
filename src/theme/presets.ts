import type { Theme } from "@/theme/themes";

/**
 * Built-in colour presets. Each one takes its palette from a well-known editor
 * or terminal scheme (Dracula, Nord, Solarized, Gruvbox, Catppuccin, Tokyo
 * Night, One Dark, GitHub, Monokai, Ayu, Rosé Pine, Everforest, Palenight,
 * Cobalt, Night Owl, Synthwave, Zenburn, Kanagawa, Oceanic, Material…) under
 * its own name. Only the core tokens are set; the engine derives the soft
 * variants and the selection colour from them.
 */
type P = {
  id: string;
  name: string;
  type: Theme["type"];
  bg: string;
  panel: string;
  panel2: string;
  panel3: string;
  line: string;
  line2: string;
  text: string;
  textSoft: string;
  textFaint: string;
  accent: string;
  accent2: string;
  onAccent: string;
  amber: string;
  green: string;
  red: string;
  purple: string;
  num: string;
  str: string;
  bool: string;
  date: string;
  json: string;
};

const P: P[] = [
  { id: "vampire", name: "Vampire Night", type: "dark", bg: "#1e1f29", panel: "#282a36", panel2: "#2f3242", panel3: "#3a3d4f", line: "#3b3e51", line2: "#4a4e63", text: "#f8f8f2", textSoft: "#c9cad6", textFaint: "#7a7d95", accent: "#bd93f9", accent2: "#d0acff", onAccent: "#1e1f29", amber: "#f1fa8c", green: "#50fa7b", red: "#ff5555", purple: "#ff79c6", num: "#bd93f9", str: "#f1fa8c", bool: "#ff79c6", date: "#ffb86c", json: "#8be9fd" },
  { id: "polar", name: "Polar Frost", type: "dark", bg: "#2e3440", panel: "#3b4252", panel2: "#434c5e", panel3: "#4c566a", line: "#4c566a", line2: "#5b6678", text: "#eceff4", textSoft: "#d8dee9", textFaint: "#8f9bb3", accent: "#88c0d0", accent2: "#8fbcbb", onAccent: "#2e3440", amber: "#ebcb8b", green: "#a3be8c", red: "#bf616a", purple: "#b48ead", num: "#b48ead", str: "#a3be8c", bool: "#d08770", date: "#ebcb8b", json: "#81a1c1" },
  { id: "solar-dusk", name: "Solar Dusk", type: "dark", bg: "#002b36", panel: "#073642", panel2: "#0b3f4c", panel3: "#124955", line: "#144a56", line2: "#1e5a66", text: "#eee8d5", textSoft: "#93a1a1", textFaint: "#657b83", accent: "#268bd2", accent2: "#2aa198", onAccent: "#fdf6e3", amber: "#b58900", green: "#859900", red: "#dc322f", purple: "#6c71c4", num: "#d33682", str: "#2aa198", bool: "#cb4b16", date: "#b58900", json: "#6c71c4" },
  { id: "solar-dawn", name: "Solar Dawn", type: "light", bg: "#fdf6e3", panel: "#fffbf0", panel2: "#f5efdc", panel3: "#eee8d5", line: "#e6dfc8", line2: "#d3ccb4", text: "#073642", textSoft: "#586e75", textFaint: "#93a1a1", accent: "#268bd2", accent2: "#2aa198", onAccent: "#fdf6e3", amber: "#b58900", green: "#859900", red: "#dc322f", purple: "#6c71c4", num: "#d33682", str: "#2aa198", bool: "#cb4b16", date: "#b58900", json: "#6c71c4" },
  { id: "retro-groove", name: "Retro Groove", type: "dark", bg: "#1d2021", panel: "#282828", panel2: "#32302f", panel3: "#3c3836", line: "#3c3836", line2: "#504945", text: "#ebdbb2", textSoft: "#d5c4a1", textFaint: "#928374", accent: "#fabd2f", accent2: "#fe8019", onAccent: "#282828", amber: "#fabd2f", green: "#b8bb26", red: "#fb4934", purple: "#d3869b", num: "#d3869b", str: "#b8bb26", bool: "#fe8019", date: "#fabd2f", json: "#83a598" },
  { id: "retro-cream", name: "Retro Cream", type: "light", bg: "#fbf1c7", panel: "#fdf7dd", panel2: "#f2e5bc", panel3: "#ebdbb2", line: "#e6d7a9", line2: "#d5c4a1", text: "#3c3836", textSoft: "#504945", textFaint: "#928374", accent: "#b57614", accent2: "#af3a03", onAccent: "#fbf1c7", amber: "#b57614", green: "#79740e", red: "#9d0006", purple: "#8f3f71", num: "#8f3f71", str: "#79740e", bool: "#af3a03", date: "#b57614", json: "#076678" },
  { id: "mocha", name: "Mocha", type: "dark", bg: "#1e1e2e", panel: "#181825", panel2: "#242438", panel3: "#313244", line: "#313244", line2: "#45475a", text: "#cdd6f4", textSoft: "#bac2de", textFaint: "#7f849c", accent: "#89b4fa", accent2: "#b4befe", onAccent: "#1e1e2e", amber: "#f9e2af", green: "#a6e3a1", red: "#f38ba8", purple: "#cba6f7", num: "#fab387", str: "#a6e3a1", bool: "#cba6f7", date: "#f9e2af", json: "#94e2d5" },
  { id: "latte", name: "Latte", type: "light", bg: "#eff1f5", panel: "#ffffff", panel2: "#f4f6fa", panel3: "#e6e9ef", line: "#dce0e8", line2: "#ccd0da", text: "#4c4f69", textSoft: "#5c5f77", textFaint: "#8c8fa1", accent: "#1e66f5", accent2: "#7287fd", onAccent: "#ffffff", amber: "#df8e1d", green: "#40a02b", red: "#d20f39", purple: "#8839ef", num: "#fe640b", str: "#40a02b", bool: "#8839ef", date: "#df8e1d", json: "#179299" },
  { id: "night-city", name: "Night City", type: "dark", bg: "#1a1b26", panel: "#1f2335", panel2: "#24283b", panel3: "#292e42", line: "#292e42", line2: "#3b4261", text: "#c0caf5", textSoft: "#a9b1d6", textFaint: "#565f89", accent: "#7aa2f7", accent2: "#7dcfff", onAccent: "#1a1b26", amber: "#e0af68", green: "#9ece6a", red: "#f7768e", purple: "#bb9af7", num: "#ff9e64", str: "#9ece6a", bool: "#bb9af7", date: "#e0af68", json: "#2ac3de" },
  { id: "midnight-one", name: "Midnight One", type: "dark", bg: "#21252b", panel: "#282c34", panel2: "#2c313a", panel3: "#3a3f4b", line: "#3a3f4b", line2: "#4b5263", text: "#abb2bf", textSoft: "#9da5b4", textFaint: "#5c6370", accent: "#61afef", accent2: "#56b6c2", onAccent: "#21252b", amber: "#e5c07b", green: "#98c379", red: "#e06c75", purple: "#c678dd", num: "#d19a66", str: "#98c379", bool: "#c678dd", date: "#e5c07b", json: "#56b6c2" },
  { id: "graphite", name: "Graphite", type: "dark", bg: "#0d1117", panel: "#161b22", panel2: "#1c2129", panel3: "#21262d", line: "#21262d", line2: "#30363d", text: "#e6edf3", textSoft: "#c9d1d9", textFaint: "#7d8590", accent: "#2f81f7", accent2: "#58a6ff", onAccent: "#ffffff", amber: "#d29922", green: "#3fb950", red: "#f85149", purple: "#a371f7", num: "#79c0ff", str: "#a5d6ff", bool: "#ff7b72", date: "#ffa657", json: "#d2a8ff" },
  { id: "paper", name: "Paper", type: "light", bg: "#f6f8fa", panel: "#ffffff", panel2: "#f6f8fa", panel3: "#eaeef2", line: "#d0d7de", line2: "#afb8c1", text: "#1f2328", textSoft: "#57606a", textFaint: "#8c959f", accent: "#0969da", accent2: "#218bff", onAccent: "#ffffff", amber: "#9a6700", green: "#1a7f37", red: "#cf222e", purple: "#8250df", num: "#0550ae", str: "#0a3069", bool: "#cf222e", date: "#953800", json: "#8250df" },
  { id: "sunset-coder", name: "Sunset Coder", type: "dark", bg: "#1e1f1c", panel: "#272822", panel2: "#2e2f28", panel3: "#3e3d32", line: "#3e3d32", line2: "#524f43", text: "#f8f8f2", textSoft: "#cfcfc2", textFaint: "#75715e", accent: "#a6e22e", accent2: "#e6db74", onAccent: "#272822", amber: "#e6db74", green: "#a6e22e", red: "#f92672", purple: "#ae81ff", num: "#ae81ff", str: "#e6db74", bool: "#f92672", date: "#fd971f", json: "#66d9ef" },
  { id: "amber-dusk", name: "Amber Dusk", type: "dark", bg: "#0b0e14", panel: "#0f131a", panel2: "#131721", panel3: "#1b2029", line: "#1b2029", line2: "#2d3440", text: "#bfbdb6", textSoft: "#a6a39b", textFaint: "#565b66", accent: "#e6b450", accent2: "#ffb454", onAccent: "#0b0e14", amber: "#ffb454", green: "#aad94c", red: "#f07178", purple: "#d2a6ff", num: "#d2a6ff", str: "#aad94c", bool: "#f07178", date: "#ffb454", json: "#39bae6" },
  { id: "morning-mist", name: "Morning Mist", type: "light", bg: "#f8f9fa", panel: "#ffffff", panel2: "#f3f4f5", panel3: "#e7e8ea", line: "#e0e2e5", line2: "#cbd0d6", text: "#5c6166", textSoft: "#6b7178", textFaint: "#9aa0a6", accent: "#ffaa33", accent2: "#f2ae49", onAccent: "#1f2328", amber: "#f2ae49", green: "#86b300", red: "#f07171", purple: "#a37acc", num: "#a37acc", str: "#86b300", bool: "#f07171", date: "#f2ae49", json: "#55b4d4" },
  { id: "rose-dawn", name: "Rose Dawn", type: "dark", bg: "#191724", panel: "#1f1d2e", panel2: "#26233a", panel3: "#2a273f", line: "#2a273f", line2: "#403d52", text: "#e0def4", textSoft: "#908caa", textFaint: "#6e6a86", accent: "#ebbcba", accent2: "#f6c177", onAccent: "#191724", amber: "#f6c177", green: "#9ccfd8", red: "#eb6f92", purple: "#c4a7e7", num: "#c4a7e7", str: "#9ccfd8", bool: "#eb6f92", date: "#f6c177", json: "#31748f" },
  { id: "evergreen", name: "Evergreen", type: "dark", bg: "#272e33", panel: "#2e383c", panel2: "#374145", panel3: "#414b50", line: "#414b50", line2: "#4f585e", text: "#d3c6aa", textSoft: "#bfb59c", textFaint: "#859289", accent: "#a7c080", accent2: "#83c092", onAccent: "#272e33", amber: "#dbbc7f", green: "#a7c080", red: "#e67e80", purple: "#d699b6", num: "#d699b6", str: "#a7c080", bool: "#e69875", date: "#dbbc7f", json: "#7fbbb3" },
  { id: "violet-night", name: "Violet Night", type: "dark", bg: "#292d3e", panel: "#2f3348", panel2: "#353a52", panel3: "#3e4460", line: "#3e4460", line2: "#4e5578", text: "#a6accd", textSoft: "#959dcb", textFaint: "#676e95", accent: "#82aaff", accent2: "#89ddff", onAccent: "#292d3e", amber: "#ffcb6b", green: "#c3e88d", red: "#f07178", purple: "#c792ea", num: "#f78c6c", str: "#c3e88d", bool: "#c792ea", date: "#ffcb6b", json: "#89ddff" },
  { id: "cobalt-sea", name: "Cobalt Sea", type: "dark", bg: "#122738", panel: "#193549", panel2: "#1f3f58", panel3: "#234a66", line: "#234a66", line2: "#2e5a7a", text: "#ffffff", textSoft: "#cbd8e2", textFaint: "#7f9fb5", accent: "#ffc600", accent2: "#ffe27a", onAccent: "#193549", amber: "#ffc600", green: "#3ad900", red: "#ff628c", purple: "#fb94ff", num: "#ff628c", str: "#3ad900", bool: "#ff9d00", date: "#ffc600", json: "#80fcff" },
  { id: "owl-night", name: "Owl Night", type: "dark", bg: "#011627", panel: "#01213a", panel2: "#0b2942", panel3: "#12324d", line: "#12324d", line2: "#1d3b53", text: "#d6deeb", textSoft: "#b6c2d2", textFaint: "#637777", accent: "#82aaff", accent2: "#7fdbca", onAccent: "#011627", amber: "#ecc48d", green: "#addb67", red: "#ef5350", purple: "#c792ea", num: "#f78c6c", str: "#ecc48d", bool: "#ff5874", date: "#ffcb8b", json: "#7fdbca" },
  { id: "synth-retro", name: "Synth Retro", type: "dark", bg: "#241b2f", panel: "#262335", panel2: "#2e2842", panel3: "#3a3050", line: "#3a3050", line2: "#4a3d66", text: "#f4eee4", textSoft: "#d8ccff", textFaint: "#8a7fa5", accent: "#f97e72", accent2: "#ff7edb", onAccent: "#241b2f", amber: "#fede5d", green: "#72f1b8", red: "#fe4450", purple: "#ff7edb", num: "#f97e72", str: "#ff8b39", bool: "#fe4450", date: "#fede5d", json: "#36f9f6" },
  { id: "zen-garden", name: "Zen Garden", type: "dark", bg: "#383838", panel: "#3f3f3f", panel2: "#494949", panel3: "#535353", line: "#535353", line2: "#646464", text: "#dcdccc", textSoft: "#c8c8b8", textFaint: "#8f8f8f", accent: "#8cd0d3", accent2: "#94bff3", onAccent: "#3f3f3f", amber: "#f0dfaf", green: "#7f9f7f", red: "#cc9393", purple: "#dc8cc3", num: "#dc8cc3", str: "#cc9393", bool: "#dfaf8f", date: "#f0dfaf", json: "#93e0e3" },
  { id: "ink-wave", name: "Ink Wave", type: "dark", bg: "#16161d", panel: "#1f1f28", panel2: "#2a2a37", panel3: "#363646", line: "#363646", line2: "#54546d", text: "#dcd7ba", textSoft: "#c8c093", textFaint: "#727169", accent: "#7e9cd8", accent2: "#7fb4ca", onAccent: "#16161d", amber: "#e6c384", green: "#98bb6c", red: "#e46876", purple: "#957fb8", num: "#d27e99", str: "#98bb6c", bool: "#ffa066", date: "#e6c384", json: "#7aa89f" },
  { id: "oceanic", name: "Oceanic", type: "dark", bg: "#1b2b34", panel: "#223340", panel2: "#293c4a", panel3: "#343d46", line: "#343d46", line2: "#4f5b66", text: "#d8dee9", textSoft: "#c0c5ce", textFaint: "#65737e", accent: "#6699cc", accent2: "#5fb3b3", onAccent: "#1b2b34", amber: "#fac863", green: "#99c794", red: "#ec5f67", purple: "#c594c5", num: "#f99157", str: "#99c794", bool: "#c594c5", date: "#fac863", json: "#5fb3b3" },
  { id: "deep-ocean", name: "Deep Ocean", type: "dark", bg: "#0f111a", panel: "#181a25", panel2: "#1e2130", panel3: "#232739", line: "#232739", line2: "#343a52", text: "#a6accd", textSoft: "#8f93b2", textFaint: "#4b526d", accent: "#84ffff", accent2: "#89ddff", onAccent: "#0f111a", amber: "#ffcb6b", green: "#c3e88d", red: "#ff5370", purple: "#c792ea", num: "#f78c6c", str: "#c3e88d", bool: "#c792ea", date: "#ffcb6b", json: "#89ddff" },
];

export const PRESETS: Theme[] = P.map((p) => ({
  id: p.id,
  name: p.name,
  type: p.type,
  author: "Osprey",
  colors: {
    bg: p.bg,
    panel: p.panel,
    "panel-2": p.panel2,
    "panel-3": p.panel3,
    line: p.line,
    "line-2": p.line2,
    text: p.text,
    "text-soft": p.textSoft,
    "text-faint": p.textFaint,
    accent: p.accent,
    "accent-2": p.accent2,
    "on-accent": p.onAccent,
    amber: p.amber,
    green: p.green,
    red: p.red,
    purple: p.purple,
    "k-num": p.num,
    "k-str": p.str,
    "k-bool": p.bool,
    "k-null": p.textFaint,
    "k-date": p.date,
    "k-json": p.json,
    "k-bytes": p.textSoft,
  },
}));
