import { describe, expect, it } from "vitest";
import fixtures from "./__fixtures__/descriptionArticles.json" with { type: "json" };
import {
  classifySentence,
  cleanExtractText,
  composeDescription,
  DESCRIPTION_MAX_CHARS,
  findSection,
  htmlToText,
  IDENTIFICATION_HEADINGS,
  nameTheSubject,
  subjectOf,
  splitSections,
  splitSentences,
  takeWithinBudget,
} from "./descriptionText.js";

type Key = keyof typeof fixtures.articles;
function describeArticle(key: Key) {
  const sections = splitSections(fixtures.articles[key].extract);
  return composeDescription({ lead: sections[0].body, identificationSection: findSection(sections, IDENTIFICATION_HEADINGS) });
}

describe("classifySentence", () => {
  it.each([
    ["The common garter snake (Thamnophis sirtalis) is a species of snake in the subfamily Natricinae of the family Colubridae.", "taxonomy"],
    ["There are several recognized subspecies.", "taxonomy"],
    ["The American red squirrel (Tamiasciurus hudsonicus) is one of three species of tree squirrels currently classified in the genus Tamiasciurus.", "taxonomy"],
    ["The great blue heron was one of many species originally described by Carl Linnaeus in his 18th-century work, Systema Naturae.", "taxonomy"],
    ["Debate exists about whether these white birds are a color morph of the great blue heron, a subspecies of it, or an entirely separate species.", "taxonomy"],
    ["The specific name maliger is a compound of malus which means \"mast\" and iger meaning \"to bear\".", "etymology"],
    ["The subspecific name fitchi is in honor of the American herpetologist Henry Sheldon Fitch.", "etymology"],
    ["The American red squirrel is variously known as the pine squirrel or piney squirrel, North American red squirrel, chickaree, boomer, or simply red squirrel.", "synonyms"],
    ["The species is indigenous to North America and found widely across the continent.", "range"],
    ["It is occasionally found in the Azores and is a rare vagrant to Europe.", "range"],
    ["It is listed as Least Concern on the IUCN Red List.", "conservation"],
    ["Their mottled orange-brown coloring allows them to blend in with rocky bottom reefs.", "identification"],
    ["Quillback rockfish are named for the sharp, venomous quills or spines on the dorsal fin.", "identification"],
    ["The great blue heron is the largest heron native to North America.", "identification"],
    ["The quillback rockfish eats mainly crustaceans, but will also eat herring.", "ecology"],
    ["This species primarily dwells in salt water reefs.", "ecology"],
    ["The common garter snake is the state reptile of Massachusetts.", "other"],
    ["Taxonomic treatments in 2006 placed this species in the genus Anaxyrus instead of Bufo.", "taxonomy"],
    ["Before the 2020s, the species was considered cosmopolitan, but the taxon has since been split into at least 28 species.", "taxonomy"],
    ["It is a marine gastropod mollusk in the Rissoidae family.", "taxonomy"],
    ["It is known by a variety of regional names, such as the widemouth bass, bigmouth bass and black bass.", "synonyms"],
    ["The raccoon, sometimes called the North American, northern or common raccoon, is a mammal.", "synonyms"],
    ["C. sapidus is of considerable economic importance in the United States, particularly in Louisiana, the Carolinas, the Chesapeake Bay, Delaware, and New Jersey.", "range"],
    ["A 2022 study concluded that the correct scientific name for the Florida bass is Micropterus salmoides.", "taxonomy"],
    ["Textile cone snails live mostly in the Indian Ocean, along the eastern coast of Africa and around Australia.", "range"],
  ] as const)("%s -> %s", (sentence, kind) => {
    expect(classifySentence(sentence)).toBe(kind);
  });
});

describe("naming the subject", () => {
  it("finds the noun phrase a lead opens with", () => {
    expect(subjectOf("The quillback rockfish (Sebastes maliger), also known as the quillback seaperch, is a fish.")).toBe("The quillback rockfish");
    expect(subjectOf("Turbonilla acuta is a species of sea snail.")).toBe("Turbonilla acuta");
    expect(subjectOf("The (American) five-lined skink (Plestiodon fasciatus) is a species of lizard.")).toBe("The five-lined skink");
    expect(subjectOf("Because of a very long and winding opening clause that never names anything at all, it is.")).toBeNull();
  });

  it("replaces It, Its and This species, and nothing else", () => {
    expect(nameTheSubject("It is the continent's smallest bear.", "The American black bear")).toBe("The American black bear is the continent's smallest bear.");
    expect(nameTheSubject("Its embryos host algae.", "The spotted salamander")).toBe("The spotted salamander's embryos host algae.");
    expect(nameTheSubject("This species dwells in reefs.", "The quillback rockfish")).toBe("The quillback rockfish dwells in reefs.");
    expect(nameTheSubject("They are solitary.", "The quillback rockfish")).toBeNull();
  });

  it("keeps the ceiling after naming the subject", () => {
    const filler = Array.from({ length: 12 }, (_, i) => `It has ${i} dark brown stripes on a pale grey body.`).join(" ");
    const text = composeDescription({ lead: `The extraordinarily long-named example animal (Exempli gratia) is a species of animal. ${filler}` })!;
    expect(text.startsWith("The extraordinarily long-named example animal has 0")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS);
  });

  it("composes without a dangling pronoun, falling back to the opener for They", () => {
    const lead = "The American black bear (Ursus americanus) is a species of medium-sized bear in the family Ursidae. It is the continent's smallest bear.";
    expect(composeDescription({ lead })).toBe("The American black bear is the continent's smallest bear.");
    const plural = "The quillback rockfish (Sebastes maliger) is a species of fish. They are solitary and give birth to live young.";
    expect(composeDescription({ lead: plural })).toBe(plural);
  });
});

describe("splitSentences", () => {
  it("keeps decimals, initials and abbreviations inside a sentence", () => {
    expect(splitSentences("The average body mass is 150 g (5.3 oz). It was described by J. E. Gray. Others, e.g. T. douglasii, differ.")).toEqual([
      "The average body mass is 150 g (5.3 oz).",
      "It was described by J. E. Gray.",
      "Others, e.g. T. douglasii, differ.",
    ]);
  });

  it("still ends a sentence on a word that ends like an abbreviation", () => {
    expect(splitSentences("It lives in the Pacific. Adults are coral. Young are pale.")).toEqual([
      "It lives in the Pacific.",
      "Adults are coral.",
      "Young are pale.",
    ]);
  });

  it("splits at line breaks", () => {
    expect(splitSentences("One line\nAnother line.")).toEqual(["One line", "Another line."]);
  });
});

describe("splitSections and findSection", () => {
  it("finds the identification section under a combined heading", () => {
    const sections = splitSections(fixtures.articles.garterSnake.extract);
    expect(sections[0].heading).toBe("");
    expect(findSection(sections, IDENTIFICATION_HEADINGS)).toMatch(/^Common garter snakes are thin snakes\./);
  });

  it("returns null when the article has none", () => {
    expect(findSection(splitSections(fixtures.articles.snailStub.extract), IDENTIFICATION_HEADINGS)).toBeNull();
  });
});

describe("composeDescription on real articles", () => {
  it("Great blue heron: keeps the overview and the size comparison, drops vagrancy and the taxonomy debate", () => {
    const text = describeArticle("heron")!;
    expect(text).toMatch(/^The great blue heron \(Ardea herodias\) is a large wading bird/);
    expect(text).toContain("An all-white population");
    expect(text).toContain("The great blue heron is the largest heron native to North America.");
    expect(text).not.toContain("rare vagrant to Europe");
    expect(text).not.toContain("Debate exists");
    expect(text.length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS);
  });

  it("Common garter snake: drops the taxonomy, range and subspecies lines, keeps stripes and size", () => {
    const text = describeArticle("garterSnake")!;
    expect(text).toMatch(/^Most common garter snakes have a pattern of yellow stripes/);
    expect(text).toContain("The average body mass is 150 g (5.3 oz).");
    expect(text).toContain("Common garter snakes are thin snakes.");
    expect(text).not.toContain("is a species of snake");
    expect(text).not.toContain("indigenous to North America");
    expect(text).not.toContain("subspecies");
  });

  it("Quillback rockfish (a fish): keeps habitat, size, colour and diet, drops the taxonomy line", () => {
    const text = describeArticle("fish")!;
    expect(text).toMatch(/^The quillback rockfish primarily dwells in salt water reefs\./);
    expect(text).toContain("mottled orange-brown");
    expect(text).toContain("eats mainly crustaceans");
    expect(text).not.toContain("ray-finned fish belonging to");
  });

  it("American red squirrel (a mammal): keeps size and look-alikes, drops classification and alternative names", () => {
    const text = describeArticle("mammal")!;
    expect(text).toMatch(/^The squirrel is a small, 200–250 g/);
    expect(text).toContain("easily distinguished from other North American tree squirrels");
    expect(text).not.toContain("one of three species");
    expect(text).not.toContain("variously known as");
  });

  it("Turbonilla acuta (a marine snail stub): keeps its one taxonomy sentence rather than nothing", () => {
    expect(describeArticle("snailStub")).toBe(
      "Turbonilla acuta is a species of sea snail, a marine gastropod mollusk in the family Pyramidellidae, the pyrams and their allies.",
    );
  });

  it("never cuts inside a sentence", () => {
    for (const key of Object.keys(fixtures.articles) as Key[]) {
      const text = describeArticle(key)!;
      expect(text).toMatch(/[.!?)]$/);
      expect(text).not.toMatch(/\.\.\.|…$/);
    }
  });
});

describe("composeDescription on iNaturalist summaries", () => {
  it("drops the cut-off last sentence and the boilerplate (heron)", () => {
    const text = composeDescription({ lead: htmlToText(fixtures.inaturalistSummaries.heron), leadTruncated: true });
    expect(text).toBe(
      "The great blue heron (Ardea herodias) is a large wading bird in the heron family Ardeidae, common near the shores of open water and in wetlands over most of North America and Central America, as well as the Caribbean and the Galápagos Islands.",
    );
  });

  it("agrees with the Wikipedia path on what it keeps (garter snake)", () => {
    const text = composeDescription({ lead: htmlToText(fixtures.inaturalistSummaries.garterSnake), leadTruncated: true })!;
    expect(text).toMatch(/^Most common garter snakes have a pattern of yellow stripes/);
    expect(text).toContain("about 55 cm (22 in)");
    expect(text).not.toContain("state reptile of...");
    expect(text).not.toContain("indigenous to North America");
  });
});

describe("budget and edge cases", () => {
  it("takes whole sentences while they fit and stops at the first that doesn't", () => {
    expect(takeWithinBudget(["aaaa.", "bbbbbbbbbb.", "c."], 12)).toEqual(["aaaa."]);
    expect(takeWithinBudget(["aaaa.", "bb."], 9)).toEqual(["aaaa.", "bb."]);
  });

  it("keeps a single over-long useful sentence whole", () => {
    const long = `It has ${"long brown stripes and ".repeat(60)}a pale belly.`;
    expect(composeDescription({ lead: long })).toBe(long);
  });

  it("reserves room for the identification section", () => {
    const lead = Array.from({ length: 20 }, (_, i) => `Adults feed on insects number ${i} in summer.`).join(" ");
    const text = composeDescription({ lead, identificationSection: "It is 20 cm long with a red crest." })!;
    expect(text.endsWith("It is 20 cm long with a red crest.")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS);
  });

  it("ignores list headings and items in an extract", () => {
    const lead =
      "Arion flagellus, also known by its common name (in the United Kingdom) the Durham slug, is a species of air-breathing land slug, a terrestrial pulmonate gastropod mollusc in the family Arionidae, the roundback slugs.\n\nVariety\n\nArion flagellus var. phillipsi Collinge, 1893 (unassessed)";
    expect(composeDescription({ lead })).toBe(lead.split("\n")[0]);
  });

  it("is null for nothing substantive", () => {
    expect(composeDescription({ lead: "" })).toBeNull();
    expect(composeDescription({ lead: "...", leadTruncated: true })).toBeNull();
  });

  it("tidies pronunciation leftovers and entities", () => {
    expect(cleanExtractText("The quokka ( ; Setonix brachyurus) is small .")).toBe("The quokka (Setonix brachyurus) is small.");
    expect(htmlToText("55&nbsp;cm <b>long</b> &amp; thin")).toBe("55 cm long & thin");
    expect(cleanExtractText("The raccoon (or US:, Procyon lotor) is a mammal.")).toBe("The raccoon (Procyon lotor) is a mammal.");
  });
});
