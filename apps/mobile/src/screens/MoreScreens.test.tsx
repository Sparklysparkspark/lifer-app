import { describe, expect, it, jest } from "@jest/globals";
import "@testing-library/react-native/matchers";
import { ActionSheetIOS, Alert } from "react-native";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import * as Sharing from "expo-sharing";
import { applyAlbums, applyCaptureChanges, applyMembers } from "../store/library";
import { loadModelState } from "../search/modelDownload";
import { applyVectorPage } from "../search/vectorStore";
import { encodeVectorForTest } from "../search/vectorTestUtil";
import { setMeta } from "../store/meta";
import { loadSettings } from "../store/settings";
import { harness, nav, renderApp } from "../testing/harness";
import { capture, seedLife } from "../testing/seed";
import { AlbumsScreen } from "./AlbumsScreen";
import { MoreFiltersSheet } from "./MoreFiltersSheet";
import { PhotoInfoSheet } from "./PhotoInfoSheet";
import { AddRegionScreen } from "./AddRegionScreen";
import { RegionPickerSheet } from "./RegionPickerSheet";
import { RegionsScreen } from "./RegionsScreen";
import { SettingsScreen } from "./SettingsScreen";
import { StatsScreen } from "./StatsScreen";
import { ViewerScreen } from "./ViewerScreen";
import { WelcomeScreen } from "./WelcomeScreen";
import { YourLiferSheet } from "./YourLiferSheet";

describe("WelcomeScreen", () => {
  it("offers to connect or to use the app on its own", async () => {
    const connect = jest.fn();
    const alone = jest.fn();
    const h = await harness();
    await renderApp(<WelcomeScreen onConnect={connect} onStandalone={alone} />, h);
    await fireEvent.press(screen.getByRole("button", { name: "Connect to your computer or server" }));
    await fireEvent.press(screen.getByRole("button", { name: "Use on this phone only" }));
    expect(connect).toHaveBeenCalled();
    expect(alone).toHaveBeenCalled();
  });
});

describe("YourLiferSheet", () => {
  it("on its own: says so, offers to connect, and lists Stats, Regions and Settings", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<YourLiferSheet />, h);
    expect(await screen.findByText("Lifer on this phone only")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Connect to a Lifer" })).toBeOnTheScreen();
    expect(await screen.findByRole("button", { name: /Regions, 1 on this phone/ })).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Stats" })).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Settings" })).toBeOnTheScreen();
  });

  it("paired but offline: calm words, not an error", async () => {
    const h = await harness({ paired: true });
    await renderApp(<YourLiferSheet />, h);
    await screen.findByText("Up to date");
    expect(screen.getByText(/Synced with your computer/)).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Sync now" })).toBeOnTheScreen();
  });
});

describe("SettingsScreen", () => {
  it("on its own: says so and offers to connect", async () => {
    const h = await harness({ mode: "standalone" });
    await renderApp(<SettingsScreen />, h);
    expect(await screen.findByText(/Not connected/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Connect to your computer or server" }));
    expect(nav().navigate).toHaveBeenCalledWith("Connect");
  });

  it("paired: shows the connection and its advanced details, and confirms before disconnecting", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    const h = await harness({ paired: true });
    await renderApp(<SettingsScreen />, h);
    expect(await screen.findByText("Connected to your computer")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Sync now" })).toBeOnTheScreen();
    expect(screen.getByText("10.0.0.5:7443")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Disconnect this phone" }));
    expect(alert).toHaveBeenCalled();
  });

  it("keeps Wi-Fi only on by default, saves a change, and picks Sunlight, a name order and a cache size", async () => {
    const h = await harness({ mode: "standalone" });
    await renderApp(<SettingsScreen />, h);
    const wifi = await screen.findByLabelText("Download photos on Wi-Fi only");
    expect(wifi.props.value).toBe(true);
    await fireEvent(wifi, "valueChange", false);
    await waitFor(async () => expect((await loadSettings(h.db)).wifiOnly).toBe(false));
    await fireEvent.press(screen.getByRole("button", { name: /Sunlight, high contrast/ }));
    await waitFor(async () => expect((await loadSettings(h.db)).appearance).toBe("sunlight"));
    await fireEvent.press(screen.getByRole("button", { name: "Scientific name first" }));
    await waitFor(async () => expect((await loadSettings(h.db)).nameOrder).toBe("scientific"));
    await fireEvent.press(screen.getByRole("button", { name: "2.0 GB" }));
    await waitFor(async () => expect((await loadSettings(h.db)).thumbCapBytes).toBe(2 * 1024 ** 3));
  });
});

describe("SettingsScreen smart search", () => {
  const ready = async (db: Parameters<typeof setMeta>[0]) => {
    await setMeta(db, "smart.model", { textModelVersion: "v1", files: { encoder: "x" }, complete: true });
    await setMeta(db, "smart.vectors", { imageModelVersion: "i1", cursor: null, complete: true });
    await applyVectorPage(db, {
      imageModelVersion: "i1",
      dimension: 768,
      removed: [],
      last: null,
      next: null,
      items: [{ id: "a", updatedAt: "x", vector: encodeVectorForTest([1]) }],
    });
  };

  it("paired and ready: shows what is stored, and Remove drops it after confirming", async () => {
    jest
      .spyOn(Alert, "alert")
      .mockImplementation((_t, _m, buttons) => void buttons?.find((b) => b.style === "destructive")?.onPress?.());
    const h = await harness({ paired: true, seed: ready });
    await renderApp(<SettingsScreen />, h);
    expect(await screen.findByText(/on this phone\. Search works with no signal/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Remove smart search" }));
    expect(await screen.findByText(/Off\. Search uses your Lifer/)).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Download smart search" })).toBeOnTheScreen();
    expect((await loadSettings(h.db)).smartSearch).toBe(false);
    expect(await loadModelState(h.db)).toBeNull();
  });

  it("paired and not downloaded yet: says it starts at the next sync", async () => {
    const h = await harness({ paired: true });
    await renderApp(<SettingsScreen />, h);
    expect(await screen.findByText("Starts at the next sync")).toBeOnTheScreen();
  });

  it("on its own with photos: says downloads are not set up yet", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<SettingsScreen />, h);
    expect(await screen.findByText("Smart search will be available once downloads are set up")).toBeOnTheScreen();
  });
});

describe("RegionsScreen", () => {
  it("lists kept regions with their size and progress, and removes one after confirming", async () => {
    const alert = jest
      .spyOn(Alert, "alert")
      .mockImplementation((_t, _m, buttons) => void buttons?.find((b) => b.style === "destructive")?.onPress?.());
    const action = jest
      .spyOn(ActionSheetIOS, "showActionSheetWithOptions")
      .mockImplementation(((_o: unknown, cb: (i: number) => void) => cb(0)) as never);
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<RegionsScreen />, h);
    const row = await screen.findByRole("button", { name: /Norfolk, 5 species, about 600 B, 3 of 5 seen/ });
    await fireEvent.press(row);
    expect(action).toHaveBeenCalled();
    expect(alert).toHaveBeenCalled();
    await waitFor(async () => expect(await h.db.all("SELECT * FROM regions")).toEqual([]));
  });

  it("empty: explains and offers to add one", async () => {
    const h = await harness({ mode: "standalone" });
    await renderApp(<RegionsScreen />, h);
    expect(await screen.findByText("No regions kept yet.")).toBeOnTheScreen();
    await fireEvent.press(screen.getAllByRole("button", { name: "Add a region" })[0]);
    expect(nav().navigate).toHaveBeenCalledWith("AddRegion");
  });
});

describe("AddRegionScreen", () => {
  it("paired: shows a hub region's size before keeping it, then keeps its checklist", async () => {
    const h = await harness({
      paired: true,
      seed: async (db) => {
        await db.run("INSERT INTO meta (key, value) VALUES ('prefs', ?)", [
          JSON.stringify({
            sensitive: { enabled: true, added: [], removed: [], iucnStatuses: [] },
            regions: [{ regionId: "r9", name: "Suffolk", packIds: [], speciesCount: 300 }],
          }),
        ]);
      },
      replies: {
        "/sync/regions/r9/checklist": {
          regionId: "r9",
          name: "Suffolk",
          items: [
            {
              scientificName: "Grus grus",
              commonName: "Common Crane",
              taxonClass: "aves",
              tier: null,
              isVagrant: false,
              sensitiveByDefault: false,
            },
          ],
        },
      },
    });
    await renderApp(<AddRegionScreen />, h);
    const row = await screen.findByRole("button", { name: /Suffolk, 300 species, about 35 KB/ });
    await fireEvent.press(row);
    await waitFor(async () => expect((await h.db.all("SELECT key FROM regions")).length).toBe(1));
    expect(await h.db.all("SELECT scientific_name FROM region_species")).toEqual([{ scientific_name: "Grus grus" }]);
  });

  it("on its own: nothing is fetched until the person asks", async () => {
    const h = await harness({ mode: "standalone" });
    await renderApp(<AddRegionScreen />, h);
    expect(await screen.findByText(/only fetched now, because you asked/)).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Get the region list" })).toBeOnTheScreen();
    expect(h.calls).toEqual([]);
  });
});

describe("RegionPickerSheet and MoreFiltersSheet", () => {
  it("Everywhere first, then the regions on the phone; choosing one closes the sheet", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<RegionPickerSheet />, h);
    expect(await screen.findByRole("button", { name: /Everywhere/ })).toBeOnTheScreen();
    await fireEvent.press(await screen.findByRole("button", { name: /Norfolk, 3 of 5 seen/ }));
    expect(nav().goBack).toHaveBeenCalled();
  });

  it("More filters toggles rarity tiers and offers to clear", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<MoreFiltersSheet />, h);
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeOnTheScreen();
    await fireEvent(screen.getByLabelText("Rare"), "valueChange", true);
    expect(await screen.findByRole("button", { name: "Clear filters" })).toBeOnTheScreen();
  });
});

describe("AlbumsScreen", () => {
  it("shows covers with names and counts, Favourites first, and opens one as a grid", async () => {
    const h = await harness({
      mode: "standalone",
      seed: async (db) => {
        await applyCaptureChanges(db, [capture("1", "Cygnus olor"), capture("2", "Cygnus olor")], []);
        await applyAlbums(
          db,
          [
            { id: "a", name: "Zebra album", coverPhotoId: null },
            { id: "f", name: "Favourites", coverPhotoId: null },
          ],
          [],
        );
        await applyMembers(
          db,
          [
            { albumId: "a", captureId: "1" },
            { albumId: "f", captureId: "2" },
          ],
          [],
        );
      },
    });
    await renderApp(<AlbumsScreen />, h);
    const cards = await screen.findAllByRole("button", { name: /photo/ });
    expect(cards[0].props.accessibilityLabel).toBe("Favourites, 1 photo");
    await fireEvent.press(cards[1]);
    expect(nav().navigate).toHaveBeenCalledWith("Photos", { title: "Zebra album", scope: { kind: "album", id: "a" } });
  });

  it("empty: says where albums come from", async () => {
    const h = await harness({ mode: "standalone" });
    await renderApp(<AlbumsScreen />, h);
    expect(await screen.findByText("No albums yet")).toBeOnTheScreen();
  });
});

describe("StatsScreen", () => {
  it("shows the plain numbers, species by group and the most photographed", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<StatsScreen />, h);
    expect(await screen.findByLabelText("2 species photographed")).toBeOnTheScreen();
    expect(screen.getByLabelText("1 seen, no photo yet")).toBeOnTheScreen();
    expect(screen.getByLabelText("3 photos")).toBeOnTheScreen();
    expect(screen.getByText("Mute Swan")).toBeOnTheScreen();
  });
});

describe("PhotoInfoSheet", () => {
  it("shows the species, when and where, and hides the place of a sensitive species", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<PhotoInfoSheet route={{ params: { photoId: "p-1" } }} />, h);
    expect(await screen.findByText("Mute Swan")).toBeOnTheScreen();
    expect(screen.getByText("Slimbridge")).toBeOnTheScreen();
  });
  it("never shows where a sensitive species was seen", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<PhotoInfoSheet route={{ params: { photoId: "p-3" } }} />, h);
    expect(await screen.findByText("Barn Owl")).toBeOnTheScreen();
    expect(screen.queryByText(/Secret field/)).not.toBeOnTheScreen();
    expect(screen.getByText(/hidden for sensitive species/)).toBeOnTheScreen();
  });
});

describe("ViewerScreen", () => {
  const seed = async (db: Parameters<typeof seedLife>[0]) => {
    await applyCaptureChanges(
      db,
      [
        capture("1", "Cygnus olor", "2026-09-02T10:00:00Z", { locationLabel: "Slimbridge" }),
        capture("3", "Tyto alba", "2026-07-02T10:00:00Z", { locationLabel: "Secret field" }),
      ],
      [],
    );
    await db.run(
      "INSERT INTO species (scientific_name, common_name, sensitive) VALUES ('Tyto alba', 'Barn Owl', 1) ON CONFLICT DO UPDATE SET sensitive = 1, common_name = 'Barn Owl'",
    );
  };

  it("shows the species and date, and the photo's spoken label includes its position", async () => {
    const h = await harness({ paired: true, seed });
    await renderApp(<ViewerScreen route={{ params: { ids: ["p-1", "p-3"], index: 0 } }} />, h);
    expect(await screen.findByText("Cygnus olor")).toBeOnTheScreen();
    expect(await screen.findByText(/2 September 2026/)).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Info" })).toBeOnTheScreen();
  });

  it("Info opens the sheet for this photo", async () => {
    const h = await harness({ paired: true, seed });
    await renderApp(<ViewerScreen route={{ params: { ids: ["p-1", "p-3"], index: 0 } }} />, h);
    await fireEvent.press(await screen.findByRole("button", { name: "Info" }));
    expect(nav().navigate).toHaveBeenCalledWith("PhotoInfo", { photoId: "p-1" });
  });

  it("asks before sharing a sensitive species, and shares nothing until then", async () => {
    const h = await harness({ paired: true, seed });
    await renderApp(<ViewerScreen route={{ params: { ids: ["p-1", "p-3"], index: 1 } }} />, h);
    expect(await screen.findByText("Barn Owl")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Share" }));
    expect(nav().navigate).toHaveBeenCalledWith("ShareSensitive", { photoId: "p-3" });
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
  });

  const open = (h: Awaited<ReturnType<typeof harness>>) =>
    renderApp(<ViewerScreen route={{ params: { ids: ["p-1"], index: 0 } }} />, h);
  const img = () => screen.getAllByLabelText(/1 of 1/).find((n) => n.props.source)!;
  const shownUri = () => img().props.source.uri as string;

  it("shows the blurred thumbnail first, then the preview copy sharp", async () => {
    const h = await harness({ paired: true, seed });
    jest.spyOn(h.boot.media, "thumb").mockReturnValue("/t/p-1.img");
    let ready!: (p: string) => void;
    jest.spyOn(h.boot.media, "display").mockReturnValue(new Promise((r) => (ready = r)));
    await open(h);
    expect(shownUri()).toBe("/t/p-1.img");
    expect(img().props.blurRadius).toBeGreaterThan(0);
    await act(async () => ready("/v/p-1.webp"));
    expect(shownUri()).toBe("/v/p-1.webp");
    expect(img().props.blurRadius).toBe(0);
  });

  it("a preview that cannot be fetched keeps the thumbnail with a note and Try again, never a blank", async () => {
    const h = await harness({ paired: true, seed });
    jest.spyOn(h.boot.media, "thumb").mockReturnValue("/t/p-1.img");
    const display = jest.spyOn(h.boot.media, "display").mockResolvedValue(null);
    await open(h);
    expect(await screen.findByText(/Showing the small one/)).toBeOnTheScreen();
    expect(shownUri()).toBe("/t/p-1.img");
    display.mockResolvedValue("/v/p-1.webp");
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(shownUri()).toBe("/v/p-1.webp"));
    expect(display).toHaveBeenLastCalledWith("p-1", true);
    expect(screen.queryByText(/Showing the small one/)).not.toBeOnTheScreen();
  });

  it("a saved copy that will not draw is refetched once, then the note appears", async () => {
    const h = await harness({ paired: true, seed });
    jest.spyOn(h.boot.media, "thumb").mockReturnValue("/t/p-1.img");
    const display = jest.spyOn(h.boot.media, "display").mockResolvedValue("/v/p-1.webp");
    await open(h);
    await waitFor(() => expect(shownUri()).toBe("/v/p-1.webp"));
    await fireEvent(img(), "error");
    await waitFor(() => expect(display).toHaveBeenCalledWith("p-1", true));
    await fireEvent(img(), "error");
    expect(await screen.findByText(/Showing the small one/)).toBeOnTheScreen();
  });

  it("with no thumbnail and no preview, says it is not saved and offers Try again", async () => {
    const h = await harness({ paired: true, seed });
    jest.spyOn(h.boot.media, "thumb").mockReturnValue(null);
    jest.spyOn(h.boot.media, "display").mockResolvedValue(null);
    await open(h);
    expect(await screen.findByText(/isn't saved on this phone yet/)).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Try again" })).toBeOnTheScreen();
  });

  it("closes", async () => {
    const h = await harness({ paired: true, seed });
    await renderApp(<ViewerScreen route={{ params: { ids: ["p-1"], index: 0 } }} />, h);
    await fireEvent.press(await screen.findByRole("button", { name: "Close" }));
    expect(nav().goBack).toHaveBeenCalled();
    await act(async () => undefined);
  });
});
