// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
const del = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));
let mode: "desktop" | "server" | null = "server";
vi.mock("../../hooks/useDeploymentMode", () => ({ useDeploymentMode: () => mode }));

const { default: ImmichSettings } = await import("./ImmichSettings");
const { ApiError } = await import("../../api/client");

const idle = {
  running: false,
  phase: null,
  downloadedBytes: null,
  totalBytes: null,
  processed: null,
  total: null,
  currentItem: null,
  error: null,
  finishedAt: null,
  cancelRequested: false,
  cancelled: false,
  result: null,
};
const notLinked = {
  linked: false,
  serverUrl: null,
  serverVersion: null,
  albumIds: [],
  writeTags: false,
  lastSyncAt: null,
  lastError: null,
  counts: { imported: 0, unrecognized: 0, skipped: 0 },
};
const linked = {
  ...notLinked,
  linked: true,
  serverUrl: "https://photos.example.com",
  serverVersion: "1.132.3",
  albumIds: ["a1"],
  lastSyncAt: new Date().toISOString(),
  counts: { imported: 1234, unrecognized: 2, skipped: 0 },
};
const albums = [
  { id: "a1", name: "Birds 2024", assetCount: 5 },
  { id: "a2", name: "A".repeat(300), assetCount: 1 },
];

function answer(status: object, job: object = idle) {
  get.mockImplementation(async (path: string) => {
    if (path === "/immich/status") return status;
    if (path === "/immich/albums") return albums;
    if (path === "/immich/sync/status") return job;
    throw new Error(`unexpected GET ${path}`);
  });
}

beforeEach(() => {
  mode = "server";
  answer(notLinked);
  post.mockResolvedValue({ ok: true });
  put.mockResolvedValue({ ok: true });
  del.mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Immich settings", () => {
  it("is hidden in the desktop app and asks nothing of the server", async () => {
    mode = "desktop";
    const { container } = render(<ImmichSettings />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
    expect(get).not.toHaveBeenCalled();
  });

  it("links with an address and key, once both are filled in", async () => {
    render(<ImmichSettings />);
    const link = await screen.findByRole("button", { name: "Link" });
    expect(link).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Immich address"), { target: { value: "https://photos.example.com" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "secret" } });
    expect(link).toHaveProperty("disabled", false);
    fireEvent.click(link);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/immich/link", { serverUrl: "https://photos.example.com", apiKey: "secret" }),
    );
  });

  it("shows why linking failed in plain words", async () => {
    post.mockRejectedValue(new ApiError(502, "Immich didn't accept the API key."));
    render(<ImmichSettings />);
    fireEvent.change(await screen.findByLabelText("Immich address"), { target: { value: "https://x.example" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(await screen.findByText("Immich didn't accept the API key.")).toBeTruthy();
  });

  it("when linked, shows the albums, the counts, and tags off by default", async () => {
    answer(linked);
    render(<ImmichSettings />);
    expect(await screen.findByText("Linked to https://photos.example.com")).toBeTruthy();
    expect(screen.getByText("1 album chosen")).toBeTruthy();
    expect(await screen.findByText("Birds 2024")).toBeTruthy();
    expect(screen.getByText("A".repeat(300))).toBeTruthy();
    expect(screen.getByText(/1,234 photos brought in\. 2 skipped: Lifer couldn't tell the species\./)).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Add species tags in Immich" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("saves album choices and the tags switch as they change", async () => {
    answer(linked);
    render(<ImmichSettings />);
    fireEvent.click(await screen.findByText("A".repeat(300)));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/immich/settings", { albumIds: ["a1", "a2"] }));
    fireEvent.click(screen.getByRole("switch", { name: "Add species tags in Immich" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/immich/settings", { writeTags: true }));
  });

  it("filters hundreds of albums and picks the shown ones in one save", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`,
      name: i < 3 ? `Owls ${i}` : `Trip ${i}`,
      assetCount: 1,
    }));
    answer(linked);
    get.mockImplementation(async (path: string) => {
      if (path === "/immich/status") return linked;
      if (path === "/immich/albums") return many;
      return idle;
    });
    render(<ImmichSettings />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Filter albums" }), { target: { value: "owls" } });
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/immich/settings", { albumIds: ["a1", "m0", "m1", "m2"] }));
    expect(put).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Deselect all" })).toBeTruthy();
  });

  it("can't sync with no album chosen", async () => {
    answer({ ...linked, albumIds: [] });
    render(<ImmichSettings />);
    expect(await screen.findByText("Choose the albums Lifer brings in.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sync now" })).toHaveProperty("disabled", true);
  });

  it("starts a sync in the background and shows its progress with Cancel", async () => {
    answer(linked, { ...idle, running: true, phase: "importing", processed: 3, total: 10 });
    render(<ImmichSettings />);
    expect(await screen.findByText(/Bringing in photos/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sync now" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/immich/sync/cancel", {}));
  });

  it("shows the last sync's problem", async () => {
    answer({ ...linked, lastError: "Couldn't reach the Immich server. Check the address and that it's running." });
    render(<ImmichSettings />);
    expect(await screen.findByText(/Couldn't reach the Immich server/)).toBeTruthy();
  });
});
