// The OpenAPI description of every route an API key can reach, served at GET /api/openapi.json.
// The human guide with recipes is docs/API.md. integrationsDocs.test.ts fails when a route using
// requireScope isn't listed here (or a listed one no longer exists), so this can't silently
// drift from the code.
import { API_KEY_SCOPES } from "../auth/apiKeyRoutes.js";

type Scope = (typeof API_KEY_SCOPES)[number];
type Method = "get" | "post" | "patch" | "put" | "delete";

interface Op {
  scope: Scope;
  summary: string;
  description?: string;
  params?: Array<{ name: string; in?: "query" | "path"; required?: boolean; description: string; schema?: object }>;
  body?: object;
  multipart?: object;
  response?: object;
  binary?: string; // content type of a file response
}

const str = { type: "string" };
const strNull = { type: ["string", "null"] };
const num = { type: "number" };
const numNull = { type: ["number", "null"] };
const int = { type: "integer" };
const intNull = { type: ["integer", "null"] };
const bool = { type: "boolean" };
const uuid = { type: "string", format: "uuid" };
const obj = (properties: Record<string, object>, extra: object = {}) => ({ type: "object", properties, ...extra });
const arr = (items: object) => ({ type: "array", items });
const q = (name: string, description: string, schema: object = str) => ({ name, in: "query" as const, description, schema });

const original = obj({ fileName: strNull, sizeBytes: intNull, sha256: { ...strNull, description: "SHA-256 of the file's bytes" } });

const CaptureItem = obj({
  captureId: uuid,
  photoId: { ...uuid, description: "Current photo; image URLs below use it" },
  speciesId: uuid,
  scientificName: str,
  commonName: strNull,
  taxonClass: strNull,
  additionalSpecies: arr(obj({ speciesId: uuid, scientificName: str, commonName: strNull })),
  takenAt: { ...strNull, format: "date-time" },
  createdAt: { ...str, format: "date-time" },
  updatedAt: { ...str, description: "Full-precision time of the last change; pass it back as `since`" },
  deletedAt: { ...strNull, description: "Set when the photo is in the trash (only with includeDeleted=1)" },
  lat: numNull,
  lon: numNull,
  regionId: { ...uuid, type: ["string", "null"] },
  regionName: strNull,
  locationLabel: strNull,
  tripId: { ...uuid, type: ["string", "null"] },
  camera: obj({ model: strNull, lens: strNull, focalLengthMm: numNull, aperture: numNull, shutter: strNull, iso: intNull }),
  rating: { ...intNull, description: "1-5" },
  tags: arr(str),
  kind: { type: "string", enum: ["image", "video"] },
  width: intNull,
  height: intNull,
  originals: obj({ jpeg: { ...original, nullable: true }, raw: { ...original, nullable: true }, video: { ...original, nullable: true } }),
  images: obj({ thumb: str, display: str, original: str }, { nullable: true, description: "Paths under the server; fetch with a photos.read key" }),
});

const ok = obj({ ok: bool });

const OPS: Record<string, Partial<Record<Method, Op>>> = {
  // --- Integrations ---
  "/captures": {
    get: {
      scope: "photos.read",
      summary: "Photo feed for syncing",
      description:
        "Every photo in the library, ordered by last change. Page with `cursor` until `nextCursor` is null; store the last item's `updatedAt` and pass it as `since` next time to get only new and edited photos. Photos deleted permanently simply stop appearing, so run an occasional full sync if you mirror deletions.",
      params: [
        q("since", "Only photos changed after this time (an `updatedAt` from an earlier call)"),
        q("cursor", "`nextCursor` from the previous page"),
        q("limit", "Page size, 1-500 (default 100)", int),
        q("speciesId", "Only photos showing this species (primary or additional)", uuid),
        q("includeDeleted", "1 to include photos in the trash, with deletedAt set", { type: "string", enum: ["1"] }),
      ],
      response: obj({ items: arr(CaptureItem), nextCursor: strNull }),
    },
  },
  "/life-list": {
    get: {
      scope: "collection.read",
      summary: "Life list",
      description: "One row per species you've photographed, oldest first. `include=seen` adds species marked seen without a photo.",
      params: [q("taxonClass", "Comma-separated taxon classes, e.g. aves,mammalia"), q("include", "`seen` to include seen-only species")],
      response: obj({
        species: arr(
          obj({
            speciesId: uuid,
            scientificName: str,
            commonName: strNull,
            taxonClass: strNull,
            family: strNull,
            status: { type: "string", enum: ["photographed", "seen"] },
            firstCollected: { ...strNull, format: "date" },
            lastPhotographed: { ...strNull, format: "date-time" },
            photoCount: int,
            bestRating: intNull,
            coverPhotoId: { ...uuid, type: ["string", "null"] },
            coverImage: strNull,
          }),
        ),
      }),
    },
  },
  "/life-list/summary": {
    get: {
      scope: "collection.read",
      summary: "Life list counts",
      description: "Small and cheap to poll: totals, per-group counts, the latest lifer, and optionally progress on one region's checklist.",
      params: [q("regionId", "Also report progress on this region's checklist", uuid)],
      response: obj({
        photographedSpecies: int,
        seenOnlySpecies: int,
        photos: int,
        newThisYear: int,
        byTaxonClass: { type: "object", additionalProperties: int },
        latestLifer: obj(
          { speciesId: uuid, scientificName: str, commonName: strNull, firstCollected: str, coverImage: strNull },
          { nullable: true },
        ),
        region: obj({ regionId: uuid, name: str, photographed: int, checklistSize: int }, { nullable: true }),
      }),
    },
  },

  // --- Photo files ---
  "/photos/{id}/thumb": { get: { scope: "photos.read", summary: "Thumbnail (WebP)", binary: "image/webp" } },
  "/photos/{id}/display": { get: { scope: "photos.read", summary: "Display-size image (WebP)", binary: "image/webp" } },
  "/photos/{id}/medium": { get: { scope: "photos.read", summary: "Grid-size image, 1,024px (WebP)", binary: "image/webp" } },
  "/photos/{id}/original": {
    get: {
      scope: "photos.read",
      summary: "Original file",
      description: "The full original JPEG/PNG. `download=1` adds a download filename. 409 when it lives on a drive that isn't connected.",
      params: [q("download", "1 to set Content-Disposition: attachment")],
      binary: "application/octet-stream",
    },
  },
  "/photos/{id}/original-raw": { get: { scope: "photos.read", summary: "Original RAW file, when the photo has one", binary: "application/octet-stream" } },
  "/photos/{id}/video": { get: { scope: "photos.read", summary: "Video file (supports Range requests)", binary: "video/*" } },

  // --- Importing and editing photos ---
  "/uploads": {
    post: {
      scope: "photos.write",
      summary: "Import a photo",
      description:
        "multipart/form-data. The file's own metadata (capture time, GPS, camera, star rating) is read on import. With `skipDuplicates=1`, an exact copy you already have returns that photo (200, `duplicate: true`) instead of a second one. After POST /uploads/inspect, send `stagedId`, `fileName` and `fileType` instead of `file` to import the copy the server kept; 410 means it has expired, so send the file.",
      multipart: obj(
        {
          file: { type: "string", format: "binary", description: "JPEG or PNG (or a RAW file on its own)" },
          rawFile: { type: "string", format: "binary", description: "Optional RAW that goes with `file`" },
          speciesId: { ...uuid, description: "Required. Find it with GET /species?q=" },
          regionId: uuid,
          locationLabel: str,
          albumId: uuid,
          tripId: uuid,
          skipDuplicates: { type: "string", enum: ["1"] },
          stagedId: { ...str, description: "Instead of `file`: the `stagedId` from POST /uploads/inspect" },
          fileName: { ...str, description: "With `stagedId`: the original file name" },
          fileType: { ...str, description: "With `stagedId`: the file's MIME type, e.g. image/jpeg" },
        },
        { required: ["speciesId"] },
      ),
      response: obj({ captureId: uuid, photoId: uuid, duplicate: bool }),
    },
  },
  "/uploads/inspect": {
    post: {
      scope: "photos.write",
      summary: "Check a photo before importing it",
      description:
        "multipart/form-data. Reports an exact or near-identical photo you already have and, with `regionId`, species suggestions. The server keeps the file for 2 hours so POST /uploads can import it by `stagedId` without sending it again.",
      multipart: obj(
        { file: { type: "string", format: "binary" }, regionId: uuid },
        { required: ["file"] },
      ),
      response: obj({ possibleDuplicate: { type: ["object", "null"] }, suggestions: { type: "array", items: { type: "object" } }, stagedId: strNull }),
    },
  },
  "/captures/{id}/reassign": {
    patch: { scope: "photos.write", summary: "Change a photo's species", body: obj({ speciesId: uuid }, { required: ["speciesId"] }), response: ok },
  },
  "/captures/{id}/species": {
    post: { scope: "photos.write", summary: "Add another species shown in the photo", body: obj({ speciesId: uuid }, { required: ["speciesId"] }), response: ok },
  },
  "/captures/{id}/species/{speciesId}": { delete: { scope: "photos.write", summary: "Remove an additional species", response: ok } },
  "/captures/{id}/rating": {
    patch: { scope: "photos.write", summary: "Set the star rating", body: obj({ rating: { ...intNull, description: "1-5, or null to clear" } }), response: ok },
  },
  "/captures/{id}/tags": { patch: { scope: "photos.write", summary: "Replace the photo's tags", body: obj({ tags: arr(str) }), response: ok } },
  "/captures/{id}/taken-at": {
    patch: { scope: "photos.write", summary: "Set the capture time", body: obj({ takenAt: { ...strNull, format: "date-time" } }), response: ok },
  },
  "/captures/{id}/region": {
    patch: {
      scope: "photos.write",
      summary: "Set the region and/or location label",
      body: obj({ regionId: { ...uuid, type: ["string", "null"] }, locationLabel: strNull }),
      response: ok,
    },
  },

  // --- Gallery ---
  "/gallery": {
    get: {
      scope: "gallery.read",
      summary: "All photos with filters (unpaged; prefer GET /captures for syncing)",
      params: [
        q("taxa", "Comma-separated taxon classes"),
        q("regionId", "Region", uuid),
        q("dateFrom", "Taken on or after (YYYY-MM-DD)"),
        q("dateTo", "Taken on or before (YYYY-MM-DD)"),
        q("tag", "Only photos with this tag"),
        q("onlyTopRated", "1 for 5-star photos only"),
        q("onlyFeatured", "1 for species cover photos only"),
        q("onlyVideo", "1 for videos only"),
        q("sort", "Sort order"),
      ],
    },
  },
  "/gallery/search": {
    get: { scope: "gallery.read", summary: "Search photos by content or species", params: [q("q", "What to look for, e.g. \"bird in flight\"")] },
  },
  "/gallery/taxa": { get: { scope: "gallery.read", summary: "Taxon classes that have photos" } },
  "/gallery/regions-with-photos": { get: { scope: "gallery.read", summary: "Regions that have photos" } },
  "/gallery/has-video": { get: { scope: "gallery.read", summary: "Whether the library has any videos" } },

  // --- Species ---
  "/species": { get: { scope: "species.read", summary: "Search species by name, code, genus or family", params: [q("q", "Search text")] } },
  "/species/{id}": { get: { scope: "species.read", summary: "Species details", params: [q("regionId", "Region context", uuid)] } },
  "/species/{id}/encounters": { get: { scope: "species.read", summary: "Your encounters with a species" } },
  "/species/{id}/reference-photos": { get: { scope: "species.read", summary: "Reference gallery for a species" } },
  "/species/{id}/reference-photo/thumb": { get: { scope: "species.read", summary: "Main reference photo, thumbnail", binary: "image/webp" } },
  "/species/{id}/reference-photo/display": { get: { scope: "species.read", summary: "Main reference photo, display size", binary: "image/webp" } },
  "/species/reference-gallery-photo/{photoId}/thumb": { get: { scope: "species.read", summary: "Reference gallery photo, thumbnail", binary: "image/webp" } },
  "/species/reference-gallery-photo/{photoId}/display": { get: { scope: "species.read", summary: "Reference gallery photo, display size", binary: "image/webp" } },
  "/species/{id}/sequences": { get: { scope: "species.read", summary: "Burst sequences among your photos of a species" } },
  "/species/{id}/unmatched-raws": { get: { scope: "species.read", summary: "RAW files for a species not yet paired with a photo" } },
  "/species/{id}/volume-usage": { get: { scope: "species.read", summary: "Which drives hold this species' files" } },

  // --- Stats ---
  "/stats": { get: { scope: "stats.read", summary: "Library statistics" } },
  "/stats/export.csv": { get: { scope: "stats.read", summary: "Life list as CSV", binary: "text/csv" } },
  "/stats/archive-health": { get: { scope: "stats.read", summary: "Missing files, unconnected drives and similar" } },
  "/stats/photography-dna": { get: { scope: "stats.read", summary: "Shooting habits" } },
  "/stats/species-portfolio": { get: { scope: "stats.read", summary: "Per-species photo coverage" } },
  "/stats/gear-species-breakdown": { get: { scope: "stats.read", summary: "Species by camera and lens" } },
  "/stats/year-comparison": { get: { scope: "stats.read", summary: "Year-over-year comparison" } },

  // --- Trips ---
  "/trips": { get: { scope: "trips.read", summary: "Trips" } },
  "/trips/{id}": { get: { scope: "trips.read", summary: "Trip details" } },
  "/trips/{id}/summary": { get: { scope: "trips.read", summary: "Trip summary" } },
  "/trips/{id}/species": { get: { scope: "trips.read", summary: "Species seen on a trip" } },
  "/trips/{id}/photos": { get: { scope: "trips.read", summary: "Photos from a trip" } },
  "/trips/{id}/scan-preview": { get: { scope: "trips.read", summary: "Preview of a trip folder scan" } },
  "/trips/{id}/scan/status": { get: { scope: "trips.read", summary: "Trip folder scan progress" } },
  "/trips/{id}/import/status": { get: { scope: "trips.read", summary: "Trip import progress" } },

  // --- Albums and shares ---
  "/albums": {
    get: { scope: "album.read", summary: "Albums" },
    post: { scope: "album.write", summary: "Create an album", body: obj({ name: str, description: strNull }) },
  },
  "/albums/{id}": {
    get: { scope: "album.read", summary: "Album details" },
    patch: {
      scope: "album.write",
      summary: "Update an album",
      body: obj({ name: str, description: strNull, coverPhotoId: { ...uuid, type: ["string", "null"] }, coverLayout: { type: "string", enum: ["single", "quad"] } }),
    },
    delete: { scope: "album.write", summary: "Delete an album (photos are kept)" },
  },
  "/albums/{id}/species": { get: { scope: "album.read", summary: "Species in an album" } },
  "/albums/{id}/captures": { post: { scope: "album.write", summary: "Add photos to an album", body: obj({ captureIds: arr(uuid) }) } },
  "/albums/{id}/captures/{captureId}": { delete: { scope: "album.write", summary: "Remove a photo from an album" } },
  "/albums/{id}/cover-crop": { patch: { scope: "album.write", summary: "Set the album cover crop", body: obj({ x: num, y: num, size: num, reset: bool }) } },
  "/albums/{id}/quad-slot": { patch: { scope: "album.write", summary: "Set a photo in a four-photo album cover" } },
  "/albums/{id}/shares": {
    get: { scope: "share.read", summary: "Share links for an album" },
    post: {
      scope: "share.write",
      summary: "Create a share link",
      body: obj({ password: str, allowDownload: bool, showMetadata: bool, expiresAt: { ...strNull, format: "date-time" } }),
    },
  },
  "/shares/{id}": { delete: { scope: "share.write", summary: "Revoke a share link" } },
};

function pathParams(p: string) {
  return [...p.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: str }));
}

export function buildOpenApi(): object {
  const paths: Record<string, Record<string, object>> = {};
  for (const [p, methods] of Object.entries(OPS)) {
    paths[p] = {};
    for (const [method, op] of Object.entries(methods) as Array<[Method, Op]>) {
      const responses: Record<string, object> = {
        "200": op.binary
          ? { description: "The file", content: { [op.binary]: { schema: { type: "string", format: "binary" } } } }
          : { description: "OK", content: { "application/json": { schema: op.response ?? { type: "object" } } } },
        "401": { description: "Missing key, or the key lacks the " + op.scope + " scope" },
      };
      paths[p][method] = {
        summary: op.summary,
        ...(op.description && { description: op.description }),
        tags: [op.scope.split(".")[0]],
        security: [{ apiKey: [] }],
        "x-required-scope": op.scope,
        parameters: [...pathParams(p), ...(op.params ?? []).map((x) => ({ in: "query", ...x }))],
        ...(op.body && { requestBody: { content: { "application/json": { schema: op.body } } } }),
        ...(op.multipart && { requestBody: { required: true, content: { "multipart/form-data": { schema: op.multipart } } } }),
        responses,
      };
    }
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Lifer API",
      version: process.env.APP_VERSION ?? "dev",
      description:
        "Routes an API key can reach on a Lifer server. Create keys under Settings > API keys and send them as the `x-api-key` header. Each key only works for the scopes it was given (`x-required-scope` on each operation). See docs/API.md for recipes.",
    },
    servers: [{ url: "/api" }],
    components: { securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "x-api-key" } } },
    paths,
  };
}

/** For integrationsDocs.test.ts: every documented (method, path, scope). */
export function documentedRoutes(): Array<{ method: string; path: string; scope: string }> {
  return Object.entries(OPS).flatMap(([p, methods]) =>
    Object.entries(methods).map(([method, op]) => ({ method: method.toUpperCase(), path: p, scope: op!.scope })),
  );
}
