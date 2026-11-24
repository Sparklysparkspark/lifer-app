// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { TripSummary } from "@lifer/shared";
import TripCard from "./TripCard";

const trip = (over: Partial<TripSummary> = {}): TripSummary =>
  ({
    id: "t1",
    name: "Marsh weekend",
    sourceFolder: "/cards/marsh",
    speciesCount: 12,
    captureCount: 340,
    earliestTakenAt: null,
    latestTakenAt: null,
    coverPhotoUrl: null,
    coverCropX: null,
    coverCropY: null,
    coverCropSize: null,
    coverLayout: "single",
    quadPhotoIds: [],
    processing: false,
    startDate: null,
    endDate: null,
    activeOverride: null,
    ...over,
  }) as TripSummary;

afterEach(cleanup);

describe("TripCard", () => {
  it("reserves two title lines and pins the counts to the bottom, dates or not", () => {
    render(
      <MemoryRouter>
        <TripCard trip={trip()} />
        <TripCard trip={trip({ id: "t2", startDate: "2026-06-01", endDate: "2026-06-03" })} />
      </MemoryRouter>,
    );
    for (const counts of screen.getAllByText(/12 species/)) {
      expect(counts.parentElement!.className).toContain("mt-auto");
    }
    for (const title of screen.getAllByText("Marsh weekend")) {
      expect(title.parentElement!.className).toContain("min-h-[2lh]");
    }
  });
});
