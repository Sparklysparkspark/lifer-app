// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegionSummary } from "@lifer/shared";

const get = vi.fn();
const post = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

const { default: OnboardingPage } = await import("./OnboardingPage");
const { resetAccountCaches } = await import("../lib/resource");
const { resetPackDownloadStore } = await import("../lib/packDownloadStore");
const { default: i18n } = await import("../i18n");
const { AuthContext } = await import("../hooks/useAuth");
const { ThemeContext } = await import("../hooks/useTheme");

const auth = { user: { id: "u1", email: "a@b.c" }, loading: false, login: vi.fn(), register: vi.fn(), logout: vi.fn() };

function region(id: string, name: string, parentId: string | null): RegionSummary {
  return {
    id,
    name,
    parentId,
    ebirdRegionCode: null,
    boundaryGeoJson: null,
    hasChildren: false,
    hasScopedChecklist: parentId !== null,
    sovereigntyGroup: null,
    isSovereignDependency: false,
  };
}

const regions = [region("world", "World", null), region("eu", "Europe", "world"), region("fr", "Freedonia", "eu")];
const pack = (taxon: string, downloaded = false) => ({
  id: `fr-${taxon}`,
  type: "region",
  region: "Freedonia",
  taxon,
  downloaded,
  sizeBytes: 1000,
});

// Answers by path prefix, most specific first; anything unlisted never resolves.
function serve({
  packs = [pack("aves"), pack("mammalia")],
  existing = { found: false, regions: [] as string[], taxa: [] as string[], checked: true },
} = {}) {
  const answers: Array<[string, unknown]> = [
    ["/offline-packs/index", { packs }],
    ["/offline-packs/download/status", { running: false, finishedAt: null, error: null }],
    ["/library/existing", existing],
    ["/regions", { regions }],
    ["/settings/embedding-model/status", { running: false }],
    ["/settings/map/status", { running: false }],
    ["/settings", { deploymentMode: "server", dataDir: "/library", libraryRoots: [], speciesNamingStyles: [] }],
  ];
  get.mockImplementation((path: string) => {
    // The map outlines never answer: setup works from the list alone.
    if (path.startsWith("/regions/boundaries")) return new Promise(() => {});
    const hit = answers.find(([prefix]) => path === prefix || path.startsWith(prefix));
    return hit ? Promise.resolve(hit[1]) : new Promise(() => {});
  });
}

function LocationProbe() {
  return <output data-testid="location-path">{useLocation().pathname}</output>;
}

function renderPage() {
  return render(
    <AuthContext.Provider value={auth}>
      <ThemeContext.Provider value={{ theme: "light", preference: "light", setPreference: vi.fn() }}>
        <MemoryRouter initialEntries={["/onboarding"]}>
          <OnboardingPage />
          <LocationProbe />
        </MemoryRouter>
      </ThemeContext.Provider>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  post.mockResolvedValue({});
  resetAccountCaches();
  resetPackDownloadStore();
  localStorage.clear();
  serve();
});

describe("OnboardingPage", () => {
  it("leaves setup for the collection when a region is already downloaded", async () => {
    serve({ packs: [pack("aves", true)] });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("location-path").textContent).toBe("/"));
  });

  it.each([
    ["fr-FR", true],
    ["fr", false],
  ])("with the language set to %s, suggests the country only when it names one", async (language, suggested) => {
    const languageSpy = vi.spyOn(navigator, "language", "get").mockReturnValue(language);
    const named = { ...regions[2], ebirdRegionCode: "FR" };
    get.mockImplementation((path: string) =>
      path === "/regions" ? Promise.resolve({ regions: [regions[0], regions[1], named] }) : new Promise(() => {}),
    );
    try {
      renderPage();
      await screen.findByRole("button", { name: "Europe" });
      const button = screen.queryByRole("button", {
        name: i18n.t("onboarding.regions.addSuggestion", { name: "Freedonia" }),
      });
      expect(button !== null).toBe(suggested);
    } finally {
      languageSpy.mockRestore();
    }
  });

  it("picks a country from the browse list and downloads only after a group is chosen", async () => {
    renderPage();
    const continueButton = await screen.findByRole("button", { name: i18n.t("onboarding.continue") });
    expect((continueButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Europe" }));
    fireEvent.click(await screen.findByRole("button", { name: "Freedonia" }));
    expect((continueButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(continueButton);

    const download = await screen.findByRole<HTMLButtonElement>("button", {
      name: i18n.t("onboarding.groups.download", { count: 1 }),
    });
    expect(download.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Birds" }));
    fireEvent.click(screen.getByRole("button", { name: "Mammals" }));
    expect(download.disabled).toBe(false);
    fireEvent.click(download);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/offline-packs/download-batch", { regionNames: ["Freedonia"], taxa: "all" }),
    );
  });

  it("lets the user in once the first pack is set up, with the rest still going", async () => {
    const lanes = (setUp: number) => {
      const lane = { currentItem: null, processed: 0, total: 2, downloadedBytes: null, totalBytes: null };
      return {
        download: { ...lane, processed: 2 },
        setup: { ...lane, processed: setUp, currentItem: "Freedonia birds", step: "checklist" },
        photos: lane,
      };
    };
    let download: object = { running: false, finishedAt: null, error: null };
    const served = get.getMockImplementation()!;
    get.mockImplementation((path: string) =>
      path === "/offline-packs/download/status" ? Promise.resolve(download) : served(path),
    );
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Europe" }));
    fireEvent.click(await screen.findByRole("button", { name: "Freedonia" }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("onboarding.continue") }));
    fireEvent.click(await screen.findByRole("button", { name: "Birds" }));

    download = { running: true, phase: "applying", processed: 0, total: 2, lanes: lanes(0) };
    fireEvent.click(screen.getByRole("button", { name: i18n.t("onboarding.groups.download", { count: 1 }) }));
    expect(await screen.findByRole("heading", { name: i18n.t("onboarding.setup.title") })).toBeTruthy();
    expect(screen.getByText(i18n.t("packProgress.settingUp"))).toBeTruthy();
    expect(screen.getByRole("region", { name: i18n.t("setupTips.label") })).toBeTruthy();

    download = { running: true, phase: "applying", processed: 0, total: 2, lanes: lanes(1) };
    expect(
      await screen.findByRole("heading", { name: i18n.t("onboarding.done.title") }, { timeout: 3000 }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: i18n.t("onboarding.done.collection") })).toBeTruthy();
    expect(screen.getByText(i18n.t("packProgress.settingUp"))).toBeTruthy();
    // A server can't read a Lightroom catalogue on this computer, so it isn't offered.
    expect(screen.queryByRole("button", { name: i18n.t("onboarding.done.lightroom") })).toBeNull();
  });

  it("offers an earlier library's countries back, already chosen", async () => {
    serve({ existing: { found: true, regions: ["Freedonia"], taxa: ["aves"], checked: true } });
    renderPage();
    await screen.findByText(i18n.t("onboarding.existing.title"));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: i18n.t("onboarding.continue") }).disabled).toBe(false);
  });

  it("says it couldn't check an earlier library's countries yet, instead of claiming it had none", async () => {
    serve({ existing: { found: true, regions: [], taxa: [], checked: false } });
    renderPage();
    expect(await screen.findByText(i18n.t("onboarding.existing.notChecked"))).toBeTruthy();
    expect(screen.queryByText(i18n.t("onboarding.existing.noRegions"))).toBeNull();
  });
});
