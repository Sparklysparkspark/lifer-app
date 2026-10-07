import { describe, expect, it, vi } from "vitest";
import { startLocalApiSession } from "./localApiSession";

describe("startLocalApiSession", () => {
  it("trades the shell's secret for the session cookie", async () => {
    const invoke = vi.fn().mockResolvedValue("s3cret");
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}"));
    await startLocalApiSession(invoke, fetchImpl);
    expect(invoke).toHaveBeenCalledWith("local_api_credential");
    expect(fetchImpl).toHaveBeenCalledWith("/api/auth/desktop-session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "x-lifer-client": "1", "x-lifer-launch-token": "s3cret" },
    });
  });

  it("does nothing outside the desktop app, on a server page, or with an older shell", async () => {
    const fetchImpl = vi.fn();
    await startLocalApiSession(null, fetchImpl);
    await startLocalApiSession(vi.fn().mockResolvedValue(null), fetchImpl);
    await startLocalApiSession(vi.fn().mockRejectedValue(new Error("unknown command")), fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still resolves when the API can't be reached, so the page renders", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(startLocalApiSession(vi.fn().mockResolvedValue("s3cret"), fetchImpl)).resolves.toBeUndefined();
  });
});
