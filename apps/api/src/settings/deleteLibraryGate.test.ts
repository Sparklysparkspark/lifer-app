import { describe, expect, it } from "vitest";
import { deleteLocalLibraryBlockedReason, type MigrationOutcome } from "./deleteLibraryGate.js";

const clean: MigrationOutcome = {
  running: false,
  finishedAt: 1,
  error: null,
  cancelled: false,
  failed: 0,
  skipped: 0,
  serverUrl: "https://lifer.example",
};

describe("deleteLocalLibraryBlockedReason", () => {
  it("allows a clean, finished migration with every capture migrated", () => {
    expect(deleteLocalLibraryBlockedReason(clean, 0)).toBeNull();
  });

  it.each<[string, Partial<MigrationOutcome>]>([
    ["never run", { finishedAt: null, serverUrl: null }],
    ["still running", { running: true }],
    ["errored (a thrown first query leaves failed = 0)", { error: "connection refused" }],
    ["cancelled", { cancelled: true }],
    ["had failures", { failed: 1 }],
    ["skipped RAW-only captures", { skipped: 2 }],
  ])("blocks when the last run %s", (_label, patch) => {
    expect(deleteLocalLibraryBlockedReason({ ...clean, ...patch }, 0)).not.toBeNull();
  });

  it("blocks when the DB still has captures without a migrated row (skipped by an earlier run)", () => {
    expect(deleteLocalLibraryBlockedReason(clean, 3)).toMatch(/3 photos aren't on the server/);
  });
});
