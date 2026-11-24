import { baseStem } from "@lifer/shared";
import type { ReviewRowBase } from "./useImportReview";

// Files of one import that are one photo (a RAW and its edited export), on the same evidence the
// library links versions on (apps/api/src/uploads/versionGrouping.ts and rawMatching.ts).

export interface PairFacts {
  key: string;
  name: string;
  isRaw: boolean;
  /** Capture time, ISO. */
  takenAt: string | null;
  /** From /uploads/inspect: the XMP document the file descends from. */
  documentId: string | null;
  /** From /uploads/inspect: the shutter press (time, sub-second and body serial), when recorded. */
  press: string | null;
}

// The same shot by name: the same press, or for a RAW and a non-RAW (an export often loses
// sub-second and serial) a capture time within a second, as a RAW finds its JPEG in the library.
// Two different documents are two photos, whatever the names say.
function sameShot(a: PairFacts, b: PairFacts): boolean {
  if (a.documentId && b.documentId) return false;
  if (a.press && a.press === b.press) return true;
  if (a.isRaw === b.isRaw || !a.takenAt || !b.takenAt) return false;
  return Math.abs(Date.parse(a.takenAt) - Date.parse(b.takenAt)) <= 1000;
}

function groupBy(files: PairFacts[], keyOf: (f: PairFacts) => string | null): PairFacts[][] {
  const out = new Map<string, PairFacts[]>();
  for (const f of files) {
    const k = keyOf(f);
    if (k) out.set(k, [...(out.get(k) ?? []), f]);
  }
  return [...out.values()];
}

/** Pairs as [the file the other follows, its partner]: the RAW, else the one without an editor's
 *  suffix, else the first. A file with more than one candidate is ambiguous and stays alone. */
export function batchPairs(files: PairFacts[]): Array<[string, string]> {
  const candidates = new Map<string, Set<string>>();
  const link = (a: PairFacts, b: PairFacts) => {
    for (const [x, y] of [
      [a, b],
      [b, a],
    ])
      candidates.set(x.key, (candidates.get(x.key) ?? new Set()).add(y.key));
  };
  for (const group of groupBy(files, (f) => f.documentId)) {
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) link(group[i], group[j]);
  }
  for (const group of groupBy(files, (f) => baseStem(f.name) || null)) {
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++) if (sameShot(group[i], group[j])) link(group[i], group[j]);
  }
  const byKey = new Map(files.map((f, i) => [f.key, { f, i }]));
  const unsuffixed = (f: PairFacts) => {
    const name = f.name.replace(/\\/g, "/").split("/").pop() ?? "";
    const dot = name.lastIndexOf(".");
    return baseStem(name) === (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
  };
  const pairs: Array<[string, string]> = [];
  for (const [key, set] of candidates) {
    const [other] = set;
    if (set.size !== 1 || candidates.get(other)?.size !== 1 || key > other) continue;
    const a = byKey.get(key)!;
    const b = byKey.get(other)!;
    const aFirst =
      a.f.isRaw !== b.f.isRaw ? a.f.isRaw : unsuffixed(a.f) !== unsuffixed(b.f) ? unsuffixed(a.f) : a.i < b.i;
    pairs.push(aFirst ? [a.f.key, b.f.key] : [b.f.key, a.f.key]);
  }
  return pairs;
}

/** The rows as the review shows them: each pair shares one species and one verdict, and the
 *  partner's own suggestions and wildlife hints are hidden. */
export function joinPairs<R extends ReviewRowBase>(
  rows: R[],
  pairs: Array<[string, string]>,
  nameOf: (row: R) => string,
): R[] {
  if (pairs.length === 0) return rows;
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const joined = new Map<string, R>();
  for (const [lead, follow] of pairs) {
    const p = byKey.get(lead);
    const s = byKey.get(follow);
    if (!p || !s) continue;
    const species = p.speciesId ? p : s;
    joined.set(p.key, { ...p, partnerKey: s.key, speciesId: species.speciesId, speciesLabel: species.speciesLabel });
    joined.set(s.key, {
      ...s,
      partnerKey: p.key,
      samePhotoAs: nameOf(p),
      speciesId: species.speciesId,
      speciesLabel: species.speciesLabel,
      suggestions: [],
      notWildlife: p.notWildlife,
      maybeNotWildlife: null,
      invertebrate: null,
      suggestError: undefined,
    });
  }
  return rows.map((r) => joined.get(r.key) ?? r);
}
