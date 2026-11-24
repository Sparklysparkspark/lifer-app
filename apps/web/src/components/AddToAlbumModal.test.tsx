// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: vi.fn() },
}));
vi.mock("../hooks/useToast", () => ({ useToast: () => ({ success: vi.fn() }) }));
const { default: AddToAlbumModal, orderAlbums } = await import("./AddToAlbumModal");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

const album = (id: string, createdAt: string, rules: object | null = null) => ({
  id,
  name: `Album ${id}`,
  createdAt,
  rules,
});

describe("orderAlbums", () => {
  it("puts the albums last added to first, then the newest", () => {
    const albums = [album("a", "2024-01-01"), album("b", "2026-01-01"), album("c", "2025-01-01")];
    expect(orderAlbums(albums, ["c"]).map((a) => a.id)).toEqual(["c", "b", "a"]);
  });
});

describe("AddToAlbumModal", () => {
  it("doesn't say there are no albums when only smart ones were left out", async () => {
    get.mockResolvedValue({ albums: [album("s", "2026-01-01", { version: 2, query: {} })] });
    render(<AddToAlbumModal captureIds={["c1"]} onClose={() => {}} />);
    expect(await screen.findByText(/Smart albums choose their own photos/)).toBeTruthy();
  });

  it("offers a search once there are more than 8 albums", async () => {
    get.mockResolvedValue({ albums: Array.from({ length: 12 }, (_, i) => album(`${i}`, "2026-01-01")) });
    render(<AddToAlbumModal captureIds={["c1"]} onClose={() => {}} />);
    const search = await screen.findByLabelText("Search albums by name");
    fireEvent.change(search, { target: { value: "Album 11" } });
    expect(screen.getAllByRole("button", { name: /^Album / }).map((b) => b.textContent)).toEqual(["Album 11"]);
  });
});
