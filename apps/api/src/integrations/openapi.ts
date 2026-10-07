// OpenAPI description of every API-key route, served at GET /api/openapi.json. Paths, scopes,
// parameters, JSON bodies and responses come from the routes themselves (their TypeBox schemas
// and requireScope, collected in lib/schema.ts routeCatalog); this file adds the prose, and the
// parts a schema can't express: multipart forms, file downloads and the tus protocol.
// integrationsDocs.test.ts checks it against the routes and the API guide.
import { PHOTO_FORMATS } from "@lifer/core/uploads/formats.js";
import type { CatalogRoute } from "../lib/schema.js";

type Method = "get" | "post" | "patch" | "put" | "delete" | "head" | "options";

interface OpText {
  summary: string;
  description?: string;
  /** A multipart/form-data body, which the route reads itself instead of through a schema. */
  multipart?: object;
  /** Content type of a file response. */
  binary?: string;
  /** A response with no JSON body (the tus endpoints): its status and what it carries. */
  noBody?: { status: string; description: string };
  /** Protocol headers the route reads itself (tus), documented as header parameters. */
  headers?: Array<{ name: string; required?: boolean; description: string }>;
}

const str = { type: "string" };
const uuid = { type: "string", format: "uuid" };
const obj = (properties: Record<string, object>, extra: object = {}) => ({ type: "object", properties, ...extra });

// From uploads/formats.ts, so the list can't drift from what the server accepts.
const ACCEPTED_FORMATS_TEXT = Object.values(PHOTO_FORMATS)
  .map((f) => `${f.extensions.join("/")} (${f.mimeTypes.join(", ")})`)
  .join("; ");

const TUS_CAPABILITIES: OpText = {
  summary: "Resumable upload capabilities",
  noBody: { status: "204", description: "`Tus-Version`, `Tus-Extension` and `Tus-Max-Size` headers" },
};
const TUS_VERSION = { name: "Tus-Resumable", required: true, description: "1.0.0" };

/** The prose for each documented operation, by OpenAPI path (under /api) and method. */
export const OPS: Record<string, Partial<Record<Method, OpText>>> = {
  // --- Integrations ---
  "/captures": {
    get: {
      summary: "Photo feed for syncing",
      description:
        "Every photo in the library, ordered by last change. Page with `cursor` until `nextCursor` is null; store the last item's `updatedAt` and pass it as `since` next time to get only new and edited photos. Photos deleted permanently simply stop appearing, so run an occasional full sync if you mirror deletions.",
    },
  },
  "/life-list": {
    get: {
      summary: "Life list",
      description:
        "One row per species you've photographed, oldest first. `include=seen` adds species marked seen without a photo.",
    },
  },
  "/life-list/summary": {
    get: {
      summary: "Life list counts",
      description:
        "Small and cheap to poll: totals, per-group counts, the latest lifer, and optionally progress on one region's checklist. An unknown or malformed `regionId` answers 404.",
    },
  },

  // --- Checklist additions ---
  "/regions/{regionId}/checklist-additions/{speciesId}": {
    put: {
      summary: "Add a species to a region's checklist",
      description:
        "Puts any species on a country's or province's checklist for you, like a hand-imported species you also found in another province. Safe to repeat: adding it again answers 200 with `added: false`. `alreadyOnChecklist` is true when the catalog already lists it there. It undoes a hide of the species in that region. Your additions are kept apart from the catalog, so catalog updates and offline packs never remove them. 400 with code `no_checklist` for World or a continent, which have no checklist of their own; 404 for an unknown region or species.",
    },
    delete: {
      summary: "Remove a species you added to a region's checklist",
      description:
        "Removes only your addition: if the catalog lists the species there too, it stays on the checklist. 404 with code `not_added` when you hadn't added it there.",
    },
  },
  "/regions/{id}/checklist-additions": {
    get: {
      summary: "Species you added to a region's checklist",
      description:
        "Only additions made to this region itself, not to provinces inside it. Species you imported by hand from iNaturalist are included. 404 for an unknown region.",
    },
  },
  "/sea-zones": {
    get: {
      summary: "Sea zones",
      description:
        "Every sea zone (IHO sea areas, and a country's own waters within the larger ones), by name, for adding a species to one's checklist.",
    },
  },
  "/sea-zones/{seaZoneId}/checklist-additions/{speciesId}": {
    put: {
      summary: "Add a species to a sea zone's checklist",
      description:
        "Puts any species on a sea zone's checklist for you, like a sea turtle or a seabird its fish and marine mammal list doesn't have. It shows on a region's checklist when that zone is ticked as nearby water. Safe to repeat: adding it again answers 200 with `added: false`. `alreadyOnChecklist` is true when the catalog already lists it there. 404 for an unknown sea zone or species.",
    },
    delete: {
      summary: "Remove a species you added to a sea zone's checklist",
      description:
        "Removes only your addition, never the catalog's own entry. 404 with code `not_added` when you hadn't added it there.",
    },
  },
  "/sea-zones/{id}/checklist-additions": {
    get: {
      summary: "Species you added to a sea zone's checklist",
      description: "404 for an unknown sea zone.",
    },
  },
  "/species/{id}/checklist-additions": {
    get: {
      summary: "Checklists you added a species to",
      description:
        "`items` lists every region whose checklist you added this species to, and `seaZones` every sea zone. A sea zone has no page of its own; `nearRegionId` is a region that offers it as nearby water, or null. 404 for an unknown species.",
    },
  },

  // --- Photo files ---
  "/photos/{id}/thumb": { get: { summary: "Thumbnail (WebP)", binary: "image/webp" } },
  "/photos/{id}/display": { get: { summary: "Display-size image (WebP)", binary: "image/webp" } },
  "/photos/{id}/medium": { get: { summary: "Grid-size image, 1,024px (WebP)", binary: "image/webp" } },
  "/photos/{id}/original": {
    get: {
      summary: "Original file",
      description:
        "The full original photo file, as imported. `download=1` adds a download filename. 409 when it lives on a drive that isn't connected.",
      binary: "application/octet-stream",
    },
  },
  "/photos/{id}/original-raw": {
    get: { summary: "Original RAW file, when the photo has one", binary: "application/octet-stream" },
  },
  "/photos/{id}/video": { get: { summary: "Video file (supports Range requests)", binary: "video/*" } },

  // --- Importing and editing photos ---
  "/uploads": {
    post: {
      summary: "Import a photo",
      description:
        "multipart/form-data. Accepted photos: " +
        ACCEPTED_FORMATS_TEXT +
        '. A camera RAW (or a TIFF holding sensor data) can also be sent on its own. The file\'s own metadata (capture time, GPS, camera, star rating) is read on import. With `skipDuplicates=1`, an exact copy you already have returns that photo (200, `duplicate: true`) instead of a second one. `cullMarks` decides what happens to a photo a culling app rejected (xmp:Rating -1, a Lightroom, digiKam, Vireo or SuperPicky reject flag): `ignore` (the default) imports it, `skip` answers 200 with `skipped: "rejected"` and imports nothing, `hide` imports it hidden (`hidden: true`, out of the gallery and life list until unhidden). A verdict on `rawFile` counts for `file` too. The file is only read, never changed. Instead of `file`, send `uploadId` (a finished resumable upload, see /uploads/tus) or, after POST /uploads/inspect, `stagedId` with `fileName` and `fileType` to import the copy the server kept. 410 means that copy is gone (expired, already imported or never finished), so send the file again; 409 means the same upload is being imported by another request.',
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
          cullMarks: {
            type: "string",
            enum: ["ignore", "skip", "hide"],
            description: "What to do if a culling app rejected the photo: ignore (default), skip or hide",
          },
          uploadId: {
            ...str,
            description:
              "Instead of `file`: a finished resumable upload (the last path segment of its /uploads/tus URL)",
          },
          rawUploadId: { ...str, description: "Instead of `rawFile`: the RAW as a finished resumable upload" },
          stagedId: { ...str, description: "Instead of `file`: the `stagedId` from POST /uploads/inspect" },
          fileName: {
            ...str,
            description: "With `stagedId`: the original file name (optional with `uploadId`, which knows its own)",
          },
          fileType: {
            ...str,
            description: "With `stagedId`: the file's MIME type, e.g. image/jpeg (optional with `uploadId`)",
          },
        },
        { required: ["speciesId"] },
      ),
    },
  },
  "/uploads/inspect": {
    post: {
      summary: "Check a photo before importing it",
      description:
        "multipart/form-data with `file`, or `uploadId` for a finished resumable upload (read where it is; import it next with the same `uploadId`). Reports an exact or near-identical photo you already have and, with `regionId`, species suggestions. A `file` is kept for 2 hours so POST /uploads can import it by `stagedId` without sending it again. `previewDataUrl` is a JPEG for files a browser can't show (RAW, TIFF, HEIC). `cull` is what a culling app marked in the file's own metadata: `verdict` (`pick`, `reject` or null) and `label` (a colour, or null). 410 when `uploadId` is gone.",
      multipart: obj({
        file: { type: "string", format: "binary" },
        uploadId: { ...str, description: "Instead of `file`: a finished resumable upload" },
        regionId: uuid,
      }),
    },
  },
  "/uploads/tus": {
    post: {
      summary: "Start a resumable upload (tus 1.0)",
      description:
        "The tus 1.0 protocol (https://tus.io/protocols/resumable-upload) with the creation, creation-with-upload, creation-defer-length, termination and expiration extensions, for files of any size through any proxy. Answers 201 with a relative `Location` (`/api/uploads/tus/{id}`); `{id}` is the `uploadId` other endpoints take. Send the bytes with PATCH in chunks (8 MB works everywhere; a proxy that answers 413 needs smaller ones). A finished upload is kept 2 hours for an import, and an unfinished one 2 hours after its last chunk (`Upload-Expires`). Uploads belong to the user who created them. A browser session also needs the `x-lifer-client: 1` header. 413 when `Upload-Length` is over the server's MAX_UPLOAD_BYTES.",
      headers: [
        TUS_VERSION,
        { name: "Upload-Length", description: "Total size in bytes (or Upload-Defer-Length: 1)" },
        {
          name: "Upload-Metadata",
          description: "Comma-separated `key base64value` pairs: `filename` and `filetype` (the MIME type)",
        },
      ],
      noBody: { status: "201", description: "Created. `Location` is the upload URL" },
    },
    options: TUS_CAPABILITIES,
  },
  "/uploads/tus/{id}": {
    patch: {
      summary: "Send the next chunk of a resumable upload",
      description:
        "Body: `application/offset+octet-stream`, starting at `Upload-Offset`. 409 when the offset doesn't match the server's (ask with HEAD), 404 for an upload that isn't yours, 410 when it expired.",
      headers: [TUS_VERSION, { name: "Upload-Offset", required: true, description: "Where this chunk starts" }],
      noBody: { status: "204", description: "The new `Upload-Offset`" },
    },
    head: {
      summary: "How much of a resumable upload arrived",
      headers: [TUS_VERSION],
      noBody: {
        status: "200",
        description: "`Upload-Offset` (resume from here), `Upload-Length` and `Upload-Metadata`",
      },
    },
    delete: {
      summary: "Cancel a resumable upload",
      headers: [TUS_VERSION],
      noBody: { status: "204", description: "Deleted" },
    },
    options: TUS_CAPABILITIES,
  },
  "/species/{id}/split": { post: { summary: "Settle photos under a species that was split" } },
  "/captures/{id}/reassign": { patch: { summary: "Change a photo's species" } },
  "/captures/{id}/species": { post: { summary: "Add another species shown in the photo" } },
  "/captures/{id}/species/{speciesId}": { delete: { summary: "Remove an additional species" } },
  "/captures/{id}/rating": { patch: { summary: "Set the star rating" } },
  "/captures/{id}/tags": { patch: { summary: "Replace the photo's tags" } },
  "/captures/{id}/taken-at": { patch: { summary: "Set the capture time" } },
  "/captures/{id}/region": {
    patch: { summary: "Set the region and/or location label", description: "A field left out stays as it is." },
  },

  // --- Gallery ---
  "/gallery": {
    get: { summary: "All photos with filters. Unpaged unless limit is given; prefer GET /captures for syncing" },
  },
  "/gallery/ids": {
    get: { summary: "Every capture id matching the GET /gallery filters, with the video and RAW ones listed again" },
  },
  "/gallery/search": { get: { summary: "Search photos by content, species, place, date, trip or album name" } },
  "/gallery/taxa": { get: { summary: "Taxon classes that have photos" } },
  "/gallery/regions-with-photos": { get: { summary: "Regions that have photos" } },
  "/gallery/has-video": { get: { summary: "Whether the library has any videos" } },

  // --- Species ---
  "/species": {
    get: { summary: "Search species by name, alias, old scientific name, code, genus or family (accents ignored)" },
  },
  "/species/{id}": { get: { summary: "Species details" } },
  "/species/{id}/encounters": { get: { summary: "Your encounters with a species" } },
  "/species/{id}/reference-photos": { get: { summary: "Reference gallery for a species" } },
  "/species/{id}/reference-photo/thumb": {
    get: { summary: "Main reference photo, thumbnail", binary: "image/webp" },
  },
  "/species/{id}/reference-photo/display": {
    get: { summary: "Main reference photo, display size", binary: "image/webp" },
  },
  "/species/reference-gallery-photo/{photoId}/thumb": {
    get: { summary: "Reference gallery photo, thumbnail", binary: "image/webp" },
  },
  "/species/reference-gallery-photo/{photoId}/display": {
    get: { summary: "Reference gallery photo, display size", binary: "image/webp" },
  },
  "/species/{id}/sequences": { get: { summary: "Burst sequences among your photos of a species" } },
  "/species/{id}/unmatched-raws": { get: { summary: "RAW files for a species not yet paired with a photo" } },
  "/species/{id}/volume-usage": { get: { summary: "Which drives hold this species' files" } },

  // --- Stats ---
  "/stats": { get: { summary: "Library statistics" } },
  "/stats/export.csv": { get: { summary: "Life list as CSV", binary: "text/csv" } },
  "/stats/archive-health": { get: { summary: "Missing files, unconnected drives and similar" } },
  "/stats/photography-dna": { get: { summary: "Shooting habits" } },
  "/stats/species-portfolio": { get: { summary: "Per-species photo coverage" } },
  "/stats/gear-species-breakdown": { get: { summary: "Species by camera and lens" } },
  "/stats/year-comparison": { get: { summary: "Year-over-year comparison" } },

  // --- Trips ---
  "/trips": { get: { summary: "Trips" } },
  "/trips/{id}": { get: { summary: "Trip details" } },
  "/trips/{id}/summary": { get: { summary: "Trip summary" } },
  "/trips/{id}/species": { get: { summary: "Species seen on a trip" } },
  "/trips/{id}/photos": { get: { summary: "Photos from a trip" } },
  "/trips/{id}/scan-preview": { get: { summary: "Preview of a trip folder scan" } },
  "/trips/{id}/scan/status": { get: { summary: "Trip folder scan progress" } },
  "/trips/{id}/import/status": { get: { summary: "Trip import progress" } },

  // --- Albums and shares ---
  "/albums": {
    get: { summary: "Albums" },
    post: { summary: "Create an album" },
  },
  "/albums/{id}": {
    get: { summary: "Album details" },
    patch: { summary: "Update an album" },
    delete: { summary: "Delete an album (photos are kept)" },
  },
  "/albums/{id}/species": { get: { summary: "Species in an album" } },
  "/albums/{id}/captures": { post: { summary: "Add photos to an album" } },
  "/albums/{id}/captures/{captureId}": { delete: { summary: "Remove a photo from an album" } },
  "/albums/{id}/cover-crop": { patch: { summary: "Set the album cover crop" } },
  "/albums/{id}/quad-slot": { patch: { summary: "Set a photo in a four-photo album cover" } },
  "/albums/{id}/shares": {
    get: { summary: "Share links for an album" },
    post: { summary: "Create a share link" },
  },
  "/shares/{id}": { delete: { summary: "Revoke a share link" } },
};

// Every error response has this shape: `error` is a message to show a person, and `code`, when
// present, is a stable machine-readable reason (for example "desktop_only", or "invalid_request"
// when the request doesn't match the route's schema). A 5xx never carries internal detail; it's
// logged on the server instead.
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

interface ObjectSchema {
  properties?: Record<string, { description?: string }>;
  required?: string[];
}

/** A route's path in the document: under /api, with `{name}` parameters. */
export function openApiPath(url: string): string {
  return url.replace(/^\/api(?=\/)/, "").replace(/:(\w+)/g, "{$1}");
}

// Plain JSON, without anything TypeBox keeps on its schema objects.
const plain = (schema: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(schema ?? {}));

/** Query, path or header parameters from an object schema. */
function parametersOf(schema: unknown, location: "query" | "path" | "header") {
  const s = plain(schema) as ObjectSchema;
  return Object.entries(s.properties ?? {}).map(([name, prop]) => {
    const { description, ...rest } = prop;
    return {
      name,
      in: location,
      required: location === "path" || (s.required ?? []).includes(name),
      ...(description && { description }),
      schema: rest,
    };
  });
}

/** The API-key routes, the ones the document describes. */
export function keyRoutes(routes: Iterable<CatalogRoute>): CatalogRoute[] {
  return [...routes].filter((r) => r.scope && r.url.startsWith("/api/"));
}

export function buildOpenApi(routes: Iterable<CatalogRoute>): object {
  const paths: Record<string, Record<string, object>> = {};
  for (const route of keyRoutes(routes)) {
    const p = openApiPath(route.url);
    const method = route.method.toLowerCase() as Method;
    const text: OpText = OPS[p]?.[method] ?? { summary: `${route.method} ${p}` };
    const schema = (route.schema ?? {}) as Record<string, unknown>;
    const response = schema.response as Record<string, unknown> | undefined;
    const okStatus = response && Object.keys(response).find((code) => /^2\d\d$/.test(code));
    const responses: Record<string, object> = {
      ...(text.noBody
        ? { [text.noBody.status]: { description: text.noBody.description } }
        : text.binary
          ? {
              "200": {
                description: "The file",
                content: { [text.binary]: { schema: { type: "string", format: "binary" } } },
              },
            }
          : {
              [okStatus ?? "200"]: {
                description: "OK",
                content: {
                  "application/json": { schema: okStatus ? plain(response[okStatus]) : { type: "object" } },
                },
              },
            }),
      "400": errorResponse("The request doesn't match this operation's parameters or body"),
      "401": errorResponse("Missing key, or the key lacks the " + route.scope + " scope"),
      default: errorResponse("Any other error"),
    };
    paths[p] ??= {};
    paths[p][method] = {
      summary: text.summary,
      ...(text.description && { description: text.description }),
      tags: [route.scope!.split(".")[0]],
      security: [{ apiKey: [] }],
      "x-required-scope": route.scope,
      parameters: [
        ...parametersOf(schema.params, "path"),
        ...parametersOf(schema.querystring, "query"),
        ...parametersOf(schema.headers, "header"),
        ...(text.headers ?? []).map((h) => ({
          name: h.name,
          in: "header",
          required: h.required ?? false,
          description: h.description,
          schema: str,
        })),
      ],
      ...(schema.body !== undefined && {
        requestBody: { required: true, content: { "application/json": { schema: plain(schema.body) } } },
      }),
      ...(text.multipart && {
        requestBody: { required: true, content: { "multipart/form-data": { schema: text.multipart } } },
      }),
      responses,
    };
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
