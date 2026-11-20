import { describe, expect, it } from "@jest/globals";
import "@testing-library/react-native/matchers";
import { fireEvent, screen } from "@testing-library/react-native";
import { harness, barItem, nav, renderApp, typeInSearch } from "../testing/harness";
import { seedLife } from "../testing/seed";
import { CollectionScreen } from "./CollectionScreen";

describe("CollectionScreen", () => {
  it("empty: says what to do and offers a region", async () => {
    const h = await harness({ mode: "standalone" });
    await renderApp(<CollectionScreen />, h);
    expect(await screen.findByText("Nothing in your Collection yet")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Choose a region" }));
    expect(nav().navigate).toHaveBeenCalledWith("RegionPicker");
  });

  it("shows species cards with a spoken label, the progress line and the group section, and opens one", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<CollectionScreen />, h);
    const card = await screen.findByRole("button", { name: "Mute Swan, Cygnus olor. Photographed, 2 photos." });
    expect(screen.getByText("2 of 5 species photographed")).toBeOnTheScreen();
    expect(screen.getByLabelText("Birds, 2 of 5 photographed")).toBeOnTheScreen();
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

  it("the menu's Show choice filters, says so in words, and clears", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<CollectionScreen />, h);
    await screen.findByRole("button", { name: /Mute Swan/ });
    await barItem("Targets").press();
    expect(await screen.findByRole("button", { name: /Common Crane/ })).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: /Mute Swan/ })).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByRole("button", { name: /Mute Swan/ })).toBeOnTheScreen();
  });

  it("Not yet photographed lists what the kept region still holds", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<CollectionScreen />, h);
    await screen.findByRole("button", { name: /Mute Swan/ });
    await barItem("Not yet photographed").press();
    expect(await screen.findByRole("button", { name: /Tundra Swan/ })).toBeOnTheScreen();
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
