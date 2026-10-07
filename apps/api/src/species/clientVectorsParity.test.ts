// Accuracy guard for desktop local inference: vectors computed by the inference-only sidecar
// (localInferenceServer.ts), sent as clientVectors and seeded into the server's memo, must give
// exactly the suggestions the server gets computing them itself. The "encoder" is a tiny ONNX
// graph (224x224 image average-pooled to 3x16x16 = 768 values), so crops change the vector.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

function pooledModel(): Buffer {
  const varint = (n: number) => {
    const out: number[] = [];
    for (;;) {
      const b = n & 0x7f;
      n = Math.floor(n / 128);
      if (n) out.push(b | 0x80);
      else {
        out.push(b);
        return Buffer.from(out);
      }
    }
  };
  const field = (num: number, payload: Buffer | number) =>
    typeof payload === "number"
      ? Buffer.concat([varint(num << 3), varint(payload)])
      : Buffer.concat([varint((num << 3) | 2), varint(payload.length), payload]);
  const str = (num: number, s: string) => field(num, Buffer.from(s));
  const ints = (name: string, values: number[]) => Buffer.concat([str(1, name), field(20, 7), ...values.map((v) => field(8, v))]);
  const shape = (dims: number[]) => Buffer.concat(dims.map((d) => field(1, field(1, d))));
  const valueInfo = (name: string, dims: number[]) => Buffer.concat([str(1, name), field(2, field(1, Buffer.concat([field(1, 1), field(2, shape(dims))])))]);
  const pool = Buffer.concat([str(1, "input"), str(2, "pooled"), str(4, "AveragePool"), field(5, ints("kernel_shape", [14, 14])), field(5, ints("strides", [14, 14]))]);
  const flatten = Buffer.concat([str(1, "pooled"), str(2, "output"), str(4, "Flatten")]);
  const graph = Buffer.concat([field(1, pool), field(1, flatten), str(2, "g"), field(11, valueInfo("input", [1, 3, 224, 224])), field(12, valueInfo("output", [1, 768]))]);
  return Buffer.concat([field(1, 8), field(7, graph), field(8, Buffer.concat([str(1, ""), field(2, 13)]))]);
}

let appData: string;
let photo: Buffer;
let model: Buffer;

beforeAll(async () => {
  appData = mkdtempSync(path.join(os.tmpdir(), "lifer-client-vectors-"));
  process.env.APP_DATA_DIR = appData;
  process.env.LIFER_INFERENCE_IN_PROCESS = "1";
  vi.resetModules();
  const { EMBEDDING_MODEL_VERSION } = await import("@lifer/core/config.js");
  mkdirSync(path.join(appData, "models"), { recursive: true });
  model = pooledModel();
  writeFileSync(path.join(appData, "models", `${EMBEDDING_MODEL_VERSION}.onnx`), model);
  // A real screenshot of the app with animal photos in it: the detector finds one, and at 4206 px
  // wide it exercises detection on a large photo and the crop from the full-size original.
  photo = readFileSync(fileURLToPath(new URL("./__fixtures__/gallery-screenshot-4206px.png", import.meta.url)));
});

afterAll(async () => {
  delete process.env.LIFER_INFERENCE_IN_PROCESS;
  delete process.env.APP_DATA_DIR;
  const { stopInference } = await import("@lifer/core/species/inference.js");
  await stopInference();
});

describe("client-computed vectors", () => {
  it("seed the memo with exactly what the server computes, so suggestions are identical", async () => {
    const config = await import("@lifer/core/config.js");
    const embeddings = await import("@lifer/core/species/embeddings.js");
    const { contentHash, inferenceRuntime } = await import("@lifer/core/species/inference.js");
    const { createLocalInferenceServer } = await import("./localInferenceServer.js");
    const { EMBED_PIPELINE_VERSION } = await import("@lifer/shared");
    const { YOLO_MODEL_SHA256 } = await import("@lifer/core/species/modelChecksums.js");

    // The desktop side: prepare with the server's matching info (the model is already in the
    // folder with a matching sha256, so nothing downloads), then embed the photo.
    const token = "t".repeat(32);
    const server = createLocalInferenceServer({ token, modelDir: path.join(appData, "models") });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const auth = { authorization: `Bearer ${token}` };
    try {
      expect((await fetch(`${base}/health`)).status).toBe(401);
      const info = {
        pipelineVersion: EMBED_PIPELINE_VERSION,
        runtime: inferenceRuntime(),
        activeModel: "general",
        targets: ["clip", "clip-crop"],
        models: {
          clip: { version: config.EMBEDDING_MODEL_VERSION, url: "https://example.invalid/model.onnx", sha256: createHash("sha256").update(model).digest("hex") },
          yolo: { version: "yolov8n", sha256: YOLO_MODEL_SHA256 },
        },
        dims: 768,
      };
      expect((await fetch(`${base}/prepare`, { method: "POST", headers: auth, body: JSON.stringify(info) })).status).toBe(202);
      let status: { ready: boolean; error: string | null } = { ready: false, error: null };
      for (let i = 0; i < 100 && !status.ready && !status.error; i++) {
        await new Promise((r) => setTimeout(r, 50));
        status = await (await fetch(`${base}/status`, { headers: auth })).json();
      }
      expect(status).toMatchObject({ ready: true, error: null });
      const res = await fetch(`${base}/embed?targets=clip,clip-crop`, { method: "POST", headers: auth, body: new Uint8Array(photo) });
      expect(res.status).toBe(200);
      const clientVectors = await res.text();
      expect(JSON.parse(clientVectors).contentHash).toBe(contentHash(photo));

      // The server side: seed from the field, then read back through the normal path.
      const hash = contentHash(photo);
      expect(embeddings.rememberClientVectors(clientVectors, hash)).toBeNull();
      expect(embeddings.hasRememberedVector("clip-crop", hash)).toBe(true);
      const seeded = embeddings.photoVectors(photo, { kinds: ["clip", "clip-crop"], key: hash, priority: "interactive" });
      // And computed from scratch on the server (a key nothing was remembered under).
      const computed = embeddings.photoVectors(photo, { kinds: ["clip", "clip-crop"], key: "fresh", priority: "interactive" });
      for (const kind of ["clip", "clip-crop"] as const) {
        expect(Array.from(await seeded.vectors[kind])).toEqual(Array.from(await computed.vectors[kind]));
      }
      // The crop actually differs from the whole frame, so the test would catch a wrong target.
      expect(Array.from(await computed.vectors["clip-crop"])).not.toEqual(Array.from(await computed.vectors.clip));

      // Same ranking either way.
      const catalog = Array.from({ length: 12 }, (_, i) => ({
        species_id: `s${i}`,
        scientific_name: `S ${i}`,
        common_name: null,
        is_vagrant: null,
        local_tier: null,
        seasonality: null,
        ref_embedding: Array.from({ length: 768 }, (_, j) => Math.cos(i * 7 + j * 0.37)),
        gallery_embeddings: null,
        text_embedding: null,
      }));
      const pool = { query: async (sql: string) => ({ rows: sql.includes("FROM region_species") ? catalog : [] }) } as never;
      const rank = async (v: Float32Array) => {
        embeddings.invalidateSuggestionCache();
        return embeddings.rankSpeciesByEmbedding(pool, "u1", v, "r1", 5, null, embeddings.CLIP_SPACE);
      };
      const fromClient = await rank(await seeded.vectors["clip-crop"]);
      expect(fromClient.length).toBeGreaterThan(0);
      expect(fromClient).toEqual(await rank(await computed.vectors["clip-crop"]));

      // A tampered field is ignored rather than seeded.
      const tampered = JSON.parse(clientVectors);
      tampered.pipelineVersion += 1;
      expect(embeddings.rememberClientVectors(JSON.stringify(tampered), "0".repeat(64))).toBe("pipeline version differs");
      expect(embeddings.hasRememberedVector("clip", "0".repeat(64))).toBe(false);
    } finally {
      server.close();
    }
  }, 120_000);
});
