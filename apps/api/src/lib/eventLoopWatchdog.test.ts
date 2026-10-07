import { describe, expect, it } from "vitest";
import {
  isEventLoopWatchdogPaused,
  pauseEventLoopWatchdog,
  resumeEventLoopWatchdog,
  withWatchdogPaused,
} from "./eventLoopWatchdog.js";

describe("eventLoopWatchdog pause", () => {
  it("counts nested pauses and resumes only after the last one", () => {
    expect(isEventLoopWatchdogPaused()).toBe(false);
    pauseEventLoopWatchdog();
    pauseEventLoopWatchdog();
    resumeEventLoopWatchdog();
    expect(isEventLoopWatchdogPaused()).toBe(true);
    resumeEventLoopWatchdog();
    expect(isEventLoopWatchdogPaused()).toBe(false);
    resumeEventLoopWatchdog();
    expect(isEventLoopWatchdogPaused()).toBe(false);
  });

  it("withWatchdogPaused resumes even when the work throws", async () => {
    await expect(
      withWatchdogPaused(() => {
        expect(isEventLoopWatchdogPaused()).toBe(true);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(isEventLoopWatchdogPaused()).toBe(false);
  });
});
