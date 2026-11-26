import { describe, expect, it } from "@jest/globals";
import "@testing-library/react-native/matchers";
import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { getMeta, setMeta } from "../store/meta";
import { saveRegion } from "../store/regions";
import { harness, nav, renderApp } from "../testing/harness";
import { NOW, seedLife } from "../testing/seed";
import { FiltersSheet } from "./FiltersSheet";

const sheet = (scope: "collection" | "gallery") => <FiltersSheet route={{ params: { scope } }} />;
const saved = (h: { db: Parameters<typeof getMeta>[0] }, key = "collectionView") =>
  getMeta<Record<string, unknown>>(h.db, key);

describe("FiltersSheet for the Collection", () => {
  it("Show, Vagrants, Rarity, Needs a better photo and year apply at once and are remembered", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(sheet("collection"), h);
    await fireEvent.press(await screen.findByRole("button", { name: "Targets" }));
    await fireEvent(screen.getByLabelText("Vagrants"), "change", { nativeEvent: { selectedSegmentIndex: 2 } });
    await fireEvent.press(screen.getByRole("button", { name: "Rarity, Any" }));
    await fireEvent.press(screen.getByRole("button", { name: "Rare" }));
    await fireEvent.press(screen.getByRole("button", { name: "Unrated" }));
    await fireEvent(screen.getByLabelText("Needs a better photo"), "valueChange", true);
    await waitFor(async () =>
      expect(await saved(h)).toMatchObject({
        show: "targets",
        vagrant: "hide",
        tiers: ["rare", "unrated"],
        needsBetter: true,
      }),
    );
    expect(screen.getByRole("button", { name: "Rarity, Rare, Unrated" })).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Targets" })).toBeSelected();
  });

  it("Photos taken is offered only for a region from the Lifer, named, with its note", async () => {
    const alone = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(sheet("collection"), alone);
    await screen.findByRole("button", { name: "Targets" });
    expect(screen.queryByText("Photos taken")).not.toBeOnTheScreen();
    screen.unmount();
    const h = await harness({
      mode: "standalone",
      seed: async (db) => {
        await seedLife(db);
        await saveRegion(db, { key: "hub:bc", name: "British Columbia", source: "hub", hubRegionId: "bc" }, [], NOW);
        await setMeta(db, "collectionView", { region: "hub:bc" });
      },
    });
    await renderApp(sheet("collection"), h);
    await fireEvent.press(await screen.findByRole("button", { name: "Only outside British Columbia" }));
    expect(screen.getByText("Photos without a location count only under Anywhere.")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Rarity here, Any" })).toBeOnTheScreen();
    await waitFor(async () => expect(await saved(h)).toMatchObject({ photosTaken: "elsewhere" }));
  });

  it("Done closes the sheet; Clear is in the bar", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(sheet("collection"), h);
    await screen.findByRole("button", { name: "Targets" });
    const opts = nav().setOptions.mock.calls.at(-1)?.[0] as {
      headerLeft?: () => unknown;
      unstable_headerRightItems?: () => { label: string; onPress: () => void }[];
    };
    expect(typeof opts.headerLeft).toBe("function");
    opts
      .unstable_headerRightItems?.()
      .find((i) => i.label === "Done")
      ?.onPress();
    expect(nav().goBack).toHaveBeenCalled();
  });
});

describe("FiltersSheet for the Gallery", () => {
  it("Featured, Group and year narrow the Gallery and are remembered", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(sheet("gallery"), h);
    await fireEvent.press(await screen.findByRole("button", { name: "Featured" }));
    await fireEvent.press(screen.getByRole("button", { name: "Group, All groups" }));
    await fireEvent.press(screen.getByRole("button", { name: "Birds" }));
    await fireEvent.press(screen.getByRole("button", { name: "Year, Any year" }));
    await fireEvent.press(await screen.findByRole("button", { name: "2026" }));
    await waitFor(async () =>
      expect(await saved(h, "galleryView")).toMatchObject({ featured: true, group: "birds", year: "2026" }),
    );
  });
});
