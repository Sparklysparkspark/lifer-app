// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ScatterPoint } from "./types";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const { CountriesCard, ScatterCard } = await import("./StatsCharts");

describe("StatsCharts", () => {
  it("gives a dot's card one number: the heading's, with a plain View all", () => {
    const photo = (i: number) =>
      ({
        photoId: i < 14 ? `p${i}` : null,
        commonName: "Heron",
        scientificName: "Ardea",
        focalLength: 400,
        aperture: 5.6,
      }) as unknown as ScatterPoint;
    const photos = Array.from({ length: 16 }, (_, i) => photo(i));
    render(
      <ScatterCard
        group={{ ...photos[0], photos, count: 16 }}
        xKey="focalLength"
        yKey="aperture"
        onOpen={() => {}}
        onViewAll={() => {}}
      />,
    );
    expect(screen.getByText("16 photos")).toBeTruthy();
    expect(screen.getByRole("button", { name: "View all" })).toBeTruthy();
  });

  it("shows a long country name in full on hover", () => {
    const long = "The United Kingdom of Great Britain and Northern Ireland and its Overseas Territories";
    const countries = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      name: i === 0 ? long : `Land ${i}`,
      photoCount: 2,
    }));
    render(
      <MemoryRouter>
        <CountriesCard countries={{ count: 6, countries } as never} />
      </MemoryRouter>,
    );
    expect(screen.getByText(long).getAttribute("title")).toBe(long);
  });
});
