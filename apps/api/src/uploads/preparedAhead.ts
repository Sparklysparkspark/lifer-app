// While the import screen waits on the user to pick species, each checked photo's previews and
// card crop are made in the background, so importing it only files it and the card is framed on
// the animal from the start. Kept in memory by user and content hash; the import takes it, else
// it expires with the staged file and its previews are removed.
//
// Built for batches of thousands: work only runs while no photo is being checked or imported
// (busy), two at a time, in the order photos were checked. An import never waits behind the
// queue: a photo whose work hasn't started is dropped and the import makes its own previews.
import { readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { generateDerivatives } from "@lifer/core/uploads/image.js";
import type { PhotoFormat } from "@lifer/core/uploads/formats.js";
import { STAGE_MAX_AGE_MS } from "../lib/stagedUploads.js";
import { detectDefaultCardCrop } from "../species/detectAndCrop.js";
import { derivativeFiles } from "./common.js";
import { prepareWorkingImage } from "./workingImage.js";

export interface PreparedAhead {
  photoId: string;
  derivatives: { displayPath: string; thumbPath: string; width: number | null; height: number | null };
  cardCrop: Awaited<ReturnType<typeof detectDefaultCardCrop>>;
}

interface Entry {
  job: Promise<PreparedAhead | null>;
  started: boolean;
  /** Resolves the job with null without running it (only before it starts). */
  drop: () => void;
  run: () => void;
  timer: NodeJS.Timeout;
}

const CONCURRENCY = 2;
const entries = new Map<string, Entry>();
const queue: Entry[] = [];
let active = 0;
let busy = 0;
const keyOf = (userId: string, fingerprint: string) => `${userId}:${fingerprint}`;

function pump(): void {
  while (active < CONCURRENCY && busy === 0 && queue.length > 0) queue.shift()!.run();
}

/** Marks a photo check or import as running, so background work steps aside until it ends. */
export async function whileImporting<T>(work: () => Promise<T>): Promise<T> {
  busy++;
  try {
    return await work();
  } finally {
    busy--;
    pump();
  }
}

async function make(filePath: string, format: PhotoFormat): Promise<PreparedAhead> {
  const working = await prepareWorkingImage(filePath, format);
  try {
    const photoId = randomUUID();
    const derivatives = await generateDerivatives(working.decodePath, photoId);
    const cardCrop = await detectDefaultCardCrop(await readFile(derivatives.displayPath), { priority: "background" });
    return { photoId, derivatives, cardCrop };
  } finally {
    await working.release();
  }
}

async function removePreviews(job: Promise<PreparedAhead | null>): Promise<void> {
  const ready = await job;
  if (ready) await Promise.all(derivativeFiles(ready.photoId).map((f) => rm(f, { force: true })));
}

function forget(key: string, entry: Entry): void {
  entries.delete(key);
  clearTimeout(entry.timer);
  const queued = queue.indexOf(entry);
  if (queued >= 0) queue.splice(queued, 1);
  if (!entry.started) entry.drop();
}

/** Queues making a checked photo's previews and card crop. `filePath` must stay readable until
 *  settlePreparedAhead or takePreparedAhead. Best effort: a failure leaves the import to do it. */
export function prepareAhead(userId: string, fingerprint: string, filePath: string, format: PhotoFormat): void {
  const key = keyOf(userId, fingerprint);
  if (entries.has(key)) return;
  let settle!: (value: PreparedAhead | null) => void;
  const job = new Promise<PreparedAhead | null>((resolve) => (settle = resolve));
  const entry: Entry = {
    job,
    started: false,
    drop: () => settle(null),
    run: () => {
      entry.started = true;
      active++;
      make(filePath, format)
        .then(settle, () => settle(null))
        .finally(() => {
          active--;
          pump();
        });
    },
    timer: setTimeout(() => {
      forget(key, entry);
      void removePreviews(job).catch(() => {});
    }, STAGE_MAX_AGE_MS),
  };
  entry.timer.unref();
  entries.set(key, entry);
  queue.push(entry);
  pump();
}

/** Lets a photo's file be moved: waits for work already running on it, drops work not started. */
export async function settlePreparedAhead(userId: string, fingerprint: string): Promise<void> {
  const key = keyOf(userId, fingerprint);
  const entry = entries.get(key);
  if (!entry) return;
  if (!entry.started) forget(key, entry);
  await entry.job;
}

/** The import's claim on a photo's background work: its previews become the import's own. Null
 *  when there was none or it hadn't started. */
export async function takePreparedAhead(userId: string, fingerprint: string): Promise<PreparedAhead | null> {
  const key = keyOf(userId, fingerprint);
  const entry = entries.get(key);
  if (!entry) return null;
  forget(key, entry);
  return entry.job;
}
