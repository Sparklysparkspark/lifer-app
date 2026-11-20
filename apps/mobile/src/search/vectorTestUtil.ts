// Test helpers: what the hub sends (float16 as base64) and a unit vector from a few weights.
export function toHalf(x: number): number {
  const f = new Float32Array([x]);
  const b = new Uint32Array(f.buffer)[0];
  const sign = (b >>> 16) & 0x8000;
  const exp = ((b >>> 23) & 255) - 127 + 15;
  const man = b & 0x7fffff;
  if (exp <= 0) return exp < -10 ? sign : sign | ((man | 0x800000) >> (14 - exp));
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | (man >> 13);
}

export function encodeVector(v: ArrayLike<number>): string {
  const bytes = new Uint8Array(v.length * 2);
  for (let i = 0; i < v.length; i++) {
    const h = toHalf(v[i]);
    bytes[2 * i] = h & 255;
    bytes[2 * i + 1] = h >> 8;
  }
  return Buffer.from(bytes).toString("base64");
}

/** A unit vector of 768 numbers from `weights` on the first axes. */
export function unit(weights: number[]): Float32Array {
  const v = new Float32Array(768);
  weights.forEach((w, i) => (v[i] = w));
  const n = Math.hypot(...weights) || 1;
  return v.map((x) => x / n);
}

/** A stored vector for a screen test: unit length, weights on the first axes. */
export const encodeVectorForTest = (weights: number[]): string => encodeVector(unit(weights));
