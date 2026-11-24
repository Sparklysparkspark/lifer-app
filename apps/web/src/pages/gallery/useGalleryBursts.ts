import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { ignore } from "../../lib/ignore";
import type { GalleryItem } from "./types";

export interface BurstInfo {
  /** The burst's first frame. */
  burstId: string;
  /** Frames in the whole burst, loaded or not. */
  count: number;
}

// The most the server takes at once: a grid page.
const CHUNK = 500;

/** Which loaded photos are in a burst of more than one frame. Asked once per photo, after the grid
 *  draws, so the badges fill in without holding the page up. */
export function useGalleryBursts(items: readonly GalleryItem[] | null): ReadonlyMap<string, BurstInfo> {
  const [bursts, setBursts] = useState<ReadonlyMap<string, BurstInfo>>(() => new Map());
  // shortcut: answers are kept for the visit, so a burst trimmed by a delete keeps its old count until the page reloads.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    const ids = (items ?? [])
      .filter((it) => it.kind === "image" && it.takenAt && !it.version && !asked.current.has(it.captureId))
      .map((it) => it.captureId);
    if (ids.length === 0) return;
    for (const id of ids) asked.current.add(id);
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
    // One update once every chunk answers: a big search would otherwise re-render and, with
    // Group bursts on, re-fold the grid once per chunk.
    Promise.allSettled(chunks.map((captureIds) => api.post("/gallery/bursts", { captureIds })))
      .then((results) => {
        const answered = results.flatMap((r) => (r.status === "fulfilled" ? r.value.bursts : []));
        const failed = results.find((r) => r.status === "rejected");
        if (failed) ignore("Couldn't load bursts")(failed.reason);
        if (answered.length === 0) return;
        setBursts((prev) => {
          const next = new Map(prev);
          for (const b of answered) for (const id of b.captureIds) next.set(id, { burstId: b.burstId, count: b.count });
          return next;
        });
      })
      .catch(ignore("Couldn't load bursts"));
  }, [items]);
  return bursts;
}

/** The grid with each burst folded into one tile where its first loaded photo was: its best-rated
 *  photo, else its first. */
export function collapseBursts(items: GalleryItem[], bursts: ReadonlyMap<string, BurstInfo>): GalleryItem[] {
  const cover = new Map<string, GalleryItem>();
  for (const it of items) {
    const b = bursts.get(it.captureId);
    if (!b) continue;
    const best = cover.get(b.burstId);
    const [rating, bestRating] = [it.qualityRating ?? 0, best?.qualityRating ?? 0];
    if (!best || rating > bestRating || (rating === bestRating && (it.takenAt ?? "") < (best.takenAt ?? "")))
      cover.set(b.burstId, it);
  }
  const placed = new Set<string>();
  return items.flatMap((it) => {
    const b = bursts.get(it.captureId);
    if (!b) return [it];
    if (placed.has(b.burstId)) return [];
    placed.add(b.burstId);
    return [cover.get(b.burstId)!];
  });
}

/** A burst folded to one tile shows its best-rated photo, else its first. */
export function coverOf(frames: GalleryItem[]): GalleryItem {
  return frames.reduce((best, f) => ((f.qualityRating ?? 0) > (best.qualityRating ?? 0) ? f : best), frames[0]);
}
