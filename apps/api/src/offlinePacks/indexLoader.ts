// Reads a saved pack index (about 22 MB, nearly all species names) off the main thread, so the
// API keeps answering other requests while it loads. The worker parses and checks the file, hands
// back the packs without their names, and the names packed as one shared table plus integer arrays
// (transferred, not copied). It can also write a lite copy (no names) for the next start.
import { Worker } from "node:worker_threads";
import type { PackIndex, PackIndexEntry } from "./schemas.js";

/** Each pack's species names, as positions in one table of distinct names: pack i's names are
 *  `ids[offsets[i]]` up to `ids[offsets[i + 1]]`, in the order of `packIds`. */
export interface PackNames {
  table: string[];
  packIds: string[];
  offsets: Int32Array;
  ids: Int32Array;
}

export interface LoadedIndex {
  /** Every pack with `scientificNames: []`; the names live in `names`. */
  index: PackIndex;
  /** Null for a file without names (a lite index). */
  names: PackNames | null;
}

// Plain CommonJS, run with `eval`: no bundling, and nothing but Node built-ins. The checks match
// PackIndexEntrySchema's required fields; anything else is passed through as published.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const { file, writeLiteTo } = workerData;
try {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!raw || typeof raw !== "object" || typeof raw.generatedAt !== "string" || !Array.isArray(raw.packs))
    throw new Error("not a pack index");
  const table = [];
  const tableIndex = new Map();
  const offsets = new Int32Array(raw.packs.length + 1);
  const ids = [];
  const packIds = [];
  let hasNames = false;
  const packs = raw.packs.map((p, i) => {
    if (
      !p || typeof p !== "object" || typeof p.id !== "string" ||
      (p.type !== "region" && p.type !== "seaZone") || typeof p.url !== "string" ||
      typeof p.contentVersion !== "string" || typeof p.sizeBytes !== "number" || typeof p.speciesCount !== "number"
    ) throw new Error("pack entry " + i + " is malformed");
    offsets[i] = ids.length;
    packIds.push(p.id);
    if (Array.isArray(p.scientificNames)) {
      hasNames = hasNames || p.scientificNames.length > 0;
      for (const name of p.scientificNames) {
        if (typeof name !== "string") throw new Error("pack entry " + i + " has a malformed name");
        let k = tableIndex.get(name);
        if (k === undefined) { k = table.length; table.push(name); tableIndex.set(name, k); }
        ids.push(k);
      }
    }
    const { scientificNames, ...rest } = p;
    return rest;
  });
  offsets[raw.packs.length] = ids.length;
  const lite = { ...raw, packs };
  if (writeLiteTo) {
    fs.writeFileSync(writeLiteTo + ".tmp", JSON.stringify(lite));
    fs.renameSync(writeLiteTo + ".tmp", writeLiteTo);
  }
  const idArray = Int32Array.from(ids);
  parentPort.postMessage(
    { ok: true, lite, names: hasNames ? { table, packIds, offsets, ids: idArray } : null },
    [offsets.buffer, idArray.buffer],
  );
} catch (err) {
  parentPort.postMessage({ ok: false, message: String((err && err.message) || err) });
}
`;

/** Loads `file` in a worker thread. With `writeLiteTo`, also saves a copy without names there. */
export function loadIndexFile(file: string, opts: { writeLiteTo?: string } = {}): Promise<LoadedIndex> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { file, writeLiteTo: opts.writeLiteTo } });
    worker.once(
      "message",
      (msg: { ok: true; lite: PackIndex; names: PackNames | null } | { ok: false; message: string }) => {
        void worker.terminate();
        if (!msg.ok) return reject(new Error(`Couldn't read the region download index: ${msg.message}`));
        for (const p of msg.lite.packs as Array<PackIndexEntry & { scientificNames?: string[] }>)
          p.scientificNames = [];
        resolve({ index: msg.lite, names: msg.names });
      },
    );
    worker.once("error", reject);
  });
}

/** One pack's species names, rebuilt from the shared table. */
export function namesOf(names: PackNames, packIndex: number): string[] {
  const out: string[] = [];
  for (let k = names.offsets[packIndex]; k < names.offsets[packIndex + 1]; k++) out.push(names.table[names.ids[k]]);
  return out;
}

/** Hands the event loop back between chunks of a long loop, so other requests keep moving. */
export const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
