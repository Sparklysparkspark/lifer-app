// Photo metadata via exiftool-vendored, which bundles its own exiftool binary. Metadata only:
// the image itself is never decoded here.
import { availableParallelism, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ExifTool } from "exiftool-vendored";
import sharp from "sharp";
import { TAXON_CLASS_LABEL, type TaxonClass, type TemplatedField, type WriteRule } from "@lifer/shared";
import { pool } from "@lifer/core/db.js";
import { composeSpeciesName } from "./speciesFolderName.js";
import { DEFAULT_FILE_WRITE, sidecarsToWrite, type FileWriteSettings } from "./sidecarNames.js";

// The library's default caps exiftool processes at a quarter of the cores; an import burst is
// latency-sensitive, so this instance uses every core.
const exiftool = new ExifTool({ maxProcs: Math.max(1, availableParallelism()) });

export interface ExtractedExif {
  takenAt: Date | null;
  /** The camera's own clock reading as a UTC date, for anything that goes by local month or
   *  hour (species seasonality): takenAt is the instant, which a time zone can move a day. */
  localTakenAt: Date | null;
  /** Whether the file said which time zone the time is in. Without one the wall clock is read as
   *  UTC, so the sun's position from it can be hours off. Absent: not known. */
  takenAtZoned?: boolean | null;
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

/** sha256 of the image data alone, which a keyword or rating write leaves unchanged; null when
 *  exiftool can't hash this format. */
export async function imageDataHash(filePath: string): Promise<string | null> {
  const tags = await exiftool.read<ExifTags & { ImageDataHash?: string }>(filePath, {
    readArgs: ["-ImageDataHash", "-api", "ImageHashType=SHA256"],
  });
  return tags.ImageDataHash ?? null;
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

// exiftool's typed Tags, read by name: only for tags the typed shape doesn't declare.
const asTagRecord = (tags: object) => tags as Record<string, unknown>;

// What photo versions are grouped by (uploads/versionGrouping.ts): the XMP document lineage
// Lightroom and Photoshop write, and the shutter press it came from.
const VERSION_TAGS = [
  "-XMP-xmpMM:DocumentID",
  "-XMP-xmpMM:OriginalDocumentID",
  "-XMP-xmpMM:DerivedFromDocumentID",
  "-XMP-xmpMM:DerivedFromOriginalDocumentID",
  "-SubSecTimeOriginal",
  "-SerialNumber",
  "-Software",
];

export async function readVersionTags(filePath: string): Promise<Record<string, unknown>> {
  return asTagRecord(await exiftool.read(filePath, { readArgs: VERSION_TAGS }));
}

export async function readCullTags(filePath: string): Promise<Record<string, unknown>> {
  return asTagRecord(await exiftool.read(filePath, { readArgs: CULL_TAGS }));
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
  /** The file gave the time zone (see captureInstant). */
  zoned: boolean;
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
  return {
    takenAt,
    wallClock,
    legacyTakenAt: legacy.getTime() === takenAt.getTime() ? null : legacy,
    zoned: !!dt.hasZone,
  };
}

export async function extractExif(filePath: string, tags?: ExifTags): Promise<ExtractedExif> {
  tags ??= await exiftool.read(filePath);

  const time = captureTimeFromTags(tags);
  const takenAt = time?.takenAt ?? null;
  const localTakenAt = time ? new Date(`${time.wallClock}Z`) : null;

  // FocalLength comes back as a string like "400.0 mm", not a number.
  const focalLengthMm = typeof tags.FocalLength === "string" ? parseFloat(tags.FocalLength) : null;

  return {
    takenAt,
    localTakenAt: localTakenAt && !Number.isNaN(localTakenAt.getTime()) ? localTakenAt : takenAt,
    takenAtZoned: time ? time.zoned : null,
    lat: typeof tags.GPSLatitude === "number" ? tags.GPSLatitude : null,
    lon: typeof tags.GPSLongitude === "number" ? tags.GPSLongitude : null,
    cameraModel: tags.Model ?? null,
    lens: tags.LensModel ?? tags.Lens ?? null,
    focalLengthMm: focalLengthMm != null && Number.isFinite(focalLengthMm) ? focalLengthMm : null,
    aperture: typeof tags.FNumber === "number" ? tags.FNumber : null,
    shutter: tags.ShutterSpeed != null ? String(tags.ShutterSpeed) : null,
    iso: typeof tags.ISO === "number" ? tags.ISO : null,
    rating: ratingOf(asTagRecord(tags)) ?? (await sidecarRating(filePath)),
  };
}

async function sidecarRating(filePath: string): Promise<number | null> {
  const sidecar = await findSidecarPath(filePath);
  if (!sidecar) return null;
  try {
    return ratingOf(asTagRecord(await exiftool.read(sidecar)));
  } catch {
    return null; // an unreadable sidecar just means no rating
  }
}

// Keywords for matching species: IPTC Keywords and dc:subject lists, plus digiKam's TagsList and
// Lightroom's HierarchicalSubject paths ("Birds/Waterfowl/Mallard", "Birds|Waterfowl|Mallard"),
// of which only the leaf is kept. Read from the raw tags, since these aren't in the typed Tags.
export async function extractKeywords(filePath: string, tags?: ExifTags): Promise<string[]> {
  const rawTags = asTagRecord(tags ?? (await exiftool.read(filePath)));
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
export async function findSidecarPath(imagePath: string): Promise<string | null> {
  const dir = path.dirname(imagePath);
  const ext = path.extname(imagePath);
  const stem = path.basename(imagePath, ext);
  const bareStemSidecar = path.join(dir, `${stem}.xmp`);
  if (await exists(bareStemSidecar)) return bareStemSidecar;
  const fullNameSidecar = path.join(dir, `${path.basename(imagePath)}.xmp`);
  if (await exists(fullNameSidecar)) return fullNameSidecar;
  return null;
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

// extractKeywords plus the sidecar's keywords, for photos tagged only in their sidecar.
export async function extractKeywordsWithSidecar(filePath: string, tags?: ExifTags): Promise<string[]> {
  const own = await extractKeywords(filePath, tags);
  const sidecarPath = await findSidecarPath(filePath);
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

// A RAW's embedded previews (not every camera writes all three, and PreviewImage is the small
// one on some), so every tag is read and the biggest picture wins.
const PREVIEW_TAGS = ["PreviewImage", "JpgFromRaw", "ThumbnailImage"] as const;

export async function extractEmbeddedPreview(filePath: string): Promise<Buffer | null> {
  let best: Buffer | null = null;
  for (const tag of PREVIEW_TAGS) {
    try {
      const buffer = await exiftool.extractBinaryTagToBuffer(tag, filePath);
      if (buffer.length > (best?.length ?? 0)) best = buffer;
    } catch {
      // Not in this file; try the next tag.
    }
  }
  return best ? uprightPreview(best, filePath) : null;
}

// EXIF orientation values that turn the picture a quarter turn.
const QUARTER_TURNS = new Set([5, 6, 7, 8]);

/** A RAW's preview stored the way the sensor saw it (a portrait shot lying on its side), turned
 *  upright with the RAW's own Orientation. A preview that carries its own orientation, or is
 *  already the shape the orientation implies, is left as it is. */
async function uprightPreview(buffer: Buffer, filePath: string): Promise<Buffer> {
  const tags = await exiftool.read(filePath, { readArgs: ["-Orientation#"] }).catch(() => null);
  const orientation = Number(tags?.Orientation);
  if (!Number.isInteger(orientation) || orientation < 2 || orientation > 8) return buffer;
  const meta = await sharp(buffer)
    .metadata()
    .catch(() => null);
  if (!meta?.width || !meta.height || (meta.orientation && meta.orientation > 1)) return buffer;
  if (QUARTER_TURNS.has(orientation) && meta.height > meta.width) return buffer;
  const tagged = await sharp(buffer).withMetadata({ orientation }).jpeg({ quality: 92 }).toBuffer();
  return sharp(tagged).rotate().jpeg({ quality: 92 }).toBuffer();
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
  ".avif",
  // JP2 and JPX only: exiftool can't write into a bare .j2k/.j2c codestream.
  ".jp2",
  ".jpf",
  ".jpx",
]);

export function metadataGoesInFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  // exiftool writes into a JPEG XL container, but would have to rewrap a bare codestream.
  if (ext === ".jxl") return !isBareJxlCodestream(filePath);
  return EMBEDDED_METADATA_EXTENSIONS.has(ext);
}

function isBareJxlCodestream(filePath: string): boolean {
  try {
    const fd = openSync(filePath, "r");
    try {
      const head = Buffer.alloc(2);
      return readSync(fd, head, 0, 2, 0) === 2 && head[0] === 0xff && head[1] === 0x0a;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
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
  /** True when coordinates were just typed or cleared in Lifer: the file's GPS follows them,
   *  inside a JPEG too, where the camera's own GPS is otherwise never touched. */
  replaceGps?: boolean;
  /** The place name, as IPTC Sublocation. undefined leaves the file's as it is; null clears it. */
  locationLabel?: string | null;
  /** The user's copyright template, filled for this photo. */
  credits?: PhotoCredits;
  /** Title, Headline, Caption and extra keywords filled from the user's templates. Without it the
   *  title names every species and nothing else templated is written. */
  fields?: TemplatedWrites;
  /** The originals row, so what Lifer writes is recorded and only Lifer's own values are replaced. */
  originalId?: string;
}

/** Creator and rights as written into a file. Empty strings write nothing. */
export interface PhotoCredits {
  creator: string;
  copyright: string;
  credit: string;
  usageTerms: string;
  /** Write over a creator, copyright, credit or usage terms the file already has. */
  replaceExisting: boolean;
}

export interface FieldWrite {
  value: string;
  rule: WriteRule;
}
export interface TemplatedWrites {
  title: FieldWrite;
  headline: FieldWrite;
  caption: FieldWrite;
  keywords: { values: string[]; rule: WriteRule };
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
export async function writeCaptureMetadata(
  imagePath: string,
  data: XmpSidecarData,
  settings: FileWriteSettings = DEFAULT_FILE_WRITE,
): Promise<void> {
  const embeds = metadataGoesInFile(imagePath);
  if (embeds && settings.insideFiles) await writeLiferMetadata(imagePath, data, "embedded");
  else
    await Promise.all(
      (await sidecarsToWrite(imagePath, embeds, settings.sidecarNames)).map((p) => writeSidecarFile(p, data)),
    );
}

/** Writes Lifer's tags into the sidecar at `sidecarPath`, created when missing. */
export function writeSidecarFile(sidecarPath: string, data: XmpSidecarData): Promise<void> {
  return writeLiferMetadata(sidecarPath, data, "sidecar");
}

// Every capture-time tag a camera or Lightroom may have put in a JPEG/TIFF/DNG. Each moves by the
// same amount, so the file's zone (OffsetTimeOriginal) still describes it.
const CAPTURE_TIME_TAGS = [
  "EXIF:DateTimeOriginal",
  "EXIF:CreateDate",
  "XMP-exif:DateTimeOriginal",
  "XMP-xmp:CreateDate",
  "XMP-photoshop:DateCreated",
];

/** Moves the capture time where other tools read it, by `minutes` (negative moves it earlier): in
 *  the file for a JPEG/TIFF/DNG, in the sidecar for a RAW or video, never inside the RAW itself.
 *  A file with no capture time is left as it is. Shifting back by the same amount undoes it. */
export async function shiftCaptureTime(
  imagePath: string,
  minutes: number,
  settings: FileWriteSettings = DEFAULT_FILE_WRITE,
): Promise<void> {
  const shift = `${minutes < 0 ? "-" : "+"}0:0:0 0:${Math.abs(minutes)}:0`;
  const embeds = metadataGoesInFile(imagePath);
  if (embeds && settings.insideFiles) {
    return queuedWrite(imagePath, async () => {
      await exiftool.write(
        imagePath,
        {},
        {
          writeArgs: [
            "-globalTimeShift",
            shift,
            "-tagsFromFile",
            "@",
            ...CAPTURE_TIME_TAGS.map((t) => `-${t}<${t}`),
            "-overwrite_original",
          ],
        },
      );
    });
  }
  const sidecars = await sidecarsToWrite(imagePath, embeds, settings.sidecarNames);
  await Promise.all(sidecars.map((sidecar) => shiftSidecarTime(imagePath, sidecar, shift)));
}

function shiftSidecarTime(imagePath: string, sidecar: string, shift: string): Promise<void> {
  return queuedWrite(sidecar, async () => {
    // A sidecar that already carries a time (an earlier shift) moves that one, so a shift back
    // returns it exactly; otherwise it starts from the camera's own time.
    const shifted = async (file: string) => {
      if (!(await exists(file))) return null;
      const dt = asTagRecord(await exiftool.read(file, { readArgs: ["-globalTimeShift", shift] })).DateTimeOriginal;
      if (typeof dt === "string") return dt;
      return dt && typeof dt === "object" && "rawValue" in dt ? String(dt.rawValue) : null;
    };
    const value = (await shifted(sidecar)) ?? (await shifted(imagePath));
    if (value) {
      const tags: Record<string, unknown> = { "XMP-exif:DateTimeOriginal": value };
      await exiftool.write(sidecar, tags, { writeArgs: ["-overwrite_original"] });
    }
  });
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
  /** Write lat/lon (null removes them) into every GPS field, embedded files included. */
  replaceGps?: boolean;
  locationLabel?: string | null;
  /** Written only into a file with no capture time of its own (a date set in Lifer). */
  takenAt?: Date | null;
  credits?: PhotoCredits;
  fields?: TemplatedWrites;
  originalId?: string;
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
  return queuedWrite(target, () => writeLiferMetadataNow(target, data, mode));
}

function queuedWrite(target: string, write: () => Promise<void>): Promise<void> {
  const prior = fileWriteQueues.get(target) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(write);
  fileWriteQueues.set(target, next);
  next
    .finally(() => {
      if (fileWriteQueues.get(target) === next) fileWriteQueues.delete(target);
    })
    .catch(() => {});
  return next;
}

// Every species in the photo is written; species[0] is the primary. namingStyles only changes the
// hierarchy label (and the default title): Keywords keep the plain common and scientific names,
// which reimport matching relies on, with codes added as extra keywords.
async function writeLiferMetadataNow(target: string, data: LiferTags, mode: "embedded" | "sidecar"): Promise<void> {
  const plan = await planLiferWrite(target, data, mode);
  await exiftool.write(target, plan.tags, { writeArgs: ["-overwrite_original"] });
  if (plan.slot) await recordWritten(data.originalId!, plan.slot, plan.written);
}

interface WritePlan {
  tags: Record<string, unknown>;
  /** Lifer's own value per templated field, to record once written. */
  written: Written;
  /** Templated fields left alone because someone else edited them. */
  edited: TemplatedField[];
  /** True when the credits or templated fields would change the file. */
  templatedChange: boolean;
  /** Where Lifer's record for this file lives; null without one. */
  slot: WriteSlot | null;
}

async function planLiferWrite(target: string, data: LiferTags, mode: "embedded" | "sidecar"): Promise<WritePlan> {
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
  const fields: TemplatedWrites = data.fields ?? {
    title: { value: labels.join(", "), rule: "replace" },
    headline: { value: "", rule: "off" },
    caption: { value: "", rule: "off" },
    keywords: { values: [], rule: "off" },
  };
  const record = data.originalId ? await readWritten(data.originalId, target) : null;
  const slot = record?.slot ?? null;
  const recorded = record?.written ?? {};
  const written: Written = {};
  const edited: TemplatedField[] = [];
  const tags: Record<string, unknown> = {};

  const extras = keywordPlan(kept, fields.keywords, recorded.keywords as string[] | undefined);
  if (extras === "edited") edited.push("keywords");
  else if (extras) written.keywords = extras.own;
  const flat = extras && extras !== "edited" ? kept.flat.filter((k) => !extras.drop.includes(k)) : kept.flat;
  const photoTags = data.tags ?? kept.liferTags;
  const subject = [...new Set([...flat, ...ours, ...(extras && extras !== "edited" ? extras.add : []), ...photoTags])];
  const hierarchical = [...new Set([...kept.hierarchical, ...ourHierarchies, ...photoTags.map(tagMarker)])];
  tags["XMP-dc:Subject"] = subject;
  tags["XMP-lr:HierarchicalSubject"] = hierarchical;
  if (mode === "embedded") tags["IPTC:Keywords"] = subject;
  let templatedChange =
    !!extras && extras !== "edited" && (extras.drop.length > 0 || extras.add.some((k) => !kept.all.includes(k)));

  // Title, Headline and Caption go into XMP and, inside a file, IPTC (and EXIF for the caption)
  // together, so every app reads the same text.
  const TEXT_TAGS: Record<"title" | "headline" | "caption", { xmp: string; file: string[] }> = {
    title: { xmp: "XMP-dc:Title", file: ["IPTC:ObjectName"] },
    headline: { xmp: "XMP-photoshop:Headline", file: ["IPTC:Headline"] },
    caption: { xmp: "XMP-dc:Description", file: ["IPTC:Caption-Abstract", "EXIF:ImageDescription"] },
  };
  for (const field of ["title", "headline", "caption"] as const) {
    const have = kept.fields[field];
    const own = recorded[field] as string | undefined;
    const fallback =
      field === "caption"
        ? kept.fields.captionIsLifers
        : field === "title" && own === undefined && have !== "" && have !== fields.title.value
          ? await looksLikeLifersTitle(have)
          : false;
    const plan = textFieldPlan(have, fields[field], own, fallback);
    if (plan === "edited") edited.push(field);
    if (!plan || plan === "edited") continue;
    written[field] = plan.own;
    if (plan.value === have) continue;
    templatedChange = true;
    tags[TEXT_TAGS[field].xmp] = plan.value;
    if (mode === "embedded") for (const t of TEXT_TAGS[field].file) tags[t] = plan.value;
    // Marks a caption that is all Lifer's, for files read without Lifer's record.
    if (field === "caption" && plan.whole) {
      tags["XMP-photoshop:CaptionWriter"] = CAPTION_WRITER;
      if (mode === "embedded") tags["IPTC:Writer-Editor"] = CAPTION_WRITER;
    }
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
  // The place name is Lifer's to set, like its tags: written over whatever the file had.
  if (data.locationLabel !== undefined) {
    tags["XMP-iptcCore:Location"] = data.locationLabel; // null deletes it
    if (mode === "embedded") tags["IPTC:Sub-location"] = data.locationLabel;
  }
  // shortcut: embedded files only, since a RAW sidecar's capture time overrides the RAW's in
  // Lightroom; add sidecars if undated RAW-only photos turn up.
  if (mode === "embedded" && data.takenAt && !kept.cameraDated) {
    // UTC wall clock with no zone: how captureTimeFromTags reads an unzoned date back.
    tags["EXIF:DateTimeOriginal"] = data.takenAt.toISOString().slice(0, 19).replace("T", " ").replace(/-/g, ":");
  }
  if (data.credits) {
    const credits = creditTags(kept.credits, data.credits, mode);
    if (Object.keys(credits).length > 0) templatedChange = true;
    Object.assign(tags, credits);
  }
  if (data.rating !== undefined) tags["XMP-xmp:Rating"] = data.rating; // null deletes it
  if (data.replaceGps) {
    // null deletes. EXIF keeps the hemisphere in a separate Ref; XMP takes the signed value.
    const lat = data.lat ?? null;
    const lon = data.lon ?? null;
    Object.assign(tags, { "XMP-exif:GPSLatitude": lat, "XMP-exif:GPSLongitude": lon });
    if (mode === "embedded") {
      Object.assign(tags, {
        "EXIF:GPSLatitude": lat == null ? null : Math.abs(lat),
        "EXIF:GPSLatitudeRef": lat == null ? null : lat < 0 ? "S" : "N",
        "EXIF:GPSLongitude": lon == null ? null : Math.abs(lon),
        "EXIF:GPSLongitudeRef": lon == null ? null : lon < 0 ? "W" : "E",
      });
    }
  } else if (mode === "sidecar") {
    if (data.lat != null) tags["XMP-exif:GPSLatitude"] = data.lat;
    if (data.lon != null) tags["XMP-exif:GPSLongitude"] = data.lon;
  }
  return { tags, written, edited, templatedChange, slot };
}

/** Lifer's own value per templated field: text, or the extra keywords it added. */
export type Written = Partial<Record<TemplatedField, string | string[]>>;

type WriteSlot = "file" | "stem" | "full";

/** Which of an original's files `target` is (the file itself, or its "IMG.CR3.xmp" or "IMG.xmp"
 *  sidecar), and what Lifer last wrote there. Null when the original is gone. */
async function readWritten(originalId: string, target: string): Promise<{ slot: WriteSlot; written: Written } | null> {
  const res = await pool.query<{
    ref: string;
    slot: WriteSlot | null;
    field: TemplatedField;
    value: string | string[];
  }>(
    `SELECT o.ref, w.slot, w.field, w.value
       FROM originals o LEFT JOIN capture_written_metadata w ON w.original_id = o.id
      WHERE o.id = $1`,
    [originalId],
  );
  const ref = res.rows[0]?.ref;
  if (!ref) return null;
  const slot: WriteSlot = target === ref ? "file" : target === `${ref}.xmp` ? "full" : "stem";
  const rows = res.rows.filter((r) => r.slot === slot);
  return { slot, written: Object.fromEntries(rows.map((r) => [r.field, r.value])) };
}

async function recordWritten(originalId: string, slot: WriteSlot, written: Written): Promise<void> {
  if (Object.keys(written).length === 0) return;
  await pool.query(
    `INSERT INTO capture_written_metadata (original_id, slot, field, value)
     SELECT $1, $2, key, value FROM jsonb_each($3::jsonb)
     ON CONFLICT (original_id, slot, field) DO UPDATE SET value = EXCLUDED.value, written_at = now()`,
    [originalId, slot, JSON.stringify(written)],
  );
}

/** What to write into one text field. `own` is what Lifer last wrote there (undefined: no record,
 *  so `fallback` says whether the file's value is Lifer's from its in-file marker). Null writes
 *  nothing; "edited" means the value is someone else's and stays. `whole`: the field is all Lifer's. */
export function textFieldPlan(
  have: string,
  want: FieldWrite,
  own: string | undefined,
  fallback: boolean,
): { value: string; own: string; whole: boolean } | "edited" | null {
  if (want.rule === "off" || want.value === "") return null;
  const lifers = have === "" || (own === undefined ? fallback : have === own);
  const whole = { value: want.value, own: want.value, whole: true };
  if (want.rule === "fillEmpty") return have === "" ? whole : null;
  if (lifers) return whole;
  if (want.rule === "replace") return have === want.value ? whole : "edited";
  // append: after the file's own text, swapping Lifer's earlier addition when it's still there.
  if (own !== undefined && have.endsWith(` ${own}`))
    return { value: `${have.slice(0, -own.length - 1)} ${want.value}`, own: want.value, whole: false };
  if (own === undefined) {
    const value = have.endsWith(want.value) ? have : `${have} ${want.value}`;
    return { value, own: want.value, whole: false };
  }
  return "edited";
}

/** The extra keywords to add and drop. Lifer's earlier ones (`recorded`) are swapped only while
 *  they're all still in the file; a removed one means someone edited them. */
export function keywordPlan(
  kept: { flat: string[]; all: string[] },
  want: { values: string[]; rule: WriteRule },
  recorded: string[] | undefined,
): { add: string[]; drop: string[]; own: string[] } | "edited" | null {
  if (want.rule === "off" || (want.values.length === 0 && !recorded?.length)) return null;
  const prior = recorded ?? [];
  const intact = prior.every((k) => kept.all.includes(k));
  if (want.rule === "append") {
    const add = want.values.filter((k) => !kept.all.includes(k));
    return { add, drop: [], own: [...new Set([...prior.filter((k) => kept.all.includes(k)), ...add])] };
  }
  if (!intact) return "edited";
  const others = kept.flat.filter((k) => !prior.includes(k));
  if (want.rule === "fillEmpty" && others.length > 0) return null;
  // One already in the file before Lifer's is the user's, so it's never recorded as Lifer's.
  const add = want.values.filter((k) => !others.includes(k));
  const drop = prior.filter((k) => !add.includes(k));
  return { add, drop, own: add };
}

/** A title from before Lifer kept a record is Lifer's when every part of it is a species name,
 *  code or rank, as the naming styles compose them. */
async function looksLikeLifersTitle(title: string): Promise<boolean> {
  const parts = [...new Set(title.split(/[,()/]/).map((p) => p.trim().toLowerCase()))].filter(Boolean);
  if (parts.length === 0) return false;
  const res = await pool.query<{ k: string }>(
    `SELECT DISTINCT lower(k) AS k
       FROM species, unnest(ARRAY[common_name, scientific_name, aba_code, ebird_code, taxon_class, taxon_order, family]) AS k
      WHERE k IS NOT NULL AND lower(k) = ANY($1)`,
    [parts],
  );
  return res.rows.length === parts.length;
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

/** The place name in a file (IPTC Sublocation), so a reimport brings it back with the photo. */
export function extractLocationLabel(tags: ExifTags | Record<string, unknown>): string | null {
  const raw = tags as Record<string, unknown>;
  const value = [raw.Location, raw["Sub-location"]].find((v) => typeof v === "string" && v.trim() !== "");
  return typeof value === "string" ? value.trim() : null;
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

/** A file's Title, Headline and Caption as other apps show them. */
interface FileFields {
  title: string;
  headline: string;
  caption: string;
  /** Lifer wrote the caption (its Description Writer), for files from before Lifer's record. */
  captionIsLifers: boolean;
}
const NO_FIELDS: FileFields = { title: "", headline: "", caption: "", captionIsLifers: false };
// Unreadable reads as someone else's text, so nothing is written over what couldn't be seen.
const UNREADABLE_FIELDS: FileFields = { title: "?", headline: "?", caption: "?", captionIsLifers: false };

function fileFieldsFromTags(raw: Record<string, unknown>): FileFields {
  return {
    title: firstText(raw, "Title", "ObjectName") ?? "",
    headline: firstText(raw, "Headline") ?? "",
    caption: firstText(raw, "Description", "Caption-Abstract", "ImageDescription") ?? "",
    captionIsLifers: firstText(raw, "CaptionWriter", "Writer-Editor") === CAPTION_WRITER,
  };
}

interface KeptMetadata {
  flat: string[];
  /** Every plain keyword in the file, species names included. */
  all: string[];
  hierarchical: string[];
  liferTags: string[];
  location: LocationFilled;
  cameraDated: boolean;
  credits: FileCredits;
  fields: FileFields;
}

async function keywordsToKeep(target: string): Promise<KeptMetadata> {
  const none = { flat: [], all: [], hierarchical: [], liferTags: [], location: NO_LOCATION, cameraDated: true };
  // Unreadable counts as dated, so a date is never written over one we couldn't see.
  if (!(await exists(target))) return { ...none, credits: NO_CREDITS, fields: NO_FIELDS };
  let raw: Record<string, unknown>;
  try {
    raw = asTagRecord(await exiftool.read(target));
  } catch {
    // Unreadable counts as filled too, so nothing is written over what couldn't be seen.
    return { ...none, credits: UNREADABLE_CREDITS, fields: UNREADABLE_FIELDS };
  }
  const credits = fileCreditsFromTags(raw);
  const fields = fileFieldsFromTags(raw);
  // Cameras write CreateDate beside DateTimeOriginal; Lifer writes only DateTimeOriginal, so one
  // without CreateDate is Lifer's own (or a scan's) and may be corrected.
  const cameraDated = captureTimeFromTags(raw) !== null && raw.CreateDate != null;
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
  const all = flat;
  if (flat.length === 0) return { flat, all, hierarchical, liferTags, location, cameraDated, credits, fields };
  const speciesWords = await pool.query<{ k: string }>(
    `SELECT DISTINCT lower(k) AS k FROM species, unnest(ARRAY[common_name, scientific_name, aba_code, ebird_code]) AS k
     WHERE k IS NOT NULL AND lower(k) = ANY($1)`,
    [flat.map((k) => k.toLowerCase())],
  );
  const species = new Set(speciesWords.rows.map((r) => r.k));
  return {
    flat: flat.filter((k) => !species.has(k.toLowerCase())),
    all,
    hierarchical,
    liferTags,
    location,
    cameraDated,
    credits,
    fields,
  };
}

/** What a file already says about who made it. */
export interface FileCredits {
  creator: string | null;
  copyright: string | null;
  credit: string | null;
  usageTerms: string | null;
}
const NO_CREDITS: FileCredits = { creator: null, copyright: null, credit: null, usageTerms: null };
const UNREADABLE_CREDITS: FileCredits = { creator: "?", copyright: "?", credit: "?", usageTerms: "?" };
// Marks a caption as Lifer's (IPTC Description Writer), so one typed in another app is kept.
const CAPTION_WRITER = "Lifer";

function firstText(raw: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = raw[k];
    // exiftool reads an all-digit title ("2024") as a number.
    const text = Array.isArray(v)
      ? v.map(String).join("; ")
      : typeof v === "string" || typeof v === "number"
        ? String(v)
        : null;
    if (text?.trim()) return text.trim();
  }
  return null;
}

function fileCreditsFromTags(raw: Record<string, unknown>): FileCredits {
  return {
    creator: firstText(raw, "Creator", "By-line", "Artist"),
    copyright: firstText(raw, "Rights", "CopyrightNotice", "Copyright"),
    credit: firstText(raw, "Credit"),
    usageTerms: firstText(raw, "UsageTerms"),
  };
}

/** The credit tags to write over what the file has: only values that differ, never over a creator
 *  or copyright of the file's own unless `replaceExisting`. Empty when the file already matches. */
export function creditTags(
  current: FileCredits,
  wanted: PhotoCredits,
  mode: "embedded" | "sidecar",
): Record<string, unknown> {
  const tags: Record<string, unknown> = {};
  const fill = (have: string | null, want: string, replaceable: boolean) =>
    want !== "" && have !== want && (have == null || replaceable);
  const owned = wanted.replaceExisting;
  if (fill(current.creator, wanted.creator, owned)) {
    tags["XMP-dc:Creator"] = [wanted.creator];
    if (mode === "embedded") {
      tags["IPTC:By-line"] = [wanted.creator];
      tags["EXIF:Artist"] = wanted.creator;
    }
  }
  if (fill(current.copyright, wanted.copyright, owned)) {
    tags["XMP-dc:Rights"] = wanted.copyright;
    if (mode === "embedded") {
      tags["IPTC:CopyrightNotice"] = wanted.copyright;
      tags["EXIF:Copyright"] = wanted.copyright;
    }
  }
  if (fill(current.credit, wanted.credit, owned)) {
    tags["XMP-photoshop:Credit"] = wanted.credit;
    if (mode === "embedded") tags["IPTC:Credit"] = wanted.credit;
  }
  if (fill(current.usageTerms, wanted.usageTerms, owned)) tags["XMP-xmpRights:UsageTerms"] = wanted.usageTerms;
  return tags;
}

/** Where a photo file's own metadata lives: in it, or in its sidecar. */
export const metadataTarget = (imagePath: string) =>
  metadataGoesInFile(imagePath) ? imagePath : sidecarPathFor(imagePath);

/** What writing `data` would do to this file's credits and templated fields, without writing:
 *  `changes` when anything of theirs would change, `edited` lists fields kept as someone edited them. */
export async function templatedWritePlan(
  imagePath: string,
  data: XmpSidecarData,
  settings: FileWriteSettings = DEFAULT_FILE_WRITE,
): Promise<{ changes: boolean; edited: TemplatedField[] }> {
  const embeds = metadataGoesInFile(imagePath);
  // The same files writeCaptureMetadata writes.
  const targets =
    embeds && settings.insideFiles ? [imagePath] : await sidecarsToWrite(imagePath, embeds, settings.sidecarNames);
  const out = { changes: false, edited: [] as TemplatedField[] };
  for (const target of targets) {
    const plan = await planLiferWrite(target, data, target === imagePath ? "embedded" : "sidecar");
    out.changes ||= plan.templatedChange;
    out.edited.push(...plan.edited.filter((f) => !out.edited.includes(f)));
  }
  return out;
}

/** The camera's file name a file was imported with (XMP PreservedFileName), or null. */
export async function readPreservedFileName(imagePath: string): Promise<string | null> {
  const target = metadataTarget(imagePath);
  if (!(await exists(target))) return null;
  try {
    return firstText(
      asTagRecord(await exiftool.read(target, { readArgs: ["-XMP-xmpMM:PreservedFileName"] })),
      "PreservedFileName",
    );
  } catch {
    return null;
  }
}

/** Dates a frame saved from a video like the video's own shot, with its place, and names the video
 *  it came from. The time is written as the UTC wall clock captureTimeFromTags reads back. */
export async function writeVideoFrameMetadata(
  imagePath: string,
  frame: { takenAt: Date | null; lat: number | null; lon: number | null; sourceName: string },
): Promise<void> {
  const tags: Record<string, unknown> = { "XMP-dc:Source": frame.sourceName };
  if (frame.takenAt) {
    tags["EXIF:DateTimeOriginal"] = frame.takenAt.toISOString().slice(0, 19).replace("T", " ").replace(/-/g, ":");
  }
  if (frame.lat != null && frame.lon != null) {
    Object.assign(tags, {
      "EXIF:GPSLatitude": Math.abs(frame.lat),
      "EXIF:GPSLatitudeRef": frame.lat < 0 ? "S" : "N",
      "EXIF:GPSLongitude": Math.abs(frame.lon),
      "EXIF:GPSLongitudeRef": frame.lon < 0 ? "W" : "E",
    });
  }
  await queuedWrite(imagePath, async () => {
    await exiftool.write(imagePath, tags, { writeArgs: ["-overwrite_original"] });
  });
}

/** Records the camera's file name before Lifer renames a file, so {original} still means it
 *  later. A name already recorded is kept. */
export function preserveFileName(imagePath: string, name: string): Promise<void> {
  const target = metadataTarget(imagePath);
  return queuedWrite(target, async () => {
    if (await readPreservedFileName(imagePath)) return;
    const tags: Record<string, unknown> = { "XMP-xmpMM:PreservedFileName": name };
    await exiftool.write(target, tags, { writeArgs: ["-overwrite_original"] });
  });
}

/** For an exported copy of a sensitive species' photo: removes its coordinates and anything
 *  finer than province or state, and swaps a caption naming the place for `caption` (dropped
 *  when empty). Only ever run on a copy, never on a library file. */
export async function stripPreciseLocation(
  copyPath: string,
  opts: { placeLabel: string | null; caption: string },
): Promise<void> {
  const raw = asTagRecord(await exiftool.read(copyPath));
  const tags: Record<string, unknown> = {};
  const caption = firstText(raw, "Description", "Caption-Abstract", "ImageDescription");
  const label = opts.placeLabel?.trim().toLowerCase();
  if (caption && label && caption.toLowerCase().includes(label)) {
    const next = opts.caption || null;
    tags["XMP-dc:Description"] = next;
    tags["IPTC:Caption-Abstract"] = next;
    tags["EXIF:ImageDescription"] = next;
  }
  await exiftool.write(copyPath, tags, {
    writeArgs: [
      "-overwrite_original",
      "-GPS:all=",
      "-XMP-exif:GPS*=",
      "-XMP-iptcCore:Location=",
      "-IPTC:Sub-location=",
      "-XMP-photoshop:City=",
      "-IPTC:City=",
      "-XMP-iptcExt:LocationCreated=",
      "-XMP-iptcExt:LocationShown=",
    ],
  });
}

export async function closeExiftool(): Promise<void> {
  await exiftool.end();
}

/** The file's bytes with GPS tags removed from a throwaway copy, so a photo can be shared without
 *  its exact location. The original is untouched and the picture isn't re-encoded. */
export async function readCopyWithoutGps(filePath: string): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "lifer-nogps-"));
  const copy = path.join(dir, path.basename(filePath));
  try {
    await copyFile(filePath, copy);
    await exiftool.write(copy, {}, { writeArgs: ["-gps:all=", "-overwrite_original"] });
    return await readFile(copy);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
