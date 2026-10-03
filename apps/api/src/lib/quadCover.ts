import type { QuadSlot } from "@lifer/shared";

export interface QuadCropInput {
  x: number;
  y: number;
  size: number;
}

/** Resolves the 4 quad-grid tiles for an album/trip. A configured slot wins while its photo is
 *  still available; empty or invalid slots fall back to the most recently added unused photo. A
 *  slot's saved crop only applies when its configured photo is the one used. */
export function resolveQuadSlots(
  quadPhotoIdsRaw: (string | null)[] | null,
  quadCropsRaw: Array<QuadCropInput | null> | null,
  availablePhotoIdsInOrder: string[],
): Array<QuadSlot | null> {
  const configured = [0, 1, 2, 3].map((i) => quadPhotoIdsRaw?.[i] ?? null);
  const crops = [0, 1, 2, 3].map((i) => quadCropsRaw?.[i] ?? null);
  const available = new Set(availablePhotoIdsInOrder);

  const used = new Set<string>();
  const resolved: (string | null)[] = configured.map((id) => {
    if (id && available.has(id)) {
      used.add(id);
      return id;
    }
    return null;
  });

  let cursor = 0;
  for (let i = 0; i < 4; i++) {
    if (resolved[i] != null) continue;
    while (cursor < availablePhotoIdsInOrder.length && used.has(availablePhotoIdsInOrder[cursor])) cursor++;
    if (cursor < availablePhotoIdsInOrder.length) {
      resolved[i] = availablePhotoIdsInOrder[cursor];
      used.add(availablePhotoIdsInOrder[cursor]!);
      cursor++;
    }
  }

  return resolved.map((photoId, i) => {
    if (!photoId) return null;
    const crop = configured[i] === photoId ? crops[i] : null;
    return { photoId, cropX: crop?.x ?? null, cropY: crop?.y ?? null, cropSize: crop?.size ?? null };
  });
}
