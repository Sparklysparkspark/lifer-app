// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const ID = "00000000-0000-4000-8000-000000000001";
const REGION = "00000000-0000-4000-8000-000000000002";
const longName = "Pacific coast pelagics ".repeat(13).trim();
const get = vi.fn(async () => ({
  lists: [
    { id: ID, name: longName, regionId: REGION, regionName: "British Columbia", speciesIds: ["a", "b"] },
    { id: "x", name: "Anywhere", regionId: null, regionName: null, speciesIds: [] },
  ],
}));
const del = vi.fn(async (_path: string) => ({ ok: true }));
const patch = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: {
    get: () => get(),
    post: vi.fn(),
    put: vi.fn(),
    patch: (...a: unknown[]) => patch(...a),
    delete: (p: string) => del(p),
  },
}));

const { default: TargetListsRow } = await import("./TargetListsRow");
const { ConfirmContext } = await import("../../hooks/useConfirm");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderRow = (confirmed = true) =>
  render(
    <MemoryRouter>
      <ConfirmContext.Provider value={async () => confirmed}>
        <TargetListsRow />
      </ConfirmContext.Provider>
    </MemoryRouter>,
  );

describe("TargetListsRow", () => {
  it("lists each target list with its region and size, and links it to the Collection", async () => {
    renderRow();
    expect(await screen.findByText(longName)).toBeTruthy();
    expect(screen.getByText("2 species in British Columbia")).toBeTruthy();
    expect(screen.getByText("0 species, anywhere")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /more/i })[0]);
    const view = await screen.findByRole("menuitem", { name: "View in Collection" });
    expect(view.getAttribute("href")).toBe(`/?region=${REGION}&show=target&targetList=${ID}`);
  });

  it("filters a long set of lists", async () => {
    get.mockResolvedValueOnce({
      lists: Array.from({ length: 10 }, (_, i) => ({
        id: `l${i}`,
        name: i === 4 ? "Owls of Alberta" : `List ${i}`,
        regionId: null,
        regionName: null,
        speciesIds: [],
      })),
    });
    renderRow();
    fireEvent.change(await screen.findByRole("textbox", { name: "Filter target lists" }), {
      target: { value: "owls" },
    });
    expect(screen.getByText("Owls of Alberta")).toBeTruthy();
    expect(screen.queryByText("List 3")).toBeNull();
  });

  it("deletes a list after confirming, and renames one", async () => {
    renderRow();
    await screen.findByText(longName);
    fireEvent.click(screen.getAllByRole("button", { name: /more/i })[0]);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith(`/target-lists/${ID}`));

    fireEvent.click(screen.getAllByRole("button", { name: /more/i })[1]);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Rename target list" }), { target: { value: "Yard" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/target-lists/x", { name: "Yard" }));
  });
});
