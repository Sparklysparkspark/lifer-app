import { describe, expect, it, jest } from "@jest/globals";
import "@testing-library/react-native/matchers";
import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { harness, renderApp } from "../testing/harness";
import { getMeta } from "../store/meta";
import { listRegions } from "../store/regions";
import { RegionsSetupScreen } from "./RegionsSetupScreen";

jest.mock("../standalone/indexFile", () => ({
  fetchPackIndex: async () => ({
    generatedAt: "x",
    packs: [
      { id: "p1", type: "region", region: "Norway", taxon: "aves", scientificNames: ["Grus grus", "Cygnus olor"] },
    ],
  }),
}));
jest.mock("../location/position", () => ({
  currentPosition: async () => ({ status: "ok", position: { lat: 60, lon: 10 } }),
  countryAt: async () => "Norway",
  locationAllowed: async () => false,
}));

describe("RegionsSetupScreen", () => {
  it("asks for location only on the suggestion button, ticks the suggested region and keeps its list", async () => {
    const h = await harness({ mode: "standalone" });
    let done = false;
    await renderApp(<RegionsSetupScreen onDone={() => (done = true)} />, h);
    await fireEvent.press(await screen.findByRole("button", { name: "Get the region list" }));
    expect(await screen.findByText(/only to suggest your country/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Suggest my region" }));
    expect(await screen.findByText("Your region looks like Norway. It is ticked below.")).toBeOnTheScreen();
    await fireEvent.press(await screen.findByRole("button", { name: "Keep 1 region" }));
    await waitFor(async () => expect(await listRegions(h.db)).toMatchObject([{ key: "pack:Norway", speciesCount: 2 }]));
    expect(done).toBe(true);
    expect(await getMeta(h.db, "regionsSetup")).toBe(true);
  });

  it("Not now skips without downloading anything", async () => {
    const h = await harness({ mode: "standalone" });
    let done = false;
    await renderApp(<RegionsSetupScreen onDone={() => (done = true)} />, h);
    await fireEvent.press(await screen.findByRole("button", { name: "Not now" }));
    await waitFor(() => expect(done).toBe(true));
    expect(await listRegions(h.db)).toEqual([]);
  });
});
