/** 1,536 bytes as "1.5 KB". Binary units, one decimal under 10. */
export function formatBytes(n: number): { value: string; unit: "B" | "KB" | "MB" | "GB" } {
  const units = ["B", "KB", "MB", "GB"] as const;
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return { value: i === 0 || v >= 10 ? String(Math.round(v)) : v.toFixed(1), unit: units[i] };
}

/** Distance between two points in kilometres. */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

/** The saved spot nearest to a point within maxKm, or null. */
export function nearestSpot<T extends { lat: number; lon: number }>(
  spots: T[],
  here: { lat: number; lon: number },
  maxKm = 60,
): T | null {
  let best: T | null = null;
  let bestKm = maxKm;
  for (const s of spots) {
    const km = distanceKm(here, s);
    if (km <= bestKm) {
      best = s;
      bestKm = km;
    }
  }
  return best;
}

export type SyncLine =
  | { key: "sync.syncing" }
  | { key: "sync.never" }
  | { key: "sync.justNow" }
  | { key: "sync.minutes"; n: number }
  | { key: "sync.hours"; n: number }
  | { key: "sync.days"; n: number }
  | { key: "sync.waiting"; n: number; where: "home" | "hub" };

/** The one calm sync line (MR4): what is waiting, or how long ago it last synced. Never an error. */
export function syncLine(o: {
  syncing: boolean;
  lastSyncAt: string | null;
  waiting: number;
  now: Date;
  reachable: boolean;
  desktop: boolean;
}): SyncLine {
  if (o.syncing) return { key: "sync.syncing" };
  if (o.waiting > 0 && !o.reachable) return { key: "sync.waiting", n: o.waiting, where: o.desktop ? "home" : "hub" };
  if (!o.lastSyncAt) return { key: "sync.never" };
  const mins = Math.floor((o.now.getTime() - new Date(o.lastSyncAt).getTime()) / 60_000);
  if (mins < 1) return { key: "sync.justNow" };
  if (mins < 60) return { key: "sync.minutes", n: mins };
  if (mins < 24 * 60) return { key: "sync.hours", n: Math.floor(mins / 60) };
  return { key: "sync.days", n: Math.floor(mins / (24 * 60)) };
}
