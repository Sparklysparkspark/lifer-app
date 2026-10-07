import { describe, expect, it } from "vitest";
import { cullInfo, isRejected, rejectedRowNote } from "./cullInfo";

describe("cullInfo", () => {
  it("names the verdict and the label", () => {
    expect(cullInfo("pick", "red")).toBe("Picked in your culling app · Red label");
    expect(cullInfo("reject", null)).toBe("Rejected in your culling app");
    expect(cullInfo(null, "purple")).toBe("Purple label");
  });

  it("says nothing without a mark", () => {
    expect(cullInfo(null, null)).toBeNull();
    expect(cullInfo(undefined, undefined)).toBeNull();
  });
});

describe("rejectedRowNote", () => {
  const rejected = { cull: { verdict: "reject" as const, label: null } };
  it("says what the chosen option will do with a rejected photo", () => {
    expect(rejectedRowNote(rejected, "skip")).toBe("Rejected in your culling app, won't be imported");
    expect(rejectedRowNote(rejected, "hide")).toBe("Rejected in your culling app, will be imported hidden");
    expect(rejectedRowNote(rejected, "ignore")).toBe("Rejected in your culling app");
  });

  it("says nothing for a photo that wasn't rejected or wasn't read", () => {
    expect(rejectedRowNote({ cull: { verdict: "pick", label: "red" } }, "skip")).toBeNull();
    expect(rejectedRowNote({}, "skip")).toBeNull();
    expect(isRejected({ cull: null })).toBe(false);
  });
});
