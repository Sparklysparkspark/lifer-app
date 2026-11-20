export type Platform = "mac" | "windows" | "other";

// Computed once. userAgentData isn't in every engine (Safari/WebKit lacks it), so fall back to the UA string.
function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const source = (
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.userAgent
  ).toLowerCase();
  if (source.includes("mac")) return "mac";
  if (source.includes("win")) return "windows";
  return "other";
}

export const platform: Platform = detectPlatform();
export const isMac = platform === "mac";

/** A store (Flathub) installed the desktop app and updates it, so Lifer's own updater stays out. */
export const storeManagedUpdates =
  typeof window !== "undefined" && (window as { __LIFER_STORE_UPDATES__?: boolean }).__LIFER_STORE_UPDATES__ === true;

// Platform words and conventions in one place: components call these, never test isMac for wording.
// The server web app has no OS truth beyond the browser's hint, so "other" gets neutral words.
export const revealPlace = (p: Platform = platform): string =>
  p === "mac" ? "Finder" : p === "windows" ? "Explorer" : "file manager";

export const modKey = (p: Platform = platform): string => (p === "mac" ? "⌘" : "Ctrl");

/** Windows puts a dialog's primary button first; macOS and Linux put it last. */
export const primaryButtonFirst = (p: Platform = platform): boolean => p === "windows";
