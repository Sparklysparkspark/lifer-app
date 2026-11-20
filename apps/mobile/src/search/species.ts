// Offline species search over names on the phone: "swans" finds Mute Swan and Tundra Swan with no
// network. Group words ("birds", "raptors") use the same table as the hub's search (@lifer/shared).
import { GROUP_TERMS, speciesInGroup } from "@lifer/shared";

export interface Searchable {
  scientificName: string;
  commonName: string | null;
  taxonClass: string | null;
}

const IRREGULAR: Record<string, string> = { geese: "goose", mice: "mouse", wolves: "wolf", lice: "louse", men: "man" };

const fold = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const words = (s: string): string[] =>
  fold(s)
    .split(/[^\p{L}]+/u)
    .filter(Boolean);

/** A crude singular, enough for animal names: finches, flies, swans, geese. */
export function singular(w: string): string {
  if (IRREGULAR[w]) return IRREGULAR[w];
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** Species whose names contain every word typed (as word starts), plus a named group. Best first. */
export function matchSpecies<T extends Searchable>(rows: T[], query: string): T[] {
  const tokens = words(query);
  if (!tokens.length) return rows;
  const group = GROUP_TERMS.get(tokens.join(" ")) ?? GROUP_TERMS.get(tokens.map(singular).join(" "));
  const wanted = tokens.map((t) => [t, singular(t)]);
  const scored: [number, T][] = [];
  for (const r of rows) {
    const common = words(r.commonName ?? "");
    const latin = words(r.scientificName);
    const all = [...common, ...latin];
    const hits = wanted.every(([plain, one]) => all.some((w) => w.startsWith(plain) || w.startsWith(one)));
    if (hits) {
      const first = fold(r.commonName ?? "");
      scored.push([first.startsWith(tokens.join(" ")) ? 0 : common.some((w) => w === wanted[0][1]) ? 1 : 2, r]);
    } else if (group && speciesInGroup({ ...r, taxonOrder: null, family: null }, group.predicate)) {
      scored.push([3, r]);
    }
  }
  return scored
    .sort(
      (a, b) =>
        a[0] - b[0] || (a[1].commonName ?? a[1].scientificName).localeCompare(b[1].commonName ?? b[1].scientificName),
    )
    .map((s) => s[1]);
}
