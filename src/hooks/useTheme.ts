import { useEffect } from "react";
import { useUi } from "@/store/ui";

/**
 * Applies the chosen theme to `<html data-theme>` and keeps "auto" in sync
 * with the OS. Also mirrors font sizes into CSS variables.
 */
export function useTheme() {
  const theme = useUi((s) => s.theme);
  const fontSize = useUi((s) => s.fontSize);
  const editorFontSize = useUi((s) => s.editorFontSize);
  const zoom = useUi((s) => s.zoom);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = theme === "auto" ? (mq.matches ? "dark" : "light") : theme;
      document.documentElement.setAttribute("data-theme", resolved);
      document.documentElement.style.colorScheme = resolved;
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--ui-font-size", `${fontSize}px`);
    root.setProperty("--editor-font-size", `${editorFontSize}px`);
    root.setProperty("--zoom", String(zoom));
  }, [fontSize, editorFontSize, zoom]);
}
