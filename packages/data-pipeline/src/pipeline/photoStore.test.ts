import { describe, expect, it } from "vitest";
import { staleShards, type PhotoStoreIndex } from "./photoStore.js";

const index = (...names: string[]): PhotoStoreIndex =>
  ({
    v: 1,
    builtAt: "",
    species: {},
    shards: names.map((name) => ({ name, bytes: 1, sha256: "" })),
  }) as PhotoStoreIndex;

describe("staleShards", () => {
  it("keeps the replaced index's shards for installs still downloading them", () => {
    const assets = ["a.bin", "b.bin", "c.bin", "lifer-photo-store.json.gz"];
    expect(staleShards(assets, index("c.bin"), index("b.bin"))).toEqual(["a.bin"]);
  });

  it("keeps only the new index's shards when nothing was published before", () => {
    expect(staleShards(["a.bin", "c.bin"], index("c.bin"), null)).toEqual(["a.bin"]);
  });
});
