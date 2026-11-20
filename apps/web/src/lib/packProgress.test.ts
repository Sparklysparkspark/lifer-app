import { describe, expect, it } from "vitest";
import { idlePackLanes, type PackDownloadStatus } from "@lifer/shared";
import i18n from "../i18n";
import { canContinueInBackground, packProgressRow, packSetupState } from "./packProgress";

const t = i18n.t.bind(i18n);

function status(over: Partial<PackDownloadStatus> = {}, lanes: (l: PackDownloadStatus["lanes"]) => void = () => {}) {
  const l = idlePackLanes();
  for (const lane of Object.values(l)) lane.total = 3;
  lanes(l);
  return {
    running: true,
    phase: "downloading",
    processed: 0,
    total: 3,
    finishedAt: null,
    error: null,
    cancelled: false,
    cancelRequested: false,
    packIds: [],
    currentPack: null,
    lanes: l,
    ...over,
  } as unknown as PackDownloadStatus;
}

describe("packProgressRow", () => {
  it("waits on the catalog before any pack starts", () => {
    const s = status({ phase: "preparing" }, (l) => Object.values(l).forEach((lane) => (lane.total = 0)));
    expect(packProgressRow(s, t).title).toBe("Getting the species list ready");
  });

  it("follows the download, with a pack set up meanwhile as a note", () => {
    const s = status({}, (l) => {
      Object.assign(l.download, { currentItem: "Canada mammals", processed: 1, downloadedBytes: 1e6, totalBytes: 4e6 });
      Object.assign(l.setup, { currentItem: "Canada birds", step: "checklist" });
    });
    expect(packProgressRow(s, t)).toMatchObject({
      key: "download",
      title: "Downloading",
      detail: "Canada mammals, 2 of 3",
      fraction: 0.25,
      note: null,
      also: "Also setting up Canada birds on this computer",
      // The pack in progress counts by its bytes, so the time left moves within a pack.
      eta: { done: 1.25, total: 3 },
    });
  });

  it("keeps the photos label while photos download", () => {
    const s = status({}, (l) => {
      Object.assign(l.download, { processed: 3 });
      Object.assign(l.photos, { processed: 1, currentItem: "Canada birds", downloadedBytes: 5, totalBytes: 10 });
    });
    expect(packProgressRow(s, t)).toMatchObject({
      title: "Downloading photos",
      detail: "Canada birds",
      fraction: 0.5,
      also: null,
    });
  });

  it("turns into the set-up once nothing downloads", () => {
    const s = status({}, (l) => {
      Object.assign(l.download, { processed: 3 });
      Object.assign(l.photos, { processed: 3 });
      Object.assign(l.setup, { processed: 2, currentItem: "Canada fish", step: "hotspots" });
    });
    expect(packProgressRow(s, t)).toMatchObject({
      key: "setup",
      title: "Setting up on this computer",
      detail: "Where to find them: Canada fish",
      note: "Doesn't use the internet",
      amount: "2 of 3",
      fraction: 2 / 3,
      also: null,
    });
  });

  it("moves calmly while the first pack sets up, with nothing yet to count", () => {
    const s = status({}, (l) => {
      Object.assign(l.download, { processed: 1 });
      Object.assign(l.setup, { currentItem: "Canada birds", step: "checklist" });
    });
    expect(packProgressRow(s, t)).toMatchObject({ key: "setup", fraction: null, eta: { done: 0, total: 3 } });
  });

  it("times the catalog load the packs wait for", () => {
    const s = status({ phase: "preparing", catalogProgress: { processed: 40, total: 200 } }, (l) =>
      Object.values(l).forEach((lane) => (lane.total = 0)),
    );
    expect(packProgressRow(s, t).eta).toEqual({ done: 40, total: 200 });
  });
});

describe("canContinueInBackground", () => {
  it("waits for the catalog, then lets the user go in while packs come", () => {
    const preparing = status({ phase: "preparing" }, (l) => Object.values(l).forEach((lane) => (lane.total = 0)));
    expect(canContinueInBackground(preparing)).toBe(false);
    expect(canContinueInBackground(status({ catalogProgress: { processed: 1, total: 2 } }))).toBe(false);
    expect(canContinueInBackground(status())).toBe(true);
  });

  it("isn't offered once stopping or stopped", () => {
    expect(canContinueInBackground(status({ cancelRequested: true }))).toBe(false);
    expect(canContinueInBackground(status({ running: false }))).toBe(false);
    expect(canContinueInBackground(null)).toBe(false);
  });
});

describe("packSetupState", () => {
  it("is idle for a run started elsewhere", () => {
    expect(packSetupState(status(), false)).toBe("idle");
  });

  it("works until the first pack's checklist is in, then lets the user in", () => {
    expect(packSetupState(status(), true)).toBe("working");
    expect(
      packSetupState(
        status({}, (l) => (l.setup.processed = 1)),
        true,
      ),
    ).toBe("ready");
  });

  it("lets the user in after downloads are stopped and what was on disk finished", () => {
    // Stopping downloads only ends the run normally once the packs on disk are set up.
    const done = status({ running: false, finishedAt: 1, result: { packsApplied: 1 } }, (l) => (l.setup.processed = 1));
    expect(packSetupState(done, true)).toBe("ready");
  });

  it("fails back to the picker when nothing got set up, and cancels the same way", () => {
    expect(packSetupState(status({ running: false, finishedAt: 1, error: "offline" }), true)).toBe("failed");
    expect(packSetupState(status({ running: false, finishedAt: 1, cancelled: true }), true)).toBe("cancelled");
  });

  it("still lets the user in when a later pack fails", () => {
    const s = status({ running: false, finishedAt: 1, error: "offline" }, (l) => (l.setup.processed = 1));
    expect(packSetupState(s, true)).toBe("ready");
  });

  it("resumes: a new run after a failure starts working again", () => {
    expect(packSetupState(status({ running: true }), true)).toBe("working");
  });
});
