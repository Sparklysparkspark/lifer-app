// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AlbumSharePanel from "./AlbumSharePanel";
import type { AlbumShares } from "./useAlbumShares";
import type { ShareLink } from "./types";

const link = (over: Partial<ShareLink> = {}): ShareLink => ({
  id: "s1",
  token: "abc",
  hasPassword: false,
  allowDownload: false,
  showMetadata: false,
  showExactLocations: false,
  expiresAt: null,
  revoked: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

function shares(list: ShareLink[]) {
  const setShowExactLocations = vi.fn();
  const setExactLocations = vi.fn();
  const value = {
    shares: list,
    now: Date.now(),
    form: {
      password: "",
      setPassword: vi.fn(),
      allowDownload: false,
      setAllowDownload: vi.fn(),
      showMetadata: false,
      setShowMetadata: vi.fn(),
      showExactLocations: false,
      setShowExactLocations,
      expiry: "never",
      setExpiry: vi.fn(),
      error: null,
      creating: false,
    },
    createShare: vi.fn(),
    revokeShare: vi.fn(),
    setExactLocations,
    copyShareUrl: vi.fn(),
  } as unknown as AlbumShares;
  return { value, setShowExactLocations, setExactLocations };
}

afterEach(cleanup);

describe("AlbumSharePanel", () => {
  it("leaves exact locations off for a new link, and says sensitive species stay coarse", () => {
    const s = shares([]);
    render(<AlbumSharePanel shares={s.value} />);
    const box = screen.getByRole("checkbox", { name: /Show exact locations/ });
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("Sensitive species only ever show their province or state and country.")).toBeTruthy();
    fireEvent.click(box);
    expect(s.setShowExactLocations).toHaveBeenCalledWith(true);
  });

  it("turns exact locations on or off for each existing link", () => {
    const s = shares([link(), link({ id: "s2", token: "def", showExactLocations: true })]);
    render(<AlbumSharePanel shares={s.value} />);
    const toggles = screen.getAllByRole("switch", { name: "Show exact locations" });
    expect(toggles.map((t) => t.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    fireEvent.click(toggles[0]);
    expect(s.setExactLocations).toHaveBeenCalledWith("s1", true);
  });
});
