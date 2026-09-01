import { describe, expect, it } from "vitest";
import { toCollectionItem, type CollectionRow } from "./collectionItem.js";
import { MEDIA_CACHE_BUST } from "../config.js";

function baseRow(overrides: Partial<CollectionRow> = {}): CollectionRow {
  return {
    species_id: "s1",
    scientific_name: "Anas platyrhynchos",
    common_name: "Mallard",
    reference_photo: "https://example.com/photo.jpg",
    reference_credit: "Jane Doe",
    tier: "common",
    state: null,
    cover_photo_id: null,
    card_crop_x: null,
    card_crop_y: null,
    card_crop_size: null,
    has_cover_photo: false,
    ...overrides,
  };
}

describe("toCollectionItem", () => {
  it("defaults a null state to unseen", () => {
    expect(toCollectionItem(baseRow({ state: null })).state).toBe("unseen");
  });

  it("passes through a real state unchanged", () => {
    expect(toCollectionItem(baseRow({ state: "seen" })).state).toBe("seen");
  });

  it("falls back to the external reference_photo when nothing is cached", () => {
    const item = toCollectionItem(baseRow({ has_cover_photo: false, has_reference_thumb: false }));
    expect(item.coverPhotoUrl).toBe("https://example.com/photo.jpg");
    expect(item.coverPhotoCredit).toBe("Jane Doe");
  });

  it("prefers the cached local reference thumb over the raw external URL", () => {
    const item = toCollectionItem(baseRow({ has_cover_photo: false, has_reference_thumb: true }));
    expect(item.coverPhotoUrl).toBe(`/api/species/s1/reference-photo/thumb?v=${MEDIA_CACHE_BUST}`);
  });

  it("prefers the user's own cover photo over any reference photo, only when state is collected", () => {
    const item = toCollectionItem(
      baseRow({ state: "collected", has_cover_photo: true, cover_photo_id: "p1", has_reference_thumb: true }),
    );
    expect(item.coverPhotoUrl).toBe("/api/photos/p1/thumb");
    expect(item.coverPhotoCredit).toBeNull();
  });

  // Boundary: has_cover_photo alone isn't enough — a "seen" (not "collected") row with a
  // cover_photo_id set shouldn't happen in practice, but if it did, this must not show it as
  // an owned cover (hasOwnCover requires state === "collected" too).
  it("does not treat a cover photo as owned when state isn't collected", () => {
    const item = toCollectionItem(
      baseRow({ state: "seen", has_cover_photo: true, cover_photo_id: "p1", reference_photo: "https://x/y.jpg" }),
    );
    expect(item.coverPhotoUrl).toBe("https://x/y.jpg");
  });

  it("only applies card crop fields when the cover photo is the user's own", () => {
    const own = toCollectionItem(
      baseRow({ state: "collected", has_cover_photo: true, card_crop_x: "0.5", card_crop_y: "0.25", card_crop_size: "0.8" }),
    );
    expect(own.cardCropX).toBe(0.5);
    expect(own.cardCropY).toBe(0.25);
    expect(own.cardCropSize).toBe(0.8);

    const reference = toCollectionItem(
      baseRow({ state: "collected", has_cover_photo: false, card_crop_x: "0.5", reference_focal_x: "0.3" }),
    );
    expect(reference.cardCropX).toBeNull();
    expect(reference.referenceFocalX).toBe(0.3);
  });

  it("only applies the reference focal point when there's no owned cover photo", () => {
    const item = toCollectionItem(
      baseRow({ state: "collected", has_cover_photo: true, reference_focal_x: "0.9", reference_focal_y: "0.1" }),
    );
    expect(item.referenceFocalX).toBeNull();
    expect(item.referenceFocalY).toBeNull();
  });

  it("treats vagrant as strictly boolean true, not just truthy", () => {
    expect(toCollectionItem(baseRow({ is_vagrant: true })).vagrant).toBe(true);
    expect(toCollectionItem(baseRow({ is_vagrant: false })).vagrant).toBe(false);
    expect(toCollectionItem(baseRow({ is_vagrant: null })).vagrant).toBe(false);
    expect(toCollectionItem(baseRow({ is_vagrant: undefined })).vagrant).toBe(false);
  });

  it("is endemic if either endemic_country_iso3 or endemic_region_label is set", () => {
    expect(toCollectionItem(baseRow({ endemic_country_iso3: "PER" })).endemic).toBe(true);
    expect(toCollectionItem(baseRow({ endemic_region_label: "the Andes" })).endemic).toBe(true);
    expect(toCollectionItem(baseRow({ endemic_country_iso3: null, endemic_region_label: null })).endemic).toBe(false);
  });

  it("only carries a cover volume label when the cover photo is owned", () => {
    const own = toCollectionItem(baseRow({ state: "collected", has_cover_photo: true, cover_volume_label: "Backup Drive" }));
    expect(own.coverVolumeLabel).toBe("Backup Drive");

    const notOwned = toCollectionItem(baseRow({ state: "collected", has_cover_photo: false, cover_volume_label: "Backup Drive" }));
    expect(notOwned.coverVolumeLabel).toBeNull();
  });

  it("coerces numeric-string crop fields but leaves null as null (numOrNull boundary)", () => {
    const item = toCollectionItem(baseRow({ state: "collected", has_cover_photo: true, card_crop_x: "0", card_crop_y: null }));
    expect(item.cardCropX).toBe(0);
    expect(item.cardCropY).toBeNull();
  });
});
