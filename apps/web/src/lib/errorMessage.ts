// Turns whatever a failed call threw into something worth showing. Tauri commands and plugins
// reject with plain strings, fetch helpers throw Error/ApiError, and some callers hand over a
// raw API body ({ error }) or a Response. Anything unrecognized falls back to `fallback`.
export function errorMessage(err: unknown, fallback: string): string {
  if (typeof err === "string") return err.trim() || fallback;
  if (err instanceof Error) return err.message.trim() || fallback;
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.error === "string" && obj.error.trim()) return obj.error.trim();
    if (typeof obj.message === "string" && obj.message.trim()) return obj.message.trim();
    // Response-like: { ok: false, status, statusText }
    if (typeof obj.status === "number" && obj.ok !== true) {
      const text = typeof obj.statusText === "string" ? obj.statusText.trim() : "";
      return text ? `${fallback} (${obj.status} ${text})` : `${fallback} (${obj.status})`;
    }
  }
  return fallback;
}
