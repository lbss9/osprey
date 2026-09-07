import { useCallback, useState } from "react";
import type { ContextMenuState, MenuItem } from "@/components/molecules/ContextMenu";

/** Small helper so any component can own one context menu. */
export function useContextMenu() {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const open = useCallback((e: { clientX: number; clientY: number; preventDefault(): void }, items: MenuItem[]) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, []);
  const close = useCallback(() => setMenu(null), []);
  return { menu, open, close };
}
