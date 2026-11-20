import { CLIENT_HEADER } from "../api/client";
import type { ToastApi } from "../hooks/useToast";

// Only the last path segment, so a name from the server can't point outside the chosen folder.
function baseName(name: string | undefined): string | undefined {
  const base = name?.split(/[/\\]/).pop()?.trim();
  return base && base !== "." && base !== ".." ? base : undefined;
}

export function safeFilename(name: string | undefined, fallback: string): string {
  return baseName(name) ?? baseName(fallback) ?? "download";
}

// A plain download link in the Tauri webview navigates the whole window to the file, so the
// desktop app uses a native Save dialog. fallbackFilename is used only without Content-Disposition,
// unless `filename` overrides the server's name.
export async function downloadFile(
  url: string,
  fallbackFilename: string,
  options: { filename?: string; folder?: string } = {},
): Promise<void> {
  const res = await fetch(url, { credentials: "same-origin", headers: CLIENT_HEADER });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const disposition = res.headers.get("content-disposition");
  const match = disposition?.match(/filename="?([^"]+)"?/);
  const filename = safeFilename(options.filename ?? match?.[1], fallbackFilename);
  const blob = await res.blob();

  if (window.liferSetup) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { exists, writeFile } = await import("@tauri-apps/plugin-fs");
    // Into a folder picked once for a batch: no dialog per file, and never over an existing file.
    if (options.folder) {
      const dot = filename.lastIndexOf(".");
      const [stem, ext] = dot > 0 ? [filename.slice(0, dot), filename.slice(dot)] : [filename, ""];
      let target = `${options.folder}/${filename}`;
      for (let n = 2; await exists(target); n++) target = `${options.folder}/${stem} (${n})${ext}`;
      await writeFile(target, new Uint8Array(await blob.arrayBuffer()));
      return;
    }
    const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".") + 1) : undefined;
    const path = await save({
      defaultPath: filename,
      filters: extension ? [{ name: extension.toUpperCase(), extensions: [extension] }] : undefined,
    });
    if (!path) return; // user cancelled the dialog
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return;
  }

  // Plain browser: an anchor click with `download` set works fine.
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  a.click();
  // Revoking right away can cancel the download before the browser has read the blob.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}

/** The desktop app's folder for a batch of downloads, asked once. Undefined outside it (the browser
 *  saves each to Downloads), null when cancelled. */
export async function pickDownloadFolder(): Promise<string | null | undefined> {
  if (!window.liferSetup) return undefined;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const folder = await open({ directory: true, recursive: true, title: "Save originals to" });
  return typeof folder === "string" ? folder : null;
}

/** downloadFile for a menu action: says it's working, since a large original takes a while to
 *  fetch before anything shows, and reports a failure. */
export async function downloadWithToast(toast: ToastApi, url: string, fallbackFilename: string): Promise<void> {
  const id = toast.show("Preparing download...", { durationMs: null });
  try {
    await downloadFile(url, fallbackFilename);
  } catch {
    toast.error("Couldn't download this file. Try again.");
  } finally {
    toast.dismiss(id);
  }
}
