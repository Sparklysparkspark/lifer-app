import { describe, expect, it } from "@jest/globals";
import "@testing-library/react-native/matchers";
import { screen } from "@testing-library/react-native";
import type { CollectionSpecies } from "../store/browse";
import { harness, renderApp } from "../testing/harness";
import { SpeciesCard } from "./SpeciesCard";
import { SpeciesRow } from "./SpeciesRow";

const row = (o: Partial<CollectionSpecies> = {}): CollectionSpecies => ({
  scientificName: "Dryocopus pileatus",
  commonName: "Pileated Woodpecker",
  taxonClass: "aves",
  tier: "uncommon",
  tierReason: null,
  sensitive: false,
  status: "photographed",
  isTarget: false,
  photos: 3,
  coverPhotoId: "p1",
  lastTakenAt: null,
  localTier: "uncommon",
  localTierReason: null,
  worldTier: "common",
  vagrant: false,
  needsBetterPhoto: false,
  taxonOrder: null,
  family: null,
  ...o,
});
const noop = () => undefined;

async function card(r: CollectionSpecies, props: Partial<Parameters<typeof SpeciesCard>[0]> = {}) {
  const h = await harness({ mode: "standalone" });
  h.boot.media.thumb = () => "file:///thumb.jpg";
  await renderApp(<SpeciesCard row={r} onPress={noop} onLongPress={noop} actions={() => []} {...props} />, h);
}
const flatStyle = (id: string) => Object.assign({}, ...[screen.getByTestId(id).props.style].flat());

describe("SpeciesCard rarity pills", () => {
  it("inside a region: here and worldwide, and VoiceOver names the region", async () => {
    await card(row(), { region: "British Columbia" });
    expect(screen.getByText("Uncommon here")).toBeOnTheScreen();
    expect(screen.getByText("Common worldwide")).toBeOnTheScreen();
    expect(
      screen.getByRole("button", {
        name: "Pileated Woodpecker, Dryocopus pileatus. Photographed, 3 photos. Uncommon in British Columbia, Common worldwide.",
      }),
    ).toBeOnTheScreen();
  });

  it("both pills even when the tiers match", async () => {
    await card(row({ localTier: "rare", worldTier: "rare" }), { region: "Norfolk" });
    expect(screen.getByText("Rare here")).toBeOnTheScreen();
    expect(screen.getByText("Rare worldwide")).toBeOnTheScreen();
  });

  it("Everywhere: one plain worldwide pill", async () => {
    await card(row({ localTier: null }), { region: null });
    expect(screen.getByText("Common")).toBeOnTheScreen();
    expect(screen.queryByText(/here/)).not.toBeOnTheScreen();
  });

  it("thin data reads Unrated in its scope", async () => {
    await card(row({ localTier: null, localTierReason: "thin_data", worldTier: null, tierReason: "no_data" }), {
      region: "Ontario",
    });
    expect(screen.getByText("Unrated here")).toBeOnTheScreen();
    expect(screen.getByText("Unrated worldwide")).toBeOnTheScreen();
  });

  it("Show rarity tags off hides both pills and their spoken words", async () => {
    await card(row(), { region: "Norfolk", showRarityTags: false });
    expect(screen.queryByText("Uncommon here")).not.toBeOnTheScreen();
    expect(screen.queryByText("Common worldwide")).not.toBeOnTheScreen();
    expect(screen.getByRole("button", { name: /Photographed, 3 photos\.$/ })).toBeOnTheScreen();
  });

  it("a very long name wraps rather than being cut, and Hide names keeps them for VoiceOver", async () => {
    const long = "Extremely long common name of the greater highland variety with spotted wings and a crest";
    await card(row({ commonName: long }), { hideNames: true });
    expect(screen.queryByText(long)).not.toBeOnTheScreen();
    expect(screen.getByRole("button", { name: new RegExp(long) })).toBeOnTheScreen();
  });

  it("SpeciesRow shows the same pills", async () => {
    const h = await harness({ mode: "standalone" });
    await renderApp(<SpeciesRow row={row()} onPress={noop} region="Norfolk" />, h);
    expect(screen.getByText("Uncommon here")).toBeOnTheScreen();
    expect(screen.getByText("Common worldwide")).toBeOnTheScreen();
  });
});

describe("SpeciesCard covers and marks", () => {
  it("a photographed cover is untouched", async () => {
    await card(row());
    expect(flatStyle("cover").filter).toBeUndefined();
    expect(flatStyle("cover").opacity).toBeUndefined();
  });

  it("an unphotographed cover is grey, or in colour (a touch dimmer) with the option on", async () => {
    await card(row({ status: "none", photos: 0, coverPhotoId: null }));
    expect(flatStyle("cover").filter).toEqual(expect.arrayContaining([{ grayscale: 0.95 }]));
    screen.unmount();
    await card(row({ status: "none", photos: 0, coverPhotoId: null }), { uncollectedColour: true });
    expect(flatStyle("cover").filter).toEqual([{ brightness: 0.88 }, { saturate: 0.88 }]);
  });

  it("a seen cover fades, and seen and target marks both show", async () => {
    await card(row({ status: "seen", photos: 0, coverPhotoId: null, isTarget: true }));
    expect(flatStyle("cover").opacity).toBe(0.45);
    const tree = JSON.stringify(screen.toJSON());
    expect(tree).toContain('"ios":"eye"');
    expect(tree).toContain('"ios":"scope"');
  });
});
