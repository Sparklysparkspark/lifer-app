// Importing a folder again: picked files the library already has (imported, or left out of an
// earlier import) are set aside before anything is uploaded or checked. Each file is known by a
// quick fingerprint, the same one the API keeps (movedPhotos/fingerprint.ts in the API).
import { api, CLIENT_HEADER } from "../api/client";
import { mapWithConcurrency } from "./concurrency";

const EDGE = 64 * 1024;
const BATCH = 2000;
// Small first batches so the first new photos appear at once; later ones grow to the API's limit.
const FIRST_BATCH = 200;

/** sha1 (hex) of the size in decimal, the first 64 KB and the last 64 KB: two small reads. */
export async function quickHash(file: Blob): Promise<string> {
  const size = file.size;
  const parts: BlobPart[] = [String(size), file.slice(0, Math.min(EDGE, size))];
  if (size > EDGE) parts.push(file.slice(Math.max(EDGE, size - EDGE), size));
  const digest = await crypto.subtle.digest("SHA-1", await new Blob(parts).arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface KnownFile {
  name: string;
  fingerprint: string;
  status: "imported" | "skipped";
  /** The picked file, or for a desktop folder its path (read only if imported anyway). */
  file: File | null;
  path: string | null;
}

/** Splits `files` into new and known, batch by batch, calling `onBatch` as each settles so new rows
 *  show long before a big folder is done. Never blocks an import: a failed lookup lets its batch
 *  through as new, where the upload's own duplicate check still runs. */
export async function sortKnownFiles(
  files: File[],
  onBatch: (fresh: Array<{ file: File; fingerprint: string | null }>, known: KnownFile[]) => void,
): Promise<void> {
  // shortcut: crypto.subtle only exists on https or localhost, so a server opened over plain http
  // skips the pre-filter and relies on the upload's duplicate check; bundle a sha1 if that matters.
  if (!globalThis.crypto?.subtle) {
    onBatch(
      files.map((file) => ({ file, fingerprint: null })),
      [],
    );
    return;
  }
  for (let start = 0, size = FIRST_BATCH; start < files.length; start += size, size = BATCH) {
    const chunk = files.slice(start, start + size);
    const prints = await mapWithConcurrency(chunk, 16, (f) => quickHash(f).catch(() => null));
    let known = new Map<string, "imported" | "skipped">();
    try {
      const fingerprints = [...new Set(prints.filter((p): p is string => p != null))];
      const res = await api.post("/uploads/known", { fingerprints });
      known = new Map(res.known.map((k) => [k.fingerprint, k.status]));
    } catch {
      // Lookup failed: everything in this batch is treated as new.
    }
    const fresh: Array<{ file: File; fingerprint: string | null }> = [];
    const old: KnownFile[] = [];
    chunk.forEach((file, i) => {
      const fingerprint = prints[i];
      const status = fingerprint ? known.get(fingerprint) : undefined;
      if (fingerprint && status) old.push({ name: file.name, fingerprint, status, file, path: null });
      else fresh.push({ file, fingerprint });
    });
    onBatch(fresh, old);
    // Let the new rows render before the next batch is read.
    await new Promise((r) => setTimeout(r, 0));
  }
}

export type SkipReason = "removed" | "not_wildlife" | "no_animal";

/** Remembers photos left out of an import, so picking their folder again doesn't offer them. */
export async function rememberSkipped(
  files: Array<{ fingerprint: string; name: string; size: number; reason: SkipReason }>,
): Promise<void> {
  for (let i = 0; i < files.length; i += BATCH)
    await api.post("/uploads/skipped", { files: files.slice(i, i + BATCH) });
}

/** A file in a remembered folder (desktop), as a File the import screen can queue like a picked one. */
export async function fetchFolderFile(entry: { path: string; name: string; mtimeMs: number }): Promise<File> {
  const res = await fetch(`/api/uploads/source-folders/file?path=${encodeURIComponent(entry.path)}`, {
    credentials: "same-origin",
    headers: CLIENT_HEADER,
  });
  if (!res.ok) throw new Error(`Couldn't read ${entry.name}`);
  // shortcut: the bytes are held in memory until imported; fine for a folder's new photos, stream
  // through a server-side staged upload if huge batches of RAWs become common.
  return new File([await res.blob()], entry.name, { lastModified: entry.mtimeMs });
}
