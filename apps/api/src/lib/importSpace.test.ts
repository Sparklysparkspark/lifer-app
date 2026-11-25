import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LIFER_UPLOAD_WORK_DIR = "/drive/uploads";
  process.env.APP_DATA_DIR = "/drive/app";
  process.env.LIFER_PG_DATA = "/db/pg";
});

const {
  CRITICAL_FREE,
  IMPORT_BYTES,
  assertImportRoom,
  checkImportSpace,
  currentImportTier,
  estimateImportBytes,
  reserveFor,
  setVolumeProbe,
  tierFor,
} = await import("./importSpace.js");

const GB = 1e9;
const TB = 1e12;

/** Uploads and app data on one 1 TB disk, the database on another. */
function drives(appFree: number, dbFree: number, dbTotal = TB) {
  setVolumeProbe(async (dir) =>
    dir.startsWith("/db") ? { free: dbFree, total: dbTotal, dev: 2 } : { free: appFree, total: TB, dev: 1 },
  );
}

afterEach(() => setVolumeProbe(null));

describe("estimateImportBytes", () => {
  it("counts the batch's own bytes once, previews twice until taken, and a few files in flight", () => {
    const need = estimateImportBytes(100, 5 * GB);
    expect(need.uploads).toBe(5 * GB + IMPORT_BYTES.filesInFlight * IMPORT_BYTES.workingPerFileInFlight);
    expect(need.appData).toBe(100 * 2e6);
    expect(need.database).toBe(100 * 0.25e6);
    expect(estimateImportBytes(1, 0).uploads).toBe(IMPORT_BYTES.workingPerFileInFlight);
  });
});

describe("tierFor", () => {
  it("keeps 5 GB or 5 percent free, whichever is larger", () => {
    expect(reserveFor(50 * GB)).toBe(5 * GB);
    expect(reserveFor(TB)).toBe(50 * GB);
  });

  it.each([
    [200 * GB, 10 * GB, "ok"],
    [55 * GB, 10 * GB, "tight"],
    [CRITICAL_FREE + 1, 0, "tight"],
    [CRITICAL_FREE - 1, 0, "critical"],
  ])("%d free, %d needed on a 1 TB disk: %s", (free, need, tier) => {
    expect(tierFor({ free, total: TB }, need)).toBe(tier);
  });
});

describe("checkImportSpace", () => {
  it("reports the fullest drive involved", async () => {
    drives(500 * GB, 2 * GB);
    expect(await checkImportSpace(50, GB)).toMatchObject({ tier: "critical", free: 2 * GB });
  });

  it("adds needs together on one disk and says how much to free to finish the batch", async () => {
    drives(4 * GB, 500 * GB);
    const out = await checkImportSpace(50, 2 * GB);
    expect(out.tier).toBe("tight");
    const need = estimateImportBytes(50, 2 * GB);
    expect(out.toFree).toBe(need.uploads + need.appData + CRITICAL_FREE - 4 * GB);
  });

  it("is ok with room for the batch and the reserve, and unknown when no drive answers", async () => {
    drives(400 * GB, 400 * GB);
    expect(await checkImportSpace(50, GB)).toMatchObject({ tier: "ok", toFree: 0 });
    setVolumeProbe(async () => null);
    expect(await checkImportSpace(50, GB)).toEqual({ tier: "ok", free: null, volume: null, toFree: 0 });
  });

  it("remembers the Import page's batch for the checks made meanwhile", async () => {
    drives(60 * GB, 400 * GB);
    await checkImportSpace(0, 0, true);
    expect(await currentImportTier()).toBe("ok");
    await checkImportSpace(1000, 20 * GB, true);
    expect(await currentImportTier()).toBe("tight");
  });
});

describe("assertImportRoom", () => {
  it("refuses a file that would take the drive under the floor, with how much to free", async () => {
    drives(CRITICAL_FREE + GB, 400 * GB);
    await expect(assertImportRoom(0.5 * GB)).resolves.toBeUndefined();
    await expect(assertImportRoom(2 * GB)).rejects.toMatchObject({ code: "disk_full", free: CRITICAL_FREE + GB });
    drives(400 * GB, 2.1 * GB);
    await expect(assertImportRoom(0)).rejects.toMatchObject({ code: "disk_full" });
  });
});
