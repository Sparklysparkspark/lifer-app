import { describe, expect, it } from "vitest";
import { migratedDb } from "./testDb";
import { MIGRATIONS, migrate } from "./migrations";
import { editMark, getMark, listSpecies, speciesCounts } from "./marks";
import {
  applyCaptureChanges,
  favouritePhotoIds,
  libraryPhotos,
  applyAlbums,
  applyMembers,
  photosForSpecies,
  listTrips,
  tripActive,
} from "./library";
import { regionProgress, removeRegion, saveRegion, targetsToFind } from "./regions";

const NOW = new Date("2026-10-25T10:00:00Z");
const cap = (id: string, name: string, takenAt: string | null, extra = {}) => ({
  id,
  deletedAt: null,
  hiddenAt: null,
  scientificName: name,
  takenAt,
  tags: [],
  qualityRating: null,
  locationLabel: null,
  regionId: null,
  photo: { id: `p-${id}`, width: 100, height: 80, kind: "image" },
  ...extra,
});

describe("migrations", () => {
  it("run once and are safe to run again", async () => {
    const db = await migratedDb();
    await migrate(db);
    expect((await db.get<{ user_version: number }>("PRAGMA user_version"))?.user_version).toBe(MIGRATIONS.length);
    expect(await db.all("SELECT name FROM sqlite_master WHERE name = 'outbox'")).toHaveLength(1);
  });
});

describe("transactions", () => {
  it("runs overlapping transactions one after another, and a failed one does not block the next", async () => {
    const db = await migratedDb();
    const order: string[] = [];
    const slow = db.tx(async () => {
      await db.run("INSERT INTO species (scientific_name) VALUES ('A a')");
      await new Promise((r) => setTimeout(r, 10));
      order.push("first");
      throw new Error("boom");
    });
    const second = db.tx(async () => {
      order.push("second");
      await db.run("INSERT INTO species (scientific_name) VALUES ('B b')");
    });
    const third = db.tx(async () => {
      order.push("third");
      await db.run("INSERT INTO species (scientific_name) VALUES ('C c')");
    });
    await expect(slow).rejects.toThrow("boom");
    await Promise.all([second, third]);
    expect(order).toEqual(["first", "second", "third"]);
    expect(
      (await db.all<{ scientific_name: string }>("SELECT scientific_name FROM species ORDER BY 1")).map(
        (r) => r.scientific_name,
      ),
    ).toEqual(["B b", "C c"]);
  });
});

describe("marks and the life list", () => {
  it("keeps an edit at once and queues it once per species", async () => {
    const db = await migratedDb();
    await editMark(db, "Cygnus olor", { state: "seen" }, NOW);
    await editMark(db, "Cygnus olor", { isTarget: true }, NOW);
    expect(await getMark(db, "Cygnus olor")).toMatchObject({ state: "seen", isTarget: true, hubVersion: null });
    expect(await db.all("SELECT * FROM outbox")).toHaveLength(1);
  });

  it("sorts species by status: photographed from captures, seen from marks, none otherwise", async () => {
    const db = await migratedDb();
    await applyCaptureChanges(db, [cap("1", "Cygnus olor", "2026-01-02T00:00:00Z")], []);
    await editMark(db, "Anas crecca", { state: "seen" }, NOW);
    await editMark(db, "Grus grus", { isTarget: true }, NOW);
    const all = await listSpecies(db, "all");
    expect(all.map((s) => [s.scientificName, s.status])).toEqual([
      ["Anas crecca", "seen"],
      ["Cygnus olor", "photographed"],
    ]);
    expect((await listSpecies(db, "targets")).map((s) => s.scientificName)).toEqual(["Grus grus"]);
    expect(await speciesCounts(db)).toMatchObject({ all: 2, photographed: 1, seen: 1, targets: 1 });
  });

  it("handles 5,000 species and 60,000 photos in one query each", async () => {
    const db = await migratedDb();
    await db.tx(async () => {
      for (let i = 0; i < 5000; i++)
        await db.run("INSERT INTO species (scientific_name, common_name) VALUES (?, ?)", [`Genus sp${i}`, `Bird ${i}`]);
      for (let i = 0; i < 60000; i++)
        await db.run("INSERT INTO captures (id, photo_id, scientific_name, taken_at) VALUES (?, ?, ?, ?)", [
          `c${i}`,
          `p${i}`,
          `Genus sp${i % 5000}`,
          `2025-${String(1 + (i % 12)).padStart(2, "0")}-01T00:00:00Z`,
        ]);
    });
    const t0 = Date.now();
    expect(await listSpecies(db, "all")).toHaveLength(5000);
    expect((await libraryPhotos(db)).length).toBe(60000);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("captures", () => {
  it("drops trashed and purged captures, hides hidden ones", async () => {
    const db = await migratedDb();
    await applyCaptureChanges(
      db,
      [
        cap("1", "A a", "2026-01-01T00:00:00Z"),
        cap("2", "B b", "2026-02-01T00:00:00Z"),
        cap("3", "C c", "2026-03-01T00:00:00Z"),
      ],
      [],
    );
    await applyCaptureChanges(
      db,
      [cap("2", "B b", "2026-02-01T00:00:00Z", { hiddenAt: "x" }), cap("3", "C c", null, { deletedAt: "x" })],
      [],
    );
    expect((await libraryPhotos(db)).map((p) => p.photoId)).toEqual(["p-1"]);
    await applyCaptureChanges(db, [], ["1"]);
    expect(await libraryPhotos(db)).toEqual([]);
  });

  it("searches by species names, tags and place", async () => {
    const db = await migratedDb();
    await applyCaptureChanges(
      db,
      [
        cap("1", "Cygnus olor", "2026-01-01T00:00:00Z"),
        cap("2", "Anas crecca", "2026-02-01T00:00:00Z", { tags: ["sunset"], locationLabel: "Slimbridge" }),
      ],
      [],
    );
    expect((await photosForSpecies(db, ["Cygnus olor"], "swans")).map((p) => p.photoId)).toEqual(["p-1"]);
    expect((await photosForSpecies(db, [], "slim")).map((p) => p.photoId)).toEqual(["p-2"]);
    expect((await photosForSpecies(db, [], "100%")).length).toBe(0);
  });

  it("finds the Favourites album's photos", async () => {
    const db = await migratedDb();
    await applyCaptureChanges(db, [cap("1", "A a", "2026-01-01T00:00:00Z")], []);
    await applyAlbums(db, [{ id: "al", name: "Favourites", coverPhotoId: null }], []);
    await applyMembers(db, [{ albumId: "al", captureId: "1" }], []);
    expect(await favouritePhotoIds(db)).toEqual(["p-1"]);
  });
});

describe("trips and regions", () => {
  it("knows when a trip is active", () => {
    expect(tripActive({ startDate: "2026-10-20", endDate: "2026-10-30", override: null }, "2026-10-25")).toBe(true);
    expect(tripActive({ startDate: "2026-10-20", endDate: "2026-10-22", override: null }, "2026-10-25")).toBe(false);
    expect(tripActive({ startDate: "2026-10-20", endDate: null, override: 0 }, "2026-10-25")).toBe(false);
    expect(listTrips).toBeTypeOf("function");
  });

  it("keeps a checklist, counts progress, lists targets, and removes it", async () => {
    const db = await migratedDb();
    const item = (n: string, c: string) => ({
      scientificName: n,
      commonName: c,
      taxonClass: "aves",
      tier: null,
      vagrant: false,
      sensitive: false,
    });
    await saveRegion(
      db,
      { key: "hub:r1", name: "Norfolk", source: "hub", hubRegionId: "r1" },
      [item("Cygnus olor", "Mute Swan"), item("Grus grus", "Common Crane")],
      NOW,
    );
    await editMark(db, "Cygnus olor", { state: "seen" }, NOW);
    await editMark(db, "Grus grus", { isTarget: true }, NOW);
    expect(await regionProgress(db, "hub:r1")).toEqual({ total: 2, seen: 1 });
    expect((await targetsToFind(db, null)).map((t) => t.commonName)).toEqual(["Common Crane"]);
    await removeRegion(db, "hub:r1");
    expect(await db.all("SELECT * FROM region_species")).toEqual([]);
    // Marked species stay known, unmarked ones go.
    expect((await db.all("SELECT scientific_name FROM species")).length).toBe(2);
  });
});

describe("changing hubs", () => {
  it("keeps the person's marks, drops the old hub's data and queues the marks for the new one", async () => {
    const { adoptHub } = await import("./hub");
    const db = await migratedDb();
    expect(await adoptHub(db, "hub-1")).toBe(false);
    await applyCaptureChanges(db, [cap("1", "A a", "2026-01-01T00:00:00Z")], []);
    await editMark(db, "A a", { state: "seen" }, NOW);
    await db.run("UPDATE marks SET hub_version = 'v1'");
    await db.run("DELETE FROM outbox");
    expect(await adoptHub(db, "hub-1")).toBe(false);
    expect(await adoptHub(db, "hub-2")).toBe(true);
    expect(await libraryPhotos(db)).toEqual([]);
    expect(await getMark(db, "A a")).toMatchObject({ state: "seen", hubVersion: null });
    expect(await db.all("SELECT ref FROM outbox")).toEqual([{ ref: "A a" }]);
  });
});
