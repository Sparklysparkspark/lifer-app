// A burst: near-identical photos (whole-photo CLIP vectors) taken close together, like frames of
// one sighting. The species page collapses them (species/detail.ts), and suggestions pool their
// evidence, so one frame with the bird turned away or behind a twig doesn't get its own answer.
import { cosineSimilarity } from "@lifer/core/species/embeddings.js";

export const BURST_SIMILARITY = 0.9;
export const BURST_MAX_GAP_MS = 120_000;

// Photos the import screen checked recently, per user, so a frame can join the burst of frames
// checked before it (they arrive one request at a time).
const RECENT_TTL_MS = 30 * 60_000;
const RECENT_PER_USER = 300;
// The burst's newest frames that a ranking pools; enough to outvote a bad frame.
const MAX_POOLED_FRAMES = 8;

export interface BurstFrame {
  uploadId: string;
  takenAt: number;
  clip: Float32Array;
  vectors: Float32Array[];
  /** Region and model space the vectors were ranked in; frames only pool within the same. */
  context: string;
}

interface Recent extends BurstFrame {
  burst: number;
  seenAt: number;
}

const recentByUser = new Map<string, Recent[]>();
let nextBurst = 1;

/** Adds a checked photo and returns its burst's frames (itself included), newest last. */
export function joinBurst(userId: string, frame: BurstFrame): BurstFrame[] {
  const now = Date.now();
  const recent = (recentByUser.get(userId) ?? []).filter(
    (r) => now - r.seenAt < RECENT_TTL_MS && r.uploadId !== frame.uploadId,
  );
  const mates = recent.filter(
    (r) =>
      r.context === frame.context &&
      Math.abs(r.takenAt - frame.takenAt) <= BURST_MAX_GAP_MS &&
      cosineSimilarity(r.clip, frame.clip) >= BURST_SIMILARITY,
  );
  // Joining two bursts (a frame similar to both) makes them one.
  const burst = mates.length > 0 ? Math.min(...mates.map((m) => m.burst)) : nextBurst++;
  const merged = new Set(mates.map((m) => m.burst));
  for (const r of recent) if (merged.has(r.burst)) r.burst = burst;
  recent.push({ ...frame, burst, seenAt: now });
  recentByUser.set(userId, recent.slice(-RECENT_PER_USER));
  return recent.filter((r) => r.burst === burst).sort((a, b) => a.takenAt - b.takenAt);
}

/** The vectors a burst's ranking pools: the frame's own, then the other frames' newest first. */
export function pooledVectors(frame: BurstFrame, frames: BurstFrame[]): Float32Array[] {
  const others = frames.filter((f) => f.uploadId !== frame.uploadId).slice(-(MAX_POOLED_FRAMES - 1));
  return [...frame.vectors, ...others.flatMap((f) => f.vectors)];
}

/** For tests. */
export function clearBursts(): void {
  recentByUser.clear();
}
