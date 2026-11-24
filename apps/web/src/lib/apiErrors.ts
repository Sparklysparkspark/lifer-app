// API errors are { error, code }: `error` is English for a person, `code` a stable reason. The web
// app shows a translation keyed by `code` when the active language has one, and the server's own
// `error` otherwise. In English the server's text always wins: it is the English source, and it
// can name things a generic message can't (a region, a field). The English values in en.json
// under errors.api are what translators translate.
import i18n, { SOURCE_LOCALE } from "../i18n";

/**
 * Every `code` value apps/api/src sends, with its message key. Audit with:
 *   grep -rhoE 'code: ?"[a-z0-9_]+"' apps/api/src packages/core/src --include='*.ts' --exclude='*.test.ts' | sort -u
 */
export const API_ERROR_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  desktop_only: "errors.api.desktop_only",
  folder_unavailable: "errors.api.folder_unavailable",
  immich_too_old: "errors.api.immich_too_old",
  immich_unreachable: "errors.api.immich_unreachable",
  invalid_request: "errors.api.invalid_request",
  library_folder_unavailable: "errors.api.library_folder_unavailable",
  maybe_on_inaturalist: "errors.api.maybe_on_inaturalist",
  model_mismatch: "errors.api.model_mismatch",
  models_not_ready: "errors.api.models_not_ready",
  no_checklist: "errors.api.no_checklist",
  no_video_frames: "errors.api.no_video_frames",
  not_added: "errors.api.not_added",
  pack_index_unavailable: "errors.api.pack_index_unavailable",
  reorganize_failed: "errors.api.reorganize_failed",
  server_only: "errors.api.server_only",
  storage_move_failed: "errors.api.storage_move_failed",
  suggestion_failed: "errors.api.suggestion_failed",
  version_link_refused: "errors.api.version_link_refused",
};

/**
 * The message to show for an API error: the active language's translation of `code` when it has
 * one, else the server's `error` text, else (no text at all) the English message for the code.
 */
export function apiErrorMessage(code: unknown, serverMessage: string | null | undefined, language?: string): string {
  const key = typeof code === "string" ? API_ERROR_MESSAGE_KEYS[code] : undefined;
  const server = serverMessage?.trim() ?? "";
  if (!key) return server;
  const lng = language ?? i18n.resolvedLanguage ?? i18n.language;
  if (lng && lng !== SOURCE_LOCALE) {
    // Only the locale's own string: falling back to English would hide the more specific server text.
    const own = i18n.getResource(lng, "translation", key);
    if (typeof own === "string" && own) return i18n.t(key, { lng });
  }
  return server || i18n.t(key, { lng: SOURCE_LOCALE });
}
