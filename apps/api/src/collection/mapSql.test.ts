import { describe, expect, it } from "vitest";
import { collectionMapSql, pinPhotosSql } from "./map.js";

describe.each([
  ["pins", collectionMapSql, "$3"],
  ["pin photos", pinPhotosSql, "$6"],
])("%s query", (_name, build, boxes) => {
  it("with an outline, reads the boxes or the region tree, each parameter one type", () => {
    const sql = build(true);
    expect(sql).toContain(`${boxes}::jsonb`);
    expect(sql).toContain("$2::uuid");
    expect(sql).not.toContain("$2::jsonb");
    expect(sql).toContain("c.region_id IN (SELECT id FROM tree) OR EXISTS");
  });

  it("without an outline, reads only the region tree", () => {
    const sql = build(false);
    expect(sql).toContain("$2::uuid");
    expect(sql).not.toContain("jsonb");
    expect(sql).toContain("c.region_id IN (SELECT id FROM tree)");
  });
});
