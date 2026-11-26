import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import "@testing-library/react-native/matchers";
import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import type { Db } from "../store/db";
import { getMeta, setMeta } from "../store/meta";
import { saveRegion } from "../store/regions";
import { harness, barItem, nav, renderApp, setWindow, typeInSearch } from "../testing/harness";
import { NOW, seedLife } from "../testing/seed";
import { CollectionScreen } from "./CollectionScreen";

describe("CollectionScreen", () => {
  it("empty: says what to do and offers a region", async () => {
    const h = await harness({ mode: "standalone" });
    await renderApp(<CollectionScreen />, h);
    expect(await screen.findByText("Nothing in your Collection yet")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Choose a region" }));
    expect(nav().navigate).toHaveBeenCalledWith("RegionPicker");
  });

  it("shows species cards with a spoken label, the group's progress band, and opens one", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<CollectionScreen />, h);
    const card = await screen.findByRole("button", { name: "Mute Swan, Cygnus olor. Photographed, 2 photos." });
    expect(screen.getByRole("button", { name: "Birds, 2 of 5 photographed" })).toBeOnTheScreen();
    expect(screen.getByText(/of 5 photographed/)).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: /Eurasian Teal.*Seen/ })).toBeOnTheScreen();
    await fireEvent.press(card);
    expect(nav().navigate).toHaveBeenCalledWith("Species", { scientificName: "Cygnus olor" });
  });

  it("a group header folds its species away and opens them again, keeping the header and its count", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<CollectionScreen />, h);
    await screen.findByRole("button", { name: /Mute Swan/ });
    await fireEvent.press(screen.getByRole("button", { name: "Birds, 2 of 5 photographed" }));
    expect(screen.queryByRole("button", { name: /Mute Swan/ })).not.toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Birds, 2 of 5 photographed" })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Birds, 2 of 5 photographed" }));
    expect(await screen.findByRole("button", { name: /Mute Swan/ })).toBeOnTheScreen();
  });

  it("search is live and finds swans from the plural", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<CollectionScreen />, h);
    await screen.findByRole("button", { name: /Mute Swan/ });
    await typeInSearch("swans");
    expect(await screen.findByText("2 species match")).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: /Common Crane/ })).not.toBeOnTheScreen();
    await typeInSearch("zzz");
    expect(await screen.findByText("No species match zzz.")).toBeOnTheScreen();
  });

  it("a Show filter applies, says so in words, counts on the Filters button, and clears", async () => {
    const h = await harness({
      mode: "standalone",
      seed: async (db) => (await seedLife(db), await setMeta(db, "collectionView", { show: "targets" })),
    });
    await renderApp(<CollectionScreen />, h);
    expect(await screen.findByRole("button", { name: /Common Crane/ })).toBeOnTheScreen();
    expect(screen.getByText("Targets")).toBeOnTheScreen();
    barItem("Filters, 1 on");
    expect(screen.queryByRole("button", { name: /Mute Swan/ })).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByRole("button", { name: /Mute Swan/ })).toBeOnTheScreen();
  });

  it("Not yet photographed lists what the kept region still holds", async () => {
    const h = await harness({
      mode: "standalone",
      seed: async (db) => (await seedLife(db), await setMeta(db, "collectionView", { show: "unseen" })),
    });
    await renderApp(<CollectionScreen />, h);
    expect(await screen.findByRole("button", { name: /Tundra Swan/ })).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: /Mute Swan/ })).not.toBeOnTheScreen();
  });

  it("Filters opens the one Filters sheet for the Collection", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<CollectionScreen />, h);
    await screen.findByRole("button", { name: /Mute Swan/ });
    await barItem("Filters").press();
    expect(nav().navigate).toHaveBeenCalledWith("Filters", { scope: "collection" });
  });

  it("the arrange menu can switch to List, which shows rows", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<CollectionScreen />, h);
    await screen.findByRole("button", { name: /Mute Swan/ });
    await barItem("List").press();
    expect(await screen.findByRole("button", { name: /Mute Swan, Cygnus olor/ })).toBeOnTheScreen();
  });

  it("holds up with 5,000 species and very long names without drawing them all", async () => {
    const h = await harness({
      mode: "standalone",
      seed: async (db) => {
        await db.tx(async () => {
          for (let i = 0; i < 5000; i++)
            await db.run("INSERT INTO species (scientific_name, common_name, taxon_class) VALUES (?, ?, 'aves')", [
              `Genus${i} species${i}`,
              `Extremely long common name number ${i} of the greater highland variety with spotted wings`,
            ]);
        });
      },
    });
    await renderApp(<CollectionScreen />, h);
    const cards = await screen.findAllByRole("button", { name: /Extremely long common name/ });
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThan(200);
  });
});

// A region whose checklist carries tiers and families, chosen in the saved view.
async function seedRegion(db: Db) {
  await seedLife(db);
  const sp = (scientificName: string, commonName: string, family: string, taxonOrder: string, localTier: string) => ({
    scientificName,
    commonName,
    taxonClass: "aves",
    tier: "common",
    localTier,
    vagrant: false,
    sensitive: false,
    family,
    taxonOrder,
  });
  await saveRegion(
    db,
    { key: "hub:r2", name: "British Columbia", source: "hub", hubRegionId: "r2" },
    [
      sp("Cygnus olor", "Mute Swan", "Anatidae", "Anseriformes", "rare"),
      sp("Tyto alba", "Barn Owl", "Tytonidae", "Strigiformes", "uncommon"),
      sp("Anas crecca", "Eurasian Teal", "Anatidae", "Anseriformes", "common"),
    ],
    NOW,
  );
  await setMeta(db, "collectionView", { region: "hub:r2" });
}

describe("CollectionScreen View menu (cards on a 390 pt phone)", () => {
  beforeEach(() => setWindow(390));
  afterEach(() => setWindow(750, 2, 1334));

  it("offers the desktop's View options by name, with card sizes as Large cards and Small cards", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<CollectionScreen />, h);
    await screen.findByRole("button", { name: /Mute Swan/ });
    for (const name of [
      "Field guide order",
      "Family group",
      "Large cards",
      "Small cards",
      "List",
      "Show rarity tags",
      "Show progress by group",
      "Show uncollected species in colour",
      "Hide names",
    ])
      expect(() => barItem(name)).not.toThrow();
  });

  it("cards inside a region show here and worldwide; Show rarity tags off hides them and is remembered", async () => {
    const h = await harness({ mode: "standalone", seed: seedRegion });
    await renderApp(<CollectionScreen />, h);
    expect(await screen.findByText("Rare here")).toBeOnTheScreen();
    expect(screen.getAllByText("Common worldwide").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Rare in British Columbia, Common worldwide\./ })).toBeOnTheScreen();
    await barItem("Show rarity tags").press();
    await waitFor(() => expect(screen.queryByText("Rare here")).not.toBeOnTheScreen());
    expect(await getMeta(h.db, "collectionView")).toMatchObject({ showRarityTags: false });
  });

  it("Show progress by group off turns bands back into plain headers with the whole region's progress", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<CollectionScreen />, h);
    await screen.findByText(/of 5 photographed/);
    await barItem("Show progress by group").press();
    expect(await screen.findByText("2 of 5 species photographed")).toBeOnTheScreen();
    expect(screen.getByText("2 of 5")).toBeOnTheScreen();
  });

  it("Family group sections by the desktop's family names in field guide order", async () => {
    const h = await harness({ mode: "standalone", seed: seedRegion });
    await renderApp(<CollectionScreen />, h);
    await screen.findByText("Rare here");
    await barItem("Family group").press();
    const headers = await screen.findAllByRole("button", { name: /photographed$/ });
    const sections = headers.map((b) => String(b.props.accessibilityLabel).split(",")[0]).filter((n) => !/^\d/.test(n));
    expect(sections).toEqual(["Waterfowl", "Owls"]);
  });

  it("Needs a better photo narrows the cards and is named in the filter line", async () => {
    const h = await harness({
      mode: "standalone",
      seed: async (db) => {
        await seedRegion(db);
        await db.run("UPDATE marks SET needs_better_photo = 1 WHERE scientific_name = 'Anas crecca'");
        await setMeta(db, "collectionView", { region: "hub:r2", needsBetter: true });
      },
    });
    await renderApp(<CollectionScreen />, h);
    expect(await screen.findByRole("button", { name: /Eurasian Teal/ })).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: /Mute Swan/ })).not.toBeOnTheScreen();
    expect(screen.getByText("Needs a better photo")).toBeOnTheScreen();
  });
});

describe("CollectionScreen defaults", () => {
  it("opens with photographed species first, then seen, as the desktop does, with no setup", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<CollectionScreen />, h);
    await screen.findByRole("button", { name: /Mute Swan/ });
    const names = screen
      .getAllByRole("button", { name: /Photographed|Seen|Not yet seen/ })
      .map((b) => String(b.props.accessibilityLabel ?? "").split(",")[0]);
    expect(names.slice(0, 3)).toEqual(["Barn Owl", "Mute Swan", "Eurasian Teal"]);
  });

  it("asks the photo cache for a reference photo for species with none of your own, and not for photographed ones", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    const asked: string[] = [];
    const real = h.boot.media.thumb.bind(h.boot.media);
    h.boot.media.thumb = (id: string) => (asked.push(id), real(id));
    await renderApp(<CollectionScreen />, h);
    await screen.findByRole("button", { name: /Tundra Swan/ });
    expect(asked).toContain("ref~Cygnus_columbianus");
    expect(asked).not.toContain("ref~Cygnus_olor");
  });
});
