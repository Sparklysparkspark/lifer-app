import { requireNativeModule } from "expo-modules-core";
import type { Transport } from "./pair";

interface Native {
  request(opts: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
    certSha256: string | null;
    captureCert: boolean;
    timeoutMs: number;
  }): Promise<{ status: number; body: string; certSha256: string }>;
}

/**
 * Desktop: the native client refuses any certificate whose SHA-256 differs from certSha256, or with
 * captureCert accepts any and reports the one it saw (a typed pairing's first request only).
 */
export const nativeTransport: Transport = async (req) => {
  const native = requireNativeModule<Native>("PinnedFetch");
  const res = await native.request({
    ...req,
    body: req.body ?? null,
    certSha256: req.certSha256 ?? null,
    captureCert: req.captureCert ?? false,
  });
  return { status: res.status, body: res.body, ...(res.certSha256 ? { certSha256: res.certSha256 } : {}) };
};

/** Server on the system trust store: the platform fetch, with a timeout. */
export const systemTransport: Transport = async (req) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), req.timeoutMs);
  try {
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: ctl.signal });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
};

/** A pinned or captured certificate always goes through the native client, never the system trust store. */
export const transportFor: Transport = (req) =>
  req.certSha256 || req.captureCert ? nativeTransport(req) : systemTransport(req);
