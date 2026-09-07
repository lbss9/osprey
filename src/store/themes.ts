/**
 * User themes loaded from the themes folder (JSON files). Built-ins are always
 * present; the backend emits `themes-changed` whenever the folder changes.
 */
import { create } from "zustand";
import * as api from "@/services/tauri";
import { BUILTIN, coerceTheme, type Theme } from "@/theme/themes";

interface ThemesState {
  user: Theme[];
  all: Theme[];
  reload: () => Promise<void>;
}

export const useThemes = create<ThemesState>()((set) => ({
  user: [],
  all: BUILTIN,
  reload: async () => {
    let user: Theme[] = [];
    try {
      const raw = await api.themesList();
      user = raw
        .map((r, i) => coerceTheme(r, (r as { __file?: string }).__file ?? `theme-${i}.json`))
        .filter((t): t is Theme => !!t && !BUILTIN.some((b) => b.id === t.id));
    } catch {
      user = [];
    }
    set({ user, all: [...BUILTIN, ...user] });
  },
}));
