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

// species_naming_styles defaults to an empty array for these fixtures unless a test says
// otherwise — matches migration 082's own column default, so a species/user row that predates
// this setting behaves exactly like it always did.
function mockSpeciesRow(row: {
  common_name: string | null;
  scientific_name: string;
  aba_code?: string | null;
  ebird_code?: string | null;
  species_naming_styles?: string[];
}) {
  vi.mocked(pool.query).mockResolvedValueOnce({
    rows: [{ aba_code: null, ebird_code: null, species_naming_styles: [], ...row }],
  } as never);
}

describe("resolveSpeciesFolderName", () => {
  it("uses the scientific name when there's no common name at all", async () => {
    mockSpeciesRow({ common_name: null, scientific_name: "Anas platyrhynchos" });
    const name = await resolveSpeciesFolderName("user-1", "species-1");
    expect(name).toBe("Anas platyrhynchos");
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("uses the plain common name when no other species shares it", async () => {
    mockSpeciesRow({ common_name: "Mallard", scientific_name: "Anas platyrhynchos" });
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as never);
    const name = await resolveSpeciesFolderName("user-1", "species-1");
    expect(name).toBe("Mallard");
  });

  it("disambiguates with the scientific name when a collision exists", async () => {
    mockSpeciesRow({ common_name: "Mallard", scientific_name: "Anas platyrhynchos" });
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [{ "?column?": 1 }] } as never);
    const name = await resolveSpeciesFolderName("user-1", "species-1");
    expect(name).toBe("Mallard (Anas platyrhynchos)");
  });

  it("sanitizes the common name before using it as a folder name", async () => {
    mockSpeciesRow({ common_name: "Mallard/Duck", scientific_name: "Anas platyrhynchos" });
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as never);
    const name = await resolveSpeciesFolderName("user-1", "species-1");
    expect(name).toBe("MallardDuck");
  });

  it("appends the ABA code alongside the common name when that naming style is on and the species has one", async () => {
    mockSpeciesRow({ common_name: "Mallard", scientific_name: "Anas platyrhynchos", aba_code: "MALL", species_naming_styles: ["aba_code"] });
    const name = await resolveSpeciesFolderName("user-1", "species-1");
    expect(name).toBe("Mallard (MALL)");
  });

  it("falls back to the plain common name when the naming style is aba_code but this species has none", async () => {
    mockSpeciesRow({ common_name: "Mallard", scientific_name: "Anas platyrhynchos", aba_code: null, species_naming_styles: ["aba_code"] });
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as never);
    const name = await resolveSpeciesFolderName("user-1", "species-1");
    expect(name).toBe("Mallard");
  });

  it("appends the eBird code alongside the common name when that naming style is on and the species has one", async () => {
    mockSpeciesRow({ common_name: "Mallard", scientific_name: "Anas platyrhynchos", ebird_code: "mallar3", species_naming_styles: ["ebird_code"] });
    const name = await resolveSpeciesFolderName("user-1", "species-1");
    expect(name).toBe("Mallard (mallar3)");
  });

  it("appends both codes together, common name space-separated by a slash, when both styles are on", async () => {
    mockSpeciesRow({
      common_name: "Mallard",
      scientific_name: "Anas platyrhynchos",
      aba_code: "MALL",
      ebird_code: "mallar3",
      species_naming_styles: ["ebird_code", "aba_code"],
    });
    const name = await resolveSpeciesFolderName("user-1", "species-1");
    expect(name).toBe("Mallard (mallar3 / MALL)");
  });
});
