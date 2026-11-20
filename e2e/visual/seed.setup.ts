// Seeds the realistic library through the API, the way a user would build one: the account,
// every country's packs, two imported trips, then marks, crops, hidden photos and an album.
// Saves the signed-in session for the tour and the behavioural checks.
import path from "node:path";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { ACCOUNT } from "../support/constants.js";
import { createTrip, HEADERS, json, libraryFolder, waitForJob } from "../support/library.js";
import { REAL_COUNTRIES, REAL_SPECIES } from "../support/realisticCatalog.js";
import { ALBUM_NAME, MARKS, TRIPS, writeTripPhotos } from "../support/realisticLibrary.js";
import { VISUAL_AUTH_STATE } from "./visual.js";

const post = (request: APIRequestContext, url: string, data?: object) => request.post(url, { headers: HEADERS, data });

async function speciesIds(request: APIRequestContext, indexes: number[]): Promise<Map<number, string>> {
  const ids = new Map<number, string>();
  for (const i of new Set(indexes)) {
    const name = REAL_SPECIES[i].scientificName;
    const res = await json<{ results: Array<{ id: string; scientific_name: string }> }>(
      await request.get(`/api/species?q=${encodeURIComponent(name)}`, { headers: HEADERS }),
    );
    const match = res.results.find((r) => r.scientific_name === name);
    if (!match) throw new Error(`${name} isn't in the catalog`);
    ids.set(i, match.id);
  }
  return ids;
}

test("seeds the realistic library", async ({ request }) => {
  test.setTimeout(600_000);
  await json(await post(request, "/api/auth/register", ACCOUNT));

  await json(
    await post(request, "/api/offline-packs/download-batch", {
      regionNames: REAL_COUNTRIES.map((c) => c.name),
      taxa: "all",
    }),
  );
  await waitForJob(request, "/api/offline-packs/download/status", 300_000);

  // The blank basemap downloads by itself at startup; the region map only shows once it's there.
  await expect
    .poll(
      async () =>
        (await json<{ downloaded: boolean }>(await request.get("/api/settings/map/status", { headers: HEADERS })))
          .downloaded,
      {
        timeout: 30_000,
      },
    )
    .toBe(true);

  const regions = (
    await json<{ regions: Array<{ id: string; name: string }> }>(
      await request.get("/api/regions", { headers: HEADERS }),
    )
  ).regions;
  const regionId = (name: string) => regions.find((r) => r.name === name)!.id;
  const ids = await speciesIds(request, [
    ...TRIPS.flatMap((t) => t.photos.map((p) => p.speciesIndex)),
    ...MARKS.seen,
    ...MARKS.target,
    ...MARKS.hiddenInCostaRica,
  ]);

  const captureIds = new Map<string, string>();
  const root = await libraryFolder(request);
  for (const trip of TRIPS) {
    const folder = path.join(root, "e2e-trips", trip.name.replace(/[^a-z0-9]+/gi, "-"));
    await writeTripPhotos(trip, folder);
    const tripId = await createTrip(request, trip.name, folder);
    await json(await post(request, `/api/trips/${tripId}/scan`));
    await waitForJob(request, `/api/trips/${tripId}/scan/status`, 120_000);
    // Each species' first shot alone first: an import runs files in parallel, and the species'
    // first photo becomes its card, so this keeps every card the same from run to run.
    const firsts = new Set<number>();
    const passes = [trip.photos.filter((p) => !firsts.has(p.speciesIndex) && firsts.add(p.speciesIndex))];
    passes.push(trip.photos.filter((p) => !passes[0].includes(p)));
    for (const photos of passes) {
      await json(
        await post(request, `/api/trips/${tripId}/import`, {
          files: photos.map((p) => ({ relativePath: p.file, speciesId: ids.get(p.speciesIndex)! })),
          regionId: regionId(trip.region),
        }),
      );
      await waitForJob(request, `/api/trips/${tripId}/import/status`, 300_000);
      const status = await json<{ results: Array<{ relativePath: string; captureId?: string; error?: string }> }>(
        await request.get(`/api/trips/${tripId}/import/status`, { headers: HEADERS }),
      );
      for (const r of status.results) {
        if (!r.captureId) throw new Error(`Importing ${r.relativePath} failed: ${r.error}`);
        if (trip === TRIPS[0]) captureIds.set(r.relativePath, r.captureId);
      }
    }
  }

  for (const i of MARKS.seen) await json(await request.patch(`/api/species/${ids.get(i)}/seen`, { headers: HEADERS }));
  for (const i of MARKS.target)
    await json(await request.patch(`/api/species/${ids.get(i)}/target`, { headers: HEADERS }));
  for (const i of MARKS.hiddenInCostaRica) {
    await json(await post(request, `/api/regions/${regionId("Costa Rica")}/species/${ids.get(i)}/hide`));
  }
  const cropIds = await speciesIds(request, MARKS.cardCrops);
  for (const [n, i] of MARKS.cardCrops.entries()) {
    await json(
      await request.patch(`/api/species/${cropIds.get(i)}/card-crop`, {
        headers: HEADERS,
        data: { x: 20 + (n % 5) * 10, y: 25 + (n % 3) * 10, size: 50 },
      }),
    );
  }
  await json(
    await post(request, "/api/captures/hide", { captureIds: MARKS.hiddenPhotos.map((f) => captureIds.get(f)!) }),
  );
  const album = await json<{ id: string }>(await post(request, "/api/albums", { name: ALBUM_NAME }));
  await json(
    await post(request, `/api/albums/${album.id}/captures`, {
      captureIds: MARKS.albumPhotos.filter((f) => !MARKS.hiddenPhotos.includes(f)).map((f) => captureIds.get(f)!),
    }),
  );

  // Card crops are framed on the animal in the background after an import. Screenshots wait for
  // them to settle, so each run shows the same cards.
  const world = regionId("World");
  const cropped = async () =>
    (
      await json<{ items: Array<{ cardCropX: number | null }> }>(
        await request.get(`/api/regions/${world}/aggregate-species`, { headers: HEADERS }),
      )
    ).items.filter((i) => i.cardCropX != null).length;
  let last = -1;
  let steady = 0;
  // Settled once the count holds for 15 seconds: detection pauses between batches.
  for (let waited = 0; steady < 8 && waited < 300_000; waited += 2000) {
    const now = await cropped();
    steady = now === last ? steady + 1 : 0;
    last = now;
    await new Promise((r) => setTimeout(r, 2000));
  }

  await request.storageState({ path: VISUAL_AUTH_STATE });
});
