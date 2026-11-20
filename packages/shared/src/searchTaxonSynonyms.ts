// Plain-language group words ("raptor", "frog", "shorebird") mapped to taxon_class, taxon_order or
// family (lowercased). Latin order and family names are recognized separately, from the catalog.
export interface GroupPredicate {
  classes?: string[];
  orders?: string[];
  families?: string[];
  excludeOrders?: string[];
  excludeFamilies?: string[];
  excludeClasses?: string[];
  /** Words in the common name that rule a species out ("duck" is the duck family minus geese). */
  excludeNameWords?: string[];
  /** Words the common name must contain. */
  includeNameWords?: string[];
  /** A diet or habitat word across many orders ("predators"): for search, not an album theme. */
  broad?: boolean;
}

const SNAKE_FAMILIES = [
  "colubridae",
  "viperidae",
  "boidae",
  "elapidae",
  "pythonidae",
  "natricidae",
  "dipsadidae",
  "lamprophiidae",
  "typhlopidae",
  "leptotyphlopidae",
];
const RAPTOR_ORDERS = ["accipitriformes", "falconiformes", "strigiformes", "cathartiformes"];

const GROUPS: Array<[string[], GroupPredicate]> = [
  [["bird", "birds", "aves"], { classes: ["aves"] }],
  [["mammal", "mammals"], { classes: ["mammalia", "aquatic_mammalia"] }],
  [["fish", "fishes"], { classes: ["actinopterygii", "elasmobranchii"] }],
  [["shark", "sharks", "ray", "rays", "skate", "skates"], { classes: ["elasmobranchii"] }],
  [
    ["whale", "whales", "dolphin", "dolphins", "porpoise", "porpoises", "marine mammal", "marine mammals"],
    { classes: ["aquatic_mammalia"] },
  ],
  [["seal", "seals", "sea lion", "sea lions"], { families: ["phocidae", "otariidae"] }],
  [["amphibian", "amphibians"], { classes: ["amphibia"] }],
  [["frog", "frogs", "toad", "toads"], { orders: ["anura"] }],
  [["salamander", "salamanders", "newt", "newts"], { orders: ["caudata", "urodela"] }],
  [["reptile", "reptiles"], { classes: ["squamata", "testudines"] }],
  [["snake", "snakes", "serpent", "serpents"], { families: SNAKE_FAMILIES }],
  [["lizard", "lizards"], { classes: ["squamata"], excludeFamilies: SNAKE_FAMILIES, excludeOrders: ["crocodylia"] }],
  [
    ["crocodile", "crocodiles", "alligator", "alligators", "caiman", "caimans", "crocodilian", "crocodilians"],
    { orders: ["crocodylia"] },
  ],
  [["turtle", "turtles", "tortoise", "tortoises", "terrapin", "terrapins"], { classes: ["testudines"] }],
  [["raptor", "raptors", "bird of prey", "birds of prey"], { orders: RAPTOR_ORDERS }],
  [["owl", "owls"], { orders: ["strigiformes"] }],
  // Broad diet words, kept to groups where nearly every species fits. Predators: carnivorans, raptors
  // except the scavenging New World vultures, crocodilians and snakes; pandas are left out.
  [
    ["predator", "predators", "apex predator", "apex predators"],
    {
      orders: ["carnivora", "accipitriformes", "falconiformes", "strigiformes", "crocodylia"],
      families: SNAKE_FAMILIES,
      excludeFamilies: ["ailuridae"],
      excludeNameWords: ["panda"],
      broad: true,
    },
  ],
  // Grazers and browsers: hoofed animals but pigs and peccaries (omnivores), elephants, rabbits and
  // hares, manatees, hyraxes, kangaroos, wombats and koalas. Whales sit in Artiodactyla in some
  // taxonomies, so marine mammals are left out by class.
  [
    ["herbivore", "herbivores", "grazer", "grazers"],
    {
      orders: [
        "artiodactyla",
        "cetartiodactyla",
        "perissodactyla",
        "proboscidea",
        "lagomorpha",
        "sirenia",
        "hyracoidea",
      ],
      families: ["macropodidae", "vombatidae", "phascolarctidae"],
      excludeFamilies: ["suidae", "tayassuidae"],
      excludeClasses: ["aquatic_mammalia"],
      broad: true,
    },
  ],
  // Birds of wetlands and coasts: waterfowl, loons, grebes, pelicans and herons, cormorants, storks,
  // cranes and rails, flamingos, shorebirds and gulls, tubenoses and penguins.
  [
    ["waterbird", "waterbirds", "water bird", "water birds"],
    {
      orders: [
        "anseriformes",
        "gaviiformes",
        "podicipediformes",
        "pelecaniformes",
        "suliformes",
        "ciconiiformes",
        "gruiformes",
        "phoenicopteriformes",
        "charadriiformes",
        "procellariiformes",
        "sphenisciformes",
      ],
      broad: true,
    },
  ],
  [
    ["wading bird", "wading birds"],
    { families: ["ardeidae", "ciconiidae", "threskiornithidae", "gruidae", "phoenicopteridae"], broad: true },
  ],
  [["waterfowl"], { orders: ["anseriformes"] }],
  // Most ducks aren't called "duck" (Mallard, Bufflehead, Scaup), so it's the family.
  [["duck", "ducks"], { families: ["anatidae"], excludeNameWords: ["goose", "geese", "swan", "swans", "brant"] }],
  [["goose", "geese"], { families: ["anatidae"], includeNameWords: ["goose", "geese", "brant"] }],
  [
    ["shorebird", "shorebirds", "wader", "waders"],
    {
      families: [
        "scolopacidae",
        "charadriidae",
        "haematopodidae",
        "recurvirostridae",
        "jacanidae",
        "burhinidae",
        "glareolidae",
      ],
    },
  ],
  [
    ["songbird", "songbirds", "passerine", "passerines", "perching bird", "perching birds"],
    { orders: ["passeriformes"] },
  ],
  [
    ["seabird", "seabirds"],
    {
      orders: ["procellariiformes", "sphenisciformes"],
      families: ["laridae", "alcidae", "stercorariidae", "sulidae", "fregatidae", "phaethontidae"],
    },
  ],
  [["gamebird", "gamebirds", "game bird", "game birds", "upland bird", "upland birds"], { orders: ["galliformes"] }],
  [["woodpecker", "woodpeckers"], { families: ["picidae"] }],
  [["corvid", "corvids", "crow family"], { families: ["corvidae"] }],
  [["hummingbird", "hummingbirds"], { families: ["trochilidae"] }],
  [["rodent", "rodents"], { orders: ["rodentia"] }],
  [["bat", "bats"], { orders: ["chiroptera"] }],
  [["carnivore", "carnivores"], { orders: ["carnivora"] }],
  [
    ["ungulate", "ungulates", "hoofed animal", "hoofed animals"],
    { orders: ["artiodactyla", "perissodactyla", "cetartiodactyla"] },
  ],
  [["primate", "primates", "monkey", "monkeys"], { orders: ["primates"] }],
  [["marsupial", "marsupials"], { orders: ["didelphimorphia", "diprotodontia", "dasyuromorphia", "peramelemorphia"] }],
  [["cat family", "feline", "felines", "wild cat", "wild cats"], { families: ["felidae"] }],
  [["dog family", "canine", "canines", "canid", "canids"], { families: ["canidae"] }],
  [["weasel family", "mustelid", "mustelids"], { families: ["mustelidae"] }],
  [["deer family", "cervid", "cervids"], { families: ["cervidae"] }],
  [["insect", "insects", "bug", "bugs"], { classes: ["insecta"] }],
  [["butterfly", "butterflies", "moth", "moths"], { orders: ["lepidoptera"] }],
  [["dragonfly", "dragonflies", "damselfly", "damselflies"], { orders: ["odonata"] }],
  [["beetle", "beetles"], { orders: ["coleoptera"] }],
  [["bee", "bees", "wasp", "wasps", "ant", "ants"], { orders: ["hymenoptera"] }],
  [["spider", "spiders"], { orders: ["araneae"] }],
  [["arachnid", "arachnids"], { classes: ["arachnida"] }],
  [["plant", "plants", "flower", "flowers", "wildflower", "wildflowers"], { classes: ["plantae"] }],
  [["mushroom", "mushrooms", "fungus", "fungi"], { classes: ["fungi"] }],
  [["coral", "corals"], { classes: ["corals"] }],
  [["jellyfish", "jelly", "jellies", "anemone", "anemones"], { classes: ["jellies_and_anemones"] }],
  [
    ["starfish", "sea star", "sea stars", "urchin", "urchins", "sand dollar", "sand dollars"],
    { classes: ["echinodermata"] },
  ],
  [["nudibranch", "nudibranchs", "sea slug", "sea slugs"], { classes: ["nudibranchs"] }],
  [
    ["mollusk", "mollusks", "mollusc", "molluscs", "shell", "shells", "snail", "snails", "clam", "clams"],
    { classes: ["marine_mollusks"] },
  ],
  [["octopus", "octopuses", "squid", "cuttlefish", "cephalopod", "cephalopods"], { classes: ["cephalopoda"] }],
  [["crab", "crabs", "lobster", "lobsters", "shrimp", "crustacean", "crustaceans"], { classes: ["crustacea"] }],
  [["sponge", "sponges", "tunicate", "tunicates"], { classes: ["sponges_tunicates_other"] }],
];

/** Phrase ("birds of prey") to the group it names. */
export const GROUP_TERMS: Map<string, { label: string; predicate: GroupPredicate }> = new Map(
  GROUPS.flatMap(([words, predicate]) => words.map((w) => [w, { label: words[1] ?? words[0], predicate }] as const)),
);

/** Longest phrase in GROUP_TERMS, in words, so matching can try the longest n-gram first. */
export const MAX_GROUP_TERM_WORDS = Math.max(...[...GROUP_TERMS.keys()].map((k) => k.split(" ").length));

export function speciesInGroup(
  species: { taxonClass: string | null; taxonOrder: string | null; family: string | null; commonName?: string | null },
  p: GroupPredicate,
): boolean {
  const cls = species.taxonClass?.toLowerCase() ?? "";
  const order = species.taxonOrder?.toLowerCase() ?? "";
  const family = species.family?.toLowerCase() ?? "";
  if (p.excludeFamilies?.includes(family) || p.excludeOrders?.includes(order) || p.excludeClasses?.includes(cls))
    return false;
  if (p.excludeNameWords || p.includeNameWords) {
    const nameWords = (species.commonName ?? "").toLowerCase().split(/[^\p{L}]+/u);
    if (p.excludeNameWords?.some((w) => nameWords.includes(w))) return false;
    if (p.includeNameWords && !p.includeNameWords.some((w) => nameWords.includes(w))) return false;
  }
  return !!(p.classes?.includes(cls) || p.orders?.includes(order) || p.families?.includes(family));
}
