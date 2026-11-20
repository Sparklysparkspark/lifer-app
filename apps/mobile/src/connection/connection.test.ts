import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { equalBytes, pakeAnswer, type CompanionPairingPayload } from "@lifer/shared";
import { baseUrl, isPrivateHost, toFoundHubs } from "./address";
import { forgetHub, loadHub, saveHub, type SecureKv } from "./hubStore";
import { PairError, pairWithCode, pairWithHub, type FoundHub, type Transport } from "./pair";

const CERT = "a".repeat(64);
const desktop: CompanionPairingPayload = {
  v: 1,
  kind: "desktop",
  instanceId: "inst-1",
  addresses: ["192.168.1.5:7443", "10.0.0.5:7443"],
  certSha256: CERT,
  code: "482913",
};
const device = { deviceName: "Pixel", platform: "android" } as const;
const ok = (instanceId = "inst-1") => ({
  status: 200,
  body: JSON.stringify({ deviceId: "d1", token: "tok", instanceId, scopes: ["companion"] }),
});

describe("addresses", () => {
  it("desktop addresses become pinned https base urls", () => {
    expect(baseUrl("192.168.1.5:7443", "desktop")).toBe("https://192.168.1.5:7443");
  });
  it("never downgrades: http only for a server on a private address", () => {
    expect(baseUrl("http://192.168.1.9:3000", "server")).toBe("http://192.168.1.9:3000");
    expect(baseUrl("http://example.com", "server")).toBeNull();
    expect(baseUrl("http://192.168.1.9:3000", "desktop")).toBeNull();
    expect(baseUrl("https://user:pw@example.com", "server")).toBeNull();
    expect(baseUrl("ftp://example.com", "server")).toBeNull();
  });
  it("knows private hosts", () => {
    expect(["10.1.1.1", "172.16.0.1", "172.31.9.9", "192.168.0.1", "lifer.local", "fe80::1"].every(isPrivateHost)).toBe(
      true,
    );
    expect(["172.32.0.1", "8.8.8.8", "example.com", "fcbarcelona.com"].some(isPrivateHost)).toBe(false);
  });
});

describe("pairWithHub", () => {
  it("pairs, sending the pinned fingerprint and the code", async () => {
    const seen: Parameters<Transport>[0][] = [];
    const paired = await pairWithHub(desktop, device, async (r) => (seen.push(r), ok()));
    expect(paired.token).toBe("tok");
    expect(paired.hub.baseUrl).toBe("https://192.168.1.5:7443");
    expect(paired.hub.fallbackUrls).toEqual(["https://10.0.0.5:7443"]);
    expect(seen[0].certSha256).toBe(CERT);
    expect(JSON.parse(seen[0].body!)).toEqual({ code: "482913", ...device });
  });
  it("falls back to the next address when the first is unreachable", async () => {
    let n = 0;
    const paired = await pairWithHub(desktop, device, async () => {
      if (n++ === 0) throw new Error("timeout");
      return ok();
    });
    expect(paired.hub.baseUrl).toBe("https://10.0.0.5:7443");
  });
  it("fails closed on a wrong certificate", async () => {
    const t: Transport = async () => {
      throw Object.assign(new Error("pin"), { code: "CERT_MISMATCH" });
    };
    await expect(pairWithHub(desktop, device, t)).rejects.toMatchObject({ code: "cert_mismatch" });
  });
  it("refuses a hub with another instance id", async () => {
    await expect(pairWithHub(desktop, device, async () => ok("other"))).rejects.toMatchObject({ code: "wrong_hub" });
  });
  it("stops on a rejected code instead of trying more addresses", async () => {
    let calls = 0;
    const t: Transport = async () => (calls++, { status: 401, body: "{}" });
    await expect(pairWithHub(desktop, device, t)).rejects.toBeInstanceOf(PairError);
    expect(calls).toBe(1);
  });
  it("maps rate limiting and unreachable", async () => {
    await expect(pairWithHub(desktop, device, async () => ({ status: 429, body: "" }))).rejects.toMatchObject({
      code: "rate_limited",
    });
    await expect(
      pairWithHub(desktop, device, async () => {
        throw new Error("down");
      }),
    ).rejects.toMatchObject({ code: "unreachable" });
  });
  it("rejects a malformed reply", async () => {
    await expect(pairWithHub(desktop, device, async () => ({ status: 200, body: "{}" }))).rejects.toMatchObject({
      code: "wrong_hub",
    });
  });
});

describe("pairWithCode", () => {
  const random = (n: number) => new Uint8Array(randomBytes(n));
  const HUB: FoundHub = { host: "192.168.1.5", port: 4311, instanceId: "inst-1" };
  const MITM_CERT = "b".repeat(64);

  // A desktop running the real hub side of the key exchange (as the API does), reached through a
  // fake TLS layer: `seen` is the certificate the phone's session sees; `cert` is the one the hub holds.
  function hub(code: string, opts: { cert?: string; seen?: string } = {}) {
    const cert = opts.cert ?? CERT;
    const seen = opts.seen ?? cert;
    const requests: Parameters<Transport>[0][] = [];
    let expect: Uint8Array | null = null;
    const transport: Transport = async (req) => {
      requests.push(req);
      if (req.certSha256 && req.certSha256 !== seen) throw Object.assign(new Error("pin"), { code: "CERT_MISMATCH" });
      const body = JSON.parse(req.body!);
      if (req.url.endsWith("/pair/start")) {
        const answer = pakeAnswer(code, cert, body)!;
        expect = answer.expectTagA;
        return { status: 200, body: JSON.stringify({ session: "s".repeat(32), ...answer.reply }), certSha256: seen };
      }
      if (!expect || !equalBytes(new Uint8Array(Buffer.from(body.tagA, "hex")), expect))
        return { status: 401, body: "{}" };
      return ok();
    };
    return { transport, requests };
  }
  const deps = (transport: Transport, found: FoundHub[] = [HUB]) => ({
    transport,
    discover: async () => found,
    random,
  });

  it("pairs with only the digits and pins the certificate the hub proved", async () => {
    const h = hub("482913");
    const paired = await pairWithCode("482913", device, deps(h.transport));
    expect(paired.hub).toMatchObject({ kind: "desktop", certSha256: CERT, baseUrl: "https://192.168.1.5:4311" });
    expect(h.requests[0]).toMatchObject({ captureCert: true });
    expect(h.requests[0].certSha256).toBeUndefined();
    expect(h.requests[1]).toMatchObject({ certSha256: CERT });
    expect(h.requests.map((r) => r.body).join()).not.toContain("482913");
  });

  it("a wrong code goes no further than the first step", async () => {
    const h = hub("482913");
    await expect(pairWithCode("111111", device, deps(h.transport))).rejects.toMatchObject({ code: "code_invalid" });
    expect(h.requests).toHaveLength(1);
  });

  it("a man in the middle relaying to the real hub is refused and never sees the code", async () => {
    const h = hub("482913", { seen: MITM_CERT });
    await expect(pairWithCode("482913", device, deps(h.transport))).rejects.toMatchObject({ code: "code_invalid" });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].body).not.toContain("482913");
  });

  it("an impostor answering for itself fails, and the real Lifer after it still pairs", async () => {
    const impostor = hub("000000", { cert: MITM_CERT });
    const real = hub("482913");
    const transport: Transport = (req) => (req.url.includes("10.0.0.66") ? impostor : real).transport(req);
    const found = [{ ...HUB, host: "10.0.0.66" }, HUB];
    const paired = await pairWithCode("482913", device, deps(transport, found));
    expect(paired.hub.baseUrl).toBe("https://192.168.1.5:4311");
    expect(impostor.requests).toHaveLength(1);
  });

  it("says plainly when nothing is found, or the hub is busy", async () => {
    await expect(pairWithCode("482913", device, deps(hub("482913").transport, []))).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      pairWithCode(
        "482913",
        device,
        deps(async () => ({ status: 429, body: "" })),
      ),
    ).rejects.toMatchObject({
      code: "rate_limited",
    });
    await expect(
      pairWithCode(
        "482913",
        device,
        deps(async () => ({ status: 401, body: "" })),
      ),
    ).rejects.toMatchObject({
      code: "code_invalid",
    });
  });

  it("random bytes reach the key exchange", async () => {
    const used: number[] = [];
    const h = hub("482913");
    await pairWithCode("482913", device, { ...deps(h.transport), random: (n) => (used.push(n), random(n)) });
    expect(used.length).toBeGreaterThan(0);
  });
});

describe("discovery results", () => {
  it("keeps only private IPv4 hosts with a port and an id", () => {
    expect(
      toFoundHubs([
        { host: "192.168.1.5", port: 4311, id: "inst-1" },
        { host: "8.8.8.8", port: 4311, id: "x" },
        { host: "fe80::1", port: 4311, id: "x" },
        { host: "10.0.0.2", port: 0, id: "x" },
        { host: "10.0.0.3", port: 4311, id: "" },
        { host: "10.0.0.4", port: 4311, id: "y".repeat(65) },
        null,
      ]),
    ).toEqual([{ host: "192.168.1.5", port: 4311, instanceId: "inst-1" }]);
    expect(toFoundHubs("nope")).toEqual([]);
  });
});

describe("hub store", () => {
  const mem = (): SecureKv => {
    const m = new Map<string, string>();
    return {
      get: async (k) => m.get(k) ?? null,
      set: async (k, v) => void m.set(k, v),
      remove: async (k) => void m.delete(k),
    };
  };
  it("round trips and forgets", async () => {
    const kv = mem();
    const paired = await pairWithHub(desktop, device, async () => ok());
    await saveHub(kv, paired);
    expect(await loadHub(kv)).toEqual(paired);
    await forgetHub(kv);
    expect(await loadHub(kv)).toBeNull();
  });
  it("treats a corrupt entry as unpaired", async () => {
    const kv = mem();
    await kv.set("lifer.hub.v1", "{nope");
    expect(await loadHub(kv)).toBeNull();
  });
});
