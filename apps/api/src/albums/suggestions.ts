// Smart albums Lifer suggests from the user's own library. Lifer only suggests: an album exists
// once the user picks one. Each suggestion is plain smart album rules, so the album it makes reads
// exactly like one built by hand.
import { pool } from "@lifer/core/db.js";
import { log } from "@lifer/core/lib/log.js";
import { getInstallSetting, setInstallSetting } from "../lib/installSettings.js";
import { GROUP_TERMS, speciesInGroup } from "../gallery/searchTaxonSynonyms.js";
import {
  ALBUM_MEMBER_COLUMNS,
  smartAlbumRows,
  upgradeRules,
  type AlbumMember,
  type SmartAlbumRules,
  type SmartAlbumRulesInput,
} from "./smartRules.js";

export const SUGGESTION_KINDS = [
  "lifers",
  "bestOfYear",
  "tripHighlights",
  "rareAndLegendary",
  "flight",
  "behavior",
  "environmental",
  "group",
  "country",
  "groupsOfAnimals",
  "goldenHour",
  "needsRating",
  "missingRegion",
] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

export const MIN_SUGGESTION_PHOTOS = 8;
// "Groups of animals" starts at three: the detector sometimes reports one animal as two (a body and
// a head, a reflection), which a floor of two would call a group.
export const GROUP_MIN_ANIMALS = 3;
const HOUSEKEEPING = new Set<SuggestionKind>(["needsRating", "missingRegion"]);
const MAX_SUGGESTIONS = 8;
// Where the New smart album builder starts: photos only, RAW-only ones included.
const BASE_QUERY = { excludeVideo: "1" } as const;

type RuleQuery = SmartAlbumRules["query"];

export interface AlbumSuggestion {
  id: string;
  kind: SuggestionKind;
  /** The year, trip, group or country a kind names; null for the others. */
  label: string | null;
  name: string;
  rules: SmartAlbumRules;
  photoCount: number;
  previewPhotoIds: string[];
}

type Candidate = Omit<AlbumSuggestion, "photoCount" | "previewPhotoIds">;

function candidate(
  id: string,
  kind: SuggestionKind,
  name: string,
  query: RuleQuery,
  label: string | null = null,
): Candidate {
  return { id, kind, label, name, rules: { version: 2 as const, query: { ...BASE_QUERY, ...query } } };
}

/** Rules as one comparable string: keys sorted, empty values dropped, as the builder saves them. */
export function rulesKey(rules: SmartAlbumRules): string {
  const q = rules.query as Record<string, string | string[] | undefined>;
  return JSON.stringify(
    Object.keys(q)
      .filter((k) => (Array.isArray(q[k]) ? q[k].length > 0 : q[k]))
      .sort()
      .map((k) => [k, Array.isArray(q[k]) ? [...q[k]].sort() : q[k]]),
  );
}

const dismissedKey = (userId: string) => `album_suggestions_dismissed:${userId}`;

async function dismissedIds(userId: string): Promise<string[]> {
  const saved = await getInstallSetting<unknown>(pool, dismissedKey(userId));
  return Array.isArray(saved) ? saved.filter((x): x is string => typeof x === "string") : [];
}

export async function restoreSuggestion(userId: string, id: string): Promise<void> {
  const ids = await dismissedIds(userId);
  if (ids.includes(id))
    await setInstallSetting(
      pool,
      dismissedKey(userId),
      ids.filter((d) => d !== id),
    );
}

// Kept to the newest few hundred: ids for trips and years long gone needn't pile up forever.
export async function dismissSuggestion(userId: string, id: string): Promise<void> {
  const ids = (await dismissedIds(userId)).filter((d) => d !== id);
  await setInstallSetting(pool, dismissedKey(userId), [...ids, id].slice(-500));
}

// Plural group words only ("owls", not "feline"), not whole classes the Gallery's own taxa filter
// already covers, and not broad diet or habitat words ("predators").
const GROUP_LABELS = [
  ...new Map(
    [...GROUP_TERMS.values()]
      .filter((g) => !g.predicate.classes && !g.predicate.broad && g.label.endsWith("s"))
      .map((g) => [g.label, g.predicate]),
  ),
];

/** Years with enough 4+ star photos, newest first. A cheap pre-filter; the rules make the count. */
async function bestYears(userId: string): Promise<number[]> {
  const res = await pool.query<{ year: number }>(
    `SELECT extract(year FROM taken_at)::int AS year FROM captures
      WHERE user_id = $1 AND quality_rating >= 4 AND taken_at IS NOT NULL
      GROUP BY 1 HAVING count(*) >= $2 ORDER BY 1 DESC LIMIT 3`,
    [userId, MIN_SUGGESTION_PHOTOS],
  );
  return res.rows.map((r) => r.year);
}

/** Trips with enough 4+ star photos, most recently photographed first. */
async function highlightTrips(userId: string): Promise<Array<{ id: string; name: string }>> {
  const res = await pool.query<{ id: string; name: string }>(
    `SELECT t.id, t.name FROM trips t JOIN captures c ON c.trip_id = t.id
      WHERE t.user_id = $1 AND c.quality_rating >= 4
      GROUP BY t.id HAVING count(*) >= $2
      ORDER BY max(c.taken_at) DESC NULLS LAST, t.created_at DESC LIMIT 2`,
    [userId, MIN_SUGGESTION_PHOTOS],
  );
  return res.rows;
}

/** The groups with the most photos, most first, leaving out one that is the whole library. */
async function topGroups(userId: string): Promise<string[]> {
  const res = await pool.query<{
    id: string;
    taxon_class: string | null;
    taxon_order: string | null;
    family: string | null;
    common_name: string | null;
    n: number;
  }>(
    `SELECT s.id, s.taxon_class, s.taxon_order, s.family, s.common_name, count(*)::int AS n
       FROM captures c JOIN species s ON s.id = c.species_id
      WHERE c.user_id = $1 GROUP BY s.id`,
    [userId],
  );
  const total = res.rows.reduce((sum, s) => sum + s.n, 0);
  // Groups run broad to narrow (raptors, then owls), so when two cover the same photos the later,
  // narrower name wins.
  const bySpecies = new Map<string, { label: string; n: number }>();
  for (const [label, predicate] of GROUP_LABELS) {
    const members = res.rows.filter((s) =>
      speciesInGroup(
        { taxonClass: s.taxon_class, taxonOrder: s.taxon_order, family: s.family, commonName: s.common_name },
        predicate,
      ),
    );
    const n = members.reduce((sum, s) => sum + s.n, 0);
    if (n >= MIN_SUGGESTION_PHOTOS && n < total) bySpecies.set(members.map((s) => s.id).join(), { label, n });
  }
  return [...bySpecies.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 2)
    .map((g) => g.label);
}

/** The countries with the most photos, when there's more than one (one would be the whole library). */
async function topCountries(userId: string): Promise<Array<{ id: string; name: string }>> {
  const res = await pool.query<{ id: string; name: string }>(
    `WITH RECURSIVE up AS (
       SELECT r.id AS start_id, r.id, COALESCE(r.home_country_id, r.parent_id) AS up_id, r.sovereignty_group, 0 AS depth
         FROM regions r
        WHERE r.id IN (SELECT DISTINCT region_id FROM captures WHERE user_id = $1 AND region_id IS NOT NULL)
       UNION ALL
       -- A province shown under its continent still belongs to its country.
       SELECT up.start_id, r.id, COALESCE(r.home_country_id, r.parent_id), r.sovereignty_group, up.depth + 1
         FROM regions r JOIN up ON r.id = up.up_id
        WHERE up.sovereignty_group IS NULL AND up.depth < 10
     ),
     country AS (
       SELECT DISTINCT ON (start_id) start_id, id FROM up WHERE sovereignty_group IS NOT NULL ORDER BY start_id, depth
     ),
     counted AS (
       SELECT country.id, count(*) AS n FROM captures c JOIN country ON country.start_id = c.region_id
        WHERE c.user_id = $1 GROUP BY country.id
     )
     SELECT r.id, r.name FROM counted JOIN regions r ON r.id = counted.id
      WHERE (SELECT count(*) FROM counted) > 1
      ORDER BY counted.n DESC LIMIT 2`,
    [userId],
  );
  return res.rows;
}

const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Every candidate, most interesting first. */
async function candidates(userId: string): Promise<Candidate[]> {
  const [years, trips, groups, countries] = await Promise.all([
    bestYears(userId),
    highlightTrips(userId),
    topGroups(userId),
    topCountries(userId),
  ]);
  const year = (y: number | undefined) =>
    y === undefined
      ? null
      : candidate(
          `best-of-${y}`,
          "bestOfYear",
          `Best of ${y}`,
          { ratingMin: "4", dateFrom: `${y}-01-01`, dateTo: `${y}-12-31` },
          String(y),
        );
  const trip = (t: { id: string; name: string } | undefined) =>
    t
      ? candidate(`trip-${t.id}`, "tripHighlights", `${t.name} highlights`, { tripId: [t.id], ratingMin: "4" }, t.name)
      : null;
  const group = (label: string | undefined) =>
    label ? candidate(`group-${label.replace(/\s+/g, "-")}`, "group", capitalized(label), { q: label }, label) : null;
  const country = (c: { id: string; name: string } | undefined) =>
    c ? candidate(`country-${c.id}`, "country", c.name, { regionId: [c.id] }, c.name) : null;
  return [
    // Search reads "lifers" as each species' first photo, and the tier words as the user's own tier.
    candidate("lifers", "lifers", "Lifers", { q: "lifers" }),
    year(years[0]),
    trip(trips[0]),
    candidate("rare-and-legendary", "rareAndLegendary", "Rare and legendary", { q: "rare or legendary" }),
    candidate("flight", "flight", "Flight shots", { action: "flying" }),
    group(groups[0]),
    country(countries[0]),
    candidate("behavior", "behavior", "Behaviour", { action: "behavior" }),
    year(years[1]),
    trip(trips[1]),
    candidate("environmental", "environmental", "Environmental", { framing: "environmental" }),
    candidate("groups-of-animals", "groupsOfAnimals", "Groups of animals", { animalsMin: String(GROUP_MIN_ANIMALS) }),
    // Golden hour is placed by the sun where a photo has coordinates. Black and white is left out:
    // alone it also brings in black-and-white animals, which isn't the album the name promises.
    candidate("golden-hour", "goldenHour", "Golden hour", { q: "golden hour" }),
    group(groups[1]),
    country(countries[1]),
    year(years[2]),
    candidate("needs-rating", "needsRating", "Needs a rating", { unrated: "1" }),
    candidate("missing-region", "missingRegion", "Missing a region", { regionId: ["uncategorized"] }),
  ].filter((c) => c !== null);
}

/** The suggestions to show: enough photos, not dismissed, not already an album, capped. With
 *  `dismissed`, the dismissed ones that would otherwise show, so any can be restored.
 *  `dismissedCount` is how many of those there are, without counting their photos. */
export async function albumSuggestions(
  userId: string,
  { dismissed: onlyDismissed = false }: { dismissed?: boolean } = {},
): Promise<{ suggestions: AlbumSuggestion[]; dismissedCount: number }> {
  const [all, dismissed, existing, library] = await Promise.all([
    candidates(userId),
    dismissedIds(userId),
    pool.query<{ rules: SmartAlbumRulesInput }>(`SELECT rules FROM albums WHERE user_id = $1 AND rules IS NOT NULL`, [
      userId,
    ]),
    smartAlbumRows<AlbumMember>({ version: 2, query: BASE_QUERY }, userId, undefined, ALBUM_MEMBER_COLUMNS),
  ]);
  const skip = new Set(dismissed);
  const taken = new Set(existing.rows.map((r) => rulesKey(upgradeRules(r.rules))));
  const fresh = all.filter((c) => !taken.has(rulesKey(c.rules)));
  const dismissedCount = fresh.filter((c) => skip.has(c.id)).length;
  const open = fresh.filter((c) => skip.has(c.id) === onlyDismissed);
  const counted = await Promise.all(
    open.map(async (c) => {
      try {
        const rows = await smartAlbumRows<AlbumMember>(c.rules, userId, undefined, ALBUM_MEMBER_COLUMNS);
        return { ...c, photoCount: rows.length, previewPhotoIds: rows.slice(0, 4).map((r) => r.photo_id) };
      } catch (err) {
        // One candidate failing (a picture model not loaded yet) never hides the others.
        log.warn({ suggestion: c.id, err: err instanceof Error ? err.message : err }, "Couldn't count a suggestion");
        return null;
      }
    }),
  );
  // An album of every photo isn't worth making, though a whole library can still need tidying.
  const worthIt = (s: AlbumSuggestion) =>
    s.photoCount >= MIN_SUGGESTION_PHOTOS && (s.photoCount < library.length || HOUSEKEEPING.has(s.kind));
  return {
    suggestions: counted.filter((s): s is AlbumSuggestion => !!s && worthIt(s)).slice(0, MAX_SUGGESTIONS),
    dismissedCount,
  };
}
