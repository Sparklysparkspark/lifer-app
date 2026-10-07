// Resumable uploads (tus 1.0 via @tus/server's file store). Files arrive in proxy-friendly
// chunks, resume after a dropped connection, and are imported by upload id. uploads/tus.ts
// mounts the HTTP side. Upload ids start with the owner's user id so ownership is checked early.
import { createHash, randomBytes, type Hash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline as pipelineCallback, Transform, type Readable } from "node:stream";
import type http from "node:http";
import { FileStore } from "@tus/file-store";
import { Server, type Upload } from "@tus/server";
import { MAX_UPLOAD_BYTES } from "@lifer/core/config.js";
import { hashFile, STAGE_MAX_AGE_MS } from "./stagedUploads.js";
import { tusUploadDir } from "./uploadWorkDir.js";

/** Kept two hours after the last byte arrived (not after creation, so a slow upload that keeps
 *  making progress never expires). */
const TUS_UPLOAD_MAX_AGE_MS = STAGE_MAX_AGE_MS;

const UPLOAD_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([0-9a-f]{32})$/i;
// The authenticated user of each request the tus server is handling, set by uploads/tus.ts. Kept
// off the request headers so a client can never supply it.
const requestUsers = new WeakMap<http.IncomingMessage, string>();

export function setTusRequestUser(req: http.IncomingMessage, userId: string): void {
  requestUsers.set(req, userId);
}

function requestUser(req: object): string | null {
  const node = (req as { runtime?: { node?: { req?: http.IncomingMessage } } }).runtime?.node?.req;
  return (node && requestUsers.get(node)) ?? null;
}

const filesDir = () => path.join(tusUploadDir(), "files");
const recordsDir = () => path.join(tusUploadDir(), "finished");

function isTusUploadId(id: string): boolean {
  return UPLOAD_ID.test(id);
}

/** True when `uploadId` is a well-formed id belonging to `userId`. */
export function ownsTusUpload(userId: string, uploadId: string): boolean {
  const m = UPLOAD_ID.exec(uploadId);
  return Boolean(m && m[1].toLowerCase() === userId.toLowerCase());
}

// sha256 of an upload so far, fed as chunks are written, so finishing rarely needs a second
// full read. Lost on restart; the finish then hashes the file.
const runningHashes = new Map<string, { hash: Hash; bytes: number }>();

class LiferFileStore extends FileStore {
  override async write(readable: http.IncomingMessage | Readable, id: string, offset: number): Promise<number> {
    let state = runningHashes.get(id);
    if (!state && offset === 0) state = { hash: createHash("sha256"), bytes: 0 };
    if (!state || state.bytes !== offset) {
      runningHashes.delete(id);
      return super.write(readable, id, offset);
    }
    const running = state;
    runningHashes.set(id, running);
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        running.hash.update(chunk);
        running.bytes += chunk.length;
        done(null, chunk);
      },
    });
    try {
      const newOffset = await super.write(
        pipelineCallback(readable, tap, () => {}),
        id,
        offset,
      );
      if (newOffset !== running.bytes) runningHashes.delete(id);
      return newOffset;
    } catch (err) {
      runningHashes.delete(id);
      throw err;
    }
  }

  // Expiry counts from the last write, not from creation.
  override async getUpload(id: string): Promise<Upload> {
    const upload = await super.getUpload(id);
    try {
      const { mtimeMs } = await stat(path.join(this.directory, id));
      const created = upload.creation_date ? Date.parse(upload.creation_date) : 0;
      if (mtimeMs > created) upload.creation_date = new Date(mtimeMs).toISOString();
    } catch {
      // the file store already reported a missing file
    }
    return upload;
  }

  override async remove(id: string): Promise<void> {
    runningHashes.delete(id);
    await super.remove(id);
    await rm(path.join(recordsDir(), `${id}.json`), { force: true });
  }
}

export interface TusUploadRecord {
  id: string;
  userId: string;
  filename: string | null;
  filetype: string | null;
  size: number;
  sha256: string;
  finishedAt: string;
}

function metadataValue(upload: Upload, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = upload.metadata?.[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 1024);
  }
  return null;
}

let server: Server | null = null;

/** The tus server, created on first use (the upload folder is only known once config loads).
 *  `routePath` is where uploads/tus.ts mounted it, e.g. "/api/uploads/tus". */
export function tusServer(routePath: string): Server {
  if (server) return server;
  const store = new LiferFileStore({ directory: filesDir(), expirationPeriodInMilliseconds: TUS_UPLOAD_MAX_AGE_MS });
  server = new Server({
    path: routePath,
    datastore: store,
    // Same origin only: no CORS headers for any origin.
    allowedOrigins: () => false,
    relativeLocation: true,
    respectForwardedHeaders: false,
    maxSize: MAX_UPLOAD_BYTES > 0 ? MAX_UPLOAD_BYTES : undefined,
    namingFunction: (req) => {
      const userId = requestUser(req);
      if (!userId) throw { status_code: 401, body: "Not authenticated\n" };
      return `${userId}_${randomBytes(16).toString("hex")}`;
    },
    onUploadFinish: async (req, upload) => {
      await recordFinishedUpload(upload, requestUser(req));
      return {};
    },
  });
  return server;
}

async function recordFinishedUpload(upload: Upload, userId: string | null): Promise<void> {
  const owner = UPLOAD_ID.exec(upload.id)?.[1];
  if (!owner || !userId || owner.toLowerCase() !== userId.toLowerCase())
    throw { status_code: 403, body: "Not your upload\n" };
  const filePath = path.join(filesDir(), upload.id);
  const running = runningHashes.get(upload.id);
  runningHashes.delete(upload.id);
  const size = (await stat(filePath)).size;
  const sha256 = running && running.bytes === size ? running.hash.digest("hex") : await hashFile(filePath);
  const record: TusUploadRecord = {
    id: upload.id,
    userId: owner,
    filename: metadataValue(upload, "filename", "name"),
    filetype: metadataValue(upload, "filetype", "type"),
    size,
    sha256,
    finishedAt: new Date().toISOString(),
  };
  await mkdir(recordsDir(), { recursive: true });
  await writeFile(path.join(recordsDir(), `${upload.id}.json`), JSON.stringify(record));
}

export interface FinishedTusUpload extends TusUploadRecord {
  /** Where the bytes are. Read in place; imports move the file out with moveIntoLibrary. */
  path: string;
}

/** A finished upload of `userId`'s, or null when it doesn't exist, isn't finished, belongs to
 *  someone else or expired. */
export async function finishedTusUpload(userId: string, uploadId: string): Promise<FinishedTusUpload | null> {
  if (!ownsTusUpload(userId, uploadId)) return null;
  let record: TusUploadRecord;
  try {
    record = JSON.parse(await readFile(path.join(recordsDir(), `${uploadId}.json`), "utf8")) as TusUploadRecord;
  } catch {
    return null;
  }
  if (record.id !== uploadId || record.userId.toLowerCase() !== userId.toLowerCase()) return null;
  const filePath = path.join(filesDir(), uploadId);
  try {
    if ((await stat(filePath)).size !== record.size) return null;
  } catch {
    return null;
  }
  return { ...record, path: filePath };
}

// Upload ids an import is using right now, so the same upload can't be imported twice at once.
const claimed = new Set<string>();

export class TusClaimError extends Error {
  constructor(
    message: string,
    readonly statusCode: 409 | 410,
  ) {
    super(message);
  }
}

/** Takes a finished upload for one import: checks the owner, that the bytes still hash to the
 *  recorded sha256 (streamed), and that no other import holds it. Call release() when done;
 *  after a successful import, removeTusUpload() too. */
export async function claimTusUpload(
  userId: string,
  uploadId: string,
): Promise<FinishedTusUpload & { release: () => void }> {
  if (claimed.has(uploadId)) throw new TusClaimError("That upload is already being imported", 409);
  claimed.add(uploadId);
  const release = () => void claimed.delete(uploadId);
  try {
    const upload = await finishedTusUpload(userId, uploadId);
    if (!upload)
      throw new TusClaimError(
        "That upload isn't here any more (finished, expired or never completed). Upload the file again.",
        410,
      );
    if ((await hashFile(upload.path)) !== upload.sha256) {
      await removeTusUpload(uploadId);
      throw new TusClaimError("That upload changed after it finished. Upload the file again.", 410);
    }
    return { ...upload, release };
  } catch (err) {
    release();
    throw err;
  }
}

/** Drops an upload's records after its bytes were moved into the library. */
async function forgetTusUpload(uploadId: string): Promise<void> {
  if (!isTusUploadId(uploadId)) return;
  runningHashes.delete(uploadId);
  await Promise.all([
    rm(path.join(filesDir(), `${uploadId}.json`), { force: true }),
    rm(path.join(recordsDir(), `${uploadId}.json`), { force: true }),
  ]);
}

/** Deletes an upload, bytes and all. */
export async function removeTusUpload(uploadId: string): Promise<void> {
  if (!isTusUploadId(uploadId)) return;
  await rm(path.join(filesDir(), uploadId), { force: true });
  await forgetTusUpload(uploadId);
}

/** Removes uploads idle for TUS_UPLOAD_MAX_AGE_MS (abandoned, or finished and never imported).
 *  Returns how many went. */
export async function sweepTusUploads(now = Date.now()): Promise<number> {
  const dir = filesDir();
  if (!existsSync(dir)) return 0;
  const ids = new Set<string>();
  for (const name of await readdir(dir)) ids.add(name.endsWith(".json") ? name.slice(0, -5) : name);
  for (const name of existsSync(recordsDir()) ? await readdir(recordsDir()) : [])
    if (name.endsWith(".json")) ids.add(name.slice(0, -5));
  let removed = 0;
  for (const id of ids) {
    if (!isTusUploadId(id) || claimed.has(id)) continue;
    const times = await Promise.all(
      [path.join(dir, id), path.join(dir, `${id}.json`), path.join(recordsDir(), `${id}.json`)].map((p) =>
        stat(p).then(
          (s) => s.mtimeMs,
          () => 0,
        ),
      ),
    );
    if (now - Math.max(...times) > TUS_UPLOAD_MAX_AGE_MS) {
      await removeTusUpload(id);
      removed++;
    }
  }
  return removed;
}
