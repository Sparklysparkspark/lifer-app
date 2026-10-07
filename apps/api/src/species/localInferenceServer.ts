// Inference-only entry the desktop app runs when connected to a server: the server's model code
// with no database or app config, so photos are matched locally and only vectors are uploaded.
//
// Env: LIFER_INFERENCE_TOKEN (every request needs "Authorization: Bearer <token>"),
// LIFER_MODEL_DIR (where model files live; the local API's own model folder, so a download is
// shared), LIFER_WATCH_PARENT_PID (exit when the desktop app is gone). Listens on a random
// 127.0.0.1 port and prints "LIFER_INFERENCE_PORT=<port>" once ready.
//
// POST /prepare  JSON matching-info from the server (GET /species/matching-info); checks the
//                preprocessing version and detector, then downloads any missing model by the
//                server's URL, verified against its sha256.
// GET  /status   { ready, downloading, downloadedBytes, totalBytes, error, pipelineVersion }
// POST /embed    raw image bytes; ?targets=clip,clip-crop,id-crop. Returns clientVectors JSON.
// GET  /health   { ok: true }
import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EMBED_PIPELINE_VERSION } from "@lifer/shared";
import { downloadResumable, sha256OfFile } from "@lifer/core/lib/resumableDownload.js";
import { CLIENT_FIELD_KIND, CLIENT_VECTOR_DIMS, encodeVector, type ClientVectors, type EncodedVector } from "@lifer/core/species/clientVectors.js";
import type { PhotoVectorKind } from "@lifer/core/species/embeddings.js";
import { DETECTOR_MODEL_PATH, analyzeImage, contentHash, inferenceRuntime, warmModels, type EmbedTarget } from "@lifer/core/species/inference.js";
import { placementFor } from "@lifer/core/species/acceleration.js";
import { selectAcceleration } from "./accelerationSelect.js";

const MAX_BODY_BYTES = 512 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const SAFE_VERSION = /^[A-Za-z0-9._-]{1,100}$/;
const KINDS: PhotoVectorKind[] = ["clip", "clip-crop", "id-crop"];

interface ModelRef {
  version: string;
  url: string;
  sha256: string | null;
  /** Its full-precision copy, for this computer's GPU. */
  gpu?: { url: string; sha256: string | null };
}

export interface MatchingInfo {
  pipelineVersion: number;
  runtime: string;
  activeModel: string | null;
  targets: PhotoVectorKind[];
  models: { clip: ModelRef; bioclip?: ModelRef; yolo: { version: string; sha256: string } };
  dims: number;
}

interface Prepared {
  info: MatchingInfo;
  /** Model file and version per kind this computer can compute. */
  models: Partial<Record<PhotoVectorKind, { path: string; version: string }>>;
}

const state = {
  prepared: null as Prepared | null,
  preparing: null as Promise<void> | null,
  preparingKey: "",
  downloading: false,
  downloadedBytes: 0,
  totalBytes: null as number | null,
  error: null as string | null,
};

let detectorSha: Promise<string> | null = null;
// A file already checked (by path, size and mtime) isn't hashed again.
const verified = new Set<string>();

async function ensureModel(dir: string, ref: ModelRef, progress: (done: number, total: number | null) => void): Promise<string> {
  if (!SAFE_VERSION.test(ref.version)) throw new Error("The server named a model this app can't store");
  if (!ref.sha256) throw new Error("The server's model has no checksum to verify a download against");
  if (!/^https:\/\//.test(ref.url)) throw new Error("The server's model address isn't https");
  const dest = path.join(dir, `${ref.version}.onnx`);
  const key = () => {
    const st = statSync(dest);
    return `${dest}:${st.size}:${st.mtimeMs}:${ref.sha256}`;
  };
  if (existsSync(dest) && verified.has(key())) return dest;
  // Hashes an existing file first and only downloads when it's missing or different.
  await downloadResumable(ref.url, dest, { expectedSha256: ref.sha256, onProgress: progress, label: `the ${ref.version} model` });
  verified.add(key());
  return dest;
}

export function validateInfo(info: unknown): MatchingInfo {
  const i = info as MatchingInfo;
  if (!i || typeof i !== "object" || !i.models?.clip || !i.models?.yolo || !Array.isArray(i.targets)) throw new Error("Unrecognized matching info");
  if (i.pipelineVersion !== EMBED_PIPELINE_VERSION) throw new Error("This server prepares photos for matching differently than this app version");
  // A different sharp/libvips or onnxruntime build can turn the same photo into slightly
  // different floats, so only an identical runtime computes for the server.
  if (i.runtime !== inferenceRuntime()) throw new Error("This server runs different image or model library versions than this app");
  if (i.dims !== CLIENT_VECTOR_DIMS) throw new Error("This server's vectors have a different size");
  return i;
}

async function prepare(info: MatchingInfo, dir: string): Promise<void> {
  detectorSha ??= sha256OfFile(DETECTOR_MODEL_PATH);
  // A different detector finds different crops, so its vectors wouldn't match the server's.
  if ((await detectorSha) !== info.models.yolo.sha256) throw new Error("This server uses a different animal detector than this app");
  mkdirSync(dir, { recursive: true });
  const wanted: Array<[ModelRef, PhotoVectorKind[]]> = [];
  const clipKinds = info.targets.filter((k) => k === "clip" || k === "clip-crop");
  if (clipKinds.length > 0) wanted.push([info.models.clip, clipKinds]);
  if (info.targets.includes("id-crop") && info.models.bioclip) wanted.push([info.models.bioclip, ["id-crop"]]);
  if (wanted.length === 0) throw new Error("The server isn't matching species right now");

  // Progress sums every file; each reports its own running total.
  const perFile = wanted.map(() => ({ done: 0, total: null as number | null }));
  const models: Prepared["models"] = {};
  state.downloading = true;
  try {
    for (const [index, [ref, kinds]] of wanted.entries()) {
      const file = await ensureModel(dir, ref, (done, total) => {
        perFile[index] = { done, total };
        state.downloadedBytes = perFile.reduce((a, f) => a + f.done, 0);
        state.totalBytes = perFile.every((f) => f.total != null) ? perFile.reduce((a, f) => a + (f.total ?? 0), 0) : null;
      });
      for (const kind of kinds) models[kind] = { path: file, version: ref.version };
    }
  } finally {
    state.downloading = false;
  }
  state.prepared = { info, models };
  // Moves matching onto this computer's GPU when it's faster and gives the same answers.
  const bio = models["id-crop"];
  const gpu = info.models.bioclip?.gpu;
  void selectAcceleration({
    cacheFile: path.join(dir, "acceleration.json"),
    gpuRuntimeRoot: path.join(dir, "gpu-runtime"),
    models: [
      { family: "detector", cpuPath: DETECTOR_MODEL_PATH, gpuPath: DETECTOR_MODEL_PATH, downloadGpuCopy: async () => {}, dims: [1, 3, 640, 640] },
      ...(bio
        ? [
            {
              family: "id" as const,
              cpuPath: bio.path,
              gpuPath: gpu ? path.join(dir, `${bio.version}-fp32.onnx`) : null,
              downloadGpuCopy: async (progress: (done: number, total: number | null) => void) => {
                if (gpu) await ensureModel(dir, { version: `${bio.version}-fp32`, url: gpu.url, sha256: gpu.sha256 }, progress);
              },
              dims: [1, 3, 224, 224],
            },
          ]
        : []),
    ],
  }).then(() => warmPrepared(models));
}

function warmPrepared(models: Prepared["models"]): void {
  const targets = (Object.keys(models) as PhotoVectorKind[]).map((k) => targetFor(k, models));
  warmModels({ models: targets, detector: true }).catch(() => {});
}

const familyOf = (kind: PhotoVectorKind) => (kind === "id" || kind === "id-crop" ? "id" : "clip");

function targetFor(k: PhotoVectorKind, models: Prepared["models"]): EmbedTarget {
  const file = models[k === "id" ? "id-crop" : k]!.path;
  return { ...placementFor(familyOf(k), file), missingMessage: "The model file is missing", crop: k.endsWith("-crop") };
}

function startPrepare(info: MatchingInfo, dir: string): void {
  const key = JSON.stringify(info);
  if (state.preparing && state.preparingKey === key) return;
  if (state.prepared && JSON.stringify(state.prepared.info) === key) return;
  state.prepared = null;
  state.error = null;
  state.preparingKey = key;
  const run = prepare(info, dir)
    .catch((err: Error) => {
      if (state.preparing === run) state.error = err.message;
    })
    .finally(() => {
      if (state.preparing === run) state.preparing = null;
    });
  state.preparing = run;
}

function status() {
  return {
    ready: state.prepared !== null,
    downloading: state.downloading,
    downloadedBytes: state.downloadedBytes,
    totalBytes: state.totalBytes,
    error: state.error,
    pipelineVersion: EMBED_PIPELINE_VERSION,
  };
}

/** Vectors for one photo in the clientVectors shape /uploads/inspect accepts. */
export async function embedForServer(bytes: Uint8Array, kinds: PhotoVectorKind[], prepared: Prepared): Promise<ClientVectors> {
  const usable = kinds.filter((k, i) => KINDS.includes(k) && kinds.indexOf(k) === i && prepared.models[k]);
  const target = (k: PhotoVectorKind): EmbedTarget => targetFor(k, prepared.models);
  const hash = contentHash(bytes);
  const result = usable.length > 0 ? await analyzeImage(bytes, { targets: usable.map(target), key: hash, subject: true, priority: "interactive" }) : null;
  const computed = new Map<PhotoVectorKind, Float32Array | { error: string }>(usable.map((k, i) => [k, result!.vectors[i]]));
  // The server backs an unsure crop with the whole photo (embeddings.ts suggestionVectors), so
  // the identification model's whole-photo vector goes too, sparing the server that model run.
  if (result?.subjectUnsure && prepared.models["id-crop"]) {
    const [whole] = (await analyzeImage(bytes, { targets: [{ ...target("id-crop"), crop: false }], key: hash, priority: "interactive" })).vectors;
    computed.set("id", whole);
  }
  const out: ClientVectors = { pipelineVersion: EMBED_PIPELINE_VERSION, contentHash: hash };
  if (result?.subjectUnsure != null) out.subjectUnsure = result.subjectUnsure;
  for (const [field, kind] of Object.entries(CLIENT_FIELD_KIND) as Array<[keyof typeof CLIENT_FIELD_KIND, PhotoVectorKind]>) {
    const v = computed.get(kind);
    const model = prepared.models[kind === "id" ? "id-crop" : kind];
    if (v instanceof Float32Array && model) out[field] = { modelVersion: model.version, b64f32: encodeVector(v) } satisfies EncodedVector;
  }
  return out;
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("Too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
  res.end(json);
}

export function createLocalInferenceServer(opts: { token: string; modelDir: string }): http.Server {
  const expected = Buffer.from(`Bearer ${opts.token}`);
  const authorized = (req: http.IncomingMessage) => {
    const got = Buffer.from(req.headers.authorization ?? "");
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  return http.createServer(async (req, res) => {
    try {
      if (!authorized(req)) return send(res, 401, { error: "Unauthorized" });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/status") return send(res, 200, status());
      if (req.method === "POST" && url.pathname === "/prepare") {
        const info = validateInfo(JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString("utf8")));
        startPrepare(info, opts.modelDir);
        return send(res, 202, status());
      }
      if (req.method === "POST" && url.pathname === "/embed") {
        const prepared = state.prepared;
        if (!prepared) return send(res, 409, { ...status(), error: state.error ?? "Not ready" });
        const kinds = (url.searchParams.get("targets") ?? prepared.info.targets.join(",")).split(",") as PhotoVectorKind[];
        const bytes = await readBody(req, MAX_BODY_BYTES);
        if (bytes.length === 0) return send(res, 400, { error: "No image" });
        return send(res, 200, await embedForServer(bytes, kinds, prepared));
      }
      return send(res, 404, { error: "Not found" });
    } catch (err) {
      const e = err as Error & { status?: number };
      if (!res.headersSent) send(res, e.status ?? (err instanceof SyntaxError ? 400 : 500), { error: e.message });
    }
  });
}

function watchParent(): void {
  const pid = Number(process.env.LIFER_WATCH_PARENT_PID);
  if (!Number.isInteger(pid) || pid <= 0) return;
  setInterval(() => {
    try {
      process.kill(pid, 0); // signal 0 only checks the pid exists
    } catch {
      process.exit(0);
    }
  }, 3000).unref();
}

// Started as a program (the desktop app), not when a test imports it.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const token = process.env.LIFER_INFERENCE_TOKEN;
  const modelDir = process.env.LIFER_MODEL_DIR;
  if (!token || token.length < 16 || !modelDir) {
    // A usage error for whoever launched it, before anything else runs.
    // eslint-disable-next-line no-console
    console.error("LIFER_INFERENCE_TOKEN (16+ chars) and LIFER_MODEL_DIR are required");
    process.exit(2);
  }
  watchParent();
  const server = createLocalInferenceServer({ token, modelDir });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    // The desktop app reads this exact line from stdout (local_inference.rs), so it stays plain.
    // eslint-disable-next-line no-console
    if (address && typeof address === "object") console.log(`LIFER_INFERENCE_PORT=${address.port}`);
  });
}
