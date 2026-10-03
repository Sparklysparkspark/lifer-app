// sha256 of each model file Lifer downloads or bundles, so a truncated or tampered download is
// caught before it's ever loaded. Each hash belongs to one exact URL: an install pointed at a
// different file (EMBEDDING_MODEL_URL / ID_MODEL_URL overrides) has nothing to check against.
// Also served to desktop clients that run inference locally, which download the same files.
import { rmSync, statSync } from "node:fs";
import { sha256OfFile } from "../lib/resumableDownload.js";

export interface ModelChecksum {
  url: string;
  sha256: string | null;
}

// The digest GitHub records for this release asset.
export const CLIP_MODEL_CHECKSUM: ModelChecksum = {
  url: "https://github.com/Sparklysparkspark/lifer-app/releases/download/models/clip-vit-l14-v2.onnx",
  sha256: "32482801ab07f178a100b5ebbdff8f38577725a28631b09b1596e96f8019ebbb",
};

// Hugging Face's LFS object id (X-Linked-ETag) for this pinned revision, which is the file's sha256.
export const CLIP_MODEL_GPU_CHECKSUM: ModelChecksum = {
  url: "https://huggingface.co/Xenova/clip-vit-large-patch14/resolve/c307790166907339eed5a9a53a249af534102536/onnx/vision_model.onnx",
  sha256: "ff49f8aa57c7abfd26e382eb083e4dbf988505223a9bd3767dbfd4e729206709",
};

// The digest GitHub records for this release asset.
export const ID_MODEL_CHECKSUM: ModelChecksum = {
  url: "https://github.com/Sparklysparkspark/lifer-app/releases/download/models/bioclip-2-v1.onnx",
  sha256: "296c69a17140569c8b0763337793a81c4f01458a64198fe9b205ea8ab464ebaa",
};

/** Bundled in apps/api/src/species/models, never downloaded; listed for clients that fetch it. */
export const YOLO_MODEL_VERSION = "yolov8n";
export const YOLO_MODEL_SHA256 = "b8de9b74614776b2a004dfef8d5741b2350f3dd82eed336ae8d3999c42630707";

// Full-precision copy for GPUs (packages/data-pipeline/python/export_id_model.py).
export const ID_MODEL_GPU_CHECKSUM: ModelChecksum = {
  url: "https://github.com/Sparklysparkspark/lifer-app/releases/download/models/bioclip-2-v1-fp32.onnx",
  sha256: "02175d4a4fb023077502144c171fef07c8c1c963a265abc0617a24adcca979e4",
};

const BY_URL = new Map([CLIP_MODEL_CHECKSUM, CLIP_MODEL_GPU_CHECKSUM, ID_MODEL_CHECKSUM, ID_MODEL_GPU_CHECKSUM].map((c) => [c.url, c.sha256]));

/** The expected sha256 for a download URL, or null when there's nothing to check it against. */
export function expectedModelSha256(url: string): string | null {
  return BY_URL.get(url) ?? null;
}

// A file already checked this run (by path, size and mtime) isn't hashed again.
const verified = new Set<string>();

/** Checks an already-downloaded model file. A mismatch deletes it (so it downloads again) and
 * returns false; true when it matches or there's no checksum to compare with. */
export async function verifyModelFile(filePath: string, url: string): Promise<boolean> {
  const expected = expectedModelSha256(url);
  if (!expected) return true;
  const st = statSync(filePath);
  const key = `${filePath}:${st.size}:${st.mtimeMs}`;
  if (verified.has(key)) return true;
  if ((await sha256OfFile(filePath)) !== expected) {
    rmSync(filePath, { force: true });
    return false;
  }
  verified.add(key);
  return true;
}
