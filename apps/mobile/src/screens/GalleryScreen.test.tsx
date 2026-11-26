import { describe, expect, it } from "@jest/globals";
import "@testing-library/react-native/matchers";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { applyVectorPage } from "../search/vectorStore";
import { encodeVectorForTest } from "../search/vectorTestUtil";
import { applyCaptureChanges } from "../store/library";
import { setMeta } from "../store/meta";
import { barItem, harness, nav, renderApp, typeInSearch } from "../testing/harness";
import { capture, seedLife } from "../testing/seed";
import { GalleryScreen } from "./GalleryScreen";

describe("GalleryScreen", () => {
  it("not connected: says where photos come from and offers to connect", async () => {
    const h = await harness({ mode: "standalone" });
    await renderApp(<GalleryScreen />, h);
    expect(await screen.findByText(/appear here once you connect/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Connect to your computer or server" }));
    expect(nav().navigate).toHaveBeenCalledWith("Connect");
  });

  it("paired with nothing yet: points at pull to refresh", async () => {
    const h = await harness({ paired: true });
    await renderApp(<GalleryScreen />, h);
    expect(await screen.findByText(/Pull down to sync/)).toBeOnTheScreen();
  });

  it("shows the library by month with headings and the count, and opens the viewer on the tapped photo", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<GalleryScreen />, h);
    expect(await screen.findByText(/September 2026/)).toBeOnTheScreen();
    expect(screen.getByText(/August 2026/)).toBeOnTheScreen();
    expect(screen.getByText("3 photos")).toBeOnTheScreen();
    const tiles = await screen.findAllByRole("imagebutton");
    expect(tiles).toHaveLength(3);
    expect(screen.getByLabelText("Mute Swan, 2 September 2026")).toBeOnTheScreen();
    await fireEvent.press(tiles[1]);
    expect(nav().navigate).toHaveBeenCalledWith("Viewer", { ids: ["p-1", "p-2", "p-3"], index: 1 });
  });

  it("Continuous layout drops the month headings and keeps every photo; the View menu also offers 16 across", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<GalleryScreen />, h);
    expect(await screen.findByText(/September 2026/)).toBeOnTheScreen();
    await barItem("Continuous").press();
    await waitFor(() => expect(screen.queryByText(/September 2026/)).not.toBeOnTheScreen());
    expect(screen.getAllByRole("imagebutton")).toHaveLength(3);
    await barItem("By date").press();
    expect(await screen.findByText(/September 2026/)).toBeOnTheScreen();
  });

  it("at 16 across the grid is continuous whatever the layout, and the choice returns at fewer columns", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<GalleryScreen />, h);
    expect(await screen.findByText(/September 2026/)).toBeOnTheScreen();
    await barItem("16 across").press();
    await waitFor(() => expect(screen.queryByText(/September 2026/)).not.toBeOnTheScreen());
    expect(screen.getAllByRole("imagebutton")).toHaveLength(3);
    await barItem("3 across").press();
    expect(await screen.findByText(/September 2026/)).toBeOnTheScreen();
  });

  it("searches offline by species name from the plural, and by place", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<GalleryScreen />, h);
    await screen.findAllByRole("imagebutton");
    await typeInSearch("swans");
    await waitFor(() => expect(screen.getAllByRole("imagebutton")).toHaveLength(2));
    expect(screen.queryByText(/September 2026/)).not.toBeOnTheScreen();
    await typeInSearch("slimbridge");
    await waitFor(() => expect(screen.getAllByRole("imagebutton")).toHaveLength(1));
    await typeInSearch("dragons");
    expect(await screen.findByText("No photos match dragons.")).toBeOnTheScreen();
  });

  it("with smart search ready, answers on the phone without asking the hub", async () => {
    const embed = async (texts: string[]) =>
      texts.map(() => Float32Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)));
    const h = await harness({
      paired: true,
      embed,
      replies: { "/sync/changes": { items: [], purged: [], last: null, next: null } },
      seed: async (db) => {
        await seedLife(db);
        await setMeta(db, "smart.model", { textModelVersion: "v1", files: { encoder: "x" }, complete: true });
        await setMeta(db, "smart.vectors", { imageModelVersion: "i1", cursor: null, complete: true });
        await applyVectorPage(db, {
          imageModelVersion: "i1",
          dimension: 768,
          removed: [],
          last: null,
          next: null,
          items: ["1", "2", "3"].map((id) => ({ id, updatedAt: "x", vector: encodeVectorForTest([0, 1]) })),
        });
      },
    });
    await renderApp(<GalleryScreen />, h);
    await screen.findAllByRole("imagebutton");
    await typeInSearch("swans");
    await waitFor(() => expect(screen.getAllByRole("imagebutton")).toHaveLength(2));
    expect(await screen.findByText("2 photos match")).toBeOnTheScreen();
    expect(h.calls.some((c) => c.includes("/gallery/search"))).toBe(false);
  });

  it("shows what a multi-part search was read as, as tokens that take their words out when removed", async () => {
    const embed = async (texts: string[]) =>
      texts.map(() => Float32Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)));
    const h = await harness({
      paired: true,
      embed,
      replies: { "/sync/changes": { items: [], purged: [], last: null, next: null } },
      seed: async (db) => {
        await seedLife(db);
        await setMeta(db, "smart.model", { textModelVersion: "v1", files: { encoder: "x" }, complete: true });
        await setMeta(db, "smart.vectors", { imageModelVersion: "i1", cursor: null, complete: true });
      },
    });
    await renderApp(<GalleryScreen />, h);
    await screen.findAllByRole("imagebutton");
    await typeInSearch("swans in 2026");
    const remove = await screen.findByRole("button", { name: /^Remove filter: .*2026/ });
    expect(screen.getByRole("button", { name: /^Remove filter: .*swan/i })).toBeOnTheScreen();
    await fireEvent.press(remove);
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Remove filter: .*2026/ })).not.toBeOnTheScreen());
    // One part left is no longer a list of tokens.
    expect(screen.queryByRole("button", { name: /^Remove filter:/ })).not.toBeOnTheScreen();
  });

  it("while smart search is still downloading and the hub is out of reach, says so under the saved matches", async () => {
    const h = await harness({ paired: true, seed: seedLife });
    await renderApp(<GalleryScreen />, h);
    await screen.findAllByRole("imagebutton");
    await act(async () => {
      (h.boot.smart as unknown as { set(p: object): void }).set({ phase: "downloading", done: 1, total: 4 });
    });
    await typeInSearch("swans");
    expect(await screen.findByText(/Smart search is still getting ready/)).toBeOnTheScreen();
  });

  it("a year filter narrows, counts on the Filters button, and the View menu changes the rows", async () => {
    const h = await harness({
      mode: "standalone",
      seed: async (db) => (await seedLife(db), await setMeta(db, "galleryView", { year: "2026" })),
    });
    await renderApp(<GalleryScreen />, h);
    expect(await screen.findByText("3 photos match")).toBeOnTheScreen();
    await barItem("Filters, 1 on").press();
    expect(nav().navigate).toHaveBeenCalledWith("Filters", { scope: "gallery" });
    await barItem("1 across").press();
    await waitFor(() => expect(screen.getAllByRole("imagebutton")).toHaveLength(3));
    await barItem("Aspect ratio grid").press();
    await waitFor(() => expect(screen.getAllByRole("imagebutton")).toHaveLength(3));
  });

  it("with the hub reachable, its search adds photos the phone did not find", async () => {
    const h = await harness({
      paired: true,
      seed: async (db) => applyCaptureChanges(db, [capture("1", "Cygnus olor")], []),
      replies: { "/gallery/search": { items: [{ photoId: "p-remote", takenAt: null }] } },
    });
    await renderApp(<GalleryScreen />, h);
    await screen.findAllByRole("imagebutton");
    await typeInSearch("sunset");
    await waitFor(() => expect(h.calls.some((c) => c.startsWith("GET /gallery/search?q=sunset"))).toBe(true));
    await waitFor(() => expect(screen.getAllByRole("imagebutton")).toHaveLength(1));
  });

  it("handles a big library without drawing it all", async () => {
    const h = await harness({
      mode: "standalone",
      seed: async (db) => {
        await db.tx(async () => {
          for (let i = 0; i < 20000; i++)
            await db.run(
              "INSERT INTO captures (id, photo_id, scientific_name, taken_at) VALUES (?, ?, 'Cygnus olor', ?)",
              [`c${i}`, `p${i}`, `2025-${String(1 + (i % 12)).padStart(2, "0")}-15T00:00:00Z`],
            );
        });
      },
    });
    await renderApp(<GalleryScreen />, h);
    const tiles = await screen.findAllByRole("imagebutton");
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThan(500);
  });
});
