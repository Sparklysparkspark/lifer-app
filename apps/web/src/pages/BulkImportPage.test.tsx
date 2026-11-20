// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

// The RAW transfer itself is out of scope: the test answers each file's result by hand.
const enqueueRawUploads = vi.fn();
vi.mock("../lib/uploadQueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/uploadQueue")>()),
  enqueueRawUploads: (...a: unknown[]) => enqueueRawUploads(...a),
}));
vi.mock("../hooks/useJobPoll", () => ({ useJobPoll: () => ({ status: null }) }));

const { default: BulkImportPage } = await import("./BulkImportPage");
const { ToastContext } = await import("../hooks/useToast");
const { resetAccountCaches } = await import("../lib/resource");

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

function renderPage() {
  return render(
    <ToastContext.Provider value={toast}>
      <MemoryRouter>
        <BulkImportPage />
      </MemoryRouter>
    </ToastContext.Provider>,
  );
}

// The RAW-only picker is the last one on the page, inside the closed details section.
function rawInput(container: HTMLElement): HTMLInputElement {
  const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"][accept]');
  return inputs[inputs.length - 1];
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAccountCaches();
  localStorage.clear();
  get.mockImplementation((path: string) => {
    if (path === "/settings") return Promise.resolve({ deploymentMode: "server", dataDir: "/data", libraryRoots: [] });
    if (path === "/regions") return Promise.resolve({ regions: [] });
    return new Promise(() => {});
  });
});

describe("BulkImportPage", () => {
  it("shows the photo import and the RAW section", () => {
    renderPage();
    expect(screen.getAllByRole("heading").length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: /photos/i })).toBeTruthy();
    expect(document.querySelector("details summary")).toBeTruthy();
  });

  // Dates around today, so the test doesn't age.
  const day = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const trip = (id: string, name: string, startDate: string | null, endDate: string | null = null) => ({
    id,
    name,
    startDate,
    endDate,
    activeOverride: null,
    regionId: null,
  });
  const withTrips = (trips: object[]) =>
    get.mockImplementation((path: string) => (path === "/trips" ? Promise.resolve({ trips }) : new Promise(() => {})));
  const pickArea = () => screen.queryByText(/Drag photos, RAWs or videos here/);

  it("with no active trip, imports into no trip, and any trip can be picked", async () => {
    withTrips([trip("t1", "Costa Rica 2025", day(-400), day(-390))]);
    renderPage();
    const select = (await screen.findByRole("combobox", { name: "Trip" })) as HTMLSelectElement;
    expect(select.value).toBe("none");
    fireEvent.change(select, { target: { value: "t1" } });
    expect(screen.getByText("Adding to Costa Rica 2025")).toBeTruthy();
  });

  it("with one active trip, says it's adding to it, and it stays changeable", async () => {
    withTrips([trip("t1", "Costa Rica 2026", day(-2)), trip("t2", "Peru", day(-300), day(-290))]);
    renderPage();
    const select = (await screen.findByRole("combobox", { name: "Trip" })) as HTMLSelectElement;
    expect(select.value).toBe("t1");
    expect(screen.getByText("Adding to Costa Rica 2026")).toBeTruthy();
    fireEvent.change(select, { target: { value: "none" } });
    expect(screen.queryByText(/Adding to/)).toBeNull();
  });

  it("with several active trips, asks which before any photos can be added, and remembers the pick", async () => {
    const both = [trip("t1", "Costa Rica 2026", day(-2)), trip("t2", "Osa", day(-1), day(3))];
    withTrips(both);
    const first = renderPage();
    const select = (await screen.findByRole("combobox", { name: "Trip" })) as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(pickArea()).toBeNull();
    fireEvent.change(select, { target: { value: "t2" } });
    expect(screen.getByText("Adding to Osa")).toBeTruthy();
    expect(pickArea()).toBeTruthy();
    first.unmount();

    renderPage();
    const again = (await screen.findByRole("combobox", { name: "Trip" })) as HTMLSelectElement;
    expect(again.value).toBe("t2");
  });

  it("rejects a RAW pick with no RAW files in it, without uploading", () => {
    const { container } = renderPage();
    fireEvent.change(rawInput(container), {
      target: { files: [new File(["x"], "heron.jpg", { type: "image/jpeg" })] },
    });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(enqueueRawUploads).not.toHaveBeenCalled();
  });

  it("uploads picked RAWs and shows where each was filed", () => {
    const { container } = renderPage();
    const raw = new File(["raw"], "heron.nef");
    fireEvent.change(rawInput(container), { target: { files: [raw] } });
    expect(enqueueRawUploads).toHaveBeenCalledTimes(1);
    const [, files, , , opts] = enqueueRawUploads.mock.calls[0];
    expect(files).toEqual([raw]);
    expect(screen.getByText(/1 uploading/)).toBeTruthy();

    act(() =>
      opts.onResult(
        raw,
        { filename: "heron.nef", linked: true, collision: false, speciesCommonName: "Great Blue Heron" },
        null,
      ),
    );
    expect(screen.getByText(/1 matched/)).toBeTruthy();
    expect(screen.getByText("heron.nef")).toBeTruthy();
    expect(screen.getByText(/Great Blue Heron/)).toBeTruthy();
  });

  it("shows a failed RAW upload's error", () => {
    const { container } = renderPage();
    const raw = new File(["raw"], "egret.cr3");
    fireEvent.change(rawInput(container), { target: { files: [raw] } });
    const opts = enqueueRawUploads.mock.calls[0][4];
    act(() => opts.onResult(raw, null, "Disk full"));
    expect(screen.getByText("Disk full")).toBeTruthy();
  });
});
