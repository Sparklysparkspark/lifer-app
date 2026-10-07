import { describe, expect, it, vi } from "vitest";

vi.mock("@lifer/core/db.js", () => ({ pool: { query: vi.fn() } }));

import { pool } from "@lifer/core/db.js";
import { composeSpeciesName, sanitizeForFilesystem, resolveSpeciesFolderName } from "./speciesFolderName.js";

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

  // Boundary value: a name of only forbidden characters (plus whitespace) reduces to an empty
  // string, which resolveSpeciesFolderName doesn't special-case.
  it("boundary value: a name of only forbidden characters sanitizes to an empty string", () => {
    expect(sanitizeForFilesystem("///")).toBe("");
  });

  it("strips trailing dots and spaces (Windows drops them silently)", () => {
    expect(sanitizeForFilesystem("Genus sp.")).toBe("Genus sp");
    expect(sanitizeForFilesystem("Name. . ")).toBe("Name");
  });

  it("boundary value: an already-empty string stays empty", () => {
    expect(sanitizeForFilesystem("")).toBe("");
  });
});

describe("composeSpeciesName", () => {
  const noCodes = { abaCode: null, ebirdCode: null };
  const taxonomy = { taxonClass: "aves", taxonOrder: "Accipitriformes", family: "Pandionidae" };

  it("writes the taxonomy tree as one label, capitalizing the class", () => {
    expect(composeSpeciesName("Osprey", "Pandion haliaetus", ["tree"], noCodes, undefined, taxonomy)).toBe(
      "Aves / Accipitriformes / Pandionidae / Pandion haliaetus",
    );
  });

  it("skips missing ranks in the tree, and works with no taxonomy at all", () => {
    const partial = { taxonClass: null, taxonOrder: "Accipitriformes", family: null };
    expect(composeSpeciesName("Osprey", "Pandion haliaetus", ["tree"], noCodes, undefined, partial)).toBe(
      "Accipitriformes / Pandion haliaetus",
    );
    expect(composeSpeciesName("Osprey", "Pandion haliaetus", ["tree"], noCodes)).toBe("Pandion haliaetus");
  });

  it("keeps the tree's separators through folder-name sanitizing", () => {
    expect(
      composeSpeciesName("Osprey", "Pandion haliaetus", ["common", "tree"], noCodes, sanitizeForFilesystem, taxonomy),
    ).toBe("Osprey (Aves  Accipitriformes  Pandionidae  Pandion haliaetus)");
  });

  it("ignores a naming style it doesn't know", () => {
    expect(
      composeSpeciesName("Osprey", "Pandion haliaetus", ["future_style", "common"], {
        abaCode: "OSPR",
        ebirdCode: "osprey",
      }),
    ).toBe("Osprey");
  });

  it("falls back to the scientific name when no chosen part exists", () => {
    expect(composeSpeciesName(null, "Pandion haliaetus", ["aba_code"], noCodes)).toBe("Pandion haliaetus");
  });
});

// species_naming_styles defaults to an empty array unless a test says otherwise.
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
    mockSpeciesRow({
      common_name: "Mallard",
      scientific_name: "Anas platyrhynchos",
      aba_code: "MALL",
      species_naming_styles: ["common", "aba_code"],
    });
    const name = await resolveSpeciesFolderName("user-1", "species-1");
    expect(name).toBe("Mallard (MALL)");
  });

  it("falls back to the plain common name when the naming style is aba_code but this species has none", async () => {
    mockSpeciesRow({
      common_name: "Mallard",
      scientific_name: "Anas platyrhynchos",
      aba_code: null,
      species_naming_styles: ["common", "aba_code"],
    });
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as never);
    const name = await resolveSpeciesFolderName("user-1", "species-1");
    expect(name).toBe("Mallard");
  });

  it("appends the eBird code alongside the common name when that naming style is on and the species has one", async () => {
    mockSpeciesRow({
      common_name: "Mallard",
      scientific_name: "Anas platyrhynchos",
      ebird_code: "mallar3",
      species_naming_styles: ["common", "ebird_code"],
    });
    const name = await resolveSpeciesFolderName("user-1", "species-1");
    expect(name).toBe("Mallard (mallar3)");
  });

  it("appends both codes together, comma-separated, when both styles are on", async () => {
    mockSpeciesRow({
      common_name: "Mallard",
      scientific_name: "Anas platyrhynchos",
      aba_code: "MALL",
      ebird_code: "mallar3",
      species_naming_styles: ["common", "ebird_code", "aba_code"],
    });
    const name = await resolveSpeciesFolderName("user-1", "species-1");
    expect(name).toBe("Mallard (mallar3, MALL)");
    expect(name).not.toContain("/");
  });

  it("puts the Latin name first (unparenthesized) and common name in parens when Latin is ordered before common", async () => {
    mockSpeciesRow({
      common_name: "Mallard",
      scientific_name: "Anas platyrhynchos",
      species_naming_styles: ["latin", "common"],
    });
    const name = await resolveSpeciesFolderName("user-1", "species-1");
    expect(name).toBe("Anas platyrhynchos (Mallard)");
  });

  it("falls back to common-name-only when species_naming_styles is empty (unconfigured default)", async () => {
    mockSpeciesRow({ common_name: "Mallard", scientific_name: "Anas platyrhynchos", species_naming_styles: [] });
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as never);
    const name = await resolveSpeciesFolderName("user-1", "species-1");
    expect(name).toBe("Mallard");
  });
});
