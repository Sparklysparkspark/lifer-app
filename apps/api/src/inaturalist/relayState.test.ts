import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { decodeRelayState, encodeRelayState, isAllowedReturnOrigin } from "./relayState.js";

const PAGE = fileURLToPath(new URL("../../../../docs/static/inat-callback/index.html", import.meta.url));

// Runs the relay page's script against a query string; returns where it sent the browser, its
// message, and a Continue click when it asks first.
interface FakeElement {
  id?: string;
  hidden: boolean;
  textContent: string;
  onclick: (() => void) | null;
  appendChild(child: FakeElement): void;
}
function runPage(search: string): {
  replaced: string | null;
  message: string | null;
  /** Clicks Continue and returns where that sent the browser. */
  confirm: (() => string | null) | null;
} {
  const script = readFileSync(PAGE, "utf8").match(/<script>([\s\S]*?)<\/script>/)![1];
  let replaced: string | null = null;
  const element = (text = ""): FakeElement => ({
    hidden: true,
    textContent: text,
    onclick: null,
    appendChild(child) {
      this.textContent += child.textContent;
    },
  });
  const status = element("Returning you to Lifer...");
  const button = element();
  const byId: Record<string, FakeElement> = { status, hint: element(), continue: button };
  vm.runInNewContext(script, {
    URL,
    URLSearchParams,
    atob,
    location: { search, replace: (to: string) => (replaced = to) },
    document: {
      getElementById: (id: string) => byId[id],
      createElement: () => element(),
      createTextNode: (text: string) => element(text),
    },
  });
  return {
    replaced,
    message: status.textContent === "Returning you to Lifer..." ? null : status.textContent,
    confirm: button.hidden
      ? null
      : () => {
          button.onclick!();
          return replaced;
        },
  };
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
  it("names the install and forwards the whole query only once the person continues", () => {
    for (const origin of allowed) {
      const search = `?code=c0de&state=${encodeRelayState("r4nd", origin)}`;
      const page = runPage(search);
      expect(page.replaced).toBeNull();
      expect(page.message).toBe(`Finish connecting iNaturalist to your Lifer at ${new URL(origin).host}?`);
      expect(page.confirm!()).toBe(`${origin}/api/inaturalist/callback${search}`);
    }
  });

  it("returns a declined sign-in straight away, since it carries no code", () => {
    const denied = `?error=access_denied&error_description=no&state=${encodeRelayState("r", "http://127.0.0.1:4310")}`;
    const page = runPage(denied);
    expect(page.replaced).toBe(`http://127.0.0.1:4310/api/inaturalist/callback${denied}`);
    expect(page.confirm).toBeNull();
  });

  it("shows a message instead of redirecting for a missing or bad state", () => {
    const bad = refused.map((origin) => `?code=c&state=${encodeRelayState("r", origin)}`);
    for (const search of ["", "?code=c", "?code=c&state=nodot", "?code=c&state=r.%%%", ...bad]) {
      const result = runPage(search);
      expect([search, result.replaced, result.confirm]).toEqual([search, null, null]);
      expect(result.message).toMatch(/^This sign-in link isn't valid\./);
    }
  });
});
