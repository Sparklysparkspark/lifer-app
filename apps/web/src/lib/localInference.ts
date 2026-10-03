// Species matching on this computer when the desktop app is connected to a server: the import sends
// locally computed vectors so the server can skip them. Optional: any failure falls back to the server.
import { useSyncExternalStore } from "react";
import { api } from "../api/client";
import { tauriInvoke } from "./tauri";

type Phase = "idle" | "starting" | "ready" | "unavailable";

interface MatchingInfo {
  targets: string[];
}

const EMBED_TIMEOUT_MS = 30_000;
const POLL_MS = 2_000;
// Try again after this long if it wasn't available (the server may have just got its models).
const RETRY_MS = 5 * 60_000;

let phase: Phase = "idle";
let targets: string[] = [];
let unavailableAt = 0;
const listeners = new Set<() => void>();

function setPhase(next: Phase): void {
  if (next === "unavailable") unavailableAt = Date.now();
  if (phase === next) return;
  phase = next;
  for (const l of listeners) l();
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    promise.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

interface Status {
  ready?: boolean;
  error?: string | null;
}

async function start(): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) return setPhase("unavailable");
  setPhase("starting");
  try {
    // Errors outside remote mode, or when the shell lacks these commands.
    await invoke("local_inference_status");
    const info = await api.get<MatchingInfo>("/species/matching-info");
    if (!info.targets?.length) return setPhase("unavailable");
    let status = (await invoke("local_inference_prepare", { info })) as Status;
    // A first run downloads the models (hundreds of MB); imports go to the server meanwhile.
    while (!status.ready && !status.error) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      status = (await invoke("local_inference_status")) as Status;
    }
    if (status.error) return setPhase("unavailable");
    targets = info.targets;
    setPhase("ready");
  } catch {
    setPhase("unavailable");
  }
}

/** Starts getting local matching ready in the background, if this is the desktop app. */
export function prepareLocalInference(): void {
  if (phase === "idle" || (phase === "unavailable" && Date.now() - unavailableAt > RETRY_MS && tauriInvoke())) void start();
}

// Matching runs wherever it's faster: this computer, or the server (a NAS with a GPU can beat a
// laptop). Running averages of each side's model time decide, and every EXPLORE_EVERY photos the
// other side is tried again, so a busy server or a laptop on battery is noticed.
const AVERAGE_WEIGHT = 0.3;
const EXPLORE_EVERY = 20;
let localMs: number | null = null;
let serverMs: number | null = null;
let decisions = 0;

const average = (prev: number | null, ms: number) => (prev === null ? ms : prev + AVERAGE_WEIGHT * (ms - prev));

/** Whether this photo should be matched on this computer rather than the server. */
export function shouldMatchLocally(): boolean {
  const n = ++decisions;
  if (localMs === null) return true; // this computer first,
  if (serverMs === null) return n % 4 !== 0; // then the server soon after
  const preferLocal = localMs <= serverMs;
  return n % EXPLORE_EVERY === 0 ? !preferLocal : preferLocal;
}

/** This computer's model time for a photo. */
export function recordLocalMatching(ms: number): void {
  localMs = average(localMs, ms);
}

/** The server's model time for a photo it matched itself (/uploads/inspect matchingMs). */
export function recordServerMatching(ms: number): void {
  serverMs = average(serverMs, ms);
}

/** The clientVectors field for /uploads/inspect, as JSON, or null to let the server compute. */
export async function computeClientVectors(file: Blob): Promise<string | null> {
  const invoke = tauriInvoke();
  if (!invoke) return null;
  if (phase !== "ready") {
    prepareLocalInference();
    return null;
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const startedAt = performance.now();
    const vectors = await withTimeout(invoke("local_embed", bytes, { headers: { "x-lifer-targets": targets.join(",") } }), EMBED_TIMEOUT_MS);
    if (!vectors || typeof vectors !== "object") return null;
    recordLocalMatching(performance.now() - startedAt);
    return JSON.stringify(vectors);
  } catch {
    // The sidecar may have exited: get it going again for the next photo.
    setPhase("idle");
    prepareLocalInference();
    return null;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True once photos are being matched on this computer. */
export function useLocalInferenceReady(): boolean {
  return useSyncExternalStore(subscribe, () => phase === "ready");
}
