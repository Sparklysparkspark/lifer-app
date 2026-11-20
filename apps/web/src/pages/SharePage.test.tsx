// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopObserver);
vi.stubGlobal("IntersectionObserver", NoopObserver);

const { default: SharePage } = await import("./SharePage");
const { resetSpeciesNamePrefsCache, setSpeciesNamePrefs } = await import("../lib/speciesName");

const robin = {
  photoId: "p1",
  captureId: "c1",
  width: 100,
  height: 100,
  commonName: "American Robin",
  scientificName: "Turdus migratorius",
  abaCode: "AMRO",
  ebirdCode: "amerob",
};

function renderShare(speciesNames?: { main: string; also: string[] }) {
  get.mockResolvedValue({ title: "Backyard", allowDownload: false, items: [robin], speciesNames });
  render(
    <MemoryRouter initialEntries={["/share/t1"]}>
      <Routes>
        <Route path="/share/:token" element={<SharePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  resetSpeciesNamePrefsCache();
  get.mockReset();
});

describe("SharePage", () => {
  it("names species the way the album's owner does, not this browser's choice", async () => {
    setSpeciesNamePrefs({ main: "common" });
    renderShare({ main: "scientific", also: ["aba"] });
    expect(await screen.findByAltText("Turdus migratorius")).toBeTruthy();
  });

  it("falls back to common names first without an owner's choice", async () => {
    setSpeciesNamePrefs({ main: "scientific" });
    renderShare();
    expect(await screen.findByAltText("American Robin")).toBeTruthy();
  });
});
