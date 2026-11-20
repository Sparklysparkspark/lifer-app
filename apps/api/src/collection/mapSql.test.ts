import { describe, expect, it } from "vitest";
import { collectionMapSql, pinPhotosSql } from "./map.js";

describe.each([
  ["pins", collectionMapSql],
  ["pin photos", pinPhotosSql],
])("%s query", (_name, build) => {
  it("with an outline, uses $2 only as JSON and has no region tree", () => {
    const sql = build(true);
    expect(sql).toContain("$2::jsonb");
    expect(sql).not.toContain("$2::uuid");
    expect(sql).not.toMatch(/\btree\b/);
  });

  it("without an outline, uses $2 only as the region id for the tree", () => {
    const sql = build(false);
    expect(sql).toContain("$2::uuid");
    expect(sql).not.toContain("$2::jsonb");
    expect(sql).toContain("c.region_id IN (SELECT id FROM tree)");
  });
});
