import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LiferApiError, type LiferClient, type Query } from "./client.js";

// Most photos one call may add to an album: a larger change is several calls, each one undo step.
export const MAX_PHOTOS_PER_CALL = 200;
const PAGE = 25;

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failure = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });

/** Wraps a handler so an API problem comes back as a tool error the assistant can read. */
function guarded<A>(run: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return text(await run(args));
    } catch (err) {
      return failure(err instanceof LiferApiError ? err.message : "Couldn't reach Lifer. Is it running?");
    }
  };
}

interface PhotoRow {
  captureId: string;
  commonName: string | null;
  scientificName: string;
  takenAt: string | null;
  regionName: string | null;
  qualityRating: number | null;
  tags: string[];
}
const brief = (p: PhotoRow) => ({
  captureId: p.captureId,
  species: p.commonName ?? p.scientificName,
  scientificName: p.scientificName,
  takenAt: p.takenAt,
  place: p.regionName,
  rating: p.qualityRating,
  tags: p.tags,
});

// Filters every list tool shares; each list repeats its parameter, so one value of a list matches.
const filterShape = {
  regionIds: z.array(z.string()).optional().describe("Region ids; a photo in any one matches"),
  tags: z.array(z.string()).optional(),
  tripIds: z.array(z.string()).optional(),
  albumIds: z.array(z.string()).optional(),
  tiers: z.array(z.enum(["legendary", "rare", "uncommon", "occasional", "common"])).optional(),
  taxa: z.string().optional().describe("Comma-separated taxon classes, e.g. aves,mammalia"),
  ratingMin: z.enum(["1", "2", "3", "4", "5"]).optional(),
  ratingMax: z.enum(["1", "2", "3", "4", "5"]).optional(),
  dateFrom: z.string().optional().describe("YYYY-MM-DD"),
  dateTo: z.string().optional().describe("YYYY-MM-DD"),
};
type Filters = { [K in keyof typeof filterShape]?: z.infer<(typeof filterShape)[K]> };

export function filterQuery(f: Filters): Query {
  return {
    regionId: f.regionIds,
    tag: f.tags,
    tripId: f.tripIds,
    albumId: f.albumIds,
    tier: f.tiers,
    taxa: f.taxa,
    ratingMin: f.ratingMin,
    ratingMax: f.ratingMax,
    dateFrom: f.dateFrom,
    dateTo: f.dateTo,
  };
}

/** The rules a smart album takes: the same filters, as query values. */
export function smartRules(f: Filters & { query?: string }) {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(filterQuery(f)))
    if (value !== undefined) query[key] = Array.isArray(value) ? [...(value as string[])] : String(value);
  if (f.query) query.q = f.query;
  return { version: 2 as const, query };
}

export function createServer(client: LiferClient): McpServer {
  const server = new McpServer({ name: "lifer", version: "0.12.0" });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    "search_photos",
    {
      description:
        "Find photos in the Lifer library by text (species, place, scene) and/or filters. Returns the newest matches first, 25 at a time.",
      inputSchema: { query: z.string().optional().describe("Words to search for"), ...filterShape },
      annotations: readOnly,
    },
    guarded(async ({ query, ...filters }) => {
      const path = query ? "/gallery/search" : "/gallery";
      const res = await client.get<{ items: PhotoRow[]; total?: number }>(path, {
        ...filterQuery(filters),
        ...(query ? { q: query } : { limit: PAGE }),
      });
      return { total: res.total ?? null, photos: res.items.slice(0, PAGE).map(brief) };
    }),
  );

  server.registerTool(
    "find_species",
    {
      description: "Search species by common or scientific name.",
      inputSchema: { query: z.string().min(1), regionId: z.string().optional() },
      annotations: readOnly,
    },
    guarded(async ({ query, regionId }) => {
      const res = await client.get<{ results: unknown[] }>("/species", { q: query, regionId });
      return res.results.slice(0, PAGE);
    }),
  );

  server.registerTool(
    "get_species",
    {
      description: "One species with the user's photos of it.",
      inputSchema: { speciesId: z.string() },
      annotations: readOnly,
    },
    guarded(async ({ speciesId }) => {
      const res = await client.get<{ species: Record<string, unknown>; captures: unknown[]; userSpecies: unknown }>(
        `/species/${encodeURIComponent(speciesId)}`,
      );
      const { species } = res;
      return {
        id: species.id,
        scientificName: species.scientific_name,
        commonName: species.common_name,
        family: species.family,
        tier: species.tier,
        userSpecies: res.userSpecies,
        photoCount: res.captures.length,
      };
    }),
  );

  server.registerTool(
    "life_list",
    {
      description: "The life list: every species photographed (or seen), with first and last dates and photo counts.",
      inputSchema: { taxonClass: z.string().optional().describe("e.g. aves") },
      annotations: readOnly,
    },
    guarded(async ({ taxonClass }) => (await client.get<{ species: unknown[] }>("/life-list", { taxonClass })).species),
  );

  server.registerTool(
    "life_list_summary",
    {
      description:
        "Totals for the life list: species, photos, new this year, the latest lifer. Optionally for one region.",
      inputSchema: { regionId: z.string().optional() },
      annotations: readOnly,
    },
    guarded(({ regionId }) => client.get("/life-list/summary", { regionId })),
  );

  server.registerTool(
    "list_albums",
    {
      description: "All albums, with their photo counts. A smart album has rules.",
      inputSchema: {},
      annotations: readOnly,
    },
    guarded(async () => {
      const res = await client.get<{
        albums: Array<{ id: string; name: string; captureCount: number; rules: unknown }>;
      }>("/albums");
      return res.albums.map((a) => ({
        id: a.id,
        name: a.name,
        photos: a.captureCount,
        smart: a.rules !== null,
        rules: a.rules,
      }));
    }),
  );

  server.registerTool(
    "suggested_smart_albums",
    {
      description: "Smart albums worth making from the user's photos. Nothing is created.",
      inputSchema: {},
      annotations: readOnly,
    },
    guarded(async () => {
      const res = await client.get<{ suggestions: Array<{ name: string; photoCount: number; rules: unknown }> }>(
        "/albums/suggestions",
      );
      return res.suggestions.map(({ name, photoCount, rules }) => ({ name, photoCount, rules }));
    }),
  );

  server.registerTool(
    "list_trips",
    { description: "All trips, with species and photo counts and dates.", inputSchema: {}, annotations: readOnly },
    guarded(async () => {
      const res = await client.get<{ trips: Array<Record<string, unknown>> }>("/trips");
      return res.trips.map((t) => ({
        id: t.id,
        name: t.name,
        species: t.speciesCount,
        photos: t.captureCount,
        from: t.earliestTakenAt,
        to: t.latestTakenAt,
      }));
    }),
  );

  server.registerTool(
    "trip_summary",
    {
      description: "A trip's species, lifer, rare and endemic counts.",
      inputSchema: { tripId: z.string() },
      annotations: readOnly,
    },
    guarded(({ tripId }) => client.get(`/trips/${encodeURIComponent(tripId)}/summary`)),
  );

  server.registerTool(
    "library_stats",
    {
      description: "Statistics about the library: keepers, insights, gear, time of day and countries.",
      inputSchema: {},
      annotations: readOnly,
    },
    guarded(async () => {
      const s = await client.get<Record<string, unknown>>("/stats");
      return { totalKeepers: s.totalKeepers, insights: s.insights, countriesPhotographed: s.countriesPhotographed };
    }),
  );

  // Writes. Each records how to undo itself, so "undo_last_change" reverses exactly one change.
  async function record(summary: string, undo: unknown[]): Promise<void> {
    await client.post("/changes", { summary, undo });
  }
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  server.registerTool(
    "create_album",
    {
      description: "Create an empty album. Undo with undo_last_change.",
      inputSchema: { name: z.string().min(1).max(200) },
      annotations: write,
    },
    guarded(async ({ name }) => {
      const album = await client.post<{ id: string }>("/albums", { name });
      await record(`Created the album "${name}"`, [{ op: "deleteAlbum", albumId: album.id }]);
      return { albumId: album.id, name };
    }),
  );

  server.registerTool(
    "create_smart_album",
    {
      description:
        "Create a smart album that fills itself with every photo matching the search and filters, including photos imported later. Undo with undo_last_change.",
      inputSchema: { name: z.string().min(1).max(200), query: z.string().optional(), ...filterShape },
      annotations: write,
    },
    guarded(async ({ name, ...rest }) => {
      const album = await client.post<{ id: string }>("/albums", { name, rules: smartRules(rest) });
      await record(`Created the smart album "${name}"`, [{ op: "deleteAlbum", albumId: album.id }]);
      return { albumId: album.id, name };
    }),
  );

  server.registerTool(
    "add_photos_to_album",
    {
      description: `Add photos (by captureId) to a hand-picked album, up to ${MAX_PHOTOS_PER_CALL} per call. One call is one undo step.`,
      inputSchema: {
        albumId: z.string(),
        captureIds: z.array(z.string()).min(1).max(MAX_PHOTOS_PER_CALL),
      },
      annotations: write,
    },
    guarded(async ({ albumId, captureIds }) => {
      // Only the photos that weren't there already are undone, so undo never removes older members.
      const inAlbum = new Set((await client.get<{ captureIds: string[] }>("/gallery/ids", { albumId })).captureIds);
      const added = [...new Set(captureIds)].filter((id) => !inAlbum.has(id));
      await client.post(`/albums/${encodeURIComponent(albumId)}/captures`, { captureIds });
      if (added.length > 0)
        await record(`Added ${added.length} photo${added.length === 1 ? "" : "s"} to an album`, [
          { op: "removeFromAlbum", albumId, captureIds: added },
        ]);
      return { requested: captureIds.length, newlyAdded: added.length };
    }),
  );

  server.registerTool(
    "undo_last_change",
    {
      description: "Undo the newest change an assistant made through Lifer that hasn't been undone yet.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    guarded(async () => {
      const res = await client.post<{ undone: { summary: string } | null }>("/changes/undo-last");
      return res.undone ? { undone: res.undone.summary } : { undone: null, note: "Nothing to undo" };
    }),
  );

  return server;
}
