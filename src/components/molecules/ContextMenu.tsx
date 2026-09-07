import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Button from "@/components/atoms/Button";
import Icon, { type IconName } from "@/components/atoms/Icon";

export interface MenuItem {
  label?: string;
  icon?: IconName;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  sep?: boolean;
  action?: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/**
 * Floating menu anchored at a screen position. Closes on outside click,
 * Escape, scroll or window blur. Flips to stay inside the viewport.
 */
export default function ContextMenu({ menu, onClose }: { menu: ContextMenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const x = Math.min(menu.x, window.innerWidth - r.width - 8);
    const y = Math.min(menu.y, window.innerHeight - r.height - 8);
    setPos({ x: Math.max(4, x), y: Math.max(4, y) });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e.type === "mousedown" && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu, onClose]);

  if (!menu) return null;
  return (
    <div ref={ref} className="ctx" style={{ left: pos.x, top: pos.y }} role="menu">
      {menu.items.map((it, i) =>
        it.sep ? (
          <div key={i} className="menu-sep" />
        ) : (
          <Button
            key={i}
            variant="bare"
            className={`menu-item ${it.danger ? "danger" : ""}`}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.action?.();
            }}
          >
            {it.icon ? <Icon name={it.icon} size={14} /> : <span style={{ width: 14 }} />}
            <span className="grow">{it.label}</span>
            {it.shortcut && <span className="shortcut">{it.shortcut}</span>}
          </Button>
        ),
      )}
    </div>
  );
}
