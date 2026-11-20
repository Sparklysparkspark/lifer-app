// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LightboxSlide } from "../components/Lightbox";

const get = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a) },
}));
vi.mock("../components/Lightbox", () => ({
  default: (p: { slides: LightboxSlide[]; index: number; onClose: () => void }) => (
    <div data-testid="viewer" data-count={p.slides.length} data-url={p.slides[p.index].url}>
      <button onClick={p.onClose}>close viewer</button>
    </div>
  ),
}));

const { default: YearInReviewPage } = await import("./YearInReviewPage");

const counts = { photos: 3, newSpecies: 2, trips: 0, places: 1 };
const review = {
  year: 2025,
  years: [2025],
  counts,
  previous: { photos: 0, newSpecies: 0, trips: 0, places: 0 },
  firsts: {
    total: 2,
    items: [
      { speciesId: "s1", scientificName: "Alpha one", commonName: "Alpha", firstTakenAt: null, photoId: "f1" },
      { speciesId: "s2", scientificName: "Beta two", commonName: "Beta", firstTakenAt: null, photoId: "f2" },
    ],
  },
  bestPhotos: [
    { captureId: "c1", photoId: "b1", speciesId: "s1", width: 400, height: 300 },
    { captureId: "c2", photoId: "b2", speciesId: "s2", width: 400, height: 300 },
    { captureId: "c3", photoId: "b3", speciesId: "s2", width: 400, height: 300 },
  ],
  monthsByGroup: [],
  trips: [],
  gear: { cameras: [], lenses: [] },
};

afterEach(cleanup);

describe("YearInReviewPage", () => {
  it("opens a best photo full size, with that section's photos as the slides", async () => {
    get.mockResolvedValue(review);
    render(
      <MemoryRouter>
        <YearInReviewPage />
      </MemoryRouter>,
    );
    const best = await screen.findAllByRole("button", { name: "Open photo" });
    fireEvent.click(best[1]);
    const viewer = screen.getByTestId("viewer");
    expect([viewer.dataset.count, viewer.dataset.url]).toEqual(["3", "/api/photos/b2/display"]);

    fireEvent.click(screen.getByText("close viewer"));
    expect(screen.queryByTestId("viewer")).toBeNull();
    expect(screen.getByText("Best photos")).toBeTruthy();
  });

  it("opens a first's photo instead of leaving the page; its name still links to the species", async () => {
    get.mockResolvedValue(review);
    render(
      <MemoryRouter>
        <YearInReviewPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open photo of Beta" }));
    const viewer = screen.getByTestId("viewer");
    expect([viewer.dataset.count, viewer.dataset.url]).toEqual(["2", "/api/photos/f2/display"]);
    expect(screen.getByRole("link", { name: "Beta" }).getAttribute("href")).toBe("/species/s2");
  });
});
