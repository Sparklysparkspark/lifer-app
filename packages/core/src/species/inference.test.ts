// The inference worker must give exactly what running the same code in-process gives, serve
// interactive work before queued background work, and report a missing model per target
// instead of failing the whole job. Uses the bundled detector and a tiny identity "encoder"
// (224x224 pixels straight through), so the vectors are the exact tensors CLIP would be fed.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// A minimal ONNX model: input [1,3,224,224] -> Flatten -> output [1,150528].
function identityModel(): Buffer {
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
  const shape = (dims: number[]) => Buffer.concat(dims.map((d) => field(1, field(1, d))));
  const valueInfo = (name: string, dims: number[]) => Buffer.concat([str(1, name), field(2, field(1, Buffer.concat([field(1, 1), field(2, shape(dims))])))]);
  const node = Buffer.concat([str(1, "input"), str(2, "output"), str(4, "Flatten")]);
  const graph = Buffer.concat([field(1, node), str(2, "g"), field(11, valueInfo("input", [1, 3, 224, 224])), field(12, valueInfo("output", [1, 150528]))]);
  return Buffer.concat([field(1, 8), field(7, graph), field(8, Buffer.concat([str(1, ""), field(2, 13)]))]);
}

let modelPath: string;
let photo: Buffer;

beforeAll(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lifer-inference-"));
  modelPath = path.join(dir, "identity.onnx");
  writeFileSync(modelPath, identityModel());
  // A dark blob on a light background, big enough to exercise shrink-on-load.
  const width = 2600;
  const height = 1700;
  const raw = Buffer.alloc(width * height * 3, 220);
  for (let y = 600; y < 1100; y++) for (let x = 1000; x < 1600; x++) raw.fill(40 + ((x * y) % 50), (y * width + x) * 3, (y * width + x) * 3 + 3);
  photo = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
});

async function freshFacade(inProcess: boolean) {
  vi.resetModules();
  if (inProcess) process.env.LIFER_INFERENCE_IN_PROCESS = "1";
  else delete process.env.LIFER_INFERENCE_IN_PROCESS;
  return import("./inference.js");
}

const target = (crop: boolean, p?: string) => ({ modelPath: p ?? modelPath, missingMessage: "no such model", crop });

describe("inference worker", () => {
  let worker: Awaited<ReturnType<typeof freshFacade>>;
  let inProcess: Awaited<ReturnType<typeof freshFacade>>;

  beforeAll(async () => {
    worker = await freshFacade(false);
    inProcess = await freshFacade(true);
  });

  afterAll(async () => {
    delete process.env.LIFER_INFERENCE_IN_PROCESS;
    await worker.stopInference();
    await inProcess.stopInference();
  });

  it("matches in-process results exactly, and the whole-photo tensor is the classic preprocessing", async () => {
    const opts = { targets: [target(false), target(true)], presence: true, cardCrop: true, priority: "interactive" as const };
    const [a, b] = await Promise.all([worker.analyzeImage(photo, { ...opts, key: "w" }), inProcess.analyzeImage(photo, { ...opts, key: "p" })]);
    expect(a.presence).toEqual(b.presence);
    expect(a.cardCrop).toEqual(b.cardCrop);
    for (let i = 0; i < 2; i++) {
      expect(a.vectors[i]).toBeInstanceOf(Float32Array);
      expect(Array.from(a.vectors[i] as Float32Array)).toEqual(Array.from(b.vectors[i] as Float32Array));
    }
    expect(worker.inferenceMode()).toBe("worker");
    expect(inProcess.inferenceMode()).toBe("in-process");
    const { preprocessImage, l2Normalize } = await import("./inferenceWorker.js");
    expect(Array.from(a.vectors[0] as Float32Array)).toEqual(Array.from(l2Normalize(await preprocessImage(photo))));
  }, 60_000);

  it("reads a file path itself", async () => {
    const file = path.join(path.dirname(modelPath), "photo.jpg");
    writeFileSync(file, photo);
    const fromPath = await worker.analyzeImage({ path: file }, { targets: [target(false)], priority: "background" });
    const fromBytes = await worker.analyzeImage(photo, { targets: [target(false)], priority: "background" });
    expect(Array.from(fromPath.vectors[0] as Float32Array)).toEqual(Array.from(fromBytes.vectors[0] as Float32Array));
  }, 60_000);

  it("reports a missing model for that target only", async () => {
    const res = await worker.analyzeImage(photo, { targets: [target(false, "/nope/missing.onnx"), target(false)], priority: "interactive" });
    expect(res.vectors[0]).toEqual({ error: "no such model" });
    expect(res.vectors[1]).toBeInstanceOf(Float32Array);
  }, 60_000);

  it("runs interactive work ahead of queued background work", async () => {
    const order: string[] = [];
    const job = (name: string, priority: "interactive" | "background") =>
      worker.analyzeImage(photo, { targets: [target(false)], priority }).then(() => order.push(name));
    await Promise.all([job("bg1", "background"), job("bg2", "background"), job("bg3", "background"), job("ui", "interactive")]);
    // bg1 was already running when the others arrived; the interactive one jumps the rest.
    expect(order.indexOf("ui")).toBeLessThan(order.indexOf("bg2"));
    expect(order.indexOf("ui")).toBeLessThan(order.indexOf("bg3"));
  }, 60_000);
});
