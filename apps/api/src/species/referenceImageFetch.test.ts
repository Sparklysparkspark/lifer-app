import { describe, expect, it } from "vitest";
import { isAllowedReferenceImageUrl, readBodyCapped } from "@lifer/core/species/lazyEnrich.js";

describe("isAllowedReferenceImageUrl", () => {
  it("allows the hosts reference photos come from", () => {
    expect(isAllowedReferenceImageUrl("https://inaturalist-open-data.s3.amazonaws.com/photos/1/medium.jpg")).toBe(true);
    expect(isAllowedReferenceImageUrl("https://static.inaturalist.org/photos/1/medium.jpg")).toBe(true);
    expect(isAllowedReferenceImageUrl("https://upload.wikimedia.org/wikipedia/commons/a/ab/x.jpg")).toBe(true);
    expect(isAllowedReferenceImageUrl("https://api.gbif.org/v1/image/x")).toBe(true);
  });

  it("rejects other hosts, lookalikes and non-http schemes", () => {
    expect(isAllowedReferenceImageUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isAllowedReferenceImageUrl("http://localhost:4000/api/admin")).toBe(false);
    expect(isAllowedReferenceImageUrl("https://evilinaturalist.org/x.jpg")).toBe(false);
    expect(isAllowedReferenceImageUrl("https://static.inaturalist.org.evil.com/x.jpg")).toBe(false);
    expect(isAllowedReferenceImageUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedReferenceImageUrl("not a url")).toBe(false);
  });
});

describe("readBodyCapped", () => {
  it("returns the body when under the cap", async () => {
    const buf = await readBodyCapped(new Response(new Uint8Array([1, 2, 3])), 10);
    expect([...buf]).toEqual([1, 2, 3]);
  });

  it("rejects a declared Content-Length over the cap", async () => {
    const res = new Response("abc", { headers: { "content-length": "999" } });
    await expect(readBodyCapped(res, 10)).rejects.toThrow(/too large/);
  });

  it("rejects a streamed body that runs past the cap", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(4));
        controller.close();
      },
    });
    await expect(readBodyCapped(new Response(stream), 10)).rejects.toThrow(/too large/);
  });
});
