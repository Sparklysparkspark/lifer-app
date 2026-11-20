// Pairing state without a database: expiry, single-use codes, the shared guessing budget, and
// tickets that only the newest launch can clear.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PAIR_CODE_TTL_MS,
  PAIR_REQUEST_TTL_MS,
  clearHostTicket,
  createPairCode,
  createPairRequest,
  pendingPairRequests,
  resetPairingState,
  setHostTicket,
  takeHostTicket,
  takePairCode,
} from "./pairing.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("pairing state", () => {
  beforeEach(() => resetPairingState());
  afterEach(() => vi.useRealTimers());

  it("expires a request nobody answers", async () => {
    vi.useFakeTimers();
    const r = createPairRequest({ userId: "u", pluginId: "a.b", name: "A", scopes: ["userdata.read"], code: "123456" });
    expect(pendingPairRequests("u")).toHaveLength(1);
    expect(pendingPairRequests("someone else")).toHaveLength(0);
    vi.advanceTimersByTime(PAIR_REQUEST_TTL_MS);
    expect(await r.done).toEqual({ status: "expired" });
    expect(pendingPairRequests("u")).toHaveLength(0);
  });

  it("takes a code once, and not after it expires", () => {
    vi.useFakeTimers();
    const { code } = createPairCode("u");
    expect(takePairCode(code)).toBe("u");
    expect(takePairCode(code)).toBeNull();
    const late = createPairCode("u").code;
    vi.advanceTimersByTime(PAIR_CODE_TTL_MS);
    expect(takePairCode(late)).toBeNull();
  });

  it("drops every live code after too many wrong ones, from any address", () => {
    const { code } = createPairCode("u");
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 10; i++) expect(takePairCode(wrong)).toBeNull();
    expect(takePairCode(code)).toBeNull();
  });

  it("keeps only the newest launch's ticket, and a stale clear can't remove it", async () => {
    setHostTicket("a.b", sha("old"), { name: "A", scopes: ["userdata.read"] });
    setHostTicket("a.b", sha("new"), { name: "A", scopes: ["userdata.read"] });
    clearHostTicket("a.b", sha("old"));
    vi.useFakeTimers();
    const old = takeHostTicket("a.b", "old");
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await old).toBeNull();
    vi.useRealTimers();
    const taken = await takeHostTicket("a.b", "new");
    expect(taken?.entry).toEqual({ name: "A", scopes: ["userdata.read"] });
    // In use until restored.
    vi.useFakeTimers();
    const meanwhile = takeHostTicket("a.b", "new");
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await meanwhile).toBeNull();
    vi.useRealTimers();
    taken!.restore();
    expect(await takeHostTicket("a.b", "new")).not.toBeNull();
  });
});
