// The scenery rule in checkSubject, with stand-ins for the CLIP text model and the detector: each
// description gets its own axis, so a photo's vector sets exactly how the softmax shares fall.
import { beforeEach, describe, expect, it, vi } from "vitest";

const prompts: string[] = [];
const presence = { animal: 0, person: 0, personArea: 0 };

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

const { checkSubject } = await import("./wildlifeCheck.js");

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
