import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Button from "@/components/atoms/Button";
import { useContextMenu, type ContextMenuItem } from "@/components/molecules/ContextMenu";
import { isMac, modKey } from "@/utils/format";

type MenuId = "file" | "edit" | "view" | "help";

export interface TitleBarProps {
  onNewConnection: () => void;
  onNewQuery: () => void;
  onOpenSettings: (tab?: string) => void;
  onToggleSidebar: () => void;
  onZoom: (dir: "in" | "out" | "reset") => void;
  onCheckUpdates: () => void;
  onPalette: () => void;
  subtitle?: string;
}

/**
 * Frameless title bar with app menus (rendered by the shared ContextMenu so
 * they look like every other menu). On macOS the native traffic lights stay
 * (overlay title bar); on Windows/Linux the window controls are drawn here.
 */
export default function TitleBar(p: TitleBarProps) {
  const { t } = useTranslation();
  const { openBelow, close } = useContextMenu();
  const [maximized, setMaximized] = useState(false);
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
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

  // the shared menu closes on outside mousedown; mirror that in our highlight
  useEffect(() => {
    if (!openMenu) return;
    const clear = () => setOpenMenu(null);
    window.addEventListener("mousedown", clear);
    window.addEventListener("keydown", clear);
    return () => {
      window.removeEventListener("mousedown", clear);
      window.removeEventListener("keydown", clear);
    };
  }, [openMenu]);

  const exec = (cmd: string) => () => {
    try {
      document.execCommand(cmd);
    } catch {
      /* unavailable */
    }
  };

  const menus: { id: MenuId; label: string; items: ContextMenuItem[] }[] = [
    {
      id: "file",
      label: t("menu.file"),
      items: [
        { label: t("menu.newConnection"), icon: "plus", shortcut: `${modKey}+N`, onSelect: p.onNewConnection },
        { label: t("menu.newQuery"), icon: "fileCode", shortcut: `${modKey}+T`, onSelect: p.onNewQuery },
        { separator: true },
        { label: t("menu.settings"), icon: "settings", shortcut: `${modKey}+,`, onSelect: () => p.onOpenSettings("general") },
        { separator: true },
        { label: t("menu.exit"), onSelect: () => void win?.close() },
      ],
    },
    {
      id: "edit",
      label: t("menu.edit"),
      items: [
        { label: t("menu.undo"), shortcut: `${modKey}+Z`, onSelect: exec("undo") },
        { label: t("menu.redo"), shortcut: `${modKey}+Y`, onSelect: exec("redo") },
        { separator: true },
        { label: t("menu.cut"), shortcut: `${modKey}+X`, onSelect: exec("cut") },
        { label: t("menu.copy"), icon: "copy", shortcut: `${modKey}+C`, onSelect: exec("copy") },
        { label: t("menu.paste"), shortcut: `${modKey}+V`, onSelect: exec("paste") },
        { label: t("menu.selectAll"), shortcut: `${modKey}+A`, onSelect: exec("selectAll") },
      ],
    },
    {
      id: "view",
      label: t("menu.view"),
      items: [
        { label: t("menu.palette"), icon: "search", shortcut: `${modKey}+K`, onSelect: p.onPalette },
        { label: t("menu.toggleSidebar"), shortcut: `${modKey}+B`, onSelect: p.onToggleSidebar },
        { separator: true },
        { label: t("menu.zoomIn"), shortcut: `${modKey}+=`, onSelect: () => p.onZoom("in") },
        { label: t("menu.zoomOut"), shortcut: `${modKey}+-`, onSelect: () => p.onZoom("out") },
        { label: t("menu.zoomReset"), shortcut: `${modKey}+0`, onSelect: () => p.onZoom("reset") },
      ],
    },
    {
      id: "help",
      label: t("menu.help"),
      items: [
        { label: t("menu.checkUpdates"), icon: "download", onSelect: p.onCheckUpdates },
        { label: t("menu.about"), icon: "info", onSelect: () => p.onOpenSettings("about") },
      ],
    },
  ];

  const show = (m: (typeof menus)[number], el: HTMLElement) => {
    if (openMenu === m.id) {
      close();
      setOpenMenu(null);
      return;
    }
    openBelow(el, m.items);
    setOpenMenu(m.id);
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
      <div className="menus">
        {menus.map((m) => (
          <Button
            key={m.id}
            variant="bare"
            className={`menu-btn ${openMenu === m.id ? "open" : ""}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => show(m, e.currentTarget)}
            onMouseEnter={(e) => openMenu && openMenu !== m.id && show(m, e.currentTarget)}
          >
            {m.label}
          </Button>
        ))}
      </div>
      <div className="drag" data-tauri-drag-region onDoubleClick={() => win?.toggleMaximize()} />
      {p.subtitle && <span className="center">{p.subtitle}</span>}
      {controls}
    </div>
  );
}
