import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ pool: { query: vi.fn() } }));

import { pool } from "../db.js";
import { sanitizeForFilesystem, resolveSpeciesFolderName } from "./speciesFolderName.js";

describe("sanitizeForFilesystem", () => {
  it("leaves an ordinary name unchanged", () => {
    expect(sanitizeForFilesystem("Mallard")).toBe("Mallard");
  });

  it("strips characters forbidden across Windows/macOS/Linux filenames", () => {
    expect(sanitizeForFilesystem('A/B\\C:D*E?F"G<H>I|J')).toBe("ABCDEFGHIJ");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeForFilesystem("  Mallard  ")).toBe("Mallard");
  });

  // Boundary value: a name made ENTIRELY of forbidden characters (plus whitespace) reduces to
  // an empty string — the caller (resolveSpeciesFolderName) has no special handling for this,
  // so it's worth pinning down explicitly rather than assuming.
  it("boundary value: a name of only forbidden characters sanitizes to an empty string", () => {
    expect(sanitizeForFilesystem("///")).toBe("");
  });

  it("boundary value: an already-empty string stays empty", () => {
    expect(sanitizeForFilesystem("")).toBe("");
  });
});

describe("resolveSpeciesFolderName", () => {
  it("uses the scientific name when there's no common name at all", async () => {
    const name = await resolveSpeciesFolderName(null, "Anas platyrhynchos");
    expect(name).toBe("Anas platyrhynchos");
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("uses the plain common name when no other species shares it", async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as never);
    const name = await resolveSpeciesFolderName("Mallard", "Anas platyrhynchos");
    expect(name).toBe("Mallard");
  });

  it("disambiguates with the scientific name when a collision exists", async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [{ "?column?": 1 }] } as never);
    const name = await resolveSpeciesFolderName("Mallard", "Anas platyrhynchos");
    expect(name).toBe("Mallard (Anas platyrhynchos)");
  });

  it("sanitizes the common name before using it as a folder name", async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as never);
    const name = await resolveSpeciesFolderName("Mallard/Duck", "Anas platyrhynchos");
    expect(name).toBe("MallardDuck");
  });
});
