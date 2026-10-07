import i18n from "../i18n";
import { taxonClassLabel } from "./speciesGroups";

// Everyday groups people search by ("Raptors", "Frogs & Toads"), from the family or order. A species
// can be in several; grouping uses the first. Others fall back to e.g. "Other Birds". The tables
// hold message keys (taxa.groups.*); the functions return the names in the active language.

type Rule = { groups: string[]; families?: string[]; orders?: string[] };

const BIRD_RULES: Rule[] = [
  {
    groups: ["taxa.groups.owls", "taxa.groups.raptors"],
    families: ["Strigidae", "Tytonidae"],
    orders: ["Strigiformes"],
  },
  {
    groups: ["taxa.groups.raptors"],
    families: ["Accipitridae", "Pandionidae", "Falconidae", "Cathartidae", "Sagittariidae"],
    orders: ["Accipitriformes", "Falconiformes", "Cathartiformes"],
  },
  { groups: ["taxa.groups.waterfowl"], families: ["Anatidae", "Anhimidae", "Anseranatidae"], orders: ["Anseriformes"] },
  {
    groups: ["taxa.groups.shorebirds"],
    families: [
      "Charadriidae",
      "Scolopacidae",
      "Recurvirostridae",
      "Haematopodidae",
      "Jacanidae",
      "Burhinidae",
      "Glareolidae",
      "Rostratulidae",
      "Thinocoridae",
      "Pluvianellidae",
      "Chionidae",
      "Ibidorhynchidae",
      "Dromadidae",
      "Pedionomidae",
      "Pluvianidae",
    ],
  },
  { groups: ["taxa.groups.gullsTerns", "taxa.groups.seabirds"], families: ["Laridae"] },
  {
    groups: ["taxa.groups.seabirds"],
    families: [
      "Procellariidae",
      "Hydrobatidae",
      "Oceanitidae",
      "Diomedeidae",
      "Pelecanoididae",
      "Sulidae",
      "Fregatidae",
      "Phaethontidae",
      "Alcidae",
      "Stercorariidae",
      "Spheniscidae",
    ],
    orders: ["Procellariiformes", "Sphenisciformes", "Phaethontiformes"],
  },
  { groups: ["taxa.groups.cormorantsPelicans"], families: ["Phalacrocoracidae", "Pelecanidae", "Anhingidae"] },
  {
    groups: ["taxa.groups.heronsWaders"],
    families: [
      "Ardeidae",
      "Threskiornithidae",
      "Ciconiidae",
      "Balaenicipitidae",
      "Scopidae",
      "Phoenicopteridae",
      "Gruidae",
      "Aramidae",
    ],
    orders: ["Ciconiiformes", "Phoenicopteriformes"],
  },
  { groups: ["taxa.groups.railsCoots"], families: ["Rallidae", "Heliornithidae", "Sarothruridae"] },
  {
    groups: ["taxa.groups.loonsGrebes"],
    families: ["Gaviidae", "Podicipedidae"],
    orders: ["Gaviiformes", "Podicipediformes"],
  },
  {
    groups: ["taxa.groups.gamebirds"],
    families: ["Phasianidae", "Odontophoridae", "Numididae", "Cracidae", "Megapodiidae", "Tinamidae"],
    orders: ["Galliformes", "Tinamiformes"],
  },
  { groups: ["taxa.groups.pigeonsDoves"], families: ["Columbidae"], orders: ["Columbiformes"] },
  { groups: ["taxa.groups.hummingbirds"], families: ["Trochilidae"] },
  { groups: ["taxa.groups.swifts"], families: ["Apodidae", "Hemiprocnidae"] },
  {
    groups: ["taxa.groups.nightjarsPotoos"],
    families: ["Caprimulgidae", "Nyctibiidae", "Podargidae", "Aegothelidae", "Steatornithidae"],
    orders: ["Caprimulgiformes", "Nyctibiiformes", "Podargiformes", "Aegotheliformes", "Steatornithiformes"],
  },
  { groups: ["taxa.groups.woodpeckers"], families: ["Picidae"] },
  {
    groups: ["taxa.groups.toucansBarbets"],
    families: ["Ramphastidae", "Capitonidae", "Semnornithidae", "Lybiidae", "Megalaimidae"],
  },
  { groups: ["taxa.groups.kingfishers"], families: ["Alcedinidae"] },
  {
    groups: ["taxa.groups.motmotsBeeEatersRollers"],
    families: ["Momotidae", "Meropidae", "Coraciidae", "Brachypteraciidae", "Todidae"],
  },
  { groups: ["taxa.groups.trogons"], families: ["Trogonidae"], orders: ["Trogoniformes"] },
  { groups: ["taxa.groups.puffbirdsJacamars"], families: ["Bucconidae", "Galbulidae"] },
  {
    groups: ["taxa.groups.hornbillsHoopoes"],
    families: ["Bucerotidae", "Bucorvidae", "Upupidae", "Phoeniculidae"],
    orders: ["Bucerotiformes"],
  },
  {
    groups: ["taxa.groups.parrots"],
    families: ["Psittacidae", "Psittaculidae", "Cacatuidae", "Strigopidae", "Nestoridae"],
    orders: ["Psittaciformes"],
  },
  { groups: ["taxa.groups.cuckoos"], families: ["Cuculidae"], orders: ["Cuculiformes"] },
  { groups: ["taxa.groups.songbirds"], orders: ["Passeriformes"] },
];

const MAMMAL_RULES: Rule[] = [
  { groups: ["taxa.groups.cats"], families: ["Felidae"] },
  { groups: ["taxa.groups.dogsFoxes"], families: ["Canidae"] },
  { groups: ["taxa.groups.bears"], families: ["Ursidae"] },
  { groups: ["taxa.groups.weaselsOtters"], families: ["Mustelidae"] },
  { groups: ["taxa.groups.sealsSeaLions"], families: ["Phocidae", "Otariidae", "Odobenidae"] },
  {
    groups: ["taxa.groups.whalesDolphins"],
    families: [
      "Delphinidae",
      "Phocoenidae",
      "Physeteridae",
      "Kogiidae",
      "Monodontidae",
      "Ziphiidae",
      "Hyperoodontidae",
      "Balaenidae",
      "Balaenopteridae",
      "Eschrichtiidae",
      "Neobalaenidae",
      "Platanistidae",
      "Iniidae",
      "Pontoporiidae",
      "Lipotidae",
    ],
    orders: ["Cetacea"],
  },
  { groups: ["taxa.groups.manateesDugongs"], orders: ["Sirenia"] },
  {
    groups: ["taxa.groups.hoofedMammals"],
    families: [
      "Bovidae",
      "Cervidae",
      "Suidae",
      "Giraffidae",
      "Camelidae",
      "Tragulidae",
      "Moschidae",
      "Tayassuidae",
      "Hippopotamidae",
      "Antilocapridae",
      "Equidae",
      "Rhinocerotidae",
      "Tapiridae",
    ],
    orders: ["Perissodactyla"],
  },
  { groups: ["taxa.groups.bats"], orders: ["Chiroptera"] },
  { groups: ["taxa.groups.rodents"], orders: ["Rodentia"] },
  { groups: ["taxa.groups.primates"], orders: ["Primates"] },
  { groups: ["taxa.groups.rabbitsHares"], orders: ["Lagomorpha"] },
  { groups: ["taxa.groups.shrewsMolesHedgehogs"], orders: ["Eulipotyphla", "Soricomorpha", "Erinaceomorpha"] },
  {
    groups: ["taxa.groups.marsupials"],
    orders: [
      "Diprotodontia",
      "Didelphimorphia",
      "Dasyuromorphia",
      "Peramelemorphia",
      "Paucituberculata",
      "Microbiotheria",
      "Notoryctemorphia",
    ],
  },
  { groups: ["taxa.groups.armadillosAnteatersSloths"], orders: ["Cingulata", "Pilosa"] },
  { groups: ["taxa.groups.otherCarnivores"], orders: ["Carnivora"] },
];

const SNAKE_FAMILIES = [
  "Colubridae",
  "Elapidae",
  "Viperidae",
  "Typhlopidae",
  "Leptotyphlopidae",
  "Lamprophiidae",
  "Pseudoxyrhophiidae",
  "Boidae",
  "Atractaspididae",
  "Uropeltidae",
  "Homalopsidae",
  "Pythonidae",
  "Psammophiidae",
  "Pareidae",
  "Xenodermidae",
  "Tropidophiidae",
  "Gerrhopilidae",
  "Anomalepididae",
  "Prosymnidae",
  "Cylindrophiidae",
  "Cyclocoridae",
  "Acrochordidae",
  "Pseudaspididae",
  "Anomochilidae",
  "Xenopeltidae",
  "Xenophidiidae",
  "Bolyeriidae",
  "Loxocemidae",
  "Aniliidae",
  "Xenotyphlopidae",
  "Natricidae",
  "Dipsadidae",
  "Calamariidae",
  "Sibynophiidae",
  "Grayiidae",
];

const REPTILE_RULES: Rule[] = [
  { groups: ["taxa.groups.snakes"], families: SNAKE_FAMILIES },
  { groups: ["taxa.groups.crocodilians"], families: ["Crocodylidae", "Alligatoridae", "Gavialidae"] },
];

const AMPHIBIAN_RULES: Rule[] = [
  { groups: ["taxa.groups.frogsToads"], orders: ["Anura"] },
  { groups: ["taxa.groups.salamandersNewts"], orders: ["Caudata"] },
  { groups: ["taxa.groups.caecilians"], orders: ["Gymnophiona"] },
];

const RULES: Partial<Record<string, { rules: Rule[]; other: string }>> = {
  aves: { rules: BIRD_RULES, other: "taxa.groups.otherBirds" },
  mammalia: { rules: MAMMAL_RULES, other: "taxa.groups.otherMammals" },
  squamata: { rules: REPTILE_RULES, other: "taxa.groups.lizards" },
  amphibia: { rules: AMPHIBIAN_RULES, other: "taxa.groups.otherAmphibians" },
};

function index(rules: Rule[]) {
  const byFamily = new Map<string, string[]>();
  const byOrder = new Map<string, string[]>();
  for (const r of rules) {
    for (const f of r.families ?? []) if (!byFamily.has(f)) byFamily.set(f, r.groups);
    for (const o of r.orders ?? []) if (!byOrder.has(o)) byOrder.set(o, r.groups);
  }
  return { byFamily, byOrder };
}
const INDEXES = new Map(Object.entries(RULES).map(([cls, v]) => [cls, { ...index(v!.rules), other: v!.other }]));

export interface BroadGroupSource {
  taxonClass: string | null;
  taxonOrder?: string | null;
  family: string | null;
  isOtherTaxa?: boolean;
}

/** Every broad group the species is in, most specific first; empty when none fits. */
export function broadGroups(item: BroadGroupSource): string[] {
  return broadGroupKeys(item).map((k) => i18n.t(k));
}

function broadGroupKeys(item: BroadGroupSource): string[] {
  if (item.isOtherTaxa || !item.taxonClass) return [];
  if (item.taxonClass === "testudines") return ["taxa.groups.turtles"];
  const idx = INDEXES.get(item.taxonClass);
  if (!idx) return [];
  return (
    (item.family ? idx.byFamily.get(item.family) : undefined) ??
    (item.taxonOrder ? idx.byOrder.get(item.taxonOrder) : undefined) ??
    []
  );
}

/** The one group a species is shown under when grouping by broad group. */
export function primaryBroadGroup(item: BroadGroupSource): string {
  const [first] = broadGroups(item);
  if (first) return first;
  if (item.isOtherTaxa) return i18n.t("taxa.otherTaxa");
  const cls = item.taxonClass ?? "";
  const other = INDEXES.get(cls)?.other;
  return other ? i18n.t(other) : (taxonClassLabel(cls) ?? i18n.t("taxa.other"));
}
