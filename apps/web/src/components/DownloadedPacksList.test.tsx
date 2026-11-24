// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PackStatusEntry } from "../lib/packIndex";
import type { AddedSpeciesRow } from "./AddedSpeciesList";

const post = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: vi.fn(), post: (...a: unknown[]) => post(...a), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/usePackDownloadStatus", () => ({
  usePackDownloadJob: () => ({ status: null, start: vi.fn(), cancel: vi.fn(), actionError: null, cancelling: false }),
}));

const { default: DownloadedPacksList } = await import("./DownloadedPacksList");
const { ToastContext } = await import("../hooks/useToast");
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

const pack = { id: "pk-ca", type: "region", region: "Canada", downloaded: true, sizeBytes: 1000 } as PackStatusEntry;

function addedRow(key: string, opts: { removable: boolean; photographed?: number }) {
  return {
    country: "Canada",
    label: "Insects",
    key,
    bytes: 500,
    removable: opts.removable,
    photographedCount: opts.photographed ?? 0,
    removableCount: opts.removable ? 3 : 0,
    removeQuietly: vi.fn(async () => 3),
    reload: vi.fn(async () => {}),
    row: (checkbox) => (
      <div>
        {checkbox}
        {key}
      </div>
    ),
  } satisfies AddedSpeciesRow;
}

function renderList(addedRows: AddedSpeciesRow[]) {
  const onRefresh = vi.fn();
  render(
    <ToastContext.Provider value={toast}>
      <DownloadedPacksList packs={[pack]} onRefresh={onRefresh} addedRows={addedRows} />
    </ToastContext.Provider>,
  );
  fireEvent.click(screen.getByText("Canada"));
  return onRefresh;
}

afterEach(cleanup);
beforeEach(() => {
  post.mockReset();
  vi.clearAllMocks();
});

describe("DownloadedPacksList added species", () => {
  it("selects an added group on its own and removes it through its route", async () => {
    const insects = addedRow("Canada|Insecta", { removable: true, photographed: 2 });
    renderList([insects]);
    // Group checkbox, pack checkbox, added checkbox.
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[2]);
    fireEvent.click(screen.getByRole("button", { name: "Remove selected (1)" }));

    expect(await screen.findByText("Remove 1 selected item?")).toBeTruthy();
    expect(screen.getByText(/Removes 3 species you added from iNaturalist/)).toBeTruthy();
    expect(screen.getByText("2 species you have photos of stay.")).toBeTruthy();
    // Added species only: no pack preview to wait on.
    expect(post).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" }).at(-1)!);
    await waitFor(() => expect(insects.removeQuietly).toHaveBeenCalledTimes(1));
    expect(post).not.toHaveBeenCalledWith("/offline-packs/offload-batch", expect.anything());
    await waitFor(() => expect(insects.reload).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith("Removed 3 species");
  });

  it("Select all takes packs and removable added groups, and removes them together", async () => {
    const insects = addedRow("Canada|Insecta", { removable: true });
    const plants = addedRow("Canada|Plantae", { removable: false });
    post.mockImplementation(async (path: string) =>
      path === "/offline-packs/offload-preview"
        ? {
            isEstimate: true,
            bytesToFree: 1000,
            speciesToRemoveCount: 0,
            speciesKeptCount: 0,
            checklistRegionsAffectedCount: 0,
          }
        : {},
    );
    const onRefresh = renderList([insects, plants]);

    const plantsBox = screen.getAllByRole("checkbox")[3] as HTMLInputElement;
    expect(plantsBox.disabled).toBe(true);
    // The hint is on the checkbox's label, so hovering the text shows it too.
    const plantsLabel = plantsBox.closest("label")!;
    fireEvent.pointerEnter(plantsLabel, { pointerType: "mouse" });
    expect((await screen.findByRole("tooltip")).textContent).toBe("You have photos of all of them, so they stay");
    fireEvent.pointerLeave(plantsLabel);

    fireEvent.click(screen.getAllByRole("button", { name: "Select all" })[0]);
    expect(plantsBox.checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Remove selected (2)" }));

    expect(await screen.findByText("Remove 2 selected items?")).toBeTruthy();
    expect(post).toHaveBeenCalledWith("/offline-packs/offload-preview", { packIds: ["pk-ca"] });
    await screen.findByText("Frees about 1 KB.");

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" }).at(-1)!);
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/offline-packs/offload-batch", { packIds: ["pk-ca"] });
    expect(insects.removeQuietly).toHaveBeenCalledTimes(1);
    expect(plants.removeQuietly).not.toHaveBeenCalled();
  });

  it("the country checkbox selects its added groups too", () => {
    renderList([addedRow("Canada|Insecta", { removable: true })]);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(screen.getByRole("button", { name: "Remove selected (2)" })).toBeTruthy();
  });
});

describe("DownloadedPacksList controls and errors", () => {
  it("opens groups with the shared chevron, not a text glyph", () => {
    renderList([]);
    const header = screen.getByText("Canada").closest("button")!;
    expect(header.querySelector("svg")).toBeTruthy();
    expect(header.textContent).not.toMatch(/[▸▾]/);
  });

  it("says the preview failed in plain words, not the browser's text", async () => {
    post.mockRejectedValue(new TypeError("Failed to fetch"));
    renderList([]);
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getByRole("button", { name: "Remove selected (1)" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/offline-packs/offload-preview", { packIds: ["pk-ca"] }));
    await waitFor(() => expect(document.body.textContent).toMatch(/Couldn't reach Lifer/));
    expect(document.body.textContent).not.toContain("Failed to fetch");
  });
});
