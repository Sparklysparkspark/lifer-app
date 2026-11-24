// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
const del = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
    delete: (...a: unknown[]) => del(...a),
    patch: vi.fn(),
  },
}));
const start = vi.fn();
const jobState = vi.hoisted(() => ({ status: null as unknown, onFinish: undefined as undefined | (() => void) }));
vi.mock("../hooks/useJobPoll", () => ({
  useJobPoll: (_path: string, options?: { onFinish?: () => void }) => {
    jobState.onFinish = options?.onFinish;
    return { status: jobState.status, start, cancel: vi.fn(), starting: false, cancelling: false, actionError: null };
  },
}));
const mode = vi.hoisted(() => ({ value: "server" as "server" | "desktop" }));
vi.mock("../hooks/useDeploymentMode", () => ({ useIsTauri: () => false, useDeploymentMode: () => mode.value }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => () => Promise.resolve(true) }));
const pickFolderNative = vi.fn();
vi.mock("../lib/pickFolderNative", () => ({ pickFolderNative: (...a: unknown[]) => pickFolderNative(...a) }));

const { default: PortfolioPage } = await import("./PortfolioPage");
const { ToastContext } = await import("../hooks/useToast");
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

const SPEC = { title: "My birds", albumIds: [], speciesIds: [], lifeList: false };

function serve(spec = SPEC, shared = false) {
  get.mockImplementation((path: string) => {
    if (path === "/portfolio") return Promise.resolve({ spec, shared });
    if (path === "/albums") return Promise.resolve({ albums: [{ id: "a1", name: "Herons at dawn" }] });
    if (path.startsWith("/settings/browse-directory"))
      return Promise.resolve({ path: "/exports/site", parent: null, entries: [] });
    return Promise.resolve({});
  });
  post.mockImplementation((path: string) => {
    if (path === "/portfolio/preview")
      return Promise.resolve({ index: "<figure></figure><figure></figure>", lifeList: null });
    if (path === "/portfolio/share") return Promise.resolve({ token: "tok123" });
    return Promise.resolve({ ok: true });
  });
  put.mockResolvedValue({ ok: true });
  del.mockResolvedValue({ ok: true });
}

function renderPage() {
  render(
    <ToastContext.Provider value={toast}>
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>
    </ToastContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mode.value = "server";
  jobState.status = null;
  serve();
});
afterEach(cleanup);

describe("PortfolioPage", () => {
  it("previews the saved portfolio and saves a ticked album", async () => {
    renderPage();
    expect(await screen.findByDisplayValue("My birds")).toBeTruthy();
    // The first preview uses what was saved, without saving it again.
    expect(await screen.findByText(/^2 photos\./, {}, { timeout: 3000 })).toBeTruthy();
    expect(put).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: "Herons at dawn" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/portfolio", { ...SPEC, albumIds: ["a1"] }), {
      timeout: 3000,
    });
  });

  it("saves to a folder picked in the in-app browser on a server", async () => {
    pickFolderNative.mockResolvedValue(undefined);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Save to a folder" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use this folder" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith("/portfolio/export", { destination: "/exports/site" }));
    expect(localStorage.getItem("lifer:portfolioExportFolder")).toBe("/exports/site");
  });

  it("saves straight to the folder the desktop picker returns, and offers no share link", async () => {
    mode.value = "desktop";
    pickFolderNative.mockResolvedValue("/Users/me/Site");
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Save to a folder" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith("/portfolio/export", { destination: "/Users/me/Site" }));
    expect(screen.queryByRole("button", { name: "Create a link" })).toBeNull();
  });

  it("makes a share link on a server and can stop sharing", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Create a link" }));
    const link = (await screen.findByRole("textbox", { name: "Portfolio link" })) as HTMLInputElement;
    expect(link.value).toBe(`${window.location.origin}/api/p/tok123`);

    fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/portfolio/share"));
    expect(await screen.findByRole("button", { name: "Create a link" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Portfolio link" })).toBeNull();
  });

  it("offers a retry when the portfolio can't load", async () => {
    get.mockRejectedValue(new Error("down"));
    renderPage();
    expect(await screen.findByText("Couldn't load your portfolio.")).toBeTruthy();
    // Retry loads again in place, without reloading the whole window.
    serve();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByDisplayValue("My birds")).toBeTruthy();
  });

  it("says a failed save in plain words, never the job's own error text", async () => {
    jobState.status = { running: false, error: "ENOSPC: no space left on device, write '/exports/site/a.jpg'" };
    renderPage();
    await screen.findByDisplayValue("My birds");
    act(() => jobState.onFinish?.());
    expect(await screen.findByText(/disk|space/i)).toBeTruthy();
    expect(screen.queryByText(/ENOSPC/)).toBeNull();
  });
});
