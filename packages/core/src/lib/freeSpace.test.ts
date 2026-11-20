import { beforeEach, describe, expect, it, vi } from "vitest";

const statfs = vi.fn();
vi.mock("node:fs/promises", async (orig) => ({ ...(await orig<typeof import("node:fs/promises")>()), statfs }));
const { DiskFullError, ensureRoom, freeSpace } = await import("./freeSpace.js");

beforeEach(() => {
  statfs.mockReset();
});

describe("freeSpace", () => {
  it("multiplies available blocks by block size", async () => {
    statfs.mockResolvedValue({ bavail: 1000, bsize: 4096 });
    expect(await freeSpace("/tmp")).toBe(4_096_000);
  });
  it("is null when unknown", async () => {
    statfs.mockImplementation(async () => {
      throw Object.assign(new Error("x"), { code: "EIO" });
    });
    expect(await freeSpace("/tmp")).toBeNull();
  });
});

describe("ensureRoom", () => {
  it("throws disk_full with sizes when short, including the 10% margin", async () => {
    statfs.mockResolvedValue({ bavail: 1_200_000, bsize: 1000 });
    const err = await ensureRoom("/x", 1_150_000_000).catch((e) => e);
    expect(err).toBeInstanceOf(DiskFullError);
    expect(err).toMatchObject({ code: "disk_full", needed: 1_150_000_000, free: 1_200_000_000 });
    expect(err.message).toBe("Needs 1.1 GB, 1.2 GB free");
  });
  it("passes when there is room, or free space is unknown", async () => {
    statfs.mockResolvedValue({ bavail: 1_000_000, bsize: 1000 });
    await expect(ensureRoom("/x", 500_000_000)).resolves.toBeUndefined();
    statfs.mockImplementation(async () => {
      throw Object.assign(new Error("x"), { code: "EIO" });
    });
    await expect(ensureRoom("/x", 5e12)).resolves.toBeUndefined();
  });
});
