import { TAXON_CLASS_LABEL, type TaxonClass } from "@lifer/shared";

// Everyday groups people search by ("Raptors", "Frogs & Toads"), from the family or order. A species
// can be in several; grouping uses the first. Others fall back to e.g. "Other Birds".

type Rule = { groups: string[]; families?: string[]; orders?: string[] };

const BIRD_RULES: Rule[] = [
  { groups: ["Owls", "Raptors"], families: ["Strigidae", "Tytonidae"], orders: ["Strigiformes"] },
  {
    groups: ["Raptors"],
    families: ["Accipitridae", "Pandionidae", "Falconidae", "Cathartidae", "Sagittariidae"],
    orders: ["Accipitriformes", "Falconiformes", "Cathartiformes"],
  },
  { groups: ["Waterfowl"], families: ["Anatidae", "Anhimidae", "Anseranatidae"], orders: ["Anseriformes"] },
  {
    groups: ["Shorebirds"],
    families: [
      "Charadriidae", "Scolopacidae", "Recurvirostridae", "Haematopodidae", "Jacanidae", "Burhinidae", "Glareolidae",
      "Rostratulidae", "Thinocoridae", "Pluvianellidae", "Chionidae", "Ibidorhynchidae", "Dromadidae", "Pedionomidae", "Pluvianidae",
    ],
  },
  { groups: ["Gulls & Terns", "Seabirds"], families: ["Laridae"] },
  {
    groups: ["Seabirds"],
    families: [
      "Procellariidae", "Hydrobatidae", "Oceanitidae", "Diomedeidae", "Pelecanoididae", "Sulidae", "Fregatidae",
      "Phaethontidae", "Alcidae", "Stercorariidae", "Spheniscidae",
    ],
    orders: ["Procellariiformes", "Sphenisciformes", "Phaethontiformes"],
  },
  { groups: ["Cormorants & Pelicans"], families: ["Phalacrocoracidae", "Pelecanidae", "Anhingidae"] },
  {
    groups: ["Herons & Waders"],
    families: ["Ardeidae", "Threskiornithidae", "Ciconiidae", "Balaenicipitidae", "Scopidae", "Phoenicopteridae", "Gruidae", "Aramidae"],
    orders: ["Ciconiiformes", "Phoenicopteriformes"],
  },
  { groups: ["Rails & Coots"], families: ["Rallidae", "Heliornithidae", "Sarothruridae"] },
  { groups: ["Loons & Grebes"], families: ["Gaviidae", "Podicipedidae"], orders: ["Gaviiformes", "Podicipediformes"] },
  {
    groups: ["Gamebirds"],
    families: ["Phasianidae", "Odontophoridae", "Numididae", "Cracidae", "Megapodiidae", "Tinamidae"],
    orders: ["Galliformes", "Tinamiformes"],
  },
  { groups: ["Pigeons & Doves"], families: ["Columbidae"], orders: ["Columbiformes"] },
  { groups: ["Hummingbirds"], families: ["Trochilidae"] },
  { groups: ["Swifts"], families: ["Apodidae", "Hemiprocnidae"] },
  {
    groups: ["Nightjars & Potoos"],
    families: ["Caprimulgidae", "Nyctibiidae", "Podargidae", "Aegothelidae", "Steatornithidae"],
    orders: ["Caprimulgiformes", "Nyctibiiformes", "Podargiformes", "Aegotheliformes", "Steatornithiformes"],
  },
  { groups: ["Woodpeckers"], families: ["Picidae"] },
  { groups: ["Toucans & Barbets"], families: ["Ramphastidae", "Capitonidae", "Semnornithidae", "Lybiidae", "Megalaimidae"] },
  { groups: ["Kingfishers"], families: ["Alcedinidae"] },
  { groups: ["Motmots, Bee-eaters & Rollers"], families: ["Momotidae", "Meropidae", "Coraciidae", "Brachypteraciidae", "Todidae"] },
  { groups: ["Trogons"], families: ["Trogonidae"], orders: ["Trogoniformes"] },
  { groups: ["Puffbirds & Jacamars"], families: ["Bucconidae", "Galbulidae"] },
  { groups: ["Hornbills & Hoopoes"], families: ["Bucerotidae", "Bucorvidae", "Upupidae", "Phoeniculidae"], orders: ["Bucerotiformes"] },
  { groups: ["Parrots"], families: ["Psittacidae", "Psittaculidae", "Cacatuidae", "Strigopidae", "Nestoridae"], orders: ["Psittaciformes"] },
  { groups: ["Cuckoos"], families: ["Cuculidae"], orders: ["Cuculiformes"] },
  { groups: ["Songbirds"], orders: ["Passeriformes"] },
];

const MAMMAL_RULES: Rule[] = [
  { groups: ["Cats"], families: ["Felidae"] },
  { groups: ["Dogs & Foxes"], families: ["Canidae"] },
  { groups: ["Bears"], families: ["Ursidae"] },
  { groups: ["Weasels & Otters"], families: ["Mustelidae"] },
  { groups: ["Seals & Sea Lions"], families: ["Phocidae", "Otariidae", "Odobenidae"] },
  {
    groups: ["Whales & Dolphins"],
    families: [
      "Delphinidae", "Phocoenidae", "Physeteridae", "Kogiidae", "Monodontidae", "Ziphiidae", "Hyperoodontidae", "Balaenidae",
      "Balaenopteridae", "Eschrichtiidae", "Neobalaenidae", "Platanistidae", "Iniidae", "Pontoporiidae", "Lipotidae",
    ],
    orders: ["Cetacea"],
  },
  { groups: ["Manatees & Dugongs"], orders: ["Sirenia"] },
  {
    groups: ["Hoofed Mammals"],
    families: [
      "Bovidae", "Cervidae", "Suidae", "Giraffidae", "Camelidae", "Tragulidae", "Moschidae", "Tayassuidae", "Hippopotamidae",
      "Antilocapridae", "Equidae", "Rhinocerotidae", "Tapiridae",
    ],
    orders: ["Perissodactyla"],
  },
  { groups: ["Bats"], orders: ["Chiroptera"] },
  { groups: ["Rodents"], orders: ["Rodentia"] },
  { groups: ["Primates"], orders: ["Primates"] },
  { groups: ["Rabbits & Hares"], orders: ["Lagomorpha"] },
  { groups: ["Shrews, Moles & Hedgehogs"], orders: ["Eulipotyphla", "Soricomorpha", "Erinaceomorpha"] },
  {
    groups: ["Marsupials"],
    orders: ["Diprotodontia", "Didelphimorphia", "Dasyuromorphia", "Peramelemorphia", "Paucituberculata", "Microbiotheria", "Notoryctemorphia"],
  },
  { groups: ["Armadillos, Anteaters & Sloths"], orders: ["Cingulata", "Pilosa"] },
  { groups: ["Other Carnivores"], orders: ["Carnivora"] },
];

const SNAKE_FAMILIES = [
  "Colubridae", "Elapidae", "Viperidae", "Typhlopidae", "Leptotyphlopidae", "Lamprophiidae", "Pseudoxyrhophiidae", "Boidae",
  "Atractaspididae", "Uropeltidae", "Homalopsidae", "Pythonidae", "Psammophiidae", "Pareidae", "Xenodermidae", "Tropidophiidae",
  "Gerrhopilidae", "Anomalepididae", "Prosymnidae", "Cylindrophiidae", "Cyclocoridae", "Acrochordidae", "Pseudaspididae",
  "Anomochilidae", "Xenopeltidae", "Xenophidiidae", "Bolyeriidae", "Loxocemidae", "Aniliidae", "Xenotyphlopidae", "Natricidae",
  "Dipsadidae", "Calamariidae", "Sibynophiidae", "Grayiidae",
];

const REPTILE_RULES: Rule[] = [
  { groups: ["Snakes"], families: SNAKE_FAMILIES },
  { groups: ["Crocodilians"], families: ["Crocodylidae", "Alligatoridae", "Gavialidae"] },
];

const AMPHIBIAN_RULES: Rule[] = [
  { groups: ["Frogs & Toads"], orders: ["Anura"] },
  { groups: ["Salamanders & Newts"], orders: ["Caudata"] },
  { groups: ["Caecilians"], orders: ["Gymnophiona"] },
];

const RULES: Partial<Record<string, { rules: Rule[]; other: string }>> = {
  aves: { rules: BIRD_RULES, other: "Other Birds" },
  mammalia: { rules: MAMMAL_RULES, other: "Other Mammals" },
  squamata: { rules: REPTILE_RULES, other: "Lizards" },
  amphibia: { rules: AMPHIBIAN_RULES, other: "Other Amphibians" },
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
  if (item.isOtherTaxa || !item.taxonClass) return [];
  if (item.taxonClass === "testudines") return ["Turtles"];
  const idx = INDEXES.get(item.taxonClass);
  if (!idx) return [];
  return (item.family ? idx.byFamily.get(item.family) : undefined) ?? (item.taxonOrder ? idx.byOrder.get(item.taxonOrder) : undefined) ?? [];
}

/** The one group a species is shown under when grouping by broad group. */
export function primaryBroadGroup(item: BroadGroupSource): string {
  const [first] = broadGroups(item);
  if (first) return first;
  if (item.isOtherTaxa) return "Other Taxa";
  const cls = item.taxonClass ?? "";
  return INDEXES.get(cls)?.other ?? TAXON_CLASS_LABEL[cls as TaxonClass] ?? "Other";
}
