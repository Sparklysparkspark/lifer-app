import { describe, expect, it } from "@jest/globals";
import "@testing-library/react-native/matchers";
import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { getMark } from "../store/marks";
import { barItem, harness, nav, renderApp } from "../testing/harness";
import { seedLife } from "../testing/seed";
import { SpeciesScreen } from "./SpeciesScreen";

const page = (scientificName: string) => <SpeciesScreen route={{ params: { scientificName } }} />;

describe("SpeciesScreen", () => {
  it("a species you have not met: Seen is a toggle with Undo, and the facts say none yet", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(page("Cygnus columbianus"), h);
    const seen = await screen.findByRole("switch", { name: "Seen" });
    expect(seen.props.accessibilityState.checked).toBe(false);
    await fireEvent.press(seen);
    await waitFor(async () => expect((await getMark(h.db, "Cygnus columbianus"))?.state).toBe("seen"));
    expect(await screen.findByText("Marked Tundra Swan as seen")).toBeOnTheScreen();
    expect(screen.getByText("No photos of this species yet.")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Undo" }));
    await waitFor(async () => expect((await getMark(h.db, "Cygnus columbianus"))?.state).toBeNull());
  });

  it("toggles the target", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(page("Cygnus columbianus"), h);
    await fireEvent.press(await screen.findByRole("switch", { name: "Target" }));
    await waitFor(async () => expect((await getMark(h.db, "Cygnus columbianus"))?.isTarget).toBe(true));
  });

  it("a photographed species shows a status, its photos and facts, and no Seen toggle", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(page("Cygnus olor"), h);
    expect(await screen.findByText("Mute Swan")).toBeOnTheScreen();
    expect(screen.getByLabelText("Photographed")).toBeOnTheScreen();
    expect(screen.queryByRole("switch", { name: "Seen" })).not.toBeOnTheScreen();
    expect(screen.getByText("2 September 2026")).toBeOnTheScreen();
    await waitFor(() => expect(screen.getAllByRole("imagebutton", { name: /^Mute Swan/ })).toHaveLength(2));
    // The hero's own photos open in the viewer too.
    expect(screen.getAllByRole("imagebutton", { name: "Photo" })).toHaveLength(2);
  });

  it("a sensitive species says its locations are never shown", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(page("Tyto alba"), h);
    expect(await screen.findByText(/never shown/)).toBeOnTheScreen();
  });

  it("the More menu opens the species in the Collection", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(page("Cygnus olor"), h);
    await screen.findByText("Mute Swan");
    await barItem("Show in Collection").press();
    expect(nav().navigate).toHaveBeenCalledWith("Tabs", { screen: "Collection" });
  });
});
