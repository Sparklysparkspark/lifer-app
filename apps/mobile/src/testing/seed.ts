import type { Db } from "../store/db";
import { applyCaptureChanges, type CaptureChange } from "../store/library";
import { editMark } from "../store/marks";
import { saveRegion } from "../store/regions";

export const NOW = new Date("2026-10-25T10:00:00Z");

export const capture = (id: string, scientificName: string, takenAt: string | null = "2026-09-01T10:00:00Z", extra: Partial<CaptureChange> = {}): CaptureChange => ({
  id,
  deletedAt: null,
  hiddenAt: null,
  scientificName,
  takenAt,
  tags: [],
  qualityRating: null,
  locationLabel: null,
  regionId: null,
  photo: { id: `p-${id}`, width: 100, height: 80, kind: "image" },
  ...extra,
});

const item = (scientificName: string, commonName: string, sensitive = false) => ({
  scientificName,
  commonName,
  taxonClass: "aves",
  tier: null,
  vagrant: false,
  sensitive,
});

/** A small life: two photographed species, one seen, a target to find, a kept region. */
export async function seedLife(db: Db): Promise<void> {
  await saveRegion(
    db,
    { key: "hub:r1", name: "Norfolk", source: "hub", hubRegionId: "r1" },
    [item("Cygnus olor", "Mute Swan"), item("Cygnus columbianus", "Tundra Swan"), item("Grus grus", "Common Crane"), item("Anas crecca", "Eurasian Teal"), item("Tyto alba", "Barn Owl", true)],
    NOW,
  );
  await applyCaptureChanges(
    db,
    [
      capture("1", "Cygnus olor", "2026-09-02T10:00:00Z", { locationLabel: "Slimbridge" }),
      capture("2", "Cygnus olor", "2026-08-02T10:00:00Z"),
      capture("3", "Tyto alba", "2026-07-02T10:00:00Z", { locationLabel: "Secret field" }),
    ],
    [],
  );
  await editMark(db, "Anas crecca", { state: "seen" }, NOW);
  await editMark(db, "Grus grus", { isTarget: true }, NOW);
}
