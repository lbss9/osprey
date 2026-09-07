import { isTauri } from "@tauri-apps/api/core";
import { ask, message, open, save } from "@tauri-apps/plugin-dialog";

export async function confirmDialog(text: string, title = "Osprey"): Promise<boolean> {
  if (isTauri()) {
    try {
      return await ask(text, { title, kind: "warning" });
    } catch {
      /* fall back */
    }
  }
  return window.confirm(text);
}

export async function infoDialog(text: string, title = "Osprey"): Promise<void> {
  if (isTauri()) {
    try {
      await message(text, { title });
      return;
    } catch {
      /* fall back */
    }
  }
  window.alert(text);
}

export async function saveDialog(defaultName: string, ext: string, label: string): Promise<string | null> {
  if (!isTauri()) return null;
  const path = await save({
    defaultPath: defaultName,
    filters: [{ name: label, extensions: [ext] }],
  });
  return path ?? null;
}

export async function openFileDialog(title?: string): Promise<string | null> {
  if (!isTauri()) return window.prompt(title ?? "Path") ?? null;
  const path = await open({ multiple: false, directory: false, title });
  return typeof path === "string" ? path : null;
}
