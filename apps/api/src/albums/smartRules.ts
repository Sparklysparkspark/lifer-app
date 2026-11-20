// Smart albums: an album whose photos are a saved Gallery filter set, matched live, instead of
// hand-picked album_captures rows.
import { upgradeRulesQuery } from "@lifer/shared";
import Value from "typebox/value";
import { Type, type Static } from "typebox";
import {
  GalleryFilterQuery,
  galleryFiltersFor,
  listGalleryRows,
  parseGalleryFilters,
  searchGallery,
  type GalleryRow,
} from "../gallery/routes.js";

const RulesQuery = {
  ...GalleryFilterQuery.properties,
  q: Type.Optional(Type.String({ maxLength: 500, description: "The Gallery's search text" })),
};

// The Gallery's own query params, so a saved album reads exactly like the Gallery it came from.
// Version 2 holds the filters that take several values as lists; version 1 held single values.
export const SmartAlbumRules = Type.Object(
  { version: Type.Literal(2), query: Type.Object(RulesQuery, { additionalProperties: false }) },
  { additionalProperties: false, description: "The Gallery filters and search a smart album matches" },
);
export type SmartAlbumRules = Static<typeof SmartAlbumRules>;

// A list, or the single value version 1 held. Only the shape is checked here: the values are
// checked against SmartAlbumRules once upgraded (smartRulesError).
const OneOrMany = Type.Optional(Type.Union([Type.Array(Type.String(), { maxItems: 500 }), Type.String()]));

/** What a client may send: version 2, or a version 1 set (older clients and saved links). */
export const SmartAlbumRulesInput = Type.Object(
  {
    version: Type.Union([Type.Literal(1), Type.Literal(2)]),
    query: Type.Object(
      {
        ...RulesQuery,
        regionId: OneOrMany,
        tag: OneOrMany,
        place: OneOrMany,
        tripId: OneOrMany,
        albumId: OneOrMany,
        tier: OneOrMany,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, description: "The Gallery filters and search a smart album matches" },
);
export type SmartAlbumRulesInput = Static<typeof SmartAlbumRulesInput>;

/** Rules as version 2 holds them, upgrading a stored or sent version 1 set. The result is checked
 *  by smartRulesError, so a value that isn't a valid id is refused there, not here. */
export function upgradeRules(rules: SmartAlbumRulesInput): SmartAlbumRules {
  return { version: 2, query: upgradeRulesQuery(rules.query) as SmartAlbumRules["query"] };
}

/** A stored rules value as version 2: rows saved before filters took lists hold version 1. */
export function storedRules(raw: SmartAlbumRulesInput | null): SmartAlbumRules | null {
  return raw ? upgradeRules(raw) : null;
}

/** The upgraded rules, or why they can't be saved: a value that isn't valid, or a date that
 *  doesn't exist. */
export function checkedRules(input: SmartAlbumRulesInput): { rules: SmartAlbumRules } | { error: string } {
  const rules = upgradeRules(input);
  if (!Value.Check(SmartAlbumRules, rules)) return { error: "These rules aren't valid filters" };
  const error = smartRulesError(rules);
  return error ? { error } : { rules };
}

/** Why a rule set can't be saved (a date that doesn't exist), or null when it can. */
export function smartRulesError(rules: SmartAlbumRules): string | null {
  const filters = parseGalleryFilters(rules.query);
  return "error" in filters ? filters.error : null;
}

/** Ids only, for counts, covers and membership: a full row costs about 1KB to build and send,
 *  which for a smart album of a whole library is seconds. Same joins, so the same photos. */
export type AlbumMember = Pick<GalleryRow, "capture_id" | "photo_id">;
export const ALBUM_MEMBER_COLUMNS = "c.id AS capture_id, p.id AS photo_id";

/** The owner's photos the rules match, ordered as the Gallery shows them: newest first, or best
 *  match first with search text. `columns` as listGalleryRows; a search always returns full rows. */
export async function smartAlbumRows<T extends AlbumMember = GalleryRow>(
  rules: SmartAlbumRules,
  userId: string,
  seenAlbums: ReadonlySet<string> = new Set(),
  columns?: string,
): Promise<T[]> {
  const { q, ...filterQuery } = rules.query;
  const filters = await galleryFiltersFor(filterQuery, userId, seenAlbums);
  // Rules are checked on save, so this only guards a hand-edited row.
  if ("error" in filters) return [];
  const text = q?.trim() ?? "";
  // The Gallery ignores search text under three characters too.
  if (text.length < 3) return listGalleryRows<T>(userId, filters, columns);
  // Album names stay out of the search: "Lifers" saved as a search for "lifers" would otherwise
  // scope to itself, and renaming any album would change what this one holds.
  const outcome = await searchGallery(userId, text, filters, { ignoreAlbumNames: true });
  // Full rows, which carry every narrower column too.
  return (outcome?.items.map((i) => i.row) ?? []) as unknown as T[];
}
