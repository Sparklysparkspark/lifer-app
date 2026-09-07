// Plain `<a href="...">` navigation to a file endpoint does NOT reliably trigger a download in
// the desktop app's Tauri webview — it just navigates the whole window to the raw response with
// no back control (confirmed live: this is exactly the bug report behind this file existing).
// StatsPage.tsx already worked around the same class of problem for its CSV export with a real
// native "Save As" dialog; this generalizes that same fix for binary files (photo downloads)
// wherever else a plain download link would otherwise silently break in desktop mode.
// fallbackFilename is only used if the response has no Content-Disposition filename to read —
// the server already sets a real one (the original file's own name), including through an S3
// redirect (see signedS3Url's own comment), so this is a rare, defensive fallback, not the norm.
export async function downloadFile(url: string, fallbackFilename: string): Promise<void> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const disposition = res.headers.get("content-disposition");
  const match = disposition?.match(/filename="?([^"]+)"?/);
  const filename = match?.[1] ?? fallbackFilename;
  const blob = await res.blob();

  if (window.liferSetup) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".") + 1) : undefined;
    const path = await save({ defaultPath: filename, filters: extension ? [{ name: extension.toUpperCase(), extensions: [extension] }] : undefined });
    if (!path) return; // user cancelled the dialog
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return;
  }

  // Plain browser (self-hosted web access) — a real anchor click with `download` set works
  // fine here; no native dialog available or needed.
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(objectUrl);
}
