import { describe, expect, it } from "@jest/globals";
import "@testing-library/react-native/matchers";
import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { barItem, harness, nav, renderApp } from "../testing/harness";
import { seedLife } from "../testing/seed";
import { StartTripSheet } from "./StartTripSheet";
import { TripScreen } from "./TripScreen";
import { TripsScreen } from "./TripsScreen";

describe("TripsScreen", () => {
  it("empty: invites a first trip", async () => {
    const h = await harness({ mode: "standalone" });
    await renderApp(<TripsScreen />, h);
    expect(await screen.findByText("No trips yet")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Start a trip" }));
    expect(nav().navigate).toHaveBeenCalledWith("StartTrip");
  });

  it("lists past trips with their dates and counts, and the active one as a Now card with progress", async () => {
    const h = await harness({
      mode: "standalone",
      seed: async (db) => {
        await seedLife(db);
        await db.run(
          "INSERT INTO trips (id, name, start_date, end_date, local) VALUES ('t1', 'Norfolk weekend', '2020-05-01', '2020-05-03', 0)",
        );
        await db.run(
          "INSERT INTO trips (id, name, start_date, region_id, active_override, local) VALUES ('t2', 'Wetlands', '2026-10-25', 'hub:r1', 1, 1)",
        );
      },
    });
    await renderApp(<TripsScreen />, h);
    expect(
      await screen.findByRole("button", { name: /Norfolk weekend, 1 to 3 May 2020, 0 species/ }),
    ).toBeOnTheScreen();
    expect(screen.getByText("Wetlands")).toBeOnTheScreen();
    expect(screen.getByText("3 of 5 species seen")).toBeOnTheScreen();
    expect(screen.getByText("1 target left")).toBeOnTheScreen();
  });

  it("Your targets in a region lists seen-not-photographed first, with no location prompt", async () => {
    const h = await harness({
      mode: "standalone",
      seed: async (db) => {
        await seedLife(db);
        await db.run(
          "INSERT OR IGNORE INTO species (scientific_name, common_name, taxon_class, tier) VALUES ('Zz a', 'Aardvark', 'mammalia', 'common'), ('Zz b', 'Badger', 'mammalia', 'rare'), ('Zz c', 'Coati', 'mammalia', 'common')",
        );
        await db.run(
          "INSERT INTO region_species (region_key, scientific_name) VALUES ('hub:r1', 'Zz a'), ('hub:r1', 'Zz b'), ('hub:r1', 'Zz c')",
        );
        await db.run(
          "INSERT INTO marks (scientific_name, state, is_target, local_at) VALUES ('Zz a', NULL, 1, 'x'), ('Zz b', NULL, 1, 'x'), ('Zz c', 'seen', 1, 'x')",
        );
      },
    });
    await renderApp(<TripsScreen />, h);
    expect(await screen.findByText("Coati")).toBeOnTheScreen();
    const names = screen.getAllByText(/^(Aardvark|Badger|Coati)$/).map((n) => n.props.children);
    expect(names).toEqual(["Coati", "Badger", "Aardvark"]);
    expect(screen.queryByText(/near you/i)).toBeNull();
  });
});

describe("StartTripSheet", () => {
  it("starting a trip opens trip mode on the region's list", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<StartTripSheet />, h);
    await fireEvent.changeText(await screen.findByLabelText("Trip name"), "Wetlands");
    await fireEvent.press(await screen.findByRole("button", { name: /Norfolk/ }));
    await fireEvent.press(screen.getByRole("button", { name: "Start a trip" }));
    await waitFor(async () =>
      expect(await h.db.all("SELECT name, local, region_id FROM trips")).toEqual([
        { name: "Wetlands", local: 1, region_id: "r1" },
      ]),
    );
  });
});

const started = async () =>
  harness({
    mode: "standalone",
    seed: async (db) => {
      await seedLife(db);
      await db.run(
        "INSERT INTO trips (id, name, start_date, region_id, active_override, local) VALUES ('t1', 'Wetlands', '2026-10-25', 'hub:r1', 1, 1)",
      );
    },
  });

describe("TripScreen", () => {
  it("shows progress and End trip in the menu", async () => {
    const h = await started();
    await renderApp(<TripScreen route={{ params: { id: "t1" } }} />, h);
    expect(await screen.findByText("3 of 5 species seen")).toBeOnTheScreen();
    await barItem("End trip");
  });

  it("the segmented control switches to the trip's photos", async () => {
    const h = await started();
    await renderApp(<TripScreen route={{ params: { id: "t1" } }} />, h);
    const seg = await screen.findByLabelText("Show on this trip");
    await fireEvent(seg, "change", { nativeEvent: { selectedSegmentIndex: 1 } });
    expect(await screen.findByText("No photos from this trip yet.")).toBeOnTheScreen();
  });
});

describe("StartTripSheet name", () => {
  it("caps the trip name at 255 characters and counts down near the limit", async () => {
    const h = await harness({ mode: "standalone" });
    await renderApp(<StartTripSheet />, h);
    const field = screen.getByLabelText("Trip name");
    expect(field.props.maxLength).toBe(255);
    expect(screen.queryByText(/characters left/)).toBeNull();
    await fireEvent.changeText(field, "a".repeat(250));
    expect(screen.getByText("5 characters left")).toBeOnTheScreen();
  });
});
