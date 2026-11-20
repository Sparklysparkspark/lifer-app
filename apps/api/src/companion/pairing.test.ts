import { beforeEach, describe, expect, it } from "vitest";
import { PAIRING_CODE_PATTERN, pakeConfirm, pakeHello } from "@lifer/shared";
import {
  COMPANION_CODE_TTL_MS,
  MAX_GUESSES,
  clearPairingCodes,
  finishPakeSession,
  mintPairingCode,
  startPakeSession,
  takePairingCode,
} from "./pairing.js";

const CERT = "c".repeat(64);
const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

describe("companion pairing codes", () => {
  beforeEach(clearPairingCodes);

  it("mints 6-digit codes, unique among live ones", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { code } = mintPairingCode(`u${i}`);
      expect(code).toMatch(new RegExp(PAIRING_CODE_PATTERN));
      seen.add(code);
    }
    expect(seen.size).toBe(50);
  });

  it("works once", () => {
    const { code } = mintPairingCode("u1");
    expect(takePairingCode(code)).toBe("u1");
    expect(takePairingCode(code)).toBeNull();
  });

  it("refuses an expired or unknown code", () => {
    const { code } = mintPairingCode("u1", undefined, 1_000);
    expect(takePairingCode(wrong(code), 1_000)).toBeNull();
    expect(takePairingCode(code, 1_000 + COMPANION_CODE_TTL_MS)).toBeNull();
  });

  it("a new code replaces the user's earlier one", () => {
    const first = mintPairingCode("u1").code;
    const second = mintPairingCode("u1").code;
    expect(takePairingCode(first)).toBeNull();
    expect(takePairingCode(second)).toBe("u1");
  });

  it("keeps different users' codes apart", () => {
    const a = mintPairingCode("a").code;
    const b = mintPairingCode("b").code;
    expect(takePairingCode(b)).toBe("b");
    expect(takePairingCode(a)).toBe("a");
  });

  it("burns every live code once the wrong guesses reach the cap", () => {
    const { code } = mintPairingCode("u1");
    for (let i = 0; i < MAX_GUESSES - 1; i++) expect(takePairingCode(wrong(code))).toBeNull();
    expect(takePairingCode(code)).toBe("u1");

    const next = mintPairingCode("u1").code;
    for (let i = 0; i < MAX_GUESSES; i++) takePairingCode(wrong(next));
    expect(takePairingCode(next)).toBeNull();
  });

  it("wrong guesses with no live code cost nothing", () => {
    for (let i = 0; i < MAX_GUESSES * 2; i++) takePairingCode("123456");
    const { code } = mintPairingCode("u1");
    for (let i = 0; i < MAX_GUESSES - 1; i++) takePairingCode(wrong(code));
    expect(takePairingCode(code)).toBe("u1");
  });
});

describe("typed pairing sessions", () => {
  beforeEach(clearPairingCodes);

  it("pairs a phone that holds the code, once", () => {
    const { code } = mintPairingCode("u1", CERT);
    const { hello, secret } = pakeHello(code);
    const started = startPakeSession(hello);
    if (typeof started === "string") throw new Error(started);
    const tagA = pakeConfirm(secret, CERT, started.reply)!;
    expect(finishPakeSession(started.session, tagA)).toBe("u1");
    expect(finishPakeSession(started.session, tagA)).toBeNull();
    expect(takePairingCode(code)).toBeNull();
  });

  it("only a code shown with a certificate takes part", () => {
    mintPairingCode("u1");
    expect(startPakeSession(pakeHello("123456").hello)).toBe("no_code");
  });

  it("caps runs per code, so guessing stays at a few in a million", () => {
    const { code } = mintPairingCode("u1", CERT);
    for (let i = 0; i < MAX_GUESSES; i++) expect(typeof startPakeSession(pakeHello(wrong(code)).hello)).toBe("object");
    expect(startPakeSession(pakeHello(code).hello)).toBe("no_code");
    expect(takePairingCode(code)).toBeNull();
  });

  it("wrong codes and key-exchange runs share one budget", () => {
    const { code } = mintPairingCode("u1", CERT);
    for (let i = 0; i < MAX_GUESSES - 1; i++) takePairingCode(wrong(code));
    expect(typeof startPakeSession(pakeHello(wrong(code)).hello)).toBe("object");
    expect(takePairingCode(code)).toBeNull();
  });

  it("a wrong tag ends the session without pairing", () => {
    const { code } = mintPairingCode("u1", CERT);
    const started = startPakeSession(pakeHello(code).hello);
    if (typeof started === "string") throw new Error(started);
    expect(finishPakeSession(started.session, "0".repeat(128))).toBeNull();
    expect(finishPakeSession(started.session, "0".repeat(128))).toBeNull();
  });

  it("a session dies with its code", () => {
    const { code } = mintPairingCode("u1", CERT);
    const { hello, secret } = pakeHello(code);
    const started = startPakeSession(hello);
    if (typeof started === "string") throw new Error(started);
    mintPairingCode("u1", CERT);
    expect(finishPakeSession(started.session, pakeConfirm(secret, CERT, started.reply)!)).toBeNull();
  });
});
