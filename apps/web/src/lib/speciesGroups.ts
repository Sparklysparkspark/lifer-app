import { otherTaxaGroupLabel } from "@lifer/shared";

// Rarity tier display names, shared by the species card badges and the tier grouping.
export const TIER_LABEL: Record<string, string> = {
  legendary: "Legendary",
  rare: "Rare",
  uncommon: "Uncommon",
  occasional: "Occasional",
  common: "Common",
  unrated: "Unrated",
};

// Birding-style group names ("Hawks, Eagles & Kites") keyed by real taxonomic family. Unmapped
// families fall back to the family name itself rather than an "Other" bucket.
const BIRD_FAMILY_GROUPS: Record<string, string> = {
  Anatidae: "Waterfowl",
  Anhingidae: "Anhingas",
  Phalacrocoracidae: "Cormorants",
  Pelecanidae: "Pelicans",
  Ardeidae: "Herons, Egrets & Bitterns",
  Threskiornithidae: "Ibises & Spoonbills",
  Ciconiidae: "Storks",
  Gaviidae: "Loons",
  Podicipedidae: "Grebes",
  Fregatidae: "Frigatebirds",
  Sulidae: "Boobies & Gannets",
  Accipitridae: "Hawks, Eagles & Kites",
  Pandionidae: "Ospreys",
  Falconidae: "Falcons & Caracaras",
  Strigidae: "Owls",
  Tytonidae: "Owls",
  Cathartidae: "Vultures & Condors",
  Rallidae: "Rails, Crakes & Coots",
  Gruidae: "Cranes",
  Charadriidae: "Plovers",
  Scolopacidae: "Sandpipers & Shorebirds",
  Recurvirostridae: "Stilts & Avocets",
  Haematopodidae: "Oystercatchers",
  Jacanidae: "Jacanas",
  Laridae: "Gulls & Terns",
  Stercorariidae: "Jaegers & Skuas",
  Alcidae: "Auks, Murres & Puffins",
  Columbidae: "Pigeons & Doves",
  Cuculidae: "Cuckoos & Roadrunners",
  Caprimulgidae: "Nightjars",
  Apodidae: "Swifts",
  Trochilidae: "Hummingbirds",
  Rallinae: "Rails",
  Alcedinidae: "Kingfishers",
  Picidae: "Woodpeckers",
  Tyrannidae: "Tyrant Flycatchers",
  Laniidae: "Shrikes",
  Vireonidae: "Vireos",
  Corvidae: "Crows, Jays & Magpies",
  Alaudidae: "Larks",
  Hirundinidae: "Swallows",
  Paridae: "Chickadees & Titmice",
  Sittidae: "Nuthatches",
  Certhiidae: "Treecreepers",
  Troglodytidae: "Wrens",
  Polioptilidae: "Gnatcatchers",
  Sturnidae: "Starlings",
  Turdidae: "Thrushes",
  Mimidae: "Mockingbirds & Thrashers",
  Bombycillidae: "Waxwings",
  Ptiliogonatidae: "Silky-flycatchers",
  Passerellidae: "New World Sparrows",
  Emberizidae: "Old World Buntings",
  Icteriidae: "Yellowthroats",
  Icteridae: "Blackbirds & Orioles",
  Parulidae: "Wood-Warblers",
  Cardinalidae: "Cardinals & Grosbeaks",
  Fringillidae: "Finches",
  Passeridae: "Old World Sparrows",
  Motacillidae: "Pipits & Wagtails",
  Phasianidae: "Grouse, Quail & Pheasants",
  Odontophoridae: "New World Quail",
  Podargidae: "Frogmouths",
  Psittacidae: "Parrots",
  Ramphastidae: "Toucans",
  Trogonidae: "Trogons",
  Bucconidae: "Puffbirds",
  Thraupidae: "Tanagers",
  Furnariidae: "Ovenbirds & Woodcreepers",
  Thamnophilidae: "Antbirds",
  Cotingidae: "Cotingas",
  Pipridae: "Manakins",
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
  if (isOtherTaxa) return inatIconicTaxon ? otherTaxaGroupLabel(inatIconicTaxon, namingStyles ?? []) : "Other";
  if (family && taxonClass === "aves" && BIRD_FAMILY_GROUPS[family]) return BIRD_FAMILY_GROUPS[family];
  return family ?? "Other";
}

export { BIRD_FAMILY_GROUPS };
