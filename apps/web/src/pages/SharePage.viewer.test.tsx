// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { LightboxSlide } from "../components/Lightbox";

const get = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
const shown: LightboxSlide[][] = [];
vi.mock("../components/Lightbox", () => ({
  default: ({ slides }: { slides: LightboxSlide[] }) => {
    shown.push(slides);
    return null;
  },
}));

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopObserver);
vi.stubGlobal("IntersectionObserver", NoopObserver);

const { default: SharePage } = await import("./SharePage");

describe("SharePage viewer", () => {
  it("shows the shared thumbnail while each photo loads, so paging never flashes black", async () => {
    get.mockResolvedValue({
      title: "Backyard",
      allowDownload: false,
      items: [
        {
          photoId: "p1",
          captureId: "c1",
          width: 4,
          height: 3,
          commonName: "American Robin",
          scientificName: "Turdus migratorius",
        },
      ],
    });
    render(
      <MemoryRouter initialEntries={["/share/t1"]}>
        <Routes>
          <Route path="/share/:token" element={<SharePage />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click((await screen.findAllByRole("img"))[0]);
    const slide = shown.at(-1)![0];
    expect([slide.thumbUrl, slide.width, slide.height]).toEqual(["/api/share/t1/photos/p1/thumb", 4, 3]);
  });
});
