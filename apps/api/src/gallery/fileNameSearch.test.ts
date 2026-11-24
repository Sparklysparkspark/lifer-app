import { describe, expect, it } from "vitest";
import { fileNameQuery } from "./fileNameSearch.js";

describe("fileNameQuery", () => {
  it("reads file names and camera-style stems, lowercased", () => {
    expect(fileNameQuery(" 6F9A8042.CR3 ")).toBe("6f9a8042.cr3");
    expect(fileNameQuery("IMG_1234")).toBe("img_1234");
    expect(fileNameQuery("6F9A804")).toBe("6f9a804");
    expect(fileNameQuery("20240512_1234.jpg")).toBe("20240512_1234.jpg");
  });

  it("leaves words, years and phrases to the normal search", () => {
    for (const q of ["owl", "2024", "bird in flight", "6F9", "b&w", "f2.8"]) expect(fileNameQuery(q)).toBeNull();
  });
});
