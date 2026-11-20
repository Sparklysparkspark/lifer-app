// Sends one of this install's captures to another Lifer server as an ordinary import. Used by
// the desktop app's push (sync/push.ts) for photos the linked server doesn't have yet.
import path from "node:path";
import { PHOTO_FORMATS, photoFormatFor } from "@lifer/core/uploads/formats.js";
import { tusUploadFile, type TusClientOptions } from "../lib/tusClient.js";
import type { Agent } from "undici";
import { viaDispatcher } from "../lib/outboundGuard.js";

/** Sends one capture to a remote Lifer server: each file as a resumable upload in chunks (so a
 *  proxy's body limit never matters), then an import naming them. True when the server took it. */
export async function sendCaptureToServer(
  baseUrl: string,
  authHeaders: Record<string, string>,
  capture: { speciesId: string; photoPath: string; rawPath: string | null },
  opts: {
    signal?: AbortSignal;
    chunkState?: { size: number };
    tus?: Partial<TusClientOptions>;
    dispatcher?: Agent;
    /** Vectors computed on this computer (species/clientVectors.ts), handed to /uploads/inspect
     *  before the import so the server skips its models. */
    clientVectors?: string | null;
    /** The import's answer (its captureId, duplicate flag). */
    onImported?: (body: unknown) => void;
  } = {},
): Promise<boolean> {
  const tusOpts: TusClientOptions = {
    endpoint: `${baseUrl}/api/uploads/tus`,
    headers: authHeaders,
    signal: opts.signal,
    chunkState: opts.chunkState,
    dispatcher: opts.dispatcher,
    ...opts.tus,
  };
  const send = (filePath: string) => {
    const format = photoFormatFor(filePath);
    return tusUploadFile(
      filePath,
      { filename: path.basename(filePath), filetype: format ? PHOTO_FORMATS[format].mimeTypes[0] : null },
      tusOpts,
    );
  };
  const form = new FormData();
  form.set("speciesId", capture.speciesId);
  form.set("mode", "store");
  // A capture the server already has (a run cut off before it was marked migrated) comes back
  // as that photo instead of a second copy.
  form.set("skipDuplicates", "1");
  const uploadId = await send(capture.photoPath);
  form.set("uploadId", uploadId);
  if (opts.clientVectors) {
    // Best effort: an inspect that fails only means the server matches the photo itself.
    const inspect = new FormData();
    inspect.set("uploadId", uploadId);
    inspect.set("clientVectors", opts.clientVectors);
    await fetch(`${baseUrl}/api/uploads/inspect`, {
      method: "POST",
      headers: authHeaders,
      body: inspect,
      redirect: "error",
      ...viaDispatcher(opts.dispatcher),
      signal: AbortSignal.timeout(5 * 60_000),
    })
      .then((r) => r.arrayBuffer())
      .catch(() => {});
  }
  if (capture.rawPath) form.set("rawUploadId", await send(capture.rawPath));
  // Generous: importing a large file (hashing it, writing derivatives) can take a while.
  const res = await fetch(`${baseUrl}/api/uploads`, {
    method: "POST",
    headers: authHeaders,
    body: form,
    // The key goes only to the server itself, never on to wherever a redirect points.
    redirect: "error",
    ...viaDispatcher(opts.dispatcher),
    signal: opts.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(15 * 60_000)])
      : AbortSignal.timeout(15 * 60_000),
  });
  const body = await res.json().catch(() => null);
  if (res.ok) opts.onImported?.(body);
  return res.ok;
}
