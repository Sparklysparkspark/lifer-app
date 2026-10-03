// The one place that reads window.__TAURI__. Returns null outside the desktop app (a plain
// browser tab or the Docker/server deployment), so callers can use it unconditionally.
// `args` may be raw bytes (a Uint8Array arrives in Rust as the request body, not a JSON array).
export type TauriInvoke = (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => Promise<unknown>;

export function tauriInvoke(): TauriInvoke | null {
  const tauri = (window as unknown as { __TAURI__?: { core: { invoke: TauriInvoke } } }).__TAURI__;
  return tauri?.core.invoke ?? null;
}

export function isTauri(): boolean {
  return tauriInvoke() !== null;
}

// The native window, for real OS fullscreen. The frameless mac window doesn't reliably support
// the DOM Fullscreen API, but window-manager fullscreen always works.
export interface TauriWindow {
  isFullscreen(): Promise<boolean>;
  setFullscreen(fullscreen: boolean): Promise<void>;
}

export function tauriCurrentWindow(): TauriWindow | null {
  const tauriWindowModule = (window as unknown as { __TAURI__?: { window: { getCurrentWindow: () => TauriWindow } } })
    .__TAURI__?.window;
  return tauriWindowModule ? tauriWindowModule.getCurrentWindow() : null;
}
