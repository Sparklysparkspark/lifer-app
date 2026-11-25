// Routes one original's metadata write by the user's file writing settings: a managed file as
// writeCaptureMetadata decides, a linked file only into a sidecar Lifer made, when the user
// opted in. A linked file itself is never changed.
import { stat } from "node:fs/promises";
import { createSidecarFile } from "../lib/originalsWrite.js";
import { metadataGoesInFile, writeCaptureMetadata, writeSidecarFile, type XmpSidecarData } from "./exif.js";
import { LIFER_CREATOR_TOOL, liferCreatedSidecar, sidecarsToWrite, type FileWriteSettings } from "./sidecarNames.js";

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

// A fresh sidecar marked as Lifer's; exiftool then merges the keywords into it.
const NEW_SIDECAR = `<?xpacket begin='' id='W5M0MpCehiHzreSzNTczkc9d'?>
<x:xmpmeta xmlns:x='adobe:ns:meta/'>
<rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>
 <rdf:Description rdf:about='' xmlns:xmp='http://ns.adobe.com/xap/1.0/'>
  <xmp:CreatorTool>${LIFER_CREATOR_TOOL}</xmp:CreatorTool>
 </rdf:Description>
</rdf:RDF>
</x:xmpmeta>
<?xpacket end='w'?>
`;

export type LinkedSidecarPlan = "create" | "update" | "skip";

/** What a write would do to one sidecar of a linked file: make it, update Lifer's own, or leave
 *  another app's alone. */
export async function linkedSidecarPlan(sidecar: string): Promise<LinkedSidecarPlan> {
  if (!(await exists(sidecar))) return "create";
  return (await liferCreatedSidecar(sidecar)) ? "update" : "skip";
}

/** The sidecars of a linked file and what a write would do to each. Empty when the file isn't
 *  there (a disconnected drive), so no stray sidecar is left in an empty folder. */
export async function linkedSidecarPlans(
  ref: string,
  settings: FileWriteSettings,
): Promise<Array<{ sidecar: string; plan: LinkedSidecarPlan }>> {
  if (!(await exists(ref))) return [];
  const sidecars = await sidecarsToWrite(ref, metadataGoesInFile(ref), settings.sidecarNames);
  return Promise.all(sidecars.map(async (sidecar) => ({ sidecar, plan: await linkedSidecarPlan(sidecar) })));
}

export async function writeOriginalMetadata(
  ref: string,
  managed: boolean,
  data: XmpSidecarData,
  settings: FileWriteSettings,
): Promise<void> {
  if (managed) return writeCaptureMetadata(ref, data, settings);
  if (!settings.linkedFolders) return;
  // Keywords and title only: rating, place, GPS and credits in someone's folder stay theirs.
  const keywordsOnly: XmpSidecarData = {
    ...data,
    rating: undefined,
    takenAt: null,
    lat: null,
    lon: null,
    place: null,
    replacePlace: false,
    replaceGps: false,
    locationLabel: undefined,
    credits: undefined,
  };
  for (const { sidecar, plan } of await linkedSidecarPlans(ref, settings)) {
    if (plan === "skip") continue;
    if (plan === "create") await createSidecarFile(sidecar, NEW_SIDECAR).catch(() => {});
    await writeSidecarFile(sidecar, keywordsOnly);
  }
}
