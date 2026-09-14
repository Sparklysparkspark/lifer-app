// Shared with TrafficLights.tsx's own local copy of this check — kept here so any future
// desktop-only integration (like species-id's AI photo match) doesn't reinvent it.
export type TauriInvoke = (cmd: string, args?: unknown) => Promise<unknown>;

export function tauriInvoke(): TauriInvoke | null {
  const tauri = (window as unknown as { __TAURI__?: { core: { invoke: TauriInvoke } } }).__TAURI__;
  return tauri?.core.invoke ?? null;
}

export function isTauri(): boolean {
  return tauriInvoke() !== null;
}

// The actual native window (real macOS/Windows/Linux fullscreen, not the browser Fullscreen
// API) — see Lightbox.tsx's own comment on why this, not document.requestFullscreen(), is what
// its fullscreen toggle needs: this app's frameless/traffic-lights window (see desktop's
// lib.rs) doesn't reliably support the DOM Fullscreen API, but window-manager-level fullscreen
// (the same thing the native green traffic-light button already does) always works.
export interface TauriWindow {
  isFullscreen(): Promise<boolean>;
  setFullscreen(fullscreen: boolean): Promise<void>;
}

export function tauriCurrentWindow(): TauriWindow | null {
  const tauriWindowModule = (window as unknown as { __TAURI__?: { window: { getCurrentWindow: () => TauriWindow } } })
    .__TAURI__?.window;
  return tauriWindowModule ? tauriWindowModule.getCurrentWindow() : null;
}
