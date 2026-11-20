import { describe, expect, it } from "vitest";
import { removeSearchPart } from "./searchParts";

const QUERY =
  "Predators stalking at blue hour with a tree in the background, making eye contact with the camera, uses the golden ratio, and is backlit";

describe("removeSearchPart", () => {
  it("takes a part's words out whatever the case or punctuation", () => {
    expect(removeSearchPart(QUERY, { text: "predators" })).toBe(
      "stalking at blue hour with a tree in the background, making eye contact with the camera, uses the golden ratio, and is backlit",
    );
    expect(removeSearchPart(QUERY, { text: "tree in the background" })).toBe(
      "Predators stalking at blue hour with a, making eye contact with the camera, uses the golden ratio, and is backlit",
    );
    expect(removeSearchPart("red-tailed hawk at dusk", { text: "red tailed hawk" })).toBe("at dusk");
  });
  it("leaves a word inside another alone, and a part it can't find", () => {
    expect(removeSearchPart("treehouse", { text: "tree" })).toBe("treehouse");
    expect(removeSearchPart("owls", { text: "foxes" })).toBe("owls");
  });
});
