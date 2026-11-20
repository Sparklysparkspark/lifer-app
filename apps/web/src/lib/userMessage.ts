// The one way to turn a thrown value into words for a person. It never returns the raw message:
// those carry codes, paths and database text (ux-rules S1). It reads only the status, the code
// and well-known error markers, then picks a plain sentence from errors.user in en.json.
import i18n from "../i18n";
import { formatBytes } from "./format";

type Kind = "offline" | "network" | "diskFull" | "permission" | "signedOut" | "notAllowed" | "notFound" | "unknown";

const MARKERS: ReadonlyArray<readonly [Kind, RegExp]> = [
  ["diskFull", /ENOSPC|no space left|disk full|quota/i],
  ["permission", /EPERM|EACCES|permission denied|operation not permitted|forbidden/i],
  ["notFound", /ENOENT|no such file|not found/i],
  ["network", /failed to fetch|networkerror|load failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network request failed/i],
];

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;
const TIMED_OUT = /ETIMEDOUT|timed? ?out/i;

function kindOf(err: unknown): Kind {
  return isOffline() ? "offline" : answerKind(err);
}

/** For a page that couldn't load: the connection's part in it ("You're offline", "Couldn't reach
 *  Lifer", "taking too long"), or null when the server answered, so the page's own words stand. */
export function connectionMessage(err: unknown): string | null {
  const obj = err && typeof err === "object" ? (err as Record<string, unknown>) : {};
  const text = typeof obj.message === "string" ? obj.message : typeof err === "string" ? err : "";
  if (obj.status === 504 || obj.name === "TimeoutError" || TIMED_OUT.test(text)) return i18n.t("errors.user.slow");
  if (answerKind(err) !== "network") return null;
  // Offline only matters once the request failed: the desktop app's own server needs no internet.
  return i18n.t(isOffline() ? "errors.user.offline" : "errors.user.network");
}

function answerKind(err: unknown): Kind {
  const obj = err && typeof err === "object" ? (err as Record<string, unknown>) : {};
  const status = typeof obj.status === "number" ? obj.status : 0;
  if (status === 507) return "diskFull";
  // API auth statuses, not file permissions.
  if (status === 401) return "signedOut";
  if (status === 403) return "notAllowed";
  if (status === 404) return "notFound";
  if (status === 502 || status === 503 || status === 504) return "network";
  // Only used to classify, never shown.
  const text =
    typeof err === "string"
      ? err
      : typeof obj.message === "string"
        ? obj.message
        : typeof obj.code === "string"
          ? obj.code
          : "";
  return MARKERS.find(([, re]) => re.test(text))?.[0] ?? "unknown";
}

// Literal keys so the i18n check can see each one is used.
export function userMessage(err: unknown): string {
  switch (kindOf(err)) {
    case "offline":
      return i18n.t("errors.user.offline");
    case "network":
      return i18n.t("errors.user.network");
    case "diskFull": {
      const { needed, free } = (err ?? {}) as { needed?: unknown; free?: unknown };
      if (typeof needed === "number" && needed > 0 && typeof free === "number")
        return i18n.t("errors.user.diskFullSizes", { needed: formatBytes(needed), free: formatBytes(free) });
      return i18n.t("errors.user.diskFull");
    }
    case "permission":
      return i18n.t("errors.user.permission");
    case "signedOut":
      return i18n.t("errors.user.signedOut");
    case "notAllowed":
      return i18n.t("errors.user.notAllowed");
    case "notFound":
      return i18n.t("errors.user.notFound");
    default:
      return i18n.t("errors.user.unknown");
  }
}
