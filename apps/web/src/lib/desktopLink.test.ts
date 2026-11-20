import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDesktopLink, forgetDesktopLink } from "./desktopLink";
import { api } from "../api/client";

afterEach(() => vi.restoreAllMocks());

describe("ensureDesktopLink", () => {
  it("mints a key and hands it to the shell only when the shell asks for one", async () => {
    const calls: string[] = [];
    const invoke = async (cmd: string, args?: unknown) => {
      calls.push(cmd + (args ? " " + JSON.stringify(args) : ""));
      return cmd === "server_link_needed";
    };
    vi.spyOn(api, "post").mockResolvedValue({ id: "k1", token: "lifer_x", linkSecret: "s1" } as never);
    await ensureDesktopLink(invoke);
    expect(calls).toEqual([
      "server_link_needed",
      'store_server_link {"keyId":"k1","token":"lifer_x","linkSecret":"s1"}',
    ]);

    calls.length = 0;
    await ensureDesktopLink(async (cmd: string) => (calls.push(cmd), false));
    expect(calls).toEqual(["server_link_needed"]);
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it("does nothing in a browser or with an older shell", async () => {
    vi.spyOn(api, "post");
    await ensureDesktopLink(null);
    await ensureDesktopLink(async () => {
      throw new Error("no such command");
    });
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe("forgetDesktopLink", () => {
  it("revokes the key the shell was holding", async () => {
    const del = vi.spyOn(api, "delete").mockResolvedValue({ ok: true } as never);
    await forgetDesktopLink(async () => "k1");
    expect(del).toHaveBeenCalledWith("/api-keys/k1");
    await forgetDesktopLink(async () => null);
    expect(del).toHaveBeenCalledTimes(1);
  });
});
