import { describe, expect, it, vi } from "vitest";
import { photoKey, publishableCount, topUpCandidates } from "./galleryTopUp.js";

const photo = (id: number, license: string | null, host = "inaturalist-open-data.s3.amazonaws.com") => ({
  medium_url: `https://${host}/photos/${id}/medium.jpg`,
  license_code: license,
  attribution: `(c) observer ${id}`,
});

describe("photoKey", () => {
  it("reads iNaturalist's photo id whatever the size or host", () => {
    expect(photoKey("https://static.inaturalist.org/photos/42/large.jpeg")).toBe("42");
    expect(photoKey("https://inaturalist-open-data.s3.amazonaws.com/photos/42/medium.png")).toBe("42");
  });
  it("keeps any other URL as it is", () => {
    expect(photoKey("https://upload.wikimedia.org/a/b.jpg")).toBe("https://upload.wikimedia.org/a/b.jpg");
  });
});

describe("publishableCount", () => {
  it("counts only photos the project may publish", () => {
    expect(
      publishableCount([
        { license: "cc-by-nc" },
        { license: "all-rights-reserved" },
        { license: null },
        { license: "cc0" },
      ]),
    ).toBe(2);
  });
});

describe("topUpCandidates", () => {
  it("drops unpublishable licences, the main photo, gallery photos and repeats, keeping order", () => {
    const picked = topUpCandidates(
      [
        photo(1, "cc-by"),
        photo(2, null),
        photo(3, "cc-by-nc"),
        photo(4, "CC-BY-SA"),
        photo(3, "cc-by-nc", "static.inaturalist.org"),
        photo(5, "cc0"),
      ],
      [
        "https://static.inaturalist.org/photos/1/large.jpg",
        "https://inaturalist-open-data.s3.amazonaws.com/photos/5/medium.jpeg",
        null,
      ],
    );
    expect(picked.map((p) => [photoKey(p.photoUrl), p.license])).toEqual([
      ["3", "cc-by-nc"],
      ["4", "cc-by-sa"],
    ]);
    expect(picked[0].credit).toBe("(c) observer 3");
  });
});

describe("topUpGalleryFromObservations", () => {
  it("adds observation photos until the gallery holds six, skipping ones it has", async () => {
    vi.resetModules();
    const persist = vi.fn();
    vi.doMock("../db.js", () => ({
      pool: {
        query: async () => ({
          rows: [
            {
              inat_taxon_id: 7,
              reference_photo: photo(1, "cc-by").medium_url,
              urls: [photo(2, "cc-by").medium_url],
              max_sort: 3,
            },
          ],
        }),
      },
    }));
    vi.doMock("./persistReference.js", () => ({ persistGalleryPromotingMainIfMissing: persist }));
    vi.doMock("./inatClient.js", async (orig) => ({
      ...(await orig<object>()),
      fetchObservationPhotos: async () => [1, 2, 3, 4, 5, 6, 7, 8, 9].map((id) => photo(id, "cc-by-nc")),
      downloadAndCacheImage: async (_url: string, key: string) => ({
        displayPath: `${key}.jpg`,
        thumbPath: `${key}-t.jpg`,
      }),
    }));
    const { topUpGalleryFromObservations } = await import("./galleryTopUp.js");
    expect(await topUpGalleryFromObservations("s1")).toBe(5);
    const [, added, hasMain] = persist.mock.calls[0];
    expect(added.map((p: { photoUrl: string }) => photoKey(p.photoUrl))).toEqual(["3", "4", "5", "6", "7"]);
    expect(added[0].sortOrder).toBe(4);
    expect(hasMain).toBe(true);
  });
});
