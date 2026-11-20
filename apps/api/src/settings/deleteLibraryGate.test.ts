import { describe, expect, it } from "vitest";
import { deleteLocalLibraryBlockedReason, type PushState } from "./deleteLibraryGate.js";

const clean: PushState = { linked: true, pushRunning: false, lastPushError: null, unpushed: 0 };

describe("deleteLocalLibraryBlockedReason", () => {
  it("allows a linked library with everything pushed", () => {
    expect(deleteLocalLibraryBlockedReason(clean)).toBeNull();
  });

  it.each<[string, Partial<PushState>]>([
    ["not linked to a server", { linked: false }],
    ["still pushing", { pushRunning: true }],
    ["the last push errored", { lastPushError: "connection refused" }],
  ])("blocks when %s", (_label, patch) => {
    expect(deleteLocalLibraryBlockedReason({ ...clean, ...patch })).not.toBeNull();
  });

  it("blocks while captures are unpushed, saying how many", () => {
    expect(deleteLocalLibraryBlockedReason({ ...clean, unpushed: 3 })).toMatch(/3 changes aren't on the server/);
  });
});
