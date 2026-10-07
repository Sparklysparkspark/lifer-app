// Where an upload's bytes come from: a multipart part, a photo kept by /uploads/inspect
// (stagedId), or a finished resumable upload (uploadId). Each becomes a file on disk with its sha256.
import { existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { claimStagedUpload, receiveToFile, stageUpload } from "../lib/stagedUploads.js";
import { claimTusUpload, removeTusUpload, TusClaimError } from "../lib/tusUploads.js";
import { uploadTempPath } from "./common.js";

export interface ReceivedFile {
  /** Where the bytes are now. Moving the file away (into the library) is expected. */
  path: string;
  filename: string | null;
  mimetype: string | null;
  sha256: string;
  size: number;
  origin: "multipart" | "staged" | "tus";
  uploadId: string | null;
  /** Ends the request's hold on the file. ok=false keeps a staged or resumable upload for a retry
   *  (moving it back if it had been filed); ok=true removes whatever is left. */
  finish: (ok: boolean) => Promise<void>;
}

/** Streams a multipart file part to a temp file, hashing it on the way. */
export async function receiveMultipartFile(part: {
  file: NodeJS.ReadableStream & { truncated?: boolean };
  filename?: string;
  mimetype?: string;
}): Promise<ReceivedFile> {
  const tmpPath = await uploadTempPath(part.filename ?? null);
  try {
    const { fingerprint, bytes } = await receiveToFile(part.file, tmpPath);
    return {
      path: tmpPath,
      filename: part.filename || null,
      mimetype: part.mimetype || null,
      sha256: fingerprint,
      size: bytes,
      origin: "multipart",
      uploadId: null,
      finish: () => rm(tmpPath, { force: true }),
    };
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
}

/** A photo /uploads/inspect kept, moved to a temp file and re-hashed. Null when it's gone. */
export async function claimStagedFile(
  userId: string,
  stagedId: string,
  filename: string | null,
  mimetype: string | null,
): Promise<ReceivedFile | null> {
  const tmpPath = await uploadTempPath(filename);
  if (!(await claimStagedUpload(userId, stagedId, tmpPath))) return null;
  const { size } = await stat(tmpPath);
  return {
    path: tmpPath,
    filename,
    mimetype,
    sha256: stagedId,
    size,
    origin: "staged",
    uploadId: null,
    finish: async (ok) => {
      // A failed import puts it back, so the retry still needn't send the file.
      if (!ok && existsSync(tmpPath) && (await stageUpload(userId, stagedId, tmpPath))) return;
      await rm(tmpPath, { force: true });
    },
  };
}

export class UploadSourceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/** A finished resumable upload, read where it is. Throws UploadSourceError (404/409/410) when it
 *  can't be used. */
export async function claimUploadById(userId: string, uploadId: string): Promise<ReceivedFile> {
  let claim: Awaited<ReturnType<typeof claimTusUpload>>;
  try {
    claim = await claimTusUpload(userId, uploadId);
  } catch (err) {
    if (err instanceof TusClaimError) throw new UploadSourceError(err.message, err.statusCode);
    throw err;
  }
  return {
    path: claim.path,
    filename: claim.filename,
    mimetype: claim.filetype,
    sha256: claim.sha256,
    size: claim.size,
    origin: "tus",
    uploadId,
    finish: async (ok) => {
      claim.release();
      if (ok) await removeTusUpload(uploadId);
    },
  };
}

export function isUploadSourceError(err: unknown): err is UploadSourceError {
  return err instanceof UploadSourceError;
}
