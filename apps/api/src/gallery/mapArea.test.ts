import { describe, expect, it } from "vitest";
import { mapAreaSql } from "./mapArea.js";

function build(f: Parameters<typeof mapAreaSql>[0]) {
  const values: unknown[] = [];
  const sql = mapAreaSql(f, (v) => {
    values.push(v);
    return `$${values.length}`;
  });
  return { sql, values };
}

describe("mapAreaSql", () => {
  it("is nothing without a box or rings", () => {
    expect(build({}).sql).toBe("");
  });

  it("keeps a plain box as before", () => {
    const { sql, values } = build({ bbox: [-10, 40, 5, 50] });
    expect(sql).toBe("AND ((c.lat BETWEEN $1 AND $2 AND c.lon BETWEEN $3 AND $4))");
    expect(values).toEqual([40, 50, -10, 5]);
  });

  it("adds the rings' region-only photos to the box's, in one clause", () => {
    const { sql, values } = build({ bbox: [170, -20, -170, -10], orRegionOnly: ["r1", "r2"] });
    expect(sql).toBe(
      "AND ((c.lat BETWEEN $1 AND $2 AND (c.lon >= $3 OR c.lon <= $4)) OR ((c.lat IS NULL OR c.lon IS NULL) AND c.region_id = ANY($5::uuid[])))",
    );
    expect(values.at(-1)).toEqual(["r1", "r2"]);
  });

  it("lists only the rings' photos without a box", () => {
    expect(build({ orRegionOnly: ["r1"] }).sql).toBe(
      "AND (((c.lat IS NULL OR c.lon IS NULL) AND c.region_id = ANY($1::uuid[])))",
    );
  });
});
