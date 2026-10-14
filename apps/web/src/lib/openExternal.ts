import { isTauri } from "./tauri";
import { ignore } from "./ignore";

/** Opens a web page outside Lifer: the desktop shell only allows external URLs through the opener
 *  plugin (see main.tsx), a browser opens a new tab. */
export function openExternal(url: string): void {
  if (isTauri())
    import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url)).catch(ignore("Couldn't open the link"));
  else window.open(url, "_blank", "noopener,noreferrer");
}
