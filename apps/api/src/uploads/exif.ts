// Photo metadata via exiftool-vendored, which bundles its own exiftool binary. Metadata only:
// the image itself is never decoded here.
import { availableParallelism } from "node:os";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { ExifTool } from "exiftool-vendored";
import { TAXON_CLASS_LABEL, type TaxonClass } from "@lifer/shared";
import { pool } from "@lifer/core/db.js";
import { composeSpeciesName } from "./speciesFolderName.js";

// The library's default caps exiftool processes at a quarter of the cores; an import burst is
// latency-sensitive, so this instance uses every core.
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

// One parsed tag set for extractExif, extractKeywords and computeExifFingerprint, so a file
// (a RAW can be tens of megabytes) is read once.
export type ExifTags = Awaited<ReturnType<typeof exiftool.read>>;

export async function readExifTags(filePath: string): Promise<ExifTags> {
  return exiftool.read(filePath);
}

// The fields culling apps leave their verdicts in (cullMarks.ts), group-qualified so an EXIF
// Rating can't stand in for xmp:Rating, and so the read skips everything else in a big RAW.
const CULL_TAGS = [
  "-XMP-xmp:Rating",
  "-XMP-xmp:Label",
  "-XMP-xmpDM:Pick",
  "-XMP-xmpDM:Good",
  "-XMP-digiKam:PickLabel",
  "-XMP-digiKam:ColorLabel",
  "-XMP-photomech:Tagged",
  "-XMP-photomech:Prefs",
];

export async function readCullTags(filePath: string): Promise<Record<string, unknown>> {
  return (await exiftool.read(filePath, { readArgs: CULL_TAGS })) as unknown as Record<string, unknown>;
}

// What exiftool-vendored hands back for DateTimeOriginal (an ExifDateTime).
interface ExifDateLike {
  toDate(): Date;
  toDateTime?: (zone?: string) => { toJSDate(): Date };
  hasZone?: boolean;
  year?: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
  second?: number;
}

function dateTimeOriginal(tags: ExifTags | Record<string, unknown>): ExifDateLike | null {
  const dt = (tags as Record<string, unknown>).DateTimeOriginal;
  return dt && typeof dt === "object" && "toDate" in dt ? (dt as ExifDateLike) : null;
}

// EXIF DateTimeOriginal is a wall-clock time with no zone. When the file says which zone
// (OffsetTimeOriginal, or one exiftool-vendored reads from the file's other tags) that's used;
// otherwise the wall clock is read as UTC on every install, so taken_at and the RAW-matching
// fingerprint don't depend on the server's zone.
function captureInstant(dt: ExifDateLike): Date {
  if (dt.hasZone || typeof dt.toDateTime !== "function") return dt.toDate();
  return dt.toDateTime("UTC").toJSDate();
}

export interface CaptureTime {
  takenAt: Date;
  /** The camera's own clock reading, "YYYY-MM-DDTHH:MM:SS": what dated file names and year
   *  folders go by, whatever zone the server runs in. */
  wallClock: string;
  /** The time read in the server's own zone, only when that differs: older rows carry it. */
  legacyTakenAt: Date | null;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** The photo's capture time (see captureInstant), or null without a DateTimeOriginal. */
export function captureTimeFromTags(tags: ExifTags | Record<string, unknown>): CaptureTime | null {
  const dt = dateTimeOriginal(tags);
  if (!dt) return null;
  const takenAt = captureInstant(dt);
  const legacy = dt.toDate();
  const wallClock =
    dt.year != null && dt.month != null && dt.day != null
      ? `${pad(dt.year, 4)}-${pad(dt.month)}-${pad(dt.day)}T${pad(dt.hour ?? 0)}:${pad(dt.minute ?? 0)}:${pad(dt.second ?? 0)}`
      : takenAt.toISOString().slice(0, 19);
  return { takenAt, wallClock, legacyTakenAt: legacy.getTime() === takenAt.getTime() ? null : legacy };
}

export async function extractExif(filePath: string, tags?: ExifTags): Promise<ExtractedExif> {
  tags ??= await exiftool.read(filePath);

  const takenAt = captureTimeFromTags(tags)?.takenAt ?? null;

  // FocalLength comes back as a string like "400.0 mm", not a number.
  const focalLengthMm = typeof tags.FocalLength === "string" ? parseFloat(tags.FocalLength) : null;

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

// Keywords for matching species: IPTC Keywords and dc:subject lists, plus digiKam's TagsList and
// Lightroom's HierarchicalSubject paths ("Birds/Waterfowl/Mallard", "Birds|Waterfowl|Mallard"),
// of which only the leaf is kept. Read from the raw tags, since these aren't in the typed Tags.
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

// A ".xmp" sidecar next to the image (common for RAWs). "IMG_0001.xmp" is checked before
// "IMG_0001.CR2.xmp" since it's the Lightroom and digiKam default.
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

// extractKeywords plus the sidecar's keywords, for photos tagged only in their sidecar.
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

// Not captures.fingerprint (a content hash): a hash of the EXIF fields a RAW and its JPEG share
// for one shutter press, so a RAW can be matched to its JPEG. Null without DateTimeOriginal.
// `loose` leaves out SubSecTimeOriginal and SerialNumber, which exports often strip; it's the
// fallback when `strict` finds nothing.
export interface ExifFingerprint {
  strict: string | null;
  loose: string | null;
  /** The pair as this install computed it before capture times stopped depending on the
   *  server's zone; only present when different. Look it up when the current pair finds
   *  nothing, so files stored earlier still match. */
  legacy?: { strict: string; loose: string };
}

function fingerprintPair(isoDate: string, rawTags: Record<string, unknown>): { strict: string; loose: string } {
  const strictParts = [
    isoDate,
    String(rawTags.SubSecTimeOriginal ?? ""),
    String(rawTags.Model ?? ""),
    String(rawTags.SerialNumber ?? ""),
  ];
  const looseParts = [isoDate, String(rawTags.Model ?? "")];
  return {
    strict: createHash("sha256").update(strictParts.join("|")).digest("hex"),
    loose: createHash("sha256").update(looseParts.join("|")).digest("hex"),
  };
}

// The date part is the capture instant's ISO string, matching what a UTC server stores; a
// server outside UTC also keeps its old zone-based value in `legacy`.
export function fingerprintFromTags(tags: ExifTags | Record<string, unknown>): ExifFingerprint {
  const time = captureTimeFromTags(tags);
  if (!time) return { strict: null, loose: null };
  const rawTags = tags as Record<string, unknown>;
  const current = fingerprintPair(time.takenAt.toISOString(), rawTags);
  return time.legacyTakenAt
    ? { ...current, legacy: fingerprintPair(time.legacyTakenAt.toISOString(), rawTags) }
    : current;
}

export async function computeExifFingerprint(filePath: string, tags?: ExifTags): Promise<ExifFingerprint> {
  return fingerprintFromTags(tags ?? (await exiftool.read(filePath)));
}

// A RAW's embedded preview, largest first (not every camera writes all three).
const PREVIEW_TAGS = ["PreviewImage", "JpgFromRaw", "ThumbnailImage"] as const;

export async function extractEmbeddedPreview(filePath: string): Promise<Buffer | null> {
  for (const tag of PREVIEW_TAGS) {
    try {
      const buffer = await exiftool.extractBinaryTagToBuffer(tag, filePath);
      if (buffer.length > 0) return buffer;
    } catch {
      // Not in this file; try the next tag.
    }
  }
  return null;
}

// Species tags embedded in the file so they travel with it, in the shapes extractKeywords reads
// back. Store mode only: a linked file isn't Lifer's to modify.
export interface SpeciesMetadata {
  commonName: string | null;
  scientificName: string;
  taxonClass: string | null;
  taxonOrder?: string | null;
  family: string | null;
  abaCode?: string | null;
  ebirdCode?: string | null;
}

// Every species in the photo is written; metas[0] is the primary for the title. namingStyles only
// changes the title and hierarchy label: Keywords keep the plain common and scientific names,
// which reimport matching relies on, with codes added as extra keywords.
export async function writeSpeciesMetadata(
  filePath: string,
  metas: SpeciesMetadata[],
  namingStyles: string[] = [],
): Promise<void> {
  await writeLiferMetadata(filePath, { species: metas, namingStyles }, "embedded");
}

// The bare-stem name ("IMG_0001.xmp"), the one findSidecarPath checks first.
export function sidecarPathFor(imagePath: string): string {
  const ext = path.extname(imagePath);
  const stem = path.basename(imagePath, ext);
  return path.join(path.dirname(imagePath), `${stem}.xmp`);
}

// Formats whose metadata other tools read from inside the file (Lightroom ignores a sidecar next
// to a JPEG/TIFF/PNG/DNG). RAW formats and anything else get a sidecar.
const EMBEDDED_METADATA_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".tif",
  ".tiff",
  ".png",
  ".dng",
  ".webp",
  ".heic",
  ".heif",
  ".hif",
]);

export function metadataGoesInFile(filePath: string): boolean {
  return EMBEDDED_METADATA_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export interface XmpSidecarData {
  species: SpeciesMetadata[];
  namingStyles: string[];
  /** undefined leaves the file's rating alone (see syncCaptureXmpSidecars); null clears it. */
  rating: number | null | undefined;
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
  /** The photo's own tags ("flight shot"), written as plain keywords. undefined leaves the
   *  file's Lifer tags as they are. */
  tags?: string[];
  /** The photo's region as names, written only into location fields the file leaves empty. */
  place?: PhotoPlace | null;
  /** True when the region was just changed in Lifer: the file's location follows it. */
  replacePlace?: boolean;
}

// A standalone ".xmp" sidecar (created fresh if it doesn't exist) carrying what Lifer knows about
// a RAW photo: species tags, the star rating, whether it's the species' cover photo, and its GPS
// (which may come from Lifer rather than the camera). Not the camera's own EXIF: Lightroom treats a
// sidecar's capture time as an override, so a copy could shift it. The card crop stays in Lifer.
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
  /** undefined leaves the file's Lifer tags as they are; [] removes them. */
  tags?: string[];
  place?: PhotoPlace | null;
  /** Write `place` over the file's location fields, not only into empty ones. */
  replacePlace?: boolean;
}

/** Where a photo was taken, as names: the photo's region's province or state, and country. */
export interface PhotoPlace {
  state: string | null;
  country: string | null;
  /** ISO 3166-1 alpha-2 ("CA"), for XMP's CountryCode. */
  countryCode: string | null;
  /** ISO 3166-1 alpha-3 ("CAN"), for the IPTC-IIM country code inside a JPEG. */
  countryCode3: string | null;
}

const COVER_KEYWORD = "Lifer:Cover";
const SPECIES_ROOT = "Species";
// Each photo tag is written twice: as a plain keyword, which every tool shows, and under this
// hierarchy root, which records that the keyword is Lifer's, so removing the tag in Lifer removes
// it from the file and never a keyword another tool added. "|" is the hierarchy separator, so a
// tag's own "|" is written as "/" there.
const TAGS_ROOT = "Lifer Tags";
const tagMarker = (tag: string) => `${TAGS_ROOT}|${tag.replaceAll("|", "/")}`;

// One write at a time per file, in request order, so the upload's background write can't
// overwrite a later species change or rating.
const fileWriteQueues = new Map<string, Promise<void>>();

function writeLiferMetadata(target: string, data: LiferTags, mode: "embedded" | "sidecar"): Promise<void> {
  const prior = fileWriteQueues.get(target) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(() => writeLiferMetadataNow(target, data, mode));
  fileWriteQueues.set(target, next);
  next
    .finally(() => {
      if (fileWriteQueues.get(target) === next) fileWriteQueues.delete(target);
    })
    .catch(() => {});
  return next;
}

async function writeLiferMetadataNow(target: string, data: LiferTags, mode: "embedded" | "sidecar"): Promise<void> {
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
    [
      SPECIES_ROOT,
      m.taxonClass ? (TAXON_CLASS_LABEL[m.taxonClass as TaxonClass] ?? m.taxonClass) : null,
      m.family,
      labels[i],
    ]
      .filter(Boolean)
      .join("|"),
  );
  const kept = await keywordsToKeep(target);
  const photoTags = data.tags ?? kept.liferTags;
  const subject = [...new Set([...kept.flat, ...ours, ...photoTags])];
  const hierarchical = [...new Set([...kept.hierarchical, ...ourHierarchies, ...photoTags.map(tagMarker)])];
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
  // Province and country names, never coordinates: a region says where, not a point. Only empty
  // fields are filled, so a location typed in Lightroom (or a camera's own) is never replaced,
  // unless the region was just changed in Lifer, which the file then follows.
  if (data.place) {
    const p = data.place;
    const filled = data.replacePlace ? NO_LOCATION : kept.location;
    if (p.state && !filled.state) {
      tags["XMP-photoshop:State"] = p.state;
      if (mode === "embedded") tags["IPTC:Province-State"] = p.state;
    }
    if (p.country && !filled.country) {
      tags["XMP-photoshop:Country"] = p.country;
      if (mode === "embedded") tags["IPTC:Country-PrimaryLocationName"] = p.country;
    }
    if (p.countryCode && !filled.countryCode) {
      tags["XMP-iptcCore:CountryCode"] = p.countryCode;
      if (mode === "embedded" && p.countryCode3) tags["IPTC:Country-PrimaryLocationCode"] = p.countryCode3;
    }
  }
  if (data.rating !== undefined) tags["XMP-xmp:Rating"] = data.rating; // null deletes it
  if (mode === "sidecar") {
    if (data.lat != null) tags["XMP-exif:GPSLatitude"] = data.lat;
    if (data.lon != null) tags["XMP-exif:GPSLongitude"] = data.lon;
  }
  await exiftool.write(target, tags, { writeArgs: ["-overwrite_original"] });
}

/** The photo tags Lifer wrote into a file (its "Lifer Tags|..." keywords), so a reimport brings
 *  them back with the photo. */
export function extractLiferTags(tags: ExifTags | Record<string, unknown>): string[] {
  const raw = (tags as Record<string, unknown>).HierarchicalSubject;
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? [raw] : [];
  const prefix = `${TAGS_ROOT}|`;
  return [...new Set(list.filter((h) => h.startsWith(prefix)).map((h) => h.slice(prefix.length).trim()))].filter(
    Boolean,
  );
}

/** The keywords already in a file or sidecar that aren't Lifer's to replace: everything except
 * species names and codes (Lifer owns which species a photo shows), Lifer's cover marker,
 * Lifer's own "Species|..." hierarchy, and the photo tags Lifer wrote (marked under "Lifer
 * Tags|..."), so keywords added in other tools survive. `liferTags` are those photo tags, for a
 * write that leaves them as they are. */
interface LocationFilled {
  state: boolean;
  country: boolean;
  countryCode: boolean;
}
const NO_LOCATION: LocationFilled = { state: false, country: false, countryCode: false };

async function keywordsToKeep(
  target: string,
): Promise<{ flat: string[]; hierarchical: string[]; liferTags: string[]; location: LocationFilled }> {
  if (!existsSync(target)) return { flat: [], hierarchical: [], liferTags: [], location: NO_LOCATION };
  let raw: Record<string, unknown>;
  try {
    raw = (await exiftool.read(target)) as unknown as Record<string, unknown>;
  } catch {
    return { flat: [], hierarchical: [], liferTags: [], location: NO_LOCATION };
  }
  const filled = (...keys: string[]) =>
    keys.some((k) => typeof raw[k] === "string" && (raw[k] as string).trim() !== "");
  const location = {
    state: filled("State", "Province-State"),
    country: filled("Country", "Country-PrimaryLocationName"),
    countryCode: filled("CountryCode", "Country-PrimaryLocationCode"),
  };
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);
  const allHierarchical = list(raw.HierarchicalSubject);
  const markers = new Set(allHierarchical.filter((h) => h.startsWith(`${TAGS_ROOT}|`)));
  const isLiferTag = (k: string) => markers.has(tagMarker(k));
  const allFlat = [...new Set([...list(raw.Subject), ...list(raw.Keywords)])].filter((k) => k !== COVER_KEYWORD);
  const liferTags = allFlat.filter(isLiferTag);
  const flat = allFlat.filter((k) => !isLiferTag(k));
  const hierarchical = allHierarchical.filter(
    (h) => !h.startsWith(`${SPECIES_ROOT}|`) && !h.startsWith(`${SPECIES_ROOT}/`) && !markers.has(h),
  );
  if (flat.length === 0) return { flat, hierarchical, liferTags, location };
  const speciesWords = await pool.query<{ k: string }>(
    `SELECT DISTINCT lower(k) AS k FROM species, unnest(ARRAY[common_name, scientific_name, aba_code, ebird_code]) AS k
     WHERE k IS NOT NULL AND lower(k) = ANY($1)`,
    [flat.map((k) => k.toLowerCase())],
  );
  const species = new Set(speciesWords.rows.map((r) => r.k));
  return { flat: flat.filter((k) => !species.has(k.toLowerCase())), hierarchical, liferTags, location };
}

export async function closeExiftool(): Promise<void> {
  await exiftool.end();
}
