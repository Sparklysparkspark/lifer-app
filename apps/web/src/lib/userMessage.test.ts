import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { ApiError } from "../api/client";
import { connectionMessage, userMessage } from "./userMessage";

afterEach(() => vi.unstubAllGlobals());

const t = (k: string) => i18n.t(`errors.user.${k}`);

describe("userMessage", () => {
  it.each([
    [new TypeError("Failed to fetch"), "network"],
    [new ApiError(502, "Bad Gateway"), "network"],
    [new Error("ENOSPC: no space left on device, write"), "diskFull"],
    [new ApiError(507, "Insufficient Storage"), "diskFull"],
    ["EPERM: operation not permitted, open '/x'", "permission"],
    [new ApiError(401, "unauthorized"), "signedOut"],
    [new ApiError(403, "forbidden"), "notAllowed"],
    [{ message: "ENOENT: no such file" }, "notFound"],
    [new ApiError(404, "Not Found"), "notFound"],
    [new Error("deadlock detected"), "unknown"],
    [undefined, "unknown"],
  ])("maps %s to %s", (err, kind) => {
    expect(userMessage(err)).toBe(t(kind));
  });

  it("says offline when the browser is offline", () => {
    vi.stubGlobal("navigator", { onLine: false });
    expect(userMessage(new Error("boom"))).toBe(t("offline"));
  });

  it("states the sizes for a disk_full error", () => {
    const err = Object.assign(new ApiError(507, "x", "disk_full"), { needed: 3_400_000_000, free: 1_200_000_000 });
    expect(userMessage(err)).toMatch(/^Needs 3\.4 GB, 1\.2 GB free/);
  });

  it("never returns the raw message", () => {
    expect(userMessage(new Error("deadlock detected"))).not.toContain("deadlock");
  });
});

describe("connectionMessage", () => {
  it.each([
    [new TypeError("Failed to fetch"), "network"],
    [new ApiError(503, "Service Unavailable"), "network"],
    [new ApiError(504, "Gateway Timeout"), "slow"],
    [Object.assign(new Error("signal timed out"), { name: "TimeoutError" }), "slow"],
  ])("words %s as %s", (err, kind) => {
    expect(connectionMessage(err)).toBe(t(kind));
  });

  it("leaves a server's answer to the page's own words", () => {
    expect(connectionMessage(new ApiError(500, "Internal Server Error"))).toBeNull();
    expect(connectionMessage(new ApiError(404, "Not Found"))).toBeNull();
  });

  it("says offline only for a request that got no answer", () => {
    vi.stubGlobal("navigator", { onLine: false });
    expect(connectionMessage(new TypeError("Failed to fetch"))).toBe(t("offline"));
    // The desktop app's own server answers without the internet.
    expect(connectionMessage(new ApiError(500, "boom"))).toBeNull();
  });
});
