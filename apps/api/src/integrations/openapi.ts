// OpenAPI description of every API-key route, served at GET /api/openapi.json. Paths, scopes,
// parameters, JSON bodies and responses come from the routes themselves (their TypeBox schemas
// and requireScope, collected in lib/schema.ts routeCatalog); this file adds the prose, and the
// parts a schema can't express: multipart forms, file downloads and the tus protocol.
// integrationsDocs.test.ts checks it against the routes and the API guide.
import { APP_VERSION } from "@lifer/core/config.js";
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
        "Every photo in the library, ordered by last change. Page with `cursor` until `nextCursor` is null; store the last item's `updatedAt` and pass it as `since` next time to get only new and edited photos. `lifeStage`, `sex`, `plumage` and `morph` say how the animal looks, null when not set. Photos deleted permanently simply stop appearing, so run an occasional full sync if you mirror deletions.",
    },
  },
  "/life-list": {
    get: {
      summary: "Life list",
      description:
        "One row per species you've photographed, oldest first. `years` lists the calendar years with a dated photo of the species, by the camera's clock. `include=seen` adds species marked seen without a photo.",
    },
  },
  "/life-list/summary": {
    get: {
      summary: "Life list counts",
      description:
        "Small and cheap to poll: totals, per-group counts, the latest lifer, and optionally progress on one region's checklist. An unknown or malformed `regionId` answers 404.",
    },
  },

  // --- Your own data, for companion apps ---
  "/userdata/v1/species": {
    get: {
      summary: "Your marked and photographed species, for syncing",
      description:
        "One row per species you photographed, marked seen or made a target, ordered by last change, then removed marks with `deletedAt` set. Only your own data: no regions, checklists, tiers, seasonality, common names or descriptions. Page with `cursor` until `nextCursor` is null, then pass the last `updatedAt` as `since`. A row with `state` null and `isTarget` false is no longer marked.",
    },
  },
  "/userdata/v1/name-display": {
    get: {
      summary: "How the user shows species names",
      description:
        "The View menu's name choice: `main` (`common` or `scientific`) and `also`, the names shown under it in order (`other` is whichever of common or scientific isn't main, then `aba` and `ebird` codes). Lifer's default when the user never chose.",
    },
  },
  "/userdata/v1/photos/{id}/display": {
    get: { summary: "Display-size image of one of your photos (WebP)", binary: "image/webp" },
  },
  "/userdata/v1/photos/{id}/thumb": {
    get: { summary: "Thumbnail of one of your photos (WebP)", binary: "image/webp" },
  },
  "/userdata/v1/species/{id}/photos": {
    get: {
      summary: "Your photos of a species, best first",
      description:
        "Your photos of that species (as the main or an additional subject), highest rating first, then newest, `limit` 1-200 (default 50). Each has its `captureId`, a `thumbnailUrl` to fetch with the same key, rating, `flag` (pick or reject), colour `label`, `takenAt` and whether it is the `featured` photo. Hidden and trashed photos are left out. 404 for an unknown species.",
    },
  },
  "/userdata/v1/species/{id}/featured": {
    get: {
      summary: "A species' featured photo",
      description:
        "The featured photo of one of your species with its `cardCrop` (percent of the photo), rating, `flag` (pick or reject) and colour `label`, and whether the species is marked `needsBetterPhoto`. `photo` is null when the species has no featured photo of yours. 404 when you have no mark for the species.",
    },
    put: {
      summary: "Choose a species' featured photo",
      description:
        "Body `{ photoId }`, one of your photos of that species (403 otherwise). Lifer frames a fresh default crop. Undoable in Lifer.",
    },
  },
  "/userdata/v1/species/{id}/similar-photos": {
    post: {
      summary: "Your photos of a species closest to an image",
      description:
        "Body `{ model, vector, limit? }`: a 768-number image embedding from the model named in `model` (only Lifer's own model compares; any other answers 400). Returns your photos of that species nearest to it, closest first, with `similarity`, rating, `flag`, `label`, `takenAt` and whether each is the `featured` photo. Hidden and trashed photos are left out. Reads only.",
    },
  },
  "/userdata/v1/photos/{id}": {
    patch: {
      summary: "Rate, pick or label one of your photos",
      description:
        "Any of `rating` (1-5), `flag` (`pick` or `reject`) and colour `label`; null clears one, and a field left out stays as it is. `changeId` names the change as Lifer lists it in Settings > Connected apps, where the user can undo it; null when nothing changed. At most 600 changes a minute per app.",
    },
  },
  "/userdata/v1/species/{id}/card-crop": {
    put: {
      summary: "Set the crop of a species' featured photo",
      description:
        "Body `{ x, y, size }` in percent of the photo. 404 when the species has no featured photo. Undoable in Lifer.",
    },
  },
  "/userdata/v1/species/{id}/needs-better-photo": {
    put: {
      summary: "Mark a species as needing a better photo",
      description: "Lifer shows the mark on the species page and as a Collection filter. Undoable in Lifer.",
    },
    delete: { summary: "Clear the needs-a-better-photo mark" },
  },

  // --- Regional species lists, for companion apps ---
  "/opendata/v1/regions": {
    get: {
      summary: "Regions installed in Lifer",
      description:
        "The regions whose species lists the user has downloaded: `id`, `name`, `countryCode`, `bounds` (the box around the region's outline, null when unknown) and `speciesCount`.",
    },
  },
  "/opendata/v1/regions/at": {
    get: {
      summary: "Installed regions holding a point",
      description:
        "Give `lat` and `lon`. Returns the installed regions that contain the point, most specific first (a province before its country). Empty when none is installed there.",
    },
  },
  "/opendata/v1/regions/tree": {
    get: {
      summary: "Every region in the catalog",
      description:
        "Installed or not, for browsing and searching by name: `id`, `name`, `parentId`, `countryCode`, `aliases`, `hasChildren`, `hasChecklist` and `installed` (whether it is among GET /opendata/v1/regions). Countries come first, then each level by name.",
    },
  },
  "/opendata/v1/regions/{id}/checklist": {
    get: {
      summary: "A region's species list",
      description:
        "Every species on the region's list with `scientificName`, `commonName`, `taxonClass`, `ebirdCode`, `tier`, `isVagrant` and `sensitiveByDefault`. 404 for an unknown region.",
    },
  },
  "/opendata/v1/gallery-vectors": {
    get: {
      summary: "Openly licensed reference vectors",
      description:
        "Gallery photo vectors whose photos are CC0, Public Domain Mark or CC BY, oldest first, each with `embedding`, `license`, `photographer` and `sourceUrl`. Page with `nextCursor`; pass the last `updatedAt` as `since` to fetch only new ones later. 409 `model_mismatch` when `space` isn't the model Lifer matches in.",
    },
  },
  "/opendata/v1/attribution": {
    get: {
      summary: "Credits for the open reference vectors",
      description:
        "The same items as GET /opendata/v1/gallery-vectors without the vectors: `photographer`, `license` and `sourceUrl` of each photo, paged the same way.",
    },
  },
  "/opendata/v1/species/names": {
    post: {
      summary: "Lifer's names for scientific names",
      description:
        "Send up to 2000 `scientificNames`; each one Lifer knows, directly or as a superseded name, comes back with its `speciesId`, `gbifKey`, `canonicalScientificName`, `commonName`, `ebirdCode` and `abaCode`. Names Lifer doesn't know are left out. No user data.",
    },
  },
  "/opendata/v1/species/rank": {
    post: {
      summary: "Species ranked for one photo",
      description:
        "Body `{ model, regionId, vectors, takenAt?, limit? }`: up to 4 image embeddings of one subject from the model named in `model`, ranked with Lifer's own matching within `regionId`'s list (null for the user's own species), best first, `limit` 1-20. Uses openly licensed reference photos and the user's own photos only, with no tier or seasonality weighting, so weigh abundance yourself. Empty when the user turned species suggestions off. 409 `model_mismatch` when `model` isn't the one Lifer ranks in.",
    },
  },
  "/opendata/v1/species/rank-batch": {
    post: {
      summary: "Species ranked for many photos at once",
      description:
        "POST /opendata/v1/species/rank for up to 16 subjects in one request: `items` each hold `vectors` and `takenAt`, sharing one `model`, `regionId` and `limit`. `results` come back in the same order, each exactly what the single route answers for that item. 409 `model_mismatch` when `model` isn't the one Lifer ranks in.",
    },
  },

  // --- Opening a connected app inside Lifer (desktop app) ---
  "/plugins/v1/host-preference": {
    get: {
      summary: "Whether the app opens inside Lifer",
      description:
        "`openInHost` for the connected app behind the key. Desktop app only (404 on a server); 403 for a key the user made by hand.",
    },
  },
  "/plugins/v1/host-preference/request": {
    post: {
      summary: "Ask to open inside Lifer, or to stop",
      description:
        "Body `{ openInHost }`. Lifer asks the person in its window and the answer waits for their choice: `granted` and the `openInHost` now in effect. Asking for what's already set answers at once. Desktop app only; at most 10 calls a minute per app.",
    },
  },
  "/plugins/v1/host/open": {
    post: {
      summary: "Bring Lifer forward showing the app",
      description:
        "Body `{ pluginId }`, the app's own id: an app opens only itself, and only once the person allowed opening inside Lifer (403 otherwise). `ok` false with `reason` `busy` (a dialog is waiting), `not_ready` (the window didn't show the app in time) or `no_frame` (Lifer's window isn't open on this library). Desktop app only; at most 10 calls a minute per app.",
    },
  },

  "/imports/v1/folders": {
    post: {
      summary: "Import a folder of photos (desktop app)",
      description:
        "Starts a background import of a folder on the same computer: ratings, picks, labels and species keywords in the files' XMP are read as in Lifer's own import, and photos Lifer already has are skipped. `mode` `in-place` leaves the files where they are, but only inside a folder or drive Lifer already knows; anywhere else (or with `copy`) Lifer files a copy by species and the answer's `mode` says which happened. 409 while another import runs.",
    },
  },
  "/imports/v1/species-lookup": {
    post: {
      summary: "Find species ids by scientific name",
      description:
        "For imports: send up to 500 scientific names, get back `matches` (`name` as sent, `speciesId`, current `scientificName`, `match` `exact` or `synonym`) and `unmatched`. Case-insensitive; only current names and superseded names match, and nothing else from the catalog is returned. Use the `speciesId` in POST /uploads.",
    },
  },
  "/imports/v1/jobs/{id}": {
    get: {
      summary: "Progress of a folder import",
      description:
        "Counts of photos looked at, imported, already in Lifer, skipped and waiting for review. 404 for any id but the latest import's.",
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
  "/photos/{id}/phone": { get: { summary: "Phone full-screen image, 2,048px long edge (WebP)", binary: "image/webp" } },
  "/photos/{id}/full": {
    get: {
      summary: "Full-resolution JPEG",
      description:
        "The JPEG original, or a JPEG rendered from the other original or a RAW's preview, kept for an hour. 409 when its drive is not connected.",
      binary: "image/jpeg",
    },
  },
  "/photos/{id}/card": {
    get: {
      summary: "Species card image (WebP)",
      description: "A square cut to a card crop and scaled to `w` pixels, as the species cards show it.",
      binary: "image/webp",
    },
  },
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
  "/photos/{id}/audio": { get: { summary: "Sound recording file (supports Range requests)", binary: "audio/*" } },
  "/photos/{id}/frame": {
    post: {
      summary: "Save one frame of a video as a new photo",
      description:
        "Send `atSeconds`. The frame is saved at the video's full size and filed like any imported photo, with the video's species, region, trip and place. 200 with the existing photo for an exact copy you already have. 400 when no frame can be read at that time, 404 when the photo isn't a video, 409 when its drive isn't connected.",
    },
  },

  // --- Importing and editing photos ---
  "/uploads": {
    post: {
      summary: "Import a photo",
      description:
        "multipart/form-data. Accepted photos: " +
        ACCEPTED_FORMATS_TEXT +
        '. A camera RAW (or a TIFF holding sensor data) can also be sent on its own. The file\'s own metadata (capture time, GPS, camera, star rating) is read on import. With `skipDuplicates=1`, an exact copy you already have returns that photo (200, `duplicate: true`) instead of a second one. `cullMarks` decides what happens to a photo a culling app rejected (xmp:Rating -1, a Lightroom, digiKam, Vireo or SuperPicky reject flag): `ignore` (the default) imports it, `skip` answers 200 with `skipped: "rejected"` and imports nothing, `hide` imports it hidden (`hidden: true`, out of the gallery and life list until unhidden). A verdict on `rawFile` counts for `file` too. Send the XMP sidecar of the file or its RAW as `xmpFile` (or `xmpUploadId`) and its rating, pick or reject, colour label and keywords are read as from a sidecar on disk. The 201 answer carries `sha256` (hex SHA-256 of the stored file, and of the duplicate on 200) and `rawSha256` when a RAW came with it, so you can verify the transfer. The file is only read, never changed. Instead of `file`, send `uploadId` (a finished resumable upload, see /uploads/tus) or, after POST /uploads/inspect, `stagedId` with `fileName` and `fileType` to import the copy the server kept. 410 means that copy is gone (expired, already imported or never finished), so send the file again; 409 means the same upload is being imported by another request.',
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
          xmpFile: { type: "string", format: "binary", description: "Optional XMP sidecar of `file` or `rawFile`" },
          xmpUploadId: { ...str, description: "Instead of `xmpFile`: the sidecar as a finished resumable upload" },
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
        cameraRegion: {
          ...str,
          description: "`1`: rank suggestions for the region of the photo's own GPS point, when it has one",
        },
      }),
    },
  },
  "/uploads/identify-animal": {
    post: {
      summary: "Match species on one animal in a photo being imported",
      description:
        "JSON with `uploadId` (a photo already checked with POST /uploads/inspect), `regionId` and `box`, the animal in percent of the upright photo (`subjectBoxes` from the check, or any area). Ranks species on that animal alone, and on the same area of the other frames of its burst, which `burst.uploadIds` lists. Saves nothing. 409 `models_not_ready` until the species-matching model is downloaded; 410 when the upload is gone.",
    },
  },
  "/uploads/space": {
    post: {
      summary: "Check free disk space for an import",
      description:
        "Send `files` (photos still to check or import) and `bytes` (their total size). `tier` is `ok`, `tight` (the batch plus a reserve of 5 GB or 5 percent doesn't fit: import one photo at a time) or `critical` (under 3 GB free: imports, checks and new uploads answer 507 `disk_full` until space is freed). `free` is the bytes free on the fullest drive the server writes to, null when unknown; `toFree` is how much to free so the rest of the batch fits.",
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
  "/captures/{id}/suggestions": {
    get: { summary: "Other likely species for a photo, from its stored vector. Empty when there is none" },
  },
  "/captures/{id}/species": { post: { summary: "Add another species shown in the photo" } },
  "/captures/{id}/species/{speciesId}": { delete: { summary: "Remove an additional species" } },
  "/captures/{id}/rating": { patch: { summary: "Set the star rating" } },
  "/captures/appearance": {
    post: {
      summary: "Set how the animal looks: life stage, sex, plumage and morph",
      description:
        "For one photo or many (`captureIds`). `lifeStage` is one of egg, larva, nymph, pupa, juvenile, subadult or adult; `sex` is male, female or unknown (looked at and can't tell). `plumage` and `morph` are free text up to 100 characters. A field left out stays as it is; null clears it. `updated` counts the photos changed.",
    },
  },
  "/captures/{id}/tags": { patch: { summary: "Replace the photo's tags" } },
  "/captures/{id}/taken-at": { patch: { summary: "Set the capture time" } },
  "/captures/{id}/region": {
    patch: { summary: "Set the region and/or location label", description: "A field left out stays as it is." },
  },
  "/captures/location": {
    post: {
      summary: "Set the region and optionally the location label of many photos",
      description: "Leave locationLabel out to keep each photo's own.",
    },
  },
  "/captures/coordinates": {
    post: {
      summary: "Set or clear the GPS coordinates of one or many photos",
      description:
        "Send lat and lon in decimal degrees, or both null to clear. The files' GPS follows in the background, in the file for a JPEG and in the sidecar for a RAW. More than 5,000 photos run in the background: background is true and GET /captures/location/status shows progress.",
    },
  },
  "/captures/location/undo": {
    post: {
      summary: "Undo the latest location change",
      description:
        "Location changes (coordinates, and filing photos under a saved spot) keep a history of 20 steps per user, held until Lifer restarts. Each call puts back one step: point, region, place name, source and accuracy. A placement still running is stopped first. Restored is 0 when there is nothing to undo.",
    },
  },
  "/captures/location/status": {
    get: {
      summary: "Progress of a big location change",
      description:
        "Placing more than 5,000 photos runs in the background. canUndo says whether POST /captures/location/undo has a step.",
    },
  },
  "/captures/location/cancel": { post: { summary: "Stop a big location change" } },
  "/captures/taken-at/preview": {
    post: {
      summary: "Date range of many photos, before adjusting their time",
      description: "And how many have no date.",
    },
  },
  "/captures/taken-at/shift": {
    post: {
      summary: "Move many photos' date and time by the same amount",
      description: "Runs in the background; files follow. Undo by sending the opposite minutes.",
    },
  },
  "/captures/taken-at/shift/status": { get: { summary: "Progress of a date and time adjustment" } },
  "/places": {
    get: {
      summary: "Every place name on your photos",
      description: "With photo counts and each name's most common region. Names in regionId come first.",
    },
  },
  "/places/rename": {
    post: { summary: "Rename a place name on every photo", description: "Into a name already in use, the two merge." },
  },
  "/places/remove": { post: { summary: "Take a place name off every photo", description: "Their regions stay." } },
  "/places/file-moves/status": { get: { summary: "Progress of files moving after a place rename" } },

  // --- Gallery ---
  "/gallery": {
    get: { summary: "Photos with filters, a page at a time (up to 500); prefer GET /captures for syncing" },
  },
  "/gallery/ids": {
    get: { summary: "Every capture id matching the GET /gallery filters, with the video and RAW ones listed again" },
  },
  "/gallery/search": { get: { summary: "Search photos by content, species, place, date, trip or album name" } },
  "/gallery/taxa": { get: { summary: "Taxon classes that have photos" } },
  "/gallery/regions-with-photos": { get: { summary: "Regions that have photos" } },
  "/gallery/has-video": { get: { summary: "Whether the library has any videos" } },
  "/gallery/similar": {
    get: {
      summary: "Groups of near-identical photos (bursts and repeats), largest first",
      description:
        "Photos of the same species, taken within 15 seconds and almost the same picture, or within 3 minutes and closer still, judged by their stored image vectors. Photos with no date or no vector are never grouped. List a group with GET /gallery?similarTo= its captureId. Lifer only lists them: nothing is changed or deleted.",
    },
  },
  "/captures/{id}/scene": {
    get: {
      summary: "A photo's burst and the scene around it",
      description:
        "A burst is the photos one camera took less than half a second apart (one second when the camera records whole seconds), cut where the picture changes completely and joined across a pause of up to 15 seconds that looks the same. A scene is the bursts taken one after another at one sighting: it ends at a gap of over 5 minutes, a move of over 200 m, or a different subject by the stored image vectors. Videos and recordings are left out, and a RAW with its JPEG is one photo. At most the 300 photos nearest the asked one are given, with truncated set when there were more.",
    },
  },
  "/gallery/appearance": {
    get: { summary: "The life stages, sexes, plumages and morphs in the library, with photo counts" },
  },
  "/gallery/map": {
    get: {
      summary: "Where the photos matching the GET /gallery filters are, for a map",
      description:
        "Photo counts per country and province (each country's count includes its provinces), and photos with coordinates grouped on a grid of about 100 m. A photo is placed only when it has coordinates: withoutCoordinates counts the ones that need placing, regionOnly those of them that have a region, and each region's regionOnlyCount the ones set to exactly it. A library with more than 20,000 grid cells gets a coarser grid and truncated set to true.",
    },
  },
  "/gallery/map/unplaced": {
    get: {
      summary: "The photos that need placing, grouped the way they were shot",
      description:
        "The GET /gallery filters, limited to photos without coordinates. Trips first, then sessions (a gap over an hour, a new region or a new day starts the next one); photos with no date are grouped per trip and region. state=region or state=none keeps the photos with only a region, or with no location at all. 50 groups a page.",
    },
  },
  "/gallery/map/unplaced/photos": {
    get: { summary: "The photos in one group from GET /gallery/map/unplaced, best rated first" },
  },

  // --- Species ---
  "/species": {
    get: {
      summary: "Search species by name, alias, old scientific name, code, genus or family (accents ignored)",
      description: "Each hit carries `gbif_key`, `inat_taxon_id` and `taxon_class` for matching it in other sources.",
    },
  },
  "/species/merges": {
    get: {
      summary: "Species folded into others by catalog updates",
      description:
        "Each `oldSpeciesId` with the `newSpeciesId` it now lives on (after any later merges), its `oldScientificName` and `mergedAt`. Pass a `mergedAt` back as `since` to get only newer merges. Small; no user data.",
    },
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
  "/stats/exif-bucket": { get: { summary: "Every photo behind one EXIF chart bar" } },
  "/stats/timeline": { get: { summary: "Photos per month by animal group" } },
  "/moved-photos/status": { get: { summary: "Whether photos moved on disk were found again, and what needs review" } },
  "/stats/year-comparison": { get: { summary: "Year-over-year comparison" } },

  // --- Trips ---
  "/trips": { get: { summary: "Trips" } },
  "/trips/{id}": { get: { summary: "Trip details" } },
  "/trips/{id}/summary": { get: { summary: "Trip summary" } },
  "/trips/{id}/species": { get: { summary: "Species seen on a trip" } },
  "/trips/{id}/photos": { get: { summary: "Photos from a trip" } },
  "/trips/{id}/suggestions": {
    get: {
      summary: "Photos taken during a trip but in no trip",
      description: "Photos the user dismissed for this trip, and hidden ones, are left out.",
    },
  },
  "/trips/matching": {
    post: { summary: "Trips some of these photos were taken during", description: "Body: `{ captureIds }`." },
  },
  "/trips/import-suggestions": {
    post: {
      summary: "Trips a batch of photos about to be imported may belong to",
      description:
        "Body: `{ groups }`, one entry per day's photos: `key`, their capture `times`, their GPS `points` and the `regionIds` they fall in. Returns the trips each group clearly fits, by date and place; nothing is changed.",
    },
  },
  "/trips/{id}/scan-preview": {
    get: {
      summary: "Preview of a file in a trip folder",
      description: "The image or video itself; a RAW, TIFF or HEIC file comes as a JPEG made from it.",
      binary: "*/*",
    },
  },
  "/trips/{id}/scan/status": { get: { summary: "Trip folder scan progress" } },
  "/trips/move-files/status": { get: { summary: "Progress of a trip's files moving" } },
  "/trips/{id}/import/status": { get: { summary: "Trip import progress" } },

  // --- Albums and shares ---
  "/portfolio/share": {
    post: {
      summary: "Create a public link to your portfolio",
      description:
        "The link is returned once, as `token`. A new link replaces the old one, which stops working. 409 on a desktop app, since share links need a Lifer server.",
    },
    delete: { summary: "Turn off your portfolio's public link" },
  },
  "/albums": {
    get: { summary: "Albums" },
    post: { summary: "Create an album" },
  },
  "/albums/{id}": {
    get: { summary: "Album details" },
    patch: { summary: "Update an album" },
    delete: { summary: "Delete an album (photos are kept)" },
  },
  "/albums/suggestions": {
    get: {
      summary: "Suggested smart albums",
      description:
        "Smart albums worth making from your own photos, each with its rules, live photo count and up to 4 preview photos. Nothing is created: post the rules to /albums to make one.",
    },
  },
  "/albums/suggestions/{id}/dismiss": { post: { summary: "Stop suggesting a smart album" } },
  "/albums/suggestions/{id}/restore": { post: { summary: "Bring back a dismissed smart album suggestion" } },
  "/pinned-filters": {
    get: { summary: "Pinned Gallery filters, in order" },
    put: {
      summary: "Replace the pinned Gallery filters",
      description:
        "Each pin is a name and the same `rules` a smart album takes (version 2, or 1 which is upgraded). The whole list is replaced, so adding, renaming, reordering and unpinning are one call. Up to 50 pins, names up to 80 characters.",
    },
  },
  "/identifications/suggested": {
    get: {
      summary: "Photos Lifer filed under a species that you haven't confirmed",
      description:
        "Lifer files a photo itself only for a confident match from its region's checklist, and the species counts on the life list marked `suggested` until you confirm. The photos come grouped into encounters (the same species and region with no gap of an hour or more), least sure first. Photos whose species you chose are never listed.",
    },
  },
  "/identifications/suggested/count": {
    get: {
      summary: "How many photos wait for review",
      description: "A count only, cheap enough to poll: the photos GET /identifications/suggested would list.",
    },
  },
  "/identifications/confirm": {
    post: {
      summary: "Confirm suggested identifications",
      description: "Marks the photos' species as yours. Photos already confirmed are left as they are.",
    },
  },
  "/changes": {
    get: { summary: "The latest recorded assistant changes" },
    post: {
      summary: "Record a change with the steps that undo it",
      description:
        "For assistants: after changing albums, record what was done and how to reverse it (`deleteAlbum`, or `removeFromAlbum` with the photos that were added). POST /changes/undo-last then reverses the newest change that hasn't been undone.",
    },
  },
  "/changes/undo-last": { post: { summary: "Undo the newest recorded change" } },
  "/albums/{id}/species": { get: { summary: "Species in an album" } },
  "/albums/{id}/captures": { post: { summary: "Add photos to an album" } },
  "/albums/{id}/captures/{captureId}": { delete: { summary: "Remove a photo from an album" } },
  "/albums/{id}/items/remove": {
    post: {
      summary: "Remove several photos from an album",
      description:
        "Body `{ captureIds }`, up to 500. Answers how many were `removed` and `skipped` (not in the album), and `addedAt` for each removed photo: pass it back to POST /albums/{id}/captures to undo with the photos in their old places. 409 for a smart album, which excludes photos instead.",
    },
  },
  "/albums/{id}/exclusions": {
    get: { summary: "Photos left out of a smart album" },
    post: { summary: "Leave photos out of a smart album" },
  },
  "/albums/{id}/exclusions/{captureId}": { delete: { summary: "Put a left-out photo back in a smart album" } },
  "/albums/{id}/exclusions/restore": { post: { summary: "Put several left-out photos back in a smart album" } },
  "/albums/{id}/cover-crop": { patch: { summary: "Set the album cover crop" } },
  "/albums/{id}/quad-slot": { patch: { summary: "Set a photo in a four-photo album cover" } },
  "/albums/{id}/shares": {
    get: { summary: "Share links for an album" },
    post: { summary: "Create a share link" },
  },
  "/shares/{id}": { delete: { summary: "Revoke a share link" } },
  "/shares/{id}/exact-locations": {
    put: { summary: "Choose whether a share link shows where its photos were taken" },
  },
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
  // The "sync" scope is the desktop app's own (auth/apiKeyRoutes.ts), not an integration surface.
  return [...routes].filter((r) => r.scope && r.scope !== "sync" && r.url.startsWith("/api/"));
}

/** Options for buildOpenApi. */
export interface OpenApiOptions {
  /** Every /api route rather than only the API-key ones, for the web app's generated types
   *  (`npm run gen:api-types`). Routes without a described answer get a response with no content. */
  internal?: boolean;
}

export function buildOpenApi(routes: Iterable<CatalogRoute>, { internal = false }: OpenApiOptions = {}): object {
  const paths: Record<string, Record<string, object>> = {};
  const selected = internal ? [...routes].filter((r) => r.url.startsWith("/api/")) : keyRoutes(routes);
  for (const route of selected) {
    const p = openApiPath(route.url);
    const method = route.method.toLowerCase() as Method;
    const text: OpText = OPS[p]?.[method] ?? { summary: `${route.method} ${p}` };
    const schema = (route.schema ?? {}) as Record<string, unknown>;
    const response = schema.response as Record<string, unknown> | undefined;
    // A route can answer more than one success, like POST /uploads' 200 for a duplicate and 201.
    const okStatuses = Object.keys(response ?? {}).filter((code) => /^2\d\d$/.test(code));
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
          : okStatuses.length
            ? Object.fromEntries(
                okStatuses.map((code) => [
                  code,
                  { description: "OK", content: { "application/json": { schema: plain(response![code]) } } },
                ]),
              )
            : internal
              ? { "200": { description: "Not described yet" } }
              : { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } } }),
      "400": errorResponse("The request doesn't match this operation's parameters or body"),
      "401": errorResponse(
        route.scope ? "Missing key, or the key lacks the " + route.scope + " scope" : "Not signed in",
      ),
      default: errorResponse("Any other error"),
    };
    paths[p] ??= {};
    paths[p][method] = {
      summary: text.summary,
      ...(text.description && { description: text.description }),
      ...(route.scope
        ? { tags: [route.scope.split(".")[0]], security: [{ apiKey: [] }], "x-required-scope": route.scope }
        : { tags: [p.split("/")[1]] }),
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
      // A fixed version for the generated web types, so a release doesn't make them stale.
      version: internal ? "internal" : APP_VERSION,
      description:
        "Routes an API key can reach on a Lifer server. Create keys under Settings > Account > API keys and send them as the `x-api-key` header. Each key only works for the scopes it was given (`x-required-scope` on each operation). See the API guide at https://sparklysparkspark.github.io/lifer-app/api/overview.",
    },
    servers: [{ url: "/api/v1" }],
    components: {
      securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "x-api-key" } },
      schemas: { Error: ErrorBody },
    },
    paths,
  };
}
