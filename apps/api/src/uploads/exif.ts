// exiftool-vendored bundles its own exiftool binary, so there's no system-install dependency
// (: "Image processing: sharp... EXIF via exiftool"). It reads metadata only —
//rule 3, Lifer never decodes the image itself for this.
import { availableParallelism } from "node:os";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { ExifTool } from "exiftool-vendored";
import { TAXON_CLASS_LABEL, type TaxonClass } from "@lifer/shared";
import { pool } from "../db.js";
import { composeSpeciesName } from "./speciesFolderName.js";

// The library's default singleton caps concurrent exiftool worker processes at 1/4 of the
// CPU count, tuned for a shared multi-tenant server. Lifer is a single-user desktop app where
// a burst of several photos uploaded at once (each needing 1-2 exiftool calls) is a normal,
// latency-sensitive workload, not something to throttle — so a dedicated instance uses the
// full core count instead of accepting that shared-server-friendly default.
const exiftool = new ExifTool({ maxProcs: Math.max(1, availableParallelism()) });

export interface ExtractedExif {
  takenAt: Date | null;
  lat: number | null;
  lon: number | null;
  cameraModel: string | null;
  lens: string | null;
  focalLengthMm: number | null;
  aperture: number | null;
  shutter: string | null;
  iso: number | null;
  /** The file's own star rating (xmp:Rating, 1-5), as set by Lightroom, digiKam or a culling
   *  tool like SuperPicky; a RAW's is read from its sidecar when the file has none. 0 (unrated)
   *  and -1 (rejected) read as null, since Lifer ratings are 1-5. */
  rating: number | null;
}

function ratingOf(tags: Record<string, unknown>): number | null {
  const r = Number(tags.Rating);
  return Number.isInteger(r) && r >= 1 && r <= 5 ? r : null;
}

// extractExif and computeExifFingerprint both need a parsed tag set; calling
// exiftool.read(filePath) independently in each would mean two full metadata parses of the
// same file (RAW files in particular can be tens of megabytes) for every upload, when a
// single read covers both. Callers that need both (see uploads/routes.ts) should call this
// once and pass the result to each.
export type ExifTags = Awaited<ReturnType<typeof exiftool.read>>;

export async function readExifTags(filePath: string): Promise<ExifTags> {
  return exiftool.read(filePath);
}

export async function extractExif(filePath: string, tags?: ExifTags): Promise<ExtractedExif> {
  tags ??= await exiftool.read(filePath);

  const takenAt =
    tags.DateTimeOriginal && typeof tags.DateTimeOriginal === "object" && "toDate" in tags.DateTimeOriginal
      ? tags.DateTimeOriginal.toDate()
      : null;

  // FocalLength comes back as a string like "400.0 mm", not a number.
  const focalLengthMm =
    typeof tags.FocalLength === "string" ? parseFloat(tags.FocalLength) : null;

  return {
    takenAt,
    lat: typeof tags.GPSLatitude === "number" ? tags.GPSLatitude : null,
    lon: typeof tags.GPSLongitude === "number" ? tags.GPSLongitude : null,
    cameraModel: tags.Model ?? null,
    lens: tags.LensModel ?? tags.Lens ?? null,
    focalLengthMm: focalLengthMm != null && Number.isFinite(focalLengthMm) ? focalLengthMm : null,
    aperture: typeof tags.FNumber === "number" ? tags.FNumber : null,
    shutter: tags.ShutterSpeed != null ? String(tags.ShutterSpeed) : null,
    iso: typeof tags.ISO === "number" ? tags.ISO : null,
    rating: ratingOf(tags as unknown as Record<string, unknown>) ?? (await sidecarRating(filePath)),
  };
}

async function sidecarRating(filePath: string): Promise<number | null> {
  const sidecar = findSidecarPath(filePath);
  if (!sidecar) return null;
  try {
    return ratingOf((await exiftool.read(sidecar)) as unknown as Record<string, unknown>);
  } catch {
    return null; // an unreadable sidecar just means no rating
  }
}

// Reads existing XMP TagsList and IPTC Keywords to auto-match species names (spec §9).
// IPTC Keywords and XMP dc:subject are both plain string lists; digiKam's own
// XMP-digiKam:TagsList and Lightroom's XMP-lr:HierarchicalSubject store hierarchical tags as
// paths ("Birds/Waterfowl/Mallard" in digiKam, "Birds|Waterfowl|Mallard" in Lightroom); the leaf segment is the actual
// subject, so that's what gets returned rather than the whole path. Not part of
// exiftool-vendored's strongly-typed Tags interface (an uncommon tag set), so read through
// the raw object instead.
export async function extractKeywords(filePath: string, tags?: ExifTags): Promise<string[]> {
  const rawTags = (tags ?? (await exiftool.read(filePath))) as unknown as Record<string, unknown>;
  const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);

  const all = [
    ...asStrings(rawTags.Keywords),
    ...asStrings(rawTags.Subject),
    ...asStrings(rawTags.TagsList),
    ...asStrings(rawTags.HierarchicalSubject),
  ];
  // Lightroom separates hierarchy levels with "|", digiKam's TagsList with "/".
  const leaves = all.map((t) => t.split(/[|/]/).pop()!.trim()).filter(Boolean);
  return [...new Set(leaves)];
}

// Many tools (Lightroom especially, for RAW formats it won't write into directly) keep a
// photo's tags in a companion ".xmp" file next to the image rather than embedding them —
// same information, different place, and easy to miss if only the image file itself ever
// gets read. Two conventions both see real use: "IMG_0001.xmp" (sidecar named after the bare
// stem) and "IMG_0001.CR2.xmp" (sidecar named after the full original filename) — checked in
// that order since the bare-stem form is the more common Lightroom/digiKam default.
export function findSidecarPath(imagePath: string): string | null {
  const dir = path.dirname(imagePath);
  const ext = path.extname(imagePath);
  const stem = path.basename(imagePath, ext);
  const bareStemSidecar = path.join(dir, `${stem}.xmp`);
  if (existsSync(bareStemSidecar)) return bareStemSidecar;
  const fullNameSidecar = path.join(dir, `${path.basename(imagePath)}.xmp`);
  if (existsSync(fullNameSidecar)) return fullNameSidecar;
  return null;
}

// Same keyword extraction as extractKeywords, but unions in a sidecar's own tags (see
// findSidecarPath) when one exists next to the image — a photo tagged entirely in its sidecar
// (no embedded metadata at all) would otherwise look completely untagged.
export async function extractKeywordsWithSidecar(filePath: string, tags?: ExifTags): Promise<string[]> {
  const own = await extractKeywords(filePath, tags);
  const sidecarPath = findSidecarPath(filePath);
  if (!sidecarPath) return own;
  try {
    const sidecarKeywords = await extractKeywords(sidecarPath);
    return [...new Set([...own, ...sidecarKeywords])];
  } catch {
    // A malformed/unreadable sidecar shouldn't block matching on the image's own tags.
    return own;
  }
}

// This EXIF-based "fingerprint" is distinct from `captures.fingerprint`, a sha256 content
// hash used for upload dedup (a different concept). This hashes the handful of EXIF fields
// that should be identical between a camera's RAW and its JPEG sibling for the same shutter
// press, so a separately-discovered RAW file can be matched to an already-uploaded JPEG
// despite being completely different bytes. Null when DateTimeOriginal is missing — too
// weak a signal to match on without it.
//
// Two fingerprints, not one: an exported JPEG (Lightroom, Capture One, etc.) commonly
// strips SubSecTimeOriginal and SerialNumber (some export presets drop the camera serial as
// a deliberate privacy default), so the strict fingerprint would silently never match its
// own RAW sibling. `loose` drops those two fragile fields (keeping just the
// second-resolution timestamp + camera model) as a fallback match, tried only when the
// strict one finds nothing — same "unique match required, else flag for review" safety rule
// already used everywhere else this fingerprint matters.
export interface ExifFingerprint {
  strict: string | null;
  loose: string | null;
}

export async function computeExifFingerprint(filePath: string, tags?: ExifTags): Promise<ExifFingerprint> {
  const rawTags = (tags ?? (await exiftool.read(filePath))) as unknown as Record<string, unknown>;
  const dateTimeOriginal = rawTags.DateTimeOriginal;
  if (!dateTimeOriginal || typeof dateTimeOriginal !== "object" || !("toDate" in dateTimeOriginal)) {
    return { strict: null, loose: null };
  }
  const isoDate = (dateTimeOriginal as { toDate: () => Date }).toDate().toISOString();

  const strictParts = [isoDate, String(rawTags.SubSecTimeOriginal ?? ""), String(rawTags.Model ?? ""), String(rawTags.SerialNumber ?? "")];
  const looseParts = [isoDate, String(rawTags.Model ?? "")];
  return {
    strict: createHash("sha256").update(strictParts.join("|")).digest("hex"),
    loose: createHash("sha256").update(looseParts.join("|")).digest("hex"),
  };
}

// Embedded-preview extraction for captures with a RAW but no JPEG — tries the largest
// available embedded image first, falling back to smaller ones rather than failing outright
// (not every RAW format/camera populates all three).
const PREVIEW_TAGS = ["PreviewImage", "JpgFromRaw", "ThumbnailImage"] as const;

export async function extractEmbeddedPreview(filePath: string): Promise<Buffer | null> {
  for (const tag of PREVIEW_TAGS) {
    try {
      const buffer = await exiftool.extractBinaryTagToBuffer(tag, filePath);
      if (buffer.length > 0) return buffer;
    } catch {
      // Try the next tag — this format/camera just doesn't have this particular preview.
    }
  }
  return null;
}

// Species metadata gets embedded directly in the JPEG itself (not a sidecar file, so it
// travels with the file no matter where it's copied — Immich, Lightroom, a USB drive)
// rather than only ever living in Lifer's own database. Written in the same
// tag shapes extractKeywords already reads back (Keywords/Subject flat list,
// HierarchicalSubject path), so re-importing a Lifer-tagged photo elsewhere round-trips
// correctly. "store" mode only (see uploads/routes.ts) — a linked/external file isn't
// Lifer's to modify.
export interface SpeciesMetadata {
  commonName: string | null;
  scientificName: string;
  taxonClass: string | null;
  taxonOrder?: string | null;
  family: string | null;
  abaCode?: string | null;
  ebirdCode?: string | null;
}

// Supports multi-species photos (e.g. a hawk catching a fish): every depicted species is
// written, not just the primary one, so the file itself reflects all of them even outside
// Lifer. `metas[0]` is treated as the primary for ObjectName/title purposes.
//
// namingStyles only ever changes the PRIMARY label (ObjectName + the last HierarchicalSubject
// segment) — Keywords/Subject always keep the plain common + scientific name regardless of
// this setting, since matchSpeciesByKeywords (reimport.ts) matches incoming files against
// those two fields specifically; silently replacing them here would break that round-trip for
// anyone using the code-based naming styles. The resolved code(s) (when this species actually
// has them) are still added as EXTRA keywords either way, so they're searchable in external
// tools too. Common name is always the base label; any selected style(s) get appended alongside
// it rather than replacing it (composeSpeciesName, shared with speciesFolderName.ts).
export async function writeSpeciesMetadata(
  filePath: string,
  metas: SpeciesMetadata[],
  namingStyles: string[] = [],
): Promise<void> {
  await writeLiferMetadata(filePath, { species: metas, namingStyles }, "embedded");
}

// The bare-stem convention ("IMG_0001.xmp", not "IMG_0001.CR2.xmp") — matches
// findSidecarPath's own read-side preference order (checked first there since it's "the more
// common Lightroom/digiKam default"), so a sidecar this app writes is the same one it — and any
// other tool defaulting to the same convention — would look for on a later read.
export function sidecarPathFor(imagePath: string): string {
  const ext = path.extname(imagePath);
  const stem = path.basename(imagePath, ext);
  return path.join(path.dirname(imagePath), `${stem}.xmp`);
}

// Formats whose metadata other tools read from inside the file. Lightroom ignores a sidecar next
// to a JPEG/TIFF/PNG/DNG and reads the embedded XMP instead, so a rating written only to a
// sidecar never showed up there. RAW formats (and anything else) get a sidecar, the one place
// Lightroom and digiKam look for a RAW's edits.
const EMBEDDED_METADATA_EXTENSIONS = new Set([".jpg", ".jpeg", ".tif", ".tiff", ".png", ".dng"]);

export function metadataGoesInFile(filePath: string): boolean {
  return EMBEDDED_METADATA_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export interface XmpSidecarData {
  species: SpeciesMetadata[];
  namingStyles: string[];
  rating: number | null;
  isCover: boolean;
  takenAt: Date | null;
  lat: number | null;
  lon: number | null;
  cameraModel: string | null;
  lens: string | null;
  focalLengthMm: number | null;
  aperture: number | null;
  shutter: string | null;
  iso: number | null;
}

// A standalone ".xmp" sidecar (created fresh if it doesn't exist) carrying what Lifer knows about
// a RAW photo: species tags, the star rating, whether it's the species' cover photo, and its GPS
// (which may come from Lifer rather than the camera). Deliberately NOT the camera's own EXIF
// (capture time, lens, exposure): the RAW already carries it exactly, and Lightroom treats a
// sidecar's capture time as an override, so a copy with a slightly different time zone reading
// would silently shift the photo's time there. Nor the card-crop region: that needs Lightroom's
// own multi-field crs:Crop* schema, untested here, so crop stays a Lifer-only concept.
export async function writeXmpSidecar(imagePath: string, data: XmpSidecarData): Promise<void> {
  await writeLiferMetadata(sidecarPathFor(imagePath), data, "sidecar");
}

/** Writes Lifer's tags where other tools look for them: inside a JPEG/TIFF/PNG/DNG, in a
 * sidecar for a RAW. Used for every change a capture's metadata carries (species, rating,
 * cover). */
export async function writeCaptureMetadata(imagePath: string, data: XmpSidecarData): Promise<void> {
  if (metadataGoesInFile(imagePath)) await writeLiferMetadata(imagePath, data, "embedded");
  else await writeXmpSidecar(imagePath, data);
}

interface LiferTags {
  species: SpeciesMetadata[];
  namingStyles: string[];
  isCover?: boolean;
  /** undefined leaves the file's rating alone; null clears it. */
  rating?: number | null;
  lat?: number | null;
  lon?: number | null;
}

const COVER_KEYWORD = "Lifer:Cover";
const SPECIES_ROOT = "Species";

// Standard fields both Lightroom and digiKam read: dc:subject (flat keywords), IPTC Keywords
// (older readers, embedded only), lr:hierarchicalSubject with "|" between levels (Lightroom's
// keyword tree; digiKam reads it too), dc:title/IPTC ObjectName (title), xmp:Rating (stars).
// Written with explicit groups so each value lands in exactly one field: the unqualified names
// wrote every keyword into dc:subject twice and put a stray pdf:Keywords into sidecars.
async function writeLiferMetadata(target: string, data: LiferTags, mode: "embedded" | "sidecar"): Promise<void> {
  const labels = data.species.map((m) =>
    composeSpeciesName(
      m.commonName,
      m.scientificName,
      data.namingStyles,
      { abaCode: m.abaCode ?? null, ebirdCode: m.ebirdCode ?? null },
      (part) => part,
      { taxonClass: m.taxonClass, taxonOrder: m.taxonOrder ?? null, family: m.family },
    ),
  );
  const ours = data.species
    .flatMap((m) => [m.commonName, m.scientificName, m.abaCode, m.ebirdCode])
    .filter((v): v is string => !!v);
  if (data.isCover) ours.push(COVER_KEYWORD);
  const ourHierarchies = data.species.map((m, i) =>
    [SPECIES_ROOT, m.taxonClass ? (TAXON_CLASS_LABEL[m.taxonClass as TaxonClass] ?? m.taxonClass) : null, m.family, labels[i]]
      .filter(Boolean)
      .join("|"),
  );
  const kept = await keywordsToKeep(target);
  const subject = [...new Set([...kept.flat, ...ours])];
  const hierarchical = [...new Set([...kept.hierarchical, ...ourHierarchies])];
  const title = labels.join(", ");

  const tags: Record<string, unknown> = {
    "XMP-dc:Subject": subject,
    "XMP-lr:HierarchicalSubject": hierarchical,
    "XMP-dc:Title": title,
  };
  if (mode === "embedded") {
    tags["IPTC:Keywords"] = subject;
    tags["IPTC:ObjectName"] = title;
  }
  if (data.rating !== undefined) tags["XMP-xmp:Rating"] = data.rating; // null deletes it
  if (mode === "sidecar") {
    if (data.lat != null) tags["XMP-exif:GPSLatitude"] = data.lat;
    if (data.lon != null) tags["XMP-exif:GPSLongitude"] = data.lon;
  }
  await exiftool.write(target, tags, { writeArgs: ["-overwrite_original"] });
}

/** The keywords already in a file or sidecar that aren't Lifer's to replace: everything except
 * species names and codes (Lifer owns which species a photo shows), Lifer's cover marker, and
 * Lifer's own "Species|..." hierarchy. Writing used to replace the whole list, wiping keywords
 * added in Lightroom or digiKam ("sunset", "backyard") every time Lifer touched the file. */
async function keywordsToKeep(target: string): Promise<{ flat: string[]; hierarchical: string[] }> {
  if (!existsSync(target)) return { flat: [], hierarchical: [] };
  let raw: Record<string, unknown>;
  try {
    raw = (await exiftool.read(target)) as unknown as Record<string, unknown>;
  } catch {
    return { flat: [], hierarchical: [] };
  }
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);
  const flat = [...new Set([...list(raw.Subject), ...list(raw.Keywords)])].filter((k) => k !== COVER_KEYWORD);
  const hierarchical = list(raw.HierarchicalSubject).filter(
    (h) => !h.startsWith(`${SPECIES_ROOT}|`) && !h.startsWith(`${SPECIES_ROOT}/`),
  );
  if (flat.length === 0) return { flat, hierarchical };
  const speciesWords = await pool.query<{ k: string }>(
    `SELECT DISTINCT lower(k) AS k FROM species, unnest(ARRAY[common_name, scientific_name, aba_code, ebird_code]) AS k
     WHERE k IS NOT NULL AND lower(k) = ANY($1)`,
    [flat.map((k) => k.toLowerCase())],
  );
  const species = new Set(speciesWords.rows.map((r) => r.k));
  return { flat: flat.filter((k) => !species.has(k.toLowerCase())), hierarchical };
}

export async function closeExiftool(): Promise<void> {
  await exiftool.end();
}
