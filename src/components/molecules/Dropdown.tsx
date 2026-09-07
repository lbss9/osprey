import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";

export interface DropdownOption {
  value: string;
  label: string;
  /** small grey text after the label */
  hint?: string;
  /** extra class on trigger/item (e.g. a colour) */
  className?: string;
  disabled?: boolean;
}

/**
 * Osprey's own dropdown. Every select in the app uses this instead of the
 * native `<select>` so the look is consistent across platforms. The menu
 * renders in a portal on `<body>` with fixed positioning so it is never
 * clipped by a scrolling ancestor.
 */
export default function Dropdown({
  value,
  options,
  onChange,
  size = "md",
  className = "",
  menuAlign = "left",
  ariaLabel,
  title,
  disabled,
  placeholder,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (v: string) => void;
  size?: "sm" | "md";
  className?: string;
  menuAlign?: "left" | "right";
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number; minWidth: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      const top = below < 200 ? Math.max(8, r.top - Math.min(340, options.length * 32 + 10) - 4) : r.bottom + 4;
      setPos(
        menuAlign === "right"
          ? { top, right: window.innerWidth - r.right, minWidth: r.width }
          : { top, left: r.left, minWidth: r.width },
      );
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, menuAlign, options.length]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // swallow it: an enclosing dialog must not close too
        e.stopPropagation();
        setOpen(false);
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const enabled = options.filter((o) => !o.disabled);
        const i = enabled.findIndex((o) => o.value === value);
        const next = enabled[(i + (e.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length];
        if (next) onChange(next.value);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, options, value, onChange]);

  return (
    <div className={`dd dd-${size} ${className}`.trim()} ref={ref} title={title}>
      <Button
        variant="bare"
        className={`dd-trigger ${current?.className ?? ""} ${open ? "open" : ""}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`dd-value ${current ? "" : "placeholder"}`}>{current?.label ?? placeholder ?? value}</span>
        <Icon name="chevronDown" size={13} className={`dd-caret ${open ? "open" : ""}`} />
      </Button>
      {open &&
        pos &&
        createPortal(
          <div className="dd-menu" ref={menuRef} role="listbox" style={{ position: "fixed", top: pos.top, left: pos.left, right: pos.right, minWidth: pos.minWidth }}>
            {options.map((o) => (
              <Button
                variant="bare"
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                className={`dd-item ${o.className ?? ""} ${o.value === value ? "active" : ""}`}
                disabled={o.disabled}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <span className="dd-item-label">
                  {o.label}
                  {o.hint && <span className="dd-item-hint">{o.hint}</span>}
                </span>
                {o.value === value && <Icon name="check" size={13} className="dd-check" />}
              </Button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
