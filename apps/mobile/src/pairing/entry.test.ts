import { describe, expect, it } from "vitest";
import { normalizeCode, typedPairing } from "./entry";
import { pairWithHub } from "../connection/pair";

describe("typed pairing", () => {
  it("normalizes the code", () => {
    expect(normalizeCode(" 482-913 ")).toBe("482913");
    expect(normalizeCode("482 913")).toBe("482913");
  });
  it("a computer needs only the 6 digits", () => {
    expect(typedPairing("482 913", "")).toEqual({ kind: "computer", code: "482913" });
  });
  it("a server adds its address, HTTPS unless it says otherwise", () => {
    expect(typedPairing("482913", "lifer.example.com")).toMatchObject({
      kind: "server",
      payload: { kind: "server", addresses: ["https://lifer.example.com"], code: "482913", instanceId: "" },
    });
    expect(typedPairing("482913", "http://192.168.1.9:3000")).toMatchObject({
      payload: { addresses: ["http://192.168.1.9:3000"] },
    });
  });
  it("rejects anything but 6 digits", () => {
    for (const bad of ["48291", "4829134", "48291a", "ABCDEFGH", ""]) expect(typedPairing(bad, "")).toBeNull();
    expect(typedPairing("482913", "x".repeat(201))).toBeNull();
  });
  it("a typed server pairs without an instance id to compare", async () => {
    const typed = typedPairing("482913", "http://192.168.1.9:3000");
    if (typed?.kind !== "server") throw new Error("expected a server");
    const paired = await pairWithHub(typed.payload, { deviceName: "P", platform: "android" }, async () => ({
      status: 200,
      body: JSON.stringify({ deviceId: "d", token: "t", instanceId: "real", scopes: [] }),
    }));
    expect(paired.hub.instanceId).toBe("real");
  });
});
