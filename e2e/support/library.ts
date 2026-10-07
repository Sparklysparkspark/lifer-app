// Gives a spec photos of its own without the import UI: it writes JPEGs into a folder in the
// server's library and runs the same trip scan and import the Trips page does, through the API.
// The e2e server runs on this machine, so the folder the API reports is one the spec can write to.
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import type { FixtureSpecies } from "./fixtureCatalog.js";
import { makeCameraJpeg } from "./photo.js";

// The header the web app sends with every request (apps/web/src/api/client.ts).
const HEADERS = { "x-lifer-client": "1" };

export interface SeedPhoto {
  file: string;
  species: FixtureSpecies;
  /** EXIF DateTimeOriginal, "YYYY:MM:DD HH:MM:SS". */
  taken: string;
  /** Makes the picture unique; see makeCameraJpeg. Use a value no other spec uses. */
  tint: number;
}

export interface SeededTrip {
  id: string;
  name: string;
  folder: string;
  /** Capture id per file name. */
  captureIds: Record<string, string>;
}

async function json<T>(res: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<T> {
  if (!res.ok()) throw new Error(`${res.url()} answered ${res.status()}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** The server's library folder (DATA_DIR), the first root the folder browser offers. */
export async function libraryFolder(request: APIRequestContext): Promise<string> {
  const res = await json<{ entries: Array<{ path: string }> }>(
    await request.get("/api/settings/browse-directory", { headers: HEADERS }),
  );
  return res.entries[0].path;
}

export async function speciesId(request: APIRequestContext, species: FixtureSpecies): Promise<string> {
  const res = await json<{ results: Array<{ id: string; scientific_name: string }> }>(
    await request.get(`/api/species?q=${encodeURIComponent(species.scientificName)}`, { headers: HEADERS }),
  );
  const match = res.results.find((r) => r.scientific_name === species.scientificName);
  if (!match) throw new Error(`${species.scientificName} isn't in the catalog`);
  return match.id;
}

/** Writes the photos into a new folder in the library and returns its path. */
export async function writeTripFolder(request: APIRequestContext, name: string, photos: SeedPhoto[]): Promise<string> {
  const folder = path.join(await libraryFolder(request), "e2e-trips", name);
  mkdirSync(folder, { recursive: true });
  for (const photo of photos) {
    await makeCameraJpeg(path.join(folder, photo.file), { taken: photo.taken, tint: photo.tint });
  }
  return folder;
}

export async function createTrip(request: APIRequestContext, name: string, folder: string): Promise<string> {
  // The destination is the API's default, given explicitly: the default is built from the source
  // folder's real path, which fails the allowed-path check when the library's own path runs
  // through a symlink (macOS's /var/folders temp dirs do).
  const destinationFolder = path.join(folder, "Wildlife");
  const res = await json<{ id: string }>(
    await request.post("/api/trips", { headers: HEADERS, data: { name, sourceFolder: folder, destinationFolder } }),
  );
  return res.id;
}

async function waitForJob(request: APIRequestContext, statusUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const status = await json<{ running: boolean; finishedAt: number | null; error: string | null }>(
      await request.get(statusUrl, { headers: HEADERS }),
    );
    if (!status.running && status.finishedAt) {
      if (status.error) throw new Error(`${statusUrl}: ${status.error}`);
      return;
    }
    if (Date.now() > deadline) throw new Error(`${statusUrl} didn't finish in time`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** A trip with these photos imported, each assigned its species. */
export async function seedTrip(request: APIRequestContext, name: string, photos: SeedPhoto[]): Promise<SeededTrip> {
  const folder = await writeTripFolder(request, name, photos);
  const id = await createTrip(request, name, folder);

  await json(await request.post(`/api/trips/${id}/scan`, { headers: HEADERS }));
  await waitForJob(request, `/api/trips/${id}/scan/status`);

  const files = [];
  for (const photo of photos)
    files.push({ relativePath: photo.file, speciesId: await speciesId(request, photo.species) });
  await json(await request.post(`/api/trips/${id}/import`, { headers: HEADERS, data: { files } }));
  await waitForJob(request, `/api/trips/${id}/import/status`);

  const status = await json<{ results: Array<{ relativePath: string; captureId?: string; error?: string }> }>(
    await request.get(`/api/trips/${id}/import/status`, { headers: HEADERS }),
  );
  const captureIds: Record<string, string> = {};
  for (const result of status.results) {
    if (!result.captureId) throw new Error(`Importing ${result.relativePath} failed: ${result.error}`);
    captureIds[result.relativePath] = result.captureId;
  }
  return { id, name, folder, captureIds };
}

/** Adds the captures one at a time, in order, so the album (newest added first) lists them reversed. */
export async function createAlbum(request: APIRequestContext, name: string, captureIds: string[]): Promise<string> {
  const album = await json<{ id: string }>(await request.post("/api/albums", { headers: HEADERS, data: { name } }));
  for (const captureId of captureIds) {
    await json(
      await request.post(`/api/albums/${album.id}/captures`, { headers: HEADERS, data: { captureIds: [captureId] } }),
    );
  }
  return album.id;
}
