// Typed pairing with a computer: the phone and the hub prove to each other that they hold the same
// 6-digit code without sending it, and the hub's certificate fingerprint is bound into the proof.
//
// CPace (draft-irtf-cfrg-cpace-21) with ristretto255 and SHA-512, initiator (phone) and responder
// (hub), plus the draft's explicit key confirmation (section 10.4). The phone's ADa is empty; ADb is
// the hub's certificate SHA-256: the hub uses its own, the phone the one its TLS session saw, so a
// man in the middle with another certificate fails the hub's tag. Each run gives an attacker one
// guess at the code and nothing to test guesses offline; the hub caps runs per code (pairing.ts).
// Built on @noble/curves and @noble/hashes so it runs the same in Node and Hermes.
import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const Point = ristretto255.Point;
type RistrettoPoint = InstanceType<typeof Point>;
type Random = (n: number) => Uint8Array;

const DSI = utf8ToBytes("CPaceRistretto255");
const DSI_ISK = utf8ToBytes("CPaceRistretto255_ISK");
const MAC_LABEL = utf8ToBytes("CPaceMac");
const CI = utf8ToBytes("lifer-companion-pair-v1");
const SHA512_BLOCK = 128;
const SID_BYTES = 16;

const HEX = (bytes: number) => new RegExp(`^[0-9a-f]{${bytes * 2}}$`);
const SID_HEX = HEX(SID_BYTES);
const POINT_HEX = HEX(32);
const TAG_HEX = HEX(64);
const CERT_HEX = HEX(32);

/** The phone's first message. */
export interface PakeHello {
  sid: string;
  ya: string;
}
/** The hub's answer: its share and its proof that it knows the code and holds the certificate. */
export interface PakeReply {
  yb: string;
  tagB: string;
}

function leb128(n: number): Uint8Array {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Uint8Array.from(out);
}

const prependLen = (b: Uint8Array) => concatBytes(leb128(b.length), b);
const lvCat = (...parts: Uint8Array[]) => concatBytes(...parts.map(prependLen));

function generator(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): RistrettoPoint {
  const zpad = Math.max(0, SHA512_BLOCK - prependLen(prs).length - prependLen(DSI).length - 1);
  return ristretto255_hasher.deriveToCurve!(sha512(lvCat(DSI, prs, new Uint8Array(zpad), ci, sid)));
}

// The draft's recommended sampling: 32 random bytes with the bits above 252 cleared, little endian.
function sampleScalar(random: Random): bigint {
  for (;;) {
    const b = random(32);
    b[31] &= 0x0f;
    let y = 0n;
    for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]);
    if (y !== 0n) return y;
  }
}

/** y times the decoded point, or null for an invalid encoding or the identity (the draft's abort). */
function scalarMultVfy(y: bigint, encoded: Uint8Array): Uint8Array | null {
  let p: RistrettoPoint;
  try {
    p = Point.fromBytes(encoded);
  } catch {
    return null;
  }
  const k = p.multiply(y);
  return k.is0() ? null : k.toBytes();
}

const NONE = new Uint8Array(0);

function sessionKey(sid: Uint8Array, k: Uint8Array, ya: Uint8Array, ada: Uint8Array, yb: Uint8Array, adb: Uint8Array) {
  const transcript = concatBytes(lvCat(ya, ada), lvCat(yb, adb));
  return sha512(concatBytes(lvCat(DSI_ISK, sid, k), transcript));
}

function tags(sid: Uint8Array, isk: Uint8Array, ya: Uint8Array, yb: Uint8Array, adb: Uint8Array) {
  const macKey = sha512(concatBytes(MAC_LABEL, sid, isk));
  return {
    tagA: hmac(sha512, macKey, lvCat(ya, NONE)),
    tagB: hmac(sha512, macKey, lvCat(yb, adb)),
  };
}

/** Constant time, so a wrong tag doesn't leak how much of it was right. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export interface PakePhoneSecret {
  code: string;
  sid: Uint8Array;
  y: bigint;
  ya: Uint8Array;
}

/** Phone, step 1: the hello to send. Keep the secret for pakeConfirm. */
export function pakeHello(code: string, random: Random = randomBytes): { hello: PakeHello; secret: PakePhoneSecret } {
  const sid = random(SID_BYTES).slice(0, SID_BYTES);
  const y = sampleScalar(random);
  const ya = generator(utf8ToBytes(code), CI, sid).multiply(y).toBytes();
  return { hello: { sid: bytesToHex(sid), ya: bytesToHex(ya) }, secret: { code, sid, y, ya } };
}

/**
 * Hub: the answer to a phone's hello, and the tag the phone must send back to prove the code.
 * Null for a malformed hello.
 */
export function pakeAnswer(
  code: string,
  certSha256: string,
  hello: PakeHello,
  random: Random = randomBytes,
): { reply: PakeReply; expectTagA: Uint8Array } | null {
  if (!SID_HEX.test(hello.sid) || !POINT_HEX.test(hello.ya) || !CERT_HEX.test(certSha256)) return null;
  const sid = hexToBytes(hello.sid);
  const ya = hexToBytes(hello.ya);
  const y = sampleScalar(random);
  const yb = generator(utf8ToBytes(code), CI, sid).multiply(y).toBytes();
  const k = scalarMultVfy(y, ya);
  if (!k) return null;
  const adb = hexToBytes(certSha256);
  const { tagA, tagB } = tags(sid, sessionKey(sid, k, ya, NONE, yb, adb), ya, yb, adb);
  return { reply: { yb: bytesToHex(yb), tagB: bytesToHex(tagB) }, expectTagA: tagA };
}

/**
 * Phone, step 2: checks the hub's tag against the certificate this phone's TLS session saw. The
 * tag to send back, or null when the hub didn't prove the code for that certificate (a wrong code
 * or a man in the middle; the phone can't tell which and must not continue either way).
 */
export function pakeConfirm(secret: PakePhoneSecret, seenCertSha256: string, reply: PakeReply): string | null {
  if (!POINT_HEX.test(reply.yb) || !TAG_HEX.test(reply.tagB) || !CERT_HEX.test(seenCertSha256)) return null;
  const yb = hexToBytes(reply.yb);
  const k = scalarMultVfy(secret.y, yb);
  if (!k) return null;
  const adb = hexToBytes(seenCertSha256);
  const { tagA, tagB } = tags(secret.sid, sessionKey(secret.sid, k, secret.ya, NONE, yb, adb), secret.ya, yb, adb);
  return equalBytes(tagB, hexToBytes(reply.tagB)) ? bytesToHex(tagA) : null;
}

export const PAKE_TAG_PATTERN = TAG_HEX.source;
export const PAKE_SID_PATTERN = SID_HEX.source;
export const PAKE_POINT_PATTERN = POINT_HEX.source;

// The curve's own point class can't appear in an exported type, so the test vectors see this shape.
interface VectorPoint {
  toBytes(): Uint8Array;
  multiply(n: bigint): VectorPoint;
}

/** For the draft's test vectors only. */
export const cpaceInternals = {
  generator: generator as (prs: Uint8Array, ci: Uint8Array, sid: Uint8Array) => VectorPoint,
  lvCat,
  scalarMultVfy,
  sessionKey,
  prependLen,
};
