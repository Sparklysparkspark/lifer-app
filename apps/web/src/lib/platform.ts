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
