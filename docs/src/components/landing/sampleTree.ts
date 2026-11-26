// Sample data for the landing page's Tree of life demo: real group and species names, but the
// photographed, rarity and target marks are made up. Not counts from anyone's collection.

export const TIERS = ["common", "occasional", "uncommon", "rare", "legendary"] as const;
export type Tier = (typeof TIERS)[number];

export interface TreeNode {
  id: string;
  name: string;
  latin?: string;
  rank: "life" | "class" | "order" | "family" | "species";
  children: TreeNode[];
  parent: TreeNode | null;
  /** Catalogue species, photographed species and targets under the node. */
  total: number;
  collected: number;
  targets: number;
  /** Rated species per tier. */
  tiers: Partial<Record<Tier, number>>;
  /** Layout: a span of species along the circle, and the ring depth (life is 0). */
  x0: number;
  x1: number;
  depth: number;
}

type Family = [name: string, latin: string, species: string];
type Order = [name: string, latin: string, families: Family[]];
type Class = [name: string, latin: string, orders: Order[], rated: boolean];

const DATA: Class[] = [
  [
    "Birds",
    "Aves",
    [
      [
        "Perching birds",
        "Passeriformes",
        [
          [
            "Tyrant flycatchers",
            "Tyrannidae",
            "Great Kiskadee, Social Flycatcher, Tropical Kingbird, Vermilion Flycatcher, Eastern Phoebe, Least Flycatcher, Great Crested Flycatcher, Scissor-tailed Flycatcher",
          ],
          [
            "New World warblers",
            "Parulidae",
            "Yellow Warbler, Magnolia Warbler, Black-and-white Warbler, American Redstart, Hooded Warbler, Common Yellowthroat, Prothonotary Warbler, Blackburnian Warbler, Golden-winged Warbler, Kirtland's Warbler",
          ],
          [
            "Tanagers",
            "Thraupidae",
            "Blue-gray Tanager, Red-legged Honeycreeper, Green Honeycreeper, Golden-hooded Tanager, Bananaquit, Yellow-faced Grassquit",
          ],
          [
            "Thrushes",
            "Turdidae",
            "American Robin, Wood Thrush, Clay-colored Thrush, Hermit Thrush, Eastern Bluebird, Swainson's Thrush",
          ],
          ["Swallows", "Hirundinidae", "Barn Swallow, Tree Swallow, Mangrove Swallow, Cliff Swallow"],
          ["Crows and jays", "Corvidae", "Blue Jay, Brown Jay, Common Raven, Yucatan Jay"],
          ["Wrens", "Troglodytidae", "Carolina Wren, House Wren, Spot-breasted Wren"],
          ["Larks", "Alaudidae", "Horned Lark"],
          ["Waxwings", "Bombycillidae", "Cedar Waxwing"],
          ["Dippers", "Cinclidae", "American Dipper"],
        ],
      ],
      [
        "Herons, ibises and pelicans",
        "Pelecaniformes",
        [
          [
            "Herons",
            "Ardeidae",
            "Great Blue Heron, Great Egret, Snowy Egret, Green Heron, Tricolored Heron, Boat-billed Heron, Bare-throated Tiger-Heron",
          ],
          ["Ibises and spoonbills", "Threskiornithidae", "White Ibis, Roseate Spoonbill"],
          ["Pelicans", "Pelecanidae", "Brown Pelican, American White Pelican"],
        ],
      ],
      [
        "Shorebirds",
        "Charadriiformes",
        [
          ["Sandpipers", "Scolopacidae", "Sanderling, Spotted Sandpiper, Least Sandpiper, Willet"],
          ["Gulls and terns", "Laridae", "Laughing Gull, Royal Tern, Black Skimmer"],
          ["Plovers", "Charadriidae", "Killdeer, Wilson's Plover"],
          ["Auks", "Alcidae", "Atlantic Puffin"],
        ],
      ],
      [
        "Owls",
        "Strigiformes",
        [
          [
            "Typical owls",
            "Strigidae",
            "Great Horned Owl, Snowy Owl, Spectacled Owl, Mottled Owl, Ferruginous Pygmy-Owl, Burrowing Owl, Barred Owl",
          ],
          ["Barn owls", "Tytonidae", "Barn Owl"],
        ],
      ],
      [
        "Toucans and woodpeckers",
        "Piciformes",
        [
          [
            "Woodpeckers",
            "Picidae",
            "Pileated Woodpecker, Golden-fronted Woodpecker, Downy Woodpecker, Lineated Woodpecker, Northern Flicker",
          ],
          ["Toucans", "Ramphastidae", "Keel-billed Toucan, Collared Aracari, Emerald Toucanet"],
        ],
      ],
      [
        "Hawks and eagles",
        "Accipitriformes",
        [
          [
            "Hawks and eagles",
            "Accipitridae",
            "Roadside Hawk, Bald Eagle, Red-tailed Hawk, Harpy Eagle, Snail Kite, Swallow-tailed Kite",
          ],
          ["Ospreys", "Pandionidae", "Osprey"],
        ],
      ],
      [
        "Hummingbirds and swifts",
        "Apodiformes",
        [
          [
            "Hummingbirds",
            "Trochilidae",
            "Ruby-throated Hummingbird, Rufous-tailed Hummingbird, White-necked Jacobin, Long-billed Hermit, Violet Sabrewing",
          ],
          ["Swifts", "Apodidae", "Chimney Swift, White-collared Swift"],
        ],
      ],
      [
        "Ducks and geese",
        "Anseriformes",
        [
          [
            "Ducks and geese",
            "Anatidae",
            "Mallard, Wood Duck, Black-bellied Whistling-Duck, Common Merganser, Harlequin Duck, Canada Goose, Muscovy Duck",
          ],
        ],
      ],
      [
        "Parrots",
        "Psittaciformes",
        [
          [
            "Parrots",
            "Psittacidae",
            "Scarlet Macaw, White-fronted Amazon, Olive-throated Parakeet, Red-lored Amazon, Yellow-headed Amazon",
          ],
        ],
      ],
      [
        "Trogons",
        "Trogoniformes",
        [["Trogons", "Trogonidae", "Resplendent Quetzal, Black-headed Trogon, Slaty-tailed Trogon"]],
      ],
      ["Loons", "Gaviiformes", [["Loons", "Gaviidae", "Common Loon"]]],
    ],
    true,
  ],
  [
    "Mammals",
    "Mammalia",
    [
      [
        "Carnivores",
        "Carnivora",
        [
          ["Cats", "Felidae", "Jaguar, Ocelot, Puma, Margay, Jaguarundi, Canada Lynx, Bobcat"],
          ["Weasels and otters", "Mustelidae", "American Mink, Neotropical Otter, Tayra, Wolverine, Sea Otter"],
          ["Dogs and foxes", "Canidae", "Gray Fox, Red Fox, Coyote, Gray Wolf, Arctic Fox"],
          ["Bears", "Ursidae", "American Black Bear, Brown Bear, Polar Bear"],
          ["Raccoons and coatis", "Procyonidae", "Raccoon, White-nosed Coati, Kinkajou"],
        ],
      ],
      [
        "Hoofed mammals",
        "Artiodactyla",
        [
          ["Deer", "Cervidae", "White-tailed Deer, Moose, Caribou, Central American Red Brocket"],
          ["Cattle, sheep and goats", "Bovidae", "Mountain Goat, Bighorn Sheep, American Bison"],
          ["Peccaries", "Tayassuidae", "Collared Peccary, White-lipped Peccary"],
        ],
      ],
      [
        "Rodents",
        "Rodentia",
        [
          ["Squirrels", "Sciuridae", "Eastern Gray Squirrel, Red Squirrel, Yucatan Squirrel, Groundhog"],
          ["Beavers", "Castoridae", "North American Beaver"],
          ["Pacas", "Cuniculidae", "Lowland Paca"],
          ["Agoutis", "Dasyproctidae", "Central American Agouti"],
        ],
      ],
      [
        "Bats",
        "Chiroptera",
        [
          ["Leaf-nosed bats", "Phyllostomidae", "Jamaican Fruit Bat, Common Vampire Bat, Honduran White Bat"],
          ["Vesper bats", "Vespertilionidae", "Little Brown Bat, Big Brown Bat, Hoary Bat"],
        ],
      ],
      ["Primates", "Primates", [["New World monkeys", "Atelidae", "Yucatan Black Howler, Geoffroy's Spider Monkey"]]],
      ["Tapirs and horses", "Perissodactyla", [["Tapirs", "Tapiridae", "Baird's Tapir"]]],
      ["Armadillos", "Cingulata", [["Armadillos", "Dasypodidae", "Nine-banded Armadillo"]]],
      ["Anteaters and sloths", "Pilosa", [["Anteaters", "Myrmecophagidae", "Northern Tamandua"]]],
    ],
    true,
  ],
  [
    "Insects",
    "Insecta",
    [
      [
        "Butterflies and moths",
        "Lepidoptera",
        [
          [
            "Brush-footed butterflies",
            "Nymphalidae",
            "Monarch, Blue Morpho, Zebra Longwing, Painted Lady, Red Admiral, Gulf Fritillary",
          ],
          ["Swallowtails", "Papilionidae", "Eastern Tiger Swallowtail, Black Swallowtail, Polydamas Swallowtail"],
          ["Silk moths", "Saturniidae", "Luna Moth, Cecropia Moth"],
        ],
      ],
      [
        "Dragonflies and damselflies",
        "Odonata",
        [
          ["Skimmers", "Libellulidae", "Twelve-spotted Skimmer, Widow Skimmer, Eastern Pondhawk"],
          ["Darners", "Aeshnidae", "Common Green Darner"],
          ["Narrow-winged damselflies", "Coenagrionidae", "Eastern Forktail"],
        ],
      ],
      [
        "Beetles",
        "Coleoptera",
        [
          ["Lady beetles", "Coccinellidae", "Seven-spotted Lady Beetle, Convergent Lady Beetle"],
          ["Scarabs", "Scarabaeidae", "Eastern Hercules Beetle"],
          ["Longhorn beetles", "Cerambycidae", "Harlequin Beetle"],
        ],
      ],
      [
        "Bees, wasps and ants",
        "Hymenoptera",
        [
          ["Bees", "Apidae", "Western Honey Bee, Common Eastern Bumble Bee"],
          ["Ants", "Formicidae", "Mexican Leafcutter Ant"],
        ],
      ],
    ],
    // Groups added from iNaturalist aren't rated, as in the app.
    false,
  ],
  [
    "Reptiles",
    "Reptilia",
    [
      [
        "Lizards and snakes",
        "Squamata",
        [
          ["Pit vipers", "Viperidae", "Terciopelo, Eyelash Viper, Timber Rattlesnake"],
          ["Colubrids", "Colubridae", "Eastern Garter Snake, Speckled Racer, Green Vine Snake"],
          ["Iguanas", "Iguanidae", "Green Iguana, Black Spiny-tailed Iguana"],
          ["Anoles", "Dactyloidae", "Brown Anole, Green Anole"],
          ["Basilisks", "Corytophanidae", "Common Basilisk, Brown Basilisk"],
          ["Boas", "Boidae", "Boa Constrictor"],
        ],
      ],
      [
        "Turtles",
        "Testudines",
        [
          ["Sea turtles", "Cheloniidae", "Green Sea Turtle, Hawksbill, Loggerhead"],
          ["Pond turtles", "Emydidae", "Painted Turtle"],
          ["Snapping turtles", "Chelydridae", "Snapping Turtle"],
        ],
      ],
      [
        "Crocodilians",
        "Crocodylia",
        [
          ["Crocodiles", "Crocodylidae", "Morelet's Crocodile, American Crocodile"],
          ["Alligators", "Alligatoridae", "American Alligator"],
        ],
      ],
    ],
    true,
  ],
  [
    "Fish",
    "Actinopterygii",
    [
      [
        "Surgeonfishes and allies",
        "Acanthuriformes",
        [
          ["Butterflyfishes", "Chaetodontidae", "Foureye Butterflyfish, Spotfin Butterflyfish, Banded Butterflyfish"],
          ["Angelfishes", "Pomacanthidae", "Queen Angelfish, French Angelfish, Gray Angelfish"],
          ["Surgeonfishes", "Acanthuridae", "Blue Tang, Ocean Surgeonfish"],
        ],
      ],
      [
        "Wrasses",
        "Labriformes",
        [
          [
            "Wrasses and parrotfishes",
            "Labridae",
            "Bluehead, Spanish Hogfish, Creole Wrasse, Stoplight Parrotfish, Queen Parrotfish",
          ],
        ],
      ],
      [
        "Salmon and trout",
        "Salmoniformes",
        [["Salmon and trout", "Salmonidae", "Sockeye Salmon, Brook Trout, Lake Trout"]],
      ],
      ["Groupers and allies", "Perciformes", [["Groupers", "Serranidae", "Nassau Grouper, Goliath Grouper"]]],
      [
        "Pufferfishes and allies",
        "Tetraodontiformes",
        [
          ["Triggerfishes", "Balistidae", "Queen Triggerfish"],
          ["Pufferfishes", "Tetraodontidae", "Sharpnose Puffer"],
        ],
      ],
    ],
    true,
  ],
  [
    "Amphibians",
    "Amphibia",
    [
      [
        "Frogs and toads",
        "Anura",
        [
          ["Tree frogs", "Hylidae", "Red-eyed Treefrog, Gray Treefrog, Spring Peeper"],
          ["True frogs", "Ranidae", "American Bullfrog, Northern Leopard Frog, Wood Frog"],
          ["Poison frogs", "Dendrobatidae", "Strawberry Poison Frog, Green-and-black Poison Frog"],
          ["Toads", "Bufonidae", "Cane Toad, American Toad"],
        ],
      ],
      [
        "Salamanders",
        "Caudata",
        [
          ["Mole salamanders", "Ambystomatidae", "Spotted Salamander, Tiger Salamander"],
          ["Lungless salamanders", "Plethodontidae", "Eastern Red-backed Salamander"],
        ],
      ],
    ],
    true,
  ],
];

// The marks are made up from each name, so every visit draws the same circle.
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}
const pickTier = (u: number): Tier =>
  u < 0.3 ? "common" : u < 0.55 ? "occasional" : u < 0.77 ? "uncommon" : u < 0.92 ? "rare" : "legendary";

function node(name: string, rank: TreeNode["rank"], latin?: string): TreeNode {
  return {
    id: "",
    name,
    latin,
    rank,
    children: [],
    parent: null,
    total: 0,
    collected: 0,
    targets: 0,
    tiers: {},
    x0: 0,
    x1: 0,
    depth: 0,
  };
}

function build(): TreeNode {
  const life = node("All life", "life");
  for (const [cName, cLatin, orders, rated] of DATA) {
    const c = node(cName, "class", cLatin);
    for (const [oName, oLatin, families] of orders) {
      const o = node(oName, "order", oLatin);
      for (const [fName, fLatin, list] of families) {
        const f = node(fName, "family", fLatin);
        for (const sp of list.split(", ")) {
          const s = node(sp, "species");
          const tier = pickTier(hash(sp));
          s.total = 1;
          // Commoner species are more often photographed already.
          s.collected = hash(`${sp}/p`) < [0.8, 0.65, 0.45, 0.3, 0.15][TIERS.indexOf(tier)] ? 1 : 0;
          s.targets = !s.collected && hash(`${sp}/t`) < 0.12 ? 1 : 0;
          if (rated) s.tiers = { [tier]: 1 };
          f.children.push(s);
        }
        o.children.push(f);
      }
      c.children.push(o);
    }
    life.children.push(c);
  }
  // Sums up the tree, sorts each level largest first (so thin groups sit together at the end,
  // where an "N more groups" segment can stand in for them) and lays out the species spans.
  const sum = (n: TreeNode, parent: TreeNode | null, depth: number, x: number, path: string) => {
    n.parent = parent;
    n.depth = depth;
    n.id = path;
    n.x0 = x;
    for (const ch of n.children) {
      sum(ch, n, depth + 1, x, `${path}/${ch.name}`);
      x = ch.x1;
      n.total += ch.total;
      n.collected += ch.collected;
      n.targets += ch.targets;
      for (const [t, k] of Object.entries(ch.tiers)) n.tiers[t as Tier] = (n.tiers[t as Tier] ?? 0) + k;
    }
    n.x1 = n.children.length ? x : x + n.total;
  };
  const sort = (n: TreeNode) => {
    n.children.forEach(sort);
    n.children.sort((a, b) => count(b) - count(a));
  };
  const count = (n: TreeNode): number => (n.rank === "species" ? 1 : n.children.reduce((k, c) => k + count(c), 0));
  sort(life);
  sum(life, null, 0, 0, "life");
  return life;
}

export const SAMPLE_TREE = build();
