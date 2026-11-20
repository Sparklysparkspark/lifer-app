import { describe, expect, it } from "vitest";
import { startsOnboarding } from "./useFirstRunRegion";

const firstRun = { desktop: true, packCount: 0, packsError: false, downloadRunning: false };

describe("startsOnboarding", () => {
  it("starts onboarding on a desktop install with no pack and nothing downloading", () => {
    expect(startsOnboarding(firstRun)).toBe(true);
  });
  it("waits while a download is putting its first pack in, or its state isn't known yet", () => {
    expect(startsOnboarding({ ...firstRun, downloadRunning: true })).toBe(false);
    expect(startsOnboarding({ ...firstRun, downloadRunning: null })).toBe(false);
  });
  it("doesn't take a pack list that failed to load for an empty one", () => {
    expect(startsOnboarding({ ...firstRun, packsError: true })).toBe(false);
  });
  it("needs the desktop app, a known pack count of zero", () => {
    expect(startsOnboarding({ ...firstRun, desktop: false })).toBe(false);
    expect(startsOnboarding({ ...firstRun, packCount: null })).toBe(false);
    expect(startsOnboarding({ ...firstRun, packCount: 1 })).toBe(false);
  });
});
