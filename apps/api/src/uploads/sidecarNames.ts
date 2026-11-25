// Where Lifer's XMP sidecars go, by the user's file writing settings (settings/fileWriteSettings.ts).
// Two naming conventions exist: "IMG_0001.xmp" (Lightroom, Bridge, Camera Raw) and
// "IMG_0001.CR3.xmp" (digiKam, Capture One, darktable). Lifer reads both (exif.ts findSidecarPath).
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export type SidecarNames = "stem" | "full" | "both";

export interface FileWriteSettings {
  /** RAW and video sidecar names. */
  sidecarNames: SidecarNames;
  /** Keywords go inside JPEG, TIFF, PNG, DNG, WebP, HEIC, AVIF, JP2 and JXL files; off writes a sidecar instead. */
  insideFiles: boolean;
  /** Linked (not managed) files get a sidecar too, never an in-file write. */
  linkedFolders: boolean;
}

export const DEFAULT_FILE_WRITE: FileWriteSettings = { sidecarNames: "stem", insideFiles: true, linkedFolders: false };

export const stemSidecar = (file: string) =>
  path.join(path.dirname(file), `${path.basename(file, path.extname(file))}.xmp`);
export const fullSidecar = (file: string) => `${file}.xmp`;

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** Every sidecar name a file can have. A JPEG-like file only owns its full name: its stem name
 *  belongs to the RAW it was shot with. */
export function sidecarNamesOf(file: string, embedsMetadata: boolean): string[] {
  return embedsMetadata ? [fullSidecar(file)] : [stemSidecar(file), fullSidecar(file)];
}

/** The sidecars a write goes to. A JPEG-like file written as a sidecar uses the full name, as
 *  digiKam and darktable do, so it never clashes with its RAW's. With "full", an existing stem
 *  sidecar is kept in step too, since Lightroom and Lifer itself read that name first. */
export async function sidecarsToWrite(file: string, embedsMetadata: boolean, names: SidecarNames): Promise<string[]> {
  if (embedsMetadata) return [fullSidecar(file)];
  if (names === "both") return [stemSidecar(file), fullSidecar(file)];
  if (names === "stem") return [stemSidecar(file)];
  return (await exists(stemSidecar(file))) ? [fullSidecar(file), stemSidecar(file)] : [fullSidecar(file)];
}

/** The sidecars of `file` that exist, by name. */
export async function existingSidecars(file: string, embedsMetadata: boolean): Promise<string[]> {
  const found: string[] = [];
  for (const p of sidecarNamesOf(file, embedsMetadata)) if (await exists(p)) found.push(p);
  return found;
}

/** The name `sidecar` (of `source`) takes beside `target`: stem for stem, full for full. */
export function sidecarFor(target: string, sidecar: string, source: string): string {
  return sidecar === fullSidecar(source) ? fullSidecar(target) : stemSidecar(target);
}

/** Moves each existing sidecar of `from` beside `to` under the matching name, never over a file
 *  already there. `move` does the actual rename or copy. */
export async function moveSidecars(
  from: string,
  to: string,
  embedsMetadata: boolean,
  move: (src: string, dest: string) => Promise<void>,
): Promise<void> {
  for (const sidecar of await existingSidecars(from, embedsMetadata)) {
    const dest = sidecarFor(to, sidecar, from);
    if (!(await exists(dest))) await move(sidecar, dest);
  }
}

// Marks a sidecar Lifer created next to a linked file, so later writes only touch Lifer's own.
export const LIFER_CREATOR_TOOL = "Lifer";
const CREATED_BY_LIFER = /CreatorTool(>|=")Lifer[<"]/;

/** True when Lifer created this sidecar (another app taking it over rewrites CreatorTool). */
export async function liferCreatedSidecar(sidecar: string): Promise<boolean> {
  try {
    return CREATED_BY_LIFER.test(await readFile(sidecar, "utf8"));
  } catch {
    return false;
  }
}
