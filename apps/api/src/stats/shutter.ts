// ShutterSpeed comes back as decimal seconds ("0.0005") or a fraction ("1/2000"); handle both.
export function parseShutterSeconds(raw: string): number | null {
  const fraction = raw.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (fraction) {
    const denominator = Number(fraction[2]);
    return denominator > 0 ? Number(fraction[1]) / denominator : null;
  }
  const plain = Number(raw);
  return Number.isFinite(plain) && plain > 0 ? plain : null;
}
