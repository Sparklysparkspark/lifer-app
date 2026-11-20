// A believable library for the visual tour: World > North America (Canada with provinces, plus
// Belize and Costa Rica, which the picker shows under its virtual "Central America" group) and
// Africa (Kenya), with 3,000+ made-up species across birds, mammals and reptiles. Everything comes
// from a seeded PRNG, so every run builds the same rows, packs and pictures.
import type { ClientBase } from "pg";

export type Taxon = "aves" | "mammalia" | "reptilia";
export const REALISTIC_TAXA: Taxon[] = ["aves", "mammalia", "reptilia"];
export type Tier = "common" | "occasional" | "uncommon" | "rare" | "legendary";

export interface RealSpecies {
  index: number;
  scientificName: string;
  commonName: string;
  taxonClass: Taxon;
  family: string;
  order: string;
  hasPhoto: boolean;
}

type Ring = Array<[number, number]>;
const feature = (...rings: Ring[]) => ({
  type: "Feature",
  properties: {},
  geometry:
    rings.length === 1
      ? { type: "Polygon", coordinates: [rings[0]] }
      : { type: "MultiPolygon", coordinates: rings.map((r) => [r]) },
});

export interface RealProvince {
  name: string;
  codes: string[];
  ebird: string | null;
  boundary: ReturnType<typeof feature>;
  /** Species indexes on its checklist, a subset of the country's. */
  members: number[];
}

export interface RealCountry {
  name: string;
  iso3: string;
  ebird: string;
  continent: "North America" | "Africa";
  boundary: ReturnType<typeof feature>;
  provinces: RealProvince[];
  members: number[];
  tiers: Map<number, Tier>;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Rough outlines at roughly the right place, so each region's map frames somewhere different.
const close = (r: Ring): Ring => [...r, r[0]];
const BOUNDARIES = {
  Canada: feature(
    close([
      [-141, 60],
      [-141, 69.6],
      [-120, 70],
      [-95, 72],
      [-80, 73],
      [-62, 66],
      [-55, 52],
      [-64, 45],
      [-67, 45],
      [-75, 45],
      [-83, 42],
      [-95, 49],
      [-123, 49],
      [-131, 54],
    ]),
    close([
      [-85, 76],
      [-62, 82],
      [-90, 82],
      [-100, 78],
    ]),
  ),
  "British Columbia": feature(
    close([
      [-139, 60],
      [-120, 60],
      [-120, 53.8],
      [-114.1, 49],
      [-123.3, 48.3],
      [-128, 50.6],
      [-133, 54.5],
    ]),
  ),
  Alberta: feature(
    close([
      [-120, 60],
      [-110, 60],
      [-110, 49],
      [-114.1, 49],
      [-120, 53.8],
    ]),
  ),
  Ontario: feature(
    close([
      [-95.2, 52.8],
      [-89, 56.9],
      [-82.3, 55.1],
      [-79.5, 51.5],
      [-79.5, 47],
      [-74.4, 45.1],
      [-79, 43.3],
      [-83, 41.7],
      [-84.8, 46.5],
      [-89.5, 48],
      [-95.2, 49.4],
    ]),
  ),
  Belize: feature(
    close([
      [-89.2, 18.0],
      [-88.3, 18.5],
      [-88.1, 17.5],
      [-88.3, 16.3],
      [-88.9, 15.9],
      [-89.2, 16.0],
    ]),
  ),
  Cayo: feature(
    close([
      [-89.2, 17.6],
      [-88.6, 17.6],
      [-88.6, 16.6],
      [-89.2, 16.6],
    ]),
  ),
  "Belize District": feature(
    close([
      [-88.6, 17.9],
      [-88.1, 17.9],
      [-88.1, 17.1],
      [-88.6, 17.1],
    ]),
  ),
  "Costa Rica": feature(
    close([
      [-85.9, 11.1],
      [-83.6, 10.9],
      [-82.6, 9.6],
      [-82.9, 8.1],
      [-83.7, 8.6],
      [-85.0, 9.6],
      [-85.7, 9.9],
    ]),
  ),
  Guanacaste: feature(
    close([
      [-85.9, 11.1],
      [-84.8, 11.0],
      [-84.9, 10.0],
      [-85.7, 9.9],
    ]),
  ),
  "San José": feature(
    close([
      [-84.4, 10.0],
      [-83.8, 10.0],
      [-83.6, 9.3],
      [-84.3, 9.2],
    ]),
  ),
  Kenya: feature(
    close([
      [34.0, 4.6],
      [35.9, 4.6],
      [41.9, 4.0],
      [41.0, -1.7],
      [39.2, -4.7],
      [37.7, -3.7],
      [33.9, -1.0],
      [34.9, 1.2],
    ]),
  ),
  Nairobi: feature(
    close([
      [36.65, -1.15],
      [37.1, -1.15],
      [37.1, -1.45],
      [36.65, -1.45],
    ]),
  ),
  "Rift Valley": feature(
    close([
      [34.6, 4.6],
      [36.6, 4.6],
      [36.9, -0.5],
      [36.0, -2.6],
      [35.0, -1.6],
      [35.2, 1.0],
    ]),
  ),
};

// Words for the made-up names. Scientific names come from a genus per group plus Latin-ish
// epithets; each common name is unique.
const GROUPS: Record<Taxon, Array<{ noun: string; genus: string; family: string; order: string }>> = {
  aves: [
    { noun: "Warbler", genus: "Setophaga", family: "Parulidae", order: "Passeriformes" },
    { noun: "Tanager", genus: "Tangara", family: "Thraupidae", order: "Passeriformes" },
    { noun: "Flycatcher", genus: "Empidonax", family: "Tyrannidae", order: "Passeriformes" },
    { noun: "Hummingbird", genus: "Amazilia", family: "Trochilidae", order: "Apodiformes" },
    { noun: "Wren", genus: "Thryothorus", family: "Troglodytidae", order: "Passeriformes" },
    { noun: "Sparrow", genus: "Melospiza", family: "Passerellidae", order: "Passeriformes" },
    { noun: "Heron", genus: "Ardea", family: "Ardeidae", order: "Pelecaniformes" },
    { noun: "Kingfisher", genus: "Chloroceryle", family: "Alcedinidae", order: "Coraciiformes" },
    { noun: "Parrot", genus: "Amazona", family: "Psittacidae", order: "Psittaciformes" },
    { noun: "Toucan", genus: "Ramphastos", family: "Ramphastidae", order: "Piciformes" },
    { noun: "Woodpecker", genus: "Melanerpes", family: "Picidae", order: "Piciformes" },
    { noun: "Hawk", genus: "Buteo", family: "Accipitridae", order: "Accipitriformes" },
    { noun: "Owl", genus: "Strix", family: "Strigidae", order: "Strigiformes" },
    { noun: "Thrush", genus: "Turdus", family: "Turdidae", order: "Passeriformes" },
    { noun: "Dove", genus: "Leptotila", family: "Columbidae", order: "Columbiformes" },
    { noun: "Sandpiper", genus: "Calidris", family: "Scolopacidae", order: "Charadriiformes" },
    { noun: "Antbird", genus: "Myrmeciza", family: "Thamnophilidae", order: "Passeriformes" },
    { noun: "Sunbird", genus: "Cinnyris", family: "Nectariniidae", order: "Passeriformes" },
    { noun: "Weaver", genus: "Ploceus", family: "Ploceidae", order: "Passeriformes" },
    { noun: "Bee-eater", genus: "Merops", family: "Meropidae", order: "Coraciiformes" },
  ],
  mammalia: [
    { noun: "Bat", genus: "Myotis", family: "Vespertilionidae", order: "Chiroptera" },
    { noun: "Squirrel", genus: "Sciurus", family: "Sciuridae", order: "Rodentia" },
    { noun: "Mouse", genus: "Peromyscus", family: "Cricetidae", order: "Rodentia" },
    { noun: "Shrew", genus: "Sorex", family: "Soricidae", order: "Eulipotyphla" },
    { noun: "Monkey", genus: "Alouatta", family: "Atelidae", order: "Primates" },
    { noun: "Antelope", genus: "Gazella", family: "Bovidae", order: "Artiodactyla" },
    { noun: "Mongoose", genus: "Herpestes", family: "Herpestidae", order: "Carnivora" },
    { noun: "Weasel", genus: "Mustela", family: "Mustelidae", order: "Carnivora" },
    { noun: "Deer", genus: "Odocoileus", family: "Cervidae", order: "Artiodactyla" },
    { noun: "Opossum", genus: "Didelphis", family: "Didelphidae", order: "Didelphimorphia" },
  ],
  reptilia: [
    { noun: "Anole", genus: "Anolis", family: "Dactyloidae", order: "Squamata" },
    { noun: "Gecko", genus: "Hemidactylus", family: "Gekkonidae", order: "Squamata" },
    { noun: "Snake", genus: "Lampropeltis", family: "Colubridae", order: "Squamata" },
    { noun: "Skink", genus: "Plestiodon", family: "Scincidae", order: "Squamata" },
    { noun: "Turtle", genus: "Kinosternon", family: "Kinosternidae", order: "Testudines" },
    { noun: "Chameleon", genus: "Trioceros", family: "Chamaeleonidae", order: "Squamata" },
  ],
};
const ADJECTIVES = [
  "Azure",
  "Crimson",
  "Golden",
  "Olive",
  "Rufous",
  "Slaty",
  "Spotted",
  "Striped",
  "Tawny",
  "Scarlet",
  "Cinnamon",
  "Dusky",
  "Pale",
  "Ashy",
  "Buff",
  "Chestnut",
  "Emerald",
  "Ivory",
  "Ochre",
  "Sooty",
  "Banded",
  "Crested",
  "Masked",
  "Collared",
  "Plain",
  "Speckled",
  "Lined",
  "Ringed",
  "Hooded",
  "Bronzed",
];
const PREFIXES = [
  "",
  "Northern ",
  "Southern ",
  "Western ",
  "Eastern ",
  "Lesser ",
  "Greater ",
  "Mountain ",
  "Lowland ",
  "Forest ",
  "River ",
  "Coastal ",
];
const EPITHETS = [
  "caerulea",
  "rubra",
  "aurea",
  "olivacea",
  "rufa",
  "schistacea",
  "maculata",
  "striata",
  "fulva",
  "coccinea",
  "cinnamomea",
  "obscura",
  "pallida",
  "cinerea",
  "ochracea",
  "castanea",
  "smaragdina",
  "eburnea",
  "fuliginosa",
  "fasciata",
  "cristata",
  "larvata",
  "torquata",
  "simplex",
  "guttata",
  "lineata",
  "annulata",
  "cucullata",
  "aenea",
  "minor",
];
const EPITHET_SUFFIX = [
  "",
  "borealis",
  "australis",
  "occidentalis",
  "orientalis",
  "minima",
  "maxima",
  "montana",
  "campestris",
  "silvatica",
  "fluviatilis",
  "litoralis",
];

const COUNTS: Record<Taxon, number> = { aves: 2100, mammalia: 700, reptilia: 450 };

function buildSpecies(): RealSpecies[] {
  const rng = mulberry32(7);
  const out: RealSpecies[] = [];
  for (const taxon of REALISTIC_TAXA) {
    const groups = GROUPS[taxon];
    // Every (prefix, adjective, group) once, in a shuffled order, so names never repeat.
    const combos: Array<[number, number, number]> = [];
    for (let p = 0; p < PREFIXES.length; p++)
      for (let a = 0; a < ADJECTIVES.length; a++) for (let g = 0; g < groups.length; g++) combos.push([p, a, g]);
    for (let i = combos.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [combos[i], combos[j]] = [combos[j], combos[i]];
    }
    for (const [p, a, g] of combos.slice(0, COUNTS[taxon])) {
      const group = groups[g];
      const epithet = EPITHET_SUFFIX[p] ? `${EPITHETS[a]}-${EPITHET_SUFFIX[p]}` : EPITHETS[a];
      out.push({
        index: out.length,
        scientificName: `${group.genus} ${epithet}`,
        commonName: `${PREFIXES[p]}${ADJECTIVES[a]} ${group.noun}`,
        taxonClass: taxon,
        family: group.family,
        order: group.order,
        // A few without a reference photo, as in a real catalog.
        hasPhoto: rng() > 0.03,
      });
    }
  }
  return out;
}

// The checklist draws. Americas species and African species are separate pools, as in life.
const AFRICAN_GROUPS = new Set(["Sunbird", "Weaver", "Bee-eater", "Antelope", "Mongoose", "Chameleon"]);
const TIERS: Tier[] = [
  "common",
  "common",
  "common",
  "occasional",
  "occasional",
  "uncommon",
  "uncommon",
  "rare",
  "legendary",
];

function buildCountries(species: RealSpecies[]): RealCountry[] {
  const rng = mulberry32(11);
  const african = (s: RealSpecies) => AFRICAN_GROUPS.has(s.commonName.split(" ").pop()!);
  const pick = (pool: RealSpecies[], share: number) => pool.filter(() => rng() < share).map((s) => s.index);
  const americas = species.filter((s) => !african(s));
  const africa = species.filter(african);
  const subset = (members: number[], share: number) => members.filter(() => rng() < share);
  const withTiers = (members: number[]) => new Map(members.map((i) => [i, TIERS[Math.floor(rng() * TIERS.length)]]));
  const province = (
    name: string,
    codes: string[],
    ebird: string | null,
    members: number[],
    share: number,
  ): RealProvince => ({
    name,
    codes,
    ebird,
    boundary: BOUNDARIES[name as keyof typeof BOUNDARIES],
    members: subset(members, share),
  });

  const canada = pick(americas, 0.28);
  const belize = pick(americas, 0.42);
  const costaRica = pick(americas, 0.68);
  const kenya = pick(africa, 0.9).concat(
    pick(
      americas.filter((s) => s.taxonClass === "aves"),
      0.04,
    ),
  );
  return [
    {
      name: "Canada",
      iso3: "CAN",
      ebird: "CA",
      continent: "North America",
      boundary: BOUNDARIES.Canada,
      members: canada,
      tiers: withTiers(canada),
      provinces: [
        province("British Columbia", ["CAN.2_1"], "CA-BC", canada, 0.7),
        province("Alberta", ["CAN.1_1"], "CA-AB", canada, 0.5),
        province("Ontario", ["CAN.9_1"], "CA-ON", canada, 0.6),
      ],
    },
    {
      name: "Belize",
      iso3: "BLZ",
      ebird: "BZ",
      continent: "North America",
      boundary: BOUNDARIES.Belize,
      members: belize,
      tiers: withTiers(belize),
      provinces: [
        province("Cayo", ["BZ-CY"], "BZ-CY", belize, 0.7),
        province("Belize District", ["BZ-BZ"], "BZ-BZ", belize, 0.6),
      ],
    },
    {
      name: "Costa Rica",
      iso3: "CRI",
      ebird: "CR",
      continent: "North America",
      boundary: BOUNDARIES["Costa Rica"],
      members: costaRica,
      tiers: withTiers(costaRica),
      provinces: [
        province("Guanacaste", ["CR-G"], "CR-G", costaRica, 0.6),
        province("San José", ["CR-SJ"], "CR-SJ", costaRica, 0.5),
      ],
    },
    {
      name: "Kenya",
      iso3: "KEN",
      ebird: "KE",
      continent: "Africa",
      boundary: BOUNDARIES.Kenya,
      members: kenya,
      tiers: withTiers(kenya),
      provinces: [
        province("Nairobi", ["KE-30"], "KE-30", kenya, 0.5),
        province("Rift Valley", ["KE-700"], "KE-700", kenya, 0.7),
      ],
    },
  ];
}

export const REAL_SPECIES = buildSpecies();
export const REAL_COUNTRIES = buildCountries(REAL_SPECIES);
export const realCountry = (name: string) => REAL_COUNTRIES.find((c) => c.name === name)!;

/** Matches the mirror's catalog manifest, so the app sees its catalog as up to date. */
export const REAL_CATALOG_VERSION = 1;

/** The catalog rows: species and the region tree down to countries. Provinces and checklists
 *  come from the packs the setup project downloads, the way a real install gets them. */
export async function insertRealisticCatalog(db: ClientBase): Promise<void> {
  await db.query("BEGIN");
  try {
    const s = REAL_SPECIES;
    await db.query(
      `INSERT INTO species (gbif_key, scientific_name, common_name, taxon_class, family, taxon_order, sort_order)
       SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[])`,
      [
        s.map((x) => 980_000_001 + x.index),
        s.map((x) => x.scientificName),
        s.map((x) => x.commonName),
        s.map((x) => x.taxonClass),
        s.map((x) => x.family),
        s.map((x) => x.order),
        s.map((x) => x.index + 1),
      ],
    );
    const world = await db.query<{ id: string }>(
      `INSERT INTO regions (name, has_children) VALUES ('World', true) RETURNING id`,
    );
    const continentIds = new Map<string, string>();
    for (const name of ["Africa", "North America"]) {
      const res = await db.query<{ id: string }>(
        `INSERT INTO regions (name, parent_id, has_children) VALUES ($1, $2, true) RETURNING id`,
        [name, world.rows[0].id],
      );
      continentIds.set(name, res.rows[0].id);
    }
    for (const c of REAL_COUNTRIES) {
      await db.query(
        `INSERT INTO regions (name, parent_id, external_codes, ebird_region_code, sovereignty_group, boundary_geojson, has_children)
         VALUES ($1, $2, $3, $4, $5, $6, true)`,
        [c.name, continentIds.get(c.continent), [c.iso3], c.ebird, c.iso3, JSON.stringify(c.boundary)],
      );
    }
    await db.query(`INSERT INTO install_settings (key, value) VALUES ('catalog_seed_version', $1)`, [
      JSON.stringify(REAL_CATALOG_VERSION),
    ]);
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  }
}
