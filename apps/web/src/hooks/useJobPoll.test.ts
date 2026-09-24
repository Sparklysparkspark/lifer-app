import { describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({ api: {}, ApiError: class ApiError extends Error {} }));

const { nextPollDelay } = await import("./useJobPoll");

describe("nextPollDelay", () => {
  it("stops polling after a 404, even with an idle cadence", () => {
    expect(nextPollDelay({ notFound: true, running: false, intervalMs: 1000, idleIntervalMs: 3000 })).toBeNull();
    expect(nextPollDelay({ notFound: true, running: true, intervalMs: 1000, idleIntervalMs: 3000 })).toBeNull();
  });

  it("keeps the normal cadence for other outcomes", () => {
    expect(nextPollDelay({ notFound: false, running: true, intervalMs: 1000, idleIntervalMs: 3000 })).toBe(1000);
    expect(nextPollDelay({ notFound: false, running: false, intervalMs: 1000, idleIntervalMs: 3000 })).toBe(3000);
    expect(nextPollDelay({ notFound: false, running: false, intervalMs: 1000, idleIntervalMs: null })).toBeNull();
  });
});
