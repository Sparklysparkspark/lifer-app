// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsResponse } from "@lifer/shared";

const get = vi.fn();
const put = vi.fn();
const post = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

const { default: SettingsPage } = await import("./SettingsPage");
const { ConfirmContext } = await import("../hooks/useConfirm");
const { ThemeContext } = await import("../hooks/useTheme");
const { resetAccountCaches } = await import("../lib/resource");

const settings: SettingsResponse = {
  organizeOriginalsByYear: false,
  organizeOriginalsByLocation: false,
  hideObscureSpecies: false,
  speciesSuggestEnabled: false,
  anyTaxaSearchEnabled: false,
  fetchWithheldPhotos: false,
  technicalDiving: false,
  speciesNamingStyles: ["common"],
  locale: null,
  abaCodesAvailable: false,
  dataDir: "/data",
  deploymentMode: "server",
  catalogLoading: null,
  libraryRoots: [],
};

// Answers GET /settings; anything else never resolves, so sections that need more stay quiet.
function serve(response: SettingsResponse) {
  get.mockImplementation((path: string) => (path === "/settings" ? Promise.resolve(response) : new Promise(() => {})));
}

function renderAt(path: string) {
  return render(
    <ThemeContext.Provider value={{ theme: "light", preference: "system", setPreference: vi.fn() }}>
      <ConfirmContext.Provider value={vi.fn().mockResolvedValue(false)}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/settings/:groupId?" element={<SettingsPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmContext.Provider>
    </ThemeContext.Provider>,
  );
}

beforeEach(() => {
  get.mockReset();
  put.mockReset();
  post.mockReset();
  resetAccountCaches();
  localStorage.clear();
});

describe("SettingsPage", () => {
  it("lists the groups for a server install and opens General by default", async () => {
    serve(settings);
    renderAt("/settings");
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    // Account only shows once the API reports a server install.
    expect(await screen.findByRole("link", { name: "Account" })).toBeTruthy();
    for (const name of ["General", "Species and import", "Library", "Storage", "Integrations", "Offline data"]) {
      expect(screen.getByRole("link", { name })).toBeTruthy();
    }
    // Server is desktop-shell only.
    expect(screen.queryByRole("link", { name: "Server" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeTruthy();
  });

  it("saves a toggle through its own endpoint and shows it checked", async () => {
    serve(settings);
    put.mockResolvedValue({});
    renderAt("/settings/species");
    const toggle = await screen.findByRole("switch", { name: "Hide obscure species" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);

    expect(put).toHaveBeenCalledWith("/settings/hide-obscure-species", { enabled: true });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  });

  it("keeps a toggle unchanged and shows the error when saving fails", async () => {
    serve(settings);
    put.mockRejectedValue(new Error("Server said no"));
    renderAt("/settings/species");
    const toggle = await screen.findByRole("switch", { name: "Technical diving depths" });

    fireEvent.click(toggle);

    expect(await screen.findByText("Server said no")).toBeTruthy();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});
