import { describe, expect, it } from "vitest";
import { cpaceInternals, pakeAnswer, pakeConfirm, pakeHello, type PakeHello } from "@lifer/shared";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const { generator, lvCat, scalarMultVfy, sessionKey } = cpaceInternals;
const HUB_CERT = "a".repeat(64);
const MITM_CERT = "b".repeat(64);

// draft-irtf-cfrg-cpace-21, appendix B.3 (ristretto255, SHA-512).
describe("CPace test vectors", () => {
  const sid = hexToBytes("7e4b4791d6a8ef019b936c79fb7f2c57");
  const ci = lvCat(utf8ToBytes("A_initiator"), utf8ToBytes("B_responder"));
  const le = (hex: string) => BigInt("0x" + bytesToHex(hexToBytes(hex).reverse()));
  const ya = le("da3d23700a9e5699258aef94dc060dfda5ebb61f02a5ea77fad53f4ff0976d08");
  const yb = le("d2316b454718c35362d83d69df6320f38578ed5984651435e2949762d900b80d");

  it("matches the generator, shares, K and ISK", () => {
    const g = generator(utf8ToBytes("Password"), ci, sid);
    expect(bytesToHex(g.toBytes())).toBe("222b6b195fe84b1652badb6f6a3ae3d24341e7306967f0b8115b40d5698c7e56");
    const Ya = g.multiply(ya).toBytes();
    const Yb = g.multiply(yb).toBytes();
    expect(bytesToHex(Ya)).toBe("d6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b9157");
    expect(bytesToHex(Yb)).toBe("3ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f7258");
    const K = scalarMultVfy(ya, Yb)!;
    expect(bytesToHex(K)).toBe("80b69a8a76457ab6a4d7f887a4bf6b55a2f80ac19c333f917a05fc9887c8b40f");
    expect(bytesToHex(scalarMultVfy(yb, Ya)!)).toBe(bytesToHex(K));
    const transcript = new Uint8Array([...lvCat(Ya, utf8ToBytes("ADa")), ...lvCat(Yb, utf8ToBytes("ADb"))]);
    expect(bytesToHex(transcript)).toBe(
      "20d6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b915703414461203ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f725803414462",
    );
    expect(bytesToHex(sessionKey(sid, K, Ya, utf8ToBytes("ADa"), Yb, utf8ToBytes("ADb")))).toBe(
      "b69effbf61b51d56401c0f65601abe428de8206feaaf0e32198896dcae7b35cd2b38950a39dfd5d4a79164614c2984f7daa460b588c1e80c3fa2068af7900447",
    );
  });

  it("aborts on the identity and on invalid encodings", () => {
    expect(scalarMultVfy(ya, new Uint8Array(32))).toBeNull();
    expect(scalarMultVfy(ya, new Uint8Array(32).fill(0xff))).toBeNull();
  });
});

describe("pairing key exchange", () => {
  it("pairs when both hold the code and the phone saw the hub's certificate", () => {
    const { hello, secret } = pakeHello("482913");
    const hub = pakeAnswer("482913", HUB_CERT, hello)!;
    const tagA = pakeConfirm(secret, HUB_CERT, hub.reply);
    expect(tagA).toBe(bytesToHex(hub.expectTagA));
  });

  it("fails closed on a wrong code, either side", () => {
    const { hello, secret } = pakeHello("482913");
    expect(pakeConfirm(secret, HUB_CERT, pakeAnswer("482914", HUB_CERT, hello)!.reply)).toBeNull();
  });

  it("a man in the middle with its own certificate is refused and never learns the code", () => {
    // The attacker relays the phone's hello to the real hub; the phone's TLS session saw MITM_CERT.
    const { hello, secret } = pakeHello("482913");
    const real = pakeAnswer("482913", HUB_CERT, hello)!;
    expect(pakeConfirm(secret, MITM_CERT, real.reply)).toBeNull();
    // Nor can it answer itself with a guessed code bound to its own certificate.
    expect(pakeConfirm(secret, MITM_CERT, pakeAnswer("000000", MITM_CERT, hello)!.reply)).toBeNull();
    // Nothing on the wire carries the code.
    const wire = JSON.stringify([hello, real.reply]);
    expect(wire).not.toContain("482913");
  });

  it("refuses malformed or hostile messages", () => {
    const { hello, secret } = pakeHello("482913");
    const zero = "0".repeat(64);
    expect(pakeAnswer("482913", HUB_CERT, { ...hello, ya: zero })).toBeNull();
    expect(pakeAnswer("482913", HUB_CERT, { ...hello, sid: "zz" } as PakeHello)).toBeNull();
    expect(pakeAnswer("482913", "nope", hello)).toBeNull();
    expect(pakeConfirm(secret, HUB_CERT, { yb: zero, tagB: "0".repeat(128) })).toBeNull();
    expect(pakeConfirm(secret, HUB_CERT, { yb: "x", tagB: "y" })).toBeNull();
  });

  it("uses a fresh session and share each time", () => {
    const a = pakeHello("482913").hello;
    const b = pakeHello("482913").hello;
    expect(a.sid).not.toBe(b.sid);
    expect(a.ya).not.toBe(b.ya);
  });
});
