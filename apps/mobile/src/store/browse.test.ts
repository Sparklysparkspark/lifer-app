import { describe, expect, it } from "vitest";
import {
  albumPhotos,
  tripCoverCrops,
  libraryShapes,
  listAlbums,
  listCollection,
  monthPlaces,
  photoInfo,
  stats,
  speciesFacts,
} from "./browse";
import { applyAlbums, applyCaptureChanges, applyMembers, applyTrips } from "./library";
import { applyHubMark, editMark } from "./marks";
import { saveRegion } from "./regions";
import { MIGRATIONS, migrate } from "./migrations";
import { memoryDb, migratedDb } from "./testDb";

const item = (scientificName: string, commonName: string, taxonClass = "aves", vagrant = false) => ({
  scientificName,
  commonName,
  taxonClass,
  tier: null,
  vagrant,
  sensitive: false,
});
const cap = (id: string, scientificName: string, takenAt: string, o: object = {}) => ({
  id,
  deletedAt: null,
  hiddenAt: null,
  scientificName,
  takenAt,
  tags: [],
  qualityRating: null,
  locationLabel: null,
  regionId: null,
  photo: { id: `p-${id}`, width: 100, height: 80, kind: "image" },
  ...o,
});

async function life() {
  const db = await migratedDb();
  const now = new Date("2026-10-25T10:00:00Z");
  await saveRegion(
    db,
    { key: "r1", name: "One", source: "pack", hubRegionId: null },
    [item("A a", "Alpha"), item("B b", "Bravo", "mammalia", true)],
    now,
  );
  await saveRegion(db, { key: "r2", name: "Two", source: "pack", hubRegionId: null }, [item("C c", "Charlie")], now);
  await applyCaptureChanges(
    db,
    [
      cap("1", "A a", "2026-05-02T10:00:00Z", { locationLabel: "Tofino" }),
      cap("2", "A a", "2026-05-03T10:00:00Z", { locationLabel: "Tofino" }),
      cap("3", "C c", "2025-01-03T10:00:00Z", { qualityRating: 5 }),
    ],
    [],
  );
  await editMark(db, "B b", { state: "seen" }, now);
  return db;
}

describe("listCollection", () => {
  it("lists a region's species with status and the vagrant flag, or everything for Everywhere", async () => {
    const db = await life();
    const one = await listCollection(db, "r1");
    expect(one.map((r) => [r.scientificName, r.status, r.vagrant])).toEqual(
      expect.arrayContaining([
        ["A a", "photographed", false],
        ["B b", "seen", true],
      ]),
    );
    expect(one).toHaveLength(2);
    expect(await listCollection(db, null)).toHaveLength(3);
  });
});

describe("gallery reads", () => {
  it("shapes the library, narrows it by year, and names each month's place", async () => {
    const db = await life();
    const all = await libraryShapes(db);
    expect(all.map((p) => p.photoId)).toEqual(["p-2", "p-1", "p-3"]);
    expect(all[0]).toMatchObject({ width: 100, height: 80, name: "Alpha" });
    expect((await libraryShapes(db, { year: "2025" })).map((p) => p.photoId)).toEqual(["p-3"]);
    expect(await libraryShapes(db, { taxonClasses: ["mammalia"] })).toEqual([]);
    expect(await monthPlaces(db)).toEqual({ "2026-05": "Tofino" });
  });
  it("describes one photo with its albums", async () => {
    const db = await life();
    await applyAlbums(db, [{ id: "al", name: "Best", coverPhotoId: null }], []);
    await applyMembers(db, [{ albumId: "al", captureId: "1" }], []);
    expect(await photoInfo(db, "p-1")).toMatchObject({
      scientificName: "A a",
      place: "Tofino",
      albums: ["Best"],
      trip: null,
    });
    expect(await photoInfo(db, "nope")).toBeNull();
  });
});

describe("albums", () => {
  it("counts, picks a cover, puts Favourites first and lists an album's photos", async () => {
    const db = await life();
    await applyAlbums(
      db,
      [
        { id: "z", name: "Zed", coverPhotoId: null },
        { id: "f", name: "favourites", coverPhotoId: null },
      ],
      [],
    );
    await applyMembers(
      db,
      [
        { albumId: "z", captureId: "1" },
        { albumId: "z", captureId: "2" },
        { albumId: "f", captureId: "3" },
      ],
      [],
    );
    const list = await listAlbums(db);
    expect(list.map((a) => [a.name, a.count, a.favourites])).toEqual([
      ["favourites", 1, true],
      ["Zed", 2, false],
    ]);
    expect(list[1].coverPhotoId).toMatch(/^p-/);
    expect((await albumPhotos(db, "z")).map((p) => p.photoId)).toEqual(["p-2", "p-1"]);
  });
});

describe("featured photo crops", () => {
  it("keeps an album's cover crop only while its chosen cover is the one shown", async () => {
    const db = await life();
    await applyAlbums(
      db,
      [
        { id: "c", name: "Chosen", coverPhotoId: "p-1", coverCropX: 10, coverCropY: 20, coverCropSize: 40 },
        { id: "n", name: "None", coverPhotoId: "p-1" },
        { id: "m", name: "Missing", coverPhotoId: "p-gone", coverCropX: 10, coverCropY: 20, coverCropSize: 40 },
      ],
      [],
    );
    await applyMembers(db, [{ albumId: "m", captureId: "2" }], []);
    const by = Object.fromEntries((await listAlbums(db)).map((a) => [a.name, a]));
    expect(by.Chosen.coverCrop).toEqual({ x: 10, y: 20, size: 40 });
    expect(by.None.coverCrop).toBeNull();
    // The chosen cover is not on this phone, so another photo shows and the crop does not apply.
    expect(by.Missing.coverPhotoId).toBe("p-2");
    expect(by.Missing.coverCrop).toBeNull();
  });

  it("stores trip cover crops and refetches albums and trips stored before the crop columns", async () => {
    const db = await life();
    const trip = { description: null, startDate: null, endDate: null, regionId: null, activeOverride: null };
    await applyTrips(
      db,
      [
        { id: "t1", name: "Cropped", coverCaptureId: "1", coverCropX: 5, coverCropY: 6, coverCropSize: 30, ...trip },
        { id: "t2", name: "Plain", coverCaptureId: "1", ...trip },
        {
          id: "t3",
          name: "Auto cover",
          coverCaptureId: null,
          coverCropX: 5,
          coverCropY: 6,
          coverCropSize: 30,
          ...trip,
        },
      ],
      [],
    );
    expect(await tripCoverCrops(db)).toEqual({ t1: { x: 5, y: 6, size: 30 } });
    // A phone stored from before this migration has no crops and cursors past every row.
    const old = memoryDb();
    for (const m of MIGRATIONS.slice(0, 2)) await old.exec(m);
    await old.exec("PRAGMA user_version = 2");
    await old.run(
      "INSERT INTO meta (key, value) VALUES ('cursor.albums', '{}'), ('cursor.trips', '{}'), ('cursor.spots', '{}')",
    );
    await migrate(old);
    expect((await old.all<{ key: string }>("SELECT key FROM meta")).map((r) => r.key)).toEqual(["cursor.spots"]);
  });

  it("gives a species card the crop of the cover the user chose, never of an automatic one", async () => {
    const db = await life();
    const now = new Date("2026-10-25T10:00:00Z");
    await applyHubMark(
      db,
      {
        scientificName: "A a",
        state: "collected",
        isTarget: false,
        coverPhotoId: "p-1",
        firstCollected: null,
        bestQuality: null,
        cardCropX: 12,
        cardCropY: 8,
        cardCropSize: 40,
        updatedAt: "2026-10-25T10:00:00.000000Z",
      },
      now,
    );
    const rows = Object.fromEntries((await listCollection(db, null)).map((r) => [r.scientificName, r]));
    expect(rows["A a"].cardCrop).toEqual({ x: 12, y: 8, size: 40 });
    expect(rows["C c"].cardCrop).toBeNull();
  });

  it("shows the best photo, uncropped, when the chosen cover is one the phone cannot list (hidden, or not this species')", async () => {
    const db = await life();
    const now = new Date("2026-10-25T10:00:00Z");
    const mark = (scientificName: string, coverPhotoId: string) => ({
      scientificName,
      state: "collected" as const,
      isTarget: false,
      coverPhotoId,
      firstCollected: null,
      bestQuality: null,
      cardCropX: 0,
      cardCropY: 0,
      cardCropSize: 66.6796875,
      updatedAt: "2026-10-25T10:00:00.000000Z",
    });
    await applyCaptureChanges(db, [cap("4", "C c", "2025-02-03T10:00:00Z", { hiddenAt: "2026-01-01T00:00:00Z" })], []);
    await applyHubMark(db, mark("A a", "p-gone"), now);
    await applyHubMark(db, mark("C c", "p-4"), now);
    const rows = Object.fromEntries((await listCollection(db, null)).map((r) => [r.scientificName, r]));
    expect(rows["A a"].coverPhotoId).toBe("p-2");
    expect(rows["A a"].cardCrop).toBeNull();
    expect(rows["C c"].coverPhotoId).toBe("p-3");
    expect(rows["C c"].cardCrop).toBeNull();
  });

  it("keeps a chosen cover with a crop at the top edge (y of 0) as the user framed it", async () => {
    const db = await life();
    await applyHubMark(
      db,
      {
        scientificName: "A a",
        state: "collected",
        isTarget: false,
        coverPhotoId: "p-1",
        firstCollected: null,
        bestQuality: null,
        cardCropX: 4.581177234649658,
        cardCropY: 0,
        cardCropSize: 66.6796875,
        updatedAt: "2026-10-25T10:00:00.000000Z",
      },
      new Date("2026-10-25T10:00:00Z"),
    );
    const row = (await listCollection(db, null)).find((r) => r.scientificName === "A a")!;
    expect(row.coverPhotoId).toBe("p-1");
    expect(row.cardCrop).toEqual({ x: 4.581177234649658, y: 0, size: 66.6796875 });
  });
});

describe("speciesFacts and stats", () => {
  it("gives first and last dates and counts", async () => {
    const db = await life();
    expect(await speciesFacts(db, "A a")).toMatchObject({
      firstPhotographed: "2026-05-02T10:00:00Z",
      lastSeen: "2026-05-03T10:00:00Z",
      photos: 2,
    });
  });
  it("counts species, photos, groups, years and the one-and-done", async () => {
    const db = await life();
    const s = await stats(db, "all");
    expect(s).toMatchObject({ photographed: 2, seenOnly: 1, photos: 3, regions: 2 });
    expect(s.byGroup).toEqual([{ taxonClass: "aves", n: 2 }]);
    expect(s.byYear).toEqual([
      { year: "2025", n: 1 },
      { year: "2026", n: 1 },
    ]);
    expect(s.mostPhotographed[0]).toMatchObject({ scientificName: "A a", n: 2 });
    expect(s.oneAndDoneCount).toBe(1);
    expect((await stats(db, "top")).photos).toBe(1);
  });
});
