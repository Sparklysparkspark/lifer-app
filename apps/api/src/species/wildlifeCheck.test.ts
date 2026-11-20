// The scenery rule in checkSubject, with stand-ins for the CLIP text model and the detector: each
// description gets its own axis, so a photo's vector sets exactly how the softmax shares fall.
import { beforeEach, describe, expect, it, vi } from "vitest";

const prompts: string[] = [];
const presence = { animal: 0, person: 0, personArea: 0, count: 0 };

vi.mock("@lifer/core/species/textEmbedding.js", () => ({
  isTextModelDownloaded: () => true,
  embedTextVectors: async (texts: string[]) => {
    prompts.splice(0, prompts.length, ...texts);
    return texts.map((_, i) => {
      const v = new Float32Array(texts.length);
      v[i] = 1;
      return v;
    });
  },
}));
vi.mock("./detectAndCrop.js", () => ({ detectSubjectPresence: async () => presence }));

const { checkSubject, unsureWithoutAnimal } = await import("./wildlifeCheck.js");

/** A photo vector whose softmax shares (CLIP's logit scale of 100) are `shares`, with what's left
 *  spread evenly over every other description. */
async function photoWith(shares: Record<string, number>): Promise<number[]> {
  // Embeds the descriptions, so their order is known.
  await checkSubject(Buffer.alloc(0), new Array(1).fill(0));
  const named = Object.values(shares).reduce((a, b) => a + b, 0);
  const rest = (1 - named) / (prompts.length - Object.keys(shares).length);
  return prompts.map((p) => Math.log(shares[p] ?? rest) / 100);
}

describe("checkSubject scenery rule", () => {
  beforeEach(() => Object.assign(presence, { animal: 0.006, person: 0, personArea: 0 }));

  it("flags a landscape whose reading splits between scenery and trees, with no animal", async () => {
    const photo = await photoWith({ "a landscape": 0.5, "a photo of a tree": 0.23, "a mountain landscape": 0.1 });
    expect((await checkSubject(Buffer.alloc(0), photo)).notWildlife).toEqual({ looksLike: "a landscape" });
  });

  it("flags a river scene whose reading goes to its reflections", async () => {
    const photo = await photoWith({
      "a landscape": 0.3,
      "trees reflected in calm water": 0.45,
      "a photo of a tree": 0.12,
    });
    expect((await checkSubject(Buffer.alloc(0), photo)).notWildlife).toEqual({ looksLike: "a landscape" });
  });

  it("keeps a forest shot with a bird on a trunk in it", async () => {
    const photo = await photoWith({
      "a photo of a tree": 0.57,
      "a bird on a tree trunk": 0.09,
      "a photo of a plant": 0.05,
    });
    expect((await checkSubject(Buffer.alloc(0), photo)).notWildlife).toBeNull();
  });

  it("keeps any photo the detector finds an animal in", async () => {
    presence.animal = 0.3;
    const photo = await photoWith({ "a landscape": 0.5, "a photo of a tree": 0.23, "a mountain landscape": 0.1 });
    expect((await checkSubject(Buffer.alloc(0), photo)).notWildlife).toBeNull();
  });
});

describe("checkSubject maybe band", () => {
  beforeEach(() => Object.assign(presence, { animal: 0.006, person: 0, personArea: 0 }));

  it("asks about a scene that reads mostly as not wildlife, short of the flag", async () => {
    const photo = await photoWith({ "a landscape": 0.35, "a mountain landscape": 0.1, "a photo of a tree": 0.1 });
    const check = await checkSubject(Buffer.alloc(0), photo);
    expect(check.notWildlife).toBeNull();
    expect(check.maybeNotWildlife?.looksLike).toBe("a landscape");
    expect(check.maybeNotWildlife?.share).toBeGreaterThanOrEqual(0.5);
  });

  it("never asks about a bird on a tree, or a photo the detector finds an animal in", async () => {
    const trunk = await photoWith({
      "a photo of a tree": 0.57,
      "a bird on a tree trunk": 0.09,
      "a photo of a plant": 0.05,
    });
    expect((await checkSubject(Buffer.alloc(0), trunk)).maybeNotWildlife ?? null).toBeNull();
    presence.animal = 0.3;
    const scene = await photoWith({ "a landscape": 0.4, "a mountain landscape": 0.15, "a photo of a tree": 0.1 });
    expect((await checkSubject(Buffer.alloc(0), scene)).maybeNotWildlife ?? null).toBeNull();
  });

  it("leaves a confident flag as it was, with no maybe", async () => {
    const photo = await photoWith({ "a landscape": 0.5, "a photo of a tree": 0.23, "a mountain landscape": 0.1 });
    const check = await checkSubject(Buffer.alloc(0), photo);
    expect(check.notWildlife).toEqual({ looksLike: "a landscape" });
    expect(check.maybeNotWildlife ?? null).toBeNull();
  });
});

describe("no confident name without an animal", () => {
  beforeEach(() => Object.assign(presence, { animal: 0, person: 0, personArea: 0 }));
  const suggestions = () => [
    { id: "a", confident: true, probably: { rank: "genus", name: "Trichechus" } },
    { id: "b", confident: undefined },
  ];

  it("takes the confidence, and the genus, from a river that reads faintly as a mammal", async () => {
    const photo = await photoWith({ "a river": 0.4, "a landscape": 0.2, "a photo of a mammal": 0.12 });
    const check = await checkSubject(Buffer.alloc(0), photo);
    expect(check.animalEvidence).toBe(false);
    const [top] = unsureWithoutAnimal(suggestions(), check);
    expect(top.confident).toBe(false);
    expect(top.probably).toBeUndefined();
  });

  it("takes the confidence from a parked bus, flagged or not", async () => {
    const photo = await photoWith({ "a bus": 0.5, "an abandoned vehicle": 0.2 });
    const [top] = unsureWithoutAnimal(suggestions(), await checkSubject(Buffer.alloc(0), photo));
    expect(top.confident).toBe(false);
  });

  it("keeps a bird deep in foliage, and anything the detector finds", async () => {
    const trunk = await photoWith({
      "a photo of a tree": 0.57,
      "a bird on a tree trunk": 0.12,
      "a photo of a plant": 0.05,
    });
    expect(unsureWithoutAnimal(suggestions(), await checkSubject(Buffer.alloc(0), trunk))[0].confident).toBe(true);
    presence.animal = 0.6;
    const river = await photoWith({ "a river": 0.4, "a landscape": 0.2 });
    expect(unsureWithoutAnimal(suggestions(), await checkSubject(Buffer.alloc(0), river))[0].confident).toBe(true);
  });

  it("leaves suggestions alone when there was nothing to tell from", () => {
    expect(unsureWithoutAnimal(suggestions(), { notWildlife: null, invertebrate: null })[0].confident).toBe(true);
  });
});
