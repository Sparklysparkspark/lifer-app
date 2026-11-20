import { describe, expect, it } from "vitest";
import { encodePairingPayload, parsePairingPayload, type CompanionPairingPayload } from "@lifer/shared";

const desktop: CompanionPairingPayload = {
  v: 1,
  kind: "desktop",
  instanceId: "abc",
  addresses: ["192.168.1.5:4311"],
  certSha256: "a".repeat(64),
  code: "482913",
};

describe("pairing payload", () => {
  it("round trips for a desktop and a server", () => {
    expect(parsePairingPayload(encodePairingPayload(desktop))).toEqual(desktop);
    const server: CompanionPairingPayload = { ...desktop, kind: "server", certSha256: undefined };
    expect(parsePairingPayload(encodePairingPayload(server))).toEqual({ ...server });
  });

  it("refuses anything malformed", () => {
    const bad = (o: object) => parsePairingPayload(JSON.stringify({ ...desktop, ...o }));
    expect(parsePairingPayload("not json")).toBeNull();
    expect(bad({ v: 2 })).toBeNull();
    expect(bad({ code: "48291a" })).toBeNull();
    expect(bad({ code: "48291" })).toBeNull();
    expect(bad({ addresses: [] })).toBeNull();
    expect(bad({ certSha256: "xyz" })).toBeNull();
    expect(bad({ kind: "server" })).toBeNull();
  });
});
