// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

// The downloads page itself loads the pack picker and its map; only its place in Settings is tested here.
vi.mock("./settings/RegionsSettings", () => ({ default: () => <h2>Species downloads</h2> }));
const { default: SettingsPage } = await import("./SettingsPage");
const { ConfirmContext } = await import("../hooks/useConfirm");
const { ThemeContext } = await import("../hooks/useTheme");
const { ToastProvider } = await import("../components/ToastProvider");
const { resetAccountCaches } = await import("../lib/resource");
const { resetSpeciesNamePrefsCache } = await import("../lib/speciesName");

const settings: SettingsResponse = {
  folderLayout: ["group", "species"],
  hideObscureSpecies: false,
  speciesSuggestEnabled: false,
  anyTaxaSearchEnabled: false,
  fetchWithheldPhotos: false,
  technicalDiving: false,
  speciesNamingStyles: ["common"],
  speciesNameDisplay: null,
  tipsEnabled: true,
  tipsSeen: [],
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
      <ToastProvider>
        <ConfirmContext.Provider value={vi.fn().mockResolvedValue(false)}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/settings/:groupId?" element={<SettingsPage />} />
              <Route path="/settings/species/downloads" element={<SettingsPage subpage="downloads" />} />
            </Routes>
          </MemoryRouter>
        </ConfirmContext.Provider>
      </ToastProvider>
    </ThemeContext.Provider>,
  );
}

beforeEach(() => {
  get.mockReset();
  put.mockReset();
  post.mockReset();
  resetAccountCaches();
  localStorage.clear();
  resetSpeciesNamePrefsCache();
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
    // A server install lists its linked devices under Server.
    expect(screen.getByRole("link", { name: "Server" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeTruthy();
  });

  it("opens Species downloads from the top of Species and import, with that group lit and a way back", async () => {
    serve(settings);
    renderAt("/settings/species");
    expect(await screen.findByRole("link", { name: /Download more countries and animal groups/ })).toBeTruthy();
    // No separate tab for it any more.
    expect(screen.queryByRole("link", { name: "Species downloads" })).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: /Download more countries and animal groups/ }));
    expect(await screen.findByRole("heading", { name: "Species downloads" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Species and import" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "← Species and import" }).getAttribute("href")).toBe("/settings/species");
  });

  it("sets the species names and card badges under Names and labels", async () => {
    serve(settings);
    put.mockResolvedValue({});
    renderAt("/settings/general");
    expect(await screen.findByRole("heading", { name: "Names and labels" })).toBeTruthy();
    // Every code is offered, whatever species any one view has.
    const also = screen.getByRole("group", { name: "Also show" });
    for (const name of [/Scientific name/, /ABA code/, /eBird code/]) {
      expect(within(also).getByRole("checkbox", { name })).toBeTruthy();
    }

    fireEvent.click(screen.getByRole("button", { name: "Scientific" }));
    expect(localStorage.getItem("lifer:speciesNameMain")).toBe(JSON.stringify("scientific"));
    // Saved to the account too, for share pages; the other-name choice follows the main name.
    expect(put).toHaveBeenCalledWith("/settings/species-name-display", { main: "scientific", also: ["other"] });
    expect(within(also).getByRole("checkbox", { name: /Common name/ })).toBeTruthy();
    fireEvent.click(within(also).getByRole("checkbox", { name: /eBird code/ }));
    expect(put).toHaveBeenLastCalledWith("/settings/species-name-display", {
      main: "scientific",
      also: ["other", "ebird"],
    });

    const cardTags = screen.getByRole("switch", { name: "Show card tags" });
    expect(cardTags.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(cardTags);
    expect(cardTags.getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem("lifer:hideLabels")).toBe("true");
  });

  it("saves a toggle through its own endpoint and shows it checked", async () => {
    serve(settings);
    put.mockResolvedValue({});
    renderAt("/settings/species");
    const toggle = await screen.findByRole("switch", { name: "Hide species almost nobody photographs" });
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

  it("picks a folder layout preset and shows where a real photo would go", async () => {
    get.mockImplementation((path: string) =>
      path === "/settings"
        ? Promise.resolve(settings)
        : path.startsWith("/settings/folder-layout/example")
          ? Promise.resolve({
              path: new URLSearchParams(path.split("?")[1]).get("layout")!.startsWith("country")
                ? "Canada/Alberta/Pigeon Lake/Birds/American Robin/Adjusted/IMG_4411.jpg"
                : "Birds/American Robin/Adjusted/IMG_4411.jpg",
              sample: false,
            })
          : new Promise(() => {}),
    );
    put.mockImplementation((_path: string, body: { layout: string[] }) =>
      Promise.resolve({ folderLayout: body.layout }),
    );
    renderAt("/settings/library");
    const menu = await screen.findByRole("combobox", { name: "Folder layout" });
    expect((menu as HTMLSelectElement).value).toBe("species");
    expect(await screen.findByText("Birds/American Robin/Adjusted/IMG_4411.jpg")).toBeTruthy();
    // The two old switches are gone.
    expect(screen.queryByRole("switch", { name: "Folders by year" })).toBeNull();

    fireEvent.change(menu, { target: { value: "location" } });
    expect(put).toHaveBeenCalledWith("/settings/folder-layout", {
      layout: ["country", "province", "place", "group", "species"],
    });
    expect(
      await screen.findByText("Canada/Alberta/Pigeon Lake/Birds/American Robin/Adjusted/IMG_4411.jpg"),
    ).toBeTruthy();
  });

  it("edits a custom layout: adds, reorders and removes levels, never the last one", async () => {
    let current = ["group", "species"];
    get.mockImplementation((path: string) =>
      path === "/settings"
        ? Promise.resolve({ ...settings, folderLayout: current })
        : path.startsWith("/settings/folder-layout/example")
          ? Promise.resolve({ path: "2025/Birds/Robin/Adjusted/IMG_4411.jpg", sample: true })
          : new Promise(() => {}),
    );
    put.mockImplementation((_path: string, body: { layout: string[] }) => {
      current = body.layout;
      return Promise.resolve({ folderLayout: body.layout });
    });
    renderAt("/settings/library");
    fireEvent.change(await screen.findByRole("combobox", { name: "Folder layout" }), { target: { value: "custom" } });
    expect(await screen.findByText(/On a sample photo:/)).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: /Year \(2025\)/ }));
    expect(put).toHaveBeenLastCalledWith("/settings/folder-layout", { layout: ["group", "species", "year"] });
    await waitFor(() => expect(screen.getByRole("button", { name: "Move Year (2025) up" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Move Year (2025) up" }));
    expect(put).toHaveBeenLastCalledWith("/settings/folder-layout", { layout: ["group", "year", "species"] });
    await waitFor(() =>
      expect((screen.getByRole("checkbox", { name: /^Group/ }) as HTMLInputElement).checked).toBe(true),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /^Group/ }));
    expect(put).toHaveBeenLastCalledWith("/settings/folder-layout", { layout: ["year", "species"] });
    await waitFor(() =>
      expect((screen.getByRole("checkbox", { name: /^Group/ }) as HTMLInputElement).checked).toBe(false),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /^Species/ }));
    await waitFor(() => expect(put).toHaveBeenLastCalledWith("/settings/folder-layout", { layout: ["year"] }));
    expect((screen.getByRole("checkbox", { name: /Year \(2025\)/ }) as HTMLInputElement).disabled).toBe(true);
  });
});
