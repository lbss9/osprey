import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Subscribe to a backend event. In Tauri that is the IPC event bus; in the
 * browser (mock) the same name is dispatched as a window CustomEvent so
 * screens behave identically. Returns an unsubscribe function.
 */
export function onEvent<T>(name: string, cb: (payload: T) => void): () => void {
  if (isTauri()) {
    let un: (() => void) | undefined;
    let cancelled = false;
    listen<T>(name, (e) => cb(e.payload)).then((u) => {
      if (cancelled) u();
      else un = u;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }
  const handler = (e: Event) => cb((e as CustomEvent<T>).detail);
  window.addEventListener(name, handler);
  return () => window.removeEventListener(name, handler);
}
