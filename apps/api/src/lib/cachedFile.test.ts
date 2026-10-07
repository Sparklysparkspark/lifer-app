import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { applyFileValidators, fileEtag, rangeStillValid, statFile } from "./cachedFile.js";

const dir = mkdtempSync(path.join(tmpdir(), "lifer-cached-"));
const file = path.join(dir, "a.bin");
writeFileSync(file, "hello");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeReply() {
  const headers: Record<string, unknown> = {};
  return { headers, reply: { header: (k: string, v: unknown) => (headers[k] = v) } as unknown as FastifyReply };
}
const req = (headers: Record<string, string>) => ({ headers }) as unknown as FastifyRequest;

describe("cachedFile", () => {
  it("stats files and returns null for a missing one", async () => {
    expect((await statFile(file))?.size).toBe(5);
    expect(await statFile(path.join(dir, "missing"))).toBeNull();
    expect(await statFile(dir)).toBeNull();
  });

  it("sets validators and matches If-None-Match, weak or strong", async () => {
    const st = (await statFile(file))!;
    const { headers, reply } = fakeReply();
    const strong = fileEtag(st, false);
    expect(applyFileValidators(req({}), reply, st, { weak: false }).notModified).toBe(false);
    expect(headers.ETag).toBe(strong);
    expect(headers["Last-Modified"]).toBe(st.mtime.toUTCString());
    expect(
      applyFileValidators(req({ "if-none-match": `"x", ${strong}` }), reply, st, { weak: false }).notModified,
    ).toBe(true);
    expect(applyFileValidators(req({ "if-none-match": `W/${strong}` }), reply, st, { weak: false }).notModified).toBe(
      true,
    );
    expect(applyFileValidators(req({ "if-none-match": `"other"` }), reply, st, { weak: false }).notModified).toBe(
      false,
    );
  });

  it("falls back to If-Modified-Since", async () => {
    const st = (await statFile(file))!;
    const { reply } = fakeReply();
    expect(
      applyFileValidators(req({ "if-modified-since": st.mtime.toUTCString() }), reply, st, { weak: true }).notModified,
    ).toBe(true);
    expect(
      applyFileValidators(req({ "if-modified-since": new Date(st.mtimeMs - 5000).toUTCString() }), reply, st, {
        weak: true,
      }).notModified,
    ).toBe(false);
  });

  it("honors a Range only while If-Range still matches", async () => {
    const st = (await statFile(file))!;
    const strong = fileEtag(st, false);
    expect(rangeStillValid(req({}), st, strong)).toBe(true);
    expect(rangeStillValid(req({ "if-range": strong }), st, strong)).toBe(true);
    expect(rangeStillValid(req({ "if-range": `"stale"` }), st, strong)).toBe(false);
    expect(rangeStillValid(req({ "if-range": st.mtime.toUTCString() }), st, strong)).toBe(true);
  });
});
