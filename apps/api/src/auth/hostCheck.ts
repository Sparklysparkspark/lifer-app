// Host header allow-list for single-user (desktop) mode. See the onRequest hook in index.ts.
const LOOPBACK_NAMES = ["localhost", "127.0.0.1", "[::1]"];

export function isAllowedLocalHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  return LOOPBACK_NAMES.some((name) => h === `${name}:${port}` || (port === 80 && h === name));
}
