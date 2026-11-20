// Development only (see devDriver.ts): a believable life for the simulator, and an extreme one.
import type { Db } from "../store/db";
import {
  applyAlbums,
  applyCaptureChanges,
  applyMembers,
  applyTrips,
  type CaptureChange,
} from "../store/library";
import { editMark } from "../store/marks";
import { saveRegion, type RegionSpecies } from "../store/regions";

const NOW = new Date("2026-10-25T10:00:00Z");

// scientific name | common name | taxon class | tier
const TABLE = `
Dryocopus pileatus|Pileated Woodpecker|aves|uncommon
Ixoreus naevius|Varied Thrush|aves|common
Dendragapus fuliginosus|Sooty Grouse|aves|rare
Haematopus bachmani|Black Oystercatcher|aves|occasional
Cyanocitta stelleri|Steller's Jay|aves|common
Strix varia|Barred Owl|aves|uncommon
Tringa incana|Wandering Tattler|aves|rare
Larus glaucescens|Glaucous-winged Gull|aves|common
Brachyramphus marmoratus|Marbled Murrelet|aves|rare
Haliaeetus leucocephalus|Bald Eagle|aves|common
Ardea herodias|Great Blue Heron|aves|common
Selasphorus rufus|Rufous Hummingbird|aves|occasional
Corvus caurinus|Northwestern Crow|aves|common
Setophaga townsendi|Townsend's Warbler|aves|uncommon
Cinclus mexicanus|American Dipper|aves|uncommon
Bucephala albeola|Bufflehead|aves|common
Melanitta perspicillata|Surf Scoter|aves|common
Pelecanus erythrorhynchos|American White Pelican|aves|rare
Setophaga nigrescens|Black-throated Gray Warbler|aves|uncommon
Catharus ustulatus|Swainson's Thrush|aves|common
Perisoreus canadensis|Canada Jay|aves|occasional
Bubo scandiacus|Snowy Owl|aves|legendary
Falco peregrinus|Peregrine Falcon|aves|rare
Aechmophorus occidentalis|Western Grebe|aves|occasional
Empidonax difficilis|Pacific-slope Flycatcher|aves|common
Piranga ludoviciana|Western Tanager|aves|uncommon
Sitta canadensis|Red-breasted Nuthatch|aves|common
Poecile rufescens|Chestnut-backed Chickadee|aves|common
Ursus americanus|Black Bear|mammalia|occasional
Odocoileus hemionus|Black-tailed Deer|mammalia|common
Sciurus carolinensis|Eastern Gray Squirrel|mammalia|common
Lontra canadensis|North American River Otter|mammalia|uncommon
Enhydra lutris|Sea Otter|mammalia|rare
Orcinus orca|Killer Whale|aquatic_mammalia|rare
Phoca vitulina|Harbour Seal|aquatic_mammalia|common
Eumetopias jubatus|Steller Sea Lion|aquatic_mammalia|occasional
Puma concolor|Cougar|mammalia|legendary
Thamnophis sirtalis|Common Garter Snake|squamata|common
Elgaria coerulea|Northern Alligator Lizard|squamata|occasional
Chrysemys picta|Painted Turtle|testudines|occasional
Ambystoma gracile|Northwestern Salamander|amphibia|uncommon
Pseudacris regilla|Pacific Tree Frog|amphibia|common
Rana aurora|Northern Red-legged Frog|amphibia|uncommon
Oncorhynchus kisutch|Coho Salmon|actinopterygii|occasional
Oncorhynchus mykiss|Rainbow Trout|actinopterygii|occasional
Sebastes caurinus|Copper Rockfish|actinopterygii|uncommon
Squalus suckleyi|Pacific Spiny Dogfish|elasmobranchii|rare
Danaus plexippus|Monarch|insecta|uncommon
Papilio rutulus|Western Tiger Swallowtail|insecta|occasional
Bombus vosnesenskii|Yellow-faced Bumble Bee|insecta|common
Pantala flavescens|Wandering Glider|insecta|uncommon
Argiope aurantia|Yellow Garden Spider|arachnida|occasional
Araneus diadematus|European Garden Spider|arachnida|common
Pisaster ochraceus|Ochre Sea Star|asteroidea|common
Anthopleura elegantissima|Aggregating Anemone|anthozoa|common
Ramphastos sulfuratus|Keel-billed Toucan With A Remarkably Long Common Name That Keeps Going|aves|legendary
`
  .trim()
  .split("\n")
  .map((l) => l.split("|"));

const species = (): RegionSpecies[] =>
  TABLE.map(([scientificName, commonName, taxonClass, tier], i) => ({
    scientificName,
    commonName,
    taxonClass,
    tier,
    vagrant: i % 17 === 5,
    sensitive: scientificName === "Strix varia",
  }));

const PLACES = [
  "Tofino, British Columbia",
  "Stanley Park, Vancouver",
  "Okanagan",
  "Pitt Meadows",
  "Cowichan Bay",
  "Victoria",
];

/** Standalone: one region kept, photos across a few months, marks, albums, an active trip and a past one. */
export async function seedDemo(db: Db): Promise<void> {
  await saveRegion(
    db,
    { key: "pack:British Columbia", name: "British Columbia", source: "pack", hubRegionId: null },
    species(),
    NOW,
  );
  const photographed = TABLE.slice(0, 26).filter((_, i) => i % 5 !== 3);
  const changes: CaptureChange[] = [];
  let n = 0;
  photographed.forEach(([sci], si) => {
    const count = 1 + ((si * 7) % 6);
    for (let k = 0; k < count; k++) {
      const month = 10 - ((si + k * 2) % 9);
      const day = 1 + ((si * 3 + k * 5) % 27);
      changes.push({
        id: `c${n}`,
        deletedAt: null,
        hiddenAt: null,
        scientificName: sci,
        takenAt: `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T07:${String(10 + (n % 50))}:00Z`,
        tags: [],
        qualityRating: (n % 5) + 1,
        locationLabel: PLACES[(si + k) % PLACES.length],
        regionId: null,
        tripId: k === 0 && si % 4 === 0 ? "trip-island" : null,
        photo: { id: `ph${n}`, width: [640, 800, 533][n % 3], height: [640, 533, 800][n % 3], kind: "image" },
      });
      n++;
    }
  });
  await applyCaptureChanges(db, changes, []);
  await editMark(db, "Dendragapus fuliginosus", { isTarget: true }, NOW);
  await editMark(db, "Brachyramphus marmoratus", { isTarget: true }, NOW);
  await editMark(db, "Tringa incana", { isTarget: true }, NOW);
  await editMark(db, "Haematopus bachmani", { state: "seen" }, NOW);
  await editMark(db, "Ursus americanus", { state: "seen" }, NOW);
  await editMark(db, "Orcinus orca", { state: "seen" }, NOW);
  await applyAlbums(
    db,
    [
      { id: "a-fav", name: "Favourites", coverPhotoId: "ph0" },
      { id: "a-owls", name: "Owls", coverPhotoId: "ph6" },
      { id: "a-island", name: "Vancouver Island 2026", coverPhotoId: "ph9" },
      { id: "a-best", name: "Best of 2025", coverPhotoId: "ph10" },
      {
        id: "a-long",
        name: "A very long album name that has to wrap onto two lines and then be cut off cleanly",
        coverPhotoId: "ph3",
      },
      { id: "a-mammals", name: "Mammals of the Rockies", coverPhotoId: "ph4" },
      // A smart album has no cover and no hand-picked members: the hub sends its matches at sync.
      { id: "a-smart", name: "Four stars and up", coverPhotoId: null },
    ],
    [],
  );
  await applyMembers(
    db,
    changes.filter((c) => (c.qualityRating ?? 0) >= 4).map((c) => ({ albumId: "a-smart", captureId: c.id })),
    [],
  );
  await applyMembers(
    db,
    changes
      .slice(0, 40)
      .map((c, i) => ({ albumId: ["a-fav", "a-owls", "a-island", "a-best"][i % 4], captureId: c.id })),
    [],
  );
  await applyTrips(
    db,
    [
      {
        id: "trip-island",
        name: "Vancouver Island",
        description: null,
        startDate: "2026-10-23",
        endDate: "2026-10-28",
        regionId: "pack:British Columbia",
        coverCaptureId: "c0",
        activeOverride: null,
      },
      {
        id: "trip-okanagan",
        name: "Okanagan spring",
        description: null,
        startDate: "2026-04-14",
        endDate: "2026-04-18",
        regionId: "pack:British Columbia",
        coverCaptureId: "c5",
        activeOverride: null,
      },
    ],
    [],
  );
}

/** 5,000 species, 60,000 photos, very long names. */
export async function seedExtreme(db: Db): Promise<void> {
  const groups = ["aves", "mammalia", "squamata", "amphibia", "actinopterygii", "insecta", "arachnida", "other"];
  const items: RegionSpecies[] = Array.from({ length: 5000 }, (_, i) => ({
    scientificName: `Genus${i} species${i}`,
    commonName:
      i % 97 === 0
        ? `Extremely Long Common Name Number ${i} Of The Greater Eastern Highland Variety With Spotted Wings`
        : `Species ${i}`,
    taxonClass: groups[i % groups.length],
    tier: ["common", "occasional", "uncommon", "rare", "legendary"][i % 5],
    vagrant: i % 40 === 0,
    sensitive: false,
  }));
  await saveRegion(
    db,
    { key: "pack:Everywhere Big", name: "Everywhere Big", source: "pack", hubRegionId: null },
    items,
    NOW,
  );
  await db.tx(async () => {
    for (let i = 0; i < 60000; i++) {
      const month = 1 + (i % 12);
      await db.run(
        "INSERT INTO captures (id, photo_id, scientific_name, taken_at, location_label, tags, rating, kind, width, height) VALUES (?, ?, ?, ?, ?, '[]', ?, 'image', ?, ?)",
        [
          `x${i}`,
          `xp${i}`,
          `Genus${i % 3000} species${i % 3000}`,
          `${2018 + (i % 9)}-${String(month).padStart(2, "0")}-${String(1 + (i % 27)).padStart(2, "0")}T07:00:00Z`,
          PLACES[i % 6],
          i % 5,
          [640, 800, 533][i % 3],
          [640, 533, 800][i % 3],
        ],
      );
    }
  });
}
