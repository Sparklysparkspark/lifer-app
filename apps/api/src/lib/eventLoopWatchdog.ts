// Restarts Lifer when it freezes. A bug that spins the main thread (an endless loop, a native call
// that never returns) leaves the process alive but unable to answer anything, including the page
// and /health, and it stays that way until someone restarts it by hand. This watches from a
// separate thread, which keeps running while the main one is stuck:
//   - after WARN_MS without a heartbeat it logs a warning naming the requests in progress, which
//     is the clue for finding the bug;
//   - after the freeze limit it logs again and kills the process, so Docker's restart policy (or
//     the desktop app, which restarts its server) brings Lifer back within seconds.
// The worker writes straight to stderr: a worker's console output is relayed through the main
// thread, which is exactly the thread that's stuck.
//
// LIFER_FREEZE_RESTART_SECONDS sets the limit (default 120); 0 turns the restart off and keeps
// only the warnings.
import { Worker } from "node:worker_threads";
import type { FastifyInstance } from "fastify";

const WARN_MS = 15_000;
const DEFAULT_RESTART_SECONDS = 120;
const HEARTBEAT_MS = 1_000;
const IN_FLIGHT_BYTES = 8_192;
const MAX_LISTED_REQUESTS = 20;

const WORKER_SOURCE = `
const { workerData } = require("node:worker_threads");
const { writeSync } = require("node:fs");
const beat = new BigInt64Array(workerData.beat);
const inFlightLength = new Int32Array(workerData.inFlight, 0, 1);
const inFlightBytes = new Uint8Array(workerData.inFlight, 4);
const { warnMs, restartMs } = workerData;
const log = (msg) => { try { writeSync(2, "[watchdog] " + msg + "\\n"); } catch {} };
const inFlight = () => {
  const len = Atomics.load(inFlightLength, 0);
  let list = [];
  try { list = JSON.parse(new TextDecoder().decode(inFlightBytes.slice(0, len)) || "[]"); } catch {}
  if (list.length === 0) return "none";
  const now = Date.now();
  return list.map(([method, url, startedAt]) => method + " " + url + " (" + Math.round((now - startedAt) / 1000) + "s)").join(", ");
};
let warned = false;
setInterval(() => {
  const stalledMs = Date.now() - Number(Atomics.load(beat, 0));
  if (stalledMs < warnMs) { warned = false; return; }
  const seconds = Math.round(stalledMs / 1000);
  if (!warned) {
    warned = true;
    log("Lifer has been unresponsive for " + seconds + "s. Requests in progress: " + inFlight());
  }
  if (restartMs > 0 && stalledMs >= restartMs) {
    log("Still unresponsive after " + seconds + "s, restarting. Requests in progress: " + inFlight());
    process.kill(process.pid, "SIGKILL");
  }
}, 2000); // stays ref'd: an unref'd timer would let this thread exit at once
`;

export function startEventLoopWatchdog(app: FastifyInstance): void {
  const raw = process.env.LIFER_FREEZE_RESTART_SECONDS;
  const restartSeconds = raw === undefined || raw === "" ? DEFAULT_RESTART_SECONDS : Number(raw);
  const restartMs = Number.isFinite(restartSeconds) && restartSeconds > 0 ? Math.max(restartSeconds * 1000, WARN_MS * 2) : 0;

  const beatBuffer = new SharedArrayBuffer(8);
  const beat = new BigInt64Array(beatBuffer);
  const inFlightBuffer = new SharedArrayBuffer(4 + IN_FLIGHT_BYTES);
  const inFlightLength = new Int32Array(inFlightBuffer, 0, 1);
  const inFlightBytes = new Uint8Array(inFlightBuffer, 4);

  const touch = () => Atomics.store(beat, 0, BigInt(Date.now()));
  touch();
  setInterval(touch, HEARTBEAT_MS).unref();

  // The requests in progress, kept where the worker can read them while this thread is stuck.
  const active = new Map<string, { method: string; url: string; startedAt: number }>();
  const encoder = new TextEncoder();
  const publish = () => {
    let listed = [...active.values()].slice(0, MAX_LISTED_REQUESTS);
    let bytes = encoder.encode(JSON.stringify(listed.map((r) => [r.method, r.url.split("?")[0].slice(0, 200), r.startedAt])));
    // Oldest requests first, since those are the likeliest culprits; drop the newest until it fits.
    while (bytes.length > IN_FLIGHT_BYTES && listed.length > 0) {
      listed = listed.slice(0, -1);
      bytes = encoder.encode(JSON.stringify(listed.map((r) => [r.method, r.url.split("?")[0].slice(0, 200), r.startedAt])));
    }
    inFlightBytes.set(bytes);
    Atomics.store(inFlightLength, 0, bytes.length);
  };
  app.addHook("onRequest", async (request) => {
    active.set(request.id, { method: request.method, url: request.url, startedAt: Date.now() });
    publish();
  });
  app.addHook("onResponse", async (request) => {
    active.delete(request.id);
    publish();
  });
  app.addHook("onRequestAbort", async (request) => {
    active.delete(request.id);
    publish();
  });

  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { beat: beatBuffer, inFlight: inFlightBuffer, warnMs: WARN_MS, restartMs },
  });
  worker.unref();
  worker.on("error", (err) => console.warn("[watchdog] stopped:", err));
}
