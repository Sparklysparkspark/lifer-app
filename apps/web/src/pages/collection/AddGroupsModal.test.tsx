// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PackStatusEntry } from "../../lib/packIndex";

const post = vi.fn(async (..._args: unknown[]) => ({ started: true, packIds: ["x"] }));
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { get: vi.fn(), post: (...a: unknown[]) => post(...a), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
const started = vi.fn();
vi.mock("../../lib/packDownloadStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/packDownloadStore")>()),
  markPackDownloadStarted: () => started(),
  refreshPackDownload: async () => null,
}));

const { default: AddGroupsModal } = await import("./AddGroupsModal");
const { groupsForCountries } = await import("../../lib/packIndex");
const { ToastContext } = await import("../../hooks/useToast");
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

const entry = (region: string, taxon: string, downloaded: boolean, sizeBytes = 5_000_000, variant?: "small") =>
  ({
    id: `${region}-${taxon}${variant ? ".small" : ""}`,
    type: "region",
    region,
    taxon,
    downloaded,
    sizeBytes,
    variant,
  }) as PackStatusEntry;

// North America with Canada and the United States: birds in both, reptiles in neither.
const packs = [
  entry("Canada", "aves", true),
  entry("United States", "aves", true),
  entry("Canada", "squamata", false),
  entry("United States", "squamata", false, 7_000_000),
  entry("United States", "testudines", false),
  entry("Canada", "squamata", false, 1_000_000, "small"),
  entry("United States", "squamata", false, 2_000_000, "small"),
  entry("United States", "testudines", false, 1_000_000, "small"),
];

function renderModal(
  countryNames = ["Canada", "United States"],
  connection: "online" | "slow" | "offline" = "online",
  sizesPending = false,
) {
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <ToastContext.Provider value={toast}>
        <AddGroupsModal
          countryNames={countryNames}
          groups={groupsForCountries(packs, countryNames)}
          freeBytes={null}
          onlyDownloaded
          connection={connection}
          sizesPending={sizesPending}
          namingStyles={[]}
          onClose={onClose}
        />
      </ToastContext.Provider>
    </MemoryRouter>,
  );
  return onClose;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AddGroupsModal", () => {
  it("names the countries, shows downloaded groups checked and disabled, and preselects nothing", () => {
    renderModal();
    expect(screen.getByRole("dialog", { name: "Add animal groups for Canada and United States" })).toBeTruthy();
    const birds = screen.getByRole("checkbox", { name: "Birds" }) as HTMLInputElement;
    expect(birds.checked && birds.disabled).toBe(true);
    const reptiles = screen.getByRole("checkbox", { name: "Reptiles" }) as HTMLInputElement;
    expect(reptiles.checked || reptiles.disabled).toBe(false);
    expect(screen.getByText("12 MB")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Download" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Choose at least one animal group")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download more countries" }).getAttribute("href")).toBe(
      "/settings/species/downloads",
    );
  });

  it("downloads the chosen group for every country and closes at once", async () => {
    const onClose = renderModal();
    fireEvent.click(screen.getByRole("checkbox", { name: "Reptiles" }));
    expect(screen.getByText(/1 animal group, 12 MB/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(onClose).toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith("/offline-packs/download-batch", {
      regionNames: ["Canada", "United States"],
      taxa: ["squamata"],
      variant: "full",
    });
    await waitFor(() => expect(started).toHaveBeenCalled());
  });

  it("offers Small, which resizes every group and the summary and downloads the small packs", () => {
    renderModal();
    fireEvent.click(screen.getByRole("checkbox", { name: "Reptiles" }));
    fireEvent.click(screen.getByRole("button", { name: "Small" }));
    expect(screen.getByText("3 MB")).toBeTruthy();
    expect(screen.getByText(/1 animal group, 3 MB/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(post).toHaveBeenCalledWith("/offline-packs/download-batch", {
      regionNames: ["Canada", "United States"],
      taxa: ["squamata"],
      variant: "small",
    });
  });

  it("while photo sizes are still being worked out, shows no size rather than a too-small one", () => {
    renderModal(["Canada", "United States"], "online", true);
    expect(screen.queryByText("12 MB")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Reptiles" }));
    expect(screen.getByText("1 animal group. Working out the size…")).toBeTruthy();
    // Never blocks: Download still works.
    expect((screen.getByRole("button", { name: "Download" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("counts many countries in the title and lists them below", () => {
    const names = Array.from({ length: 50 }, (_, i) => `Country ${i + 1}`);
    renderModal(names);
    expect(screen.getByRole("dialog", { name: "Add animal groups for 50 countries" })).toBeTruthy();
    expect(screen.getByText(/Country 1, Country 2/)).toBeTruthy();
  });

  it("offline, says so and keeps Download off even with a group picked", () => {
    renderModal(["Canada", "United States"], "offline");
    expect(screen.getByText(/You're offline, showing what's on this computer/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Reptiles" }));
    expect((screen.getByRole("button", { name: "Download" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("on a slow connection, says so but keeps Download on: it only takes longer", () => {
    renderModal(["Canada", "United States"], "slow");
    expect(screen.getByText("Slow connection, still trying…")).toBeTruthy();
    expect(screen.queryByText(/You're offline/)).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Reptiles" }));
    expect((screen.getByRole("button", { name: "Download" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("while the list is still coming in, shows how far it has got instead of an endless spinner", () => {
    render(
      <MemoryRouter>
        <ToastContext.Provider value={toast}>
          <AddGroupsModal
            countryNames={["Canada"]}
            groups={groupsForCountries(packs, ["Canada"]).filter((g) => g.downloaded)}
            freeBytes={null}
            connection="slow"
            listReady={false}
            listProgress={{ receivedBytes: 6_800_000, totalBytes: 21_903_355 }}
            onlyDownloaded={false}
            namingStyles={[]}
            onClose={vi.fn()}
          />
        </ToastContext.Provider>
      </MemoryRouter>,
    );
    expect(screen.getByText("Getting the list of animal groups… 31%")).toBeTruthy();
    expect(screen.queryByText(/offline/i)).toBeNull();
    expect((screen.getByRole("button", { name: "Download" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
