import { describe, expect, it } from "vitest";
import { addToSetIn, groupInto } from "./groupInto";

describe("groupInto and addToSetIn", () => {
  it("creates each bucket on first use", () => {
    const lists = new Map<string, number[]>();
    groupInto(lists, "a", 1);
    groupInto(lists, "a", 2);
    groupInto(lists, "b", 3);
    expect([...lists]).toEqual([
      ["a", [1, 2]],
      ["b", [3]],
    ]);
    const sets = new Map<string, Set<number>>();
    addToSetIn(sets, "a", 1);
    addToSetIn(sets, "a", 1);
    expect(sets.get("a")).toEqual(new Set([1]));
  });
});
