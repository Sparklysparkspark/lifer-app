import { describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import { trustProxyHint } from "./trustProxyHint.js";

const req = (headers: Record<string, string>) =>
  ({ headers, socket: { remoteAddress: "172.18.0.3" } }) as unknown as FastifyRequest;

describe("trustProxyHint", () => {
  it("warns once when proxied requests arrive and TRUST_PROXY is unset", async () => {
    const log = { warn: vi.fn() } as unknown as FastifyBaseLogger;
    const hint = trustProxyHint(log, undefined);
    await hint(req({}));
    expect(log.warn).not.toHaveBeenCalled();
    await hint(req({ "x-forwarded-for": "203.0.113.9" }));
    await hint(req({ "x-forwarded-for": "203.0.113.10" }));
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.warn).mock.calls[0][0]).toMatch(/TRUST_PROXY/);
  });

  it("stays quiet once TRUST_PROXY is set", async () => {
    const log = { warn: vi.fn() } as unknown as FastifyBaseLogger;
    await trustProxyHint(log, "192.168.1.5")(req({ "x-forwarded-for": "203.0.113.9" }));
    expect(log.warn).not.toHaveBeenCalled();
  });
});
