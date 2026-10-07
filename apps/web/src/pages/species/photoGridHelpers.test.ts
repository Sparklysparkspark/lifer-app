import { describe, expect, it } from "vitest";
import {
  captureCounts,
  deleteNoun,
  locationText,
  matchesFilter,
  photosSectionTitle,
  sortCaptures,
} from "./photoGridHelpers";
import type { SpeciesCapture } from "./types";

function capture(id: string, partial: Partial<SpeciesCapture> = {}): SpeciesCapture {
  return {
    id,
    photo_id: `p-${id}`,
    width: null,
    height: null,
    taken_at: null,
    camera_model: null,
    lens: null,
    focal_length_mm: null,
    aperture: null,
    shutter: null,
    iso: null,
    quality_rating: null,
    tags: [],
    photo_kind: "image",
    duration_seconds: null,
    original_ref: null,
    original_managed: null,
    original_kind: "jpeg",
    original_available: null,
    original_volume_label: null,
    has_raw_original: false,
    raw_ref: null,
    region_id: null,
    region_name: null,
    location_label: null,
    ...partial,
  };
}

const ids = (list: SpeciesCapture[]) => list.map((c) => c.id);

describe("sortCaptures", () => {
  const captures = [
    capture("mid", { taken_at: "2022-06-01T12:00:00Z", quality_rating: 3 }),
    capture("undated", { quality_rating: null }),
    capture("old", { taken_at: "2020-06-01T12:00:00Z", quality_rating: 1 }),
    capture("new", { taken_at: "2024-06-01T12:00:00Z", quality_rating: 5 }),
  ];

  it("keeps the server's order, and the same array, for newest", () => {
    expect(sortCaptures(captures, "newest")).toBe(captures);
  });

  it("sorts oldest first, undated first of all", () => {
    expect(ids(sortCaptures(captures, "oldest"))).toEqual(["undated", "old", "mid", "new"]);
  });

  it("sorts by rating with unrated below a 1-star", () => {
    expect(ids(sortCaptures(captures, "rating"))).toEqual(["new", "mid", "old", "undated"]);
  });
});

describe("matchesFilter", () => {
  it("sorts each capture into edited, RAW or video", () => {
    const edited = capture("e");
    const raw = capture("r", { original_kind: "raw" });
    const video = capture("v", { photo_kind: "video", original_kind: "raw" });
    expect(matchesFilter(edited, "edited")).toBe(true);
    expect(matchesFilter(raw, "edited")).toBe(false);
    expect(matchesFilter(raw, "raw")).toBe(true);
    expect(matchesFilter(video, "raw")).toBe(false);
    expect(matchesFilter(video, "video")).toBe(true);
    for (const c of [edited, raw, video]) expect(matchesFilter(c, "all")).toBe(true);
  });
});

describe("locationText", () => {
  it("joins the place name and the region", () => {
    expect(locationText(capture("a", { location_label: "Prince George", region_name: "British Columbia" }))).toBe(
      "Prince George, British Columbia",
    );
  });

  it("uses whichever half is set, or nothing", () => {
    expect(locationText(capture("a", { location_label: "Backyard" }))).toBe("Backyard");
    expect(locationText(capture("a", { region_name: "Yukon" }))).toBe("Yukon");
    expect(locationText(capture("a"))).toBeNull();
  });
});

describe("captureCounts", () => {
  it("counts edited, RAW and video, skipping captures without a photo", () => {
    expect(
      captureCounts([
        capture("e1"),
        capture("e2"),
        capture("r", { original_kind: "raw" }),
        capture("v", { photo_kind: "video", photo_id: null }),
        capture("none", { photo_id: null }),
      ]),
    ).toEqual({ edited: 2, raw: 1, video: 1 });
  });
});

describe("photosSectionTitle", () => {
  const photosOnly = { edited: 2, raw: 1, video: 0 };
  const videosOnly = { edited: 0, raw: 0, video: 2 };
  const both = { edited: 1, raw: 0, video: 1 };

  it("names what the filter shows", () => {
    expect(photosSectionTitle("video", both)).toBe("Your videos");
    expect(photosSectionTitle("raw", both)).toBe("Your photos");
    expect(photosSectionTitle("edited", videosOnly)).toBe("Your photos");
  });

  it("names what the species has under All", () => {
    expect(photosSectionTitle("all", both)).toBe("Your photos and videos");
    expect(photosSectionTitle("all", videosOnly)).toBe("Your videos");
    expect(photosSectionTitle("all", photosOnly)).toBe("Your photos");
    expect(photosSectionTitle("all", { edited: 0, raw: 0, video: 0 })).toBe("Your photos");
  });
});

describe("deleteNoun", () => {
  it("names the selection by what's in it", () => {
    const video = capture("v", { photo_kind: "video" });
    expect(deleteNoun([capture("a")])).toBe("photo");
    expect(deleteNoun([video])).toBe("video");
    expect(deleteNoun([video, capture("a")])).toBe("file");
    expect(deleteNoun([])).toBe("photo");
  });
});
