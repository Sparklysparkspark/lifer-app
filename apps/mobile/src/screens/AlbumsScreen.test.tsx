import { describe, expect, it, jest } from "@jest/globals";
import "@testing-library/react-native/matchers";
import { fireEvent, screen } from "@testing-library/react-native";
import { harness, renderApp } from "../testing/harness";
import { seedLife } from "../testing/seed";
import { AlbumsScreen } from "./AlbumsScreen";
import { PhotosScreen } from "./PhotosScreen";
import { TripScreen } from "./TripScreen";

describe("AlbumsScreen", () => {
  it("lists the hub's albums, hand-picked and smart, with the photos each holds", async () => {
    const h = await harness({
      mode: "paired",
      paired: true,
      seed: async (db) => {
        await seedLife(db);
        await db.run("INSERT INTO albums (id, name) VALUES ('a1', 'Hand picked'), ('s1', 'Swans, smart')");
        await db.run("INSERT INTO album_captures (album_id, capture_id) VALUES ('a1', '1'), ('s1', '1'), ('s1', '2')");
      },
    });
    await renderApp(<AlbumsScreen />, h);
    expect(await screen.findByRole("button", { name: /Hand picked, 1 photo/ })).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: /Swans, smart, 2 photos/ })).toBeOnTheScreen();
  });

  it("shows an album's cover as the hub's square, asking for it by the saved crop", async () => {
    const h = await harness({
      mode: "paired",
      paired: true,
      seed: async (db) => {
        await seedLife(db);
        await db.run(
          "INSERT INTO albums (id, name, cover_photo_id, cover_crop_x, cover_crop_y, cover_crop_size) VALUES ('a1', 'Hand picked', 'p-1', 10, 20, 40)",
        );
        await db.run("INSERT INTO album_captures (album_id, capture_id) VALUES ('a1', '1')");
      },
    });
    const square = jest.spyOn(h.boot.media, "square").mockResolvedValue("/p/sq.webp");
    await renderApp(<AlbumsScreen />, h);
    const image = await screen.findByTestId("cropped-image");
    expect(image.props.source).toEqual({ uri: "/p/sq.webp" });
    expect(square).toHaveBeenCalledWith("album", "a1", "p-1", { x: 10, y: 20, size: 40 });
  });

  it("switches to Trips with the native control, remembers the choice, and switches back", async () => {
    const h = await harness({
      mode: "standalone",
      seed: async (db) => {
        await seedLife(db);
        await db.run("INSERT INTO albums (id, name) VALUES ('a1', 'Hand picked')");
        await db.run(
          "INSERT INTO trips (id, name, start_date, end_date, local) VALUES ('t1', 'Norfolk weekend', '2020-05-01', '2020-05-03', 0)",
        );
      },
    });
    await renderApp(<AlbumsScreen />, h);
    expect(await screen.findByRole("button", { name: /Hand picked/ })).toBeOnTheScreen();
    const seg = screen.getByLabelText("Albums or trips");
    await fireEvent(seg, "change", { nativeEvent: { selectedSegmentIndex: 1 } });
    expect(await screen.findByRole("button", { name: /Norfolk weekend/ })).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: /Hand picked/ })).toBeNull();
    expect(JSON.stringify(await h.db.all("SELECT value FROM meta WHERE key = 'settings'"))).toContain("trips");
    await fireEvent(screen.getByLabelText("Albums or trips"), "change", {
      nativeEvent: { selectedSegmentIndex: 0 },
    });
    expect(await screen.findByRole("button", { name: /Hand picked/ })).toBeOnTheScreen();
  });

  describe("long names wrap in full instead of ending in an ellipsis", () => {
    const long = "Wetland ".repeat(38).trim();
    const seeded = () =>
      harness({
        mode: "standalone",
        seed: async (db) => {
          await seedLife(db);
          await db.run("INSERT INTO albums (id, name) VALUES ('a1', ?)", [long]);
          await db.run(
            "INSERT INTO trips (id, name, start_date, end_date, local) VALUES ('t1', ?, '2020-05-01', '2020-05-03', 0)",
            [long],
          );
        },
      });
    const wraps = (el: { props: { numberOfLines?: number } }) => expect(el.props.numberOfLines).toBeUndefined();
    it("album cover", async () => {
      await renderApp(<AlbumsScreen />, await seeded());
      wraps(await screen.findByText(long));
    });
    it("album page title", async () => {
      await renderApp(
        <PhotosScreen route={{ params: { title: long, scope: { kind: "album", id: "a1" } } }} />,
        await seeded(),
      );
      wraps(await screen.findByText(long));
    });
    it("trip page title", async () => {
      await renderApp(<TripScreen route={{ params: { id: "t1" } }} />, await seeded());
      wraps(await screen.findByText(long));
    });
  });
});
