import { isTauri } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

export async function copyText(text: string): Promise<void> {
  if (isTauri()) {
    try {
      await writeText(text);
      return;
    } catch {
      /* fall through to the DOM API */
    }
  }
  await navigator.clipboard.writeText(text);
}
