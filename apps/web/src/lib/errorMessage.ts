// Turns whatever a failed call threw into something worth showing. Tauri commands and plugins
// reject with plain strings, fetch helpers throw Error/ApiError, and some callers hand over a
// raw API body ({ error, code }) or a Response. Anything unrecognized falls back to `fallback`.
// An API error's `code` shows in the active language when it has a translation (lib/apiErrors.ts).
import { apiErrorMessage } from "./apiErrors";
import { userMessage } from "./userMessage";

// fetch's own rejection when no answer came back (Chrome, Firefox, Safari wordings).
const NO_ANSWER = /failed to fetch|networkerror|load failed/i;

export function errorMessage(err: unknown, fallback: string): string {
  // Plain words ("You're offline...") rather than the browser's "Failed to fetch" (ux-rules S1, S9).
  if (err instanceof TypeError && NO_ANSWER.test(err.message)) return userMessage(err);
  if (typeof err === "string") return err.trim() || fallback;
  if (err instanceof Error) return err.message.trim() || fallback;
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.error === "string" && obj.error.trim())
      return apiErrorMessage(obj.code, obj.error) || obj.error.trim();
    if (typeof obj.message === "string" && obj.message.trim()) return obj.message.trim();
    // Response-like: { ok: false, status, statusText }
    if (typeof obj.status === "number" && obj.ok !== true) {
      const text = typeof obj.statusText === "string" ? obj.statusText.trim() : "";
      return text ? `${fallback} (${obj.status} ${text})` : `${fallback} (${obj.status})`;
    }
  }
  return fallback;
}
