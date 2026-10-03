// OpenAPI description of every API-key route, served at GET /api/openapi.json.
// integrationsDocs.test.ts keeps it in step with the routes.
import { API_KEY_SCOPES } from "../auth/apiKeyRoutes.js";
import { PHOTO_FORMATS } from "../uploads/formats.js";

type Scope = (typeof API_KEY_SCOPES)[number];
type Method = "get" | "post" | "patch" | "put" | "delete" | "head" | "options";

interface Op {
  scope: Scope;
  summary: string;
  description?: string;
  params?: Array<{ name: string; in?: "query" | "path"; required?: boolean; description: string; schema?: object }>;
  body?: object;
  multipart?: object;
  response?: object;
  binary?: string; // content type of a file response
  /** A response with no JSON body (the tus endpoints): its status and what it carries. */
  noBody?: { status: string; description: string };
  /** Request headers, documented as header parameters. */
  headers?: Array<{ name: string; required?: boolean; description: string }>;
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

// From uploads/formats.ts, so the list can't drift from what the server accepts.
const ACCEPTED_FORMATS_TEXT = Object.values(PHOTO_FORMATS)
  .map((f) => `${f.extensions.join("/")} (${f.mimeTypes.join(", ")})`)
  .join("; ");

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
      description: "The full original photo file, as imported. `download=1` adds a download filename. 409 when it lives on a drive that isn't connected.",
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
        "multipart/form-data. Accepted photos: " + ACCEPTED_FORMATS_TEXT + ". A camera RAW (or a TIFF holding sensor data) can also be sent on its own. The file's own metadata (capture time, GPS, camera, star rating) is read on import. With `skipDuplicates=1`, an exact copy you already have returns that photo (200, `duplicate: true`) instead of a second one. Instead of `file`, send `uploadId` (a finished resumable upload, see /uploads/tus) or, after POST /uploads/inspect, `stagedId` with `fileName` and `fileType` to import the copy the server kept. 410 means that copy is gone (expired, already imported or never finished), so send the file again; 409 means the same upload is being imported by another request.",
      multipart: obj(
        {
          file: { type: "string", format: "binary", description: "The photo (or a RAW file on its own)" },
          rawFile: { type: "string", format: "binary", description: "Optional RAW that goes with `file`" },
          speciesId: { ...uuid, description: "Required. Find it with GET /species?q=" },
          regionId: uuid,
          locationLabel: str,
          albumId: uuid,
          tripId: uuid,
          skipDuplicates: { type: "string", enum: ["1"] },
          uploadId: { ...str, description: "Instead of `file`: a finished resumable upload (the last path segment of its /uploads/tus URL)" },
          rawUploadId: { ...str, description: "Instead of `rawFile`: the RAW as a finished resumable upload" },
          stagedId: { ...str, description: "Instead of `file`: the `stagedId` from POST /uploads/inspect" },
          fileName: { ...str, description: "With `stagedId`: the original file name (optional with `uploadId`, which knows its own)" },
          fileType: { ...str, description: "With `stagedId`: the file's MIME type, e.g. image/jpeg (optional with `uploadId`)" },
        },
        { required: ["speciesId"] },
      ),
      response: obj({ captureId: uuid, photoId: { ...uuid, type: ["string", "null"] }, duplicate: bool, linkedExisting: bool }),
    },
  },
  "/uploads/inspect": {
    post: {
      scope: "photos.write",
      summary: "Check a photo before importing it",
      description:
        "multipart/form-data with `file`, or `uploadId` for a finished resumable upload (read where it is; import it next with the same `uploadId`). Reports an exact or near-identical photo you already have and, with `regionId`, species suggestions. A `file` is kept for 2 hours so POST /uploads can import it by `stagedId` without sending it again. `previewDataUrl` is a JPEG for files a browser can't show (RAW, TIFF, HEIC). 410 when `uploadId` is gone.",
      multipart: obj({
        file: { type: "string", format: "binary" },
        uploadId: { ...str, description: "Instead of `file`: a finished resumable upload" },
        regionId: uuid,
      }),
      response: obj({
        takenAt: { ...strNull, format: "date-time" },
        keywords: arr(str),
        possibleDuplicate: { type: ["object", "null"] },
        suggestions: { type: "array", items: { type: "object" } },
        burst: {
          type: ["object", "null"],
          description:
            "When this photo is one frame of a burst inspected recently (near-identical, taken within 2 minutes): `uploadIds` of the other frames and `suggestions` ranked from all of them, which apply to those frames too",
        },
        matchingMs: { type: ["number", "null"], description: "Milliseconds this server spent running the matching models, when it ran them (not for vectors a desktop app sent)" },
        previewDataUrl: strNull,
        stagedId: { ...strNull, description: "Set for a `file` the server kept" },
        uploadId: { ...strNull, description: "Echoes `uploadId` when one was inspected" },
        notWildlife: { type: ["object", "null"] },
      }),
    },
  },
  "/uploads/tus": {
    post: {
      scope: "photos.write",
      summary: "Start a resumable upload (tus 1.0)",
      description:
        "The tus 1.0 protocol (https://tus.io/protocols/resumable-upload) with the creation, creation-with-upload, creation-defer-length, termination and expiration extensions, for files of any size through any proxy. Answers 201 with a relative `Location` (`/api/uploads/tus/{id}`); `{id}` is the `uploadId` other endpoints take. Send the bytes with PATCH in chunks (8 MB works everywhere; a proxy that answers 413 needs smaller ones). A finished upload is kept 2 hours for an import, and an unfinished one 2 hours after its last chunk (`Upload-Expires`). Uploads belong to the user who created them. A browser session also needs the `x-lifer-client: 1` header. 413 when `Upload-Length` is over the server's MAX_UPLOAD_BYTES.",
      headers: [
        { name: "Tus-Resumable", required: true, description: "1.0.0" },
        { name: "Upload-Length", description: "Total size in bytes (or Upload-Defer-Length: 1)" },
        { name: "Upload-Metadata", description: "Comma-separated `key base64value` pairs: `filename` and `filetype` (the MIME type)" },
      ],
      noBody: { status: "201", description: "Created. `Location` is the upload URL" },
    },
    options: {
      scope: "photos.write",
      summary: "Resumable upload capabilities",
      noBody: { status: "204", description: "`Tus-Version`, `Tus-Extension` and `Tus-Max-Size` headers" },
    },
  },
  "/uploads/tus/{id}": {
    patch: {
      scope: "photos.write",
      summary: "Send the next chunk of a resumable upload",
      description: "Body: `application/offset+octet-stream`, starting at `Upload-Offset`. 409 when the offset doesn't match the server's (ask with HEAD), 404 for an upload that isn't yours, 410 when it expired.",
      headers: [
        { name: "Tus-Resumable", required: true, description: "1.0.0" },
        { name: "Upload-Offset", required: true, description: "Where this chunk starts" },
      ],
      noBody: { status: "204", description: "The new `Upload-Offset`" },
    },
    head: {
      scope: "photos.write",
      summary: "How much of a resumable upload arrived",
      headers: [{ name: "Tus-Resumable", required: true, description: "1.0.0" }],
      noBody: { status: "200", description: "`Upload-Offset` (resume from here), `Upload-Length` and `Upload-Metadata`" },
    },
    delete: {
      scope: "photos.write",
      summary: "Cancel a resumable upload",
      headers: [{ name: "Tus-Resumable", required: true, description: "1.0.0" }],
      noBody: { status: "204", description: "Deleted" },
    },
    options: {
      scope: "photos.write",
      summary: "Resumable upload capabilities",
      noBody: { status: "204", description: "`Tus-Version`, `Tus-Extension` and `Tus-Max-Size` headers" },
    },
  },
  "/species/{id}/split": {
    post: {
      scope: "photos.write",
      summary: "Settle photos under a species that was split",
      body: obj({ speciesId: uuid, keep: { type: "boolean", description: "True to keep the old name for these photos" } }),
      response: ok,
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
      summary: "All photos with filters. Unpaged unless limit is given; prefer GET /captures for syncing",
      params: [
        q("taxa", "Comma-separated taxon classes"),
        q("regionId", "Region, or \"uncategorized\" for photos with no region", uuid),
        q("dateFrom", "Taken on or after (YYYY-MM-DD)"),
        q("dateTo", "Taken on or before (YYYY-MM-DD)"),
        q("tag", "Only photos with this tag"),
        q("tripId", "Only photos in this trip", uuid),
        q("albumId", "Only photos in this album", uuid),
        q("missingDate", "1 for photos with no capture date only"),
        q("onlyTopRated", "1 for 5-star photos only"),
        q("onlyFeatured", "1 for species cover photos only"),
        q("onlyVideo", "1 for videos only"),
        q("sort", "newest (default), oldest, ratingHigh or ratingLow"),
        q("limit", "Page size, 1 to 500 (larger is capped at 500). When given, the response adds nextCursor", int),
        q("cursor", "nextCursor from the previous page, with the same sort and filters"),
      ],
      response: obj({
        items: arr(obj({ captureId: uuid, photoId: uuid })),
        nextCursor: { ...strNull, description: "Only when limit is given: pass as cursor for the next page; null on the last page" },
        total: { ...int, description: "Only on the first page (limit given, no cursor): how many photos match the filters in all" },
      }),
    },
  },
  "/gallery/ids": {
    get: {
      scope: "gallery.read",
      summary: "Every capture id matching the GET /gallery filters, with the video and RAW ones listed again",
      params: [
        q("taxa", "Comma-separated taxon classes"),
        q("regionId", "Region, or \"uncategorized\"", uuid),
        q("dateFrom", "Taken on or after (YYYY-MM-DD)"),
        q("dateTo", "Taken on or before (YYYY-MM-DD)"),
        q("tag", "Only photos with this tag"),
        q("tripId", "Only photos in this trip", uuid),
        q("albumId", "Only photos in this album", uuid),
        q("missingDate", "1 for photos with no capture date only"),
        q("onlyTopRated", "1 for 5-star photos only"),
        q("onlyFeatured", "1 for species cover photos only"),
        q("onlyVideo", "1 for videos only"),
      ],
      response: obj({ captureIds: arr(uuid), videoCaptureIds: arr(uuid), rawCaptureIds: arr(uuid) }),
    },
  },
  "/gallery/search": {
    get: {
      scope: "gallery.read",
      summary: "Search photos by content, species, place, date, trip or album name",
      params: [
        q("q", "What to look for, e.g. \"bird in flight\" or \"costa rica trip\""),
        q("quick", "1 to skip picture matching and answer at once"),
        q("taxa", "Comma-separated taxon classes"),
        q("regionId", "Region, or \"uncategorized\"", uuid),
        q("dateFrom", "Taken on or after (YYYY-MM-DD)"),
        q("dateTo", "Taken on or before (YYYY-MM-DD)"),
        q("tag", "Only photos with this tag"),
        q("tripId", "Only photos in this trip", uuid),
        q("albumId", "Only photos in this album", uuid),
        q("missingDate", "1 for photos with no capture date only"),
        q("onlyTopRated", "1 for 5-star photos only"),
        q("onlyFeatured", "1 for species cover photos only"),
        q("onlyVideo", "1 for videos only"),
      ],
    },
  },
  "/gallery/taxa": { get: { scope: "gallery.read", summary: "Taxon classes that have photos" } },
  "/gallery/regions-with-photos": { get: { scope: "gallery.read", summary: "Regions that have photos" } },
  "/gallery/has-video": { get: { scope: "gallery.read", summary: "Whether the library has any videos" } },

  // --- Species ---
  "/species": {
    get: {
      scope: "species.read",
      summary: "Search species by name, alias, old scientific name, code, genus or family (accents ignored)",
      params: [q("q", "Search text. Empty returns your most recently photographed species"), q("regionId", "Rank species on this region's checklist higher", uuid)],
      response: obj({
        results: arr(obj({ id: uuid, scientific_name: str, common_name: strNull, rank: { ...num, description: "Higher is better" } })),
      }),
    },
  },
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

// Every error response has this shape: `error` is a message to show a person, and `code`, when
// present, is a stable machine-readable reason (for example "desktop_only"). A 5xx never
// carries internal detail; it's logged on the server instead.
const ErrorBody = obj(
  {
    error: { ...str, description: "What went wrong, fit to show a person" },
    code: { ...str, description: "Stable reason code, when there is one" },
  },
  { required: ["error"] },
);
const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

export function buildOpenApi(): object {
  const paths: Record<string, Record<string, object>> = {};
  for (const [p, methods] of Object.entries(OPS)) {
    paths[p] = {};
    for (const [method, op] of Object.entries(methods) as Array<[Method, Op]>) {
      const responses: Record<string, object> = {
        ...(op.noBody
          ? { [op.noBody.status]: { description: op.noBody.description } }
          : {
              "200": op.binary
                ? { description: "The file", content: { [op.binary]: { schema: { type: "string", format: "binary" } } } }
                : { description: "OK", content: { "application/json": { schema: op.response ?? { type: "object" } } } },
            }),
        "401": errorResponse("Missing key, or the key lacks the " + op.scope + " scope"),
        default: errorResponse("Any other error"),
      };
      paths[p][method] = {
        summary: op.summary,
        ...(op.description && { description: op.description }),
        tags: [op.scope.split(".")[0]],
        security: [{ apiKey: [] }],
        "x-required-scope": op.scope,
        parameters: [
          ...pathParams(p),
          ...(op.params ?? []).map((x) => ({ in: "query", ...x })),
          ...(op.headers ?? []).map((h) => ({ name: h.name, in: "header", required: h.required ?? false, description: h.description, schema: str })),
        ],
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
        "Routes an API key can reach on a Lifer server. Create keys under Settings > Account > API keys and send them as the `x-api-key` header. Each key only works for the scopes it was given (`x-required-scope` on each operation). See the API guide at https://sparklysparkspark.github.io/lifer-app/api/overview.",
    },
    servers: [{ url: "/api" }],
    components: {
      securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "x-api-key" } },
      schemas: { Error: ErrorBody },
    },
    paths,
  };
}

/** For integrationsDocs.test.ts: every documented (method, path, scope). */
export function documentedRoutes(): Array<{ method: string; path: string; scope: string }> {
  return Object.entries(OPS).flatMap(([p, methods]) =>
    Object.entries(methods).map(([method, op]) => ({ method: method.toUpperCase(), path: p, scope: op!.scope })),
  );
}
