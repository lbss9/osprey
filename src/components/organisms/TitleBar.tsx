import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Button from "@/components/atoms/Button";
import type { MenuItem } from "@/components/molecules/ContextMenu";
import { isMac, modKey } from "@/utils/format";

type MenuId = "file" | "edit" | "view" | "help";

export interface TitleBarProps {
  onNewConnection: () => void;
  onNewQuery: () => void;
  onOpenSettings: (tab?: string) => void;
  onToggleSidebar: () => void;
  onZoom: (dir: "in" | "out" | "reset") => void;
  onCheckUpdates: () => void;
  subtitle?: string;
}

/**
 * Frameless title bar with app menus. On macOS the native traffic lights
 * stay (overlay title bar), so only the menus render; on Windows/Linux the
 * window controls are drawn here.
 */
export default function TitleBar(p: TitleBarProps) {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const win = useMemo(() => {
    try {
      return getCurrentWindow();
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!win) return;
    let unlisten: (() => void) | undefined;
    win.isMaximized().then(setMaximized).catch(() => {});
    win
      .onResized(() => win.isMaximized().then(setMaximized).catch(() => {}))
      .then((u) => (unlisten = u))
      .catch(() => {});
    return () => unlisten?.();
  }, [win]);

  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpenMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [openMenu]);

  const exec = (cmd: string) => () => {
    try {
      document.execCommand(cmd);
    } catch {
      /* unavailable */
    }
  };

  const menus: { id: MenuId; label: string; items: MenuItem[] }[] = [
    {
      id: "file",
      label: t("menu.file"),
      items: [
        { label: t("menu.newConnection"), shortcut: `${modKey}+N`, action: p.onNewConnection },
        { label: t("menu.newQuery"), shortcut: `${modKey}+T`, action: p.onNewQuery },
        { sep: true },
        { label: t("menu.settings"), shortcut: `${modKey}+,`, action: () => p.onOpenSettings("general") },
        { sep: true },
        { label: t("menu.exit"), action: () => win?.close() },
      ],
    },
    {
      id: "edit",
      label: t("menu.edit"),
      items: [
        { label: t("menu.undo"), shortcut: `${modKey}+Z`, action: exec("undo") },
        { label: t("menu.redo"), shortcut: `${modKey}+Y`, action: exec("redo") },
        { sep: true },
        { label: t("menu.cut"), shortcut: `${modKey}+X`, action: exec("cut") },
        { label: t("menu.copy"), shortcut: `${modKey}+C`, action: exec("copy") },
        { label: t("menu.paste"), shortcut: `${modKey}+V`, action: exec("paste") },
        { label: t("menu.selectAll"), shortcut: `${modKey}+A`, action: exec("selectAll") },
      ],
    },
    {
      id: "view",
      label: t("menu.view"),
      items: [
        { label: t("menu.toggleSidebar"), shortcut: `${modKey}+B`, action: p.onToggleSidebar },
        { sep: true },
        { label: t("menu.zoomIn"), shortcut: `${modKey}+=`, action: () => p.onZoom("in") },
        { label: t("menu.zoomOut"), shortcut: `${modKey}+-`, action: () => p.onZoom("out") },
        { label: t("menu.zoomReset"), shortcut: `${modKey}+0`, action: () => p.onZoom("reset") },
      ],
    },
    {
      id: "help",
      label: t("menu.help"),
      items: [
        { label: t("menu.checkUpdates"), action: p.onCheckUpdates },
        { label: t("menu.about"), action: () => p.onOpenSettings("about") },
      ],
    },
  ];

  const openAt = (id: MenuId, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setAnchor({ x: r.left, y: r.bottom + 2 });
    setOpenMenu((cur) => (cur === id ? null : id));
  };

  const controls = !isMac && (
    <div className="win-controls">
      <Button variant="bare" className="wc min" onClick={() => win?.minimize()} aria-label={t("window.minimize")}>
        <svg width="10" height="10" viewBox="0 0 10 10">
          <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
        </svg>
      </Button>
      <Button variant="bare" className="wc max" onClick={() => win?.toggleMaximize()} aria-label={t("window.maximize")}>
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="0.5" y="2.5" width="6" height="6" fill="none" stroke="currentColor" />
            <path d="M3 2.5V1h5.5V6.5H7" fill="none" stroke="currentColor" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
          </svg>
        )}
      </Button>
      <Button variant="bare" className="wc close" onClick={() => win?.close()} aria-label={t("window.close")}>
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M0 0L10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </Button>
    </div>
  );

  return (
    <div className={`titlebar ${isMac ? "mac" : ""}`} data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <span className="logo">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M12 4c-1.6 3-5 5-10 4.8 3 1.8 6.4 2.6 8.4 2.2L12 15l1.6-4c2 .4 5.4-.4 8.4-2.2C17 9 13.6 7 12 4z" fill="#06202b" />
            <circle cx="12" cy="8" r="1.2" fill="#ffc766" />
          </svg>
        </span>
        <span>Osprey</span>
      </div>
      <div className="menus" onMouseDown={(e) => e.stopPropagation()}>
        {menus.map((m) => (
          <Button
            key={m.id}
            variant="bare"
            className={`menu-btn ${openMenu === m.id ? "open" : ""}`}
            onClick={(e) => openAt(m.id, e.currentTarget)}
            onMouseEnter={(e) => openMenu && openMenu !== m.id && openAt(m.id, e.currentTarget)}
          >
            {m.label}
          </Button>
        ))}
      </div>
      <div className="drag" data-tauri-drag-region onDoubleClick={() => win?.toggleMaximize()} />
      {p.subtitle && <span className="center">{p.subtitle}</span>}
      {controls}
      {openMenu && (
        <div className="menu-pop" style={{ left: anchor.x, top: anchor.y }} onMouseDown={(e) => e.stopPropagation()}>
          {menus
            .find((m) => m.id === openMenu)!
            .items.map((it, i) =>
              it.sep ? (
                <div key={i} className="menu-sep" />
              ) : (
                <Button
                  key={i}
                  variant="bare"
                  className="menu-item"
                  onClick={() => {
                    setOpenMenu(null);
                    it.action?.();
                  }}
                >
                  <span className="grow">{it.label}</span>
                  {it.shortcut && <span className="shortcut">{it.shortcut}</span>}
                </Button>
              ),
            )}
        </div>
      )}
    </div>
  );
}
