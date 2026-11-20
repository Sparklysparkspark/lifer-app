import { describe, expect, it, vi } from "vitest";
import { errorMessage } from "./errorMessage";

describe("errorMessage", () => {
  it("passes through Tauri string errors", () => {
    expect(errorMessage("signature verification failed", "fallback")).toBe("signature verification failed");
  });
  it("reads Error messages", () => {
    expect(errorMessage(new Error("boom"), "fallback")).toBe("boom");
  });
  it("reads API { error } bodies", () => {
    expect(errorMessage({ error: "A catalog update is already running" }, "fallback")).toBe(
      "A catalog update is already running",
    );
  });
  it("describes Response-like objects", () => {
    expect(errorMessage({ ok: false, status: 502, statusText: "Bad Gateway" }, "Couldn't check")).toBe(
      "Couldn't check (502 Bad Gateway)",
    );
  });
  it("says a request that got no answer in plain words, offline or not", () => {
    vi.stubGlobal("navigator", { onLine: true });
    expect(errorMessage(new TypeError("Failed to fetch"), "fallback")).toBe(
      "Couldn't reach Lifer. Check your connection and try again.",
    );
    vi.stubGlobal("navigator", { onLine: false });
    expect(errorMessage(new TypeError("Load failed"), "fallback")).toBe(
      "You're offline. Check your connection and try again.",
    );
    vi.unstubAllGlobals();
    // Other TypeErrors are bugs with their own message.
    expect(errorMessage(new TypeError("x is not a function"), "fallback")).toBe("x is not a function");
  });
  it("falls back for empty or unknown values", () => {
    expect(errorMessage("", "fallback")).toBe("fallback");
    expect(errorMessage(undefined, "fallback")).toBe("fallback");
    expect(errorMessage(42, "fallback")).toBe("fallback");
  });
});
