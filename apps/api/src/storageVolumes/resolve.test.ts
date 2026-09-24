import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const identity = { listMountedVolumes: vi.fn(), mountPathFor: vi.fn(), getVolumeId: vi.fn() };
let tmp: string;

async function load(desktop: boolean) {
  vi.resetModules();
  vi.doMock("../db.js", () => ({ pool: { query } }));
  vi.doMock("../config.js", () => ({ SINGLE_USER_MODE: desktop }));
  vi.doMock("./volumeIdentity.js", () => identity);
  return import("./resolve.js");
}

const rootRow = (overrides: Record<string, unknown> = {}) => ({
  kind: "root",
  label: "NAS",
  platform_volume_id: null,
  root_path: tmp,
  removed_at: null,
  ...overrides,
});

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "lifer-resolve-")));
  query.mockReset();
  for (const fn of Object.values(identity)) fn.mockReset();
});
afterEach(() => {
  vi.doUnmock("../db.js");
  vi.doUnmock("../config.js");
  vi.doUnmock("./volumeIdentity.js");
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolveOriginalPath for a library root", () => {
  const original = { ref: "/stale", volume_id: "v1", volume_relative_path: "/Birds/heron.jpg" };

  it("joins the root path and the relative path when the folder is there", async () => {
    const { resolveOriginalPath } = await load(false);
    query.mockResolvedValueOnce({ rows: [rootRow()] });
    expect(await resolveOriginalPath(original)).toEqual({ path: `${tmp}/Birds/heron.jpg`, connected: true, volumeLabel: "NAS" });
    expect(identity.listMountedVolumes).not.toHaveBeenCalled();
  });

  it("reports not connected when the folder is gone", async () => {
    const { resolveOriginalPath } = await load(false);
    query.mockResolvedValueOnce({ rows: [rootRow({ root_path: path.join(tmp, "unmounted") })] });
    expect(await resolveOriginalPath(original)).toEqual({ path: null, connected: false, volumeLabel: "NAS" });
  });

  it("reports not connected once the root is removed from the env", async () => {
    const { resolveOriginalPath } = await load(false);
    query.mockResolvedValueOnce({ rows: [rootRow({ removed_at: "2026-09-24T00:00:00Z" })] });
    expect((await resolveOriginalPath(original)).connected).toBe(false);
  });
});

describe("resolveChosenVolumeDestination for a library root", () => {
  it("writes under the root's Lifer Originals folder", async () => {
    const { resolveChosenVolumeDestination } = await load(false);
    query.mockResolvedValueOnce({ rows: [rootRow()] });
    expect(await resolveChosenVolumeDestination("u1", "v1")).toEqual({
      baseDir: `${tmp}/Lifer Originals`,
      mountPath: tmp,
      volumeId: "v1",
    });
  });
});

describe("tagWithRegisteredVolume", () => {
  it("tags against the most specific root", async () => {
    const inner = path.join(tmp, "trips");
    mkdirSync(inner);
    const { tagWithRegisteredVolume } = await load(false);
    query.mockResolvedValueOnce({
      rows: [
        { id: "outer", root_path: tmp },
        { id: "inner", root_path: inner },
      ],
    });
    expect(await tagWithRegisteredVolume("u1", `${inner}/Alaska/a.jpg`)).toEqual({
      volumeId: "inner",
      volumeRelativePath: "/Alaska/a.jpg",
    });
  });

  it("doesn't match a sibling that only shares a name prefix", async () => {
    const { tagWithRegisteredVolume } = await load(false);
    query.mockResolvedValueOnce({ rows: [{ id: "r", root_path: tmp }] });
    expect(await tagWithRegisteredVolume("u1", `${tmp}-other/a.jpg`)).toEqual({ volumeId: null, volumeRelativePath: null });
  });

  it("never runs drive detection on a server", async () => {
    const { tagWithRegisteredVolume } = await load(false);
    query.mockResolvedValueOnce({ rows: [] });
    expect(await tagWithRegisteredVolume("u1", "/somewhere/a.jpg")).toEqual({ volumeId: null, volumeRelativePath: null });
    expect(identity.mountPathFor).not.toHaveBeenCalled();
    expect(identity.getVolumeId).not.toHaveBeenCalled();
  });

  it("still tags against a registered drive on desktop", async () => {
    const { tagWithRegisteredVolume } = await load(true);
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: "drive1" }] });
    identity.mountPathFor.mockResolvedValue("/Volumes/Ext");
    identity.getVolumeId.mockResolvedValue("UUID-1");
    expect(await tagWithRegisteredVolume("u1", "/Volumes/Ext/Birds/a.jpg")).toEqual({
      volumeId: "drive1",
      volumeRelativePath: "/Birds/a.jpg",
    });
  });
});
