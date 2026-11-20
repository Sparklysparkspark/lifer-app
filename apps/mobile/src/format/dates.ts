import { MONTH_KEYS } from "../labels";
type T = (key: string) => string;

const parts = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
};

/** "12 May 2026" from an ISO date or timestamp; the text itself when it is not one. */
export function dateText(t: T, iso: string): string {
  const p = parts(iso);
  return p ? `${p.d} ${t(MONTH_KEYS[p.m - 1])} ${p.y}` : iso;
}

/** "14 to 18 April 2026", "28 April to 2 May 2026", or one date. */
export function rangeText(t: T, from: string | null, to: string | null): string {
  const word = t("common.to");
  const a = from ? parts(from) : null;
  const b = to ? parts(to) : null;
  if (!a) return "";
  if (!b || (a.y === b.y && a.m === b.m && a.d === b.d)) return dateText(t, from!);
  const month = (p: { m: number }) => t(MONTH_KEYS[p.m - 1]);
  if (a.y === b.y && a.m === b.m) return `${a.d} ${word} ${b.d} ${month(b)} ${b.y}`;
  if (a.y === b.y) return `${a.d} ${month(a)} ${word} ${b.d} ${month(b)} ${b.y}`;
  return `${dateText(t, from!)} ${word} ${dateText(t, to!)}`;
}

/** Time of day as "7:42 AM" from a timestamp, when it has one. */
export function timeText(iso: string): string | null {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return null;
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}
