// exiftool-vendored bundles its own exiftool binary, so there's no system-install dependency
// (lifer-spec.md §4: "Image processing: sharp... EXIF via exiftool"). It reads metadata only —
// per spec §6 rule 3, Lifer never decodes the image itself for this.
import { createHash } from "node:crypto";
import { exiftool } from "exiftool-vendored";

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
  };
}

// Reads existing XMP TagsList and IPTC Keywords to auto-match species names (spec §9).
// IPTC Keywords and XMP dc:subject are both plain string lists; digiKam's own
// XMP-digiKam:TagsList and Lightroom's XMP-lr:HierarchicalSubject store hierarchical tags
// as slash-separated paths (e.g. "Birds/Waterfowl/Mallard") — the leaf segment is the actual
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
  const leaves = all.map((t) => t.split("/").pop()!.trim()).filter(Boolean);
  return [...new Set(leaves)];
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
// HierarchicalSubject slash-path), so re-importing a Lifer-tagged photo elsewhere round-trips
// correctly. "store" mode only (see uploads/routes.ts) — a linked/external file isn't
// Lifer's to modify.
export interface SpeciesMetadata {
  commonName: string | null;
  scientificName: string;
  taxonClass: string | null;
  family: string | null;
}

// Supports multi-species photos (e.g. a hawk catching a fish): every depicted species is
// written, not just the primary one, so the file itself reflects all of them even outside
// Lifer. `metas[0]` is treated as the primary for ObjectName/title purposes.
export async function writeSpeciesMetadata(filePath: string, metas: SpeciesMetadata[]): Promise<void> {
  const labels = metas.map((m) => m.commonName ?? m.scientificName);
  const keywords = metas.flatMap((m) => [m.commonName, m.scientificName]).filter((v): v is string => !!v);
  const hierarchies = metas.map((m, i) =>
    ["Species", m.taxonClass, m.family, labels[i]].filter(Boolean).join("/"),
  );

  await exiftool.write(
    filePath,
    {
      Keywords: keywords,
      Subject: keywords,
      HierarchicalSubject: hierarchies,
      ObjectName: labels.join(", "),
    } as Record<string, unknown>,
    { writeArgs: ["-overwrite_original"] },
  );
}

export async function closeExiftool(): Promise<void> {
  await exiftool.end();
}
