// One locally-run ONNX image encoder: download, lazy load, embed, idle unload, release. Shared by
// the CLIP model (embeddings.ts: suggestions fallback, Gallery search, near-duplicates) and the
// species identification model (idModel.ts: suggestions). Both are CLIP-family ViT-L/14 encoders
// with the same 224px input and normalization, so one preprocessing path serves both.
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import * as ort from "onnxruntime-node";
import { downloadResumable } from "../lib/resumableDownload.js";

const INPUT_SIZE = 224;
// CLIP's own published preprocessing constants. Every CLIP-family vision encoder (including both
// exports this app runs) was trained expecting pixels normalized against exactly these, not a
// generic ImageNet mean/std.
const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073];
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711];

// Loading a session costs a real, user-visible amount of time (reading ~300MB off disk and
// initializing the ONNX runtime), which is why it's kept warm across requests rather than
// reloaded every call. But "warm forever, even after hours of total inactivity" wastes real
// memory on a self-hosted server that isn't always actively matching photos (a Docker/NAS
// deployment can sit idle for days between imports). Unloading after a period of no use gets
// both: fast while actually in use, small the rest of the time.
const IDLE_UNLOAD_MS = 15 * 60 * 1000;
const INFERENCE_TIMEOUT_MS = 20_000;
const MAX_STUCK_INFERENCES = 2;

/** Resize/crop to 224x224 and normalize into NCHW float32. Mirrors how uploads/image.ts already
 *  uses sharp for derivative generation, just producing a tensor instead of a webp file. */
export async function preprocessImage(buffer: Buffer): Promise<Float32Array> {
  const { data } = await sharp(buffer)
    .rotate()
    .resize(INPUT_SIZE, INPUT_SIZE, { fit: "cover" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const floats = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const pixelCount = INPUT_SIZE * INPUT_SIZE;
  for (let i = 0; i < pixelCount; i++) {
    for (let c = 0; c < 3; c++) {
      const value = data[i * 3 + c] / 255;
      // HWC -> CHW: channel c's plane starts at c * pixelCount
      floats[c * pixelCount + i] = (value - CLIP_MEAN[c]) / CLIP_STD[c];
    }
  }
  return floats;
}

export function l2Normalize(vec: Float32Array): number[] {
  let sumSquares = 0;
  for (const v of vec) sumSquares += v * v;
  const norm = Math.sqrt(sumSquares) || 1;
  return Array.from(vec, (v) => v / norm);
}

export interface OnnxImageModel {
  /** Cheap and sync, safe to call from a status endpoint on every poll. */
  isDownloaded(): boolean;
  /** Streams to disk with an atomic rename on completion, resuming a partial file. */
  download(onProgress?: (downloadedBytes: number, totalBytes: number | null) => void, signal?: AbortSignal): Promise<void>;
  /** Drops the loaded session (after its file was deleted), once nothing is mid-inference. */
  release(): void;
  /** L2-normalized embedding for one image, guarded by a hard timeout. */
  embed(buffer: Buffer): Promise<number[]>;
  /** Several timed-out native calls are still running: refuse new work until a restart. */
  isStuck(): boolean;
}

export function createOnnxImageModel(opts: {
  path: string;
  url: string;
  /** For download errors, e.g. "the species-matching model". */
  label: string;
  /** Thrown by embed() when the file isn't there. */
  missingMessage: string;
}): OnnxImageModel {
  let sessionPromise: Promise<ort.InferenceSession> | null = null;
  let activeInferences = 0;
  let idleUnloadTimer: ReturnType<typeof setTimeout> | null = null;
  let stuckInferences = 0;
  const sessionsAwaitingRelease: Promise<ort.InferenceSession>[] = [];

  function drainReleases(): void {
    for (const p of sessionsAwaitingRelease.splice(0)) p.then((session) => session.release()).catch(() => {});
  }

  function cancelIdleUnload(): void {
    if (idleUnloadTimer) {
      clearTimeout(idleUnloadTimer);
      idleUnloadTimer = null;
    }
  }

  // Only ever armed once nothing is mid-session.run(), so it can't unload out from under a call.
  function armIdleUnload(): void {
    cancelIdleUnload();
    idleUnloadTimer = setTimeout(() => {
      idleUnloadTimer = null;
      const promise = sessionPromise;
      sessionPromise = null;
      promise?.then((session) => session.release()).catch(() => {});
    }, IDLE_UNLOAD_MS);
    idleUnloadTimer.unref?.();
  }

  // Deliberately does NOT auto-download: the model is an opt-in download (Settings > Offline
  // Data, or the desktop app's first-run prompt), never a surprise multi-hundred-MB fetch
  // triggered by an ordinary upload or search. Every caller treats the thrown error as "feature
  // unavailable", not a hard failure.
  async function getSession(): Promise<ort.InferenceSession> {
    cancelIdleUnload();
    if (!sessionPromise) {
      sessionPromise = (async () => {
        if (!existsSync(opts.path)) throw new Error(opts.missingMessage);
        return ort.InferenceSession.create(opts.path);
      })().catch((err) => {
        sessionPromise = null; // let the next caller retry instead of caching a permanent failure
        throw err;
      });
    }
    return sessionPromise;
  }

  return {
    isDownloaded: () => existsSync(opts.path),

    async download(onProgress, signal) {
      mkdirSync(path.dirname(opts.path), { recursive: true });
      await downloadResumable(opts.url, opts.path, { signal, onProgress, label: opts.label });
    },

    release() {
      cancelIdleUnload();
      const promise = sessionPromise;
      sessionPromise = null; // a session pointing at a now-deleted file must not be reused
      if (!promise) return;
      sessionsAwaitingRelease.push(promise);
      if (activeInferences === 0) drainReleases();
    },

    isStuck: () => stuckInferences >= MAX_STUCK_INFERENCES,

    async embed(buffer) {
      // A timed-out native call keeps running in the background. Refuse new work while several
      // are stuck, instead of piling more hung calls onto the same native session.
      if (stuckInferences >= MAX_STUCK_INFERENCES) {
        throw new Error("Species matching is stuck on an earlier photo. Restart Lifer to recover.");
      }
      // Counts this call as active for the session's whole real lifetime, including the rare case
      // where `work` loses the race below and keeps running after a timeout, so an idle unload
      // can never fire while a session.run() is still in flight underneath it.
      activeInferences++;
      const work = (async () => {
        const session = await getSession();
        const tensor = new ort.Tensor("float32", await preprocessImage(buffer), [1, 3, INPUT_SIZE, INPUT_SIZE]);
        const results = await session.run({ [session.inputNames[0]]: tensor });
        return l2Normalize(results[session.outputNames[0]].data as Float32Array);
      })();
      let timedOut = false;
      let settled = false;
      // .finally() returns its OWN new promise, separate from `work`: a rejection (e.g. the model
      // not being downloaded) left that derived promise unhandled and crashed the whole API
      // process on every model-not-downloaded upload. Promise.race below already subscribes to
      // `work` itself; this .catch() is the only handler the chain was missing.
      work
        .finally(() => {
          settled = true;
          activeInferences--;
          if (timedOut) stuckInferences--;
          if (activeInferences === 0) {
            drainReleases();
            armIdleUnload();
          }
        })
        .catch(() => {});

      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<number[]>((_, reject) => {
        timer = setTimeout(() => {
          if (!settled) {
            timedOut = true;
            stuckInferences++;
          }
          reject(new Error("embedding inference timed out"));
        }, INFERENCE_TIMEOUT_MS);
      });
      try {
        return await Promise.race([work, timeout]);
      } finally {
        // Without this, every fast call leaves its timer running for the rest of its 20s, then
        // rejects a promise nothing is listening to anymore: an unhandled rejection per call.
        clearTimeout(timer!);
      }
    },
  };
}
