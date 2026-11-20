// Which names and XMP make a file a version, and of what.
import { describe, expect, it } from "vitest";
import { baseStem, classifyFile, versionLabel } from "./versionGrouping.js";

describe("version names and roles", () => {
  it("strips editor suffixes but not camera numbering", () => {
    expect(baseStem("/a/Moose/_M8A6162-2.jpg")).toBe("_m8a6162");
    expect(baseStem("_M8A6162-Edit-6.jpg")).toBe("_m8a6162");
    expect(baseStem("IMG_1-Enhanced-NR.dng")).toBe("img_1");
    expect(baseStem("pano-Pano_10x27.jpg")).toBe("pano");
    expect(baseStem("DSC_0001.JPG")).toBe("dsc_0001");
    expect(baseStem("C:\\Photos\\DSC_123.jpg")).toBe("dsc_123");
    expect(baseStem("IMG_1-BW.jpg")).toBe("img_1");
    expect(baseStem("IMG_1_bw.jpg")).toBe("img_1");
    expect(baseStem("IMG_1234bw.jpg")).toBe("img_1234");
    expect(baseStem("IMG_1 16x20.tif")).toBe("img_1");
    expect(baseStem("elbow.jpg")).toBe("elbow");
  });

  it("names versions from their names and folders", () => {
    expect(versionLabel("/a/Fox/IMG_1-BW.jpg", "export")).toEqual({ kind: "bw", size: null });
    expect(versionLabel("/a/Fox/Prints/IMG_1.jpg", "export")).toEqual({ kind: "print", size: null });
    expect(versionLabel("/a/Fox/IMG_1_10x27.jpg", "export")).toEqual({ kind: "print", size: "10x27" });
    expect(versionLabel("/a/Fox/IMG_1-Enhanced-NR.dng", "edit").kind).toBe("enhanced");
    expect(versionLabel("/a/Fox/IMG_1.CR3", null).kind).toBe("original");
    expect(classifyFile("IMG_1.jpg", {}, true).role).toBe("export");
  });

  it("reads roles from names and XMP lineage", () => {
    expect(classifyFile("IMG_1.CR3", {}).role).toBe("original");
    expect(classifyFile("IMG_1-2.jpg", {}).role).toBe("export");
    expect(classifyFile("IMG_1-Enhanced-NR.dng", {}).role).toBe("edit");
    const exported = classifyFile("IMG_1.jpg", {
      DocumentID: "xmp.did:aaaa1111bbbb2222",
      OriginalDocumentID: "CCCC3333DDDD4444",
    });
    expect(exported).toEqual({ role: "export", documentId: "cccc3333dddd4444" });
    expect(classifyFile("IMG_1.jpg", { Software: "Adobe Photoshop Lightroom Classic 13.0" }).role).toBe("export");
  });
});
