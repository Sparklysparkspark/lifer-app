import { describe, expect, it } from "vitest";
import { canSend } from "./routes.js";

describe("canSend", () => {
  it("sends a photo that was never sent", () => {
    expect(canSend(null, 123)).toBe(true);
  });

  it("sends again a photo whose send stopped partway, to finish its observation", () => {
    expect(canSend(false, 123)).toBe(true);
  });

  it("skips a photo that is already on iNaturalist", () => {
    expect(canSend(true, 123)).toBe(false);
  });

  it("skips a species iNaturalist doesn't know yet", () => {
    expect(canSend(null, null)).toBe(false);
  });
});
