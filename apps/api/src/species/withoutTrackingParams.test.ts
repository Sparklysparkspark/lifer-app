import { describe, expect, it } from "vitest";
import { withoutTrackingParams } from "./lazyEnrich.js";

describe("withoutTrackingParams", () => {
  it("drops the utm_ parameters Commons adds, so the fetch can hit Wikimedia's cache", () => {
    expect(
      withoutTrackingParams(
        "https://upload.wikimedia.org/wikipedia/commons/d/d2/Finny_scad.JPG?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=original",
      ),
    ).toBe("https://upload.wikimedia.org/wikipedia/commons/d/d2/Finny_scad.JPG");
  });

  it("keeps other parameters and leaves plain URLs alone", () => {
    expect(withoutTrackingParams("https://example.org/a.jpg?size=medium&utm_source=x")).toBe("https://example.org/a.jpg?size=medium");
    expect(withoutTrackingParams("https://inaturalist-open-data.s3.amazonaws.com/photos/1/medium.jpg")).toBe(
      "https://inaturalist-open-data.s3.amazonaws.com/photos/1/medium.jpg",
    );
    expect(withoutTrackingParams("not a url")).toBe("not a url");
  });
});
