// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const S = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const option = (n: number, extra: object = {}) => ({
  speciesId: S(n),
  scientificName: `Testus ${n}`,
  commonName: `Bird ${n}`,
  state: null,
  onChecklist: true,
  ...extra,
});
const preview = {
  canAddToChecklist: true,
  rows: [
    { name: "Bird 1", status: "matched", options: [option(1)] },
    { name: "Twin", status: "ambiguous", options: [option(2), option(3)] },
    { name: "Seen one", status: "matched", options: [option(4, { state: "seen" })] },
    { name: "Away", status: "matched", options: [option(5, { onChecklist: false })] },
    { name: "Nope", status: "unmatched", options: [] },
  ],
};
const imported = {
  listId: S(9),
  createdList: true,
  addedSpeciesIds: [S(1), S(3)],
  checklistSpeciesIds: [],
  leftAlone: 1,
};

const post = vi.fn(async (path: string) => (String(path).includes("preview") ? preview : imported));
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: {
    get: vi.fn(async () => ({ lists: [] })),
    post: (...a: [string]) => post(...a),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("../hooks/useRegions", () => ({
  useRegions: () => ({ regions: [{ id: S(8), name: "Testland" }], error: null, refresh: vi.fn() }),
}));
vi.mock("./RegionBrowser", () => ({ default: () => null }));

const { default: TargetListImportModal } = await import("./TargetListImportModal");
const { ToastContext } = await import("../hooks/useToast");
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderModal() {
  const onClose = vi.fn();
  const onImported = vi.fn();
  render(
    <MemoryRouter>
      <ToastContext.Provider value={toast}>
        <TargetListImportModal regionId={S(8)} onClose={onClose} onImported={onImported} />
      </ToastContext.Provider>
    </MemoryRouter>,
  );
  return { onClose, onImported };
}

async function dropFile() {
  const file = new File(["Scientific Name\nTestus 1\n"], "Costa Rica trip.csv", { type: "text/csv" });
  fireEvent.drop(screen.getByText("Drop a CSV of species here").parentElement!, { dataTransfer: { files: [file] } });
  await screen.findByText(/matched, 1 to pick, 1 not found/);
}

describe("TargetListImportModal", () => {
  it("previews the file for the browsed region and offers one file, not a folder", async () => {
    renderModal();
    expect(screen.queryByText("Choose a folder")).toBeNull();
    await dropFile();
    expect(post.mock.calls[0][0]).toContain(`regionId=${S(8)}`);
    expect(screen.getByText(/1 species you've seen or photographed stays as it is/)).toBeTruthy();
    expect(screen.getByText("Not found: Nope")).toBeTruthy();
    expect((screen.getByLabelText("List name") as HTMLInputElement).value).toBe("Costa Rica trip");
  });

  it("imports the matched and picked species, skipping off-checklist ones unless included, with Undo", async () => {
    const { onClose, onImported } = renderModal();
    await dropFile();
    expect(screen.getByRole("button", { name: "Add 1 target" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Twin"), { target: { value: S(3) } });
    fireEvent.click(screen.getByText(/Include 1 species not on Testland's checklist/));
    fireEvent.click(screen.getByRole("button", { name: "Add 3 targets" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(post).toHaveBeenLastCalledWith("/target-lists/import", {
      name: "Costa Rica trip",
      regionId: S(8),
      speciesIds: [S(1), S(3), S(5)],
      addToChecklist: true,
    });
    expect(onImported).toHaveBeenCalled();
    const [message, options] = toast.show.mock.calls[0];
    expect(message).toBe("Added 2 targets to Costa Rica trip");
    options.actions[0].onClick();
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith("/target-lists/import/undo", {
        listId: S(9),
        createdList: true,
        addedSpeciesIds: [S(1), S(3)],
        checklistSpeciesIds: [],
      }),
    );
  });

  it("shows a plain message when the file can't be read", async () => {
    post.mockRejectedValueOnce(new Error('The file needs a "Scientific Name" or "Common Name" column.'));
    renderModal();
    const file = new File(["a,b"], "x.csv");
    fireEvent.drop(screen.getByText("Drop a CSV of species here").parentElement!, { dataTransfer: { files: [file] } });
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
