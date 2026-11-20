import { describe, expect, it } from "vitest";
import { plannedAutoDownloads } from "./autoDownloads.js";

const all = { modelsWanted: true, mapWanted: true, modelsDownloaded: false, mapDownloaded: false, mapAvailable: true };

describe("plannedAutoDownloads", () => {
  it("starts what's wanted and missing, and nothing a user turned off or already has", () => {
    expect(plannedAutoDownloads(all)).toEqual({ models: true, map: true });
    expect(plannedAutoDownloads({ ...all, modelsWanted: false })).toEqual({ models: false, map: true });
    expect(plannedAutoDownloads({ ...all, mapDownloaded: true, modelsDownloaded: true })).toEqual({
      models: false,
      map: false,
    });
    expect(plannedAutoDownloads({ ...all, mapAvailable: false })).toEqual({ models: true, map: false });
  });
});
