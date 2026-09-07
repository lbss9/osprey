import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import Button from "@/components/atoms/Button";
import Icon, { type IconName } from "@/components/atoms/Icon";

/** A single actionable row, a submenu, or a divider between groups. */
export type ContextMenuItem =
  | { separator: true }
  | {
      separator?: false;
      label: string;
      icon?: IconName;
      /** hint shown right-aligned, e.g. "Ctrl+W" */
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      /** a check mark on the left (toggles) */
      checked?: boolean;
      /** nested items open to the right on hover */
      children?: ContextMenuItem[];
      onSelect?: () => void;
    };

/** What a target hands to the provider when it is right-clicked. */
export type MenuBuilder = () => ContextMenuItem[];

interface OpenState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

interface ContextMenuApi {
  /**
   * Open the custom menu at the cursor. Prevents the native WebView menu and
   * stops the event bubbling so an ancestor's menu doesn't override it.
   */
  open: (e: ReactMouseEvent | { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, items: ContextMenuItem[] | MenuBuilder) => void;
  /** Open below an element (dropdown-style buttons). */
  openBelow: (el: HTMLElement, items: ContextMenuItem[] | MenuBuilder) => void;
  close: () => void;
}

const Ctx = createContext<ContextMenuApi | null>(null);

/** Attach `onContextMenu={(e) => open(e, items)}` to any element. */
export function useContextMenu(): ContextMenuApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("useContextMenu must be used inside <ContextMenuProvider>");
  return api;
}

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<OpenState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const resolve = (items: ContextMenuItem[] | MenuBuilder) => (typeof items === "function" ? items() : items);

  const open = useCallback<ContextMenuApi["open"]>((e, items) => {
    e.preventDefault();
    e.stopPropagation();
    const list = resolve(items);
    if (list.length === 0) return;
    setState({ x: e.clientX, y: e.clientY, items: list });
  }, []);

  const openBelow = useCallback<ContextMenuApi["openBelow"]>((el, items) => {
    const list = resolve(items);
    if (list.length === 0) return;
    const r = el.getBoundingClientRect();
    setState({ x: r.left, y: r.bottom + 4, items: list });
  }, []);

  const close = useCallback(() => setState(null), []);

  // Kill the native menu everywhere; a target that wants ours calls open() and
  // stops propagation, so this only fires for un-handled right-clicks.
  useEffect(() => {
    const onNative = (e: globalThis.MouseEvent) => {
      const t = e.target as HTMLElement | null;
      // keep the native menu on editable fields (spell-check, paste)
      if (t && (t.closest("input, textarea, [contenteditable=true]") || t.closest(".cm-editor"))) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", onNative);
    return () => document.removeEventListener("contextmenu", onNative);
  }, []);

  // close on any outside interaction
  useEffect(() => {
    if (!state) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // the menu owns this Escape; an enclosing dialog must stay open
      e.stopPropagation();
      close();
    };
    const onScroll = () => close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("blur", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("blur", onScroll);
    };
  }, [state, close]);

  // flip the menu so it never overflows the window
  useLayoutEffect(() => {
    if (!state || !menuRef.current) return;
    const el = menuRef.current;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    let x = state.x;
    let y = state.y;
    if (x + width + pad > window.innerWidth) x = Math.max(pad, window.innerWidth - width - pad);
    if (y + height + pad > window.innerHeight) y = Math.max(pad, window.innerHeight - height - pad);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [state]);

  return (
    <Ctx.Provider value={{ open, openBelow, close }}>
      {children}
      {state &&
        createPortal(
          <div className="ctx-menu" ref={menuRef} role="menu" style={{ position: "fixed", left: state.x, top: state.y }}>
            <MenuItems items={state.items} close={close} />
          </div>,
          document.body,
        )}
    </Ctx.Provider>
  );
}

function MenuItems({ items, close }: { items: ContextMenuItem[]; close: () => void }) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  return (
    <>
      {items.map((it, i) =>
        "separator" in it && it.separator ? (
          <div className="ctx-sep" key={`sep-${i}`} role="separator" />
        ) : (
          <div
            key={`${it.label}-${i}`}
            className="ctx-item-wrap"
            onMouseEnter={() => setOpenSub(it.children ? i : null)}
            onMouseLeave={() => it.children && setOpenSub((s) => (s === i ? null : s))}
          >
            <Button
              variant="bare"
              className={`ctx-item ${it.danger ? "danger" : ""} ${it.checked ? "checked" : ""}`}
              role={it.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
              aria-checked={it.checked}
              disabled={it.disabled}
              onClick={() => {
                if (it.children && !it.onSelect) {
                  setOpenSub(i);
                  return;
                }
                close();
                it.onSelect?.();
              }}
            >
              <span className="ctx-icon">
                {it.checked !== undefined ? (it.checked ? <Icon name="check" size={14} /> : null) : it.icon && <Icon name={it.icon} size={14} />}
              </span>
              <span className="ctx-label">{it.label}</span>
              {it.shortcut && <span className="ctx-shortcut">{it.shortcut}</span>}
              {it.children && <Icon name="chevronRight" size={13} className="ctx-more" />}
            </Button>
            {it.children && openSub === i && (
              <SubMenu items={it.children} close={close} />
            )}
          </div>
        ),
      )}
    </>
  );
}

function SubMenu({ items, close }: { items: ContextMenuItem[]; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // open to the left when there is no room on the right
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) el.classList.add("left");
    if (r.bottom > window.innerHeight - 8) el.style.top = `${Math.max(-r.top + 8, window.innerHeight - 8 - r.bottom)}px`;
  }, []);
  return (
    <div className="ctx-menu ctx-sub" ref={ref} role="menu">
      <MenuItems items={items} close={close} />
    </div>
  );
}
