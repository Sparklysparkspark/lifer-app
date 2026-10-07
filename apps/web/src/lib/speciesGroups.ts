import { otherTaxaGroupLabel } from "@lifer/shared";
import i18n from "../i18n";

// Rarity tier display names, shared by the species card badges and the tier grouping.
const TIER_LABEL_KEYS: Record<string, string> = {
  legendary: "collection.tiers.legendary",
  rare: "collection.tiers.rare",
  uncommon: "collection.tiers.uncommon",
  occasional: "collection.tiers.occasional",
  common: "collection.tiers.common",
  unrated: "collection.tiers.unrated",
};

/** A rarity tier's name in the active language; an unknown tier shows as is. */
export function tierLabel(tier: string): string {
  const key = TIER_LABEL_KEYS[tier];
  return key ? i18n.t(key) : tier;
}

// The fixed taxon classes' names (packages/shared TAXON_CLASS_LABEL has the English, for the API).
const TAXON_CLASS_LABEL_KEYS: Record<string, string> = {
  aves: "taxa.class.aves",
  mammalia: "taxa.class.mammalia",
  actinopterygii: "taxa.class.actinopterygii",
  elasmobranchii: "taxa.class.elasmobranchii",
  aquatic_mammalia: "taxa.class.aquatic_mammalia",
  amphibia: "taxa.class.amphibia",
  squamata: "taxa.class.squamata",
  testudines: "taxa.class.testudines",
  corals: "taxa.class.corals",
  jellies_and_anemones: "taxa.class.jellies_and_anemones",
  echinodermata: "taxa.class.echinodermata",
  nudibranchs: "taxa.class.nudibranchs",
  marine_mollusks: "taxa.class.marine_mollusks",
  cephalopoda: "taxa.class.cephalopoda",
  crustacea: "taxa.class.crustacea",
  sponges_tunicates_other: "taxa.class.sponges_tunicates_other",
};

/** A built-in taxon class's name in the active language, or undefined for any other value. */
export function taxonClassLabel(taxonClass: string): string | undefined {
  const key = TAXON_CLASS_LABEL_KEYS[taxonClass];
  return key ? i18n.t(key) : undefined;
}

/** Whether a value is one of the built-in taxon classes. */
export function isTaxonClass(value: string): boolean {
  return value in TAXON_CLASS_LABEL_KEYS;
}

// Birding-style group names ("Hawks, Eagles & Kites", as message keys) by real taxonomic family. Unmapped
// families fall back to the family name itself rather than an "Other" bucket.
const BIRD_FAMILY_GROUPS: Record<string, string> = {
  Anatidae: "taxa.groups.waterfowl",
  Anhingidae: "taxa.groups.anhingas",
  Phalacrocoracidae: "taxa.groups.cormorants",
  Pelecanidae: "taxa.groups.pelicans",
  Ardeidae: "taxa.groups.heronsEgretsBitterns",
  Threskiornithidae: "taxa.groups.ibisesSpoonbills",
  Ciconiidae: "taxa.groups.storks",
  Gaviidae: "taxa.groups.loons",
  Podicipedidae: "taxa.groups.grebes",
  Fregatidae: "taxa.groups.frigatebirds",
  Sulidae: "taxa.groups.boobiesGannets",
  Accipitridae: "taxa.groups.hawksEaglesKites",
  Pandionidae: "taxa.groups.ospreys",
  Falconidae: "taxa.groups.falconsCaracaras",
  Strigidae: "taxa.groups.owls",
  Tytonidae: "taxa.groups.owls",
  Cathartidae: "taxa.groups.vulturesCondors",
  Rallidae: "taxa.groups.railsCrakesCoots",
  Gruidae: "taxa.groups.cranes",
  Charadriidae: "taxa.groups.plovers",
  Scolopacidae: "taxa.groups.sandpipersShorebirds",
  Recurvirostridae: "taxa.groups.stiltsAvocets",
  Haematopodidae: "taxa.groups.oystercatchers",
  Jacanidae: "taxa.groups.jacanas",
  Laridae: "taxa.groups.gullsTerns",
  Stercorariidae: "taxa.groups.jaegersSkuas",
  Alcidae: "taxa.groups.auksMurresPuffins",
  Columbidae: "taxa.groups.pigeonsDoves",
  Cuculidae: "taxa.groups.cuckoosRoadrunners",
  Caprimulgidae: "taxa.groups.nightjars",
  Apodidae: "taxa.groups.swifts",
  Trochilidae: "taxa.groups.hummingbirds",
  Rallinae: "taxa.groups.rails",
  Alcedinidae: "taxa.groups.kingfishers",
  Picidae: "taxa.groups.woodpeckers",
  Tyrannidae: "taxa.groups.tyrantFlycatchers",
  Laniidae: "taxa.groups.shrikes",
  Vireonidae: "taxa.groups.vireos",
  Corvidae: "taxa.groups.crowsJaysMagpies",
  Alaudidae: "taxa.groups.larks",
  Hirundinidae: "taxa.groups.swallows",
  Paridae: "taxa.groups.chickadeesTitmice",
  Sittidae: "taxa.groups.nuthatches",
  Certhiidae: "taxa.groups.treecreepers",
  Troglodytidae: "taxa.groups.wrens",
  Polioptilidae: "taxa.groups.gnatcatchers",
  Sturnidae: "taxa.groups.starlings",
  Turdidae: "taxa.groups.thrushes",
  Mimidae: "taxa.groups.mockingbirdsThrashers",
  Bombycillidae: "taxa.groups.waxwings",
  Ptiliogonatidae: "taxa.groups.silkyFlycatchers",
  Passerellidae: "taxa.groups.newWorldSparrows",
  Emberizidae: "taxa.groups.oldWorldBuntings",
  Icteriidae: "taxa.groups.yellowthroats",
  Icteridae: "taxa.groups.blackbirdsOrioles",
  Parulidae: "taxa.groups.woodWarblers",
  Cardinalidae: "taxa.groups.cardinalsGrosbeaks",
  Fringillidae: "taxa.groups.finches",
  Passeridae: "taxa.groups.oldWorldSparrows",
  Motacillidae: "taxa.groups.pipitsWagtails",
  Phasianidae: "taxa.groups.grouseQuailPheasants",
  Odontophoridae: "taxa.groups.newWorldQuail",
  Podargidae: "taxa.groups.frogmouths",
  Psittacidae: "taxa.groups.parrots",
  Ramphastidae: "taxa.groups.toucans",
  Trogonidae: "taxa.groups.trogons",
  Bucconidae: "taxa.groups.puffbirds",
  Thraupidae: "taxa.groups.tanagers",
  Furnariidae: "taxa.groups.ovenbirdsWoodcreepers",
  Thamnophilidae: "taxa.groups.antbirds",
  Cotingidae: "taxa.groups.cotingas",
  Pipridae: "taxa.groups.manakins",
};

// Only birds have friendly names so far; other taxa group by family. Other Taxa species have no
// family, so they group by their iNat iconic taxon ("Insecta", "Fungi", ...).
export function speciesGroupLabel(
  taxonClass: string | null,
  family: string | null,
  isOtherTaxa?: boolean,
  inatIconicTaxon?: string | null,
  namingStyles?: string[],
): string {
  if (isOtherTaxa)
    return inatIconicTaxon ? otherTaxaGroupLabel(inatIconicTaxon, namingStyles ?? []) : i18n.t("taxa.other");
  if (family && taxonClass === "aves" && BIRD_FAMILY_GROUPS[family]) return i18n.t(BIRD_FAMILY_GROUPS[family]);
  return family ?? i18n.t("taxa.other");
}
