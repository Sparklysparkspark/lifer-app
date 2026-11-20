// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LightboxSlide } from "../../components/Lightbox";

// The grid's layout and the viewer have their own tests; this checks what the set hands them.
vi.mock("../../components/PhotoGrid", () => ({
  default: (p: { items: Array<{ photoId: string }>; onOpen: (i: number) => void }) => (
    <ul>
      {p.items.map((item, i) => (
        <li key={item.photoId}>
          <button onClick={() => p.onOpen(i)}>{item.photoId}</button>
        </li>
      ))}
    </ul>
  ),
}));
vi.mock("../../components/Lightbox", () => ({
  default: (p: { slides: LightboxSlide[]; index: number; onClose: () => void }) => (
    <div data-testid="viewer" data-count={p.slides.length} data-url={p.slides[p.index].url}>
      <button onClick={p.onClose}>close viewer</button>
    </div>
  ),
}));

const { default: PhotoSetModal } = await import("./PhotoSetModal");

afterEach(cleanup);

describe("PhotoSetModal", () => {
  it("shows every photo, opens one with arrows through all of them, and returns to the grid", () => {
    const photos = Array.from({ length: 37 }, (_, i) => ({ photoId: `p${i}` }));
    render(<PhotoSetModal title="37 photos, 400mm, 1/1250" photos={photos} onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "37 photos, 400mm, 1/1250" })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(37);

    fireEvent.click(screen.getByText("p20"));
    const viewer = screen.getByTestId("viewer");
    expect([viewer.dataset.count, viewer.dataset.url]).toEqual(["37", "/api/photos/p20/display"]);

    fireEvent.click(screen.getByText("close viewer"));
    expect(screen.queryByTestId("viewer")).toBeNull();
    expect(screen.getByText("p36")).toBeTruthy();
  });
});
