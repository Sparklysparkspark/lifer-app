import { describe, expect, it } from "vitest";
import { safeFilename } from "./downloadFile";

describe("safeFilename", () => {
  it("keeps only the last path segment", () => {
    expect(safeFilename("../../x.jpg", "f.jpg")).toBe("x.jpg");
    expect(safeFilename("..\\..\\x.jpg", "f.jpg")).toBe("x.jpg");
    expect(safeFilename("/etc/passwd", "f.jpg")).toBe("passwd");
    expect(safeFilename("bird.jpg", "f.jpg")).toBe("bird.jpg");
  });

  it("falls back for empty, dot and dot-dot names", () => {
    for (const name of [undefined, "", " ", ".", "..", "a/..", "dir/"])
      expect(safeFilename(name, "f.jpg")).toBe("f.jpg");
    expect(safeFilename("..", "../")).toBe("download");
  });
});
