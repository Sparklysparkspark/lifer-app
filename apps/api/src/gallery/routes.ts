// A browsable gallery of every photo you've taken, across all species — separate from the
// per-species detail view, for just scrolling your own collection like a photo library.
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireScope } from "../auth/session.js";
import { cosineSimilarity } from "../species/embeddings.js";
import { embedQueryText } from "../species/textEmbedding.js";
import { EMBEDDING_MODEL_VERSION } from "../config.js";
import { TAXON_WORD_TO_CLASS } from "./searchTaxonSynonyms.js";

const SEARCH_RESULT_LIMIT = 100;

// Skipped when tokenizing a query for subject-word detection — short/connector words that
// would otherwise either falsely "consume" as a leftover descriptor or (for very short ones)
// risk a coincidental substring hit against an unrelated species name.
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "in",
  "on",
  "at",
  "with",
  "and",
  "or",
  "my",
  "to",
  "is",
  "are",
  "some",
]);

// Splits a name/alias into whole words for token-level matching — a raw substring check (the
// previous approach) let "crow" match "Yellow-Crown Warbler" (the alias literally contains
// "Crown", whose first four letters are "crow"), pulling warbler photos into every crow search.
// Splitting on anything that isn't a letter/digit means a hyphenated compound name's parts
// ("Fish-Crow") are each their own comparable word, while an embedded fragment inside a longer
// word ("Crown") never is.
function wordsOf(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// Cheap, deliberately approximate English suffix-stripping — covers two common ways a query
// and a name/alias can share the same root but not the same exact word: plain plurals ("foxes"
// needs to match a species literally named "Fox", and vice versa), and the "-ed" adjectival
// form bird names constantly use ("crowned" needs to match an alias that says "Crown" —
// "Golden-Crowned", "Ruby-Crowned", "Red-Crowned" etc. are common real species-name patterns,
// and "Yellow-Crown Warbler" is exactly this alias for Yellow-Rumped Warbler). Without this,
// wording alone (plural vs singular, noun vs adjective form of the same root) silently sends a
// query down an entirely different code path with different filtering behavior, rather than
// being treated as a harmless variant of the exact same search. Not a real lemmatizer
// (irregular forms aren't handled, and a short word ending in "ed"/"s" by coincidence — "Red",
// length 3 — is protected by the length guards below rather than actually detected) — good
// enough for the common cases this exists for, matching this codebase's existing tolerance for
// approximate-but-useful heuristics elsewhere (word-width estimates, gap-based relevance
// cutoffs) over a heavier, more "correct" dependency.
function normalizeWordForm(word: string): string {
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 2 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}
function wordMatches(word: string, token: string): boolean {
  return word === token || normalizeWordForm(word) === normalizeWordForm(token);
}

// Escapes regex metacharacters so a raw user query can be safely interpolated into a Postgres
// regex pattern (used below for word-boundary matching via `~*`) without a stray `.`/`*`/`(` in
// what's typed turning into an unintended pattern or a query error.
function escapeRegexForPostgres(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Plain CLIP content search (no recognized subject, no name match) has no subject filter to
// scope the candidate set — every capture in the library is a candidate, ranked by raw cosine
// similarity with nothing dropped. This codebase's own testing found genuine matches can score
// as low as ~0.19, so a fixed floor was deliberately removed (see the content-search comment
// below) — but with NO cutoff at all, "eating" or "mouse" just re-sorted the entire gallery
// instead of narrowing it, and a query matching NOTHING in the library (e.g. "tiger" with no
// tiger photos) still came back with the whole gallery re-sorted rather than "no results" —
// every capture always gets SOME nonzero similarity, so a cutoff relative only to the best
// score in THIS result set can never come back empty, no matter how irrelevant everything is.
//
// A statistical outlier test fixes both problems at once: treat this query's own score
// distribution as its noise floor, and only keep results that stand out meaningfully above it
// (mean + Z_SCORE_THRESHOLD standard deviations), rather than a fixed floor or a ratio to the
// top score. When a query has real matches, those scores break away from the rest of the
// library's shared baseline and post a high z-score; when nothing in the library is actually
// relevant, every score is just noise clustered around the same mean with low spread, so
// nothing clears the bar and the result set is correctly empty. Worth recalibrating once
// there's real usage to tune the threshold against, same as DESCRIPTOR_RELATIVE_CUTOFF's own
// comment above.
const CONTENT_SEARCH_Z_SCORE_THRESHOLD = 1.0;
function filterToRelevantContentMatches<T extends { score: number }>(rankedDescending: T[]): T[] {
  const n = rankedDescending.length;
  if (n === 0) return rankedDescending;
  const mean = rankedDescending.reduce((sum, r) => sum + r.score, 0) / n;
  const variance = rankedDescending.reduce((sum, r) => sum + (r.score - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  // Zero variance means nothing here stands out from anything else — but that reads two
  // opposite ways depending on how many candidates there are. Across the WHOLE library (large
  // n), it means no real signal at all, so nothing should come back. But a tiny candidate set
  // (e.g. exactly one name-matched backfill candidate) is trivially "zero variance" too (one
  // point has nothing to differ from), and there it isn't meaningful to treat that as "nothing
  // relevant." Failing OPEN (return everything) rather than closed when there's nothing to
  // discriminate on is correct either way: for a real "nothing matches" query the threshold
  // check below would have excluded everything anyway once there IS real variance to measure.
  if (stddev === 0) return rankedDescending;
  return rankedDescending.filter((r) => (r.score - mean) / stddev >= CONTENT_SEARCH_Z_SCORE_THRESHOLD);
}

// "600mm" (or "600 mm") is a focal-length lookup, not a name or content query — parsed out
// before either of those paths runs. A ±FOCAL_TOLERANCE band (not an exact match) since nobody
// remembers/means their exact focal length; ranked by closeness to the typed number.
const FOCAL_LENGTH_PATTERN = /(\d{2,4})\s*mm\b/i;
const FOCAL_TOLERANCE = 0.2;

// Deciding "is this a name search" needs to be conservative: the species-picker's own search
// (/species) can afford pg_trgm's default 0.3 similarity threshold for the `%` operator because
// a bad match there just ranks low in a list the user is already scanning by eye. Here, a match
// SWITCHES THE WHOLE SEARCH MODE — a coincidental weak trigram hit between a typed content word
// (e.g. "flying") and some unrelated species name would silently hijack a content search into a
// (wrong, probably empty) name search instead of ever reaching CLIP. Requiring a real substring
// (ILIKE) or a substantially higher similarity (0.5, well above the fuzzy default) keeps short
// content words from accidentally tripping this.
const NAME_MATCH_MIN_SIMILARITY = 0.5;

// Shared by both routes below: species/taxon columns + the RAW/original bookkeeping every
// gallery item needs, as one string so a taxon filter or the "include RAW-derived photos"
// toggle never has to be wired into just one of the two endpoints and not the other.
export const GALLERY_ITEM_COLUMNS = `
  c.id AS capture_id, p.id AS photo_id, p.width, p.height, c.species_id, s.scientific_name, s.common_name, s.taxon_class,
  c.taken_at, c.created_at, c.camera_model, c.lens, c.focal_length_mm, c.aperture, c.shutter, c.iso, c.quality_rating,
  c.lat, c.lon,
  (p.id = us.cover_photo_id) AS is_featured,
  EXISTS (SELECT 1 FROM originals ro WHERE ro.capture_id = c.id AND ro.kind = 'raw') AS has_raw_original,
  o.ref AS original_ref, o.managed AS original_managed, o.kind AS original_kind
`;
export const GALLERY_ITEM_JOINS = `
  JOIN photos p ON p.id = c.current_photo_id
  JOIN species s ON s.id = c.species_id
  LEFT JOIN user_species us ON us.user_id = c.user_id AND us.species_id = c.species_id
  -- jpeg-preferred tiebreak (same as SpeciesDetailPage's own capture query) — original_kind
  -- from THIS row is what "include RAW-derived photos" filters against: a capture whose only
  -- original is a RAW file has no jpeg to win the tiebreak, so this resolves to 'raw'.
  LEFT JOIN LATERAL (
    SELECT * FROM originals lo WHERE lo.capture_id = c.id ORDER BY (lo.kind = 'jpeg') DESC LIMIT 1
  ) o ON true
`;

export async function galleryRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { q?: string; onlyTopRated?: string; onlyFeatured?: string; taxa?: string; includeRaw?: string };
  }>("/gallery/search", { preHandler: requireScope("gallery.read") }, async (request) => {
    const userId = request.user!.id;
    const q = request.query.q?.trim();
    if (!q) return { items: [] };
    // Same filters as the plain (unsearched) /gallery listing — previously only taxa/includeRaw
    // were honored here, so switching to a text search silently dropped whatever Top rated /
    // Featured filter was already checked, with no indication the search had widened past them.
    const onlyTopRated = request.query.onlyTopRated === "1";
    const onlyFeatured = request.query.onlyFeatured === "1";
    const taxa = request.query.taxa?.split(",").filter(Boolean) ?? [];
    // Defaults to including everything — this only narrows the result set when the caller
    // explicitly asks to hide RAW-derived photos, never silently drops photos by default.
    const includeRaw = request.query.includeRaw !== "0";
    const ratingFeaturedClause = `${onlyTopRated ? "AND c.quality_rating = 5" : ""} ${onlyFeatured ? "AND p.id = us.cover_photo_id" : ""}`;

    const focalMatch = q.match(FOCAL_LENGTH_PATTERN);
    if (focalMatch) {
      const target = Number(focalMatch[1]);
      const res = await pool.query(
        `SELECT ${GALLERY_ITEM_COLUMNS}
           FROM captures c
           ${GALLERY_ITEM_JOINS}
           WHERE c.user_id = $1
             AND c.focal_length_mm IS NOT NULL
             AND c.focal_length_mm BETWEEN $2 * (1 - $3) AND $2 * (1 + $3)
             ${ratingFeaturedClause}
             ${taxa.length > 0 ? "AND s.taxon_class = ANY($4)" : ""}
             ${includeRaw ? "" : "AND o.kind IS DISTINCT FROM 'raw'"}`,
        taxa.length > 0 ? [userId, target, FOCAL_TOLERANCE, taxa] : [userId, target, FOCAL_TOLERANCE],
      );
      const scored = res.rows
        .map((row) => ({ row, score: 1 - Math.abs(Number(row.focal_length_mm) - target) / target }))
        .sort((a, b) => b.score - a.score);
      return { items: scored.slice(0, SEARCH_RESULT_LIMIT).map(({ row, score }) => toGalleryItem(row, score)) };
    }

    // Postgres's `\y` is a word-boundary anchor (like `\b` elsewhere) — matching "crow" against
    // this instead of a raw `ILIKE '%crow%'` is what stops it from matching inside "Crown" (the
    // boundary right after "crow" only exists when the next character isn't itself a word
    // character, which is true in "Crow" but not in "Crown"). $2 (the raw query) still feeds
    // the fuzzy-typo `similarity()` calls below unchanged — only the literal/exact checks move
    // to this word-bounded pattern.
    const wordBoundaryPattern = `\\y${escapeRegexForPostgres(q)}\\y`;
    // Fuzzy trigram similarity is only a meaningful "did they mean this" signal for a SINGLE
    // typo'd word ("pilated" for "Pileated") — pg_trgm's similarity() scores the WHOLE query
    // string against the WHOLE name as one blob, so a multi-word query sharing just one real
    // word with an unrelated species inflates the combined score even when the other word(s)
    // don't correspond at all. Confirmed live: similarity('common hawk', 'Common Nighthawk')
    // scores 0.53 — comfortably over the 0.5 floor — purely because they share "common"; Common
    // Nighthawk isn't a hawk and was never the intended match. Disabling the fuzzy clause for
    // any multi-word query (by handing it a threshold no real similarity() score can reach)
    // leaves it doing what it was actually designed for — single-word typo tolerance — without
    // multi-word queries hijacking it via a partial, coincidental word overlap.
    const nameMatchMinSimilarity = /\s/.test(q.trim()) ? 2 : NAME_MATCH_MIN_SIMILARITY;
    // `\m` is a word-START anchor only (no matching anchor required at the end) — this is what
    // still lets "pil" find "Pileated Woodpecker" (a genuinely truncated, still-being-typed
    // word) even though it's not a whole word on its own. Used ONLY as a fallback tier in JS
    // below, consulted exclusively when nothing matched at the stronger word-boundary tier —
    // "crow" already whole-word-matches "American Crow", so this prefix tier (which "crow" would
    // ALSO match against "Crowned" — a prefix match doesn't know the difference) never even gets
    // consulted for that query. Only a query with no real whole-word competitor falls back to it.
    const prefixPattern = `\\m${escapeRegexForPostgres(q)}`;
    const res = await pool.query(
      `SELECT ${GALLERY_ITEM_COLUMNS},
                ce.embedding,
                s.common_name_aliases, s.aba_code, s.ebird_code,
                (
                  s.common_name ~* $5 OR s.scientific_name ~* $5
                  OR EXISTS (SELECT 1 FROM unnest(s.common_name_aliases) a WHERE a ~* $5)
                  OR upper(s.aba_code) = upper($2) OR upper(s.ebird_code) = upper($2)
                ) AS literal_match,
                (
                  s.common_name ~* $5 OR s.scientific_name ~* $5
                  OR EXISTS (SELECT 1 FROM unnest(s.common_name_aliases) a WHERE a ~* $5)
                  OR similarity(s.common_name, $2) >= $4 OR similarity(s.scientific_name, $2) >= $4
                  OR EXISTS (SELECT 1 FROM unnest(s.common_name_aliases) a WHERE similarity(a, $2) >= $4)
                  OR upper(s.aba_code) = upper($2) OR upper(s.ebird_code) = upper($2)
                ) AS name_match,
                (
                  s.common_name ~* $6 OR s.scientific_name ~* $6
                  OR EXISTS (SELECT 1 FROM unnest(s.common_name_aliases) a WHERE a ~* $6)
                ) AS prefix_match,
                GREATEST(
                  similarity(s.common_name, $2),
                  similarity(s.scientific_name, $2),
                  COALESCE((SELECT MAX(similarity(a, $2)) FROM unnest(s.common_name_aliases) a), 0),
                  CASE WHEN upper(s.aba_code) = upper($2) OR upper(s.ebird_code) = upper($2) THEN 1 ELSE 0 END
                ) AS name_score
         FROM captures c
         ${GALLERY_ITEM_JOINS}
         JOIN capture_embeddings ce ON ce.capture_id = c.id AND ce.model_version = $3
         WHERE c.user_id = $1
           ${ratingFeaturedClause}
           ${taxa.length > 0 ? "AND s.taxon_class = ANY($7)" : ""}
           ${includeRaw ? "" : "AND o.kind IS DISTINCT FROM 'raw'"}`,
      taxa.length > 0
        ? [userId, q, EMBEDDING_MODEL_VERSION, nameMatchMinSimilarity, wordBoundaryPattern, prefixPattern, taxa]
        : [userId, q, EMBEDDING_MODEL_VERSION, nameMatchMinSimilarity, wordBoundaryPattern, prefixPattern],
    );

    // A THIRD kind of query embeds a real subject alongside a scene description — "fox playing",
    // "water aves" — that neither the name-match path below (the whole string never literally
    // names a species) nor a bare content search (ranks the ENTIRE library, so an unrelated
    // photo that happens to score well against "playing" can still surface a bird for a fox
    // query) handles correctly. Every capture already carries a definitively known species/
    // taxon_class — used here as a hard, exact filter before CLIP ever runs, rather than as
    // just another ranking signal, so an off-subject photo is excluded outright instead of
    // merely ranked lower. A query with no recognized subject word at all (e.g. "sunset") falls
    // through untouched to the ordinary content search below. A query that's ENTIRELY a subject
    // (just "fox", or "aves") is also handled right here (sorted like an ordinary name match,
    // just without that path's fuzzy-typo trigram fallback) rather than falling through — a
    // typo'd single-species search (no literal substring match) is the one case that still needs
    // the old path's trigram tolerance, and it does: hasSubject stays false for that case.
    //
    // Only reached when the query ISN'T already a name match on its own — "common nighthawk" is
    // a real bug this guards against: BOTH "common" (matches every "Common ___" species) and
    // "nighthawk" (matches Common Nighthawk) are independently real whole-word subject hits, so
    // per-token matching below unions them into "every Common-anything species," exactly the
    // same broad list plain "common" alone returns — drowning out the tight, correct answer the
    // whole-query name-match path below would give ("Common Nighthawk" literally IS the name).
    // A multi-word species name should resolve as ONE compound match, not several independent
    // single-word subjects OR'd together, and the name-match path already does exactly that
    // (it tests the query as one literal phrase) — so it gets first refusal whenever it has a
    // real answer, and this block is the fallback for when it doesn't.
    const hasWholeQueryNameMatch = res.rows.some((row) => row.name_match);
    if (!hasWholeQueryNameMatch) {
      const rawTokens = q
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter(Boolean);
      const matchedTaxonClasses = new Set<string>();
      const matchedSpeciesIds = new Set<string>();
      const subjectTokenIndexes = new Set<number>();
      for (let i = 0; i < rawTokens.length; i++) {
        const token = rawTokens[i];
        if (STOPWORDS.has(token) || token.length < 3) continue;
        const bigram = i + 1 < rawTokens.length ? `${token} ${rawTokens[i + 1]}` : null;
        const taxonClass = (bigram && TAXON_WORD_TO_CLASS.get(bigram)) || TAXON_WORD_TO_CLASS.get(token);
        if (taxonClass) {
          matchedTaxonClasses.add(taxonClass);
          subjectTokenIndexes.add(i);
          if (bigram && TAXON_WORD_TO_CLASS.get(bigram)) subjectTokenIndexes.add(i + 1);
          continue;
        }
        // Species-name token match against species already present in this result set — a
        // capture's own row already carries its species' common/scientific name (and aliases —
        // old names, alternate spellings — the same three fields the whole-query name-match
        // path below checks), so this needs no extra query. WHOLE-WORD match (not raw substring)
        // at the token level: a plain substring check made "crow" match the alias "Yellow-Crown
        // Warbler" (the first four letters of "Crown"), pulling every warbler photo into a Crow
        // search — exact-enough for real words like "fox"/"duck" still works fine as a whole-
        // word match, and the whole-query trigram path below still covers a typo'd single-
        // species search.
        let matchedAny = false;
        for (const row of res.rows) {
          const common = String(row.common_name ?? "").toLowerCase();
          const sci = String(row.scientific_name ?? "").toLowerCase();
          const aliases = (row.common_name_aliases as string[] | null) ?? [];
          // ABA/eBird codes are short, exact identifiers, not prose — an equality check (not a
          // substring one) so a 4-letter code doesn't spuriously match as a fragment of some
          // unrelated longer word elsewhere in the query.
          const abaCode = String(row.aba_code ?? "").toLowerCase();
          const ebirdCode = String(row.ebird_code ?? "").toLowerCase();
          if (
            wordsOf(common).some((w) => wordMatches(w, token)) ||
            wordsOf(sci).some((w) => wordMatches(w, token)) ||
            aliases.some((a) => wordsOf(a).some((w) => wordMatches(w, token))) ||
            (abaCode && abaCode === token) ||
            (ebirdCode && ebirdCode === token)
          ) {
            matchedSpeciesIds.add(String(row.species_id));
            matchedAny = true;
          }
        }
        // Fallback tier, consulted only when this specific token matched NO whole word at all —
        // a genuinely truncated word being typed ("pil" for "Pileated Woodpecker") has no
        // whole-word competitor here to lose to, so a prefix match is trusted the same way. A
        // token that DID whole-word-match (like "crow" against "American Crow") never reaches
        // this, so it can't also pull in "Yellow-Crowned Warbler" via the "crow" ⊂ "Crowned"
        // prefix overlap the way a plain substring check would.
        if (!matchedAny) {
          for (const row of res.rows) {
            const common = String(row.common_name ?? "").toLowerCase();
            const sci = String(row.scientific_name ?? "").toLowerCase();
            const aliases = (row.common_name_aliases as string[] | null) ?? [];
            if (
              wordsOf(common).some((w) => w.startsWith(token)) ||
              wordsOf(sci).some((w) => w.startsWith(token)) ||
              aliases.some((a) => wordsOf(a).some((w) => w.startsWith(token)))
            ) {
              matchedSpeciesIds.add(String(row.species_id));
              matchedAny = true;
            }
          }
        }
        if (matchedAny) subjectTokenIndexes.add(i);
      }
      const hasSubject = matchedTaxonClasses.size > 0 || matchedSpeciesIds.size > 0;
      const hasLeftoverDescriptor = rawTokens.some(
        (token, i) => token.length >= 3 && !STOPWORDS.has(token) && !subjectTokenIndexes.has(i),
      );
      if (hasSubject) {
        const candidates = res.rows.filter(
          (row) => matchedSpeciesIds.has(String(row.species_id)) || matchedTaxonClasses.has(String(row.taxon_class)),
        );
        let scored: Array<{ row: (typeof res.rows)[number]; score: number }>;
        if (!hasLeftoverDescriptor) {
          // Pure subject query ("fox", "water birds" minus "water" not recognized — falls
          // here too) — no scene description to rank by, so sort the same way an ordinary
          // name-match result does.
          scored = candidates
            .map((row) => ({ row, score: 1 }))
            .sort((a, b) => (b.row.quality_rating ?? 0) - (a.row.quality_rating ?? 0));
        } else {
          const queryEmbedding = await embedQueryText(q);
          // Rank ALL subject-matched candidates by descriptor score — no cutoff. Two different
          // statistical filters were tried and tested against real data here (a z-score test,
          // then a largest-score-gap test), and EACH broke on a different near-synonymous
          // rewording of the exact same query: the z-score test dropped real fox photos between
          // "fox play" and "fox playing" (its own mean/spread shifted enough to flip which
          // photos cleared it); the gap test then fixed that case, but broke on "fox playing"
          // vs "foxes playing" instead — confirmed live, same 11 candidate fox photos, but
          // "foxes playing" scored one photo so much higher than the rest that the "real" gap
          // landed in a completely different place, keeping only 1 of the photos "fox playing"
          // correctly kept 8 of. That's not a bug in either filter individually — it's evidence
          // that CLIP's cross-modal similarity for near-synonymous text against a small,
          // visually homogeneous candidate set (11 photos of one species) just doesn't have a
          // stable, wording-independent separation margin to threshold on. A third heuristic
          // would likely break on the next paraphrase too. Every candidate here is ALREADY a
          // confirmed real subject match — showing all of them, best descriptor match first,
          // means wording can shift the ORDER but can never make a real photo silently vanish.
          scored = candidates
            .map((row) => ({ row, score: cosineSimilarity(queryEmbedding, row.embedding) }))
            .sort((a, b) => b.score - a.score);
        }
        const limited = scored.slice(0, SEARCH_RESULT_LIMIT);
        return { items: limited.map(({ row, score }) => toGalleryItem(row, score)) };
      }
    }

    // Two different kinds of query need two different matching strategies: "pil" or "mallard"
    // are NAME lookups (the user knows what species they want), while "fox playing" is a
    // CONTENT lookup (no species is literally named that). Pure semantic (CLIP) matching got
    // both wrong — a short/partial name string isn't a meaningful phrase to CLIP's text
    // encoder, so "pil" scored better against an unrelated fox photo than the actual Pileated
    // Woodpecker.
    //
    // A hard minimum-similarity floor was tried here to keep a name search's tail from
    // reading as "unrelated photos in my results" — but CLIP's raw cosine similarities for
    // genuinely correct matches run much lower than intuition suggests (a real fox-eating-prey
    // photo scored ~0.19 against "eating" in testing) — well below any floor that would
    // meaningfully trim noise, so a floor just silently deleted real matches instead. Removed:
    // rank order (not the absolute score) is what actually matters for semantic search.
    //
    // Name and content matches are NOT always mutually exclusive, even though a query only
    // ever triggers one search MODE. Treating them as always exclusive was a real bug:
    // searching "mouse" hit name_match for every actual Mouse-species photo (common names
    // routinely contain ordinary words like this), which used to skip CLIP scoring entirely —
    // so a fox-eating-a-mouse photo (species: Red Fox, not any "Mouse" species) never got a
    // chance to match on its actual content.
    //
    // But backfilling content matches unconditionally swung too far the other way: "duck"
    // legitimately matches a couple dozen real Duck-species photos by name, and appending
    // every OTHER photo's (noisy, no-floor — see above) content score just to fill out the
    // tail buried real results under irrelevant ones for no benefit — there was never a gap to
    // fill in that case. Only backfill when name matches are actually sparse, which is the
    // real shape of the problem this exists for (a query that coincidentally substring-matches
    // one or two species names, where those matches alone don't reflect what was probably
    // meant). Name matches still always rank first when present, sparse or not.
    const SPARSE_NAME_MATCH_THRESHOLD = 5;
    const hasNameMatch = res.rows.some((row) => row.name_match);
    let scored: Array<{ row: (typeof res.rows)[number]; score: number }>;
    if (hasNameMatch) {
      const nameMatched = res.rows
        .filter((row) => row.name_match)
        .map((row) => ({ row, score: Number(row.name_score) }))
        .sort((a, b) => b.score - a.score || (b.row.quality_rating ?? 0) - (a.row.quality_rating ?? 0));
      // A LITERAL match (the query is an actual substring of the name/alias, or an exact ABA/
      // eBird code) is never coincidental — it's a real, deliberate species lookup regardless of
      // how few photos happen to match it. Searching "crow" with only 2 American Crow photos
      // used to still count as "sparse" and backfill the rest of the library ranked by CLIP
      // similarity to the bare word "crow" — which is exactly how an unrelated Yellow-Rumped
      // Warbler photo once outscored real content and got appended. The sparseness heuristic
      // below is only meant for the OTHER kind of name_match: a fuzzy trigram hit with no literal
      // substring at all (a typo'd search like "pilated" for "Pileated"), where a coincidental,
      // not-actually-intended match really is possible. name_match's own fuzzy-only case is what
      // stays gated by count; a literal hit always stands on its own.
      const hasLiteralMatch = nameMatched.some(({ row }) => row.literal_match);
      if (!hasLiteralMatch && nameMatched.length < SPARSE_NAME_MATCH_THRESHOLD) {
        const nameMatchedIds = new Set(nameMatched.map(({ row }) => row.capture_id));
        const queryEmbedding = await embedQueryText(q);
        const contentMatched = filterToRelevantContentMatches(
          res.rows
            .filter((row) => !nameMatchedIds.has(row.capture_id))
            .map((row) => ({ row, score: cosineSimilarity(queryEmbedding, row.embedding) }))
            .sort((a, b) => b.score - a.score),
        );
        scored = [...nameMatched, ...contentMatched];
      } else {
        scored = nameMatched;
      }
    } else if (res.rows.some((row) => row.prefix_match)) {
      // Fallback tier, only ever consulted when NOTHING matched at the whole-word/fuzzy/code
      // tier above — a genuinely truncated, still-being-typed word ("pil" for "Pileated
      // Woodpecker") has no whole-word competitor to lose to here, so it's trusted the same way
      // a literal match is (no sparse-count gate, no CLIP backfill needed). This is deliberately
      // the LAST resort, not an equal alternative to name_match: prefix_match's own SQL, on its
      // own, would ALSO match "crow" against "Crowned" — but that query already resolved via the
      // whole-word tier above and never reaches this branch at all, which is what keeps this
      // fallback safe to have.
      scored = res.rows
        .filter((row) => row.prefix_match)
        .map((row) => ({ row, score: 1 }))
        .sort((a, b) => (b.row.quality_rating ?? 0) - (a.row.quality_rating ?? 0));
    } else {
      const queryEmbedding = await embedQueryText(q);
      scored = filterToRelevantContentMatches(
        res.rows
          .map((row) => ({ row, score: cosineSimilarity(queryEmbedding, row.embedding) }))
          .sort((a, b) => b.score - a.score),
      );
    }
    const limited = scored.slice(0, SEARCH_RESULT_LIMIT);

    return {
      items: limited.map(({ row, score }) => toGalleryItem(row, score)),
    };
  });

  app.get<{
    Querystring: {
      onlyTopRated?: string;
      onlyFeatured?: string;
      taxa?: string;
      includeRaw?: string;
      missingDate?: string;
    };
  }>("/gallery", { preHandler: requireScope("gallery.read") }, async (request) => {
    const userId = request.user!.id;
    const onlyTopRated = request.query.onlyTopRated === "1";
    const onlyFeatured = request.query.onlyFeatured === "1";
    const taxa = request.query.taxa?.split(",").filter(Boolean) ?? [];
    const includeRaw = request.query.includeRaw !== "0";
    // Drill-down from the Stats page's Archive health card — every capture with no taken_at,
    // so "41 photos missing a date" turns into an actual view to go fix instead of just a
    // number (see PATCH /captures/:id/taken-at, which this view's date input calls).
    const missingDate = request.query.missingDate === "1";

    // "Featured" compares this photo's id against user_species.cover_photo_id for the SAME
    // species — a per-species single pick (set from either SpeciesDetailPage.tsx or this
    // page's own toggle, via PATCH /species/:id/cover), not a photo-level flag of its own.
    const res = await pool.query(
      `SELECT ${GALLERY_ITEM_COLUMNS}
         FROM captures c
         ${GALLERY_ITEM_JOINS}
         WHERE c.user_id = $1
           ${onlyTopRated ? "AND c.quality_rating = 5" : ""}
           ${onlyFeatured ? "AND p.id = us.cover_photo_id" : ""}
           ${missingDate ? "AND c.taken_at IS NULL" : ""}
           ${taxa.length > 0 ? "AND s.taxon_class = ANY($2)" : ""}
           ${includeRaw ? "" : "AND o.kind IS DISTINCT FROM 'raw'"}
         ORDER BY c.taken_at DESC NULLS LAST, c.created_at DESC`,
      taxa.length > 0 ? [userId, taxa] : [userId],
    );

    return { items: res.rows.map((row) => toGalleryItem(row, null)) };
  });
}

// Shared response shape between /gallery and /gallery/search — score is null for the plain
// (unsearched) listing, since "match quality" isn't a meaningful concept there.
export function toGalleryItem(row: Record<string, unknown>, score: number | null) {
  return {
    photoId: row.photo_id,
    width: row.width,
    height: row.height,
    captureId: row.capture_id,
    speciesId: row.species_id,
    scientificName: row.scientific_name,
    commonName: row.common_name,
    taxonClass: row.taxon_class,
    takenAt: row.taken_at,
    cameraModel: row.camera_model,
    lens: row.lens,
    focalLengthMm: row.focal_length_mm,
    aperture: row.aperture,
    shutter: row.shutter,
    iso: row.iso,
    qualityRating: row.quality_rating,
    lat: row.lat,
    lon: row.lon,
    isFeatured: row.is_featured,
    hasRawOriginal: row.has_raw_original,
    originalRef: row.original_ref,
    originalManaged: row.original_managed,
    originalKind: row.original_kind,
    matchScore: score,
  };
}
