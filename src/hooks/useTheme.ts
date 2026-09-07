import { useEffect } from "react";
import { onEvent } from "@/services/events";
import { useThemes } from "@/store/themes";
import { useUi } from "@/store/ui";
import { applyTheme, AUTO_ID, BUILTIN } from "@/theme/themes";

/**
 * Applies the selected theme (built-in, JSON from the themes folder, or
 * "auto" following the OS) to `<html>` and mirrors font sizes into CSS vars.
 */
export function useTheme() {
  const theme = useUi((s) => s.theme);
  const fontSize = useUi((s) => s.fontSize);
  const editorFontSize = useUi((s) => s.editorFontSize);
  const zoom = useUi((s) => s.zoom);
  const all = useThemes((s) => s.all);
  const reload = useThemes((s) => s.reload);

  useEffect(() => {
    void reload();
    return onEvent("themes-changed", () => void reload());
  }, [reload]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const id = theme === AUTO_ID ? (mq.matches ? "dark" : "light") : theme;
      applyTheme(all.find((t) => t.id === id) ?? BUILTIN[0]);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme, all]);

  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--ui-font-size", `${fontSize}px`);
    root.setProperty("--editor-font-size", `${editorFontSize}px`);
    root.setProperty("--zoom", String(zoom));
  }, [fontSize, editorFontSize, zoom]);
}
