import { afterEach, describe, expect, it, vi } from "vitest";
import { ignore } from "./ignore";

afterEach(() => vi.restoreAllMocks());

describe("ignore", () => {
  it("logs the failure with its reason, but not a cancelled request", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ignore("Couldn't load tags")(new Error("offline"));
    ignore("Couldn't load tags")(new DOMException("aborted", "AbortError"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("Couldn't load tags:", expect.any(Error));
  });
});
