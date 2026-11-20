// Development only (see devDriver.ts): makes smart search ready on the demo library without the hub or
// the CLIP model, so the real query reading and ranking run in the simulator for screenshots. The
// "model" gives a description a direction from its words; photos get vectors, frames and backgrounds to match.
import type { App } from "../app/AppContext";
import { setMeta } from "../store/meta";
import { toHalf } from "../search/vectorTestUtil";

const IDEAS = [/stalking|hunting/, /tree/, /eye contact/, /backlit/, /car|street|text|food|building|computer|furniture|cartoon|airplane|spreadsheet|logo|keyboard/, /blue hour|dusk|twilight/];

function unit(weights: number[]): Float32Array {
  const v = new Float32Array(768);
  weights.forEach((w, i) => (v[i] = w));
  const n = Math.hypot(...weights) || 1;
  return v.map((x) => x / n);
}

function half(v: Float32Array): Uint8Array {
  const out = new Uint8Array(v.length * 2);
  v.forEach((x, i) => {
    const h = toHalf(x);
    out[2 * i] = h & 255;
    out[2 * i + 1] = h >> 8;
  });
  return out;
}

export async function smartFake(app: App): Promise<void> {
  const ids = await app.db.all<{ id: string }>("SELECT id FROM captures");
  await app.db.tx(async () => {
    for (const [i, { id }] of ids.entries()) {
      const w = new Array(8).fill(0.02);
      w[1] += i % 2; // trees in half the photos
      w[3] += i % 3 === 0 ? 1 : 0;
      w[5] += 0.5;
      await app.db.run("INSERT OR REPLACE INTO capture_vectors (capture_id, vec) VALUES (?, ?)", [id, half(unit(w))]);
      const golden = true;
      await app.db.run(
        "INSERT OR REPLACE INTO capture_frames (capture_id, box, unsure, aspect, light, zoned) VALUES (?, ?, 0, 1.5, ?, 1)",
        [
          id,
          JSON.stringify(golden ? [0.3, 0.3, 0.46, 0.46] : [0.4, 0.4, 0.6, 0.6]),
          JSON.stringify({ luma: 0.3, warmth: -0.05, highlights: 0.02, shadows: 0.2, saturation: 0.3 }),
        ],
      );
      await app.db.run("INSERT OR REPLACE INTO capture_backgrounds (capture_id, vec) VALUES (?, ?)", [id, half(unit([0, i % 2, 0.1]))]);
    }
  });
  await setMeta(app.db, "smart.model", { textModelVersion: "dev", files: { encoder: "x" }, complete: true });
  await setMeta(app.db, "smart.vectors", { imageModelVersion: "dev", cursor: null, complete: true });
  await setMeta(app.db, "smart.frames", { imageModelVersion: "dev", cursor: null, complete: true });
  await app.smart.load();
  const embedTexts = async (texts: string[]) =>
    texts.map((t) => unit(IDEAS.reduce((w, re, k) => ((w[k + 1] += re.test(t) ? 1 : 0), w), new Array(8).fill(0.02))));
  (app.smart as unknown as { embedder: Promise<unknown> }).embedder = Promise.resolve({ embedTexts, release: async () => undefined });
  app.bump();
}
