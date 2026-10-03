// Mirrors isPrivateHost in apps/desktop/src/picker.js: addresses that only resolve on a local or
// private network, where plain http doesn't expose a password to the open internet.
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || (!host.includes(".") && !host.includes(":"))) return true;
  if (/\.(local|lan|home\.arpa|internal|localhost)$/.test(host)) return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (host.includes(":")) return host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  return false;
}

/** True when `raw` parses as a plain-http URL to a public host. Unparseable input is not flagged. */
export function isInsecurePublicUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" && !isPrivateHost(url.hostname);
  } catch {
    return false;
  }
}
