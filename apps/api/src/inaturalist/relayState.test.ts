import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { decodeRelayState, encodeRelayState, isAllowedReturnOrigin } from "./relayState.js";

const PAGE = fileURLToPath(new URL("../../../../docs/static/inat-callback/index.html", import.meta.url));

// Runs the relay page's script against a query string; returns where it sent the browser, or its message.
function runPage(search: string): { replaced: string | null; message: string | null } {
  const script = readFileSync(PAGE, "utf8").match(/<script>([\s\S]*?)<\/script>/)![1];
  const result = { replaced: null as string | null, message: null as string | null };
  const status = {
    set textContent(text: string) {
      result.message = text;
    },
  };
  vm.runInNewContext(script, {
    URL,
    URLSearchParams,
    atob,
    location: { search, replace: (to: string) => (result.replaced = to) },
    document: { getElementById: () => status },
  });
  return result;
}

const allowed = [
  "https://lifer.example.com",
  "https://lifer.example.com:8443",
  "http://127.0.0.1:4310",
  "http://localhost:4000",
  "http://[::1]:4310",
  "http://192.168.1.20:30080",
  "http://10.0.0.5",
  "http://172.16.0.1:4000",
  "http://172.31.255.255",
  "http://truenas.local:30080",
];
const refused = [
  "http://lifer.example.com",
  "http://8.8.8.8",
  "http://172.32.0.1",
  "http://10.evil.com",
  "http://192.168.1.20.evil.com",
  "https://lifer.example.com/",
  "https://lifer.example.com/api",
  "https://lifer.example.com?x=1",
  "https://user:pass@lifer.example.com",
  "javascript:alert(1)",
  "ftp://lifer.example.com",
  "HTTPS://LIFER.EXAMPLE.COM",
  "",
  "not a url",
];

describe("relay state", () => {
  it("allows https anywhere and http only on local addresses, with nothing after the origin", () => {
    for (const origin of allowed) expect([origin, isAllowedReturnOrigin(origin)]).toEqual([origin, true]);
    for (const origin of refused) expect([origin, isAllowedReturnOrigin(origin)]).toEqual([origin, false]);
  });

  it("round-trips the origin and refuses states without a usable one", () => {
    const state = encodeRelayState("abc_-123", "https://lifer.example.com");
    expect(state).toMatch(/^abc_-123\.[A-Za-z0-9_-]+$/);
    expect(decodeRelayState(state)).toBe("https://lifer.example.com");
    expect(decodeRelayState("abc123")).toBeNull();
    expect(decodeRelayState(`.${Buffer.from("https://a.example").toString("base64url")}`)).toBeNull();
    expect(decodeRelayState(encodeRelayState("abc", "http://lifer.example.com"))).toBeNull();
  });
});

describe("relay page", () => {
  it("forwards the whole query to the origin in state", () => {
    for (const origin of allowed) {
      const search = `?code=c0de&state=${encodeRelayState("r4nd", origin)}`;
      expect(runPage(search)).toEqual({ replaced: `${origin}/api/inaturalist/callback${search}`, message: null });
    }
    const denied = `?error=access_denied&error_description=no&state=${encodeRelayState("r", "http://127.0.0.1:4310")}`;
    expect(runPage(denied).replaced).toBe(`http://127.0.0.1:4310/api/inaturalist/callback${denied}`);
  });

  it("shows a message instead of redirecting for a missing or bad state", () => {
    const bad = refused.map((origin) => `?code=c&state=${encodeRelayState("r", origin)}`);
    for (const search of ["", "?code=c", "?code=c&state=nodot", "?code=c&state=r.%%%", ...bad]) {
      const result = runPage(search);
      expect([search, result.replaced]).toEqual([search, null]);
      expect(result.message).toMatch(/^This sign-in link isn't valid\./);
    }
  });
});
