import { CLIENT_HEADER } from "../api/client";

// A plain download link in the Tauri webview navigates the whole window to the file, so the
// desktop app uses a native Save dialog. fallbackFilename is used only without Content-Disposition.
export async function downloadFile(url: string, fallbackFilename: string): Promise<void> {
  const res = await fetch(url, { credentials: "same-origin", headers: CLIENT_HEADER });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const disposition = res.headers.get("content-disposition");
  const match = disposition?.match(/filename="?([^"]+)"?/);
  const filename = match?.[1] ?? fallbackFilename;
  const blob = await res.blob();

  if (window.liferSetup) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
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
