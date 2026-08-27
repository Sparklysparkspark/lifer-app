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
