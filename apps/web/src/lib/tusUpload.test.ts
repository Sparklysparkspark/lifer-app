import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  INITIAL_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  nextChunkSize,
  shrinkChunkSize,
  uploadIdFromUrl,
} from "./tusUpload";

describe("chunk size adaptation", () => {
  it("halves from 8 MB down to the 256 KB floor, then stops", () => {
    const sizes: number[] = [];
    let size: number | null = INITIAL_CHUNK_SIZE;
    while (size != null) {
      sizes.push(size);
      size = shrinkChunkSize(size);
    }
    expect(sizes.map((s) => s / 1024)).toEqual([8192, 4096, 2048, 1024, 512, 256]);
    expect(shrinkChunkSize(MIN_CHUNK_SIZE)).toBeNull();
  });

  it("never goes below the floor from an odd size", () => {
    expect(shrinkChunkSize(MIN_CHUNK_SIZE + 10)).toBe(MIN_CHUNK_SIZE);
  });

  it("jumps straight to a smaller size another upload already found", () => {
    expect(nextChunkSize(INITIAL_CHUNK_SIZE, 1024 * 1024)).toBe(1024 * 1024);
    expect(nextChunkSize(INITIAL_CHUNK_SIZE, INITIAL_CHUNK_SIZE)).toBe(INITIAL_CHUNK_SIZE / 2);
    expect(nextChunkSize(MIN_CHUNK_SIZE, MIN_CHUNK_SIZE)).toBeNull();
  });
});

describe("classifyFailure", () => {
  it("shrinks on a proxy's 413 to a chunk, or a dropped connection mid-chunk", () => {
    expect(classifyFailure("PATCH", 413, true)).toBe("shrink");
    expect(classifyFailure("PATCH", null, true)).toBe("shrink");
  });

  it("doesn't shrink while offline", () => {
    expect(classifyFailure("PATCH", null, false)).toBe("fatal");
  });

  it("reports a 413 on creation as the file being over the server's cap", () => {
    expect(classifyFailure("POST", 413, true)).toBe("too-large");
  });

  it("starts over when the server lost the upload", () => {
    expect(classifyFailure("PATCH", 404, true)).toBe("restart");
    expect(classifyFailure("PATCH", 410, true)).toBe("restart");
    expect(classifyFailure("HEAD", 410, true)).toBe("restart");
  });

  it("gives up on anything else", () => {
    expect(classifyFailure("POST", 500, true)).toBe("fatal");
    expect(classifyFailure("PATCH", 403, true)).toBe("fatal");
  });
});

describe("uploadIdFromUrl", () => {
  it("takes the last path segment of a relative or absolute Location", () => {
    const id = "0b5d7c1e-8a41-4a3f-9d62-1f2e3a4b5c6d_0123456789abcdef0123456789abcdef";
    expect(uploadIdFromUrl(`/api/uploads/tus/${id}`)).toBe(id);
    expect(uploadIdFromUrl(`https://lifer.example/api/uploads/tus/${id}/`)).toBe(id);
    expect(uploadIdFromUrl(`/api/uploads/tus/${id}?x=1`)).toBe(id);
  });
});
